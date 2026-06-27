const { loadUserWorklogIdentity } = require('./worklogFromDb');
const {
  listWorkingDaysInMonthUpToToday,
  todayYmdBangkok,
  WORKING_HOURS_PER_DAY,
} = require('./workingDays');
const { fetchPersonalOtMap, requiredHoursForDay } = require('./personalOtFromDb');
const { EXCLUDE_CANCELLED_SQL } = require('./jiraIssueStatusFilters');

function resolveProjectKeys(jiraProject) {
  const keys = String(jiraProject || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : null;
}

function parseDateYmd(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

/** Chỉ task/sub-task/bug… — bỏ Story, Epic (và tên tiếng Việt tương đương). */
const EXCLUDE_STORY_EPIC_SQL = `
  AND LOWER(COALESCE(i.issue_type, '')) NOT LIKE '%story%'
  AND LOWER(COALESCE(i.issue_type, '')) NOT LIKE '%yêu cầu%'
  AND LOWER(COALESCE(i.issue_type, '')) NOT LIKE '%epic%'
`;

/** Còn giờ log được — khớp logic remainingLogHours trên client. */
const HAS_REMAINING_LOG_SQL = `
  AND (
    COALESCE(i.original_estimate, 0) <= 0
    OR (
      CASE
        WHEN COALESCE(i.remaining_estimate, 0) > 0 THEN
          LEAST(
            GREATEST(0, COALESCE(i.original_estimate, 0) - COALESCE(i.time_spent, 0)),
            COALESCE(i.remaining_estimate, 0)
          )
        ELSE GREATEST(0, COALESCE(i.original_estimate, 0) - COALESCE(i.time_spent, 0))
      END > 0
    )
  )
`;

function yearMonthFromYmd(dateYmd) {
  const date = parseDateYmd(dateYmd);
  if (!date) return null;
  const [year, month] = date.split('-').map(Number);
  if (!year || !month) return null;
  return { year, month };
}

/** Khớp author worklog với user hiện tại (accountId hoặc email). */
function worklogAuthorMatchSql(accountIdRef, emailRef, wAlias = 'w') {
  const w = wAlias;
  return `(
    (${accountIdRef}::text IS NOT NULL AND TRIM(COALESCE(${w}.author_account_id, '')) = TRIM(${accountIdRef}))
    OR (${emailRef}::text IS NOT NULL AND LOWER(TRIM(COALESCE(${w}.author_email, ''))) = LOWER(TRIM(${emailRef})))
    OR (
      ${emailRef}::text IS NOT NULL
      AND TRIM(COALESCE(${w}.author_account_id, '')) LIKE '%@%'
      AND LOWER(TRIM(${w}.author_account_id)) = LOWER(TRIM(${emailRef}))
    )
  )`;
}

/** Chưa có worklog (giây > 0) của user trong ngày ghi log. */
function noUserLogOnDateSql(logDateRef, accountIdRef, emailRef) {
  return `AND NOT EXISTS (
    SELECT 1
    FROM jira_worklog_entries w
    WHERE w.issue_key = i.key
      AND (w.started_at AT TIME ZONE 'Asia/Bangkok')::date = ${logDateRef}::date
      AND COALESCE(w.time_spent_seconds, 0) > 0
      AND ${worklogAuthorMatchSql(accountIdRef, emailRef, 'w')}
  )`;
}

/** Chưa có worklog (giây > 0) của user trên ticket — bất kỳ ngày nào. */
function noUserLogOnIssueSql(accountIdRef, emailRef) {
  return `AND NOT EXISTS (
    SELECT 1
    FROM jira_worklog_entries w
    WHERE w.issue_key = i.key
      AND COALESCE(w.time_spent_seconds, 0) > 0
      AND ${worklogAuthorMatchSql(accountIdRef, emailRef, 'w')}
  )`;
}

/** start_date và due_date đều thuộc cùng tháng (theo ngày lọc). */
function planDatesInMonthSql(yearParamRef, monthParamRef) {
  return `
    AND i.start_date IS NOT NULL
    AND i.due_date IS NOT NULL
    AND EXTRACT(YEAR FROM i.start_date) = ${yearParamRef}
    AND EXTRACT(MONTH FROM i.start_date) = ${monthParamRef}
    AND EXTRACT(YEAR FROM i.due_date) = ${yearParamRef}
    AND EXTRACT(MONTH FROM i.due_date) = ${monthParamRef}
  `;
}

/** Ngày lọc nằm trong khoảng start_date … due_date (cùng ngày cũng hợp lệ). */
function planDateInRangeSql(dateRef) {
  return `
    AND i.start_date IS NOT NULL
    AND i.due_date IS NOT NULL
    AND i.start_date::date <= ${dateRef}::date
    AND i.due_date::date >= ${dateRef}::date
  `;
}

/**
 * Ticket Done gán cho user — ngày lọc nằm trong [start_date, due_date].
 */
async function fetchAutoLogworkCandidates(db, userId, dateYmd, logDateYmd) {
  const date = parseDateYmd(dateYmd);
  if (!date) throw new Error('date phải dạng YYYY-MM-DD');
  const logDate = parseDateYmd(logDateYmd) || date;

  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) throw new Error('Không tìm thấy người dùng.');

  const planMonth = yearMonthFromYmd(date);
  if (!planMonth) throw new Error('date phải dạng YYYY-MM-DD');

  const projectKeys = resolveProjectKeys(identity.jiraProject);
  const params = [date, logDate, identity.accountId, identity.email, planMonth.year, planMonth.month];
  let projectFilter = '';
  if (projectKeys) {
    params.push(projectKeys);
    projectFilter = `AND i.project_key = ANY($${params.length}::text[])`;
  }

  const res = await db.query(
    `
    SELECT
      i.key,
      i.summary,
      i.status,
      i.status_category,
      i.start_date,
      i.due_date,
      COALESCE(i.original_estimate, 0)::int AS original_estimate,
      COALESCE(i.time_spent, 0)::int AS time_spent,
      COALESCE(i.remaining_estimate, 0)::int AS remaining_estimate,
      i.updated_at
    FROM jira_issues i
    WHERE LOWER(COALESCE(i.status_category, '')) IN ('done', 'indeterminate', 'in progress')
      ${planDateInRangeSql('$1')}
      AND (
        ($3::text IS NOT NULL AND i.assignee_account_id = $3)
        OR ($4::text IS NOT NULL AND LOWER(i.assignee_account_id) = LOWER($4))
      )
      ${EXCLUDE_STORY_EPIC_SQL}
      ${EXCLUDE_CANCELLED_SQL}
      ${planDatesInMonthSql('$5::int', '$6::int')}
      ${projectFilter}
      ${noUserLogOnDateSql('$2', '$3', '$4')}
      ${noUserLogOnIssueSql('$3', '$4')}
      ${HAS_REMAINING_LOG_SQL}
    ORDER BY i.start_date DESC, i.key ASC
    `,
    params
  );

  return {
    date,
    logDate,
    planYear: planMonth.year,
    planMonth: planMonth.month,
    issues: res.rows.map(row => mapRowToCandidateIssue(row)),
  };
}

function mapRowToCandidateIssue(row) {
  const originalEstimateSeconds = Number(row.original_estimate) || 0;
  const timeSpentSeconds = Number(row.time_spent) || 0;
  const remainingEstimateSeconds = Number(row.remaining_estimate) || 0;
  const remainingFromOriginal = Math.max(0, originalEstimateSeconds - timeSpentSeconds);
  const remainingLogSeconds =
    originalEstimateSeconds > 0
      ? remainingEstimateSeconds > 0
        ? Math.min(remainingFromOriginal, remainingEstimateSeconds)
        : remainingFromOriginal
      : 0;

  return {
    key: row.key,
    summary: row.summary || '',
    status: row.status || '',
    statusCategory: row.status_category || '',
    issueType: row.issue_type || '',
    startDate: formatPgDate(row.start_date),
    dueDate: formatPgDate(row.due_date),
    originalEstimateSeconds,
    originalEstimateHours: +(originalEstimateSeconds / 3600).toFixed(2),
    timeSpentSeconds,
    timeSpentHours: +(timeSpentSeconds / 3600).toFixed(2),
    remainingLogSeconds,
    remainingLogHours: +(remainingLogSeconds / 3600).toFixed(2),
    loggedOnLogDateSeconds: 0,
    loggedOnLogDateHours: 0,
    updatedAt: row.updated_at,
  };
}

/**
 * Gợi ý ticket Done (trừ Story/Epic) gán cho user — dùng dropdown khi thêm thủ công.
 */
async function searchIssuesForAutoLogwork(
  db,
  userId,
  query,
  limit = 15,
  logDateYmd = null,
  planDateYmd = null
) {
  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) throw new Error('Không tìm thấy người dùng.');

  const rawQ = String(query || '').trim();
  if (!rawQ || rawQ.length < 2) return { issues: [] };

  const logDate = parseDateYmd(logDateYmd);
  const planDate = parseDateYmd(planDateYmd);

  const projectKeys = resolveProjectKeys(identity.jiraProject);
  const params = [identity.accountId, identity.email];
  let logDateFilter = '';
  if (logDate) {
    params.push(logDate);
    logDateFilter = noUserLogOnDateSql(`$${params.length}`, '$1', '$2');
  }
  let planDateFilter = '';
  if (planDate) {
    params.push(planDate);
    planDateFilter = planDateInRangeSql(`$${params.length}`);
    const planMonth = yearMonthFromYmd(planDate);
    if (planMonth) {
      params.push(planMonth.year, planMonth.month);
      planDateFilter += planDatesInMonthSql(`$${params.length - 1}::int`, `$${params.length}::int`);
    }
  }
  const issueLogFilter = noUserLogOnIssueSql('$1', '$2');
  let projectFilter = '';
  if (projectKeys) {
    params.push(projectKeys);
    projectFilter = `AND i.project_key = ANY($${params.length}::text[])`;
  }

  const pattern = `%${rawQ}%`;
  params.push(pattern);
  const patternParam = params.length;

  let keySuffixSql = '';
  if (/^\d+$/.test(rawQ)) {
    params.push(`%-${rawQ}`);
    keySuffixSql = `OR i.key ILIKE $${params.length}`;
  }

  params.push(Math.min(Math.max(Number(limit) || 15, 1), 30));
  const limitParam = params.length;

  const res = await db.query(
    `
    SELECT
      i.key,
      i.summary,
      i.status,
      i.status_category,
      i.issue_type,
      i.start_date,
      i.due_date,
      COALESCE(i.original_estimate, 0)::int AS original_estimate,
      COALESCE(i.time_spent, 0)::int AS time_spent,
      COALESCE(i.remaining_estimate, 0)::int AS remaining_estimate,
      i.updated_at
    FROM jira_issues i
    WHERE LOWER(COALESCE(i.status_category, '')) IN ('done', 'indeterminate', 'in progress')
      AND (
        ($1::text IS NOT NULL AND i.assignee_account_id = $1)
        OR ($2::text IS NOT NULL AND LOWER(i.assignee_account_id) = LOWER($2))
      )
      ${EXCLUDE_STORY_EPIC_SQL}
      ${EXCLUDE_CANCELLED_SQL}
      ${projectFilter}
      ${planDateFilter}
      AND (
        i.key ILIKE $${patternParam}
        OR i.summary ILIKE $${patternParam}
        OR i.status ILIKE $${patternParam}
        ${keySuffixSql}
      )
      ${logDateFilter}
      ${issueLogFilter}
      ${HAS_REMAINING_LOG_SQL}
    ORDER BY
      CASE
        WHEN i.key ILIKE $${patternParam} THEN 0
        WHEN ${keySuffixSql ? `i.key ILIKE $${params.length - 1}` : 'FALSE'} THEN 1
        ELSE 2
      END,
      i.updated_at DESC
    LIMIT $${limitParam}
    `,
    params
  );

  return { issues: res.rows.map(row => mapRowToCandidateIssue(row)) };
}

async function fetchIssueForAutoLogwork(
  db,
  userId,
  issueKey,
  logDateYmd,
  planDateYmd
) {
  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) throw new Error('Không tìm thấy người dùng.');

  const key = String(issueKey || '').trim();
  if (!key) throw new Error('Thiếu issueKey');
  const logDate = parseDateYmd(logDateYmd) || null;
  const planDate = parseDateYmd(planDateYmd) || null;

  const projectKeys = resolveProjectKeys(identity.jiraProject);
  const params = [key, identity.accountId, identity.email];
  let projectFilter = '';
  if (projectKeys) {
    params.push(projectKeys);
    projectFilter = `AND i.project_key = ANY($${params.length}::text[])`;
  }

  let planDateFilter = '';
  if (planDate) {
    params.push(planDate);
    planDateFilter = planDateInRangeSql(`$${params.length}`);
    const planMonth = yearMonthFromYmd(planDate);
    if (planMonth) {
      params.push(planMonth.year, planMonth.month);
      planDateFilter += planDatesInMonthSql(`$${params.length - 1}::int`, `$${params.length}::int`);
    }
  }

  let logDateFilter = '';
  if (logDate) {
    params.push(logDate);
    logDateFilter = noUserLogOnDateSql(`$${params.length}`, '$2', '$3');
  }
  const issueLogFilter = noUserLogOnIssueSql('$2', '$3');

  const res = await db.query(
    `
    SELECT
      i.key,
      i.summary,
      i.status,
      i.status_category,
      i.start_date,
      i.due_date,
      COALESCE(i.original_estimate, 0)::int AS original_estimate,
      COALESCE(i.time_spent, 0)::int AS time_spent,
      COALESCE(i.remaining_estimate, 0)::int AS remaining_estimate
    FROM jira_issues i
    WHERE i.key = $1
      AND LOWER(COALESCE(i.status_category, '')) IN ('done', 'indeterminate', 'in progress')
      AND (
        ($2::text IS NOT NULL AND i.assignee_account_id = $2)
        OR ($3::text IS NOT NULL AND LOWER(i.assignee_account_id) = LOWER($3))
      )
      ${EXCLUDE_STORY_EPIC_SQL}
      ${EXCLUDE_CANCELLED_SQL}
      ${planDateFilter}
      ${projectFilter}
      ${logDateFilter}
      ${issueLogFilter}
      ${HAS_REMAINING_LOG_SQL}
    LIMIT 1
    `,
    params
  );

  if (!res.rows.length) return null;

  return mapRowToCandidateIssue(res.rows[0]);
}

function formatPgDate(val) {
  if (val == null) return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(val);
  }
  const s = String(val);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function loadMonthLoggedSecondsByDate(db, userId, yearInt, monthInt) {
  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) throw new Error('Không tìm thấy người dùng.');

  const startDate = `${yearInt}-${String(monthInt).padStart(2, '0')}-01`;
  const nextMonth = monthInt === 12 ? 1 : monthInt + 1;
  const nextYear = monthInt === 12 ? yearInt + 1 : yearInt;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

  const projectKeys = resolveProjectKeys(identity.jiraProject);
  const params = [startDate, endDate, identity.accountId, identity.email];
  let projectFilter = '';
  if (projectKeys) {
    params.push(projectKeys);
    projectFilter = `AND w.project_key = ANY($5::text[])`;
  }

  const res = await db.query(
    `
    SELECT
      (w.started_at AT TIME ZONE 'Asia/Bangkok')::date AS work_date,
      COALESCE(SUM(w.time_spent_seconds), 0)::int AS logged_seconds
    FROM jira_worklog_entries w
    WHERE w.started_at >= $1::timestamptz
      AND w.started_at < $2::timestamptz
      AND COALESCE(w.time_spent_seconds, 0) > 0
      AND ${worklogAuthorMatchSql('$3', '$4', 'w')}
      ${projectFilter}
    GROUP BY work_date
    `,
    params
  );

  const loggedByDate = new Map();
  for (const row of res.rows) {
    const dateStr = formatPgDate(row.work_date);
    if (dateStr) loggedByDate.set(dateStr, Number(row.logged_seconds) || 0);
  }
  return loggedByDate;
}

function buildDayLogTarget(date, loggedSeconds, baseHoursPerDay, otHours) {
  const ot = Number(otHours) || 0;
  const [y, m, d] = date.split('-').map(Number);
  const dayOfWeek = new Date(y, m - 1, d).getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const requiredHours = requiredHoursForDay(baseHoursPerDay, ot, isWeekend);
  const requiredSeconds = Math.round(requiredHours * 3600);
  const missingSeconds = Math.max(0, requiredSeconds - loggedSeconds);
  return {
    date,
    loggedSeconds,
    loggedHours: +(loggedSeconds / 3600).toFixed(2),
    otHours: ot,
    baseHoursPerDay: isWeekend ? 0 : baseHoursPerDay,
    requiredHours,
    requiredSeconds,
    missingSeconds,
    missingHours: +(missingSeconds / 3600).toFixed(2),
    minHoursPerDay: requiredHours,
  };
}

/**
 * Ngày làm việc trong tháng chưa log đủ — mục tiêu = 7h + OT cá nhân/ngày.
 */
async function fetchUnderLoggedDays(db, userId, year, month, minHoursPerDay = WORKING_HOURS_PER_DAY) {
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  if (!yearInt || !monthInt || monthInt < 1 || monthInt > 12) {
    throw new Error('year hoặc month không hợp lệ');
  }

  const baseHours = Number(minHoursPerDay) || WORKING_HOURS_PER_DAY;
  if (baseHours <= 0) throw new Error('minHours phải > 0');

  const workingDays = listWorkingDaysInMonthUpToToday(yearInt, monthInt);
  if (!workingDays.length) {
    return { year: yearInt, month: monthInt, baseHoursPerDay: baseHours, days: [] };
  }

  const [loggedByDate, otMap] = await Promise.all([
    loadMonthLoggedSecondsByDate(db, userId, yearInt, monthInt),
    fetchPersonalOtMap(db, userId, yearInt, monthInt),
  ]);

  const dateSet = new Set(workingDays);
  const monthPrefix = `${yearInt}-${String(monthInt).padStart(2, '0')}`;
  const todayYmd = todayYmdBangkok();
  for (const date of otMap.keys()) {
    if (!date.startsWith(`${monthPrefix}-`)) continue;
    const [y, mo, d] = date.split('-').map(Number);
    const ymd = y * 10000 + mo * 100 + d;
    if (ymd <= todayYmd) dateSet.add(date);
  }

  const days = [];
  for (const date of [...dateSet].sort()) {
    const loggedSeconds = loggedByDate.get(date) || 0;
    const otHours = otMap.get(date) || 0;
    const row = buildDayLogTarget(date, loggedSeconds, baseHours, otHours);
    if (row.loggedSeconds >= row.requiredSeconds) continue;
    days.push(row);
  }

  days.sort((a, b) => b.date.localeCompare(a.date));

  return {
    year: yearInt,
    month: monthInt,
    baseHoursPerDay: baseHours,
    minHoursPerDay: baseHours,
    days,
  };
}

/** Tổng quan OT + log theo ngày làm việc trong tháng (để nhập OT). */
async function fetchPersonalOtMonthDays(db, userId, year, month, minHoursPerDay = WORKING_HOURS_PER_DAY) {
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  if (!yearInt || !monthInt || monthInt < 1 || monthInt > 12) {
    throw new Error('year hoặc month không hợp lệ');
  }

  const baseHours = Number(minHoursPerDay) || WORKING_HOURS_PER_DAY;
  const [loggedByDate, otMap] = await Promise.all([
    loadMonthLoggedSecondsByDate(db, userId, yearInt, monthInt),
    fetchPersonalOtMap(db, userId, yearInt, monthInt),
  ]);

  const monthPrefix = `${yearInt}-${String(monthInt).padStart(2, '0')}`;
  const dates = [...otMap.keys()]
    .filter(date => date.startsWith(`${monthPrefix}-`))
    .sort((a, b) => b.localeCompare(a));

  const days = dates.map(date => {
    const loggedSeconds = loggedByDate.get(date) || 0;
    const otHours = otMap.get(date) || 0;
    return buildDayLogTarget(date, loggedSeconds, baseHours, otHours);
  });

  return {
    year: yearInt,
    month: monthInt,
    baseHoursPerDay: baseHours,
    days,
  };
}

module.exports = {
  fetchAutoLogworkCandidates,
  fetchIssueForAutoLogwork,
  searchIssuesForAutoLogwork,
  fetchUnderLoggedDays,
  fetchPersonalOtMonthDays,
  parseDateYmd,
};
