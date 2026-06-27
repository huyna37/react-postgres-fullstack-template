// JiraGenius Server - Refactored and modular architecture
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const db = require('./db');
const jwt = require('jsonwebtoken');
const { resolveActingUserId } = require('./lib/jiraUserLogin');
const notificationCron = require('./services/notificationCron');
const jiraSyncCron = require('./services/jiraSyncCron');
const { normalizePublicPages, DEFAULT_PUBLIC_PAGES } = require('./public-pages');
const { getIssueCreateFieldConfig } = require('./lib/jiraIssueFieldConfig');
const { jiraApiErrorDetail } = require('./lib/jiraEpicCreate');
const { createPushProfiler } = require('./lib/jiraPushProfiler');

const SPRINT_CACHE_MS = 2 * 60 * 1000;
/** @type {Map<string, { expires: number, id: number | null }>} */
const activeSprintCache = new Map();

const JWT_SECRET = process.env.JWT_SECRET || 'jira_genius_secret_key_123!';

async function getPublicPagesFromDb() {
  try {
    const res = await db.query(`SELECT value FROM app_settings WHERE key = 'public_pages'`);
    if (res.rows.length === 0) return [...DEFAULT_PUBLIC_PAGES];
    const raw = res.rows[0].value;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizePublicPages(parsed);
  } catch {
    return [...DEFAULT_PUBLIC_PAGES];
  }
}

async function savePublicPagesToDb(pages) {
  const normalized = normalizePublicPages(pages);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('public_pages', $1::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(normalized)]
  );
  return normalized;
}

const DEFAULT_THEME = 'dark';

function parseThemeSetting(raw) {
  if (raw === 'light' || raw === 'dark') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === 'light' || parsed === 'dark') return parsed;
    } catch {
      /* pg jsonb string — giá trị đã là light/dark, không phải JSON */
    }
    if (raw === 'light' || raw === 'dark') return raw;
  }
  return null;
}

async function getDefaultThemeFromDb() {
  try {
    const res = await db.query(`SELECT value FROM app_settings WHERE key = 'default_theme'`);
    if (res.rows.length === 0) return DEFAULT_THEME;
    return parseThemeSetting(res.rows[0].value) || DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

async function saveDefaultThemeToDb(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('default_theme', $1::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [JSON.stringify(normalized)]
  );
  return normalized;
}

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) return res.sendStatus(401);

  try {
    const user = jwt.verify(token, JWT_SECRET);
    const realId = await resolveActingUserId(db, user);
    req.user = { ...user, id: realId };
    next();
  } catch {
    return res.sendStatus(403);
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Require Admin Role' });
  }
};

const requirePermission = (permission) => {
  return (req, res, next) => {
    const permissions = Array.isArray(permission) ? permission : [permission];
    const hasPerm = req.user && req.user.permissions && permissions.some(p => req.user.permissions.includes(p));
    
    if (req.user && (req.user.role === 'admin' || hasPerm)) {
      next();
    } else {
      res.status(403).json({ error: `Bạn không có quyền thực hiện hành động này: ${permissions.join(' hoặc ')}` });
    }
  };
};

const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return next();

  try {
    const user = jwt.verify(token, JWT_SECRET);
    const realId = await resolveActingUserId(db, user);
    req.user = { ...user, id: realId };
  } catch {
    // ignore invalid token
  }
  next();
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '8mb' }));

// ==========================================
// Jira Shared Helpers
// ==========================================

const resolveJiraAssignee = async (assigneeId) => {
  if (!assigneeId || assigneeId === 'Me' || assigneeId === 'Unassigned') return null;

  if (assigneeId.includes(':') || assigneeId.length > 30) {
    return { accountId: assigneeId };
  }

  if (assigneeId.startsWith('JIRAUSER')) {
    try {
      const res = await db.query('SELECT email_address FROM jira_users WHERE account_id = $1', [assigneeId]);
      if (res.rows.length > 0 && res.rows[0].email_address) {
        return { name: res.rows[0].email_address };
      }
    } catch (e) {
      console.error('Failed to resolve JIRAUSER to email:', e.message);
    }
    return { name: assigneeId };
  }

  return { name: assigneeId };
};

const getActiveSprintId = async (projectKey, token) => {
  const cacheKey = String(projectKey || '').trim();
  const hit = activeSprintCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return hit.id;
  }

  try {
    const boardsRes = await axios.get(`${process.env.JIRA_URL}/rest/agile/1.0/board`, {
      headers: { 'Authorization': `Bearer ${token}` },
      params: { projectKeyOrId: projectKey },
      httpsAgent
    });

    const boards = boardsRes.data.values || [];
    if (boards.length === 0) return null;

    for (const board of boards) {
      if (board.type === 'scrum') {
        const sprintsRes = await axios.get(`${process.env.JIRA_URL}/rest/agile/1.0/board/${board.id}/sprint`, {
          headers: { 'Authorization': `Bearer ${token}` },
          params: { state: 'active' },
          httpsAgent
        });

        const activeSprints = sprintsRes.data.values || [];
        if (activeSprints.length > 0) {
          const sprintId = activeSprints[0].id;
          activeSprintCache.set(cacheKey, { expires: Date.now() + SPRINT_CACHE_MS, id: sprintId });
          return sprintId;
        }
      }
    }
  } catch (err) {
    console.warn(`Could not detect active sprint for ${projectKey} via Agile API:`, err.message);
  }
  activeSprintCache.set(cacheKey, { expires: Date.now() + SPRINT_CACHE_MS, id: null });
  return null;
};

const formatJiraDate = (dateStr) => {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return `${dateStr}T00:00:00.000+0700`;
  }
  if (dateStr.includes('T') && !dateStr.includes('+') && !dateStr.endsWith('Z')) {
    return `${dateStr}:00.000+0700`; 
  }
  return dateStr;
};

const pushToJira = async (ticket, parentKey = null, assigneeId = null, userToken = null, userProject = null, startDate = null, dueDate = null, originalEstimate = null, epicKey = null) => {
  const profiler = createPushProfiler(
    parentKey ? `pushToJira:${parentKey}` : `pushToJira:${ticket.summary?.slice(0, 40) || 'issue'}`
  );
  const url = `${process.env.JIRA_URL}/rest/api/2/issue`;
  const token = userToken;
  if (!token) {
    throw new Error('Thiếu Jira Token cá nhân. Cấu hình tại mục Cấu hình cá nhân.');
  }
  const projectKey = userProject || process.env.JIRA_PROJECT_KEY || 'AI';
  const issueType = ticket.issueType || 'Task';
  
  let fullDescription = ticket.description || '';
  
  if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
    const ac = Array.isArray(ticket.acceptanceCriteria) ? ticket.acceptanceCriteria : [ticket.acceptanceCriteria];
    fullDescription += `\n\nh3. Tiêu chí chấp nhận (Acceptance Criteria)\n` + ac.map(item => `* ${item}`).join('\n');
  }
  
  if (ticket.technicalNotes && ticket.technicalNotes.length > 0) {
    const tn = Array.isArray(ticket.technicalNotes) ? ticket.technicalNotes : [ticket.technicalNotes];
    fullDescription += `\n\nh3. Ghi chú kỹ thuật (Technical Notes)\n` + tn.map(item => `* ${item}`).join('\n');
  }
  
  if (ticket.risks && ticket.risks.length > 0) {
    const r = Array.isArray(ticket.risks) ? ticket.risks : [ticket.risks];
    fullDescription += `\n\nh3. Rủi ro & Lưu ý (Risks)\n` + r.map(item => `* ${item}`).join('\n');
  }

  const fieldConfig = await getIssueCreateFieldConfig(db, {
    projectKey,
    issueTypeName: issueType,
    token,
    httpsAgent,
    jiraBaseUrl: process.env.JIRA_URL,
  });
  profiler.step('fieldConfig');

  const body = {
    fields: {
      project: { key: projectKey },
      summary: ticket.summary,
      description: fullDescription,
      issuetype: { name: issueType },
    },
  };

  if (originalEstimate && fieldConfig.supportsTimetracking) {
    body.fields.timetracking = { originalEstimate };
  }

  if (!parentKey) {
    const sprintId = await getActiveSprintId(projectKey, token);
    profiler.step('activeSprint', { sprintId });
    if (sprintId && fieldConfig.sprintField) {
      console.log(`Auto-assigning ticket to sprint field ${fieldConfig.sprintField}: ${sprintId}`);
      body.fields[fieldConfig.sprintField] = sprintId;
    }
  }

  if (assigneeId) {
    const assigneeField = await resolveJiraAssignee(assigneeId);
    profiler.step('resolveAssignee');
    if (assigneeField) {
      body.fields.assignee = assigneeField;
    }
  }

  if (startDate && fieldConfig.startDateField) {
    body.fields[fieldConfig.startDateField] = formatJiraDate(startDate);
  }

  if (dueDate && fieldConfig.dueDateField) {
    body.fields[fieldConfig.dueDateField] = formatJiraDate(dueDate);
  }

  if (parentKey) {
    body.fields.parent = { key: parentKey };
  }

  if (epicKey && fieldConfig.epicLinkField) {
    body.fields[fieldConfig.epicLinkField] = epicKey;
  }

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      httpsAgent,
      timeout: 600000,
    });
    profiler.step('jiraCreatePost', { key: response.data?.key });
    profiler.finish({ issueKey: response.data?.key, projectKey, issueType, parentKey });
    return response.data;
  } catch (error) {
    const detail = jiraApiErrorDetail(error);
    profiler.step('jiraCreateFailed', { detail });
    profiler.finish({ failed: true, projectKey, issueType, parentKey });
    console.error('Jira API Error:', detail);
    throw new Error(`Tạo issue thất bại: ${detail}`);
  }
};

// ==========================================
// Inject Context & Mount Modular Domain Routers
// ==========================================

const context = {
  JWT_SECRET,
  db,
  httpsAgent,
  authenticateToken,
  requireAdmin,
  requirePermission,
  optionalAuth,
  resolveJiraAssignee,
  getActiveSprintId,
  formatJiraDate,
  pushToJira,
  getPublicPagesFromDb,
  savePublicPagesToDb,
  DEFAULT_PUBLIC_PAGES,
  getDefaultThemeFromDb,
  saveDefaultThemeToDb,
  DEFAULT_THEME
};

app.use(require('./routes/auth')(context));

const ticketsRouter = require('./routes/tickets')(context);
const estimatesRouter = require('./routes/estimates')(context);
app.use(ticketsRouter);
app.use(estimatesRouter);

app.use(require('./routes/ai')(context));
app.use(require('./routes/users')(context));
app.use(require('./routes/projects')(context));
app.use(require('./routes/worklogs')(context));
app.use(require('./routes/notifications')(context));
app.use(require('./routes/planning')(context));
app.use(require('./routes/webpush')(context));
app.use(require('./routes/presence')(context));
app.use(require('./routes/reports')(context));
app.use(require('./routes/agent')(context));

// ==========================================
// Serve Static Frontend Assets
// ==========================================

app.use(express.static(path.join(__dirname, '../client/dist')));

app.use((req, res) => {
  const indexPath = path.join(__dirname, '../client/dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Frontend not built. Use npm run dev in client folder for development.');
  }
});

// ==========================================
// Database Init & Listen Server
// ==========================================

const startServer = async () => {
  try {
    await db.initDB();
    
    // Reset stuck in_progress AI fixes on startup
    await db.query(`
      UPDATE app_ai_fixes 
      SET status = 'failure', 
          current_step = 'Process Terminated', 
          log = COALESCE(log, '') || '\n[' || CURRENT_TIMESTAMP || '] Server restarted. Process terminated.'
      WHERE status = 'in_progress'
    `);

    jiraSyncCron.start();
    notificationCron.start(process.env.JIRA_URL);

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();
