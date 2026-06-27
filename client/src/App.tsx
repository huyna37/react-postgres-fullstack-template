import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import './App.css';

// Types
import type { User } from './types';

// Components
import CommonModal from './components/CommonModal';
import LoginForm from './components/LoginForm';
import Sidebar from './components/Sidebar';

// Pages
import { Bell } from 'lucide-react';
import JiraTokenPromptModal from './components/JiraTokenPromptModal';
import { DEFAULT_PUBLIC_PAGES, VALID_TAB_KEYS } from './constants/menus';
import { notifyDefaultThemeChanged } from './context/ThemeContext';
import { useJiraTokenPrompt } from './hooks/useJiraTokenPrompt';
import { useReadyTaskNotifications } from './hooks/useReadyTaskNotifications';
import AppAccounts from './pages/AppAccounts';
import AutoLogwork from './pages/AutoLogwork';
import Config from './pages/Config';
import Dashboard from './pages/Dashboard';
import EpicManagement from './pages/EpicManagement';
import LogworkHistory from './pages/LogworkHistory';
import MissingEstimates from './pages/MissingEstimates';
import OnlineMonitor from './pages/OnlineMonitor';
import OverdueTasks from './pages/OverdueTasks';
import PersonalOt from './pages/PersonalOt';
import Planning from './pages/Planning';
import Projects from './pages/Projects';
import Reports from './pages/Reports';
import Skills from './pages/Skills';
import TesterTasks from './pages/TesterTasks';
import { showError } from './utils/swal';

function App() {
  const API_BASE_URL =
    import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:5000');

  // Auth States
  const [authToken, setAuthToken] = useState(localStorage.getItem('token') || '');
  const [currentUser, setCurrentUser] = useState<User | null>(
    JSON.parse(localStorage.getItem('user') || 'null')
  );

  const [activeTab, setActiveTab] = useState('dashboard');
  const [projectUsers, setProjectUsers] = useState<any[]>([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [publicPages, setPublicPages] = useState<string[]>(DEFAULT_PUBLIC_PAGES);

  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setAuthToken('');
    setCurrentUser(null);
    navigate('/dashboard');
  }, [navigate]);

  const apiFetch = useCallback(
    async (url: string, options: any = {}) => {
      const token = localStorage.getItem('token');
      const headers = { ...options.headers };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(url, { ...options, headers });
      if ((response.status === 401 || response.status === 403) && token) {
        handleLogout();
      }
      return response;
    },
    [handleLogout]
  );

  const openJiraTicket = useCallback(
    (key: string) => {
      const trimmed = String(key || '').trim();
      if (!trimmed) return;
      const base = String(jiraBaseUrl || '')
        .trim()
        .replace(/\/$/, '');
      if (!base) {
        showError('Chưa cấu hình URL Jira trên server (biến JIRA_URL).');
        return;
      }
      window.open(`${base}/browse/${encodeURIComponent(trimmed)}`, '_blank', 'noopener,noreferrer');
    },
    [jiraBaseUrl]
  );

  const readyTaskNotifications = useReadyTaskNotifications(
    apiFetch,
    API_BASE_URL,
    !!authToken,
    activeTab
  );
  const jiraTokenPrompt = useJiraTokenPrompt(
    apiFetch,
    API_BASE_URL,
    authToken,
    currentUser,
    setCurrentUser,
    activeTab
  );

  // Đồng bộ jira_token / jira_project từ DB (JWT có thể cũ sau khi lưu Cấu hình)
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/me`);
        if (!res.ok || cancelled) return;
        const user = await res.json();
        if (!cancelled && user?.id) {
          setCurrentUser(user);
          localStorage.setItem('user', JSON.stringify(user));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken, apiFetch, API_BASE_URL]);

  // Sync tab with URL
  useEffect(() => {
    const path = location.pathname.split('/')[1];
    const validTabs = ['login', ...VALID_TAB_KEYS];

    if (path === 'users') {
      navigate('/app-users', { replace: true });
      return;
    }

    if (path && validTabs.includes(path)) {
      const isAdmin = currentUser?.role === 'admin';
      const isPublicTab = path === 'login' || publicPages.includes(path);
      const hasPermission = isAdmin || isPublicTab || currentUser?.permissions?.includes(path);

      if (!hasPermission) {
        if (!authToken) {
          navigate('/login', { replace: true });
        } else {
          navigate('/dashboard', { replace: true });
        }
      } else {
        setActiveTab(path);
      }
    } else if (location.pathname === '/') {
      if (!authToken && !publicPages.includes('dashboard')) {
        navigate('/login', { replace: true });
      } else {
        navigate('/dashboard', { replace: true });
      }
    }
  }, [location.pathname, navigate, currentUser, publicPages, authToken]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/config`)
      .then(res => res.json())
      .then(data => {
        setJiraBaseUrl(data.jiraBaseUrl);
        if (Array.isArray(data.publicPages)) setPublicPages(data.publicPages);
        if (data.defaultTheme === 'light' || data.defaultTheme === 'dark') {
          notifyDefaultThemeChanged(data.defaultTheme);
        }
      })
      .catch(err => console.error('Failed to load config:', err));
  }, [API_BASE_URL]);

  useEffect(() => {
    if (!authToken) return;
    apiFetch(`${API_BASE_URL}/api/users/active`)
      .then(res => res.json())
      .then(data => setProjectUsers(data))
      .catch(err => console.error('Failed to fetch active users:', err));
  }, [authToken, API_BASE_URL]);

  const renderContent = () => {
    const isPublicTab = activeTab === 'login' || publicPages.includes(activeTab);
    if (!authToken && !isPublicTab) {
      return (
        <LoginForm
          API_BASE_URL={API_BASE_URL}
          setAuthToken={setAuthToken}
          setCurrentUser={setCurrentUser}
        />
      );
    }

    switch (activeTab) {
      case 'dashboard':
        return (
          <Dashboard
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
            isActive
          />
        );
      case 'logwork-history':
        return (
          <LogworkHistory
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
          />
        );
      case 'auto-logwork':
        return (
          <AutoLogwork
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
          />
        );
      case 'personal-ot':
        return <PersonalOt apiFetch={apiFetch} API_BASE_URL={API_BASE_URL} />;
      case 'app-users':
        return (
          <AppAccounts
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            currentUser={currentUser}
            publicPages={publicPages}
            onPublicPagesUpdated={setPublicPages}
          />
        );
      case 'config':
        return (
          <Config
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            currentUser={currentUser}
            setCurrentUser={setCurrentUser}
          />
        );
      case 'projects':
        return <Projects apiFetch={apiFetch} API_BASE_URL={API_BASE_URL} />;
      case 'skills':
        return <Skills apiFetch={apiFetch} API_BASE_URL={API_BASE_URL} />;
      case 'tester-tasks':
        return (
          <TesterTasks
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
            setCurrentUser={setCurrentUser}
          />
        );
      case 'overdue-tasks':
        return (
          <OverdueTasks
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
          />
        );
      case 'planning':
        return (
          <Planning
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
            projectUsers={projectUsers}
          />
        );
      case 'reports':
        return (
          <Reports
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            currentUser={currentUser}
          />
        );
      case 'epics':
        return (
          <EpicManagement
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
          />
        );
      case 'missing-estimates':
        return (
          <MissingEstimates
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
          />
        );
      case 'online-monitor':
        return (
          <OnlineMonitor
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            currentUser={currentUser}
          />
        );
      case 'login':
        return (
          <LoginForm
            API_BASE_URL={API_BASE_URL}
            setAuthToken={setAuthToken}
            setCurrentUser={setCurrentUser}
          />
        );
      default:
        return (
          <Dashboard
            apiFetch={apiFetch}
            API_BASE_URL={API_BASE_URL}
            openJiraTicket={openJiraTicket}
            currentUser={currentUser}
            isActive={activeTab === 'dashboard'}
          />
        );
    }
  };

  const isLoginLayout = activeTab === 'login';

  return (
    <div className={`app-container${isLoginLayout ? ' app-container--login' : ''}`}>
      {!isLoginLayout && (
        <Sidebar
          activeTab={activeTab}
          currentUser={currentUser}
          authToken={authToken}
          handleLogout={handleLogout}
          publicPages={publicPages}
          notifySupported={readyTaskNotifications.notifySupported}
          notifyEnabled={readyTaskNotifications.notifyEnabled}
          notifyPermission={readyTaskNotifications.notifyPermission}
          onRequestNotifyPermission={readyTaskNotifications.requestNotifyPermission}
        />
      )}
      <div
        className={
          isLoginLayout
            ? 'login-main'
            : `main-content${
                activeTab === 'dashboard'
                  ? ' main-content--dashboard-fit'
                  : activeTab === 'tester-tasks'
                    ? ' main-content--tester-fit'
                    : activeTab === 'personal-ot'
                      ? ' main-content--personal-ot-fit'
                      : ''
              }`
        }
      >
        {renderContent()}
      </div>

      <JiraTokenPromptModal
        open={jiraTokenPrompt.open}
        tokenDraft={jiraTokenPrompt.tokenDraft}
        saving={jiraTokenPrompt.saving}
        onTokenChange={jiraTokenPrompt.setTokenDraft}
        onSave={jiraTokenPrompt.saveToken}
        onLogout={handleLogout}
      />

      <CommonModal
        open={readyTaskNotifications.showNotifyPrompt}
        onClose={readyTaskNotifications.dismissNotifyPrompt}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Bell color="#fbbf24" size={22} /> Bật thông báo Desktop
          </span>
        }
        titleId="notify-permission-modal-title"
        styleContent={{ maxWidth: '420px' }}
      >
        <p
          style={{
            color: 'var(--text-secondary)',
            marginTop: 0,
            marginBottom: '1.25rem',
            fontSize: '0.88rem',
            lineHeight: 1.6,
          }}
        >
          Nhấn <strong style={{ color: 'var(--text-primary)' }}>Cho phép thông báo</strong> bên
          dưới. Trình duyệt sẽ hiện hộp thoại hệ thống — chọn{' '}
          <strong style={{ color: '#4ade80' }}>Allow</strong> để nhận alert task, bug commit và
          thông báo admin.
        </p>
        <div style={{ display: 'flex', gap: '0.65rem' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={readyTaskNotifications.dismissNotifyPrompt}
            style={{ flex: 1, marginTop: 0, padding: '10px' }}
          >
            Để sau
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={readyTaskNotifications.confirmNotifyPermission}
            style={{ flex: 1, marginTop: 0, padding: '10px' }}
          >
            Cho phép thông báo
          </button>
        </div>
      </CommonModal>
    </div>
  );
}

export default App;
