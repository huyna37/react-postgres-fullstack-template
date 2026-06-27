import React from 'react';
import { ExternalLink } from 'lucide-react';

type JiraTicketKeyLinkProps = {
  issueKey: string;
  onOpen: (key: string) => void;
  className?: string;
  showIcon?: boolean;
  stopPropagation?: boolean;
  children?: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
};

export default function JiraTicketKeyLink({
  issueKey,
  onOpen,
  className = 'jira-ticket-key-link',
  showIcon = false,
  stopPropagation = false,
  children,
  title,
  style,
}: JiraTicketKeyLinkProps) {
  const key = String(issueKey || '').trim();
  if (!key) return null;

  return (
    <button
      type="button"
      className={className}
      title={title ?? `Mở ${key} trên Jira`}
      style={style}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onOpen(key);
      }}
    >
      {children ?? key}
      {showIcon ? <ExternalLink size={12} aria-hidden /> : null}
    </button>
  );
}
