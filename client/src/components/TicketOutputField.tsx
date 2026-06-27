import React, { useEffect, useRef } from 'react';
import { outputFieldRows } from '../utils/outputFieldRows';

type TicketOutputFieldProps = {
  value: string;
  editing: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  onChange: (next: string) => void;
};

export default function TicketOutputField({
  value,
  editing,
  disabled = false,
  className = '',
  placeholder = 'Ghi kết quả xử lý (text thuần)...',
  onChange,
}: TicketOutputFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = outputFieldRows(value);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el || !editing) return;
    el.style.height = 'auto';
    const minPx = 48;
    const maxPx = 280;
    el.style.height = `${Math.min(maxPx, Math.max(minPx, el.scrollHeight))}px`;
  }, [value, editing]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        className={`section-content ticket-field ticket-field--compact ticket-output-field ${className}`.trim()}
        rows={rows}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
      />
    );
  }

  if (!value.trim()) return null;

  return (
    <div className={`ticket-output-view ticket-field ticket-field--plain ${className}`.trim()}>
      {value}
    </div>
  );
}
