const { ymdInWorkTz } = require('./jiraMonthFilter');

/** Vietnam public holidays by year (Tet lunar calendar dates) */
function getVietnamHolidays(year) {
  const tetDates = {
    2025: ['2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04'],
    2026: ['2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23'],
    2027: ['2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12'],
  };
  const holidays = [`${year}-04-30`, `${year}-05-01`, `${year}-09-02`];
  if (tetDates[year]) holidays.push(...tetDates[year]);
  return holidays;
}

function ymdToDateString(ymd) {
  const y = Math.floor(ymd / 10000);
  const mo = Math.floor((ymd % 10000) / 100);
  const d = ymd % 100;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayYmdBangkok(now = new Date()) {
  return ymdInWorkTz(now);
}

/** Working days in month up to today (Bangkok), Mon–Fri excl. holidays */
function listWorkingDaysInMonthUpToToday(year, month, now = new Date()) {
  const todayYmd = todayYmdBangkok(now);
  const daysInMonth = new Date(year, month, 0).getDate();
  const holidays = getVietnamHolidays(year);
  const result = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = year * 10000 + month * 100 + d;
    if (ymd > todayYmd) break;

    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    const dateStr = ymdToDateString(ymd);
    if (dow >= 1 && dow <= 5 && !holidays.includes(dateStr)) {
      result.push(dateStr);
    }
  }

  return result;
}

function isWorkingDayYmd(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  const dow = date.getDay();
  if (dow < 1 || dow > 5) return false;
  return !getVietnamHolidays(y).includes(`${m[1]}-${m[2]}-${m[3]}`);
}

const WORKING_HOURS_PER_DAY = 7;

module.exports = {
  getVietnamHolidays,
  listWorkingDaysInMonthUpToToday,
  isWorkingDayYmd,
  todayYmdBangkok,
  ymdToDateString,
  WORKING_HOURS_PER_DAY,
};
