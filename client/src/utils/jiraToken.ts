import { DEFAULT_PUBLIC_PAGES } from '../constants/menus';
import type { User } from '../types';

export const MISSING_JIRA_TOKEN_HINT =
  'Cần cấu hình Jira Token cá nhân (mục Cấu hình cá nhân) để thao tác với Jira.';

/** Tab / quyền được phép logwork hoặc chuyển trạng thái ticket trên Jira. */
const JIRA_TICKET_ACTION_PERMS = [
  'update_ticket',
  'dashboard',
  'tester-tasks',
  'overdue-tasks',
  'planning',
  'epics',
  'missing-estimates',
] as const;

const PUBLIC_JIRA_ACTION_PAGES = new Set<string>(
  DEFAULT_PUBLIC_PAGES.filter(p => (JIRA_TICKET_ACTION_PERMS as readonly string[]).includes(p))
);

export function hasJiraToken(user: User | null | undefined): boolean {
  return !!user?.jira_token && String(user.jira_token).trim() !== '';
}

function hasJiraTicketActionPerm(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const perms = user.permissions || [];
  return JIRA_TICKET_ACTION_PERMS.some(p => perms.includes(p));
}

/** Sửa mô tả / output — admin hoặc quyền update_ticket. */
export function canUpdateTicket(user: User | null | undefined): boolean {
  if (!user || !hasJiraToken(user)) return false;
  return user.role === 'admin' || !!user.permissions?.includes('update_ticket');
}

/** Logwork — có token Jira + quyền tab liên quan. */
export function canLogworkTicket(user: User | null | undefined): boolean {
  if (!hasJiraToken(user)) return false;
  return hasJiraTicketActionPerm(user);
}

/** Chuyển trạng thái — có token Jira + quyền tab liên quan (không chỉ admin). */
export function canTransitionTicket(user: User | null | undefined): boolean {
  if (!hasJiraToken(user)) return false;
  return hasJiraTicketActionPerm(user);
}

/** Tạo sub-task/bug trên story — có token Jira + quyền tab hoặc trang public (vd. tester-tasks). */
export function canCreateChildTicket(
  user: User | null | undefined,
  pageKey?: string
): boolean {
  if (!hasJiraToken(user)) return false;
  if (hasJiraTicketActionPerm(user)) return true;
  return !!(pageKey && PUBLIC_JIRA_ACTION_PAGES.has(pageKey));
}
