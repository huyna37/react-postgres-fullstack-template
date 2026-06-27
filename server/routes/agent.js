const express = require('express');
const { fetchAgentTickets } = require('../lib/agentTicketsFromDb');
const { parseCommentEmail, parseCommentItems, postAgentComments } = require('../lib/agentCommentPost');
const {
  parseTransitionItems,
  postAgentTransitions,
  fetchAgentTicketTransitions,
} = require('../lib/agentStatusPost');
const { requireUserJiraTokenByEmail } = require('../lib/jiraToken');
const { resolveAttachmentFile } = require('../lib/jiraAttachmentCache');

module.exports = ({ db, httpsAgent }) => {
  const router = express.Router();

  /**
   * Public — không cần đăng nhập. Dùng cho Cursor multi-agent / automation bên ngoài.
   *
   * GET /api/agent/tickets?email=huyna@etc.vn&type=bug&projectKey=BXDCSDL&status=open&limit=100
   *
   * type: bug | subtask | dev | test | all
   * status: open (default) | all
   * Bỏ qua ticket Cancelled / Rejected (Từ chối).
   */
  router.get('/api/agent/tickets', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const email = req.query.email || req.query.assignee || req.query.user;
      const data = await fetchAgentTickets({
        email,
        type: req.query.type,
        projectKey: req.query.projectKey || req.query.project,
        status: req.query.status,
        limit: req.query.limit,
        httpsAgent,
      });
      res.json(data);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error('[API /api/agent/tickets]', error);
      }
      res.status(status).json({
        success: false,
        error: error.message || 'Failed to fetch agent tickets',
      });
    }
  });

  /**
   * POST /api/agent/comments
   *
   * Body:
   * {
   *   "email": "huyna@etc.vn",
   *   "comments": [
   *     { 
   *       "key": "BXDCSDL-123", 
   *       "text": "Đã fix xong (tùy chọn nếu có images)",
   *       "images": [
   *         { "dataBase64": "iVBOR...", "filename": "capture.png", "mimeType": "image/png" }
   *       ]
   *     },
   *     { "key": "BXDCSDL-456", "text": "Cần thêm thông tin" }
   *   ]
   * }
   *
   * Tìm user theo email trong hệ thống, dùng Jira Token cá nhân của user đó để comment.
   */
  router.post('/api/agent/comments', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const email = parseCommentEmail(req.body, req.query);
      const items = parseCommentItems(req.body);
      const data = await postAgentComments({ email, items, db, httpsAgent });
      const status = data.failed > 0 && data.ok === 0 ? 500 : data.failed > 0 ? 207 : 200;
      res.status(status).json(data);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error('[API /api/agent/comments]', error);
      }
      res.status(status).json({
        success: false,
        error: error.message || 'Failed to post comments',
      });
    }
  });

  /**
   * GET /api/agent/tickets/:key/transitions?email=huyna@etc.vn
   *
   * Liệt kê transition khả dụng của ticket (theo trạng thái hiện tại trên Jira).
   */
  router.get('/api/agent/tickets/:key/transitions', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const email = req.query.email || req.query.assignee || req.query.user;
      const data = await fetchAgentTicketTransitions({
        email,
        key: req.params.key,
        db,
        httpsAgent,
      });
      res.json({ success: true, ...data });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error('[API /api/agent/tickets/:key/transitions]', error);
      }
      res.status(status).json({
        success: false,
        error: error.message || 'Failed to fetch transitions',
      });
    }
  });

  /**
   * POST /api/agent/transitions
   *
   * Chỉ đổi trạng thái ticket — không gửi comment (dùng POST /api/agent/comments).
   *
   * Body:
   * {
   *   "email": "huyna@etc.vn",
   *   "transitions": [
   *     { "key": "BXDCSDL-123", "status": "Done" },
   *     { "key": "BXDCSDL-456", "transitionId": "31" }
   *   ]
   * }
   *
   * Mỗi phần tử: key + transitionId | status | transitionName.
   * fields (tùy chọn): field bắt buộc trên màn hình transition của Jira (resolution, …).
   */
  router.post('/api/agent/transitions', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const email = parseCommentEmail(req.body, req.query);
      const items = parseTransitionItems(req.body);
      const data = await postAgentTransitions({ email, items, db, httpsAgent });
      const status = data.failed > 0 && data.ok === 0 ? 500 : data.failed > 0 ? 207 : 200;
      res.status(status).json({ success: data.failed === 0, ...data });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error('[API /api/agent/transitions]', error);
      }
      res.status(status).json({
        success: false,
        error: error.message || 'Failed to update ticket status',
        requiredFields: error.requiredFields || undefined,
        transition: error.transition || undefined,
      });
    }
  });

  /**
   * GET /api/agent/tickets/:key/attachments/:filename
   *
   * Query params:
   * - email=... (hoặc assignee, user)
   * - variant=full|thumb
   * - base64=true (trả về JSON { filename, mimeType, dataBase64: '...' })
   */
  router.get('/api/agent/tickets/:key/attachments/:filename', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const email = req.query.email || req.query.assignee || req.query.user;
      if (!email) {
        return res.status(400).json({ success: false, error: 'email is required' });
      }

      const { token } = await requireUserJiraTokenByEmail(db, email);
      const jiraBaseUrl = process.env.JIRA_URL || '';
      if (!jiraBaseUrl) {
        return res.status(503).json({ success: false, error: 'JIRA_URL chưa cấu hình trên server' });
      }

      const { key, filename } = req.params;
      const decodedFilename = decodeURIComponent(filename);
      const variant = req.query.variant === 'thumb' ? 'thumb' : 'full';

      const file = await resolveAttachmentFile(
        jiraBaseUrl,
        key,
        decodedFilename,
        token,
        httpsAgent,
        { variant, db }
      );

      if (!file) {
        return res.status(404).json({ success: false, error: 'Attachment not found' });
      }

      if (req.query.base64 === 'true') {
        return res.json({
          filename: decodedFilename,
          mimeType: file.contentType,
          dataBase64: file.buffer.toString('base64'),
        });
      }

      res.setHeader('Content-Type', file.contentType);
      res.send(file.buffer);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        console.error('[API /api/agent/tickets/:key/attachments/:filename]', error);
      }
      res.status(status).json({
        success: false,
        error: error.message || 'Failed to fetch attachment',
      });
    }
  });

  router.get('/api/agent/health', (_req, res) => {
    res.json({
      success: true,
      service: 'jira-agent',
      public: true,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
};
