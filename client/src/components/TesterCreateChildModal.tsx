import { Bug, Loader2, Plus, User as UserIcon } from 'lucide-react';
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useState,
} from 'react';
import CommonModal from './CommonModal';
import JiraRichComposer from './JiraRichComposer';
import {
  type ComposerInlineImage,
  revokeJiraImagePreviews,
  serializeJiraImages,
} from '../utils/jiraImages';
import { showError, showSuccess } from '../utils/swal';

export type CreateChildKind = 'dev' | 'test' | 'bug';

export type TesterCreateChildModalHandle = {
  open: (kind: CreateChildKind) => void;
};

const CREATE_CHILD_META: Record<
  CreateChildKind,
  { label: string; badgeClass: string; placeholder: string }
> = {
  dev: {
    label: 'Sub-task DEV',
    badgeClass: 'tester-create-child-modal__badge--dev',
    placeholder: 'VD: Sửa validation form đăng ký',
  },
  test: {
    label: 'Sub-task TEST',
    badgeClass: 'tester-create-child-modal__badge--test',
    placeholder: 'VD: Kiểm thử luồng đăng ký',
  },
  bug: {
    label: 'Bug',
    badgeClass: 'tester-create-child-modal__badge--bug',
    placeholder: 'VD: Lỗi hiển thị sai dữ liệu báo cáo',
  },
};

const isTestTask = (sub: any) => {
  if (!sub) return false;
  const summary = sub.summary?.toUpperCase() || '';
  if (summary.includes('[TEST]')) return true;
  if (summary.includes('[DEV]')) return false;
  return sub.assignee?.role === 'tester';
};

type TesterCreateChildModalProps = {
  activeTask: any | null;
  projectUsers: any[];
  myEmail: string | null;
  userHasJiraToken: boolean;
  canCreateChildTicket: boolean;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  onCreated: () => void;
};

const TesterCreateChildModal = forwardRef<
  TesterCreateChildModalHandle,
  TesterCreateChildModalProps
>(function TesterCreateChildModal(
  {
    activeTask,
    projectUsers,
    myEmail,
    userHasJiraToken,
    canCreateChildTicket,
    apiFetch,
    apiBaseUrl,
    onCreated,
  },
  ref
) {
  const [createChildKind, setCreateChildKind] = useState<CreateChildKind | null>(null);
  const [createChildSummary, setCreateChildSummary] = useState('');
  const [createChildWiki, setCreateChildWiki] = useState('');
  const [createChildImages, setCreateChildImages] = useState<ComposerInlineImage[]>([]);
  const [createChildAssigneeId, setCreateChildAssigneeId] = useState('');
  const [createChildSubmitting, setCreateChildSubmitting] = useState(false);
  const [parentSnapshot, setParentSnapshot] = useState<{ key: string; summary: string } | null>(
    null
  );

  const resolveDefaultAssigneeForKind = useCallback(
    (kind: CreateChildKind, task: any) => {
      if (kind === 'test') {
        if (task?.assignee?.accountId) {
          const parentAssignee = projectUsers.find(
            u => u.accountId === task.assignee.accountId || 
                 (u.emailAddress && task.assignee.emailAddress && u.emailAddress.toLowerCase() === task.assignee.emailAddress.toLowerCase())
          );
          if (parentAssignee?.role === 'tester') return parentAssignee.accountId;
        }
        
        const testSub = task?.subTasks?.find(
          (s: any) => isTestTask(s) && s.assignee?.accountId
        );
        if (testSub?.assignee?.accountId) return testSub.assignee.accountId;

        const me = projectUsers.find(
          u =>
            (u.emailAddress?.toLowerCase() === myEmail?.toLowerCase() ||
            u.accountId?.toLowerCase() === myEmail?.toLowerCase())
        );
        if (me?.role === 'tester' && me.accountId) return me.accountId;

        const tester = projectUsers.find(u => u.role === 'tester');
        if (tester?.accountId) return tester.accountId;
      }
      if (kind === 'dev' || kind === 'bug') {
        const devSub = task?.subTasks?.find(
          (s: any) => !isTestTask(s) && s.assignee?.accountId
        );
        if (devSub?.assignee?.accountId) return devSub.assignee.accountId;
        const devUser = projectUsers.find(u => u.role !== 'tester');
        if (devUser?.accountId) return devUser.accountId;
      }
      return projectUsers[0]?.accountId || '';
    },
    [projectUsers, myEmail]
  );

  const closeCreateChildModal = useCallback(() => {
    setCreateChildImages(prev => {
      revokeJiraImagePreviews(prev);
      return [];
    });
    setCreateChildKind(null);
    setCreateChildSummary('');
    setCreateChildWiki('');
    setCreateChildAssigneeId('');
    setCreateChildSubmitting(false);
    setParentSnapshot(null);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      open(kind: CreateChildKind) {
        if (!userHasJiraToken) {
          showError('Cần cấu hình Jira token cá nhân để tạo sub-task/bug.');
          return;
        }
        if (!activeTask?.key) return;
        if (activeTask.isSynthesized) {
          showError('Không thể tạo sub-task cho story mồ côi.');
          return;
        }
        if (!canCreateChildTicket) {
          showError('Bạn không có quyền tạo sub-task/bug trên trang này.');
          return;
        }
        setParentSnapshot({ key: activeTask.key, summary: activeTask.summary || activeTask.key });
        setCreateChildKind(kind);
        setCreateChildSummary('');
        setCreateChildWiki('');
        setCreateChildImages([]);
        setCreateChildAssigneeId(resolveDefaultAssigneeForKind(kind, activeTask));
      },
    }),
    [
      activeTask,
      canCreateChildTicket,
      userHasJiraToken,
      resolveDefaultAssigneeForKind,
    ]
  );

  const submitCreateChild = async () => {
    if (!parentSnapshot?.key || !createChildKind) return;
    const summary = createChildSummary.trim();
    if (!summary) {
      showError('Vui lòng nhập tiêu đề sub-task/bug.');
      return;
    }

    setCreateChildSubmitting(true);
    try {
      const description = createChildWiki.trim();
      const images =
        createChildImages.length > 0 ? await serializeJiraImages(createChildImages) : undefined;
      const res = await apiFetch(
        `${apiBaseUrl}/api/tickets/${encodeURIComponent(parentSnapshot.key)}/children`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: createChildKind,
            summary,
            description: description || undefined,
            images,
            assigneeId: createChildAssigneeId || undefined,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Không thể tạo sub-task/bug');
      }
      showSuccess(`Đã tạo ${data.key} trên Jira.`);
      closeCreateChildModal();
      onCreated();
    } catch (err: any) {
      showError(err.message || 'Lỗi khi tạo sub-task/bug');
    } finally {
      setCreateChildSubmitting(false);
    }
  };

  const open = !!createChildKind && !!parentSnapshot;

  return (
    <CommonModal
      open={open}
      onClose={closeCreateChildModal}
      closeDisabled={createChildSubmitting}
      title={
        createChildKind && parentSnapshot ? (
          <span className="tester-create-child-modal__title-row">
            <span
              className={`tester-create-child-modal__badge ${CREATE_CHILD_META[createChildKind].badgeClass}`}
            >
              {createChildKind === 'bug' ? <Bug size={14} /> : <Plus size={14} />}
              {CREATE_CHILD_META[createChildKind].label}
            </span>
            <span className="tester-create-child-modal__parent">Story {parentSnapshot.key}</span>
          </span>
        ) : null
      }
      titleId="tester-create-child-title"
      classNameContent="modal-content--wide tester-create-child-modal"
      zIndex={1300}
    >
      {createChildKind && parentSnapshot ? (
        <>
          <div className="modal-body">
            <p className="tester-create-child-modal__story-hint">
              Thuộc story: <strong>{parentSnapshot.summary}</strong>
            </p>

            <div className="ticket-transition-field">
              <label className="ticket-transition-field__label" htmlFor="tester-create-summary">
                Tiêu đề
                <span className="ticket-transition-field__req">*</span>
              </label>
              <input
                id="tester-create-summary"
                type="text"
                value={createChildSummary}
                onChange={e => setCreateChildSummary(e.target.value)}
                placeholder={CREATE_CHILD_META[createChildKind].placeholder}
                className="ticket-transition-field__input"
                autoFocus
                disabled={createChildSubmitting}
              />
            </div>

            <div className="ticket-transition-field">
              <label className="ticket-transition-field__label" htmlFor="tester-create-desc">
                Mô tả
                <span className="tester-create-child-modal__optional">(tuỳ chọn)</span>
              </label>
              <JiraRichComposer
                key={`${parentSnapshot.key}-${createChildKind}`}
                wiki={createChildWiki}
                images={createChildImages}
                onChange={({ wiki, images }) => {
                  setCreateChildWiki(wiki);
                  setCreateChildImages(images);
                }}
                disabled={createChildSubmitting}
                className="tester-create-child-modal__composer"
                hint="Soạn mô tả như CKEditor: chèn ảnh vào đúng chỗ, kéo góc để đổi kích thước, căn trái/giữa/phải."
                minHeight={200}
              />
            </div>

            <div className="ticket-transition-field">
              <label className="ticket-transition-field__label" htmlFor="tester-create-assignee">
                <UserIcon size={13} style={{ marginRight: '4px', verticalAlign: '-2px' }} />
                Gán cho
              </label>
              <select
                id="tester-create-assignee"
                value={createChildAssigneeId}
                onChange={e => setCreateChildAssigneeId(e.target.value)}
                className="ticket-transition-field__input"
                disabled={createChildSubmitting}
              >
                <option value="">— Chưa gán —</option>
                {projectUsers.map(u => (
                  <option key={u.accountId} value={u.accountId}>
                    {u.displayName}
                    {u.role ? ` · ${u.role}` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="filter-btn"
              onClick={closeCreateChildModal}
              disabled={createChildSubmitting}
            >
              Huỷ
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submitCreateChild()}
              disabled={createChildSubmitting || !createChildSummary.trim()}
            >
              {createChildSubmitting ? (
                <Loader2 size={14} className="spinner" />
              ) : createChildKind === 'bug' ? (
                <Bug size={14} />
              ) : (
                <Plus size={14} />
              )}
              Tạo
            </button>
          </div>
        </>
      ) : null}
    </CommonModal>
  );
});

export default TesterCreateChildModal;
