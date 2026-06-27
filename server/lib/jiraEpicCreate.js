const axios = require('axios');
const { getIssueCreateFieldConfig } = require('./jiraIssueFieldConfig');

const JIRA_REQUEST_TIMEOUT_MS = Number(process.env.JIRA_REQUEST_TIMEOUT_MS) || 120000;

function jiraApiErrorDetail(err) {
  const data = err.response?.data;
  if (!data) return err.message || 'Lỗi Jira API';
  if (Array.isArray(data.errorMessages) && data.errorMessages.length) {
    return data.errorMessages.join('; ');
  }
  if (data.errors && typeof data.errors === 'object') {
    return Object.entries(data.errors)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
  }
  return err.message || 'Lỗi Jira API';
}

function buildEpicCreateBody(projectKey, summary, description, epicNameField) {
  const fields = {
    project: { key: projectKey },
    summary: String(summary || '').trim(),
    description: String(description || ''),
    issuetype: { name: 'Epic' },
  };
  if (epicNameField) {
    fields[epicNameField] = fields.summary;
  }
  return { fields };
}

/**
 * Tạo Epic — probe createmeta lần đầu để biết Epic Name field, một request không retry.
 */
async function createJiraEpic({
  db,
  jiraBaseUrl,
  token,
  httpsAgent,
  projectKey,
  summary,
  description,
}) {
  const fieldConfig = await getIssueCreateFieldConfig(db, {
    projectKey,
    issueTypeName: 'Epic',
    token,
    httpsAgent,
    jiraBaseUrl,
  });

  const url = `${String(jiraBaseUrl || '').replace(/\/$/, '')}/rest/api/2/issue`;
  const body = buildEpicCreateBody(projectKey, summary, description, fieldConfig.epicNameField);

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      httpsAgent,
      timeout: JIRA_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  } catch (err) {
    const detail = jiraApiErrorDetail(err);
    const fieldHint = fieldConfig.epicNameField || 'không có Epic Name trên createmeta';
    throw new Error(`Tạo Epic thất bại (${fieldHint}): ${detail}`);
  }
}

module.exports = {
  buildEpicCreateBody,
  createJiraEpic,
  jiraApiErrorDetail,
};
