import React from 'react';
import { MessageSquare } from 'lucide-react';
import JiraRichContent from './JiraRichContent';
import JiraTicketKeyLink from './JiraTicketKeyLink';
import {
  formatCommentBody,
  commentAuthorInitials,
  formatCommentDate,
  type JiraCommentItem,
} from '../utils/jiraComment';

type TicketCommentListProps = {
  comments?: JiraCommentItem[] | null;
  title?: string;
  hint?: string;
  maxHeight?: string;
  /** List cuộn trong vùng còn lại — dùng cùng tab comments có form gửi cố định dưới. */
  fillAvailable?: boolean;
  className?: string;
  /** Key mặc định để resolve ảnh wiki (!file.png!) trong comment */
  issueKey?: string;
  apiBaseUrl?: string;
  apiFetch?: (url: string, options?: RequestInit) => Promise<Response>;
  eagerImages?: boolean;
  onOpenJiraTicket?: (key: string) => void;
};

export default function TicketCommentList({
  comments,
  title,
  hint,
  maxHeight = 'min(48vh, 440px)',
  fillAvailable = false,
  className = '',
  issueKey,
  apiBaseUrl = '',
  apiFetch,
  eagerImages = false,
  onOpenJiraTicket,
}: TicketCommentListProps) {
  const list = comments ?? [];
  const count = list.length;
  const hasRelatedSources = list.some((c) => c.sourceType && c.sourceType !== 'self');
  const resolvedTitle =
    title ?? (hasRelatedSources ? 'Bình luận (story & sub-task)' : 'Bình luận');

  const compactSourceLabel = (comment: JiraCommentItem) => {
    const key = comment.sourceKey?.trim();
    if (!key) return comment.sourceLabel || null;
    if (comment.sourceType === 'parent') return `Story · ${key}`;
    if (comment.sourceType === 'sibling') return `Sub · ${key}`;
    if (comment.sourceType === 'self') return key;
    return key;
  };

  const sectionClass = `ticket-comments${fillAvailable ? ' ticket-comments--fill' : ''} ${className}`.trim();
  const scrollClass = `ticket-comments__scroll ticket-comments__scroll--bounded${
    fillAvailable ? ' ticket-comments__scroll--fill' : ''
  }`;

  return (
    <section className={sectionClass}>
      <header className="ticket-comments__header">
        <MessageSquare size={14} aria-hidden />
        <span>
          {resolvedTitle} ({count})
        </span>
      </header>
      {hint ? <p className="ticket-comments__hint ticket-comments__hint--compact">{hint}</p> : null}
      <div
        className={scrollClass}
        style={fillAvailable ? undefined : { maxHeight }}
      >
        {count === 0 ? (
          <p className="ticket-comments__empty">Chưa có bình luận trên ticket này.</p>
        ) : (
          <ul className="ticket-comments__list">
            {list.map((comment) => {
              const body = formatCommentBody(comment.body);
              const name = comment.author?.displayName || 'Ẩn danh';
              const email = comment.author?.emailAddress?.trim();
              const sourceType = comment.sourceType;
              const itemKey = `${comment.sourceKey || 'self'}-${comment.id || comment.created || `${name}-${body.slice(0, 20)}`}`;

              return (
                <li key={itemKey} className="ticket-comment">
                  <div className="ticket-comment__avatar" aria-hidden>
                    {commentAuthorInitials(name)}
                  </div>
                  <div className="ticket-comment__main">
                    {compactSourceLabel(comment) ? (
                      onOpenJiraTicket && comment.sourceKey ? (
                        <JiraTicketKeyLink
                          issueKey={comment.sourceKey}
                          onOpen={onOpenJiraTicket}
                          className={`ticket-comment__source ticket-comment__source--${sourceType || 'self'} jira-ticket-key-link`}
                          title={[comment.sourceSummary, comment.sourceLabel].filter(Boolean).join(' — ')}
                        >
                          {compactSourceLabel(comment)}
                        </JiraTicketKeyLink>
                      ) : (
                        <span
                          className={`ticket-comment__source ticket-comment__source--${sourceType || 'self'}`}
                          title={[comment.sourceSummary, comment.sourceLabel].filter(Boolean).join(' — ')}
                        >
                          {compactSourceLabel(comment)}
                        </span>
                      )
                    ) : null}
                    <div className="ticket-comment__meta">
                      <span className="ticket-comment__author" title={email || undefined}>
                        {name}
                      </span>
                      <time className="ticket-comment__time" dateTime={comment.created}>
                        {formatCommentDate(comment.created)}
                      </time>
                    </div>
                    <div className="ticket-comment__body">
                      {body ? (
                        <JiraRichContent
                          content={body}
                          issueKey={comment.sourceKey || issueKey}
                          apiBaseUrl={apiBaseUrl}
                          apiFetch={apiFetch}
                          eagerImages={eagerImages}
                          className="jira-rich-content--compact"
                        />
                      ) : (
                        <span className="ticket-comments__empty-inline">(Nội dung trống)</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
