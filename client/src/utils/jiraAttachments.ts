export type IssueAttachmentMeta = {
  filename: string;
  mimeType: string | null;
  size: number;
  hasThumbnail: boolean;
};

/** Trích tên file từ wiki Jira: !filename.png|thumbnail! */
export function extractWikiAttachmentFilenames(raw?: string | null): string[] {
  const text = String(raw ?? '');
  if (!text.includes('!')) return [];
  const names = new Set<string>();
  const re = /!([^!\n]+)!/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const filename = String(m[1] || '')
      .split('|')[0]
      .trim();
    if (filename) names.add(filename);
  }
  return [...names];
}

export function buildAttachmentProxyUrl(
  apiBaseUrl: string,
  issueKey: string,
  filename: string,
  variant: 'full' | 'thumb' = 'full'
) {
  const base = `${apiBaseUrl}/api/jira/issues/${encodeURIComponent(issueKey)}/attachments/${encodeURIComponent(filename)}`;
  const params = new URLSearchParams();
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  if (token) params.set('token', token);
  if (variant === 'thumb') params.set('variant', 'thumb');
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function isImageMimeType(mimeType: string | null | undefined) {
  return !!mimeType && mimeType.startsWith('image/');
}

export function formatAttachmentSize(bytes: number) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function fetchIssueAttachments(
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>,
  apiBaseUrl: string,
  issueKey: string
): Promise<IssueAttachmentMeta[]> {
  const res = await apiFetch(
    `${apiBaseUrl}/api/tickets/${encodeURIComponent(issueKey)}/attachments`
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || err.message || 'Không tải được danh sách đính kèm');
  }
  const data = await res.json();
  return Array.isArray(data.attachments) ? data.attachments : [];
}

