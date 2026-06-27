import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Loader2, Radio, RefreshCw, Users } from 'lucide-react';
import { getAvatarUrl } from '../utils/avatar';
import type { User as AuthUser } from '../types';

type OnlineUserPage = {
  page: string;
  label: string;
  tabCount: number;
};

type OnlineUser = {
  userId: number;
  username: string | null;
  displayName: string | null;
  emailAddress: string | null;
  avatarUrl: string | null;
  appRole: string | null;
  tabCount: number;
  connectedAt: string | null;
  lastSeenAt: string | null;
  primaryPage: string | null;
  primaryPageLabel: string | null;
  pages: OnlineUserPage[];
};

type PresenceSnapshot = {
  users: OnlineUser[];
  onlineCount: number;
  updatedAt: string;
};

interface OnlineMonitorProps {
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  API_BASE_URL: string;
  currentUser: AuthUser | null;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s trước`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  return `${hr} giờ trước`;
}

function formatClock(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const OnlineMonitor: React.FC<OnlineMonitorProps> = ({ apiFetch, API_BASE_URL, currentUser }) => {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const sseRef = useRef<EventSource | null>(null);

  const fetchSnapshot = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/presence/online`);
      if (res.ok) {
        const data = await res.json();
        setSnapshot(data);
      }
    } catch (err) {
      console.error('Failed to fetch presence snapshot:', err);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, API_BASE_URL]);

  useEffect(() => {
    if (currentUser?.role !== 'admin') {
      setLoading(false);
      return;
    }

    const token = localStorage.getItem('token') || '';
    let reconnectTimer: number | null = null;

    const connect = () => {
      if (sseRef.current) return;
      const sse = new EventSource(`${API_BASE_URL}/api/presence/monitor/sse?token=${encodeURIComponent(token)}`);
      sseRef.current = sse;

      sse.addEventListener('presence', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data) as PresenceSnapshot;
          setSnapshot(data);
          setLoading(false);
        } catch (err) {
          console.error('Presence SSE parse error:', err);
        }
      });

      sse.onopen = () => setConnected(true);
      sse.onerror = () => {
        setConnected(false);
        sse.close();
        sseRef.current = null;
        reconnectTimer = window.setTimeout(connect, 4000);
      };
    };

    void fetchSnapshot();
    connect();

    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      sseRef.current?.close();
      sseRef.current = null;
    };
  }, [API_BASE_URL, currentUser?.role, fetchSnapshot]);

  const filteredUsers = useMemo(() => {
    const users = snapshot?.users || [];
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(u => {
      const pageLabels = (u.pages || []).map(p => p.label).join(' ');
      const hay = [u.displayName, u.username, u.emailAddress, u.appRole, u.primaryPageLabel, pageLabels]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [snapshot?.users, search]);

  if (currentUser?.role !== 'admin') {
    return (
      <main className="glass-card online-monitor-page">
        <p className="online-monitor-empty">Chỉ admin mới xem được màn hình này.</p>
      </main>
    );
  }

  return (
    <main className="glass-card online-monitor-page">
      <header className="online-monitor-header">
        <div>
          <h2 className="online-monitor-title">
            <Radio size={22} aria-hidden />
            Người đang online
          </h2>
          <p className="online-monitor-subtitle">
            Theo dõi realtime qua SSE — tab đang mở và trang hiện tại (cập nhật khi đổi menu).
          </p>
        </div>
        <div className="online-monitor-header__meta">
          <span className={`online-monitor-live${connected ? ' is-live' : ''}`}>
            <Circle size={8} aria-hidden />
            {connected ? 'Live SSE' : 'Đang kết nối…'}
          </span>
          <button type="button" className="admin-page-btn" onClick={() => void fetchSnapshot()} title="Làm mới">
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <div className="online-monitor-toolbar">
        <div className="online-monitor-stat">
          <Users size={16} aria-hidden />
          <strong>{snapshot?.onlineCount ?? 0}</strong>
          <span>đang online</span>
        </div>
        <input
          type="search"
          className="ticket-field online-monitor-search"
          placeholder="Tìm tên, email, username…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {snapshot?.updatedAt && (
          <span className="online-monitor-updated">Cập nhật: {formatClock(snapshot.updatedAt)}</span>
        )}
      </div>

      {loading && !snapshot ? (
        <div className="online-monitor-loading">
          <Loader2 className="spinner" size={24} />
          <span>Đang tải danh sách online…</span>
        </div>
      ) : filteredUsers.length === 0 ? (
        <p className="online-monitor-empty">
          {search.trim() ? 'Không có ai khớp tìm kiếm.' : 'Chưa có ai online (không có tab app đang mở).'}
        </p>
      ) : (
        <div className="online-monitor-grid">
          {filteredUsers.map(user => {
            const label = user.displayName || user.username || `User #${user.userId}`;
            const avatarSrc = user.avatarUrl ? getAvatarUrl(user.avatarUrl, API_BASE_URL) : null;
            return (
              <article key={user.userId} className="online-monitor-card">
                <div className="online-monitor-card__avatar">
                  {avatarSrc ? (
                    <img src={avatarSrc} alt="" />
                  ) : (
                    <span>{label.charAt(0).toUpperCase()}</span>
                  )}
                  <span className="online-monitor-card__dot" title="Online" />
                </div>
                <div className="online-monitor-card__body">
                  <strong className="online-monitor-card__name">{label}</strong>
                  {user.username && user.username !== label && (
                    <span className="online-monitor-card__username">@{user.username}</span>
                  )}
                  {user.emailAddress && (
                    <span className="online-monitor-card__email">{user.emailAddress}</span>
                  )}
                  {(user.primaryPageLabel || (user.pages?.length ?? 0) > 0) && (
                    <div className="online-monitor-card__pages">
                      {(user.pages?.length ? user.pages : user.primaryPageLabel ? [{ label: user.primaryPageLabel, tabCount: user.tabCount, page: user.primaryPage || '' }] : []).map(entry => (
                        <span key={entry.page || entry.label} className="online-monitor-page-chip" title={entry.page}>
                          {entry.label}
                          {entry.tabCount > 1 ? ` ×${entry.tabCount}` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="online-monitor-card__meta">
                    {user.appRole && <span className="online-monitor-role">{user.appRole}</span>}
                    <span>{user.tabCount} tab</span>
                    <span title={user.connectedAt || ''}>Vào {formatRelativeTime(user.connectedAt)}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
};

export default OnlineMonitor;
