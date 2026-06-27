import { CalendarClock, CheckCircle2, Clock, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  currentMonthYmd,
  defaultDateForMonth,
  formatDayLabel,
  WORKING_HOURS_PER_DAY,
  type DayLogTarget,
} from '../utils/personalOt';
import { showError, showSuccess } from '../utils/swal';

interface PersonalOtProps {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  API_BASE_URL: string;
}

type DraftRow = {
  date: string;
  hours: string;
};

export default function PersonalOt({ apiFetch, API_BASE_URL }: PersonalOtProps) {
  const [month, setMonth] = useState(currentMonthYmd);
  const [days, setDays] = useState<DayLogTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingDate, setSavingDate] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRow | null>(null);

  const loadDays = useCallback(async () => {
    const [year, mo] = month.split('-').map(Number);
    if (!year || !mo) return;
    setLoading(true);
    try {
      const qs = `year=${year}&month=${mo}&minHours=${WORKING_HOURS_PER_DAY}`;
      const res = await apiFetch(`${API_BASE_URL}/api/worklogs/personal-ot?${qs}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(typeof data.error === 'string' ? data.error : 'Không tải được OT cá nhân.');
        return;
      }
      setDays(Array.isArray(data.days) ? data.days : []);
    } catch {
      showError('Lỗi kết nối khi tải OT cá nhân.');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, API_BASE_URL, month]);

  useEffect(() => {
    void loadDays();
  }, [loadDays]);

  const saveOt = useCallback(
    async (date: string, rawHours: string, opts?: { silent?: boolean }) => {
      const hours = parseFloat(String(rawHours).replace(',', '.'));
      if (!Number.isFinite(hours) || hours < 0) {
        showError('Giờ OT phải >= 0.');
        return false;
      }
      if (hours <= 0) {
        // xóa entry
      } else if (hours > 24) {
        showError('Giờ OT tối đa 24h.');
        return false;
      }

      setSavingDate(date);
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/worklogs/personal-ot`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, otHours: hours }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError(typeof data.error === 'string' ? data.error : 'Không lưu được OT.');
          return false;
        }
        if (!opts?.silent) {
          if (hours <= 0) showSuccess('Đã xóa OT.');
          else showSuccess('Đã lưu OT.');
        }
        await loadDays();
        return true;
      } catch {
        showError('Lỗi kết nối khi lưu OT.');
        return false;
      } finally {
        setSavingDate(null);
      }
    },
    [apiFetch, API_BASE_URL, loadDays]
  );

  const startAdd = () => {
    setDraft({ date: defaultDateForMonth(month), hours: '' });
  };

  const saveDraft = async () => {
    if (!draft) return;
    const date = draft.date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      showError('Chọn ngày hợp lệ.');
      return;
    }
    if (!date.startsWith(month)) {
      showError(`Ngày phải thuộc tháng ${month}.`);
      return;
    }
    const hours = draft.hours.trim();
    if (!hours) {
      showError('Nhập số giờ OT.');
      return;
    }
    if (days.some(d => d.date === date)) {
      showError('Ngày này đã có trong bảng — sửa trực tiếp trên dòng đó.');
      return;
    }
    const ok = await saveOt(date, hours);
    if (ok) setDraft(null);
  };

  const deleteOt = async (date: string) => {
    await saveOt(date, '0');
  };

  const monthLabel = useMemo(() => {
    const [y, mo] = month.split('-').map(Number);
    if (!y || !mo) return month;
    return new Date(y, mo - 1, 1).toLocaleDateString('vi-VN', { month: 'long', year: 'numeric' });
  }, [month]);

  const stats = useMemo(() => {
    const totalOt = days.reduce((s, d) => s + (d.otHours || 0), 0);
    const missingDays = days.filter(d => d.missingHours > 0).length;
    const doneDays = days.filter(d => d.missingHours <= 0).length;
    return { totalOt: +totalOt.toFixed(1), missingDays, doneDays };
  }, [days]);

  return (
    <main className="glass-card personal-ot-page">
      <header className="personal-ot-page__head">
        <div className="personal-ot-page__intro">
          <h2 className="personal-ot-page__title">
            <span className="personal-ot-page__title-icon">
              <Clock size={20} />
            </span>
            Giờ OT cá nhân
          </h2>
          <p className="personal-ot-page__subtitle">
            Khai báo OT theo từng ngày. Mục tiêu logwork = {WORKING_HOURS_PER_DAY}h + OT — dùng trong{' '}
            <strong>Logwork tự động</strong> khi phân bổ giờ.
          </p>
        </div>
      </header>

      <div className="personal-ot-page__toolbar-bar">
        <div className="personal-ot-page__toolbar-left">
          <CalendarClock size={16} className="personal-ot-page__toolbar-icon" />
          <span className="personal-ot-page__toolbar-label">{monthLabel}</span>
          <input
            type="month"
            className="ticket-field ticket-field--compact personal-ot-page__month-input"
            value={month}
            onChange={e => {
              setMonth(e.target.value);
              setDraft(null);
            }}
            aria-label="Chọn tháng"
          />
          <button
            type="button"
            className="filter-btn personal-ot-page__icon-btn"
            onClick={() => void loadDays()}
            disabled={loading}
            title="Tải lại"
          >
            <RefreshCw size={15} className={loading ? 'spinner' : ''} />
          </button>
        </div>
        <button type="button" className="personal-ot-page__add-btn" onClick={startAdd}>
          <Plus size={15} strokeWidth={2.5} />
          Thêm OT
        </button>
      </div>

      {!loading && days.length > 0 ? (
        <div className="personal-ot-page__stats">
          <div className="personal-ot-page__stat">
            <span className="personal-ot-page__stat-label">Ngày khai báo</span>
            <strong className="personal-ot-page__stat-value">{days.length}</strong>
          </div>
          <div className="personal-ot-page__stat">
            <span className="personal-ot-page__stat-label">Tổng OT</span>
            <strong className="personal-ot-page__stat-value personal-ot-page__stat-value--violet">
              {stats.totalOt}h
            </strong>
          </div>
          <div className="personal-ot-page__stat">
            <span className="personal-ot-page__stat-label">Đủ mục tiêu</span>
            <strong className="personal-ot-page__stat-value personal-ot-page__stat-value--ok">
              {stats.doneDays}
            </strong>
          </div>
          <div className="personal-ot-page__stat">
            <span className="personal-ot-page__stat-label">Còn thiếu log</span>
            <strong
              className={`personal-ot-page__stat-value${stats.missingDays > 0 ? ' personal-ot-page__stat-value--warn' : ''}`}
            >
              {stats.missingDays}
            </strong>
          </div>
        </div>
      ) : null}

      <div className="personal-ot-page__content">
        {loading && days.length === 0 && !draft ? (
          <div className="personal-ot-page__loading">
            <Loader2 size={22} className="spinner" />
            <span>Đang tải dữ liệu…</span>
          </div>
        ) : days.length === 0 && !draft ? (
          <div className="personal-ot-page__empty">
            <div className="personal-ot-page__empty-icon">
              <Clock size={28} />
            </div>
            <h3>Chưa có OT trong {monthLabel}</h3>
            <p>Bấm <strong>Thêm OT</strong> để khai báo ngày làm thêm và số giờ tương ứng.</p>
            <button type="button" className="personal-ot-page__add-btn" onClick={startAdd}>
              <Plus size={15} strokeWidth={2.5} />
              Thêm OT đầu tiên
            </button>
          </div>
        ) : (
          <div className="personal-ot-page__table-wrap">
            <table className="personal-ot-page__table">
              <thead>
                <tr>
                  <th>Ngày</th>
                  <th>Đã log</th>
                  <th>OT</th>
                  <th>Mục tiêu</th>
                  <th>Trạng thái</th>
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {draft ? (
                  <tr className="personal-ot-page__draft">
                    <td>
                      <input
                        type="date"
                        className="ticket-field ticket-field--compact personal-ot-page__date-input"
                        value={draft.date}
                        onChange={e => setDraft(prev => (prev ? { ...prev, date: e.target.value } : prev))}
                      />
                    </td>
                    <td>
                      <span className="personal-ot-page__muted">—</span>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0.5}
                        max={24}
                        step={0.5}
                        className="ticket-field ticket-field--compact personal-ot-page__input"
                        value={draft.hours}
                        placeholder="5"
                        autoFocus
                        onChange={e => setDraft(prev => (prev ? { ...prev, hours: e.target.value } : prev))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void saveDraft();
                        }}
                      />
                    </td>
                    <td colSpan={2}>
                      <span className="personal-ot-page__formula">
                        {WORKING_HOURS_PER_DAY}h + OT = mục tiêu log
                      </span>
                    </td>
                    <td>
                      <div className="personal-ot-page__draft-actions">
                        <button
                          type="button"
                          className="personal-ot-page__mini-btn personal-ot-page__mini-btn--primary"
                          onClick={() => void saveDraft()}
                          disabled={savingDate != null}
                        >
                          Lưu
                        </button>
                        <button
                          type="button"
                          className="personal-ot-page__mini-btn"
                          onClick={() => setDraft(null)}
                          disabled={savingDate != null}
                        >
                          Hủy
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {days.map(day => (
                  <tr key={day.date}>
                    <td>
                      <span className="personal-ot-page__date">{formatDayLabel(day.date)}</span>
                    </td>
                    <td>
                      <span className="personal-ot-page__pill personal-ot-page__pill--log">
                        {day.loggedHours}h
                      </span>
                    </td>
                    <td>
                      <div className="personal-ot-page__ot-cell">
                        <input
                          key={`${day.date}-${day.otHours}`}
                          type="number"
                          min={0}
                          max={24}
                          step={0.5}
                          className="ticket-field ticket-field--compact personal-ot-page__input"
                          defaultValue={day.otHours}
                          disabled={savingDate === day.date}
                          onBlur={e => {
                            const v = e.target.value.trim();
                            const next = v === '' ? 0 : parseFloat(v.replace(',', '.'));
                            const prev = day.otHours || 0;
                            if (!Number.isFinite(next)) return;
                            if (Math.abs(next - prev) < 0.01) return;
                            void saveOt(day.date, v === '' ? '0' : v, { silent: true });
                          }}
                        />
                        <span className="personal-ot-page__unit">h</span>
                      </div>
                    </td>
                    <td>
                      <span className="personal-ot-page__formula">
                        <span className="personal-ot-page__formula-part">{day.baseHoursPerDay}h</span>
                        <span className="personal-ot-page__formula-plus">+</span>
                        <span className="personal-ot-page__formula-part personal-ot-page__formula-part--ot">
                          {day.otHours}h OT
                        </span>
                        <span className="personal-ot-page__formula-eq">=</span>
                        <strong className="personal-ot-page__formula-total">{day.requiredHours}h</strong>
                      </span>
                    </td>
                    <td>
                      {day.missingHours > 0 ? (
                        <span className="personal-ot-page__status personal-ot-page__status--warn">
                          −{day.missingHours}h
                        </span>
                      ) : (
                        <span className="personal-ot-page__status personal-ot-page__status--ok">
                          <CheckCircle2 size={13} />
                          Đủ
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="personal-ot-page__delete-btn"
                        title="Xóa OT"
                        disabled={savingDate === day.date}
                        onClick={() => void deleteOt(day.date)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
