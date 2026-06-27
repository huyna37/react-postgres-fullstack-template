import {
  AlertTriangle,
  ArrowLeft,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Clock,
  Code,
  Edit3,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  Download,
  Flag,
  Info,
  LayoutGrid,
  List,
  Loader2,
  PenTool,
  Plus,
  ShieldCheck,
  Sparkles,
  Tag,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Users,
} from 'lucide-react';
import React, { startTransition, useEffect, useState, useRef } from 'react';
import * as XLSX from 'xlsx';

import CommonModal from '../components/CommonModal';
import JiraRichComposer from '../components/JiraRichComposer';
import { useDeferredUnmount } from '../hooks/useDeferredUnmount';
import type { User } from '../types';
import type { ComposerInlineImage } from '../utils/jiraImages';
import { serializeJiraImages } from '../utils/jiraImages';
import { hasJiraToken, MISSING_JIRA_TOKEN_HINT } from '../utils/jiraToken';
import { buildManualJiraTicket } from '../utils/manualJiraTicket';
import { showConfirm, showError, showSuccess } from '../utils/swal';

interface PlanningProps {
  apiFetch: (url: string, options?: any) => Promise<Response>;
  API_BASE_URL: string;
  openJiraTicket: (key: string) => void;
  currentUser: User | null;
  projectUsers?: any[];
}

type PageMode = 'planning' | 'bulk-stories' | 'create-task';

interface SubtaskProposal {
  summary: string;
  description: string;
  descriptionImages?: ComposerInlineImage[];
  issueType: string;
  estimateHours: number;
  assignee: string;
}

interface TicketProposal {
  summary: string;
  description: string;
  descriptionImages?: ComposerInlineImage[];
  issueType: string;
  estimateHours: number;
  assignee: string;
  subtasks: SubtaskProposal[];
}

function memberRoleShort(role?: string): string {
  if (role === 'ba') return 'BA';
  if (role === 'tester') return 'Tester';
  return 'Dev';
}

function buildStoryOwnerOptions(
  activeUsers: { accountId: string; displayName?: string; role?: string }[],
  selectedMembers: string[],
  currentAssignee?: string
) {
  const ids = new Set<string>();
  for (const id of selectedMembers) ids.add(id);
  if (currentAssignee) ids.add(currentAssignee);
  if (ids.size === 0) {
    activeUsers.forEach(u => ids.add(u.accountId));
  }
  const roleOrder: Record<string, number> = { tester: 0, ba: 1, developer: 2 };
  return Array.from(ids)
    .map(id => activeUsers.find(u => u.accountId === id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .sort((a, b) => {
      const ra = roleOrder[a.role || ''] ?? 3;
      const rb = roleOrder[b.role || ''] ?? 3;
      if (ra !== rb) return ra - rb;
      return (a.displayName || '').localeCompare(b.displayName || '', 'vi');
    });
}

function wikiToPlainPreview(wiki: string, maxLen = 140): string {
  const plain = String(wiki || '')
    .replace(/![^!\n]+!/g, '[ảnh]')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^h[1-6]\.\s*/gm, '')
    .replace(/\n+/g, ' ')
    .trim();
  if (!plain) return 'Không có mô tả.';
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}…` : plain;
}

type BulkStoryItem = { title: string; description: string };

const BULK_STORIES_JSON_EXAMPLE = `[
  { "title": "Báo cáo doanh thu trạm", "description": "Export Excel, filter theo ngày" }
]`;

function parseBulkStoriesJson(raw: string): BulkStoryItem[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('JSON trống.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('JSON không hợp lệ. Kiểm tra dấu ngoặc và dấu phẩy.');
  }

  let items: unknown[] = [];
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { stories?: unknown[] }).stories)
  ) {
    items = (parsed as { stories: unknown[] }).stories;
  } else {
    throw new Error('JSON phải là mảng hoặc object có field "stories".');
  }

  const result: BulkStoryItem[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const title = item.trim();
      if (title) result.push({ title, description: '' });
      continue;
    }
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const title = String(row.title ?? row.summary ?? row.name ?? '').trim();
      const description = String(row.description ?? row.desc ?? row.detail ?? '').trim();
      if (title) result.push({ title, description });
    }
  }

  if (result.length === 0) {
    throw new Error('Không tìm thấy story hợp lệ (cần title hoặc summary).');
  }

  return result;
}

const Planning: React.FC<PlanningProps> = ({
  apiFetch,
  API_BASE_URL,
  openJiraTicket,
  currentUser,
  projectUsers = [],
}) => {
  const userHasJiraToken = hasJiraToken(currentUser);
  const [pageMode, setPageMode] = useState<PageMode>('bulk-stories');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Create Task state ───────────────────────────────────────────────
  const [ctContext, setCtContext] = useState('');
  const [ctRole, setCtRole] = useState('DEV lead');
  const [ctTicketType, setCtTicketType] = useState('Task');
  const [ctAssignee, setCtAssignee] = useState('');
  const [ctLoading, setCtLoading] = useState(false);
  const [ctPushing, setCtPushing] = useState(false);
  const [ctTicket, setCtTicket] = useState<any>(null);
  const [ctCopied, setCtCopied] = useState(false);
  const [ctOriginalEstimate, setCtOriginalEstimate] = useState('');
  const [ctStartDate, setCtStartDate] = useState('');
  const [ctDueDate, setCtDueDate] = useState('');
  const [ctUseAi, setCtUseAi] = useState(false);
  const [ctCreateAutoSubTasks, setCtCreateAutoSubTasks] = useState(false);
  const [ctSubTaskDevAssignee, setCtSubTaskDevAssignee] = useState('');
  const [ctSubTaskTestAssignee, setCtSubTaskTestAssignee] = useState('');
  const [ctSubTaskStartDate, setCtSubTaskStartDate] = useState('');
  const [ctSubTaskDueDate, setCtSubTaskDueDate] = useState('');
  const [ctRewritingFields, setCtRewritingFields] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (projectUsers.length > 0) {
      if (!ctSubTaskDevAssignee) setCtSubTaskDevAssignee(projectUsers[0].accountId);
      if (!ctSubTaskTestAssignee) setCtSubTaskTestAssignee(projectUsers[0].accountId);
      if (!ctAssignee) setCtAssignee(projectUsers[0].displayName);
    }
  }, [projectUsers]);

  const handleCtGenerate = async () => {
    if (!ctContext.trim()) return;

    if (!ctUseAi) {
      const manual = buildManualJiraTicket({
        context: ctContext,
        ticketType: ctTicketType,
        assignee: ctAssignee,
        createAutoSubTasks: ctCreateAutoSubTasks,
      });
      setCtTicket({
        ...manual,
        id: Date.now().toString(),
        status: 'To Do',
      });
      return;
    }

    setCtLoading(true);
    setCtTicket(null);
    try {
      const selectedUser = projectUsers.find((u: any) => u.displayName === ctAssignee);
      const assigneeId = selectedUser ? selectedUser.accountId : ctAssignee;
      const response = await apiFetch(`${API_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: ctContext,
          role: ctRole,
          assignee: ctAssignee,
          assigneeId,
          ticketType: ctTicketType,
          createAutoSubTasks: ctCreateAutoSubTasks,
          subTaskDevAssignee: ctSubTaskDevAssignee,
          subTaskTestAssignee: ctSubTaskTestAssignee,
          subTaskStartDate: ctSubTaskStartDate,
          subTaskDueDate: ctSubTaskDueDate,
          startDate: ctStartDate,
          dueDate: ctDueDate,
          originalEstimate: ctOriginalEstimate,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to generate ticket');
      }
      const data = await response.json();
      setCtTicket({
        ...data,
        id: Date.now().toString(),
        status: 'To Do',
        acceptanceCriteria: data.acceptanceCriteria || [],
        technicalNotes: data.technicalNotes || [],
        risks: data.risks || [],
        subTickets: data.subTickets || [],
      });
    } catch (error: any) {
      showError(error.message || 'Không thể kết nối đến server.');
    } finally {
      setCtLoading(false);
    }
  };

  const handleCtPush = async () => {
    if (!ctTicket) return;
    if (!userHasJiraToken) {
      showError(MISSING_JIRA_TOKEN_HINT);
      return;
    }
    setCtPushing(true);
    try {
      const selectedUser = projectUsers.find((u: any) => u.displayName === ctAssignee);
      const assigneeId = selectedUser ? selectedUser.accountId : ctAssignee;
      const response = await apiFetch(`${API_BASE_URL}/api/push-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket: ctTicket,
          assigneeId,
          startDate: ctStartDate || null,
          dueDate: ctDueDate || null,
          originalEstimate: ctOriginalEstimate || null,
          createAutoSubTasks: ctCreateAutoSubTasks,
          subTaskDevAssignee: ctSubTaskDevAssignee,
          subTaskTestAssignee: ctSubTaskTestAssignee,
          subTaskStartDate: ctSubTaskStartDate || null,
          subTaskDueDate: ctSubTaskDueDate || null,
        }),
      });
      const data = await response.json();
      if (data.success) {
        showSuccess(`Đã tạo ticket thành công: ${data.key}`);
        setCtTicket({ ...ctTicket, jiraKey: data.key });
      } else {
        showError(data.error || 'Đẩy ticket thất bại');
      }
    } catch {
      showError('Lỗi mạng khi đẩy ticket');
    } finally {
      setCtPushing(false);
    }
  };

  const handleCtAiRewrite = async (fieldType: string, currentContent: string | string[]) => {
    if (!currentContent || (Array.isArray(currentContent) && currentContent.length === 0)) return;
    const contentToRewrite = Array.isArray(currentContent)
      ? currentContent.join('\n')
      : currentContent;
    setCtRewritingFields(prev => ({ ...prev, [fieldType]: true }));
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/generate/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldType, currentContent: contentToRewrite }),
      });
      if (response.ok) {
        const data = await response.json();
        const rewritten = data.rewritten;
        if (Array.isArray(currentContent)) {
          setCtTicket((prev: any) =>
            prev
              ? { ...prev, [fieldType]: rewritten.split('\n').filter((s: string) => s.trim()) }
              : prev
          );
        } else {
          setCtTicket((prev: any) => (prev ? { ...prev, [fieldType]: rewritten } : prev));
        }
      }
    } catch {
      /* silent */
    } finally {
      setCtRewritingFields(prev => ({ ...prev, [fieldType]: false }));
    }
  };

  const updateCtField = (field: string, value: any) =>
    setCtTicket((prev: any) => (prev ? { ...prev, [field]: value } : prev));
  const updateCtSubTicket = (idx: number, field: string, value: any) => {
    if (!ctTicket?.subTickets) return;
    const subs = [...ctTicket.subTickets];
    subs[idx] = { ...subs[idx], [field]: value };
    setCtTicket((prev: any) => ({ ...prev, subTickets: subs }));
  };
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [activeUsers, setActiveUsers] = useState<any[]>([]);

  // Step 1: Input details
  const [planName, setPlanName] = useState('');
  const [startDate, setStartDate] = useState(() => {
    // Default: today
    return new Date().toISOString().split('T')[0];
  });
  const [dueDate, setDueDate] = useState(() => {
    // Default: last day of current month
    const d = new Date();
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return lastDay.toISOString().split('T')[0];
  });
  const [storyCount, setStoryCount] = useState<number | ''>(1);
  const [goal, setGoal] = useState(
    'Phát triển module báo cáo doanh thu trạm, đồng bộ dữ liệu giao dịch sang bảng mới, fix các bug tồn đọng.'
  );
  const [bulkStoryList, setBulkStoryList] = useState<BulkStoryItem[]>([
    { title: '', description: '' },
  ]);
  const [bulkJsonModalOpen, setBulkJsonModalOpen] = useState(false);
  const [bulkJsonInput, setBulkJsonInput] = useState(BULK_STORIES_JSON_EXAMPLE);
  const bulkJsonModalMounted = useDeferredUnmount(bulkJsonModalOpen);
  const [includeBa, setIncludeBa] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [epicMode, setEpicMode] = useState<'create' | 'existing' | 'none'>('existing');
  const [selectedEpicKey, setSelectedEpicKey] = useState<string>('');
  const [existingEpics, setExistingEpics] = useState<any[]>([]);
  const [loadingEpics, setLoadingEpics] = useState(false);
  /** Planning chỉ dùng Story → Sub-task (DEV/TEST/BA), không tạo Bug */
  const PLANNING_PARENT_TYPE = 'Story';

  // Step 2: AI Proposal
  const [proposedTickets, setProposedTickets] = useState<TicketProposal[]>([]);
  const [refineText, setRefineText] = useState('');
  const [refining, setRefining] = useState(false);
  const [balancing, setBalancing] = useState(false);
  const [storyViewMode, setStoryViewMode] = useState<'grid' | 'list'>('grid');
  const [workloadOpen, setWorkloadOpen] = useState(false);
  const [editingStoryIdx, setEditingStoryIdx] = useState<number | null>(null);
  const editStoryModalMounted = useDeferredUnmount(editingStoryIdx !== null);
  const editingTicket = editingStoryIdx !== null ? proposedTickets[editingStoryIdx] : null;

  const applyProposedTickets = (tickets: TicketProposal[]) => {
    setProposedTickets(tickets);
    if (tickets.length >= 3) setWorkloadOpen(false);
  };

  const subRoleMeta = (summary: string) => {
    if (/^\[BA\]/i.test(summary))
      return { label: 'BA', bg: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' };
    if (/^\[TEST\]/i.test(summary))
      return { label: 'TEST', bg: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa' };
    return { label: 'DEV', bg: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' };
  };

  // Step 3: Push status
  const [createdKeys, setCreatedKeys] = useState<string[]>([]);

  useEffect(() => {
    // Load active users to select team members
    apiFetch(`${API_BASE_URL}/api/users/active`)
      .then(res => res.json())
      .then(data => {
        setActiveUsers(data);
      })
      .catch(err => console.error('Failed to load active users:', err));
  }, []);

  useEffect(() => {
    if (epicMode === 'existing' && existingEpics.length === 0) {
      setLoadingEpics(true);
      apiFetch(`${API_BASE_URL}/api/epics`)
        .then(res => res.json())
        .then(data => {
          if (data && Array.isArray(data.epics)) {
            setExistingEpics(data.epics);
          }
        })
        .catch(err => console.error('Failed to load existing epics:', err))
        .finally(() => setLoadingEpics(false));
    }
  }, [epicMode]);

  const handleToggleMember = (accountId: string) => {
    setSelectedMembers(prev =>
      prev.includes(accountId) ? prev.filter(id => id !== accountId) : [...prev, accountId]
    );
  };

  const handleGeneratePlan = async () => {
    if (epicMode === 'create' && !planName.trim()) {
      showError('Vui lòng nhập tên Epic mới.');
      return;
    }
    if (epicMode === 'existing' && !selectedEpicKey) {
      showError('Vui lòng chọn Epic có sẵn.');
      return;
    }
    if (!goal.trim()) {
      showError('Vui lòng nhập mô tả mục tiêu Epic.');
      return;
    }
    if (selectedMembers.length === 0) {
      showError('Vui lòng chọn ít nhất 1 thành viên tham gia.');
      return;
    }

    setLoading(true);
    try {
      const selectedUserInfo = activeUsers.filter(u => selectedMembers.includes(u.accountId));
      const response = await apiFetch(`${API_BASE_URL}/api/planning/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planName,
          goal,
          storyCount: storyCount ? Number(storyCount) : undefined,
          members: selectedUserInfo,
          taskTypes: [PLANNING_PARENT_TYPE, 'Sub-task'],
          includeBa,
        }),
      });

      if (!response.ok) {
        throw new Error('Không thể phân tích mục tiêu.');
      }

      const data = await response.json();
      applyProposedTickets(data.tickets || []);
      setStep(2);
      showSuccess('AI đã lập kế hoạch thành công!');
    } catch (error) {
      showError('Gặp lỗi khi tạo kế hoạch với AI.');
    } finally {
      setLoading(false);
    }
  };

  const handleApplyBulkJson = () => {
    try {
      const stories = parseBulkStoriesJson(bulkJsonInput);
      if (stories.length > 50) {
        showError('Hệ thống chỉ hỗ trợ nạp tối đa 50 đầu việc một lần để đảm bảo ổn định. Vui lòng chia nhỏ JSON.');
        return;
      }
      setBulkStoryList(stories);
      setBulkJsonModalOpen(false);
      showSuccess(`Đã nạp ${stories.length} story từ JSON.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Không thể đọc JSON.';
      showError(msg);
    }
  };

  const handleDownloadTemplate = () => {
    const ws = XLSX.utils.json_to_sheet([
      { 'Tên Story': 'Tạo API đăng nhập', 'Mô tả': 'Dùng Google OAuth' },
      { 'Tên Story': 'Giao diện Quên mật khẩu', 'Mô tả': 'Cho phép user gửi email reset pass' },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stories');
    XLSX.writeFile(wb, 'Story_Template.xlsx');
  };

  const handleExcelImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws);
        const parsedStories = data
          .map((row: any) => ({
            title: row['Tên Story'] || row['Title'] || row['Summary'] || row['Tên'] || '',
            description: row['Mô tả'] || row['Description'] || row['Chi tiết'] || '',
          }))
          .filter((s) => s.title.trim() !== '');

        if (parsedStories.length > 50) {
          showError('Hệ thống chỉ hỗ trợ import tối đa 50 đầu việc một lần để đảm bảo ổn định. Vui lòng chia nhỏ file Excel.');
          if (fileInputRef.current) fileInputRef.current.value = '';
          return;
        }

        if (parsedStories.length > 0) {
          setBulkStoryList(parsedStories);
          showSuccess(`Đã nạp ${parsedStories.length} story từ Excel.`);
        } else {
          showError('Không tìm thấy dữ liệu hợp lệ trong file Excel. Cần có cột "Tên Story".');
        }
      } catch (error) {
        showError('Lỗi khi đọc file Excel.');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsBinaryString(file);
  };

  const handleGeneratePlanBulk = async () => {
    if (epicMode === 'create' && !planName.trim()) {
      showError('Vui lòng nhập tên Epic mới.');
      return;
    }
    if (epicMode === 'existing' && !selectedEpicKey) {
      showError('Vui lòng chọn Epic có sẵn.');
      return;
    }
    if (selectedMembers.length === 0) {
      showError('Vui lòng chọn ít nhất 1 thành viên tham gia.');
      return;
    }

    if (!useAi) {
      const validStories = bulkStoryList.filter(s => s.title.trim().length > 0);
      if (validStories.length === 0) {
        showError('Vui lòng nhập ít nhất 1 Story hợp lệ.');
        return;
      }

      const defaultTester = memberByRole('tester');
      const defaultDev = memberByRole('developer');
      const defaultBa = memberByRole('ba');

      const tickets: TicketProposal[] = validStories.map(story => {
        const subtasks: SubtaskProposal[] = [];
        if (includeBa) {
          subtasks.push({
            summary: `[BA] Phân tích & Tài liệu — ${story.title}`,
            description: 'Phân tích yêu cầu và viết tài liệu.',
            issueType: 'Sub-task',
            estimateHours: 8,
            assignee: defaultBa,
          });
        }
        subtasks.push({
          summary: `[DEV] Triển khai — ${story.title}`,
          description: 'Phát triển tính năng',
          issueType: 'Sub-task',
          estimateHours: 16,
          assignee: defaultDev,
        });
        subtasks.push({
          summary: `[TEST] Kiểm thử — ${story.title}`,
          description: 'Kiểm thử tính năng',
          issueType: 'Sub-task',
          estimateHours: 8,
          assignee: defaultTester,
        });

        return {
          summary: story.title,
          description: story.description || story.title,
          issueType: PLANNING_PARENT_TYPE,
          estimateHours: includeBa ? 32 : 24,
          assignee: defaultTester,
          subtasks,
        };
      });

      applyProposedTickets(tickets);
      setStep(2);
      showSuccess('Đã tạo danh sách Story!');
      return;
    }

    const storiesArray = bulkStoryList
      .filter(s => s.title.trim().length > 0)
      .map(s => `${s.title}${s.description.trim() ? `\nMô tả chi tiết: ${s.description}` : ''}`);

    if (storiesArray.length === 0) {
      showError('Vui lòng nhập ít nhất 1 Story hợp lệ.');
      return;
    }

    setLoading(true);
    try {
      const selectedUserInfo = activeUsers.filter(u => selectedMembers.includes(u.accountId));
      const response = await apiFetch(`${API_BASE_URL}/api/planning/generate-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planName,
          stories: storiesArray,
          members: selectedUserInfo,
          includeBa,
        }),
      });

      if (!response.ok) {
        throw new Error('Không thể phân tích mục tiêu.');
      }

      const data = await response.json();
      applyProposedTickets(data.tickets || []);
      setStep(2);
      showSuccess('AI đã lập kế hoạch thành công!');
    } catch (error) {
      showError('Gặp lỗi khi tạo kế hoạch với AI.');
    } finally {
      setLoading(false);
    }
  };

  // Refine Plan via Chat
  const handleRefinePlan = async () => {
    if (!refineText.trim()) return;
    setRefining(true);
    try {
      const selectedUserInfo = activeUsers.filter(u => selectedMembers.includes(u.accountId));
      const response = await apiFetch(`${API_BASE_URL}/api/planning/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planName,
          goal: `Dựa trên bản nháp kế hoạch hiện tại:\n${JSON.stringify(proposedTickets, null, 2)}\n\nHãy điều chỉnh kế hoạch theo yêu cầu sau:\n${refineText}`,
          members: selectedUserInfo,
          taskTypes: [PLANNING_PARENT_TYPE, 'Sub-task'],
          includeBa,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        applyProposedTickets(data.tickets || []);
        setRefineText('');
        showSuccess('Đã cập nhật kế hoạch theo yêu cầu!');
      }
    } catch (e) {
      showError('Lỗi điều chỉnh kế hoạch.');
    } finally {
      setRefining(false);
    }
  };

  // Calculate workloads for each member
  const workloads = React.useMemo(() => {
    const map: Record<string, number> = {};
    // Pre-populate members with 0
    selectedMembers.forEach(id => {
      map[id] = 0;
    });

    proposedTickets.forEach(t => {
      if (t.assignee && selectedMembers.includes(t.assignee)) {
        // Main ticket estimate (excluding subtasks estimate if they exist, or count everything?)
        // In JIRA, workloads are normally aggregate sum of either subtasks or parent issues
        // Let's sum both parent estimates (if they don't have subtasks) and subtask estimates
        if (t.subtasks && t.subtasks.length > 0) {
          t.subtasks.forEach(sub => {
            if (sub.assignee && selectedMembers.includes(sub.assignee)) {
              map[sub.assignee] = (map[sub.assignee] || 0) + (sub.estimateHours || 0);
            }
          });
        } else {
          map[t.assignee] = (map[t.assignee] || 0) + (t.estimateHours || 0);
        }
      }
    });

    return map;
  }, [proposedTickets, selectedMembers]);

  const workloadByRole = React.useMemo(() => {
    const roles = ['ba', 'developer', 'tester'] as const;
    const labels: Record<string, string> = { ba: 'BA', developer: 'Developer', tester: 'Tester' };
    return roles
      .map(role => {
        const ids = selectedMembers.filter(
          id => activeUsers.find(u => u.accountId === id)?.role === role
        );
        const members = ids.map(id => {
          const user = activeUsers.find(u => u.accountId === id);
          const hrs = workloads[id] || 0;
          return { id, name: user?.displayName || id, hrs };
        });
        const max = Math.max(...members.map(m => m.hrs), 0);
        const positive = members.map(m => m.hrs).filter(h => h > 0);
        const min = positive.length ? Math.min(...positive) : 0;
        const imbalanced =
          members.length >= 2 && max > 0 && (min === 0 || (min > 0 && max / min > 1.35));
        return { role, label: labels[role], members, imbalanced };
      })
      .filter(g => g.members.length > 0);
  }, [workloads, selectedMembers, activeUsers]);

  const hasWorkloadImbalance = workloadByRole.some(g => g.imbalanced);

  const handleBalanceWorkload = async () => {
    setBalancing(true);
    try {
      const selectedUserInfo = activeUsers.filter(u => selectedMembers.includes(u.accountId));
      const response = await apiFetch(`${API_BASE_URL}/api/planning/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickets: proposedTickets, members: selectedUserInfo }),
      });
      if (!response.ok) throw new Error('balance failed');
      const data = await response.json();
      applyProposedTickets(data.tickets || []);
      showSuccess('Đã cân bằng phân công theo role.');
    } catch {
      showError('Không cân bằng được workload.');
    } finally {
      setBalancing(false);
    }
  };

  // Edit fields
  const handleUpdateTicket = (index: number, field: keyof TicketProposal, value: any) => {
    setProposedTickets(prev => {
      const clone = [...prev];
      const updatedTicket = { ...clone[index], [field]: value } as any;

      // Auto-sync [TEST] subtask assignee if the parent Story assignee is updated
      if (field === 'assignee' && updatedTicket.subtasks) {
        updatedTicket.subtasks = updatedTicket.subtasks.map((sub: any) => {
          if (/^\[TEST\]/i.test(sub.summary)) {
            return { ...sub, assignee: value };
          }
          return sub;
        });
      }

      clone[index] = updatedTicket;
      return clone;
    });
  };

  const handleUpdateTicketDescription = (
    index: number,
    payload: { wiki: string; images: ComposerInlineImage[] }
  ) => {
    setProposedTickets(prev => {
      const clone = [...prev];
      clone[index] = {
        ...clone[index],
        description: payload.wiki,
        descriptionImages: payload.images,
      };
      return clone;
    });
  };

  const handleUpdateSubtaskDescription = (
    tIndex: number,
    sIndex: number,
    payload: { wiki: string; images: ComposerInlineImage[] }
  ) => {
    setProposedTickets(prev => {
      const clone = [...prev];
      const subtasks = [...clone[tIndex].subtasks];
      subtasks[sIndex] = {
        ...subtasks[sIndex],
        description: payload.wiki,
        descriptionImages: payload.images,
      };
      clone[tIndex] = { ...clone[tIndex], subtasks };
      return clone;
    });
  };

  const handleUpdateSubtask = (
    tIndex: number,
    sIndex: number,
    field: keyof SubtaskProposal,
    value: any
  ) => {
    setProposedTickets(prev => {
      const clone = [...prev];
      const subtasks = [...clone[tIndex].subtasks];
      const updatedSub = { ...subtasks[sIndex], [field]: value } as any;

      // If the subtask summary is changed to a [TEST] task, force its assignee to match the parent's assignee
      if (field === 'summary' && /^\[TEST\]/i.test(value)) {
        updatedSub.assignee = clone[tIndex].assignee;
      }

      subtasks[sIndex] = updatedSub;
      clone[tIndex] = { ...clone[tIndex], subtasks };
      return clone;
    });
  };

  const handleDeleteTicket = (index: number) => {
    setProposedTickets(prev => prev.filter((_, i) => i !== index));
  };

  const handleDeleteSubtask = (tIndex: number, sIndex: number) => {
    setProposedTickets(prev => {
      const clone = [...prev];
      clone[tIndex] = {
        ...clone[tIndex],
        subtasks: clone[tIndex].subtasks.filter((_, i) => i !== sIndex),
      };
      return clone;
    });
  };

  const memberByRole = (role: string) =>
    activeUsers.find(u => selectedMembers.includes(u.accountId) && u.role === role)?.accountId ||
    selectedMembers[0] ||
    '';

  const handleAddTicket = () => {
    const storyTitle = 'Chức năng mới';
    const defaultTester = memberByRole('tester');
    const newTicket: TicketProposal = {
      summary: storyTitle,
      description: 'Mô tả chức năng: user cần làm được gì (không mô tả việc BA/Dev/Test ở đây).',
      issueType: PLANNING_PARENT_TYPE,
      estimateHours: 32,
      assignee: defaultTester,
      subtasks: [
        {
          summary: `[BA] Làm tài liệu / spec — ${storyTitle}`,
          description: 'Phân tích, viết spec, acceptance criteria',
          issueType: 'Sub-task',
          estimateHours: 8,
          assignee: memberByRole('ba'),
        },
        {
          summary: `[DEV] Triển khai — ${storyTitle}`,
          description: 'Phát triển code, API, UI',
          issueType: 'Sub-task',
          estimateHours: 16,
          assignee: memberByRole('developer'),
        },
        {
          summary: `[TEST] Kiểm thử & checklist — ${storyTitle}`,
          description: 'Checklist, test nghiệp vụ, xác nhận done',
          issueType: 'Sub-task',
          estimateHours: 8,
          assignee: defaultTester,
        },
      ],
    };
    setProposedTickets(prev => [...prev, newTicket]);
  };

  const handleAddSubtask = (tIndex: number) => {
    const storySummary = proposedTickets[tIndex]?.summary || 'Story';
    const newSub: SubtaskProposal = {
      summary: `[DEV] Triển khai — ${storySummary}`,
      description: 'Hạng mục phát triển kỹ thuật',
      issueType: 'Sub-task',
      estimateHours: 6,
      assignee: memberByRole('developer'),
    };
    setProposedTickets(prev => {
      const clone = [...prev];
      clone[tIndex] = {
        ...clone[tIndex],
        subtasks: [...clone[tIndex].subtasks, newSub],
      };
      return clone;
    });
  };

  // Push to Jira
  const handlePushToJira = async () => {
    if (!userHasJiraToken) {
      showError(MISSING_JIRA_TOKEN_HINT);
      return;
    }
    const confirm = await showConfirm(
      'Xác nhận đẩy lên Jira?',
      `Hành động này sẽ tạo ${proposedTickets.length} ticket chính cùng toàn bộ sub-task đi kèm trực tiếp trên máy chủ Jira.`
    );
    if (!confirm) return;

    setPushing(true);
    try {
      const selectedUserInfo = activeUsers.filter(u => selectedMembers.includes(u.accountId));
      const ticketsPayload = await Promise.all(
        proposedTickets.map(async t => ({
          ...t,
          descriptionImages: undefined,
          images:
            t.descriptionImages && t.descriptionImages.length > 0
              ? await serializeJiraImages(t.descriptionImages)
              : undefined,
          subtasks: await Promise.all(
            (t.subtasks || []).map(async sub => ({
              ...sub,
              descriptionImages: undefined,
              images:
                sub.descriptionImages && sub.descriptionImages.length > 0
                  ? await serializeJiraImages(sub.descriptionImages)
                  : undefined,
            }))
          ),
        }))
      );
      const response = await apiFetch(`${API_BASE_URL}/api/planning/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planName,
          goal,
          tickets: ticketsPayload,
          members: selectedUserInfo,
          startDate,
          dueDate,
          epicMode,
          selectedEpicKey,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setCreatedKeys(data.createdKeys || []);
        setStep(3);
        showSuccess('Đã đẩy kế hoạch lên Jira thành công!');
      } else {
        const errorData = await response.json();
        showError(errorData.error || 'Lỗi khi đẩy lên Jira.');
      }
    } catch (e) {
      showError('Không thể kết nối máy chủ.');
    } finally {
      setPushing(false);
    }
  };

  if (!currentUser) {
    return (
      <main className="glass-card" style={{ padding: '3rem', textAlign: 'center' }}>
        <AlertTriangle size={48} color="#f87171" style={{ marginBottom: '1rem' }} />
        <h3>Yêu cầu đăng nhập</h3>
        <p style={{ color: 'var(--text-secondary)' }}>
          Vui lòng đăng nhập hệ thống để sử dụng tính năng lên kế hoạch.
        </p>
      </main>
    );
  }

  return (
    <main
      className="glass-card dashboard-main planning-page"
      style={{
        padding: '1.25rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
        height: 'calc(100vh - 2.2rem)',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* ── Mode Switcher ── */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          borderBottom: '1px solid var(--border-color)',
          paddingBottom: '0.75rem',
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setPageMode('planning')}
          style={{
            padding: '6px 18px',
            borderRadius: '8px',
            border: '1px solid',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: pageMode === 'planning' ? 'rgba(129,140,248,0.15)' : 'transparent',
            borderColor: pageMode === 'planning' ? 'rgba(129,140,248,0.4)' : 'var(--border-color)',
            color: pageMode === 'planning' ? '#a5b4fc' : 'var(--text-secondary)',
            transition: 'all 0.18s',
          }}
        >
          <Sparkles size={14} /> Lên kế hoạch Sprint
        </button>
        <button
          type="button"
          onClick={() => {
            setPageMode('bulk-stories');
            setStep(1);
          }}
          style={{
            padding: '6px 18px',
            borderRadius: '8px',
            border: '1px solid',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: pageMode === 'bulk-stories' ? 'rgba(168,85,247,0.15)' : 'transparent',
            borderColor:
              pageMode === 'bulk-stories' ? 'rgba(168,85,247,0.4)' : 'var(--border-color)',
            color: pageMode === 'bulk-stories' ? '#c084fc' : 'var(--text-secondary)',
            transition: 'all 0.18s',
          }}
        >
          <List size={14} /> Tạo Story hàng loạt
        </button>
        <button
          type="button"
          onClick={() => setPageMode('create-task')}
          style={{
            padding: '6px 18px',
            borderRadius: '8px',
            border: '1px solid',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: pageMode === 'create-task' ? 'rgba(74,222,128,0.12)' : 'transparent',
            borderColor:
              pageMode === 'create-task' ? 'rgba(74,222,128,0.35)' : 'var(--border-color)',
            color: pageMode === 'create-task' ? '#4ade80' : 'var(--text-secondary)',
            transition: 'all 0.18s',
          }}
        >
          <Tag size={14} /> Tạo Task
        </button>
      </div>
      {/* ─── Planning & Bulk Stories Modes ─── */}
      {(pageMode === 'planning' || pageMode === 'bulk-stories') && (
        <>
          {/* 3-Step Wizard Indicator */}
          <div
            className="wizard-steps"
            style={{
              marginBottom: step === 2 ? '0.5rem' : '2rem',
              paddingBottom: step === 2 ? '0.5rem' : '1.25rem',
            }}
          >
            <div
              className="wizard-steps__inner"
              style={{
                gap: step === 2 ? '1.5rem' : '3rem',
                fontSize: step === 2 ? '0.78rem' : '0.85rem',
              }}
            >
              <div
                className={`wizard-step${step === 1 ? ' is-active' : step > 1 ? ' is-done' : ''}`}
              >
                <span className="wizard-step__badge">1</span>
                <strong>{pageMode === 'bulk-stories' ? 'Danh sách Story' : 'Mô tả Epic'}</strong>
              </div>
              <div
                className={`wizard-step${step === 2 ? ' is-active' : step > 2 ? ' is-done' : ''}`}
              >
                <span className="wizard-step__badge">2</span>
                <strong>
                  {pageMode === 'bulk-stories' ? 'AI đề xuất Sub-task' : 'AI đề xuất Epic & Story'}
                </strong>
              </div>
              <div className={`wizard-step${step === 3 ? ' is-active is-done' : ''}`}>
                <span className="wizard-step__badge">3</span>
                <strong>Epic & Jira</strong>
              </div>
            </div>
          </div>

          <div
            style={{
              flex: 1,
              overflowY: step === 2 ? 'hidden' : 'auto',
              paddingRight: '6px',
              paddingBottom: step === 2 ? 0 : '1rem',
              display: step === 2 ? 'flex' : 'block',
              flexDirection: step === 2 ? 'column' : undefined,
              minHeight: 0,
            }}
            className="scrollable-area"
          >
            {/* STEP 1: Goal and Info input */}
            {step === 1 && (
              <div style={{ maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
                <div style={{ marginBottom: '1.5rem' }}>
                  <h3>Liên kết Epic</h3>
                  <div
                    style={{
                      display: 'flex',
                      gap: '1.25rem',
                      marginTop: '0.5rem',
                      marginBottom: '1rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        cursor: 'pointer',
                        fontSize: '0.82rem',
                        color: epicMode === 'create' ? '#818cf8' : 'var(--text-secondary)',
                      }}
                    >
                      <input
                        type="radio"
                        name="epicMode"
                        value="create"
                        checked={epicMode === 'create'}
                        onChange={() => setEpicMode('create')}
                        style={{ cursor: 'pointer' }}
                      />
                      <strong>Tạo Epic mới</strong>
                    </label>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        cursor: 'pointer',
                        fontSize: '0.82rem',
                        color: epicMode === 'existing' ? '#818cf8' : 'var(--text-secondary)',
                      }}
                    >
                      <input
                        type="radio"
                        name="epicMode"
                        value="existing"
                        checked={epicMode === 'existing'}
                        onChange={() => setEpicMode('existing')}
                        style={{ cursor: 'pointer' }}
                      />
                      <strong>Chọn Epic có sẵn</strong>
                    </label>
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        cursor: 'pointer',
                        fontSize: '0.82rem',
                        color: epicMode === 'none' ? '#818cf8' : 'var(--text-secondary)',
                      }}
                    >
                      <input
                        type="radio"
                        name="epicMode"
                        value="none"
                        checked={epicMode === 'none'}
                        onChange={() => setEpicMode('none')}
                        style={{ cursor: 'pointer' }}
                      />
                      <strong>Không tạo/gán Epic</strong>
                    </label>
                  </div>

                  <div
                    className={`planning-step1__filters${pageMode === 'planning' ? ' planning-step1__filters--with-count' : ''}`}
                  >
                    {epicMode === 'create' && (
                      <div className="planning-step1__field planning-step1__field--epic">
                        <label>Tên Epic / Kế hoạch mới</label>
                        <input
                          type="text"
                          value={planName}
                          onChange={e => setPlanName(e.target.value)}
                          className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control"
                          placeholder="Tên Epic mới..."
                        />
                      </div>
                    )}
                    {epicMode === 'existing' && (
                      <div className="planning-step1__field planning-step1__field--epic">
                        <label>Chọn Epic trên Jira</label>
                        <select
                          value={selectedEpicKey}
                          onChange={e => setSelectedEpicKey(e.target.value)}
                          className="premium-select planning-step1__control"
                          disabled={loadingEpics}
                        >
                          <option value="">
                            — {loadingEpics ? 'Đang tải danh sách...' : 'Chọn Epic có sẵn'}
                          </option>
                          {existingEpics.map(epic => (
                            <option key={epic.key} value={epic.key}>
                              {epic.key} - {epic.fields?.summary}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {epicMode === 'none' && (
                      <div className="planning-step1__field planning-step1__field--epic">
                        <label>Tên Kế hoạch (chỉ lưu nháp)</label>
                        <input
                          type="text"
                          value={planName}
                          onChange={e => setPlanName(e.target.value)}
                          className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control planning-step1__control--muted"
                          placeholder="Tên kế hoạch nháp..."
                        />
                      </div>
                    )}
                    {pageMode === 'planning' && (
                      <div className="planning-step1__field planning-step1__field--count">
                        <label>Số lượng Story (tuỳ chọn)</label>
                        <input
                          type="number"
                          value={storyCount}
                          onChange={e =>
                            setStoryCount(e.target.value === '' ? '' : Number(e.target.value))
                          }
                          className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control"
                          min="1"
                          max="50"
                          placeholder="Ví dụ: 5"
                        />
                      </div>
                    )}
                    <div className="planning-step1__field planning-step1__field--date">
                      <label>Bắt đầu</label>
                      <input
                        type="date"
                        value={startDate}
                        onChange={e => setStartDate(e.target.value)}
                        className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control"
                      />
                    </div>
                    <div className="planning-step1__field planning-step1__field--date">
                      <label>Kết thúc</label>
                      <input
                        type="date"
                        value={dueDate}
                        onChange={e => setDueDate(e.target.value)}
                        className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control"
                      />
                    </div>
                  </div>

                  <div className="planning-step1__checkboxes">
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        cursor: 'pointer',
                        userSelect: 'none',
                        margin: 0,
                        fontWeight: 600,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={includeBa}
                        onChange={e => setIncludeBa(e.target.checked)}
                        style={{ width: '1.1rem', height: '1.1rem', cursor: 'pointer' }}
                      />
                      Tạo sub-task BA
                    </label>
                    {pageMode === 'bulk-stories' && (
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem',
                          cursor: 'pointer',
                          userSelect: 'none',
                          margin: 0,
                          fontWeight: 600,
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={useAi}
                          onChange={e => setUseAi(e.target.checked)}
                          style={{ width: '1.1rem', height: '1.1rem', cursor: 'pointer' }}
                        />
                        Sử dụng AI phân tích
                      </label>
                    )}
                  </div>
                </div>

                {pageMode === 'planning' ? (
                  <div style={{ marginBottom: '2rem' }}>
                    <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                      Mục tiêu Epic (mô tả để AI hiểu)
                    </label>
                    <textarea
                      value={goal}
                      onChange={e => setGoal(e.target.value)}
                      rows={5}
                      className="ticket-field ticket-field--tall"
                      style={{ width: '100%', resize: 'vertical', backgroundImage: 'none' }}
                      placeholder="Ví dụ: Hoàn thiện module báo cáo doanh thu trạm, chuyển bớt phần đồng bộ dữ liệu..."
                    />
                  </div>
                ) : (
                  <div style={{ marginBottom: '2rem' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.5rem',
                        flexWrap: 'wrap',
                        gap: '0.5rem',
                      }}
                    >
                      <label style={{ fontWeight: 600, margin: 0 }}>
                        Danh sách Story (Đầu việc)
                      </label>
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        <input
                          type="file"
                          ref={fileInputRef}
                          style={{ display: 'none' }}
                          accept=".xlsx, .xls"
                          onChange={handleExcelImport}
                        />
                        <button
                          type="button"
                          onClick={handleDownloadTemplate}
                          className="filter-btn"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            padding: '4px 10px',
                            borderRadius: '12px',
                            color: '#10b981',
                            borderColor: 'rgba(16,185,129,0.35)',
                          }}
                        >
                          <Download size={14} /> Tải Template
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="filter-btn"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            padding: '4px 10px',
                            borderRadius: '12px',
                            color: '#10b981',
                            borderColor: 'rgba(16,185,129,0.35)',
                          }}
                        >
                          <FileSpreadsheet size={14} /> Nhập Excel
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setBulkJsonInput(
                              bulkStoryList.some(s => s.title.trim())
                                ? JSON.stringify(bulkStoryList, null, 2)
                                : BULK_STORIES_JSON_EXAMPLE
                            );
                            setBulkJsonModalOpen(true);
                          }}
                          className="filter-btn"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            padding: '4px 10px',
                            borderRadius: '12px',
                            color: '#c084fc',
                            borderColor: 'rgba(168,85,247,0.35)',
                          }}
                        >
                          <FileJson size={14} /> Nhập JSON
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setBulkStoryList([...bulkStoryList, { title: '', description: '' }])
                          }
                          className="filter-btn"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '0.75rem',
                            padding: '4px 8px',
                            borderRadius: '12px',
                          }}
                        >
                          <Plus size={14} /> Thêm đầu việc
                        </button>
                      </div>
                    </div>
                    <div className="planning-bulk-stories">
                      <div className="planning-bulk-stories__head">
                        <span>#</span>
                        <span>Tên Story / Chức năng</span>
                        <span>Mô tả / Yêu cầu</span>
                        <span aria-hidden />
                      </div>
                      <div style={{ maxHeight: '45vh', overflowY: 'auto', paddingRight: '4px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {bulkStoryList.map((story, idx) => (
                          <div key={idx} className="planning-bulk-stories__row">
                            <span className="planning-bulk-stories__index">{idx + 1}.</span>
                            <input
                              type="text"
                              value={story.title}
                              onChange={e => {
                                const newList = [...bulkStoryList];
                                newList[idx] = { ...newList[idx], title: e.target.value };
                                setBulkStoryList(newList);
                              }}
                              className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control planning-bulk-stories__title"
                              placeholder="VD: Thêm API đăng nhập bằng Google"
                            />
                            <input
                              type="text"
                              value={story.description}
                              onChange={e => {
                                const newList = [...bulkStoryList];
                                newList[idx] = { ...newList[idx], description: e.target.value };
                                setBulkStoryList(newList);
                              }}
                              className="premium-select premium-select--no-chevron toolbar-inline-input planning-step1__control planning-bulk-stories__desc"
                              placeholder="Mô tả / Yêu cầu chi tiết..."
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const newList = bulkStoryList.filter((_, i) => i !== idx);
                                setBulkStoryList(
                                  newList.length ? newList : [{ title: '', description: '' }]
                                );
                              }}
                              className="filter-btn planning-bulk-stories__delete"
                              title="Xóa đầu việc"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: '2rem' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem' }}>
                    <Users size={16} style={{ display: 'inline', marginRight: '6px' }} /> Thành viên
                    tham gia
                  </label>
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                      marginTop: '0.5rem',
                    }}
                  >
                    {activeUsers.map(user => {
                      const isSelected = selectedMembers.includes(user.accountId);
                      const roleText =
                        user.role === 'ba' ? 'BA' : user.role === 'tester' ? 'Tester' : 'Developer';
                      return (
                        <button
                          key={user.accountId}
                          type="button"
                          onClick={() => handleToggleMember(user.accountId)}
                          className="filter-btn"
                          style={{
                            padding: '4px 12px',
                            borderRadius: '20px',
                            fontSize: '0.8rem',
                            background: isSelected
                              ? 'rgba(129, 140, 248, 0.2)'
                              : 'var(--border-color)',
                            borderColor: isSelected
                              ? 'rgba(129, 140, 248, 0.4)'
                              : 'var(--border-color)',
                            color: isSelected ? '#a5b4fc' : 'var(--text-secondary)',
                          }}
                        >
                          {user.displayName} ({roleText})
                        </button>
                      );
                    })}
                  </div>
                  <p
                    style={{
                      fontSize: '0.7rem',
                      color: 'var(--text-secondary)',
                      marginTop: '0.5rem',
                    }}
                  >
                    * Bấm để chọn/bỏ chọn. AI sẽ dựa vào workload tháng trước để phân công tối ưu.
                  </p>
                </div>

                <div
                  style={{
                    marginBottom: '2.5rem',
                    padding: '0.75rem 1rem',
                    borderRadius: '10px',
                    background: 'rgba(16, 185, 129, 0.06)',
                    border: '1px solid rgba(16, 185, 129, 0.15)',
                  }}
                >
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.35rem' }}>
                    Cấu trúc kế hoạch
                  </label>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    <strong style={{ color: '#6ee7b7' }}>Story</strong> = tên chức năng (vd:
                    &quot;Báo cáo doanh thu trạm&quot;), assignee mặc định{' '}
                    <strong style={{ color: '#60a5fa' }}>Tester</strong> (nhận &amp; close story).
                    Việc BA/Dev/Test nằm trong Sub-task.
                  </p>
                </div>

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button
                    onClick={
                      pageMode === 'bulk-stories' ? handleGeneratePlanBulk : handleGeneratePlan
                    }
                    disabled={loading}
                    className="btn-primary"
                    style={{
                      padding: '10px 40px',
                      fontSize: '1rem',
                      width: 'auto',
                      borderRadius: '12px',
                    }}
                  >
                    {loading ? <Loader2 className="spinner" size={20} /> : <Sparkles size={20} />}
                    {loading
                      ? pageMode === 'bulk-stories'
                        ? 'AI đang tạo sub-task...'
                        : 'AI đang phân rã Epic...'
                      : 'Gửi cho AI phân tích'}
                  </button>
                </div>
              </div>
            )}

            {/* STEP 2: Interactive AI proposal — fit one screen */}
            {step === 2 && (
              <div
                style={{
                  maxWidth: '1600px',
                  margin: '0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  width: '100%',
                }}
                className="planning-step2"
              >
                {/* Workload */}
                <div className="planning-panel planning-workload-bar">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setWorkloadOpen(v => !v)}
                      className="planning-workload-toggle"
                    >
                      {workloadOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      Phân bổ workload
                      {!workloadOpen && hasWorkloadImbalance && (
                        <AlertTriangle size={12} style={{ color: '#fbbf24' }} />
                      )}
                    </button>
                    {!workloadOpen && (
                      <div className="planning-workload-chips">
                        {workloadByRole.map(group => (
                          <span
                            key={group.role}
                            className={`planning-chip${group.imbalanced ? ' planning-chip--warn' : ''}`}
                          >
                            {group.label}:{' '}
                            {group.members
                              .map(m => `${m.name.split(' ').pop()} ${m.hrs.toFixed(0)}h`)
                              .join(' · ')}
                          </span>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={handleBalanceWorkload}
                      disabled={balancing || proposedTickets.length === 0}
                      className="filter-btn planning-btn-sm"
                      style={{
                        color: hasWorkloadImbalance ? '#fbbf24' : '#6ee7b7',
                        borderColor: hasWorkloadImbalance
                          ? 'rgba(251, 191, 36, 0.35)'
                          : 'rgba(74, 222, 128, 0.25)',
                        flexShrink: 0,
                      }}
                    >
                      {balancing ? <Loader2 className="spinner" size={12} /> : 'Cân bằng'}
                    </button>
                  </div>
                  {workloadOpen && (
                    <div className="planning-workload-grid">
                      {workloadByRole.map(group => (
                        <div key={group.role}>
                          <div className="planning-workload-col-title">
                            {group.label}
                            {group.imbalanced ? ' ⚠' : ''}
                          </div>
                          {group.members.map(({ id, name, hrs }) => {
                            const limit = 40;
                            const percent = Math.min(100, (hrs / limit) * 100);
                            const isOverloaded = hrs > limit;
                            return (
                              <div key={id} className="planning-workload-row">
                                <span title={name}>{name.split(' ').pop()}</span>
                                <div className="planning-bar-track">
                                  <div
                                    className={`planning-bar-fill${isOverloaded ? ' planning-bar-fill--over' : ''}`}
                                    style={{ width: `${percent}%` }}
                                  />
                                </div>
                                <span
                                  style={{
                                    color: isOverloaded ? '#f87171' : '#fbbf24',
                                    fontWeight: 600,
                                    width: 30,
                                    textAlign: 'right',
                                  }}
                                >
                                  {hrs.toFixed(0)}h
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Toolbar */}
                <div className="planning-toolbar">
                  <div className="planning-toolbar-title">
                    Story đề xuất <span>({proposedTickets.length})</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div className="planning-segment">
                      <button
                        type="button"
                        className={storyViewMode === 'grid' ? 'active' : ''}
                        onClick={() => setStoryViewMode('grid')}
                      >
                        <LayoutGrid size={13} /> Lưới
                      </button>
                      <button
                        type="button"
                        className={storyViewMode === 'list' ? 'active' : ''}
                        onClick={() => setStoryViewMode('list')}
                      >
                        <List size={13} /> List
                      </button>
                    </div>
                    <button
                      onClick={handleAddTicket}
                      className="filter-btn planning-btn-sm planning-btn-sm--add"
                    >
                      <Plus size={13} /> Thêm
                    </button>
                  </div>
                </div>

                {/* Story grid */}
                <div className={`planning-story-grid planning-story-grid--${storyViewMode}`}>
                  {proposedTickets.map((ticket, tIdx) => {
                    return (
                      <div
                        key={tIdx}
                        className="planning-story-card detailed-card"
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          background: 'rgba(15, 23, 42, 0.6)',
                          border: '1px solid var(--border-color)',
                          borderRadius: '10px',
                          overflow: 'hidden',
                        }}
                      >
                        {/* Header */}
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '0.65rem',
                            borderBottom: '1px solid var(--border-color)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span
                              style={{
                                fontSize: '0.8rem',
                                color: 'var(--text-secondary)',
                                fontWeight: 600,
                              }}
                            >
                              #{tIdx + 1}
                            </span>
                            <span
                              style={{
                                padding: '2px 8px',
                                background: 'rgba(59, 130, 246, 0.15)',
                                color: '#60a5fa',
                                borderRadius: '10px',
                                fontSize: '0.7rem',
                                fontWeight: 600,
                              }}
                            >
                              Story
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: '0.3rem' }}>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                startTransition(() => setEditingStoryIdx(tIdx));
                              }}
                              className="planning-icon-btn"
                              style={{ padding: '4px', background: 'var(--border-color)' }}
                              title="Sửa story"
                            >
                              <Edit3 size={12} />
                            </button>
                            <button
                              onClick={e => {
                                e.stopPropagation();
                                handleDeleteTicket(tIdx);
                              }}
                              className="planning-icon-btn planning-icon-btn--danger"
                              style={{ padding: '4px', background: 'var(--border-color)' }}
                              title="Xóa story"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>

                        {/* Title & Desc & Meta */}
                        <div style={{ padding: '0.65rem' }}>
                          <h3
                            style={{
                              margin: '0 0 0.25rem 0',
                              fontSize: '0.95rem',
                              fontWeight: 700,
                              color: 'var(--text-primary)',
                              lineHeight: 1.3,
                            }}
                          >
                            {ticket.summary || 'Chức năng mới...'}
                          </h3>
                          <p
                            style={{
                              margin: '0 0 0.5rem 0',
                              fontSize: '0.8rem',
                              color: 'var(--text-secondary)',
                              lineHeight: 1.4,
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {wikiToPlainPreview(ticket.description)}
                          </p>
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              fontSize: '0.8rem',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              {ticket.assignee ? (
                                <>
                                  <div
                                    style={{
                                      width: 20,
                                      height: 20,
                                      borderRadius: '50%',
                                      background: 'rgba(74, 222, 128, 0.2)',
                                      color: '#4ade80',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '0.6rem',
                                      fontWeight: 700,
                                    }}
                                  >
                                    {activeUsers
                                      .find(u => u.accountId === ticket.assignee)
                                      ?.displayName?.split(' ')
                                      .pop()
                                      ?.substring(0, 2)
                                      .toUpperCase()}
                                  </div>
                                  <span>
                                    {
                                      activeUsers.find(u => u.accountId === ticket.assignee)
                                        ?.displayName
                                    }
                                  </span>
                                </>
                              ) : (
                                <>
                                  <div
                                    style={{
                                      width: 20,
                                      height: 20,
                                      borderRadius: '50%',
                                      background: 'var(--border-color)',
                                      color: '#aaa',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '0.6rem',
                                      fontWeight: 700,
                                    }}
                                  >
                                    ?
                                  </div>
                                  <span>Chưa gán</span>
                                </>
                              )}
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.3rem',
                                fontWeight: 600,
                              }}
                            >
                              <Clock size={12} style={{ opacity: 0.7 }} />
                              <span>
                                {ticket.estimateHours}{' '}
                                <span style={{ opacity: 0.7, fontWeight: 400 }}>h est.</span>
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Subtasks */}
                        {ticket.subtasks && ticket.subtasks.length > 0 && (
                          <div
                            style={{
                              padding: '0 0.65rem',
                              borderTop: '1px solid var(--border-color)',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '0.5rem',
                                padding: '0.65rem 0',
                              }}
                            >
                              {ticket.subtasks.map((sub, sIdx) => {
                                let roleIcon = <Code size={11} />;
                                let roleColor = '#60a5fa'; // BA = blue, DEV = green, TEST = orange
                                let roleLabel = 'DEV';

                                if (sub.summary.toUpperCase().includes('[BA]')) {
                                  roleIcon = <PenTool size={11} />;
                                  roleColor = '#60a5fa'; // Blue
                                  roleLabel = 'BA';
                                } else if (sub.summary.toUpperCase().includes('[DEV]')) {
                                  roleIcon = <Code size={11} />;
                                  roleColor = '#4ade80'; // Green
                                  roleLabel = 'DEV';
                                } else if (sub.summary.toUpperCase().includes('[TEST]')) {
                                  roleIcon = <Bug size={11} />;
                                  roleColor = '#fb923c'; // Orange
                                  roleLabel = 'TEST';
                                }

                                return (
                                  <div
                                    key={sIdx}
                                    style={{
                                      display: 'flex',
                                      gap: '0.4rem',
                                      alignItems: 'flex-start',
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        color: roleColor,
                                        marginTop: '2px',
                                        flexShrink: 0,
                                      }}
                                    >
                                      {roleIcon}
                                    </div>
                                    <div
                                      style={{
                                        flex: 1,
                                        fontSize: '0.85rem',
                                        color: 'var(--text-primary)',
                                        lineHeight: 1.35,
                                      }}
                                    >
                                      <span
                                        style={{
                                          color: roleColor,
                                          fontWeight: 700,
                                          marginRight: '4px',
                                        }}
                                      >
                                        [{roleLabel}]
                                      </span>
                                      {sub.summary.replace(/\[(BA|DEV|TEST)\]\s*/i, '').trim()}
                                    </div>
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        flexShrink: 0,
                                        marginTop: '1px',
                                      }}
                                    >
                                      {sub.assignee ? (
                                        <div
                                          style={{
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            background: 'var(--border-color)',
                                            color: '#cbd5e1',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '0.55rem',
                                            fontWeight: 700,
                                          }}
                                          title={
                                            activeUsers.find(u => u.accountId === sub.assignee)
                                              ?.displayName
                                          }
                                        >
                                          {activeUsers
                                            .find(u => u.accountId === sub.assignee)
                                            ?.displayName?.split(' ')
                                            .pop()
                                            ?.substring(0, 2)
                                            .toUpperCase()}
                                        </div>
                                      ) : (
                                        <div
                                          style={{
                                            width: 18,
                                            height: 18,
                                            borderRadius: '50%',
                                            background: 'var(--border-color)',
                                            color: '#666',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '0.55rem',
                                            fontWeight: 700,
                                          }}
                                        >
                                          ?
                                        </div>
                                      )}
                                      <span
                                        style={{
                                          fontSize: '0.75rem',
                                          color: 'var(--text-secondary)',
                                          fontWeight: 600,
                                          width: '20px',
                                          textAlign: 'right',
                                        }}
                                      >
                                        {sub.estimateHours}h
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Footer */}
                        <div
                          style={{
                            padding: '0.5rem 0.65rem',
                            borderTop: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: 'rgba(0,0,0,0.15)',
                          }}
                        >
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              startTransition(() => setEditingStoryIdx(tIdx));
                            }}
                            className="filter-btn"
                            style={{
                              padding: '3px 8px',
                              fontSize: '0.75rem',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.3rem',
                              borderColor: 'var(--border-color)',
                              background: 'transparent',
                            }}
                          >
                            <Plus size={11} /> Thêm sub-task
                          </button>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.4rem',
                              fontSize: '0.75rem',
                              color: 'var(--text-secondary)',
                            }}
                          >
                            <div
                              style={{
                                width: '30px',
                                height: '4px',
                                background: 'var(--border-color)',
                                borderRadius: '2px',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{ width: '33%', height: '100%', background: '#64748b' }}
                              ></div>
                            </div>
                            <span>{ticket.subtasks?.length || 0}/3</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Footer */}
                <div className="planning-footer">
                  <div className="planning-refine-row">
                    <Sparkles size={14} style={{ color: '#a5b4fc', flexShrink: 0 }} />
                    <input
                      type="text"
                      value={refineText}
                      onChange={e => setRefineText(e.target.value)}
                      placeholder="Nói với AI điều chỉnh kế hoạch..."
                      className="premium-select"
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleRefinePlan();
                      }}
                    />
                    <button
                      onClick={handleRefinePlan}
                      disabled={refining || !refineText.trim()}
                      className="filter-btn planning-btn-sm"
                      style={{ flexShrink: 0 }}
                    >
                      {refining ? <Loader2 className="spinner" size={12} /> : 'Gửi AI'}
                    </button>
                  </div>
                  <div className="planning-nav-row">
                    <button
                      onClick={() => setStep(1)}
                      className="btn-secondary"
                      style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      <ArrowLeft size={14} /> Bước 1
                    </button>
                    <button
                      onClick={handlePushToJira}
                      disabled={pushing || proposedTickets.length === 0 || !userHasJiraToken}
                      title={userHasJiraToken ? undefined : MISSING_JIRA_TOKEN_HINT}
                      className="btn-primary"
                      style={{ width: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}
                    >
                      {pushing ? <Loader2 className="spinner" size={14} /> : <Check size={14} />}
                      {pushing ? 'Đang đẩy...' : 'Đẩy lên Jira'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: Live Push Status */}
            {step === 3 && (
              <div
                style={{
                  maxWidth: '1600px',
                  margin: '0 auto',
                  textAlign: 'center',
                  padding: '2rem 0',
                }}
              >
                <div
                  style={{
                    display: 'inline-flex',
                    padding: '12px',
                    background: 'rgba(74, 222, 128, 0.1)',
                    borderRadius: '50%',
                    color: '#4ade80',
                    marginBottom: '1.5rem',
                  }}
                >
                  <ShieldCheck size={48} />
                </div>
                <h2 style={{ color: '#4ade80', marginBottom: '0.5rem' }}>
                  Sprint Planning Đã Được Đẩy Thành Công!
                </h2>
                <p
                  style={{
                    color: 'var(--text-secondary)',
                    marginBottom: '2rem',
                    fontSize: '0.95rem',
                  }}
                >
                  Tổng cộng <strong>{createdKeys.length}</strong> ticket chính cùng toàn bộ sub-task
                  đã được khởi tạo trực tiếp trong sprint này trên Jira.
                </p>

                <div
                  style={{
                    background: 'rgba(0,0,0,0.2)',
                    padding: '0.25rem',
                    borderRadius: '12px',
                    border: '1px solid var(--border-color)',
                    textAlign: 'left',
                    marginBottom: '2rem',
                  }}
                >
                  <h5
                    style={{
                      margin: '0 0 0.75rem',
                      fontSize: '0.8rem',
                      color: '#a5b4fc',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}
                  >
                    Danh sách Ticket được tạo:
                  </h5>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {createdKeys.map(key => (
                      <button
                        key={key}
                        onClick={() => openJiraTicket(key)}
                        className="filter-btn"
                        style={{
                          padding: '4px 10px',
                          borderColor: 'rgba(74, 222, 128, 0.3)',
                          color: '#4ade80',
                          fontSize: '0.8rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        {key} <ExternalLink size={12} />
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={() => {
                    setStep(1);
                    setProposedTickets([]);
                    setCreatedKeys([]);
                  }}
                  className="btn-primary"
                  style={{ width: 'auto', padding: '10px 30px', borderRadius: '10px' }}
                >
                  Lên kế hoạch Sprint mới
                </button>
              </div>
            )}
          </div>

          {editStoryModalMounted &&
            editingTicket &&
            editingStoryIdx !== null &&
            (() => {
              const tIdx = editingStoryIdx;
              const ticket = editingTicket;
              const storyOwnerOptions = buildStoryOwnerOptions(
                activeUsers,
                selectedMembers,
                ticket.assignee
              );
              const storyOwnerUser = activeUsers.find(u => u.accountId === ticket.assignee);

              return (
                <CommonModal
                  open={editingStoryIdx !== null}
                  onClose={() => setEditingStoryIdx(null)}
                  title={
                    <>
                      <span className="modal-header__badge">#{tIdx + 1} STORY</span>
                      Chỉnh sửa chi tiết
                    </>
                  }
                  titleId={`planning-story-edit-${tIdx}`}
                  headerActions={
                    <button
                      type="button"
                      onClick={() => setEditingStoryIdx(null)}
                      className="btn-primary modal-header__done-btn"
                    >
                      Xong & Đóng
                    </button>
                  }
                  showCloseButton={false}
                  zIndex={1100}
                  classNameContent="modal-content--wide planning-edit-modal"
                >
                  <div className="modal-body scrollable-area planning-edit-modal__body">
                    <input
                      type="text"
                      value={ticket.summary}
                      onChange={e => handleUpdateTicket(tIdx, 'summary', e.target.value)}
                      className="premium-select planning-edit-modal__title"
                      title={ticket.summary}
                      placeholder="Tên chức năng"
                    />

                    <div className="planning-edit-modal__meta">
                      <div className="planning-edit-modal__meta-field planning-edit-modal__meta-field--grow">
                        <span className="planning-edit-modal__label">Người phụ trách (Story)</span>
                        <div className="planning-edit-modal__owner-row">
                          {storyOwnerUser ? (
                            <span
                              className="planning-edit-modal__owner-avatar"
                              title={storyOwnerUser.displayName}
                            >
                              {storyOwnerUser.displayName
                                ?.split(' ')
                                .pop()
                                ?.substring(0, 2)
                                .toUpperCase() || '?'}
                            </span>
                          ) : (
                            <span className="planning-edit-modal__owner-avatar planning-edit-modal__owner-avatar--empty">
                              ?
                            </span>
                          )}
                          <select
                            value={ticket.assignee}
                            onChange={e => handleUpdateTicket(tIdx, 'assignee', e.target.value)}
                            className="premium-select planning-edit-modal__select"
                          >
                            <option value="">— Chọn người —</option>
                            {storyOwnerOptions.map(user => (
                              <option key={user.accountId} value={user.accountId}>
                                {user.displayName} ({memberRoleShort(user.role)})
                              </option>
                            ))}
                          </select>
                        </div>
                        <span className="planning-edit-modal__field-hint">
                          Tester, Dev hoặc BA trong nhóm tham gia — mặc định gợi ý Tester.
                        </span>
                      </div>
                      <div className="planning-edit-modal__meta-field planning-edit-modal__meta-field--est">
                        <span className="planning-edit-modal__label">Estimate</span>
                        <div className="planning-edit-modal__hours">
                          <input
                            type="number"
                            value={ticket.estimateHours}
                            onChange={e =>
                              handleUpdateTicket(
                                tIdx,
                                'estimateHours',
                                Math.max(0, parseInt(e.target.value) || 0)
                              )
                            }
                            className="ticket-field planning-edit-modal__hours-input"
                          />
                          <span className="planning-edit-modal__hours-unit">h</span>
                        </div>
                      </div>
                    </div>

                    <div className="planning-edit-modal__section planning-edit-modal__section--card">
                      <label className="planning-edit-modal__label">Mô tả chi tiết Story</label>
                      <JiraRichComposer
                        key={`story-desc-${tIdx}`}
                        wiki={ticket.description || ''}
                        images={ticket.descriptionImages || []}
                        onChange={payload => handleUpdateTicketDescription(tIdx, payload)}
                        className="planning-edit-modal__composer"
                        minHeight={160}
                        placeholder="Mô tả chức năng, yêu cầu nghiệp vụ, acceptance criteria…"
                        hint="Soạn mô tả như CKEditor: định dạng chữ, danh sách, chèn ảnh inline."
                      />
                    </div>

                    <div className="planning-edit-modal__divider" />

                    <div className="planning-edit-modal__subtasks">
                      <h4 className="planning-edit-modal__subtasks-title">
                        <Check size={16} color="#4ade80" />
                        Sub-tasks ({ticket.subtasks?.length || 0})
                      </h4>
                      {ticket.subtasks?.map((sub, sIdx) => {
                        const role = subRoleMeta(sub.summary);
                        return (
                          <div
                            key={sIdx}
                            className={`planning-edit-modal__sub-card planning-edit-modal__sub-card--${role.label.toLowerCase()}`}
                          >
                            <div className="planning-edit-modal__sub-head">
                              <div className="planning-edit-modal__sub-head-left">
                                <span
                                  className="planning-role-badge"
                                  style={{ background: role.bg, color: role.color }}
                                >
                                  {role.label}
                                </span>
                                <select
                                  value={
                                    /^\[TEST\]/i.test(sub.summary) ? ticket.assignee : sub.assignee
                                  }
                                  onChange={e =>
                                    handleUpdateSubtask(tIdx, sIdx, 'assignee', e.target.value)
                                  }
                                  className="premium-select planning-edit-modal__sub-select"
                                  disabled={/^\[TEST\]/i.test(sub.summary)}
                                >
                                  <option value="">— Assignee —</option>
                                  {buildStoryOwnerOptions(
                                    activeUsers,
                                    selectedMembers,
                                    /^\[TEST\]/i.test(sub.summary) ? ticket.assignee : sub.assignee
                                  )
                                    .filter(user => {
                                      if (/^\[BA\]/i.test(sub.summary)) return user.role === 'ba';
                                      if (/^\[TEST\]/i.test(sub.summary))
                                        return user.role === 'tester';
                                      return user.role === 'developer';
                                    })
                                    .map(user => (
                                      <option key={user.accountId} value={user.accountId}>
                                        {user.displayName} ({memberRoleShort(user.role)})
                                      </option>
                                    ))}
                                </select>
                              </div>
                              <div className="planning-edit-modal__sub-head-right">
                                <div className="planning-edit-modal__hours planning-edit-modal__hours--compact">
                                  <input
                                    type="number"
                                    value={sub.estimateHours}
                                    onChange={e =>
                                      handleUpdateSubtask(
                                        tIdx,
                                        sIdx,
                                        'estimateHours',
                                        Math.max(0, parseInt(e.target.value) || 0)
                                      )
                                    }
                                    className="ticket-field planning-edit-modal__hours-input"
                                  />
                                  <span className="planning-edit-modal__hours-unit">h</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteSubtask(tIdx, sIdx)}
                                  className="planning-icon-btn planning-icon-btn--danger planning-edit-modal__delete"
                                  title="Xóa"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>

                            <input
                              type="text"
                              value={sub.summary}
                              onChange={e =>
                                handleUpdateSubtask(tIdx, sIdx, 'summary', e.target.value)
                              }
                              className="premium-select planning-edit-modal__sub-summary"
                              placeholder="Tiêu đề sub-task..."
                            />

                            <div className="planning-edit-modal__sub-desc">
                              <span className="planning-edit-modal__label planning-edit-modal__label--sub">
                                Mô tả
                              </span>
                              <JiraRichComposer
                                key={`sub-desc-${tIdx}-${sIdx}`}
                                wiki={sub.description || ''}
                                images={sub.descriptionImages || []}
                                onChange={payload =>
                                  handleUpdateSubtaskDescription(tIdx, sIdx, payload)
                                }
                                className="planning-edit-modal__composer planning-edit-modal__composer--sub"
                                minHeight={120}
                                placeholder="Mô tả công việc chi tiết…"
                              />
                            </div>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => handleAddSubtask(tIdx)}
                        className="planning-edit-modal__add-sub"
                      >
                        <Plus size={14} />
                        Thêm Sub-task
                      </button>
                    </div>
                  </div>
                </CommonModal>
              );
            })()}
        </>
      )}

      {/* ─── Create Task Mode ─── */}
      {pageMode === 'create-task' && (
        <div
          className="scrollable-area"
          style={{ flex: 1, overflowY: 'auto', paddingRight: '6px', paddingBottom: '2rem' }}
        >
          <div className="glass-card" style={{ padding: '1.25rem' }}>
            <div
              style={{
                marginBottom: '1.25rem',
                borderBottom: '1px solid var(--border-color)',
                paddingBottom: '1rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <h2
                    style={{
                      fontSize: '1.1rem',
                      marginBottom: '0.25rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    {ctUseAi ? (
                      <Sparkles size={20} className="text-primary" />
                    ) : (
                      <Tag size={20} className="text-primary" />
                    )}
                    {ctUseAi ? 'Thiết kế Ticket bằng AI' : 'Tạo Jira Ticket'}
                  </h2>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', margin: 0 }}>
                    {ctUseAi
                      ? 'AI sẽ tự động phân tích và tạo cấu trúc Jira Ticket từ yêu cầu của bạn.'
                      : 'Tạo ticket trực tiếp từ nội dung — dòng đầu làm tiêu đề, không gọi AI.'}
                  </p>
                </div>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    cursor: 'pointer',
                    userSelect: 'none',
                    margin: 0,
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    fontSize: '0.8rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ctUseAi}
                    onChange={e => setCtUseAi(e.target.checked)}
                    style={{ width: '1.1rem', height: '1.1rem', cursor: 'pointer' }}
                  />
                  Sử dụng AI phân tích
                </label>
              </div>
            </div>

            {/* Config Grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '1rem',
                marginBottom: '1.25rem',
              }}
            >
              {ctUseAi && (
                <div className="form-group">
                  <label
                    className="action-label"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.4rem',
                      fontSize: '0.7rem',
                    }}
                  >
                    <Users size={12} /> AI Persona Profile
                  </label>
                  <select
                    value={ctRole}
                    onChange={e => setCtRole(e.target.value)}
                    className="premium-select"
                    style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                  >
                    <option>DEV lead</option>
                    <option>Business Analyst</option>
                    <option>Technical Project Manager</option>
                    <option>Quality Assurance Lead</option>
                  </select>
                </div>
              )}
              <div className="form-group">
                <label
                  className="action-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontSize: '0.7rem',
                  }}
                >
                  <Tag size={12} /> Loại Jira Ticket
                </label>
                <select
                  value={ctTicketType}
                  onChange={e => setCtTicketType(e.target.value)}
                  className="premium-select"
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                >
                  <option>Task</option>
                  <option>Story</option>
                  <option>Bug</option>
                  <option>Improvement</option>
                  <option>Epic</option>
                </select>
              </div>
              <div className="form-group">
                <label
                  className="action-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontSize: '0.7rem',
                  }}
                >
                  <Users size={12} /> Người nhận (Assignee)
                </label>
                <select
                  value={ctAssignee}
                  onChange={e => setCtAssignee(e.target.value)}
                  className="premium-select"
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                >
                  {projectUsers.length > 0 ? (
                    projectUsers.map((u: any, i: number) => (
                      <option key={i} value={u.displayName}>
                        {u.displayName}
                      </option>
                    ))
                  ) : (
                    <option>Tự động gán</option>
                  )}
                </select>
              </div>
              <div className="form-group">
                <label
                  className="action-label"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontSize: '0.7rem',
                  }}
                >
                  <Flag size={12} /> Ước lượng (Est)
                </label>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <input
                    type="text"
                    value={ctOriginalEstimate}
                    onChange={e => setCtOriginalEstimate(e.target.value)}
                    className="premium-select"
                    placeholder="VD: 4h, 1d"
                    style={{
                      backgroundImage: 'none',
                      flex: 1,
                      padding: '0.4rem 0.75rem',
                      fontSize: '0.8rem',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setCtOriginalEstimate('4h')}
                    className="premium-select"
                    style={{
                      width: 'auto',
                      padding: '0 0.5rem',
                      fontSize: '0.7rem',
                      background:
                        ctOriginalEstimate === '4h'
                          ? 'rgba(99, 102, 241, 0.2)'
                          : 'var(--border-color)',
                      backgroundImage: 'none',
                    }}
                  >
                    4h
                  </button>
                  <button
                    type="button"
                    onClick={() => setCtOriginalEstimate('7h')}
                    className="premium-select"
                    style={{
                      width: 'auto',
                      padding: '0 0.5rem',
                      fontSize: '0.7rem',
                      background:
                        ctOriginalEstimate === '7h'
                          ? 'rgba(99, 102, 241, 0.2)'
                          : 'var(--border-color)',
                      backgroundImage: 'none',
                    }}
                  >
                    7h
                  </button>
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '2.5rem',
                marginBottom: '1.25rem',
              }}
            >
              <div className="form-group">
                <label className="action-label" style={{ fontSize: '0.7rem' }}>
                  Ngày bắt đầu
                </label>
                <input
                  type="datetime-local"
                  value={ctStartDate}
                  onChange={e => setCtStartDate(e.target.value)}
                  className="premium-select"
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                />
              </div>
              <div className="form-group">
                <label className="action-label" style={{ fontSize: '0.7rem' }}>
                  Ngày kết thúc
                </label>
                <input
                  type="datetime-local"
                  value={ctDueDate}
                  onChange={e => setCtDueDate(e.target.value)}
                  className="premium-select"
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                />
              </div>
            </div>

            {/* Sub-tasks config for Story */}
            {ctTicketType === 'Story' && (
              <div
                style={{
                  marginBottom: '1.25rem',
                  padding: '1rem',
                  background: 'rgba(99, 102, 241, 0.03)',
                  borderRadius: '0.75rem',
                  border: '1px solid rgba(99, 102, 241, 0.1)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <ExternalLink size={14} className="text-primary" />
                    <div>
                      <h4 style={{ margin: 0, fontSize: '0.85rem' }}>Cấu hình Sub-tasks</h4>
                      <p style={{ margin: 0, fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        Tự động sinh [DEV] và [TEST].
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setCtCreateAutoSubTasks(!ctCreateAutoSubTasks)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: ctCreateAutoSubTasks ? '#4ade80' : '#444',
                      padding: 0,
                    }}
                  >
                    {ctCreateAutoSubTasks ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                  </button>
                </div>
                {ctCreateAutoSubTasks && (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                      gap: '1rem',
                    }}
                  >
                    <div className="form-group">
                      <label className="action-label" style={{ fontSize: '0.7rem' }}>
                        Assignee [DEV]
                      </label>
                      <select
                        value={ctSubTaskDevAssignee}
                        onChange={e => setCtSubTaskDevAssignee(e.target.value)}
                        className="premium-select"
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                      >
                        {projectUsers.map((u: any, i: number) => (
                          <option key={i} value={u.accountId}>
                            {u.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="action-label" style={{ fontSize: '0.7rem' }}>
                        Assignee [TEST]
                      </label>
                      <select
                        value={ctSubTaskTestAssignee}
                        onChange={e => setCtSubTaskTestAssignee(e.target.value)}
                        className="premium-select"
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                      >
                        {projectUsers.map((u: any, i: number) => (
                          <option key={i} value={u.accountId}>
                            {u.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="action-label" style={{ fontSize: '0.7rem' }}>
                        Bắt đầu (Sub)
                      </label>
                      <input
                        type="datetime-local"
                        value={ctSubTaskStartDate}
                        onChange={e => setCtSubTaskStartDate(e.target.value)}
                        className="premium-select"
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                      />
                    </div>
                    <div className="form-group">
                      <label className="action-label" style={{ fontSize: '0.7rem' }}>
                        Kết thúc (Sub)
                      </label>
                      <input
                        type="datetime-local"
                        value={ctSubTaskDueDate}
                        onChange={e => setCtSubTaskDueDate(e.target.value)}
                        className="premium-select"
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Context Input */}
            <div style={{ marginBottom: '1.25rem' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '0.5rem',
                  alignItems: 'center',
                }}
              >
                <h3
                  style={{
                    fontSize: '0.9rem',
                    margin: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}
                >
                  Nội dung yêu cầu (Context) <Info size={12} style={{ opacity: 0.5 }} />
                </h3>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                  {ctUseAi
                    ? 'AI phân tích kỹ thuật dựa trên mô tả này'
                    : 'Dòng đầu = tiêu đề ticket, toàn bộ = mô tả'}
                </span>
              </div>
              <textarea
                className="context-textarea"
                style={{
                  width: '100%',
                  minHeight: '120px',
                  fontSize: '0.85rem',
                  padding: '0.75rem',
                }}
                placeholder={
                  ctUseAi
                    ? 'Mô tả yêu cầu nghiệp vụ...'
                    : 'Dòng 1: Tiêu đề ticket\nDòng 2+: Mô tả chi tiết...'
                }
                value={ctContext}
                onChange={e => setCtContext(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                className="btn-primary"
                onClick={handleCtGenerate}
                disabled={ctLoading || !ctContext.trim()}
                style={{
                  padding: '0.6rem 2.5rem',
                  fontSize: '0.95rem',
                  borderRadius: '0.75rem',
                  boxShadow: '0 8px 30px rgba(99, 102, 241, 0.2)',
                }}
              >
                {ctLoading ? (
                  <Loader2 className="spinner" size={18} />
                ) : ctUseAi ? (
                  <Sparkles size={18} />
                ) : (
                  <Tag size={18} />
                )}
                {ctLoading
                  ? 'Đang phân tích...'
                  : ctUseAi
                    ? 'Thiết kế & Tạo Jira Ticket'
                    : 'Tạo Jira Ticket'}
              </button>
            </div>
          </div>

          {/* Ticket Preview */}
          {ctTicket && (
            <div className="ticket-preview" style={{ marginTop: '2rem' }}>
              <div className="preview-header" style={{ padding: '1rem 1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <div
                    style={{
                      padding: '6px',
                      background: 'rgba(74, 222, 128, 0.1)',
                      borderRadius: '6px',
                    }}
                  >
                    <ShieldCheck size={20} color="#4ade80" />
                  </div>
                  <div>
                    <span
                      style={{
                        fontSize: '0.6rem',
                        color: 'var(--text-secondary)',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}
                    >
                      PHÂN TÍCH HOÀN TẤT
                    </span>
                    <h4 style={{ margin: 0, fontSize: '0.95rem' }}>
                      {ctTicket.jiraKey || 'Bản thảo Jira Ticket'}
                    </h4>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  {ctTicket.jiraKey && (
                    <button
                      className="btn-secondary"
                      onClick={() => openJiraTicket(ctTicket.jiraKey)}
                      style={{ padding: '0.4rem 0.8rem', width: 'auto', fontSize: '0.8rem' }}
                    >
                      <ExternalLink size={14} /> Xem Jira
                    </button>
                  )}
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(ctTicket, null, 2));
                      setCtCopied(true);
                      setTimeout(() => setCtCopied(false), 2000);
                    }}
                    style={{ padding: '0.4rem 0.8rem', width: 'auto', fontSize: '0.8rem' }}
                  >
                    {ctCopied ? <Check size={14} color="#4ade80" /> : <Clipboard size={14} />}
                    {ctCopied ? 'Đã chép' : 'JSON'}
                  </button>
                </div>
              </div>

              <div className="preview-body" style={{ padding: '1.25rem' }}>
                <input
                  className="preview-summary"
                  value={ctTicket.summary}
                  onChange={e => updateCtField('summary', e.target.value)}
                  style={{
                    width: '100%',
                    background: 'none',
                    border: 'none',
                    borderBottom: '1px solid var(--border-color)',
                    outline: 'none',
                    marginBottom: '1.25rem',
                    paddingBottom: '0.5rem',
                    fontSize: '1.1rem',
                  }}
                />
                <div
                  className="preview-meta"
                  style={{
                    marginBottom: '2rem',
                    gap: '1.25rem',
                    display: 'flex',
                    flexWrap: 'wrap',
                  }}
                >
                  <div
                    className="meta-item"
                    style={{
                      background: 'var(--border-color)',
                      padding: '0.5rem 1.25rem',
                      borderRadius: '2rem',
                      fontSize: '0.85rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Users size={14} /> <span style={{ opacity: 0.7 }}>Assignee:</span>{' '}
                    <strong>{ctTicket.assignee || 'Chưa gán'}</strong>
                  </div>
                  <div
                    className="meta-item"
                    style={{
                      background: 'var(--border-color)',
                      padding: '0.5rem 1.25rem',
                      borderRadius: '2rem',
                      fontSize: '0.85rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Tag size={14} /> <span style={{ opacity: 0.7 }}>Loại:</span>{' '}
                    <strong>{ctTicket.issueType}</strong>
                  </div>
                </div>

                <div className="preview-section" style={{ marginBottom: '1.25rem' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <h5 className="section-title" style={{ fontSize: '0.85rem' }}>
                      Mô tả chi tiết
                    </h5>
                    <button
                      className="ai-assist-btn"
                      onClick={() => handleCtAiRewrite('description', ctTicket.description)}
                      disabled={ctRewritingFields['description']}
                      style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}
                    >
                      {ctRewritingFields['description'] ? (
                        <Loader2 size={12} className="spinner" />
                      ) : (
                        <Sparkles size={12} />
                      )}{' '}
                      AI viết lại
                    </button>
                  </div>
                  <textarea
                    className={`section-content ${ctRewritingFields['description'] ? 'field-loading' : ''}`}
                    value={ctTicket.description}
                    onChange={e => updateCtField('description', e.target.value)}
                    style={{ minHeight: '120px', fontSize: '0.85rem' }}
                  />
                </div>

                <div className="preview-section" style={{ marginBottom: '1.25rem' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <h5 className="section-title" style={{ fontSize: '0.85rem' }}>
                      Tiêu chí chấp nhận
                    </h5>
                    <button
                      className="ai-assist-btn"
                      onClick={() =>
                        handleCtAiRewrite('acceptanceCriteria', ctTicket.acceptanceCriteria)
                      }
                      disabled={ctRewritingFields['acceptanceCriteria']}
                      style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}
                    >
                      {ctRewritingFields['acceptanceCriteria'] ? (
                        <Loader2 size={12} className="spinner" />
                      ) : (
                        <Sparkles size={12} />
                      )}{' '}
                      AI tinh chỉnh
                    </button>
                  </div>
                  <textarea
                    className={`section-content ${ctRewritingFields['acceptanceCriteria'] ? 'field-loading' : ''}`}
                    value={ctTicket.acceptanceCriteria?.join('\n')}
                    onChange={e => updateCtField('acceptanceCriteria', e.target.value.split('\n'))}
                    placeholder="Mỗi tiêu chí một dòng..."
                    style={{ minHeight: '80px', fontSize: '0.85rem' }}
                  />
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '1rem',
                    marginBottom: '1.5rem',
                  }}
                >
                  <div className="preview-section">
                    <h5
                      className="section-title"
                      style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}
                    >
                      Ghi chú kỹ thuật
                    </h5>
                    <textarea
                      value={ctTicket.technicalNotes?.join('\n')}
                      onChange={e => updateCtField('technicalNotes', e.target.value.split('\n'))}
                      style={{
                        minHeight: '80px',
                        fontSize: '0.85rem',
                        width: '100%',
                        background: 'var(--surface-muted)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '0.5rem',
                        padding: '0.5rem',
                      }}
                    />
                  </div>
                  <div className="preview-section">
                    <h5
                      className="section-title"
                      style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}
                    >
                      Rủi ro & Lưu ý
                    </h5>
                    <textarea
                      value={ctTicket.risks?.join('\n')}
                      onChange={e => updateCtField('risks', e.target.value.split('\n'))}
                      style={{
                        minHeight: '80px',
                        fontSize: '0.85rem',
                        width: '100%',
                        background: 'var(--surface-muted)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '0.5rem',
                        padding: '0.5rem',
                      }}
                    />
                  </div>
                </div>

                {ctTicket.subTickets && ctTicket.subTickets.length > 0 && (
                  <div
                    style={{
                      marginTop: '2rem',
                      paddingTop: '1.5rem',
                      borderTop: '1px solid var(--border-color)',
                    }}
                  >
                    <h5
                      className="section-title"
                      style={{ color: '#4ade80', fontSize: '0.9rem', marginBottom: '1rem' }}
                    >
                      Sub-tasks ({ctTicket.subTickets.length})
                    </h5>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                        gap: '1rem',
                      }}
                    >
                      {ctTicket.subTickets.map((st: any, i: number) => (
                        <div
                          key={i}
                          style={{
                            padding: '1rem',
                            background: 'rgba(0,0,0,0.3)',
                            borderRadius: '0.75rem',
                            border: '1px solid var(--border-color)',
                          }}
                        >
                          <div
                            style={{
                              fontSize: '0.65rem',
                              color: '#4ade80',
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              background: 'rgba(74, 222, 128, 0.1)',
                              padding: '0.1rem 0.4rem',
                              borderRadius: '3px',
                              display: 'inline-block',
                              marginBottom: '0.5rem',
                            }}
                          >
                            {st.issueType}
                          </div>
                          <input
                            value={st.summary}
                            onChange={e => updateCtSubTicket(i, 'summary', e.target.value)}
                            style={{
                              width: '100%',
                              background: 'none',
                              border: 'none',
                              borderBottom: '1px solid var(--border-color)',
                              outline: 'none',
                              marginBottom: '0.4rem',
                              color: 'white',
                              fontWeight: 600,
                              fontSize: '0.85rem',
                            }}
                          />
                          <textarea
                            value={st.description}
                            onChange={e => updateCtSubTicket(i, 'description', e.target.value)}
                            style={{
                              width: '100%',
                              background: 'none',
                              border: 'none',
                              outline: 'none',
                              color: 'var(--text-secondary)',
                              fontSize: '0.75rem',
                              resize: 'none',
                              minHeight: '50px',
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!ctTicket.jiraKey && (
                  <div style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'center' }}>
                    <button
                      className="btn-primary"
                      onClick={handleCtPush}
                      disabled={ctPushing}
                      style={{
                        padding: '0.75rem 3rem',
                        fontSize: '1rem',
                        borderRadius: '1rem',
                        fontWeight: 700,
                        boxShadow: '0 0 30px rgba(99, 102, 241, 0.3)',
                      }}
                    >
                      {ctPushing ? (
                        <Loader2 className="spinner" size={20} />
                      ) : (
                        <ShieldCheck size={20} />
                      )}
                      {ctPushing ? 'Đang đẩy...' : 'Xác nhận & Đẩy lên Jira'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {bulkJsonModalMounted && (
        <CommonModal
          open={bulkJsonModalOpen}
          onClose={() => setBulkJsonModalOpen(false)}
          title="Nhập danh sách Story (JSON)"
          titleId="bulk-json-modal-title"
          classNameContent="modal-content--wide planning-bulk-json-modal"
          zIndex={1200}
        >
          <div className="modal-body">
            <p className="planning-bulk-json-modal__hint">
              Dán mảng JSON. Mỗi phần tử dùng <strong>title</strong> hoặc <strong>summary</strong>,
              tùy chọn <strong>description</strong>. Hỗ trợ mảng chuỗi, hoặc object có field{' '}
              <strong>stories</strong>.
            </p>
            <textarea
              value={bulkJsonInput}
              onChange={e => setBulkJsonInput(e.target.value)}
              className="planning-bulk-json-modal__textarea"
              rows={14}
              spellCheck={false}
            />
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="filter-btn"
              onClick={() => setBulkJsonModalOpen(false)}
            >
              Hủy
            </button>
            <button
              type="button"
              className="btn-primary planning-bulk-json-modal__apply"
              onClick={handleApplyBulkJson}
            >
              <FileJson size={16} /> Áp dụng vào danh sách
            </button>
          </div>
        </CommonModal>
      )}
    </main>
  );
};

export default Planning;
