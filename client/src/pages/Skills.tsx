import React, { useState, useEffect } from 'react';
import { Loader2, Plus, Edit2, Trash2, Save, ScrollText } from 'lucide-react';
import { showSuccess, showError, showConfirm } from '../utils/swal';
import CommonModal from '../components/CommonModal';

interface SkillRow {
  filename: string;
  label: string;
}

interface SkillsMeta {
  storage: string;
  table: string;
  skillCount: number;
}

interface SkillsProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
}

const Skills: React.FC<SkillsProps> = ({ apiFetch, API_BASE_URL }) => {
  const [list, setList] = useState<SkillRow[]>([]);
  const [meta, setMeta] = useState<SkillsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingFilename, setEditingFilename] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [rList, rMeta] = await Promise.all([
        apiFetch(`${API_BASE_URL}/api/skills`),
        apiFetch(`${API_BASE_URL}/api/admin/skills/meta`),
      ]);
      if (rList.ok) setList(await rList.json());
      if (rMeta.ok) setMeta(await rMeta.json());
      else setMeta({ storage: 'postgresql', table: 'app_expert_skills', skillCount: 0 });
    } catch {
      showError('Lỗi tải danh sách skill');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setCreating(true);
    setEditingFilename(null);
    setDraftName('');
    setDraftContent('# New skill\n\n');
    setModalOpen(true);
  };

  const openEdit = async (filename: string) => {
    setCreating(false);
    setEditingFilename(filename);
    setDraftName(filename);
    setModalOpen(true);
    setDraftContent('');
    try {
      const r = await apiFetch(`${API_BASE_URL}/api/admin/skills/${encodeURIComponent(filename)}`);
      const data = await r.json();
      if (!r.ok) {
        showError(data.error || 'Không đọc được file');
        setModalOpen(false);
        return;
      }
      setDraftContent(data.content ?? '');
    } catch {
      showError('Lỗi kết nối');
      setModalOpen(false);
    }
  };

  const closeModal = () => {
    setModalOpen(false);
    setSaving(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (creating) {
        const name = draftName.trim();
        if (!name) {
          showError('Nhập tên file (vd: my-skill.md)');
          setSaving(false);
          return;
        }
        const r = await apiFetch(`${API_BASE_URL}/api/admin/skills`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: name,
            content: draftContent,
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          showError(data.error || 'Tạo thất bại');
          setSaving(false);
          return;
        }
        showSuccess('Đã tạo skill (đã lưu vào database)');
      } else if (editingFilename) {
        const r = await apiFetch(`${API_BASE_URL}/api/admin/skills/${encodeURIComponent(editingFilename)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: draftContent,
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          showError(data.error || 'Lưu thất bại');
          setSaving(false);
          return;
        }
        showSuccess('Đã cập nhật skill (database)');
      }
      closeModal();
      load();
    } catch {
      showError('Lỗi kết nối');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (filename: string) => {
    const ok = await showConfirm(`Xóa skill "${filename}"?`);
    if (!ok) return;
    try {
      const r = await apiFetch(`${API_BASE_URL}/api/admin/skills/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      const data = await r.json();
      if (!r.ok) {
        showError(data.error || 'Xóa thất bại');
        return;
      }
      showSuccess('Đã xóa skill (database)');
      load();
    } catch {
      showError('Lỗi kết nối');
    }
  };

  return (
    <main className="glass-card skills-page" style={{
      padding: '1.25rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      height: 'calc(100vh - 2.2rem)',
      boxSizing: 'border-box',
      overflow: 'hidden'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <ScrollText className="text-primary" /> Quản lý Skill AI
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.5rem', marginBottom: 0 }}>
            Skill lưu trong PostgreSQL (bảng <code>app_expert_skills</code>). Lần chạy DB trống có thể tự nhập từ thư mục <code>server/skills</code> một lần. Project chọn skill theo tên file trong màn hình Projects.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={openCreate} style={{ width: 'auto', padding: '0.6rem 1.2rem', marginTop: 0 }}>
          <Plus size={18} /> Thêm skill
        </button>
      </div>

      {meta && (
        <div style={{
          marginBottom: '1.25rem',
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          border: '1px solid var(--border-color)',
          background: 'rgba(0,0,0,0.2)',
          fontSize: '0.78rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
        }}>
          <div>
            <strong style={{ color: 'var(--text-secondary)' }}>Lưu trữ:</strong>{' '}
            <span style={{ color: '#4ade80' }}>{meta.storage}</span> — bảng <code>{meta.table}</code>, hiện{' '}
            <strong style={{ color: 'white' }}>{meta.skillCount}</strong> skill.
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Loader2 className="spinner" size={40} />
        </div>
      ) : (
        <div className="scrollable-area" style={{ flex: 1, overflowY: 'auto', paddingRight: '6px' }}>
          <div className="grid-container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem', marginTop: 0 }}>
          {list.map((row) => (
            <div key={row.filename} className="dashboard-user-card" style={{ padding: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--primary)', fontSize: '0.95rem', wordBreak: 'break-all' }}>{row.filename}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{row.label}</div>
              </div>
              <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
                <button type="button" className="icon-btn" title="Sửa" onClick={() => openEdit(row.filename)}>
                  <Edit2 size={16} />
                </button>
                <button type="button" className="icon-btn" title="Xóa" style={{ color: '#ef4444' }} onClick={() => handleDelete(row.filename)}>
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      )}

      <CommonModal
        open={modalOpen}
        onClose={closeModal}
        title={creating ? 'Thêm skill mới' : `Sửa: ${editingFilename}`}
        titleId="skills-editor-modal-title"
        classNameContent="project-modal-content"
        styleContent={{ maxWidth: '720px', width: '92vw' }}
        closeDisabled={saving}
        closeOnOverlayClick={!saving}
      >
            {creating && (
              <div className="form-group">
                <label>Tên file</label>
                <input
                  className="project-input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="ten-skill.md"
                />
              </div>
            )}
            <div className="form-group">
              <label>Nội dung (Markdown)</label>
              <textarea
                className="project-input"
                value={draftContent}
                onChange={(e) => setDraftContent(e.target.value)}
                rows={18}
                style={{ width: '100%', minHeight: '280px', fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
              />
            </div>
            <div className="project-modal-actions">
              <button type="button" className="btn-secondary" onClick={() => !saving && closeModal()} disabled={saving}>Hủy</button>
              <button type="button" className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="spinner" size={18} /> : <Save size={18} />} Lưu
              </button>
            </div>
      </CommonModal>
    </main>
  );
};

export default Skills;

