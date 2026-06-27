import {
  Check,
  Clock3,
  Copy,
  ExternalLink,
  Loader2,
  Sparkles,
  User as UserIcon,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '../types';
import { fetchIssueAttachments } from '../utils/jiraAttachments';
import {
  revokeJiraImagePreviews,
  serializeJiraImages,
  type ComposerInlineImage,
} from '../utils/jiraImages';
import {
  canLogworkTicket,
  canTransitionTicket,
  canUpdateTicket,
  hasJiraToken,
} from '../utils/jiraToken';
import { showError } from '../utils/swal';
import CommonModal from './CommonModal';
import JiraRichComposer from './JiraRichComposer';
import JiraRichContent from './JiraRichContent';
import JiraTicketKeyLink from './JiraTicketKeyLink';
import TicketActionPanel from './TicketActionPanel';
import TicketAttachmentList from './TicketAttachmentList';
import TicketCommentList from './TicketCommentList';
import TicketAssigneeField from './TicketAssigneeField';
import TicketFieldEditButton from './TicketFieldEditButton';
import TicketLogworkButton from './TicketLogworkButton';
import { TicketModalTabs, type TicketModalTab } from './TicketModalTabs';
import TicketOutputField from './TicketOutputField';
import TicketStatusTransition from './TicketStatusTransition';

export type TicketDetailFields = {
  summary: string;
  description: string;
  output: string;
  startDate?: string | null;
  dueDate?: string | null;
  updated?: string | null;
  created?: string | null;
  timeSpent?: number;
  timeSpentMonth?: number;
  originalEstimate?: number;
  remainingEstimate?: number;
  creator?: string | null;
  creatorEmail?: string | null;
  assignee?: any | null;
  isSubtask?: boolean;
  parentKey?: string | null;
  commentsIncludeRelated?: boolean;
  comments?: any[];
  myWorklog?: {
    id: string;
    timeSpent?: string;
    timeSpentSeconds?: number;
    started?: string;
    comment?: unknown;
  } | null;
};

const parsePlanDateYmd = (val?: string | null) => {
  if (!val) return null;
  const m = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};

const formatTicketDate = (val?: string | null) => {
  const p = parsePlanDateYmd(val);
  if (p) return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year}`;
  if (!val) return '—';
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Bangkok' });
};

const formatTicketDateTime = (val?: string | null) => {
  if (!val) return '—';
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
};

const formatHoursCompact = (sec?: number | null) => {
  if (sec == null || sec <= 0) return null;
  return `${(sec / 3600).toFixed(1)}h`;
};

const metaDisplay = (formatted: string) => (formatted === '—' ? 'Chưa có' : formatted);

export const ticketDetailsFromListItem = (ticket: any): TicketDetailFields => ({
  summary: ticket.summary || '',
  description: ticket.description || '',
  output: ticket.output || '',
  startDate: ticket.startDate ?? null,
  dueDate: ticket.dueDate ?? null,
  updated: ticket.updated ?? null,
  created: ticket.created ?? null,
  timeSpent: ticket.timeSpent ?? 0,
  timeSpentMonth: ticket.timeSpentMonth ?? ticket.timeSpent ?? 0,
  originalEstimate: ticket.originalEstimate ?? 0,
  remainingEstimate: ticket.remainingEstimate ?? 0,
  creator: ticket.creator || null,
  creatorEmail: ticket.creatorEmail || null,
  assignee: ticket.assignee ?? null,
  comments: ticket.comments || [],
});

const TicketScheduleStrip = ({
  details,
  loading,
}: {
  details: TicketDetailFields;
  loading: boolean;
}) => (
  <p className={`ticket-schedule-plain${loading ? ' is-pending' : ''}`} aria-label="Lịch kế hoạch">
    {metaDisplay(formatTicketDate(details.startDate))}
    {' – '}
    {metaDisplay(formatTicketDate(details.dueDate))}
  </p>
);

const EffortStat = ({
  label,
  hours,
  title,
}: {
  label: string;
  hours: string | null;
  title?: string;
}) => {
  if (!hours) return null;
  return (
    <span className="ticket-effort-stat" title={title}>
      <span className="ticket-effort-stat__label">{label}</span>
      <span className="ticket-effort-stat__value">{hours}</span>
    </span>
  );
};

const TicketEffortMeta = ({
  details,
  loading,
  leading,
  trailing,
}: {
  details: TicketDetailFields;
  loading: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) => {
  const logMonth = formatHoursCompact(details.timeSpentMonth);
  const logTotal = formatHoursCompact(details.timeSpent);
  const showLogTotal =
    logTotal != null &&
    logMonth !== logTotal &&
    ((details.timeSpent ?? 0) > 0 || (details.timeSpentMonth ?? 0) > 0);
  const est = formatHoursCompact(details.originalEstimate);
  const remaining = formatHoursCompact(details.remainingEstimate);

  return (
    <div className={`ticket-effort-meta${loading ? ' is-pending' : ''}`}>
      <div className="ticket-effort-meta__main">
        {leading}
        <div className="ticket-effort-stats">
          <EffortStat label="Log" hours={logMonth ?? logTotal} title="Logwork trên ticket" />
          {showLogTotal && (
            <EffortStat label="Log tổng" hours={logTotal} title="Tổng logwork trên ticket (Jira)" />
          )}
          <EffortStat label="Est" hours={est} title="Estimate ban đầu" />
          <EffortStat label="Còn" hours={remaining} title="Estimate còn lại" />
        </div>
      </div>
      {trailing ? <div className="ticket-effort-meta__trailing">{trailing}</div> : null}
    </div>
  );
};

const TicketSystemLogBar = ({
  details,
  loading,
}: {
  details: TicketDetailFields;
  loading: boolean;
}) => (
  <div className={`ticket-system-log${loading ? ' is-pending' : ''}`} aria-label="Nhật ký hệ thống">
    <div className="ticket-system-log__head">
      <Clock3 size={14} aria-hidden />
      <span>Nhật ký hệ thống</span>
    </div>
    <div className="ticket-system-log__items">
      <span className="ticket-system-log__item">
        <span className="ticket-system-log__item-label">Cập nhật</span>
        <span className="ticket-system-log__item-value">
          {metaDisplay(formatTicketDateTime(details.updated))}
        </span>
      </span>
      <span className="ticket-system-log__sep" aria-hidden />
      <span className="ticket-system-log__item">
        <span className="ticket-system-log__item-label">Tạo</span>
        <span className="ticket-system-log__item-value">
          {metaDisplay(formatTicketDateTime(details.created))}
        </span>
      </span>
      {(details.creator || details.creatorEmail) && (
        <>
          <span className="ticket-system-log__sep" aria-hidden />
          <span className="ticket-system-log__item ticket-system-log__item--creator">
            <span className="ticket-system-log__item-label">Người tạo</span>
            <span className="ticket-system-log__item-value">
              {details.creator || '—'}
              {details.creatorEmail ? (
                <a
                  className="ticket-system-log__creator-email"
                  href={`mailto:${details.creatorEmail}`}
                  onClick={e => e.stopPropagation()}
                >
                  {details.creator ? ` (${details.creatorEmail})` : details.creatorEmail}
                </a>
              ) : null}
            </span>
          </span>
        </>
      )}
    </div>
  </div>
);

type TicketPreviewModalProps = {
  open: boolean;
  onClose: () => void;
  ticket: any | null;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  openJiraTicket: (key: string) => void;
  currentUser: User | null;
  selectedMonth: string;
  projectUsers?: any[];
  parentStoryAssignee?: any | null;
  isAssigneeLocked?: boolean;
  onAssigneeChange?: (issueKey: string, assigneeId: string) => Promise<void>;
  savingAssigneeKey?: string | null;
  onTicketUpdated?: () => void;
};

export default function TicketPreviewModal({
  open,
  onClose,
  ticket,
  apiFetch,
  apiBaseUrl,
  openJiraTicket,
  currentUser,
  selectedMonth,
  projectUsers = [],
  parentStoryAssignee = null,
  isAssigneeLocked = false,
  onAssigneeChange,
  savingAssigneeKey = null,
  onTicketUpdated,
}: TicketPreviewModalProps) {
  const canUpdate = canUpdateTicket(currentUser);
  const canLogwork = canLogworkTicket(currentUser);
  const canTransition = canTransitionTicket(currentUser);
  const [assigneeEditing, setAssigneeEditing] = useState(false);
  const [ticketDetailTab, setTicketDetailTab] = useState<TicketModalTab>('content');
  const [descriptionEditMode, setDescriptionEditMode] = useState(false);
  const [descriptionImages, setDescriptionImages] = useState<ComposerInlineImage[]>([]);
  const [outputEditMode, setOutputEditMode] = useState(false);
  const [ticketDetails, setTicketDetails] = useState<TicketDetailFields | null>(null);
  const outputSavedRef = useRef('');
  const descriptionBaselineRef = useRef('');
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [liveTicket, setLiveTicket] = useState<any | null>(null);
  const [attachmentCount, setAttachmentCount] = useState(0);

  const loadTicketDetails = useCallback(
    async (key: string) => {
      setLoadingDetails(true);
      try {
        const [year, month] = selectedMonth.split('-');
        const response = await apiFetch(
          `${apiBaseUrl}/api/tickets/details/${key}?year=${year}&month=${month}`
        );
        if (response.ok) {
          const data = await response.json();
          setTicketDetails(prev => {
            const next = prev ? { ...prev, ...data } : data;
            outputSavedRef.current = next.output || '';
            descriptionBaselineRef.current = next.description || '';
            return next;
          });
          if (data.timeSpentMonth != null) {
            setLiveTicket((prev: any) =>
              prev?.key === key ? { ...prev, timeSpent: data.timeSpentMonth } : prev
            );
          }
          if (data.assignee !== undefined) {
            setLiveTicket((prev: any) =>
              prev?.key === key ? { ...prev, assignee: data.assignee } : prev
            );
          }
        }
      } catch (error) {
        console.error('Failed to fetch ticket details:', error);
      } finally {
        setLoadingDetails(false);
      }
    },
    [apiFetch, apiBaseUrl, selectedMonth]
  );

  useEffect(() => {
    if (!open || !ticket?.key) return;
    void fetchIssueAttachments(apiFetch, apiBaseUrl, ticket.key)
      .then(list => setAttachmentCount(list.length))
      .catch(() => setAttachmentCount(0));
    setLiveTicket(ticket);
    setTicketDetails(ticketDetailsFromListItem(ticket));
    outputSavedRef.current = ticket.output || '';
    descriptionBaselineRef.current = ticket.description || '';
    setDescriptionEditMode(false);
    setOutputEditMode(false);
    setDescriptionImages(prev => {
      revokeJiraImagePreviews(prev);
      return [];
    });
    setTicketDetailTab('content');
    setAssigneeEditing(false);
    void loadTicketDetails(ticket.key);
  }, [open, ticket?.key, apiFetch, apiBaseUrl, loadTicketDetails]);

  useEffect(() => {
    if (!ticket?.key) return;
    setLiveTicket((prev: any) =>
      prev?.key === ticket.key ? { ...prev, assignee: ticket.assignee ?? null } : prev
    );
  }, [ticket?.key, ticket?.assignee]);

  const handleClose = () => {
    setTicketDetails(prev =>
      prev
        ? {
            ...prev,
            description: descriptionBaselineRef.current,
            output: outputSavedRef.current,
          }
        : prev
    );
    setDescriptionEditMode(false);
    setOutputEditMode(false);
    setAssigneeEditing(false);
    revokeJiraImagePreviews(descriptionImages);
    setDescriptionImages([]);
    onClose();
  };

  const beginDescriptionEdit = () => {
    setDescriptionEditMode(true);
  };

  const hasUnsavedEdits = useMemo(() => {
    if (!ticketDetails || !canUpdate) return false;
    const desc = ticketDetails.description ?? '';
    const out = ticketDetails.output ?? '';
    return (
      desc !== descriptionBaselineRef.current ||
      out !== outputSavedRef.current ||
      descriptionImages.length > 0
    );
  }, [ticketDetails, descriptionImages, canUpdate]);

  const handleCopy = (content: string, type: string) => {
    navigator.clipboard.writeText(content);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleSaveDescription = async (payload?: {
    wiki: string;
    images: ComposerInlineImage[];
  }) => {
    if (!liveTicket?.key || !ticketDetails || isUpdating) return;
    const nextDescription = payload?.wiki ?? ticketDetails.description;
    const nextImages = payload?.images ?? descriptionImages;
    setIsUpdating(true);
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/tickets/${liveTicket.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: nextDescription,
          images: nextImages.length > 0 ? await serializeJiraImages(nextImages) : undefined,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Cập nhật mô tả thất bại');
      }
      const data = await response.json();
      setTicketDetails(prev =>
        prev ? { ...prev, description: data.description ?? nextDescription } : prev
      );
      revokeJiraImagePreviews(nextImages);
      setDescriptionImages([]);
      setDescriptionEditMode(false);
      descriptionBaselineRef.current = data.description ?? nextDescription;
      await loadTicketDetails(liveTicket.key);
      onTicketUpdated?.();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Lỗi khi lưu mô tả');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaveOutput = async (nextOutput?: string) => {
    if (!liveTicket?.key || !ticketDetails || isUpdating) return;
    const output = nextOutput ?? ticketDetails.output ?? '';
    if (output === outputSavedRef.current) return;
    setIsUpdating(true);
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/tickets/${liveTicket.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Cập nhật output thất bại');
      }
      const data = await response.json();
      const saved = data.output ?? output;
      outputSavedRef.current = saved;
      setTicketDetails(prev => (prev ? { ...prev, output: saved } : prev));
      setOutputEditMode(false);
      await loadTicketDetails(liveTicket.key);
      onTicketUpdated?.();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Lỗi khi lưu output');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleAiRewrite = async (fieldType: 'summary' | 'description' | 'output') => {
    if (!ticketDetails) return;
    let contentToProcess = ticketDetails[fieldType];
    if (fieldType === 'output' && !String(contentToProcess || '').trim()) {
      contentToProcess = `Tiêu đề: ${ticketDetails.summary}\nMô tả: ${ticketDetails.description}\n\nHãy viết nội dung kết quả xử lý (output) cho ticket này.`;
    }
    if (!contentToProcess) return;
    setRewriting(fieldType);
    try {
      const response = await apiFetch(`${apiBaseUrl}/api/generate/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldType, currentContent: contentToProcess }),
      });
      if (response.ok) {
        const data = await response.json();
        setTicketDetails({ ...ticketDetails, [fieldType]: data.rewritten });
        if (fieldType === 'output') {
          setOutputEditMode(true);
        }
      }
    } catch (error) {
      console.error('Rewrite failed:', error);
    } finally {
      setRewriting(null);
    }
  };

  const handleSaveModalEdits = async () => {
    if (!hasUnsavedEdits || isUpdating) return;
    (document.activeElement as HTMLElement | null)?.blur();
    await new Promise<void>(resolve => {
      window.setTimeout(resolve, 0);
    });
    const desc = ticketDetails?.description ?? '';
    const out = ticketDetails?.output ?? '';
    const descDirty = desc !== descriptionBaselineRef.current || descriptionImages.length > 0;
    const outDirty = out !== outputSavedRef.current;
    if (descDirty) await handleSaveDescription();
    if (outDirty) await handleSaveOutput();
  };

  if (!liveTicket) return null;

  return (
    <CommonModal
      open={open}
      onClose={handleClose}
      title={null}
      showCloseButton={false}
      ariaLabel={`Chi tiết ticket ${liveTicket.key}`}
      classNameOverlay="modal-overlay--ticket"
      classNameContent="modal-content--ticket"
      zIndex={1250}
    >
      <header className="ticket-modal-header">
        <div className="ticket-modal-header__layout">
          <div className="ticket-modal-header__ticket">
            <div className="ticket-modal-header__identity">
              <JiraTicketKeyLink
                issueKey={liveTicket.key}
                onOpen={openJiraTicket}
                className="ticket-modal-header__key jira-ticket-key-link"
                showIcon
              />
            </div>
            {(ticketDetails?.summary || liveTicket.summary) && (
              <p className="ticket-modal-header__summary">
                {ticketDetails?.summary || liveTicket.summary}
              </p>
            )}
          </div>
          <div className="ticket-modal-header__aside">
            {ticketDetails && (
              <TicketScheduleStrip details={ticketDetails} loading={loadingDetails} />
            )}
            <button
              type="button"
              className="modal-header__close"
              onClick={handleClose}
              aria-label="Đóng"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </header>

      {ticketDetails && liveTicket && (
        <TicketEffortMeta
          details={ticketDetails}
          loading={loadingDetails}
          leading={
            <div className="ticket-effort-meta__assignee">
              <UserIcon size={14} aria-hidden className="ticket-effort-meta__icon" />
              <span className="ticket-effort-meta__creator-line">
                <span className="ticket-effort-meta__creator-label">Gán cho</span>
                <TicketAssigneeField
                  assignee={liveTicket.assignee ?? ticketDetails.assignee ?? null}
                  displayAssignee={isAssigneeLocked ? parentStoryAssignee : undefined}
                  projectUsers={projectUsers}
                  canEdit={canTransition && !!onAssigneeChange}
                  locked={isAssigneeLocked}
                  saving={savingAssigneeKey === liveTicket.key}
                  editing={assigneeEditing}
                  onStartEdit={() => setAssigneeEditing(true)}
                  onCancelEdit={() => setAssigneeEditing(false)}
                  onChange={async next => {
                    if (!onAssigneeChange) return;
                    await onAssigneeChange(liveTicket.key, next);
                  }}
                  apiBaseUrl={apiBaseUrl}
                  showAvatar
                />
              </span>
            </div>
          }
          trailing={
            <>
              <TicketLogworkButton
                issueKey={liveTicket.key}
                ticketSummary={ticketDetails?.summary || liveTicket.summary}
                ticketDescription={ticketDetails?.description}
                originalEstimateSeconds={
                  ticketDetails?.originalEstimate ?? liveTicket?.originalEstimate
                }
                defaultTimeSpentSeconds={ticketDetails?.timeSpentMonth ?? liveTicket?.timeSpent}
                existingWorklog={ticketDetails?.myWorklog ?? null}
                worklogYear={Number(selectedMonth.split('-')[0]) || undefined}
                worklogMonth={Number(selectedMonth.split('-')[1]) || undefined}
                apiFetch={apiFetch}
                apiBaseUrl={apiBaseUrl}
                canAct={canLogwork}
                onLogged={async () => {
                  await loadTicketDetails(liveTicket.key);
                  onTicketUpdated?.();
                }}
              />
              <TicketStatusTransition
                issueKey={liveTicket.key}
                currentStatus={liveTicket.status}
                apiFetch={apiFetch}
                apiBaseUrl={apiBaseUrl}
                canAct={canTransition}
                prefillFields={{ customfield_10304: ticketDetails?.output || '' }}
                aiContext={{
                  summary: ticketDetails?.summary || liveTicket?.summary,
                  description: ticketDetails?.description || '',
                }}
                onStatusChanged={({ status, statusCategory }) => {
                  if (status) {
                    setLiveTicket((prev: any) =>
                      prev ? { ...prev, status, statusCategory } : prev
                    );
                  }
                  void loadTicketDetails(liveTicket.key);
                  onTicketUpdated?.();
                }}
              />
            </>
          }
        />
      )}

      <div className="ticket-modal-scroll">
        <TicketModalTabs
          active={ticketDetailTab}
          onChange={setTicketDetailTab}
          commentCount={ticketDetails?.comments?.length ?? 0}
          tabs={[
            { id: 'content', label: 'Mô tả' },
            {
              id: 'attachments',
              label: 'Đính kèm',
              badge: attachmentCount > 0 ? attachmentCount : undefined,
            },
            {
              id: 'comments',
              label: 'Bình luận',
              badge:
                (ticketDetails?.comments?.length ?? 0) > 0
                  ? ticketDetails?.comments?.length
                  : undefined,
            },
          ]}
        />

        {ticketDetailTab === 'content' && ticketDetails && (
          <div className="ticket-modal-tab-panel">
            <div className="preview-section">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.4rem',
                }}
              >
                <h6 className="section-title ticket-preview-section__title">Mô tả (Description)</h6>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => handleCopy(ticketDetails.description || '', 'description')}
                    style={{ padding: '2px 6px', height: '24px' }}
                  >
                    {copied === 'description' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  {canUpdate && !descriptionEditMode ? (
                    <TicketFieldEditButton
                      onClick={beginDescriptionEdit}
                      disabled={loadingDetails || isUpdating}
                      iconOnly
                      title="Chỉnh sửa mô tả"
                    />
                  ) : null}
                  {canUpdate && !descriptionEditMode && (
                    <button
                      type="button"
                      className="ai-assist-btn"
                      onClick={() => void handleAiRewrite('description')}
                      disabled={rewriting === 'description' || loadingDetails}
                      style={{ fontSize: '0.65rem', padding: '2px 8px', height: '24px' }}
                    >
                      {rewriting === 'description' ? (
                        <Loader2 size={12} className="spinner" />
                      ) : (
                        <Sparkles size={12} />
                      )}{' '}
                      AI Phân tích & Viết lại
                    </button>
                  )}
                </div>
              </div>
              {canUpdate && descriptionEditMode ? (
                <JiraRichComposer
                  key={`desc-${liveTicket.key}`}
                  issueKey={liveTicket.key}
                  apiBaseUrl={apiBaseUrl}
                  wiki={ticketDetails.description || ''}
                  images={descriptionImages}
                  onChange={({ wiki, images }) => {
                    setTicketDetails(prev => (prev ? { ...prev, description: wiki } : null));
                    setDescriptionImages(images);
                  }}
                  disabled={rewriting === 'description' || loadingDetails || isUpdating}
                  className={`ticket-field--composer ${rewriting === 'description' ? 'field-loading' : ''} ${loadingDetails ? 'field-pending' : ''}`}
                  minHeight={220}
                  placeholder="Soạn mô tả — chèn ảnh inline..."
                  hint="Ctrl+V dán screenshot."
                />
              ) : (
                <JiraRichContent
                  content={ticketDetails.description}
                  issueKey={liveTicket.key}
                  apiBaseUrl={apiBaseUrl}
                  apiFetch={apiFetch}
                  eagerImages
                  className={`ticket-field ticket-field--rich ${loadingDetails ? 'field-pending' : ''}`}
                  maxHeight="min(50vh, 420px)"
                />
              )}
            </div>

            <div className="preview-section">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.4rem',
                }}
              >
                <h6 className="section-title ticket-preview-section__title">
                  Output (Kết quả xử lý)
                </h6>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    type="button"
                    className="copy-btn"
                    onClick={() => handleCopy(ticketDetails.output || '', 'output')}
                    style={{ padding: '2px 6px', height: '24px' }}
                  >
                    {copied === 'output' ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                  {canUpdate && !outputEditMode ? (
                    <TicketFieldEditButton
                      onClick={() => setOutputEditMode(true)}
                      disabled={loadingDetails || isUpdating}
                    />
                  ) : null}
                  {canUpdate && !outputEditMode && (
                    <button
                      type="button"
                      className="ai-assist-btn"
                      onClick={() => void handleAiRewrite('output')}
                      disabled={rewriting === 'output' || loadingDetails}
                      style={{ fontSize: '0.65rem', padding: '2px 8px', height: '24px' }}
                    >
                      {rewriting === 'output' ? (
                        <Loader2 size={12} className="spinner" />
                      ) : (
                        <Sparkles size={12} />
                      )}{' '}
                      AI Viết output
                    </button>
                  )}
                </div>
              </div>
              <TicketOutputField
                value={ticketDetails.output || ''}
                editing={canUpdate && outputEditMode}
                disabled={rewriting === 'output' || loadingDetails || isUpdating}
                className={loadingDetails ? 'field-pending' : ''}
                onChange={next =>
                  setTicketDetails(prev => (prev ? { ...prev, output: next } : null))
                }
              />
            </div>
          </div>
        )}

        {ticketDetailTab === 'attachments' && liveTicket && (
          <div className="ticket-modal-tab-panel">
            <TicketAttachmentList
              issueKey={liveTicket.key}
              apiFetch={apiFetch}
              apiBaseUrl={apiBaseUrl}
              className="preview-section"
              onCountChange={setAttachmentCount}
            />
          </div>
        )}

        {ticketDetailTab === 'comments' && ticketDetails && (
          <div className="ticket-modal-tab-panel ticket-modal-tab-panel--comments">
            <TicketCommentList
              comments={ticketDetails.comments}
              className="preview-section"
              fillAvailable
              issueKey={liveTicket.key}
              apiBaseUrl={apiBaseUrl}
              apiFetch={apiFetch}
              eagerImages
              onOpenJiraTicket={openJiraTicket}
              hint={
                ticketDetails.commentsIncludeRelated
                  ? ticketDetails.isSubtask
                    ? `Gồm comment story cha${ticketDetails.parentKey ? ` ${ticketDetails.parentKey}` : ''} & sub-task liên quan.`
                    : 'Gồm comment story & sub-task liên quan.'
                  : undefined
              }
            />
            <TicketActionPanel
              issueKey={liveTicket.key}
              apiFetch={apiFetch}
              apiBaseUrl={apiBaseUrl}
              canAct={hasJiraToken(currentUser)}
              className="preview-section"
              onSuccess={({ status }) => {
                if (status) {
                  setLiveTicket((prev: any) => (prev ? { ...prev, status } : prev));
                }
                void loadTicketDetails(liveTicket.key);
                onTicketUpdated?.();
              }}
            />
          </div>
        )}
      </div>

      {ticketDetails && <TicketSystemLogBar details={ticketDetails} loading={loadingDetails} />}

      <div className="ticket-modal-footer">
        <button
          type="button"
          className="btn-secondary ticket-modal-footer__btn"
          onClick={handleClose}
        >
          Đóng
        </button>
        {canUpdate && hasUnsavedEdits ? (
          <button
            type="button"
            className="btn-primary ticket-modal-footer__btn ticket-modal-footer__btn--save"
            onClick={() => void handleSaveModalEdits()}
            disabled={isUpdating}
          >
            {isUpdating ? <Loader2 size={14} className="spinner" /> : <Check size={14} />}
            Lưu thay đổi
          </button>
        ) : null}
        <button
          type="button"
          className="btn-primary ticket-modal-footer__btn"
          onClick={() => openJiraTicket(liveTicket.key)}
        >
          Xem trên Jira
          <ExternalLink size={14} />
        </button>
      </div>
    </CommonModal>
  );
}
