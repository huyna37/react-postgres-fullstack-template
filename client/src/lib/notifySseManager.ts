/**
 * Một EventSource / tab trình duyệt.
 * Teardown trễ để sống sót React StrictMode remount (dev).
 */

import { showToast } from '../utils/swal';

const SSE_TEARDOWN_MS = 100;
const SSE_RECONNECT_MS = 5000;

type NotifySseState = {
  source: EventSource | null;
  url: string | null;
  apiBaseUrl: string | null;
  tabId: string | null;
  subscribers: number;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
};

const state: NotifySseState = {
  source: null,
  url: null,
  apiBaseUrl: null,
  tabId: null,
  subscribers: 0,
  teardownTimer: null,
  reconnectTimer: null,
};

function buildNotifySseUrl(apiBaseUrl: string, tabId: string): string {
  const token = localStorage.getItem('token') || '';
  const pathPage = window.location.pathname.replace(/^\//, '').split('/')[0] || 'dashboard';
  const connectPage = pathPage === 'login' ? 'dashboard' : pathPage;
  const params = new URLSearchParams({ token, tabId, page: connectPage });
  return `${apiBaseUrl}/api/webpush/sse?${params}`;
}

const NOTIFY_TAB_DEDUP_MS = 5000;

/** Chỉ một tab hiển thị desktop notify — tránh 2 tab cùng nhận SSE. */
function shouldShowDesktopNotify(tag: string): boolean {
  try {
    const key = `notify-dedup:${tag}`;
    const now = Date.now();
    const prev = Number(localStorage.getItem(key) || '0');
    if (prev && now - prev < NOTIFY_TAB_DEDUP_MS) return false;
    localStorage.setItem(key, String(now));
    return true;
  } catch {
    return true;
  }
}

function handleSseMessage(event: MessageEvent) {
  try {
    const data = JSON.parse(event.data);
    
    if (data.type === 'FORCE_REFRESH') {
      window.location.reload();
      return;
    }

    if (Notification.permission === 'granted') {
      const tag = data.url || `${data.title}|${data.body || ''}`;
      if (!shouldShowDesktopNotify(tag)) return;
      const notification = new Notification(data.title, { body: data.body, icon: data.icon, tag });
      if (data.url) {
        notification.onclick = () => window.open(data.url, '_blank');
      }
    }
  } catch (e) {
    console.error('[Notify] SSE parse error:', e);
  }
}

function closeNotifySse() {
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.source?.close();
  state.source = null;
  state.url = null;
}

function scheduleReconnect() {
  if (state.reconnectTimer || state.subscribers === 0) return;
  if (!state.apiBaseUrl || !state.tabId) return;

  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (state.subscribers > 0 && state.apiBaseUrl && state.tabId) {
      openNotifySse(state.apiBaseUrl, state.tabId);
    }
  }, SSE_RECONNECT_MS);
}

function openNotifySse(apiBaseUrl: string, tabId: string) {
  const url = buildNotifySseUrl(apiBaseUrl, tabId);
  if (
    state.source &&
    state.url === url &&
    state.source.readyState !== EventSource.CLOSED
  ) {
    return;
  }

  closeNotifySse();

  if (import.meta.env.DEV) {
    console.log('[Notify] SSE connecting (tab open)...');
  }

  const source = new EventSource(url);
  source.onmessage = handleSseMessage;
  source.onerror = () => {
    if (import.meta.env.DEV) {
      console.warn('[Notify] SSE error — reconnect in 5s');
    }
    source.close();
    if (state.source === source) {
      state.source = null;
      state.url = null;
    }
    scheduleReconnect();
  };

  state.source = source;
  state.url = url;
  state.apiBaseUrl = apiBaseUrl;
  state.tabId = tabId;
}

export function acquireNotifySse(apiBaseUrl: string, tabId: string) {
  if (state.teardownTimer) {
    window.clearTimeout(state.teardownTimer);
    state.teardownTimer = null;
  }
  state.subscribers += 1;
  state.apiBaseUrl = apiBaseUrl;
  state.tabId = tabId;
  openNotifySse(apiBaseUrl, tabId);
}

export function releaseNotifySse() {
  state.subscribers = Math.max(0, state.subscribers - 1);
  if (state.subscribers > 0) return;

  if (state.teardownTimer) window.clearTimeout(state.teardownTimer);
  state.teardownTimer = window.setTimeout(() => {
    state.teardownTimer = null;
    if (state.subscribers === 0) {
      closeNotifySse();
      state.apiBaseUrl = null;
      state.tabId = null;
    }
  }, SSE_TEARDOWN_MS);
}
