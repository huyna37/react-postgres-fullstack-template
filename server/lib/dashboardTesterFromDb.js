const {
  monthPlanDateFilterClause,
  monthPlanDateFilterParams,
  formatPlanDateFromDb,
} = require('./jiraMonthFilter');
const {
  enrichIssueRowsFromLookup,
  loadAssigneeLookup,
  normalizeEmail,
} = require('./assigneeIdentity');

const STORY_TASK_TYPE_SQL = `
  LOWER(COALESCE(p.issue_type, '')) NOT SIMILAR TO '%(epic|initiative|feature|theme|capability)%'
  AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%sub%task%'
  AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%bug%'
  AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%lỗi%'
  AND (
    LOWER(COALESCE(p.issue_type, '')) LIKE '%story%'
    OR LOWER(COALESCE(p.issue_type, '')) LIKE '%yêu cầu%'
    OR LOWER(COALESCE(p.issue_type, '')) LIKE '%công việc%'
    OR (
      LOWER(COALESCE(p.issue_type, '')) LIKE '%task%'
      AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%sub%'
    )
  )
`;

const ISSUE_ROW_COLUMNS = `
  key, parent_key, is_subtask, summary, status, status_category, issue_type,
  updated_at, created_at, original_estimate, remaining_estimate,
  start_date, due_date, creator, time_spent,
  assignee_account_id, assignee_name, assignee_role,
  COALESCE(jsonb_array_length(attachments), 0) AS attachment_count,
  COALESCE(jsonb_array_length(comments), 0) AS comment_count
`;

function familyCommentCount(parentRow, subs) {
  let total = Number(parentRow.comment_count) || 0;
  for (const sub of subs || []) {
    total += Number(sub.comment_count) || 0;
  }
  return total;
}

function matchesStoryTaskType(issueType) {
  const t = (issueType || '').toLowerCase();
  if (/(epic|initiative|feature|theme|capability)/.test(t)) return false;
  if (t.includes('sub') && t.includes('task')) return false;
  if (t.includes('bug') || t.includes('lỗi')) return false;
  return (
    t.includes('story') ||
    t.includes('yêu cầu') ||
    t.includes('công việc') ||
    (t.includes('task') && !t.includes('sub'))
  );
}

function isTesterRole(accountId, role, lookup) {
  if (role === 'tester') return true;
  if (!lookup || !accountId) return false;
  const email = normalizeEmail(accountId) || lookup.emailByJiraId?.get(accountId);
  return !!(email && lookup.roleByEmail?.get(email) === 'tester');
}

function isRelevantTestSubtask(sub, lookup) {
  return isTesterRole(sub.assignee_account_id, sub.assignee_role, lookup);
}

async function fetchTesterMonthBundle(db, projectKey, year, month) {
  const monthWhere = monthPlanDateFilterClause('', 2);
  const monthRes = await db.query(
    `
    SELECT key
    FROM jira_issues
    WHERE project_key = $1 AND is_subtask = false AND ${monthWhere}
    `,
    [projectKey, ...monthPlanDateFilterParams(year, month)]
  );

  const parentKeySet = new Set();
  for (const row of monthRes.rows) {
    parentKeySet.add(row.key);
  }

  const candidateKeys = [...parentKeySet];
  if (candidateKeys.length === 0) {
    return { parents: [], subsByParent: new Map() };
  }

  const metaRes = await db.query(
    `
    SELECT key, parent_key, is_subtask, issue_type, assignee_account_id, assignee_role, summary
    FROM jira_issues
    WHERE project_key = $1
      AND (
        (key = ANY($2::text[]) AND is_subtask = false)
        OR (parent_key = ANY($2::text[]) AND is_subtask = true)
      )
    `,
    [projectKey, candidateKeys]
  );

  const parents = [];
  const storyKeySet = new Set();
  const subsByParent = new Map();
  for (const row of metaRes.rows) {
    if (row.is_subtask) {
      if (!subsByParent.has(row.parent_key)) subsByParent.set(row.parent_key, []);
      subsByParent.get(row.parent_key).push(row);
    } else if (matchesStoryTaskType(row.issue_type)) {
      parents.push(row);
      storyKeySet.add(row.key);
    }
  }

  for (const key of [...subsByParent.keys()]) {
    if (!storyKeySet.has(key)) subsByParent.delete(key);
  }

  return { parents, subsByParent };
}

function selectTesterParentKeys(bundle, assigneeLookup) {
  return bundle.parents
    .map(p => p.key)
    .sort();
}

async function fetchTesterParentKeys(db, projectKey, year, month, assigneeLookup) {
  if (year != null && month != null) {
    const bundle = await fetchTesterMonthBundle(db, projectKey, year, month);
    if (!assigneeLookup) return selectTesterParentKeys(bundle, { roleByEmail: new Map(), emailByJiraId: new Map() });
    return selectTesterParentKeys(bundle, assigneeLookup);
  }

  const res = await db.query(
    `
    SELECT p.key
    FROM jira_issues p
    WHERE p.project_key = $1
      AND p.is_subtask = false
      AND (p.status_category != 'done' OR p.updated_at >= CURRENT_DATE - INTERVAL '14 days')
      AND ${STORY_TASK_TYPE_SQL}
      AND p.assignee_role = 'tester'
    ORDER BY p.key
    `,
    [projectKey]
  );
  return res.rows.map(r => r.key);
}

async function fetchTesterIssuesWithSubtasks(db, projectKey, parentKeys) {
  const treeRes = await db.query(
    `
    SELECT ${ISSUE_ROW_COLUMNS}
    FROM jira_issues
    WHERE project_key = $1
      AND (
        key = ANY($2::text[])
        OR (is_subtask = true AND parent_key = ANY($2::text[]))
      )
    ORDER BY is_subtask, key
    `,
    [projectKey, parentKeys]
  );

  const parentRows = [];
  const subsByParent = new Map();
  for (const row of treeRes.rows) {
    if (row.is_subtask) {
      const pk = row.parent_key;
      if (!subsByParent.has(pk)) subsByParent.set(pk, []);
      subsByParent.get(pk).push(row);
    } else {
      parentRows.push(row);
    }
  }

  return parentRows.map(parent => ({
    ...parent,
    subtasks_json: subsByParent.get(parent.key) || [],
  }));
}

function mapTesterAssignee(row) {
  if (!row.resolved_assignee_email && !row.assignee_name && !row.assignee_account_id) return null;
  return {
    accountId: row.resolved_assignee_email || row.assignee_account_id || null,
    emailAddress: row.resolved_assignee_email || null,
    displayName: row.assignee_name || null,
    avatarUrl: row.assignee_avatar_url || null,
    role: row.assignee_role_resolved || row.assignee_role || null,
  };
}

function mapTesterSubtaskRow(row) {
  return {
    id: row.key,
    key: row.key,
    summary: row.summary || '',
    status: row.status || '',
    statusCategory: row.status_category || '',
    issueType: row.issue_type || '',
    isSubtask: true,
    originalEstimate: row.original_estimate || 0,
    assignee: mapTesterAssignee(row),
    updated: row.updated_at,
    created: row.created_at,
  };
}

function mapTesterParentRow(row, subs) {
  return {
    id: row.key,
    key: row.key,
    summary: row.summary || '',
    status: row.status || '',
    statusCategory: row.status_category || '',
    issueType: row.issue_type || '',
    isSubtask: false,
    updated: row.updated_at,
    created: row.created_at,
    originalEstimate: row.original_estimate || 0,
    remainingEstimate: row.remaining_estimate || 0,
    timeEstimate: row.remaining_estimate || 0,
    timeSpent: row.time_spent || 0,
    creator: row.creator || null,
    startDate: formatPlanDateFromDb(row.start_date),
    dueDate: formatPlanDateFromDb(row.due_date),
    description: '',
    parentKey: null,
    assignee: mapTesterAssignee(row),
    subTasks: subs,
    attachmentCount: Number(row.attachment_count) || 0,
    commentCount: familyCommentCount(row, subs),
  };
}

function buildTesterIssues(rows, assigneeLookup) {
  const allRows = [];
  for (const row of rows) {
    allRows.push(row);
    const subs = row.subtasks_json;
    if (subs?.length) allRows.push(...subs);
  }
  enrichIssueRowsFromLookup(allRows, assigneeLookup);

  const parentMap = new Map();
  for (const row of rows) {
    const subs = row.subtasks_json || [];
    const mappedSubs = subs.length ? subs.map(mapTesterSubtaskRow) : [];
    parentMap.set(row.key, mapTesterParentRow(row, mappedSubs));
  }
  return parentMap;
}

function sortTesterIssues(issues) {
  issues.sort((a, b) => {
    const aDone =
      a.statusCategory?.toLowerCase() === 'done' || a.status?.toLowerCase() === 'closed';
    const bDone =
      b.statusCategory?.toLowerCase() === 'done' || b.status?.toLowerCase() === 'closed';
    if (aDone !== bDone) return aDone ? 1 : -1;
    return new Date(b.updated) - new Date(a.updated);
  });
  return issues;
}

async function fetchTesterDashboard(db, projectKey, normalizedMonth, normalizedYear) {
  const t0 = Date.now();
  const yearQuery = normalizedYear ? parseInt(normalizedYear, 10) : null;
  const monthQuery = normalizedMonth ? parseInt(normalizedMonth, 10) : null;

  const t1 = Date.now();
  const [assigneeLookup, monthBundle] = await Promise.all([
    loadAssigneeLookup(projectKey),
    yearQuery != null && monthQuery != null
      ? fetchTesterMonthBundle(db, projectKey, yearQuery, monthQuery)
      : Promise.resolve(null),
  ]);
  const parentKeys = monthBundle
    ? selectTesterParentKeys(monthBundle, assigneeLookup)
    : await fetchTesterParentKeys(db, projectKey, yearQuery, monthQuery, assigneeLookup);
  const keysMs = Date.now() - t1;

  if (parentKeys.length === 0) {
    return {
      issues: [],
      timing: { keysMs, treeMs: 0, rowCount: 0, totalMs: Date.now() - t0 },
    };
  }

  const t2 = Date.now();
  const rows = await fetchTesterIssuesWithSubtasks(db, projectKey, parentKeys);
  const parentMap = buildTesterIssues(rows, assigneeLookup);
  const issues = sortTesterIssues(parentKeys.map(key => parentMap.get(key)).filter(Boolean));
  const treeMs = Date.now() - t2;

  return {
    issues,
    timing: {
      keysMs,
      treeMs,
      parentCount: parentKeys.length,
      subCount: rows.reduce((n, r) => n + (r.subtasks_json?.length || 0), 0),
      totalMs: Date.now() - t0,
    },
  };
}

module.exports = {
  fetchTesterDashboard,
  fetchTesterParentKeys,
};
