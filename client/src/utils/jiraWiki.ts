import { wrapWikiImageMarkup } from './jiraImageLoading';

const escapeHtml = (s: string) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function appAuthQuery(): string {
  if (typeof window === 'undefined') return '';
  const token = localStorage.getItem('token');
  return token ? `?token=${encodeURIComponent(token)}` : '';
}

type WikiRenderOptions = {
  eagerImages?: boolean;
};

function attachmentUrl(
  apiBaseUrl: string,
  issueKey: string,
  filename: string,
  variant: 'full' | 'thumb' = 'full'
) {
  const base = `${apiBaseUrl}/api/jira/issues/${encodeURIComponent(issueKey)}/attachments/${encodeURIComponent(filename)}`;
  const params = new URLSearchParams();
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('token') || '' : '';
  if (token) params.set('token', token);
  if (variant === 'thumb') params.set('variant', 'thumb');
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function inlineWikiFormat(
  text: string,
  issueKey: string | undefined,
  apiBaseUrl: string,
  options: WikiRenderOptions = {}
): string {
  let t = escapeHtml(text);

  if (issueKey) {
    t = t.replace(/!([^!\n]+)!/g, (_m, inner: string) => {
      const parts = String(inner)
        .split('|')
        .map(s => s.trim());
      const filename = parts[0];
      if (!filename) return _m;
      const params = parts.slice(1).join('|').toLowerCase();
      const useThumb = params.includes('thumbnail');
      const fullSrc = attachmentUrl(apiBaseUrl, issueKey, filename, 'full');
      const displaySrc = useThumb
        ? attachmentUrl(apiBaseUrl, issueKey, filename, 'thumb')
        : fullSrc;
      const loading = options.eagerImages ? 'eager' : 'lazy';

      const style: string[] = [];
      const widthMatch = params.match(/width=(\d+)/i);
      const heightMatch = params.match(/height=(\d+)/i);
      if (widthMatch) style.push(`max-width:${widthMatch[1]}px`);
      if (heightMatch) style.push(`max-height:${heightMatch[1]}px`);
      if (useThumb && !widthMatch) style.push('max-width:min(100%,420px)');

      const styleAttr = style.length ? ` style="${style.join(';')}"` : '';
      const img = `<img src="${displaySrc}" data-full-src="${fullSrc}" alt="${escapeHtml(filename)}" class="jira-wiki-img" loading="${loading}" decoding="async" role="button" tabindex="0" title="Click để phóng to ảnh"${styleAttr} />`;
      return wrapWikiImageMarkup(img);
    });
  }

  t = t.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^|\]]+)\|([^\]]+)\]/g, (_m, label: string, url: string) => {
    const safeUrl = escapeHtml(url.trim());
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  t = t.replace(/\[([^\]]+)\]/g, (_m, url: string) => {
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const safeUrl = escapeHtml(trimmed);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
    }
    return `[${url}]`;
  });

  return t;
}

/** Jira Server wiki markup → HTML (mô tả / comment). */
export function jiraWikiToHtml(
  raw: string,
  issueKey: string | undefined,
  apiBaseUrl: string,
  options: WikiRenderOptions = {}
): string {
  const text = String(raw ?? '');
  if (!text.trim()) return '';
  return jiraWikiToHtmlImpl(text, issueKey, apiBaseUrl, options);
}

function renderPlainParts(
  parts: string[],
  issueKey: string | undefined,
  apiBaseUrl: string,
  options: WikiRenderOptions
): string {
  const inner = parts
    .map((part) =>
      part === '__BR__' ? '<br />' : inlineWikiFormat(part, issueKey, apiBaseUrl, options)
    )
    .join('');
  return `<p class="jira-wiki-p">${inner}</p>`;
}

function jiraWikiToHtmlImpl(
  text: string,
  issueKey: string | undefined,
  apiBaseUrl: string,
  options: WikiRenderOptions = {}
): string {
  if (!text.trim()) return '';

  const lines = text.replace(/\n+$/, '').split('\n');
  const out: string[] = [];
  let inCode = false;
  let listType: 'ul' | 'ol' | null = null;
  let plainParts: string[] = [];
  let consecutiveBlanks = 0;

  const flushPlain = () => {
    if (!plainParts.length) return;
    out.push(renderPlainParts(plainParts, issueKey, apiBaseUrl, options));
    plainParts = [];
  };

  const closeList = () => {
    if (listType) {
      out.push(listType === 'ul' ? '</ul>' : '</ol>');
      listType = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '{code}' || trimmed === '{noformat}') {
      flushPlain();
      closeList();
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      flushPlain();
      closeList();
      out.push(`<pre class="jira-wiki-code">${escapeHtml(line)}</pre>`);
      continue;
    }

    const heading = line.match(/^h([1-6])\.\s+(.*)$/i);
    if (heading) {
      flushPlain();
      closeList();
      const level = heading[1];
      out.push(
        `<h${level} class="jira-wiki-heading">${inlineWikiFormat(heading[2], issueKey, apiBaseUrl, options)}</h${level}>`
      );
      continue;
    }

    if (line.match(/^bq\.\s+/i)) {
      flushPlain();
      closeList();
      out.push(
        `<blockquote class="jira-wiki-bq">${inlineWikiFormat(line.replace(/^bq\.\s+/i, ''), issueKey, apiBaseUrl, options)}</blockquote>`
      );
      continue;
    }

    if (trimmed === '----') {
      flushPlain();
      closeList();
      out.push('<hr class="jira-wiki-hr" />');
      continue;
    }

    const bullet = line.match(/^\s*\*\s+(.*)$/);
    if (bullet) {
      flushPlain();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul class="jira-wiki-ul">');
        listType = 'ul';
      }
      out.push(`<li>${inlineWikiFormat(bullet[1], issueKey, apiBaseUrl, options)}</li>`);
      continue;
    }

    const numbered = line.match(/^\s*#\s+(.*)$/);
    if (numbered) {
      flushPlain();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol class="jira-wiki-ol">');
        listType = 'ol';
      }
      out.push(`<li>${inlineWikiFormat(numbered[1], issueKey, apiBaseUrl, options)}</li>`);
      continue;
    }

    closeList();

    if (!trimmed) {
      consecutiveBlanks++;
      if (consecutiveBlanks >= 2) {
        if (plainParts.length && plainParts[plainParts.length - 1] === '__BR__') {
          plainParts.pop();
        }
        flushPlain();
        consecutiveBlanks = 0;
      } else if (plainParts.length > 0) {
        plainParts.push('__BR__');
      }
      continue;
    }

    consecutiveBlanks = 0;
    plainParts.push(line);
  }

  flushPlain();
  closeList();
  return out.join('\n');
}

export function clearJiraWikiHtmlCache(_issueKey?: string) {
  /* cache đã bỏ — giữ API để không phá caller cũ */
}

export function plainTextToHtml(text: string): string {
  const normalized = String(text ?? '').replace(/\n+$/, '');
  if (!normalized.trim()) return '';

  const lines = normalized.split('\n');
  const parts: string[] = [];
  let consecutiveBlanks = 0;
  const blocks: string[][] = [];

  const flushBlock = () => {
    if (!parts.length) return;
    blocks.push([...parts]);
    parts.length = 0;
  };

  for (const line of lines) {
    if (!line.trim()) {
      consecutiveBlanks++;
      if (consecutiveBlanks >= 2) {
        if (parts.length && parts[parts.length - 1] === '__BR__') {
          parts.pop();
        }
        flushBlock();
        consecutiveBlanks = 0;
      } else if (parts.length > 0) {
        parts.push('__BR__');
      }
      continue;
    }
    consecutiveBlanks = 0;
    parts.push(escapeHtml(line));
  }
  flushBlock();

  return blocks
    .map((block) => {
      const inner = block
        .map((part) => (part === '__BR__' ? '<br />' : part))
        .join('');
      return `<p class="jira-wiki-p">${inner}</p>`;
    })
    .join('\n');
}
