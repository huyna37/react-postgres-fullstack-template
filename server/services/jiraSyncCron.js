const db = require('../db');
const axios = require('axios');
const https = require('https');
const { jiraFieldToStorage, normalizeJiraComments } = require('../lib/jiraComments');
const { normalizeJiraAttachments } = require('../lib/jiraAttachmentsDb');
const { upsertJiraIssue } = require('../lib/jiraIssueUpsert');
const { enrichRawIssueFromJira } = require('../lib/jiraSyncEnrich');
const { buildDeltaJql } = require('../lib/jiraMonthFilter');
const {
  buildAssigneeLookup,
  loadAssigneeLookup,
  normalizeAssignee,
  migrateAssigneeAccountIdsToEmail,
} = require('../lib/assigneeIdentity');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const SYNC_INTERVAL_MS = 5000; // 10 giây
const STARTUP_DELAY_MS = 5000;
const PAGE_SIZE = 500;
/** Lùi mốc JQL để không sót ticket (clock skew / sync chậm). */
const SYNC_OVERLAP_MS = 3 * 60 * 1000;
const DELETE_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 giờ
const lastDeleteSyncMap = new Map();

const JIRA_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'updated',
  'created',
  'resolutiondate',
  'timespent',
  'timeoriginalestimate',
  'timeestimate',
  'creator',
  'customfield_10300',
  'customfield_10302',
  'customfield_10304',
  'assignee',
  'parent',
  'customfield_10008',
  'customfield_10014',
  'customfield_10201',
  'description',
  'worklog',
  'comment',
  'attachment',
].join(',');

function syncSettingsKey(projectKey) {
  return `jira_sync_at:${projectKey}`;
}

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

function mapIssue(issue, mapAssignee) {
  const f = issue.fields;
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
    resolved: f.resolutiondate ?? null,
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
    worklog: f.worklog !== undefined ? f.worklog : undefined,
    comments: normalizeJiraComments(f.comment),
    attachments: normalizeJiraAttachments(f.attachment),
  };
}

async function buildRoleMaps(projectKey) {
  const res = await db.query(
    `SELECT account_id, display_name, email_address, role FROM jira_users
     WHERE string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]
       AND is_active = true`,
    [projectKey]
  );
  const lookup = buildAssigneeLookup(res.rows);
  const mapAssignee = a => {
    if (!a) return null;
    return normalizeAssignee(
      {
        accountId: a.accountId || a.key,
        emailAddress: a.emailAddress,
        displayName: a.displayName,
        avatarUrl: a.avatarUrls?.['24x24'] || a.avatarUrls?.['48x48'],
      },
      lookup
    );
  };
  return { mapAssignee, lookup };
}

async function searchJira(jql, token, fields = JIRA_FIELDS) {
  const url = `${process.env.JIRA_URL}/rest/api/2/search`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let startAt = 0;
  let total = Infinity;
  const raw = [];

  while (startAt < total) {
    const res = await axios.get(url, {
      headers,
      params: { jql, startAt, maxResults: PAGE_SIZE, fields },
      httpsAgent,
    });
    total = res.data.total ?? 0;
    const batch = res.data.issues || [];
    raw.push(...batch);
    if (batch.length === 0) break;
    startAt += batch.length;
  }

  return raw;
}

async function fetchAllProjectIssues(projectKey, token) {
  const jql = `project = ${projectKey} ORDER BY updated DESC`;
  return searchJira(jql, token);
}

async function fetchDeltaIssues(projectKey, token, sinceDate) {
  const jql = buildDeltaJql(projectKey, sinceDate);
  return await searchJira(jql, token);
}

async function upsertRawIssues(raw, projectKey, token) {
  const { mapAssignee, lookup } = await buildRoleMaps(projectKey);
  const assigneeLookup = lookup || (await loadAssigneeLookup(projectKey));

  let upserted = 0;
  for (const item of raw) {
    await enrichRawIssueFromJira(item, token);
    const issue = mapIssue(item, mapAssignee);
    try {
      await upsertJiraIssue(issue, projectKey, assigneeLookup);
      upserted++;
    } catch {
      /* logged in upsertJiraIssue */
    }
  }
  return upserted;
}

async function getLastSyncAt(projectKey) {
  const res = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [
    syncSettingsKey(projectKey),
  ]);
  if (!res.rows.length) return null;
  const v = res.rows[0].value;
  const iso = typeof v === 'string' ? v : v?.at;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function setLastSyncAt(projectKey, date) {
  const payload = JSON.stringify({ at: date.toISOString() });
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
    [syncSettingsKey(projectKey), payload]
  );
}

/** Mốc JQL: last sync − overlap; fallback MAX(updated_at) trong DB. */
async function resolveSinceDate(projectKey) {
  const stored = await getLastSyncAt(projectKey);
  if (stored) {
    return new Date(stored.getTime() - SYNC_OVERLAP_MS);
  }

  const res = await db.query(
    `SELECT MAX(updated_at) AS max_u FROM jira_issues WHERE project_key = $1`,
    [projectKey]
  );
  const maxU = res.rows[0]?.max_u;
  if (maxU) {
    return new Date(new Date(maxU).getTime() - SYNC_OVERLAP_MS);
  }

  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

async function projectHasData(projectKey) {
  const res = await db.query(`SELECT 1 FROM jira_issues WHERE project_key = $1 LIMIT 1`, [
    projectKey,
  ]);
  return res.rows.length > 0;
}

async function syncProjectFull(projectKey, token) {
  console.log(`[JiraSyncCron] Bootstrap: ${projectKey} — lay het project`);
  const raw = await fetchAllProjectIssues(projectKey, token);
  const upserted = await upsertRawIssues(raw, projectKey, token);
  await setLastSyncAt(projectKey, new Date());
  const migrated = await migrateAssigneeAccountIdsToEmail(projectKey);
  if (migrated > 0) {
    console.log(`[JiraSyncCron] ${projectKey}: migrated ${migrated} assignee -> email`);
  }
  console.log(`[JiraSyncCron] ${projectKey} bootstrap: ${upserted}/${raw.length}`);
  return upserted;
}

async function syncProjectDelta(projectKey, token) {
  const since = await resolveSinceDate(projectKey);
  const raw = await fetchDeltaIssues(projectKey, token, since);
  const upserted = await upsertRawIssues(raw, projectKey, token);
  await setLastSyncAt(projectKey, new Date());

  if (raw.length > 0) {
    console.log(
      `[JiraSyncCron] ${projectKey} delta (tu ${since.toISOString()}): ${upserted}/${raw.length}`
    );
  }
  return upserted;
}

async function syncProject(projectKey, token) {
  let upserted;
  if (!(await projectHasData(projectKey))) {
    upserted = await syncProjectFull(projectKey, token);
  } else {
    upserted = await syncProjectDelta(projectKey, token);
  }

  // Trigger background workflow cache sync if needed
  void (async () => {
    try {
      const { ensureWorkflowCacheForProject } = require('../lib/jiraWorkflowCache');
      await ensureWorkflowCacheForProject(db, projectKey, token, httpsAgent, process.env.JIRA_URL);
    } catch (err) {
      console.error(`[JiraSyncCron] ensureWorkflowCache failed for ${projectKey}:`, err.message);
    }
  })();

  return upserted;
}

async function getProjectsToSync() {
  const tokenRes = await db.query(
    `SELECT jira_token FROM jira_users WHERE jira_token IS NOT NULL AND jira_token != '' LIMIT 1`
  );
  if (!tokenRes.rows.length) return null;
  const token = tokenRes.rows[0].jira_token;

  const projRes = await db.query(
    `SELECT DISTINCT TRIM(unnest(string_to_array(jira_project, ','))) AS project_key
     FROM jira_users WHERE jira_project IS NOT NULL AND jira_project != ''`
  );
  if (!projRes.rows.length) return null;

  const map = new Map();
  for (const row of projRes.rows) {
    if (row.project_key) map.set(row.project_key, token);
  }
  return map;
}

let isSyncing = false;
let syncLoopTimer = null;

async function syncDeletedIssues(projectKey, token) {
  const jql = `project = ${projectKey}`;
  const url = `${process.env.JIRA_URL}/rest/api/2/search`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let startAt = 0;
  let total = Infinity;
  const currentKeys = [];

  while (startAt < total) {
    const res = await axios.get(url, {
      headers,
      params: { jql, startAt, maxResults: 1000, fields: 'key' },
      httpsAgent,
    });
    total = res.data.total ?? 0;
    const batch = res.data.issues || [];
    currentKeys.push(...batch.map(i => i.key));
    if (batch.length === 0) break;
    startAt += batch.length;
  }

  let deletedCount = 0;
  if (currentKeys.length > 0) {
    const res = await db.query(
      `DELETE FROM jira_issues WHERE project_key = $1 AND NOT (key = ANY($2))`,
      [projectKey, currentKeys]
    );
    deletedCount = res.rowCount;
  } else if (total === 0) {
    const res = await db.query(`DELETE FROM jira_issues WHERE project_key = $1`, [projectKey]);
    deletedCount = res.rowCount;
  }

  if (deletedCount > 0) {
    console.log(`[JiraSyncCron] ${projectKey}: đã xóa ${deletedCount} issues bị xóa trên Jira`);
  }
  return deletedCount;
}

async function runSync() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const projects = await getProjectsToSync();
    if (!projects) return;

    for (const [projectKey, token] of projects.entries()) {
      try {
        await syncProject(projectKey, token);

        // Chạy đồng bộ xóa định kỳ (mỗi DELETE_SYNC_INTERVAL_MS)
        const lastDelSync = lastDeleteSyncMap.get(projectKey) || 0;
        if (Date.now() - lastDelSync >= DELETE_SYNC_INTERVAL_MS) {
          await syncDeletedIssues(projectKey, token);
          lastDeleteSyncMap.set(projectKey, Date.now());
        }
      } catch (err) {
        console.error(`[JiraSyncCron] Loi ${projectKey}:`, err.message);
        if (err.message?.includes('JQL') && err.cause?.response?.status === 400) {
          console.error(
            `[JiraSyncCron] Goi y: kiem tra JQL/datetime hoac field khong ton tai tren Jira`
          );
        }
      }
    }
  } catch (err) {
    console.error('[JiraSyncCron] Loi dong bo:', err.message);
  } finally {
    isSyncing = false;
  }
}

function scheduleSyncLoop() {
  if (syncLoopTimer) clearTimeout(syncLoopTimer);
  syncLoopTimer = setTimeout(async () => {
    await runSync();
    scheduleSyncLoop();
  }, SYNC_INTERVAL_MS);
}

module.exports = {
  start: () => {
    console.log(
      '[JiraSyncCron] Lan dau: het project; sau: delta updated/created tu last sync (overlap 3p) — 10s'
    );
    setTimeout(() => {
      runSync().finally(() => scheduleSyncLoop());
    }, STARTUP_DELAY_MS);
  },
  runSync,
  syncProject,
  syncProjectFull,
  syncProjectDelta,
  syncDeletedIssues,
  fetchAllProjectIssues,
  fetchDeltaIssues,
  getLastSyncAt,
  setLastSyncAt,
  resolveSinceDate,
};
