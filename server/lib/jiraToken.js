const MISSING_JIRA_TOKEN_MSG =
  'Cần cấu hình Jira Token cá nhân (mục Cấu hình cá nhân) để thao tác với Jira.';

const MISSING_JIRA_TOKEN_PROJECTS_MSG =
  'Cần cấu hình Jira Token cá nhân (mục Cấu hình cá nhân) để lấy danh sách dự án Jira.';

function normalizeJiraToken(token) {
  if (token == null || String(token).trim() === '') return null;
  return String(token).trim();
}

function getUserJiraToken(user) {
  return normalizeJiraToken(user?.jira_token);
}

async function getUserJiraTokenFromDb(db, userId) {
  if (!userId) return null;
  const accRes = await db.query('SELECT jira_token FROM jira_users WHERE id = $1', [userId]);
  return normalizeJiraToken(accRes.rows[0]?.jira_token);
}

async function resolveAnyJiraTokenFromDb(db) {
  const res = await db.query(
    `SELECT jira_token FROM jira_users
     WHERE jira_token IS NOT NULL AND TRIM(jira_token) != ''
     ORDER BY CASE WHEN app_role = 'admin' THEN 0 ELSE 1 END, id ASC
     LIMIT 1`
  );
  return normalizeJiraToken(res.rows[0]?.jira_token);
}

/** Token của chính user đang đăng nhập (JWT → DB). Không dùng token người khác. */
async function resolveJiraTokenForRequest(db, req) {
  const fromJwt = getUserJiraToken(req.user);
  if (fromJwt) return fromJwt;
  if (req.user?.id) {
    return getUserJiraTokenFromDb(db, req.user.id);
  }
  return null;
}

async function requireUserJiraToken(db, req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const token = await resolveJiraTokenForRequest(db, req);
  if (!token) {
    res.status(400).json({ error: MISSING_JIRA_TOKEN_MSG, code: 'personal_token_required' });
    return null;
  }
  return token;
}

function normalizeLookupEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return v || null;
}

/** Tìm user theo email/username và lấy jira_token cá nhân (dùng cho agent API). */
async function getUserJiraTokenByEmail(db, email) {
  const lookup = normalizeLookupEmail(email);
  if (!lookup) return { user: null, token: null };

  const res = await db.query(
    `SELECT id, jira_token, email_address, username, display_name
     FROM jira_users
     WHERE LOWER(TRIM(COALESCE(email_address, ''))) = $1
        OR LOWER(TRIM(COALESCE(username, ''))) = $1
     ORDER BY
       CASE WHEN password_hash IS NOT NULL THEN 0 ELSE 1 END,
       CASE WHEN jira_token IS NOT NULL AND TRIM(jira_token) != '' THEN 0 ELSE 1 END,
       id ASC
     LIMIT 1`,
    [lookup]
  );

  if (res.rows.length === 0) return { user: null, token: null };

  const user = res.rows[0];
  return {
    user,
    token: normalizeJiraToken(user.jira_token),
  };
}

async function requireUserJiraTokenByEmail(db, email) {
  const lookup = normalizeLookupEmail(email);
  if (!lookup) {
    const err = new Error('email is required');
    err.status = 400;
    throw err;
  }

  const { user, token } = await getUserJiraTokenByEmail(db, lookup);
  if (!user) {
    const err = new Error(`Không tìm thấy user ${lookup} trong hệ thống`);
    err.status = 404;
    throw err;
  }
  if (!token) {
    const err = new Error(
      `User ${lookup} chưa cấu hình Jira Token cá nhân (Cấu hình cá nhân)`
    );
    err.status = 400;
    err.code = 'personal_token_required';
    throw err;
  }

  return { email: lookup, token, user };
}

module.exports = {
  MISSING_JIRA_TOKEN_MSG,
  MISSING_JIRA_TOKEN_PROJECTS_MSG,
  normalizeJiraToken,
  getUserJiraToken,
  getUserJiraTokenFromDb,
  getUserJiraTokenByEmail,
  requireUserJiraTokenByEmail,
  resolveAnyJiraTokenFromDb,
  resolveJiraTokenForRequest,
  requireUserJiraToken,
};
