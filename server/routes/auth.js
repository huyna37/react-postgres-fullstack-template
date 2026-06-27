const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const {
  DEFAULT_PERMISSIONS,
  mapAuthUser,
  buildJwtPayload,
  localAccountId,
} = require('../lib/jiraUserAuth');
const {
  hashPassword,
  resolveUniqueSyncUsername,
  profileFromRow,
  findLoginUserByIdentifier,
} = require('../lib/jiraUserLogin');

module.exports = (context) => {
  const router = express.Router();
  const {
    JWT_SECRET,
    authenticateToken,
    requireAdmin,
    getPublicPagesFromDb,
    savePublicPagesToDb,
    DEFAULT_PUBLIC_PAGES,
    getDefaultThemeFromDb,
    saveDefaultThemeToDb,
    DEFAULT_THEME
  } = context;

  const LOGIN_ACCOUNT_SQL = `
    SELECT id, username, password_hash, app_role, permissions, jira_token, jira_project, theme_preference
    FROM jira_users
    WHERE id = $1 AND password_hash IS NOT NULL
    LIMIT 1
  `;

  // ==========================================
  // Auth Endpoints
  // ==========================================

  router.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = await findLoginUserByIdentifier(db, username);
      if (!user) return res.status(400).json({ error: 'Invalid credentials' });
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });

      const token = jwt.sign(buildJwtPayload(user), JWT_SECRET, { expiresIn: '180d' });
      res.json({ token, user: mapAuthUser(user) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/me', authenticateToken, async (req, res) => {
    try {
      const userRes = await db.query(LOGIN_ACCOUNT_SQL, [req.user.id]);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(mapAuthUser(userRes.rows[0]));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/me/theme', authenticateToken, async (req, res) => {
    try {
      const { theme } = req.body;
      const normalizedTheme = theme === 'light' ? 'light' : 'dark';
      await db.query(
        'UPDATE jira_users SET theme_preference = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [normalizedTheme, req.user.id]
      );
      res.json({ success: true, theme: normalizedTheme });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/me/config', authenticateToken, async (req, res) => {
    try {
      const { jira_token, jira_project } = req.body;
      await db.query(
        'UPDATE jira_users SET jira_token = $1, jira_project = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [jira_token, jira_project, req.user.id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // Login accounts (stored in jira_users)
  // ==========================================

  router.get('/api/admin/accounts', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const result = await db.query(
        `SELECT
          id,
          account_id AS "accountId",
          display_name AS "displayName",
          email_address AS "emailAddress",
          avatar_url AS "avatarUrl",
          username,
          app_role AS "appRole",
          role AS "teamRole",
          permissions,
          jira_project AS "jiraProject",
          sort_order AS "sortOrder",
          is_active AS "isActive",
          created_at,
          (password_hash IS NOT NULL) AS "canLogin"
         FROM jira_users
         ORDER BY is_active DESC, sort_order DESC, display_name ASC`
      );
      const rows = result.rows.map(row => ({
        ...row,
        permissions: JSON.parse(row.permissions || '[]'),
      }));
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/admin/accounts', authenticateToken, requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    try {
      const normalizedUsername = String(username || '').trim();
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      const existing = await db.query(
        `SELECT account_id, id FROM jira_users
         WHERE LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
            OR LOWER(TRIM(COALESCE(email_address, ''))) = LOWER($1)
         LIMIT 1`,
        [normalizedUsername]
      );

      let result;
      if (existing.rows.length > 0) {
        result = await db.query(
          `UPDATE jira_users SET
            username = $1,
            password_hash = $2,
            app_role = $3,
            permissions = COALESCE(permissions, $4),
            is_active = true,
            updated_at = CURRENT_TIMESTAMP
           WHERE account_id = $5
           RETURNING id, username, app_role AS role`,
          [
            normalizedUsername,
            hash,
            role || 'user',
            JSON.stringify(DEFAULT_PERMISSIONS),
            existing.rows[0].account_id,
          ]
        );
      } else {
        result = await db.query(
          `INSERT INTO jira_users (
            account_id, display_name, username, password_hash, app_role, permissions, is_active
          ) VALUES ($1, $2, $3, $4, $5, $6, true)
          RETURNING id, username, app_role AS role`,
          [
            localAccountId(normalizedUsername),
            normalizedUsername,
            normalizedUsername,
            hash,
            role || 'user',
            JSON.stringify(DEFAULT_PERMISSIONS),
          ]
        );
      }
      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/admin/accounts/:id/role', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;
    try {
      await db.query(
        'UPDATE jira_users SET app_role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND password_hash IS NOT NULL',
        [role, id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/admin/accounts/:id/permissions', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { permissions } = req.body;
    try {
      await db.query(
        'UPDATE jira_users SET permissions = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND password_hash IS NOT NULL',
        [JSON.stringify(permissions), id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/admin/accounts/:id/password', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    try {
      if (!password || !String(password).trim()) {
        return res.status(400).json({ error: 'Mật khẩu không được để trống.' });
      }

      const userRes = await db.query(
        `SELECT id, account_id, username, password_hash, email_address, display_name
         FROM jira_users WHERE id = $1`,
        [id]
      );
      if (!userRes.rows.length) {
        return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
      }

      const user = userRes.rows[0];
      const hash = await hashPassword(password);

      if (!user.password_hash) {
        const username = await resolveUniqueSyncUsername(db, profileFromRow(user), user.account_id);
        await db.query(
          `UPDATE jira_users SET
            username = COALESCE(NULLIF(TRIM(username), ''), $2),
            password_hash = $3,
            app_role = COALESCE(app_role, 'user'),
            permissions = COALESCE(permissions, $4),
            updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, username, hash, JSON.stringify(DEFAULT_PERMISSIONS)]
        );
      } else {
        await db.query(
          'UPDATE jira_users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [hash, id]
        );
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete('/api/admin/accounts/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const userId = parseInt(id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'ID người dùng không hợp lệ.' });
    }
    try {
      if (userId === req.user.id) {
        return res.status(400).json({ error: 'Không thể xóa tài khoản của chính bạn.' });
      }

      const existing = await db.query('SELECT id FROM jira_users WHERE id = $1', [userId]);
      if (existing.rowCount === 0) {
        return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
      }

      await db.query('DELETE FROM cron_worklogs WHERE user_id = $1', [userId]);
      await db.query('UPDATE app_broadcast_notifications SET created_by = NULL WHERE created_by = $1', [
        userId,
      ]);
      const result = await db.query('DELETE FROM jira_users WHERE id = $1 RETURNING id', [userId]);

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Không tìm thấy người dùng.' });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ==========================================
  // Public Pages Configuration
  // ==========================================

  router.get('/api/admin/settings/public-pages', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const publicPages = await getPublicPagesFromDb();
      res.json({ publicPages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/admin/settings/public-pages', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const publicPages = await savePublicPagesToDb(req.body?.publicPages);
      res.json({ success: true, publicPages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/admin/settings/default-theme', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const defaultTheme = await getDefaultThemeFromDb();
      res.json({ defaultTheme });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/api/admin/settings/default-theme', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const defaultTheme = await saveDefaultThemeToDb(req.body?.defaultTheme);
      res.json({ success: true, defaultTheme });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/config', async (req, res) => {
    try {
      const publicPages = await getPublicPagesFromDb();
      const defaultTheme = await getDefaultThemeFromDb();
      res.json({ jiraBaseUrl: process.env.JIRA_URL, publicPages, defaultTheme });
    } catch (err) {
      console.error('Config error:', err.message);
      res.json({ jiraBaseUrl: process.env.JIRA_URL, publicPages: DEFAULT_PUBLIC_PAGES, defaultTheme: DEFAULT_THEME });
    }
  });

  return router;
};
