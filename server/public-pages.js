/** Các route (tab key) có thể bật xem không cần đăng nhập. 'login' luôn công khai. */
const VALID_PAGE_KEYS = [
  'dashboard',
  'create',
  'logwork-history',
  'auto-logwork',
  'tester-tasks',
  'overdue-tasks',
  'planning',
  'epics',
  'projects',
  'skills',
  'app-users',
  'online-monitor',
  'config',
  'personal-ot',
];

const DEFAULT_PUBLIC_PAGES = ['dashboard', 'tester-tasks'];

const normalizePublicPages = (value) => {
  if (!Array.isArray(value)) return [...DEFAULT_PUBLIC_PAGES];
  const seen = new Set();
  const out = [];
  for (const key of value) {
    if (typeof key !== 'string') continue;
    const k = key.trim();
    if (!VALID_PAGE_KEYS.includes(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
};

module.exports = {
  VALID_PAGE_KEYS,
  DEFAULT_PUBLIC_PAGES,
  normalizePublicPages,
};
