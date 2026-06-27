import { useCallback, useEffect, useState } from 'react';
import type { User } from '../types';
import { hasJiraToken } from '../utils/jiraToken';
import { showError, showSuccess } from '../utils/swal';

export function useJiraTokenPrompt(
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>,
  API_BASE_URL: string,
  authToken: string,
  currentUser: User | null,
  setCurrentUser: (user: User | null) => void,
  activeTab: string
) {
  const [open, setOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authToken || activeTab === 'login') {
      setOpen(false);
      return;
    }
    setOpen(!hasJiraToken(currentUser));
  }, [authToken, currentUser, activeTab]);

  const saveToken = useCallback(async () => {
    const trimmed = tokenDraft.trim();
    if (!trimmed) {
      showError('Vui lòng nhập Jira Personal Access Token.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/me/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jira_token: trimmed,
          jira_project: currentUser?.jira_project || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showError(data.error || 'Lưu Jira Token thất bại.');
        return;
      }
      const updated: User = {
        ...currentUser!,
        jira_token: trimmed,
      };
      setCurrentUser(updated);
      localStorage.setItem('user', JSON.stringify(updated));
      setTokenDraft('');
      setOpen(false);
      showSuccess('Đã lưu Jira Token. Bạn có thể thao tác với Jira.');
    } catch {
      showError('Lỗi mạng khi lưu Jira Token.');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, API_BASE_URL, currentUser, setCurrentUser, tokenDraft]);

  return {
    open,
    tokenDraft,
    setTokenDraft,
    saving,
    saveToken,
  };
}
