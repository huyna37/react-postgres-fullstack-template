/** Snapshot nhẹ để so sánh — tránh setState/re-render khi poll trả về dữ liệu giống hệt (ảnh avatar bị load lại). */

const jsonEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function snapshotDashboardGroups(groups: any[]): unknown {
  return (groups || []).map(g => ({
    u: g.user?.accountId ?? null,
    avatar: g.user?.avatarUrl ?? null,
    name: g.user?.displayName ?? null,
    tickets: (g.tickets || []).map((t: any) => ({
      key: t.key,
      status: t.status,
      cat: t.statusCategory,
      summary: t.summary,
      updated: t.updated ?? null,
      spent: t.timeSpent ?? 0,
      spentW: t.timeSpentWeek ?? 0,
      est: t.originalEstimate ?? 0,
      start: t.startDate ?? null,
      due: t.dueDate ?? null,
      assignee: t.assignee?.accountId ?? t.assignee?.emailAddress ?? null,
      subs: (t.subTasks || []).map((s: any) => ({
        key: s.key,
        status: s.status,
        cat: s.statusCategory,
        summary: s.summary,
        updated: s.updated ?? null,
        spent: s.timeSpent ?? 0,
        est: s.originalEstimate ?? 0,
      })),
    })),
  }));
}

export function snapshotTesterIssues(issues: any[]): unknown {
  return (issues || []).map(t => ({
    key: t.key,
    id: t.id ?? null,
    status: t.status,
    cat: t.statusCategory,
    summary: t.summary,
    type: t.issueType,
    updated: t.updated ?? null,
    assignee: t.assignee?.accountId ?? t.assignee?.emailAddress ?? null,
    creator: t.creator ?? null,
    synth: !!t.isSynthesized,
    est: t.originalEstimate ?? 0,
    attach: t.attachmentCount ?? 0,
    comments: t.commentCount ?? 0,
    subs: (t.subTasks || []).map((s: any) => ({
      key: s.key,
      status: s.status,
      cat: s.statusCategory,
      summary: s.summary,
      type: s.issueType,
      updated: s.updated ?? null,
      assignee: s.assignee?.accountId ?? s.assignee?.emailAddress ?? null,
    })),
  }));
}

export function isSameDashboardGroups(prev: any[], next: any[]): boolean {
  return jsonEqual(snapshotDashboardGroups(prev), snapshotDashboardGroups(next));
}

export function isSameTesterIssues(prev: any[], next: any[]): boolean {
  return jsonEqual(snapshotTesterIssues(prev), snapshotTesterIssues(next));
}
