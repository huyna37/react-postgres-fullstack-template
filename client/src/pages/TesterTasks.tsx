import {
  AlertCircle,
  Award,
  Bug,
  Calendar,
  CheckCircle2,
  Clock,
  Code,
  ExternalLink,
  Flame,
  HelpCircle,
  Layers,
  ListTodo,
  Loader2,
  Percent,
  Play,
  Plus,
  Search,
  X,
} from 'lucide-react';
import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JiraRichComposer from '../components/JiraRichComposer';
import JiraRichContent from '../components/JiraRichContent';
import JiraTicketKeyLink from '../components/JiraTicketKeyLink';
import TesterCreateChildModal, {
  type CreateChildKind,
  type TesterCreateChildModalHandle,
} from '../components/TesterCreateChildModal';
import TesterTaskCard from '../components/TesterTaskCard';
import TicketActionPanel from '../components/TicketActionPanel';
import TicketAttachmentList from '../components/TicketAttachmentList';
import TicketCommentList from '../components/TicketCommentList';
import TicketAssigneeField, { buildAssigneeFromId } from '../components/TicketAssigneeField';
import TicketFieldEditButton from '../components/TicketFieldEditButton';
import { TicketModalTabs, type TicketModalTab } from '../components/TicketModalTabs';
import TicketOutputField from '../components/TicketOutputField';
import TicketPreviewModal from '../components/TicketPreviewModal';
import TicketStatusTransition from '../components/TicketStatusTransition';
import { useTheme } from '../context/ThemeContext';
import type { User } from '../types';
import { getAvatarUrl } from '../utils/avatar';
import {
  revokeJiraImagePreviews,
  serializeJiraImages,
  type ComposerInlineImage,
} from '../utils/jiraImages';
import {
  canCreateChildTicket,
  canLogworkTicket,
  canTransitionTicket,
  canUpdateTicket,
  hasJiraToken,
} from '../utils/jiraToken';
import { clearJiraWikiHtmlCache } from '../utils/jiraWiki';
import { isSameTesterIssues } from '../utils/stableDataCompare';
import { showError } from '../utils/swal';
import {
  assigneeEmailMatches,
  classifyStoryTestBucket,
  countClosedBugsInTask,
  countDevSubsDoneTodayInTask,
  countOpenBugsInTask,
  countOpenDevSubsInTask,
  getIssueTypeStyle,
  getStatusColor,
  isAssigneeDevWorkComplete,
  isBugSubtask,
  isDevSubtask,
  isDevTaskDone,
  isDevTaskInProgress,
  isStoryDevComplete,
  isStoryDevDoneNoTestSub,
  isStoryDevDoneTestIncomplete,
  isStoryReadyToTest,
  isStoryTestVerifiedDone,
  isStoryUnderTest,
  isStoryWithIncompleteDevSubs,
  isTestTask,
} from '../utils/testerTaskHelpers';

interface TesterTasksProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
  currentUser: User | null;
  setCurrentUser: (user: User | null) => void;
}

// Định nghĩa tất cả các filter tab hợp lệ để tránh lỗi TS2345 và TS2367
type FilterTab =
  | 'all'
  | 'ready-to-test'
  | 'my-tasks'
  | 'dev-done-bug-pending'
  | 'subtasks-done-not-closed';

function ticketContentMatches(
  cached: { summary?: string; description?: string; output?: string },
  data: { summary?: string; description?: string; output?: string }
) {
  return (
    (cached.summary || '') === (data.summary || '') &&
    (cached.description ?? '') === (data.description ?? '') &&
    (cached.output || '') === (data.output || '')
  );
}

function assigneeRoleLabel(role?: string) {
  if (role === 'tester') return 'Tester';
  if (role === 'ba') return 'BA';
  if (role === 'developer') return 'Dev';
  return role || '';
}

function isLockedTestSubtask(sub: any) {
  return /^\[TEST\]/i.test(sub.summary || '') || isTestTask(sub);
}

export default function TesterTasks({
  apiFetch,
  API_BASE_URL,
  openJiraTicket,
  currentUser,
  setCurrentUser,
}: TesterTasksProps) {
  const { theme } = useTheme();
  const isLight = theme === 'light';

  // Config & Token Locker States
  const [jiraProjects, setJiraProjects] = useState<any[]>([]);
  const [loadingJiraProjects, setLoadingJiraProjects] = useState(false);

  const [activeProjects, setActiveProjects] = useState<{ jira_key: string; name: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState(() => {
    return currentUser?.jira_project || 'BXDCSDL';
  });

  // Dashboard Data States
  const [tasks, setTasks] = useState<any[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [projectKey, setProjectKey] = useState('');

  // Filters State
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>('all');
  const [activeChipFilter, setActiveChipFilter] = useState<string | null>(null);
  // Dùng email thay vì Jira accountId — lấy từ currentUser.username (không cần gọi Jira)
  const [myEmail, setMyEmail] = useState<string | null>(currentUser?.username || null);

  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
  });
  const [selectedAssignee, setSelectedAssignee] = useState<string>('all');

  const [projectUsers, setProjectUsers] = useState<any[]>([]);

  const createChildModalRef = useRef<TesterCreateChildModalHandle>(null);

  const [previewSubtask, setPreviewSubtask] = useState<any | null>(null);
  const [previewSubtaskOpen, setPreviewSubtaskOpen] = useState(false);

  useEffect(() => {
    // Cập nhật myEmail khi currentUser thay đổi
    setMyEmail(currentUser?.username || null);
  }, [currentUser?.username]);

  // Reset chip filter when project, month, or main filter tab changes
  useEffect(() => {
    setActiveChipFilter(null);
  }, [selectedProject, selectedMonth, activeFilterTab]);

  useEffect(() => {
    if (!selectedProject) return;
    const fetchProjectUsers = async () => {
      try {
        const res = await apiFetch(
          `${API_BASE_URL}/api/users/active?projectKey=${encodeURIComponent(selectedProject)}`
        );
        if (res.ok) {
          const data = await res.json();
          setProjectUsers(data);
        }
      } catch (err) {
        console.error('Failed to fetch project users:', err);
      }
    };
    fetchProjectUsers();
  }, [selectedProject, apiFetch, API_BASE_URL]);

  // Fetch active projects on mount
  useEffect(() => {
    const fetchActiveProjects = async () => {
      try {
        const response = await apiFetch(`${API_BASE_URL}/api/projects/active`);
        if (response.ok) {
          const data = await response.json();
          setActiveProjects(data);
          if (data.length > 0) {
            const currentProj = currentUser?.jira_project || 'BXDCSDL';
            const exists = data.some((p: any) => p.jira_key === currentProj);
            if (exists) {
              setSelectedProject(currentProj);
            } else {
              setSelectedProject(data[0].jira_key);
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch active projects:', error);
      }
    };
    fetchActiveProjects();
  }, [apiFetch, API_BASE_URL, currentUser?.jira_project]);

  // Detail Modal States — chỉ lưu key, luôn resolve từ tasks mới sau mỗi lần poll
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(null);
  const [testerDetailTab, setTesterDetailTab] = useState<TicketModalTab>('content');
  const [descriptionEditMode, setDescriptionEditMode] = useState(false);
  const [descriptionImages, setDescriptionImages] = useState<ComposerInlineImage[]>([]);
  const [savingDescription, setSavingDescription] = useState(false);
  const [savingOutput, setSavingOutput] = useState(false);
  const [savingAssigneeKey, setSavingAssigneeKey] = useState<string | null>(null);
  const [assigneeEditingKey, setAssigneeEditingKey] = useState<string | null>(null);
  const [outputEditMode, setOutputEditMode] = useState(false);
  const outputSavedRef = useRef('');
  const descriptionBaselineRef = useRef('');
  const detailsCacheRef = useRef(
    new Map<
      string,
      {
        summary: string;
        description: string;
        output: string;
        creator?: string | null;
        creatorEmail?: string | null;
        isSubtask?: boolean;
        parentKey?: string | null;
        attachmentCount?: number;
        commentCount?: number;
        comments?: any[];
        commentsIncludeRelated?: boolean;
      }
    >()
  );
  const [attachmentCount, setAttachmentCount] = useState<number | null>(null);
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [activeTaskDetails, setActiveTaskDetails] = useState<{
    summary?: string;
    description?: string;
    output?: string;
    creator?: string | null;
    creatorEmail?: string | null;
  } | null>(null);
  const [commentDetails, setCommentDetails] = useState<{
    isSubtask?: boolean;
    parentKey?: string | null;
    commentsIncludeRelated?: boolean;
    comments?: any[];
  } | null>(null);
  const [contentLoadedKey, setContentLoadedKey] = useState<string | null>(null);

  const userHasJiraToken = hasJiraToken(currentUser);
  const canUpdateTicketFlag = canUpdateTicket(currentUser);
  const canCreateChildTicketFlag = canCreateChildTicket(currentUser, 'tester-tasks');
  const canLogworkTicketFlag = canLogworkTicket(currentUser);
  const canTransitionTicketFlag = canTransitionTicket(currentUser);
  const fetchGenerationRef = useRef(0);
  const fetchInFlightRef = useRef(false);
  const pendingSilentRefreshRef = useRef(false);
  const tasksRef = useRef<any[]>([]);
  const projectKeyRef = useRef('');

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    projectKeyRef.current = projectKey;
  }, [projectKey]);

  // Load Tasks
  const fetchTesterTasks = useCallback(
    async (showRefreshIndicator = false, silent = false) => {
      if (fetchInFlightRef.current) {
        if (silent) pendingSilentRefreshRef.current = true;
        return;
      }
      fetchInFlightRef.current = true;
      const requestGen = ++fetchGenerationRef.current;

      if (!silent) {
        if (showRefreshIndicator) setRefreshing(true);
        else setLoadingTasks(true);
      }

      try {
        const [year, month] = selectedMonth.split('-');
        const token = localStorage.getItem('token');
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await apiFetch(
          `${API_BASE_URL}/api/tester/dashboard-tasks?month=${month}&year=${year}&projectKey=${selectedProject}`,
          { headers }
        );
        if (requestGen !== fetchGenerationRef.current) return;

        if (res.ok) {
          const data = await res.json();
          const newIssues: any[] = data.issues || [];
          if (!isSameTesterIssues(tasksRef.current, newIssues)) {
            setTasks(newIssues);
          }
          const nextProjectKey = data.projectKey || '';
          if (nextProjectKey !== projectKeyRef.current) {
            setProjectKey(nextProjectKey);
          }
          // Dùng email từ app account (trả về từ API), fallback sang currentUser.username
          if (data.currentUserEmail) {
            setMyEmail(prev => (prev === data.currentUserEmail ? prev : data.currentUserEmail));
          }
        } else if (res.status === 400) {
          const err = await res.json();
          if (err.error === 'personal_token_required') {
            console.warn('Personal token required from API');
          }
        } else {
          const errText = await res.text();
          console.error('Error fetching tasks:', errText);
        }
      } catch (err) {
        if (requestGen === fetchGenerationRef.current) {
          console.error('Failed to load tester tasks:', err);
        }
      } finally {
        fetchInFlightRef.current = false;
        if (requestGen === fetchGenerationRef.current) {
          setLoadingTasks(false);
          setRefreshing(false);
        }
        if (pendingSilentRefreshRef.current) {
          pendingSilentRefreshRef.current = false;
          void fetchTesterTasks(false, true);
        }
      }
    },
    [selectedMonth, selectedProject, apiFetch, API_BASE_URL]
  );

  const scheduleTesterTasksRefresh = useCallback(() => {
    window.setTimeout(() => void fetchTesterTasks(false, true), 500);
  }, [fetchTesterTasks]);

  useEffect(() => {
    fetchTesterTasks();
  }, [fetchTesterTasks]);

  // Auto-refresh 10s — silent poll; setTasks chỉ khi isSameTesterIssues = false
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchTesterTasks(false, true);
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchTesterTasks]);

  // Load Jira Projects list for the Locker interface
  const fetchJiraProjects = async (tokenOverride?: string) => {
    setLoadingJiraProjects(true);
    try {
      const headers: Record<string, string> = {};
      const token = tokenOverride || currentUser?.jira_token;
      if (token) {
        headers['Authorization'] = `Bearer ${localStorage.getItem('token')}`;
      }

      const res = await apiFetch(`${API_BASE_URL}/api/jira/projects`);
      if (res.ok) {
        const data = await res.json();
        setJiraProjects(data);
      }
    } catch (err) {
      console.error('Failed to fetch Jira projects:', err);
    } finally {
      setLoadingJiraProjects(false);
    }
  };

  // Pre-load project options if token exists but no project is selected
  useEffect(() => {
    if (userHasJiraToken && jiraProjects.length === 0) {
      fetchJiraProjects();
    }
  }, [currentUser?.jira_token]);

  const toggleChipFilter = (filterKey: string) => {
    setActiveChipFilter(prev => (prev === filterKey ? null : filterKey));
  };

  const getChipFilterLabel = (filterKey: string) => {
    switch (filterKey) {
      case 'open-dev-subs':
        return 'DEV chưa xong';
      case 'dev-subs-done-today':
        return 'DEV HT hôm nay';
      case 'dev-done-test-pending':
        return 'Chờ kiểm thử';
      case 'ready-to-test':
        return 'Sẵn sàng test';
      case 'under-test':
        return 'Đang test';
      case 'awaiting-test-sub':
        return 'Chờ TESTER (Chưa có TEST)';
      case 'incomplete-dev-stories':
        return 'Story chưa hoàn thành DEV';
      case 'open-bugs':
        return 'Bug mở';
      case 'closed-bugs':
        return 'Bug đóng';
      case 'test-story-open':
        return 'Story chưa xong TEST';
      case 'test-story-done':
        return 'Story đã xong TEST';
      case 'test-story-no-sub':
        return 'Story chưa có sub TEST';
      case 'test-verified-done':
        return 'Đã test xong';
      case 'dev-work-complete':
        return 'Story hoàn thành DEV';
      default:
        return '';
    }
  };

  const tasksWithActiveProjectUsers = useMemo(() => {
    if (projectUsers.length === 0) return tasks;

    return tasks.map(task => {
      if (!task.subTasks || task.subTasks.length === 0) return task;
      const filteredSubs = task.subTasks.filter((s: any) => {
        if (!s.assignee) return false;
        const email = s.assignee.emailAddress?.toLowerCase();
        const accId = s.assignee.accountId?.toLowerCase();
        return projectUsers.some(u => {
          const uEmail = u.emailAddress?.toLowerCase();
          const uAccId = u.accountId?.toLowerCase();
          return (
            (uAccId && accId === uAccId) ||
            (uEmail && email === uEmail) ||
            (uEmail && accId && accId.includes('@') && accId === uEmail)
          );
        });
      });
      return {
        ...task,
        subTasks: filteredSubs,
      };
    });
  }, [tasks, projectUsers]);

  const taskMatchesSearchTerm = (task: any, term: string) => {
    const q = term.trim().toLowerCase();
    if (!q) return true;

    const textMatches = (...values: (string | undefined | null)[]) =>
      values.some(v => v?.toLowerCase().includes(q));

    if (
      textMatches(
        task.key,
        task.summary,
        task.description,
        task.assignee?.displayName,
        task.assignee?.emailAddress
      )
    ) {
      return true;
    }

    return (
      task.subTasks?.some((s: any) =>
        textMatches(
          s.key,
          s.summary,
          s.description,
          s.assignee?.displayName,
          s.assignee?.emailAddress
        )
      ) ?? false
    );
  };

  // Filter issues based on tabs and search term (computed first, analytics depends on this)
  const baseFilteredTasks = useMemo(() => {
    return tasksWithActiveProjectUsers.filter(task => {
      if (!taskMatchesSearchTerm(task, searchTerm)) return false;

      if (selectedAssignee !== 'all') {
        // So sánh bằng email — chính xác hơn displayName
        const matchesEmail = (assignee?: any) =>
          assigneeEmailMatches(assignee, selectedAssignee);
        const isParentMatch = matchesEmail(task.assignee);
        const isSubtaskMatch = task.subTasks?.some((s: any) => matchesEmail(s.assignee));
        if (!isParentMatch && !isSubtaskMatch) return false;
      }

      return true;
    });
  }, [tasksWithActiveProjectUsers, searchTerm, selectedAssignee]);

  const tabEstimates = useMemo(() => {
    const allCount = baseFilteredTasks.length;
    const allEst =
      baseFilteredTasks.reduce((sum: number, t: any) => sum + (t.originalEstimate || 0), 0) / 3600;

    const readyTasks = baseFilteredTasks.filter(isStoryReadyToTest);
    const readyCount = readyTasks.length;
    const readyEst =
      readyTasks.reduce((sum: number, t: any) => sum + (t.originalEstimate || 0), 0) / 3600;

    const devDoneBugTasks = baseFilteredTasks.filter(task => {
      const devSubs = task.subTasks?.filter((s: any) => isDevSubtask(s)) || [];
      const allDevDone = devSubs.length > 0 && devSubs.every((s: any) => isDevTaskDone(s));
      return (
        allDevDone &&
        (task.subTasks?.some(
          (s: any) => isBugSubtask(s) && s.statusCategory?.toLowerCase() !== 'done'
        ) ||
          false)
      );
    });
    const devDoneBugCount = devDoneBugTasks.length;
    const devDoneBugEst =
      devDoneBugTasks.reduce((sum: number, t: any) => sum + (t.originalEstimate || 0), 0) / 3600;

    const subtasksDoneNotClosedTasks = baseFilteredTasks.filter(task => {
      const subs = task.subTasks || [];
      if (subs.length === 0) return false;
      const isParentClosed =
        task.statusCategory?.toLowerCase() === 'done' ||
        task.status?.toLowerCase() === 'closed' ||
        task.status?.toLowerCase() === 'đóng';
      if (isParentClosed) return false;
      const allSubsDone = subs.every(
        (s: any) =>
          s.statusCategory?.toLowerCase() === 'done' ||
          s.status?.toLowerCase()?.includes('done') ||
          s.status?.toLowerCase()?.includes('resolved') ||
          s.status?.toLowerCase()?.includes('hoàn thành')
      );
      const hasNotClosed = subs.some(
        (s: any) => s.status?.toLowerCase() !== 'closed' && s.status?.toLowerCase() !== 'đóng'
      );
      return allSubsDone && hasNotClosed;
    });
    const subtasksDoneNotClosedCount = subtasksDoneNotClosedTasks.length;
    const subtasksDoneNotClosedEst =
      subtasksDoneNotClosedTasks.reduce(
        (sum: number, t: any) => sum + (t.originalEstimate || 0),
        0
      ) / 3600;

    return {
      allCount,
      allEst,
      readyCount,
      readyEst,
      devDoneBugCount,
      devDoneBugEst,
      subtasksDoneNotClosedCount,
      subtasksDoneNotClosedEst,
    };
  }, [baseFilteredTasks]);

  const tabFilteredTasks = useMemo(() => {
    return baseFilteredTasks.filter(task => {
      if (activeFilterTab === 'all') return true;

      const devSubs = task.subTasks?.filter((s: any) => !isTestTask(s)) || [];
      const testSubs = task.subTasks?.filter((s: any) => isTestTask(s)) || [];

      if (activeFilterTab === 'my-tasks') {
        // Dùng email — không phụ thuộc Jira accountId
        const emailMatch = (a?: any) =>
          a?.emailAddress && myEmail && a.emailAddress.toLowerCase() === myEmail.toLowerCase();
        return emailMatch(task.assignee) || task.subTasks?.some((s: any) => emailMatch(s.assignee));
      }

      if (activeFilterTab === 'ready-to-test') {
        return isStoryReadyToTest(task);
      }

      if (activeFilterTab === 'dev-done-bug-pending') {
        const devSubs = task.subTasks?.filter((s: any) => isDevSubtask(s)) || [];
        const allDevDone = devSubs.length > 0 && devSubs.every((s: any) => isDevTaskDone(s));
        return (
          allDevDone &&
          (task.subTasks?.some(
            (s: any) => isBugSubtask(s) && s.statusCategory?.toLowerCase() !== 'done'
          ) ||
            false)
        );
      }

      if (activeFilterTab === 'subtasks-done-not-closed') {
        const subs = task.subTasks || [];
        if (subs.length === 0) return false;

        // Bỏ qua nếu parent ticket bản thân đã đóng/hoàn thành
        const isParentClosed =
          task.statusCategory?.toLowerCase() === 'done' ||
          task.status?.toLowerCase() === 'closed' ||
          task.status?.toLowerCase() === 'đóng';
        if (isParentClosed) return false;

        const allSubsDone = subs.every(
          (s: any) =>
            s.statusCategory?.toLowerCase() === 'done' ||
            s.status?.toLowerCase()?.includes('done') ||
            s.status?.toLowerCase()?.includes('resolved') ||
            s.status?.toLowerCase()?.includes('hoàn thành')
        );
        const hasNotClosed = subs.some(
          (s: any) => s.status?.toLowerCase() !== 'closed' && s.status?.toLowerCase() !== 'đóng'
        );
        return allSubsDone && hasNotClosed;
      }

      return true;
    });
  }, [baseFilteredTasks, activeFilterTab, myEmail]);

  const filteredTasks = useMemo(() => {
    if (!activeChipFilter) return tabFilteredTasks;

    const assigneeFilter = selectedAssignee !== 'all' ? selectedAssignee : null;

    return tabFilteredTasks.filter(task => {
      switch (activeChipFilter) {
        case 'open-dev-subs':
          return countOpenDevSubsInTask(task, assigneeFilter) > 0;
        case 'dev-subs-done-today':
          return countDevSubsDoneTodayInTask(task, assigneeFilter) > 0;
        case 'dev-done-test-pending':
          return isStoryDevDoneTestIncomplete(task);
        case 'ready-to-test':
          return isStoryReadyToTest(task);
        case 'under-test':
          return isStoryUnderTest(task);
        case 'awaiting-test-sub':
          return isStoryDevDoneNoTestSub(task);
        case 'incomplete-dev-stories':
          return isStoryWithIncompleteDevSubs(task, assigneeFilter);
        case 'open-bugs':
          return countOpenBugsInTask(task, assigneeFilter) > 0;
        case 'closed-bugs':
          return countClosedBugsInTask(task, assigneeFilter) > 0;
        case 'test-story-open':
          return classifyStoryTestBucket(task) === 'open-test';
        case 'test-story-done':
          return classifyStoryTestBucket(task) === 'all-test-done';
        case 'test-story-no-sub':
          return classifyStoryTestBucket(task) === 'no-test-sub';
        case 'test-verified-done':
          return isStoryTestVerifiedDone(task);
        case 'dev-work-complete':
          return isStoryTestVerifiedDone(task) || isStoryDevDoneTestIncomplete(task);
        default:
          return true;
      }
    });
  }, [tabFilteredTasks, activeChipFilter, selectedAssignee]);

  const activeTask = useMemo(() => {
    if (selectedTaskKey) {
      const found = filteredTasks.find(t => t.key === selectedTaskKey);
      if (found) return found;
    }
    return filteredTasks[0] || null;
  }, [filteredTasks, selectedTaskKey]);

  const actionIssueKey = activeTask?.key || '';

  const renderCreateChildButton = (
    kind: CreateChildKind,
    label: string,
    color: string,
    compact = false
  ) => {
    if (!activeTask?.key || activeTask?.isSynthesized) return null;
    const canCreate = canCreateChildTicketFlag;
    return (
      <button
        type="button"
        onClick={e => {
          e.stopPropagation();
          createChildModalRef.current?.open(kind);
        }}
        title={
          canCreate
            ? `Tạo ${label} cho ${activeTask.key}`
            : !userHasJiraToken
              ? 'Cần Jira token cá nhân'
              : 'Không có quyền tạo sub-task trên trang này'
        }
        disabled={!canCreate}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: compact ? '3px' : '5px',
          padding: compact ? '2px 8px' : '5px 12px',
          fontSize: compact ? '0.62rem' : '0.72rem',
          fontWeight: 600,
          borderRadius: '6px',
          border: `1px solid ${color}44`,
          background: `${color}18`,
          color,
          cursor: canCreate ? 'pointer' : 'not-allowed',
          opacity: canCreate ? 1 : 0.55,
        }}
      >
        {kind === 'bug' ? <Bug size={compact ? 11 : 13} /> : <Plus size={compact ? 11 : 13} />}
        {label}
      </button>
    );
  };

  // Giữ selection khớp danh sách sau đổi tab/filter/tháng
  useEffect(() => {
    if (filteredTasks.length === 0) {
      if (selectedTaskKey) setSelectedTaskKey(null);
      return;
    }
    if (!selectedTaskKey || !filteredTasks.some(t => t.key === selectedTaskKey)) {
      setSelectedTaskKey(filteredTasks[0].key);
    }
  }, [filteredTasks, selectedTaskKey]);

  const applyTicketContent = useCallback(
    (
      key: string,
      data: {
        summary?: string;
        description?: string;
        output?: string;
        creator?: string | null;
        creatorEmail?: string | null;
        isSubtask?: boolean;
        parentKey?: string | null;
        attachmentCount?: number;
        commentCount?: number;
        commentsIncludeRelated?: boolean;
      }
    ) => {
      const summary = data.summary || '';
      const description = data.description ?? '';
      const output = data.output || '';
      outputSavedRef.current = output;
      descriptionBaselineRef.current = description;
      setContentLoadedKey(key);
      setActiveTaskDetails({
        summary,
        description,
        output,
        creator: data.creator,
        creatorEmail: data.creatorEmail,
      });
      if (data.attachmentCount != null) setAttachmentCount(data.attachmentCount);
      if (data.commentCount != null) setCommentCount(data.commentCount);
      const prev = detailsCacheRef.current.get(key) || {
        summary,
        description,
        output,
      };
      detailsCacheRef.current.set(key, {
        ...prev,
        summary,
        description,
        output,
        creator: data.creator,
        creatorEmail: data.creatorEmail,
        isSubtask: data.isSubtask,
        parentKey: data.parentKey,
        attachmentCount: data.attachmentCount ?? prev.attachmentCount,
        commentCount: data.commentCount ?? prev.commentCount,
        commentsIncludeRelated: data.commentsIncludeRelated ?? prev.commentsIncludeRelated,
      });
    },
    []
  );

  const applyTicketComments = useCallback(
    (
      key: string,
      data: {
        isSubtask?: boolean;
        parentKey?: string | null;
        commentsIncludeRelated?: boolean;
        comments?: any[];
      }
    ) => {
      const comments = data.comments || [];
      setCommentDetails({
        isSubtask: data.isSubtask,
        parentKey: data.parentKey,
        commentsIncludeRelated: data.commentsIncludeRelated,
        comments,
      });
      setCommentCount(comments.length);
      const prev = detailsCacheRef.current.get(key);
      if (prev) {
        detailsCacheRef.current.set(key, {
          ...prev,
          isSubtask: data.isSubtask,
          parentKey: data.parentKey,
          commentsIncludeRelated: data.commentsIncludeRelated,
          comments,
          commentCount: comments.length,
        });
      }
    },
    []
  );

  const handleSelectTask = useCallback(
    (key: string) => {
      if (key === selectedTaskKey) return;
      const listTask = tasksRef.current.find(t => t.key === key);
      const cached = detailsCacheRef.current.get(key);
      if (listTask?.attachmentCount != null) {
        setAttachmentCount(listTask.attachmentCount);
      } else if (!cached?.description) {
        setAttachmentCount(null);
      }
      if (listTask?.commentCount != null) {
        setCommentCount(listTask.commentCount);
      } else if (!cached?.comments && cached?.commentCount == null) {
        setCommentCount(null);
      }
      if (cached?.description !== undefined) {
        applyTicketContent(key, cached);
        if (cached.comments) {
          applyTicketComments(key, {
            isSubtask: cached.isSubtask,
            parentKey: cached.parentKey,
            commentsIncludeRelated: cached.commentsIncludeRelated,
            comments: cached.comments,
          });
        } else {
          setCommentDetails(null);
        }
      } else {
        setContentLoadedKey(null);
        setActiveTaskDetails(null);
        setCommentDetails(null);
      }
      setTesterDetailTab('content');
      setDescriptionEditMode(false);
      setOutputEditMode(false);
      setDescriptionImages(prev => {
        revokeJiraImagePreviews(prev);
        return [];
      });
      if (cached?.description === undefined) {
        descriptionBaselineRef.current = '';
        outputSavedRef.current = '';
      }
      startTransition(() => setSelectedTaskKey(key));
    },
    [selectedTaskKey, applyTicketContent, applyTicketComments]
  );

  const loadTicketContent = useCallback(
    async (key: string) => {
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/tickets/details/${key}?with=content`);
        if (!res.ok) {
          setActiveTaskDetails(null);
          setContentLoadedKey(null);
          setAttachmentCount(null);
          setCommentCount(null);
          return;
        }
        const data = await res.json();
        const cached = detailsCacheRef.current.get(key);
        if (cached && ticketContentMatches(cached, data)) {
          setContentLoadedKey(prev => (prev === key ? prev : key));
          if (data.attachmentCount != null) setAttachmentCount(data.attachmentCount);
          if (data.commentCount != null) setCommentCount(data.commentCount);
          return;
        }
        startTransition(() => {
          applyTicketContent(key, data);
        });
      } catch {
        setActiveTaskDetails(null);
        setContentLoadedKey(null);
        setAttachmentCount(null);
        setCommentCount(null);
      }
    },
    [apiFetch, API_BASE_URL, applyTicketContent]
  );

  const loadTicketComments = useCallback(
    async (key: string) => {
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/tickets/details/${key}?with=comments`);
        if (!res.ok) {
          setCommentDetails(null);
          return;
        }
        const data = await res.json();
        applyTicketComments(key, data);
      } catch {
        setCommentDetails(null);
      }
    },
    [apiFetch, API_BASE_URL, applyTicketComments]
  );

  useEffect(() => {
    const key = activeTask?.key;
    if (!key) {
      setActiveTaskDetails(null);
      setCommentDetails(null);
      setAttachmentCount(null);
      setCommentCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      await loadTicketContent(key);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTask?.key, loadTicketContent]);

  useEffect(() => {
    const key = activeTask?.key;
    if (!key) return;
    const listTask = tasksWithActiveProjectUsers.find(t => t.key === key);
    if (!listTask) return;
    if (listTask.attachmentCount != null) setAttachmentCount(listTask.attachmentCount);
    if (listTask.commentCount != null) setCommentCount(listTask.commentCount);
  }, [activeTask?.key, tasksWithActiveProjectUsers]);

  useEffect(() => {
    const key = activeTask?.key;
    if (!key || testerDetailTab !== 'comments') return;
    let cancelled = false;
    void (async () => {
      await loadTicketComments(key);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTask?.key, testerDetailTab, loadTicketComments]);

  const reloadCommentDetails = useCallback(async () => {
    const key = activeTask?.key;
    if (!key) {
      setCommentDetails(null);
      return;
    }
    const cached = detailsCacheRef.current.get(key);
    if (cached) {
      detailsCacheRef.current.set(key, { ...cached, comments: undefined });
    }
    await loadTicketComments(key);
  }, [activeTask?.key, loadTicketComments]);

  const openSubtaskPreview = (sub: any) => {
    setPreviewSubtask(sub);
    setPreviewSubtaskOpen(true);
  };

  const subtaskCardProps = (sub: any) => ({
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => openSubtaskPreview(sub),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSubtaskPreview(sub);
      }
    },
  });

  const renderSubtaskHead = (sub: any, done: boolean, ip: boolean) => (
    <div className="tester-sub-item__head">
      {done ? (
        <CheckCircle2 size={13} color="#34d399" style={{ marginTop: '2px', flexShrink: 0 }} />
      ) : ip ? (
        <Loader2
          className="spinner"
          size={13}
          color="#fbbf24"
          style={{ marginTop: '2px', flexShrink: 0 }}
        />
      ) : (
        <Clock
          size={13}
          color="var(--text-secondary)"
          style={{ marginTop: '2px', flexShrink: 0 }}
        />
      )}
      <div className={`tester-sub-item__title${done ? ' is-done' : ''}`}>
        <div className="tester-sub-item__meta">
          <span>[{sub.key}]</span>
          {sub.issueType &&
            (() => {
              const subTypeStyle = getIssueTypeStyle(sub.issueType, isLight);
              return (
                <span
                  className="tester-sub-item__type"
                  style={{
                    background: subTypeStyle.bg,
                    color: subTypeStyle.color,
                    border: subTypeStyle.border,
                  }}
                >
                  {sub.issueType}
                </span>
              );
            })()}
        </div>
        <span className="tester-sub-item__summary">{sub.summary}</span>
      </div>
    </div>
  );

  const patchSubtaskStatus = useCallback(
    (subKey: string, patch: { status?: string; statusCategory?: string }) => {
      setTasks(prev =>
        prev.map(parent => ({
          ...parent,
          subTasks: (parent.subTasks || []).map((s: any) =>
            s.key === subKey ? { ...s, ...patch } : s
          ),
        }))
      );
    },
    []
  );

  const patchAssigneeInTasks = useCallback((issueKey: string, assignee: any | null) => {
    setTasks(prev =>
      prev.map(parent => {
        if (parent.key === issueKey) {
          return { ...parent, assignee };
        }
        const subs = parent.subTasks || [];
        if (!subs.some((s: any) => s.key === issueKey)) return parent;
        return {
          ...parent,
          subTasks: subs.map((s: any) => (s.key === issueKey ? { ...s, assignee } : s)),
        };
      })
    );
    setPreviewSubtask((prev: any | null) =>
      prev?.key === issueKey ? { ...prev, assignee } : prev
    );
  }, []);

  const findAssigneeInTasks = useCallback(
    (issueKey: string) => {
      for (const parent of tasksRef.current) {
        if (parent.key === issueKey) return parent.assignee ?? null;
        const sub = (parent.subTasks || []).find((s: any) => s.key === issueKey);
        if (sub) return sub.assignee ?? null;
      }
      return null;
    },
    []
  );

  const handleAssigneeChange = useCallback(
    async (issueKey: string, assigneeId: string) => {
      if (!canTransitionTicketFlag) {
        showError('Bạn không có quyền đổi người gán ticket.');
        return;
      }
      if (savingAssigneeKey === issueKey) return;
      const prevAssignee = findAssigneeInTasks(issueKey);
      const optimisticAssignee = buildAssigneeFromId(assigneeId, projectUsers);
      setSavingAssigneeKey(issueKey);
      patchAssigneeInTasks(issueKey, optimisticAssignee);
      try {
        const res = await apiFetch(`${API_BASE_URL}/api/tickets/${issueKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigneeId: assigneeId || null }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Cập nhật assignee thất bại');
        patchAssigneeInTasks(issueKey, data.assignee ?? optimisticAssignee);
        scheduleTesterTasksRefresh();
      } catch (err: unknown) {
        patchAssigneeInTasks(issueKey, prevAssignee);
        showError(err instanceof Error ? err.message : 'Lỗi khi cập nhật assignee');
        throw err;
      } finally {
        setSavingAssigneeKey(prev => (prev === issueKey ? null : prev));
      }
    },
    [
      API_BASE_URL,
      apiFetch,
      canTransitionTicketFlag,
      findAssigneeInTasks,
      patchAssigneeInTasks,
      projectUsers,
      savingAssigneeKey,
      scheduleTesterTasksRefresh,
    ]
  );

  const handleStoryAssigneeChange = useCallback(
    async (assigneeId: string) => {
      if (!activeTask?.key || !canTransitionTicketFlag) return;
      const testSubKeys = (activeTask.subTasks || [])
        .filter((s: any) => isLockedTestSubtask(s))
        .map((s: any) => s.key)
        .filter(Boolean);
      await handleAssigneeChange(activeTask.key, assigneeId);
      for (const key of testSubKeys) {
        await handleAssigneeChange(key, assigneeId);
      }
    },
    [activeTask, canTransitionTicketFlag, handleAssigneeChange]
  );

  const renderAssigneeField = (
    issueKey: string,
    assignee: any | null,
    options?: {
      locked?: boolean;
      displayAssignee?: any | null;
      onChange?: (value: string) => void | Promise<void>;
      compact?: boolean;
      showAvatar?: boolean;
      stopPropagation?: boolean;
    }
  ) => (
    <TicketAssigneeField
      assignee={assignee}
      displayAssignee={options?.displayAssignee}
      projectUsers={projectUsers}
      canEdit={canTransitionTicketFlag}
      locked={options?.locked}
      saving={savingAssigneeKey === issueKey}
      editing={assigneeEditingKey === issueKey}
      onStartEdit={() => setAssigneeEditingKey(issueKey)}
      onCancelEdit={() =>
        setAssigneeEditingKey(prev => (prev === issueKey ? null : prev))
      }
      onChange={options?.onChange ?? (next => handleAssigneeChange(issueKey, next))}
      apiBaseUrl={API_BASE_URL}
      compact={options?.compact}
      showAvatar={options?.showAvatar}
      stopPropagation={options?.stopPropagation}
    />
  );

  const renderSubtaskStatusControl = (sub: any, done: boolean, ip: boolean) => {
    if (!canTransitionTicketFlag) {
      return (
        <span
          className={`tester-sub-status${done ? ' tester-sub-status--done' : ip ? ' tester-sub-status--progress' : ''}`}
        >
          {sub.status}
        </span>
      );
    }
    return (
      <span className="tester-sub-status-transition">
        <TicketStatusTransition
          issueKey={sub.key}
          currentStatus={sub.status}
          apiFetch={apiFetch}
          apiBaseUrl={API_BASE_URL}
          canAct={canTransitionTicketFlag}
          onStatusChanged={({ status, statusCategory }) => {
            // Cập nhật local state ngay (optimistic)
            if (status) patchSubtaskStatus(sub.key, { status, statusCategory });
            // Invalidate comment cache của ticket cha
            const parentKey = activeTask?.key;
            if (parentKey) {
              const cached = detailsCacheRef.current.get(parentKey);
              if (cached) {
                detailsCacheRef.current.set(parentKey, { ...cached, comments: undefined });
              }
            }
            // Fetch lại tasks ngay lập tức (không delay) để đồng bộ với Jira
            void fetchTesterTasks(false, true);
          }}
        />
      </span>
    );
  };

  const detailSummary = activeTaskDetails?.summary || activeTask?.summary || '';
  const detailDescription = activeTaskDetails?.description ?? '';
  const detailOutput = activeTaskDetails?.output ?? '';
  const contentReady = !!activeTask?.key && contentLoadedKey === activeTask.key;

  const activeDetailView = useMemo(() => {
    if (!activeTask) return null;
    const totalSubsCount = activeTask.subTasks?.length || 0;
    const completedSubsCount =
      activeTask.subTasks?.filter((s: any) => s.statusCategory?.toLowerCase() === 'done').length ||
      0;
    const progressPercent =
      totalSubsCount > 0 ? Math.round((completedSubsCount / totalSubsCount) * 100) : 0;
    return {
      totalSubsCount,
      completedSubsCount,
      progressPercent,
      devSubs: activeTask.subTasks?.filter((s: any) => isDevSubtask(s)) || [],
      testSubs: activeTask.subTasks?.filter((s: any) => isTestTask(s)) || [],
      bugSubs: activeTask.subTasks?.filter((s: any) => isBugSubtask(s)) || [],
      statusColors: getStatusColor(activeTask.statusCategory, isLight),
      detailTypeStyle: getIssueTypeStyle(activeTask.issueType, isLight),
    };
  }, [activeTask, isLight]);

  const beginDescriptionEdit = () => {
    setDescriptionEditMode(true);
  };

  const descriptionDirty = useMemo(
    () => detailDescription !== descriptionBaselineRef.current || descriptionImages.length > 0,
    [detailDescription, descriptionImages.length]
  );

  const outputDirty = useMemo(() => detailOutput !== outputSavedRef.current, [detailOutput]);

  const cancelDescriptionEdit = useCallback(() => {
    setActiveTaskDetails(prev =>
      prev ? { ...prev, description: descriptionBaselineRef.current } : prev
    );
    setDescriptionImages(prev => {
      revokeJiraImagePreviews(prev);
      return [];
    });
    setDescriptionEditMode(false);
  }, []);

  const cancelOutputEdit = useCallback(() => {
    setActiveTaskDetails(prev => (prev ? { ...prev, output: outputSavedRef.current } : prev));
    setOutputEditMode(false);
  }, []);

  const discardUnsavedEdits = useCallback(() => {
    cancelDescriptionEdit();
    cancelOutputEdit();
  }, [cancelDescriptionEdit, cancelOutputEdit]);

  useEffect(() => {
    setAssigneeEditingKey(null);
  }, [activeTask?.key]);

  useEffect(() => {
    if (!activeTask?.key) {
      descriptionBaselineRef.current = '';
      outputSavedRef.current = '';
      setDescriptionEditMode(false);
      setOutputEditMode(false);
      setDescriptionImages(prev => {
        revokeJiraImagePreviews(prev);
        return [];
      });
    }
  }, [activeTask?.key]);

  useEffect(() => {
    if (testerDetailTab === 'content') return;
    if (descriptionEditMode || outputEditMode) {
      discardUnsavedEdits();
    }
  }, [testerDetailTab, descriptionEditMode, outputEditMode, discardUnsavedEdits]);

  const handleSaveDescription = async (payload?: {
    wiki: string;
    images: ComposerInlineImage[];
  }) => {
    if (!activeTask?.key || !canUpdateTicketFlag || savingDescription) return;
    const nextDescription = payload?.wiki ?? detailDescription;
    const nextImages = payload?.images ?? descriptionImages;
    setSavingDescription(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/tickets/${activeTask.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: nextDescription,
          images: nextImages.length > 0 ? await serializeJiraImages(nextImages) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Cập nhật mô tả thất bại');
      setDescriptionEditMode(false);
      descriptionBaselineRef.current = data.description ?? nextDescription;
      revokeJiraImagePreviews(nextImages);
      setDescriptionImages([]);
      clearJiraWikiHtmlCache(activeTask.key);
      setActiveTaskDetails(prev =>
        prev ? { ...prev, description: data.description ?? nextDescription } : prev
      );
      setTasks(prev =>
        prev.map(t =>
          t.key === activeTask.key ? { ...t, description: data.description ?? nextDescription } : t
        )
      );
      void fetchTesterTasks(false, true);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Lỗi khi lưu mô tả');
    } finally {
      setSavingDescription(false);
    }
  };

  const handleSaveOutput = async (nextOutput?: string) => {
    if (!activeTask?.key || !canUpdateTicketFlag || savingOutput) return;
    const output = nextOutput ?? detailOutput;
    if (output === outputSavedRef.current) return;
    setSavingOutput(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/api/tickets/${activeTask.key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ output }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Cập nhật output thất bại');
      const saved = data.output ?? output;
      outputSavedRef.current = saved;
      setActiveTaskDetails(prev => (prev ? { ...prev, output: saved } : prev));
      setOutputEditMode(false);
      void fetchTesterTasks(false, true);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Lỗi khi lưu output');
    } finally {
      setSavingOutput(false);
    }
  };

  // Analytics stats — computed from tabFilteredTasks; sub/bug đếm theo assignee khi đã chọn nhân sự
  const analytics = useMemo(() => {
    const assigneeFilter = selectedAssignee !== 'all' ? selectedAssignee : null;
    let total = tabFilteredTasks.length;
    let readyToTest = 0,
      underTest = 0,
      awaitingTestSub = 0,
      verifiedDone = 0;
    let devSubsDoneToday = 0,
      devDoneTestPending = 0,
      testStoryOpen = 0,
      testStoryAllDone = 0,
      testStoryNoSub = 0,
      incompleteDevStories = 0,
      openDevSubsRemaining = 0,
      completeDevStories = 0,
      openBugsRemaining = 0,
      closedBugsCount = 0;

    tabFilteredTasks.forEach(task => {
      const openDevForAssignee = countOpenDevSubsInTask(task, assigneeFilter);
      devSubsDoneToday += countDevSubsDoneTodayInTask(task, assigneeFilter);

      if (isStoryWithIncompleteDevSubs(task, assigneeFilter)) incompleteDevStories++;
      if (assigneeFilter) {
        if (isAssigneeDevWorkComplete(task, assigneeFilter)) completeDevStories++;
      } else if (isStoryDevComplete(task)) {
        completeDevStories++;
      }
      openDevSubsRemaining += openDevForAssignee;
      if (isStoryDevDoneNoTestSub(task)) awaitingTestSub++;
      if (isStoryDevDoneTestIncomplete(task)) devDoneTestPending++;
      openBugsRemaining += countOpenBugsInTask(task, assigneeFilter);
      closedBugsCount += countClosedBugsInTask(task, assigneeFilter);

      const testBucket = classifyStoryTestBucket(task);
      if (testBucket === 'open-test') testStoryOpen++;
      else if (testBucket === 'all-test-done') testStoryAllDone++;
      else if (testBucket === 'no-test-sub') testStoryNoSub++;

      if (isStoryTestVerifiedDone(task)) {
        verifiedDone++;
      } else if (isStoryUnderTest(task)) {
        underTest++;
      } else if (isStoryReadyToTest(task)) {
        readyToTest++;
      }
    });

    const testPipelineTotal = verifiedDone + devDoneTestPending;
    const testDonePercent =
      testPipelineTotal > 0 ? Math.round((verifiedDone / testPipelineTotal) * 100) : 0;

    return {
      total,
      readyToTest,
      underTest,
      awaitingTestSub,
      verifiedDone,
      devSubsDoneToday,
      devDoneTestPending,
      incompleteDevStories,
      openDevSubsRemaining,
      completeDevStories,
      openBugsRemaining,
      closedBugsCount,
      testStoryOpen,
      testStoryAllDone,
      testStoryNoSub,
      testPipelineTotal,
      testDonePercent,
    };
  }, [tabFilteredTasks, selectedAssignee]);

  // Danh sách nhân sự cho dropdown — toàn bộ active theo project (tester, dev, BA…), key bằng email
  const uniqueAssignees = useMemo(() => {
    return [...projectUsers].sort(
      (a, b) =>
        (b.sortOrder ?? 0) - (a.sortOrder ?? 0) || a.displayName.localeCompare(b.displayName, 'vi')
    );
  }, [projectUsers]);

  return (
    <main className="glass-card dashboard-main tester-page tester-page--viewport-fit">
      {/* 4. FILTERS PANEL */}
      <div className="glass-card page-toolbar">
        {/* Left side: Tabs and Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {/* Quick Filter Tabs */}
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {(() => {
              const filterTabs = [
                {
                  id: 'all',
                  label: 'Tất cả',
                  count: tabEstimates.allCount,
                  est: tabEstimates.allEst,
                  title: `Tổng: ${tabEstimates.allCount} ticket(s) • Est: ${tabEstimates.allEst.toFixed(1)}h`,
                },
                {
                  id: 'ready-to-test',
                  label: 'Đủ ĐK Test',
                  count: tabEstimates.readyCount,
                  est: tabEstimates.readyEst,
                  title: `Tổng Đủ ĐK Test: ${tabEstimates.readyCount} ticket(s) • Est: ${tabEstimates.readyEst.toFixed(1)}h`,
                },
                {
                  id: 'dev-done-bug-pending',
                  label: '🐞 Story còn bug',
                  count: tabEstimates.devDoneBugCount,
                  est: tabEstimates.devDoneBugEst,
                  title: `Tổng Story còn bug: ${tabEstimates.devDoneBugCount} ticket(s) • Est: ${tabEstimates.devDoneBugEst.toFixed(1)}h`,
                  style: {
                    active: isLight
                      ? {
                          background:
                            'linear-gradient(135deg, rgba(254, 226, 226, 0.9) 0%, rgba(254, 243, 199, 0.9) 100%)',
                          border: '1px solid rgba(220, 38, 38, 0.45)',
                          color: '#b91c1c',
                        }
                      : {
                          background:
                            'linear-gradient(135deg, rgba(239, 68, 68, 0.2) 0%, rgba(245, 158, 11, 0.2) 100%)',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          color: '#f87171',
                        },
                  },
                },
                {
                  id: 'subtasks-done-not-closed',
                  label: '✓ Subtask close',
                  count: tabEstimates.subtasksDoneNotClosedCount,
                  est: tabEstimates.subtasksDoneNotClosedEst,
                  title: `Tổng Subtask Xong Chưa Close: ${tabEstimates.subtasksDoneNotClosedCount} ticket(s) • Est: ${tabEstimates.subtasksDoneNotClosedEst.toFixed(1)}h`,
                  style: {
                    active: isLight
                      ? {
                          background:
                            'linear-gradient(135deg, rgba(219, 234, 254, 0.95) 0%, rgba(209, 250, 229, 0.95) 100%)',
                          border: '1px solid rgba(37, 99, 235, 0.4)',
                          color: '#1d4ed8',
                        }
                      : {
                          background:
                            'linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(16, 185, 129, 0.2) 100%)',
                          border: '1px solid rgba(59, 130, 246, 0.4)',
                          color: '#60a5fa',
                        },
                  },
                },
              ];

              return filterTabs.map(tab => {
                const isActive = activeFilterTab === tab.id;
                const isCustomTab = tab.style?.active;

                const baseBtnStyle: React.CSSProperties = {
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                };

                const activeStyle: React.CSSProperties =
                  isCustomTab && tab.style ? tab.style.active : {};

                const inactiveStyle: React.CSSProperties = isCustomTab ? {} : {};

                const inactiveClass = isCustomTab && !isActive ? 'filter-tab-inactive-custom' : '';

                const combinedStyle = {
                  ...baseBtnStyle,
                  ...(isActive ? activeStyle : inactiveStyle),
                };

                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveFilterTab(tab.id as any)}
                    className={`filter-btn ${isActive ? 'active' : ''} ${inactiveClass}`.trim()}
                    style={combinedStyle}
                    title={tab.title}
                  >
                    <span>{tab.label}</span>
                    <span className="tester-tab-count">({tab.count})</span>
                  </button>
                );
              });
            })()}
            {activeChipFilter && (
              <button
                onClick={() => setActiveChipFilter(null)}
                className="filter-btn active"
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  background: isLight ? 'rgba(239, 68, 68, 0.08)' : 'rgba(239, 68, 68, 0.18)',
                  border: isLight ? '1px solid rgba(220, 38, 38, 0.3)' : '1px solid rgba(239, 68, 68, 0.4)',
                  color: isLight ? '#dc2626' : '#f87171',
                }}
                title="Nhấp để xóa bộ lọc số liệu"
              >
                <span>Lọc: {getChipFilterLabel(activeChipFilter)}</span>
                <X size={12} style={{ marginLeft: '4px' }} />
              </button>
            )}
          </div>
        </div>

        {/* Right side: Search, Month, Assignee, and Reload */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1.25rem',
            flexWrap: 'nowrap',
            justifyContent: 'end',
          }}
        >
          {/* Project selector */}
          <div
            className="dashboard-month-wrap"
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <label
              style={{
                margin: 0,
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              Dự án:
            </label>
            <select
              value={selectedProject}
              onChange={e => {
                startTransition(() => {
                  setSelectedProject(e.target.value);
                });
              }}
              className="premium-select toolbar-compact"
              style={{ width: '110px', height: '37px', flexShrink: 0 }}
            >
              {activeProjects.length === 0 ? (
                <option value={selectedProject} title={selectedProject}>{selectedProject}</option>
              ) : (
                activeProjects.map(proj => (
                  <option key={proj.jira_key} value={proj.jira_key} title={proj.name}>
                    {proj.jira_key}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Search Box */}
          <div style={{ position: 'relative', width: '10rem', flexShrink: 0 }}>
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Tìm Key, Summary, Sub..."
              className="premium-select toolbar-inline-input premium-select--no-chevron"
              style={{
                width: '10rem',
                height: '37px',
                padding: '0 0.75rem 0 1.8rem',
                borderRadius: '6px',
                fontSize: '0.75rem',
              }}
            />
            <Search
              size={12}
              color="var(--text-secondary)"
              style={{
                position: 'absolute',
                left: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
              }}
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Month Picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <input
              type="month"
              value={selectedMonth}
              onChange={e => {
                startTransition(() => setSelectedMonth(e.target.value));
              }}
              className="premium-select toolbar-compact toolbar-compact--sm premium-select--no-chevron"
              style={{ width: 'auto' }}
            />
          </div>

          {/* Assignee Filter Dropdown - dùng email làm key, hiển thị tên */}
          <select
            value={selectedAssignee}
            onChange={e => setSelectedAssignee(e.target.value)}
            className="premium-select toolbar-compact"
            style={{ minWidth: '110px', maxWidth: '135px', height: '37px', flexShrink: 0 }}
          >
            <option value="all">Tất cả NS ({uniqueAssignees.length})</option>
            {uniqueAssignees.map(user => (
              <option
                key={user.emailAddress || user.accountId}
                value={user.emailAddress || user.accountId}
              >
                {user.displayName}
                {user.role ? ` (${assigneeRoleLabel(user.role)})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="page-body-pad">
        <div className="stat-grid stat-grid--tester">
          <div className="glass-card stat-card stat-card--indigo">
            <div className="stat-card__icon stat-card__icon--indigo">
              <Layers size={18} color="#818cf8" />
            </div>
            <div className="stat-card__body">
              <span
                className="stat-card__label"
                title="Tổng story/task trong filter — chip bên dưới là chỉ số riêng, không cộng bằng tổng"
              >
                Stories / Tasks
              </span>
              <div
                className={`stat-card__primary stat-card__primary-clickable ${activeChipFilter === null ? 'is-active' : ''}`}
                onClick={() => setActiveChipFilter(null)}
                title="Nhấp để hiển thị tất cả"
              >
                <span className="stat-card__number">{analytics.total}</span>
                <span className="stat-card__unit">tổng</span>
              </div>
              <div className="stat-card__breakdown">
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'open-dev-subs' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('open-dev-subs')}
                  title="Sub có tag [DEV] chưa hoàn thành (Open/In Progress…) — không tính [TEST]/bug"
                >
                  <ListTodo size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.openDevSubsRemaining}</strong>
                </span>
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'dev-subs-done-today' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('dev-subs-done-today')}
                  title="Sub DEV Done/Resolved/Closed hôm nay (giờ Bangkok, theo updated_at)"
                >
                  <CheckCircle2 size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.devSubsDoneToday}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="glass-card stat-card stat-card--blue">
            <div className="stat-card__icon stat-card__icon--blue">
              <ListTodo size={18} color="#60a5fa" />
            </div>
            <div className="stat-card__body">
              <span className="stat-card__label" title="Story DEV xong, TEST chưa hoàn thành">
                Chờ kiểm thử
              </span>
              <div
                className={`stat-card__primary stat-card__primary-clickable ${activeChipFilter === 'dev-done-test-pending' ? 'is-active' : ''}`}
                onClick={() => toggleChipFilter('dev-done-test-pending')}
                title="Nhấp để lọc Story DEV xong, TEST chưa hoàn thành"
              >
                <span className="stat-card__number stat-card__number--blue">
                  {analytics.devDoneTestPending}
                </span>
                <span className="stat-card__unit">story</span>
              </div>
              <div className="stat-card__breakdown">
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'ready-to-test' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('ready-to-test')}
                  title="DEV xong, chờ tester nhận"
                >
                  <Play size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.readyToTest}</strong>
                </span>
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'under-test' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('under-test')}
                  title="Đang có sub TEST in progress"
                >
                  <Clock size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.underTest}</strong>
                </span>
                {analytics.awaitingTestSub > 0 ? (
                  <span
                    className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'awaiting-test-sub' ? 'is-active' : ''}`}
                    onClick={() => toggleChipFilter('awaiting-test-sub')}
                    title="DEV xong nhưng chưa có sub TEST"
                  >
                    <AlertCircle size={13} style={{ marginRight: '4px' }} />
                    <strong>{analytics.awaitingTestSub}</strong>
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="glass-card stat-card stat-card--red">
            <div className="stat-card__icon stat-card__icon--red">
              <Code size={18} color="#f87171" />
            </div>
            <div className="stat-card__body">
              <span className="stat-card__label">Lập trình (DEV)</span>
              <div
                className={`stat-card__primary stat-card__primary-clickable ${activeChipFilter === 'incomplete-dev-stories' ? 'is-active' : ''}`}
                onClick={() => toggleChipFilter('incomplete-dev-stories')}
                title="Nhấp để lọc Story chưa hoàn thành DEV"
              >
                <span className="stat-card__number stat-card__number--red">
                  {analytics.incompleteDevStories}
                </span>
                <span className="stat-card__unit">story chưa HT</span>
              </div>
              <div className="stat-card__breakdown">
                <span
                  className={`stat-card__chip stat-card__chip--red stat-card__chip-clickable ${activeChipFilter === 'open-dev-subs' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('open-dev-subs')}
                  title="Sub-task DEV trong story chưa hoàn thành (mở/chưa xong)"
                >
                  <ListTodo size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.openDevSubsRemaining}</strong>
                </span>
                <span
                  className={`stat-card__chip stat-card__chip--red stat-card__chip-clickable ${activeChipFilter === 'open-bugs' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('open-bugs')}
                  title="Story có Bug mở (chưa đóng)"
                >
                  <Bug size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.openBugsRemaining}</strong>
                </span>
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'closed-bugs' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('closed-bugs')}
                  title="Story có Bug đã đóng"
                >
                  <CheckCircle2 size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.closedBugsCount}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="glass-card stat-card stat-card--purple">
            <div className="stat-card__icon stat-card__icon--purple">
              <Award size={18} color="#c084fc" />
            </div>
            <div className="stat-card__body">
              <span className="stat-card__label" title="Theo story — mỗi story một nhóm TEST">
                Kiểm thử (TEST)
              </span>
              <div
                className={`stat-card__primary stat-card__primary-clickable ${activeChipFilter === 'test-story-open' ? 'is-active' : ''}`}
                onClick={() => toggleChipFilter('test-story-open')}
                title="Nhấp để lọc Story chưa hoàn thành TEST"
              >
                <span className="stat-card__number stat-card__number--purple">
                  {analytics.testStoryOpen}
                </span>
                <span className="stat-card__unit">story chưa xong</span>
              </div>
              <div className="stat-card__breakdown">
                <span
                  className={`stat-card__chip stat-card__chip--purple stat-card__chip-clickable ${activeChipFilter === 'test-story-done' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('test-story-done')}
                  title="Nhấp để lọc Story đã hoàn thành TEST"
                >
                  <CheckCircle2 size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.testStoryAllDone}</strong>
                </span>
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'test-story-no-sub' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('test-story-no-sub')}
                  title="Nhấp để lọc Story chưa có sub TEST"
                >
                  <HelpCircle size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.testStoryNoSub}</strong>
                </span>
              </div>
            </div>
          </div>

          <div className="glass-card stat-card stat-card--green">
            <div className="stat-card__icon stat-card__icon--green">
              <Flame size={18} color="#34d399" />
            </div>
            <div className="stat-card__body">
              <span
                className="stat-card__label"
                title="Story DEV đã HT — đã verify TEST vs còn backlog"
              >
                Kết quả TEST
              </span>
              <div
                className={`stat-card__primary stat-card__primary-clickable ${activeChipFilter === 'test-verified-done' ? 'is-active' : ''}`}
                onClick={() => toggleChipFilter('test-verified-done')}
                title="Nhấp để lọc Story đã test xong"
              >
                <span className="stat-card__number stat-card__number--green">
                  {analytics.verifiedDone}
                </span>
                <span className="stat-card__unit">đã test xong</span>
              </div>
              <div className="stat-card__breakdown">
                {analytics.testPipelineTotal > 0 ? (
                  <span
                    className={`stat-card__chip stat-card__chip--green stat-card__chip-clickable ${activeChipFilter === 'dev-work-complete' ? 'is-active' : ''}`}
                    onClick={() => toggleChipFilter('dev-work-complete')}
                    title="Nhấp để lọc tất cả Story DEV HT"
                  >
                    <Percent size={13} style={{ marginRight: '4px' }} />
                    <strong>{analytics.testDonePercent}%</strong>
                  </span>
                ) : null}
                <span
                  className={`stat-card__chip stat-card__chip-clickable ${activeChipFilter === 'dev-work-complete' ? 'is-active' : ''}`}
                  onClick={() => toggleChipFilter('dev-work-complete')}
                  title="Nhấp để lọc tất cả Story DEV HT"
                >
                  <Code size={13} style={{ marginRight: '4px' }} />
                  <strong>{analytics.testPipelineTotal}</strong>
                </span>
              </div>
            </div>
          </div>
        </div>
        {/* 5. TICKET STORY BOARD GRID */}
        {loadingTasks && tasks.length === 0 ? (
          <div
            className="dashboard-initial-loading"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              padding: '3rem 0',
            }}
          >
            <Loader2 className="spinner" size={32} color="#6366f1" />
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '1rem' }}>
              Đang tải danh sách công việc từ Jira...
            </span>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="empty-state-box">
            <ListTodo
              size={36}
              color="var(--text-secondary)"
              style={{ marginBottom: '1rem', opacity: 0.5 }}
            />
            <h4 className="empty-state-box__title">Không tìm thấy công việc nào</h4>
            <p
              style={{
                color: 'var(--text-secondary)',
                fontSize: '0.8rem',
                margin: 0,
                textAlign: 'center',
              }}
            >
              {tasks.length === 0
                ? 'Hiện tại không có Story hoặc Task nào trong sprint hoạt động của dự án này.'
                : 'Hãy thử thay đổi điều kiện tìm kiếm hoặc thay đổi tab bộ lọc.'}
            </p>
          </div>
        ) : (
          <div
            className={`page-content-wrap page-content-wrap--row${loadingTasks && tasks.length > 0 ? ' page-content-wrap--refreshing' : ''}`}
          >
            {loadingTasks && tasks.length > 0 && <div className="page-refresh-bar" aria-hidden />}

            {/* LEFT COLUMN: MASTER LIST */}
            <div className="tester-task-list">
              {filteredTasks.map(task => (
                <TesterTaskCard
                  key={task.id}
                  task={task}
                  isActive={activeTask?.key === task.key}
                  isLight={isLight}
                  onSelect={handleSelectTask}
                  onOpenJira={openJiraTicket}
                />
              ))}
            </div>

            {/* RIGHT COLUMN: DETAIL PANEL */}
            <div className="tester-detail-panel">
              {!activeTask ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    opacity: 0.7,
                  }}
                >
                  <Layers
                    size={48}
                    color="var(--text-secondary)"
                    style={{ marginBottom: '1rem', opacity: 0.3 }}
                  />
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    Chọn một Story hoặc Task bên trái để xem chi tiết.
                  </span>
                </div>
              ) : activeDetailView ? (
                <div className="tester-detail-panel__body">
                  {/* Header Detail */}
                  <div className="tester-detail-header">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.75rem',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span
                          className="tester-detail-type-badge"
                          style={{
                            background: activeDetailView.detailTypeStyle.bg,
                            color: activeDetailView.detailTypeStyle.color,
                            border: activeDetailView.detailTypeStyle.border,
                          }}
                        >
                          {activeTask.issueType}
                        </span>
                        <JiraTicketKeyLink
                          issueKey={activeTask.key}
                          onOpen={openJiraTicket}
                          className="tester-detail-key jira-ticket-key-link"
                          style={{ color: activeDetailView.detailTypeStyle.color }}
                          showIcon
                        />
                        {activeTask.isSynthesized && (
                          <span className="tester-badge tester-badge--warn">Mồ côi</span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        {/* Dates */}
                        {(activeTask.startDate || activeTask.dueDate) && (
                          <span
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '3px',
                            }}
                          >
                            <Calendar size={11} />
                            {activeTask.startDate
                              ? activeTask.startDate.split('T')[0]
                              : '...'} -{' '}
                            {activeTask.dueDate ? activeTask.dueDate.split('T')[0] : '...'}
                          </span>
                        )}

                        <TicketStatusTransition
                          issueKey={activeTask.key}
                          currentStatus={activeTask.status}
                          apiFetch={apiFetch}
                          apiBaseUrl={API_BASE_URL}
                          canAct={canTransitionTicketFlag}
                          onStatusChanged={({ status, statusCategory }) => {
                            if (status) {
                              setTasks(prev =>
                                prev.map(t =>
                                  t.key === activeTask.key ? { ...t, status, statusCategory } : t
                                )
                              );
                            }
                            // Invalidate comment cache để force reload
                            const cached = detailsCacheRef.current.get(activeTask.key);
                            if (cached) {
                              detailsCacheRef.current.set(activeTask.key, { ...cached, comments: undefined });
                            }
                            void reloadCommentDetails();
                            // Fetch lại tasks ngay lập tức để đồng bộ với Jira
                            void fetchTesterTasks(false, true);
                          }}
                        />
                      </div>
                    </div>

                    <div className="tester-detail-title-row">
                      <h3 className="tester-detail-title">{detailSummary}</h3>
                      <div className="tester-story-create-actions">
                        {renderCreateChildButton('dev', 'DEV', '#6366f1', true)}
                        {renderCreateChildButton('bug', 'Bug', '#ef4444', true)}
                        {renderCreateChildButton('test', 'TEST', '#a855f7', true)}
                      </div>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.75rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        <div className="tester-detail-assignee">
                          <span>Gán cho:</span>
                          {canTransitionTicketFlag ? (
                            renderAssigneeField(activeTask.key, activeTask.assignee, {
                              showAvatar: true,
                              onChange: value => handleStoryAssigneeChange(value),
                            })
                          ) : activeTask.assignee ? (
                            <>
                              {activeTask.assignee.avatarUrl ? (
                                <img
                                  src={getAvatarUrl(activeTask.assignee.avatarUrl, API_BASE_URL)}
                                  alt={activeTask.assignee.displayName}
                                  style={{ width: '18px', height: '18px', borderRadius: '50%' }}
                                />
                              ) : (
                                <div className="avatar-fallback avatar-fallback--sm">
                                  {activeTask.assignee.displayName[0]}
                                </div>
                              )}
                              <strong>{activeTask.assignee.displayName}</strong>
                            </>
                          ) : (
                            <span style={{ color: 'var(--text-secondary)' }}>Chưa gán cho ai</span>
                          )}
                        </div>

                        {(activeTaskDetails?.creator || activeTask?.creator) && (
                          <span
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-secondary)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <span>• Tạo bởi:</span>
                            <strong className="text-body">
                              {activeTaskDetails?.creator || activeTask?.creator}
                              {activeTaskDetails?.creatorEmail || activeTask?.creatorEmail
                                ? ` (${activeTaskDetails?.creatorEmail || activeTask?.creatorEmail})`
                                : ''}
                            </strong>
                          </span>
                        )}
                      </div>

                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.65rem',
                          flexWrap: 'wrap',
                        }}
                      >
                        {activeTask.originalEstimate > 0 && (
                          <span className="tester-task-card__est" title="Estimate ban đầu">
                            Est: {(activeTask.originalEstimate / 3600).toFixed(1)}h
                          </span>
                        )}
                        <button
                          onClick={() => openJiraTicket(activeTask.key)}
                          className="copy-btn tester-jira-link-btn"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.72rem',
                            borderRadius: '6px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                          }}
                        >
                          <span>Xem trên Jira</span>
                          <ExternalLink size={11} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <TicketModalTabs
                    active={testerDetailTab}
                    onChange={setTesterDetailTab}
                    tabs={[
                      { id: 'content', label: 'Chi tiết' },
                      {
                        id: 'attachments',
                        label: 'Đính kèm',
                        badge:
                          attachmentCount != null && attachmentCount > 0
                            ? attachmentCount
                            : undefined,
                      },
                      {
                        id: 'comments',
                        label: 'Bình luận',
                        badge: commentCount != null && commentCount > 0 ? commentCount : undefined,
                      },
                    ]}
                  />

                  {testerDetailTab === 'content' && (
                    <>
                      <div className="tester-detail-block">
                        <div className="tester-detail-block__head">
                          <h5 className="tester-detail-block__title">Mô tả công việc</h5>
                          {canUpdateTicketFlag ? (
                            descriptionEditMode ? (
                              <div className="ticket-field-edit-actions">
                                <button
                                  type="button"
                                  className="ticket-field-cancel-btn"
                                  onClick={cancelDescriptionEdit}
                                  disabled={savingDescription}
                                >
                                  Hủy
                                </button>
                                <button
                                  type="button"
                                  className="btn-primary ticket-field-save-btn"
                                  onClick={() => void handleSaveDescription()}
                                  disabled={savingDescription || !descriptionDirty}
                                >
                                  {savingDescription ? (
                                    <Loader2 size={12} className="spinner" />
                                  ) : null}
                                  Lưu
                                </button>
                              </div>
                            ) : (
                              <TicketFieldEditButton
                                onClick={beginDescriptionEdit}
                                disabled={savingDescription}
                                iconOnly
                                title="Chỉnh sửa mô tả"
                              />
                            )
                          ) : null}
                        </div>
                        {canUpdateTicketFlag && descriptionEditMode ? (
                          <JiraRichComposer
                            key={`desc-${activeTask.key}`}
                            issueKey={activeTask.key}
                            apiBaseUrl={API_BASE_URL}
                            wiki={detailDescription}
                            images={descriptionImages}
                            onChange={({ wiki, images }) => {
                              setActiveTaskDetails(prev => ({
                                summary: prev?.summary ?? activeTask.summary ?? '',
                                description: wiki,
                                output: prev?.output ?? '',
                                creator: prev?.creator,
                                creatorEmail: prev?.creatorEmail,
                              }));
                              setDescriptionImages(images);
                            }}
                            disabled={savingDescription}
                            className="tester-detail-description ticket-field--composer"
                            minHeight={200}
                            placeholder="Soạn mô tả — chèn ảnh inline..."
                            hint="Ctrl+V dán screenshot."
                          />
                        ) : contentReady ? (
                          <JiraRichContent
                            key={activeTask.key}
                            content={detailDescription}
                            issueKey={activeTask.key}
                            apiBaseUrl={API_BASE_URL}
                            apiFetch={apiFetch}
                            eagerImages
                            className="tester-detail-description jira-rich-content--panel"
                          />
                        ) : (
                          <div className="tester-detail-description tester-detail-description--placeholder">
                            Đang tải mô tả…
                          </div>
                        )}
                      </div>

                      <div className="tester-detail-block">
                        <div className="tester-detail-block__head">
                          <h5 className="tester-detail-block__title">Output (Kết quả xử lý)</h5>
                          {canUpdateTicketFlag ? (
                            outputEditMode ? (
                              <div className="ticket-field-edit-actions">
                                <button
                                  type="button"
                                  className="ticket-field-cancel-btn"
                                  onClick={cancelOutputEdit}
                                  disabled={savingOutput}
                                >
                                  Hủy
                                </button>
                                <button
                                  type="button"
                                  className="btn-primary ticket-field-save-btn"
                                  onClick={() => void handleSaveOutput()}
                                  disabled={savingOutput || !outputDirty}
                                >
                                  {savingOutput ? <Loader2 size={12} className="spinner" /> : null}
                                  Lưu
                                </button>
                              </div>
                            ) : (
                              <TicketFieldEditButton
                                onClick={() => setOutputEditMode(true)}
                                disabled={savingOutput}
                                iconOnly
                                title="Chỉnh sửa output"
                              />
                            )
                          ) : null}
                        </div>
                        <TicketOutputField
                          value={detailOutput}
                          editing={canUpdateTicketFlag && outputEditMode}
                          disabled={savingOutput}
                          className="tester-detail-output"
                          onChange={next =>
                            setActiveTaskDetails(prev => ({
                              summary: prev?.summary ?? activeTask.summary ?? '',
                              description: prev?.description ?? detailDescription,
                              output: next,
                              creator: prev?.creator,
                              creatorEmail: prev?.creatorEmail,
                            }))
                          }
                        />
                      </div>

                      {activeDetailView.totalSubsCount > 0 && (
                        <div style={{ marginBottom: '1.5rem' }}>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: '0.72rem',
                              color: 'var(--text-secondary)',
                              marginBottom: '0.35rem',
                              fontWeight: 600,
                            }}
                          >
                            <span>Tiến độ subtask</span>
                            <span>
                              {activeDetailView.progressPercent}% (
                              {activeDetailView.completedSubsCount}/
                              {activeDetailView.totalSubsCount} hoàn thành)
                            </span>
                          </div>
                          <div className="tester-progress-track">
                            <div
                              style={{
                                height: '100%',
                                width: `${activeDetailView.progressPercent}%`,
                                background: 'linear-gradient(90deg, #6366f1, #34d399)',
                                transition: 'width 0.4s ease',
                              }}
                            />
                          </div>
                        </div>
                      )}

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                          gap: '1.25rem',
                          alignItems: 'start',
                        }}
                      >
                        {/* DEV COLUMN */}
                        <div className="tester-sub-column">
                          <div className="tester-sub-column__head">
                            <div
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                background: '#6366f1',
                              }}
                            />
                            <strong>Lập trình (Development)</strong>
                            <span
                              style={{
                                fontSize: '0.65rem',
                                color: 'var(--text-secondary)',
                                marginLeft: 'auto',
                              }}
                            >
                              {activeDetailView.devSubs.filter((s: any) => isDevTaskDone(s)).length}
                              /{activeDetailView.devSubs.length} Done
                            </span>
                          </div>

                          {activeDetailView.devSubs.length === 0 ? (
                            <div
                              style={{
                                padding: '1rem',
                                color: 'var(--text-secondary)',
                                fontSize: '0.75rem',
                                textAlign: 'center',
                                fontStyle: 'italic',
                              }}
                            >
                              Không có subtask DEV.
                            </div>
                          ) : (
                            activeDetailView.devSubs.map((sub: any) => {
                              const done = isDevTaskDone(sub);
                              const ip = isDevTaskInProgress(sub);
                              return (
                                <div
                                  key={sub.id}
                                  className={`tester-sub-item tester-sub-item--clickable${done ? ' is-done' : ''}`}
                                  {...subtaskCardProps(sub)}
                                >
                                  {renderSubtaskHead(sub, done, ip)}
                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: '0.5rem',
                                      flexWrap: 'wrap',
                                      fontSize: '0.68rem',
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <span>Gán:</span>
                                      {canTransitionTicketFlag ? (
                                        renderAssigneeField(sub.key, sub.assignee, {
                                          compact: true,
                                          stopPropagation: true,
                                        })
                                      ) : (
                                        <strong className="text-body">
                                          {sub.assignee ? sub.assignee.displayName : 'Chưa gán'}
                                        </strong>
                                      )}
                                    </span>
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.4rem',
                                        flexShrink: 0,
                                      }}
                                      onClick={e => e.stopPropagation()}
                                      onKeyDown={e => e.stopPropagation()}
                                    >
                                      {sub.originalEstimate > 0 && (
                                        <span className="tester-sub-est">
                                          Est: {(sub.originalEstimate / 3600).toFixed(1)}h
                                        </span>
                                      )}
                                      {renderSubtaskStatusControl(sub, done, ip)}
                                    </span>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>

                        {/* TEST COLUMN */}
                        <div className="tester-sub-column">
                          <div className="tester-sub-column__head">
                            <div
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                background: '#a855f7',
                              }}
                            />
                            <strong>Kiểm thử (Testing & Validation)</strong>
                            <span
                              style={{
                                fontSize: '0.65rem',
                                color: 'var(--text-secondary)',
                                marginLeft: 'auto',
                              }}
                            >
                              {
                                activeDetailView.testSubs.filter(
                                  (s: any) => s.statusCategory?.toLowerCase() === 'done'
                                ).length
                              }
                              /{activeDetailView.testSubs.length} Done
                            </span>
                          </div>

                          {activeDetailView.testSubs.length === 0 ? (
                            <div
                              style={{
                                padding: '1rem',
                                color: 'var(--text-secondary)',
                                fontSize: '0.75rem',
                                textAlign: 'center',
                                fontStyle: 'italic',
                              }}
                            >
                              Không có subtask TEST.
                            </div>
                          ) : (
                            activeDetailView.testSubs.map((sub: any) => {
                              const done = sub.statusCategory?.toLowerCase() === 'done';
                              const ip = sub.statusCategory?.toLowerCase() === 'indeterminate';

                              return (
                                <div
                                  key={sub.id}
                                  className={`tester-sub-item tester-sub-item--clickable${done ? ' is-done' : ''}`}
                                  style={{ gap: '0.5rem' }}
                                  {...subtaskCardProps(sub)}
                                >
                                  {renderSubtaskHead(sub, done, ip)}

                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: '0.5rem',
                                      flexWrap: 'wrap',
                                      fontSize: '0.68rem',
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <span>Gán:</span>
                                      {canTransitionTicketFlag ? (
                                        renderAssigneeField(sub.key, sub.assignee, {
                                          compact: true,
                                          stopPropagation: true,
                                          locked: isLockedTestSubtask(sub),
                                          displayAssignee: activeTask.assignee,
                                        })
                                      ) : (
                                        <strong className="text-body">
                                          {isLockedTestSubtask(sub) && activeTask.assignee
                                            ? activeTask.assignee.displayName
                                            : sub.assignee
                                              ? sub.assignee.displayName
                                              : 'Chưa gán'}
                                        </strong>
                                      )}
                                    </span>
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.4rem',
                                        flexShrink: 0,
                                      }}
                                      onClick={e => e.stopPropagation()}
                                      onKeyDown={e => e.stopPropagation()}
                                    >
                                      {sub.originalEstimate > 0 && (
                                        <span className="tester-sub-est">
                                          Est: {(sub.originalEstimate / 3600).toFixed(1)}h
                                        </span>
                                      )}
                                      {renderSubtaskStatusControl(sub, done, ip)}
                                    </span>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>

                        {/* BUG COLUMN */}
                        <div className="tester-sub-column">
                          <div className="tester-sub-column__head">
                            <div
                              style={{
                                width: '6px',
                                height: '6px',
                                borderRadius: '50%',
                                background: '#ef4444',
                              }}
                            />
                            <strong>Lỗi phát sinh (Bugs in Dev)</strong>
                            <span
                              style={{
                                fontSize: '0.65rem',
                                color: 'var(--text-secondary)',
                                marginLeft: 'auto',
                              }}
                            >
                              {
                                activeDetailView.bugSubs.filter(
                                  (s: any) => isDevTaskDone(s)
                                ).length
                              }
                              /{activeDetailView.bugSubs.length} Done
                            </span>
                          </div>

                          {activeDetailView.bugSubs.length === 0 ? (
                            <div
                              style={{
                                padding: '1rem',
                                color: 'var(--text-secondary)',
                                fontSize: '0.75rem',
                                textAlign: 'center',
                                fontStyle: 'italic',
                              }}
                            >
                              Không có lỗi phát sinh.
                            </div>
                          ) : (
                            activeDetailView.bugSubs.map((sub: any) => {
                              const done = isDevTaskDone(sub);
                              const ip = isDevTaskInProgress(sub);

                              return (
                                <div
                                  key={sub.id}
                                  className={`tester-sub-item tester-sub-item--clickable${done ? ' is-done' : ''}`}
                                  style={{ gap: '0.5rem' }}
                                  {...subtaskCardProps(sub)}
                                >
                                  {renderSubtaskHead(sub, done, ip)}

                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      gap: '0.5rem',
                                      flexWrap: 'wrap',
                                      fontSize: '0.68rem',
                                      color: 'var(--text-secondary)',
                                    }}
                                  >
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.35rem',
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <span>Gán:</span>
                                      {canTransitionTicketFlag ? (
                                        renderAssigneeField(sub.key, sub.assignee, {
                                          compact: true,
                                          stopPropagation: true,
                                        })
                                      ) : (
                                        <strong className="text-body">
                                          {sub.assignee ? sub.assignee.displayName : 'Chưa gán'}
                                        </strong>
                                      )}
                                    </span>
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.4rem',
                                        flexShrink: 0,
                                      }}
                                      onClick={e => e.stopPropagation()}
                                      onKeyDown={e => e.stopPropagation()}
                                    >
                                      {sub.originalEstimate > 0 && (
                                        <span className="tester-sub-est">
                                          Est: {(sub.originalEstimate / 3600).toFixed(1)}h
                                        </span>
                                      )}
                                      {renderSubtaskStatusControl(sub, done, ip)}
                                    </span>
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {testerDetailTab === 'attachments' && (
                    <div className="ticket-modal-tab-panel">
                      <TicketAttachmentList
                        issueKey={activeTask.key}
                        apiFetch={apiFetch}
                        apiBaseUrl={API_BASE_URL}
                        onCountChange={setAttachmentCount}
                      />
                    </div>
                  )}

                  {testerDetailTab === 'comments' && (
                    <div className="ticket-modal-tab-panel ticket-modal-tab-panel--comments">
                      <TicketCommentList
                        comments={commentDetails?.comments}
                        fillAvailable
                        issueKey={actionIssueKey}
                        apiBaseUrl={API_BASE_URL}
                        apiFetch={apiFetch}
                        eagerImages={testerDetailTab === 'comments'}
                        onOpenJiraTicket={openJiraTicket}
                        className="ticket-comments--in-panel"
                        hint={
                          commentDetails?.commentsIncludeRelated
                            ? commentDetails.isSubtask
                              ? `Gồm bình luận từ story cha${commentDetails.parentKey ? ` (${commentDetails.parentKey})` : ''} và các sub-task khác.`
                              : 'Gồm bình luận từ story và các sub-task liên quan.'
                            : undefined
                        }
                      />

                      {actionIssueKey ? (
                        <TicketActionPanel
                          issueKey={actionIssueKey}
                          apiFetch={apiFetch}
                          apiBaseUrl={API_BASE_URL}
                          canAct={canLogworkTicketFlag}
                          onSuccess={() => {
                            void reloadCommentDetails();
                            void fetchTesterTasks(false, true);
                          }}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <TesterCreateChildModal
        ref={createChildModalRef}
        activeTask={activeTask}
        projectUsers={projectUsers}
        myEmail={myEmail}
        userHasJiraToken={userHasJiraToken}
        canCreateChildTicket={canCreateChildTicketFlag}
        apiFetch={apiFetch}
        apiBaseUrl={API_BASE_URL}
        onCreated={() => void fetchTesterTasks(false, true)}
      />

      <TicketPreviewModal
        open={previewSubtaskOpen}
        onClose={() => {
          setPreviewSubtaskOpen(false);
          setPreviewSubtask(null);
        }}
        ticket={previewSubtask}
        apiFetch={apiFetch}
        apiBaseUrl={API_BASE_URL}
        openJiraTicket={openJiraTicket}
        currentUser={currentUser}
        selectedMonth={selectedMonth}
        projectUsers={projectUsers}
        parentStoryAssignee={activeTask?.assignee ?? null}
        isAssigneeLocked={
          previewSubtask ? isLockedTestSubtask(previewSubtask) : false
        }
        onAssigneeChange={handleAssigneeChange}
        savingAssigneeKey={savingAssigneeKey}
        onTicketUpdated={() => void fetchTesterTasks(false, true)}
      />
    </main>
  );
}
