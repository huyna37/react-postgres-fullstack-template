import React, { useEffect, useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { BarChart3, LineChart as LineChartIcon, Activity, CheckCircle2, Bug, Award, TrendingUp, Users } from 'lucide-react';
import type { User } from '../types';

interface ReportsProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  currentUser: User | null;
}

interface MemberStat {
  assignee: string;
  total_tasks: number;
  dev_tasks_done: number;
  test_tasks_done: number;
  assigned_bugs: number;
  bugs_created: number;
  fixed_bugs: number;
}

interface DailyStat {
  date: string;
  dev_tasks_done: number;
  test_tasks_done: number;
  fixed_bugs: number;
}

interface MemberDailyStat {
  date: string;
  assignee: string;
  dev_tasks_done: number;
  test_tasks_done: number;
  assigned_bugs: number;
  bugs_created: number;
  fixed_bugs: number;
}

function formatListDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}

function DevMemberDailyTable({
  title,
  hint,
  rows,
  emptyLabel,
}: {
  title: string;
  hint: string;
  rows: MemberDailyStat[];
  emptyLabel: string;
}) {
  const entries = useMemo(
    () =>
      rows
        .filter(
          row =>
            Number(row.dev_tasks_done || 0) > 0 ||
            Number(row.assigned_bugs || 0) > 0 ||
            Number(row.fixed_bugs || 0) > 0
        )
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) || a.assignee.localeCompare(b.assignee, 'vi')
        )
        .map(row => ({
          date: row.date,
          assignee: row.assignee,
          devCount: Number(row.dev_tasks_done || 0),
          bugsAssigned: Number(row.assigned_bugs || 0),
          bugsFixed: Number(row.fixed_bugs || 0),
        })),
    [rows]
  );

  if (entries.length === 0) {
    return (
      <div className="glass-card reports-member-daily__block">
        <h4 className="reports-member-daily__block-title">{title}</h4>
        <p className="reports-member-daily__block-hint">{hint}</p>
        <div className="reports-member-daily__empty">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className="glass-card reports-member-daily__block">
      <h4 className="reports-member-daily__block-title">{title}</h4>
      <p className="reports-member-daily__block-hint">{hint}</p>
      <div className="reports-member-daily__scroll">
        <table className="reports-member-daily__table reports-member-daily__table--list premium-table">
          <thead>
            <tr>
              <th>Ngày</th>
              <th>Thành viên</th>
              <th className="reports-member-daily__count-col">Sub-task Dev</th>
              <th className="reports-member-daily__count-col">Bug đã assign</th>
              <th className="reports-member-daily__count-col">Bug đã fix</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={`${entry.date}-${entry.assignee}`}>
                <td className="reports-member-daily__date">{formatListDate(entry.date)}</td>
                <td className="reports-member-daily__member">{entry.assignee}</td>
                <td className="reports-member-daily__count reports-member-daily__cell--dev">
                  {entry.devCount > 0 ? entry.devCount : '—'}
                </td>
                <td className="reports-member-daily__count reports-member-daily__cell--bug">
                  {entry.bugsAssigned > 0 ? entry.bugsAssigned : '—'}
                </td>
                <td className="reports-member-daily__count reports-member-daily__cell--bug-fixed">
                  {entry.bugsFixed > 0 ? entry.bugsFixed : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TesterMemberDailyTable({
  title,
  hint,
  rows,
  emptyLabel,
}: {
  title: string;
  hint: string;
  rows: MemberDailyStat[];
  emptyLabel: string;
}) {
  const entries = useMemo(
    () =>
      rows
        .filter(row => Number(row.test_tasks_done || 0) > 0 || Number(row.bugs_created || 0) > 0)
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) || a.assignee.localeCompare(b.assignee, 'vi')
        )
        .map(row => ({
          date: row.date,
          assignee: row.assignee,
          testCount: Number(row.test_tasks_done || 0),
          bugsCreated: Number(row.bugs_created || 0),
        })),
    [rows]
  );

  if (entries.length === 0) {
    return (
      <div className="glass-card reports-member-daily__block">
        <h4 className="reports-member-daily__block-title">{title}</h4>
        <p className="reports-member-daily__block-hint">{hint}</p>
        <div className="reports-member-daily__empty">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className="glass-card reports-member-daily__block">
      <h4 className="reports-member-daily__block-title">{title}</h4>
      <p className="reports-member-daily__block-hint">{hint}</p>
      <div className="reports-member-daily__scroll">
        <table className="reports-member-daily__table reports-member-daily__table--list premium-table">
          <thead>
            <tr>
              <th>Ngày</th>
              <th>Thành viên</th>
              <th className="reports-member-daily__count-col">Sub-task Test</th>
              <th className="reports-member-daily__count-col">Bug đã report</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={`${entry.date}-${entry.assignee}`}>
                <td className="reports-member-daily__date">{formatListDate(entry.date)}</td>
                <td className="reports-member-daily__member">{entry.assignee}</td>
                <td className="reports-member-daily__count reports-member-daily__cell--test">
                  {entry.testCount > 0 ? entry.testCount : '—'}
                </td>
                <td className="reports-member-daily__count reports-member-daily__cell--bug">
                  {entry.bugsCreated > 0 ? entry.bugsCreated : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type ChartTooltipEntry = {
  color?: string;
  name?: string;
  value?: number | string;
  dataKey?: string | number;
};

function ReportsChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="reports-chart-tooltip">
      {label ? <p className="reports-chart-tooltip__label">{label}</p> : null}
      <ul className="reports-chart-tooltip__list">
        {payload.map(entry => (
          <li key={String(entry.dataKey ?? entry.name)} className="reports-chart-tooltip__item">
            <span className="reports-chart-tooltip__name">
              <span
                className="reports-chart-tooltip__dot"
                style={{ backgroundColor: entry.color || 'var(--text-secondary)' }}
                aria-hidden
              />
              {entry.name}
            </span>
            <strong className="reports-chart-tooltip__value">{entry.value ?? 0}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Reports({ apiFetch, API_BASE_URL, currentUser }: ReportsProps) {
  const [loading, setLoading] = useState(false);
  const [memberStats, setMemberStats] = useState<MemberStat[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyStat[]>([]);
  const [memberDailyStats, setMemberDailyStats] = useState<MemberDailyStat[]>([]);

  const [activeProjects, setActiveProjects] = useState<{ jira_key: string; name: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');

  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });

  // Fetch active projects on mount
  useEffect(() => {
    let isMounted = true;
    apiFetch(`${API_BASE_URL}/api/projects/active`)
      .then(res => res.json())
      .then(data => {
        if (!isMounted) return;
        if (Array.isArray(data)) {
          setActiveProjects(data);
          if (data.length > 0) {
            const userProj = currentUser?.jira_project ? currentUser.jira_project.split(',')[0].trim() : '';
            const exists = data.some(p => p.jira_key === userProj);
            setSelectedProject(exists ? userProj : data[0].jira_key);
          }
        }
      })
      .catch(err => {
        console.error('Failed to fetch active projects', err);
      });
    return () => {
      isMounted = false;
    };
  }, [apiFetch, API_BASE_URL, currentUser]);

  useEffect(() => {
    if (!selectedProject) return;

    let isMounted = true;
    setLoading(true);

    const [year, month] = selectedMonth.split('-');

    apiFetch(`${API_BASE_URL}/api/reports?projectKey=${selectedProject}&month=${month}&year=${year}`)
      .then(res => res.json())
      .then(data => {
        if (!isMounted) return;
        if (data.success && data.data) {
          setMemberStats(data.data.memberStats || []);
          setDailyStats(data.data.dailyStats || []);
          setMemberDailyStats(data.data.memberDailyStats || []);
        } else {
          setMemberStats([]);
          setDailyStats([]);
          setMemberDailyStats([]);
        }
      })
      .catch(err => {
        console.error('Failed to fetch reports', err);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedProject, selectedMonth, apiFetch, API_BASE_URL]);

  const totalDevTasksCompleted = memberStats.reduce((sum, item) => sum + (item.dev_tasks_done || 0), 0);
  const totalTestTasksCompleted = memberStats.reduce((sum, item) => sum + (item.test_tasks_done || 0), 0);
  const totalBugsFixed = memberStats.reduce((sum, item) => sum + (item.fixed_bugs || 0), 0);

  const topBugReporter = useMemo(() => {
    if (memberStats.length === 0) return null;
    const sorted = [...memberStats].sort((a, b) => (b.bugs_created || 0) - (a.bugs_created || 0));
    const top = sorted[0];
    if (top && (top.bugs_created || 0) > 0) {
      return top;
    }
    return null;
  }, [memberStats]);

  const sortedByBugsCreated = useMemo(() => {
    return [...memberStats]
      .filter(item => (item.bugs_created || 0) > 0)
      .sort((a, b) => (b.bugs_created || 0) - (a.bugs_created || 0));
  }, [memberStats]);

  const sortedByTasks = useMemo(() => {
    return [...memberStats]
      .filter(item => (item.dev_tasks_done || 0) > 0 || (item.test_tasks_done || 0) > 0)
      .sort((a, b) => ((b.dev_tasks_done || 0) + (b.test_tasks_done || 0)) - ((a.dev_tasks_done || 0) + (a.test_tasks_done || 0)));
  }, [memberStats]);

  const [reportYear, reportMonth] = useMemo(() => {
    const [y, m] = selectedMonth.split('-').map(Number);
    return [y, m];
  }, [selectedMonth]);

  const pageShellStyle: React.CSSProperties = {
    padding: '1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    minHeight: 'calc(100vh - 1.5rem)',
    boxSizing: 'border-box',
  };

  const reportsHeader = (
    <div className="page-header-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
        <div
          style={{
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            padding: '7px',
            borderRadius: '8px',
            boxShadow: '0 2px 10px rgba(99, 102, 241, 0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Activity size={16} color="white" />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.3px' }}>
            Báo cáo thống kê
          </h2>
          <span className="page-header-subtitle">
            Tổng hợp tiến độ và hiệu suất công việc theo dự án
          </span>
        </div>
      </div>

      <div className="page-header-filters">
        <div className="page-header-filter page-header-filter--month">
          <label className="page-header-filter__label" htmlFor="reports-month-picker">
            Chọn tháng
          </label>
          <input
            id="reports-month-picker"
            type="month"
            className="premium-select premium-select--no-chevron page-header-filter__control"
            value={selectedMonth}
            onChange={e => setSelectedMonth(e.target.value)}
          />
        </div>
        <div className="page-header-filter page-header-filter--project">
          <label className="page-header-filter__label" htmlFor="reports-project-picker">
            Chọn dự án
          </label>
          <select
            id="reports-project-picker"
            className="premium-select page-header-filter__control"
            value={selectedProject}
            onChange={e => setSelectedProject(e.target.value)}
          >
            {activeProjects.map(p => (
              <option key={p.jira_key} value={p.jira_key} title={p.name}>
                {p.name} ({p.jira_key})
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );

  if (activeProjects.length === 0 && !loading) {
    return (
      <main className="glass-card dashboard-main reports-page" style={pageShellStyle}>
        {reportsHeader}
        <div className="page-body-pad" style={{ justifyContent: 'center', textAlign: 'center', paddingTop: '2rem' }}>
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            Không tìm thấy dự án hoạt động nào trong hệ thống. Vui lòng cấu hình dự án trong mục Cấu
            hình cá nhân.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="glass-card dashboard-main reports-page" style={pageShellStyle}>
      {reportsHeader}

      <div className="page-body-pad" style={{ gap: '1.5rem', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {loading ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Đang tải dữ liệu báo cáo...
        </div>
      ) : (
        <>
          {/* Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem' }}>
            <div className="glass-card stat-card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ background: 'rgba(59,130,246,0.1)', padding: '0.75rem', borderRadius: '10px' }}>
                <CheckCircle2 color="#3b82f6" size={24} />
              </div>
              <div>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Sub-task Dev xong</p>
                <h3 style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', color: '#3b82f6' }}>{totalDevTasksCompleted}</h3>
              </div>
            </div>

            <div className="glass-card stat-card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ background: 'rgba(16,185,129,0.1)', padding: '0.75rem', borderRadius: '10px' }}>
                <CheckCircle2 color="#10b981" size={24} />
              </div>
              <div>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Sub-task Test xong</p>
                <h3 style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', color: '#10b981' }}>{totalTestTasksCompleted}</h3>
              </div>
            </div>

            <div className="glass-card stat-card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ background: 'rgba(239,68,68,0.1)', padding: '0.75rem', borderRadius: '10px' }}>
                <Bug color="#ef4444" size={24} />
              </div>
              <div>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Bug đã xử lý</p>
                <h3 style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', color: '#ef4444' }}>{totalBugsFixed}</h3>
              </div>
            </div>

            <div className="glass-card stat-card" style={{ padding: '1.25rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{ background: 'rgba(239,68,68,0.1)', padding: '0.75rem', borderRadius: '10px' }}>
                <Award color="#f59e0b" size={24} />
              </div>
              <div>
                <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Tester tạo bug nhiều nhất</p>
                <h3 style={{ margin: '0.25rem 0 0', fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '170px' }} title={topBugReporter ? topBugReporter.assignee : undefined}>
                  {topBugReporter ? topBugReporter.assignee : 'N/A'}
                </h3>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {topBugReporter ? (
                    <>Tạo <strong>{topBugReporter.bugs_created}</strong> bug</>
                  ) : (
                    'Chưa có bug được tạo'
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Charts Area */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
            
            {/* Daily Stats Chart */}
            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h3 style={{ margin: '0 0 1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                <LineChartIcon size={16} color="var(--primary-color)" /> Tiến độ xử lý hàng ngày (Trong tháng {selectedMonth.split('-')[1]})
              </h3>
              <div style={{ height: '300px', width: '100%' }}>
                {dailyStats.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={dailyStats} margin={{ top: 5, right: 20, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis dataKey="date" stroke="var(--text-secondary)" fontSize={12} tickMargin={10} />
                      <YAxis stroke="var(--text-secondary)" fontSize={12} allowDecimals={false} />
                      <Tooltip
                        content={<ReportsChartTooltip />}
                        cursor={{ stroke: 'var(--border-color)', strokeWidth: 1, strokeDasharray: '4 4' }}
                        wrapperStyle={{ outline: 'none', zIndex: 20 }}
                      />
                      <Legend wrapperStyle={{ paddingTop: '20px' }} />
                      <Line type="monotone" dataKey="dev_tasks_done" name="Sub-task Dev" stroke="#3b82f6" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                      <Line type="monotone" dataKey="test_tasks_done" name="Sub-task Test" stroke="#10b981" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                      <Line type="monotone" dataKey="fixed_bugs" name="Bug đã fix" stroke="#ef4444" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                    Chưa có dữ liệu xử lý trong tháng này
                  </div>
                )}
              </div>
            </div>

            {/* Member Stats Chart */}
            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h3 style={{ margin: '0 0 1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem' }}>
                <BarChart3 size={16} color="var(--primary-color)" /> Đóng góp theo thành viên
              </h3>
              <div style={{ height: '350px', width: '100%' }}>
                {memberStats.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={memberStats} margin={{ top: 5, right: 20, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                      <XAxis 
                        dataKey="assignee" 
                        stroke="var(--text-secondary)" 
                        fontSize={12} 
                        tickMargin={10} 
                        interval={0}
                        angle={-45}
                        textAnchor="end"
                        height={70}
                      />
                      <YAxis stroke="var(--text-secondary)" fontSize={12} allowDecimals={false} />
                      <Tooltip
                        content={<ReportsChartTooltip />}
                        cursor={{ fill: 'rgba(148, 163, 184, 0.14)' }}
                        wrapperStyle={{ outline: 'none', zIndex: 20 }}
                      />
                      <Legend wrapperStyle={{ paddingTop: '20px' }} />
                      <Bar dataKey="dev_tasks_done" name="Sub-task Dev" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="test_tasks_done" name="Sub-task Test" fill="#10b981" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="fixed_bugs" name="Bug đã fix" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
                    Chưa có dữ liệu thành viên
                  </div>
                )}
              </div>
            </div>

          </div>

          {/* Detailed Leaderboards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.5rem' }}>
            {/* Task Completion Leaderboard */}
            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h3 style={{ margin: '0 0 1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem', fontWeight: 600 }}>
                <TrendingUp size={16} color="#10b981" /> Bảng xếp hạng hoàn thành task
              </h3>
              <div style={{ overflowX: 'auto' }}>
                {sortedByTasks.length > 0 ? (
                  <table className="premium-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                        <th style={{ padding: '0.6rem 0.5rem' }}>Hạng</th>
                        <th style={{ padding: '0.6rem 0.5rem' }}>Thành viên</th>
                        <th style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}>Dev Xong</th>
                        <th style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}>Test Xong</th>
                        <th style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}>Tổng cộng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedByTasks.map((item, index) => {
                        const totalDone = (item.dev_tasks_done || 0) + (item.test_tasks_done || 0);
                        return (
                          <tr key={item.assignee} style={{ borderBottom: '1px solid var(--border-color)', height: '40px' }}>
                            <td style={{ padding: '0.5rem', fontWeight: 600, color: index === 0 ? '#eab308' : index === 1 ? '#94a3b8' : index === 2 ? '#b45309' : 'var(--text-secondary)' }}>
                              #{index + 1}
                            </td>
                            <td style={{ padding: '0.5rem', fontWeight: 500 }}>{item.assignee}</td>
                            <td style={{ padding: '0.5rem', textAlign: 'center', color: '#3b82f6', fontWeight: 600 }}>{item.dev_tasks_done}</td>
                            <td style={{ padding: '0.5rem', textAlign: 'center', color: '#10b981', fontWeight: 600 }}>{item.test_tasks_done}</td>
                            <td style={{ padding: '0.5rem', textAlign: 'center', fontWeight: 600 }}>{totalDone}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Chưa có dữ liệu xếp hạng task
                  </div>
                )}
              </div>
            </div>

            {/* Bugs Leaderboard */}
            <div className="glass-card" style={{ padding: '1.25rem' }}>
              <h3 style={{ margin: '0 0 1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.95rem', fontWeight: 600 }}>
                <Bug size={16} color="#ef4444" /> Bug tester đã tạo (người report)
              </h3>
              <div style={{ overflowX: 'auto' }}>
                {sortedByBugsCreated.length > 0 ? (
                  <table className="premium-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left', color: 'var(--text-secondary)' }}>
                        <th style={{ padding: '0.6rem 0.5rem' }}>Hạng</th>
                        <th style={{ padding: '0.6rem 0.5rem' }}>Tester</th>
                        <th style={{ padding: '0.6rem 0.5rem', textAlign: 'center' }}>Bug đã tạo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedByBugsCreated.map((item, index) => (
                          <tr key={item.assignee} style={{ borderBottom: '1px solid var(--border-color)', height: '40px' }}>
                            <td style={{ padding: '0.5rem', fontWeight: 600, color: index === 0 ? '#ef4444' : 'var(--text-secondary)' }}>
                              #{index + 1}
                            </td>
                            <td style={{ padding: '0.5rem', fontWeight: 500 }}>{item.assignee}</td>
                            <td style={{ padding: '0.5rem', textAlign: 'center', color: '#ef4444', fontWeight: 600 }}>{item.bugs_created}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Chưa có dữ liệu bug tester tạo
                  </div>
                )}
              </div>
            </div>
          </div>

          <section className="reports-member-daily">
            <div>
              <h3 className="reports-member-daily__title">
                <Users size={17} color="var(--primary-color)" />
                Chi tiết theo ngày trong tháng {reportMonth}/{reportYear}
              </h3>
              <p className="reports-member-daily__subtitle">
                Sub-task hoàn thành theo ngày và người gán — Dev và Tester tách riêng.
              </p>
            </div>

            <div className="reports-member-daily__grid">
              <DevMemberDailyTable
                title="Developer"
                hint="Sub-task [DEV] hoàn thành, bug được gán và bug đã xử lý theo ngày."
                rows={memberDailyStats}
                emptyLabel="Chưa có dữ liệu Dev trong tháng này."
              />

              <TesterMemberDailyTable
                title="Tester"
                hint="Sub-task [TEST] hoàn thành và bug do tester tạo (người report) theo ngày."
                rows={memberDailyStats}
                emptyLabel="Chưa có dữ liệu Tester trong tháng này."
              />
            </div>
          </section>
        </>
      )}
      </div>
    </main>
  );
}
