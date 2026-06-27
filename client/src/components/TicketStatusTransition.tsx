import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft, ChevronDown, Loader2, Sparkles } from 'lucide-react';
import CommonModal from './CommonModal';
import { useDeferredUnmount } from '../hooks/useDeferredUnmount';
import { showError } from '../utils/swal';

const OUTPUT_FIELD_KEY = 'customfield_10304';

type TransitionFieldOption = {
  id?: string | null;
  name?: string;
  value?: string;
};

type TransitionField = {
  key: string;
  name: string;
  required: boolean;
  schema?: { type?: string; system?: string; custom?: string } | null;
  allowedValues?: TransitionFieldOption[];
};

type JiraTransition = {
  id: string;
  name: string;
  to?: { name?: string };
  fields?: TransitionField[];
  hasScreen?: boolean;
};

type TicketStatusTransitionProps = {
  issueKey: string;
  currentStatus: string;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  canAct: boolean;
  /** Giá trị sẵn cho các field transition (vd. output đã có trên ticket). */
  prefillFields?: Record<string, string>;
  /** Ngữ cảnh ticket để AI sinh output. */
  aiContext?: { summary?: string; description?: string };
  onStatusChanged?: (result: { status?: string; statusCategory?: string }) => void;
};

function isCommentField(key: string) {
  return key === 'comment';
}

function buildInitialFieldValues(
  transition: JiraTransition,
  prefillFields?: Record<string, string>
): Record<string, string> {
  const values: Record<string, string> = { ...(prefillFields || {}) };

  const formatDate = (d: Date, isDateTime: boolean) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (!isDateTime) return `${year}-${month}-${day}`;
    
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${mins}`;
  };

  for (const field of transition.fields || []) {
    if (isCommentField(field.key)) continue;
    if (values[field.key] !== undefined && values[field.key] !== '') continue;

    const fieldType = field.schema?.type || '';
    const nameLower = (field.name || '').toLowerCase();

    if (fieldType === 'date' || fieldType === 'datetime' || fieldType === 'any') {
      const isDateTime = fieldType === 'datetime' || nameLower.includes('(time)');
      if (nameLower.includes('start') || nameLower.includes('bắt đầu')) {
        values[field.key] = formatDate(new Date(), isDateTime);
        continue;
      } else if (nameLower.includes('due') || nameLower.includes('kết thúc') || nameLower.includes('hạn')) {
        const d = new Date();
        d.setDate(d.getDate() + 2);
        values[field.key] = formatDate(d, isDateTime);
        continue;
      }
    }

    const allowed = field.allowedValues || [];
    if (allowed.length === 1) {
      values[field.key] = allowed[0].id || allowed[0].name || allowed[0].value || '';
      continue;
    }

    if (field.key === 'resolution' && allowed.length > 0) {
      const preferred =
        allowed.find(v => /^(done|fixed|complete|hoàn)/i.test(v.name || '')) ||
        allowed.find(v => !/won.?t|cancel|reject/i.test(v.name || '')) ||
        allowed[0];
      values[field.key] = preferred?.id || preferred?.name || '';
    }
  }

  return values;
}

function validateLocalFields(
  transition: JiraTransition,
  fieldValues: Record<string, string>,
  commentText: string
): string | null {
  for (const field of (transition.fields || []).filter(f => f.required)) {
    if (isCommentField(field.key)) {
      if (!commentText.trim()) {
        return `Bắt buộc: ${field.name}`;
      }
      continue;
    }
    const val = fieldValues[field.key];
    if (val === undefined || val === null || String(val).trim() === '') {
      return `Bắt buộc: ${field.name}`;
    }
  }
  return null;
}

function TransitionFieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: TransitionField;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const allowed = field.allowedValues || [];
  const fieldType = field.schema?.type || '';
  const isSelect = allowed.length > 0 || fieldType === 'resolution' || fieldType === 'option';

  if (isSelect && allowed.length > 0) {
    return (
      <select
        className="premium-select ticket-transition-field__input"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required={field.required}
      >
        <option value="">— Chọn {field.name} —</option>
        {allowed.map(opt => {
          const optValue = opt.id || opt.name || opt.value || '';
          const label = opt.name || opt.value || opt.id || '';
          return (
            <option key={`${field.key}-${optValue}`} value={optValue}>
              {label}
            </option>
          );
        })}
      </select>
    );
  }

  if (fieldType === 'date' || fieldType === 'datetime') {
    return (
      <input
        type={fieldType === 'datetime' ? 'datetime-local' : 'date'}
        className="ticket-transition-field__input"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required={field.required}
      />
    );
  }

  const isLongText =
    field.key === OUTPUT_FIELD_KEY ||
    /output|mô tả|description|note|comment/i.test(field.name) ||
    fieldType === 'string';

  if (isLongText) {
    return (
      <textarea
        className="ticket-transition-field__textarea"
        rows={4}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required={field.required}
        placeholder={`Nhập ${field.name}...`}
      />
    );
  }

  return (
    <input
      type="text"
      className="ticket-transition-field__input"
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      required={field.required}
      placeholder={`Nhập ${field.name}...`}
    />
  );
}

export default function TicketStatusTransition({
  issueKey,
  currentStatus,
  apiFetch,
  apiBaseUrl,
  canAct,
  prefillFields,
  aiContext,
  onStatusChanged,
}: TicketStatusTransitionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [liveStatus, setLiveStatus] = useState(currentStatus);
  const [selectedTransition, setSelectedTransition] = useState<JiraTransition | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [aiGeneratingOutput, setAiGeneratingOutput] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const flowMounted = useDeferredUnmount(flowOpen);

  const updateMenuPosition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const menuWidth = Math.min(320, Math.max(240, rect.width));
    const margin = 8;
    let left = rect.right - menuWidth;
    if (left < margin) left = margin;
    if (left + menuWidth > window.innerWidth - margin) {
      left = window.innerWidth - menuWidth - margin;
    }

    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const estimatedHeight = 260;
    let top = rect.bottom + 6;
    if (spaceBelow < estimatedHeight && rect.top > estimatedHeight) {
      top = rect.top - estimatedHeight - 6;
    }
    if (top < margin) top = margin;

    setMenuStyle({
      position: 'fixed',
      top,
      left,
      width: menuWidth,
      zIndex: 1310,
    });
  }, []);

  useEffect(() => {
    setLiveStatus(currentStatus);
  }, [currentStatus, issueKey]);

  useEffect(() => {
    setMenuOpen(false);
    setFlowOpen(false);
    setSelectedTransition(null);
    setCommentText('');
    setFieldValues({});
    setTransitions([]);
  }, [issueKey]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
    const menuEl = menuPortalRef.current;
    const btn = triggerRef.current;
    if (menuEl && btn) {
      const rect = btn.getBoundingClientRect();
      const menuHeight = menuEl.offsetHeight;
      const margin = 8;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      let top = rect.bottom + 6;
      if (spaceBelow < menuHeight && rect.top > menuHeight) {
        top = rect.top - menuHeight - 6;
      }
      if (top < margin) top = margin;
      setMenuStyle(prev => ({ ...prev, top }));
    }
  }, [menuOpen, transitions.length, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onScrollOrResize = () => updateMenuPosition();
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || menuPortalRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const loadTransitions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`${apiBaseUrl}/api/tickets/${issueKey}/transitions`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Không tải được danh sách transition.');
      const list = Array.isArray(data) ? data : Array.isArray(data.transitions) ? data.transitions : [];
      setTransitions(list);
      return list;
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, apiFetch, issueKey]);

  const openMenu = async () => {
    if (!canAct || loading) return;
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    try {
      await loadTransitions();
      setMenuOpen(true);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Không tải được danh sách transition.');
    }
  };

  const closeFlow = () => {
    setFlowOpen(false);
    setSelectedTransition(null);
  };

  const performTransition = async (
    transition: JiraTransition,
    text: string,
    fields: Record<string, string>
  ) => {
    setSubmitting(true);
    try {
      const res = await apiFetch(`${apiBaseUrl}/api/tickets/${issueKey}/transitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transitionId: transition.id,
          text,
          fields,
          output: fields[OUTPUT_FIELD_KEY],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail =
          typeof data.details?.errors === 'object'
            ? Object.values(data.details.errors).join(' ')
            : '';
        throw new Error([data.error, detail].filter(Boolean).join(' ') || 'Chuyển trạng thái thất bại.');
      }

      const nextStatus = data.status || transition.to?.name || transition.name;
      setLiveStatus(nextStatus);
      setTransitions([]);
      closeFlow();
      onStatusChanged?.({
        status: nextStatus,
        statusCategory: data.statusCategory,
      });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Chuyển trạng thái thất bại.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleTransitionClick = async (transition: JiraTransition) => {
    setMenuOpen(false);
    const hasRequiredFields = (transition.fields || []).some(f => f.required);
    if (hasRequiredFields) {
      setSelectedTransition(transition);
      setCommentText('');
      setFieldValues(buildInitialFieldValues(transition, prefillFields));
      setFlowOpen(true);
    } else {
      const initialFields = buildInitialFieldValues(transition, prefillFields);
      await performTransition(transition, '', initialFields);
    }
  };

  const handleAiGenerateOutput = async () => {
    const current = fieldValues[OUTPUT_FIELD_KEY] || '';
    let contentToProcess = current.trim();
    if (!contentToProcess) {
      const summary = aiContext?.summary || issueKey;
      const description = aiContext?.description || '';
      contentToProcess = `Tiêu đề: ${summary}\nMô tả: ${description}\n\nHãy viết nội dung kết quả xử lý (output) mẫu cho ticket này.`;
    }

    setAiGeneratingOutput(true);
    try {
      const res = await apiFetch(`${apiBaseUrl}/api/generate/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fieldType: 'output',
          currentContent: contentToProcess,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'AI không tạo được output.');
      }
      const data = await res.json();
      if (data.rewritten) {
        setFieldValues(prev => ({ ...prev, [OUTPUT_FIELD_KEY]: data.rewritten }));
      }
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'AI không tạo được output.');
    } finally {
      setAiGeneratingOutput(false);
    }
  };

  const handleConfirmTransition = async () => {
    if (!selectedTransition) return;

    const localError = validateLocalFields(selectedTransition, fieldValues, commentText);
    if (localError) {
      showError(localError);
      return;
    }

    await performTransition(selectedTransition, commentText, fieldValues);
  };

  if (!canAct) {
    return <span className="ticket-status-badge ticket-status-badge--readonly">{liveStatus}</span>;
  }

  const screenFields = (selectedTransition?.fields || []).filter(f => !isCommentField(f.key));
  const commentField = (selectedTransition?.fields || []).find(f => isCommentField(f.key));

  const menuContent =
    menuOpen &&
    createPortal(
      <div
        ref={menuPortalRef}
        className="ticket-status-transition__menu ticket-status-transition__menu--portal"
        style={menuStyle}
        role="menu"
      >
        <div className="ticket-status-transition__menu-head">
          <span>Chuyển trạng thái</span>
        </div>
        {transitions.length === 0 ? (
          <p className="ticket-status-transition__empty">Không có transition khả dụng.</p>
        ) : (
          <ul className="ticket-status-transition__list">
            {transitions.map(t => (
              <li key={t.id}>
                <button
                  type="button"
                  className="ticket-status-transition__item"
                  onClick={() => void handleTransitionClick(t)}
                >
                  <ArrowRightLeft size={13} />
                  <span className="ticket-status-transition__item-name">{t.name}</span>
                  {t.to?.name && t.to.name !== t.name && (
                    <span className="ticket-status-transition__item-to">→ {t.to.name}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>,
      document.body
    );

  return (
    <>
      <div className="ticket-status-transition" ref={rootRef}>
        <button
          ref={triggerRef}
          type="button"
          className="ticket-status-badge ticket-status-badge--action"
          onClick={() => void openMenu()}
          disabled={loading || submitting}
          title="Chuyển trạng thái"
        >
          {loading || submitting ? <Loader2 size={12} className="spinner" /> : null}
          <span>{liveStatus}</span>
          <ChevronDown size={12} />
        </button>
      </div>
      {menuContent}

      {flowMounted && selectedTransition && (
        <CommonModal
          open={flowOpen}
          onClose={closeFlow}
          title={`Chuyển trạng thái: ${selectedTransition.name}`}
          titleId="ticket-transition-flow-title"
          classNameContent="modal-content--wide ticket-transition-flow"
          zIndex={1300}
          closeDisabled={submitting}
        >
          <div className="modal-body">
            {screenFields.length > 0 && (
              <div className="ticket-transition-fields">
                {screenFields.map(field => (
                  <div key={field.key} className="ticket-transition-field">
                    {field.key === OUTPUT_FIELD_KEY ? (
                      <>
                        <div className="ticket-transition-field__label-row">
                          <label className="ticket-transition-field__label">
                            {field.name}
                            {field.required ? (
                              <span className="ticket-transition-field__req">*</span>
                            ) : null}
                          </label>
                          <button
                            type="button"
                            className="ai-assist-btn"
                            onClick={() => void handleAiGenerateOutput()}
                            disabled={submitting || aiGeneratingOutput}
                          >
                            {aiGeneratingOutput ? (
                              <Loader2 size={12} className="spinner" />
                            ) : (
                              <Sparkles size={12} />
                            )}
                            AI viết
                          </button>
                        </div>
                        <textarea
                          className="ticket-transition-field__textarea"
                          rows={5}
                          value={fieldValues[field.key] || ''}
                          onChange={e =>
                            setFieldValues(prev => ({
                              ...prev,
                              [field.key]: e.target.value,
                            }))
                          }
                          disabled={submitting || aiGeneratingOutput}
                          required={field.required}
                          placeholder="Mô tả kết quả xử lý..."
                        />
                      </>
                    ) : (
                      <>
                        <label className="ticket-transition-field__label">
                          {field.name}
                          {field.required ? (
                            <span className="ticket-transition-field__req">*</span>
                          ) : null}
                        </label>
                        <TransitionFieldInput
                          field={field}
                          value={fieldValues[field.key] || ''}
                          onChange={next =>
                            setFieldValues(prev => ({ ...prev, [field.key]: next }))
                          }
                          disabled={submitting}
                        />
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {(commentField || screenFields.length === 0) && (
              <div className="ticket-transition-field">
                {commentField ? (
                  <label className="ticket-transition-field__label">
                    {commentField.name}
                    {commentField.required ? (
                      <span className="ticket-transition-field__req">*</span>
                    ) : null}
                  </label>
                ) : null}
                <textarea
                  className="ticket-transition-field__textarea"
                  rows={4}
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  disabled={submitting}
                  required={commentField?.required}
                  placeholder="Bình luận khi chuyển trạng thái..."
                />
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="filter-btn" onClick={closeFlow} disabled={submitting}>
              Hủy
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void handleConfirmTransition()}
              disabled={submitting}
            >
              {submitting ? <Loader2 size={14} className="spinner" /> : <ArrowRightLeft size={14} />}
              Xác nhận chuyển
            </button>
          </div>
        </CommonModal>
      )}
    </>
  );
}
