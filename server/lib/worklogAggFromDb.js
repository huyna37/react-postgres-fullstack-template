const WORK_TZ = 'Asia/Bangkok';

/**
 * Batch aggregate worklogs for many issue keys — one scan instead of per-row LATERAL.
 * Returns Map<issueKey, Array<{author_email, author_account_id, total_seconds, month_seconds, week_seconds}>>
 */
async function fetchWorklogAggMap(db, issueKeys, monthBounds, weekStart, weekEnd) {
  const map = new Map();
  if (!issueKeys?.length) return map;

  const monthStartTz = monthBounds?.monthStartTz ?? null;
  const monthEndExclusiveTz = monthBounds?.monthEndExclusiveTz ?? null;

  const res = await db.query(
    `
    SELECT
      w.issue_key,
      LOWER(TRIM(COALESCE(w.author_email, ''))) AS author_email,
      w.author_account_id,
      COALESCE(SUM(w.time_spent_seconds), 0)::int AS total_seconds,
      COALESCE(SUM(w.time_spent_seconds) FILTER (
        WHERE $2::timestamptz IS NOT NULL AND $3::timestamptz IS NOT NULL
          AND w.started_at >= $2::timestamptz AND w.started_at < $3::timestamptz
      ), 0)::int AS month_seconds,
      COALESCE(SUM(w.time_spent_seconds) FILTER (
        WHERE $4::date IS NOT NULL AND $5::date IS NOT NULL
          AND (w.started_at AT TIME ZONE '${WORK_TZ}')::date BETWEEN $4::date AND $5::date
      ), 0)::int AS week_seconds
    FROM jira_worklog_entries w
    WHERE w.issue_key = ANY($1::text[])
    GROUP BY w.issue_key, LOWER(TRIM(COALESCE(w.author_email, ''))), w.author_account_id
    `,
    [issueKeys, monthStartTz, monthEndExclusiveTz, weekStart, weekEnd]
  );

  for (const row of res.rows) {
    if (!map.has(row.issue_key)) map.set(row.issue_key, []);
    map.get(row.issue_key).push({
      author_email: row.author_email,
      author_account_id: row.author_account_id,
      total_seconds: row.total_seconds,
      month_seconds: row.month_seconds,
      week_seconds: row.week_seconds,
    });
  }
  return map;
}

function attachWorklogAgg(rows, worklogMap) {
  for (const row of rows) {
    row.worklog_agg = worklogMap.get(row.key) || [];
  }
  return rows;
}

module.exports = {
  fetchWorklogAggMap,
  attachWorklogAgg,
};
