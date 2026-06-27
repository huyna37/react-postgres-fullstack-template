import {
  AlarmClock,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Hourglass,
  ListTodo,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  User as UserIcon,
  X,
} from 'lucide-react';
import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CommonModal from '../components/CommonModal';
import JiraRichComposer from '../components/JiraRichComposer';
import JiraRichContent from '../components/JiraRichContent';
import JiraTicketKeyLink from '../components/JiraTicketKeyLink';
import TicketActionPanel from '../components/TicketActionPanel';
import TicketAttachmentList from '../components/TicketAttachmentList';
import TicketCommentList from '../components/TicketCommentList';
import TicketAssigneeField, { buildAssigneeFromId } from '../components/TicketAssigneeField';
import TicketFieldEditButton from '../components/TicketFieldEditButton';
import TicketLogworkButton from '../components/TicketLogworkButton';
import { TicketModalTabs, type TicketModalTab } from '../components/TicketModalTabs';
import TicketOutputField from '../components/TicketOutputField';
import TicketStatusTransition from '../components/TicketStatusTransition';
import { useDashboardViewportMetrics } from '../hooks/useDashboardViewportMetrics';
import { getAvatarUrl } from '../utils/avatar';
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
import { filterDashboardUserGroups } from '../utils/jiraIssueStatus';
import { currentWeekYmdRangeBangkok, isPlanDateInWeek } from '../utils/planDates';
import { isSameDashboardGroups } from '../utils/stableDataCompare';
import { showError, showWarning } from '../utils/swal';
import { countWorkingDays, requiredHoursForWorkingDays } from '../utils/workingDays';

type TicketDetailFields = {
  summary: string;
  description: string;
  output: string;
  startDate?: string | null;
  dueDate?: string | null;
  updated?: string | null;
  created?: string | null;
  timeSpent?: number;
  /** Logwork trong tháng đang xem (dashboard) */
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

const formatTicketDateShort = (val?: string | null) => {
  const p = parsePlanDateYmd(val);
  if (p) return `${p.day}/${p.month}`;
  if (!val) return '—';
  const d = new Date(val);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Bangkok' });
};

const planDateSortKey = (val?: string | null) => {
  const p = parsePlanDateYmd(val);
  return p ? p.year * 10000 + p.month * 100 + p.day : Number.MAX_SAFE_INTEGER;
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

/** Số giờ gọn cho log / estimate (luôn có đơn vị h) */
const formatHoursCompact = (sec?: number | null) => {
  if (sec == null || sec <= 0) return null;
  return `${(sec / 3600).toFixed(1)}h`;
};

const metaDisplay = (formatted: string) => (formatted === '—' ? 'Chưa có' : formatted);

/** Lịch kế hoạch — ngay dưới header ticket */
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

/** Một số giờ gọn: nhãn nhỏ + giá trị */
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

/** Gán cho + effort — compact, trước nội dung chính */
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

/** Nhật ký hệ thống — cuối modal, trước nút hành động */
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

const normalizeSearchQuery = (q: string) => q.trim().toLowerCase();

const DASHBOARD_SEARCH_DEBOUNCE_MS = 300;
const DASHBOARD_SEARCH_MIN_LEN = 2;

const parseDashboardMonthlyResponse = (json: unknown): any[] => {
  const raw = Array.isArray(json)
    ? json
    : Array.isArray((json as { users?: any[] })?.users)
      ? (json as { users: any[] }).users
      : [];
  return filterDashboardUserGroups(raw);
};

const ticketDetailsFromListItem = (ticket: any): TicketDetailFields => ({
  summary: ticket.summary || '',
  description: ticket.description || '',
  output: ticket.output || '',
  startDate: ticket.startDate ?? null,
  dueDate: ticket.dueDate ?? null,
  updated: ticket.updated ?? null,
  created: ticket.created ?? null,
  timeSpent: ticket.timeSpent ?? 0,
  timeSpentMonth: ticket.timeSpent ?? 0,
  originalEstimate: ticket.originalEstimate ?? 0,
  remainingEstimate: ticket.remainingEstimate ?? 0,
  creator: ticket.creator || null,
  creatorEmail: ticket.creatorEmail || null,
  assignee: ticket.assignee ?? null,
  comments: ticket.comments || [],
  isSubtask: ticket.isSubtask,
  parentKey: ticket.parentKey,
});

type DashboardStatusFilter = 'all' | 'pending' | 'done';

const AVATAR_FALLBACK_SVG =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="%23475569"/><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm0 14c-2.03 0-4.43-.82-6.14-2.88C7.55 15.8 9.68 15 12 15s4.45.8 6.14 2.12C16.43 19.18 14.03 20 12 20z" fill="%2394a3b8"/></svg>';

const ticketMatchesStatusFilter = (ticket: any, filter: DashboardStatusFilter) => {
  if (filter === 'pending') {
    return ticket.statusCategory === 'indeterminate' || ticket.statusCategory === 'new';
  }
  if (filter === 'done') return ticket.statusCategory === 'done';
  return true;
};

const computeDashboardUserMetrics = (tickets: any[], targetYear: number, targetMonth: number) => {
  const isPlannedInSelectedMonth = (t: any) => {
    const startP = parsePlanDateYmd(t.startDate);
    const dueP = parsePlanDateYmd(t.dueDate);
    const isStartInMonth = !!startP && startP.year === targetYear && startP.month === targetMonth;
    const isDueInMonth = !!dueP && dueP.year === targetYear && dueP.month === targetMonth;
    return isStartInMonth || isDueInMonth;
  };

  const seTickets = tickets.filter(isPlannedInSelectedMonth);
  const pendingTickets = tickets.filter(
    (t: any) => t.statusCategory === 'indeterminate' || t.statusCategory === 'new'
  );
  const doneTickets = tickets.filter((t: any) => t.statusCategory === 'done');

  return {
    logHours: seTickets.reduce((sum: number, t: any) => sum + (t.timeSpent || 0), 0) / 3600,
    estWithLog:
      seTickets.reduce(
        (sum: number, t: any) => sum + (t.timeSpent > 0 ? t.originalEstimate || 0 : 0),
        0
      ) / 3600,
    totalEst: seTickets.reduce((sum: number, t: any) => sum + (t.originalEstimate || 0), 0) / 3600,
    pendingEst:
      pendingTickets
        .filter(isPlannedInSelectedMonth)
        .reduce((sum: number, t: any) => sum + (t.originalEstimate || 0), 0) / 3600,
    doneEst:
      doneTickets
        .filter(isPlannedInSelectedMonth)
        .reduce((sum: number, t: any) => sum + (t.originalEstimate || 0), 0) / 3600,
    pendingCount: pendingTickets.length,
    doneCount: doneTickets.length,
  };
};

type DashboardUserCardProps = {
  group: any;
  activeFilter: DashboardStatusFilter;
  selectedMonth: string;
  apiBaseUrl: string;
  onFilterChange: (accountId: string, filter: DashboardStatusFilter) => void;
  onTicketClick: (ticket: any) => void;
  onOpenJiraTicket: (key: string) => void;
};

const DashboardUserCard = React.memo(function DashboardUserCard({
  group,
  activeFilter,
  selectedMonth,
  apiBaseUrl,
  onFilterChange,
  onTicketClick,
  onOpenJiraTicket,
}: DashboardUserCardProps) {
  const accountId = group.user.accountId;
  const [targetYearStr, targetMonthStr] = selectedMonth.split('-');
  const targetYear = parseInt(targetYearStr, 10);
  const targetMonth = parseInt(targetMonthStr, 10);

  const metrics = useMemo(
    () => computeDashboardUserMetrics(group.tickets, targetYear, targetMonth),
    [group.tickets, targetYear, targetMonth]
  );

  const visibleCount = useMemo(() => {
    if (activeFilter === 'all') return group.tickets.length;
    let count = 0;
    for (const ticket of group.tickets) {
      if (ticketMatchesStatusFilter(ticket, activeFilter)) count += 1;
    }
    return count;
  }, [group.tickets, activeFilter]);

  return (
    <div className="dashboard-user-card">
      <div className="dashboard-user-header">
        <div className="dashboard-user-header__row">
          <div className="dashboard-user-header__profile">
            <div className="user-avatar user-avatar--dashboard">
              <img
                src={
                  group.user.avatarUrl
                    ? getAvatarUrl(group.user.avatarUrl, apiBaseUrl)
                    : AVATAR_FALLBACK_SVG
                }
                alt={group.user.displayName}
                onError={e => {
                  (e.target as HTMLImageElement).src = AVATAR_FALLBACK_SVG;
                }}
              />
            </div>
            <h3 className="dashboard-user-header__name" title={group.user.displayName}>
              {group.user.displayName}
            </h3>
          </div>
          <div className="dashboard-user-effort-pills">
            <div className="dashboard-user-effort-pill" title="Tổng logwork tháng (ticket có log)">
              <span className="dashboard-user-effort-pill__label">Log</span>
              <span className="dashboard-user-effort-pill__value">
                {metrics.logHours.toFixed(1)}h
              </span>
            </div>
            <div className="dashboard-user-effort-pill" title="Tổng estimate (ticket có log)">
              <span className="dashboard-user-effort-pill__label">Est</span>
              <span className="dashboard-user-effort-pill__value">
                {metrics.estWithLog.toFixed(1)}h
              </span>
            </div>
          </div>
        </div>
        <div className="dashboard-user-filter-bar" role="tablist" aria-label="Lọc ticket">
          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'all'}
            onClick={() => onFilterChange(accountId, 'all')}
            className={`dashboard-user-filter-seg dashboard-user-filter-seg--all${activeFilter === 'all' ? ' is-active' : ''}`}
            title={`Tất cả ticket — Est ${metrics.totalEst.toFixed(1)}h`}
          >
            <ListTodo size={11} aria-hidden />
            <span className="dashboard-user-filter-seg__count">{group.tickets.length}</span>
            <span className="dashboard-user-filter-seg__est">{metrics.totalEst.toFixed(1)}h</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'pending'}
            onClick={() =>
              onFilterChange(accountId, activeFilter === 'pending' ? 'all' : 'pending')
            }
            className={`dashboard-user-filter-seg dashboard-user-filter-seg--pending${activeFilter === 'pending' ? ' is-active' : ''}`}
            title={`Đang làm — Est ${metrics.pendingEst.toFixed(1)}h`}
          >
            <Hourglass size={11} aria-hidden />
            <span className="dashboard-user-filter-seg__count">{metrics.pendingCount}</span>
            <span className="dashboard-user-filter-seg__est">{metrics.pendingEst.toFixed(1)}h</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeFilter === 'done'}
            onClick={() => onFilterChange(accountId, activeFilter === 'done' ? 'all' : 'done')}
            className={`dashboard-user-filter-seg dashboard-user-filter-seg--done${activeFilter === 'done' ? ' is-active' : ''}`}
            title={`Hoàn thành — Est ${metrics.doneEst.toFixed(1)}h`}
          >
            <CheckCircle2 size={11} aria-hidden />
            <span className="dashboard-user-filter-seg__count">{metrics.doneCount}</span>
            <span className="dashboard-user-filter-seg__est">{metrics.doneEst.toFixed(1)}h</span>
          </button>
        </div>
      </div>

      <div className="dashboard-tickets">
        {visibleCount === 0 ? (
          <p className="dashboard-tickets-empty">
            {activeFilter === 'pending'
              ? 'Không có task pending nào.'
              : activeFilter === 'done'
                ? 'Không có task done nào.'
                : 'Không có task nào đang làm.'}
          </p>
        ) : (
          group.tickets.map((t: any) => {
            const hidden = !ticketMatchesStatusFilter(t, activeFilter);
            return (
              <div
                key={t.key}
                className={`dashboard-ticket-item${hidden ? ' dashboard-ticket-item--filter-hidden' : ''}`}
                onClick={() => onTicketClick(t)}
                style={{ cursor: 'pointer' }}
                aria-hidden={hidden}
              >
                <div className="dashboard-ticket-item__head">
                  <div className="dashboard-ticket-item__identity">
                    <JiraTicketKeyLink
                      issueKey={t.key}
                      onOpen={onOpenJiraTicket}
                      className="dashboard-ticket-key"
                      showIcon
                      stopPropagation
                    />
                    {t.issueType && (
                      <span
                        className={`dashboard-issue-badge ${
                          t.issueType.toLowerCase().includes('bug')
                            ? 'dashboard-issue-badge--bug'
                            : 'dashboard-issue-badge--default'
                        }`}
                      >
                        {t.issueType}
                      </span>
                    )}
                  </div>
                  <span className="dashboard-ticket-status" title={t.status}>
                    {t.status}
                  </span>
                </div>
                <p className="dashboard-ticket-item__summary" title={t.summary}>
                  {t.summary}
                </p>
                <div className="dashboard-ticket-item__foot">
                  {t.creator ? (
                    <span className="dashboard-ticket-meta" title={t.creator}>
                      <span>Tạo:</span>
                      <strong>{t.creator.split(' ').pop()}</strong>
                    </span>
                  ) : null}
                  <div className="dashboard-ticket-item__foot-right">
                    <span className="dashboard-ticket-item__dates">
                      {t.startDate ? (
                        <span
                          className="dashboard-date--start"
                          title={`Bắt đầu: ${formatTicketDate(t.startDate)}`}
                        >
                          <Play size={10} aria-hidden />
                          {formatTicketDateShort(t.startDate)}
                        </span>
                      ) : null}
                      {t.dueDate ? (
                        <span
                          className="dashboard-date--due"
                          title={`Hạn: ${formatTicketDate(t.dueDate)}`}
                        >
                          <AlarmClock size={10} aria-hidden />
                          {formatTicketDateShort(t.dueDate)}
                        </span>
                      ) : null}
                      {t.updated ? (
                        <span
                          className="dashboard-date--upd"
                          title={`Cập nhật: ${new Date(t.updated).toLocaleString('vi-VN')}`}
                        >
                          <RefreshCw size={10} aria-hidden />
                          {new Date(t.updated).toLocaleDateString('vi-VN', {
                            day: 'numeric',
                            month: 'numeric',
                          })}
                        </span>
                      ) : null}
                    </span>
                    {(t.timeSpent > 0 || t.originalEstimate > 0) && (
                      <span className="ticket-effort-stats dashboard-ticket-effort">
                        {t.timeSpent > 0 && (
                          <EffortStat
                            label="Log"
                            hours={formatHoursCompact(t.timeSpent)}
                            title="Logwork tháng này"
                          />
                        )}
                        {t.originalEstimate > 0 && (
                          <EffortStat
                            label="Est"
                            hours={formatHoursCompact(t.originalEstimate)}
                            title="Estimate ban đầu"
                          />
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});

interface DashboardProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
  currentUser: any | null;
  /** Chỉ true khi tab Dashboard đang hiển thị — tránh poll API khi ở trang khác */
  isActive?: boolean;
}

const escapeHtml = (s: string) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const LINK_STYLE = 'color:#93c5fd;text-decoration:underline;word-break:break-all';

/** Escape HTML rồi bọc URL http(s) trong &lt;a&gt; (mở tab mới). */
const escapeHtmlWithLinks = (raw: string) => {
  const text = String(raw ?? '');
  const re = /https?:\/\/[^\s<>"']+/gi;
  const pieces: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    pieces.push(escapeHtml(text.slice(last, m.index)));
    const full = m[0];
    const trimmed = full.replace(/[.,;:!?)]+$/g, '');
    const safeUrl = trimmed || full;
    const href = escapeHtml(safeUrl);
    pieces.push(
      `<a href="${href}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLE}">${href}</a>`
    );
    last = m.index + full.length;
  }
  pieces.push(escapeHtml(text.slice(last)));
  return pieces.join('');
};

type ProjectAssistantMsg = { role: 'user' | 'assistant'; content: string };

/** Dựng HTML nội dung kết quả (đã escape) — dùng với dangerouslySetInnerHTML. */
const buildProjectAssistantResultHtml = (data: Record<string, unknown>) => {
  const answer = typeof data.answer === 'string' ? data.answer : '';
  const steps = (Array.isArray(data.steps) ? data.steps : []) as Array<{
    title?: string;
    detail?: string;
  }>;

  const stepsHtml =
    steps.length > 0
      ? `<div style="margin-bottom:0.65rem;padding-bottom:0.65rem;border-bottom:1px solid var(--border-color)"><div style="font-size:0.72rem;color:var(--text-secondary);margin-bottom:0.4rem">Căn cứ</div>${steps
          .map(
            (s, i) =>
              `<div style="margin-bottom:0.5rem"><strong style="color:#a5b4fc;font-size:0.8rem">${i + 1}. ${escapeHtml(String(s.title || 'Căn cứ'))}</strong><div style="font-size:0.78rem;color:#cbd5e1;line-height:1.45;margin-top:0.2rem">${escapeHtmlWithLinks(String(s.detail || ''))}</div></div>`
          )
          .join('')}</div>`
      : '';

  const caveatsHtml = data.caveats
    ? `<div style="font-size:0.78rem;color:#fcd34d;background:rgba(251,191,36,0.06);padding:0.5rem 0.6rem;border-radius:6px;margin-top:0.65rem;border:1px solid rgba(251,191,36,0.15)"><strong>Lưu ý:</strong> ${escapeHtmlWithLinks(String(data.caveats))}</div>`
    : '';

  return `${stepsHtml}<div style="white-space:pre-wrap;line-height:1.55;color:#f1f5f9;font-size:0.92rem">${escapeHtmlWithLinks(answer)}</div>${caveatsHtml}`;
};

const Dashboard: React.FC<DashboardProps> = ({
  apiFetch,
  API_BASE_URL,
  openJiraTicket,
  currentUser,
  isActive = true,
}) => {
  const [dashboardData, setDashboardData] = useState<any[]>([]);
  const [activeProjects, setActiveProjects] = useState<{ jira_key: string; name: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState(() => {
    return currentUser?.jira_project || 'BXDCSDL';
  });
  const [sortBy, setSortBy] = useState<
    'startDate' | 'dueDate' | 'updated' | 'timeEstimate' | 'key' | 'status'
  >('startDate');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [ticketSearchInput, setTicketSearchInput] = useState('');
  const [ticketSearchQuery, setTicketSearchQuery] = useState('');
  const [searchDashboardData, setSearchDashboardData] = useState<any[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingDashboard, setLoadingDashboard] = useState(false);
  const [isRefreshingDashboard, setIsRefreshingDashboard] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<any | null>(null);
  const [ticketPanelOpen, setTicketPanelOpen] = useState(false);
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
  const [attachmentCount, setAttachmentCount] = useState(0);
  const [projectUsers, setProjectUsers] = useState<any[]>([]);
  const [savingAssigneeKey, setSavingAssigneeKey] = useState<string | null>(null);
  const [assigneeEditing, setAssigneeEditing] = useState(false);

  const [paOpen, setPaOpen] = useState(false);
  const [paStep, setPaStep] = useState<'form' | 'loading' | 'result'>('form');
  const [paProjects, setPaProjects] = useState<{ id: number; name: string; jira_key: string }[]>(
    []
  );
  const [paProjectId, setPaProjectId] = useState<number | ''>('');
  const [paQuestion, setPaQuestion] = useState('');
  const [paFormError, setPaFormError] = useState('');
  const [paConversation, setPaConversation] = useState<ProjectAssistantMsg[]>([]);
  const [paResultHtml, setPaResultHtml] = useState('');
  /** Tránh double-open trong lúc fetch danh sách dự án (setState paOpen chưa kịp). */
  const paOpeningRef = useRef(false);
  const paLastProjectIdRef = useRef<number | null>(null);
  const paSubmittingRef = useRef(false);

  const [userFilters, setUserFilters] = useState<Record<string, DashboardStatusFilter>>({});

  const handleUserFilterChange = useCallback((accountId: string, filter: DashboardStatusFilter) => {
    setUserFilters(prev => ({ ...prev, [accountId]: filter }));
  }, []);

  // Fetch projects with active users
  useEffect(() => {
    const fetchActiveProjects = async () => {
      try {
        const response = await apiFetch(`${API_BASE_URL}/api/projects/active`);
        if (response.ok) {
          const data = await response.json();
          setActiveProjects(data);
          if (data.length > 0) {
            const currentProj = currentUser?.jira_project || 'BXDCSDL';
            const exists = data.some((p: any) => p.jira_key === currentProj);
            if (exists) {
              setSelectedProject(currentProj);
            } else {
              setSelectedProject(data[0].jira_key);
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch active projects:', error);
      }
    };
    fetchActiveProjects();
  }, [apiFetch, API_BASE_URL, currentUser?.jira_project]);

  useEffect(() => {
    if (!selectedProject) return;
    const fetchProjectUsers = async () => {
      try {
        const res = await apiFetch(
          `${API_BASE_URL}/api/users/active?projectKey=${encodeURIComponent(selectedProject)}`
        );
        if (res.ok) {
          setProjectUsers(await res.json());
        }
      } catch (err) {
        console.error('Failed to fetch project users:', err);
      }
    };
    void fetchProjectUsers();
  }, [selectedProject, apiFetch, API_BASE_URL]);

  const canUpdate = canUpdateTicket(currentUser);
  const canLogwork = canLogworkTicket(currentUser);
  const canTransition = canTransitionTicket(currentUser);
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });

  const dashboardDataRef = useRef<any[]>([]);
  const searchDashboardDataRef = useRef<any[] | null>(null);
  const dashboardFetchBusyRef = useRef(false);
  const pendingSilentReloadRef = useRef(false);
  const selectedMonthRef = useRef(selectedMonth);
  const selectedProjectRef = useRef(selectedProject);
  const ticketSearchQueryRef = useRef(ticketSearchQuery);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    dashboardDataRef.current = dashboardData;
  }, [dashboardData]);

  useEffect(() => {
    searchDashboardDataRef.current = searchDashboardData;
  }, [searchDashboardData]);

  useEffect(() => {
    ticketSearchQueryRef.current = ticketSearchQuery;
  }, [ticketSearchQuery]);

  const isDashboardSearchActive = ticketSearchQuery.length >= DASHBOARD_SEARCH_MIN_LEN;

  const effectiveDashboardData =
    isDashboardSearchActive && searchDashboardData !== null ? searchDashboardData : dashboardData;

  const dashboardContextKey = () => `${selectedMonthRef.current}|${selectedProjectRef.current}`;

  const dashboardMonthlyUrlFor = (month: string, projectKey: string) => {
    const [year, m] = month.split('-');
    return `${API_BASE_URL}/api/dashboard/monthly?month=${m}&year=${year}&projectKey=${projectKey}`;
  };

  /** Không dùng AbortSignal — request luôn chạy đến hết; chỉ bỏ qua kết quả nếu đã đổi tháng/dự án. */
  const fetchDashboardSearch = useCallback(
    async (signal?: AbortSignal): Promise<boolean> => {
      const q = ticketSearchQueryRef.current;
      if (!q || q.length < DASHBOARD_SEARCH_MIN_LEN) return false;

      const projectKey = selectedProjectRef.current;
      const url = `${API_BASE_URL}/api/dashboard/search?q=${encodeURIComponent(q)}&projectKey=${encodeURIComponent(projectKey)}`;

      try {
        const response = await apiFetch(url, { cache: 'no-store', signal });
        if (ticketSearchQueryRef.current !== q || selectedProjectRef.current !== projectKey) {
          return false;
        }
        if (response.ok) {
          const users = parseDashboardMonthlyResponse(await response.json());
          const prev = searchDashboardDataRef.current;
          if (prev !== null && isSameDashboardGroups(prev, users)) {
            return true;
          }
          setSearchDashboardData(users);
          return true;
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') return false;
        if (error instanceof Error && error.name === 'AbortError') return false;
        console.error('Failed to refresh dashboard search:', error);
      }
      return false;
    },
    [apiFetch, API_BASE_URL]
  );

  const fetchDashboardMonthly = useCallback(async (): Promise<boolean> => {
    const ctx = dashboardContextKey();
    const url = dashboardMonthlyUrlFor(selectedMonthRef.current, selectedProjectRef.current);

    try {
      const response = await apiFetch(url, { cache: 'no-store' });
      if (dashboardContextKey() !== ctx) return false;
      if (response.ok) {
        const users = parseDashboardMonthlyResponse(await response.json());
        if (!isSameDashboardGroups(dashboardDataRef.current, users)) {
          setDashboardData(users);
        }
        return true;
      }
    } catch (error: unknown) {
      if (dashboardContextKey() !== ctx) return false;
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        return false;
      }
      console.error('Failed to fetch dashboard monthly:', error);
    }
    return false;
  }, [apiFetch, API_BASE_URL]);

  const loadDashboardData = useCallback(async () => {
    const ctx = dashboardContextKey();
    const hasCachedData = dashboardDataRef.current.length > 0;
    if (hasCachedData) {
      setIsRefreshingDashboard(true);
    } else {
      setLoadingDashboard(true);
    }
    dashboardFetchBusyRef.current = true;
    try {
      await fetchDashboardMonthly();
      if (ticketSearchQueryRef.current.length >= DASHBOARD_SEARCH_MIN_LEN) {
        await fetchDashboardSearch();
      }
    } finally {
      if (dashboardContextKey() === ctx) {
        setLoadingDashboard(false);
        setIsRefreshingDashboard(false);
      }
      dashboardFetchBusyRef.current = false;
      if (pendingSilentReloadRef.current) {
        pendingSilentReloadRef.current = false;
        void fetchDashboardMonthly();
        if (ticketSearchQueryRef.current.length >= DASHBOARD_SEARCH_MIN_LEN) {
          void fetchDashboardSearch();
        }
      }
    }
  }, [fetchDashboardMonthly, fetchDashboardSearch]);

  const reloadDashboardSilent = useCallback(async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }
    if (dashboardFetchBusyRef.current) {
      pendingSilentReloadRef.current = true;
      return;
    }
    await fetchDashboardMonthly();
    if (ticketSearchQueryRef.current.length >= DASHBOARD_SEARCH_MIN_LEN) {
      await fetchDashboardSearch();
    }
  }, [fetchDashboardMonthly, fetchDashboardSearch]);

  const readApiErrorMessage = async (response: Response) => {
    try {
      const data = await response.json();
      return (data && (data.error || data.message)) || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  };

  const closeProjectAssistantModal = useCallback(() => {
    setPaOpen(false);
    setPaStep('form');
    setPaProjects([]);
    setPaProjectId('');
    setPaQuestion('');
    setPaFormError('');
    setPaConversation([]);
    setPaResultHtml('');
    paOpeningRef.current = false;
    paSubmittingRef.current = false;
  }, []);

  const openProjectAssistant = async () => {
    if (!currentUser) {
      showError('Vui lòng đăng nhập để dùng trợ lý dự án.');
      return;
    }
    if (paOpen || paOpeningRef.current) {
      await showWarning('Đang có phiên hỏi codebase — đóng hộp thoại hiện tại trước khi mở thêm.');
      return;
    }
    paOpeningRef.current = true;
    try {
      const projRes = await apiFetch(`${API_BASE_URL}/api/projects`);
      if (!projRes.ok) {
        showError(await readApiErrorMessage(projRes));
        return;
      }
      const projects = await projRes.json();
      if (!Array.isArray(projects) || projects.length === 0) {
        await showWarning('Chưa có dự án nào. Thêm và clone dự án trong mục Projects trước.');
        return;
      }
      const normalized = projects.map((p: any) => ({
        id: Number(p.id),
        name: String(p.name || ''),
        jira_key: String(p.jira_key || ''),
      }));
      const lastId = paLastProjectIdRef.current;
      const defaultId =
        lastId != null && normalized.some(p => p.id === lastId) ? lastId : normalized[0].id;
      setPaProjects(normalized);
      setPaProjectId(defaultId);
      setPaQuestion('');
      setPaFormError('');
      setPaConversation([]);
      setPaResultHtml('');
      setPaStep('form');
      setPaOpen(true);
    } catch (e) {
      console.error(e);
      showError('Không tải được danh sách dự án.');
    } finally {
      paOpeningRef.current = false;
    }
  };

  const submitProjectAssistantQuestion = async () => {
    if (paSubmittingRef.current) return;
    setPaFormError('');
    const q = paQuestion.trim();
    const pid = Number(paProjectId);
    if (!q) {
      setPaFormError('Vui lòng nhập câu hỏi.');
      return;
    }
    if (!pid || Number.isNaN(pid)) {
      setPaFormError('Chọn dự án.');
      return;
    }
    paSubmittingRef.current = true;
    paLastProjectIdRef.current = pid;
    setPaStep('loading');
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/project-assistant/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: pid,
          question: q,
          conversationHistory: paConversation,
        }),
      });
      if (!res.ok) {
        showError(await readApiErrorMessage(res));
        setPaStep('form');
        return;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const answer = typeof data.answer === 'string' ? data.answer : '';
      setPaResultHtml(buildProjectAssistantResultHtml(data));
      setPaConversation(prev => [
        ...prev,
        { role: 'user', content: q },
        { role: 'assistant', content: answer },
      ]);
      setPaQuestion('');
      setPaStep('result');
    } catch (e) {
      console.error(e);
      showError('Không thể gọi trợ lý dự án.');
      setPaStep('form');
    } finally {
      paSubmittingRef.current = false;
    }
  };

  const handleProjectAssistant = () => {
    void openProjectAssistant();
  };

  const loadTicketDetails = useCallback(
    async (key: string, monthKey = selectedMonth) => {
      setLoadingDetails(true);
      try {
        const [year, month] = monthKey.split('-');
        const response = await apiFetch(
          `${API_BASE_URL}/api/tickets/details/${key}?year=${year}&month=${month}`
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
            setSelectedTicket((prev: any) =>
              prev?.key === key ? { ...prev, timeSpent: data.timeSpentMonth } : prev
            );
          }
          if (data.assignee !== undefined) {
            setSelectedTicket((prev: any) =>
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
    [apiFetch, API_BASE_URL, selectedMonth]
  );

  const handleTicketClick = useCallback(
    (ticket: any) => {
      void fetchIssueAttachments(apiFetch, API_BASE_URL, ticket.key)
        .then(list => setAttachmentCount(list.length))
        .catch(() => setAttachmentCount(0));
      startTransition(() => {
        setSelectedTicket(ticket);
        setTicketDetails(ticketDetailsFromListItem(ticket));
        setDescriptionEditMode(false);
        setOutputEditMode(false);
        setDescriptionImages(prev => {
          revokeJiraImagePreviews(prev);
          return [];
        });
        outputSavedRef.current = ticket.output || '';
        descriptionBaselineRef.current = ticket.description || '';
        setTicketDetailTab('content');
        setAssigneeEditing(false);
        setTicketPanelOpen(true);
      });
      void loadTicketDetails(ticket.key);
    },
    [loadTicketDetails, apiFetch, API_BASE_URL]
  );

  useEffect(() => {
    setAssigneeEditing(false);
  }, [selectedTicket?.key]);

  const patchAssigneeInDashboard = useCallback((issueKey: string, assignee: any | null) => {
    const patchTickets = (tickets: any[]) =>
      tickets.map(t => (t.key === issueKey ? { ...t, assignee } : t));
    const patchGroups = (groups: any[]) =>
      groups.map(g => ({
        ...g,
        tickets: patchTickets(g.tickets || []),
      }));
    setDashboardData(prev => patchGroups(prev));
    setSearchDashboardData(prev => (prev ? patchGroups(prev) : prev));
    setSelectedTicket((prev: any | null) =>
      prev?.key === issueKey ? { ...prev, assignee } : prev
    );
  }, []);

  const handleAssigneeChange = useCallback(
    async (issueKey: string, assigneeId: string) => {
      if (!canTransition) {
        showError('Bạn không có quyền đổi người gán ticket.');
        return;
      }
      if (savingAssigneeKey === issueKey) return;
      const prevAssignee = selectedTicket?.key === issueKey ? selectedTicket.assignee ?? null : null;
      const optimisticAssignee = buildAssigneeFromId(assigneeId, projectUsers);
      setSavingAssigneeKey(issueKey);
      patchAssigneeInDashboard(issueKey, optimisticAssignee);
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/tickets/${issueKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigneeId: assigneeId || null }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Cập nhật assignee thất bại');
        patchAssigneeInDashboard(issueKey, data.assignee ?? optimisticAssignee);
      } catch (err: unknown) {
        patchAssigneeInDashboard(issueKey, prevAssignee);
        showError(err instanceof Error ? err.message : 'Lỗi khi cập nhật assignee');
        throw err;
      } finally {
        setSavingAssigneeKey(prev => (prev === issueKey ? null : prev));
      }
    },
    [
      API_BASE_URL,
      apiFetch,
      canTransition,
      patchAssigneeInDashboard,
      projectUsers,
      savingAssigneeKey,
      selectedTicket?.assignee,
      selectedTicket?.key,
    ]
  );

  const closeTicketPanel = () => {
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
    setTicketPanelOpen(false);
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
    if (!selectedTicket || !ticketDetails || isUpdating) return;
    const nextDescription = payload?.wiki ?? ticketDetails.description;
    const nextImages = payload?.images ?? descriptionImages;
    setIsUpdating(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/tickets/${selectedTicket.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: nextDescription,
          images: nextImages.length > 0 ? await serializeJiraImages(nextImages) : undefined,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Cập nhật mô tả thất bại');
      }
      const data = await response.json();
      setTicketDetails(prev =>
        prev ? { ...prev, description: data.description ?? nextDescription } : prev
      );
      setSelectedTicket((prev: any) =>
        prev ? { ...prev, description: data.description ?? nextDescription } : prev
      );
      revokeJiraImagePreviews(nextImages);
      setDescriptionImages([]);
      setDescriptionEditMode(false);
      descriptionBaselineRef.current = data.description ?? nextDescription;
      void loadTicketDetails(selectedTicket.key);
      await fetchDashboardMonthly();
    } catch (error) {
      console.error('Description save failed:', error);
      showError(error instanceof Error ? error.message : 'Có lỗi xảy ra khi lưu mô tả');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaveOutput = async (nextOutput?: string) => {
    if (!selectedTicket || !ticketDetails || isUpdating) return;
    const output = nextOutput ?? ticketDetails.output ?? '';
    if (output === outputSavedRef.current) return;
    setIsUpdating(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/tickets/${selectedTicket.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Cập nhật output thất bại');
      }
      const data = await response.json();
      const saved = data.output ?? output;
      outputSavedRef.current = saved;
      setTicketDetails(prev => (prev ? { ...prev, output: saved } : prev));
      setOutputEditMode(false);
      void loadTicketDetails(selectedTicket.key);
    } catch (error) {
      console.error('Output save failed:', error);
      showError(error instanceof Error ? error.message : 'Có lỗi xảy ra khi lưu output');
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
      const response = await apiFetch(`${API_BASE_URL}/api/generate/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fieldType,
          currentContent: contentToProcess,
        }),
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

  useEffect(() => {
    selectedMonthRef.current = selectedMonth;
    selectedProjectRef.current = selectedProject;
    void loadDashboardData();
  }, [selectedMonth, selectedProject, loadDashboardData]);

  useEffect(() => {
    const trimmed = ticketSearchInput.trim();
    if (!trimmed) {
      setTicketSearchQuery('');
      setSearchDashboardData(null);
      setSearchLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setTicketSearchQuery(normalizeSearchQuery(ticketSearchInput));
    }, DASHBOARD_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [ticketSearchInput]);

  useEffect(() => {
    const q = ticketSearchQuery;
    searchAbortRef.current?.abort();

    if (!q || q.length < DASHBOARD_SEARCH_MIN_LEN) {
      if (!q) {
        setSearchDashboardData(null);
      }
      setSearchLoading(false);
      return;
    }

    const projectKey = selectedProject;
    const controller = new AbortController();
    searchAbortRef.current = controller;

    void (async () => {
      setSearchLoading(true);
      try {
        const ok = await fetchDashboardSearch(controller.signal);
        if (
          ticketSearchQueryRef.current === q &&
          selectedProjectRef.current === projectKey &&
          !ok
        ) {
          setSearchDashboardData([]);
        }
      } finally {
        if (
          !controller.signal.aborted &&
          ticketSearchQueryRef.current === q &&
          selectedProjectRef.current === projectKey
        ) {
          setSearchLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [ticketSearchQuery, selectedProject, fetchDashboardSearch]);

  useEffect(() => {
    if (ticketPanelOpen) return;
    const t = window.setTimeout(() => setSelectedTicket(null), 230);
    return () => clearTimeout(t);
  }, [ticketPanelOpen]);
  // 7s Background reload — chỉ khi tab Dashboard đang active và tab trình duyệt visible
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void reloadDashboardSilent();
    }, 7000);

    return () => clearInterval(interval);
  }, [reloadDashboardSilent, isActive]);

  // Stats calculation (theo kết quả tìm kiếm nếu có)
  const stats = React.useMemo(() => {
    const allTickets = effectiveDashboardData.flatMap(u => u.tickets);
    const week = currentWeekYmdRangeBangkok();
    const weeklyByKey = new Map<string, (typeof allTickets)[0]>();
    for (const t of allTickets) {
      if (isPlanDateInWeek(t.startDate, week) || isPlanDateInWeek(t.dueDate, week)) {
        weeklyByKey.set(t.key, t);
      }
    }
    const weeklyTickets = [...weeklyByKey.values()];
    const clientWeeklyLogSeconds = weeklyTickets.reduce(
      (sum, t) => sum + (t.timeSpentWeek ?? 0),
      0
    );
    const [monthYearStr, monthNumStr] = selectedMonth.split('-');
    const monthWorkingDays = countWorkingDays(
      parseInt(monthYearStr, 10),
      parseInt(monthNumStr, 10)
    );

    return {
      total: allTickets.length,
      monthWorkingDays,
      monthMinHours: requiredHoursForWorkingDays(monthWorkingDays),
      weeklySpent: clientWeeklyLogSeconds / 3600,
      weeklyEstimate: weeklyTickets.reduce((sum, t) => sum + (t.originalEstimate || 0), 0) / 3600,
      todo: allTickets.filter(t => t.statusCategory === 'new').length,
      inProgress: allTickets.filter(t => t.statusCategory === 'indeterminate').length,
      done: allTickets.filter(t => t.statusCategory === 'done').length,
    };
  }, [effectiveDashboardData, selectedMonth]);

  const sortedDashboardData = React.useMemo(() => {
    const [targetYearStr, targetMonthStr] = selectedMonth.split('-');
    const targetYear = parseInt(targetYearStr);
    const targetMonth = parseInt(targetMonthStr);
    const useMonthTiers = !isDashboardSearchActive;

    return effectiveDashboardData
      .map(group => {
        const sortedTickets = [...group.tickets].sort((a, b) => {
          // 1. Sort by timeEstimate (Thời gian log)
          if (sortBy === 'timeEstimate') {
            const hasA = a.timeSpent > 0;
            const hasB = b.timeSpent > 0;
            if (hasA !== hasB) {
              return hasA ? -1 : 1; // Ticket có log time lên trước
            }
            if (!hasA && !hasB) {
              // Fallback to updated DESC if both have 0 log time
              const timeA = a.updated ? new Date(a.updated).getTime() : 0;
              const timeB = b.updated ? new Date(b.updated).getTime() : 0;
              return timeB - timeA;
            }
            return sortOrder === 'asc' ? a.timeSpent - b.timeSpent : b.timeSpent - a.timeSpent;
          }

          // Helper to categorize tickets for S/D sorting
          const getPlanDateGroup = (t: any, field: 'startDate' | 'dueDate') => {
            if (!useMonthTiers) return 0;
            const dateVal = t[field];
            if (!dateVal) return 4; // Unplanned -> Bottom (Group 4)

            const p = parsePlanDateYmd(dateVal);
            if (!p) return 4;
            const tYear = p.year;
            const tMonth = p.month;

            const isDone =
              t.statusCategory === 'done' ||
              t.status?.toLowerCase() === 'closed' ||
              t.status?.toLowerCase() === 'done';

            if (tYear === targetYear && tMonth === targetMonth) {
              return 1; // Planned in current target month -> Top (Group 1)
            }

            const isPast = tYear < targetYear || (tYear === targetYear && tMonth < targetMonth);
            if (isPast) {
              return isDone ? 3 : 1.2; // Done in past -> Bottom-ish (Group 3), Active past (rollover) -> Near top (Group 1.2)
            }

            return 2; // Planned in future -> Middle-bottom (Group 2)
          };

          // 2. Sort by startDate (S)
          if (sortBy === 'startDate') {
            const groupA = getPlanDateGroup(a, 'startDate');
            const groupB = getPlanDateGroup(b, 'startDate');

            if (groupA !== groupB) {
              return groupA - groupB; // Sort by group score first (1 < 1.2 < 2 < 3 < 4)
            }

            // Chronological within the same group
            const valA = planDateSortKey(a.startDate);
            const valB = planDateSortKey(b.startDate);

            if (valA === valB) {
              const timeA = a.updated ? new Date(a.updated).getTime() : 0;
              const timeB = b.updated ? new Date(b.updated).getTime() : 0;
              return timeB - timeA;
            }

            return sortOrder === 'asc' ? valA - valB : valB - valA;
          }

          // 3. Sort by dueDate (D)
          if (sortBy === 'dueDate') {
            const groupA = getPlanDateGroup(a, 'dueDate');
            const groupB = getPlanDateGroup(b, 'dueDate');

            if (groupA !== groupB) {
              return groupA - groupB;
            }

            const valA = planDateSortKey(a.dueDate);
            const valB = planDateSortKey(b.dueDate);

            if (valA === valB) {
              const timeA = a.updated ? new Date(a.updated).getTime() : 0;
              const timeB = b.updated ? new Date(b.updated).getTime() : 0;
              return timeB - timeA;
            }

            return sortOrder === 'asc' ? valA - valB : valB - valA;
          }

          // 4. Sort by updated
          if (sortBy === 'updated') {
            const valA = a.updated ? new Date(a.updated).getTime() : 0;
            const valB = b.updated ? new Date(b.updated).getTime() : 0;
            return sortOrder === 'asc' ? valA - valB : valB - valA;
          }

          // 5. General fields sorting (key, status)
          const valA = a[sortBy] || '';
          const valB = b[sortBy] || '';

          if (valA !== valB) {
            if (typeof valA === 'string' && typeof valB === 'string') {
              return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            }
            return sortOrder === 'asc' ? (valA > valB ? 1 : -1) : valA < valB ? 1 : -1;
          }

          // Fallback to updated DESC
          const timeA = a.updated ? new Date(a.updated).getTime() : 0;
          const timeB = b.updated ? new Date(b.updated).getTime() : 0;
          return timeB - timeA;
        });

        return {
          ...group,
          tickets: sortedTickets,
        };
      })
      .filter(group => group.tickets.length > 0);
  }, [effectiveDashboardData, sortBy, sortOrder, selectedMonth, isDashboardSearchActive]);

  const searchResultCount = React.useMemo(
    () => sortedDashboardData.reduce((n, g) => n + g.tickets.length, 0),
    [sortedDashboardData]
  );

  const dashboardMainRef = useRef<HTMLElement>(null);
  const dashboardHeaderRef = useRef<HTMLDivElement>(null);
  const dashboardGridWrapRef = useRef<HTMLDivElement>(null);
  const dashboardGridRef = useRef<HTMLDivElement>(null);
  useDashboardViewportMetrics(
    dashboardMainRef,
    dashboardHeaderRef,
    dashboardGridWrapRef,
    dashboardGridRef,
    sortedDashboardData.length || 1
  );

  return (
    <main ref={dashboardMainRef} className="glass-card dashboard-main dashboard-main--viewport-fit">
      <div
        ref={dashboardHeaderRef}
        className="dashboard-page-header"
        style={{ flexDirection: 'column', gap: '0.75rem', alignItems: 'stretch' }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 'clamp(1rem, 4vw, 1.2rem)',
            }}
          >
            Dashboard: Tiến độ Công việc Tháng
          </h2>
          <div
            className="dashboard-page-actions"
            style={{
              flex: '1 1 auto',
              justifyContent: 'flex-end',
              flexWrap: 'nowrap',
              overflowX: 'auto',
              gap: '1.25rem',
            }}
          >
            <div
              className="dashboard-month-wrap"
              style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <label
                style={{
                  margin: 0,
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                Dự án:
              </label>
              <select
                value={selectedProject}
                onChange={e => {
                  startTransition(() => {
                    setSelectedProject(e.target.value);
                  });
                }}
                className="premium-select toolbar-compact"
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

            <div className="dashboard-month-wrap" style={{ flexShrink: 0 }}>
              <label
                style={{
                  margin: 0,
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                Chọn tháng:
              </label>
              <input
                type="month"
                value={selectedMonth}
                onChange={e => {
                  startTransition(() => {
                    setSelectedMonth(e.target.value);
                  });
                }}
                className="premium-select toolbar-compact premium-select--no-chevron"
                style={{
                  width: '8rem',
                  maxWidth: '100%',
                  paddingRight: '10px',
                  height: '1.5rem',
                }}
              />
            </div>

            <div className="dashboard-search-row" style={{ flexShrink: 0 }}>
              <input
                type="search"
                value={ticketSearchInput}
                onChange={e => setTicketSearchInput(e.target.value)}
                placeholder="Tìm toàn bộ ticket trong dự án (story, task, sub-task, mã, tiêu đề...)"
                className="dashboard-search-input"
                aria-label="Tìm kiếm ticket"
              />
              <Search size={18} color="#64748b" style={{ flexShrink: 0 }} aria-hidden />
            </div>
            <div
              className="dashboard-month-wrap"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                flexShrink: 0,
              }}
            >
              <label
                style={{
                  margin: 0,
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                Sắp xếp:
              </label>
              <select
                value={sortBy}
                onChange={(e: any) => {
                  const val = e.target.value;
                  setSortBy(val);
                  if (val === 'timeEstimate' || val === 'updated') {
                    setSortOrder('desc');
                  } else {
                    setSortOrder('asc');
                  }
                }}
                className="premium-select toolbar-compact"
              >
                <option value="startDate">Ngày bắt đầu</option>
                <option value="dueDate">Hạn hoàn thành</option>
                <option value="updated">Ngày cập nhật</option>
                <option value="timeEstimate">Thời gian log (Logwork)</option>
                <option value="key">Mã ticket (Key)</option>
                <option value="status">Trạng thái (Status)</option>
              </select>
              <button
                type="button"
                className="filter-btn"
                onClick={() => setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))}
                style={{
                  padding: '4px 10px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
                title={sortOrder === 'asc' ? 'Tăng dần' : 'Giảm dần'}
              >
                <span style={{ fontSize: '0.7rem' }}>
                  {sortOrder === 'asc' ? '▲ ASC' : '▼ DESC'}
                </span>
              </button>
            </div>
          </div>
        </div>
        <div className="dashboard-page-header__meta" style={{ flex: 'none', width: '100%' }}>
          <div className="dashboard-stats-meta">
            <div className="dashboard-stats-group">
              <span>
                Tổng: <strong className="dashboard-stats-strong">{stats.total}</strong>
              </span>
              <span title="Số công trong tháng đang chọn (T2–T6, trừ ngày lễ VN)">
                Công ngày làm việc tháng:{' '}
                <strong style={{ color: 'var(--primary)' }}>{stats.monthWorkingDays}</strong>
              </span>
              <span title="7 giờ / ngày làm việc (cùng quy tắc Lịch sử Logwork)">
                Giờ tối thiểu tháng:{' '}
                <strong className="dashboard-stat-accent dashboard-stat-accent--indigo">
                  {stats.monthMinHours}h
                </strong>
              </span>
              <span>
                Log tuần ticket:{' '}
                <strong className="dashboard-stat-accent dashboard-stat-accent--indigo">
                  {stats.weeklySpent.toFixed(1)}h
                </strong>
              </span>
              <span>
                Est tuần ticket:{' '}
                <strong className="dashboard-stat-accent dashboard-stat-accent--amber">
                  {stats.weeklyEstimate.toFixed(1)}h
                </strong>
              </span>
            </div>
            <div className="dashboard-stats-group">
              <span title="To Do">
                🆕{' '}
                <strong className="dashboard-stat-accent dashboard-stat-accent--muted">
                  {stats.todo}
                </strong>
              </span>
              <span title="In Progress">
                ⏳{' '}
                <strong className="dashboard-stat-accent" style={{ color: 'var(--primary)' }}>
                  {stats.inProgress}
                </strong>
              </span>
              <span title="Done">
                ✅{' '}
                <strong className="dashboard-stat-accent dashboard-stat-accent--green">
                  {stats.done}
                </strong>
              </span>
            </div>
          </div>
        </div>
      </div>

      {loadingDashboard && dashboardData.length === 0 ? (
        <div className="dashboard-initial-loading">
          <Loader2 className="spinner" size={48} color="#0052cc" />
          <p>Đang tổng hợp dữ liệu từ Jira...</p>
        </div>
      ) : (
        <div
          ref={dashboardGridWrapRef}
          className={`dashboard-grid-wrap${isRefreshingDashboard ? ' dashboard-grid-wrap--refreshing' : ''}`}
        >
          {isRefreshingDashboard && <div className="dashboard-refresh-bar" aria-hidden />}
          <div ref={dashboardGridRef} className="dashboard-grid">
            {sortedDashboardData.length === 0 &&
            isDashboardSearchActive &&
            !searchLoading &&
            searchDashboardData !== null ? (
              <div className="dashboard-search-empty">
                <p>Không có ticket nào khớp &quot;{ticketSearchQuery}&quot;</p>
                <button
                  type="button"
                  className="filter-btn"
                  onClick={() => {
                    searchAbortRef.current?.abort();
                    setTicketSearchInput('');
                    setTicketSearchQuery('');
                    setSearchDashboardData(null);
                    setSearchLoading(false);
                  }}
                >
                  Xóa bộ lọc
                </button>
              </div>
            ) : (
              sortedDashboardData.map(group => (
                <DashboardUserCard
                  key={group.user.accountId}
                  group={group}
                  activeFilter={userFilters[group.user.accountId] || 'all'}
                  selectedMonth={selectedMonth}
                  apiBaseUrl={API_BASE_URL}
                  onFilterChange={handleUserFilterChange}
                  onTicketClick={handleTicketClick}
                  onOpenJiraTicket={openJiraTicket}
                />
              ))
            )}
          </div>
        </div>
      )}

      {selectedTicket && (
        <CommonModal
          open={ticketPanelOpen}
          onClose={closeTicketPanel}
          title={null}
          showCloseButton={false}
          ariaLabel={`Chi tiết ticket ${selectedTicket.key}`}
          classNameOverlay="modal-overlay--ticket"
          classNameContent="modal-content--ticket"
          zIndex={1200}
        >
          <header className="ticket-modal-header">
            <div className="ticket-modal-header__layout">
              <div className="ticket-modal-header__ticket">
                <div className="ticket-modal-header__identity" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <JiraTicketKeyLink
                    issueKey={selectedTicket.key}
                    onOpen={openJiraTicket}
                    className="ticket-modal-header__key jira-ticket-key-link"
                    showIcon
                  />
                  {ticketDetails?.isSubtask && ticketDetails?.parentKey && (
                    <button
                      type="button"
                      className="tester-badge"
                      onClick={() => {
                        let foundParent = null;
                        for (const group of effectiveDashboardData) {
                          const p = group.tickets.find((t: any) => t.key === ticketDetails.parentKey);
                          if (p) {
                            foundParent = p;
                            break;
                          }
                        }
                        if (foundParent) {
                          handleTicketClick(foundParent);
                        } else {
                          handleTicketClick({
                            key: ticketDetails.parentKey,
                            summary: `Đang tải ${ticketDetails.parentKey}...`
                          });
                        }
                      }}
                      title={`Chuyển sang story cha ${ticketDetails.parentKey}`}
                      style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.7rem'
                      }}
                    >
                      Về story cha {ticketDetails.parentKey}
                    </button>
                  )}
                </div>
                {(ticketDetails?.summary || selectedTicket.summary) && (
                  <p className="ticket-modal-header__summary">
                    {ticketDetails?.summary || selectedTicket.summary}
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
                  onClick={closeTicketPanel}
                  aria-label="Đóng"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          </header>

          {ticketDetails && selectedTicket && (
            <TicketEffortMeta
              details={ticketDetails}
              loading={loadingDetails}
              leading={
                <div className="ticket-effort-meta__assignee">
                  <UserIcon size={14} aria-hidden className="ticket-effort-meta__icon" />
                  <span className="ticket-effort-meta__creator-line">
                    <span className="ticket-effort-meta__creator-label">Gán cho</span>
                    <TicketAssigneeField
                      assignee={selectedTicket.assignee ?? ticketDetails.assignee ?? null}
                      projectUsers={projectUsers}
                      canEdit={canTransition}
                      saving={savingAssigneeKey === selectedTicket.key}
                      editing={assigneeEditing}
                      onStartEdit={() => setAssigneeEditing(true)}
                      onCancelEdit={() => setAssigneeEditing(false)}
                      onChange={next => handleAssigneeChange(selectedTicket.key, next)}
                      apiBaseUrl={API_BASE_URL}
                      showAvatar
                    />
                  </span>
                </div>
              }
              trailing={
                <>
                  <TicketLogworkButton
                    issueKey={selectedTicket.key}
                    ticketSummary={ticketDetails?.summary || selectedTicket.summary}
                    ticketDescription={ticketDetails?.description}
                    originalEstimateSeconds={
                      ticketDetails?.originalEstimate ?? selectedTicket?.originalEstimate
                    }
                    defaultTimeSpentSeconds={
                      ticketDetails?.timeSpentMonth ?? selectedTicket?.timeSpent
                    }
                    existingWorklog={ticketDetails?.myWorklog ?? null}
                    worklogYear={Number(selectedMonth.split('-')[0]) || undefined}
                    worklogMonth={Number(selectedMonth.split('-')[1]) || undefined}
                    apiFetch={apiFetch}
                    apiBaseUrl={API_BASE_URL}
                    canAct={canLogwork}
                    onLogged={async () => {
                      await fetchDashboardMonthly();
                      await loadTicketDetails(selectedTicket.key);
                    }}
                  />
                  <TicketStatusTransition
                    issueKey={selectedTicket.key}
                    currentStatus={selectedTicket.status}
                    apiFetch={apiFetch}
                    apiBaseUrl={API_BASE_URL}
                    canAct={canTransition}
                    prefillFields={{
                      customfield_10304: ticketDetails?.output || '',
                    }}
                    aiContext={{
                      summary: ticketDetails?.summary || selectedTicket?.summary,
                      description: ticketDetails?.description || '',
                    }}
                    onStatusChanged={({ status, statusCategory }) => {
                      if (status) {
                        setSelectedTicket((prev: any) =>
                          prev ? { ...prev, status, statusCategory } : prev
                        );
                      }
                      void loadTicketDetails(selectedTicket.key);
                      window.setTimeout(() => void fetchDashboardMonthly(), 500);
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

            {ticketDetailTab === 'content' && (
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
                    <h6
                      className="section-title"
                      style={{
                        margin: 0,
                        fontSize: '0.7rem',
                        textTransform: 'uppercase',
                        color: 'var(--text-secondary)',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Mô tả (Description)
                    </h6>
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.4rem',
                      }}
                    >
                      <button
                        className="copy-btn"
                        onClick={() => handleCopy(ticketDetails?.description || '', 'description')}
                        style={{
                          padding: '2px 6px',
                          height: '24px',
                        }}
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
                          className="ai-assist-btn"
                          onClick={() => handleAiRewrite('description')}
                          disabled={rewriting === 'description' || loadingDetails}
                          style={{
                            fontSize: '0.65rem',
                            padding: '2px 8px',
                            height: '24px',
                          }}
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
                      key={`desc-${selectedTicket.key}`}
                      issueKey={selectedTicket.key}
                      apiBaseUrl={API_BASE_URL}
                      wiki={ticketDetails?.description || ''}
                      images={descriptionImages}
                      onChange={({ wiki, images }) => {
                        setTicketDetails(prev => (prev ? { ...prev, description: wiki } : null));
                        setDescriptionImages(images);
                      }}
                      disabled={rewriting === 'description' || loadingDetails || isUpdating}
                      className={`ticket-field--composer ${rewriting === 'description' ? 'field-loading' : ''} ${loadingDetails ? 'field-pending' : ''}`}
                      minHeight={220}
                      placeholder="Soạn mô tả — chèn ảnh, chỉnh kích thước & căn lề..."
                      hint="Ctrl+V dán screenshot."
                    />
                  ) : (
                    <JiraRichContent
                      content={ticketDetails?.description}
                      issueKey={selectedTicket.key}
                      apiBaseUrl={API_BASE_URL}
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
                    <h6
                      className="section-title"
                      style={{
                        margin: 0,
                        fontSize: '0.7rem',
                        textTransform: 'uppercase',
                        color: 'var(--text-secondary)',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Output (Kết quả xử lý)
                    </h6>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <button
                        className="copy-btn"
                        onClick={() => handleCopy(ticketDetails?.output || '', 'output')}
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
                          className="ai-assist-btn"
                          onClick={() => handleAiRewrite('output')}
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
                    value={ticketDetails?.output || ''}
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

            {ticketDetailTab === 'attachments' && selectedTicket && (
              <div className="ticket-modal-tab-panel">
                <TicketAttachmentList
                  issueKey={selectedTicket.key}
                  apiFetch={apiFetch}
                  apiBaseUrl={API_BASE_URL}
                  className="preview-section"
                  onCountChange={setAttachmentCount}
                />
              </div>
            )}

            {ticketDetailTab === 'comments' && (
              <div className="ticket-modal-tab-panel ticket-modal-tab-panel--comments">
                <TicketCommentList
                  comments={ticketDetails?.comments}
                  className="preview-section"
                  fillAvailable
                  issueKey={selectedTicket.key}
                  apiBaseUrl={API_BASE_URL}
                  apiFetch={apiFetch}
                  eagerImages
                  onOpenJiraTicket={openJiraTicket}
                  hint={
                    ticketDetails?.commentsIncludeRelated
                      ? ticketDetails.isSubtask
                        ? `Gồm comment story cha${ticketDetails.parentKey ? ` ${ticketDetails.parentKey}` : ''} & sub-task liên quan.`
                        : 'Gồm comment story & sub-task liên quan.'
                      : undefined
                  }
                />
                <TicketActionPanel
                  issueKey={selectedTicket.key}
                  apiFetch={apiFetch}
                  apiBaseUrl={API_BASE_URL}
                  canAct={canLogwork}
                  className="preview-section"
                  onSuccess={({ status }) => {
                    if (status) {
                      setSelectedTicket((prev: any) => (prev ? { ...prev, status } : prev));
                    }
                    void loadTicketDetails(selectedTicket.key);
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
              onClick={closeTicketPanel}
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
              onClick={() => openJiraTicket(selectedTicket.key)}
            >
              Xem trên Jira
              <ExternalLink size={14} />
            </button>
          </div>
        </CommonModal>
      )}
    </main>
  );
};

export default Dashboard;
