const axios = require('axios');
const https = require('https');
const {
  loadUserWorklogIdentity,
  fetchLatestUserWorklogForIssue,
  worklogBelongsToUser,
  worklogStartedInMonth,
} = require('./lib/worklogFromDb');
const { syncWorklogEntriesForIssue } = require('./lib/jiraWorklogIndex');
const { fetchIssueFromJira, mapJiraIssue } = require('./lib/jiraSyncOneIssue');

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

/**
 * Jira Server thường yêu cầu started dạng yyyy-MM-dd'T'HH:mm:ss.SSS+0000, không phải chuỗi .000Z từ toISOString().
 */
function formatWorklogStartedForJiraServer(isoOrDate) {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return undefined;
  const p = (n, z = 2) => String(n).padStart(z, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}+0000`;
}

/** Giống cron: timeSpent + comment (luôn là string); started chỉ thêm khi có và format Jira */
function buildWorklogPostBody({ timeSpent, comment, started }) {
  const body = {
    timeSpent: String(timeSpent).trim(),
    comment: comment != null ? String(comment) : '',
  };
  if (started) {
    const formatted = formatWorklogStartedForJiraServer(started);
    if (formatted) body.started = formatted;
  }
  return body;
}

/** POST /rest/api/2/issue/{issueKey}/worklog — path issue giống cron (không encodeURIComponent) */
function postIssueWorklog(jiraBaseUrl, issueKey, payload, token) {
  const url = `${jiraBaseUrl}/rest/api/2/issue/${String(issueKey).trim()}/worklog?adjustEstimate=auto`;
  const body = buildWorklogPostBody(payload);
  return axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    httpsAgent,
  });
}

function jiraWorklogBelongsToUser(wl, identity) {
  const author = wl?.author || {};
  const row = {
    author_account_id: author.accountId || author.name || author.key || null,
    author_email: author.emailAddress || author.name || null,
  };
  return worklogBelongsToUser(row, identity, { emailByJiraId: new Map() });
}

async function fetchIssueWorklogsFromJira(jiraBaseUrl, issueKey, token) {
  const issueTrim = String(issueKey).trim();
  const worklogs = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `${jiraBaseUrl}/rest/api/2/issue/${issueTrim}/worklog?startAt=${startAt}&maxResults=${maxResults}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent,
    });
    const batch = Array.isArray(res.data?.worklogs) ? res.data.worklogs : [];
    worklogs.push(...batch);
    const total = Number(res.data?.total) || batch.length;
    startAt += batch.length;
    if (startAt >= total || batch.length === 0) break;
  }

  return worklogs;
}

function pickLatestUserWorklog(worklogs, identity, opts = {}) {
  const mine = worklogs
    .filter(wl => jiraWorklogBelongsToUser(wl, identity))
    .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime());

  if (!mine.length) return null;

  const year = opts.year != null ? parseInt(opts.year, 10) : null;
  const month = opts.month != null ? parseInt(opts.month, 10) : null;
  if (year && month) {
    const inMonth = mine.filter(wl => worklogStartedInMonth(wl.started, year, month));
    if (inMonth.length) return inMonth[0];
  }

  return mine[0];
}

async function resolveUserWorklogIdForReplace(db, userId, issueKey, opts, jiraBaseUrl, token) {
  const identity = await loadUserWorklogIdentity(db, userId);
  if (!identity) return null;

  try {
    const worklogs = await fetchIssueWorklogsFromJira(jiraBaseUrl, issueKey, token);
    const picked = pickLatestUserWorklog(worklogs, identity, opts);
    if (picked?.id != null) return String(picked.id);
  } catch (error) {
    console.warn('[Worklog] Jira list fallback DB:', error.response?.data || error.message);
  }

  const fromDb = await fetchLatestUserWorklogForIssue(db, userId, issueKey, opts);
  return fromDb?.id != null ? String(fromDb.id) : null;
}

async function syncIssueWorklogsToDb(db, issueKey, jiraBaseUrl, token) {
  const key = String(issueKey).trim();
  const issueRes = await db.query(
    'SELECT project_key FROM jira_issues WHERE key = $1 LIMIT 1',
    [key]
  );
  const projectKey = issueRes.rows[0]?.project_key || key.split('-')[0] || key;

  const worklogs = await fetchIssueWorklogsFromJira(jiraBaseUrl, key, token);
  await syncWorklogEntriesForIssue(db, key, projectKey, { worklogs });

  try {
    const raw = await fetchIssueFromJira(jiraBaseUrl, key, token, httpsAgent);
    const mapped = mapJiraIssue(raw);
    await db.query(
      `UPDATE jira_issues
       SET time_spent = $1,
           remaining_estimate = $2,
           updated_at = COALESCE($3::timestamptz, updated_at)
       WHERE key = $4`,
      [
        mapped.timeSpent || 0,
        mapped.remainingEstimate || 0,
        mapped.updated ? new Date(mapped.updated) : null,
        key,
      ]
    );
  } catch (error) {
    console.warn('[Worklog] sync issue timespent:', error.response?.data || error.message);
  }
}

async function deleteIssueWorklog(jiraBaseUrl, issueKey, worklogId, token) {
  const issueTrim = String(issueKey).trim();
  const wlEnc = encodeURIComponent(String(worklogId));
  const deleteUrl = `${jiraBaseUrl}/rest/api/2/issue/${issueTrim}/worklog/${wlEnc}`;
  await axios.delete(deleteUrl, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
  });
}

module.exports = {
  httpsAgent,
  formatWorklogStartedForJiraServer,
  buildWorklogPostBody,
  postIssueWorklog,
  fetchIssueWorklogsFromJira,
  resolveUserWorklogIdForReplace,
  deleteIssueWorklog,
  syncIssueWorklogsToDb,
};
