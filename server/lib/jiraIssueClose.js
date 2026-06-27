const axios = require('axios');
const {
  OUTPUT_FIELD_KEY,
  isCommentField,
  buildTransitionFieldsPayload,
  formatJiraApiError,
} = require('./jiraTransitionFields');
const { refreshIssueCommentsAndStatus } = require('./jiraCommentPost');
const {
  fetchTransitionsFromJira,
  normalizeTransitions,
} = require('./jiraSyncOneIssue');
const { mapWithConcurrency } = require('./asyncPool');

const CLOSE_CONCURRENCY = 5;

function isIssueClosed({ status } = {}) {
  const name = String(status || '').trim().toLowerCase();
  if (!name) return false;
  if (/re-?open|mở lại|mo lai/.test(name)) return false;
  return (
    name === 'closed' ||
    name === 'đóng' ||
    name === 'close' ||
    name.includes('closed') ||
    name.includes('đóng') ||
    name.includes('dong')
  );
}

function findCloseTransition(transitions) {
  if (!Array.isArray(transitions) || transitions.length === 0) return null;

  const toClosed = transitions.find(
    t => t.to?.name && /closed|đóng|dong/i.test(t.to.name)
  );
  if (toClosed) return toClosed;

  const namedClose = transitions.find(
    t => /close|đóng|dong/i.test(t.name || '')
  );
  if (namedClose) return namedClose;

  return (
    transitions.find(
      t =>
        /done|resolve|hoàn thành/i.test(t.name || '') ||
        (t.to?.name && /done|resolved|hoàn thành/i.test(t.to.name))
    ) || null
  );
}

function buildAutoCloseFields(transition, outputText = 'Đã hoàn thành.') {
  const localFields = {};
  for (const field of transition.fields || []) {
    if (isCommentField(field.key)) continue;

    const isOutput = field.key === OUTPUT_FIELD_KEY;
    const isRequired = !!field.required;
    if (!isOutput && !isRequired) continue;

    let val = '';
    if (isOutput) {
      val = String(outputText || '').trim() || 'Đã hoàn thành.';
    } else {
      const allowed = field.allowedValues || [];
      if (allowed.length === 1) {
        val = allowed[0].id || allowed[0].name || allowed[0].value || '';
      } else if (field.key === 'resolution' && allowed.length > 0) {
        const preferred =
          allowed.find(v => /^(done|fixed|complete|hoàn)/i.test(v.name || '')) ||
          allowed.find(v => !/won.?t|cancel|reject/i.test(v.name || '')) ||
          allowed[0];
        val = preferred?.id || preferred?.name || '';
      } else {
        const fieldType = field.schema?.type || '';
        if (fieldType === 'date') {
          const d = new Date();
          val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        } else if (fieldType === 'datetime') {
          const d = new Date();
          const pad = num => String(num).padStart(2, '0');
          val = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        } else {
          val = 'Done';
        }
      }
    }
    localFields[field.key] = val;
  }
  return localFields;
}

async function closeIssueOnJira({
  db,
  jiraBaseUrl,
  issueKey,
  token,
  httpsAgent,
  outputText,
}) {
  const key = String(issueKey || '').trim();
  if (!key) {
    throw new Error('Thiếu issueKey');
  }

  const dbIssue = await db.query(
    'SELECT status, status_category FROM jira_issues WHERE key = $1',
    [key]
  );
  const row = dbIssue.rows[0] || {};
  const statusName = row.status || '';
  const statusCat = row.status_category || '';

  if (isIssueClosed({ status: statusName, statusCategory: statusCat })) {
    return {
      issueKey: key,
      ok: true,
      skipped: true,
      status: statusName,
      statusCategory: statusCat,
      message: 'Ticket đã đóng',
    };
  }

  const rawTrans = await fetchTransitionsFromJira(jiraBaseUrl, key, token, httpsAgent);
  const transitions = normalizeTransitions(rawTrans);
  const closeTransition = findCloseTransition(transitions);

  if (!closeTransition) {
    const err = new Error('Không tìm thấy transition đóng (Done/Closed/Hoàn thành)');
    err.status = 400;
    throw err;
  }

  const targetStatusName = closeTransition.to?.name?.toLowerCase();
  if (targetStatusName && targetStatusName === String(statusName).toLowerCase()) {
    return {
      issueKey: key,
      ok: true,
      skipped: true,
      status: statusName,
      statusCategory: statusCat,
      message: 'Ticket đã ở trạng thái đích',
    };
  }

  const localFields = buildAutoCloseFields(closeTransition, outputText);
  const transitionFields = buildTransitionFieldsPayload(closeTransition, { fields: localFields });
  const body = {
    transition: { id: String(closeTransition.id) },
  };
  if (Object.keys(transitionFields).length > 0) {
    body.fields = transitionFields;
  }

  await axios.post(`${jiraBaseUrl}/rest/api/2/issue/${key}/transitions`, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    httpsAgent,
  });

  const refreshed = await refreshIssueCommentsAndStatus(db, jiraBaseUrl, key, token, httpsAgent);

  return {
    issueKey: key,
    ok: true,
    skipped: false,
    transitionId: closeTransition.id,
    transitionName: closeTransition.name,
    status: refreshed.status,
    statusCategory: refreshed.statusCategory,
  };
}

async function closeIssuesOnJira({
  db,
  jiraBaseUrl,
  issueKeys,
  token,
  httpsAgent,
  outputText,
}) {
  const uniqueKeys = [...new Set((issueKeys || []).map(k => String(k || '').trim()).filter(Boolean))];

  const results = await mapWithConcurrency(uniqueKeys, CLOSE_CONCURRENCY, async issueKey => {
    try {
      return await closeIssueOnJira({
        db,
        jiraBaseUrl,
        issueKey,
        token,
        httpsAgent,
        outputText,
      });
    } catch (error) {
      return {
        issueKey,
        ok: false,
        error: formatJiraApiError(error) || error.message || 'Không đóng được ticket',
      };
    }
  });

  const ok = results.filter(r => r.ok).length;
  const closed = results.filter(r => r.ok && !r.skipped).length;
  const skipped = results.filter(r => r.ok && r.skipped).length;

  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    closed,
    skipped,
    results,
  };
}

module.exports = {
  isIssueClosed,
  findCloseTransition,
  buildAutoCloseFields,
  closeIssueOnJira,
  closeIssuesOnJira,
  formatJiraApiError,
};
