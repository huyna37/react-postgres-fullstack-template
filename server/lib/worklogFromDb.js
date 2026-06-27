const { normalizeEmail, buildAssigneeLookup, loadAssigneeLookup } = require('./assigneeIdentity');
const { formatPlanDateFromDb } = require('./jiraMonthFilter');

const WORK_TZ = 'Asia/Bangkok';

function formatEstimateSeconds(seconds) {
  const n = Number(seconds) || 0;
  if (n <= 0) return '—';
  const h = n / 3600;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

/** Jira chỉ nhận dạng `2h`, `45m`, `1h 30m` — không nhận `1.75h`. */
function formatSecondsToJiraTime(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  if (n <= 0) return '1m';
  let hours = Math.floor(n / 3600);
  let minutes = Math.round((n % 3600) / 60);
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return minutes > 0 ? `${minutes}m` : '1m';
}

function formatHoursToJiraEstimate(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return '1m';
  return formatSecondsToJiraTime(Math.round(n * 3600));
}

function resolveAuthorEmail(row, lookup) {
  return (
    normalizeEmail(row.author_email) ||
    (row.author_account_id && lookup.emailByJiraId.get(row.author_account_id)) ||
    normalizeEmail(row.author_account_id)
  );
}

/** Khớp author worklog với user — dùng trong SQL (auto logwork, under-logged). */
function worklogAuthorMatchesUserSql(accountIdRef, emailRef, wAlias = 'w') {
  const w = wAlias;
  return `(
    (${accountIdRef}::text IS NOT NULL AND TRIM(COALESCE(${w}.author_account_id, '')) = TRIM(${accountIdRef}))
    OR (${emailRef}::text IS NOT NULL AND LOWER(TRIM(COALESCE(${w}.author_email, ''))) = LOWER(TRIM(${emailRef})))
    OR (
      ${emailRef}::text IS NOT NULL
      AND TRIM(COALESCE(${w}.author_account_id, '')) LIKE '%@%'
      AND LOWER(TRIM(${w}.author_account_id)) = LOWER(TRIM(${emailRef}))
    )
    OR EXISTS (
      SELECT 1 FROM jira_users u
      WHERE TRIM(COALESCE(u.account_id, '')) <> ''
        AND TRIM(u.account_id) = TRIM(${w}.author_account_id)
        AND (
          (
            ${emailRef}::text IS NOT NULL
            AND LOWER(TRIM(COALESCE(u.email_address, ''))) = LOWER(TRIM(${emailRef}))
          )
          OR (
            ${accountIdRef}::text IS NOT NULL
            AND TRIM(u.account_id) = TRIM(${accountIdRef})
          )
        )
    )
  )`;
}

function worklogBelongsToUser(row, identity, lookup) {
  const userEmail = normalizeEmail(identity.email) || normalizeEmail(identity.accountId);
  if (!userEmail) return false;

  const authorEmail = resolveAuthorEmail(row, lookup);
  if (authorEmail && authorEmail === userEmail) return true;

  if (identity.accountId && row.author_account_id === identity.accountId) return true;

  if (row.author_account_id && lookup.emailByJiraId.get(row.author_account_id) === userEmail) {
    return true;
  }

  return false;
}

function rowToWorklogPayload(row) {
  let comment = row.comment;
  if (typeof comment === 'string') {
    try {
      comment = JSON.parse(comment);
    } catch {
      /* keep string */
    }
  }

  const seconds = Number(row.time_spent_seconds) || 0;
  return {
    id: row.id,
    issueKey: row.issue_key,
    timeSpent: row.time_spent || formatSecondsToJiraTime(seconds),
    timeSpentSeconds: seconds,
    started: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    comment: comment ?? null,
  };
}

function resolveProjectKeys(jiraProject) {
  const keys = String(jiraProject || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : null;
}

async function loadUserWorklogIdentity(db, userId) {
  const res = await db.query(
    `SELECT id, account_id, email_address, display_name, username, jira_project
     FROM jira_users WHERE id = $1`,
    [userId]
  );
  if (!res.rows.length) return null;

  const row = res.rows[0];
  return {
    accountId: row.account_id || null,
    email: normalizeEmail(row.email_address) || normalizeEmail(row.account_id),
    username: row.username || null,
    jiraProject: row.jira_project || null,
  };
}

async function fetchUserWorklogsFromDb(db, { userId, year, month }) {
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  if (!yearInt || !monthInt || monthInt < 1 || monthInt > 12) {
    throw new Error('year hoặc month không hợp lệ');
  }

  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) {
    throw new Error('Không tìm thấy người dùng.');
  }

  const projectKeys = resolveProjectKeys(identity.jiraProject);
  const startDate = `${yearInt}-${String(monthInt).padStart(2, '0')}-01`;
  const nextMonth = monthInt === 12 ? 1 : monthInt + 1;
  const nextYear = monthInt === 12 ? yearInt + 1 : yearInt;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const params = [startDate, endDate, identity.accountId, identity.email];
  let projectFilter = '';
  if (projectKeys) {
    params.push(projectKeys);
    projectFilter = `AND w.project_key = ANY($5::text[])`;
  }

  const rowsRes = await db.query(
    `
    SELECT
      w.id,
      w.issue_key,
      w.started_at,
      w.time_spent_seconds,
      w.time_spent,
      w.comment,
      w.author_account_id,
      w.author_email,
      i.summary,
      i.start_date,
      i.due_date,
      i.original_estimate,
      i.status,
      i.status_category
    FROM jira_worklog_entries w
    INNER JOIN jira_issues i ON i.key = w.issue_key
    WHERE w.started_at >= $1::timestamptz
      AND w.started_at < $2::timestamptz
      AND (
        ($3::text IS NOT NULL AND w.author_account_id = $3)
        OR ($4::text IS NOT NULL AND LOWER(w.author_email) = LOWER($4))
      )
      ${projectFilter}
    ORDER BY w.started_at DESC
    `,
    params
  );

  const issueMonthTotals = new Map();
  const myWorklogs = [];

  for (const row of rowsRes.rows) {
    const issueKey = row.issue_key;
    const seconds = Number(row.time_spent_seconds) || 0;
    issueMonthTotals.set(issueKey, (issueMonthTotals.get(issueKey) || 0) + seconds);

    let comment = row.comment;
    if (typeof comment === 'string') {
      try {
        comment = JSON.parse(comment);
      } catch {
        /* keep string */
      }
    }

    myWorklogs.push({
      id: row.id,
      issueKey,
      summary: row.summary || '',
      timeSpent: row.time_spent || formatEstimateSeconds(seconds),
      timeSpentSeconds: seconds,
      started: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
      comment: comment ?? null,
      startDate: formatPlanDateFromDb(row.start_date),
      dueDate: formatPlanDateFromDb(row.due_date),
      originalEstimate: formatEstimateSeconds(row.original_estimate),
      originalEstimateSeconds: Number(row.original_estimate) || 0,
      status: row.status || '',
      statusCategory: row.status_category || '',
    });
  }

  for (const wl of myWorklogs) {
    wl.issueMonthTotalSeconds = issueMonthTotals.get(wl.issueKey) || 0;
  }

  const totalSeconds = myWorklogs.reduce((sum, wl) => sum + (wl.timeSpentSeconds || 0), 0);

  return {
    worklogs: myWorklogs,
    totalTimeSpentSeconds: totalSeconds,
    source: 'db',
  };
}

async function fetchLatestUserWorklogForIssue(db, userId, issueKey, opts = {}) {
  const key = String(issueKey || '').trim();
  if (!key) return null;

  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) return null;

  const issueRes = await db.query(`SELECT project_key FROM jira_issues WHERE key = $1 LIMIT 1`, [
    key,
  ]);
  const projectKey = issueRes.rows[0]?.project_key || null;
  const lookup = projectKey ? await loadAssigneeLookup(projectKey) : buildAssigneeLookup([]);

  const year = opts.year != null ? parseInt(opts.year, 10) : null;
  const month = opts.month != null ? parseInt(opts.month, 10) : null;

  const res = await db.query(
    `
    SELECT issue_key, id, started_at, time_spent, time_spent_seconds, comment,
           author_account_id, author_email
    FROM jira_worklog_entries
    WHERE issue_key = $1
    ORDER BY started_at DESC
    `,
    [key]
  );

  const mine = res.rows.filter(row => worklogBelongsToUser(row, identity, lookup));
  if (!mine.length) return null;

  let picked = mine[0];
  if (year && month) {
    const inMonth = mine.filter(row => {
      const d = row.started_at instanceof Date ? row.started_at : new Date(row.started_at);
      if (Number.isNaN(d.getTime())) return false;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: WORK_TZ,
        year: 'numeric',
        month: 'numeric',
      }).formatToParts(d);
      const y = Number(parts.find(p => p.type === 'year')?.value);
      const m = Number(parts.find(p => p.type === 'month')?.value);
      return y === year && m === month;
    });
    if (inMonth.length) picked = inMonth[0];
  }

  return rowToWorklogPayload(picked);
}

async function fetchUserMonthSecondsForIssue(db, userId, issueKey, year, month) {
  const key = String(issueKey || '').trim();
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  if (!key || !yearInt || !monthInt || monthInt < 1 || monthInt > 12) return 0;

  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) return 0;

  const issueRes = await db.query('SELECT project_key FROM jira_issues WHERE key = $1 LIMIT 1', [
    key,
  ]);
  const projectKey = issueRes.rows[0]?.project_key || null;
  const lookup = projectKey ? await loadAssigneeLookup(projectKey) : { emailByJiraId: new Map() };

  const res = await db.query(
    `SELECT time_spent_seconds, author_account_id, author_email, started_at
     FROM jira_worklog_entries
     WHERE issue_key = $1`,
    [key]
  );

  let total = 0;
  for (const row of res.rows) {
    if (!worklogBelongsToUser(row, identity, lookup)) continue;
    if (!worklogStartedInMonth(row.started_at, yearInt, monthInt)) continue;
    total += Number(row.time_spent_seconds) || 0;
  }
  return total;
}

function worklogStartedInMonth(startedAt, year, month, tz = WORK_TZ) {
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(d.getTime())) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(d);
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const m = Number(parts.find(p => p.type === 'month')?.value);
  return y === year && m === month;
}

module.exports = {
  fetchUserWorklogsFromDb,
  fetchLatestUserWorklogForIssue,
  fetchUserMonthSecondsForIssue,
  loadUserWorklogIdentity,
  worklogAuthorMatchesUserSql,
  worklogBelongsToUser,
  worklogStartedInMonth,
  formatEstimateSeconds,
  formatSecondsToJiraTime,
  formatHoursToJiraEstimate,
};
