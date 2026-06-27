/** Nhãn trang app — khớp client/src/constants/menus.ts */
const PAGE_LABELS = {
  dashboard: 'Dashboard Tháng',
  'logwork-history': 'Lịch sử Logwork',
  'tester-tasks': 'Công việc team',
  'overdue-tasks': 'Công việc quá hạn',
  planning: 'Lên kế hoạch',
  'missing-estimates': 'Thiếu Estimate',
  epics: 'Quản lý Epic',
  projects: 'Cấu hình Dự án',
  skills: 'Quản lý Skill AI',
  'app-users': 'Quản trị Hệ thống',
  'online-monitor': 'Ai đang online',
  config: 'Cấu hình cá nhân',
  login: 'Đăng nhập',
};

function normalizePageKey(pageKey) {
  if (!pageKey || typeof pageKey !== 'string') return null;
  const key = pageKey.trim();
  return key || null;
}

function isKnownPageKey(pageKey) {
  const key = normalizePageKey(pageKey);
  return !!key && Object.prototype.hasOwnProperty.call(PAGE_LABELS, key);
}

function getPageLabel(pageKey) {
  const key = normalizePageKey(pageKey);
  if (!key) return '—';
  return PAGE_LABELS[key] || key;
}

module.exports = { PAGE_LABELS, getPageLabel, isKnownPageKey, normalizePageKey };
