import { Loader2 } from 'lucide-react';
import React, { useEffect, useState, useRef, useLayoutEffect } from 'react';

type JiraLoadingImageProps = {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  frameClassName?: string;
  objectFit?: 'cover' | 'contain';
  onClick?: () => void;
};

export default function JiraLoadingImage({
  src,
  alt,
  className = '',
  imgClassName = 'jira-loading-image__img',
  frameClassName = '',
  objectFit = 'cover',
  onClick,
}: JiraLoadingImageProps) {
  const [state, setState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setState('loading');
  }, [src]);

  useLayoutEffect(() => {
    if (imgRef.current?.complete && imgRef.current.naturalWidth > 0) {
      setState('loaded');
    }
  }, [src]);

  const frameClass = [
    'jira-img-frame',
    state === 'loading' ? 'is-loading' : state === 'loaded' ? 'is-loaded' : 'is-error',
    frameClassName,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={frameClass}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {state === 'loading' ? (
        <>
          <span className="jira-img-frame__shimmer" aria-hidden />
          <span className="jira-img-frame__spinner" aria-hidden>
            <Loader2 size={18} className="spinner" />
          </span>
        </>
      ) : null}
      {state === 'error' ? (
        <span className="jira-img-frame__error" title="Không tải được ảnh">
          Ảnh lỗi
        </span>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={imgClassName}
          style={{ objectFit }}
          loading="eager"
          decoding="async"
          onLoad={() => setState('loaded')}
          onError={() => setState('error')}
        />
      )}
    </span>
  );
}
