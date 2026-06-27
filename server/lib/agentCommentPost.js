const {
  buildAndPostComment,
  refreshIssueCommentsAndStatus,
} = require('./jiraCommentPost');
const { invalidateIssueAttachmentCache } = require('./jiraAttachmentCache');
const { requireUserJiraTokenByEmail } = require('./jiraToken');

const MAX_BATCH = 50;

function jiraApiErrorMessage(error) {
  return (
    error?.response?.data?.errorMessages?.[0] ||
    error?.response?.data?.errors?.comment ||
    error?.message ||
    'Failed to post comment'
  );
}

function parseCommentEmail(body, query = {}) {
  const email =
    body?.email ||
    body?.user ||
    body?.assignee ||
    query.email ||
    query.user ||
    query.assignee;
  return String(email || '').trim();
}

function parseCommentItems(body) {
  const raw = Array.isArray(body)
    ? body
    : Array.isArray(body?.comments)
      ? body.comments
      : Array.isArray(body?.items)
        ? body.items
        : null;

  if (!raw) {
    const err = new Error('Body phải là mảng hoặc { email, comments: [...] }');
    err.status = 400;
    throw err;
  }

  if (raw.length === 0) {
    const err = new Error('Danh sách comment trống');
    err.status = 400;
    throw err;
  }

  if (raw.length > MAX_BATCH) {
    const err = new Error(`Tối đa ${MAX_BATCH} comment mỗi request`);
    err.status = 400;
    throw err;
  }

  return raw.map((item, index) => {
    const key = String(item?.key || item?.ticketKey || item?.issueKey || '').trim();
    const text = String(item?.text || item?.comment || item?.body || '').trim();
    const images = Array.isArray(item?.images) ? item.images : [];

    if (!key) {
      const err = new Error(`Thiếu key ở phần tử #${index + 1}`);
      err.status = 400;
      throw err;
    }
    if (!text && images.length === 0) {
      const err = new Error(`Thiếu nội dung hoặc ảnh comment cho ${key}`);
      err.status = 400;
      throw err;
    }

    return { key, text, images };
  });
}

function getAgentJiraBaseUrl() {
  const url = String(process.env.JIRA_URL || '').trim();
  if (!url) {
    const err = new Error('JIRA_URL chưa cấu hình trên server');
    err.status = 503;
    throw err;
  }
  return url;
}

/**
 * @param {object} opts
 * @param {string} opts.email
 * @param {Array<{key:string,text:string,images?:any[]}>} opts.items
 * @param {object} opts.db
 * @param {import('https').Agent} opts.httpsAgent
 */
async function postAgentComments({ email, items, db, httpsAgent }) {
  const { token, email: resolvedEmail } = await requireUserJiraTokenByEmail(db, email);
  const jiraBaseUrl = getAgentJiraBaseUrl();

  const results = [];
  for (const item of items) {
    try {
      await buildAndPostComment(
        jiraBaseUrl,
        item.key,
        { text: item.text, images: item.images || [] },
        token,
        httpsAgent
      );
      invalidateIssueAttachmentCache(item.key);
      await refreshIssueCommentsAndStatus(db, jiraBaseUrl, item.key, token, httpsAgent);
      results.push({ key: item.key, ok: true });
    } catch (error) {
      results.push({
        key: item.key,
        ok: false,
        error: jiraApiErrorMessage(error),
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

module.exports = {
  MAX_BATCH,
  parseCommentEmail,
  parseCommentItems,
  postAgentComments,
};
