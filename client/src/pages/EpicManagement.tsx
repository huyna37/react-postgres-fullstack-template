import React, { useState, useEffect, useMemo } from 'react';
import { Loader2, Plus, FolderGit2, AlertTriangle, ChevronDown, ChevronRight, ExternalLink, RefreshCw, BarChart2, LayoutGrid, List, ArrowUpDown } from 'lucide-react';
import { showSuccess, showError } from '../utils/swal';
import type { User } from '../types';

interface EpicManagementProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
  currentUser: User | null;
}

const isDoneStatus = (status: any) => {
  const cat =
    status?.statusCategory?.name?.toLowerCase() ??
    status?.statusCategory?.key?.toLowerCase() ??
    (typeof status?.statusCategory === 'string' ? status.statusCategory.toLowerCase() : '');
  const name = (status?.name ?? '').toLowerCase();
  if (cat === 'done') return true;
  return /done|closed|resolved|complete|completed|hoàn thành|đóng/.test(name);
};

const epicDescriptionText = (description: unknown): string => {
  if (!description) return '';
  if (typeof description === 'string') return description.replace(/<[^>]+>/g, '').trim();
  return '';
};

/** 0 = To Do, 1 = In Progress, 2 = Done — dùng để sort epic theo trạng thái */
const epicStatusOrder = (epic: any): number => {
  const cat = epic.fields?.status?.statusCategory?.key?.toLowerCase()
    || epic.fields?.status?.statusCategory?.name?.toLowerCase()
    || '';
  if (cat === 'done') return 2;
  if (cat === 'indeterminate' || cat.includes('progress')) return 1;
  return 0;
};

type EpicSort = 'status-open-first' | 'status-done-first' | 'name-asc' | 'key-desc';

const CHILD_SCROLL_THRESHOLD = 8;

const EpicManagement: React.FC<EpicManagementProps> = ({ apiFetch, API_BASE_URL, openJiraTicket, currentUser }) => {
  const [epics, setEpics] = useState<any[]>([]);
  const [children, setChildren] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedEpics, setExpandedEpics] = useState<Record<string, boolean>>({});
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [epicSort, setEpicSort] = useState<EpicSort>('status-open-first');

  const [activeProjects, setActiveProjects] = useState<{ jira_key: string; name: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState(() => {
    return currentUser?.jira_project || "BXDCSDL";
  });

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newSummary, setNewSummary] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Fetch active projects on mount
  useEffect(() => {
    const fetchActiveProjects = async () => {
      try {
        const response = await apiFetch(`${API_BASE_URL}/api/projects/active`);
        if (response.ok) {
          const data = await response.json();
          setActiveProjects(data);
          if (data.length > 0) {
            const currentProj = currentUser?.jira_project || "BXDCSDL";
            const exists = data.some((p: any) => p.jira_key === currentProj);
            if (exists) {
              setSelectedProject(currentProj);
            } else {
              setSelectedProject(data[0].jira_key);
            }
          }
        }
      } catch (error) {
        console.error("Failed to fetch active projects:", error);
      }
    };
    fetchActiveProjects();
  }, [apiFetch, API_BASE_URL, currentUser?.jira_project]);

  const loadEpics = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/epics?projectKey=${selectedProject}`);
      if (res.ok) {
        const data = await res.json();
        setEpics(data.epics || []);
        setChildren(data.children || []);
      } else {
        throw new Error('Không thể tải danh sách Epic.');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi tải dữ liệu Epic.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEpics();
  }, [selectedProject]);

  const handleCreateEpic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSummary.trim()) {
      showError('Vui lòng nhập tên Epic.');
      return;
    }

    setCreating(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/epics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          summary: newSummary, 
          description: newDescription,
          projectKey: selectedProject
        }),
      });

      if (res.ok) {
        showSuccess('Tạo Epic mới trên Jira thành công!');
        setNewSummary('');
        setNewDescription('');
        setShowCreateForm(false);
        loadEpics();
      } else {
        const errData = await res.json();
        throw new Error(errData.error || 'Lỗi tạo Epic');
      }
    } catch (err: any) {
      showError(err.message || 'Gặp lỗi khi tạo Epic.');
    } finally {
      setCreating(false);
    }
  };

  const toggleExpand = (epicKey: string) => {
    setExpandedEpics(prev => ({ ...prev, [epicKey]: !prev[epicKey] }));
  };

  const expandAll = () => {
    const all: Record<string, boolean> = {};
    epics.forEach(e => { all[e.key] = true; });
    setExpandedEpics(all);
  };

  const collapseAll = () => setExpandedEpics({});

  const getEpicStats = (epicKey: string) => {
    const epicChildList = children.filter(c => {
      const epicLink = c.fields.customfield_10008 || c.fields.customfield_10014 || c.fields.customfield_10201 || c.fields.parent?.key;
      return epicLink === epicKey;
    });

    const totalStories = epicChildList.length;
    const resolvedStories = epicChildList.filter(c => isDoneStatus(c.fields.status)).length;

    let totalEst = 0;
    let resolvedEst = 0;
    epicChildList.forEach(c => {
      const est = (c.fields.timeoriginalestimate || 0) / 3600;
      totalEst += est;
      if (isDoneStatus(c.fields.status)) resolvedEst += est;
    });

    return { totalStories, resolvedStories, totalEst, resolvedEst, epicChildList };
  };

  const overallStats = useMemo(() => {
    let totalStories = 0;
    let resolvedStories = 0;
    epics.forEach(epic => {
      const epicChildList = children.filter(c => {
        const epicLink = c.fields.customfield_10008 || c.fields.customfield_10014 || c.fields.customfield_10201 || c.fields.parent?.key;
        return epicLink === epic.key;
      });
      totalStories += epicChildList.length;
      resolvedStories += epicChildList.filter(c => isDoneStatus(c.fields.status)).length;
    });
    const progress = totalStories > 0 ? Math.round((resolvedStories / totalStories) * 100) : 0;
    return { totalStories, resolvedStories, progress };
  }, [epics, children]);

  const sortedEpics = useMemo(() => {
    const list = [...epics];
    list.sort((a, b) => {
      switch (epicSort) {
        case 'status-open-first': {
          const diff = epicStatusOrder(a) - epicStatusOrder(b);
          return diff !== 0 ? diff : a.key.localeCompare(b.key);
        }
        case 'status-done-first': {
          const diff = epicStatusOrder(b) - epicStatusOrder(a);
          return diff !== 0 ? diff : b.key.localeCompare(a.key);
        }
        case 'name-asc':
          return (a.fields.summary || '').localeCompare(b.fields.summary || '', 'vi');
        case 'key-desc':
        default:
          return b.key.localeCompare(a.key);
      }
    });
    return list;
  }, [epics, epicSort]);

  if (!currentUser) {
    return (
      <main className="glass-card" style={{ padding: '3rem', textAlign: 'center' }}>
        <AlertTriangle size={48} color="#f87171" style={{ marginBottom: '1rem' }} />
        <h3>Yêu cầu đăng nhập</h3>
        <p style={{ color: 'var(--text-secondary)' }}>Vui lòng đăng nhập hệ thống để quản lý Epic.</p>
      </main>
    );
  }

  return (
    <main className="glass-card dashboard-main" style={{
      padding: '1rem 1.15rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.55rem',
      height: 'calc(100vh - 2.2rem)',
      boxSizing: 'border-box',
      overflow: 'hidden',
    }}>
      <div className="epic-page">
        {/* Header */}
        <div className="epic-header">
          <div>
            <h2 className="epic-header-title">
              <FolderGit2 color="#818cf8" size={22} /> Quản lý Epic
              {epics.length > 0 && (
                <span className="epic-stat-chip" style={{ fontSize: '0.68rem', padding: '2px 8px' }}>{epics.length}</span>
              )}
            </h2>
            <p className="epic-header-desc">Theo dõi tiến độ Story/Task con và tạo Epic trên Jira.</p>
          </div>
          <div className="epic-header-actions">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <select
                value={selectedProject}
                onChange={e => setSelectedProject(e.target.value)}
                className="premium-select epic-sort-select"
                title="Chọn dự án"
                style={{ width: 'auto', minWidth: '120px' }}
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
            </div>
            <div className="planning-segment">
              <button type="button" className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')}>
                <LayoutGrid size={13} /> Lưới
              </button>
              <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
                <List size={13} /> List
              </button>
            </div>
            {epics.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ArrowUpDown size={13} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                  <select
                    value={epicSort}
                    onChange={e => setEpicSort(e.target.value as EpicSort)}
                    className="premium-select epic-sort-select"
                    title="Sắp xếp Epic"
                  >
                    <option value="status-open-first">Trạng thái: đang mở trước</option>
                    <option value="status-done-first">Trạng thái: Done trước</option>
                    <option value="name-asc">Tên A → Z</option>
                    <option value="key-desc">Key mới nhất</option>
                  </select>
                </div>
                <button type="button" onClick={expandAll} className="filter-btn epic-btn-sm">Mở tất cả</button>
                <button type="button" onClick={collapseAll} className="filter-btn epic-btn-sm">Thu gọn</button>
              </>
            )}
            <button onClick={loadEpics} className="filter-btn epic-btn-sm" disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spinner' : ''} /> Tải lại
            </button>
            <button onClick={() => setShowCreateForm(!showCreateForm)} className="btn-primary epic-btn-sm" style={{ width: 'auto', marginTop: 0 }}>
              <Plus size={14} /> Tạo Epic
            </button>
          </div>
        </div>

        {/* Summary bar */}
        {epics.length > 0 && !loading && (
          <div className="epic-summary-bar">
            <span className="epic-stat-chip"><strong>{epics.length}</strong> Epic</span>
            <span className="epic-stat-chip"><strong>{overallStats.totalStories}</strong> Story/Task</span>
            <span className="epic-stat-chip epic-stat-chip--green">
              <strong>{overallStats.resolvedStories}/{overallStats.totalStories}</strong> Done ({overallStats.progress}%)
            </span>
          </div>
        )}

        {/* Create form */}
        {showCreateForm && (
          <div className="epic-create-form">
            <h4>Tạo Epic mới trên Jira</h4>
            <form onSubmit={handleCreateEpic}>
              <div className="epic-create-grid">
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.75rem' }}>Tên Epic</label>
                  <input
                    type="text"
                    value={newSummary}
                    onChange={e => setNewSummary(e.target.value)}
                    className="premium-select"
                    placeholder="Nhập tên Epic..."
                    style={{ backgroundImage: 'none', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', fontSize: '0.8rem' }}
                    required
                  />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label style={{ fontSize: '0.75rem' }}>Mô tả</label>
                  <textarea
                    value={newDescription}
                    onChange={e => setNewDescription(e.target.value)}
                    className="premium-select"
                    placeholder="Mô tả Epic..."
                    rows={2}
                    style={{ backgroundImage: 'none', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', resize: 'none', fontSize: '0.8rem' }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowCreateForm(false)} className="btn-secondary epic-btn-sm" style={{ width: 'auto', marginTop: 0 }}>
                  Hủy
                </button>
                <button type="submit" disabled={creating} className="btn-primary epic-btn-sm" style={{ width: 'auto', marginTop: 0 }}>
                  {creating ? <Loader2 size={14} className="spinner" /> : null} Tạo Epic
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Epic list */}
        {loading && epics.length === 0 ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, flexDirection: 'column', gap: '0.75rem' }}>
            <Loader2 className="spinner" size={32} color="#818cf8" />
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Đang tải Epic từ Jira...</span>
          </div>
        ) : epics.length === 0 ? (
          <div className="epic-empty">
            <FolderGit2 size={40} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
            <h4 style={{ margin: '0 0 0.35rem' }}>Không có Epic</h4>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: 0 }}>Chưa có Epic nào trong dự án Jira.</p>
          </div>
        ) : (
          <div className={`epic-list scrollable-area${viewMode === 'list' ? ' epic-list--single' : ''}`}>
            {sortedEpics.map(epic => {
              const isExpanded = !!expandedEpics[epic.key];
              const { totalStories, resolvedStories, totalEst, resolvedEst, epicChildList } = getEpicStats(epic.key);
              const progressPercent = totalStories > 0 ? Math.round((resolvedStories / totalStories) * 100) : 0;
              const progressEstPercent = totalEst > 0 ? Math.round((resolvedEst / totalEst) * 100) : 0;
              const epicStatus = epic.fields.status?.name || 'To Do';
              const isDone = isDoneStatus(epic.fields.status);
              const desc = epicDescriptionText(epic.fields.description);

              return (
                <div key={epic.key} className={`epic-card${isDone ? ' epic-card--done' : ''}`}>
                  <div className="epic-card-head">
                    <button type="button" onClick={() => toggleExpand(epic.key)} className="epic-expand-btn" title={isExpanded ? 'Thu gọn' : 'Xem Story con'}>
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>

                    <div className="epic-card-body">
                      <div className="epic-card-top">
                        <span className="epic-key">{epic.key}</span>
                        <span className="epic-summary" title={epic.fields.summary}>{epic.fields.summary}</span>
                        <span className={`epic-status ${isDone ? 'epic-status--done' : 'epic-status--open'}`}>{epicStatus}</span>
                        <button
                          type="button"
                          onClick={() => openJiraTicket(epic.key)}
                          className="filter-btn epic-jira-btn"
                          title="Mở trên Jira"
                        >
                          Jira <ExternalLink size={10} />
                        </button>
                      </div>

                      {desc && <p className="epic-desc" title={desc}>{desc}</p>}

                      <div className="epic-progress-row">
                        <div className="epic-progress-item">
                          <div className="epic-progress-label">
                            <span>Stories</span>
                            <strong>{resolvedStories}/{totalStories} ({progressPercent}%)</strong>
                          </div>
                          <div className="epic-bar-track">
                            <div className="epic-bar-fill epic-bar-fill--story" style={{ width: `${progressPercent}%` }} />
                          </div>
                        </div>
                        <div className="epic-progress-item">
                          <div className="epic-progress-label">
                            <span>Thời gian</span>
                            <strong>{resolvedEst.toFixed(0)}h/{totalEst.toFixed(0)}h ({progressEstPercent}%)</strong>
                          </div>
                          <div className="epic-bar-track">
                            <div className="epic-bar-fill epic-bar-fill--time" style={{ width: `${progressEstPercent}%` }} />
                          </div>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="epic-children">
                          <h5 className="epic-children-title">
                            <BarChart2 size={12} /> Story & Task ({epicChildList.length})
                          </h5>

                          {epicChildList.length === 0 ? (
                            <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', margin: 0 }}>Chưa có tác vụ con.</p>
                          ) : (
                            <div className="epic-child-table">
                              <div className="epic-child-head">
                                <span>Key</span>
                                <span>Summary</span>
                                <span>Assignee</span>
                                <span>Status</span>
                                <span style={{ textAlign: 'right' }}>Est</span>
                                <span />
                              </div>
                              <div className="epic-child-scroll">
                                {epicChildList.map(child => {
                                  const childStatus = child.fields.status?.name || 'To Do';
                                  const isChildDone = isDoneStatus(child.fields.status);
                                  const childEst = (child.fields.timeoriginalestimate || 0) / 3600;
                                  const assignee = child.fields.assignee?.displayName;

                                  return (
                                    <div key={child.key} className="epic-child-row">
                                      <span className="epic-child-key">{child.key}</span>
                                      <span className="epic-child-summary" title={child.fields.summary}>{child.fields.summary}</span>
                                      <span className="epic-child-assignee" title={assignee}>{assignee || '—'}</span>
                                      <span className={`epic-child-status ${isChildDone ? 'epic-child-status--done' : 'epic-child-status--open'}`} title={childStatus}>
                                        {childStatus}
                                      </span>
                                      <span className="epic-child-est">{childEst > 0 ? `${childEst.toFixed(0)}h` : '—'}</span>
                                      <button type="button" onClick={() => openJiraTicket(child.key)} className="epic-child-link" title="Mở Jira">
                                        <ExternalLink size={11} />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                              {epicChildList.length > CHILD_SCROLL_THRESHOLD && (
                                <div className="epic-child-scroll-hint">Cuộn để xem thêm ({epicChildList.length} ticket)</div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
};

export default EpicManagement;

