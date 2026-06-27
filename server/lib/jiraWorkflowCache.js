const {
  fetchTransitionsFromJira,
  normalizeTransitions,
} = require('./jiraSyncOneIssue');
const { syncProjectCreateMeta } = require('./jiraCreateMeta');
const { probeProjectFieldConfig } = require('./jiraIssueFieldConfig');

async function saveWorkflowStatusRows(db, projectKey, statuses, errors, syncedAt) {
  const syncedTs = syncedAt || new Date().toISOString();

  const statusPromises = Object.entries(statuses).map(([statusName, transitions]) => 
    db.query(
      `INSERT INTO jira_workflow_status (project_key, status_name, transitions, synced_at, sync_error, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, NULL, CURRENT_TIMESTAMP)
       ON CONFLICT (project_key, status_name) DO UPDATE SET
         transitions = EXCLUDED.transitions,
         synced_at = EXCLUDED.synced_at,
         sync_error = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [projectKey, statusName, JSON.stringify(transitions), syncedTs]
    )
  );

  const errorPromises = errors.filter(err => err?.status).map(err => 
    db.query(
      `INSERT INTO jira_workflow_status (project_key, status_name, sample_issue_key, transitions, synced_at, sync_error, updated_at)
       VALUES ($1, $2, $3, '[]'::jsonb, $4::timestamptz, $5, CURRENT_TIMESTAMP)
       ON CONFLICT (project_key, status_name) DO UPDATE SET
         sample_issue_key = COALESCE(EXCLUDED.sample_issue_key, jira_workflow_status.sample_issue_key),
         sync_error = EXCLUDED.sync_error,
         synced_at = EXCLUDED.synced_at,
         updated_at = CURRENT_TIMESTAMP`,
      [projectKey, err.status, err.sampleKey || null, syncedTs, err.error || null]
    )
  );

  await Promise.all([...statusPromises, ...errorPromises]);
}

async function loadWorkflowCache(db, projectKey) {
  const res = await db.query(
    `SELECT status_name, transitions, sync_error, sample_issue_key, synced_at, updated_at
     FROM jira_workflow_status
     WHERE project_key = $1
     ORDER BY status_name`,
    [projectKey]
  );
  if (!res.rows.length) return null;

  const statuses = {};
  const errors = [];
  let latestSyncedAt = null;
  let latestUpdatedAt = null;

  for (const row of res.rows) {
    if (row.sync_error) {
      errors.push({
        status: row.status_name,
        sampleKey: row.sample_issue_key,
        error: row.sync_error,
      });
    }
    if (Array.isArray(row.transitions) && row.transitions.length > 0) {
      statuses[row.status_name] = row.transitions;
    }
    if (row.synced_at && (!latestSyncedAt || row.synced_at > latestSyncedAt)) {
      latestSyncedAt = row.synced_at;
    }
    if (row.updated_at && (!latestUpdatedAt || row.updated_at > latestUpdatedAt)) {
      latestUpdatedAt = row.updated_at;
    }
  }

  return {
    projectKey,
    syncedAt: latestSyncedAt ? new Date(latestSyncedAt).toISOString() : null,
    statuses,
    statusCount: Object.keys(statuses).length,
    errors,
    updatedAt: latestUpdatedAt,
  };
}

async function listWorkflowCacheMeta(db) {
  const res = await db.query(
    `
    SELECT
      project_key AS "projectKey",
      COUNT(*)::int AS "statusCount",
      COUNT(*) FILTER (WHERE sync_error IS NOT NULL)::int AS "errorCount",
      MAX(synced_at) AS "syncedAt",
      MAX(updated_at) AS "updatedAt"
    FROM jira_workflow_status
    GROUP BY project_key
    ORDER BY project_key
    `
  );
  return res.rows.map((row) => ({
    projectKey: row.projectKey,
    syncedAt: row.syncedAt ? new Date(row.syncedAt).toISOString() : null,
    statusCount: row.statusCount,
    errorCount: row.errorCount,
    updatedAt: row.updatedAt,
  }));
}

async function discoverProjectKeys(db, projectKeyFilter) {
  if (projectKeyFilter) return [projectKeyFilter];

  const res = await db.query(
    `
    SELECT DISTINCT project_key AS key FROM jira_issues WHERE project_key IS NOT NULL
    UNION
    SELECT DISTINCT jira_key AS key FROM app_projects WHERE jira_key IS NOT NULL
    ORDER BY key
    `
  );
  return res.rows.map((r) => r.key).filter(Boolean);
}

async function syncWorkflowCacheForProject(db, projectKey, token, httpsAgent, jiraBaseUrl) {
  const statusesRes = await db.query(
    `
    SELECT DISTINCT ON (issue_type, status) issue_type, status, key
    FROM jira_issues
    WHERE project_key = $1 AND status IS NOT NULL AND TRIM(status) <> '' AND issue_type IS NOT NULL
    ORDER BY issue_type, status, updated_at DESC NULLS LAST
    `,
    [projectKey]
  );

  const statuses = {};
  const errors = [];
  
  // Xử lý song song từng batch nhỏ (ví dụ 5 request một lúc) để tránh quá tải Jira API
  const chunkSize = 5;
  for (let i = 0; i < statusesRes.rows.length; i += chunkSize) {
    const chunk = statusesRes.rows.slice(i, i + chunkSize);
    await Promise.all(chunk.map(async (row) => {
      const cacheKey = `${row.issue_type}:::${row.status}`;
      
      try {
        const raw = await fetchTransitionsFromJira(jiraBaseUrl, row.key, token, httpsAgent);
        const normalized = normalizeTransitions(raw);
        
        // Tránh race condition khi ghi vào statuses object (mỗi cacheKey là duy nhất nên an toàn)
        statuses[cacheKey] = normalized;
      } catch (err) {
        errors.push({
          status: cacheKey,
          sampleKey: row.key,
          error: err.message || 'Failed to fetch transitions',
        });
      }
    }));
  }

  const syncedAt = new Date().toISOString();
  await saveWorkflowStatusRows(db, projectKey, statuses, errors, syncedAt);

  let createMeta = null;
  let createMetaError = null;
  try {
    createMeta = await syncProjectCreateMeta(db, projectKey, token, httpsAgent, jiraBaseUrl);
  } catch (err) {
    createMetaError = err.message || 'Failed to sync createmeta';
    console.error(`[WorkflowCache] createmeta ${projectKey}:`, createMetaError);
  }

  let fieldConfigError = null;
  try {
    await probeProjectFieldConfig(db, { projectKey, token, httpsAgent, jiraBaseUrl });
  } catch (err) {
    fieldConfigError = err.message || 'Failed to probe Jira field config';
    console.error(`[WorkflowCache] field config ${projectKey}:`, fieldConfigError);
  }

  return {
    projectKey,
    syncedAt,
    statuses,
    statusCount: Object.keys(statuses).length,
    errors,
    createMetaIssueTypeCount: createMeta?.issueTypeCount ?? 0,
    createMetaError,
    fieldConfigError,
  };
}

async function syncAllWorkflowCaches(db, token, httpsAgent, jiraBaseUrl, projectKeyFilter) {
  const projectKeys = await discoverProjectKeys(db, projectKeyFilter);
  const results = [];

  for (const projectKey of projectKeys) {
    try {
      const payload = await syncWorkflowCacheForProject(
        db,
        projectKey,
        token,
        httpsAgent,
        jiraBaseUrl
      );
      results.push({
        projectKey,
        ok: true,
        statusCount: payload.statusCount,
        errorCount: payload.errors.length,
        createMetaIssueTypeCount: payload.createMetaIssueTypeCount ?? 0,
        createMetaError: payload.createMetaError || null,
        syncedAt: payload.syncedAt,
      });
    } catch (err) {
      results.push({
        projectKey,
        ok: false,
        error: err.message || 'Sync failed',
      });
    }
  }

  return { projects: results };
}

async function resolveTransitionsForIssue(db, issueKey, token, httpsAgent, jiraBaseUrl) {
  const issueRes = await db.query(
    `SELECT project_key, status, issue_type FROM jira_issues WHERE key = $1`,
    [issueKey]
  );
  const projectKey = issueRes.rows[0]?.project_key || null;
  const status = issueRes.rows[0]?.status || null;
  const issueType = issueRes.rows[0]?.issue_type || null;

  if (projectKey && issueType && status) {
    const cacheKey = `${issueType}:::${status}`;
    const cacheRes = await db.query(
      `SELECT transitions FROM jira_workflow_status 
       WHERE project_key = $1 AND status_name = $2
       LIMIT 1`,
      [projectKey, cacheKey]
    );
    if (
      cacheRes.rows.length > 0 &&
      Array.isArray(cacheRes.rows[0].transitions) &&
      cacheRes.rows[0].transitions.length > 0
    ) {
      return {
        source: 'database_cache',
        projectKey,
        status,
        transitions: cacheRes.rows[0].transitions,
      };
    }
  }

  try {
    const raw = await fetchTransitionsFromJira(jiraBaseUrl, issueKey, token, httpsAgent);
    return {
      source: 'jira_live_fallback',
      projectKey,
      status,
      transitions: normalizeTransitions(raw),
    };
  } catch (err) {
    return {
      source: 'database_cache',
      projectKey,
      status,
      transitions: [],
    };
  }
}

async function ensureWorkflowCacheForProject(db, projectKey, token, httpsAgent, jiraBaseUrl) {
  try {
    const missingRes = await db.query(
      `
      SELECT DISTINCT i.issue_type, i.status 
      FROM jira_issues i
      LEFT JOIN jira_workflow_status w 
        ON i.project_key = w.project_key AND w.status_name = (i.issue_type || ':::' || i.status)
      WHERE i.project_key = $1 
        AND i.issue_type IS NOT NULL
        AND i.status IS NOT NULL
        AND w.status_name IS NULL
      `,
      [projectKey]
    );

    const checkRes = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM jira_workflow_status 
         WHERE project_key = $1 AND synced_at > NOW() - INTERVAL '1 hour'
       ) AS is_fresh`,
      [projectKey]
    );
    const isFresh = checkRes.rows[0]?.is_fresh ?? false;
    const isStale = !isFresh;

    if (missingRes.rows.length > 0 || isStale) {
      console.log(`[WorkflowCache] Project ${projectKey} is missing transitions or cache is stale. Syncing in background...`);
      await syncWorkflowCacheForProject(db, projectKey, token, httpsAgent, jiraBaseUrl);
    }
  } catch (err) {
    console.error(`[WorkflowCache] ensureWorkflowCacheForProject ${projectKey} failed:`, err.message);
  }
}

module.exports = {
  loadWorkflowCache,
  listWorkflowCacheMeta,
  syncWorkflowCacheForProject,
  syncAllWorkflowCaches,
  resolveTransitionsForIssue,
  ensureWorkflowCacheForProject,
};
