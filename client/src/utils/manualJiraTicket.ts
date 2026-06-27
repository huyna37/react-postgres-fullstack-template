import type { JiraTicket } from '../types';

function emptyTicketFields(): Pick<
  JiraTicket,
  | 'priority'
  | 'labels'
  | 'components'
  | 'acceptanceCriteria'
  | 'technicalNotes'
  | 'risks'
  | 'suggestedTeam'
  | 'estimatedComplexity'
> {
  return {
    priority: 'Medium',
    labels: [],
    components: [],
    acceptanceCriteria: [],
    technicalNotes: [],
    risks: [],
    suggestedTeam: '',
    estimatedComplexity: 'Medium',
  };
}

/** Lấy tiêu đề từ dòng đầu context; nếu một dòng thì dùng cả đoạn (tối đa 120 ký tự). */
export function deriveSummaryFromContext(context: string): string {
  const trimmed = context.trim();
  if (!trimmed) return '';
  const firstLine = trimmed.split('\n')[0]?.trim() || trimmed;
  if (firstLine.length <= 120) return firstLine;
  return `${firstLine.slice(0, 117)}...`;
}

export function buildManualJiraTicket(opts: {
  context: string;
  ticketType: string;
  assignee: string;
  createAutoSubTasks?: boolean;
  summary?: string;
}): JiraTicket {
  const description = opts.context.trim();
  const summary = opts.summary?.trim() || deriveSummaryFromContext(description);
  const base = emptyTicketFields();

  const ticket: JiraTicket = {
    summary,
    description,
    issueType: opts.ticketType,
    assignee: opts.assignee,
    subTickets: [],
    ...base,
  };

  if (opts.ticketType === 'Story' && opts.createAutoSubTasks) {
    ticket.subTickets = [
      {
        summary: `[DEV] Triển khai — ${summary}`,
        description,
        issueType: 'Sub-task',
        subTickets: [],
        ...base,
      },
      {
        summary: `[TEST] Kiểm thử — ${summary}`,
        description: 'Kiểm thử tính năng',
        issueType: 'Sub-task',
        subTickets: [],
        ...base,
      },
    ];
  }

  return ticket;
}
