const axios = require('axios');
const FormData = require('form-data');
const { normalizeJiraComments } = require('./jiraComments');
const { normalizeJiraAttachments } = require('./jiraAttachmentsDb');

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function sanitizeFilename(name, index, mimeType) {
  const base = String(name || '')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80);
  if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
  const ext =
    mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/gif'
        ? 'gif'
        : mimeType === 'image/webp'
          ? 'webp'
          : 'jpg';
  return `paste-${Date.now()}-${index}.${ext}`;
}

function buildWikiCommentBody(text, attachmentNames) {
  const parts = [String(text || '').trim()];
  for (const name of attachmentNames) {
    parts.push(`!${name}|thumbnail!`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function descriptionHasWikiImages(text) {
  return /![^!\r\n]+!/.test(String(text || ''));
}

async function uploadIssueAttachments(jiraBaseUrl, issueKey, images, token, httpsAgent) {
  if (!Array.isArray(images) || images.length === 0) return [];

  const names = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const dataBase64 = img?.dataBase64;
    if (!dataBase64) continue;

    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) continue;
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`Ảnh ${i + 1} vượt quá ${MAX_IMAGE_BYTES / (1024 * 1024)}MB.`);
    }

    const filename = sanitizeFilename(img.filename, i, img.mimeType);
    const form = new FormData();
    form.append('file', buffer, {
      filename,
      contentType: img.mimeType || 'application/octet-stream',
    });

    await axios.post(`${jiraBaseUrl}/rest/api/2/issue/${issueKey}/attachments`, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${token}`,
        'X-Atlassian-Token': 'no-check',
      },
      httpsAgent,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    names.push(filename);
  }

  return names;
}

async function postIssueComment(jiraBaseUrl, issueKey, body, token, httpsAgent) {
  const url = `${jiraBaseUrl}/rest/api/2/issue/${issueKey}/comment`;
  const res = await axios.post(
    url,
    { body },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      httpsAgent,
    }
  );
  return res.data;
}

async function refreshIssueCommentsAndStatus(db, jiraBaseUrl, issueKey, token, httpsAgent) {
  const url = `${jiraBaseUrl}/rest/api/2/issue/${issueKey}?fields=status,comment,attachment,resolutiondate`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
  });

  const f = res.data?.fields || {};
  const status = f.status?.name || null;
  const statusCategory = f.status?.statusCategory?.key || null;
  const comments = normalizeJiraComments(f.comment);
  const attachments = normalizeJiraAttachments(f.attachment);
  const resolutionDate = f.resolutiondate || null;

  await db.query(
    `UPDATE jira_issues
     SET status = COALESCE($2, status),
         status_category = COALESCE($3, status_category),
         comments = $4::jsonb,
         attachments = $5::jsonb,
         updated_at = NOW(),
         resolved_at = $6::timestamptz
     WHERE key = $1`,
    [
      issueKey,
      status,
      statusCategory,
      JSON.stringify(comments),
      JSON.stringify(attachments),
      resolutionDate ? new Date(resolutionDate) : null
    ]
  );

  return { status, statusCategory, comments };
}

async function buildAndPostComment(jiraBaseUrl, issueKey, { text, images }, token, httpsAgent) {
  if (!Array.isArray(images)) images = [];
  if (images.length > MAX_IMAGES) {
    throw new Error(`Tối đa ${MAX_IMAGES} ảnh mỗi bình luận.`);
  }

  const attachmentNames = await uploadIssueAttachments(
    jiraBaseUrl,
    issueKey,
    images,
    token,
    httpsAgent
  );
  let body = String(text || '').trim();
  if (!descriptionHasWikiImages(body)) {
    body = buildWikiCommentBody(body, attachmentNames);
  }
  if (!body.trim()) {
    throw new Error('Nội dung bình luận trống.');
  }

  await postIssueComment(jiraBaseUrl, issueKey, body, token, httpsAgent);
  return body;
}

module.exports = {
  MAX_IMAGES,
  buildWikiCommentBody,
  descriptionHasWikiImages,
  uploadIssueAttachments,
  postIssueComment,
  refreshIssueCommentsAndStatus,
  buildAndPostComment,
};
