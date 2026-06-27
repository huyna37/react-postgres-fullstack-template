import {
  AlertCircle,
  Bell,
  BellOff,
  CalendarDays,
  Check,
  CheckSquare,
  Clock,
  FolderGit2,
  LayoutDashboard,
  LogIn,
  LogOut,
  Radio,
  Scale,
  ShieldCheck,
  BarChart3,
} from 'lucide-react';
import React from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../types';
import AppBrand from './AppBrand';
import ThemeToggle from './ThemeToggle';

interface SidebarProps {
  activeTab: string;
  currentUser: User | null;
  authToken: string;
  handleLogout: () => void;
  publicPages: string[];
  notifySupported?: boolean;
  notifyEnabled?: boolean;
  notifyPermission?: NotificationPermission | 'unsupported';
  onRequestNotifyPermission?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  currentUser,
  authToken,
  handleLogout,
  publicPages,
  notifySupported,
  notifyEnabled,
  notifyPermission,
  onRequestNotifyPermission,
}) => {
  const allAvailableMenus = [
    { key: 'dashboard', label: 'Dashboard Tháng', icon: <LayoutDashboard size={18} /> },
    { key: 'tester-tasks', label: 'Công việc team', icon: <CheckSquare size={18} /> },
    { key: 'logwork-history', label: 'Lịch sử Logwork', icon: <CalendarDays size={18} /> },
    { key: 'auto-logwork', label: 'Logwork tự động', icon: <Scale size={18} /> },
    { key: 'personal-ot', label: 'Giờ OT cá nhân', icon: <Clock size={18} /> },
    { key: 'overdue-tasks', label: 'Công việc quá hạn', icon: <AlertCircle size={18} /> },
    { key: 'planning', label: 'Lên kế hoạch', icon: <CalendarDays size={18} /> },
    { key: 'missing-estimates', label: 'Thiếu Estimate', icon: <AlertCircle size={18} /> },
    { key: 'epics', label: 'Quản lý Epic', icon: <FolderGit2 size={18} /> },
    { key: 'reports', label: 'Báo cáo thống kê', icon: <BarChart3 size={18} /> },
    // { key: 'projects', label: 'Cấu hình Dự án', icon: <FolderGit2 size={18} /> },
    // { key: 'skills', label: 'Quản lý Skill AI', icon: <ScrollText size={18} />, adminOnly: true },
    {
      key: 'app-users',
      label: 'Quản trị Hệ thống',
      icon: <ShieldCheck size={18} />,
      adminOnly: true,
    },
    { key: 'online-monitor', label: 'Ai đang online', icon: <Radio size={18} />, adminOnly: true },
    { key: 'config', label: 'Cấu hình cá nhân', icon: <Check size={18} /> },
  ];

  const filteredMenus = allAvailableMenus.filter(menu => {
    const isAdmin = currentUser?.role === 'admin';
    const isPublicTab = publicPages.includes(menu.key);
    return isAdmin || isPublicTab || currentUser?.permissions?.includes(menu.key);
  });

  return (
    <aside className="sidenav">
      <div className="sidenav-header">
        <AppBrand variant="sidebar" asLink={!!authToken} />
      </div>
      <nav className="sidenav-menu">
        {filteredMenus.map(menu => (
          <Link
            key={menu.key}
            to={`/${menu.key}`}
            className={`tab-btn ${activeTab === menu.key ? 'active' : ''}`}
          >
            {menu.icon} {menu.label}
          </Link>
        ))}
      </nav>

      <div
        style={{
          marginTop: 'auto',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border-color)',
        }}
      >
        <ThemeToggle variant="compact" />
        {authToken ? (
          <>
            <div
              className="sidenav-user"
              style={{
                padding: '0 1.2rem',
                marginBottom: '1rem',
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
              }}
            >
              Logged in as <strong>{currentUser?.username}</strong>
              <span
                style={{
                  display: 'block',
                  fontSize: '0.7rem',
                  marginTop: '4px',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                }}
              >
                {currentUser?.role}
              </span>
            </div>
            {notifySupported && onRequestNotifyPermission && (
              <button
                type="button"
                className="tab-btn"
                onClick={onRequestNotifyPermission}
                style={{
                  color: notifyEnabled ? '#34d399' : '#fbbf24',
                  marginBottom: '0.25rem',
                }}
                title={
                  notifyEnabled
                    ? 'Thông báo desktop đã bật — click để thử'
                    : notifyPermission === 'denied'
                      ? 'Thông báo bị chặn — bật lại trong cài đặt trình duyệt'
                      : 'Bật thông báo desktop: task, bug commit & thông báo hệ thống'
                }
              >
                {notifyEnabled ? <Bell size={18} /> : <BellOff size={18} />}
                {notifyEnabled ? 'Thông báo đã bật' : 'Bật thông báo task'}
              </button>
            )}
            <button className="tab-btn" onClick={handleLogout} style={{ color: '#ef4444' }}>
              <LogOut size={18} /> Đăng xuất
            </button>
          </>
        ) : (
          <Link className="tab-btn" to="/login" style={{ color: '#4ade80' }}>
            <LogIn size={18} /> Đăng nhập
          </Link>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
