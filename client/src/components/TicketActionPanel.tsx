import React, { useState } from 'react';
import { Loader2, MessageSquarePlus, Send } from 'lucide-react';
import JiraRichComposer from './JiraRichComposer';
import { showError, showToast } from '../utils/swal';
import {
  serializeJiraImages,
  type ComposerInlineImage,
  revokeJiraImagePreviews,
} from '../utils/jiraImages';

type TicketActionPanelProps = {
  issueKey: string;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  canAct: boolean;
  onSuccess?: (result: { status?: string; statusCategory?: string }) => void;
  className?: string;
};

export default function TicketActionPanel({
  issueKey,
  apiFetch,
  apiBaseUrl,
  canAct,
  onSuccess,
  className = '',
}: TicketActionPanelProps) {
  const [commentWiki, setCommentWiki] = useState('');
  const [commentImages, setCommentImages] = useState<ComposerInlineImage[]>([]);
  const [postingComment, setPostingComment] = useState(false);
  const [composerResetKey, setComposerResetKey] = useState(0);

  const hasPayload = commentWiki.trim().length > 0 || commentImages.length > 0;

  const handlePostComment = async () => {
    if (!hasPayload) {
      showError('Nhập nội dung hoặc dán ảnh trước khi gửi.');
      return;
    }
    setPostingComment(true);
    try {
      const res = await apiFetch(`${apiBaseUrl}/api/tickets/${issueKey}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: commentWiki,
          images:
            commentImages.length > 0 ? await serializeJiraImages(commentImages) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Gửi bình luận thất bại.');
      showToast('Đã gửi bình luận lên Jira.', 'success');
      revokeJiraImagePreviews(commentImages);
      setCommentWiki('');
      setCommentImages([]);
      setComposerResetKey(k => k + 1);
      onSuccess?.({ status: data.status, statusCategory: data.statusCategory });
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : 'Gửi bình luận thất bại.');
    } finally {
      setPostingComment(false);
    }
  };

  if (!canAct) return null;

  return (
    <section
      className={`ticket-action-panel ticket-action-panel--compact ticket-action-panel--pinned ${className}`.trim()}
    >
      <header className="ticket-action-panel__head ticket-action-panel__head--actions">
        <span className="ticket-action-panel__head-label">
          <MessageSquarePlus size={13} aria-hidden />
          Gửi bình luận
        </span>
        <button
          type="button"
          className="btn-primary ticket-action-panel__send-btn"
          onClick={handlePostComment}
          disabled={postingComment || !hasPayload}
          title="Gửi bình luận lên Jira"
        >
          {postingComment ? <Loader2 size={14} className="spinner" /> : <Send size={14} />}
          Gửi
        </button>
      </header>

      <JiraRichComposer
        key={`${issueKey}-${composerResetKey}`}
        id={`comment-${issueKey}`}
        issueKey={issueKey}
        apiBaseUrl={apiBaseUrl}
        wiki={commentWiki}
        images={commentImages}
        onChange={({ wiki, images }) => {
          setCommentWiki(wiki);
          setCommentImages(images);
        }}
        disabled={postingComment}
        className="jira-rich-composer--compact"
        minHeight={64}
        placeholder="Viết bình luận..."
        hint="Ctrl+V dán ảnh."
      />
    </section>
  );
}
