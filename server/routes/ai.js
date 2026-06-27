const express = require('express');
const db = require('../db');
const { generateJiraTicket, generateWorklogComment, rewriteContent } = require('../generator');
const { listModels, getActiveLlmInfo, llmGenerate } = require('../llm');
const { answerProjectQuestion } = require('../project-assistant');
const { triggerAiFix, resumeAiFix } = require('../ai-agent');

module.exports = (context) => {
  const router = express.Router();
  const { authenticateToken } = context;

  // ==========================================
  // AI Ticket Generation & Rewriting
  // ==========================================

  router.post('/api/generate', authenticateToken, async (req, res) => {
    const { 
      context: promptContext, role, assignee, assigneeId, autoCreateJira, ticketType, subTaskEmail,
      createAutoSubTasks, subTaskDevAssignee, subTaskTestAssignee,
      subTaskStartDate, subTaskDueDate,
      startDate, dueDate, originalEstimate 
    } = req.body;
    
    if (!promptContext || !role) {
      return res.status(400).json({ error: 'Missing context or role' });
    }

    console.log(`Generating ticket via AI. Role: ${role}, Assignee: ${assignee}`);
    
    try {
      const ticket = await generateJiraTicket(
        promptContext, role, assignee, ticketType,
        createAutoSubTasks, subTaskDevAssignee, subTaskTestAssignee
      );
      
      res.json(ticket);
    } catch (error) {
      console.error('Process Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/generate/rewrite', authenticateToken, async (req, res) => {
    const { fieldType, currentContent } = req.body;
    if (!fieldType || !currentContent) {
      return res.status(400).json({ error: 'Missing fieldType or currentContent' });
    }

    try {
      const rewritten = await rewriteContent(fieldType, currentContent);
      res.json({ rewritten });
    } catch (error) {
      console.error('Rewrite Process Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/project-assistant/ask', authenticateToken, async (req, res) => {
    const projectId = Number(req.body?.projectId);
    const question = String(req.body?.question || '').trim();
    const conversationHistory = Array.isArray(req.body?.conversationHistory) ? req.body.conversationHistory : [];
    if (!projectId || Number.isNaN(projectId)) {
      return res.status(400).json({ error: 'projectId không hợp lệ' });
    }
    if (!question) {
      return res.status(400).json({ error: 'question không được để trống' });
    }

    try {
      const payload = await answerProjectQuestion({
        db,
        projectId,
        question,
        conversationHistory,
        llmGenerate,
      });
      res.json(payload);
    } catch (error) {
      const msg = error?.message || String(error);
      const code =
        /Không tìm thấy dự án|Chưa có trên server|không phải git repository/i.test(msg) ? 400 : 500;
      console.error('[project-assistant]', msg);
      res.status(code).json({ error: msg });
    }
  });

  router.get('/api/ai/models', authenticateToken, async (req, res) => {
    try {
      const models = await listModels();
      const info = getActiveLlmInfo();
      res.json({
        models: models.data || models,
        activeInfo: info
      });
    } catch (error) {
      console.error('List Models Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/generate/worklog-comment', authenticateToken, async (req, res) => {
    const { summary, description } = req.body;
    try {
      const comment = await generateWorklogComment(summary, description);
      res.json({ comment });
    } catch (error) {
      console.error('AI Comment Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // AI Agent Endpoints
  // ==========================================

  router.post('/api/ai-agent/fix', authenticateToken, async (req, res) => {
    const { ticketKey, projectId, ticketDetails, additionalContext, approveImmediately } = req.body;
    if (!ticketKey || !projectId || !ticketDetails) {
      return res.status(400).json({ error: 'Missing ticketKey, projectId or ticketDetails' });
    }

    try {
      const projectRes = await db.query('SELECT id, name, cloned_initialized FROM app_projects WHERE id = $1', [projectId]);
      if (projectRes.rows.length === 0) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const project = projectRes.rows[0];
      if (!project.cloned_initialized) {
        return res.status(400).json({
          error: `Project "${project.name}" chưa được clone từ màn hình Cấu hình Dự án. Vui lòng bấm Clone project trước khi chạy AI Fix.`,
        });
      }
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }

    triggerAiFix(ticketKey, projectId, ticketDetails, additionalContext, { approveImmediately: !!approveImmediately });
    
    res.json({ success: true, message: 'AI Fix started in background' });
  });

  router.post('/api/ai-agent/approve/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    resumeAiFix(id);
    res.json({ success: true, message: 'AI Fix resumed after approval' });
  });

  router.post('/api/ai-agent/retry/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    resumeAiFix(id);
    res.json({ success: true, message: 'AI Agent is retrying the fix' });
  });

  router.post('/api/ai-agent/reject/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { feedback } = req.body;
    
    if (!feedback) {
      return res.status(400).json({ error: 'Missing feedback for re-planning' });
    }
    
    resumeAiFix(id, feedback);
    res.json({ success: true, message: 'AI Agent is re-planning based on your feedback' });
  });

  router.post('/api/ai-agent/stop/:ticketKey', authenticateToken, async (req, res) => {
    const { ticketKey } = req.params;
    try {
      await db.query(`
        UPDATE app_ai_fixes 
        SET status = 'failure', 
            current_step = 'Stopped by User', 
            log = COALESCE(log, '') || '\n[' || NOW() || '] Process stopped manually by user.'
        WHERE ticket_key = $1 AND status = 'in_progress'
      `, [ticketKey]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/ai-agent/fix/:ticketKey', authenticateToken, async (req, res) => {
    try {
      const result = await db.query(
        'SELECT * FROM app_ai_fixes WHERE ticket_key = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.ticketKey]
      );
      res.json(result.rows[0] || null);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

