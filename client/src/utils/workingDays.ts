import { currentWeekYmdRangeBangkok } from './planDates';

/** Vietnam public holidays by year (Tet lunar calendar dates) */
export function getVietnamHolidays(year: number): string[] {
  const tetDates: Record<number, string[]> = {
    2025: ['2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04'],
    2026: ['2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23'],
    2027: ['2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12'],
  };
  const holidays: string[] = [`${year}-04-30`, `${year}-05-01`, `${year}-09-02`];
  if (tetDates[year]) holidays.push(...tetDates[year]);
  return holidays;
}

/** Count working days (Mon–Fri, excl. Vietnam holidays) in a given month/year */
export function countWorkingDays(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  const holidays = getVietnamHolidays(year);
  let count = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (dow >= 1 && dow <= 5 && !holidays.includes(dateStr)) count++;
  }
  return count;
}

function addDaysToYmd(ymd: number, days: number): number {
  const y = Math.floor(ymd / 10000);
  const mo = Math.floor((ymd % 10000) / 100);
  const d = ymd % 100;
  const date = new Date(y, mo - 1, d);
  date.setDate(date.getDate() + days);
  return (
    date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()
  );
}

/** Working days between two YMD dates (inclusive), Mon–Fri excl. holidays */
export function countWorkingDaysInRange(startYmd: number, endYmd: number): number {
  const holidaysByYear = new Map<number, string[]>();
  let count = 0;

  for (let cur = startYmd; cur <= endYmd; cur = addDaysToYmd(cur, 1)) {
    const y = Math.floor(cur / 10000);
    const mo = Math.floor((cur % 10000) / 100);
    const day = cur % 100;
    const date = new Date(y, mo - 1, day);
    const dow = date.getDay();
    if (dow < 1 || dow > 5) continue;

    if (!holidaysByYear.has(y)) holidaysByYear.set(y, getVietnamHolidays(y));
    const dateStr = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!holidaysByYear.get(y)!.includes(dateStr)) count++;
  }

  return count;
}

/** Working days in calendar week (Mon–Sun, Asia/Bangkok) */
export function countWorkingDaysInWeek(
  week = currentWeekYmdRangeBangkok()
): number {
  return countWorkingDaysInRange(week.start, week.end);
}

export const WORKING_HOURS_PER_DAY = 7;

export function requiredHoursForWorkingDays(days: number): number {
  return days * WORKING_HOURS_PER_DAY;
}
