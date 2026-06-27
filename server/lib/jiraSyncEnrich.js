const axios = require('axios');
const https = require('https');
const { fetchIssueWorklogsFromJira } = require('../jiraWorklog');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function isJiraPagedFieldComplete(field) {
  if (!field || typeof field !== 'object') return true;
  const total = Number(field.total) || 0;
  const embedded = Array.isArray(field.comments)
    ? field.comments.length
    : Array.isArray(field.worklogs)
      ? field.worklogs.length
      : 0;
  return embedded >= total;
}

async function fetchIssueCommentsFromJira(jiraBaseUrl, issueKey, token) {
  const issueTrim = String(issueKey).trim();
  const comments = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const url = `${jiraBaseUrl}/rest/api/2/issue/${issueTrim}/comment`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params: { startAt, maxResults },
      httpsAgent,
    });
    const batch = Array.isArray(res.data?.comments) ? res.data.comments : [];
    comments.push(...batch);
    const total = Number(res.data?.total) || batch.length;
    startAt += batch.length;
    if (startAt >= total || batch.length === 0) break;
  }

  return comments;
}

/** Jira Search chỉ nhúng một phần worklog/comment — tải đủ trước khi upsert DB. */
async function enrichRawIssueFromJira(rawIssue, token, jiraBaseUrl = process.env.JIRA_URL) {
  if (!rawIssue?.key || !rawIssue.fields || !token) return rawIssue;

  const wl = rawIssue.fields.worklog;
  if (wl != null && !isJiraPagedFieldComplete(wl)) {
    try {
      const full = await fetchIssueWorklogsFromJira(jiraBaseUrl, rawIssue.key, token);
      rawIssue.fields.worklog = {
        startAt: 0,
        maxResults: full.length,
        total: full.length,
        worklogs: full,
      };
    } catch (err) {
      console.warn(`[JiraSyncEnrich] worklog ${rawIssue.key}:`, err.message);
    }
  }

  const cf = rawIssue.fields.comment;
  if (cf != null && !isJiraPagedFieldComplete(cf)) {
    try {
      const full = await fetchIssueCommentsFromJira(jiraBaseUrl, rawIssue.key, token);
      rawIssue.fields.comment = {
        startAt: 0,
        maxResults: full.length,
        total: full.length,
        comments: full,
      };
    } catch (err) {
      console.warn(`[JiraSyncEnrich] comment ${rawIssue.key}:`, err.message);
    }
  }

  return rawIssue;
}

module.exports = {
  enrichRawIssueFromJira,
  isJiraPagedFieldComplete,
  fetchIssueCommentsFromJira,
};
