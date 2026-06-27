import React, { useState } from 'react';
import { Clock, Loader2, Sparkles } from 'lucide-react';
import CommonModal from './CommonModal';
import { useDeferredUnmount } from '../hooks/useDeferredUnmount';
import { formatCommentBody } from '../utils/jiraComment';
import { showError, showToast } from '../utils/swal';

type TicketLogworkButtonProps = {
  issueKey: string;
  ticketSummary?: string;
  ticketDescription?: string;
  originalEstimateSeconds?: number;
  defaultTimeSpentSeconds?: number;
  existingWorklog?: {
    id?: string;
    timeSpent?: string;
    started?: string;
    comment?: unknown;
  } | null;
  worklogYear?: number;
  worklogMonth?: number;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  canAct: boolean;
  onLogged?: () => void;
};

function secondsToEstimateHours(sec?: number): string {
  if (sec == null || sec <= 0) return '';
  return String(+(sec / 3600).toFixed(2));
}

function formatSecondsToJiraTime(seconds?: number): string {
  const n = Number(seconds) || 0;
  if (n <= 0) return '1h';
  const h = n / 3600;
  if (h >= 1) return `${Math.round(h * 10) / 10}h`;
  const m = Math.round(n / 60);
  return m > 0 ? `${m}m` : '1h';
}

function parseEstimateHours(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toDatetimeLocalValue(input?: string | Date): string {
  const d = input ? new Date(input) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${safe.getFullYear()}-${pad(safe.getMonth() + 1)}-${pad(safe.getDate())}T${pad(safe.getHours())}:${pad(safe.getMinutes())}`;
}

function plainDescription(val: unknown): string {
  return typeof val === 'string' ? val : formatCommentBody(val);
}

function resolveTimeSpent(
  worklog: TicketLogworkButtonProps['existingWorklog'],
  fallbackSeconds?: number
): string {
  return worklog?.timeSpent?.trim() || formatSecondsToJiraTime(fallbackSeconds);
}

export default function TicketLogworkButton({
  issueKey,
  ticketSummary,
  ticketDescription,
  originalEstimateSeconds,
  defaultTimeSpentSeconds,
  existingWorklog,
  worklogYear,
  worklogMonth,
  apiFetch,
  apiBaseUrl,
  canAct,
  onLogged,
}: TicketLogworkButtonProps) {
  const [open, setOpen] = useState(false);
  const [timeSpent, setTimeSpent] = useState('1h');
  const [started, setStarted] = useState(toDatetimeLocalValue);
  const [estimateHours, setEstimateHours] = useState('');
  const [initialEstimateHours, setInitialEstimateHours] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [generatingAi, setGeneratingAi] = useState(false);
  const mounted = useDeferredUnmount(open);

  const isReplaceMode = !!existingWorklog;
  const canReplace = isReplaceMode;

  const resetForm = () => {
    const estStr = secondsToEstimateHours(originalEstimateSeconds);
    setEstimateHours(estStr);
    setInitialEstimateHours(parseEstimateHours(estStr));

    if (existingWorklog) {
      setTimeSpent(resolveTimeSpent(existingWorklog, defaultTimeSpentSeconds));
      setStarted(toDatetimeLocalValue(existingWorklog.started));
      setComment(formatCommentBody(existingWorklog.comment));
      return;
    }

    setTimeSpent(resolveTimeSpent(null, defaultTimeSpentSeconds));
    setStarted(toDatetimeLocalValue());
    setComment('');
  };

  const handleOpen = () => {
    resetForm();
    setOpen(true);
  };

  const handleAiComment = async () => {
    setGeneratingAi(true);
    try {
      const res = await apiFetch(`${apiBaseUrl}/api/generate/worklog-comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: String(ticketSummary ?? ''),
          description: plainDescription(ticketDescription),
        }),
      });
      if (!res.ok) throw new Error('AI không tạo được comment.');
      const data = await res.json();
      setComment(String(data.comment ?? ''));
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'AI không tạo được comment.');
    } finally {
      setGeneratingAi(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTime = timeSpent.trim();
    if (!trimmedTime) {
      showError('Vui lòng nhập thời gian (vd: 1h, 30m).');
      return;
    }

    const nextEstimate = parseEstimateHours(estimateHours);
    if (estimateHours.trim() && nextEstimate == null) {
      showError('Estimate phải là số giờ lớn hơn 0 (vd: 4 hoặc 2.5).');
      return;
    }

    const shouldUpdateEstimate =
      nextEstimate != null &&
      (initialEstimateHours == null || Math.abs(nextEstimate - initialEstimateHours) > 0.001);

    setSubmitting(true);
    try {
      const payload = {
        issueKey,
        timeSpent: trimmedTime,
        comment,
        started: new Date(started).toISOString(),
        ...(isReplaceMode && worklogYear && worklogMonth
          ? { year: worklogYear, month: worklogMonth }
          : {}),
      };
      const res = await apiFetch(
        `${apiBaseUrl}/api/worklogs${isReplaceMode ? '/replace' : ''}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || (isReplaceMode ? 'Cập nhật logwork thất bại.' : 'Ghi logwork thất bại.'));
      }

      let estimateNote = '';
      if (shouldUpdateEstimate && nextEstimate != null) {
        const estRes = await apiFetch(`${apiBaseUrl}/api/tickets/batch-estimate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ key: issueKey, estimateHours: nextEstimate }] }),
        });
        const estData = await estRes.json().catch(() => ({}));
        const estResult = Array.isArray(estData.results)
          ? estData.results.find((r: { key?: string }) => r.key === issueKey)
          : null;
        if (estRes.ok && estResult?.success) {
          estimateNote = `, estimate → ${nextEstimate}h`;
        } else {
          const errMsg = estResult?.error || estData.error || 'Cập nhật estimate thất bại';
          const logMsg = isReplaceMode ? 'Đã cập nhật logwork' : `Đã log ${trimmedTime}`;
          showToast(`${logMsg} nhưng estimate chưa lưu: ${errMsg}`, 'warning');
          setOpen(false);
          onLogged?.();
          return;
        }
      }

      showToast(
        isReplaceMode
          ? `Đã cập nhật logwork ${trimmedTime} cho ${issueKey}${estimateNote}.`
          : `Đã log ${trimmedTime} vào ${issueKey}${estimateNote}.`,
        'success'
      );
      setOpen(false);
      onLogged?.();
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : isReplaceMode ? 'Cập nhật logwork thất bại.' : 'Ghi logwork thất bại.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!canAct) return null;

  return (
    <>
      <button
        type="button"
        className="ticket-logwork-btn"
        onClick={handleOpen}
        title={canReplace ? 'Sửa logwork trên Jira' : 'Ghi logwork lên Jira'}
      >
        <Clock size={13} />
        <span>Logwork</span>
      </button>

      {mounted && (
        <CommonModal
          open={open}
          onClose={() => setOpen(false)}
          title={isReplaceMode ? `Cập nhật logwork — ${issueKey}` : `Logwork — ${issueKey}`}
          titleId="ticket-logwork-modal-title"
          classNameContent="ticket-logwork-modal"
          zIndex={1300}
          closeDisabled={submitting}
        >
          <form className="ticket-logwork-modal__form" onSubmit={(e) => void handleSubmit(e)}>
            <p className="ticket-logwork-modal__intro">
              {isReplaceMode ? (
                <>
                  Ticket <strong>{issueKey}</strong> đã có logwork của bạn — lưu sẽ{' '}
                  <strong>xóa log cũ và tạo mới</strong> trên Jira.
                </>
              ) : (
                <>
                  Ghi logwork lên Jira cho <strong>{issueKey}</strong>. Có thể thêm hoặc sửa estimate gốc
                  cùng lúc.
                </>
              )}
            </p>

            <div className="ticket-logwork-modal__grid ticket-logwork-modal__grid--with-estimate">
              <label className="ticket-logwork-modal__field">
                <span className="ticket-logwork-modal__label">Thời gian log</span>
                <input
                  required
                  value={timeSpent}
                  onChange={(e) => setTimeSpent(e.target.value)}
                  className="ticket-field ticket-field--compact"
                  placeholder="1h, 30m, 1h 30m"
                  disabled={submitting}
                />
              </label>
              <label className="ticket-logwork-modal__field">
                <span className="ticket-logwork-modal__label">Bắt đầu</span>
                <input
                  type="datetime-local"
                  required
                  value={started}
                  onChange={(e) => setStarted(e.target.value)}
                  className="ticket-field ticket-field--compact ticket-logwork-modal__datetime"
                  disabled={submitting}
                />
              </label>
              <label className="ticket-logwork-modal__field">
                <span className="ticket-logwork-modal__label">Estimate (giờ)</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={estimateHours}
                  onChange={(e) => setEstimateHours(e.target.value)}
                  className="ticket-field ticket-field--compact"
                  placeholder="vd: 4"
                  disabled={submitting}
                />
              </label>
            </div>
            <p className="ticket-logwork-modal__hint">
              {initialEstimateHours != null
                ? `Estimate hiện tại: ${initialEstimateHours}h — sửa số nếu cần cập nhật.`
                : 'Chưa có estimate — nhập số giờ để thêm khi ghi log.'}
            </p>

            <div className="ticket-logwork-modal__field ticket-logwork-modal__field--comment">
              <div className="ticket-logwork-modal__comment-head">
                <span className="ticket-logwork-modal__label">Mô tả / comment</span>
                <button
                  type="button"
                  className="ticket-logwork-modal__ai-btn"
                  onClick={() => void handleAiComment()}
                  disabled={submitting || generatingAi}
                >
                  {generatingAi ? <Loader2 size={12} className="spinner" /> : <Sparkles size={12} />}
                  {generatingAi ? 'Đang soạn...' : 'AI từ ticket'}
                </button>
              </div>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                className="ticket-field ticket-field--medium"
                disabled={submitting}
                placeholder="Mô tả công việc đã làm..."
              />
            </div>

            <div className="ticket-logwork-modal__footer">
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)} disabled={submitting}>
                Hủy
              </button>
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? <Loader2 size={14} className="spinner" /> : <Clock size={14} />}
                {isReplaceMode ? 'Cập nhật logwork' : 'Ghi logwork'}
              </button>
            </div>
          </form>
        </CommonModal>
      )}
    </>
  );
}
