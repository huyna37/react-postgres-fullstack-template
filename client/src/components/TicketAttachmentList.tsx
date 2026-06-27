import { Download, ExternalLink, FileText, Loader2, Paperclip } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import {
  buildAttachmentProxyUrl,
  fetchIssueAttachments,
  formatAttachmentSize,
  isImageMimeType,
  type IssueAttachmentMeta,
} from '../utils/jiraAttachments';
import JiraImageLightbox from './JiraImageLightbox';
import JiraLoadingImage from './JiraLoadingImage';

type TicketAttachmentListProps = {
  issueKey: string;
  apiFetch: (url: string, options?: RequestInit) => Promise<Response>;
  apiBaseUrl: string;
  className?: string;
  /** Dữ liệu đã có từ /api/tickets/details — tránh gọi API lại khi mở tab. */
  initialAttachments?: IssueAttachmentMeta[] | null;
  onCountChange?: (count: number) => void;
};

export default function TicketAttachmentList({
  issueKey,
  apiFetch,
  apiBaseUrl,
  className = '',
  initialAttachments = null,
  onCountChange,
}: TicketAttachmentListProps) {
  const [attachments, setAttachments] = useState<IssueAttachmentMeta[]>(
    () => initialAttachments ?? []
  );
  const [loading, setLoading] = useState(() => initialAttachments == null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const loadAttachments = useCallback(async () => {
    if (!issueKey) return;
    setLoading(true);
    setError(null);
    try {
      const list = await fetchIssueAttachments(apiFetch, apiBaseUrl, issueKey);
      setAttachments(list);
      onCountChange?.(list.length);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Không tải được đính kèm';
      setError(message);
      setAttachments([]);
      onCountChange?.(0);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, apiBaseUrl, issueKey, onCountChange]);

  useEffect(() => {
    if (initialAttachments != null) {
      setAttachments(initialAttachments);
      setLoading(false);
      onCountChange?.(initialAttachments.length);
      return;
    }
    void loadAttachments();
  }, [loadAttachments, initialAttachments, onCountChange]);

  if (loading) {
    return (
      <div className={`ticket-attachments ticket-attachments--loading ${className}`.trim()}>
        <Loader2 size={18} className="spinner" />
        <span>Đang tải đính kèm từ Jira…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`ticket-attachments ticket-attachments--error ${className}`.trim()}>
        <p>{error}</p>
        <button type="button" className="filter-btn" onClick={() => void loadAttachments()}>
          Thử lại
        </button>
      </div>
    );
  }

  if (attachments.length === 0) {
    return (
      <div className={`ticket-attachments ticket-attachments--empty ${className}`.trim()}>
        <Paperclip size={16} aria-hidden />
        <span>Ticket này chưa có file đính kèm trên Jira.</span>
      </div>
    );
  }

  return (
    <>
      <div className={`ticket-attachments ${className}`.trim()}>
        <ul className="ticket-attachments__grid">
          {attachments.map(att => {
            const isImage = isImageMimeType(att.mimeType);
            const thumbUrl = buildAttachmentProxyUrl(
              apiBaseUrl,
              issueKey,
              att.filename,
              att.hasThumbnail ? 'thumb' : 'full'
            );
            const fullUrl = buildAttachmentProxyUrl(apiBaseUrl, issueKey, att.filename, 'full');
            const sizeLabel = formatAttachmentSize(att.size);

            return (
              <li key={att.filename} className="ticket-attachments__item">
                {isImage ? (
                  <button
                    type="button"
                    className="ticket-attachments__preview"
                    onClick={() => setLightbox({ src: fullUrl, alt: att.filename })}
                    title="Xem ảnh"
                  >
                    <JiraLoadingImage
                      src={thumbUrl}
                      alt={att.filename}
                      frameClassName="jira-img-frame--attachment"
                      objectFit="cover"
                    />
                  </button>
                ) : (
                  <a
                    href={fullUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ticket-attachments__file"
                    title="Mở / tải file"
                  >
                    <FileText size={28} aria-hidden />
                  </a>
                )}
                <div className="ticket-attachments__meta">
                  <span className="ticket-attachments__name" title={att.filename}>
                    {att.filename}
                  </span>
                  {sizeLabel ? (
                    <span className="ticket-attachments__size">{sizeLabel}</span>
                  ) : null}
                </div>
                <div className="ticket-attachments__actions">
                  <a
                    href={fullUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ticket-attachments__action"
                    title="Mở tab mới"
                  >
                    <ExternalLink size={13} />
                  </a>
                  <a
                    href={fullUrl}
                    download={att.filename}
                    className="ticket-attachments__action"
                    title="Tải xuống"
                  >
                    <Download size={13} />
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <JiraImageLightbox
        open={!!lightbox}
        src={lightbox?.src ?? ''}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </>
  );
}
