/** Khớp server/lib/jiraMonthFilter.js — Asia/Bangkok */
export const WORK_TZ = "Asia/Bangkok";

export function planDateToYmd(value: string | null | undefined): number | null {
	if (!value) return null;
	const s = String(value);
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return null;
	return ymdInTimeZone(d, WORK_TZ);
}

export function ymdInTimeZone(d: Date, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(d);
	const y = Number(parts.find((p) => p.type === "year")?.value);
	const mo = Number(parts.find((p) => p.type === "month")?.value);
	const day = Number(parts.find((p) => p.type === "day")?.value);
	if (!y || !mo || !day) return 0;
	return y * 10000 + mo * 100 + day;
}

export function currentWeekYmdRangeBangkok(now = new Date()): {
	start: number;
	end: number;
} {
	const today = ymdInTimeZone(now, WORK_TZ);
	const y = Math.floor(today / 10000);
	const mo = Math.floor((today % 10000) / 100);
	const day = today % 100;
	const weekday = new Intl.DateTimeFormat("en-US", {
		timeZone: WORK_TZ,
		weekday: "short",
	}).format(now);
	const dowMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	const dow = dowMap[weekday] ?? 0;
	const daysFromMon = dow === 0 ? 6 : dow - 1;
	const mondayUtc = new Date(Date.UTC(y, mo - 1, day - daysFromMon));
	const sundayUtc = new Date(Date.UTC(y, mo - 1, day - daysFromMon + 6));
	return {
		start: ymdInTimeZone(mondayUtc, WORK_TZ),
		end: ymdInTimeZone(sundayUtc, WORK_TZ),
	};
}

export function isPlanDateInWeek(
	value: string | null | undefined,
	week: { start: number; end: number },
): boolean {
	const ymd = planDateToYmd(value);
	if (ymd == null) return false;
	return ymd >= week.start && ymd <= week.end;
}
