const express = require('express');
const notificationCron = require('../services/notificationCron');

module.exports = context => {
  const router = express.Router();
  const { authenticateToken, requireAdmin } = context;

  router.put('/api/presence/page', authenticateToken, (req, res) => {
    const page = typeof req.body?.page === 'string' ? req.body.page.trim() : '';
    const tabId = typeof req.body?.tabId === 'string' ? req.body.tabId.trim() : '';
    if (!page) {
      return res.status(400).json({ error: 'page is required' });
    }
    const updated = notificationCron.setUserTabPage(req.user.id, tabId, page);
    if (!updated) {
      return res.status(204).end();
    }
    res.status(204).end();
  });

  router.get('/api/presence/online', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const snapshot = await notificationCron.getPresenceSnapshot();
      res.json(snapshot);
    } catch (error) {
      console.error('[Presence] online snapshot error:', error.message);
      res.status(500).json({ error: error.message || 'Failed to fetch online users' });
    }
  });

  router.get('/api/presence/monitor/sse', authenticateToken, requireAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setTimeout(0);

    notificationCron.addPresenceMonitorClient(res);
    void notificationCron.sendPresenceToClient(res);

    const keepAlive = setInterval(() => {
      res.write('event: heartbeat\ndata: ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      notificationCron.removePresenceMonitorClient(res);
    });
  });

  return router;
};
