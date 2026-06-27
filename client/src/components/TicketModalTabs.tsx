import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type TicketModalTab = 'content' | 'comments' | 'attachments' | 'output' | 'subtasks';

export type TicketModalTabItem = {
  id: TicketModalTab;
  label: string;
  badge?: number;
};

type TicketModalTabsProps = {
  active: TicketModalTab;
  onChange: (tab: TicketModalTab) => void;
  tabs?: TicketModalTabItem[];
  commentCount?: number;
};

export function TicketModalTabs({ active, onChange, tabs, commentCount = 0 }: TicketModalTabsProps) {
  const tabList: TicketModalTabItem[] = tabs ?? [
    { id: 'content', label: 'Mô tả' },
    { id: 'comments', label: 'Bình luận', badge: commentCount > 0 ? commentCount : undefined },
    { id: 'output', label: 'Output' },
  ];

  return (
    <nav className="ticket-modal-tabs" role="tablist" aria-label="Phần nội dung ticket">
      {tabList.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`ticket-modal-tabs__btn${active === tab.id ? ' is-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge != null ? (
            <span className="ticket-modal-tabs__badge">{tab.badge}</span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

type TicketCollapsibleProps = {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
};

export function TicketCollapsible({
  title,
  defaultOpen = false,
  children,
  className = '',
}: TicketCollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`ticket-collapsible${open ? ' is-open' : ''} ${className}`.trim()}>
      <button
        type="button"
        className="ticket-collapsible__head"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className="ticket-collapsible__chevron" aria-hidden />
        <span>{title}</span>
      </button>
      {open ? <div className="ticket-collapsible__body">{children}</div> : null}
    </section>
  );
}
