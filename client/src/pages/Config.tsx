import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, RefreshCw, Moon, Sun, AlertCircle } from 'lucide-react';
import { showSuccess, showError } from '../utils/swal';
import type { User } from '../types';
import { useTheme } from '../context/ThemeContext';
import CommonModal from '../components/CommonModal';

interface ConfigProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
}

const Config: React.FC<ConfigProps> = ({ apiFetch, API_BASE_URL, currentUser, setCurrentUser }) => {
  const { theme, setTheme } = useTheme();
  const [userJiraToken, setUserJiraToken] = useState(currentUser?.jira_token || '');
  const [userJiraProject, setUserJiraProject] = useState(currentUser?.jira_project || '');
  const [projects, setProjects] = useState<any[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [selectedProjectsDraft, setSelectedProjectsDraft] = useState<string[]>([]);

  const fetchProjects = useCallback(async (tokenOverride?: string) => {
    const jiraToken = (tokenOverride ?? userJiraToken)?.trim();
    if (!jiraToken && !currentUser?.jira_token) {
      setProjects([]);
      setProjectsError('Nhập Jira Token và bấm Lưu (hoặc nút tải lại) để lấy danh sách dự án.');
      return;
    }

    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const headers: Record<string, string> = {};
      if (jiraToken) headers['X-Jira-Token'] = jiraToken;

      const res = await apiFetch(`${API_BASE_URL}/api/jira/projects`, { headers });
      if (res.ok) {
        const data = await res.json();
        setProjects(Array.isArray(data) ? data : []);
      } else {
        const data = await res.json().catch(() => ({}));
        setProjects([]);
        setProjectsError(data.error || 'Không tải được danh sách dự án Jira.');
      }
    } catch (err) {
      console.error('Failed to fetch projects:', err);
      setProjectsError('Lỗi mạng khi tải danh sách dự án.');
    } finally {
      setLoadingProjects(false);
    }
  }, [apiFetch, API_BASE_URL, userJiraToken, currentUser?.jira_token]);

  useEffect(() => {
    if (userJiraToken.trim() || currentUser?.jira_token) {
      void fetchProjects();
    }
  }, [currentUser?.jira_token]);

  const handleToggleProject = (projectKey: string) => {
    setSelectedProjectsDraft(prev => {
      if (prev.includes(projectKey)) {
        return prev.filter(k => k !== projectKey);
      } else {
        return [...prev, projectKey];
      }
    });
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/me/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jira_token: userJiraToken.trim() || null,
          jira_project: userJiraProject || null,
        }),
      });
      if (res.ok) {
        showSuccess('Cập nhật cấu hình cá nhân thành công!');
        const updatedUser = {
          ...currentUser!,
          jira_token: userJiraToken.trim() || undefined,
          jira_project: userJiraProject || undefined,
        };
        setCurrentUser(updatedUser);
        localStorage.setItem('user', JSON.stringify(updatedUser));
        await fetchProjects(userJiraToken.trim());
      } else {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Cập nhật thất bại.');
      }
    } catch (err) {
      console.error(err);
      showError('Lỗi mạng.');
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <main className="glass-card config-page">
      <header className="config-page__header">
        <h2 className="config-page__title">Cấu hình cá nhân</h2>
        <p className="config-page__subtitle">
          Thiết lập Jira Token và dự án mặc định. Token được lưu trên server sau khi bấm{' '}
          <strong>Lưu cấu hình</strong> — có thể thử token trước bằng nút tải lại bên cạnh ô nhập.
        </p>
      </header>

      <div className="config-page__body scrollable-area">
        <div className="config-form">
          <div className="form-group">
            <label>Giao diện</label>
            <div className="theme-picker">
              <button
                type="button"
                className={`theme-picker__btn${theme === 'light' ? ' is-active' : ''}`}
                onClick={() => setTheme('light')}
              >
                <Sun size={16} /> Sáng
              </button>
              <button
                type="button"
                className={`theme-picker__btn${theme === 'dark' ? ' is-active' : ''}`}
                onClick={() => setTheme('dark')}
              >
                <Moon size={16} /> Tối
              </button>
            </div>
            <p className="config-hint">Lưu trên trình duyệt; lần sau mở app sẽ giữ nguyên.</p>
          </div>

          <div className="config-form-row">
            <div className="form-group config-form-row__item">
              <label htmlFor="jira-token">Jira Token của bạn</label>
              <div className="config-input-wrap">
                <input
                  id="jira-token"
                  type="password"
                  value={userJiraToken}
                  onChange={e => setUserJiraToken(e.target.value)}
                  placeholder="Nhập Jira Personal Access Token"
                  className="config-input"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="config-input__refresh"
                  onClick={() => void fetchProjects()}
                  title="Tải danh sách dự án (dùng token trong ô nhập)"
                  disabled={loadingProjects}
                >
                  <RefreshCw size={16} className={loadingProjects ? 'spinner' : ''} />
                </button>
              </div>
              <p className="config-hint">
                Tạo token tại Jira → Profile → Personal Access Tokens. Bấm <strong>Lưu cấu hình</strong>{' '}
                để server ghi nhớ token cho các thao tác khác.
              </p>
            </div>

            <div className="form-group config-form-row__item">
              <label htmlFor="jira-project">Dự án Jira (mặc định)</label>
              {loadingProjects ? (
                <div className="config-loading">
                  <Loader2 size={16} className="spinner" />
                  <span>Đang tải danh sách dự án...</span>
                </div>
              ) : (
                <div className="config-project-picker">
                  <button
                    type="button"
                    className="btn-secondary config-project-picker__btn"
                    onClick={() => {
                      setSelectedProjectsDraft(userJiraProject ? userJiraProject.split(',').map(k => k.trim()).filter(Boolean) : []);
                      setIsProjectModalOpen(true);
                    }}
                  >
                    Chọn dự án
                  </button>
                  <span className="config-project-picker__value">
                    {userJiraProject ? userJiraProject.split(',').map(k => `[${k.trim()}]`).join(', ') : '— Chưa chọn —'}
                  </span>
                </div>
              )}
              {projectsError && (
                <div className="config-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{projectsError}</span>
                </div>
              )}
              {!loadingProjects && !projectsError && projects.length === 0 && userJiraToken.trim() && (
                <p className="config-hint">Không có dự án nào — kiểm tra token hoặc quyền trên Jira.</p>
              )}
            </div>
          </div>

          <div className="config-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleSaveConfig()}
              disabled={savingConfig}
            >
              {savingConfig ? <Loader2 className="spinner" size={20} /> : <Check size={20} />}
              {savingConfig ? 'Đang lưu...' : 'Lưu cấu hình'}
            </button>
          </div>
        </div>
      </div>

      <CommonModal
        open={isProjectModalOpen}
        onClose={() => setIsProjectModalOpen(false)}
        title={`Gán dự án — ${currentUser?.username || ''}`}
        styleContent={{ maxWidth: '480px' }}
      >
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
          Chọn một hoặc nhiều project Jira cho người dùng này.
        </p>
        <div className="user-mgmt-project-list scrollable-area" style={{ maxHeight: '300px' }}>
          {projects.map(p => {
            const isChecked = selectedProjectsDraft.includes(p.key);
            return (
              <label
                key={p.key}
                className={`user-mgmt-project-option${isChecked ? ' is-checked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => handleToggleProject(p.key)}
                />
                <span style={{ fontSize: '0.875rem' }}>
                  <strong>[{p.key}]</strong> {p.name}
                </span>
              </label>
            );
          })}
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
            onClick={() => {
              setUserJiraProject(selectedProjectsDraft.join(','));
              setIsProjectModalOpen(false);
            }}
            className="btn-primary"
            style={{ padding: '0.5rem 1.25rem', fontSize: '0.85rem', width: 'auto', marginTop: 0 }}
          >
            Lưu dự án
          </button>
        </div>
      </CommonModal>
    </main>
  );
};

export default Config;
