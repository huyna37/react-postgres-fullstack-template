import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCw,
  Sparkles,
  Clock,
  Award,
  Timer,
} from 'lucide-react';
import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CommonModal from '../components/CommonModal';
import { useDeferredUnmount } from '../hooks/useDeferredUnmount';
import { showConfirm, showError, showSuccess, showWarning } from '../utils/swal';

interface LogworkHistoryProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
}

function worklogCommentToPlain(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (
    typeof c === 'object' &&
    c !== null &&
    'type' in c &&
    (c as { type: string }).type === 'doc'
  ) {
    const extract = (nodes: unknown[]): string =>
      nodes
        .map(n => {
          if (n && typeof n === 'object') {
            const o = n as { text?: string; content?: unknown[] };
            if (typeof o.text === 'string') return o.text;
            if (Array.isArray(o.content)) return extract(o.content);
          }
          return '';
        })
        .join('');
    const doc = c as { content?: unknown[] };
    return doc.content ? extract(doc.content).trim() : '';
  }
  return '';
}

function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Jira custom date (cf 10300 / 10302) — thường là chuỗi YYYY-MM-DD */
function formatCustomFieldDate(val: unknown): string {
  if (val == null || val === '') return '—';
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('vi-VN');
    return val;
  }
  return '—';
}

import {
  canCloseIssueForLogwork,
  isIssueFinallyClosed,
} from '../utils/issueCloseStatus';
import {
  computeDayLogStatus,
  formatRequiredHoursTitle,
  type DayLogStatus,
} from '../utils/personalOt';
import {
  countWorkingDays,
  requiredHoursForWorkingDays,
  WORKING_HOURS_PER_DAY,
} from '../utils/workingDays';

const WORK_TZ = 'Asia/Bangkok';

function logDayKeyBangkok(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: WORK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function formatDayGroupLabel(dateYmd: string): string {
  const [y, mo, d] = dateYmd.split('-').map(Number);
  if (!y || !mo || !d) return dateYmd;
  const dt = new Date(y, mo - 1, d);
  const weekday = dt.toLocaleDateString('vi-VN', { weekday: 'short' });
  return `${d}/${mo}/${y} (${weekday})`;
}

function parseDayParts(dateYmd: string) {
  const [y, mo, d] = dateYmd.split('-').map(Number);
  if (!y || !mo || !d) {
    return { day: 0, monthShort: '', weekday: '', isWeekend: false };
  }
  const dt = new Date(y, mo - 1, d);
  const dow = dt.getDay();
  return {
    day: d,
    monthShort: dt.toLocaleDateString('vi-VN', { month: 'short' }),
    weekday: dt.toLocaleDateString('vi-VN', { weekday: 'short' }),
    isWeekend: dow === 0 || dow === 6,
  };
}

function formatLogTimeBangkok(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: WORK_TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function DayProgressRing({
  pct,
  met,
  label,
  size = 46,
}: {
  pct: number;
  met: boolean;
  label: string;
  size?: number;
}) {
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (Math.min(100, Math.max(0, pct)) / 100) * circ;
  return (
    <div className="logwork-day-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          className="logwork-day-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className={`logwork-day-ring__fill${met ? ' logwork-day-ring__fill--met' : ''}`}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="logwork-day-ring__label">{label}</span>
    </div>
  );
}

type WorklogDayGroup = {
  dateKey: string;
  label: string;
  items: any[];
  totalSeconds: number;
  totalHours: string;
  dayStatus: DayLogStatus;
  openIssueCount: number;
  openIssueKeys: string[];
};

function getUniqueIssuesByKey(items: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const wl of items) {
    if (!map.has(wl.issueKey)) map.set(wl.issueKey, wl);
  }
  return map;
}

function worklogStatusBadgeClass(status?: string, statusCategory?: string): string {
  if (isIssueFinallyClosed(status)) return 'logwork-entry-card__status--done';
  const name = String(status || '').toLowerCase();
  if (/resolved|resolve|done|hoàn thành|complete/.test(name)) {
    return 'logwork-entry-card__status--resolved';
  }
  const cat = String(statusCategory || '').toLowerCase();
  if (cat === 'indeterminate') return 'logwork-entry-card__status--progress';
  return 'logwork-entry-card__status--open';
}

const LogworkHistory: React.FC<LogworkHistoryProps> = ({
  apiFetch,
  API_BASE_URL,
  openJiraTicket,
}) => {
  const [worklogs, setWorklogs] = useState<any[]>([]);
  const [loadingWorklogs, setLoadingWorklogs] = useState(false);
  const [isRefreshingWorklogs, setIsRefreshingWorklogs] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const editModalMounted = useDeferredUnmount(editModalOpen);
  const [worklogMonth, setWorklogMonth] = useState(new Date().getMonth() + 1);
  const [worklogYear, setWorklogYear] = useState(new Date().getFullYear());

  const [editRow, setEditRow] = useState<any | null>(null);
  const [editTimeSpent, setEditTimeSpent] = useState('');
  const [editComment, setEditComment] = useState('');
  const [editStarted, setEditStarted] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [generatingAiComment, setGeneratingAiComment] = useState(false);
  const [rewritingComment, setRewritingComment] = useState(false);
  const [otByDate, setOtByDate] = useState<Map<string, number>>(() => new Map());
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set());
  const [closingDays, setClosingDays] = useState<Set<string>>(() => new Set());
  const hasLoadedWorklogsRef = useRef(false);

  const toggleDay = useCallback((dateKey: string) => {
    setExpandedDays(prev => {
      const next = new Set(prev);
      if (next.has(dateKey)) next.delete(dateKey);
      else next.add(dateKey);
      return next;
    });
  }, []);

  const jiraDescriptionToPlain = (val: unknown): string => {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    return worklogCommentToPlain(val);
  };

  const fetchWorklogs = useCallback(async () => {
    if (hasLoadedWorklogsRef.current) {
      setIsRefreshingWorklogs(true);
    } else {
      setLoadingWorklogs(true);
    }
    try {
      const qs = `year=${worklogYear}&month=${worklogMonth}`;
      const [response, otRes] = await Promise.all([
        apiFetch(`${API_BASE_URL}/api/worklogs?${qs}`),
        apiFetch(
          `${API_BASE_URL}/api/worklogs/personal-ot?${qs}&minHours=${WORKING_HOURS_PER_DAY}`
        ),
      ]);
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setWorklogs(data.worklogs ?? []);
        hasLoadedWorklogsRef.current = true;
      } else {
        showError(typeof data.error === 'string' ? data.error : 'Không tải được lịch sử logwork.');
      }
      if (otRes.ok) {
        const otData = await otRes.json().catch(() => ({}));
        const map = new Map<string, number>();
        for (const day of otData.days ?? []) {
          if (day?.date) map.set(day.date, Number(day.otHours) || 0);
        }
        setOtByDate(map);
      } else {
        setOtByDate(new Map());
      }
    } catch (error) {
      console.error('Failed to fetch worklogs:', error);
      showError('Lỗi kết nối khi tải lịch sử logwork.');
    } finally {
      setLoadingWorklogs(false);
      setIsRefreshingWorklogs(false);
    }
  }, [apiFetch, API_BASE_URL, worklogMonth, worklogYear]);

  useEffect(() => {
    fetchWorklogs();
  }, [fetchWorklogs]);

  const worklogsByDay = useMemo((): WorklogDayGroup[] => {
    const map = new Map<string, any[]>();
    for (const wl of worklogs) {
      const key = logDayKeyBangkok(wl.started) || 'unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(wl);
    }
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateKey, items]) => {
        const sorted = [...items].sort(
          (a, b) => new Date(b.started).getTime() - new Date(a.started).getTime()
        );
        const totalSeconds = sorted.reduce((s, w) => s + (w.timeSpentSeconds || 0), 0);
        const dayStatus = computeDayLogStatus(dateKey, totalSeconds, otByDate.get(dateKey) ?? 0);
        const uniqueIssues = getUniqueIssuesByKey(sorted);
        const openIssueKeys = [...uniqueIssues.entries()]
          .filter(([, wl]) => canCloseIssueForLogwork(wl))
          .map(([key]) => key);
        return {
          dateKey,
          label: formatDayGroupLabel(dateKey),
          items: sorted,
          totalSeconds,
          totalHours: (totalSeconds / 3600).toFixed(1),
          dayStatus,
          openIssueCount: openIssueKeys.length,
          openIssueKeys,
        };
      });
  }, [worklogs, otByDate]);

  useEffect(() => {
    if (worklogsByDay.length > 0) {
      setExpandedDays(new Set(worklogsByDay.map(g => g.dateKey)));
    } else {
      setExpandedDays(new Set());
    }
  }, [worklogMonth, worklogYear, worklogsByDay]);

  const totalLoggedSeconds = useMemo(
    () => worklogs.reduce((s, w) => s + (w.timeSpentSeconds || 0), 0),
    [worklogs]
  );

  const totalEstimateSeconds = useMemo(() => {
    const uniqueIssues = new Map();
    worklogs.forEach(wl => {
      if (!uniqueIssues.has(wl.issueKey)) {
        uniqueIssues.set(wl.issueKey, wl.originalEstimateSeconds || 0);
      }
    });
    let sum = 0;
    uniqueIssues.forEach(val => (sum += val));
    return sum;
  }, [worklogs]);

  const requiredWorkingDays = useMemo(
    () => countWorkingDays(worklogYear, worklogMonth),
    [worklogYear, worklogMonth]
  );
  const baseRequiredHours = requiredHoursForWorkingDays(requiredWorkingDays);

  const monthOtHours = useMemo(() => {
    let sum = 0;
    otByDate.forEach(h => {
      sum += Number(h) || 0;
    });
    return +sum.toFixed(1);
  }, [otByDate]);

  const monthTargetHours = useMemo(
    () => +(baseRequiredHours + monthOtHours).toFixed(1),
    [baseRequiredHours, monthOtHours]
  );

  const monthStats = useMemo(() => {
    const loggedH = totalLoggedSeconds / 3600;
    const estimateH = totalEstimateSeconds / 3600;
    const shortDays = worklogsByDay.filter(g => g.dayStatus.isShort).length;
    const loggedDays = worklogsByDay.length;
    const otDays = [...otByDate.values()].filter(h => (Number(h) || 0) > 0).length;
    const targetPct =
      monthTargetHours > 0 ? Math.min(100, Math.round((loggedH / monthTargetHours) * 100)) : null;
    const monthGapH =
      monthTargetHours > 0 ? Math.max(0, +(monthTargetHours - loggedH).toFixed(1)) : null;
    return { loggedH, estimateH, shortDays, loggedDays, otDays, targetPct, monthGapH };
  }, [totalLoggedSeconds, totalEstimateSeconds, worklogsByDay, monthTargetHours, otByDate]);

  const monthPickerValue = `${worklogYear}-${String(worklogMonth).padStart(2, '0')}`;

  const openEdit = (wl: any) => {
    setEditRow(wl);
    setEditTimeSpent(wl.timeSpent || '');
    setEditComment(worklogCommentToPlain(wl.comment));
    setEditStarted(
      toDatetimeLocalValue(wl.started) || toDatetimeLocalValue(new Date().toISOString())
    );
    setEditModalOpen(true);
  };

  const closeEdit = () => {
    setEditModalOpen(false);
  };

  useEffect(() => {
    if (editModalOpen) return;
    const t = window.setTimeout(() => {
      setEditRow(null);
      setEditTimeSpent('');
      setEditComment('');
      setEditStarted('');
      setGeneratingAiComment(false);
      setRewritingComment(false);
    }, 230);
    return () => clearTimeout(t);
  }, [editModalOpen]);

  const handleAiWriteCommentFromTicket = async () => {
    if (!editRow?.issueKey) return;
    setGeneratingAiComment(true);
    try {
      const detailsRes = await apiFetch(`${API_BASE_URL}/api/tickets/details/${editRow.issueKey}`);
      if (!detailsRes.ok) {
        showError('Không tải được chi tiết ticket.');
        return;
      }
      const details = await detailsRes.json();
      const summary = String(details.summary ?? editRow.summary ?? '');
      const description = jiraDescriptionToPlain(details.description);
      const commentRes = await apiFetch(`${API_BASE_URL}/api/generate/worklog-comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary, description }),
      });
      if (commentRes.ok) {
        const { comment } = await commentRes.json();
        setEditComment(comment);
      } else {
        showError('AI không tạo được comment.');
      }
    } catch {
      showError('Lỗi khi gọi AI.');
    } finally {
      setGeneratingAiComment(false);
    }
  };

  const handleAiRewriteComment = async () => {
    const text = editComment.trim();
    if (!text) {
      showError('Cần có nội dung comment để AI chỉnh lại.');
      return;
    }
    setRewritingComment(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/generate/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldType: 'Worklog comment', currentContent: text }),
      });
      if (res.ok) {
        const data = await res.json();
        setEditComment(data.rewritten);
      } else {
        showError('AI chỉnh sửa thất bại.');
      }
    } catch {
      showError('Lỗi khi gọi AI.');
    } finally {
      setRewritingComment(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editRow || !editTimeSpent.trim()) {
      showError('Vui lòng nhập thời gian (time spent).');
      return;
    }
    setSavingEdit(true);
    try {
      const startedIso = editStarted
        ? new Date(editStarted).toISOString()
        : new Date(editRow.started).toISOString();
      const res = await apiFetch(`${API_BASE_URL}/api/worklogs/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueKey: editRow.issueKey,
          timeSpent: editTimeSpent.trim(),
          comment: editComment,
          started: startedIso,
          year: worklogYear,
          month: worklogMonth,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        showSuccess('Đã cập nhật worklog (xóa và tạo lại trên Jira).');
        closeEdit();
        fetchWorklogs();
      } else {
        showError(typeof data.error === 'string' ? data.error : 'Cập nhật worklog thất bại.');
        if (data.deletedOldOnly) {
          closeEdit();
          fetchWorklogs();
        }
      }
    } catch {
      showError('Lỗi mạng khi cập nhật worklog.');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleCloseDayIssues = async (group: WorklogDayGroup) => {
    if (group.openIssueKeys.length === 0) return;

    const confirm = await showConfirm(
      `Đóng ${group.openIssueKeys.length} ticket?`,
      `Chuyển các ticket chưa đóng trong ngày ${group.label} sang Done/Closed trên Jira.`
    );
    if (!confirm.isConfirmed) return;

    setClosingDays(prev => new Set(prev).add(group.dateKey));
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/worklogs/close-issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueKeys: group.openIssueKeys }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok || res.status === 207) {
        const closed = Number(data.closed) || 0;
        const failed = Number(data.failed) || 0;
        if (failed > 0) {
          const failList = (data.results || [])
            .filter((r: { ok?: boolean }) => !r.ok)
            .map((r: { issueKey?: string; error?: string }) => `${r.issueKey}: ${r.error}`)
            .join('\n');
          showWarning(`Đóng được ${closed} ticket. ${failed} ticket lỗi:\n${failList}`);
        } else {
          showSuccess(
            closed > 0 ? `Đã đóng ${closed} ticket.` : 'Các ticket đã ở trạng thái đóng.'
          );
        }
        fetchWorklogs();
      } else {
        showError(typeof data.error === 'string' ? data.error : 'Không đóng được ticket.');
      }
    } catch {
      showError('Lỗi mạng khi đóng ticket.');
    } finally {
      setClosingDays(prev => {
        const next = new Set(prev);
        next.delete(group.dateKey);
        return next;
      });
    }
  };

  return (
    <main
      className="glass-card logwork-page"
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
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: '1rem',
            marginBottom: '1rem',
          }}
        >
          <div>
            <h2
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '1.2rem',
                marginBottom: '0.35rem',
              }}
            >
              <CalendarDays size={20} color="#3b82f6" /> Lịch sử Logwork
            </h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0 }}>
              Worklog theo tháng (đồng bộ Jira).
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <label
                style={{
                  margin: 0,
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap',
                }}
              >
                Tháng worklog:
              </label>
              <input
                type="month"
                value={monthPickerValue}
                onChange={e => {
                  const v = e.target.value;
                  if (!v) return;
                  const [y, m] = v.split('-').map(Number);
                  startTransition(() => {
                    setWorklogYear(y);
                    setWorklogMonth(m);
                  });
                }}
                className="premium-select"
                style={{ width: 'auto', padding: '4px 10px' }}
              />
            </div>
            <button
              type="button"
              className="filter-btn"
              onClick={fetchWorklogs}
              disabled={loadingWorklogs || isRefreshingWorklogs}
              title="Tải lại"
              style={{
                padding: '4px 10px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <RotateCw
                size={14}
                className={loadingWorklogs || isRefreshingWorklogs ? 'spinner' : ''}
              />
              <span style={{ fontSize: '0.75rem' }}>Reload</span>
            </button>
          </div>
        </div>
      </div>

      {loadingWorklogs && worklogs.length === 0 ? (
        <div
          className="dashboard-initial-loading"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <Loader2 className="spinner" size={48} color="var(--primary)" />
          <p>Đang tải dữ liệu...</p>
        </div>
      ) : worklogs.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '3rem',
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            Không có worklog trong tháng đã chọn.
          </p>
        </div>
      ) : (
        <div
          className={`page-content-wrap page-content-wrap--column${isRefreshingWorklogs ? ' page-content-wrap--refreshing' : ''}`}
        >
          {isRefreshingWorklogs && <div className="page-refresh-bar" aria-hidden />}
          <div className="page-content-body logwork-history__body">
            <div className="logwork-history__summary">
              <div className="stat-grid" style={{ marginBottom: '0.75rem' }}>

                {/* CARD 1: ĐÃ LOG THÁNG */}
                <div className="glass-card stat-card stat-card--indigo" style={{ minHeight: '6rem' }}>
                  <div className="stat-card__icon stat-card__icon--indigo">
                    <Clock size={18} color="#818cf8" />
                  </div>
                  <div className="stat-card__body">
                    <span className="stat-card__label">Đã log tháng</span>
                    <div className="stat-card__primary">
                      <span className="stat-card__number">{monthStats.loggedH.toFixed(1)}h</span>
                      <span
                        className="stat-card__unit"
                        title={
                          monthOtHours > 0
                            ? `${baseRequiredHours}h (${requiredWorkingDays} ngày × ${WORKING_HOURS_PER_DAY}h) + ${monthOtHours}h OT`
                            : `${baseRequiredHours}h (${requiredWorkingDays} ngày × ${WORKING_HOURS_PER_DAY}h)`
                        }
                        style={{ marginLeft: '0.25rem' }}
                      >
                        / {monthTargetHours}h mục tiêu
                      </span>
                    </div>
                    {monthStats.targetPct != null && (
                      <div
                        className="logwork-month-summary__bar"
                        style={{ width: '100%', marginTop: '4px', height: '5px' }}
                        role="progressbar"
                        aria-valuenow={monthStats.targetPct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        title={`${monthStats.loggedH.toFixed(1)}h / ${monthTargetHours}h`}
                      >
                        <div
                          className={`logwork-month-summary__bar-fill${monthStats.monthGapH && monthStats.monthGapH > 0 ? '' : ' logwork-month-summary__bar-fill--full'}`}
                          style={{ width: `${monthStats.targetPct}%` }}
                        />
                      </div>
                    )}
                    {monthStats.monthGapH != null && monthStats.monthGapH > 0 ? (
                      <span className="logwork-month-summary__hint logwork-month-summary__hint--short" style={{ fontSize: '0.68rem', marginTop: '4px', display: 'block' }}>
                        Còn thiếu {monthStats.monthGapH}h
                      </span>
                    ) : monthStats.targetPct != null ? (
                      <span className="logwork-month-summary__hint logwork-month-summary__hint--ok" style={{ fontSize: '0.68rem', marginTop: '4px', display: 'block' }}>
                        Đạt mục tiêu
                      </span>
                    ) : null}
                  </div>
                </div>

                {/* CARD 2: ESTIMATE TICKET */}
                <div className="glass-card stat-card stat-card--blue" style={{ minHeight: '6rem' }}>
                  <div className="stat-card__icon stat-card__icon--blue">
                    <Award size={18} color="#60a5fa" />
                  </div>
                  <div className="stat-card__body">
                    <span className="stat-card__label">Estimate ticket</span>
                    <div className="stat-card__primary">
                      <span className="stat-card__number">{monthStats.estimateH.toFixed(1)}h</span>
                    </div>
                    <div className="stat-card__breakdown" style={{ marginTop: '4px' }}>
                      <span className="stat-card__chip">
                        <strong>{worklogs.length}</strong> dòng log
                      </span>
                    </div>
                  </div>
                </div>

                {/* CARD 3: NGÀY CÓ LOG */}
                <div className="glass-card stat-card stat-card--purple" style={{ minHeight: '6rem' }}>
                  <div className="stat-card__icon stat-card__icon--purple">
                    <CalendarDays size={18} color="#a855f7" />
                  </div>
                  <div className="stat-card__body">
                    <span className="stat-card__label">Ngày có log</span>
                    <div className="stat-card__primary">
                      <span className="stat-card__number">{monthStats.loggedDays}</span>
                      <span className="stat-card__unit" style={{ marginLeft: '0.15rem' }}>ngày</span>
                    </div>
                    <div className="stat-card__breakdown" style={{ marginTop: '4px' }}>
                      {monthStats.shortDays > 0 ? (
                        <span className="stat-card__chip" style={{ color: '#f87171', background: 'rgba(239, 68, 68, 0.06)', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
                          <strong>{monthStats.shortDays}</strong> ngày thiếu giờ
                        </span>
                      ) : (
                        <span className="stat-card__chip" style={{ color: '#34d399', background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.15)' }}>
                          Không thiếu ngày nào
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* CARD 4: OT THÁNG */}
                <div className="glass-card stat-card stat-card--green" style={{ minHeight: '6rem' }}>
                  <div className="stat-card__icon stat-card__icon--green">
                    <Sparkles size={18} color="#34d399" />
                  </div>
                  <div className="stat-card__body">
                    <span className="stat-card__label">OT tháng</span>
                    <div className="stat-card__primary">
                      <span className="stat-card__number">
                        {monthOtHours > 0 ? `+${monthOtHours}h` : '0h'}
                      </span>
                    </div>
                    <div className="stat-card__breakdown" style={{ marginTop: '4px' }}>
                      <span className="stat-card__chip">
                        {monthStats.otDays > 0 ? (
                          <><strong>{monthStats.otDays}</strong> ngày có OT</>
                        ) : (
                          <>{requiredWorkingDays} ngày chuẩn</>
                        )}
                      </span>
                    </div>
                  </div>
                </div>

              </div>
            </div>
            <div className="logwork-history__scroll scrollable-area">
              <div className="logwork-timeline">
                {worklogsByDay.map((group, groupIdx) => {
                  const loggedH = group.totalSeconds / 3600;
                  const requiredH = group.dayStatus.requiredHours;
                  const dayFillPct =
                    requiredH > 0
                      ? Math.min(100, Math.round((loggedH / requiredH) * 100))
                      : loggedH > 0
                        ? 100
                        : 0;
                  const isExpanded = expandedDays.has(group.dateKey);
                  const dayParts = parseDayParts(group.dateKey);
                  const isLast = groupIdx === worklogsByDay.length - 1;
                  return (
                    <article
                      key={group.dateKey}
                      className={`logwork-day-card${group.dayStatus.isShort ? ' logwork-day-card--short' : ''}${group.dayStatus.isMet && group.dayStatus.requiredHours > 0 ? ' logwork-day-card--met' : ''}${group.dayStatus.otHours > 0 ? ' logwork-day-card--ot' : ''}${isExpanded ? ' logwork-day-card--expanded' : ' logwork-day-card--collapsed'}`}
                    >
                      <div className="logwork-day-card__rail" aria-hidden>
                        <div
                          className={`logwork-day-card__date-tile${dayParts.isWeekend ? ' logwork-day-card__date-tile--weekend' : ''}`}
                        >
                          <span className="logwork-day-card__date-num">{dayParts.day}</span>
                          <span className="logwork-day-card__date-month">{dayParts.monthShort}</span>
                          <span className="logwork-day-card__date-weekday">{dayParts.weekday}</span>
                        </div>
                        {!isLast ? <div className="logwork-day-card__connector" /> : null}
                      </div>

                      <div className="logwork-day-card__body">
                        <button
                          type="button"
                          className="logwork-day-card__head"
                          onClick={() => toggleDay(group.dateKey)}
                          aria-expanded={isExpanded}
                          aria-controls={`logwork-day-${group.dateKey}`}
                        >
                          <div className="logwork-day-card__head-text">
                            <span className="logwork-day-card__title">{group.label}</span>
                            <span className="logwork-day-card__meta">
                              {group.items.length} dòng log
                              {group.dayStatus.otHours > 0 ? ` · +${group.dayStatus.otHours}h OT` : ''}
                            </span>
                          </div>

                          <DayProgressRing
                            pct={dayFillPct}
                            met={group.dayStatus.isMet && requiredH > 0}
                            label={requiredH > 0 ? `${group.totalHours}h` : `${group.totalHours}h`}
                          />

                          <div className="logwork-day-card__stats">
                            {requiredH > 0 ? (
                              <span
                                className="logwork-day-card__hours"
                                title={formatRequiredHoursTitle(group.dayStatus)}
                              >
                                <strong>{group.totalHours}h</strong>
                                <span> / {requiredH}h</span>
                              </span>
                            ) : (
                              <span className="logwork-day-card__hours">
                                <strong>{group.totalHours}h</strong>
                              </span>
                            )}
                            <div className="logwork-day-card__badges">
                              <button
                                type="button"
                                className={`logwork-day-card__close-btn${group.openIssueCount === 0 ? ' logwork-day-card__close-btn--inactive' : ''}`}
                                onClick={e => {
                                  e.stopPropagation();
                                  void handleCloseDayIssues(group);
                                }}
                                disabled={
                                  group.openIssueCount === 0 || closingDays.has(group.dateKey)
                                }
                                title={
                                  group.openIssueCount === 0
                                    ? 'Không có ticket chưa đóng trong ngày này'
                                    : 'Đóng các ticket chưa close trong ngày này'
                                }
                              >
                                {closingDays.has(group.dateKey) ? (
                                  <Loader2 className="spinner" size={13} />
                                ) : (
                                  <CheckCircle2 size={13} />
                                )}
                                {group.openIssueCount > 0
                                  ? `Đóng ${group.openIssueCount} ticket`
                                  : 'Đóng ticket'}
                              </button>
                              {group.dayStatus.isShort ? (
                                <span
                                  className="logwork-day-group__badge logwork-day-group__badge--short"
                                  title={formatRequiredHoursTitle(group.dayStatus)}
                                >
                                  Thiếu {group.dayStatus.missingHours}h
                                </span>
                              ) : requiredH > 0 ? (
                                <span
                                  className="logwork-day-group__badge logwork-day-group__badge--met"
                                  title={formatRequiredHoursTitle(group.dayStatus)}
                                >
                                  Đủ giờ
                                </span>
                              ) : null}
                            </div>
                          </div>

                          <ChevronDown
                            size={18}
                            className={`logwork-day-card__chevron${isExpanded ? ' logwork-day-card__chevron--open' : ''}`}
                            aria-hidden
                          />
                        </button>

                        {isExpanded ? (
                          <div
                            id={`logwork-day-${group.dateKey}`}
                            className="logwork-entry-grid"
                          >
                            {group.items.map((wl, idx) => {
                              const commentPlain = worklogCommentToPlain(wl.comment);
                              const dueLabel = formatCustomFieldDate(wl.dueDate);
                              const showDue = dueLabel !== '—';
                              const logTime = formatLogTimeBangkok(wl.started);
                              return (
                                <article
                                  key={`${group.dateKey}-${wl.id}-${idx}`}
                                  className="logwork-entry-card"
                                >
                                  <div className="logwork-entry-card__head">
                                    <button
                                      type="button"
                                      onClick={() => openJiraTicket(wl.issueKey)}
                                      className="logwork-day-group__ticket"
                                    >
                                      {wl.issueKey} <ExternalLink size={10} />
                                    </button>
                                    {logTime ? (
                                      <span className="logwork-entry-card__time" title="Thời điểm log">
                                        <Timer size={11} aria-hidden />
                                        {logTime}
                                      </span>
                                    ) : null}
                                    <button
                                      type="button"
                                      title="Cập nhật worklog"
                                      onClick={() => openEdit(wl)}
                                      className="logwork-entry-card__edit filter-btn"
                                    >
                                      <Pencil size={13} />
                                    </button>
                                  </div>

                                  <h4 className="logwork-entry-card__summary">{wl.summary}</h4>

                                  <div className="logwork-entry-card__chips">
                                    {wl.status ? (
                                      <span
                                        className={`logwork-entry-card__status ${worklogStatusBadgeClass(wl.status, wl.statusCategory)}`}
                                        title={wl.statusCategory ? `Category: ${wl.statusCategory}` : undefined}
                                      >
                                        {wl.status}
                                      </span>
                                    ) : null}
                                    <span className="logwork-day-group__chip logwork-day-group__chip--spent">
                                      {wl.timeSpent}
                                    </span>
                                    {wl.originalEstimate ? (
                                      <span className="logwork-day-group__chip logwork-day-group__chip--est">
                                        est {wl.originalEstimate}
                                      </span>
                                    ) : null}
                                  </div>

                                  {commentPlain ? (
                                    <p className="logwork-entry-card__comment">
                                      <MessageSquare size={12} className="logwork-entry-card__comment-icon" aria-hidden />
                                      {commentPlain.length > 180
                                        ? `${commentPlain.substring(0, 180)}…`
                                        : commentPlain}
                                    </p>
                                  ) : null}

                                  {showDue ? (
                                    <p className="logwork-entry-card__due" title="Hạn ticket">
                                      Hạn {dueLabel}
                                    </p>
                                  ) : null}
                                </article>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {editModalMounted && editRow && (
        <CommonModal
          open={editModalOpen}
          onClose={closeEdit}
          title={`Cập nhật worklog — ${editRow.issueKey}`}
          titleId="logwork-history-edit-modal-title"
          styleContent={{ maxWidth: '480px', width: '92%' }}
        >
          <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 1rem' }}>
            Hệ thống sẽ xóa worklog hiện tại trên Jira và tạo lại với nội dung bên dưới.
          </p>
          <form
            onSubmit={handleSaveEdit}
            style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '0.35rem',
                }}
              >
                Thời gian (vd: 1h, 30m, 1h 30m)
              </label>
              <input
                required
                value={editTimeSpent}
                onChange={e => setEditTimeSpent(e.target.value)}
                className="ticket-field ticket-field--compact"
                style={{ width: '100%' }}
              />
            </div>
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: '0.75rem',
                  color: 'var(--text-secondary)',
                  marginBottom: '0.35rem',
                }}
              >
                Thời điểm bắt đầu
              </label>
              <input
                type="datetime-local"
                required
                value={editStarted}
                onChange={e => setEditStarted(e.target.value)}
                className="premium-select"
                style={{ width: '100%', padding: '0.65rem' }}
              />
            </div>
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '0.35rem',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                <label style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  Mô tả / comment
                </label>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleAiWriteCommentFromTicket}
                    disabled={generatingAiComment || rewritingComment || !editRow?.issueKey}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#4ade80',
                      fontSize: '0.72rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 0',
                    }}
                  >
                    {generatingAiComment ? (
                      <Loader2 className="spinner" size={12} />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    {generatingAiComment ? 'Đang soạn...' : 'AI Viết từ ticket'}
                  </button>
                  <button
                    type="button"
                    onClick={handleAiRewriteComment}
                    disabled={rewritingComment || generatingAiComment || !editComment.trim()}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#60a5fa',
                      fontSize: '0.72rem',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 0',
                    }}
                  >
                    {rewritingComment ? (
                      <Loader2 className="spinner" size={12} />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    {rewritingComment ? 'Đang sửa...' : 'AI chỉnh lại'}
                  </button>
                </div>
              </div>
              <textarea
                value={editComment}
                onChange={e => setEditComment(e.target.value)}
                rows={4}
                className="ticket-field ticket-field--medium"
                style={{ width: '100%', resize: 'vertical' }}
              />
            </div>
            <div
              style={{
                display: 'flex',
                gap: '0.75rem',
                justifyContent: 'flex-end',
                marginTop: '0.5rem',
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={closeEdit}
                style={{ marginTop: 0, width: 'auto' }}
              >
                Hủy
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={savingEdit}
                style={{
                  marginTop: 0,
                  width: 'auto',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                {savingEdit ? <Loader2 className="spinner" size={16} /> : null}
                Lưu
              </button>
            </div>
          </form>
        </CommonModal>
      )}
    </main>
  );
};

export default LogworkHistory;
