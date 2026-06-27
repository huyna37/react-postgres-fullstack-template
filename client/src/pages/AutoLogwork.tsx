import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Scale,
  Send,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '../types';
import { isCancelledTicketStatus } from '../utils/jiraIssueStatus';
import { hasJiraToken } from '../utils/jiraToken';
import {
  distributeLogworkHours,
  formatSecondsToJiraTime,
  sumRemainingLogHours,
} from '../utils/logworkDistribute';
import { formatDayLabel, WORKING_HOURS_PER_DAY, type DayLogTarget } from '../utils/personalOt';
import { showError, showSuccess, showToast } from '../utils/swal';

type CandidateIssue = {
  key: string;
  summary: string;
  status: string;
  issueType?: string;
  startDate?: string | null;
  dueDate?: string | null;
  originalEstimateHours: number;
  timeSpentHours: number;
  remainingLogHours: number;
  loggedOnLogDateHours: number;
};

const ADD_SEARCH_MIN_LEN = 2;
const ADD_SEARCH_DEBOUNCE_MS = 280;
const DEFAULT_LOG_TIME = '17:00';

/** Giờ ghi log theo Asia/Bangkok (+07:00), không phụ thuộc timezone trình duyệt. */
function logDateTimeToBangkokIso(logDate: string, logTime: string): string {
  const dm = logDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm = logTime.match(/^(\d{1,2}):(\d{2})/);
  if (!dm || !tm) return new Date().toISOString();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dm[1]}-${dm[2]}-${dm[3]}T${pad(Number(tm[1]))}:${pad(Number(tm[2]))}:00+07:00`;
}

function getRowMuteNote(row: RowState): string | null {
  if (row.selected) return null;
  return 'Chưa chọn để phân bổ log';
}

function normalizeIssueKey(raw: string, project?: string | null): string {
  const s = raw.trim().toUpperCase();
  if (!s) return s;
  if (s.includes('-')) return s;
  const proj = (project || 'BXDCSDL').split(',')[0].trim().toUpperCase();
  if (/^\d+$/.test(s)) return `${proj}-${s}`;
  return s;
}

type RowState = CandidateIssue & {
  selected: boolean;
  allocatedHours: number;
  timeSpent: string;
  comment: string;
  /** Estimate từ Jira lúc tải — so sánh khi ghi lên Jira */
  savedEstimateHours: number;
  /** User sửa est / phân bổ trên dòng — không ghi đè khi tính lại */
  estimateTouched?: boolean;
  allocationTouched?: boolean;
};

function parseEstimateHours(raw: string | number): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function remainingFromEstimate(estimateHours: number, timeSpentHours: number): number {
  if (estimateHours <= 0) return 0;
  return Math.max(0, +(estimateHours - timeSpentHours).toFixed(2));
}

/** Chia tổng giờ thành n phần (2 chữ số thập phân, tổng khớp). */
function splitTotalHours(total: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [+total.toFixed(2)];
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / count);
  const result = Array.from({ length: count }, () => base / 100);
  let remainder = cents - base * count;
  for (let i = 0; i < remainder; i += 1) {
    result[i] += 0.01;
  }
  return result.map(n => +n.toFixed(2));
}

/** Chỉ chia estimate — không đụng giờ log. */
function applyEstToRows(base: RowState[], defaultEstimateStr: string): RowState[] {
  const fallbackEstTotal = parseEstimateHours(defaultEstimateStr) ?? 0;
  const selectedBase = base.filter(r => r.selected);
  const manualEstSum = selectedBase
    .filter(r => r.estimateTouched)
    .reduce((s, r) => s + (r.originalEstimateHours || 0), 0);
  const autoEstKeys = selectedBase.filter(r => !r.estimateTouched).map(r => r.key);
  const autoEstBudget = Math.max(0, fallbackEstTotal - manualEstSum);
  const estShares = splitTotalHours(autoEstBudget, autoEstKeys.length);
  const estByKey = new Map(autoEstKeys.map((key, i) => [key, estShares[i] ?? 0]));

  return base.map(r => {
    if (!r.selected) return r;

    let estimateHours = r.originalEstimateHours;
    if (!r.estimateTouched && estByKey.has(r.key)) {
      estimateHours = estByKey.get(r.key) ?? 0;
    }

    return {
      ...r,
      originalEstimateHours: estimateHours,
      remainingLogHours: remainingFromEstimate(estimateHours, r.timeSpentHours),
    };
  });
}

/** Chia giờ log — chỉ gọi khi đổi Tổng giờ log hoặc danh sách ticket chọn. */
function redistributeLogInBase(
  base: RowState[],
  estRows: RowState[],
  targetHoursNum: number
): RowState[] {
  const estByKey = new Map(estRows.map(r => [r.key, r]));
  const clearLog = (r: RowState): RowState => ({
    ...r,
    allocatedHours: 0,
    timeSpent: '0h',
  });

  if (targetHoursNum <= 0) {
    return base.map(r => (r.selected && !r.allocationTouched ? clearLog(r) : r));
  }

  const selected = base.filter(r => r.selected);
  if (!selected.length) return base;

  const manualAllocSum = selected
    .filter(r => r.allocationTouched)
    .reduce((s, r) => s + (r.allocatedHours || 0), 0);
  const autoKeys = selected.filter(r => !r.allocationTouched).map(r => r.key);
  if (!autoKeys.length) return base;

  const autoBudget = Math.max(0, targetHoursNum - manualAllocSum);
  const inputs = autoKeys.map(key => {
    const est = estByKey.get(key);
    return {
      key,
      estimateHours: est?.originalEstimateHours ?? 0,
      remainingHours: est?.remainingLogHours ?? 0,
    };
  });

  const cap = sumRemainingLogHours(inputs);
  if (cap <= 0) {
    return base.map(r => (r.selected && !r.allocationTouched ? clearLog(r) : r));
  }

  const effectiveTarget = Math.min(autoBudget, cap);
  const distributed = distributeLogworkHours(inputs, effectiveTarget);
  const logByKey = new Map(distributed.map(d => [d.key, d]));

  return base.map(r => {
    if (!r.selected || r.allocationTouched) return r;
    const d = logByKey.get(r.key);
    if (!d) return clearLog(r);
    return {
      ...r,
      allocatedHours: d.hours,
      timeSpent: d.timeSpent,
    };
  });
}

interface AutoLogworkProps {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
  currentUser: User | null;
}

function todayYmd(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function AutoLogwork({
  apiFetch,
  API_BASE_URL,
  openJiraTicket,
  currentUser,
}: AutoLogworkProps) {
  const [workDate, setWorkDate] = useState(todayYmd);
  const [logDate, setLogDate] = useState(todayYmd);
  const [logTime, setLogTime] = useState(DEFAULT_LOG_TIME);
  const [targetHours, setTargetHours] = useState('7');
  const [defaultEstimate, setDefaultEstimate] = useState('8');
  const [rowsBase, setRowsBase] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addSearchQuery, setAddSearchQuery] = useState('');
  const [addSearchResults, setAddSearchResults] = useState<CandidateIssue[]>([]);
  const [addSearchLoading, setAddSearchLoading] = useState(false);
  const [addDropdownOpen, setAddDropdownOpen] = useState(false);
  const addSearchAbortRef = useRef<AbortController | null>(null);
  const addSearchBoxRef = useRef<HTMLDivElement | null>(null);
  const [underLoggedDays, setUnderLoggedDays] = useState<DayLogTarget[]>([]);
  const [underLoggedMonth, setUnderLoggedMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [loadingUnderLogged, setLoadingUnderLogged] = useState(false);
  const [syncTopFromRows, setSyncTopFromRows] = useState<'est' | null>(null);
  const [closeTasks, setCloseTasks] = useState(false);
  const [closeTaskOutput, setCloseTaskOutput] = useState('Đã hoàn thành.');
  const [applyStatus, setApplyStatus] = useState<string | null>(null);

  const canLog = hasJiraToken(currentUser);

  const targetHoursNum = parseFloat(String(targetHours).replace(',', '.')) || 0;

  const applyEstAndLog = useCallback(
    (base: RowState[]): RowState[] => {
      const estRows = applyEstToRows(base, defaultEstimate);
      return redistributeLogInBase(base, estRows, targetHoursNum);
    },
    [defaultEstimate, targetHoursNum]
  );

  const loadUnderLoggedDays = useCallback(async (): Promise<DayLogTarget[] | null> => {
    const [year, month] = underLoggedMonth.split('-').map(Number);
    if (!year || !month) return null;
    setLoadingUnderLogged(true);
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/api/worklogs/auto-distribute/under-logged-days?year=${year}&month=${month}&minHours=${WORKING_HOURS_PER_DAY}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(typeof data.error === 'string' ? data.error : 'Không tải được ngày thiếu log.');
        return null;
      }
      const days = Array.isArray(data.days) ? (data.days as DayLogTarget[]) : [];
      setUnderLoggedDays(days);
      return days;
    } catch {
      showError('Lỗi kết nối khi tải ngày thiếu log.');
      return null;
    } finally {
      setLoadingUnderLogged(false);
    }
  }, [apiFetch, API_BASE_URL, underLoggedMonth]);

  const selectUnderLoggedDay = useCallback((day: DayLogTarget) => {
    setLogDate(day.date);
    setWorkDate(day.date);
    setLogTime(DEFAULT_LOG_TIME);
    setTargetHours(String(day.missingHours));
    setDefaultEstimate(String(+(day.missingHours + 1).toFixed(2)));
    setRowsBase(prev =>
      prev.map(r => ({ ...r, allocationTouched: false, estimateTouched: false }))
    );
  }, []);

  const focusNextLogDay = useCallback(
    async (loggedDate: string) => {
      const days = await loadUnderLoggedDays();
      if (!days) return;

      const sameDay = days.find(d => d.date === loggedDate);
      if (sameDay) {
        selectUnderLoggedDay(sameDay);
        return;
      }
      if (days.length > 0) {
        selectUnderLoggedDay(days[0]);
      }
    },
    [loadUnderLoggedDays, selectUnderLoggedDay]
  );

  useEffect(() => {
    void loadUnderLoggedDays();
  }, [loadUnderLoggedDays]);

  const loadCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/api/worklogs/auto-distribute/candidates?date=${encodeURIComponent(workDate)}&logDate=${encodeURIComponent(logDate)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(typeof data.error === 'string' ? data.error : 'Không tải được ticket.');
        return;
      }
      const issues: CandidateIssue[] = (data.issues || []).filter(
        (it: CandidateIssue) => !isCancelledTicketStatus(it.status)
      );
      const base = issues.map(it => ({
        ...it,
        selected: false,
        allocatedHours: 0,
        timeSpent: '0h',
        comment: '',
        savedEstimateHours: it.originalEstimateHours,
      }));
      const th = parseFloat(String(targetHours).replace(',', '.')) || 0;
      const estRows = applyEstToRows(base, defaultEstimate);
      setRowsBase(redistributeLogInBase(base, estRows, th));
    } catch {
      showError('Lỗi kết nối khi tải ticket.');
    } finally {
      setLoading(false);
    }
    // defaultEstimate / targetHours đọc khi response về — không đưa vào deps để tránh reload khi sửa ô trên
  }, [apiFetch, API_BASE_URL, workDate, logDate]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const logStartedIso = useMemo(
    () => logDateTimeToBangkokIso(logDate, logTime),
    [logDate, logTime]
  );

  const logDateDisplay = useMemo(() => {
    const [y, mo, d] = logDate.split('-');
    if (!y || !mo || !d) return '—';
    return `${d}/${mo}/${y} ${logTime}`;
  }, [logDate, logTime]);

  const rowsWithEst = useMemo(
    () => applyEstToRows(rowsBase, defaultEstimate),
    [rowsBase, defaultEstimate]
  );

  const rows = useMemo(
    () =>
      rowsWithEst.map(r => {
        const log = rowsBase.find(b => b.key === r.key);
        if (!log) return r;
        return {
          ...r,
          allocatedHours: log.allocatedHours,
          timeSpent: log.timeSpent,
          allocationTouched: log.allocationTouched,
        };
      }),
    [rowsWithEst, rowsBase]
  );

  const selectedKeysSig = useMemo(
    () =>
      rowsBase
        .filter(r => r.selected)
        .map(r => r.key)
        .sort()
        .join('|'),
    [rowsBase]
  );

  useEffect(() => {
    setRowsBase(prev => {
      if (!prev.length) return prev;
      const estRows = applyEstToRows(prev, defaultEstimate);
      const next = redistributeLogInBase(prev, estRows, targetHoursNum);
      const unchanged = next.every(r => {
        const p = prev.find(x => x.key === r.key);
        if (!p) return false;
        return (
          p.allocatedHours === r.allocatedHours &&
          p.timeSpent === r.timeSpent &&
          p.allocationTouched === r.allocationTouched
        );
      });
      return unchanged ? prev : next;
    });
    // defaultEstimate đọc từ closure — sửa est không kích hoạt chia log lại
  }, [targetHoursNum, selectedKeysSig]);

  const selectedRows = useMemo(() => rows.filter(r => r.selected), [rows]);

  const totalEstimateHours = useMemo(
    () => selectedRows.reduce((s, r) => s + (r.originalEstimateHours || 0), 0),
    [selectedRows]
  );

  const allocatedTotalHours = useMemo(
    () => selectedRows.reduce((s, r) => s + (r.allocatedHours || 0), 0),
    [selectedRows]
  );

  const totalRemainingHours = useMemo(() => {
    const sum = sumRemainingLogHours(
      selectedRows.map(r => ({
        key: r.key,
        estimateHours: r.originalEstimateHours,
        remainingHours: r.remainingLogHours,
      }))
    );
    return sum;
  }, [selectedRows]);

  const cappedTargetHours = useMemo(() => {
    if (targetHoursNum <= 0) return 0;
    if (totalRemainingHours === Infinity) return targetHoursNum;
    return Math.min(targetHoursNum, totalRemainingHours);
  }, [targetHoursNum, totalRemainingHours]);

  useEffect(() => {
    if (!syncTopFromRows) return;
    if (syncTopFromRows === 'est') {
      const sum = selectedRows.reduce((s, r) => s + (r.originalEstimateHours || 0), 0);
      const next = (+sum.toFixed(2)).toString();
      setDefaultEstimate(prev => (prev === next ? prev : next));
    }
    setSyncTopFromRows(null);
  }, [syncTopFromRows, selectedRows]);

  const handleAddTicket = async (keyOverride?: string) => {
    const key = normalizeIssueKey(keyOverride ?? addKey, currentUser?.jira_project);
    if (!key) return;
    if (rowsBase.some(r => r.key === key)) {
      showError('Ticket đã có trong danh sách.');
      return;
    }
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/api/worklogs/auto-distribute/issue/${encodeURIComponent(key)}?logDate=${encodeURIComponent(logDate)}&planDate=${encodeURIComponent(workDate)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(typeof data.error === 'string' ? data.error : 'Không thêm được ticket.');
        return;
      }
      const it = data.issue as CandidateIssue;
      setRowsBase(prev =>
        applyEstAndLog([
          ...prev,
          {
            ...it,
            selected: false,
            allocatedHours: 0,
            timeSpent: '0h',
            comment: '',
            savedEstimateHours: it.originalEstimateHours,
          },
        ])
      );
      setAddKey('');
      setAddSearchQuery('');
      setAddSearchResults([]);
      setAddDropdownOpen(false);
    } catch {
      showError('Lỗi khi tra cứu ticket.');
    }
  };

  useEffect(() => {
    const trimmed = addKey.trim();
    if (!trimmed) {
      setAddSearchQuery('');
      setAddSearchResults([]);
      setAddSearchLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setAddSearchQuery(trimmed);
    }, ADD_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [addKey]);

  useEffect(() => {
    addSearchAbortRef.current?.abort();

    if (!addSearchQuery || addSearchQuery.length < ADD_SEARCH_MIN_LEN) {
      if (!addSearchQuery) setAddSearchResults([]);
      setAddSearchLoading(false);
      return;
    }

    const controller = new AbortController();
    addSearchAbortRef.current = controller;

    void (async () => {
      setAddSearchLoading(true);
      try {
        const res = await apiFetch(
          `${API_BASE_URL}/api/worklogs/auto-distribute/search?q=${encodeURIComponent(addSearchQuery)}&limit=12&logDate=${encodeURIComponent(logDate)}&planDate=${encodeURIComponent(workDate)}`,
          { signal: controller.signal }
        );
        const data = await res.json().catch(() => ({}));
        if (controller.signal.aborted) return;
        if (!res.ok) {
          setAddSearchResults([]);
          return;
        }
        const issues = Array.isArray(data.issues) ? (data.issues as CandidateIssue[]) : [];
        setAddSearchResults(issues);
        setAddDropdownOpen(true);
      } catch (err) {
        if (controller.signal.aborted) return;
        setAddSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setAddSearchLoading(false);
      }
    })();

    return () => controller.abort();
  }, [addSearchQuery, logDate, workDate, apiFetch, API_BASE_URL]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!addSearchBoxRef.current?.contains(e.target as Node)) {
        setAddDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const addSearchSuggestions = useMemo(
    () =>
      addSearchResults.filter(
        r => !isCancelledTicketStatus(r.status) && !rowsBase.some(row => row.key === r.key)
      ),
    [addSearchResults, rowsBase]
  );

  const handleAiComment = async (issueKey: string) => {
    const row = rows.find(r => r.key === issueKey);
    if (!row) return;
    try {
      const detailsRes = await apiFetch(
        `${API_BASE_URL}/api/tickets/details/${issueKey}?with=content`
      );
      if (!detailsRes.ok) {
        showError('Không tải được mô tả ticket.');
        return;
      }
      const details = await detailsRes.json();
      const commentRes = await apiFetch(`${API_BASE_URL}/api/generate/worklog-comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: details.summary ?? row.summary,
          description: details.description ?? '',
        }),
      });
      if (!commentRes.ok) {
        showError('AI không tạo được comment.');
        return;
      }
      const { comment } = await commentRes.json();
      setRowsBase(prev => prev.map(r => (r.key === issueKey ? { ...r, comment: comment || '' } : r)));
    } catch {
      showError('Lỗi khi gọi AI.');
    }
  };

  const handleApplyLogwork = async () => {
    const toApply = rows.filter(r => r.selected && r.timeSpent && r.timeSpent !== '0m');
    if (!toApply.length) {
      showError('Chưa có giờ log — kiểm tra tổng giờ log.');
      return;
    }
    if (!canLog) {
      showError('Cần cấu hình Jira Token tại Cấu hình cá nhân.');
      return;
    }

    setApplying(true);
    setApplyStatus(null);
    const loggedDateAtApply = logDate;
    try {
      const estimateUpdates = toApply
        .map(r => {
          const estimateHours = parseEstimateHours(r.originalEstimateHours);
          if (estimateHours == null) return null;
          if (Math.abs(estimateHours - r.savedEstimateHours) < 0.01) return null;
          return { key: r.key, estimateHours };
        })
        .filter(Boolean) as { key: string; estimateHours: number }[];

      if (estimateUpdates.length > 0) {
        const estRes = await apiFetch(`${API_BASE_URL}/api/tickets/batch-estimate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: estimateUpdates }),
        });
        const estData = await estRes.json().catch(() => ({}));
        if (!estRes.ok) {
          showError(typeof estData.error === 'string' ? estData.error : 'Cập nhật estimate thất bại.');
          return;
        }
        const estResults = (estData.results || []) as { key: string; success?: boolean; error?: string }[];
        const estFailed = estResults.filter(r => !r.success);
        if (estFailed.length > 0) {
          showToast(
            `Estimate lỗi ${estFailed.length} ticket — vẫn thử ghi logwork.`,
            'warning'
          );
        }
      }

      setApplyStatus(`Đang ghi logwork ${toApply.length} ticket...`);

      const res = await apiFetch(`${API_BASE_URL}/api/worklogs/auto-distribute/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          started: logStartedIso,
          entries: toApply.map(r => ({
            issueKey: r.key,
            timeSpent: r.timeSpent,
            comment: r.comment,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(typeof data.error === 'string' ? data.error : 'Ghi logwork thất bại.');
        return;
      }
      const { okCount = 0, failCount = 0, results = [] } = data;
      const okKeys = new Set(
        (results as { issueKey: string; ok?: boolean }[])
          .filter(r => r.ok)
          .map(r => r.issueKey)
      );
      if (okKeys.size > 0) {
        setRowsBase(prev => prev.filter(r => !okKeys.has(r.key)));
      }

      let closeFailed: { issueKey: string; error?: string }[] = [];
      let closedCount = 0;

      if (closeTasks && okKeys.size > 0) {
        setApplyStatus(`Đang đóng ${okKeys.size} ticket...`);
        const closeRes = await apiFetch(`${API_BASE_URL}/api/worklogs/close-issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            issueKeys: [...okKeys],
            output: closeTaskOutput.trim() || 'Đã hoàn thành.',
          }),
        });
        const closeData = await closeRes.json().catch(() => ({}));
        if (closeRes.ok || closeRes.status === 207) {
          closedCount = Number(closeData.closed) || 0;
          closeFailed = (closeData.results || []).filter(
            (r: { ok?: boolean }) => !r.ok
          );
        } else {
          closeFailed = [...okKeys].map(issueKey => ({
            issueKey,
            error:
              typeof closeData.error === 'string'
                ? closeData.error
                : 'Không đóng được ticket',
          }));
        }
      }

      if (failCount === 0) {
        if (closeFailed.length > 0) {
          const failList = closeFailed.map(r => `${r.issueKey}: ${r.error}`).join('\n');
          showSuccess(
            `Đã logwork ${okCount} ticket lên Jira.\n(Không đóng được ${closeFailed.length} ticket:\n${failList})`
          );
        } else if (closeTasks && closedCount > 0) {
          showSuccess(`Đã logwork ${okCount} ticket và đóng ${closedCount} ticket.`);
        } else {
          showSuccess(`Đã logwork ${okCount} ticket lên Jira.`);
        }
        await focusNextLogDay(loggedDateAtApply);
        void loadCandidates();
      } else {
        const failed = (results as { issueKey: string; ok?: boolean; error?: string }[])
          .filter(r => !r.ok)
          .map(r => `${r.issueKey}: ${r.error}`)
          .join('\n');
        const closeWarn =
          closeFailed.length > 0
            ? `\n(Một số ticket không đóng được:\n${closeFailed.map(r => `${r.issueKey}: ${r.error}`).join('\n')})`
            : '';
        showError(`Thành công ${okCount}, lỗi ${failCount}.\n${failed}${closeWarn}`);
        if (okCount > 0) {
          await focusNextLogDay(loggedDateAtApply);
        }
        void loadCandidates();
      }
    } catch {
      showError('Lỗi mạng khi ghi logwork.');
    } finally {
      setApplying(false);
      setApplyStatus(null);
    }
  };

  const updateRowEstimate = (key: string, raw: string) => {
    setRowsBase(prev =>
      prev.map(r => {
        if (r.key !== key) return r;
        const parsed = parseEstimateHours(raw);
        const estimateHours = parsed ?? 0;
        const remainingLogHours = remainingFromEstimate(estimateHours, r.timeSpentHours);
        return {
          ...r,
          originalEstimateHours: estimateHours,
          remainingLogHours,
          estimateTouched: true,
          selected:
            estimateHours <= 0 ? r.selected : remainingLogHours > 0 ? r.selected : false,
        };
      })
    );
    setSyncTopFromRows('est');
  };

  const updateRowAllocation = (key: string, raw: string) => {
    const hours = parseFloat(String(raw).replace(',', '.')) || 0;
    setRowsBase(prev => {
      const row = prev.find(r => r.key === key);
      if (!row) return prev;

      const otherManualSum = prev
        .filter(r => r.selected && r.key !== key && r.allocationTouched)
        .reduce((s, r) => s + (r.allocatedHours || 0), 0);
      const targetBudgetLeft = Math.max(0, targetHoursNum - otherManualSum);

      const capByEst = row.originalEstimateHours > 0 ? row.remainingLogHours : Infinity;
      let clamped = Math.max(0, hours);
      if (capByEst !== Infinity) clamped = Math.min(clamped, capByEst);
      clamped = Math.min(clamped, targetBudgetLeft);

      const seconds = Math.max(0, Math.round(clamped * 3600));

      const withEdit = prev.map(r => {
        if (r.key !== key) return r;
        return {
          ...r,
          allocatedHours: clamped,
          timeSpent: formatSecondsToJiraTime(seconds),
          allocationTouched: true,
        };
      });

      const estRows = applyEstToRows(withEdit, defaultEstimate);
      return redistributeLogInBase(withEdit, estRows, targetHoursNum);
    });
  };

  return (
    <main className="glass-card auto-logwork-page">
      <div className="auto-logwork-page__head">
        <div>
          <h2 className="auto-logwork-page__title">
            <Scale size={22} color="#6366f1" />
            Logwork tự động (cân tải)
          </h2>
          <p className="auto-logwork-page__subtitle">
            Lọc ticket <strong>Done/In Progress</strong> có ngày lọc nằm trong <strong>start–due</strong> (cùng tháng) —
            <strong>Tổng est</strong> chia đều
            cho các ticket, <strong>Tổng giờ log</strong> chia theo tỉ lệ est.
          </p>
        </div>
        <button
          type="button"
          className="filter-btn"
          onClick={() => void loadCandidates()}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? 'spinner' : ''} />
          Tải lại
        </button>
      </div>

      <section className="auto-logwork-underlogged">
        <div className="auto-logwork-underlogged__head">
          <div>
            <h3 className="auto-logwork-underlogged__title">
              Ngày chưa đủ mục tiêu ({WORKING_HOURS_PER_DAY}h + OT)
            </h3>
            <p className="auto-logwork-underlogged__hint">
              Mục tiêu = {WORKING_HOURS_PER_DAY}h + OT (khai báo tại <strong>Giờ OT cá nhân</strong>).
              Bấm chip để chọn ngày ghi log và điền giờ còn thiếu.
            </p>
          </div>
          <div className="auto-logwork-underlogged__month">
            <input
              type="month"
              className="ticket-field ticket-field--compact"
              value={underLoggedMonth}
              onChange={e => setUnderLoggedMonth(e.target.value)}
            />
            <button
              type="button"
              className="filter-btn"
              onClick={() => void loadUnderLoggedDays()}
              disabled={loadingUnderLogged}
              title="Tải lại"
            >
              <RefreshCw size={14} className={loadingUnderLogged ? 'spinner' : ''} />
            </button>
          </div>
        </div>
        {loadingUnderLogged && underLoggedDays.length === 0 ? (
          <div className="auto-logwork-underlogged__loading">
            <Loader2 size={18} className="spinner" />
            <span>Đang kiểm tra logwork…</span>
          </div>
        ) : underLoggedDays.length === 0 ? (
          <p className="auto-logwork-underlogged__empty">
            Tháng này không có ngày làm việc nào thiếu log (≤ hôm nay).
          </p>
        ) : (
          <div className="auto-logwork-underlogged__list">
            {underLoggedDays.map(day => {
              const isActive = logDate === day.date;
              return (
                <button
                  key={day.date}
                  type="button"
                  className={`auto-logwork-underlogged__chip${isActive ? ' is-active' : ''}`}
                  onClick={() => selectUnderLoggedDay(day)}
                  title={`Đã log ${day.loggedHours}h — còn thiếu ${day.missingHours}h`}
                >
                  <span className="auto-logwork-underlogged__chip-date">
                    {formatDayLabel(day.date)}
                  </span>
                  <span className="auto-logwork-underlogged__chip-meta">
                    {day.loggedHours}h / {day.requiredHours ?? day.minHoursPerDay}h
                    {(day.otHours ?? 0) > 0 && day.baseHoursPerDay > 0 ? (
                      <em className="auto-logwork-underlogged__ot"> +{day.otHours}h OT</em>
                    ) : (day.otHours ?? 0) > 0 && day.baseHoursPerDay === 0 ? (
                      <em className="auto-logwork-underlogged__ot"> (OT)</em>
                    ) : null}
                    <strong> −{day.missingHours}h</strong>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="auto-logwork-page__controls">
        <label className="auto-logwork-field">
          <span>Ngày lọc (start–due)</span>
          <input
            type="date"
            className="ticket-field ticket-field--compact"
            value={workDate}
            onChange={e => setWorkDate(e.target.value)}
            title="Chỉ hiện ticket Done có start_date ≤ ngày này ≤ due_date"
          />
        </label>
        <label className="auto-logwork-field">
          <span>Ngày ghi log (Jira)</span>
          <input
            type="date"
            className="ticket-field ticket-field--compact"
            value={logDate}
            onChange={e => setLogDate(e.target.value)}
            title="Ngày started khi ghi worklog lên Jira"
          />
        </label>
        <label className="auto-logwork-field auto-logwork-field--time">
          <span>Giờ log</span>
          <input
            type="time"
            className="ticket-field ticket-field--compact"
            value={logTime}
            onChange={e => setLogTime(e.target.value)}
          />
        </label>
        <label className="auto-logwork-field">
          <span>Tổng giờ log</span>
          <input
            type="number"
            min={0.25}
            step={0.25}
            className="ticket-field ticket-field--compact"
            value={targetHours}
            onChange={e => {
              const val = e.target.value;
              setTargetHours(val);
              const num = parseFloat(val.replace(',', '.')) || 0;
              if (num > 0) {
                setDefaultEstimate(String(num + 1));
              }
              setRowsBase(prev =>
                prev.map(r => ({ ...r, allocationTouched: false, estimateTouched: false }))
              );
            }}
            placeholder="7"
          />
        </label>
        <label className="auto-logwork-field">
          <span>Tổng est (h)</span>
          <input
            type="number"
            min={0.25}
            step={0.25}
            className="ticket-field ticket-field--compact"
            value={defaultEstimate}
            onChange={e => {
              setDefaultEstimate(e.target.value);
              setRowsBase(prev => prev.map(r => ({ ...r, estimateTouched: false })));
            }}
            placeholder="8"
            title="Tổng estimate chia đều cho ticket chưa sửa est tay — VD: 8h / 3 ticket ≈ 2.67h mỗi ticket"
          />
        </label>
        <div className="auto-logwork-field" style={{ minWidth: closeTasks ? '22rem' : '13rem', marginBottom: '0.4rem' }}>
          <span style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>Sau khi logwork</span>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              height: '40px',
            }}
          >
            <label
              className="ticket-field ticket-field--compact"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                height: '40px',
                boxSizing: 'border-box',
                flexShrink: 0,
                width: 'auto',
                margin: 0,
              }}
            >
              <input
                type="checkbox"
                checked={closeTasks}
                onChange={e => setCloseTasks(e.target.checked)}
                style={{
                  width: '16px',
                  height: '16px',
                  margin: 0,
                  cursor: 'pointer',
                  accentColor: '#6366f1',
                }}
              />
              <span
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--text-primary)',
                  textTransform: 'none',
                  fontWeight: 'normal',
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
                title="Tự động chuyển trạng thái ticket sang Done/Hoàn thành/Closed và điền output mẫu nếu Jira yêu cầu"
              >
                Đóng task & điền output
              </span>
            </label>
            {closeTasks && (
              <input
                type="text"
                className="ticket-field ticket-field--compact"
                placeholder="Nội dung output khi đóng task..."
                value={closeTaskOutput}
                onChange={e => setCloseTaskOutput(e.target.value)}
                style={{ flex: 1, minWidth: '10rem', height: '40px' }}
                title="Nội dung sẽ điền vào trường Output khi chuyển trạng thái Đóng/Done"
              />
            )}
          </div>
        </div>
      </div>

      <div className="auto-logwork-toolbar">
        <div className="auto-logwork-page__stats">
          <span>
            Ticket chọn: <strong>{selectedRows.length}</strong>
          </span>
          <span>
            Tổng est: <strong>{totalEstimateHours.toFixed(1)}h</strong>
          </span>
          <span>
            Est còn lại:{' '}
            <strong>
              {totalRemainingHours === Infinity
                ? '—'
                : `${totalRemainingHours.toFixed(2)}h`}
            </strong>
          </span>
          <span>
            Đã log:{' '}
            <strong
              className={
                Math.abs(allocatedTotalHours - cappedTargetHours) < 0.05
                  ? 'auto-logwork-stat--ok'
                  : undefined
              }
            >
              {allocatedTotalHours.toFixed(2)}h
            </strong>
            {cappedTargetHours > 0 ? ` / ${cappedTargetHours.toFixed(2)}h` : ''}
            {cappedTargetHours < targetHoursNum - 0.05 ? (
              <span className="auto-logwork-stat--warn" title="Bị giới hạn bởi estimate">
                (max est)
              </span>
            ) : null}
          </span>
          <span>
            Ghi log:{' '}
            <strong>
              {logDate.split('-').reverse().join('/')} {logTime}
            </strong>
          </span>
        </div>
        <div className="auto-logwork-add-row" ref={addSearchBoxRef}>
          <div className="auto-logwork-add-search">
            <input
              type="text"
              className="ticket-field ticket-field--compact"
              placeholder="Tìm ticket Done/In Progress (VD: 2653, BXDCSDL-123)..."
              value={addKey}
              autoComplete="off"
              onChange={e => {
                setAddKey(e.target.value);
                setAddDropdownOpen(true);
              }}
              onFocus={() => {
                if (addSearchSuggestions.length > 0) setAddDropdownOpen(true);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (addSearchSuggestions.length === 1) {
                    void handleAddTicket(addSearchSuggestions[0].key);
                    return;
                  }
                  void handleAddTicket();
                }
                if (e.key === 'Escape') setAddDropdownOpen(false);
              }}
            />
            {addDropdownOpen &&
            addKey.trim().length >= ADD_SEARCH_MIN_LEN &&
            (addSearchLoading || addSearchSuggestions.length > 0) ? (
              <ul className="auto-logwork-add-dropdown" role="listbox">
                {addSearchLoading ? (
                  <li className="auto-logwork-add-dropdown__status">
                    <Loader2 className="spinner" size={14} />
                    Đang tìm…
                  </li>
                ) : null}
                {!addSearchLoading && addSearchSuggestions.length === 0 ? (
                  <li className="auto-logwork-add-dropdown__status">Không có ticket Done/In Progress phù hợp</li>
                ) : null}
                {!addSearchLoading
                  ? addSearchSuggestions.map(item => (
                      <li key={item.key} role="option">
                        <button
                          type="button"
                          className="auto-logwork-add-dropdown__item"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => void handleAddTicket(item.key)}
                        >
                          <span className="auto-logwork-add-dropdown__key">{item.key}</span>
                          <span className="auto-logwork-add-dropdown__meta">
                            {item.issueType ? `${item.issueType} · ` : ''}
                            {item.status}
                          </span>
                          <span className="auto-logwork-add-dropdown__summary">{item.summary}</span>
                        </button>
                      </li>
                    ))
                  : null}
              </ul>
            ) : null}
          </div>
          <button type="button" className="filter-btn" onClick={() => void handleAddTicket()}>
            <Plus size={14} />
            Thêm
          </button>
        </div>
      </div>

      {loading && rowsBase.length === 0 ? (
        <div className="dashboard-initial-loading">
          <Loader2 className="spinner" size={36} color="#6366f1" />
          <p>Đang tải ticket Done/In Progress (start–due chứa ngày lọc)…</p>
        </div>
      ) : rowsBase.length === 0 ? (
        <div className="empty-state-box">
          <CheckCircle2 size={40} style={{ opacity: 0.35 }} />
          <p>
            Không có ticket Done/In Progress (trừ Story/Epic) — start ≤ {workDate.split('-').reverse().join('/')} ≤ due,
            start & due trong tháng {workDate.slice(0, 7)}, gán cho bạn, chưa có logwork của bạn trên ticket
            và chưa ghi ngày {logDate.split('-').reverse().join('/')}.
          </p>
          <p className="auto-logwork-page__hint">Thêm Task/Sub-task thủ công bằng ô phía trên.</p>
        </div>
      ) : (
        <div className="auto-logwork-table-wrap">
          <table className="auto-logwork-table">
            <thead>
              <tr>
                <th />
                <th>Ticket</th>
                <th>Start / Due</th>
                <th>Est</th>
                <th>Ngày ghi log</th>
                <th>Log</th>
                <th>Jira</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const muteNote = getRowMuteNote(row);
                const rowClass = row.selected ? 'is-selected' : 'is-muted';

                return (
                <tr key={row.key} className={rowClass}>
                  <td>
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={e =>
                        setRowsBase(prev =>
                          prev.map(r =>
                            r.key === row.key ? { ...r, selected: e.target.checked } : r
                          )
                        )
                      }
                    />
                  </td>
                  <td>
                    <div className="auto-logwork-ticket-cell">
                      <div className="auto-logwork-ticket-head">
                        <button
                          type="button"
                          className="auto-logwork-key"
                          onClick={() => openJiraTicket(row.key)}
                        >
                          {row.key}
                          <ExternalLink size={11} />
                        </button>
                      </div>
                      <div className="auto-logwork-summary" title={row.summary}>
                        {row.summary}
                      </div>
                      {muteNote ? (
                        <div className="auto-logwork-mute-note">{muteNote}</div>
                      ) : null}
                    </div>
                  </td>
                  <td className="auto-logwork-plan-dates">
                    {row.startDate ? row.startDate.split('-').reverse().join('/') : '—'}
                    <span className="auto-logwork-plan-dates__sep">→</span>
                    {row.dueDate ? row.dueDate.split('-').reverse().join('/') : '—'}
                  </td>
                  <td className="auto-logwork-table__num auto-logwork-table__est">
                    <input
                      type="number"
                      min={0}
                      step={0.25}
                      className="ticket-field ticket-field--compact auto-logwork-est-input"
                      placeholder="Est"
                      value={row.originalEstimateHours > 0 ? row.originalEstimateHours : ''}
                      disabled={!row.selected}
                      title={
                        row.savedEstimateHours > 0
                          ? `Jira: ${row.savedEstimateHours}h`
                          : 'Nhập estimate gốc (giờ) — lưu lên Jira khi ghi log'
                      }
                      onChange={e => updateRowEstimate(row.key, e.target.value)}
                    />
                  </td>
                  <td className="auto-logwork-table__log-date">
                    {row.selected ? logDateDisplay : '—'}
                  </td>
                  <td className="auto-logwork-table__num auto-logwork-table__log">
                    <input
                      type="number"
                      min={0}
                      step={0.25}
                      className="ticket-field ticket-field--compact auto-logwork-alloc-input"
                      value={row.allocatedHours > 0 ? row.allocatedHours : ''}
                      disabled={!row.selected}
                      placeholder="—"
                      title={row.timeSpent ? `Ghi Jira: ${row.timeSpent}` : undefined}
                      onChange={e => updateRowAllocation(row.key, e.target.value)}
                    />
                  </td>
                  <td>
                    <span className="auto-logwork-status">{row.status}</span>
                  </td>
                  <td>
                    <div className="auto-logwork-comment-cell">
                      <input
                        type="text"
                        className="ticket-field ticket-field--compact"
                        placeholder="Comment logwork..."
                        value={row.comment}
                        disabled={!row.selected}
                        onChange={e =>
                          setRowsBase(prev =>
                            prev.map(r =>
                              r.key === row.key ? { ...r, comment: e.target.value } : r
                            )
                          )
                        }
                      />
                      <button
                        type="button"
                        className="filter-btn auto-logwork-ai-btn"
                        title="AI viết comment"
                        disabled={!row.selected}
                        onClick={() => void handleAiComment(row.key)}
                      >
                        <Sparkles size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="auto-logwork-page__footer">
        {!canLog ? (
          <p className="auto-logwork-page__warn">
            Cấu hình Jira Token tại mục Cấu hình cá nhân để ghi log.
          </p>
        ) : null}
        <button
          type="button"
          className="btn-primary"
          disabled={applying || !canLog || selectedRows.length === 0}
          onClick={() => void handleApplyLogwork()}
        >
          {applying ? <Loader2 size={15} className="spinner" /> : <Send size={15} />}
          {applying && applyStatus
            ? applyStatus
            : `Ghi logwork lên Jira (${selectedRows.filter(r => r.timeSpent && r.timeSpent !== '0m').length})`}
        </button>
      </div>
    </main>
  );
}
