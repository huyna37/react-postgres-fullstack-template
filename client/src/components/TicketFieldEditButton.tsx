import { Pencil } from 'lucide-react';
import React from 'react';

type TicketFieldEditButtonProps = {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  label?: string;
  /** Chỉ hiện icon bút — dùng cạnh tiêu đề section. */
  iconOnly?: boolean;
};

export default function TicketFieldEditButton({
  onClick,
  disabled = false,
  title = 'Chỉnh sửa',
  label = 'Chỉnh sửa',
  iconOnly = false,
}: TicketFieldEditButtonProps) {
  return (
    <button
      type="button"
      className={`ticket-field-edit-btn${iconOnly ? ' ticket-field-edit-btn--icon' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      <Pencil size={iconOnly ? 13 : 12} aria-hidden />
      {!iconOnly ? label : null}
    </button>
  );
}
