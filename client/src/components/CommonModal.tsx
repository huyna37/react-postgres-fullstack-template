import React, { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export type CommonModalProps = {
  open: boolean;
  onClose: () => void;
  /** Tiêu đề (string hoặc node). */
  title?: ReactNode;
  /** id cho aria-labelledby — nên unique khi nhiều modal. */
  titleId?: string;
  /** Nút / hành động bổ sung bên phải header (trước nút đóng). */
  headerActions?: ReactNode;
  children: ReactNode;
  /** z-index overlay (mặc định 1100). */
  zIndex?: number;
  classNameOverlay?: string;
  classNameContent?: string;
  classNameHeader?: string;
  styleOverlay?: CSSProperties;
  styleContent?: CSSProperties;
  /** Khóa scroll body khi mở (mặc định true). */
  lockBodyScroll?: boolean;
  /** Đóng bằng Escape (mặc định true). */
  closeOnEscape?: boolean;
  /** Click nền đóng (mặc định true). */
  closeOnOverlayClick?: boolean;
  /** Hiện nút X góc (mặc định true). */
  showCloseButton?: boolean;
  /** Khi true: không đóng (Escape / nền / nút X đều vô hiệu). */
  closeDisabled?: boolean;
  /** aria-label cho dialog khi không có title. */
  ariaLabel?: string;
};

const defaultTitleId = 'common-modal-title';
const EXIT_MS = 220;

/**
 * Modal overlay dùng chung (glass / dark theme theo `modal-overlay` + `modal-content` trong index.css).
 */
const CommonModal: React.FC<CommonModalProps> = ({
  open,
  onClose,
  title,
  titleId = defaultTitleId,
  headerActions,
  children,
  zIndex = 1100,
  classNameOverlay = '',
  classNameContent = '',
  classNameHeader = '',
  styleOverlay,
  styleContent,
  lockBodyScroll = true,
  closeOnEscape = true,
  closeOnOverlayClick = true,
  showCloseButton = true,
  closeDisabled = false,
  ariaLabel,
}) => {
  const [rendered, setRendered] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true));
      });
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = window.setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!rendered || !lockBodyScroll) return;
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.classList.add('modal-open');
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      html.classList.remove('modal-open');
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, [rendered, lockBodyScroll]);

  useEffect(() => {
    if (!rendered || !closeOnEscape || closeDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rendered, closeOnEscape, closeDisabled, onClose]);

  if (!rendered) return null;

  const overlayClass = [
    'modal-overlay',
    visible ? 'modal-overlay--visible' : '',
    classNameOverlay,
  ]
    .filter(Boolean)
    .join(' ');
  const contentClass = ['modal-content', classNameContent].filter(Boolean).join(' ');

  const showHeader = title != null || showCloseButton || headerActions != null;
  const headerClass = [
    'modal-header',
    title == null ? 'modal-header--no-title' : '',
    classNameHeader,
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div
      className={overlayClass}
      style={{ zIndex, ...styleOverlay }}
      role="presentation"
      onMouseDown={(e) => {
        if (!closeOnOverlayClick || closeDisabled) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={contentClass}
        style={styleContent}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        aria-label={title == null ? ariaLabel || 'Hộp thoại' : undefined}
      >
        {showHeader && (
          <header className={headerClass}>
            {title != null ? (
              <h3 id={titleId} className="modal-header__title">
                {title}
              </h3>
            ) : null}
            {(headerActions != null || showCloseButton) && (
              <div className="modal-header__end">
                {headerActions}
                {showCloseButton ? (
                  <button
                    type="button"
                    className="modal-header__close"
                    onClick={() => {
                      if (!closeDisabled) onClose();
                    }}
                    disabled={closeDisabled}
                    aria-label="Đóng"
                  >
                    <X size={22} />
                  </button>
                ) : null}
              </div>
            )}
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
};

export default CommonModal;
