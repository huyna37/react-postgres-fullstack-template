import React, { memo, useEffect, useMemo, useRef, useState } from 'react';

import { jiraWikiToHtml, plainTextToHtml } from '../utils/jiraWiki';
import { storedContentToWiki } from '../utils/jiraStoredContent';

import { bindJiraImagesInRoot } from '../utils/jiraImageLoading';

import JiraImageLightbox from './JiraImageLightbox';



function resolveWikiImageFullSrc(img: HTMLElement): string | null {

  const full = img.getAttribute('data-full-src');

  if (full) return full;

  const src = img.getAttribute('src');

  if (!src) return null;

  try {

    const url = new URL(src, window.location.origin);

    url.searchParams.delete('variant');

    return url.toString();

  } catch {

    return src.replace(/([?&])variant=thumb(&|$)/i, '$1').replace(/[?&]$/, '');

  }

}



type JiraRichContentProps = {

  content?: string | null;

  issueKey?: string;

  apiBaseUrl: string;

  apiFetch?: (url: string, options?: RequestInit) => Promise<Response>;

  className?: string;

  maxHeight?: string;

  /** Ticket/modal: tải ảnh ngay (loading="eager"), không lazy. */

  eagerImages?: boolean;

};



function JiraRichContent({

  content,

  issueKey,

  apiBaseUrl,

  apiFetch,

  className = '',

  maxHeight,

  eagerImages = false,

}: JiraRichContentProps) {

  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const contentRef = useRef<HTMLDivElement>(null);



  const html = useMemo(() => {

    const text = storedContentToWiki(String(content ?? ''));

    if (!text.trim()) return '';

    if (issueKey) return jiraWikiToHtml(text, issueKey, apiBaseUrl, { eagerImages });

    return plainTextToHtml(text);

  }, [content, issueKey, apiBaseUrl, eagerImages]);



  useEffect(() => {

    const root = contentRef.current;

    if (!root) return;

    return bindJiraImagesInRoot(root);

  });



  const handleContentClick = (e: React.MouseEvent<HTMLDivElement>) => {

    const el = e.target as HTMLElement;

    if (el.tagName === 'IMG' && el.classList.contains('jira-wiki-img')) {

      e.preventDefault();

      e.stopPropagation();

      const src = resolveWikiImageFullSrc(el);

      if (!src) return;

      setLightbox({

        src,

        alt: el.getAttribute('alt') || 'Ảnh đính kèm',

      });

    }

  };



  if (!html) return null;



  return (

    <>

      <div

        ref={contentRef}

        className={`jira-rich-content${eagerImages ? ' jira-rich-content--eager' : ''} ${className}`.trim()}

        style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}

        dangerouslySetInnerHTML={{ __html: html }}

        onClick={handleContentClick}

      />

      <JiraImageLightbox

        open={!!lightbox}

        src={lightbox?.src ?? ''}

        alt={lightbox?.alt}

        onClose={() => setLightbox(null)}

      />

    </>

  );

}



export default memo(JiraRichContent);

