const axios = require('axios');
const { attachmentIndexFromStored } = require('./jiraAttachmentsDb');

function normalizeFilename(name) {
  return String(name || '').trim().toLowerCase();
}

async function fetchIssueAttachmentsFromJira(jiraBaseUrl, issueKey, token, httpsAgent) {
  const issueRes = await axios.get(`${jiraBaseUrl}/rest/api/2/issue/${issueKey}`, {
    params: { fields: 'attachment' },
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
  });
  const attachments = issueRes.data?.fields?.attachment || [];
  const byName = new Map();
  for (const att of attachments) {
    const filename = att?.filename;
    if (!filename) continue;
    byName.set(normalizeFilename(filename), {
      id: att.id,
      filename,
      mimeType: att.mimeType || null,
      content: att.content || null,
      thumbnail: att.thumbnail || null,
      size: att.size || 0,
    });
  }
  return byName;
}

async function getIssueAttachmentIndexFromDb(db, issueKey) {
  if (!db) return null;
  try {
    const result = await db.query(`SELECT attachments FROM jira_issues WHERE key = $1`, [issueKey]);
    if (!result.rows.length) return null;
    const byName = attachmentIndexFromStored(result.rows[0].attachments);
    return byName.size > 0 ? byName : null;
  } catch {
    return null;
  }
}

/** Luôn lấy metadata đính kèm từ Jira — không cache RAM/DB để proxy ảnh luôn đúng. */
async function getIssueAttachmentIndex(jiraBaseUrl, issueKey, token, httpsAgent, _db = null) {
  return fetchIssueAttachmentsFromJira(jiraBaseUrl, issueKey, token, httpsAgent);
}

function findAttachment(byName, decodedFilename) {
  const direct = byName.get(normalizeFilename(decodedFilename));
  if (direct) return direct;
  for (const att of byName.values()) {
    if (att.filename === decodedFilename) return att;
  }
  return null;
}

async function resolveAttachmentFile(
  jiraBaseUrl,
  issueKey,
  decodedFilename,
  token,
  httpsAgent,
  { variant = 'full', db = null } = {}
) {
  const byName = await getIssueAttachmentIndex(jiraBaseUrl, issueKey, token, httpsAgent, db);
  const match = findAttachment(byName, decodedFilename);
  if (!match) return null;

  const useThumb = variant === 'thumb' && match.thumbnail;
  const sourceUrl = useThumb ? match.thumbnail : match.content;
  if (!sourceUrl) return null;

  const fileRes = await axios.get(sourceUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
    httpsAgent,
  });

  const buffer = Buffer.from(fileRes.data);
  const contentType =
    match.mimeType || fileRes.headers['content-type'] || 'application/octet-stream';

  return { buffer, contentType };
}

function invalidateIssueAttachmentCache(_issueKey) {
  /* no-op — không cache metadata ảnh */
}

module.exports = {
  getIssueAttachmentIndex,
  getIssueAttachmentIndexFromDb,
  resolveAttachmentFile,
  invalidateIssueAttachmentCache,
};
