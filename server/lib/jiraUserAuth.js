const DEFAULT_PERMISSIONS = [
  'dashboard',
  'create',
  'my-tickets',
  'worklogs',
  'logwork-history',
  'config',
  'projects',
];

function parsePermissions(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : DEFAULT_PERMISSIONS;
  } catch {
    return DEFAULT_PERMISSIONS;
  }
}

function mapAuthUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.app_role || 'user',
    permissions: parsePermissions(row.permissions),
    jira_token: row.jira_token || null,
    jira_project: row.jira_project || null,
    theme_preference: row.theme_preference || null,
  };
}

function buildJwtPayload(row) {
  const user = mapAuthUser(row);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: user.permissions,
    jira_token: user.jira_token,
    jira_project: user.jira_project,
    theme_preference: user.theme_preference,
  };
}

function localAccountId(username) {
  return `local:${String(username || '').trim().toLowerCase()}`;
}

function deriveSyncUsername(jiraUser) {
  const email = String(jiraUser.emailAddress || '').trim();
  if (email) {
    const local = email.split('@')[0]?.trim();
    if (local) return local.toLowerCase();
  }

  const display = String(jiraUser.displayName || '').trim();
  if (display) {
    const slug = display
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, '.')
      .replace(/[^a-z0-9._-]/g, '');
    if (slug) return slug;
  }

  const accountId = String(jiraUser.accountId || jiraUser.name || jiraUser.key || '').trim();
  return accountId.toLowerCase() || 'user';
}

module.exports = {
  DEFAULT_PERMISSIONS,
  parsePermissions,
  mapAuthUser,
  buildJwtPayload,
  localAccountId,
  deriveSyncUsername,
};
