const db = require('../db');
const { normalizeAssignee, resolveAssigneeEmail } = require('./assigneeIdentity');
const { syncWorklogEntriesForIssue } = require('./jiraWorklogIndex');
const { normalizePlanDateForStorage } = require('./jiraMonthFilter');
const { normalizeJiraComments } = require('./jiraComments');

async function prepareAssigneeFields(issue, projectKey, assigneeLookup) {
  let lookup = assigneeLookup;
  if (!lookup) {
    const { loadAssigneeLookup } = require('./assigneeIdentity');
    lookup = await loadAssigneeLookup(projectKey);
  }
  if (issue.assignee) {
    issue.assignee = normalizeAssignee(issue.assignee, lookup);
  }
  return {
    storageEmail: resolveAssigneeEmail(issue.assignee, lookup),
    assigneeName: issue.assignee?.displayName || null,
    assigneeRole: issue.assignee?.role || null,
  };
}

const ASSIGNEE_ACCOUNT_ID_UPDATE = `
  assignee_account_id = CASE
    WHEN EXCLUDED.assignee_account_id IS NOT NULL
      AND TRIM(EXCLUDED.assignee_account_id) <> ''
      AND EXCLUDED.assignee_account_id LIKE '%@%'
      THEN LOWER(EXCLUDED.assignee_account_id)
    WHEN EXCLUDED.assignee_account_id IS NOT NULL
      AND TRIM(EXCLUDED.assignee_account_id) <> ''
      THEN EXCLUDED.assignee_account_id
    ELSE NULL
  END
`;

function serializeComments(issue) {
  const list = Array.isArray(issue.comments)
    ? issue.comments
    : normalizeJiraComments(issue.comments);
  return JSON.stringify(list || []);
}

function serializeAttachments(issue) {
  const list = Array.isArray(issue.attachments) ? issue.attachments : [];
  return JSON.stringify(list || []);
}

/**
 * Epic/background sync — chỉ metadata (parent, status, assignee).
 */
async function upsertJiraIssueEpicScope(issue, projectKey, assigneeLookup = null) {
  if (issue.isSynthesized) return;

  const { storageEmail, assigneeName, assigneeRole } = await prepareAssigneeFields(
    issue,
    projectKey,
    assigneeLookup
  );

  const query = `
    INSERT INTO jira_issues (
      key, project_key, parent_key, summary, status, status_category, issue_type,
      is_subtask, assignee_name, assignee_role, creator, start_date, due_date,
      updated_at, assignee_account_id, creator_email, resolved_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
    )
    ON CONFLICT (key) DO UPDATE SET
      project_key = EXCLUDED.project_key,
      parent_key = EXCLUDED.parent_key,
      summary = EXCLUDED.summary,
      status = EXCLUDED.status,
      status_category = EXCLUDED.status_category,
      issue_type = EXCLUDED.issue_type,
      is_subtask = EXCLUDED.is_subtask,
      assignee_name = EXCLUDED.assignee_name,
      assignee_role = EXCLUDED.assignee_role,
      ${ASSIGNEE_ACCOUNT_ID_UPDATE},
      creator = EXCLUDED.creator,
      creator_email = EXCLUDED.creator_email,
      start_date = EXCLUDED.start_date,
      due_date = EXCLUDED.due_date,
      updated_at = COALESCE(EXCLUDED.updated_at, jira_issues.updated_at),
      resolved_at = EXCLUDED.resolved_at
  `;

  const values = [
    issue.key,
    projectKey,
    issue.parentKey || null,
    issue.summary || '',
    issue.status || '',
    issue.statusCategory || '',
    issue.issueType || '',
    !!issue.isSubtask,
    assigneeName,
    assigneeRole,
    issue.creator || null,
    normalizePlanDateForStorage(issue.startDate),
    normalizePlanDateForStorage(issue.dueDate),
    issue.updated ? new Date(issue.updated) : null,
    storageEmail,
    issue.creatorEmail || null,
    issue.resolved ? new Date(issue.resolved) : null,
  ];

  try {
    await db.query(query, values);
  } catch (err) {
    console.error(`[JiraUpsert:epic] Failed issue ${issue.key}:`, err.message);
    throw err;
  }
}

/**
 * Upsert jira_issues — dữ liệu lưu cột riêng + jira_worklog_entries, không phụ thuộc raw_data.
 */
async function upsertJiraIssue(issue, projectKey, assigneeLookup = null) {
  if (issue.isSynthesized) return;

  const { storageEmail, assigneeName, assigneeRole } = await prepareAssigneeFields(
    issue,
    projectKey,
    assigneeLookup
  );

  const commentsJson = serializeComments(issue);
  const attachmentsJson = serializeAttachments(issue);

  const query = `
    INSERT INTO jira_issues (
      key, project_key, parent_key, summary, status, status_category, issue_type,
      is_subtask, assignee_name, assignee_role, creator, start_date, due_date,
      created_at, updated_at, time_spent, original_estimate, remaining_estimate,
      description, output, comments, attachments, assignee_account_id, creator_email, resolved_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23, $24, $25
    )
    ON CONFLICT (key) DO UPDATE SET
      project_key = EXCLUDED.project_key,
      parent_key = EXCLUDED.parent_key,
      summary = EXCLUDED.summary,
      status = EXCLUDED.status,
      status_category = EXCLUDED.status_category,
      issue_type = EXCLUDED.issue_type,
      is_subtask = EXCLUDED.is_subtask,
      assignee_name = EXCLUDED.assignee_name,
      assignee_role = EXCLUDED.assignee_role,
      ${ASSIGNEE_ACCOUNT_ID_UPDATE},
      creator = EXCLUDED.creator,
      start_date = EXCLUDED.start_date,
      due_date = EXCLUDED.due_date,
      created_at = COALESCE(EXCLUDED.created_at, jira_issues.created_at),
      updated_at = COALESCE(EXCLUDED.updated_at, jira_issues.updated_at),
      time_spent = EXCLUDED.time_spent,
      original_estimate = EXCLUDED.original_estimate,
      remaining_estimate = EXCLUDED.remaining_estimate,
      description = EXCLUDED.description,
      output = EXCLUDED.output,
      comments = EXCLUDED.comments,
      attachments = EXCLUDED.attachments,
      creator_email = EXCLUDED.creator_email,
      resolved_at = EXCLUDED.resolved_at
  `;

  const values = [
    issue.key,
    projectKey,
    issue.parentKey || null,
    issue.summary || '',
    issue.status || '',
    issue.statusCategory || '',
    issue.issueType || '',
    !!issue.isSubtask,
    assigneeName,
    assigneeRole,
    issue.creator || null,
    normalizePlanDateForStorage(issue.startDate),
    normalizePlanDateForStorage(issue.dueDate),
    issue.created ? new Date(issue.created) : null,
    issue.updated ? new Date(issue.updated) : null,
    issue.timeSpent || 0,
    issue.originalEstimate || 0,
    issue.remainingEstimate || 0,
    issue.description || '',
    issue.output || '',
    commentsJson,
    attachmentsJson,
    storageEmail,
    issue.creatorEmail || null,
    issue.resolved ? new Date(issue.resolved) : null,
  ];

  try {
    await db.query(query, values);
    // Luôn sync khi payload có field worklog — kể cả worklogs=[] (đã xóa hết trên Jira).
    if (issue.worklog !== undefined) {
      await syncWorklogEntriesForIssue(
        db,
        issue.key,
        projectKey,
        issue.worklog || { worklogs: [] }
      );
    }
  } catch (err) {
    console.error(`[JiraUpsert] Failed issue ${issue.key}:`, err.message);
    throw err;
  }
}

module.exports = { upsertJiraIssue, upsertJiraIssueEpicScope };
