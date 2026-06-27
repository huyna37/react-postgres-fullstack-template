import {
  Bell,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  GitBranch,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sun,
  ToggleLeft,
  ToggleRight,
  Trash2,
  UserCircle,
  Users,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import CommonModal from '../components/CommonModal';
import { APP_MENUS } from '../constants/menus';
import { notifyDefaultThemeChanged, type ThemeMode } from '../context/ThemeContext';
import type { User } from '../types';
import { getAvatarUrl } from '../utils/avatar';
import { hasJiraToken, MISSING_JIRA_TOKEN_HINT } from '../utils/jiraToken';
import { showConfirm, showError, showSuccess } from '../utils/swal';

const TEAM_ROLE_OPTIONS = [
  { value: 'developer', label: 'Developer' },
  { value: 'tester', label: 'Tester' },
  { value: 'ba', label: 'BA' },
] as const;

interface AppAccountsProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  currentUser: User | null;
  publicPages: string[];
  onPublicPagesUpdated: (pages: string[]) => void;
}

const AppAccounts: React.FC<AppAccountsProps> = ({
  apiFetch,
  API_BASE_URL,
  currentUser,
  publicPages,
  onPublicPagesUpdated,
}) => {
  const [appAccounts, setAppAccounts] = useState<any[]>([]);
  const [loadingAppAccounts, setLoadingAppAccounts] = useState(false);
  const [newAccountUser, setNewAccountUser] = useState('');
  const [newAccountPass, setNewAccountPass] = useState('');
  const [newAccountRole, setNewAccountRole] = useState<'admin' | 'user'>('user');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isBroadcastModalOpen, setIsBroadcastModalOpen] = useState(false);
  const [creatingAccount, setCreatingAccount] = useState(false);

  const [isPermModalOpen, setIsPermModalOpen] = useState(false);
  const [editingAcc, setEditingAcc] = useState<any>(null);
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [savingPerms, setSavingPerms] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [isThemeModalOpen, setIsThemeModalOpen] = useState(false);
  const [isPublicPagesModalOpen, setIsPublicPagesModalOpen] = useState(false);
  const [isNotificationsModalOpen, setIsNotificationsModalOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [publicPageDraft, setPublicPageDraft] = useState<string[]>(publicPages);
  const [allowedNotificationTypes, setAllowedNotificationTypes] = useState<string[]>([
    'bug_commit',
    'subtask_resolved',
    'bug_assigned_open',
  ]);
  const [notificationProjects, setNotificationProjects] = useState('');
  const [forcingRefresh, setForcingRefresh] = useState(false);
  const [accountsPage, setAccountsPage] = useState(1);
  const [accountsPageSize, setAccountsPageSize] = useState(10);

  const [broadcastTitle, setBroadcastTitle] = useState('');
  const [broadcastBody, setBroadcastBody] = useState('');
  const [sendingBroadcast, setSendingBroadcast] = useState(false);
  const [broadcastHistory, setBroadcastHistory] = useState<any[]>([]);
  const [loadingBroadcasts, setLoadingBroadcasts] = useState(false);
  const [broadcastRecipientIds, setBroadcastRecipientIds] = useState<number[]>([]);
  const [clearingBroadcasts, setClearingBroadcasts] = useState(false);
  const [defaultTheme, setDefaultTheme] = useState<ThemeMode>('dark');
  const [savingDefaultTheme, setSavingDefaultTheme] = useState(false);
  const [workflowCacheProjects, setWorkflowCacheProjects] = useState<
    { projectKey: string; syncedAt: string | null; statusCount: number; errorCount: number }[]
  >([]);
  const [syncingWorkflows, setSyncingWorkflows] = useState(false);
  const [syncingUsers, setSyncingUsers] = useState(false);
  const [accountSearchQuery, setAccountSearchQuery] = useState('');
  const [jiraProjects, setJiraProjects] = useState<any[]>([]);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [editingJiraUser, setEditingJiraUser] = useState<any | null>(null);
  const [selectedProjectsDraft, setSelectedProjectsDraft] = useState<string[]>([]);

  const ACCOUNTS_PAGE_SIZE_OPTIONS = [10, 20, 50];

  const allAvailableMenus = APP_MENUS.map(m => ({ key: m.key, label: m.label }));
  const configurablePublicMenus = APP_MENUS.filter((m: any) => !m.adminOnly);

  const fetchAppAccounts = async () => {
    setLoadingAppAccounts(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/accounts`);
      if (res.ok) setAppAccounts(await res.json());
    } catch (err) {
      console.error('Failed to fetch app accounts:', err);
    } finally {
      setLoadingAppAccounts(false);
    }
  };

  const fetchWorkflowCacheMeta = async () => {
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/jira/workflow-cache`);
      if (res.ok) {
        const data = await res.json();
        setWorkflowCacheProjects(Array.isArray(data.projects) ? data.projects : []);
      }
    } catch (err) {
      console.error('Failed to fetch workflow cache meta:', err);
    }
  };

  const userHasJiraToken = hasJiraToken(currentUser);

  const handleSyncWorkflows = async () => {
    if (!userHasJiraToken) {
      showError(MISSING_JIRA_TOKEN_HINT);
      return;
    }
    const result = await showConfirm(
      'Đồng bộ workflow Jira',
      'Lấy toàn bộ transition theo từng trạng thái từ Jira và lưu vào database. Chỉ cần chạy khi workflow trên Jira thay đổi.'
    );
    if (!result.isConfirmed) return;

    setSyncingWorkflows(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/jira/sync-workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Đồng bộ workflow thất bại.');

      const projects = Array.isArray(data.projects) ? data.projects : [];
      const okCount = projects.filter((p: { ok?: boolean }) => p.ok).length;
      const failCount = projects.length - okCount;
      const statusTotal = projects.reduce(
        (sum: number, p: { statusCount?: number }) => sum + (p.statusCount || 0),
        0
      );

      await fetchWorkflowCacheMeta();

      if (failCount > 0) {
        showError(
          `Đồng bộ xong: ${okCount} dự án, ${failCount} lỗi. Tổng ${statusTotal} trạng thái.`
        );
      } else {
        showSuccess(`Đã đồng bộ ${okCount} dự án, ${statusTotal} trạng thái workflow.`);
      }
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Đồng bộ workflow thất bại.');
    } finally {
      setSyncingWorkflows(false);
    }
  };

  const fetchBroadcastHistory = async () => {
    setLoadingBroadcasts(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/notifications/broadcasts`);
      if (res.ok) setBroadcastHistory(await res.json());
    } catch (err) {
      console.error('Failed to fetch broadcast history:', err);
    } finally {
      setLoadingBroadcasts(false);
    }
  };

  const fetchJiraProjects = async () => {
    try {
      const [appRes, activeRes] = await Promise.all([
        apiFetch(`${API_BASE_URL}/api/projects`),
        apiFetch(`${API_BASE_URL}/api/projects/active`),
      ]);
      const merged = new Map<string, { key: string; name: string }>();
      if (appRes.ok) {
        const rows = await appRes.json();
        for (const p of Array.isArray(rows) ? rows : []) {
          if (p?.jira_key) {
            merged.set(p.jira_key, { key: p.jira_key, name: p.name || p.jira_key });
          }
        }
      }
      if (activeRes.ok) {
        const rows = await activeRes.json();
        for (const p of Array.isArray(rows) ? rows : []) {
          if (p?.jira_key) {
            merged.set(p.jira_key, { key: p.jira_key, name: p.name || p.jira_key });
          }
        }
      }
      setJiraProjects([...merged.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')));
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    }
  };

  const handleSyncJiraUsers = async () => {
    if (!userHasJiraToken) {
      showError(MISSING_JIRA_TOKEN_HINT);
      return;
    }
    setSyncingUsers(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/users/sync`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const count = typeof data.syncedCount === 'number' ? data.syncedCount : 0;
        const total = typeof data.totalProcessed === 'number' ? data.totalProcessed : count;
        showSuccess(`Đồng bộ người dùng Jira thành công (${count}/${total}).`);
        void fetchAppAccounts();
      } else {
        const msg = [data.error, data.details].filter(Boolean).join(' — ');
        showError(msg || 'Đồng bộ thất bại!');
      }
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Đồng bộ thất bại!');
    } finally {
      setSyncingUsers(false);
    }
  };

  const userApiUrl = (accountId: string, path: string) =>
    `${API_BASE_URL}/api/users/${encodeURIComponent(accountId)}${path}`;

  const handleTeamRoleChange = async (accountId: string, newRole: string) => {
    try {
      setAppAccounts(prev =>
        prev.map(u => (u.accountId === accountId ? { ...u, teamRole: newRole } : u))
      );
      const response = await apiFetch(userApiUrl(accountId, '/role'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!response.ok) showError('Không thể cập nhật vai trò!');
    } catch {
      showError('Lỗi kết nối khi cập nhật vai trò!');
    }
  };

  const handleToggleDropdown = async (accountId: string, currentStatus: boolean) => {
    const nextActive = !currentStatus;
    try {
      setAppAccounts(prev =>
        prev.map(u => (u.accountId === accountId ? { ...u, isActive: nextActive } : u))
      );
      const response = await apiFetch(userApiUrl(accountId, '/toggle'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setAppAccounts(prev =>
          prev.map(u => (u.accountId === accountId ? { ...u, isActive: currentStatus } : u))
        );
        showError(data.error || 'Không thể cập nhật trạng thái hiển thị!');
      }
    } catch {
      setAppAccounts(prev =>
        prev.map(u => (u.accountId === accountId ? { ...u, isActive: currentStatus } : u))
      );
      showError('Lỗi kết nối khi cập nhật trạng thái hiển thị!');
    }
  };

  const handleSortOrderChange = async (accountId: string, newSortOrder: number) => {
    try {
      setAppAccounts(prev =>
        prev.map(u => (u.accountId === accountId ? { ...u, sortOrder: newSortOrder } : u))
      );
      const response = await apiFetch(userApiUrl(accountId, '/sort-order'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sortOrder: newSortOrder }),
      });
      if (!response.ok) showError('Không thể cập nhật thứ tự!');
    } catch {
      showError('Lỗi kết nối khi cập nhật thứ tự!');
    }
  };

  const handleProjectChange = async (accountId: string, jiraProject: string) => {
    try {
      setAppAccounts(prev =>
        prev.map(u => (u.accountId === accountId ? { ...u, jiraProject: jiraProject || null } : u))
      );
      const response = await apiFetch(userApiUrl(accountId, '/project'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraProject: jiraProject || null }),
      });
      if (!response.ok) showError('Không thể cập nhật dự án!');
    } catch {
      showError('Lỗi kết nối khi cập nhật dự án!');
    }
  };

  const openProjectModal = (user: any) => {
    setEditingJiraUser(user);
    setSelectedProjectsDraft(user.jiraProject ? user.jiraProject.split(',') : []);
    setIsProjectModalOpen(true);
  };

  useEffect(() => {
    fetchAppAccounts();
    fetchWorkflowCacheMeta();
    void fetchJiraProjects();
    apiFetch(`${API_BASE_URL}/api/admin/settings/default-theme`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data?.defaultTheme === 'light' || data?.defaultTheme === 'dark') {
          setDefaultTheme(data.defaultTheme);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPublicPageDraft(publicPages);
  }, [publicPages]);

  const handleTogglePublicPage = (key: string) => {
    setPublicPageDraft(prev => {
      const newPages = prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key];
      savePublicPages(newPages);
      return newPages;
    });
  };

  const saveDefaultTheme = async (theme: ThemeMode) => {
    setSavingDefaultTheme(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/settings/default-theme`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultTheme: theme }),
      });
      if (res.ok) {
        const data = await res.json();
        const saved = data.defaultTheme === 'light' ? 'light' : 'dark';
        setDefaultTheme(saved);
        notifyDefaultThemeChanged(saved);
        showSuccess(`Giao diện mặc định: ${saved === 'light' ? 'Sáng' : 'Tối'}`);
      } else {
        const data = await res.json();
        showError(data.error || 'Lưu thất bại');
      }
    } catch {
      showError('Lỗi khi lưu giao diện mặc định');
    } finally {
      setSavingDefaultTheme(false);
    }
  };

  const savePublicPages = async (newPages: string[]) => {
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/settings/public-pages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicPages: newPages }),
      });
      if (res.ok) {
        const data = await res.json();
        onPublicPagesUpdated(data.publicPages || newPages);
      } else {
        const data = await res.json();
        showError(data.error || 'Lưu thất bại');
      }
    } catch {
      showError('Lỗi khi lưu cấu hình trang công khai');
    }
  };

  useEffect(() => {
    const fetchNotificationSettings = async () => {
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/admin/settings/notifications`);
        if (res.ok) {
          const data = await res.json();
          setAllowedNotificationTypes(
            data.allowedTypes || ['bug_commit', 'subtask_resolved', 'bug_assigned_open']
          );
          if (data.notificationProjects && Array.isArray(data.notificationProjects)) {
            setNotificationProjects(data.notificationProjects.join(', '));
          }
        }
      } catch (err) {
        console.error('Failed to fetch notification settings:', err);
      }
    };
    fetchNotificationSettings();
  }, [apiFetch, API_BASE_URL]);

  const handleToggleNotificationType = (key: string) => {
    setAllowedNotificationTypes(prev => {
      const newTypes = prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key];
      saveNotificationSettings(newTypes);
      return newTypes;
    });
  };

  const saveNotificationSettings = async (newTypes: string[]) => {
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/settings/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedTypes: newTypes }),
      });
      if (!res.ok) {
        const data = await res.json();
        showError(data.error || 'Lưu cấu hình thông báo thất bại');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi khi lưu cấu hình thông báo');
    }
  };

  const handleSaveNotificationProjects = async () => {
    const projArray = notificationProjects
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/settings/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedTypes: allowedNotificationTypes, notificationProjects: projArray }),
      });
      if (!res.ok) {
        const data = await res.json();
        showError(data.error || 'Lưu cấu hình dự án thất bại');
      } else {
        showSuccess('Lưu cấu hình dự án nhận thông báo thành công!');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi khi lưu cấu hình dự án');
    }
  };

  const handleForceRefresh = async () => {
    const result = await showConfirm(
      'Ép tất cả người dùng F5?',
      'Hành động này sẽ gửi lệnh bắt tất cả người dùng đang kết nối tự động tải lại trang. Chú ý: Tránh dùng ngay khi server đang rebuild vì SSE có thể chưa kết nối lại.'
    );
    if (!result.isConfirmed) return;

    setForcingRefresh(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/notifications/force-refresh`, {
        method: 'POST',
      });
      if (res.ok) {
        showSuccess('Đã gửi lệnh ép tải lại trang tới tất cả người dùng!');
      } else {
        const data = await res.json();
        showError(data.error || 'Gửi lệnh thất bại');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi kết nối khi gửi lệnh F5');
    } finally {
      setForcingRefresh(false);
    }
  };

  const notificationTypes = [
    {
      key: 'bug_commit',
      label: '🐛 Bug chuyển Commit',
      desc: 'Báo khi Bug/Lỗi chuyển sang trạng thái Commit',
    },
    {
      key: 'bug_assigned_open',
      label: '🐛 Bug mới / Open / ReOpen / đổi assign',
      desc: 'Báo bug mới tạo, mở lại, phân công hoặc đổi assignee (sau restart không báo bug cũ)',
    },
    {
      key: 'subtask_resolved',
      label: '🏁 Subtask hoàn thành (Resolved)',
      desc: 'Báo khi công việc phụ hoàn thành',
    },
  ];

  const handleSendBroadcast = async () => {
    const title = broadcastTitle.trim();
    const body = broadcastBody.trim();
    if (!title || !body) {
      showError('Vui lòng nhập tiêu đề và nội dung thông báo.');
      return;
    }
    setSendingBroadcast(true);
    const recipientCount = broadcastRecipientIds.length;
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/notifications/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          body,
          ...(broadcastRecipientIds.length > 0 ? { recipientIds: broadcastRecipientIds } : {}),
        }),
      });
      if (res.ok) {
        setBroadcastTitle('');
        setBroadcastBody('');
        setBroadcastRecipientIds([]);
        setIsBroadcastModalOpen(false);
        fetchBroadcastHistory();
        const targetLabel =
          recipientCount > 0 ? `${recipientCount} tài khoản đã chọn` : 'tất cả người dùng';
        showSuccess(
          `Đã gửi thông báo tới ${targetLabel}! Người nhận đang mở app sẽ thấy trong vài giây (nếu đã bật quyền desktop).`
        );
      } else {
        const data = await res.json();
        showError(data.error || 'Gửi thông báo thất bại');
      }
    } catch {
      showError('Lỗi khi gửi thông báo');
    } finally {
      setSendingBroadcast(false);
    }
  };

  const handleTestWebPush = async () => {
    setSendingBroadcast(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/notifications/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testSelf: true,
          title: 'Test Web Push Notification',
          body: 'Nếu bạn nhận được thông báo này khi đóng tab, Web Push đang hoạt động bình thường!',
        }),
      });
      if (res.ok) {
        showSuccess('Đã gửi Test Web Push. Hãy đóng tab và kiểm tra.');
        fetchBroadcastHistory();
      } else {
        const data = await res.json();
        showError(data.error || 'Gửi test thất bại');
      }
    } catch {
      showError('Lỗi khi gửi test thông báo');
    } finally {
      setSendingBroadcast(false);
    }
  };

  const handleUpdateAccountRole = async (id: number, newRole: string) => {
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/accounts/${id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) fetchAppAccounts();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteAccount = async (id: number) => {
    const result = await showConfirm(
      'Bạn có chắc muốn xoá?',
      'Tài khoản này sẽ bị xoá vĩnh viễn khỏi hệ thống.'
    );
    if (!result.isConfirmed) return;
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/accounts/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchAppAccounts();
      } else {
        const data = await res.json();
        showError(data.error || 'Xoá thất bại');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi kết nối khi xoá tài khoản');
    }
  };

  const openCreateModal = () => {
    setNewAccountUser('');
    setNewAccountPass('');
    setNewAccountRole('user');
    setIsCreateModalOpen(true);
  };

  const openBroadcastModal = () => {
    setBroadcastRecipientIds([]);
    setIsBroadcastModalOpen(true);
    fetchBroadcastHistory();
  };

  const handleToggleBroadcastRecipient = (accountId: number) => {
    setBroadcastRecipientIds(prev =>
      prev.includes(accountId) ? prev.filter(id => id !== accountId) : [...prev, accountId]
    );
  };

  const handleClearBroadcastForm = () => {
    setBroadcastTitle('');
    setBroadcastBody('');
    setBroadcastRecipientIds([]);
  };

  const handleDeleteBroadcast = async (id: number) => {
    const result = await showConfirm('Xóa thông báo này?', 'Thông báo sẽ bị xóa khỏi lịch sử.');
    if (!result.isConfirmed) return;
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/notifications/broadcasts/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setBroadcastHistory(prev => prev.filter(item => item.id !== id));
        showSuccess('Đã xóa thông báo.');
      } else {
        const data = await res.json();
        showError(data.error || 'Xóa thất bại');
      }
    } catch {
      showError('Lỗi khi xóa thông báo');
    }
  };

  const handleClearAllBroadcasts = async () => {
    const result = await showConfirm(
      'Xóa toàn bộ lịch sử?',
      'Tất cả thông báo đã gửi sẽ bị xóa vĩnh viễn.'
    );
    if (!result.isConfirmed) return;
    setClearingBroadcasts(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/notifications/broadcasts`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setBroadcastHistory([]);
        showSuccess('Đã xóa toàn bộ lịch sử thông báo.');
      } else {
        const data = await res.json();
        showError(data.error || 'Xóa lịch sử thất bại');
      }
    } catch {
      showError('Lỗi khi xóa lịch sử');
    } finally {
      setClearingBroadcasts(false);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountUser.trim() || !newAccountPass.trim()) {
      showError('Vui lòng nhập đầy đủ username và mật khẩu.');
      return;
    }
    setCreatingAccount(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newAccountUser.trim(),
          password: newAccountPass,
          role: newAccountRole,
        }),
      });
      if (res.ok) {
        setIsCreateModalOpen(false);
        setNewAccountUser('');
        setNewAccountPass('');
        setNewAccountRole('user');
        fetchAppAccounts();
        showSuccess('Tạo tài khoản thành công!');
      } else {
        const data = await res.json();
        showError(data.error || 'Tạo tài khoản thất bại');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi mạng khi tạo tài khoản');
    } finally {
      setCreatingAccount(false);
    }
  };

  const openPermModal = (acc: any) => {
    setEditingAcc(acc);
    setSelectedPerms(acc.permissions || []);
    setIsPermModalOpen(true);
  };

  const handleTogglePerm = (key: string) => {
    setSelectedPerms(prev => (prev.includes(key) ? prev.filter(p => p !== key) : [...prev, key]));
  };

  const handleSavePermissions = async () => {
    if (!editingAcc) return;
    setSavingPerms(true);
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/api/admin/accounts/${editingAcc.id}/permissions`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions: selectedPerms }),
        }
      );
      if (res.ok) {
        setIsPermModalOpen(false);
        fetchAppAccounts();
        showSuccess('Cập nhật phân quyền thành công!');
      }
    } catch (error) {
      console.error('Failed to save permissions:', error);
    } finally {
      setSavingPerms(false);
    }
  };
  const handleEnableLogin = async (acc: { accountId: string; displayName?: string }) => {
    const result = await showConfirm(
      'Bật đăng nhập',
      `Bật đăng nhập cho ${acc.displayName || acc.accountId}? Mật khẩu mặc định là 1.`
    );
    if (!result.isConfirmed) return;

    try {
      const res = await apiFetch(userApiUrl(acc.accountId, '/enable-login'), {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Bật đăng nhập thất bại.');

      void fetchAppAccounts();
      if (data.alreadyEnabled) {
        showSuccess(`Tài khoản đã có đăng nhập (${data.username}).`);
      } else {
        showSuccess(`Đã bật đăng nhập: ${data.username} / mật khẩu 1`);
      }
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Bật đăng nhập thất bại.');
    }
  };

  const handleUpdatePassword = async () => {
    if (!editingAcc || !newPassword) return;
    setSavingPassword(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/admin/accounts/${editingAcc.id}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      if (res.ok) {
        setIsPasswordModalOpen(false);
        setNewPassword('');
        void fetchAppAccounts();
        showSuccess(
          editingAcc.canLogin ? 'Đổi mật khẩu thành công!' : 'Đã bật đăng nhập với mật khẩu mới.'
        );
      } else {
        const data = await res.json();
        showError(data.error || 'Đổi mật khẩu thất bại');
      }
    } catch (error) {
      console.error('Failed to update password:', error);
      showError('Lỗi kết nối khi đổi mật khẩu');
    } finally {
      setSavingPassword(false);
    }
  };

  const openPasswordModal = (acc: any) => {
    setEditingAcc(acc);
    setNewPassword('');
    setIsPasswordModalOpen(true);
  };

  const accountInitial = (acc: any) =>
    (acc.displayName || acc.username || acc.emailAddress || '?').trim().charAt(0).toUpperCase();

  const loginAccounts = appAccounts.filter(a => a.canLogin);
  const adminCount = loginAccounts.filter(a => a.appRole === 'admin').length;
  const activeDropdownCount = appAccounts.filter(a => a.isActive).length;

  const filteredAccounts = useMemo(() => {
    const q = accountSearchQuery.trim().toLowerCase();
    if (!q) return appAccounts;
    return appAccounts.filter(acc => {
      const haystack = [acc.displayName, acc.emailAddress, acc.username, acc.accountId]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [appAccounts, accountSearchQuery]);

  const totalAccounts = filteredAccounts.length;
  const totalAccountPages = Math.max(1, Math.ceil(totalAccounts / accountsPageSize));
  const accountsPageStart = totalAccounts === 0 ? 0 : (accountsPage - 1) * accountsPageSize + 1;
  const accountsPageEnd = Math.min(accountsPage * accountsPageSize, totalAccounts);
  const paginatedAccounts = filteredAccounts.slice(
    (accountsPage - 1) * accountsPageSize,
    accountsPage * accountsPageSize
  );

  const loginRecipients = appAccounts.filter(a => a.canLogin && a.id);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredAccounts.length / accountsPageSize));
    if (accountsPage > maxPage) setAccountsPage(maxPage);
  }, [filteredAccounts.length, accountsPageSize, accountsPage]);

  const accountPageNumbers = () => {
    const pages: number[] = [];
    const maxVisible = 5;
    let start = Math.max(1, accountsPage - Math.floor(maxVisible / 2));
    let end = Math.min(totalAccountPages, start + maxVisible - 1);
    start = Math.max(1, end - maxVisible + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  };

  return (
    <main
      className="glass-card admin-page"
      style={{
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        height: 'calc(100vh - 2.2rem)',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          marginBottom: '1rem',
          flexShrink: 0,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Quản trị Hệ thống</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '4px 0 0' }}>
            Quản lý người dùng Jira, tài khoản đăng nhập, phân quyền, thông báo và trang công khai.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleTestWebPush}
            disabled={sendingBroadcast}
            style={{
              width: 'auto',
              marginTop: 0,
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              background: 'rgba(99, 102, 241, 0.1)',
              color: '#818cf8',
              borderColor: 'rgba(99, 102, 241, 0.3)',
            }}
          >
            {sendingBroadcast ? <Loader2 className="spinner" size={16} /> : <Send size={16} />}
            Test Web Push
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={openBroadcastModal}
            style={{
              width: 'auto',
              marginTop: 0,
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Bell size={16} /> Gửi thông báo
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={openCreateModal}
            style={{
              width: 'auto',
              marginTop: 0,
              padding: '8px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Plus size={16} /> Tạo tài khoản
          </button>
        </div>
      </div>

      <div className="admin-settings-bar">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setIsThemeModalOpen(true)}
          style={{
            width: 'auto',
            marginTop: 0,
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Sun size={16} style={{ color: '#fbbf24' }} />
          Giao diện mặc định
          <span className="admin-settings-badge admin-settings-badge--amber">
            {defaultTheme === 'light' ? 'Sáng' : 'Tối'}
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setIsPublicPagesModalOpen(true)}
          style={{
            width: 'auto',
            marginTop: 0,
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Globe size={16} style={{ color: '#a5b4fc' }} />
          Trang công khai
          <span className="admin-settings-badge admin-settings-badge--indigo">
            {publicPageDraft.length} trang
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setIsNotificationsModalOpen(true)}
          style={{
            width: 'auto',
            marginTop: 0,
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <Bell size={16} style={{ color: '#34d399' }} />
          Loại thông báo
          <span className="admin-settings-badge admin-settings-badge--green">
            {allowedNotificationTypes.length}/{notificationTypes.length}
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleForceRefresh}
          disabled={forcingRefresh}
          style={{
            width: 'auto',
            marginTop: 0,
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <RefreshCw size={16} style={{ color: '#f87171' }} className={forcingRefresh ? 'spinner' : ''} />
          Refresh tất cả
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleSyncWorkflows()}
          disabled={syncingWorkflows || !userHasJiraToken}
          style={{
            width: 'auto',
            marginTop: 0,
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
          title={
            userHasJiraToken
              ? 'Đồng bộ transition từ Jira và lưu vào database'
              : MISSING_JIRA_TOKEN_HINT
          }
        >
          {syncingWorkflows ? (
            <Loader2 size={16} className="spinner" style={{ color: '#f472b6' }} />
          ) : (
            <GitBranch size={16} style={{ color: '#f472b6' }} />
          )}
          Workflow Jira
          <span className="admin-settings-badge admin-settings-badge--pink">
            {workflowCacheProjects.length > 0
              ? `${workflowCacheProjects.reduce((s, p) => s + (p.statusCount || 0), 0)} status`
              : 'Chưa lưu DB'}
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void handleSyncJiraUsers()}
          disabled={syncingUsers || !userHasJiraToken}
          style={{
            width: 'auto',
            marginTop: 0,
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
          title={
            userHasJiraToken
              ? 'Lấy danh sách người dùng từ Jira vào hệ thống'
              : MISSING_JIRA_TOKEN_HINT
          }
        >
          {syncingUsers ? (
            <Loader2 size={16} className="spinner" style={{ color: '#818cf8' }} />
          ) : (
            <RefreshCw size={16} style={{ color: '#818cf8' }} />
          )}
          Người dùng Jira
          <span className="admin-settings-badge admin-settings-badge--indigo">
            {appAccounts.length} người
          </span>
        </button>
      </div>

      <div
        className="scrollable-area"
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          paddingRight: '6px',
        }}
      >
        <section
          className="admin-accounts-panel"
          style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        >
          <div
            style={{
              padding: '0.85rem 1rem',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '0.75rem',
              flexShrink: 0,
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: '0.92rem',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <Users size={16} style={{ color: '#818cf8' }} />
              Danh sách người dùng
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <div className="user-mgmt-search">
                <Search size={16} />
                <input
                  type="text"
                  placeholder="Tìm tên, email, username..."
                  value={accountSearchQuery}
                  onChange={e => {
                    setAccountSearchQuery(e.target.value);
                    setAccountsPage(1);
                  }}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void handleSyncJiraUsers()}
                disabled={syncingUsers || !userHasJiraToken}
                title={userHasJiraToken ? undefined : MISSING_JIRA_TOKEN_HINT}
                style={{
                  width: 'auto',
                  marginTop: 0,
                  padding: '0.5rem 0.9rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '0.82rem',
                }}
              >
                {syncingUsers ? <Loader2 className="spinner" size={14} /> : <RefreshCw size={14} />}
                Đồng bộ Jira
              </button>
              {!loadingAppAccounts && (
                <div className="admin-accounts-stats" style={{ marginBottom: 0 }}>
                  <span className="admin-accounts-stat">
                    <strong>{appAccounts.length}</strong> người
                  </span>
                  <span className="admin-accounts-stat">
                    <strong>{loginAccounts.length}</strong> đăng nhập
                  </span>
                  <span className="admin-accounts-stat admin-accounts-stat--admin">
                    <strong>{adminCount}</strong> admin
                  </span>
                  <span className="admin-accounts-stat user-mgmt-stat--active">
                    <strong>{activeDropdownCount}</strong> dropdown
                  </span>
                </div>
              )}
            </div>
          </div>

          {loadingAppAccounts ? (
            <div className="admin-accounts-loading">
              <Loader2 className="spinner" size={32} color="#818cf8" />
              <span>Đang tải danh sách...</span>
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="admin-accounts-empty">
              <UserCircle size={40} style={{ opacity: 0.35 }} />
              <p>
                {accountSearchQuery.trim()
                  ? 'Không tìm thấy người dùng phù hợp.'
                  : 'Chưa có người dùng. Nhấn Đồng bộ Jira hoặc Tạo tài khoản.'}
              </p>
              {!accountSearchQuery.trim() && (
                <div
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    marginTop: '1rem',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                  }}
                >
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void handleSyncJiraUsers()}
                    disabled={syncingUsers}
                    style={{ width: 'auto', padding: '8px 16px' }}
                  >
                    <RefreshCw size={16} /> Đồng bộ Jira
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={openCreateModal}
                    style={{ width: 'auto', padding: '8px 16px' }}
                  >
                    <Plus size={16} /> Tạo tài khoản
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div
              className="admin-accounts-table-wrap scrollable-area"
              style={{ flex: 1, overflowY: 'auto' }}
            >
              <table className="admin-accounts-table">
                <thead>
                  <tr>
                    <th>Người dùng</th>
                    <th className="is-center">Vai trò</th>
                    <th className="is-center">Dự án</th>
                    <th className="is-center">Thứ tự</th>
                    <th className="is-center">Dropdown</th>
                    <th>Đăng nhập</th>
                    <th style={{ textAlign: 'right' }}>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedAccounts.map(acc => {
                    const isSelf = acc.canLogin && acc.id === currentUser?.id;
                    const isAdmin = acc.appRole === 'admin';
                    const permCount = (acc.permissions || []).length;
                    const teamRole = acc.teamRole || 'developer';
                    const hasProject = Boolean(acc.jiraProject);

                    return (
                      <tr
                        key={acc.accountId}
                        className={`${isSelf ? 'admin-accounts-row--self' : ''}${!acc.isActive ? ' is-inactive' : ''}`.trim()}
                      >
                        <td>
                          <div className="user-mgmt-user">
                            {acc.avatarUrl ? (
                              <img
                                src={getAvatarUrl(acc.avatarUrl, API_BASE_URL)}
                                alt=""
                                className="user-mgmt-avatar"
                              />
                            ) : (
                              <div
                                className={`admin-account-avatar${isAdmin ? ' admin-account-avatar--admin' : ''}`}
                              >
                                {accountInitial(acc)}
                              </div>
                            )}
                            <div style={{ minWidth: 0 }}>
                              <div className="admin-account-name">
                                {acc.displayName || acc.username || acc.accountId}
                                {isSelf && <span className="admin-account-you">Bạn</span>}
                              </div>
                              <div className="user-mgmt-email">
                                {acc.emailAddress || acc.username || '—'}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="is-center">
                          <select
                            value={teamRole}
                            onChange={e => void handleTeamRoleChange(acc.accountId, e.target.value)}
                            className="premium-select user-mgmt-role-select"
                          >
                            {TEAM_ROLE_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="is-center">
                          <button
                            type="button"
                            onClick={() => openProjectModal(acc)}
                            className={`user-mgmt-project-btn${hasProject ? ' has-project' : ''}`}
                            title={acc.jiraProject || 'Chưa gán dự án'}
                          >
                            <FolderGit2 size={13} style={{ flexShrink: 0 }} />
                            {hasProject ? acc.jiraProject.split(',').join(', ') : 'Gán dự án'}
                          </button>
                        </td>
                        <td className="is-center">
                          <input
                            type="number"
                            className="user-mgmt-sort-input"
                            value={acc.sortOrder ?? 0}
                            onChange={e =>
                              void handleSortOrderChange(
                                acc.accountId,
                                parseInt(e.target.value, 10) || 0
                              )
                            }
                            title="Thứ tự trong dropdown"
                          />
                        </td>
                        <td className="is-center">
                          <button
                            type="button"
                            onClick={() => void handleToggleDropdown(acc.accountId, acc.isActive)}
                            className={`user-mgmt-toggle${acc.isActive ? ' is-on' : ' is-off'}`}
                            title={
                              acc.isActive
                                ? 'Đang hiển thị — nhấn để ẩn'
                                : 'Đang ẩn — nhấn để hiển thị'
                            }
                          >
                            {acc.isActive ? <ToggleRight size={30} /> : <ToggleLeft size={30} />}
                          </button>
                        </td>
                        <td>
                          {acc.canLogin ? (
                            <div
                              style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}
                            >
                              <select
                                value={acc.appRole || 'user'}
                                onChange={e => void handleUpdateAccountRole(acc.id, e.target.value)}
                                className="premium-select admin-role-select"
                                disabled={isSelf}
                                title={
                                  isSelf ? 'Không thể đổi quyền của chính bạn' : 'Quyền hệ thống'
                                }
                              >
                                <option value="user">User</option>
                                <option value="admin">Admin</option>
                              </select>
                              {isAdmin ? (
                                <span className="admin-perm-chip">Tất cả menu</span>
                              ) : (
                                <span
                                  className={`admin-perm-chip${permCount === 0 ? ' admin-perm-chip--none' : ''}`}
                                >
                                  <ShieldCheck size={12} />
                                  {permCount === 0 ? 'Chưa gán menu' : `${permCount} menu`}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="admin-perm-chip admin-perm-chip--none">
                              Chưa có login
                            </span>
                          )}
                        </td>
                        <td>
                          <div className="admin-account-actions">
                            {!acc.canLogin && (
                              <button
                                type="button"
                                onClick={() => void handleEnableLogin(acc)}
                                className="admin-icon-btn admin-icon-btn--perm"
                                title="Bật đăng nhập (mật khẩu mặc định: 1)"
                              >
                                <KeyRound size={14} /> Login
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openPasswordModal(acc)}
                              className="admin-icon-btn admin-icon-btn--pass"
                              title={acc.canLogin ? 'Đổi mật khẩu' : 'Đặt mật khẩu đăng nhập'}
                            >
                              <Lock size={14} /> Pass
                            </button>
                            {acc.canLogin && !isAdmin && (
                              <button
                                type="button"
                                onClick={() => openPermModal(acc)}
                                className="admin-icon-btn admin-icon-btn--perm"
                                title="Phân quyền menu"
                              >
                                <ShieldCheck size={14} /> Quyền
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteAccount(acc.id)}
                              disabled={isSelf}
                              className="admin-icon-btn admin-icon-btn--danger"
                              title={
                                isSelf
                                  ? 'Không thể xóa tài khoản của chính bạn'
                                  : 'Xóa khỏi database'
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!loadingAppAccounts && totalAccounts > 0 && (
            <div className="admin-accounts-pagination" style={{ flexShrink: 0 }}>
              <div className="admin-accounts-pagination__info">
                Hiển thị{' '}
                <strong>
                  {accountsPageStart}–{accountsPageEnd}
                </strong>{' '}
                / {totalAccounts}
              </div>
              <div className="admin-accounts-pagination__controls">
                <button
                  type="button"
                  className="admin-page-btn"
                  onClick={() => setAccountsPage(p => Math.max(1, p - 1))}
                  disabled={accountsPage <= 1}
                  title="Trang trước"
                >
                  <ChevronLeft size={16} />
                </button>
                {accountPageNumbers().map(page => (
                  <button
                    key={page}
                    type="button"
                    className={`admin-page-btn${page === accountsPage ? ' admin-page-btn--active' : ''}`}
                    onClick={() => setAccountsPage(page)}
                  >
                    {page}
                  </button>
                ))}
                <button
                  type="button"
                  className="admin-page-btn"
                  onClick={() => setAccountsPage(p => Math.min(totalAccountPages, p + 1))}
                  disabled={accountsPage >= totalAccountPages}
                  title="Trang sau"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
              <div className="admin-accounts-pagination__size">
                <span>Mỗi trang</span>
                <select
                  value={accountsPageSize}
                  onChange={e => {
                    setAccountsPageSize(Number(e.target.value));
                    setAccountsPage(1);
                  }}
                  className="premium-select admin-page-size-select"
                >
                  {ACCOUNTS_PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </section>
      </div>

      <CommonModal
        open={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        title={`Gán dự án — ${editingJiraUser?.displayName ?? ''}`}
        styleContent={{ maxWidth: '480px' }}
      >
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          Chọn một hoặc nhiều project Jira cho người dùng này.
        </p>
        <div className="user-mgmt-project-list scrollable-area">
          {jiraProjects.map(p => {
            const isChecked = selectedProjectsDraft.includes(p.key);
            return (
              <label
                key={p.key}
                className={`user-mgmt-project-option${isChecked ? ' is-checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={e => {
                    if (e.target.checked) {
                      setSelectedProjectsDraft(prev => [...prev, p.key]);
                    } else {
                      setSelectedProjectsDraft(prev => prev.filter(k => k !== p.key));
                    }
                  }}
                />
                <span style={{ fontSize: '0.875rem' }}>
                  <strong>[{p.key}]</strong> {p.name}
                </span>
              </label>
            );
          })}
          {jiraProjects.length === 0 && (
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.875rem',
                textAlign: 'center',
                margin: 0,
              }}
            >
              Không tìm thấy dự án nào.
            </p>
          )}
        </div>
        <div className="user-mgmt-modal-footer">
          <button
            type="button"
            onClick={() => setIsProjectModalOpen(false)}
            className="filter-btn"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={async () => {
              if (editingJiraUser) {
                const joined =
                  selectedProjectsDraft.length > 0 ? selectedProjectsDraft.join(',') : '';
                await handleProjectChange(editingJiraUser.accountId, joined);
              }
              setIsProjectModalOpen(false);
            }}
            className="btn-primary"
            style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem', width: 'auto', marginTop: 0 }}
          >
            Lưu dự án
          </button>
        </div>
      </CommonModal>

      <CommonModal
        open={isThemeModalOpen}
        onClose={() => !savingDefaultTheme && setIsThemeModalOpen(false)}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Sun color="#fbbf24" size={22} /> Giao diện mặc định
          </span>
        }
        titleId="app-accounts-theme-modal-title"
        styleContent={{ maxWidth: '480px' }}
      >
        <p
          style={{
            color: 'var(--text-secondary)',
            margin: '0 0 1.25rem',
            fontSize: '0.88rem',
            lineHeight: 1.5,
          }}
        >
          Chế độ hiển thị cho người dùng chưa tự chọn theme (toggle sidebar hoặc Cấu hình cá nhân).
          Người đã chọn riêng không bị ghi đè.
        </p>
        <div className="theme-picker">
          <button
            type="button"
            disabled={savingDefaultTheme}
            className={`theme-picker__btn${defaultTheme === 'light' ? ' is-active' : ''}`}
            onClick={() => saveDefaultTheme('light')}
          >
            <Sun size={16} /> Sáng (Light)
          </button>
          <button
            type="button"
            disabled={savingDefaultTheme}
            className={`theme-picker__btn${defaultTheme === 'dark' ? ' is-active' : ''}`}
            onClick={() => saveDefaultTheme('dark')}
          >
            <Moon size={16} /> Tối (Dark)
          </button>
        </div>
        {savingDefaultTheme && (
          <p
            style={{
              margin: '1rem 0 0',
              fontSize: '0.82rem',
              color: 'var(--text-secondary)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Loader2 className="spinner" size={14} /> Đang lưu...
          </p>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setIsThemeModalOpen(false)}
          disabled={savingDefaultTheme}
          style={{ width: '100%', marginTop: '1.25rem', padding: '10px' }}
        >
          Đóng
        </button>
      </CommonModal>

      <CommonModal
        open={isPublicPagesModalOpen}
        onClose={() => setIsPublicPagesModalOpen(false)}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Globe color="#a5b4fc" size={22} /> Trang công khai
          </span>
        }
        titleId="app-accounts-public-pages-modal-title"
        styleContent={{ maxWidth: '560px' }}
      >
        <p
          style={{
            color: 'var(--text-secondary)',
            margin: '0 0 1.25rem',
            fontSize: '0.88rem',
            lineHeight: 1.5,
          }}
        >
          Bật các menu guest được xem mà không cần đăng nhập. Trang Quản trị / Skill luôn yêu cầu
          admin.
        </p>
        <div
          className="scrollable-area"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            maxHeight: 'min(360px, 55vh)',
            overflowY: 'auto',
            paddingRight: '4px',
          }}
        >
          {configurablePublicMenus.map(menu => {
            const on = publicPageDraft.includes(menu.key);
            return (
              <button
                key={menu.key}
                type="button"
                onClick={() => handleTogglePublicPage(menu.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.65rem 0.85rem',
                  background: on ? 'rgba(74, 222, 128, 0.1)' : 'var(--surface-muted)',
                  border: `1px solid ${on ? 'rgba(74, 222, 128, 0.3)' : 'var(--border-color)'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  color: 'inherit',
                  textAlign: 'left',
                }}
              >
                <span style={{ fontSize: '0.88rem' }}>{menu.label}</span>
                <span style={{ color: on ? '#4ade80' : '#555' }}>
                  {on ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setIsPublicPagesModalOpen(false)}
          style={{ width: '100%', marginTop: '1.25rem', padding: '10px' }}
        >
          Đóng
        </button>
      </CommonModal>

      <CommonModal
        open={isNotificationsModalOpen}
        onClose={() => setIsNotificationsModalOpen(false)}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Bell color="#34d399" size={22} /> Loại thông báo tự động
          </span>
        }
        titleId="app-accounts-notifications-modal-title"
        styleContent={{ maxWidth: '560px' }}
      >
        <p
          style={{
            color: 'var(--text-secondary)',
            margin: '0 0 1.25rem',
            fontSize: '0.88rem',
            lineHeight: 1.5,
          }}
        >
          Cấu hình các loại thông báo tự động gửi qua Web Push hoặc SSE tới màn hình desktop của
          người dùng.
        </p>
        <div
          className="scrollable-area"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            maxHeight: 'min(400px, 55vh)',
            overflowY: 'auto',
            paddingRight: '4px',
          }}
        >
          {notificationTypes.map(type => {
            const on = allowedNotificationTypes.includes(type.key);
            return (
              <button
                key={type.key}
                type="button"
                onClick={() => handleToggleNotificationType(type.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.65rem 0.85rem',
                  background: on ? 'rgba(74, 222, 128, 0.1)' : 'var(--surface-muted)',
                  border: `1px solid ${on ? 'rgba(74, 222, 128, 0.3)' : 'var(--border-color)'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  color: 'inherit',
                  textAlign: 'left',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    paddingRight: '0.5rem',
                  }}
                >
                  <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>{type.label}</span>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-secondary)',
                      lineHeight: 1.35,
                    }}
                  >
                    {type.desc}
                  </span>
                </div>
                <span style={{ color: on ? '#4ade80' : '#555', flexShrink: 0 }}>
                  {on ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: '1.25rem', padding: '1rem', background: 'var(--surface-muted)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
          <label style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
            Dự án nhận thông báo (Project Keys)
          </label>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
            Nhập danh sách mã dự án cách nhau bằng dấu phẩy (VD: ABC, DEF). Để trống nếu muốn áp dụng cho tất cả dự án.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              value={notificationProjects}
              onChange={e => setNotificationProjects(e.target.value)}
              placeholder="VD: CORE, APP"
              className="config-input"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={handleSaveNotificationProjects}
              style={{ padding: '0 1rem', whiteSpace: 'nowrap' }}
            >
              Lưu dự án
            </button>
          </div>
        </div>

        <button
          type="button"
          className="btn-secondary"
          onClick={() => setIsNotificationsModalOpen(false)}
          style={{ width: '100%', marginTop: '1.25rem', padding: '10px' }}
        >
          Đóng
        </button>
      </CommonModal>

      <CommonModal
        open={isCreateModalOpen}
        onClose={() => !creatingAccount && setIsCreateModalOpen(false)}
        closeDisabled={creatingAccount}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Plus color="#4ade80" size={22} /> Tạo tài khoản mới
          </span>
        }
        titleId="app-accounts-create-modal-title"
        styleContent={{ maxWidth: '420px' }}
      >
        <p style={{ color: '#888', marginBottom: '1.25rem', fontSize: '0.88rem', marginTop: 0 }}>
          Thêm tài khoản đăng nhập JiraGenius. Sau khi tạo, có thể phân quyền menu riêng.
        </p>
        <form onSubmit={handleCreateAccount}>
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.82rem' }}>Username</label>
            <input
              type="text"
              required
              value={newAccountUser}
              onChange={e => setNewAccountUser(e.target.value)}
              placeholder="vd: huy.tran"
              autoFocus
              className="premium-select"
              style={{
                backgroundImage: 'none',
                background: 'rgba(0,0,0,0.35)',
                padding: '10px 12px',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '1rem' }}>
            <label style={{ fontSize: '0.82rem' }}>Mật khẩu</label>
            <input
              type="password"
              required
              value={newAccountPass}
              onChange={e => setNewAccountPass(e.target.value)}
              placeholder="Mật khẩu ban đầu..."
              className="premium-select"
              style={{
                backgroundImage: 'none',
                background: 'rgba(0,0,0,0.35)',
                padding: '10px 12px',
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '1.5rem' }}>
            <label style={{ fontSize: '0.82rem' }}>Vai trò hệ thống</label>
            <select
              value={newAccountRole}
              onChange={e => setNewAccountRole(e.target.value as 'admin' | 'user')}
              className="premium-select"
              style={{ height: '40px', width: '100%' }}
            >
              <option value="user">User — phân quyền theo menu</option>
              <option value="admin">Admin — toàn quyền</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.65rem' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setIsCreateModalOpen(false)}
              disabled={creatingAccount}
              style={{ flex: 1, marginTop: 0, padding: '10px' }}
            >
              Hủy
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={creatingAccount}
              style={{
                flex: 1,
                marginTop: 0,
                padding: '10px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
            >
              {creatingAccount ? <Loader2 className="spinner" size={18} /> : <Check size={18} />}
              {creatingAccount ? 'Đang tạo...' : 'Tạo tài khoản'}
            </button>
          </div>
        </form>
      </CommonModal>

      <CommonModal
        open={isBroadcastModalOpen}
        onClose={() => !sendingBroadcast && setIsBroadcastModalOpen(false)}
        closeDisabled={sendingBroadcast}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Bell color="#fbbf24" size={22} /> Gửi thông báo Desktop
          </span>
        }
        titleId="app-accounts-broadcast-modal-title"
        styleContent={{ maxWidth: '520px' }}
      >
        <p style={{ color: '#888', marginBottom: '1.25rem', fontSize: '0.88rem', marginTop: 0 }}>
          Thông báo Windows tới người dùng đang đăng nhập app. Không chọn người nhận = gửi tất cả.
          Người nhận cần bật quyền thông báo ở sidebar (nút chuông).
        </p>
        <div className="form-group" style={{ marginBottom: '1rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.35rem',
            }}
          >
            <label style={{ fontSize: '0.82rem', margin: 0 }}>Tiêu đề</label>
            {(broadcastTitle || broadcastBody || broadcastRecipientIds.length > 0) && (
              <button
                type="button"
                onClick={handleClearBroadcastForm}
                style={{
                  padding: '2px 8px',
                  fontSize: '0.72rem',
                  background: 'transparent',
                  border: '1px solid var(--border-hover)',
                  borderRadius: '4px',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Xóa nội dung
              </button>
            )}
          </div>
          <input
            type="text"
            value={broadcastTitle}
            onChange={e => setBroadcastTitle(e.target.value)}
            placeholder="Tiêu đề thông báo"
            autoFocus
            className="premium-select"
            style={{
              backgroundImage: 'none',
              background: 'rgba(0,0,0,0.35)',
              padding: '10px 12px',
              width: '100%',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div className="form-group" style={{ marginBottom: '1.25rem' }}>
          <label style={{ fontSize: '0.82rem' }}>Nội dung</label>
          <textarea
            value={broadcastBody}
            onChange={e => setBroadcastBody(e.target.value)}
            placeholder="Nội dung thông báo..."
            rows={4}
            className="premium-select"
            style={{
              backgroundImage: 'none',
              background: 'rgba(0,0,0,0.35)',
              padding: '10px 12px',
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
            }}
          />
        </div>

        <div className="form-group" style={{ marginBottom: '1.25rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.5rem',
              gap: '0.5rem',
            }}
          >
            <label style={{ fontSize: '0.82rem', margin: 0 }}>Người nhận</label>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
              {broadcastRecipientIds.length > 0
                ? `${broadcastRecipientIds.length} đã chọn`
                : 'Tất cả (mặc định)'}
            </span>
          </div>
          {broadcastRecipientIds.length > 0 && (
            <button
              type="button"
              onClick={() => setBroadcastRecipientIds([])}
              style={{
                marginBottom: '0.5rem',
                padding: '2px 8px',
                fontSize: '0.72rem',
                background: 'transparent',
                border: '1px solid var(--border-hover)',
                borderRadius: '4px',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              Bỏ chọn — gửi tất cả
            </button>
          )}
          <div
            className="scrollable-area"
            style={{
              maxHeight: '140px',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.35rem',
              padding: '0.5rem',
              background: 'rgba(0,0,0,0.2)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
            }}
          >
            {loginRecipients.length === 0 ? (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                Chưa có tài khoản đăng nhập
              </span>
            ) : (
              loginRecipients.map(acc => {
                const checked = broadcastRecipientIds.includes(acc.id);
                return (
                  <label
                    key={acc.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontSize: '0.82rem',
                      color: checked ? 'var(--text-primary)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      padding: '0.25rem 0.15rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleBroadcastRecipient(acc.id)}
                    />
                    <span>{acc.displayName || acc.username}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      ({acc.appRole || 'user'})
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>

        {loadingBroadcasts ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              marginBottom: '1.25rem',
            }}
          >
            <Loader2 className="spinner" size={14} /> Đang tải lịch sử...
          </div>
        ) : (
          broadcastHistory.length > 0 && (
            <div style={{ marginBottom: '1.25rem' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.5rem',
                  gap: '0.5rem',
                }}
              >
                <h4
                  style={{
                    margin: 0,
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}
                >
                  Lịch sử gần đây
                </h4>
                <button
                  type="button"
                  onClick={handleClearAllBroadcasts}
                  disabled={clearingBroadcasts || sendingBroadcast}
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.72rem',
                    background: 'transparent',
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                    borderRadius: '4px',
                    color: '#f87171',
                    cursor: clearingBroadcasts ? 'not-allowed' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  {clearingBroadcasts ? (
                    <Loader2 className="spinner" size={12} />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Xóa tất cả
                </button>
              </div>
              <div
                className="scrollable-area"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  maxHeight: '160px',
                  overflowY: 'auto',
                  paddingRight: '4px',
                }}
              >
                {broadcastHistory.slice(0, 8).map(item => (
                  <div
                    key={item.id}
                    style={{
                      padding: '0.6rem 0.75rem',
                      background: 'rgba(0,0,0,0.2)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      fontSize: '0.8rem',
                      position: 'relative',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleDeleteBroadcast(item.id)}
                      disabled={clearingBroadcasts || sendingBroadcast}
                      title="Xóa thông báo"
                      style={{
                        position: 'absolute',
                        top: '6px',
                        right: '6px',
                        padding: '2px',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '1.5rem',
                        marginBottom: '0.25rem',
                        paddingRight: '1.25rem',
                      }}
                    >
                      <strong style={{ color: '#fde68a' }}>{item.title}</strong>
                      <span
                        style={{
                          color: 'var(--text-secondary)',
                          fontSize: '0.72rem',
                          flexShrink: 0,
                        }}
                      >
                        {new Date(item.created_at).toLocaleString('vi-VN')}
                      </span>
                    </div>
                    <div style={{ color: '#cbd5e1', whiteSpace: 'pre-wrap' }}>{item.body}</div>
                    <div
                      style={{
                        marginTop: '0.35rem',
                        fontSize: '0.72rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {item.recipient_usernames?.length
                        ? `Gửi tới: ${item.recipient_usernames.join(', ')}`
                        : 'Gửi tới: Tất cả'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        )}

        <div style={{ display: 'flex', gap: '0.65rem' }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setIsBroadcastModalOpen(false)}
            disabled={sendingBroadcast}
            style={{ flex: 1, marginTop: 0, padding: '10px' }}
          >
            Hủy
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSendBroadcast}
            disabled={sendingBroadcast}
            style={{
              flex: 1,
              marginTop: 0,
              padding: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            {sendingBroadcast ? <Loader2 className="spinner" size={18} /> : <Send size={18} />}
            {sendingBroadcast ? 'Đang gửi...' : 'Gửi thông báo'}
          </button>
        </div>
      </CommonModal>

      <CommonModal
        open={isPermModalOpen}
        onClose={() => setIsPermModalOpen(false)}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ShieldCheck color="#4ade80" size={22} /> Phân quyền Menu
          </span>
        }
        titleId="app-accounts-perm-modal-title"
        styleContent={{ maxWidth: '500px' }}
      >
        <p style={{ color: '#888', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          Thiết lập các menu mà tài khoản <strong>{editingAcc?.username}</strong> được phép truy
          cập.
        </p>

        <div
          className="scrollable-area"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            marginBottom: '2rem',
            maxHeight: '360px',
            overflowY: 'auto',
            paddingRight: '6px',
          }}
        >
          {allAvailableMenus.map(menu => (
            <div
              key={menu.key}
              onClick={() => handleTogglePerm(menu.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.75rem 1rem',
                background: selectedPerms.includes(menu.key)
                  ? 'rgba(74, 222, 128, 0.1)'
                  : 'var(--surface-muted)',
                border: `1px solid ${selectedPerms.includes(menu.key) ? 'rgba(74, 222, 128, 0.3)' : 'var(--border-color)'}`,
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '0.95rem', fontWeight: 500 }}>{menu.label}</span>
              </div>
              <div style={{ color: selectedPerms.includes(menu.key) ? '#4ade80' : '#444' }}>
                {selectedPerms.includes(menu.key) ? (
                  <ToggleRight size={28} />
                ) : (
                  <ToggleLeft size={28} />
                )}
              </div>
            </div>
          ))}
        </div>

        <button
          className="btn-primary"
          onClick={handleSavePermissions}
          disabled={savingPerms}
          style={{ width: '100%' }}
        >
          {savingPerms ? <Loader2 className="spinner" size={18} /> : <Check size={18} />}
          {savingPerms ? 'Đang lưu...' : 'Lưu phân quyền'}
        </button>
      </CommonModal>
      <CommonModal
        open={isPasswordModalOpen}
        onClose={() => setIsPasswordModalOpen(false)}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Lock color="#fbbf24" size={22} />{' '}
            {editingAcc?.canLogin ? 'Đổi mật khẩu' : 'Đặt mật khẩu đăng nhập'}
          </span>
        }
        titleId="app-accounts-password-modal-title"
        styleContent={{ maxWidth: '400px' }}
      >
        <p style={{ color: '#888', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
          {editingAcc?.canLogin ? (
            <>
              Đổi mật khẩu cho tài khoản <strong>{editingAcc?.username}</strong>.
            </>
          ) : (
            <>
              Bật đăng nhập cho{' '}
              <strong>
                {editingAcc?.displayName || editingAcc?.emailAddress || editingAcc?.accountId}
              </strong>
              . Username sẽ tự tạo từ email/tên.
            </>
          )}
        </p>

        <div className="form-group" style={{ marginBottom: '2rem' }}>
          <label>Mật khẩu mới</label>
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            placeholder="Nhập mật khẩu mới..."
            style={{
              width: '20.3rem',
              padding: '0.75rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'rgba(0,0,0,0.4)',
              color: 'white',
            }}
            autoFocus
          />
        </div>

        <button
          className="btn-primary"
          onClick={handleUpdatePassword}
          disabled={savingPassword || !newPassword}
          style={{
            width: '100%',
            background: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
            borderColor: '#fbbf24',
          }}
        >
          {savingPassword ? <Loader2 className="spinner" size={18} /> : <Check size={18} />}
          {savingPassword ? 'Đang lưu...' : 'Cập nhật mật khẩu'}
        </button>
      </CommonModal>
    </main>
  );
};

export default AppAccounts;
