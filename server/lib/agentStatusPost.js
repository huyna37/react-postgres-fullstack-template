const axios = require('axios');
const { assertTransitionAllowed } = require('./jiraTransitionFlow');
const {
  buildTransitionFieldsPayload,
  formatJiraApiError,
  validateTransitionInput,
} = require('./jiraTransitionFields');
const { refreshIssueCommentsAndStatus } = require('./jiraCommentPost');
const { requireUserJiraTokenByEmail } = require('./jiraToken');
const {
  fetchTransitionsFromJira,
  normalizeTransitions,
} = require('./jiraSyncOneIssue');
const { parseCommentEmail } = require('./agentCommentPost');

const MAX_BATCH = 50;

function getAgentJiraBaseUrl() {
  const url = String(process.env.JIRA_URL || '').trim();
  if (!url) {
    const err = new Error('JIRA_URL chưa cấu hình trên server');
    err.status = 503;
    throw err;
  }
  return url;
}

function resolveTransitionByTarget(transitions, target) {
  const needle = String(target || '').trim().toLowerCase();
  if (!needle) return null;

  const exactTo = transitions.find(t => (t.to?.name || '').toLowerCase() === needle);
  if (exactTo) return exactTo;

  const exactName = transitions.find(t => (t.name || '').toLowerCase() === needle);
  if (exactName) return exactName;

  const partialTo = transitions.find(t => (t.to?.name || '').toLowerCase().includes(needle));
  if (partialTo) return partialTo;

  const partialName = transitions.find(t => (t.name || '').toLowerCase().includes(needle));
  if (partialName) return partialName;

  return null;
}

function parseTransitionItems(body) {
  const raw = Array.isArray(body)
    ? body
    : Array.isArray(body?.transitions)
      ? body.transitions
      : Array.isArray(body?.items)
        ? body.items
        : body?.key
          ? [body]
          : null;

  if (!raw) {
    const err = new Error(
      'Body phải là mảng hoặc { email, transitions: [...] } hoặc một object { email, key, status }'
    );
    err.status = 400;
    throw err;
  }

  if (raw.length === 0) {
    const err = new Error('Danh sách transition trống');
    err.status = 400;
    throw err;
  }

  if (raw.length > MAX_BATCH) {
    const err = new Error(`Tối đa ${MAX_BATCH} transition mỗi request`);
    err.status = 400;
    throw err;
  }

  return raw.map((item, index) => {
    const key = String(item?.key || item?.ticketKey || item?.issueKey || '').trim();
    const transitionId = item?.transitionId ?? item?.transition_id ?? null;
    const statusTarget =
      item?.status ?? item?.statusName ?? item?.transitionName ?? item?.transition ?? null;
    const fields =
      item?.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
        ? item.fields
        : {};

    if (!key) {
      const err = new Error(`Thiếu key ở phần tử #${index + 1}`);
      err.status = 400;
      throw err;
    }
    if (!transitionId && !statusTarget) {
      const err = new Error(
        `Thiếu transitionId hoặc status cho ${key} (phần tử #${index + 1})`
      );
      err.status = 400;
      throw err;
    }

    return {
      key,
      transitionId: transitionId != null ? String(transitionId) : null,
      statusTarget: statusTarget != null ? String(statusTarget).trim() : null,
      fields,
    };
  });
}

async function applyAgentTransition({
  jiraBaseUrl,
  item,
  token,
  httpsAgent,
  db,
}) {
  const rawTransitions = await fetchTransitionsFromJira(
    jiraBaseUrl,
    item.key,
    token,
    httpsAgent
  );
  const liveTransitions = normalizeTransitions(rawTransitions);

  let transition = null;
  if (item.transitionId) {
    transition = assertTransitionAllowed(liveTransitions, item.transitionId);
  } else {
    transition = resolveTransitionByTarget(liveTransitions, item.statusTarget);
    if (!transition) {
      const available = liveTransitions
        .map(t => t.to?.name || t.name)
        .filter(Boolean)
        .join(', ');
      throw new Error(
        `Không tìm thấy transition tới "${item.statusTarget}" cho ${item.key}. Có thể: ${available || '(trống)'}`
      );
    }
  }

  const transitionInput = { fields: { ...item.fields } };

  const missing = validateTransitionInput(transition, transitionInput);
  if (missing.length > 0) {
    const err = new Error(
      `Transition "${transition.name}" yêu cầu: ${missing.map(f => f.name).join(', ')}`
    );
    err.status = 400;
    err.requiredFields = missing;
    err.transition = transition;
    throw err;
  }

  const jiraFields = buildTransitionFieldsPayload(transition, transitionInput);
  const body = {
    transition: { id: String(transition.id) },
  };
  if (Object.keys(jiraFields).length > 0) {
    body.fields = jiraFields;
  }

  await axios.post(`${jiraBaseUrl}/rest/api/2/issue/${item.key}/transitions`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    httpsAgent,
  });

  const refreshed = await refreshIssueCommentsAndStatus(
    db,
    jiraBaseUrl,
    item.key,
    token,
    httpsAgent
  );

  return {
    key: item.key,
    ok: true,
    transitionId: transition.id,
    transitionName: transition.name,
    status: refreshed.status,
    statusCategory: refreshed.statusCategory,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.email
 * @param {Array<object>} opts.items
 * @param {object} opts.db
 * @param {import('https').Agent} opts.httpsAgent
 */
async function postAgentTransitions({ email, items, db, httpsAgent }) {
  const { token, email: resolvedEmail } = await requireUserJiraTokenByEmail(db, email);
  const jiraBaseUrl = getAgentJiraBaseUrl();

  const results = [];
  for (const item of items) {
    try {
      const result = await applyAgentTransition({
        jiraBaseUrl,
        item,
        token,
        httpsAgent,
        db,
      });
      results.push(result);
    } catch (error) {
      results.push({
        key: item.key,
        ok: false,
        error: formatJiraApiError(error) || error.message || 'Failed to update status',
        requiredFields: error.requiredFields || undefined,
        transition: error.transition || undefined,
      });
    }
  }

  const ok = results.filter(r => r.ok).length;
  const failed = results.length - ok;

  return {
    email: resolvedEmail,
    total: results.length,
    ok,
    failed,
    results,
  };
}

async function fetchAgentTicketTransitions({ email, key, db, httpsAgent }) {
  const { token, email: resolvedEmail } = await requireUserJiraTokenByEmail(db, email);
  const jiraBaseUrl = getAgentJiraBaseUrl();
  const raw = await fetchTransitionsFromJira(jiraBaseUrl, key, token, httpsAgent);
  const transitions = normalizeTransitions(raw);

  return {
    email: resolvedEmail,
    key,
    transitions: transitions.map(t => ({
      id: t.id,
      name: t.name,
      to: t.to,
      hasScreen: t.hasScreen,
      requiredFields: (t.fields || []).filter(f => f.required).map(f => ({
        key: f.key,
        name: f.name,
      })),
    })),
  };
}

module.exports = {
  MAX_BATCH,
  parseTransitionItems,
  postAgentTransitions,
  fetchAgentTicketTransitions,
};
