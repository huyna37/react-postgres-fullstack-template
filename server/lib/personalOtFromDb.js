function parseDateYmd(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function otSettingsKey(userId) {
  return `user_personal_ot:${userId}`;
}

/** OT theo ngày (YYYY-MM-DD → giờ). */
async function fetchPersonalOtMap(db, userId, year, month) {
  const res = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [
    otSettingsKey(userId),
  ]);
  if (!res.rows.length) return new Map();

  const raw = res.rows[0].value;
  const byMonth = raw && typeof raw === 'object' ? raw : {};
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const days = byMonth[monthKey];
  if (!days || typeof days !== 'object') return new Map();

  const map = new Map();
  for (const [date, hours] of Object.entries(days)) {
    const n = Number(hours);
    if (parseDateYmd(date) && Number.isFinite(n) && n > 0) {
      map.set(date, +n.toFixed(2));
    }
  }
  return map;
}

async function savePersonalOtForDate(db, userId, dateYmd, otHours) {
  const date = parseDateYmd(dateYmd);
  if (!date) throw new Error('date phải dạng YYYY-MM-DD');

  const hours = Number(otHours);
  if (!Number.isFinite(hours) || hours < 0) throw new Error('otHours phải >= 0');
  if (hours > 24) throw new Error('otHours tối đa 24h');

  const [year, month] = date.split('-').map(Number);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const key = otSettingsKey(userId);

  const res = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  const existing = res.rows[0]?.value && typeof res.rows[0].value === 'object' ? res.rows[0].value : {};
  const monthDays = { ...(existing[monthKey] || {}) };

  if (hours <= 0) {
    delete monthDays[date];
  } else {
    monthDays[date] = +hours.toFixed(2);
  }

  const next = { ...existing, [monthKey]: monthDays };
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
    [key, JSON.stringify(next)]
  );

  return { date, otHours: hours <= 0 ? 0 : +hours.toFixed(2) };
}

function requiredHoursForDay(baseHoursPerDay, otHours, isWeekend) {
  const ot = Number(otHours) || 0;
  if (isWeekend) {
    return +ot.toFixed(2);
  }
  const base = Number(baseHoursPerDay) || 0;
  return +(base + ot).toFixed(2);
}

module.exports = {
  fetchPersonalOtMap,
  savePersonalOtForDate,
  requiredHoursForDay,
};
