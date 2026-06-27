/** Plain text from Jira/DB description for card previews */
export function plainTicketDescription(raw: string | null | undefined): string {
  if (!raw?.trim()) return '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerptTicketText(raw: string | null | undefined, maxLen = 200): string {
  const plain = plainTicketDescription(raw);
  if (!plain) return '';
  if (plain.length <= maxLen) return plain;
  return `${plain.slice(0, maxLen).trim()}…`;
}
