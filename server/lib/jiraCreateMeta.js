const axios = require('axios');

const CREATE_META_KEY_PREFIX = 'jira_createmeta:';

/** Tên sub-task chuẩn (khớp theo createmeta Jira, không hardcode theo project). */
const GENERIC_SUBTASK_NAME = /^(sub-?task|subtask|công việc con)$/i;

function createMetaSettingsKey(projectKey) {
  return `${CREATE_META_KEY_PREFIX}${projectKey}`;
}

function normalizeIssueTypeRow(row) {
  if (!row) return null;
  return {
    id: row.id != null ? String(row.id) : '',
    name: String(row.name || '').trim(),
    subtask: !!row.subtask,
  };
}

async function fetchProjectIssueTypesFromJira(jiraBaseUrl, projectKey, token, httpsAgent) {
  const url = `${jiraBaseUrl}/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
    params: { maxResults: 200 },
  });

  const rows = res.data?.values || res.data?.issueTypes || [];
  return rows.map(normalizeIssueTypeRow).filter(t => t?.name);
}

async function loadProjectIssueTypesFromDb(db, projectKey) {
  const res = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [
    createMetaSettingsKey(projectKey),
  ]);
  const payload = res.rows[0]?.value;
  if (!payload || !Array.isArray(payload.issueTypes)) return null;
  return {
    syncedAt: payload.syncedAt || null,
    issueTypes: payload.issueTypes,
  };
}

async function saveProjectIssueTypesToDb(db, projectKey, issueTypes, syncedAt) {
  const syncedIso = syncedAt || new Date().toISOString();
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      createMetaSettingsKey(projectKey),
      JSON.stringify({
        syncedAt: syncedIso,
        issueTypes,
      }),
    ]
  );
  return { syncedAt: syncedIso, issueTypes };
}

async function syncProjectCreateMeta(db, projectKey, token, httpsAgent, jiraBaseUrl) {
  const issueTypes = await fetchProjectIssueTypesFromJira(
    jiraBaseUrl,
    projectKey,
    token,
    httpsAgent
  );
  await saveProjectIssueTypesToDb(db, projectKey, issueTypes);
  return { projectKey, issueTypeCount: issueTypes.length, issueTypes };
}

async function ensureProjectIssueTypes(db, projectKey, token, httpsAgent, jiraBaseUrl) {
  const cached = await loadProjectIssueTypesFromDb(db, projectKey);
  if (cached?.issueTypes?.length) return cached.issueTypes;

  const synced = await syncProjectCreateMeta(db, projectKey, token, httpsAgent, jiraBaseUrl);
  return synced.issueTypes;
}

function listSubtaskIssueTypes(issueTypes) {
  return (issueTypes || []).filter(t => t.subtask);
}

/**
 * Chọn issuetype.name từ createmeta Jira (đã sync workflow).
 * dev/test → sub-task generic; bug → sub-task có "bug"/"lỗi" trong tên.
 */
function resolveChildIssueTypeName(kind, issueTypes) {
  const subtasks = listSubtaskIssueTypes(issueTypes);
  if (!subtasks.length) {
    throw new Error(
      'Createmeta Jira không có loại sub-task nào. Chạy sync workflow trong Quản trị.'
    );
  }

  const childKind = String(kind || 'subtask').toLowerCase();

  if (childKind === 'bug') {
    const bugTypes = subtasks.filter(t => /bug|lỗi/i.test(t.name));
    if (bugTypes.length === 1) return bugTypes[0].name;
    if (bugTypes.length > 1) {
      throw new Error(
        `Nhiều loại sub-task bug trong createmeta: ${bugTypes.map(t => t.name).join(', ')}. Liên hệ admin.`
      );
    }
    throw new Error(
      `Không có loại sub-task bug trong createmeta. Sub-task hiện có: ${subtasks.map(t => t.name).join(', ')}`
    );
  }

  const generic = subtasks.find(t => GENERIC_SUBTASK_NAME.test(t.name));
  if (generic) return generic.name;

  const nonBug = subtasks.filter(t => !/bug|lỗi/i.test(t.name));
  if (nonBug.length === 1) return nonBug[0].name;
  if (nonBug.length > 1) {
    throw new Error(
      `Không xác định được sub-task generic từ createmeta: ${nonBug.map(t => t.name).join(', ')}`
    );
  }

  throw new Error(
    `Không tìm thấy sub-task phù hợp (dev/test) trong createmeta: ${subtasks.map(t => t.name).join(', ')}`
  );
}

async function resolveChildIssueTypeForProject(
  db,
  projectKey,
  kind,
  { token, httpsAgent, jiraBaseUrl }
) {
  const issueTypes = await ensureProjectIssueTypes(db, projectKey, token, httpsAgent, jiraBaseUrl);
  return resolveChildIssueTypeName(kind, issueTypes);
}

module.exports = {
  fetchProjectIssueTypesFromJira,
  loadProjectIssueTypesFromDb,
  saveProjectIssueTypesToDb,
  syncProjectCreateMeta,
  ensureProjectIssueTypes,
  resolveChildIssueTypeName,
  resolveChildIssueTypeForProject,
  listSubtaskIssueTypes,
};
