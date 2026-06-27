export type CommentSourceType = 'self' | 'parent' | 'sibling';

export type JiraCommentItem = {
  id?: string;
  created?: string;
  body?: unknown;
  author?: {
    displayName?: string;
    emailAddress?: string;
  };
  sourceKey?: string;
  sourceSummary?: string;
  sourceType?: CommentSourceType;
  sourceLabel?: string;
};

export function formatCommentBody(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null && 'type' in body) {
    return JSON.stringify(body);
  }
  return '';
}

export function commentAuthorInitials(name?: string): string {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatCommentDate(created?: string): string {
  if (!created) return '';
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
