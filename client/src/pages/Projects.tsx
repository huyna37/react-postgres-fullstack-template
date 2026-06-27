import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Plus, Edit2, Trash2, Save, FolderGit2, Link as LinkIcon, HardDrive, GitBranch, Cpu, TerminalSquare, Play, Download } from 'lucide-react';
import { showSuccess, showError, showConfirm } from '../utils/swal';
import CommonModal from '../components/CommonModal';
import { useDeferredUnmount } from '../hooks/useDeferredUnmount';

interface Project {
  id?: number;
  name: string;
  jira_key: string;
  git_url: string;
  git_user?: string;
  git_password?: string;
  local_path: string;
  base_branch: string;
  stack: string;
  selected_skills?: string[];
  cloned_initialized?: boolean;
  last_cloned_at?: string | null;
}

interface SkillOption {
  filename: string;
  label: string;
}

interface ProjectsProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
}

const Projects: React.FC<ProjectsProps> = ({ apiFetch, API_BASE_URL }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [availableSkills, setAvailableSkills] = useState<SkillOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [terminalProject, setTerminalProject] = useState<Project | null>(null);
  const [terminalModalOpen, setTerminalModalOpen] = useState(false);
  const terminalModalMounted = useDeferredUnmount(terminalModalOpen);
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState('');
  /** Chỉ true khi đang gọi API gửi lệnh — không dùng trạng thái "shell còn sống" của server (shell tương tác luôn running). */
  const [terminalSubmitting, setTerminalSubmitting] = useState(false);
  const [terminalShellOpen, setTerminalShellOpen] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState<string | null>(null);
  const [terminalExitCode, setTerminalExitCode] = useState<number | null>(null);
  const terminalCursorRef = useRef(0);
  const prevShellOpenRef = useRef<boolean | null>(null);
  const [pullingProjectId, setPullingProjectId] = useState<number | null>(null);
  const [formData, setFormData] = useState<Project>({
    name: '',
    jira_key: '',
    git_url: '',
    git_user: '',
    git_password: '',
    local_path: '',
    base_branch: 'main',
    stack: 'nodejs',
    selected_skills: []
  });

  const loadProjects = async () => {
    setLoading(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadSkills = async () => {
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/skills`);
      if (response.ok) {
        const data = await response.json();
        setAvailableSkills(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error('Failed to load skills:', error);
    }
  };

  useEffect(() => {
    loadProjects();
    loadSkills();
  }, []);

  const handleOpenModal = (project?: Project) => {
    if (project) {
      setEditingProject(project);
      setFormData({
        ...project,
        selected_skills: Array.isArray(project.selected_skills) ? project.selected_skills : []
      });
    } else {
      setEditingProject(null);
      setFormData({
        name: '',
        jira_key: '',
        git_url: '',
        git_user: '',
        git_password: '',
        local_path: '',
        base_branch: 'main',
        stack: 'nodejs',
        selected_skills: []
      });
    }
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const method = editingProject ? 'PUT' : 'POST';
    const url = editingProject ? `${API_BASE_URL}/api/projects/${editingProject.id}` : `${API_BASE_URL}/api/projects`;

    try {
      const response = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });

      if (response.ok) {
        showSuccess(editingProject ? 'Cập nhật thành công!' : 'Thêm mới thành công!');
        setIsModalOpen(false);
        loadProjects();
      } else {
        const data = await response.json();
        showError(data.error || 'Có lỗi xảy ra');
      }
    } catch (error) {
      showError('Lỗi kết nối server');
    }
  };

  const handleDelete = async (id: number) => {
    const confirm = await showConfirm('Xác nhận xóa dự án này?');
    if (!confirm) return;

    try {
      const response = await apiFetch(`${API_BASE_URL}/api/projects/${id}`, { method: 'DELETE' });
      if (response.ok) {
        showSuccess('Đã xóa dự án');
        loadProjects();
      }
    } catch (error) {
      showError('Lỗi khi xóa');
    }
  };

  const handleOpenTerminal = (project: Project) => {
    setTerminalProject(project);
    setTerminalCommand('');
    setTerminalOutput('');
    setTerminalSessionId(null);
    setTerminalExitCode(null);
    setTerminalSubmitting(false);
    setTerminalShellOpen(false);
    terminalCursorRef.current = 0;
    prevShellOpenRef.current = null;
    setTerminalModalOpen(true);
  };

  useEffect(() => {
    if (terminalModalOpen) return;
    const t = window.setTimeout(() => {
      setTerminalProject(null);
      setTerminalSessionId(null);
      setTerminalSubmitting(false);
      setTerminalShellOpen(false);
      setTerminalExitCode(null);
      terminalCursorRef.current = 0;
      prevShellOpenRef.current = null;
    }, 230);
    return () => clearTimeout(t);
  }, [terminalModalOpen]);

  const ensureTerminalSession = async (projectId: number) => {
    if (terminalSessionId) return terminalSessionId;
    const response = await apiFetch(`${API_BASE_URL}/api/projects/${projectId}/terminal/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Cannot open terminal session');
    setTerminalSessionId(data.sessionId || null);
    return data.sessionId;
  };

  useEffect(() => {
    if (!terminalProject?.id || terminalSessionId) return;
    ensureTerminalSession(terminalProject.id).catch((error) => {
      setTerminalShellOpen(false);
      setTerminalOutput(String(error));
      showError('Không mở được terminal cho project');
    });
  }, [terminalProject?.id, terminalSessionId]);

  const handleRunTerminalCommand = async () => {
    if (!terminalProject?.id || !terminalCommand.trim()) return;
    setTerminalSubmitting(true);
    try {
      const sessionId = await ensureTerminalSession(terminalProject.id);
      const response = await apiFetch(`${API_BASE_URL}/api/projects/${terminalProject.id}/terminal/input/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: terminalCommand })
      });
      const data = await response.json();
      if (!response.ok) {
        setTerminalOutput(data.output || data.error || 'Command failed');
        showError(data.error || 'Lệnh chạy thất bại');
        return;
      }
      setTerminalCommand('');
    } catch (error) {
      setTerminalOutput(String(error));
      showError('Lỗi kết nối server');
    } finally {
      setTerminalSubmitting(false);
    }
  };

  useEffect(() => {
    if (!terminalProject?.id || !terminalSessionId) return;
    prevShellOpenRef.current = null;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await apiFetch(`${API_BASE_URL}/api/projects/${terminalProject.id}/terminal/status/${terminalSessionId}?cursor=${terminalCursorRef.current}`);
        const data = await response.json();
        if (!response.ok) {
          if (!stopped) {
            setTerminalShellOpen(false);
            setTerminalOutput(data.error || 'Không lấy được trạng thái terminal');
          }
          return;
        }
        if (!stopped) {
          if (data.output) {
            setTerminalOutput(prev => `${prev}${data.output}`);
          }
          const nextCursor = typeof data.cursor === 'number' ? data.cursor : terminalCursorRef.current;
          terminalCursorRef.current = nextCursor;
          const shellOpen = Boolean(data.running);
          setTerminalShellOpen(shellOpen);
          setTerminalExitCode(typeof data.exitCode === 'number' ? data.exitCode : null);
          const prev = prevShellOpenRef.current;
          if (prev === true && !shellOpen) {
            if (!(typeof data.exitCode === 'number' && data.exitCode === 0)) {
              showError(`Shell thoát với mã lỗi ${data.exitCode ?? 'unknown'}`);
            }
          }
          prevShellOpenRef.current = shellOpen;
        }
      } catch (e) {
        if (!stopped) {
          setTerminalShellOpen(false);
          setTerminalOutput(String(e));
        }
      }
    };

    poll();
    const intervalId = window.setInterval(() => {
      poll();
    }, 900);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [terminalProject?.id, terminalSessionId]);

  const handleCloseTerminal = async () => {
    try {
      if (terminalProject?.id && terminalSessionId) {
        await apiFetch(`${API_BASE_URL}/api/projects/${terminalProject.id}/terminal/close/${terminalSessionId}`, {
          method: 'POST'
        });
      }
    } catch (e) {
      // ignore close error
    } finally {
      setTerminalModalOpen(false);
    }
  };

  const handleCloneProject = async (project: Project) => {
    if (!project.id) return;
    setPullingProjectId(project.id);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/projects/${project.id}/clone`, { method: 'POST' });
      const data = await response.json();
      if (response.ok) {
        showSuccess('Đã clone project thành công');
        loadProjects();
      } else {
        showError(data.error || 'Clone project thất bại');
      }
    } catch (error) {
      showError('Lỗi kết nối server');
    } finally {
      setPullingProjectId(null);
    }
  };

  return (
    <main className="glass-card projects-page" style={{
      padding: '1.25rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      height: 'calc(100vh - 2.2rem)',
      boxSizing: 'border-box',
      overflow: 'hidden'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <FolderGit2 className="text-primary" /> Cấu hình Dự án
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.5rem' }}>
            Quản lý ánh xạ giữa Jira Project Key và Git Repository cho AI Agent.
          </p>
        </div>
        <button className="btn-primary" onClick={() => handleOpenModal()} style={{ width: 'auto', padding: '0.6rem 1.2rem', marginTop: 0 }}>
          <Plus size={18} /> Thêm Dự án mới
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Loader2 className="spinner" size={40} />
        </div>
      ) : (
        <div className="scrollable-area" style={{ flex: 1, overflowY: 'auto', paddingRight: '6px' }}>
          <div className="grid-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '1.5rem', marginTop: 0 }}>
          {projects.map(project => (
            <div key={project.id} className="dashboard-user-card" style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, color: 'var(--primary)', fontSize: '1.1rem' }}>{project.name}</h3>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="icon-btn"
                    onClick={() => handleCloneProject(project)}
                    title="Clone project"
                    disabled={pullingProjectId === project.id}
                  >
                    {pullingProjectId === project.id ? <Loader2 className="spinner" size={16} /> : <Download size={16} />}
                  </button>
                  <button className="icon-btn" onClick={() => handleOpenTerminal(project)} title="Terminal">
                    <TerminalSquare size={16} />
                  </button>
                  <button className="icon-btn" onClick={() => handleOpenModal(project)} title="Sửa">
                    <Edit2 size={16} />
                  </button>
                  <button className="icon-btn" onClick={() => handleDelete(project.id!)} title="Xóa" style={{ color: '#ef4444' }}>
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--text-secondary)' }}>
                  <Cpu size={14} /> Jira Key: <strong className="text-body">{project.jira_key}</strong>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--text-secondary)' }}>
                  <LinkIcon size={14} /> Git: <span className="text-body" style={{ wordBreak: 'break-all' }}>{project.git_url}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--text-secondary)' }}>
                  <HardDrive size={14} /> Path: <span className="text-body">{project.local_path}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--text-secondary)' }}>
                  <GitBranch size={14} /> Branch: <span className="text-body">{project.base_branch}</span>
                </div>
                <div style={{ marginTop: '0.5rem' }}>
                  <span style={{ 
                    padding: '2px 8px', 
                    background: 'rgba(59, 130, 246, 0.1)', 
                    border: '1px solid rgba(59, 130, 246, 0.2)', 
                    borderRadius: '4px', 
                    fontSize: '0.7rem',
                    color: '#60a5fa',
                    textTransform: 'uppercase'
                  }}>
                    {project.stack}
                  </span>
                </div>
                <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontSize: '0.68rem',
                    border: project.cloned_initialized ? '1px solid rgba(74, 222, 128, 0.35)' : '1px solid rgba(248, 113, 113, 0.35)',
                    background: project.cloned_initialized ? 'rgba(74, 222, 128, 0.12)' : 'rgba(248, 113, 113, 0.12)',
                    color: project.cloned_initialized ? '#4ade80' : '#f87171'
                  }}>
                    {project.cloned_initialized ? 'Da clone' : 'Chua clone'}
                  </span>
                  {project.last_cloned_at && (
                    <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                      Lan clone cap nhat: {new Date(project.last_cloned_at).toLocaleString('vi-VN')}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
          </div>
        </div>
      )}

      <CommonModal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingProject ? 'Cập nhật Dự án' : 'Thêm Dự án mới'}
        titleId="projects-form-modal-title"
        classNameContent="project-modal-content"
      >
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Tên Dự án</label>
                <input 
                  className="project-input"
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  required
                  placeholder="VD: Dự án Quản lý Kho"
                />
              </div>

              <div className="project-form-grid">
                <div className="form-group">
                  <label>Jira Project Key</label>
                  <input 
                    className="project-input"
                    value={formData.jira_key}
                    onChange={e => setFormData({...formData, jira_key: e.target.value})}
                    required
                    placeholder="VD: PROJ"
                  />
                </div>
                <div className="form-group">
                  <label>Base Branch</label>
                  <input 
                    className="project-input"
                    value={formData.base_branch}
                    onChange={e => setFormData({...formData, base_branch: e.target.value})}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Git URL</label>
                <input 
                  className="project-input"
                  value={formData.git_url}
                  onChange={e => setFormData({...formData, git_url: e.target.value})}
                  required
                  placeholder="https://git.example.com/repo.git"
                />
              </div>

              <div className="project-form-grid">
                <div className="form-group">
                  <label>Git User</label>
                  <input 
                    className="project-input"
                    value={formData.git_user}
                    onChange={e => setFormData({...formData, git_user: e.target.value})}
                    placeholder="Username / Email"
                  />
                </div>
                <div className="form-group">
                  <label>Git Password / Token</label>
                  <input 
                    type="password"
                    className="project-input"
                    value={formData.git_password}
                    onChange={e => setFormData({...formData, git_password: e.target.value})}
                    placeholder="App Password / Personal Access Token"
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Local Path (In Container)</label>
                <input 
                  className="project-input"
                  value={formData.local_path}
                  onChange={e => setFormData({...formData, local_path: e.target.value})}
                  required
                  placeholder="/app/repos/repo-name"
                />
              </div>

              <div className="form-group">
                <label style={{ display: 'block', marginBottom: '0.5rem' }}>Tech Stack (Chọn nhiều)</label>
                <div className="project-stack-grid">
                  {[
                    { value: 'nodejs', label: 'Node.js / Express' },
                    { value: 'dotnet', label: 'ASP.NET Core (.NET 8)' },
                    { value: 'angular', label: 'Angular' },
                    { value: 'polyglot', label: 'Polyglot (Auto Detect)' }
                  ].map(s => (
                    <label
                      key={s.value}
                      className={`project-stack-option ${formData.stack?.split(',').includes(s.value) ? 'active' : ''}`}
                    >
                      <input 
                        type="checkbox" 
                        checked={formData.stack?.split(',').includes(s.value)}
                        onChange={() => {
                          const currentStacks = formData.stack ? formData.stack.split(',').filter(x => x) : [];
                          let newStacks;
                          if (currentStacks.includes(s.value)) {
                            newStacks = currentStacks.filter(x => x !== s.value);
                          } else {
                            newStacks = [...currentStacks, s.value];
                          }
                          setFormData({ ...formData, stack: newStacks.join(',') });
                        }}
                        className="project-stack-checkbox"
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label style={{ display: 'block', marginBottom: '0.5rem' }}>Skills cho AI Agent</label>
                {availableSkills.length === 0 ? (
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    Không có skill khả dụng.
                  </div>
                ) : (
                  <div className="project-stack-grid">
                    {availableSkills.map((skill) => (
                      <label
                        key={skill.filename}
                        className={`project-stack-option ${formData.selected_skills?.includes(skill.filename) ? 'active' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={formData.selected_skills?.includes(skill.filename)}
                          onChange={() => {
                            const currentSkills = Array.isArray(formData.selected_skills) ? formData.selected_skills : [];
                            const newSkills = currentSkills.includes(skill.filename)
                              ? currentSkills.filter((x) => x !== skill.filename)
                              : [...currentSkills, skill.filename];
                            setFormData({ ...formData, selected_skills: newSkills });
                          }}
                          className="project-stack-checkbox"
                        />
                        {skill.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="project-modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setIsModalOpen(false)} style={{ marginTop: 0 }}>Hủy</button>
                <button type="submit" className="btn-primary" style={{ marginTop: 0 }}>
                  <Save size={18} /> {editingProject ? 'Cập nhật' : 'Lưu Dự án'}
                </button>
              </div>
            </form>
      </CommonModal>

      {terminalModalMounted && terminalProject && (
      <CommonModal
        open={terminalModalOpen}
        onClose={handleCloseTerminal}
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TerminalSquare size={18} /> Terminal: {terminalProject.name}
          </span>
        }
        titleId="projects-terminal-modal-title"
        classNameContent="project-modal-content"
      >
            <div className="form-group">
              <label>Command</label>
              <div style={{ display: 'flex', gap: '0.6rem' }}>
                <input
                  className="project-input"
                  value={terminalCommand}
                  onChange={(e) => setTerminalCommand(e.target.value)}
                  placeholder="npm install"
                />
                <button
                  className="btn-primary"
                  type="button"
                  onClick={handleRunTerminalCommand}
                  disabled={terminalSubmitting || !terminalCommand.trim()}
                  style={{ width: 'auto', marginTop: 0, padding: '0.55rem 1rem' }}
                >
                  {terminalSubmitting ? <Loader2 className="spinner" size={16} /> : <Play size={16} />} Run
                </button>
              </div>
              <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                CWD: {terminalProject.local_path || '(chưa cấu hình local_path)'}
              </div>
              {terminalSessionId && (
                <div style={{ marginTop: '0.3rem', fontSize: '0.72rem', color: terminalShellOpen ? '#60a5fa' : (terminalExitCode === 0 ? '#4ade80' : '#f87171') }}>
                  Shell: {terminalShellOpen ? 'đang mở (có thể gửi lệnh tiếp)' : `đã đóng (exit: ${terminalExitCode ?? 'unknown'})`}
                </div>
              )}
            </div>

            <div className="form-group">
              <label>Output</label>
              <pre style={{
                margin: 0,
                minHeight: '220px',
                maxHeight: '420px',
                overflow: 'auto',
                padding: '0.8rem',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(0,0,0,0.35)',
                color: '#cbd5e1',
                fontSize: '0.75rem',
                whiteSpace: 'pre-wrap'
              }}>
                {terminalOutput || 'Chưa có output. Hãy chạy lệnh.'}
              </pre>
            </div>
      </CommonModal>
      )}
    </main>
  );
};

export default Projects;

