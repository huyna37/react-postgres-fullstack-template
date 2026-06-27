const express = require('express');
const db = require('../db');
const notificationCron = require('../services/notificationCron');
const { resolveActingUserId } = require('../lib/jiraUserLogin');

/** Chuẩn hoá danh sách người nhận; remap id JWT cũ → id thật trong jira_users (sau merge app_accounts). */
async function validateAndResolveRecipientIds(db, rawIds, jwtUser) {
  const ids = [
    ...new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map(id => parseInt(id, 10))
        .filter(id => Number.isFinite(id))
    ),
  ];
  if (ids.length === 0) return { recipientIds: null };

  const loadActiveIds = async candidateIds => {
    const res = await db.query(
      'SELECT id FROM jira_users WHERE id = ANY($1::int[]) AND is_active = true',
      [candidateIds]
    );
    return new Set(res.rows.map(r => Number(r.id)));
  };

  let found = await loadActiveIds(ids);
  let resolved = [...ids];

  const missing = resolved.filter(id => !found.has(id));
  if (missing.length > 0 && jwtUser?.username) {
    const meRes = await db.query(
      `SELECT id FROM jira_users
       WHERE is_active = true
         AND LOWER(TRIM(COALESCE(username, ''))) = LOWER(TRIM($1))
       LIMIT 1`,
      [jwtUser.username]
    );
    const realMeId = meRes.rows[0] ? Number(meRes.rows[0].id) : null;
    if (realMeId != null && missing.includes(Number(jwtUser.id))) {
      resolved = [...new Set(resolved.map(id => (id === Number(jwtUser.id) ? realMeId : id)))];
      found = await loadActiveIds(resolved);
    }
  }

  const stillMissing = resolved.filter(id => !found.has(id));
  if (stillMissing.length > 0) {
    return { error: 'Một hoặc nhiều tài khoản người nhận không hợp lệ', missingIds: stillMissing };
  }

  return { recipientIds: resolved };
}

const mapBroadcastRow = (row, accountMap) => {
  const recipientIds = Array.isArray(row.recipient_ids)
    ? row.recipient_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : null;
  const hasRecipients = recipientIds && recipientIds.length > 0;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    created_at: row.created_at,
    created_by_username: row.created_by_username || null,
    recipient_ids: hasRecipients ? recipientIds : null,
    recipient_usernames: hasRecipients
      ? recipientIds.map((id) => accountMap.get(id)).filter(Boolean)
      : null,
  };
};

module.exports = (context) => {
  const router = express.Router();
  const { authenticateToken, requireAdmin } = context;

  // ==========================================
  // Broadcast Notifications
  // ==========================================

  router.get('/api/admin/notifications/broadcasts', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const [result, accountsRes] = await Promise.all([
        db.query(
          `SELECT b.id, b.title, b.body, b.created_at, b.recipient_ids, a.username AS created_by_username
           FROM app_broadcast_notifications b
           LEFT JOIN jira_users a ON a.id = b.created_by
           ORDER BY b.id DESC
           LIMIT 50`
        ),
        db.query('SELECT id, username FROM jira_users WHERE is_active = true'),
      ]);
      const accountMap = new Map(accountsRes.rows.map((r) => [r.id, r.username]));
      res.json(result.rows.map((row) => mapBroadcastRow(row, accountMap)));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/admin/notifications/broadcast', authenticateToken, requireAdmin, async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!title || !body) {
      return res.status(400).json({ error: 'Tiêu đề và nội dung không được để trống' });
    }

    try {
      const createdBy = await resolveActingUserId(db, req.user);
      let recipientIds = null;

      if (req.body?.testSelf === true) {
        if (!createdBy) {
          return res.status(400).json({ error: 'Không xác định được người dùng hiện tại' });
        }
        recipientIds = [createdBy];
      } else {
        const resolved = await validateAndResolveRecipientIds(
          db,
          req.body?.recipientIds,
          req.user
        );
        if (resolved.error) {
          return res.status(400).json({ error: resolved.error });
        }
        recipientIds = resolved.recipientIds;
      }

      const result = await db.query(
        `INSERT INTO app_broadcast_notifications (title, body, created_by, recipient_ids)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, title, body, created_at, recipient_ids`,
        [title, body, createdBy, recipientIds ? JSON.stringify(recipientIds) : null]
      );

      // --- Send Web Push Notifications ---
      try {
        const webPush = require('web-push');
        
        // Fetch subscriptions
        let subsQuery = 'SELECT user_id, endpoint, auth, p256dh FROM app_push_subscriptions';
        let subsParams = [];
        if (recipientIds) {
          subsQuery += ' WHERE user_id = ANY($1::int[])';
          subsParams = [recipientIds];
        }
        
        const subsRes = await db.query(subsQuery, subsParams);
        const subscriptions = subsRes.rows;

        const payload = JSON.stringify({
          title: `📢 ${title}`,
          body: body,
          icon: '/notify-broadcast.svg',
          url: '/'
        });

        const pushPromises = subscriptions.map(async (sub) => {
          const pushSubscription = {
            endpoint: sub.endpoint,
            keys: {
              auth: sub.auth,
              p256dh: sub.p256dh
            }
          };
          try {
            await webPush.sendNotification(pushSubscription, payload, { TTL: 43200 }); // 12 hours TTL
          } catch (error) {
            console.error(`Error sending push to user ${sub.user_id}:`, error.message);
            if (error.statusCode === 404 || error.statusCode === 410) {
              // Subscription has expired or is no longer valid
              await db.query('DELETE FROM app_push_subscriptions WHERE endpoint = $1', [sub.endpoint]);
            }
          }
        });

        // Don't await so the request doesn't block
        Promise.all(pushPromises).catch(err => console.error('Push notification batch error:', err));
        
        // --- Send via SSE Fallback ---
        try {
          notificationCron.sendSseToUsers(recipientIds, payload);
          console.log(`[Notifications] Sent broadcast via SSE to ${recipientIds ? recipientIds.length + ' users' : 'all users'}`);
        } catch (sseErr) {
          console.error('Failed to send broadcast via SSE:', sseErr.message);
        }
      } catch (pushErr) {
        console.error('Failed to trigger web push notifications:', pushErr.message);
      }
      // -----------------------------------

      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/notifications/broadcasts', authenticateToken, async (req, res) => {
    try {
      const after = parseInt(req.query.after, 10) || 0;
      const userId = req.user.id;
      const result = await db.query(
        `SELECT id, title, body, created_at
         FROM app_broadcast_notifications
         WHERE id > $1
           AND (
             recipient_ids IS NULL
             OR jsonb_array_length(recipient_ids) = 0
             OR recipient_ids @> to_jsonb(ARRAY[$2::int])
           )
         ORDER BY id ASC
         LIMIT 20`,
        [after, userId]
      );
      res.json(result.rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/admin/notifications/broadcasts/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'ID không hợp lệ' });
      }
      const result = await db.query('DELETE FROM app_broadcast_notifications WHERE id = $1 RETURNING id', [id]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Không tìm thấy thông báo' });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/admin/notifications/broadcasts', authenticateToken, requireAdmin, async (req, res) => {
    try {
      await db.query('DELETE FROM app_broadcast_notifications');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/admin/settings/notifications', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await db.query(`SELECT value FROM app_settings WHERE key = 'allowed_notification_types'`);
      const projResult = await db.query(`SELECT value FROM app_settings WHERE key = 'notification_projects'`);
      
      let allowedTypes = ['bug_commit', 'subtask_resolved'];
      if (result.rows.length > 0) {
        allowedTypes = result.rows[0].value;
      }
      
      let notificationProjects = [];
      if (projResult.rows.length > 0 && Array.isArray(projResult.rows[0].value)) {
        notificationProjects = projResult.rows[0].value;
      }
      
      res.json({ allowedTypes, notificationProjects });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/admin/settings/notifications', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const allowedTypes = req.body?.allowedTypes;
      const notificationProjects = req.body?.notificationProjects;

      if (!Array.isArray(allowedTypes)) {
        return res.status(400).json({ error: 'Cấu hình allowedTypes phải là mảng' });
      }
      
      if (notificationProjects !== undefined && !Array.isArray(notificationProjects)) {
        return res.status(400).json({ error: 'Cấu hình notificationProjects phải là mảng' });
      }

      await db.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('allowed_notification_types', $1::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [JSON.stringify(allowedTypes)]
      );
      
      if (notificationProjects !== undefined) {
        await db.query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ('notification_projects', $1::jsonb, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [JSON.stringify(notificationProjects)]
        );
      }
      
      res.json({ success: true, allowedTypes, notificationProjects });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/admin/notifications/force-refresh', authenticateToken, requireAdmin, async (req, res) => {
    try {
      notificationCron.sendSseToUsers(null, JSON.stringify({ type: 'FORCE_REFRESH' }));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

