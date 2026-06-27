const db = require('../db');

function isEmailLike(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v.includes('@') && !v.includes(' ');
}

function normalizeEmail(value) {
  if (!isEmailLike(value)) return null;
  return value.trim().toLowerCase();
}

/**
 * Maps từ jira_users — resolve Jira accountId → email.
 */
function buildAssigneeLookup(rows) {
  const emailByJiraId = new Map();
  const roleByEmail = new Map();
  const roleByJiraId = new Map();
  const displayNameByEmail = new Map();
  const avatarByEmail = new Map();

  for (const r of rows || []) {
    const email = normalizeEmail(r.email_address);
    const jiraId = r.account_id || null;
    if (jiraId && email) emailByJiraId.set(jiraId, email);
    if (email) {
      if (r.role) roleByEmail.set(email, r.role);
      if (r.display_name) displayNameByEmail.set(email, r.display_name);
      if (r.avatar_url) avatarByEmail.set(email, r.avatar_url);
    }
    if (jiraId && r.role) roleByJiraId.set(jiraId, r.role);
  }

  return { emailByJiraId, roleByEmail, roleByJiraId, displayNameByEmail, avatarByEmail };
}

async function loadAssigneeLookup(projectKey) {
  const key = String(projectKey || '').trim();
  const cached = usersDashboardCache.get(`lookup:${key}`);
  if (cached && Date.now() - cached.at < USERS_DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await db.query(
    `SELECT account_id, email_address, role, display_name, avatar_url
     FROM jira_users
     WHERE string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]`,
    [projectKey]
  );
  const lookup = buildAssigneeLookup(res.rows);
  usersDashboardCache.set(`lookup:${key}`, { at: Date.now(), data: lookup });
  return lookup;
}

/** Gắn email/role/avatar assignee từ lookup — tránh LATERAL JOIN trên từng dòng issue. */
function enrichIssueRowsFromLookup(rows, lookup) {
  if (!Array.isArray(rows) || !lookup) return rows;
  for (const row of rows) {
    const email =
      normalizeEmail(row.assignee_account_id) ||
      (row.assignee_account_id && lookup.emailByJiraId.get(row.assignee_account_id)) ||
      null;
    row.resolved_assignee_email = email;
    row.assignee_role_resolved =
      (email && lookup.roleByEmail.get(email)) ||
      (row.assignee_account_id && lookup.roleByJiraId.get(row.assignee_account_id)) ||
      row.assignee_role ||
      null;
    row.assignee_avatar_url = email ? lookup.avatarByEmail?.get(email) || null : null;
  }
  return rows;
}

/**
 * Email chuẩn để lưu assignee_account_id — không dùng Jira accountId.
 */
function resolveAssigneeEmail(assignee, lookup) {
  if (!assignee) return null;

  const direct = normalizeEmail(assignee.emailAddress) || normalizeEmail(assignee.accountId);
  if (direct) return direct;

  const jiraId = assignee.accountId || assignee.key || assignee.name;
  if (jiraId && lookup?.emailByJiraId?.has(jiraId)) {
    return lookup.emailByJiraId.get(jiraId);
  }

  return null;
}

function normalizeAssignee(assignee, lookup) {
  if (!assignee) return null;
  const email = resolveAssigneeEmail(assignee, lookup);
  if (!email) {
    return {
      accountId: null,
      emailAddress: null,
      displayName: assignee.displayName || null,
      avatarUrl: assignee.avatarUrl || null,
      role: assignee.role || null,
    };
  }

  return {
    accountId: email,
    emailAddress: email,
    displayName: assignee.displayName || lookup?.displayNameByEmail?.get(email) || null,
    avatarUrl: assignee.avatarUrl || null,
    role:
      assignee.role ||
      lookup?.roleByEmail?.get(email) ||
      (assignee.accountId && lookup?.roleByJiraId?.get(assignee.accountId)) ||
      null,
  };
}

/** So khớp user dashboard ↔ ticket assignee */
function assigneeMatchesUser(assignee, user) {
  if (!assignee || !user) return false;

  const userEmail = normalizeEmail(user.emailAddress) || normalizeEmail(user.accountId);
  const assigneeEmail =
    normalizeEmail(assignee.emailAddress) || normalizeEmail(assignee.accountId);

  if (userEmail && assigneeEmail && userEmail === assigneeEmail) return true;

  const userName = (user.displayName || '').trim().toLowerCase();
  const assigneeName = (assignee.displayName || '').trim().toLowerCase();
  return !!(userName && assigneeName && userName === assigneeName);
}

/** Một user / ticket — tránh nhân đôi row khi nhiều jira_users khớp assignee */
const JIRA_USER_ASSIGNEE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT u.email_address, u.role, u.display_name, u.avatar_url, u.account_id
    FROM jira_users u
    WHERE string_to_array(TRIM(COALESCE(u.jira_project, '')), ',') @> ARRAY[i.project_key::text]
      AND (
        (
          i.assignee_account_id IS NOT NULL
          AND TRIM(i.assignee_account_id) != ''
          AND LOWER(TRIM(COALESCE(u.email_address, ''))) = LOWER(TRIM(i.assignee_account_id))
        )
        OR (
          i.assignee_account_id IS NOT NULL
          AND TRIM(i.assignee_account_id) != ''
          AND u.account_id = i.assignee_account_id
        )
      )
    ORDER BY
      CASE
        WHEN i.assignee_account_id LIKE '%@%'
          AND LOWER(TRIM(u.email_address)) = LOWER(TRIM(i.assignee_account_id))
        THEN 0
        ELSE 1
      END,
      u.sort_order DESC NULLS LAST
    LIMIT 1
  ) u ON true
`;

const RESOLVED_ASSIGNEE_EMAIL_SQL = `
  LOWER(
    COALESCE(
      NULLIF(TRIM(u.email_address), ''),
      CASE WHEN i.assignee_account_id LIKE '%@%' THEN TRIM(i.assignee_account_id) END
    )
  ) AS resolved_assignee_email
`;

/** Đổi assignee_account_id từ Jira id → email (dữ liệu cũ sau cron Epic). */
async function migrateAssigneeAccountIdsToEmail(projectKey) {
  const res = await db.query(
    `
    UPDATE jira_issues i
    SET assignee_account_id = LOWER(TRIM(u.email_address))
    FROM jira_users u
    WHERE i.project_key = $1
      AND i.assignee_account_id IS NOT NULL
      AND TRIM(i.assignee_account_id) != ''
      AND i.assignee_account_id NOT LIKE '%@%'
      AND u.account_id = i.assignee_account_id
      AND u.email_address IS NOT NULL
      AND TRIM(u.email_address) != ''
    `,
    [projectKey]
  );
  return res.rowCount || 0;
}

/** Chuẩn hóa assignee trên cây issue (parent + subTasks) khi đọc DB. */
function normalizeIssueTreeAssignees(issue, lookup) {
  if (!issue) return;
  if (issue.assignee) {
    issue.assignee = normalizeAssignee(issue.assignee, lookup);
  }
  if (issue.subTasks?.length) {
    for (const sub of issue.subTasks) {
      normalizeIssueTreeAssignees(sub, lookup);
    }
  }
}

const USERS_DASHBOARD_CACHE_TTL_MS = 60_000;
const usersDashboardCache = new Map();

async function loadProjectUsersForDashboard(projectKey) {
  const key = String(projectKey || '').trim();
  const cached = usersDashboardCache.get(key);
  if (cached && Date.now() - cached.at < USERS_DASHBOARD_CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await db.query(
    `SELECT account_id, email_address, role, display_name, avatar_url, sort_order, is_active
     FROM jira_users
     WHERE string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]`,
    [projectKey]
  );
  const assigneeLookup = buildAssigneeLookup(res.rows);
  const activeUsers = res.rows
    .filter(r => r.is_active)
    .sort(
      (a, b) =>
        (Number(b.sort_order) || 0) - (Number(a.sort_order) || 0) ||
        String(a.display_name || '').localeCompare(String(b.display_name || ''), 'vi')
    )
    .map(r => ({
      accountId: r.account_id,
      displayName: r.display_name,
      emailAddress: normalizeEmail(r.email_address),
      avatarUrl: r.avatar_url,
      sortOrder: r.sort_order,
    }));
  const data = { activeUsers, assigneeLookup };
  usersDashboardCache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = {
  isEmailLike,
  normalizeEmail,
  buildAssigneeLookup,
  loadAssigneeLookup,
  loadProjectUsersForDashboard,
  resolveAssigneeEmail,
  normalizeAssignee,
  assigneeMatchesUser,
  migrateAssigneeAccountIdsToEmail,
  normalizeIssueTreeAssignees,
  enrichIssueRowsFromLookup,
  JIRA_USER_ASSIGNEE_JOIN,
  RESOLVED_ASSIGNEE_EMAIL_SQL,
};
