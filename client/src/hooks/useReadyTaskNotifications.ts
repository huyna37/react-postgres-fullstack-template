import { useCallback, useEffect, useRef, useState } from 'react';
import { acquireNotifySse, releaseNotifySse } from '../lib/notifySseManager';

function generateUUID(): string {
  try {
    if (
      typeof window !== 'undefined' &&
      window.isSecureContext &&
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
  } catch {
    /* HTTP / trình duyệt cũ — dùng fallback bên dưới */
  }
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => {
    const num = Number(c);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return (num ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> num / 4).toString(16);
    }
    return (num ^ Math.random() * 16 >> num / 4).toString(16);
  });
}

function getPresenceTabId(): string {
  if (typeof window === 'undefined') return '_default';
  let id = sessionStorage.getItem('presenceTabId');
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem('presenceTabId', id);
  }
  return id;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

export function useReadyTaskNotifications(
  apiFetch: (url: string, options?: any) => Promise<Response>,
  API_BASE_URL: string,
  enabled: boolean,
  activeTab?: string
) {
  const presenceTabIdRef = useRef(getPresenceTabId());
  const lastReportedPageRef = useRef<string | null>(null);
  const [notifyPermission, setNotifyPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => {
    if (typeof window === 'undefined' || !('Notification' in window))
      return 'unsupported';
    return Notification.permission;
  });
  const [showNotifyPrompt, setShowNotifyPrompt] = useState(false);
  const notifySupported =
    typeof window !== 'undefined' && 'Notification' in window;

  // ── Sync permission state on window focus / visibility change ──────────────
  useEffect(() => {
    const syncPermission = () => {
      if ('Notification' in window) setNotifyPermission(Notification.permission);
    };
    window.addEventListener('focus', syncPermission);
    document.addEventListener('visibilitychange', syncPermission);
    return () => {
      window.removeEventListener('focus', syncPermission);
      document.removeEventListener('visibilitychange', syncPermission);
    };
  }, []);

  // ── Báo trang hiện tại (nhẹ — chỉ khi đổi menu, không reconnect SSE) ───────
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !activeTab || activeTab === 'login') {
      return;
    }
    if (lastReportedPageRef.current === activeTab) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (lastReportedPageRef.current === activeTab) return;
      lastReportedPageRef.current = activeTab;
      void apiFetch(`${API_BASE_URL}/api/presence/page`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: activeTab, tabId: presenceTabIdRef.current }),
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [enabled, activeTab, apiFetch, API_BASE_URL]);

  useEffect(() => {
    if (!enabled) {
      lastReportedPageRef.current = null;
    }
  }, [enabled]);

  // ── SSE presence + notifications (mọi tab đăng nhập) ───────────────────────
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    acquireNotifySse(API_BASE_URL, presenceTabIdRef.current);
    return () => releaseNotifySse();
  }, [enabled, API_BASE_URL]);

  // ── Web Push (chỉ khi user cho phép thông báo) ───────────────────────────
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || notifyPermission !== 'granted') {
      return;
    }

    const setupPush = async () => {
      const token = localStorage.getItem('token');

      if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
      }

      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        console.log('Service Worker registered with scope:', registration.scope);

        const vapidRes = await apiFetch(`${API_BASE_URL}/api/webpush/vapid-public-key`);
        if (!vapidRes.ok) throw new Error('Failed to fetch VAPID key');
        const vapidPublicKey = await vapidRes.text();

        const urlBase64ToUint8Array = (base64String: string) => {
          const padding = '='.repeat((4 - base64String.length % 4) % 4);
          const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
          const rawData = window.atob(base64);
          const outputArray = new Uint8Array(rawData.length);
          for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
          }
          return outputArray;
        };

        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });

        await apiFetch(`${API_BASE_URL}/api/webpush/subscribe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify(subscription)
        });
        console.log('Push subscription saved to server.');
      } catch (err) {
        console.error('Service Worker / Push setup failed:', err);
      }
    };

    void setupPush();
  }, [enabled, notifyPermission, apiFetch, API_BASE_URL]);

  const dismissNotifyPrompt = useCallback(() => {
    setShowNotifyPrompt(false);
  }, []);

  const confirmNotifyPermission = useCallback(() => {
    if (!notifySupported) return;
    if (Notification.permission !== 'default') {
      setNotifyPermission(Notification.permission);
      setShowNotifyPrompt(false);
      return;
    }

    Notification.requestPermission().then((result) => {
      setNotifyPermission(result);
      setShowNotifyPrompt(false);
    });
  }, [notifySupported]);

  const requestNotifyPermission = useCallback(() => {
    if (!notifySupported) {
      window.alert('Trình duyệt không hỗ trợ thông báo desktop.');
      return;
    }

    const current = Notification.permission;
    setNotifyPermission(current);

    if (current === 'granted') {
      return;
    }

    if (current === 'denied') {
      window.alert(
        'Thông báo đã bị chặn trước đó.\\n\\n' +
          'Chrome/Edge: biểu tượng ổ khóa cạnh URL → Site settings → Notifications → Allow.\\n' +
          'Sau đó tải lại trang và thử lại.'
      );
      return;
    }

    setShowNotifyPrompt(true);
  }, [notifySupported]);

  return {
    notifySupported,
    notifyEnabled: notifyPermission === 'granted',
    notifyPermission,
    requestNotifyPermission,
    showNotifyPrompt,
    confirmNotifyPermission,
    dismissNotifyPrompt,
  };
}
