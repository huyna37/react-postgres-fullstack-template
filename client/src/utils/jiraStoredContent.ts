import { adfToWiki, type AdfDoc } from './adfToWiki';

/** Mô tả/output đã lưu dạng ADF JSON (sync nguyên bản từ Jira). */
export function isStoredAdf(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; content?: unknown[] };
    return parsed?.type === 'doc' && Array.isArray(parsed.content);
  } catch {
    return false;
  }
}

/** Wiki để render UI — ADF trong DB được chuyển sang wiki tạm thời. */
export function storedContentToWiki(stored: string): string {
  if (!stored) return '';
  if (isStoredAdf(stored)) {
    try {
      return adfToWiki(JSON.parse(stored) as AdfDoc);
    } catch {
      return stored;
    }
  }
  return stored;
}
