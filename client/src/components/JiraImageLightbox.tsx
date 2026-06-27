import React, { useCallback, useEffect, useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';

type JiraImageLightboxProps = {
  open: boolean;
  src: string;
  alt?: string;
  onClose: () => void;
};

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
}

export default function JiraImageLightbox({ open, src, alt = 'Ảnh đính kèm', onClose }: JiraImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (open) {
      setScale(1);
      setLoading(true);
      setError(false);
    }
  }, [open, src]);

  useLayoutEffect(() => {
    if (open && imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setLoading(false);
    }
  }, [open, src, scale]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const zoomBy = useCallback((delta: number) => {
    setScale((s) => clampScale(s + delta));
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 0.12 : -0.12);
  };

  if (!open || !src) return null;

  return createPortal(
    <div
      className="jira-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh phóng to"
      onClick={onClose}
    >
      <div className="jira-image-lightbox__toolbar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="jira-image-lightbox__btn" onClick={() => zoomBy(-0.25)} title="Thu nhỏ">
          <ZoomOut size={18} />
        </button>
        <span className="jira-image-lightbox__scale">{Math.round(scale * 100)}%</span>
        <button type="button" className="jira-image-lightbox__btn" onClick={() => zoomBy(0.25)} title="Phóng to">
          <ZoomIn size={18} />
        </button>
        <button type="button" className="jira-image-lightbox__btn" onClick={() => setScale(1)} title="Đặt lại">
          <RotateCcw size={18} />
        </button>
        <button type="button" className="jira-image-lightbox__btn jira-image-lightbox__btn--close" onClick={onClose} title="Đóng">
          <X size={20} />
        </button>
      </div>

      <div className="jira-image-lightbox__stage" onWheel={handleWheel}>
        <div
          className="jira-image-lightbox__content"
          onClick={(e) => e.stopPropagation()}
        >
          {loading && !error ? (
            <div className="jira-image-lightbox__loading">
              <Loader2 size={28} className="spinner" />
            </div>
          ) : null}
          {error ? (
            <p className="jira-image-lightbox__error">Không tải được ảnh.</p>
          ) : (
            <img
              ref={imgRef}
              src={src}
              alt={alt}
              className="jira-image-lightbox__img"
              style={{ transform: `scale(${scale})` }}
              draggable={false}
              onLoad={() => setLoading(false)}
              onError={() => {
                setLoading(false);
                setError(true);
              }}
            />
          )}
        </div>
      </div>
      <p className="jira-image-lightbox__hint">Lăn chuột để zoom · Esc hoặc click nền để đóng</p>
    </div>,
    document.body
  );
}
