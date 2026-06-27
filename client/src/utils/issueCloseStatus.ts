/** Ticket đã ở trạng thái cuối Closed/Đóng — không cần đóng thêm. Resolved/Done vẫn có thể close tiếp. */
export function isIssueFinallyClosed(status?: string | null): boolean {
  const name = String(status || '').trim().toLowerCase();
  if (!name) return false;
  if (/re-?open|mở lại|mo lai/.test(name)) return false;
  return (
    name === 'closed' ||
    name === 'đóng' ||
    name === 'close' ||
    name.includes('closed') ||
    name.includes('đóng') ||
    name.includes('dong')
  );
}

export function canCloseIssueForLogwork(wl: {
  status?: string | null;
  statusCategory?: string | null;
}): boolean {
  return !isIssueFinallyClosed(wl.status);
}
