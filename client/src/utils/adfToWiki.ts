type AdfMark = { type: string; attrs?: Record<string, unknown> };
type AdfNode = {
  type: string;
  text?: string;
  marks?: AdfMark[];
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
};

export type AdfDoc = { type: 'doc'; content?: AdfNode[] };

function applyMarks(text: string, marks?: AdfMark[]): string {
  if (!marks?.length) return text;
  let out = text;
  for (const mark of marks) {
    if (mark.type === 'strong') out = `*${out}*`;
    else if (mark.type === 'em') out = `_${out}_`;
    else if (mark.type === 'link') {
      const href = String(mark.attrs?.href || '');
      out = href ? `[${out}|${href}]` : out;
    }
  }
  return out;
}

function inlineNodes(nodes?: AdfNode[]): string {
  if (!Array.isArray(nodes)) return '';
  return nodes
    .map((n) => {
      if (n.type === 'text') return applyMarks(n.text || '', n.marks);
      if (n.type === 'hardBreak') return '\n';
      if (Array.isArray(n.content)) return inlineNodes(n.content);
      return '';
    })
    .join('');
}

function listItemWiki(node: AdfNode, ordered: boolean): string {
  const prefix = ordered ? '# ' : '* ';
  const body = (node.content || [])
    .map((child) => blockNode(child))
    .filter(Boolean)
    .join('\n');
  if (!body) return '';
  return body
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function blockNode(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return inlineNodes(node.content);
    case 'heading': {
      const level = Number(node.attrs?.level) || 1;
      const n = Math.min(6, Math.max(1, level));
      return `h${n}. ${inlineNodes(node.content)}`;
    }
    case 'bulletList':
      return (node.content || []).map((item) => listItemWiki(item, false)).filter(Boolean).join('\n');
    case 'orderedList':
      return (node.content || []).map((item) => listItemWiki(item, true)).filter(Boolean).join('\n');
    case 'listItem':
      return listItemWiki(node, false);
    case 'blockquote':
      return `bq. ${(node.content || []).map((child) => blockNode(child)).filter(Boolean).join(' ')}`;
    case 'codeBlock':
      return `{code}\n${inlineNodes(node.content)}\n{code}`;
    case 'rule':
      return '----';
    default:
      if (Array.isArray(node.content)) {
        return node.content.map((child) => blockNode(child)).filter(Boolean).join('\n');
      }
      return '';
  }
}

/** ADF (Jira Cloud) → wiki markup để hiển thị / soạn thảo. */
export function adfToWiki(doc: AdfDoc): string {
  if (!doc?.content?.length) return '';
  return doc.content
    .map((node) => blockNode(node))
    .filter(Boolean)
    .join('\n\n');
}
