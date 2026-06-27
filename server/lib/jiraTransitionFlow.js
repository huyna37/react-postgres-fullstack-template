const {
  fetchIssueFromJira,
  fetchTransitionsFromJira,
  mapJiraIssue,
  normalizeTransitions,
} = require('./jiraSyncOneIssue');
const {
  buildAssigneeLookup,
  loadAssigneeLookup,
  normalizeAssignee,
} = require('./assigneeIdentity');
const { enrichRawIssueFromJira } = require('./jiraSyncEnrich');

/**
 * Đồng bộ ticket từ Jira → DB, lấy transitions mới nhất (workflow follow).
 */
async function syncWorkflowState({ db, upsertIssueToDb, key, token, httpsAgent, jiraBaseUrl }) {
  const dbBefore = await db.query(
    `SELECT status, status_category, updated_at FROM jira_issues WHERE key = $1`,
    [key]
  );
  const beforeRow = dbBefore.rows[0] || null;

  const rawIssue = await fetchIssueFromJira(jiraBaseUrl, key, token, httpsAgent);
  await enrichRawIssueFromJira(rawIssue, token, jiraBaseUrl);
  const projectKey = rawIssue?.fields?.project?.key;
  if (!projectKey) {
    throw new Error('Không xác định được project của ticket.');
  }

  const usersRes = await db.query(
    `SELECT account_id, display_name, email_address, role FROM jira_users
     WHERE string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]
       AND is_active = true`,
    [projectKey]
  );
  const lookup = buildAssigneeLookup(usersRes.rows);
  const assigneeLookup = await loadAssigneeLookup(projectKey);
  const mapAssignee = (a) => {
    if (!a) return null;
    return normalizeAssignee(
      {
        accountId: a.accountId || a.key,
        emailAddress: a.emailAddress,
        displayName: a.displayName,
        avatarUrl: a.avatarUrls?.['24x24'] || a.avatarUrls?.['48x48'],
      },
      lookup
    );
  };

  const issue = mapJiraIssue(rawIssue, mapAssignee);
  if (upsertIssueToDb) {
    await upsertIssueToDb(issue, projectKey, assigneeLookup);
  }

  const transitions = normalizeTransitions(
    await fetchTransitionsFromJira(jiraBaseUrl, key, token, httpsAgent)
  );

  return {
    syncedAt: new Date().toISOString(),
    status: issue.status || null,
    statusCategory: issue.statusCategory || null,
    dbStatusBefore: beforeRow?.status || null,
    statusChanged: !!(beforeRow?.status && issue.status && beforeRow.status !== issue.status),
    transitions,
  };
}

function assertTransitionAllowed(transitions, transitionId) {
  const id = String(transitionId);
  const found = transitions.find((t) => t.id === id);
  if (!found) {
    throw new Error(
      'Transition không còn hợp lệ sau khi đồng bộ workflow. Vui lòng chọn lại thao tác.'
    );
  }
  return found;
}

module.exports = {
  syncWorkflowState,
  assertTransitionAllowed,
};
