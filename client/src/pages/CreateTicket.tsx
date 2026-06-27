import React, { useState, useEffect } from 'react';
import { Sparkles, Loader2, ShieldCheck, Info, Users, Flag, Tag, ExternalLink, Check, Clipboard, ToggleLeft, ToggleRight } from 'lucide-react';
import { showSuccess, showError } from '../utils/swal';
import { buildManualJiraTicket } from '../utils/manualJiraTicket';
import type { JiraTicket } from '../types';

interface CreateTicketProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  projectUsers: any[];
  openJiraTicket: (key: string) => void;
}

const CreateTicket: React.FC<CreateTicketProps> = ({ apiFetch, API_BASE_URL, projectUsers, openJiraTicket }) => {
  const [context, setContext] = useState('');
  const [role, setRole] = useState('DEV lead');
  const [ticketType, setTicketType] = useState('Task');
  const [assignee, setAssignee] = useState('Me');
  const [loading, setLoading] = useState(false);
  const [ticket, setTicket] = useState<JiraTicket | null>(null);
  const [copied, setCopied] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [createAutoSubTasks, setCreateAutoSubTasks] = useState(false);
  const [subTaskDevAssignee, setSubTaskDevAssignee] = useState('');
  const [subTaskTestAssignee, setSubTaskTestAssignee] = useState('');
  const [subTaskStartDate, setSubTaskStartDate] = useState('');
  const [subTaskDueDate, setSubTaskDueDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [originalEstimate, setOriginalEstimate] = useState('');
  const [pushing, setPushing] = useState(false);
  const [rewritingFields, setRewritingFields] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (projectUsers.length > 0) {
      if (!subTaskDevAssignee) setSubTaskDevAssignee(projectUsers[0].accountId);
      if (!subTaskTestAssignee) setSubTaskTestAssignee(projectUsers[0].accountId);
      if (assignee === 'Me') setAssignee(projectUsers[0].displayName);
    }
  }, [projectUsers]);

  const handleGenerate = async () => {
    if (!context.trim()) return;

    if (!useAi) {
      const manual = buildManualJiraTicket({
        context,
        ticketType,
        assignee,
        createAutoSubTasks,
      });
      setTicket({
        ...manual,
        id: Date.now().toString(),
        status: 'To Do',
      });
      return;
    }

    setLoading(true);
    setTicket(null);
    
    try {
      const selectedUser = projectUsers.find(u => u.displayName === assignee);
      const assigneeId = selectedUser ? selectedUser.accountId : assignee;

      const response = await apiFetch(`${API_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          context, role, assignee, assigneeId, ticketType,
          createAutoSubTasks, subTaskDevAssignee, subTaskTestAssignee,
          subTaskStartDate, subTaskDueDate,
          startDate, dueDate, originalEstimate
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate ticket');
      }

      const data = await response.json();
      const newTicket: JiraTicket = { 
        ...data, 
        id: Date.now().toString(), 
        status: 'To Do',
        acceptanceCriteria: data.acceptanceCriteria || [],
        technicalNotes: data.technicalNotes || [],
        risks: data.risks || [],
        subTickets: data.subTickets || []
      };
      setTicket(newTicket);
    } catch (error: any) {
      console.error('Generation failed:', error);
      showError(error.message || 'Không thể kết nối đến server.');
    } finally {
      setLoading(false);
    }
  };

  const handleManualPush = async () => {
    if (!ticket) return;
    setPushing(true);
    try {
      const selectedUser = projectUsers.find(u => u.displayName === assignee);
      const assigneeId = selectedUser ? selectedUser.accountId : assignee;

      const response = await apiFetch(`${API_BASE_URL}/api/push-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          ticket, 
          assigneeId,
          startDate: startDate || null,
          dueDate: dueDate || null,
          originalEstimate: originalEstimate || null,
          createAutoSubTasks,
          subTaskDevAssignee,
          subTaskTestAssignee,
          subTaskStartDate: subTaskStartDate || null,
          subTaskDueDate: subTaskDueDate || null
        })
      });

      const data = await response.json();
      if (data.success) {
        showSuccess(`Đã tạo ticket thành công: ${data.key}`);
        setTicket({ ...ticket, jiraKey: data.key });
      } else {
        showError(data.error || 'Đẩy ticket thất bại');
      }
    } catch (err) {
      showError('Lỗi mạng khi đẩy ticket');
    } finally {
      setPushing(false);
    }
  };

  const handleAiRewrite = async (fieldType: string, currentContent: string | string[]) => {
    if (!currentContent || (Array.isArray(currentContent) && currentContent.length === 0)) return;
    
    const contentToRewrite = Array.isArray(currentContent) ? currentContent.join('\n') : currentContent;
    setRewritingFields(prev => ({ ...prev, [fieldType]: true }));
    
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/generate/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldType, currentContent: contentToRewrite })
      });
      
      if (response.ok) {
        const data = await response.json();
        const rewritten = data.rewritten;
        
        if (Array.isArray(currentContent)) {
          updateTicketField(fieldType, rewritten.split('\n').filter((s: string) => s.trim()));
        } else {
          updateTicketField(fieldType, rewritten);
        }
      }
    } catch (error) {
      console.error('Rewrite failed:', error);
    } finally {
      setRewritingFields(prev => ({ ...prev, [fieldType]: false }));
    }
  };

  const updateTicketField = (field: string, value: any) => {
    if (!ticket) return;
    setTicket({ ...ticket, [field as keyof JiraTicket]: value } as JiraTicket);
  };

  const updateSubTicketField = (index: number, field: string, value: any) => {
    if (!ticket || !ticket.subTickets) return;
    const newSubTickets = [...ticket.subTickets];
    newSubTickets[index] = { ...newSubTickets[index], [field as keyof JiraTicket]: value } as JiraTicket;
    setTicket({ ...ticket, subTickets: newSubTickets });
  };

  const copyToClipboard = () => {
    if (!ticket) return;
    navigator.clipboard.writeText(JSON.stringify(ticket, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className={`create-ticket-page ${loading ? 'generating-pulse' : ''}`} style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      height: '95vh',
      boxSizing: 'border-box',
      overflow: 'hidden'
    }}>
      <div className="scrollable-area" style={{ flex: 1, overflowY: 'auto', paddingRight: '6px', paddingBottom: '6rem' }}>
        <div className="glass-card" style={{ padding: '1.25rem' }}>
        <div style={{ marginBottom: '1.25rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ fontSize: '1.1rem', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {useAi ? <Sparkles size={20} className="text-primary" /> : <Tag size={20} className="text-primary" />}
                {useAi ? 'Thiết kế Ticket bằng AI' : 'Tạo Jira Ticket'}
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: 0 }}>
                {useAi
                  ? 'AI sẽ tự động phân tích và tạo cấu trúc Jira Ticket từ yêu cầu của bạn.'
                  : 'Tạo ticket trực tiếp từ nội dung — dòng đầu làm tiêu đề, không gọi AI.'}
              </p>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', userSelect: 'none', margin: 0, fontWeight: 600, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <input
                type="checkbox"
                checked={useAi}
                onChange={e => setUseAi(e.target.checked)}
                style={{ width: '1.1rem', height: '1.1rem', cursor: 'pointer' }}
              />
              Sử dụng AI phân tích
            </label>
          </div>
        </div>

        {/* Configuration Section - Horizontal Grid */}
        <div className="config-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
          {useAi && (
          <div className="form-group">
            <label className="action-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
              <Users size={12} /> AI Persona Profile
            </label>
            <select value={role} onChange={(e) => setRole(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
              <option>DEV lead</option>
              <option>Business Analyst</option>
              <option>Technical Project Manager</option>
              <option>Quality Assurance Lead</option>
            </select>
          </div>
          )}

          <div className="form-group">
            <label className="action-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
              <Tag size={12} /> Loại Jira Ticket
            </label>
            <select value={ticketType} onChange={(e) => setTicketType(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
              <option>Task</option>
              <option>Story</option>
              <option>Bug</option>
              <option>Improvement</option>
              <option>Epic</option>
            </select>
          </div>

          <div className="form-group">
            <label className="action-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
              <Users size={12} /> Người nhận (Assignee)
            </label>
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
              {projectUsers.length > 0 ? (
                projectUsers.map((u, i) => (
                  <option key={i} value={u.displayName}>{u.displayName}</option>
                ))
              ) : (
                <option>Tự động gán</option>
              )}
            </select>
          </div>

          <div className="form-group">
            <label className="action-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
              <Flag size={12} /> Ước lượng (Est)
            </label>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <input 
                type="text" 
                value={originalEstimate} 
                onChange={(e) => setOriginalEstimate(e.target.value)} 
                className="premium-select" 
                placeholder="VD: 4h, 1d"
                style={{ backgroundImage: 'none', flex: 1, padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
              />
              <button 
                type="button"
                onClick={() => setOriginalEstimate('4h')}
                className="premium-select"
                style={{ width: 'auto', padding: '0 0.5rem', fontSize: '0.7rem', background: originalEstimate === '4h' ? 'rgba(99, 102, 241, 0.2)' : 'var(--border-color)', backgroundImage: 'none' }}
              >
                4h
              </button>
              <button 
                type="button"
                onClick={() => setOriginalEstimate('7h')}
                className="premium-select"
                style={{ width: 'auto', padding: '0 0.5rem', fontSize: '0.7rem', background: originalEstimate === '7h' ? 'rgba(99, 102, 241, 0.2)' : 'var(--border-color)', backgroundImage: 'none' }}
              >
                7h
              </button>
            </div>
          </div>
        </div>

        <div className="config-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2.5rem', marginBottom: '1.25rem' }}>
          <div className="form-group">
            <label className="action-label" style={{ fontSize: '0.7rem' }}>Ngày bắt đầu</label>
            <input 
              type="datetime-local" 
              value={startDate} 
              onChange={(e) => setStartDate(e.target.value)} 
              className="premium-select" 
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }} 
            />
          </div>
          <div className="form-group">
            <label className="action-label" style={{ fontSize: '0.7rem' }}>Ngày kết thúc</label>
            <input 
              type="datetime-local" 
              value={dueDate} 
              onChange={(e) => setDueDate(e.target.value)} 
              className="premium-select" 
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }} 
            />
          </div>
        </div>

        {/* Sub-tasks Config - If Story */}
        {ticketType === 'Story' && (
          <div style={{ marginBottom: '1.25rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.03)', borderRadius: '0.75rem', border: '1px solid rgba(99, 102, 241, 0.1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ExternalLink size={14} className="text-primary" />
                <div>
                  <h4 style={{ margin: 0, fontSize: '0.85rem' }}>Cấu hình Sub-tasks</h4>
                  <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-secondary)' }}>Tự động sinh [DEV] và [TEST].</p>
                </div>
              </div>
              <button 
                onClick={() => setCreateAutoSubTasks(!createAutoSubTasks)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: createAutoSubTasks ? '#4ade80' : '#444', padding: 0 }}
              >
                {createAutoSubTasks ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
              </button>
            </div>

            {createAutoSubTasks && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
                <div className="form-group">
                  <label className="action-label" style={{ fontSize: '0.7rem' }}>Assignee [DEV]</label>
                  <select value={subTaskDevAssignee} onChange={(e) => setSubTaskDevAssignee(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
                    {projectUsers.map((u, i) => (
                      <option key={i} value={u.accountId}>{u.displayName}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="action-label" style={{ fontSize: '0.7rem' }}>Assignee [TEST]</label>
                  <select value={subTaskTestAssignee} onChange={(e) => setSubTaskTestAssignee(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}>
                    {projectUsers.map((u, i) => (
                      <option key={i} value={u.accountId}>{u.displayName}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="action-label" style={{ fontSize: '0.7rem' }}>Bắt đầu (Sub)</label>
                  <input type="datetime-local" value={subTaskStartDate} onChange={(e) => setSubTaskStartDate(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }} />
                </div>
                <div className="form-group">
                  <label className="action-label" style={{ fontSize: '0.7rem' }}>Kết thúc (Sub)</label>
                  <input type="datetime-local" value={subTaskDueDate} onChange={(e) => setSubTaskDueDate(e.target.value)} className="premium-select" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Main Input Area */}
        <div style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', alignItems: 'center' }}>
            <h3 style={{ fontSize: '0.9rem', margin: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              Nội dung yêu cầu (Context) <Info size={12} style={{ opacity: 0.5 }} />
            </h3>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
              {useAi ? 'AI phân tích kỹ thuật dựa trên mô tả này' : 'Dòng đầu = tiêu đề ticket, toàn bộ = mô tả'}
            </span>
          </div>
          <textarea
            className="context-textarea"
            style={{ width: '100%', minHeight: '120px', fontSize: '0.85rem', padding: '0.75rem' }}
            placeholder={useAi ? 'Mô tả yêu cầu nghiệp vụ...' : 'Dòng 1: Tiêu đề ticket\nDòng 2+: Mô tả chi tiết...'}
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button 
            className="btn-primary" 
            onClick={handleGenerate} 
            disabled={loading || !context.trim()} 
            style={{ padding: '0.6rem 2.5rem', fontSize: '0.95rem', borderRadius: '0.75rem', boxShadow: '0 8px 30px rgba(99, 102, 241, 0.2)' }}
          >
            {loading ? <Loader2 className="spinner" size={18} /> : useAi ? <Sparkles size={18} /> : <Tag size={18} />}
            {loading ? 'Đang phân tích...' : useAi ? 'Thiết kế & Tạo Jira Ticket' : 'Tạo Jira Ticket'}
          </button>
        </div>
      </div>

      {ticket && (
        <div className="ticket-preview" style={{ marginTop: '2rem' }}>
          <div className="preview-header" style={{ padding: '1rem 1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ padding: '6px', background: 'rgba(74, 222, 128, 0.1)', borderRadius: '6px' }}>
                <ShieldCheck size={20} color="#4ade80" />
              </div>
              <div>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>PHÂN TÍCH HOÀN TẤT</span>
                <h4 style={{ margin: 0, fontSize: '0.95rem' }}>{ticket.jiraKey || 'Bản thảo Jira Ticket'}</h4>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              {ticket.jiraKey && (
                <button className="btn-secondary" onClick={() => openJiraTicket(ticket.jiraKey!)} style={{ padding: '0.4rem 0.8rem', width: 'auto', fontSize: '0.8rem' }}>
                  <ExternalLink size={14} /> Xem Jira
                </button>
              )}
              <button className="btn-secondary" onClick={copyToClipboard} style={{ padding: '0.4rem 0.8rem', width: 'auto', fontSize: '0.8rem' }}>
                {copied ? <Check size={14} color="#4ade80" /> : <Clipboard size={14} />}
                {copied ? 'Đã chép' : 'JSON'}
              </button>
            </div>
          </div>

          <div className="preview-body" style={{ padding: '1.25rem' }}>
            <input 
              className="preview-summary" 
              value={ticket.summary} 
              onChange={(e) => updateTicketField('summary', e.target.value)}
              style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border-color)', outline: 'none', marginBottom: '1.25rem', paddingBottom: '0.5rem', fontSize: '1.1rem' }}
            />
            
            <div className="preview-meta" style={{ marginBottom: '2rem', gap: '1.25rem', display: 'flex', flexWrap: 'wrap' }}>
              <div className="meta-item" style={{ background: 'var(--border-color)', padding: '0.5rem 1.25rem', borderRadius: '2rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
                <Users size={14} /> <span style={{ opacity: 0.7 }}>Assignee:</span> <strong>{ticket.assignee || 'Chưa gán'}</strong>
              </div>

              <div className="meta-item" style={{ background: 'var(--border-color)', padding: '0.5rem 1.25rem', borderRadius: '2rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap' }}>
                <Tag size={14} /> <span style={{ opacity: 0.7 }}>Loại:</span> <strong>{ticket.issueType}</strong>
              </div>
            </div>

            <div className="preview-section" style={{ marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h5 className="section-title" style={{ fontSize: '0.85rem' }}>Mô tả chi tiết</h5>
                <button 
                  className="ai-assist-btn" 
                  onClick={() => handleAiRewrite('description', ticket.description)}
                  disabled={rewritingFields['description']}
                  style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}
                >
                  {rewritingFields['description'] ? <Loader2 size={12} className="spinner" /> : <Sparkles size={12} />} AI viết lại
                </button>
              </div>
              <textarea 
                className={`section-content ${rewritingFields['description'] ? 'field-loading' : ''}`}
                value={ticket.description}
                onChange={(e) => updateTicketField('description', e.target.value)}
                style={{ minHeight: '120px', fontSize: '0.85rem' }}
              />
            </div>

            <div className="preview-section" style={{ marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h5 className="section-title" style={{ fontSize: '0.85rem' }}>Tiêu chí chấp nhận</h5>
                <button 
                  className="ai-assist-btn" 
                  onClick={() => handleAiRewrite('acceptanceCriteria', ticket.acceptanceCriteria)}
                  disabled={rewritingFields['acceptanceCriteria']}
                  style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}
                >
                  {rewritingFields['acceptanceCriteria'] ? <Loader2 size={12} className="spinner" /> : <Sparkles size={12} />} AI tinh chỉnh
                </button>
              </div>
              <textarea 
                className={`section-content ${rewritingFields['acceptanceCriteria'] ? 'field-loading' : ''}`}
                value={ticket.acceptanceCriteria?.join('\n')}
                onChange={(e) => updateTicketField('acceptanceCriteria', e.target.value.split('\n'))}
                placeholder="Mỗi tiêu chí một dòng..."
                style={{ minHeight: '80px', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
               <div className="preview-section">
                  <h5 className="section-title" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>Ghi chú kỹ thuật</h5>
                  <textarea 
                    value={ticket.technicalNotes?.join('\n')}
                    onChange={(e) => updateTicketField('technicalNotes', e.target.value.split('\n'))}
                    style={{ minHeight: '80px', fontSize: '0.85rem', width: '100%', background: 'var(--surface-muted)', border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '0.5rem' }}
                  />
               </div>
               <div className="preview-section">
                  <h5 className="section-title" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>Rủi ro & Lưu ý</h5>
                  <textarea 
                    value={ticket.risks?.join('\n')}
                    onChange={(e) => updateTicketField('risks', e.target.value.split('\n'))}
                    style={{ minHeight: '80px', fontSize: '0.85rem', width: '100%', background: 'var(--surface-muted)', border: '1px solid var(--border-color)', borderRadius: '0.5rem', padding: '0.5rem' }}
                  />
               </div>
            </div>

            {ticket.subTickets && ticket.subTickets.length > 0 && (
              <div style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
                <h5 className="section-title" style={{ color: '#4ade80', fontSize: '0.9rem', marginBottom: '1rem' }}>Sub-tasks ({ticket.subTickets.length})</h5>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
                  {ticket.subTickets.map((st: any, i: number) => (
                    <div key={i} style={{ padding: '1rem', background: 'rgba(0,0,0,0.3)', borderRadius: '0.75rem', border: '1px solid var(--border-color)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                        <div style={{ fontSize: '0.65rem', color: '#4ade80', fontWeight: 700, textTransform: 'uppercase', background: 'rgba(74, 222, 128, 0.1)', padding: '0.1rem 0.4rem', borderRadius: '3px' }}>{st.issueType}</div>
                      </div>
                      <input 
                        value={st.summary} 
                        onChange={(e) => updateSubTicketField(i, 'summary', e.target.value)}
                        style={{ width: '100%', background: 'none', border: 'none', borderBottom: '1px solid var(--border-color)', outline: 'none', marginBottom: '0.4rem', color: 'white', fontWeight: 600, fontSize: '0.85rem' }}
                      />
                      <textarea 
                        value={st.description}
                        onChange={(e) => updateSubTicketField(i, 'description', e.target.value)}
                        style={{ width: '100%', background: 'none', border: 'none', outline: 'none', color: 'var(--text-secondary)', fontSize: '0.75rem', resize: 'none', minHeight: '50px' }}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!ticket.jiraKey && (
              <div style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'center' }}>
                <button 
                  className="btn-primary" 
                  onClick={handleManualPush} 
                  disabled={pushing}
                  style={{ padding: '0.75rem 3rem', fontSize: '1rem', borderRadius: '1rem', fontWeight: 700, boxShadow: '0 0 30px rgba(99, 102, 241, 0.3)' }}
                >
                  {pushing ? <Loader2 className="spinner" size={20} /> : <ShieldCheck size={20} />}
                  {pushing ? 'Đang đẩy...' : 'Xác nhận & Đẩy lên Jira'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </main>
  );
};

export default CreateTicket;

