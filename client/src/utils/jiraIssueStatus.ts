export function isCancelledTicketStatus(status: string | undefined | null): boolean {
  const st = String(status || '').toLowerCase();
  return st.includes('cancel') || st.includes('hủy') || st.includes('huy');
}

export function filterDashboardUserGroups(users: any[]): any[] {
  if (!Array.isArray(users)) return [];
  return users.map(group => ({
    ...group,
    tickets: (group.tickets || []).filter(
      (t: { status?: string | null }) => !isCancelledTicketStatus(t.status)
    ),
  }));
}
