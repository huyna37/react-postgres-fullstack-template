import { buildAttachmentProxyUrl } from './jiraAttachments';
import { decorateComposerImageWrap } from './jiraImageLoading';
import type { ComposerInlineImage } from './jiraImages';
import { storedContentToWiki } from './jiraStoredContent';

export type ImageAlign = 'left' | 'center' | 'right';

export const DEFAULT_INLINE_IMAGE_WIDTH = 420;
export const MIN_INLINE_IMAGE_WIDTH = 120;
export const MAX_INLINE_IMAGE_WIDTH = 900;

export function imageFilenameForId(imageId: string, mimeType?: string) {
  const ext =
    mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/gif'
        ? 'gif'
        : mimeType === 'image/webp'
          ? 'webp'
          : 'jpg';
  return `paste-${imageId}.${ext}`;
}

export function buildWikiImageMacro(filename: string, width: number, align: ImageAlign) {
  const parts = [`width=${Math.round(width)}`];
  if (align !== 'center') parts.push(`align=${align}`);
  return `!${filename}|${parts.join(',')}!`;
}

function parseWikiImageParams(params: string) {
  let width = DEFAULT_INLINE_IMAGE_WIDTH;
  let align: ImageAlign = 'center';
  for (const token of params.split(',').map(s => s.trim().toLowerCase())) {
    if (token.startsWith('width=')) {
      const n = parseInt(token.slice(6), 10);
      if (!Number.isNaN(n)) width = n;
    } else if (token === 'align=left' || token === 'left') align = 'left';
    else if (token === 'align=right' || token === 'right') align = 'right';
    else if (token === 'align=center' || token === 'center') align = 'center';
    else if (token === 'thumbnail') width = Math.min(width, 280);
  }
  return { width: clampWidth(width), align };
}

function clampWidth(width: number) {
  return Math.min(MAX_INLINE_IMAGE_WIDTH, Math.max(MIN_INLINE_IMAGE_WIDTH, Math.round(width)));
}

function isPendingPasteFilename(filename: string) {
  return /^paste-/i.test(filename);
}

function appendInlineWiki(parent: HTMLElement, text: string) {
  if (!text) return;
  const pattern = /(\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const token = match[1];
    if (token.startsWith('*') && token.endsWith('*')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(1, -1);
      parent.appendChild(strong);
    } else if (token.startsWith('_') && token.endsWith('_')) {
      const em = document.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else if (token.startsWith('[') && token.endsWith(']')) {
      const inner = token.slice(1, -1);
      const pipe = inner.indexOf('|');
      const anchor = document.createElement('a');
      if (pipe >= 0) {
        anchor.textContent = inner.slice(0, pipe);
        anchor.href = inner.slice(pipe + 1).trim();
      } else {
        anchor.textContent = inner;
        anchor.href = inner;
      }
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      parent.appendChild(anchor);
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
}

function appendWikiImage(
  editor: HTMLElement,
  filename: string,
  paramStr: string,
  opts?: { issueKey?: string; apiBaseUrl?: string; images?: ComposerInlineImage[] }
) {
  const imagesByFilename = new Map(
    (opts?.images || []).map(img => [
      img.filename || imageFilenameForId(img.id, img.file?.type),
      img,
    ])
  );
  const { width, align } = parseWikiImageParams(paramStr);
  const wrap = document.createElement('div');
  wrap.className = 'jira-rich-composer__img-wrap';
  wrap.contentEditable = 'false';
  wrap.dataset.align = align;
  wrap.dataset.width = String(width);
  wrap.classList.add(`is-align-${align}`);

  const imageEl = document.createElement('img');
  let localPreview = false;

  if (isPendingPasteFilename(filename)) {
    const local = imagesByFilename.get(filename);
    if (local) {
      wrap.dataset.imageId = local.id;
      imageEl.src = local.previewUrl;
      localPreview = true;
    }
  } else {
    wrap.classList.add('jira-rich-composer__img-wrap--existing');
    wrap.dataset.existingFilename = filename;
    if (opts?.issueKey && opts?.apiBaseUrl) {
      const variant = paramStr.toLowerCase().includes('thumbnail') ? 'thumb' : 'full';
      imageEl.src = buildAttachmentProxyUrl(opts.apiBaseUrl, opts.issueKey, filename, variant);
    }
  }

  imageEl.alt = filename;
  imageEl.draggable = false;
  imageEl.style.width = `${width}px`;

  const resizeHandle = document.createElement('span');
  resizeHandle.className = 'jira-rich-composer__resize-handle';
  resizeHandle.title = 'Kéo để đổi kích thước';

  wrap.append(imageEl, resizeHandle);
  decorateComposerImageWrap(wrap, imageEl, { localPreview });
  editor.appendChild(wrap);
  editor.appendChild(document.createTextNode('\u00A0'));
}

function appendWikiLinesToEditor(
  editor: HTMLElement,
  text: string,
  opts?: { issueKey?: string; apiBaseUrl?: string; images?: ComposerInlineImage[] }
) {
  const lines = text.replace(/\n+$/, '').split('\n');
  let inCode = false;
  let listEl: HTMLUListElement | HTMLOListElement | null = null;
  let listType: 'ul' | 'ol' | null = null;
  let plainSegs: Array<string | '__BR__'> = [];
  let consecutiveBlanks = 0;

  const flushPlainSegs = () => {
    if (!plainSegs.length) return;
    const block = document.createElement('div');
    for (const seg of plainSegs) {
      if (seg === '__BR__') {
        block.appendChild(document.createElement('br'));
      } else {
        appendInlineWiki(block, seg);
      }
    }
    editor.appendChild(block);
    plainSegs = [];
  };

  const closeList = () => {
    if (listEl) {
      editor.appendChild(listEl);
      listEl = null;
      listType = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '{code}' || trimmed === '{noformat}') {
      flushPlainSegs();
      closeList();
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      flushPlainSegs();
      closeList();
      const pre = document.createElement('pre');
      pre.className = 'jira-wiki-code';
      pre.textContent = line;
      editor.appendChild(pre);
      continue;
    }

    const heading = line.match(/^h([1-6])\.\s+(.*)$/i);
    if (heading) {
      flushPlainSegs();
      closeList();
      const el = document.createElement(`h${heading[1]}`);
      appendInlineWiki(el, heading[2]);
      editor.appendChild(el);
      continue;
    }

    if (line.match(/^bq\.\s+/i)) {
      flushPlainSegs();
      closeList();
      const bq = document.createElement('blockquote');
      appendInlineWiki(bq, line.replace(/^bq\.\s+/i, ''));
      editor.appendChild(bq);
      continue;
    }

    if (trimmed === '----') {
      flushPlainSegs();
      closeList();
      editor.appendChild(document.createElement('hr'));
      continue;
    }

    const bullet = line.match(/^\s*\*\s+(.*)$/);
    if (bullet) {
      flushPlainSegs();
      if (listType !== 'ul') {
        closeList();
        listEl = document.createElement('ul');
        listType = 'ul';
      }
      const li = document.createElement('li');
      appendInlineWiki(li, bullet[1]);
      listEl!.appendChild(li);
      continue;
    }

    const numbered = line.match(/^\s*#\s+(.*)$/);
    if (numbered) {
      flushPlainSegs();
      if (listType !== 'ol') {
        closeList();
        listEl = document.createElement('ol');
        listType = 'ol';
      }
      const li = document.createElement('li');
      appendInlineWiki(li, numbered[1]);
      listEl!.appendChild(li);
      continue;
    }

    closeList();

    if (!trimmed) {
      consecutiveBlanks++;
      if (consecutiveBlanks >= 2) {
        if (plainSegs.length && plainSegs[plainSegs.length - 1] === '__BR__') {
          plainSegs.pop();
        }
        flushPlainSegs();
        consecutiveBlanks = 0;
      } else if (plainSegs.length > 0) {
        plainSegs.push('__BR__');
      }
      continue;
    }

    consecutiveBlanks = 0;
    plainSegs.push(line);
  }

  flushPlainSegs();
  closeList();
}

export function hydrateEditorFromWiki(
  editor: HTMLElement,
  wiki: string,
  opts?: { issueKey?: string; apiBaseUrl?: string; images?: ComposerInlineImage[] }
) {
  editor.innerHTML = '';
  const text = storedContentToWiki(String(wiki || ''));
  if (!text.trim()) return;

  const parts = text.split(/(![^!\n]+!)/g);
  for (const part of parts) {
    const macro = part.match(/^!([^!\n]+)!$/);
    if (macro) {
      const bits = macro[1].split('|').map(s => s.trim());
      const filename = bits[0];
      if (!filename) continue;
      appendWikiImage(editor, filename, bits.slice(1).join(','), opts);
      continue;
    }
    if (!part) continue;
    appendWikiLinesToEditor(editor, part, opts);
  }
}

function wikiForElement(el: HTMLElement, imagesById: Map<string, ComposerInlineImage>): string {
  const tag = el.tagName;

  if (el.classList.contains('jira-rich-composer__img-wrap')) {
    const existingFilename = el.dataset.existingFilename;
    if (existingFilename) {
      const img = el.querySelector('img');
      const width = Math.round(
        parseFloat(img?.style.width || '') ||
          parseFloat(el.dataset.width || '') ||
          DEFAULT_INLINE_IMAGE_WIDTH
      );
      const align = (el.dataset.align as ImageAlign) || 'center';
      return buildWikiImageMacro(existingFilename, width, align);
    }

    const imageId = el.dataset.imageId;
    if (!imageId) return '';
    const stored = imagesById.get(imageId);
    const img = el.querySelector('img');
    const width = Math.round(
      parseFloat(img?.style.width || '') ||
        parseFloat(el.dataset.width || '') ||
        stored?.width ||
        DEFAULT_INLINE_IMAGE_WIDTH
    );
    const align = (el.dataset.align as ImageAlign) || stored?.align || 'center';
    const filename = stored?.filename || imageFilenameForId(imageId, stored?.file.type);
    return buildWikiImageMacro(filename, width, align);
  }

  if (tag === 'BR') return '\n';

  if (/^H[1-6]$/.test(tag)) {
    const inner = Array.from(el.childNodes)
      .map(child => wikiForNode(child, imagesById))
      .join('')
      .trim();
    return inner ? `h${tag[1]}. ${inner}` : '';
  }

  if (tag === 'BLOCKQUOTE') {
    const inner = Array.from(el.childNodes)
      .map(child => wikiForNode(child, imagesById))
      .join('')
      .trim();
    return inner ? `bq. ${inner}` : '';
  }

  if (tag === 'PRE') {
    const code = el.textContent || '';
    return code ? `{code}\n${code}\n{code}` : '';
  }

  if (tag === 'HR') return '----';

  if (tag === 'B' || tag === 'STRONG') {
    const inner = Array.from(el.childNodes)
      .map(child => wikiForNode(child, imagesById))
      .join('');
    return inner ? `*${inner}*` : '';
  }

  if (tag === 'I' || tag === 'EM') {
    const inner = Array.from(el.childNodes)
      .map(child => wikiForNode(child, imagesById))
      .join('');
    return inner ? `_${inner}_` : '';
  }

  if (tag === 'UL') {
    return Array.from(el.children)
      .filter(li => li.tagName === 'LI')
      .map(li => {
        const body = Array.from(li.childNodes)
          .map(child => wikiForNode(child, imagesById))
          .join('')
          .trim();
        return body ? `* ${body}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (tag === 'OL') {
    return Array.from(el.children)
      .filter(li => li.tagName === 'LI')
      .map(li => {
        const body = Array.from(li.childNodes)
          .map(child => wikiForNode(child, imagesById))
          .join('')
          .trim();
        return body ? `# ${body}` : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (tag === 'DIV' || tag === 'P') {
    return Array.from(el.childNodes)
      .map(child => wikiForNode(child, imagesById))
      .join('');
  }

  return Array.from(el.childNodes)
    .map(child => wikiForNode(child, imagesById))
    .join('');
}

function wikiForNode(node: Node, imagesById: Map<string, ComposerInlineImage>): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  return wikiForElement(node as HTMLElement, imagesById);
}

export function exportEditorToJiraWiki(
  editor: HTMLElement,
  images: ComposerInlineImage[]
): { wiki: string; images: ComposerInlineImage[] } {
  const imagesById = new Map(images.map(img => [img.id, img]));
  const blocks: string[] = [];

  editor.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || '').trim();
      if (text) blocks.push(text);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains('jira-rich-composer__img-wrap')) {
      blocks.push(wikiForElement(el, imagesById));
      return;
    }
    const chunk = wikiForElement(el, imagesById).trim();
    if (chunk) blocks.push(chunk);
  });

  return {
    wiki: blocks.join('\n\n').trim(),
    images,
  };
}

export function descriptionHasWikiImages(text: string) {
  return /![^!\r\n]+!/.test(String(text || ''));
}
