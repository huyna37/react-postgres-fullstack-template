const { normalizeEmail } = require('./assigneeIdentity');

function extractAuthorFields(author = {}) {
  const accountId = author.accountId || author.name || author.key || null;
  const email = normalizeEmail(author.emailAddress) || normalizeEmail(author.accountId) || null;
  return {
    authorAccountId: accountId ? String(accountId) : null,
    authorEmail: email,
  };
}

async function syncWorklogEntriesForIssue(db, issueKey, projectKey, worklog) {
  const entries = Array.isArray(worklog?.worklogs) ? worklog.worklogs : [];

  await db.query('DELETE FROM jira_worklog_entries WHERE issue_key = $1', [issueKey]);
  if (!entries.length) return 0;

  let inserted = 0;
  for (const wl of entries) {
    if (!wl?.id || !wl?.started) continue;
    const { authorAccountId, authorEmail } = extractAuthorFields(wl.author);
    await db.query(
      `INSERT INTO jira_worklog_entries (
        id, issue_key, project_key, author_account_id, author_email,
        started_at, time_spent_seconds, time_spent, comment
      ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9::jsonb)
      ON CONFLICT (issue_key, id) DO UPDATE SET
        project_key = EXCLUDED.project_key,
        author_account_id = EXCLUDED.author_account_id,
        author_email = EXCLUDED.author_email,
        started_at = EXCLUDED.started_at,
        time_spent_seconds = EXCLUDED.time_spent_seconds,
        time_spent = EXCLUDED.time_spent,
        comment = EXCLUDED.comment,
        updated_at = CURRENT_TIMESTAMP`,
      [
        String(wl.id),
        issueKey,
        projectKey,
        authorAccountId,
        authorEmail,
        wl.started,
        Number(wl.timeSpentSeconds) || 0,
        wl.timeSpent || null,
        wl.comment != null ? JSON.stringify(wl.comment) : null,
      ]
    );
    inserted += 1;
  }
  return inserted;
}

function rowToWorklogEntry(row) {
  return {
    id: row.id,
    started: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    timeSpentSeconds: Number(row.time_spent_seconds) || 0,
    timeSpent: row.time_spent || null,
    comment: row.comment ?? null,
    author: {
      accountId: row.author_account_id || null,
      emailAddress: row.author_email || null,
      key: row.author_account_id || null,
      name: row.author_account_id || null,
    },
  };
}

async function loadWorklogsByIssueKeys(db, issueKeys) {
  if (!Array.isArray(issueKeys) || issueKeys.length === 0) {
    return new Map();
  }

  const res = await db.query(
    `
    SELECT issue_key, id, started_at, time_spent_seconds, time_spent, comment,
           author_account_id, author_email
    FROM jira_worklog_entries
    WHERE issue_key = ANY($1::text[])
    ORDER BY issue_key, started_at DESC
    `,
    [issueKeys]
  );

  const map = new Map();
  for (const row of res.rows) {
    if (!map.has(row.issue_key)) {
      map.set(row.issue_key, { worklogs: [] });
    }
    map.get(row.issue_key).worklogs.push(rowToWorklogEntry(row));
  }
  return map;
}

async function attachWorklogsToRows(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const keys = [...new Set(rows.map(r => r.key).filter(Boolean))];
  const map = await loadWorklogsByIssueKeys(db, keys);
  for (const row of rows) {
    row.worklog = map.get(row.key) || { worklogs: [] };
  }
  return rows;
}

const WORK_TZ = 'Asia/Bangkok';
const { planMonthBoundsForSql } = require('./jiraMonthFilter');

function ymdNumberToPgDate(ymd) {
  const n = Number(ymd);
  if (!n) return null;
  const s = String(n).padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** Tổng giây theo issue + author — dùng cho Dashboard thay vì tải full worklog JSON. */
async function attachWorklogAggregatesToRows(db, rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const keys = [...new Set(rows.map(r => r.key).filter(Boolean))];
  if (!keys.length) return rows;

  const year = opts.year != null ? parseInt(opts.year, 10) : null;
  const month = opts.month != null ? parseInt(opts.month, 10) : null;
  const monthBounds = year && month ? planMonthBoundsForSql(year, month) : null;
  const monthStartTz = monthBounds?.monthStartTz ?? null;
  const monthEndExclusiveTz = monthBounds?.monthEndExclusiveTz ?? null;
  const weekStart = opts.weekRange ? ymdNumberToPgDate(opts.weekRange.start) : null;
  const weekEnd = opts.weekRange ? ymdNumberToPgDate(opts.weekRange.end) : null;

  const res = await db.query(
    `
    SELECT
      w.issue_key,
      LOWER(TRIM(COALESCE(w.author_email, ''))) AS author_email,
      w.author_account_id,
      COALESCE(SUM(w.time_spent_seconds), 0)::int AS total_seconds,
      COALESCE(SUM(w.time_spent_seconds) FILTER (
        WHERE $2::timestamptz IS NOT NULL
          AND $3::timestamptz IS NOT NULL
          AND w.started_at >= $2::timestamptz AND w.started_at < $3::timestamptz
      ), 0)::int AS month_seconds,
      COALESCE(SUM(w.time_spent_seconds) FILTER (
        WHERE $4::date IS NOT NULL
          AND $5::date IS NOT NULL
          AND (w.started_at AT TIME ZONE '${WORK_TZ}')::date BETWEEN $4::date AND $5::date
      ), 0)::int AS week_seconds
    FROM jira_worklog_entries w
    WHERE w.issue_key = ANY($1::text[])
    GROUP BY w.issue_key, LOWER(TRIM(COALESCE(w.author_email, ''))), w.author_account_id
    `,
    [keys, monthStartTz, monthEndExclusiveTz, weekStart, weekEnd]
  );

  const map = new Map();
  for (const row of res.rows) {
    if (!map.has(row.issue_key)) map.set(row.issue_key, []);
    map.get(row.issue_key).push(row);
  }

  for (const row of rows) {
    row.worklogAgg = map.get(row.key) || [];
  }
  return rows;
}

module.exports = {
  syncWorklogEntriesForIssue,
  extractAuthorFields,
  loadWorklogsByIssueKeys,
  attachWorklogsToRows,
  attachWorklogAggregatesToRows,
};
