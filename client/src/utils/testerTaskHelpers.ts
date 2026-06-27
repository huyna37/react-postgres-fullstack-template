import { WORK_TZ, ymdInTimeZone } from './planDates';

function normalizeStatusName(status?: string | null) {
  return String(status || '').trim().toLowerCase();
}

/** Xong: Done / Resolved / Closed / Đóng / Hoàn thành. Chưa xong: Open, In Progress, ReOpen… */
export const isDevTaskDone = (sub: any) => {
  if (!sub) return false;
  const name = normalizeStatusName(sub.status);

  if (name && (name.includes('reopen') || name.includes('re-open') || name.includes('mở lại'))) {
    return false;
  }

  const cat = sub.statusCategory?.toLowerCase();
  if (cat === 'done') return true;
  if (!name) return false;

  return (
    name.includes('resolved') ||
    name.includes('closed') ||
    name === 'close' ||
    name.includes('đóng') ||
    name.includes('dong') ||
    name.includes('done') ||
    name.includes('hoàn thành') ||
    name.includes('hoan thanh') ||
    name.includes('complete')
  );
};

export const isDevTaskInProgress = (sub: any) => {
  if (!sub) return false;
  const cat = sub.statusCategory?.toLowerCase();
  const name = sub.status?.toLowerCase();
  return (
    cat === 'indeterminate' ||
    name?.includes('progress') ||
    name?.includes('testing') ||
    name?.includes('triển khai')
  );
};

export const isTestTask = (sub: any) => {
  if (!sub) return false;
  return sub.assignee?.role === 'tester';
};

export const isBugSubtask = (sub: any) => {
  if (!sub) return false;
  const type = sub.issueType?.toLowerCase() || '';
  return type.includes('bug') || type.includes('lỗi');
};

/** Sub-task DEV — không phải TEST/Bug. */
export const isDevSubtask = (sub: any) => {
  if (!sub || isBugSubtask(sub) || isTestTask(sub)) return false;
  return true;
};

export const isBugIssue = (issue: any) => {
  if (!issue) return false;
  const type = issue.issueType?.toLowerCase() || '';
  return type.includes('bug') || type.includes('lỗi') || isBugSubtask(issue);
};

/** Story/task còn sub-task [DEV] chưa xong. */
export const isStoryDevIncomplete = (task: any) => {
  if (!task) return false;
  const devSubs = storyDevSubs(task);
  if (devSubs.length > 0) {
    return devSubs.some((s: any) => !isDevTaskDone(s));
  }
  if (isBugIssue(task)) return false;
  return !isDevTaskDone(task);
};

/** Story/task (không tính bug) đã xong phần DEV. */
export const isStoryDevComplete = (task: any) => {
  if (!task || isBugIssue(task)) return false;
  return !isStoryDevIncomplete(task);
};

function storyDevSubs(task: any) {
  return (task.subTasks || []).filter((s: any) => isDevSubtask(s));
}

function storyTestSubs(task: any) {
  return (task.subTasks || []).filter((s: any) => isTestTask(s));
}

/** Toàn bộ sub DEV (không TEST/Bug) đã xong — hoặc story không có sub DEV. */
export function isAllStoryDevDone(task: any) {
  if (!task) return false;
  const devSubs = storyDevSubs(task);
  if (devSubs.length > 0) return devSubs.every((s: any) => isDevTaskDone(s));
  if (isBugIssue(task)) return false;
  return isDevTaskDone(task);
}

function isAllStoryTestDone(task: any) {
  const testSubs = storyTestSubs(task);
  if (testSubs.length === 0) return false;
  return testSubs.every((s: any) => isDevTaskDone(s));
}

function isStoryTestActive(task: any) {
  const testSubs = storyTestSubs(task);
  if (testSubs.length === 0) return false;
  return testSubs.some((s: any) => isDevTaskInProgress(s));
}

/** Đủ điều kiện test: DEV xong + có sub TEST + TEST chưa xong + chưa đang test. */
export function isStoryReadyToTest(task: any) {
  if (!task || isBugIssue(task)) return false;
  if (task.statusCategory?.toLowerCase() === 'done') return false;
  if (!isAllStoryDevDone(task)) return false;
  if (storyTestSubs(task).length === 0) return false;
  if (isAllStoryTestDone(task)) return false;
  if (isStoryTestActive(task)) return false;
  return true;
}

/** Đang test: DEV xong + có sub TEST chưa xong + có sub TEST in progress. */
export function isStoryUnderTest(task: any) {
  if (!task || isBugIssue(task)) return false;
  if (task.statusCategory?.toLowerCase() === 'done') return false;
  if (!isAllStoryDevDone(task)) return false;
  if (storyTestSubs(task).length === 0) return false;
  if (isAllStoryTestDone(task)) return false;
  return isStoryTestActive(task);
}

/** Story đã xong phía test (story Done hoặc mọi sub TEST Done). */
export function isStoryTestVerifiedDone(task: any) {
  if (!task) return false;
  if (task.statusCategory?.toLowerCase() === 'done') return true;
  return isAllStoryTestDone(task);
}

/** DEV xong nhưng chưa có sub-task TEST. */
export function isStoryDevDoneNoTestSub(task: any) {
  if (!task || isBugIssue(task)) return false;
  if (task.statusCategory?.toLowerCase() === 'done') return false;
  if (!isAllStoryDevDone(task)) return false;
  return storyTestSubs(task).length === 0;
}

export type StoryTestBucket = 'no-test-sub' | 'all-test-done' | 'open-test';

/** Phân loại story theo sub TEST — mỗi story thuộc đúng một nhóm (bỏ qua bug). */
export function classifyStoryTestBucket(task: any): StoryTestBucket | null {
  if (!task || isBugIssue(task)) return null;
  const testSubs = storyTestSubs(task).filter((s: any) => !isCancelledStatus(s.status));
  if (testSubs.length === 0) return 'no-test-sub';
  if (testSubs.every((s: any) => isDevTaskDone(s))) return 'all-test-done';
  return 'open-test';
}

/** DEV xong, TEST chưa xong — gồm chờ test, đang test, hoặc chưa có sub TEST. */
export const isStoryDevDoneTestIncomplete = (task: any) => {
  if (isStoryDevDoneNoTestSub(task)) return true;
  if (!task || isBugIssue(task)) return false;
  if (task.statusCategory?.toLowerCase() === 'done') return false;
  if (!isAllStoryDevDone(task)) return false;
  return storyTestSubs(task).some((s: any) => !isDevTaskDone(s));
};

function isCancelledStatus(status: string | undefined | null) {
  const st = String(status || '').toLowerCase();
  return st.includes('cancel') || st.includes('hủy') || st.includes('huy');
}

/** Khi filter nhân sự — chỉ tính ticket/sub assign cho email đó. */
export function assigneeEmailMatches(assignee: any, filterEmail?: string | null) {
  if (!filterEmail) return true;
  const filter = filterEmail.toLowerCase();
  const email = assignee?.emailAddress?.toLowerCase();
  const accountId = assignee?.accountId?.toLowerCase();
  return email === filter || accountId === filter;
}

/**
 * Story (không bug) có sub DEV và còn ít nhất 1 sub DEV chưa xong.
 * Không đếm story không có sub DEV; khi filter nhân sự chỉ xét sub DEV của người đó.
 */
export function isStoryWithIncompleteDevSubs(task: any, assigneeEmail?: string | null) {
  if (!task || isBugIssue(task)) return false;
  const devSubs = storyDevSubs(task).filter((s: any) =>
    assigneeEmailMatches(s.assignee, assigneeEmail)
  );
  if (devSubs.length === 0) return false;
  return devSubs.some((s: any) => !isDevTaskDone(s) && !isCancelledStatus(s.status));
}

/** Sub DEV của một nhân sự trong story — tất cả đã xong. */
export function isAssigneeDevWorkComplete(task: any, assigneeEmail: string) {
  if (!task || isBugIssue(task)) return false;
  const mine = storyDevSubs(task).filter((s: any) => assigneeEmailMatches(s.assignee, assigneeEmail));
  if (mine.length === 0) return false;
  return mine.every((s: any) => isDevTaskDone(s) || isCancelledStatus(s.status));
}

/** Tổng bug trên story (sub-task bug + story bug), mọi trạng thái. */
export const countAllBugsInTask = (task: any, assigneeEmail?: string | null) => {
  if (!task) return 0;
  let count = 0;
  if (
    isBugIssue(task) &&
    !isCancelledStatus(task.status) &&
    assigneeEmailMatches(task.assignee, assigneeEmail)
  ) {
    count++;
  }
  for (const sub of task.subTasks || []) {
    if (
      isBugSubtask(sub) &&
      !isCancelledStatus(sub.status) &&
      assigneeEmailMatches(sub.assignee, assigneeEmail)
    ) {
      count++;
    }
  }
  return count;
};

function issueUpdatedYmdBangkok(issue: { updated?: string | null }) {
  if (!issue?.updated) return null;
  const d = new Date(issue.updated);
  if (Number.isNaN(d.getTime())) return null;
  return ymdInTimeZone(d, WORK_TZ);
}

/** Sub-task DEV hoàn thành hôm nay (Bangkok) — theo updated_at khi status Done/Resolved/Closed. */
export const countDevSubsDoneTodayInTask = (
  task: any,
  assigneeEmail?: string | null,
  now = new Date()
) => {
  if (!task || isBugIssue(task)) return 0;
  const todayYmd = ymdInTimeZone(now, WORK_TZ);
  return storyDevSubs(task).filter((s: any) => {
    if (!isDevTaskDone(s) || isCancelledStatus(s.status)) return false;
    if (!assigneeEmailMatches(s.assignee, assigneeEmail)) return false;
    const ymd = issueUpdatedYmdBangkok(s);
    return ymd !== null && ymd === todayYmd;
  }).length;
};

/** Đếm sub-task DEV trong story chưa hoàn thành (không bug, không story parent). */
export const countOpenDevSubsInTask = (task: any, assigneeEmail?: string | null) => {
  if (!task || isBugIssue(task)) return 0;
  return storyDevSubs(task).filter(
    (s: any) =>
      !isDevTaskDone(s) &&
      !isCancelledStatus(s.status) &&
      assigneeEmailMatches(s.assignee, assigneeEmail)
  ).length;
};

/** Đếm bug chưa xong trên story (sub-task bug + story bug). */
export const countOpenBugsInTask = (task: any, assigneeEmail?: string | null) => {
  if (!task) return 0;
  let count = 0;
  if (
    isBugIssue(task) &&
    !isDevTaskDone(task) &&
    !isCancelledStatus(task.status) &&
    assigneeEmailMatches(task.assignee, assigneeEmail)
  ) {
    count++;
  }
  for (const sub of task.subTasks || []) {
    if (
      isBugSubtask(sub) &&
      !isDevTaskDone(sub) &&
      !isCancelledStatus(sub.status) &&
      assigneeEmailMatches(sub.assignee, assigneeEmail)
    ) {
      count++;
    }
  }
  return count;
};

/** Đếm bug đã đóng/xong trên story (sub-task bug + story bug). */
export const countClosedBugsInTask = (task: any, assigneeEmail?: string | null) => {
  if (!task) return 0;
  let count = 0;
  if (
    isBugIssue(task) &&
    isDevTaskDone(task) &&
    !isCancelledStatus(task.status) &&
    assigneeEmailMatches(task.assignee, assigneeEmail)
  ) {
    count++;
  }
  for (const sub of task.subTasks || []) {
    if (
      isBugSubtask(sub) &&
      isDevTaskDone(sub) &&
      !isCancelledStatus(sub.status) &&
      assigneeEmailMatches(sub.assignee, assigneeEmail)
    ) {
      count++;
    }
  }
  return count;
};

export const getIssueTypeStyle = (type?: string, light = false) => {
  const t = type?.toLowerCase() || '';
  if (t.includes('bug') || t.includes('lỗi')) {
    return light
      ? {
          bg: 'rgba(239, 68, 68, 0.12)',
          color: '#dc2626',
          border: '1px solid rgba(220, 38, 38, 0.35)',
        }
      : {
          bg: 'rgba(239, 68, 68, 0.15)',
          color: '#f87171',
          border: '1px solid rgba(239, 68, 68, 0.3)',
        };
  }
  if (t.includes('story') || t.includes('yêu cầu')) {
    return light
      ? {
          bg: 'rgba(16, 185, 129, 0.12)',
          color: '#047857',
          border: '1px solid rgba(5, 150, 105, 0.35)',
        }
      : {
          bg: 'rgba(16, 185, 129, 0.15)',
          color: '#34d399',
          border: '1px solid rgba(16, 185, 129, 0.3)',
        };
  }
  if (t.includes('task') || t.includes('công việc')) {
    return light
      ? {
          bg: 'rgba(59, 130, 246, 0.12)',
          color: '#1d4ed8',
          border: '1px solid rgba(37, 99, 235, 0.35)',
        }
      : {
          bg: 'rgba(59, 130, 246, 0.15)',
          color: '#60a5fa',
          border: '1px solid rgba(59, 130, 246, 0.3)',
        };
  }
  return light
    ? {
        bg: 'rgba(99, 102, 241, 0.12)',
        color: '#4338ca',
        border: '1px solid rgba(79, 70, 229, 0.35)',
      }
    : {
        bg: 'rgba(99, 102, 241, 0.12)',
        color: '#818cf8',
        border: '1px solid rgba(99, 102, 241, 0.3)',
      };
};

export const getStatusColor = (cat: string, light = false) => {
  switch (cat?.toLowerCase()) {
    case 'new':
      return {
        bg: 'rgba(148,163,184,0.15)',
        text: light ? '#475569' : 'var(--text-secondary)',
        border: 'rgba(148,163,184,0.3)',
      };
    case 'indeterminate':
      return light
        ? { bg: 'rgba(245,158,11,0.12)', text: '#b45309', border: 'rgba(217,119,6,0.35)' }
        : { bg: 'rgba(245,158,11,0.15)', text: '#fbbf24', border: 'rgba(245,158,11,0.3)' };
    case 'done':
      return light
        ? { bg: 'rgba(16,185,129,0.12)', text: '#047857', border: 'rgba(5,150,105,0.35)' }
        : { bg: 'rgba(16,185,129,0.15)', text: '#34d399', border: 'rgba(16,185,129,0.3)' };
    default:
      return {
        bg: 'rgba(148,163,184,0.15)',
        text: light ? '#475569' : 'var(--text-secondary)',
        border: 'rgba(148,163,184,0.3)',
      };
  }
};
