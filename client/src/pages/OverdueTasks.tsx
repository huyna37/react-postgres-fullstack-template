import React, { useState, useEffect, useMemo, useCallback, startTransition } from 'react';
import { 
  Loader2, AlertCircle, Calendar, Clock, ExternalLink, RefreshCw, 
  Search, Users, CheckCircle2, ArrowUpDown, 
  ShieldAlert, Star, Sparkles, User, Info 
} from 'lucide-react';
import { showError, showSuccess } from '../utils/swal';
import { excerptTicketText } from '../utils/ticketText';
import { getAvatarUrl } from '../utils/avatar';
import type { User as AuthUser } from '../types';

interface UserAvatarProps {
  displayName: string;
  avatarUrl: string | null;
  size?: number;
  apiBaseUrl: string;
}

const UserAvatar: React.FC<UserAvatarProps> = ({ displayName, avatarUrl, size = 22, apiBaseUrl }) => {
  const [imgFailed, setImgFailed] = useState(!avatarUrl);

  useEffect(() => {
    setImgFailed(!avatarUrl);
  }, [avatarUrl]);

  if (avatarUrl && !imgFailed) {
    const proxiedUrl =
      avatarUrl.startsWith('data:') ? avatarUrl : getAvatarUrl(avatarUrl, apiBaseUrl);
      
    return (
      <img 
        src={proxiedUrl} 
        alt={displayName}
        style={{ width: `${size}px`, height: `${size}px`, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.2)', objectFit: 'cover' }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  const char = displayName?.charAt(0).toUpperCase() || '?';
  const gradients = [
    'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
    'linear-gradient(135deg, #4ade80 0%, #3b82f6 100%)',
    'linear-gradient(135deg, #f43f5e 0%, #f97316 100%)',
    'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
    'linear-gradient(135deg, #e11d48 0%, #b91c1c 100%)'
  ];
  const index = displayName ? displayName.charCodeAt(0) % gradients.length : 0;
  const gradient = gradients[index];

  return (
    <div style={{ 
      width: `${size}px`, 
      height: `${size}px`, 
      borderRadius: '50%', 
      background: gradient,
      fontSize: `${size * 0.4}px`,
      color: 'white',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 'bold',
      border: '1px solid rgba(255,255,255,0.2)'
    }}>
      {char}
    </div>
  );
};

const getTodayLocalString = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getFiveDaysAheadLocalString = () => {
  const date = new Date();
  date.setDate(date.getDate() + 5);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

type WorkflowTone = 'rose' | 'amber' | 'purple' | 'orange';

const getOverdueUrgencyTone = (dueDate: string | null, overdueDays: number): WorkflowTone => {
  if (!dueDate) return 'purple';
  if (overdueDays > 7) return 'rose';
  return 'amber';
};

interface OverdueTasksProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
  currentUser: AuthUser | null;
}

interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
  avatarUrl: string | null;
  role: string | null;
}

const OverdueTasks: React.FC<OverdueTasksProps> = ({ apiFetch, API_BASE_URL, openJiraTicket, currentUser }) => {
  const [tickets, setTickets] = useState<any[]>([]);
  const [activeUsers, setActiveUsers] = useState<JiraUser[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Filter and Search states
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUserFilter, setSelectedUserFilter] = useState<string>('all'); // 'all', 'me', or accountId
  const [sortBy, setSortBy] = useState<string>('dueDate-asc');

  // Selection and Batch Reschedule States
  const [selectedTicketKeys, setSelectedTicketKeys] = useState<string[]>([]);
  const [newDueDate, setNewDueDate] = useState<string>(getFiveDaysAheadLocalString());
  const [newStartDate, setNewStartDate] = useState<string>(getTodayLocalString());
  const [rescheduling, setRescheduling] = useState(false);

  const [activeProjects, setActiveProjects] = useState<{ jira_key: string; name: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState(
    () => currentUser?.jira_project || 'BXDCSDL'
  );

  const handleSelectTicket = (key: string) => {
    setSelectedTicketKeys(prev => 
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleBatchReschedule = async () => {
    if (selectedTicketKeys.length === 0) return;
    if (!newDueDate) {
      showError('Vui lòng chọn ngày hạn chót mới.');
      return;
    }

    setRescheduling(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/tickets/batch-reschedule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          keys: selectedTicketKeys,
          dueDate: newDueDate,
          startDate: newStartDate || undefined
        })
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          showSuccess(`Đã chuyển ${result.rescheduled.length} công việc sang ngày mới thành công.`);
          const rescheduledKeys: string[] = result.rescheduled || [];
          setTickets(prev => prev.filter(t => !rescheduledKeys.includes(t.key)));
          setSelectedTicketKeys([]);
          setNewDueDate(getFiveDaysAheadLocalString());
          setNewStartDate(getTodayLocalString());
          fetchOverdueTickets();
        } else {
          showError('Gia hạn công việc thất bại.');
        }
      } else {
        showError('Không thể gia hạn công việc.');
      }
    } catch (error) {
      console.error('Failed to batch reschedule:', error);
      showError('Đã xảy ra lỗi khi kết nối máy chủ.');
    } finally {
      setRescheduling(false);
    }
  };

  useEffect(() => {
    const fetchActiveProjects = async () => {
      try {
        const response = await apiFetch(`${API_BASE_URL}/api/projects/active`);
        if (response.ok) {
          const data = await response.json();
          setActiveProjects(data);
          if (data.length > 0) {
            const currentProj = currentUser?.jira_project || 'BXDCSDL';
            const exists = data.some((p: { jira_key: string }) => p.jira_key === currentProj);
            setSelectedProject(exists ? currentProj : data[0].jira_key);
          }
        }
      } catch (error) {
        console.error('Failed to fetch active projects:', error);
      }
    };
    if (currentUser) fetchActiveProjects();
  }, [apiFetch, API_BASE_URL, currentUser?.jira_project]);

  const fetchOverdueTickets = useCallback(async () => {
    if (!currentUser || !selectedProject) return;
    setLoadingTickets(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/api/tickets/overdue?all=true&projectKey=${encodeURIComponent(selectedProject)}`,
        { cache: 'no-store' }
      );
      if (response.ok) {
        const data = await response.json();
        setTickets(data);
        setSelectedTicketKeys([]);
      } else {
        showError('Không thể tải danh sách công việc quá hạn.');
      }
    } catch (error) {
      console.error('Failed to fetch overdue tickets:', error);
      showError('Đã xảy ra lỗi khi kết nối máy chủ.');
    } finally {
      setLoadingTickets(false);
    }
  }, [apiFetch, API_BASE_URL, currentUser, selectedProject]);

  const fetchActiveUsers = useCallback(async () => {
    if (!currentUser || !selectedProject) return;
    setLoadingUsers(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/api/users/active?projectKey=${encodeURIComponent(selectedProject)}`
      );
      if (response.ok) {
        const data = await response.json();
        setActiveUsers(data);
      }
    } catch (error) {
      console.error('Failed to fetch active users:', error);
    } finally {
      setLoadingUsers(false);
    }
  }, [apiFetch, API_BASE_URL, currentUser, selectedProject]);

  useEffect(() => {
    if (!currentUser || !selectedProject) return;
    fetchOverdueTickets();
    fetchActiveUsers();
  }, [currentUser, selectedProject, fetchOverdueTickets, fetchActiveUsers]);

  useEffect(() => {
    setSelectedUserFilter('all');
    setSelectedTicketKeys([]);
  }, [selectedProject]);

  // Find my Jira account ID based on username matching email or display name
  const myJiraUser = useMemo(() => {
    if (!currentUser || activeUsers.length === 0) return null;
    return activeUsers.find(u => 
      u.emailAddress?.toLowerCase().includes(currentUser.username.toLowerCase()) || 
      u.displayName?.toLowerCase().includes(currentUser.username.toLowerCase())
    );
  }, [currentUser, activeUsers]);

  const myAccountId = myJiraUser?.accountId;

  // Calculate stats for all tickets (unfiltered)
  const stats = useMemo(() => {
    const totalCount = tickets.length;
    const totalEstSecs = tickets.reduce((sum, t) => sum + (t.originalEstimate || 0), 0);
    const totalEstHours = totalEstSecs / 3600;
    
    // Unique assignees who have overdue tickets
    const affectedMembers = new Set(tickets.map(t => t.assignee?.accountId).filter(Boolean)).size;
    
    // Critical overdue bugs
    const criticalBugs = tickets.filter(t => t.issueType?.toLowerCase().includes('bug')).length;

    // Tickets with no end date
    const missingDueCount = tickets.filter(t => !t.dueDate).length;

    return {
      totalCount,
      totalEstHours,
      affectedMembers,
      criticalBugs,
      missingDueCount
    };
  }, [tickets]);

  // Compute ticket counts per member
  const memberTicketCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    tickets.forEach(t => {
      const accId = t.assignee?.accountId;
      if (accId) {
        counts[accId] = (counts[accId] || 0) + 1;
      }
    });
    return counts;
  }, [tickets]);

  // Filtered and sorted tickets
  const filteredTickets = useMemo(() => {
    return tickets.filter(t => {
      // 1. Assignee filter
      if (selectedUserFilter === 'me') {
        if (!myAccountId) {
          // If my account ID is not found, fallback to match displayName/email with currentUser.username
          const assigneeName = t.assignee?.displayName?.toLowerCase() || '';
          return assigneeName.includes(currentUser?.username?.toLowerCase() || '');
        }
        return t.assignee?.accountId === myAccountId;
      } else if (selectedUserFilter !== 'all') {
        return t.assignee?.accountId === selectedUserFilter;
      }

      return true;
    }).filter(t => {
      // 2. Search term (key or summary)
      if (!searchTerm) return true;
      const search = searchTerm.toLowerCase();
      const keyMatch = t.key?.toLowerCase().includes(search);
      const summaryMatch = t.summary?.toLowerCase().includes(search);
      return keyMatch || summaryMatch;
    }).sort((a, b) => {
      // 3. Sort options
      if (sortBy === 'dueDate-asc') {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return -1;
        if (!b.dueDate) return 1;
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      }
      if (sortBy === 'dueDate-desc') {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime();
      }
      if (sortBy === 'est-desc') {
        return (b.originalEstimate || 0) - (a.originalEstimate || 0);
      }
      if (sortBy === 'est-asc') {
        return (a.originalEstimate || 0) - (b.originalEstimate || 0);
      }
      if (sortBy === 'key-asc') {
        return a.key.localeCompare(b.key);
      }
      return 0;
    });
  }, [tickets, selectedUserFilter, searchTerm, sortBy, myAccountId, currentUser]);

  // Calculate overdue days helper
  const getOverdueDays = (dueDateStr: string | null) => {
    if (!dueDateStr) return 0;
    const due = new Date(dueDateStr);
    due.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffTime = today.getTime() - due.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : 0;
  };

  if (!currentUser) {
    return (
      <main className="glass-card" style={{ padding: '4rem 2rem', textAlign: 'center', maxWidth: '600px', margin: '4rem auto' }}>
        <AlertCircle size={60} color="#f87171" style={{ marginBottom: '1.5rem', filter: 'drop-shadow(0 0 10px rgba(248, 113, 113, 0.3))' }} />
        <h3 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.75rem' }}>Yêu cầu đăng nhập</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: 1.6 }}>
          Vui lòng đăng nhập hệ thống để quản lý và theo dõi danh sách các công việc quá hạn trong dự án.
        </p>
      </main>
    );
  }

  const isRefreshLoading = loadingTickets || loadingUsers;

  return (
    <main className="glass-card dashboard-main overdue-page workflow-page" style={{ 
      padding: '1.25rem', 
      display: 'flex', 
      flexDirection: 'column', 
      gap: '0.75rem', 
      height: 'calc(100vh - 1.5rem)', 
      boxSizing: 'border-box', 
      overflow: 'hidden' 
    }}>
      {/* 1. Header Section */}
      <div className="page-header-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <div style={{ 
            background: 'linear-gradient(135deg, #f43f5e 0%, #ef4444 100%)', 
            padding: '7px', 
            borderRadius: '8px',
            boxShadow: '0 2px 10px rgba(239, 68, 68, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <ShieldAlert size={16} color="white" />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.3px' }}>
              Bảng Việc Quá Hạn & Chưa Có Hạn
            </h2>
            <span className="page-header-subtitle">
              Theo dõi tiến độ bàn giao, nhân sự quá hạn và các công việc thiếu ngày hoàn thành.
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
          <select
            value={selectedProject}
            onChange={e => setSelectedProject(e.target.value)}
            className="premium-select workflow-project-select"
            title="Chọn dự án"
          >
            {activeProjects.length === 0 ? (
              <option value={selectedProject}>{selectedProject}</option>
            ) : (
              activeProjects.map(proj => (
                <option key={proj.jira_key} value={proj.jira_key}>
                  {proj.name} ({proj.jira_key})
                </option>
              ))
            )}
          </select>
          <button 
            className="filter-btn" 
            onClick={() => { fetchOverdueTickets(); fetchActiveUsers(); }} 
            disabled={isRefreshLoading}
            style={{ 
              padding: '6px 12px', 
              height: '32px', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.4rem', 
              borderRadius: '8px',
              background: 'var(--surface-muted)',
              border: '1px solid rgba(255,255,255,0.08)',
              cursor: 'pointer',
              transition: 'all 0.3s ease'
            }}
          >
            <RefreshCw size={13} className={isRefreshLoading ? 'spinner' : ''} />
            <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>Làm mới</span>
          </button>
        </div>
      </div>

      {/* 2. KPI Cards Panel */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', 
        gap: '0.75rem' 
      }}>
        {/* KPI 1 */}
        <div className="small-card page-kpi-card page-kpi-card--rose">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span className="page-kpi-label page-kpi-label--rose">Tổng trễ & Chưa hạn</span>
            <AlertCircle size={14} color="#f43f5e" />
          </div>
          <div className="page-kpi-value page-kpi-value--rose">{stats.totalCount}</div>
          <span className="page-kpi-hint page-kpi-hint--rose">
            Gồm {stats.totalCount - stats.missingDueCount} trễ, {stats.missingDueCount} chưa có hạn
          </span>
        </div>

        {/* KPI 2 */}
        <div className="small-card page-kpi-card page-kpi-card--amber">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span className="page-kpi-label page-kpi-label--amber">Tổng Est trễ</span>
            <Clock size={14} color="#fbbf24" />
          </div>
          <div className="page-kpi-value page-kpi-value--amber">{stats.totalEstHours.toFixed(1)}h</div>
          <span className="page-kpi-hint page-kpi-hint--amber">≈ {Math.ceil(stats.totalEstHours / 8)} ngày công</span>
        </div>

        {/* KPI 3 */}
        <div className="small-card page-kpi-card page-kpi-card--indigo">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span className="page-kpi-label page-kpi-label--indigo">Nhân sự ảnh hưởng</span>
            <Users size={14} color="#818cf8" />
          </div>
          <div className="page-kpi-value page-kpi-value--indigo">{stats.affectedMembers}</div>
          <span className="page-kpi-hint page-kpi-hint--indigo">Đang bị quá tải</span>
        </div>

        {/* KPI 4 */}
        <div className="small-card page-kpi-card page-kpi-card--purple">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
            <span className="page-kpi-label page-kpi-label--purple">Bug trễ hạn</span>
            <Sparkles size={14} color="#c084fc" />
          </div>
          <div className="page-kpi-value page-kpi-value--purple">{stats.criticalBugs}</div>
          <span className="page-kpi-hint page-kpi-hint--purple">Bugs nghiêm trọng</span>
        </div>
      </div>

      {/* Reschedule Action Panel (visible only when items are selected) */}
      {selectedTicketKeys.length > 0 && (
        <div style={{
          background: 'rgba(99, 102, 241, 0.08)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
          borderRadius: '12px',
          padding: '0.75rem 1.25rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          boxShadow: '0 4px 20px rgba(99, 102, 241, 0.1)',
          animation: 'slideUp 0.3s ease-out'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              background: 'var(--primary)',
              color: 'white',
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: '0.8rem'
            }}>
              {selectedTicketKeys.length}
            </div>
            <div>
              <strong style={{ fontSize: '0.85rem', color: 'white' }}>Công việc đang được chọn</strong>
              <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                Bạn có thể thay đổi hạn chót đồng loạt cho các công việc này.
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Ngày bắt đầu (tùy chọn):</span>
            <input 
              type="date"
              value={newStartDate}
              onChange={(e) => setNewStartDate(e.target.value)}
              style={{
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: 'white',
                padding: '0.4rem 0.65rem',
                borderRadius: '8px',
                fontSize: '0.8rem',
                outline: 'none',
                marginRight: '0.5rem'
              }}
            />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Hạn chót mới:</span>
            <input 
              type="date"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              style={{
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: 'white',
                padding: '0.4rem 0.65rem',
                borderRadius: '8px',
                fontSize: '0.8rem',
                outline: 'none'
              }}
            />
            <button
              onClick={handleBatchReschedule}
              disabled={rescheduling || !newDueDate}
              className="filter-btn"
              style={{
                background: 'var(--primary)',
                borderColor: 'var(--primary)',
                color: 'white',
                padding: '0.4rem 1rem',
                borderRadius: '8px',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                transition: 'all 0.2s'
              }}
            >
              {rescheduling ? (
                <>
                  <Loader2 size={13} className="spinner" />
                  <span>Đang xử lý...</span>
                </>
              ) : (
                <>
                  <Calendar size={13} />
                  <span>Gia hạn hàng loạt</span>
                </>
              )}
            </button>
            <button
              onClick={() => setSelectedTicketKeys([])}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#ef4444',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Hủy chọn
            </button>
          </div>
        </div>
      )}

      {/* 3. Main Dashboard Layout (Split) */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'minmax(240px, 280px) 1fr', 
        gap: '1.5rem',
        alignItems: 'stretch',
        flex: 1,
        minHeight: 0,
        overflow: 'hidden'
      }} className="responsive-dashboard-grid">
        
        {/* Left Column: Team & Member Quick Filters */}
        <div style={{ 
          background: 'rgba(255, 255, 255, 0.01)',
          border: '1px solid var(--surface-muted)',
          borderRadius: '16px',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
            <Users size={16} color="var(--primary)" />
            <h3 className="workflow-sidebar__title">Nhân sự dự án</h3>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1, minHeight: 0 }}>
            {/* Filter All Option */}
            <button 
              onClick={() => setSelectedUserFilter('all')}
              className="tab-btn"
              style={{
                background: selectedUserFilter === 'all' ? 'linear-gradient(90deg, rgba(99, 102, 241, 0.15), transparent)' : 'transparent',
                borderLeft: selectedUserFilter === 'all' ? '3px solid var(--primary)' : '3px solid transparent',
                borderRadius: selectedUserFilter === 'all' ? '0 8px 8px 0' : '8px',
                color: selectedUserFilter === 'all' ? 'white' : 'var(--text-secondary)',
                fontWeight: selectedUserFilter === 'all' ? 700 : 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.6rem 0.8rem',
                width: '100%',
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Users size={14} />
                <span>Tất cả thành viên</span>
              </div>
              <span style={{ 
                fontSize: '0.7rem', 
                background: selectedUserFilter === 'all' ? 'var(--primary)' : 'var(--border-color)', 
                color: 'white', 
                padding: '2px 6px', 
                borderRadius: '10px', 
                fontWeight: 700 
              }}>
                {tickets.length}
              </span>
            </button>

            {/* Filter My Tasks Option */}
            <button 
              onClick={() => setSelectedUserFilter('me')}
              className="tab-btn"
              style={{
                background: selectedUserFilter === 'me' ? 'linear-gradient(90deg, rgba(239, 68, 68, 0.15), transparent)' : 'transparent',
                borderLeft: selectedUserFilter === 'me' ? '3px solid #ef4444' : '3px solid transparent',
                borderRadius: selectedUserFilter === 'me' ? '0 8px 8px 0' : '8px',
                color: selectedUserFilter === 'me' ? 'white' : 'var(--text-secondary)',
                fontWeight: selectedUserFilter === 'me' ? 700 : 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.6rem 0.8rem',
                width: '100%',
                cursor: 'pointer'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Star size={14} color="#f43f5e" />
                <span>Cá nhân tôi</span>
              </div>
              <span style={{ 
                fontSize: '0.7rem', 
                background: selectedUserFilter === 'me' ? '#ef4444' : 'var(--border-color)', 
                color: 'white', 
                padding: '2px 6px', 
                borderRadius: '10px', 
                fontWeight: 700 
              }}>
                {tickets.filter(t => myAccountId ? t.assignee?.accountId === myAccountId : t.assignee?.displayName?.toLowerCase().includes(currentUser.username.toLowerCase())).length}
              </span>
            </button>

            {/* Scrollable Container for active team members list */}
            <div 
              style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                gap: '0.4rem', 
                flex: 1, 
                overflowY: 'auto',
                paddingRight: '4px',
                borderTop: '1px solid var(--border-color)',
                paddingTop: '0.5rem',
                marginTop: '0.25rem',
                maxHeight: '31rem',
                paddingBottom: '1.5rem'
              }} 
              className="scrollable-area"
            >
              {/* List of active team members */}
              {loadingUsers ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem 0' }}>
                  <Loader2 size={20} className="spinner" color="var(--primary)" />
                </div>
              ) : activeUsers.length === 0 ? (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', textAlign: 'center', margin: '1rem 0' }}>Không tìm thấy nhân sự</p>
              ) : (
                activeUsers.map(user => {
                  const count = memberTicketCounts[user.accountId] || 0;
                  const isMe = user.accountId === myAccountId;
                  const isActive = selectedUserFilter === user.accountId;
                  
                  return (
                    <button 
                      key={user.accountId}
                      onClick={() => setSelectedUserFilter(user.accountId)}
                      className="tab-btn"
                      style={{
                        background: isActive ? 'linear-gradient(90deg, rgba(99, 102, 241, 0.15), transparent)' : 'transparent',
                        borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                        borderRadius: isActive ? '0 8px 8px 0' : '8px',
                        color: isActive ? 'white' : 'var(--text-secondary)',
                        fontWeight: isActive ? 700 : 500,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.5rem 0.6rem',
                        width: '100%',
                        cursor: 'pointer'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflow: 'hidden' }}>
                        <UserAvatar 
                          displayName={user.displayName} 
                          avatarUrl={user.avatarUrl} 
                          size={22} 
                          apiBaseUrl={API_BASE_URL} 
                        />
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', overflow: 'hidden' }}>
                          <span style={{ fontSize: '0.8rem', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', maxWidth: '140px' }}>
                            {user.displayName} {isMe && <span style={{ fontSize: '0.65rem', color: '#fbbf24' }}>(Tôi)</span>}
                          </span>
                          {user.role && (
                            <span style={{ fontSize: '0.6rem', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                              {user.role}
                            </span>
                          )}
                        </div>
                      </div>
                      {count > 0 ? (
                        <span style={{ 
                          fontSize: '0.7rem', 
                          background: isActive ? '#f43f5e' : 'rgba(244,63,94,0.15)', 
                          color: isActive ? 'white' : '#f87171', 
                          padding: '1px 5px', 
                          borderRadius: '10px', 
                          fontWeight: 700,
                          border: isActive ? 'none' : '1px solid rgba(244,63,94,0.3)'
                        }}>
                          {count}
                        </span>
                      ) : (
                        <CheckCircle2 size={13} color="#4ade80" style={{ opacity: 0.6 }} />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Dynamic Stats, Filters, and Overdue Tasks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', height: '100%', overflow: 'hidden' }}>
          
          {/* 3a. Search and Filters Toolbar */}
          <div style={{ 
            background: 'rgba(255, 255, 255, 0.01)',
            border: '1px solid var(--surface-muted)',
            borderRadius: '16px',
            padding: '1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '1rem'
          }}>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              {/* Text Search */}
              <div style={{ position: 'relative', flex: '1', minWidth: '220px' }}>
                <Search size={16} color="var(--text-secondary)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
                <input 
                  type="text"
                  placeholder="Tìm kiếm theo mã task, tiêu đề..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid var(--border-color)',
                    color: 'white',
                    padding: '0.65rem 1rem 0.65rem 2.25rem',
                    borderRadius: '10px',
                    fontSize: '0.85rem',
                    outline: 'none',
                    transition: 'all 0.3s ease'
                  }}
                  className="project-input"
                />
              </div>

              {/* Sort selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: '180px' }}>
                <ArrowUpDown size={14} color="var(--text-secondary)" />
                <select 
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="premium-select"
                  style={{ margin: 0, padding: '0.5rem 2rem 0.5rem 1rem', height: '38px', borderRadius: '10px' }}
                >
                  <option value="dueDate-asc">Hạn chót: Tăng dần</option>
                  <option value="dueDate-desc">Hạn chót: Giảm dần</option>
                  <option value="est-desc">Ước lượng: Giảm dần</option>
                  <option value="est-asc">Ước lượng: Tăng dần</option>
                  <option value="key-asc">Mã công việc: A-Z</option>
                </select>
              </div>
            </div>


          </div>

          {/* 3b. Overdue Tasks Grid List */}
          {loadingTickets && tickets.length === 0 ? (
            <div className="dashboard-initial-loading" style={{ padding: '6rem 0' }}>
              <Loader2 className="spinner" size={48} color="var(--primary)" />
              <p>Đang quét các công việc trễ hạn từ Jira...</p>
            </div>
          ) : filteredTickets.length === 0 ? (
            <div style={{ 
              textAlign: 'center', 
              padding: '6rem 2rem', 
              background: 'rgba(255,255,255,0.01)', 
              borderRadius: '20px', 
              border: '1px dashed var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '1rem'
            }}>
              <div style={{ fontSize: '3.5rem' }}>🎉</div>
              <h3 style={{ margin: 0, color: '#4ade80', fontSize: '1.2rem', fontWeight: 700 }}>Không tìm thấy công việc trễ hạn</h3>
              <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.85rem', maxWidth: '380px', lineHeight: 1.6 }}>
                Không có công việc nào trễ hạn thỏa mãn các điều kiện bộ lọc của bạn. Thật tuyệt vời!
              </p>
            </div>
          ) : (
            <div
              className={`page-content-wrap${loadingTickets && tickets.length > 0 ? ' page-content-wrap--refreshing' : ''}`}
              style={{ position: 'relative' }}
            >
              {loadingTickets && tickets.length > 0 && (
                <div className="page-refresh-bar" aria-hidden />
              )}
            <>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                <span>Hiển thị <strong>{filteredTickets.length}</strong> / <strong>{tickets.length}</strong> công việc quá hạn</span>
                {filteredTickets.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', fontSize: '0.78rem', color: 'white', fontWeight: 600 }}>
                    <input 
                      type="checkbox"
                      checked={filteredTickets.length > 0 && filteredTickets.every(t => selectedTicketKeys.includes(t.key))}
                      onChange={() => {
                        const filteredKeys = filteredTickets.map(t => t.key);
                        const isAllSelected = filteredKeys.every(k => selectedTicketKeys.includes(k));
                        if (isAllSelected) {
                          setSelectedTicketKeys(prev => prev.filter(k => !filteredKeys.includes(k)));
                        } else {
                          setSelectedTicketKeys(prev => Array.from(new Set([...prev, ...filteredKeys])));
                        }
                      }}
                      style={{ 
                        width: '14px', 
                        height: '14px', 
                        accentColor: 'var(--primary)', 
                        cursor: 'pointer' 
                      }}
                    />
                    <span>Chọn tất cả</span>
                  </label>
                )}
              </div>
              <div 
                style={{ 
                  flex: 1, 
                  overflowY: 'auto', 
                  paddingRight: '6px',
                  marginTop: '0.75rem',
                  maxHeight: '31rem',
                  paddingBottom: '2.5rem'
                }} 
                className="scrollable-area"
              >
                <div className="dashboard-tickets workflow-tickets-grid">
                  {filteredTickets.map(t => {
                  const isBug = t.issueType?.toLowerCase().includes('bug');
                  const formattedDue = t.dueDate ? new Date(t.dueDate).toLocaleDateString('vi-VN') : 'Chưa cấu hình';
                  const formattedStart = t.startDate ? new Date(t.startDate).toLocaleDateString('vi-VN') : 'N/A';
                  const overdueDays = getOverdueDays(t.dueDate);
                  const tone = getOverdueUrgencyTone(t.dueDate, overdueDays);
                  
                  // Progress metrics
                  const originalEstimateSec = t.originalEstimate || 0;
                  const timeSpentSec = t.timeSpent || 0;
                  const progressPercentage = originalEstimateSec > 0 ? Math.min(100, Math.round((timeSpentSec / originalEstimateSec) * 100)) : 0;
                  const descriptionExcerpt = excerptTicketText(t.description);
                  const showProgress = originalEstimateSec > 0 || timeSpentSec > 0;

                  return (
                    <div 
                      key={t.id} 
                      className={`dashboard-ticket-item workflow-ticket-card workflow-ticket-card--${tone}`}
                    >
                      <div className={`workflow-ticket-bar workflow-ticket-bar--${tone}`} />
                      <div className="workflow-ticket-card__inner">
                        <div className="workflow-ticket-header">
                          <div className="workflow-ticket-header__left">
                            <input 
                              type="checkbox"
                              checked={selectedTicketKeys.includes(t.key)}
                              onChange={() => handleSelectTicket(t.key)}
                              style={{ 
                                width: '14px', 
                                height: '14px', 
                                accentColor: 'var(--primary)', 
                                cursor: 'pointer',
                                margin: 0,
                                flexShrink: 0
                              }}
                            />
                            <button 
                              type="button"
                              onClick={() => openJiraTicket(t.key)}
                              className={`filter-btn workflow-ticket-key workflow-ticket-key--${tone}`}
                            >
                              {t.key} <ExternalLink size={9} />
                            </button>
                            <span className={`workflow-urgency-badge workflow-urgency-badge--${tone}`}>
                              {!t.dueDate ? 'Chưa có hạn' : `Trễ ${overdueDays} ngày`}
                            </span>
                          </div>
                          <span className="overdue-ticket-status workflow-ticket-header__status">
                            {t.status}
                          </span>
                        </div>

                        <div className="workflow-ticket-card__content">
                          {t.parentKey && (
                            <span className="workflow-ticket__parent">Thuộc {t.parentKey}</span>
                          )}
                          <h4 className="workflow-ticket__title" title={t.summary}>
                            {t.summary}
                          </h4>
                          {descriptionExcerpt && (
                            <p className="workflow-ticket__description" title={descriptionExcerpt}>
                              {descriptionExcerpt}
                            </p>
                          )}
                        </div>

                        <div className="workflow-ticket-card__footer">
                          <div className="workflow-ticket-assignee-row">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flex: 1, minWidth: 0 }}>
                              {t.assignee ? (
                                <UserAvatar 
                                  displayName={t.assignee.displayName} 
                                  avatarUrl={t.assignee.avatarUrl} 
                                  size={24} 
                                  apiBaseUrl={API_BASE_URL} 
                                />
                              ) : (
                                <div style={{ 
                                  width: '24px', 
                                  height: '24px', 
                                  borderRadius: '50%', 
                                  background: 'var(--border-color)', 
                                  border: '1px dashed var(--border-color)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0
                                }}>
                                  <User size={11} color="var(--text-secondary)" />
                                </div>
                              )}
                              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: '1px' }}>
                                <span className="overdue-ticket__assignee" title={t.assignee ? t.assignee.displayName : 'Chưa phân công'}>
                                  {t.assignee ? t.assignee.displayName : 'Chưa phân công'}
                                </span>
                                {t.creator && (
                                  <span className="workflow-ticket-creator" title={`Tạo bởi: ${t.creator}`}>
                                    Tạo bởi: {t.creator}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="workflow-ticket-chips">
                            {t.issueType && (
                              <span className={`workflow-issue-chip ${isBug ? 'workflow-issue-chip--bug' : 'workflow-issue-chip--default'}`}>
                                {t.issueType}
                              </span>
                            )}
                            {originalEstimateSec > 0 && (
                              <span className="workflow-est-chip">
                                Est: {(originalEstimateSec / 3600).toFixed(1)}h
                              </span>
                            )}
                            {timeSpentSec > 0 && (
                              <span className="workflow-logged-chip">
                                Logged: {(timeSpentSec / 3600).toFixed(1)}h
                              </span>
                            )}
                          </div>

                          {showProgress && (
                            <div className="workflow-ticket-progress">
                              <div className="workflow-ticket-progress-label">
                                <span>Tiến trình ước lượng</span>
                                <span className="overdue-ticket__progress-pct">{progressPercentage}%</span>
                              </div>
                              <div style={{ width: '100%', height: '4px', background: 'var(--border-color)', borderRadius: '10px', overflow: 'hidden' }}>
                                <div style={{ 
                                  width: `${progressPercentage}%`, 
                                  height: '100%', 
                                  background: progressPercentage === 100 ? '#4ade80' : 'linear-gradient(90deg, #6366f1, #a855f7)', 
                                  borderRadius: '10px',
                                  transition: 'width 0.4s ease'
                                }} />
                              </div>
                            </div>
                          )}

                          <div className="workflow-ticket-dates">
                            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                              <Calendar size={12} style={{ opacity: 0.7 }} />
                              <span>Bắt đầu: <strong className="overdue-ticket__meta-strong">{t.startDate ? formattedStart : 'Chưa rõ'}</strong></span>
                            </span>
                            <span className={`workflow-due-date workflow-due-date--${tone}`}>
                              <Clock size={12} />
                              <span>Hạn chót: <strong>{formattedDue}</strong></span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>
            </>
            </div>
          )}
        </div>
      </div>
    </main>
  );
};

export default OverdueTasks;

