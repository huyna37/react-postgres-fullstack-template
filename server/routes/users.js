const express = require('express');
const { getUserJiraTokenFromDb, requireUserJiraToken } = require('../lib/jiraToken');
const {
  DEFAULT_SYNC_PASSWORD,
  hashPassword,
  enableLoginForAccount,
  ensureDefaultSyncCredentials,
} = require('../lib/jiraUserLogin');
const axios = require('axios');
const db = require('../db');

module.exports = (context) => {
  const router = express.Router();
  const {
    authenticateToken,
    optionalAuth,
    requireAdmin,
    httpsAgent
  } = context;

  // ==========================================
  // JIRA Users DB Lookups & Management
  // ==========================================

  // 1. Get all users from DB
  router.get('/api/users/db', optionalAuth, async (req, res) => {
    try {
      const result = await db.query(
        `SELECT id, account_id as "accountId", display_name as "displayName", email_address as "emailAddress",
                avatar_url as "avatarUrl", is_active as "isActive", role,
                jira_project as "jiraProject", sort_order as "sortOrder", username,
                (password_hash IS NOT NULL) AS "canLogin", app_role AS "appRole"
         FROM jira_users ORDER BY is_active DESC, sort_order DESC, display_name ASC`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('DB Fetch Error:', err.message);
      res.status(500).json({ error: 'Failed to fetch users from DB' });
    }
  });

  // 2. Get only active users for dropdowns
  // Prioritize projectKey from query param, then logged-in user's project, otherwise return all active users
  router.get('/api/users/active', authenticateToken, async (req, res) => {
    const userProject = req.query.projectKey || req.user?.jira_project;
    try {
      let result;
      if (userProject) {
        result = await db.query(
          `SELECT account_id as "accountId", display_name as "displayName", email_address as "emailAddress", avatar_url as "avatarUrl", role, sort_order as "sortOrder"
           FROM jira_users
            WHERE is_active = true
              AND string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]
            ORDER BY sort_order DESC, display_name ASC`,
          [userProject]
        );
      } else {
        result = await db.query(
          'SELECT account_id as "accountId", display_name as "displayName", email_address as "emailAddress", avatar_url as "avatarUrl", role, sort_order as "sortOrder" FROM jira_users WHERE is_active = true ORDER BY sort_order DESC, display_name ASC'
        );
      }
      res.json(result.rows);
    } catch (err) {
      console.error('DB Fetch Active Error:', err.message);
      res.status(500).json({ error: 'Failed to fetch active users from DB' });
    }
  });

  // 3. Toggle user active status
  router.put('/api/users/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive phải là boolean.' });
    }
    try {
      const result = await db.query(
        `UPDATE jira_users SET is_active = $1, updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $2
         RETURNING account_id`,
        [isActive, id]
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Không tìm thấy người dùng để cập nhật.' });
      }
      res.json({ success: true, isActive });
    } catch (err) {
      console.error('DB Update Error:', err.message);
      res.status(500).json({ error: 'Failed to update user status' });
    }
  });

  // 4. Update user role
  router.put('/api/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    try {
      await db.query('UPDATE jira_users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2', [role, id]);
      res.json({ success: true });
    } catch (err) {
      console.error('DB Update Role Error:', err.message);
      res.status(500).json({ error: 'Failed to update user role' });
    }
  });

  // 5. Update user project assignment
  router.put('/api/users/:id/project', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { jiraProject } = req.body;
    try {
      await db.query('UPDATE jira_users SET jira_project = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2', [jiraProject || null, id]);
      res.json({ success: true });
    } catch (err) {
      console.error('DB Update Project Error:', err.message);
      res.status(500).json({ error: 'Failed to update user project' });
    }
  });

  // 6. Update user sort order
  router.put('/api/users/:id/sort-order', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { sortOrder } = req.body;
    try {
      await db.query('UPDATE jira_users SET sort_order = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2', [parseInt(sortOrder) || 0, id]);
      res.json({ success: true });
    } catch (err) {
      console.error('DB Update Sort Order Error:', err.message);
      res.status(500).json({ error: 'Failed to update user sort order' });
    }
  });

  // Avatar proxy endpoint to fetch user avatars from Jira with authentication
  router.get('/api/users/avatar', optionalAuth, async (req, res) => {
    try {
      const { url } = req.query;
      if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
      }

      const jiraUrl = process.env.JIRA_URL;
      if (jiraUrl && !url.startsWith(jiraUrl) && !url.startsWith('/')) {
        return res.status(400).json({ error: 'Invalid avatar URL' });
      }

      const targetUrl = url.startsWith('/') ? `${jiraUrl}${url}` : url;
      const token = await getUserJiraTokenFromDb(db, req.user?.id);
      if (!token) {
        return res.status(401).json({ error: 'Cần đăng nhập và cấu hình Jira Token để tải avatar.' });
      }

      const response = await axios.get(targetUrl, {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'arraybuffer',
        httpsAgent
      });

      const contentType = response.headers['content-type'] || 'image/png';
      res.setHeader('Content-Type', contentType);
      res.send(response.data);
    } catch (error) {
      console.error('Error proxying avatar:', error.message);
      res.status(500).json({ error: 'Failed to fetch avatar' });
    }
  });

  const resolveSyncProjectKeys = async req => {
    const fromUser = String(req.user?.jira_project || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (fromUser.length > 0) return [...new Set(fromUser)];

    const envKey = process.env.JIRA_PROJECT_KEY;
    if (envKey) return [envKey];

    const projRes = await db.query(
      `SELECT DISTINCT TRIM(unnest(string_to_array(jira_project, ','))) AS project_key
       FROM jira_users
       WHERE jira_project IS NOT NULL AND TRIM(jira_project) != ''`
    );
    const fromDb = projRes.rows.map(r => r.project_key).filter(Boolean);
    if (fromDb.length > 0) return [...new Set(fromDb)];

    return ['BXDCSDL'];
  };

  const mergeLocalLoginIntoJiraAccount = async (accountId, emailAddress) => {
    if (!emailAddress) return;
    const localRes = await db.query(
      `SELECT * FROM jira_users
       WHERE account_id LIKE 'local:%'
         AND LOWER(TRIM(COALESCE(email_address, username, ''))) = LOWER($1)
       LIMIT 1`,
      [emailAddress]
    );
    if (localRes.rows.length === 0) return;

    const local = localRes.rows[0];
    const targetRes = await db.query(`SELECT id FROM jira_users WHERE account_id = $1`, [accountId]);
    const targetId = targetRes.rows[0]?.id;

    await db.query(
      `UPDATE jira_users SET
        username = COALESCE(username, $2),
        password_hash = COALESCE(password_hash, $3),
        app_role = COALESCE(app_role, $4),
        permissions = COALESCE(permissions, $5),
        jira_token = COALESCE(jira_token, $6),
        jira_project = COALESCE(NULLIF(jira_project, ''), $7),
        theme_preference = COALESCE(theme_preference, $8),
        updated_at = CURRENT_TIMESTAMP
       WHERE account_id = $1`,
      [
        accountId,
        local.username,
        local.password_hash,
        local.app_role,
        local.permissions,
        local.jira_token,
        local.jira_project,
        local.theme_preference,
      ]
    );

    if (local.id && targetId && local.id !== targetId) {
      await db.query('UPDATE cron_worklogs SET user_id = $1 WHERE user_id = $2', [targetId, local.id]);
      await db.query('UPDATE app_push_subscriptions SET user_id = $1 WHERE user_id = $2', [targetId, local.id]);
      await db.query('UPDATE app_broadcast_notifications SET created_by = $1 WHERE created_by = $2', [
        targetId,
        local.id,
      ]);
    }

    await db.query(`DELETE FROM jira_users WHERE account_id = $1`, [local.account_id]);
  };

  router.post('/api/users/:id/enable-login', authenticateToken, requireAdmin, async (req, res) => {
    const { id: accountId } = req.params;
    try {
      const result = await enableLoginForAccount(db, accountId, DEFAULT_SYNC_PASSWORD);
      res.json({
        success: true,
        username: result.username,
        alreadyEnabled: result.alreadyEnabled,
        defaultPassword: result.alreadyEnabled ? null : DEFAULT_SYNC_PASSWORD,
      });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Không bật được đăng nhập.' });
    }
  });

  // 7. Sync users from Jira to DB
  router.post('/api/users/sync', authenticateToken, requireAdmin, async (req, res) => {
    if (!process.env.JIRA_URL) {
      return res.status(500).json({ error: 'Chưa cấu hình JIRA_URL trên server.' });
    }

    const projectKeys = await resolveSyncProjectKeys(req);
    const assignableUrl = `${process.env.JIRA_URL}/rest/api/2/user/assignable/search`;
    const generalSearchUrl = `${process.env.JIRA_URL}/rest/api/2/user/search`;
    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;

    let allUsersMap = new Map();

    const fetchUsers = async (apiUrl, apiParams, label) => {
      let startAt = 0;
      const maxResults = 1000;
      let hasMore = true;
      console.log(`Starting ${label} sync...`);

      while (hasMore) {
        const response = await axios.get(apiUrl, {
          headers: { Authorization: `Bearer ${token}` },
          params: { ...apiParams, startAt, maxResults },
          httpsAgent,
        });

        const users = response.data || [];
        for (const u of users) {
          const id = u.accountId || u.name || u.key;
          if (id) allUsersMap.set(id, u);
        }

        console.log(`[${label}] Fetched batch: ${users.length} users (Total unique: ${allUsersMap.size})`);
        if (users.length < maxResults) hasMore = false;
        else startAt += maxResults;
      }
    };

    try {
      for (const projectKey of projectKeys) {
        await fetchUsers(assignableUrl, { project: projectKey }, `Assignable Users (${projectKey})`);
      }
      await fetchUsers(
        generalSearchUrl,
        { username: '.', includeActive: true, includeInactive: true },
        'General Search'
      );

      let syncedCount = 0;
      const allUsers = Array.from(allUsersMap.values());
      const defaultPasswordHash = await hashPassword(DEFAULT_SYNC_PASSWORD);

      for (const user of allUsers) {
        const accountId = user.accountId || user.name || user.key;
        if (!accountId) continue;

        const avatarUrl = user.avatarUrls?.['48x48'] || user.avatarUrls?.['24x24'] || null;

        const syncResult = await db.query(
          `
          INSERT INTO jira_users (account_id, display_name, email_address, avatar_url, is_active)
          VALUES ($1, $2, $3, $4, false)
          ON CONFLICT (account_id) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              email_address = COALESCE(EXCLUDED.email_address, jira_users.email_address),
              avatar_url = COALESCE(EXCLUDED.avatar_url, jira_users.avatar_url),
              updated_at = CURRENT_TIMESTAMP
          RETURNING (xmax = 0) AS inserted
          `,
          [accountId, user.displayName, user.emailAddress, avatarUrl]
        );

        const isNewRow = syncResult.rows[0]?.inserted === true;

        if (user.emailAddress) {
          await mergeLocalLoginIntoJiraAccount(accountId, user.emailAddress);
        }

        if (isNewRow) {
          await ensureDefaultSyncCredentials(db, accountId, user, defaultPasswordHash);
        }

        if (syncResult.rowCount > 0) syncedCount++;
      }

      console.log(
        `[Users Sync] Done — projects: ${projectKeys.join(', ')}; processed ${allUsers.length}, touched ${syncedCount}`
      );
      res.json({ success: true, syncedCount, totalProcessed: allUsers.length, projectKeys });
    } catch (error) {
      const details = error.response?.data?.errorMessages?.join?.('; ')
        || error.response?.data?.message
        || error.message;
      console.error('Jira API Sync Error:', error.response ? error.response.data : error.message);
      res.status(500).json({
        error: 'Không đồng bộ được người dùng từ Jira',
        details,
      });
    }
  });

  return router;
};

