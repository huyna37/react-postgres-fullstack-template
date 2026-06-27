const db = require('../db');
const {
  EXCLUDE_CANCELLED_REJECTED_SQL,
  isSkippedAgentIssueStatus,
} = require('./jiraIssueStatusFilters');
const {
  JIRA_USER_ASSIGNEE_JOIN,
  normalizeEmail,
} = require('./assigneeIdentity');
const { normalizeCommentsForResponse } = require('./jiraComments');

const MAX_COMMENTS = 5;
const MAX_TEXT = 3000;

const BUG_TYPE_SQL = `
  (
    LOWER(COALESCE(i.issue_type, '')) LIKE '%bug%'
    OR LOWER(COALESCE(i.issue_type, '')) LIKE '%lỗi%'
  )
`;

const NON_BUG_SUBTASK_SQL = `
  i.is_subtask = true
  AND NOT ${BUG_TYPE_SQL}
`;

function buildTypeFilter(type) {
  const t = String(type || 'bug').trim().toLowerCase();
  switch (t) {
    case 'bug':
    case 'bugs':
      return BUG_TYPE_SQL;
    case 'subtask':
    case 'subtasks':
      return NON_BUG_SUBTASK_SQL;
    case 'dev':
      return `${NON_BUG_SUBTASK_SQL} AND COALESCE(u.role, i.assignee_role, '') != 'tester'`;
    case 'test':
      return `${NON_BUG_SUBTASK_SQL} AND COALESCE(u.role, i.assignee_role, '') = 'tester'`;
    case 'all':
      return 'TRUE';
    default:
      return null;
  }
}

function buildStatusFilter(status) {
  const s = String(status || 'open').trim().toLowerCase();
  if (s === 'all' || s === 'any') return '';
  return `AND COALESCE(LOWER(i.status_category), '') <> 'done'`;
}

function clipText(val, max = MAX_TEXT) {
  const s = String(val || '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function mapAgentTicketRow(row, email) {
  if (isSkippedAgentIssueStatus(row.status)) return null;

  const comments = normalizeCommentsForResponse(
    Array.isArray(row.comments) ? row.comments : []
  )
    .slice(0, MAX_COMMENTS)
    .map(c => clipText(`[${c.author.displayName}] ${c.body}`, 800))
    .filter(Boolean);

  const ticket = {
    key: row.key,
    summary: row.summary || '',
    status: row.status || '',
    description: clipText(row.description),
    output: clipText(row.output),
  };

  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  if (attachments.length > 0) {
    ticket.attachments = attachments.map(att => ({
      filename: att.filename,
      mimeType: att.mimeType,
      size: att.size,
      url: `/api/agent/tickets/${row.key}/attachments/${encodeURIComponent(att.filename)}?email=${encodeURIComponent(email)}`
    }));
  }

  if (row.parent_key) {
    ticket.parent = {
      key: row.parent_key,
      summary: row.parent_summary || '',
    };
  }

  if (comments.length) ticket.comments = comments;

  return ticket;
}

/**
 * @param {object} opts
 * @param {string} opts.email
 * @param {string} [opts.type] bug | subtask | dev | test | all
 * @param {string} [opts.projectKey]
 * @param {string} [opts.status] open | all
 * @param {number} [opts.limit]
 */
async function fetchAgentTickets({
  email,
  type = 'bug',
  projectKey,
  status = 'open',
  limit = 100,
  httpsAgent,
}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    const err = new Error('email is required');
    err.status = 400;
    throw err;
  }

  const typeFilter = buildTypeFilter(type);
  if (!typeFilter) {
    const err = new Error('Invalid type. Use: bug, subtask, dev, test, all');
    err.status = 400;
    throw err;
  }

  const project =
    String(projectKey || process.env.JIRA_PROJECT_KEY || 'BXDCSDL').trim() || 'BXDCSDL';
  const cappedLimit = Math.min(Math.max(parseInt(String(limit), 10) || 100, 1), 500);
  const statusFilter = buildStatusFilter(status);

  const result = await db.query(
    `
    SELECT
      i.key,
      i.summary,
      i.status,
      i.description,
      i.output,
      i.comments,
      i.attachments,
      i.parent_key,
      p.summary AS parent_summary
    FROM jira_issues i
    ${JIRA_USER_ASSIGNEE_JOIN}
    LEFT JOIN jira_issues p ON p.key = i.parent_key
    WHERE i.project_key = $1
      AND (${typeFilter})
      ${statusFilter}
      ${EXCLUDE_CANCELLED_REJECTED_SQL}
      AND (
        LOWER(TRIM(COALESCE(i.assignee_account_id, ''))) = LOWER($2)
        OR EXISTS (
          SELECT 1 FROM jira_users u2
          WHERE (
            LOWER(TRIM(COALESCE(u2.email_address, ''))) = LOWER($2)
            OR LOWER(TRIM(COALESCE(u2.username, ''))) = LOWER($2)
          )
          AND (
            u2.account_id = i.assignee_account_id
            OR LOWER(TRIM(COALESCE(u2.email_address, ''))) = LOWER(TRIM(i.assignee_account_id))
          )
        )
      )
    ORDER BY
      CASE WHEN COALESCE(LOWER(i.status_category), '') = 'done' THEN 1 ELSE 0 END,
      i.updated_at DESC NULLS LAST,
      i.key DESC
    LIMIT $3
    `,
    [project, normalizedEmail, cappedLimit]
  );

  const tickets = result.rows.map(row => mapAgentTicketRow(row, normalizedEmail)).filter(Boolean);

  let token = null;
  const jiraBaseUrl = String(process.env.JIRA_URL || '').trim();
  if (normalizedEmail && jiraBaseUrl && httpsAgent) {
    try {
      const { requireUserJiraTokenByEmail } = require('./jiraToken');
      const tokenInfo = await requireUserJiraTokenByEmail(db, normalizedEmail);
      token = tokenInfo?.token;
    } catch (e) {
      console.warn(`[fetchAgentTickets] Cannot get token for email ${normalizedEmail}:`, e.message);
    }
  }

  if (token && jiraBaseUrl && httpsAgent) {
    try {
      const { resolveAttachmentFile } = require('./jiraAttachmentCache');
      await Promise.all(
        tickets.map(async (ticket) => {
          if (!ticket.attachments || ticket.attachments.length === 0) return;
          await Promise.all(
            ticket.attachments.map(async (att) => {
              if (att.mimeType && att.mimeType.startsWith('image/')) {
                try {
                  const file = await resolveAttachmentFile(
                    jiraBaseUrl,
                    ticket.key,
                    att.filename,
                    token,
                    httpsAgent,
                    { db }
                  );
                  if (file) {
                    att.dataBase64 = file.buffer.toString('base64');
                  }
                } catch (err) {
                  console.error(`[fetchAgentTickets] Failed to load image for ticket ${ticket.key} file ${att.filename}:`, err.message);
                }
              }
            })
          );
        })
      );
    } catch (err) {
      console.error('[fetchAgentTickets] Failed to batch load attachments:', err.message);
    }
  }

  return {
    count: tickets.length,
    tickets,
  };
}

module.exports = {
  fetchAgentTickets,
  mapAgentTicketRow,
};
