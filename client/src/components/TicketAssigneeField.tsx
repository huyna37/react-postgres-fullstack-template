import { Loader2 } from 'lucide-react';
import React from 'react';
import { getAvatarUrl } from '../utils/avatar';
import TicketFieldEditButton from './TicketFieldEditButton';

export function resolveAssigneeSelectValue(assignee?: any | null) {
  if (!assignee) return '';
  return assignee.accountId || assignee.emailAddress || '';
}

export function buildAssigneeFromId(assigneeId: string, projectUsers: any[]) {
  if (!assigneeId) return null;
  const user = projectUsers.find(
    u =>
      u.accountId === assigneeId ||
      (u.emailAddress && u.emailAddress.toLowerCase() === assigneeId.toLowerCase())
  );
  if (!user) {
    return {
      accountId: assigneeId,
      emailAddress: assigneeId.includes('@') ? assigneeId : null,
      displayName: assigneeId,
      avatarUrl: null,
      role: null,
    };
  }
  return {
    accountId: user.accountId || user.emailAddress,
    emailAddress: user.emailAddress || null,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl || null,
    role: user.role || null,
  };
}

type TicketAssigneeFieldProps = {
  assignee: any | null;
  /** Khi locked (vd. sub TEST): hiển thị assignee story cha thay vì sub. */
  displayAssignee?: any | null;
  projectUsers: any[];
  canEdit: boolean;
  locked?: boolean;
  saving?: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChange: (assigneeId: string) => void | Promise<void>;
  apiBaseUrl?: string;
  compact?: boolean;
  showAvatar?: boolean;
  className?: string;
  stopPropagation?: boolean;
};

export default function TicketAssigneeField({
  assignee,
  displayAssignee,
  projectUsers,
  canEdit,
  locked = false,
  saving = false,
  editing,
  onStartEdit,
  onCancelEdit,
  onChange,
  apiBaseUrl,
  compact = false,
  showAvatar = false,
  className = '',
  stopPropagation = false,
}: TicketAssigneeFieldProps) {
  const shown = locked && displayAssignee != null ? displayAssignee : assignee;
  const displayName = shown?.displayName || null;
  const editable = canEdit && !locked;
  const selectedValue = resolveAssigneeSelectValue(assignee);
  const selectedUser = projectUsers.find(
    u =>
      u.accountId === selectedValue ||
      (u.emailAddress && u.emailAddress.toLowerCase() === selectedValue.toLowerCase())
  );
  const selectedLabel = selectedUser
    ? `${selectedUser.displayName}${selectedUser.role ? ` · ${selectedUser.role}` : ''}`
    : displayName || '';

  const interactionProps = stopPropagation
    ? {
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
        onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
      }
    : {};

  const handleSelectChange = async (next: string) => {
    try {
      await onChange(next);
      onCancelEdit();
    } catch {
      /* parent shows error */
    }
  };

  if (editing && editable) {
    return (
      <span
        className={`ticket-assignee-field ticket-assignee-field--editing${compact ? ' ticket-assignee-field--compact' : ''} ${className}`.trim()}
        {...interactionProps}
      >
        <select
          value={selectedValue}
          onChange={e => void handleSelectChange(e.target.value)}
          className="premium-select ticket-assignee-field__select"
          disabled={saving}
          title={selectedLabel}
          autoFocus
        >
          <option value="">— Chưa gán —</option>
          {projectUsers.map(u => (
            <option key={u.accountId} value={u.accountId}>
              {u.displayName}
              {u.role ? ` · ${u.role}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ticket-field-cancel-btn ticket-assignee-field__cancel"
          onClick={onCancelEdit}
          disabled={saving}
        >
          Hủy
        </button>
        {saving ? <Loader2 size={12} className="spinner ticket-assignee-field__spinner" /> : null}
      </span>
    );
  }

  return (
    <span
      className={`ticket-assignee-field${compact ? ' ticket-assignee-field--compact' : ''} ${className}`.trim()}
      {...interactionProps}
    >
      {showAvatar && displayName ? (
        shown?.avatarUrl && apiBaseUrl ? (
          <img
            src={getAvatarUrl(shown.avatarUrl, apiBaseUrl)}
            alt={displayName}
            className="ticket-assignee-field__avatar"
          />
        ) : (
          <span className="avatar-fallback avatar-fallback--sm ticket-assignee-field__avatar-fallback">
            {displayName[0]}
          </span>
        )
      ) : null}
      {displayName ? (
        <strong
          className={`ticket-assignee-field__name${compact ? ' text-body' : ''}`}
          title={displayName}
        >
          {displayName}
        </strong>
      ) : (
        <span className="ticket-assignee-field__empty">Chưa gán</span>
      )}
      {editable ? (
        <TicketFieldEditButton
          onClick={e => {
            if (stopPropagation) e.stopPropagation();
            onStartEdit();
          }}
          disabled={saving}
          iconOnly
          title="Đổi người gán"
        />
      ) : null}
      {saving ? <Loader2 size={12} className="spinner ticket-assignee-field__spinner" /> : null}
    </span>
  );
}
