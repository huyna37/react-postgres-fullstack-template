/** Múi giờ làm việc — khớp Jira (Asia/Bangkok) khi lọc theo tháng */
const WORK_TZ = 'Asia/Bangkok';

/** Cột timestamptz → thời điểm theo WORK_TZ (dùng trong EXTRACT) */
function colInWorkTz(column) {
  return `(${column} AT TIME ZONE '${WORK_TZ}')`;
}

/**
 * Điều kiện SQL: issue thuộc tháng/năm (start, due, updated, created).
 * Tham số: $yearParam, $monthParam (vd. $2, $3), prefix bảng tùy chọn.
 */
function monthMatchWhere(yearParam, monthParam, tablePrefix = '') {
  const p = tablePrefix ? `${tablePrefix}.` : '';
  const ud = colInWorkTz(`${p}updated_at`);
  const cd = colInWorkTz(`${p}created_at`);
  return `(
    (EXTRACT(YEAR FROM ${p}start_date) = ${yearParam} AND EXTRACT(MONTH FROM ${p}start_date) = ${monthParam}) OR
    (EXTRACT(YEAR FROM ${p}due_date) = ${yearParam} AND EXTRACT(MONTH FROM ${p}due_date) = ${monthParam}) OR
    (EXTRACT(YEAR FROM ${ud}) = ${yearParam} AND EXTRACT(MONTH FROM ${ud}) = ${monthParam}) OR
    (EXTRACT(YEAR FROM ${cd}) = ${yearParam} AND EXTRACT(MONTH FROM ${cd}) = ${monthParam})
  )`;
}

/** Parse ngày issue (ISO / Jira) → { year, month } theo WORK_TZ */
function yearMonthInWorkTz(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: WORK_TZ,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(d);
  const year = Number(parts.find(p => p.type === 'year')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value);
  if (!year || !month) return null;
  return { year, month };
}

/** Khớp logic SQL monthMatchWhere — ít nhất một trong start/due/updated/created thuộc tháng */
function issueMatchesMonth(issue, yearInt, monthInt) {
  if (!issue) return false;
  const fields = [issue.startDate, issue.dueDate, issue.updated, issue.created];
  for (const val of fields) {
    const ym = yearMonthInWorkTz(val);
    if (ym && ym.year === yearInt && ym.month === monthInt) return true;
  }
  return false;
}

/** Dashboard: chỉ start/due/created — sync updated_at không làm nhảy số tháng */
function issueMatchesMonthPlanDatesOnly(issue, yearInt, monthInt) {
  if (!issue) return false;
  for (const val of [issue.startDate, issue.dueDate, issue.created]) {
    const ym = yearMonthInWorkTz(val);
    if (ym && ym.year === yearInt && ym.month === monthInt) return true;
  }
  return false;
}

/**
 * Chỉ start/due/created — dùng cho Tester Tasks để sync updated_at không đẩy ticket vào/ra tháng.
 * @deprecated Dùng monthPlanDateFilterClause + monthPlanDateFilterParams (range, index-friendly).
 */
function monthMatchWherePlanDatesOnly(yearParam, monthParam, tablePrefix = '') {
  const p = tablePrefix ? `${tablePrefix}.` : '';
  const cd = colInWorkTz(`${p}created_at`);
  return `(
    (EXTRACT(YEAR FROM ${p}start_date) = ${yearParam} AND EXTRACT(MONTH FROM ${p}start_date) = ${monthParam}) OR
    (EXTRACT(YEAR FROM ${p}due_date) = ${yearParam} AND EXTRACT(MONTH FROM ${p}due_date) = ${monthParam}) OR
    (EXTRACT(YEAR FROM ${cd}) = ${yearParam} AND EXTRACT(MONTH FROM ${cd}) = ${monthParam})
  )`;
}

/** Biên tháng theo Asia/Bangkok — dùng cho so sánh DATE / timestamptz (không EXTRACT). */
function planMonthBoundsForSql(yearInt, monthInt) {
  const y = Number(yearInt);
  const m = Number(monthInt);
  if (!y || !m || m < 1 || m > 12) return null;
  const monthStartDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const monthEndExclusiveDate = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
  return {
    monthStartDate,
    monthEndExclusiveDate,
    monthStartTz: `${monthStartDate}T00:00:00+07:00`,
    monthEndExclusiveTz: `${monthEndExclusiveDate}T00:00:00+07:00`,
  };
}

/** 4 bind params: monthStartDate, monthEndExclusiveDate, monthStartTz, monthEndExclusiveTz */
function monthPlanDateFilterParams(yearInt, monthInt) {
  const b = planMonthBoundsForSql(yearInt, monthInt);
  if (!b) return [];
  return [b.monthStartDate, b.monthEndExclusiveDate, b.monthStartTz, b.monthEndExclusiveTz];
}

/** paramStart = index SQL $1-based cho monthStartDate (tiếp theo +1,+2,+3). */
function monthPlanDateFilterClause(tablePrefix = '', paramStart = 2) {
  const p = tablePrefix ? `${tablePrefix}.` : '';
  const d0 = `$${paramStart}`;
  const d1 = `$${paramStart + 1}`;
  const t0 = `$${paramStart + 2}`;
  const t1 = `$${paramStart + 3}`;
  return `(
    (${p}start_date >= ${d0}::date AND ${p}start_date < ${d1}::date) OR
    (${p}due_date >= ${d0}::date AND ${p}due_date < ${d1}::date) OR
    (${p}created_at >= ${t0}::timestamptz AND ${p}created_at < ${t1}::timestamptz)
  )`;
}

/** DATE / string từ Postgres → YYYY-MM-DD theo lịch Asia/Bangkok */
function formatPlanDateFromDb(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'string') {
    const m = val.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = val instanceof Date ? val : new Date(val);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value;
  const mo = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  return y && mo && day ? `${y}-${mo}-${day}` : null;
}

/** Ghi cột DATE — luôn trả 'YYYY-MM-DD', không dùng Date object (tránh lệch UTC). */
function normalizePlanDateForStorage(val) {
  return formatPlanDateFromDb(val);
}

function planDateToYmd(value) {
  const s = formatPlanDateFromDb(value);
  if (!s) return null;
  const [y, mo, d] = s.split('-').map(Number);
  return y * 10000 + mo * 100 + d;
}

function ymdInWorkTz(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const mo = Number(parts.find(p => p.type === 'month')?.value);
  const day = Number(parts.find(p => p.type === 'day')?.value);
  if (!y || !mo || !day) return 0;
  return y * 10000 + mo * 100 + day;
}

function getCurrentWeekYmdRangeBangkok(now = new Date()) {
  const today = ymdInWorkTz(now);
  const y = Math.floor(today / 10000);
  const mo = Math.floor((today % 10000) / 100);
  const day = today % 100;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: WORK_TZ, weekday: 'short' }).format(
    now
  );
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[weekday] ?? 0;
  const daysFromMon = dow === 0 ? 6 : dow - 1;
  const mondayUtc = new Date(Date.UTC(y, mo - 1, day - daysFromMon));
  const sundayUtc = new Date(Date.UTC(y, mo - 1, day - daysFromMon + 6));
  return { start: ymdInWorkTz(mondayUtc), end: ymdInWorkTz(sundayUtc) };
}

function planDateInWeek(value, week) {
  const ymd = planDateToYmd(value);
  if (ymd == null) return false;
  return ymd >= week.start && ymd <= week.end;
}

function sumWorklogSecondsInWeek(issue, week) {
  const wls = issue?.worklog?.worklogs || [];
  let sum = 0;
  for (const wl of wls) {
    if (planDateInWeek(wl.started, week)) {
      sum += wl.timeSpentSeconds || 0;
    }
  }
  return sum;
}

/** Định dạng datetime cho JQL (Asia/Bangkok), vd. "2026-06-01 14:30" — một dòng, không xuống dòng. */
function formatJiraJqlDateTime(date, timeZone = WORK_TZ) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const local = d.toLocaleString('sv-SE', { timeZone });
  return local.slice(0, 16);
}

/**
 * JQL delta: updated hoặc created sau mốc (overlap ở cron) — tránh sót ticket mới.
 */
function buildDeltaJql(projectKey, sinceDate) {
  const since = formatJiraJqlDateTime(sinceDate);
  const key = String(projectKey).trim();
  return `project = ${key} AND (updated >= "${since}" OR created >= "${since}") ORDER BY updated DESC`;
}

/** Đầu/cuối tháng lịch (YYYY-MM-DD) — dùng JQL cf[10300]/cf[10302], updated, created */
function monthRangeYmd(yearInt, monthInt) {
  const startDate = `${yearInt}-${String(monthInt).padStart(2, '0')}-01`;
  const lastDay = new Date(yearInt, monthInt, 0).getDate();
  const endDate = `${yearInt}-${String(monthInt).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}

/** JQL: mọi loại issue trong project, khớp monthMatchWhere (start/due/updated/created). */
function buildMonthJql(projectKey, yearInt, monthInt) {
  const { startDate, endDate } = monthRangeYmd(yearInt, monthInt);
  return `project = ${projectKey} AND (
    (cf[10300] >= "${startDate}" AND cf[10300] <= "${endDate}") OR
    (cf[10302] >= "${startDate}" AND cf[10302] <= "${endDate}") OR
    (updated >= "${startDate}" AND updated <= "${endDate} 23:59") OR
    (created >= "${startDate}" AND created <= "${endDate} 23:59")
  ) ORDER BY updated DESC`;
}

function currentMonthInWorkTz(now = new Date()) {
  const ym = yearMonthInWorkTz(now.toISOString());
  if (ym) return ym;
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function computeWeekStats(issues) {
  const week = getCurrentWeekYmdRangeBangkok();
  const keys = new Set();
  let weeklyLogSeconds = 0;
  for (const issue of issues || []) {
    if (!issue?.key) continue;
    const inWeek = planDateInWeek(issue.startDate, week) || planDateInWeek(issue.dueDate, week);
    if (!inWeek) continue;
    keys.add(issue.key);
    weeklyLogSeconds += sumWorklogSecondsInWeek(issue, week);
  }
  return { weeklyCount: keys.size, weeklyLogSeconds };
}

/** Tổng tuần từ ticket các user dashboard (timeSpentWeek theo assignee). */
function computeWeekStatsFromDashboardTickets(dashboardGroups, week = getCurrentWeekYmdRangeBangkok()) {
  const weeklyByKey = new Map();
  let weeklyLogSeconds = 0;
  let weeklyEstimateSeconds = 0;
  for (const group of dashboardGroups || []) {
    for (const t of group.tickets || []) {
      if (!t?.key) continue;
      const inWeek =
        planDateInWeek(t.startDate, week) || planDateInWeek(t.dueDate, week);
      if (!inWeek || weeklyByKey.has(t.key)) continue;
      weeklyByKey.set(t.key, t);
      weeklyLogSeconds += t.timeSpentWeek || 0;
      weeklyEstimateSeconds += t.originalEstimate || 0;
    }
  }
  return {
    weeklyCount: weeklyByKey.size,
    weeklyLogSeconds,
    weeklyEstimateSeconds,
  };
}

module.exports = {
  WORK_TZ,
  colInWorkTz,
  monthMatchWhere,
  monthMatchWherePlanDatesOnly,
  planMonthBoundsForSql,
  monthPlanDateFilterParams,
  monthPlanDateFilterClause,
  yearMonthInWorkTz,
  issueMatchesMonth,
  issueMatchesMonthPlanDatesOnly,
  formatPlanDateFromDb,
  normalizePlanDateForStorage,
  planDateToYmd,
  ymdInWorkTz,
  getCurrentWeekYmdRangeBangkok,
  planDateInWeek,
  sumWorklogSecondsInWeek,
  computeWeekStats,
  computeWeekStatsFromDashboardTickets,
  monthRangeYmd,
  buildMonthJql,
  currentMonthInWorkTz,
  formatJiraJqlDateTime,
  buildDeltaJql,
};
