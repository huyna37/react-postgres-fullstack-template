const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { randomUUID } = require('crypto');
const db = require('../db');
const skillsStore = require('../skills-store');
const { cloneProject } = require('../ai-agent');

const normalizeSelectedSkills = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;

  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!/^[\w.-]+\.(md|txt)$/i.test(trimmed)) return null;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
};

const {
  normalizeJiraToken,
  resolveJiraTokenForRequest,
  MISSING_JIRA_TOKEN_PROJECTS_MSG,
} = require('../lib/jiraToken');

module.exports = (context) => {
  const router = express.Router();
  const { authenticateToken, requireAdmin, optionalAuth } = context;

  const terminalSessions = new Map();

  // ==========================================
  // Project Config CRUD
  // ==========================================

  router.get('/api/projects', authenticateToken, async (req, res) => {
    try {
      const result = await db.query('SELECT * FROM app_projects ORDER BY name ASC');
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/projects/active', authenticateToken, async (req, res) => {
    try {
      const result = await db.query(
        `SELECT DISTINCT proj_key AS "jira_key", COALESCE(p.name, proj_key) AS "name"
         FROM (
           SELECT unnest(string_to_array(jira_project, ',')) AS proj_key
           FROM jira_users
           WHERE jira_project IS NOT NULL AND jira_project != '' AND is_active = true
         ) u
         LEFT JOIN app_projects p ON u.proj_key = p.jira_key
         ORDER BY name ASC`
      );
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/projects', authenticateToken, requireAdmin, async (req, res) => {
    const { name, jira_key, git_url, git_user, git_password, local_path, base_branch, stack, selected_skills } = req.body;
    try {
      const normalizedSkills = normalizeSelectedSkills(selected_skills);
      if (normalizedSkills === null) {
        return res.status(400).json({ error: 'selected_skills must be an array of valid .md/.txt filenames' });
      }
      const result = await db.query(
        'INSERT INTO app_projects (name, jira_key, git_url, git_user, git_password, local_path, base_branch, stack, selected_skills, cloned_initialized, last_cloned_at, pulled_initialized, last_pulled_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, false, NULL, false, NULL) RETURNING *',
        [name, jira_key, git_url, git_user, git_password, local_path, base_branch || 'main', stack, JSON.stringify(normalizedSkills)]
      );
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/projects/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, jira_key, git_url, git_user, git_password, local_path, base_branch, stack, selected_skills } = req.body;
    try {
      const normalizedSkills = normalizeSelectedSkills(selected_skills);
      if (normalizedSkills === null) {
        return res.status(400).json({ error: 'selected_skills must be an array of valid .md/.txt filenames' });
      }
      const result = await db.query(
        'UPDATE app_projects SET name = $1, jira_key = $2, git_url = $3, git_user = $4, git_password = $5, local_path = $6, base_branch = $7, stack = $8, selected_skills = $9::jsonb, cloned_initialized = false, last_cloned_at = NULL, pulled_initialized = false, last_pulled_at = NULL, updated_at = NOW() WHERE id = $10 RETURNING *',
        [name, jira_key, git_url, git_user, git_password, local_path, base_branch, stack, JSON.stringify(normalizedSkills), id]
      );
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/projects/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
      await db.query('DELETE FROM app_projects WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/projects/by-jira/:key', authenticateToken, async (req, res) => {
    try {
      const result = await db.query('SELECT * FROM app_projects WHERE jira_key = $1', [req.params.key]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // Terminal Session Runners
  // ==========================================

  router.post('/api/projects/:id/terminal/exec', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { command } = req.body || {};
    const safeCommand = String(command || '').trim();
    if (!safeCommand) {
      return res.status(400).json({ error: 'Missing command' });
    }

    try {
      const projRes = await db.query('SELECT * FROM app_projects WHERE id = $1', [id]);
      if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
      const project = projRes.rows[0];
      const cwd = project.local_path;
      if (!cwd || !fs.existsSync(cwd)) {
        return res.status(400).json({ error: 'Project local_path not found. Please clone project first.' });
      }

      exec(safeCommand, { cwd, maxBuffer: 30 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
        const output = `${stdout || ''}\n${stderr || ''}`.trim();
        if (error) {
          return res.status(400).json({
            error: error.message,
            output,
            exitCode: error.code ?? 1,
          });
        }
        return res.json({
          success: true,
          output,
          exitCode: 0,
        });
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/projects/:id/terminal/start', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
      const projRes = await db.query('SELECT * FROM app_projects WHERE id = $1', [id]);
      if (projRes.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
      const project = projRes.rows[0];
      const cwd = project.local_path;
      if (!cwd || !fs.existsSync(cwd)) {
        return res.status(400).json({ error: 'Project local_path not found. Please clone project first.' });
      }

      const sessionId = randomUUID();
      const session = {
        id: sessionId,
        projectId: Number(id),
        command: '',
        cwd,
        output: '',
        cursor: 0,
        running: true,
        exitCode: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        proc: null,
      };
      terminalSessions.set(sessionId, session);

      const shellCmd = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
      const shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['-l'];
      const proc = spawn(shellCmd, shellArgs, { cwd, stdio: 'pipe', windowsHide: true });
      session.proc = proc;
      const append = (chunk) => {
        const next = `${session.output}${String(chunk || '')}`;
        session.output = next.length > 250000 ? next.slice(next.length - 250000) : next;
        session.cursor = session.output.length;
        session.updatedAt = new Date().toISOString();
      };
      proc.stdout.on('data', append);
      proc.stderr.on('data', append);
      proc.on('error', (err) => {
        append(`\n[PROCESS ERROR] ${err.message}\n`);
      });
      proc.on('close', (code) => {
        session.running = false;
        session.exitCode = typeof code === 'number' ? code : 1;
        session.updatedAt = new Date().toISOString();
        setTimeout(() => terminalSessions.delete(sessionId), 30 * 60 * 1000);
      });

      return res.json({ success: true, sessionId });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/projects/:id/terminal/input/:sessionId', authenticateToken, requireAdmin, async (req, res) => {
    const { id, sessionId } = req.params;
    const { command } = req.body || {};
    const text = String(command || '').trim();
    if (!text) return res.status(400).json({ error: 'Missing command' });

    const session = terminalSessions.get(sessionId);
    if (!session || session.projectId !== Number(id)) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }
    if (!session.running || !session.proc) {
      return res.status(400).json({ error: 'Terminal session already closed' });
    }

    session.command = text;
    session.output = `${session.output}\n$ ${text}\n`;
    session.cursor = session.output.length;
    session.updatedAt = new Date().toISOString();
    session.proc.stdin.write(`${text}\n`);
    return res.json({ success: true });
  });

  router.get('/api/projects/:id/terminal/status/:sessionId', authenticateToken, requireAdmin, async (req, res) => {
    const { id, sessionId } = req.params;
    const session = terminalSessions.get(sessionId);
    if (!session || session.projectId !== Number(id)) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }
    const cursor = Math.max(0, Number(req.query.cursor) || 0);
    const output = session.output.slice(cursor);
    return res.json({
      sessionId: session.id,
      running: session.running,
      exitCode: session.exitCode,
      output,
      cursor: session.output.length,
      command: session.command,
      cwd: session.cwd,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    });
  });

  router.post('/api/projects/:id/terminal/close/:sessionId', authenticateToken, requireAdmin, async (req, res) => {
    const { id, sessionId } = req.params;
    const session = terminalSessions.get(sessionId);
    if (!session || session.projectId !== Number(id)) {
      return res.status(404).json({ error: 'Terminal session not found' });
    }
    if (session.proc && session.running) {
      session.proc.kill();
    }
    session.running = false;
    session.updatedAt = new Date().toISOString();
    setTimeout(() => terminalSessions.delete(sessionId), 1000);
    return res.json({ success: true });
  });

  // ==========================================
  // Clone / Pull Actions
  // ==========================================

  router.post('/api/projects/:id/pull', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query('SELECT * FROM app_projects WHERE id = $1', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
      const project = result.rows[0];
      await cloneProject(project, { updateIfExists: true });
      await db.query(
        'UPDATE app_projects SET cloned_initialized = true, last_cloned_at = NOW(), pulled_initialized = true, last_pulled_at = NOW(), updated_at = NOW() WHERE id = $1',
        [id]
      );
      res.json({ success: true, message: 'Project pulled successfully.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/projects/:id/clone', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query('SELECT * FROM app_projects WHERE id = $1', [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Project not found' });
      const project = result.rows[0];
      await cloneProject(project, { updateIfExists: true });
      await db.query(
        'UPDATE app_projects SET cloned_initialized = true, last_cloned_at = NOW(), pulled_initialized = true, last_pulled_at = NOW(), updated_at = NOW() WHERE id = $1',
        [id]
      );
      res.json({ success: true, message: 'Project cloned/updated successfully.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // Skills CRUD
  // ==========================================

  router.get('/api/skills', authenticateToken, async (req, res) => {
    try {
      const skills = await skillsStore.listSkillsForApi();
      res.json(skills);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/admin/skills/meta', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const r = await db.query('SELECT COUNT(*)::int AS c FROM app_expert_skills');
      res.json({
        storage: 'postgresql',
        table: 'app_expert_skills',
        skillCount: r.rows[0]?.c ?? 0,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/admin/skills/:filename', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const row = await skillsStore.getSkillRow(req.params.filename);
      res.json({ filename: row.filename, content: row.body });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/api/admin/skills', authenticateToken, requireAdmin, async (req, res) => {
    const { filename, content } = req.body || {};
    const v = skillsStore.validateFilename(filename);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      await skillsStore.createSkill(v.filename, content ?? '');
      res.json({ success: true, filename: v.filename });
    } catch (error) {
      const msg = error.message || String(error);
      if (/already exists|duplicate/i.test(msg)) {
        return res.status(409).json({ error: 'Skill already exists' });
      }
      res.status(500).json({ error: msg });
    }
  });

  router.put('/api/admin/skills/:filename', authenticateToken, requireAdmin, async (req, res) => {
    const { content } = req.body || {};
    try {
      await skillsStore.updateSkill(req.params.filename, content ?? '');
      res.json({ success: true, filename: req.params.filename });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/api/admin/skills/:filename', authenticateToken, requireAdmin, async (req, res) => {
    try {
      await skillsStore.deleteSkill(req.params.filename);
      res.json({ success: true, filename: req.params.filename });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // ==========================================
  // Jira Projects List (proxy to Jira API)
  // ==========================================

  router.get('/api/jira/projects', optionalAuth, async (req, res) => {
    try {
      const axios = require('axios');
      const https = require('https');
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });

      const previewToken = normalizeJiraToken(
        req.headers['x-jira-token'] || req.query.jiraToken
      );
      let token = previewToken || (await resolveJiraTokenForRequest(db, req));

      if (!token) {
        return res.status(400).json({ error: MISSING_JIRA_TOKEN_PROJECTS_MSG });
      }

      const response = await axios.get(`${process.env.JIRA_URL}/rest/api/2/project`, {
        headers: { Authorization: `Bearer ${token}` },
        httpsAgent,
      });

      res.json(response.data);
    } catch (error) {
      const status = error.response?.status;
      const jiraMsg =
        error.response?.data?.errorMessages?.[0] ||
        error.response?.data?.message ||
        error.message;
      console.error('Jira projects fetch error:', error.response?.data || error.message);
      if (status === 401 || status === 403) {
        return res.status(400).json({
          error: 'Jira Token không hợp lệ hoặc đã hết hạn. Kiểm tra lại token trong Cấu hình cá nhân.',
          details: jiraMsg,
        });
      }
      res.status(500).json({ error: 'Failed to fetch Jira projects', details: jiraMsg });
    }
  });

  return router;
};

