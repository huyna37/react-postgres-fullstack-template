const axios = require('axios');
const { jiraFieldToStorage, normalizeJiraComments } = require('./jiraComments');
const { normalizeJiraAttachments } = require('./jiraAttachmentsDb');

const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'updated',
  'created',
  'timespent',
  'timeoriginalestimate',
  'timeestimate',
  'creator',
  'customfield_10300',
  'customfield_10302',
  'customfield_10304',
  'assignee',
  'parent',
  'description',
  'comment',
  'project',
  'attachment',
  'worklog',
].join(',');

function linkKey(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.trim() || null;
  if (typeof val === 'object' && val.key) return val.key;
  return null;
}

function parentKeyFromFields(f) {
  if (f.issuetype?.subtask && f.parent?.key) return f.parent.key;
  return (
    linkKey(f.customfield_10008) ||
    linkKey(f.customfield_10014) ||
    linkKey(f.customfield_10201) ||
    f.parent?.key ||
    null
  );
}

function mapJiraIssue(issue, mapAssignee = () => null) {
  const f = issue.fields || {};
  return {
    id: issue.id,
    key: issue.key,
    summary: f.summary,
    status: f.status?.name,
    statusCategory: f.status?.statusCategory?.key,
    issueType: f.issuetype?.name,
    isSubtask: !!f.issuetype?.subtask,
    updated: f.updated,
    created: f.created ?? null,
    timeSpent: f.timespent || 0,
    originalEstimate: f.timeoriginalestimate || 0,
    remainingEstimate: f.timeestimate || 0,
    creator: f.creator?.displayName ?? null,
    creatorEmail: f.creator?.emailAddress ?? null,
    startDate: f.customfield_10300 ?? null,
    dueDate: f.customfield_10302 ?? null,
    description: jiraFieldToStorage(f.description),
    output: jiraFieldToStorage(f.customfield_10304),
    assignee: mapAssignee(f.assignee),
    parentKey: parentKeyFromFields(f),
    comments: normalizeJiraComments(f.comment),
    attachments: normalizeJiraAttachments(f.attachment),
    worklog: f.worklog !== undefined ? f.worklog : undefined,
    projectKey: f.project?.key || null,
  };
}

async function fetchIssueFromJira(jiraBaseUrl, key, token, httpsAgent) {
  const url = `${jiraBaseUrl}/rest/api/2/issue/${key}`;
  const res = await axios.get(url, {
    params: { fields: ISSUE_FIELDS },
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
  });
  return res.data;
}

async function fetchTransitionsFromJira(jiraBaseUrl, key, token, httpsAgent) {
  const url = `${jiraBaseUrl}/rest/api/2/issue/${key}/transitions`;
  const res = await axios.get(url, {
    params: { expand: 'transitions.fields' },
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
  });
  return res.data?.transitions || [];
}

const { normalizeTransitionFields } = require('./jiraTransitionFields');

function normalizeTransitions(transitions) {
  if (!Array.isArray(transitions)) return [];
  return transitions.map((t) => ({
    id: String(t.id),
    name: t.name || '',
    to: t.to
      ? {
          id: t.to.id,
          name: t.to.name || '',
          statusCategory: t.to.statusCategory?.key || null,
        }
      : null,
    fields: normalizeTransitionFields(t.fields),
    hasScreen: Object.keys(t.fields || {}).length > 0,
  }));
}

module.exports = {
  fetchIssueFromJira,
  fetchTransitionsFromJira,
  mapJiraIssue,
  normalizeTransitions,
};
