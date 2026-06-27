const {
  monthPlanDateFilterClause,
  monthPlanDateFilterParams,
  planMonthBoundsForSql,
  formatPlanDateFromDb,
  getCurrentWeekYmdRangeBangkok,
  computeWeekStatsFromDashboardTickets,
} = require('./jiraMonthFilter');
const {
  enrichIssueRowsFromLookup,
  loadProjectUsersForDashboard,
  normalizeEmail,
} = require('./assigneeIdentity');
const { fetchWorklogAggMap, attachWorklogAgg } = require('./worklogAggFromDb');
const { EXCLUDE_CANCELLED_SQL, isCancelledIssueStatus } = require('./jiraIssueStatusFilters');

function ymdNumberToPgDate(ymd) {
  const n = Number(ymd);
  if (!n) return null;
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function mapDbRowToIssueFormat(row) {
  if (!row) return null;
  let worklogAgg = row.worklog_agg;
  if (typeof worklogAgg === 'string') {
    try {
      worklogAgg = JSON.parse(worklogAgg);
    } catch {
      worklogAgg = [];
    }
  }
  if (!Array.isArray(worklogAgg)) worklogAgg = [];

  return {
    id: row.key,
    key: row.key,
    summary: row.summary || '',
    status: row.status || '',
    statusCategory: row.status_category || '',
    issueType: row.issue_type || '',
    isSubtask: !!row.is_subtask,
    updated: row.updated_at
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : new Date(row.updated_at).toISOString()
      : null,
    created: row.created_at
      ? row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString()
      : null,
    timeEstimate: row.remaining_estimate || 0,
    timeSpent: row.time_spent || 0,
    originalEstimate: row.original_estimate || 0,
    remainingEstimate: row.remaining_estimate || 0,
    creator: row.creator || null,
    startDate: formatPlanDateFromDb(row.start_date),
    dueDate: formatPlanDateFromDb(row.due_date),
    description: row.description || '',
    parentKey: row.parent_key || null,
    assignee:
      row.resolved_assignee_email || row.assignee_name || row.assignee_account_id
        ? {
            accountId: row.resolved_assignee_email || row.assignee_account_id || null,
            emailAddress: row.resolved_assignee_email || null,
            displayName: row.assignee_name || null,
            avatarUrl: row.assignee_avatar_url || null,
            role: row.assignee_role_resolved || row.assignee_role || null,
          }
        : null,
    worklogAgg,
  };
}

function buildDashboardTicketFromIssue(
  issue,
  user,
  assigneeLookup,
  weekRange,
  targetYear,
  targetMonth
) {
  let timeLogged = 0;
  let timeLoggedThisWeek = 0;
  const userEmail = normalizeEmail(user.emailAddress) || normalizeEmail(user.accountId);
  const scopeToMonth = targetYear != null && targetMonth != null;
  const aggregates = issue.worklogAgg || [];

  for (const agg of aggregates) {
    const authorEmail =
      normalizeEmail(agg.author_email) ||
      (agg.author_account_id && assigneeLookup.emailByJiraId.get(agg.author_account_id)) ||
      normalizeEmail(agg.author_account_id);
    if (!userEmail || !authorEmail || authorEmail !== userEmail) continue;
    if (scopeToMonth) {
      timeLogged += Number(agg.month_seconds) || 0;
    } else {
      timeLogged += Number(agg.total_seconds) || 0;
    }
    timeLoggedThisWeek += Number(agg.week_seconds) || 0;
  }

  return {
    id: issue.id,
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    statusCategory: issue.statusCategory,
    issueType: issue.issueType,
    updated: issue.updated,
    created: issue.created || null,
    timeEstimate: issue.originalEstimate || 0,
    timeSpent: timeLogged,
    timeSpentWeek: timeLoggedThisWeek,
    originalEstimate: issue.originalEstimate || 0,
    remainingEstimate: issue.remainingEstimate || 0,
    startDate: issue.startDate,
    dueDate: issue.dueDate,
    creator: issue.creator,
    assignee: issue.assignee ?? null,
    isSubtask: !!issue.isSubtask,
    parentKey: issue.parentKey || null,
    description: issue.description || '',
  };
}

function groupSubtasksIntoDashboardUsers(
  subtasks,
  activeUsers,
  assigneeLookup,
  weekRange,
  { targetYear, targetMonth, scopeToMonth }
) {
  const uniqueIssues = [
    ...new Map(
      (subtasks || [])
        .filter(
          issue =>
            !!issue?.key && !isCancelledIssueStatus(issue.status)
        )
        .map(issue => [issue.key, issue])
    ).values(),
  ];

  const issuesByEmail = new Map();
  const issuesByDisplayName = new Map();
  for (const issue of uniqueIssues) {
    const email =
      normalizeEmail(issue.assignee?.emailAddress) || normalizeEmail(issue.assignee?.accountId);
    if (email) {
      if (!issuesByEmail.has(email)) issuesByEmail.set(email, []);
      issuesByEmail.get(email).push(issue);
    }
    const name = (issue.assignee?.displayName || '').trim().toLowerCase();
    if (name) {
      if (!issuesByDisplayName.has(name)) issuesByDisplayName.set(name, []);
      issuesByDisplayName.get(name).push(issue);
    }
  }

  const issuesForUser = user => {
    const userEmail = normalizeEmail(user.emailAddress) || normalizeEmail(user.accountId);
    if (userEmail && issuesByEmail.has(userEmail)) return issuesByEmail.get(userEmail);
    const userName = (user.displayName || '').trim().toLowerCase();
    if (userName && issuesByDisplayName.has(userName)) return issuesByDisplayName.get(userName);
    return [];
  };

  return activeUsers.map(user => {
    const userTickets = issuesForUser(user)
      .map(issue =>
        buildDashboardTicketFromIssue(
          issue,
          user,
          assigneeLookup,
          weekRange,
          scopeToMonth ? targetYear : null,
          scopeToMonth ? targetMonth : null
        )
      )
      .sort((a, b) => {
        const dateA = a.startDate ? new Date(a.startDate).getTime() : Infinity;
        const dateB = b.startDate ? new Date(b.startDate).getTime() : Infinity;
        if (dateA !== dateB) return dateA - dateB;
        return new Date(b.updated).getTime() - new Date(a.updated).getTime();
      });

    return { user, tickets: userTickets };
  });
}

/**
 * Dashboard monthly — 1 query subtask + worklog aggregate (Postgres), không dựng cây parent/subtask.
 */
async function fetchMonthlySubtasksFromDb(db, projectKey, targetYear, targetMonth, weekRange) {
  const monthWhere = monthPlanDateFilterClause('i', 2);
  const monthParams = monthPlanDateFilterParams(targetYear, targetMonth);
  const monthBounds = planMonthBoundsForSql(targetYear, targetMonth);
  const weekStart = weekRange ? ymdNumberToPgDate(weekRange.start) : null;
  const weekEnd = weekRange ? ymdNumberToPgDate(weekRange.end) : null;

  const tIssues = Date.now();
  const res = await db.query(
    `
    SELECT
      i.key, i.parent_key, i.is_subtask, i.summary, i.status, i.status_category, i.issue_type,
      i.updated_at, i.created_at, i.original_estimate, i.remaining_estimate,
      i.start_date, i.due_date, i.creator, i.time_spent,
      i.assignee_account_id, i.assignee_name, i.assignee_role
    FROM jira_issues i
    WHERE i.project_key = $1
      AND i.is_subtask = true
      ${EXCLUDE_CANCELLED_SQL}
      AND ${monthWhere}
    ORDER BY i.updated_at DESC
    `,
    [projectKey, ...monthParams]
  );
  const issuesMs = Date.now() - tIssues;

  const keys = res.rows.map(r => r.key);
  const tWorklog = Date.now();
  const worklogMap = await fetchWorklogAggMap(db, keys, monthBounds, weekStart, weekEnd);
  const worklogMs = Date.now() - tWorklog;

  return {
    rows: attachWorklogAgg(res.rows, worklogMap),
    issuesMs,
    worklogMs,
  };
}

async function fetchMonthlyDashboard(db, projectKey, targetYear, targetMonth) {
  const t0 = Date.now();
  const weekRange = getCurrentWeekYmdRangeBangkok();

  let usersMs = 0;
  let issuesMs = 0;
  let worklogMs = 0;
  const usersTask = (async () => {
    const s = Date.now();
    const r = await loadProjectUsersForDashboard(projectKey);
    usersMs = Date.now() - s;
    return r;
  })();
  const subtasksTask = (async () => {
    const r = await fetchMonthlySubtasksFromDb(db, projectKey, targetYear, targetMonth, weekRange);
    issuesMs = r.issuesMs;
    worklogMs = r.worklogMs;
    return r;
  })();
  const [{ activeUsers, assigneeLookup }, subtaskBundle] = await Promise.all([
    usersTask,
    subtasksTask,
  ]);
  const rows = subtaskBundle.rows;
  const subtasksMs = issuesMs + worklogMs;

  if (activeUsers.length === 0) {
    return {
      users: [],
      weekStats: { weeklyCount: 0, weeklyLogSeconds: 0, weeklyEstimateSeconds: 0 },
      timing: { usersMs, issuesMs, worklogMs, subtasksMs: issuesMs + worklogMs, totalMs: Date.now() - t0 },
    };
  }

  enrichIssueRowsFromLookup(rows, assigneeLookup);
  const subtasks = rows.map(mapDbRowToIssueFormat).filter(Boolean);

  const dashboardData = groupSubtasksIntoDashboardUsers(
    subtasks,
    activeUsers,
    assigneeLookup,
    weekRange,
    { targetYear, targetMonth, scopeToMonth: true }
  );
  const weekStats = computeWeekStatsFromDashboardTickets(dashboardData, weekRange);

  return {
    users: dashboardData,
    weekStats,
    timing: {
      usersMs,
      issuesMs,
      worklogMs,
      subtasksMs,
      rowCount: rows.length,
      totalMs: Date.now() - t0,
    },
  };
}

module.exports = {
  fetchMonthlyDashboard,
  fetchMonthlySubtasksFromDb,
  groupSubtasksIntoDashboardUsers,
  buildDashboardTicketFromIssue,
  mapDbRowToIssueFormat,
};
