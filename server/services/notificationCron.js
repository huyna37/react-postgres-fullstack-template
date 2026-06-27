const webPush = require('web-push');
const db = require('../db');
const { loadWorkflowCache } = require('../lib/jiraWorkflowCache');
const { buildWorkflowNotifyIndex } = require('../lib/jiraWorkflowNotify');

// Trạng thái theo dõi trong RAM (như frontend trackingRef)
// Map<userId_issueKey, status>
const bugStatusByKey = new Map();
const bugAssigneeByKey = new Map();
/** Tránh gửi trùng; gửi lại khi đổi status hoặc assignee (ReOpen / reassign). */
const bugOpenNotifySigByKey = new Map();
/** @type {Map<string, { status: string, statusCategory: string }>} */
const subtaskStatusByKey = new Map();

let cachedJiraBaseUrl = '';

// Chống spam: lưu lịch sử các push đã gửi gần đây (endpoint + title)
const recentlySentPush = new Map();
/** Tránh gửi 2 lần "Bug mới" khi poll song song (cron + pollProjectNow). */
const recentBugNewNotifyAt = new Map();

// Lưu danh sách các client SSE đang kết nối
// Map<userId, Set<Response>>
const sseClients = new Map();

/** @type {Map<number, { userId: number, username: string|null, appRole: string|null, connectedAt: string, lastSeenAt: string, tabCount: number }>} */
const onlinePresence = new Map();

/** Admin monitor SSE clients */
const presenceMonitorClients = new Set();

/** @type {Map<number, Map<string, { page: string, updatedAt: string }>>} */
const userTabPages = new Map();

/** @type {Map<object, string>} */
const sseTabIds = new Map();

const { getPageLabel, isKnownPageKey, normalizePageKey } = require('../lib/appPageLabels');

/** Cache profile jira_users cho presence — chỉ query user mới online */
const presenceUserCache = new Map();

const normalizeEmailKey = value => {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v.includes('@') && !v.includes(' ') ? v : null;
};

/** Khóa ổn định để so sánh assignee giữa các lần poll. */
const assigneeTrackingKey = assignee => {
  if (!assignee) return 'unassigned';
  const email = normalizeEmailKey(assignee.emailAddress) || normalizeEmailKey(assignee.accountId);
  if (email) return email;
  if (assignee.accountId) return String(assignee.accountId).trim();
  if (assignee.displayName) return assignee.displayName.trim().toLowerCase();
  return 'unassigned';
};

const enrichIssueFromRow = row => {
  const issue = {
    key: row.key,
    summary: row.summary || '',
    issueType: row.issue_type || '',
    isSubtask: !!row.is_subtask,
    parentKey: row.parent_key || null,
    status: row.status || '',
    statusCategory: row.status_category || '',
    updatedAtMs: null,
    assignee: null,
  };

  if (row.updated_at) {
    const u = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
    issue.updatedAtMs = Number.isNaN(u.getTime()) ? null : u.getTime();
  }

  if (row.assignee_account_id || row.assignee_name) {
    const email =
      normalizeEmailKey(row.assignee_account_id) ||
      (row.assignee_account_id && String(row.assignee_account_id).trim()) ||
      null;
    issue.assignee = {
      emailAddress: email,
      accountId: email,
      displayName: row.assignee_name || null,
    };
  }

  return issue;
};

const isBugIssue = issue => {
  if (!issue?.key) return false;
  const type = (issue.issueType || '').toLowerCase();
  return type.includes('bug');
};

/** Project đã seed baseline sau restart — chưa seed thì không gửi notify. */
const seededProjects = new Set();
const lastPollTimeByProject = new Map();

const getUpdaterName = issue => {
  return (
    issue.updater?.displayName ||
    issue.updatedBy?.displayName ||
    issue.lastUpdatedBy?.displayName ||
    issue.assignee?.displayName ||
    ''
  );
};

let isRunning = false;

async function getActiveProjectKeys() {
  const res = await db.query(
    `SELECT DISTINCT trim(project_key) AS project_key
     FROM (
       SELECT trim(p) AS project_key
       FROM jira_users j,
            unnest(string_to_array(COALESCE(j.jira_project, ''), ',')) AS p
       WHERE trim(p) <> ''
         AND (j.is_active = true OR j.password_hash IS NOT NULL)
       UNION
       SELECT DISTINCT project_key
       FROM jira_issues
       WHERE project_key IS NOT NULL AND trim(project_key) <> ''
     ) all_p
     WHERE trim(project_key) <> ''`
  );
  return res.rows.map(r => r.project_key);
}

/**
 * User nhận thông báo dự án (query DB mỗi lần poll — không cache):
 * - jira_project chứa projectKey, hoặc app_role = admin
 * - có login hoặc đã đăng ký push
 * - is_active = true
 */
async function getProjectMemberAppUserIds(projectKey) {
  const res = await db.query(
    `SELECT DISTINCT j.id AS user_id, j.username, j.app_role
     FROM jira_users j
     WHERE j.is_active = true
       AND (
         trim($1) = ANY (
           SELECT trim(x) FROM unnest(string_to_array(COALESCE(j.jira_project, ''), ',')) AS x
         )
       )
       AND (
         j.password_hash IS NOT NULL
         OR EXISTS (SELECT 1 FROM app_push_subscriptions s WHERE s.user_id = j.id)
       )
     ORDER BY j.id`,
    [projectKey]
  );
  return res.rows;
}

function seedProjectBaseline(projectKey, rawIssues, skipBugKeys = new Set()) {
  for (const issue of rawIssues) {
    if (isBugIssue(issue)) {
      if (skipBugKeys.has(issue.key)) continue;
      const status = issue.status || '';
      const assigneeKey = assigneeTrackingKey(issue.assignee);
      bugStatusByKey.set(issue.key, status);
      bugAssigneeByKey.set(issue.key, assigneeKey);
      bugOpenNotifySigByKey.set(issue.key, `${status}|${assigneeKey}`);
    } else if (issue.isSubtask && issue.key) {
      subtaskStatusByKey.set(issue.key, {
        status: issue.status || '',
        statusCategory: issue.statusCategory || '',
      });
    }
  }
  seededProjects.add(projectKey);
  console.log(
    `[NotificationCron] Seed baseline ${projectKey} (${rawIssues.length} issues) — khong gui thong bao cu`
  );
}

const assigneeLabel = assignee => {
  if (!assignee) return 'Chưa assign';
  return assignee.displayName || assignee.emailAddress || assignee.accountId || 'Chưa assign';
};

const usernameOf = (userId, memberById) => {
  const row = memberById?.get(userId);
  return row?.username || row?.display_name || `#${userId}`;
};

const shortNotifyTitle = title =>
  String(title || '')
    .replace(/^[^\w\d\u00C0-\u024F]+/u, '')
    .trim() || 'thong bao';

const issueKeyFromPayload = payload => {
  const m = String(payload?.body || '').match(/\[([A-Z][A-Z0-9]+-\d+)\]/);
  return m ? m[1] : null;
};

async function deliverNotificationsToUsers(userIds, payloads, memberRows = []) {
  const seen = new Set();
  const unique = payloads.filter(p => {
    const k = `${p.title}|${p.body}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) return;

  const memberById = new Map(memberRows.map(r => [r.user_id, r]));
  const missingIds = userIds.filter(id => !memberById.has(id));
  if (missingIds.length > 0) {
    const extra = await db.query(
      `SELECT id AS user_id, username, app_role FROM jira_users WHERE id = ANY($1::int[])`,
      [missingIds]
    );
    for (const row of extra.rows) memberById.set(row.user_id, row);
  }

  const deliveredUsers = new Set();
  const noChannelUsers = new Set();

  for (const userId of userIds) {
    const userSubsRes = await db.query(
      'SELECT endpoint, auth, p256dh FROM app_push_subscriptions WHERE user_id = $1',
      [userId]
    );
    const hasSse = sseClients.has(userId);
    const sseClientCount = hasSse ? sseClients.get(userId).size : 0;

    for (const payload of unique) {
      const payloadStr = JSON.stringify(payload);
      const titleBodyKey = `${payload.title}|${payload.body}`;
      let pushSent = 0;
      let pushDedup = 0;
      let pushFailed = 0;
      let sseSent = 0;
      let sseDedup = 0;

      if (hasSse) {
        const dupSseKey = `sse_${userId}|${titleBodyKey}`;
        const now = Date.now();
        if (recentlySentPush.has(dupSseKey) && now - recentlySentPush.get(dupSseKey) < 60 * 1000) {
          sseDedup = sseClientCount;
        } else {
          recentlySentPush.set(dupSseKey, now);
          if (recentlySentPush.size > 1000) recentlySentPush.clear();
          const clients = sseClients.get(userId);
          for (const res of clients) {
            res.write(`data: ${payloadStr}\n\n`);
          }
          sseSent = clients.size;
        }
      }

      // Tab đang mở đã nhận SSE — không gửi web push (tránh 2 thông báo desktop trùng nội dung)
      if (sseSent === 0) {
        for (const sub of userSubsRes.rows) {
          const pushSubscription = {
            endpoint: sub.endpoint,
            keys: { auth: sub.auth, p256dh: sub.p256dh },
          };
          try {
            const dupKey = `${sub.endpoint}|${titleBodyKey}`;
            const now = Date.now();
            if (recentlySentPush.has(dupKey) && now - recentlySentPush.get(dupKey) < 60 * 1000) {
              pushDedup += 1;
              continue;
            }
            recentlySentPush.set(dupKey, now);
            if (recentlySentPush.size > 1000) recentlySentPush.clear();

            await webPush.sendNotification(pushSubscription, payloadStr, { TTL: 43200 });
            pushSent += 1;
          } catch (err) {
            pushFailed += 1;
            console.error(`[NotificationCron] Push fail #${userId}: ${err.message}`);
            if (err.statusCode === 410) {
              await db.query('DELETE FROM app_push_subscriptions WHERE endpoint = $1', [
                sub.endpoint,
              ]);
            }
          }
        }
      }

      const delivered = pushSent > 0 || sseSent > 0;
      if (delivered) deliveredUsers.add(userId);
      else noChannelUsers.add(userId);
    }
  }

  const title = shortNotifyTitle(unique[0]?.title);
  const issueKey = issueKeyFromPayload(unique[0]);
  const got = [...deliveredUsers].map(id => usernameOf(id, memberById));
  const prefix = issueKey ? `${issueKey} ` : '';
  const okPart = got.length > 0 ? ` | ok: ${got.join(', ')}` : ' | ok: —';
  console.log(
    `[NotificationCron] ${prefix}${title} (${deliveredUsers.size}/${userIds.length})${okPart}`
  );
}

async function getNotificationSettings() {
  const configRes = await db.query(
    `SELECT value FROM app_settings WHERE key = 'allowed_notification_types'`
  );
  const projRes = await db.query(
    `SELECT value FROM app_settings WHERE key = 'notification_projects'`
  );

  const allowedTypes =
    configRes.rows.length > 0 && Array.isArray(configRes.rows[0].value)
      ? configRes.rows[0].value
      : ['bug_commit', 'subtask_resolved', 'bug_assigned_open'];

  const notificationProjects =
    projRes.rows.length > 0 && Array.isArray(projRes.rows[0].value)
      ? projRes.rows[0].value
      : [];

  return {
    isBugAllowed: allowedTypes.includes('bug_commit'),
    isSubtaskAllowed: allowedTypes.includes('subtask_resolved'),
    isBugOpenAllowed: allowedTypes.includes('bug_assigned_open'),
    notificationProjects,
  };
}

async function processProjectNotifications(projectKey, jiraBaseUrl, settings, options = {}) {
  const { isBugAllowed, isSubtaskAllowed, isBugOpenAllowed } = settings;

  const memberRows = await getProjectMemberAppUserIds(projectKey);
  const memberUserIds = memberRows.map(r => r.user_id);
  if (memberUserIds.length === 0) {
    console.warn(
      `[NotificationCron] ${projectKey}: khong co user nhan thong bao (can login + jira_project hoac push subscription)`
    );
    return;
  }

  const lastPoll = lastPollTimeByProject.get(projectKey) || null;
  let dbRes;
  if (!lastPoll) {
    dbRes = await db.query(
      `SELECT key, summary, issue_type, is_subtask, parent_key,
              assignee_account_id, assignee_name, status, status_category, updated_at
       FROM jira_issues WHERE project_key = $1`,
      [projectKey]
    );
  } else {
    // Delta query: only items updated since last poll (with 1-min overlap to prevent skew)
    const sinceDate = new Date(lastPoll.getTime() - 60000);
    dbRes = await db.query(
      `SELECT key, summary, issue_type, is_subtask, parent_key,
              assignee_account_id, assignee_name, status, status_category, updated_at
       FROM jira_issues WHERE project_key = $1 AND updated_at >= $2`,
      [projectKey, sinceDate]
    );
  }

  lastPollTimeByProject.set(projectKey, new Date());

  const rawIssues = dbRes.rows.map(enrichIssueFromRow);

  if (!seededProjects.has(projectKey)) {
    const skipBugKeys = new Set(options.skipBaselineBugKeys || []);
    seedProjectBaseline(projectKey, rawIssues, skipBugKeys);
    return;
  }

  const workflowCache = await loadWorkflowCache(db, projectKey);
  const workflowIndex = buildWorkflowNotifyIndex(workflowCache);
  if (!workflowIndex.hasCache) {
    console.warn(
      `[NotificationCron] ${projectKey}: chua co jira_workflow_status — dung status_category tu jira_issues`
    );
  }

  const notificationsToSend = [];

  const processBug = bugIssue => {
    if (!bugIssue?.key) return;
    const mapKey = bugIssue.key;
    const prevStatus = bugStatusByKey.get(mapKey);
    const nowCommit = workflowIndex.isCommit(bugIssue.status);
    const wasCommit = workflowIndex.isCommit(prevStatus);

    const prevAssigneeKey = bugAssigneeByKey.get(mapKey);
    const nowAssigneeKey = assigneeTrackingKey(bugIssue.assignee);
    const hasBaseline = prevStatus !== undefined && prevAssigneeKey !== undefined;
    const assigneeChanged = hasBaseline && prevAssigneeKey !== nowAssigneeKey;

    const statusChanged = hasBaseline && prevStatus !== (bugIssue.status || '');
    const transition = statusChanged
      ? workflowIndex.findTransition(prevStatus, bugIssue.status)
      : null;
    const nowOpen = workflowIndex.isOpen(bugIssue.status, bugIssue.statusCategory);
    const justReopened =
      statusChanged && workflowIndex.isReopenStatus(bugIssue.status, prevStatus, null, transition);

    if (hasBaseline && nowCommit && !wasCommit && isBugAllowed) {
      const updater = getUpdaterName(bugIssue);
      const byLine = updater ? `\n👤 ${updater}` : '';
      notificationsToSend.push({
        title: '🐛 Bug đã chuyển Commit',
        body: `🔀 [${bugIssue.key}] ${bugIssue.summary}${byLine}`,
        icon: '/notify-bug.svg',
        url: `${jiraBaseUrl}/browse/${bugIssue.key}`,
      });
    }

    const isNewBug = prevStatus === undefined;

    if (isBugOpenAllowed && isNewBug) {
      const parentLine = bugIssue.parentKey ? `\n📂 Thuộc: ${bugIssue.parentKey}` : '';
      const assigneeLine = `\n👤 Assignee: ${assigneeLabel(bugIssue.assignee)}`;
      const notifyAt = Date.now();
      const lastNewNotify = recentBugNewNotifyAt.get(mapKey);
      if (!lastNewNotify || notifyAt - lastNewNotify > 15 * 1000) {
        recentBugNewNotifyAt.set(mapKey, notifyAt);
        if (recentBugNewNotifyAt.size > 2000) recentBugNewNotifyAt.clear();
        notificationsToSend.push({
          title: '🐛 Bug mới',
          body: `📌 [${bugIssue.key}] ${bugIssue.summary}${parentLine}${assigneeLine}`,
          icon: '/notify-bug-open.svg',
          url: `${jiraBaseUrl}/browse/${bugIssue.key}`,
        });
      }
    } else if (isBugOpenAllowed && nowOpen && hasBaseline) {
      const notifySig = `${bugIssue.status || ''}|${nowAssigneeKey}`;
      const prevNotifySig = bugOpenNotifySigByKey.get(mapKey);
      const sigChanged = prevNotifySig !== notifySig;

      if (sigChanged) {
        const assigneeLine = `\n👤 Assignee: ${assigneeLabel(bugIssue.assignee)}`;
        const title =
          justReopened ||
          workflowIndex.isReopenStatus(bugIssue.status, prevStatus, null, transition)
            ? '🐛 Bug ReOpened'
            : assigneeChanged
              ? '🐛 Bug đổi người phụ trách'
              : '🐛 Bug Open / phân công';
        notificationsToSend.push({
          title,
          body: `📌 [${bugIssue.key}] ${bugIssue.summary}${assigneeLine}`,
          icon: '/notify-bug-open.svg',
          url: `${jiraBaseUrl}/browse/${bugIssue.key}`,
        });
      }
    }

    bugStatusByKey.set(mapKey, bugIssue.status || '');
    bugAssigneeByKey.set(mapKey, nowAssigneeKey);
    bugOpenNotifySigByKey.set(mapKey, `${bugIssue.status || ''}|${nowAssigneeKey}`);
  };

  for (const issue of rawIssues) {
    if (isBugIssue(issue)) {
      processBug(issue);
    } else if (issue.isSubtask && isSubtaskAllowed) {
      const mapKey = issue.key;
      const prev = subtaskStatusByKey.get(mapKey);
      const hasBaseline = prev !== undefined;
      const statusChanged =
        hasBaseline &&
        (prev.status !== (issue.status || '') || prev.statusCategory !== (issue.statusCategory || ''));
      const isNowDone = workflowIndex.isDone(issue.status, issue.statusCategory);
      const wasDone = prev ? workflowIndex.isDone(prev.status, prev.statusCategory) : false;

      if (statusChanged && isNowDone && !wasDone) {
        const updater = getUpdaterName(issue);
        const parentLine = issue.parentKey ? `\n📂 Thuộc: ${issue.parentKey}` : '';
        const byLine = updater ? `\n👤 ${updater}` : '';
        const statusLabel = issue.status || 'Done';
        notificationsToSend.push({
          title: `✅ Subtask đã ${statusLabel}`,
          body: `📝 [${issue.key}] ${issue.summary}` + parentLine + byLine,
          icon: '/notify-subtask.svg',
          url: `${jiraBaseUrl}/browse/${issue.key}`,
        });
      }

      subtaskStatusByKey.set(mapKey, {
        status: issue.status || '',
        statusCategory: issue.statusCategory || '',
      });
    }
  }

  const exclude = new Set((options.excludeUserIds || []).map(Number).filter(Boolean));
  const recipientIds = exclude.size
    ? memberUserIds.filter(id => !exclude.has(id))
    : memberUserIds;
  await deliverNotificationsToUsers(recipientIds, notificationsToSend, memberRows);
}

async function pollPushNotifications(jiraBaseUrl, onlyProjectKey = null) {
  if (isRunning) return;
  isRunning = true;
  cachedJiraBaseUrl = jiraBaseUrl || cachedJiraBaseUrl;

  try {
    const settings = await getNotificationSettings();
    if (!settings.isBugAllowed && !settings.isSubtaskAllowed && !settings.isBugOpenAllowed) {
      return;
    }

    let projectKeys = onlyProjectKey ? [onlyProjectKey] : await getActiveProjectKeys();
    if (settings.notificationProjects && settings.notificationProjects.length > 0) {
      projectKeys = projectKeys.filter(k => settings.notificationProjects.includes(k));
    }
    if (projectKeys.length === 0) return;

    for (const projectKey of projectKeys) {
      try {
        await processProjectNotifications(projectKey, jiraBaseUrl, settings);
      } catch (err) {
        console.error(`[NotificationCron] Loi project ${projectKey}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Push notification cron error:', err.message);
  } finally {
    isRunning = false;
  }
}

/** Gọi ngay sau khi đổi status trong app — không chờ poll 3s. */
async function pollProjectNow(projectKey, jiraBaseUrl, options = {}) {
  if (!projectKey) return;
  const settings = await getNotificationSettings();
  if (!settings.isBugAllowed && !settings.isSubtaskAllowed && !settings.isBugOpenAllowed) {
    return;
  }
  if (settings.notificationProjects && settings.notificationProjects.length > 0) {
    if (!settings.notificationProjects.includes(projectKey)) return;
  }
  const baseUrl = jiraBaseUrl || cachedJiraBaseUrl;
  try {
    if (!seededProjects.has(projectKey)) {
      await processProjectNotifications(projectKey, baseUrl, settings, options);
    }
    await processProjectNotifications(projectKey, baseUrl, settings, options);
  } catch (err) {
    console.error(`[NotificationCron] pollProjectNow ${projectKey}:`, err.message);
  }
}

function normalizeTabId(tabId) {
  return tabId && String(tabId).trim() ? String(tabId).trim() : '_default';
}

function normalizePresencePage(page) {
  const key = normalizePageKey(page) || 'dashboard';
  return isKnownPageKey(key) ? key : 'dashboard';
}

function setUserTabPageEntry(userId, tabId, page) {
  const tid = normalizeTabId(tabId);
  const key = normalizePresencePage(page);
  if (!userTabPages.has(userId)) userTabPages.set(userId, new Map());
  userTabPages.get(userId).set(tid, { page: key, updatedAt: new Date().toISOString() });
}

function getUserTabPage(userId, tabId) {
  const tid = normalizeTabId(tabId);
  return userTabPages.get(userId)?.get(tid)?.page || null;
}

function removeUserTabPageEntry(userId, tabId) {
  if (!tabId || !userTabPages.has(userId)) return;
  userTabPages.get(userId).delete(tabId);
  if (userTabPages.get(userId).size === 0) userTabPages.delete(userId);
}

function summarizeUserPages(userId) {
  const tabs = userTabPages.get(userId);
  if (!tabs?.size) {
    return { pages: [], primaryPage: null, primaryPageLabel: null };
  }

  const counts = new Map();
  let primaryPage = null;
  let primaryAt = '';

  for (const { page, updatedAt } of tabs.values()) {
    counts.set(page, (counts.get(page) || 0) + 1);
    if (updatedAt > primaryAt) {
      primaryAt = updatedAt;
      primaryPage = page;
    }
  }

  const pages = [...counts.entries()]
    .map(([page, tabCount]) => ({ page, label: getPageLabel(page), tabCount }))
    .sort((a, b) => a.label.localeCompare(b.label, 'vi'));

  return {
    pages,
    primaryPage,
    primaryPageLabel: primaryPage ? getPageLabel(primaryPage) : null,
  };
}

function syncOnlinePresence(userId, meta = {}) {
  const tabCount = sseClients.get(userId)?.size || 0;
  if (tabCount <= 0) {
    onlinePresence.delete(userId);
    presenceUserCache.delete(userId);
    return;
  }

  const now = new Date().toISOString();
  const existing = onlinePresence.get(userId);
  if (!existing) {
    onlinePresence.set(userId, {
      userId,
      username: meta.username || null,
      appRole: meta.appRole || null,
      connectedAt: now,
      lastSeenAt: now,
      tabCount,
    });
    return;
  }

  if (meta.username) existing.username = meta.username;
  if (meta.appRole) existing.appRole = meta.appRole;
  existing.tabCount = tabCount;
  existing.lastSeenAt = now;
}

async function buildPresenceSnapshot() {
  const ids = [...onlinePresence.keys()];
  if (!ids.length) {
    presenceUserCache.clear();
    return { users: [], onlineCount: 0, updatedAt: new Date().toISOString() };
  }

  for (const cachedId of presenceUserCache.keys()) {
    if (!onlinePresence.has(cachedId)) presenceUserCache.delete(cachedId);
  }

  const missingIds = ids.filter(id => !presenceUserCache.has(id));
  if (missingIds.length) {
    const res = await db.query(
      `SELECT id, username, display_name, avatar_url, app_role, email_address
       FROM jira_users WHERE id = ANY($1::int[])`,
      [missingIds]
    );
    for (const row of res.rows) presenceUserCache.set(row.id, row);
  }

  const byId = presenceUserCache;

  const users = ids.map(id => {
    const p = onlinePresence.get(id);
    const row = byId.get(id);
    const pageInfo = summarizeUserPages(id);
    return {
      userId: id,
      username: row ? row.username : (p?.username || null),
      displayName: row?.display_name || p?.username || null,
      emailAddress: row?.email_address || null,
      avatarUrl: row?.avatar_url || null,
      appRole: row?.app_role || p?.appRole || null,
      tabCount: p?.tabCount || 0,
      connectedAt: p?.connectedAt || null,
      lastSeenAt: p?.lastSeenAt || null,
      primaryPage: pageInfo.primaryPage,
      primaryPageLabel: pageInfo.primaryPageLabel,
      pages: pageInfo.pages,
    };
  });

  users.sort((a, b) => String(a.displayName || a.username || '').localeCompare(String(b.displayName || b.username || ''), 'vi'));

  return {
    users,
    onlineCount: users.length,
    updatedAt: new Date().toISOString(),
  };
}

let presenceBroadcastTimer = null;

function schedulePresenceBroadcast() {
  if (presenceBroadcastTimer) return;
  presenceBroadcastTimer = setTimeout(async () => {
    presenceBroadcastTimer = null;
    if (!presenceMonitorClients.size) return;
    try {
      const snapshot = await buildPresenceSnapshot();
      const payload = JSON.stringify(snapshot);
      for (const clientRes of presenceMonitorClients) {
        try {
          clientRes.write(`event: presence\ndata: ${payload}\n\n`);
        } catch {
          presenceMonitorClients.delete(clientRes);
        }
      }
    } catch (err) {
      console.error('[Presence] broadcast error:', err.message);
    }
  }, 120);
}

module.exports = {
  addSseClient: (userId, res, meta = {}) => {
    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);
    const tabId = normalizeTabId(meta.tabId);
    sseTabIds.set(res, tabId);
    const isNewTab = getUserTabPage(userId, tabId) === null;
    setUserTabPageEntry(userId, tabId, meta.page || 'dashboard');
    syncOnlinePresence(userId, meta);
    if (isNewTab) schedulePresenceBroadcast();
  },
  removeSseClient: (userId, res) => {
    const tabId = sseTabIds.get(res);
    sseTabIds.delete(res);
    if (tabId) removeUserTabPageEntry(userId, tabId);
    if (sseClients.has(userId)) {
      sseClients.get(userId).delete(res);
      if (sseClients.get(userId).size === 0) {
        sseClients.delete(userId);
        userTabPages.delete(userId);
      }
    }
    syncOnlinePresence(userId);
    schedulePresenceBroadcast();
  },
  setUserTabPage(userId, tabId, page) {
    if (!sseClients.has(userId) || sseClients.get(userId).size === 0) {
      return false;
    }
    const nextPage = normalizePresencePage(page);
    if (getUserTabPage(userId, tabId) === nextPage) {
      return true;
    }
    setUserTabPageEntry(userId, tabId, nextPage);
    syncOnlinePresence(userId);
    schedulePresenceBroadcast();
    return true;
  },
  async getPresenceSnapshot() {
    return buildPresenceSnapshot();
  },
  addPresenceMonitorClient: res => {
    presenceMonitorClients.add(res);
  },
  removePresenceMonitorClient: res => {
    presenceMonitorClients.delete(res);
  },
  async sendPresenceToClient(res) {
    const snapshot = await buildPresenceSnapshot();
    res.write(`event: presence\ndata: ${JSON.stringify(snapshot)}\n\n`);
  },
  sendSseToUsers: (userIds, payloadStr) => {
    if (!userIds) {
      // Send to all
      for (const clients of sseClients.values()) {
        for (const res of clients) {
          res.write(`data: ${payloadStr}\n\n`);
        }
      }
    } else {
      // Send to specific users
      for (const userId of userIds) {
        if (sseClients.has(userId)) {
          const clients = sseClients.get(userId);
          for (const res of clients) {
            res.write(`data: ${payloadStr}\n\n`);
          }
        }
      }
    }
  },
  pollProjectNow,
  start: jiraBaseUrl => {
    cachedJiraBaseUrl = jiraBaseUrl || '';
    seededProjects.clear();
    bugStatusByKey.clear();
    bugAssigneeByKey.clear();
    bugOpenNotifySigByKey.clear();
    subtaskStatusByKey.clear();
    console.log(
      '[NotificationCron] Poll 5s — jira_users; seed baseline khi restart, chi notify thay doi moi'
    );
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      console.warn('[NotificationCron] VAPID chưa cấu hình — chỉ SSE, không web push');
    }
    setInterval(() => pollPushNotifications(jiraBaseUrl), 5000);
  },
};
