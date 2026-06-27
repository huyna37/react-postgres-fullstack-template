/** Danh sách menu/tab — dùng chung Sidebar, AppAccounts, routing */
export const APP_MENUS = [
  { key: 'dashboard', label: 'Dashboard Tháng' },
  { key: 'tester-tasks', label: 'Công việc team' },
  { key: 'logwork-history', label: 'Lịch sử Logwork' },
  { key: 'auto-logwork', label: 'Logwork tự động' },
  { key: 'personal-ot', label: 'Giờ OT cá nhân' },
  { key: 'overdue-tasks', label: 'Công việc quá hạn' },
  { key: 'planning', label: 'Lên kế hoạch' },
  { key: 'missing-estimates', label: 'Thiếu Estimate' },
  { key: 'epics', label: 'Quản lý Epic' },
  { key: 'reports', label: 'Báo cáo thống kê' },
  { key: 'projects', label: 'Cấu hình Dự án' },
  { key: 'skills', label: 'Quản lý Skill AI', adminOnly: true },
  { key: 'app-users', label: 'Quản trị Hệ thống', adminOnly: true },
  { key: 'online-monitor', label: 'Ai đang online', adminOnly: true },
  { key: 'config', label: 'Cấu hình cá nhân' },
] as const;

export const VALID_TAB_KEYS = APP_MENUS.map(m => m.key);

export const DEFAULT_PUBLIC_PAGES = ['dashboard', 'tester-tasks'];
