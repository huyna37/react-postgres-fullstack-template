const axios = require('axios');
const {
  loadProjectIssueTypesFromDb,
  syncProjectCreateMeta,
} = require('./jiraCreateMeta');

const SETTINGS_PREFIX = 'jira_field_config:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const memoryCache = new Map();

function fieldConfigSettingsKey(projectKey) {
  return `${SETTINGS_PREFIX}${projectKey}`;
}

function findFieldByNamePattern(allFields, pattern, allowedSet) {
  const match = allFields.find(
    f => pattern.test(String(f.name || '')) && allowedSet.has(f.id)
  );
  return match?.id || null;
}

function extractCreateFieldIds(data) {
  const ids = new Set();
  for (const project of data?.projects || []) {
    for (const issueType of project.issuetypes || []) {
      for (const fieldId of Object.keys(issueType.fields || {})) {
        ids.add(fieldId);
      }
    }
  }
  return ids;
}

function extractCreateFieldIdsFromValues(values) {
  const ids = new Set();
  for (const row of values || []) {
    if (row?.fieldId) ids.add(row.fieldId);
  }
  return ids;
}

async function fetchJiraFields(jiraBaseUrl, token, httpsAgent) {
  const base = String(jiraBaseUrl || '').replace(/\/$/, '');
  const res = await axios.get(`${base}/rest/api/2/field`, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
    timeout: 60000,
  });
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchCreateMetaFieldIdsByIssueTypeId(
  jiraBaseUrl,
  projectKey,
  issueTypeId,
  token,
  httpsAgent
) {
  const base = String(jiraBaseUrl || '').replace(/\/$/, '');
  const url = `${base}/rest/api/2/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
    timeout: 60000,
    params: { expand: 'fields' },
  });
  return extractCreateFieldIdsFromValues(res.data?.values);
}

async function fetchCreateMetaFieldIds(jiraBaseUrl, projectKey, issueTypeName, token, httpsAgent) {
  const base = String(jiraBaseUrl || '').replace(/\/$/, '');
  const res = await axios.get(`${base}/rest/api/2/issue/createmeta`, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
    timeout: 60000,
    params: {
      projectKeys: projectKey,
      issuetypeNames: issueTypeName,
      expand: 'projects.issuetypes.fields',
    },
  });
  return extractCreateFieldIds(res.data);
}

async function fetchCreateableFieldIds(jiraBaseUrl, projectKey, issueType, token, httpsAgent) {
  if (issueType?.id) {
    try {
      return await fetchCreateMetaFieldIdsByIssueTypeId(
        jiraBaseUrl,
        projectKey,
        issueType.id,
        token,
        httpsAgent
      );
    } catch (err) {
      console.warn(
        `[JiraFieldConfig] createmeta ${projectKey}/${issueType.name}#${issueType.id}: ${err.response?.data?.errorMessages?.[0] || err.message}`
      );
    }
  }
  if (issueType?.name) {
    try {
      return await fetchCreateMetaFieldIds(
        jiraBaseUrl,
        projectKey,
        issueType.name,
        token,
        httpsAgent
      );
    } catch (err) {
      console.warn(
        `[JiraFieldConfig] createmeta ${projectKey}/${issueType.name}: ${err.response?.data?.errorMessages?.[0] || err.message}`
      );
    }
  }
  return new Set();
}

async function ensureProjectIssueTypes(dbConn, projectKey, token, httpsAgent, jiraBaseUrl) {
  let cached = await loadProjectIssueTypesFromDb(dbConn, projectKey);
  if (cached?.issueTypes?.length) return cached.issueTypes;

  await syncProjectCreateMeta(dbConn, projectKey, token, httpsAgent, jiraBaseUrl);
  cached = await loadProjectIssueTypesFromDb(dbConn, projectKey);
  return cached?.issueTypes || [];
}

/**
 * Chọn field từ danh sách createmeta + tên field Jira — không dùng env, không hardcode ID.
 */
function buildConfigForIssueType(allFields, allowedFieldIds) {
  if (!allowedFieldIds?.size) {
    return {
      epicLinkField: null,
      epicNameField: null,
      sprintField: null,
      startDateField: null,
      dueDateField: null,
      supportsTimetracking: false,
    };
  }

  return {
    epicLinkField: findFieldByNamePattern(allFields, /epic\s*link/i, allowedFieldIds),
    epicNameField: findFieldByNamePattern(allFields, /epic\s*name/i, allowedFieldIds),
    sprintField: findFieldByNamePattern(allFields, /^sprint$/i, allowedFieldIds),
    startDateField: findFieldByNamePattern(allFields, /start\s*date/i, allowedFieldIds),
    dueDateField: findFieldByNamePattern(allFields, /due\s*date/i, allowedFieldIds),
    supportsTimetracking: allowedFieldIds.has('timetracking'),
  };
}

/**
 * Probe createmeta từng issue type — lần đầu tạo issue / sync workflow.
 */
async function probeProjectFieldConfig(dbConn, { projectKey, token, httpsAgent, jiraBaseUrl }) {
  const project = String(projectKey || '').trim();
  if (!project || !token) {
    throw new Error('Thiếu projectKey hoặc token để probe Jira fields');
  }

  const allFields = await fetchJiraFields(jiraBaseUrl, token, httpsAgent);
  const issueTypes = await ensureProjectIssueTypes(
    dbConn,
    project,
    token,
    httpsAgent,
    jiraBaseUrl
  );

  if (!issueTypes.length) {
    throw new Error(
      `Không lấy được createmeta issue types cho project ${project}. Kiểm tra token Jira.`
    );
  }

  const byIssueType = {};
  const unionAllowed = new Set();

  for (const issueType of issueTypes) {
    const ids = await fetchCreateableFieldIds(
      jiraBaseUrl,
      project,
      issueType,
      token,
      httpsAgent
    );
    if (ids.size > 0) {
      byIssueType[issueType.name] = buildConfigForIssueType(allFields, ids);
      ids.forEach(id => unionAllowed.add(id));
    }
  }

  if (!Object.keys(byIssueType).length) {
    throw new Error(
      `Không probe được field tạo issue cho project ${project}. Kiểm tra quyền Jira.`
    );
  }

  const defaultConfig =
    byIssueType.Story || byIssueType.Task || byIssueType.Epic || Object.values(byIssueType)[0];

  const payload = {
    syncedAt: new Date().toISOString(),
    byIssueType,
    default: defaultConfig,
  };

  await dbConn.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [fieldConfigSettingsKey(project), JSON.stringify(payload)]
  );

  for (const key of [...memoryCache.keys()]) {
    if (key.startsWith(`${project}:`)) memoryCache.delete(key);
  }

  console.log(
    `[JiraFieldConfig] ${project} probed — ` +
      `epicLink=${defaultConfig.epicLinkField || 'none'}, ` +
      `epicName=${defaultConfig.epicNameField || 'none'}, ` +
      `sprint=${defaultConfig.sprintField || 'none'}, ` +
      `timetracking=${defaultConfig.supportsTimetracking}`
  );

  return payload;
}

async function getIssueCreateFieldConfig(
  dbConn,
  { projectKey, issueTypeName, token, httpsAgent, jiraBaseUrl }
) {
  const project = String(projectKey || '').trim();
  const issueType = String(issueTypeName || 'Story').trim();
  if (!project || !token) {
    throw new Error('Thiếu project hoặc token Jira để xác định custom field');
  }

  const memKey = `${project}:${issueType}`;
  if (memoryCache.has(memKey)) return memoryCache.get(memKey);

  let stored = null;
  try {
    const res = await dbConn.query(`SELECT value FROM app_settings WHERE key = $1`, [
      fieldConfigSettingsKey(project),
    ]);
    stored = res.rows[0]?.value;
    if (typeof stored === 'string') {
      try {
        stored = JSON.parse(stored);
      } catch {
        stored = null;
      }
    }
  } catch {
    stored = null;
  }

  const stale =
    !stored?.syncedAt || Date.now() - new Date(stored.syncedAt).getTime() > CACHE_TTL_MS;

  if (stale) {
    const hasUsableCache =
      stored?.default || (stored?.byIssueType && Object.keys(stored.byIssueType).length > 0);
    if (hasUsableCache) {
      void probeProjectFieldConfig(dbConn, {
        projectKey: project,
        token,
        httpsAgent,
        jiraBaseUrl,
      }).catch(err =>
        console.warn(`[JiraFieldConfig] background refresh ${project}:`, err.message)
      );
    } else {
      stored = await probeProjectFieldConfig(dbConn, {
        projectKey: project,
        token,
        httpsAgent,
        jiraBaseUrl,
      });
    }
  }

  const config =
    stored?.byIssueType?.[issueType] ||
    stored?.byIssueType?.Story ||
    stored?.default;

  if (!config) {
    throw new Error(`Chưa probe được field config cho ${project} / ${issueType}`);
  }

  memoryCache.set(memKey, config);
  return config;
}

module.exports = {
  getIssueCreateFieldConfig,
  probeProjectFieldConfig,
  buildConfigForIssueType,
};
