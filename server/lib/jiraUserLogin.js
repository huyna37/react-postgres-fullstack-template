const bcrypt = require('bcryptjs');
const { DEFAULT_PERMISSIONS, deriveSyncUsername } = require('./jiraUserAuth');

const DEFAULT_SYNC_PASSWORD = '1';

function profileFromRow(row) {
  return {
    emailAddress: row.email_address,
    displayName: row.display_name,
    accountId: row.account_id,
  };
}

async function resolveUniqueSyncUsername(db, profile, accountId) {
  const base = deriveSyncUsername(profile);
  const candidates = [base];
  const email = String(profile.emailAddress || '').trim().toLowerCase();
  if (email && email !== base) candidates.push(email);

  const accountSuffix = String(accountId || '').slice(-6).toLowerCase();
  if (accountSuffix) candidates.push(`${base}.${accountSuffix}`);

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const clash = await db.query(
      `SELECT account_id FROM jira_users
       WHERE LOWER(username) = LOWER($1) AND account_id != $2
       LIMIT 1`,
      [candidate, accountId]
    );
    if (clash.rows.length === 0) return candidate;
  }

  return `${base}.${Date.now()}`;
}

async function hashPassword(password) {
  return bcrypt.hash(password, await bcrypt.genSalt(10));
}

async function enableLoginForAccount(db, accountId, password = DEFAULT_SYNC_PASSWORD) {
  const existing = await db.query(
    `SELECT id, account_id, username, password_hash, email_address, display_name
     FROM jira_users WHERE account_id = $1`,
    [accountId]
  );
  if (!existing.rows.length) {
    throw new Error('Không tìm thấy người dùng.');
  }

  const row = existing.rows[0];
  if (row.password_hash) {
    return { alreadyEnabled: true, id: row.id, username: row.username };
  }

  const username = await resolveUniqueSyncUsername(db, profileFromRow(row), accountId);
  const passwordHash = await hashPassword(password);

  const updated = await db.query(
    `UPDATE jira_users SET
      username = COALESCE(NULLIF(TRIM(username), ''), $2),
      password_hash = $3,
      app_role = COALESCE(app_role, 'user'),
      permissions = COALESCE(permissions, $4),
      updated_at = CURRENT_TIMESTAMP
     WHERE account_id = $1
     RETURNING id, username, app_role`,
    [accountId, username, passwordHash, JSON.stringify(DEFAULT_PERMISSIONS)]
  );

  return {
    alreadyEnabled: false,
    id: updated.rows[0].id,
    username: updated.rows[0].username,
    appRole: updated.rows[0].app_role,
  };
}

async function ensureDefaultSyncCredentials(db, accountId, jiraUser, defaultPasswordHash) {
  const existing = await db.query(
    `SELECT username, password_hash FROM jira_users WHERE account_id = $1`,
    [accountId]
  );
  if (!existing.rows.length || existing.rows[0].password_hash) return;

  const username = await resolveUniqueSyncUsername(db, jiraUser, accountId);
  await db.query(
    `UPDATE jira_users SET
      username = COALESCE(NULLIF(TRIM(username), ''), $2),
      password_hash = $3,
      app_role = COALESCE(app_role, 'user'),
      permissions = COALESCE(permissions, $4),
      updated_at = CURRENT_TIMESTAMP
     WHERE account_id = $1 AND password_hash IS NULL`,
    [accountId, username, defaultPasswordHash, JSON.stringify(DEFAULT_PERMISSIONS)]
  );
}

/** Đăng nhập bằng username, email đầy đủ, hoặc phần trước @ của email. */
async function findLoginUserByIdentifier(db, identifier) {
  const login = String(identifier || '').trim();
  if (!login) return null;

  // Xử lý bỏ qua hậu tố: nếu không có @ thì tự động thêm @etc.vn để so khớp chính xác
  let exactEmail = login;
  if (!login.includes('@')) {
    exactEmail = `${login}@etc.vn`;
  }

  const res = await db.query(
    `SELECT id, username, password_hash, app_role, permissions, jira_token, jira_project, theme_preference
     FROM jira_users
     WHERE password_hash IS NOT NULL
       AND (
         LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
         OR LOWER(TRIM(COALESCE(email_address, ''))) = LOWER($1)
         OR LOWER(TRIM(COALESCE(username, ''))) = LOWER($2)
         OR LOWER(TRIM(COALESCE(email_address, ''))) = LOWER($2)
       )
     ORDER BY
       CASE
         WHEN LOWER(TRIM(COALESCE(username, ''))) = LOWER($1) THEN 0
         WHEN LOWER(TRIM(COALESCE(email_address, ''))) = LOWER($1) THEN 1
         WHEN LOWER(TRIM(COALESCE(username, ''))) = LOWER($2) THEN 2
         WHEN LOWER(TRIM(COALESCE(email_address, ''))) = LOWER($2) THEN 3
         ELSE 4
       END,
       id ASC
     LIMIT 1`,
    [login, exactEmail]
  );
  return res.rows[0] || null;
}

/**
 * Map JWT → id tài khoản login thật trong jira_users.
 * JWT id có thể trùng row Jira sync cũ (vd. id=1 không phải admin) — ưu tiên username.
 */
async function resolveActingUserId(db, jwtUser) {
  if (!jwtUser) return null;

  const loginSql = `
    SELECT id FROM jira_users
    WHERE is_active = true AND password_hash IS NOT NULL
  `;

  if (jwtUser.username) {
    const byUsername = await db.query(
      `${loginSql}
       AND LOWER(TRIM(COALESCE(username, ''))) = LOWER(TRIM($1))
       LIMIT 1`,
      [jwtUser.username]
    );
    if (byUsername.rows[0]) return Number(byUsername.rows[0].id);
  }

  if (jwtUser.id != null) {
    const byId = await db.query(`${loginSql} AND id = $1 LIMIT 1`, [jwtUser.id]);
    if (byId.rows[0]) return Number(byId.rows[0].id);
  }

  return jwtUser.id != null ? Number(jwtUser.id) : null;
}

async function enableLoginByUserId(db, userId, password = DEFAULT_SYNC_PASSWORD) {
  const existing = await db.query(`SELECT account_id FROM jira_users WHERE id = $1`, [userId]);
  if (!existing.rows.length) {
    throw new Error('Không tìm thấy người dùng.');
  }
  return enableLoginForAccount(db, existing.rows[0].account_id, password);
}

module.exports = {
  DEFAULT_SYNC_PASSWORD,
  profileFromRow,
  resolveUniqueSyncUsername,
  hashPassword,
  findLoginUserByIdentifier,
  enableLoginForAccount,
  enableLoginByUserId,
  ensureDefaultSyncCredentials,
  resolveActingUserId,
};
