import { WORKING_HOURS_PER_DAY } from './workingDays';

export type DayLogTarget = {
  date: string;
  loggedHours: number;
  missingHours: number;
  otHours: number;
  baseHoursPerDay: number;
  requiredHours: number;
  minHoursPerDay: number;
};

export function formatDayLabel(dateYmd: string): string {
  const [y, mo, d] = dateYmd.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  const weekday = dt.toLocaleDateString('vi-VN', { weekday: 'short' });
  return `${d}/${mo} (${weekday})`;
}

export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function currentMonthYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function defaultDateForMonth(month: string): string {
  const today = todayYmd();
  if (today.startsWith(month)) return today;
  const [y, mo] = month.split('-').map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  return `${y}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

export { WORKING_HOURS_PER_DAY };

export function isWeekendYmd(dateYmd: string): boolean {
  const [y, m, d] = dateYmd.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

/** Khớp server `personalOtFromDb.requiredHoursForDay` */
export function requiredHoursForDay(
  baseHoursPerDay: number,
  otHours: number,
  isWeekend: boolean
): number {
  const ot = Number(otHours) || 0;
  if (isWeekend) return +ot.toFixed(2);
  const base = Number(baseHoursPerDay) || 0;
  return +(base + ot).toFixed(2);
}

export type DayLogStatus = {
  otHours: number;
  baseHoursPerDay: number;
  requiredHours: number;
  missingHours: number;
  missingSeconds: number;
  isShort: boolean;
  isMet: boolean;
};

export function computeDayLogStatus(
  dateYmd: string,
  loggedSeconds: number,
  otHours = 0,
  baseHoursPerDay = WORKING_HOURS_PER_DAY
): DayLogStatus {
  const isWeekend = isWeekendYmd(dateYmd);
  const ot = Number(otHours) || 0;
  const requiredHours = requiredHoursForDay(baseHoursPerDay, ot, isWeekend);
  const requiredSeconds = Math.round(requiredHours * 3600);
  const missingSeconds = Math.max(0, requiredSeconds - loggedSeconds);
  return {
    otHours: ot,
    baseHoursPerDay: isWeekend ? 0 : baseHoursPerDay,
    requiredHours,
    missingHours: +(missingSeconds / 3600).toFixed(1),
    missingSeconds,
    isShort: missingSeconds > 0 && requiredSeconds > 0,
    isMet: requiredSeconds === 0 || loggedSeconds >= requiredSeconds,
  };
}

export function formatRequiredHoursTitle(status: Pick<DayLogStatus, 'baseHoursPerDay' | 'otHours' | 'requiredHours'>): string {
  const { baseHoursPerDay, otHours, requiredHours } = status;
  if (otHours > 0 && baseHoursPerDay > 0) {
    return `Mục tiêu ${requiredHours}h (${baseHoursPerDay}h + ${otHours}h OT)`;
  }
  if (otHours > 0 && baseHoursPerDay === 0) {
    return `Mục tiêu ${requiredHours}h (OT cuối tuần)`;
  }
  return `Mục tiêu ${requiredHours}h`;
}
