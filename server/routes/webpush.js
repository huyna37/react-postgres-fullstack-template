const express = require('express');
const webPush = require('web-push');
const db = require('../db');
const notificationCron = require('../services/notificationCron');
module.exports = (context) => {
  const router = express.Router();
  const { authenticateToken } = context;

  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  // Endpoint to send the public key to the frontend
  router.get('/api/webpush/vapid-public-key', (req, res) => {
    res.send(process.env.VAPID_PUBLIC_KEY);
  });

  // Endpoint to save a subscription
  router.post('/api/webpush/subscribe', authenticateToken, async (req, res) => {
    const subscription = req.body;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    try {
      const { endpoint, keys: { auth, p256dh } } = subscription;
      const userId = req.user.id;

      await db.query(
        `INSERT INTO app_push_subscriptions (user_id, endpoint, auth, p256dh)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, endpoint) DO UPDATE
         SET auth = EXCLUDED.auth, p256dh = EXCLUDED.p256dh, created_at = CURRENT_TIMESTAMP`,
        [userId, endpoint, auth, p256dh]
      );

      res.status(201).json({ success: true });
    } catch (error) {
      console.error('Error saving push subscription:', error.message);
      res.status(500).json({ error: 'Failed to save subscription' });
    }
  });

  // Optional: Endpoint to remove a subscription
  router.post('/api/webpush/unsubscribe', authenticateToken, async (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });

    try {
      await db.query(
        'DELETE FROM app_push_subscriptions WHERE user_id = $1 AND endpoint = $2',
        [req.user.id, endpoint]
      );
      res.json({ success: true });
    } catch (error) {
      console.error('Error removing push subscription:', error.message);
      res.status(500).json({ error: 'Failed to remove subscription' });
    }
  });

  // SSE — luôn dùng khi tab đang mở (song song web push)
  router.get('/api/webpush/sse', authenticateToken, (req, res) => {
    const userId = req.user.id;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    req.socket.setTimeout(0);

    const tabId = typeof req.query.tabId === 'string' ? req.query.tabId.trim() : '';
    const page = typeof req.query.page === 'string' ? req.query.page.trim() : 'dashboard';

    notificationCron.addSseClient(userId, res, {
      username: req.user.username || null,
      appRole: req.user.role || null,
      tabId: tabId || undefined,
      page: page || 'dashboard',
    });

    const keepAlive = setInterval(() => {
      res.write('event: heartbeat\ndata: ping\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      notificationCron.removeSseClient(userId, res);
    });
  });

  return router;
};
