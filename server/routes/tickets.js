const express = require('express');
const axios = require('axios');
const db = require('../db');
const {
  monthPlanDateFilterClause,
  monthPlanDateFilterParams,
  issueMatchesMonthPlanDatesOnly,
  formatPlanDateFromDb,
  planDateInWeek,
  planDateToYmd,
  ymdInWorkTz,
  getCurrentWeekYmdRangeBangkok,
  computeWeekStatsFromDashboardTickets,
  yearMonthInWorkTz,
} = require('../lib/jiraMonthFilter');
const { upsertJiraIssue } = require('../lib/jiraIssueUpsert');
const {
  buildAssigneeLookup,
  loadAssigneeLookup,
  normalizeAssignee,
  assigneeMatchesUser,
  normalizeEmail,
  migrateAssigneeAccountIdsToEmail,
  normalizeIssueTreeAssignees,
  enrichIssueRowsFromLookup,
  JIRA_USER_ASSIGNEE_JOIN,
  RESOLVED_ASSIGNEE_EMAIL_SQL,
} = require('../lib/assigneeIdentity');
const {
  jiraFieldToStorage,
  normalizeJiraComments,
  normalizeCommentsForResponse,
  aggregateParentFamilyComments,
  aggregateSubtaskFamilyComments,
  countParentFamilyComments,
  countSubtaskFamilyComments,
  countStoredComments,
} = require('../lib/jiraComments');
const {
  buildAndPostComment,
  buildWikiCommentBody,
  descriptionHasWikiImages,
  uploadIssueAttachments,
  refreshIssueCommentsAndStatus,
} = require('../lib/jiraCommentPost');
const { assertTransitionAllowed } = require('../lib/jiraTransitionFlow');
const { requireUserJiraToken } = require('../lib/jiraToken');
const {
  listWorkflowCacheMeta,
  syncAllWorkflowCaches,
  resolveTransitionsForIssue,
} = require('../lib/jiraWorkflowCache');
const {
  fetchIssueFromJira,
  fetchTransitionsFromJira,
  mapJiraIssue,
  normalizeTransitions,
} = require('../lib/jiraSyncOneIssue');
const { enrichRawIssueFromJira } = require('../lib/jiraSyncEnrich');
const {
  validateTransitionInput,
  buildTransitionFieldsPayload,
  formatJiraApiError,
  OUTPUT_FIELD_KEY,
} = require('../lib/jiraTransitionFields');
const { attachWorklogAggregatesToRows } = require('../lib/jiraWorklogIndex');
const {
  fetchLatestUserWorklogForIssue,
  fetchUserMonthSecondsForIssue,
} = require('../lib/worklogFromDb');
const { fetchMonthlyDashboard } = require('../lib/dashboardMonthlyFromDb');
const { fetchTesterDashboard } = require('../lib/dashboardTesterFromDb');
const notificationCron = require('../services/notificationCron');
const { resolveChildIssueTypeForProject } = require('../lib/jiraCreateMeta');
const {
  getIssueAttachmentIndex,
  resolveAttachmentFile,
  invalidateIssueAttachmentCache,
} = require('../lib/jiraAttachmentCache');
const { attachmentsForApiResponse } = require('../lib/jiraAttachmentsDb');
const { EXCLUDE_CANCELLED_SQL, isCancelledIssueStatus } = require('../lib/jiraIssueStatusFilters');

module.exports = context => {
  const router = express.Router();
  const {
    JWT_SECRET,
    authenticateToken,
    optionalAuth,
    requirePermission,
    requireAdmin,
    httpsAgent,
    pushToJira,
    resolveJiraAssignee,
    getActiveSprintId,
    formatJiraDate,
  } = context;

  const inFlightRequests = new Map();

  const parseYmdForDb = dateStr => {
    if (!dateStr) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    return formatPlanDateFromDb(dateStr);
  };

  const ymdToDateString = ymd => {
    const y = Math.floor(ymd / 10000);
    const mo = Math.floor((ymd % 10000) / 100);
    const d = ymd % 100;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  /** Sub-task mới: start = hôm nay (Bangkok), due = +2 ngày. */
  const defaultChildPlanDates = () => {
    const todayYmd = ymdInWorkTz(new Date());
    const y = Math.floor(todayYmd / 10000);
    const mo = Math.floor((todayYmd % 10000) / 100);
    const d = todayYmd % 100;
    const startDate = ymdToDateString(todayYmd);
    const dueYmd = ymdInWorkTz(new Date(Date.UTC(y, mo - 1, d + 2)));
    return { startDate, dueDate: ymdToDateString(dueYmd) };
  };

  const isOverdueDueDate = dueDate => {
    const dueYmd = planDateToYmd(dueDate);
    if (dueYmd == null) return true;
    return dueYmd < ymdInWorkTz(new Date());
  };

  const assigneeInActiveSet = (assignee, activeRows) => {
    if (!assignee || !activeRows.length) return false;
    const aEmail = normalizeEmail(assignee.emailAddress || assignee.accountId);
    for (const row of activeRows) {
      const rowEmail = normalizeEmail(row.email_address);
      if (aEmail && rowEmail && aEmail === rowEmail) return true;
      if (assignee.accountId && row.account_id === assignee.accountId) return true;
      const aName = (assignee.displayName || '').trim().toLowerCase();
      const rName = (row.display_name || '').trim().toLowerCase();
      if (aName && rName && aName === rName) return true;
    }
    return false;
  };

  const patchIssuePlanDatesInDb = async (keys, dueDate, startDate) => {
    if (!Array.isArray(keys) || keys.length === 0) return;
    const dueDb = parseYmdForDb(dueDate);
    if (!dueDb) return;
    const startDb = startDate ? parseYmdForDb(startDate) : null;
    await db.query(
      `UPDATE jira_issues
       SET due_date = $1::date,
           start_date = CASE WHEN $2::date IS NOT NULL THEN $2::date ELSE start_date END,
           updated_at = NOW()
       WHERE key = ANY($3::text[])`,
      [dueDb, startDb, keys]
    );
  };

  const patchIssueContentInDb = async (key, { summary, description, output }) => {
    const sets = [];
    const vals = [key];
    let idx = 2;
    if (summary !== undefined) {
      sets.push(`summary = $${idx++}`);
      vals.push(String(summary ?? ''));
    }
    if (description !== undefined) {
      sets.push(`description = $${idx++}`);
      vals.push(String(description ?? ''));
    }
    if (output !== undefined) {
      sets.push(`output = $${idx++}`);
      vals.push(String(output ?? ''));
    }
    if (!sets.length) return;
    sets.push('updated_at = NOW()');
    await db.query(`UPDATE jira_issues SET ${sets.join(', ')} WHERE key = $1`, vals);
  };

  const patchIssueAssigneeInDb = async (key, assignee) => {
    if (!assignee) {
      await db.query(
        `UPDATE jira_issues
         SET assignee_name = NULL, assignee_account_id = NULL, assignee_role = NULL, updated_at = NOW()
         WHERE key = $1`,
        [key]
      );
      return;
    }
    const storageEmail =
      normalizeEmail(assignee.emailAddress) || normalizeEmail(assignee.accountId) || null;
    await db.query(
      `UPDATE jira_issues
       SET assignee_name = $2,
           assignee_account_id = $3,
           assignee_role = $4,
           updated_at = NOW()
       WHERE key = $1`,
      [key, assignee.displayName || null, storageEmail || assignee.accountId || null, assignee.role || null]
    );
  };

  const fetchOverdueFromDb = async (projectKey, showAll, user) => {
    const activeUsersRes = await db.query(
      `SELECT account_id, email_address, display_name
       FROM jira_users
       WHERE is_active = true
         AND string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]`,
      [projectKey]
    );
    const activeRows = activeUsersRes.rows;

    const dbRes = await db.query(
      `SELECT ${ISSUE_ROW_SELECT}
       FROM jira_issues i
       ${JIRA_USER_ASSIGNEE_JOIN}
       WHERE i.project_key = $1
         AND COALESCE(LOWER(i.status_category), '') <> 'done'
         AND LOWER(COALESCE(i.status, '')) NOT IN ('done', 'closed', 'resolved')
         AND i.assignee_account_id IS NOT NULL
       ORDER BY i.due_date ASC NULLS FIRST`,
      [projectKey]
    );
    const userForMatch = user
      ? {
          emailAddress: user.email || user.username,
          displayName: user.username,
          accountId: user.email || user.username,
        }
      : null;

    return dbRes.rows.map(mapDbRowToIssueFormat).filter(t => {
      if (!t) return false;
      if (showAll) {
        if (activeRows.length > 0 && !assigneeInActiveSet(t.assignee, activeRows)) return false;
      } else if (userForMatch && !assigneeMatchesUser(t.assignee, userForMatch)) {
        return false;
      }
      return isOverdueDueDate(t.dueDate);
    });
  };

  // ==========================================
  // Push Manual
  // ==========================================

  router.post('/api/push-manual', authenticateToken, async (req, res) => {
    const {
      ticket,
      assigneeId,
      createAutoSubTasks,
      subTaskDevAssignee,
      subTaskTestAssignee,
      subTaskStartDate,
      subTaskDueDate,
      startDate,
      dueDate,
      originalEstimate,
    } = req.body;

    if (!ticket || !ticket.summary) {
      return res.status(400).json({ error: 'Missing ticket data' });
    }

    const jiraToken = await requireUserJiraToken(db, req, res);
    if (!jiraToken) return;

    try {
      console.log(`Manually pushing ticket to Jira: ${ticket.summary}`);
      const jiraResponse = await pushToJira(
        ticket,
        null,
        assigneeId,
        jiraToken,
        req.user.jira_project,
        startDate,
        dueDate,
        originalEstimate
      );
      const mainKey = jiraResponse.key;

      // Create sub-tasks if any
      if (ticket.subTickets && ticket.subTickets.length > 0) {
        for (const sub of ticket.subTickets) {
          let subAssigneeId = assigneeId;

          if (createAutoSubTasks) {
            if (sub.summary.startsWith('[DEV]') && subTaskDevAssignee) {
              subAssigneeId = subTaskDevAssignee;
            } else if (sub.summary.startsWith('[TEST]') && subTaskTestAssignee) {
              subAssigneeId = subTaskTestAssignee;
            }
          }

          // Apply start/due date to subtasks only
          await pushToJira(
            sub,
            mainKey,
            subAssigneeId,
            jiraToken,
            req.user.jira_project,
            subTaskStartDate || null,
            subTaskDueDate || null
          );
        }
      }

      res.json({ success: true, key: mainKey });
    } catch (error) {
      console.error('Manual Push Error:', error.message);
      const detailedError =
        error.response?.data?.errorMessages?.join(', ') ||
        (error.response?.data?.errors ? JSON.stringify(error.response.data.errors) : error.message);
      res.status(500).json({ error: detailedError });
    }
  });

  router.post('/api/tickets/:parentKey/children', authenticateToken, async (req, res) => {
    const { parentKey } = req.params;
    const { kind, summary, description, images, assigneeId, startDate, dueDate, originalEstimate } =
      req.body || {};

    const trimmedSummary = String(summary || '').trim();
    if (!trimmedSummary) {
      return res.status(400).json({ error: 'Thiếu tiêu đề (summary)' });
    }

    const jiraToken = await requireUserJiraToken(db, req, res);
    if (!jiraToken) return;

    const jiraBaseUrl = process.env.JIRA_URL;

    const parentRow = await db.query(
      'SELECT key, project_key, summary FROM jira_issues WHERE key = $1',
      [parentKey]
    );
    if (!parentRow.rows.length) {
      return res.status(404).json({ error: `Không tìm thấy story/task ${parentKey} trong DB` });
    }

    const projectKey = parentRow.rows[0].project_key || req.user.jira_project;

    const childKind = String(kind || 'subtask').toLowerCase();
    let finalSummary = trimmedSummary;

    if (childKind === 'dev') {
      if (!finalSummary.toUpperCase().startsWith('[DEV]')) {
        finalSummary = `[DEV] ${finalSummary}`;
      }
    } else if (childKind === 'test') {
      if (!finalSummary.toUpperCase().startsWith('[TEST]')) {
        finalSummary = `[TEST] ${finalSummary}`;
      }
    } else if (childKind === 'bug') {
      if (!finalSummary.toUpperCase().startsWith('[BUG]')) {
        finalSummary = `[BUG] ${finalSummary}`;
      }
    }

    let issueType;
    try {
      issueType = await resolveChildIssueTypeForProject(db, projectKey, childKind, {
        token: jiraToken,
        httpsAgent,
        jiraBaseUrl,
      });
    } catch (metaErr) {
      return res
        .status(400)
        .json({ error: metaErr.message || 'Không lấy được issue type từ createmeta' });
    }

    try {
      let descriptionBody = String(description || '').trim();
      const hasImages = Array.isArray(images) && images.length > 0;
      const planDefaults = defaultChildPlanDates();
      const effectiveStartDate = startDate || planDefaults.startDate;
      const effectiveDueDate = dueDate || planDefaults.dueDate;

      const jiraResponse = await pushToJira(
        {
          summary: finalSummary,
          description: hasImages ? '' : descriptionBody,
          issueType,
        },
        parentKey,
        assigneeId || null,
        jiraToken,
        projectKey,
        effectiveStartDate,
        effectiveDueDate,
        originalEstimate || null
      );

      const childKey = jiraResponse.key;

      if (hasImages) {
        const attachmentNames = await uploadIssueAttachments(
          jiraBaseUrl,
          childKey,
          images,
          jiraToken,
          httpsAgent
        );
        if (!descriptionHasWikiImages(descriptionBody)) {
          descriptionBody = buildWikiCommentBody(descriptionBody, attachmentNames);
        }
        invalidateIssueAttachmentCache(childKey);
        await axios.put(
          `${jiraBaseUrl}/rest/api/2/issue/${childKey}`,
          { fields: { description: descriptionBody } },
          {
            headers: {
              Authorization: `Bearer ${jiraToken}`,
              'Content-Type': 'application/json',
            },
            httpsAgent,
          }
        );
      }

      const pollOptions =
        childKind === 'bug'
          ? { skipBaselineBugKeys: [childKey], excludeUserIds: [req.user.id] }
          : undefined;

      res.json({
        success: true,
        key: childKey,
        issueType,
        summary: finalSummary,
        startDate: effectiveStartDate,
        dueDate: effectiveDueDate,
      });

      void (async () => {
        const t0 = Date.now();
        try {
          const lookup = await loadAssigneeLookup(projectKey);
          const mapAssignee = a => normalizeAssignee(a, lookup);
          const raw = await fetchIssueFromJira(jiraBaseUrl, childKey, jiraToken, httpsAgent);
          await enrichRawIssueFromJira(raw, jiraToken, jiraBaseUrl);
          const mapped = mapJiraIssue(raw, mapAssignee);
          if (hasImages) {
            mapped.description = descriptionBody;
          }
          await upsertJiraIssue(mapped, projectKey, lookup);
          if (hasImages) {
            await patchIssueContentInDb(childKey, { description: descriptionBody });
          }
          if (process.env.JIRA_PUSH_TIMING === '1' || process.env.JIRA_PUSH_TIMING === 'true') {
            console.log(
              `[JiraPushTiming] childDbSync:${childKey} ${Date.now() - t0}ms (background)`
            );
          }
        } catch (syncErr) {
          console.error(`[CreateChild] DB sync ${childKey}:`, syncErr.message);
        }
        void notificationCron.pollProjectNow(projectKey, jiraBaseUrl, pollOptions);
      })();
    } catch (error) {
      const detailedError =
        error.response?.data?.errorMessages?.join(', ') ||
        (error.response?.data?.errors
          ? JSON.stringify(error.response.data.errors)
          : error.message) ||
        'Không thể tạo sub-task/bug trên Jira';
      console.error(`Create child under ${parentKey}:`, detailedError);
      res.status(500).json({ error: detailedError });
    }
  });

  // ==========================================
  // Ticket Queries
  // ==========================================

  router.get('/api/tickets/monthly-assigned', authenticateToken, async (req, res) => {
    try {
      const accRes = await db.query(
        'SELECT jira_token, jira_project FROM jira_users WHERE id = $1',
        [req.user.id]
      );
      const row = accRes.rows[0];
      const token = row?.jira_token && String(row.jira_token).trim() !== '' ? row.jira_token : null;
      if (!token) {
        return res.status(400).json({
          error:
            'Cần Jira Token cá nhân (mục Cấu hình cá nhân) để Jira xác định currentUser() đúng với bạn khi lọc assignee = currentUser().',
        });
      }

      const { month, year } = req.query;
      const now = new Date();
      const targetMonth = month ? parseInt(month, 10) : now.getMonth() + 1;
      const targetYear = year ? parseInt(year, 10) : now.getFullYear();
      const startDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
      const lastDay = new Date(targetYear, targetMonth, 0).getDate();
      const endDate = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      const projectKey = row?.jira_project || process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
      const cacheKey = `monthly_assigned_${req.user.id}_${projectKey}_${targetYear}_${targetMonth}`;

      if (inFlightRequests.has(cacheKey)) {
        try {
          const collapsedData = await inFlightRequests.get(cacheKey);
          return res.json(collapsedData);
        } catch (err) {
          return res.status(500).json({ error: err.message });
        }
      }

      async function fetchAssigned() {
        const jql = `project = ${projectKey} AND assignee = currentUser() AND (
          (cf[10300] >= "${startDate}" AND cf[10300] <= "${endDate}") OR
          (cf[10302] >= "${startDate}" AND cf[10302] <= "${endDate}") OR
          (updated >= "${startDate}" AND updated <= "${endDate} 23:59")
        ) ORDER BY updated DESC`;

        const url = `${process.env.JIRA_URL}/rest/api/2/search`;
        const fields =
          'summary,status,issuetype,updated,description,timeoriginalestimate,timeestimate,timespent,customfield_10300,customfield_10301,customfield_10302';
        const pageSize = 100;
        const maxIssues = 2000;
        let startAt = 0;
        const allRaw = [];
        while (allRaw.length < maxIssues) {
          const response = await axios.get(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            params: {
              jql,
              startAt,
              maxResults: pageSize,
              fields,
            },
            httpsAgent,
          });
          const batch = response.data.issues || [];
          allRaw.push(...batch);
          const total =
            typeof response.data.total === 'number' ? response.data.total : batch.length;
          if (batch.length === 0 || allRaw.length >= total) break;
          startAt += batch.length;
        }

        return allRaw.map(issue => ({
          id: issue.id,
          jiraKey: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status.name,
          statusCategory: issue.fields.status.statusCategory?.key,
          issueType: issue.fields.issuetype.name,
          updated: issue.fields.updated,
          timeEstimate: issue.fields.timespent || 0,
          timeSpent: issue.fields.timespent || 0,
          originalEstimate: issue.fields.timeoriginalestimate || 0,
          remainingEstimate: issue.fields.timeestimate || 0,
          startDate: issue.fields.customfield_10300 ?? null,
          dueDate: issue.fields.customfield_10302 ?? null,
          description: jiraFieldToStorage(issue.fields.description),
        }));
      }

      const fetchPromise = fetchAssigned();
      inFlightRequests.set(cacheKey, fetchPromise);
      try {
        const resultData = await fetchPromise;
        return res.json(resultData);
      } catch (err) {
        throw err;
      } finally {
        inFlightRequests.delete(cacheKey);
      }
    } catch (error) {
      console.error(
        'Jira monthly-assigned Error:',
        error.response ? error.response.data : error.message
      );
      res.status(500).json({ error: error.message });
    }
  });

  router.upsertIssueToDb = async (issue, projectKey, assigneeLookup = null) => {
    try {
      await upsertJiraIssue(issue, projectKey, assigneeLookup);
    } catch {
      /* logged in upsertJiraIssue */
    }
  };

  router.mergeDbSubtasksForParents = async (
    parentMap,
    parentKeys,
    worklogOpts = null,
    assigneeLookup = null
  ) => {
    if (!parentKeys.length) return;
    const subsRes = await db.query(
      `
      SELECT ${ISSUE_ROW_SELECT_LIGHT}
      FROM jira_issues i
      WHERE i.parent_key = ANY($1::text[]) AND i.is_subtask = true
      ORDER BY i.parent_key, i.key
      `,
      [parentKeys]
    );
    if (assigneeLookup) enrichIssueRowsFromLookup(subsRes.rows, assigneeLookup);
    if (worklogOpts) {
      await attachWorklogAggregatesToRows(db, subsRes.rows, worklogOpts);
    }
    for (const row of subsRes.rows) {
      const sub = mapDbRowToIssueFormat(row);
      if (!sub?.key || !sub.parentKey || !parentMap.has(sub.parentKey)) continue;
      const parent = parentMap.get(sub.parentKey);
      if (!parent.subTasks.some(s => s.key === sub.key)) {
        parent.subTasks.push(sub);
      }
    }
  };

  /** Gắn toàn bộ subtask cho story/task từ DB (chỉ đọc cache DB). */
  router.enrichParentsWithAllSubtasksFromDb = async (
    parentMap,
    parentKeys,
    worklogOpts = null,
    assigneeLookup = null
  ) => {
    const keys = [...new Set(parentKeys.filter(k => k && parentMap.has(k)))];
    if (!keys.length) return;
    await router.mergeDbSubtasksForParents(parentMap, keys, worklogOpts, assigneeLookup);
  };

  router.resolveOrphanSubtasksFromDb = async (
    parentMap,
    orphanSubtasks,
    worklogOpts = null,
    assigneeLookup = null
  ) => {
    if (!orphanSubtasks.length) return [];

    const orphanParentKeys = [...new Set(orphanSubtasks.map(s => s.parentKey).filter(Boolean))];
    if (orphanParentKeys.length > 0) {
      // Load parent from DB
      const dbRes = await db.query(
        `
        SELECT ${ISSUE_ROW_SELECT_LIGHT}
        FROM jira_issues i
        WHERE i.key = ANY($1::text[]) AND i.is_subtask = false
        `,
        [orphanParentKeys]
      );
      if (assigneeLookup) enrichIssueRowsFromLookup(dbRes.rows, assigneeLookup);
      if (worklogOpts) {
        await attachWorklogAggregatesToRows(db, dbRes.rows, worklogOpts);
      }
      for (const row of dbRes.rows) {
        const parent = mapDbRowToIssueFormat(row);
        if (parent && !parentMap.has(parent.key)) {
          parent.subTasks = [];
          parent.isSynthesized = false;
          parentMap.set(parent.key, parent);
        }
      }
      await router.mergeDbSubtasksForParents(parentMap, orphanParentKeys);
    }

    const stillOrphan = [];
    for (const sub of orphanSubtasks) {
      if (sub.parentKey && parentMap.has(sub.parentKey)) {
        const parent = parentMap.get(sub.parentKey);
        if (!parent.subTasks.some(s => s.key === sub.key)) {
          parent.subTasks.push(sub);
        }
      } else {
        stillOrphan.push(sub);
      }
    }

    const orphansByParent = new Map();
    stillOrphan.forEach(sub => {
      if (!orphansByParent.has(sub.parentKey)) orphansByParent.set(sub.parentKey, []);
      orphansByParent.get(sub.parentKey).push(sub);
    });

    const synthesized = [];
    for (const [parentKey, subs] of orphansByParent.entries()) {
      synthesized.push({
        id: `synth-${parentKey}`,
        key: parentKey,
        summary: parentKey,
        status: 'Chưa đồng bộ',
        statusCategory: 'new',
        issueType: 'Story',
        isSubtask: false,
        updated: subs[0]?.updated || null,
        startDate: null,
        dueDate: null,
        description: '',
        assignee: null,
        subTasks: subs,
        isSynthesized: true,
      });
    }
    return synthesized;
  };
  const ISSUE_ROW_SELECT_LIGHT = `
    i.key, i.parent_key, i.is_subtask, i.summary, i.status, i.status_category, i.issue_type,
    i.updated_at, i.created_at, i.original_estimate, i.remaining_estimate,
    i.start_date, i.due_date, i.creator, i.time_spent, i.description,
    i.assignee_account_id, i.assignee_name, i.assignee_role
  `;

  const ISSUE_ROW_SELECT = `
    ${ISSUE_ROW_SELECT_LIGHT},
    ${RESOLVED_ASSIGNEE_EMAIL_SQL},
    u.role AS assignee_role_resolved,
    u.avatar_url AS assignee_avatar_url
  `;

  const STORY_TASK_TYPE_SQL = `
    LOWER(COALESCE(p.issue_type, '')) NOT SIMILAR TO '%(epic|initiative|feature|theme|capability)%'
    AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%sub%task%'
    AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%bug%'
    AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%lỗi%'
    AND (
      LOWER(COALESCE(p.issue_type, '')) LIKE '%story%'
      OR LOWER(COALESCE(p.issue_type, '')) LIKE '%yêu cầu%'
      OR LOWER(COALESCE(p.issue_type, '')) LIKE '%công việc%'
      OR (
        LOWER(COALESCE(p.issue_type, '')) LIKE '%task%'
        AND LOWER(COALESCE(p.issue_type, '')) NOT LIKE '%sub%'
      )
    )
  `;

  const TESTER_RELEVANCE_SQL = `
    (
      p.assignee_role = 'tester'
      OR EXISTS (
        SELECT 1 FROM jira_users pu
        WHERE pu.role = 'tester'
          AND (
            LOWER(TRIM(COALESCE(pu.email_address, ''))) = LOWER(TRIM(COALESCE(p.assignee_account_id, '')))
            OR pu.account_id = p.assignee_account_id
          )
      )
      OR EXISTS (
        SELECT 1 FROM jira_issues s
        LEFT JOIN jira_users su ON (
          LOWER(TRIM(COALESCE(su.email_address, ''))) = LOWER(TRIM(COALESCE(s.assignee_account_id, '')))
          OR su.account_id = s.assignee_account_id
        )
        WHERE s.project_key = $1
          AND s.parent_key = p.key
          AND s.is_subtask = true
          AND (s.assignee_role = 'tester' OR su.role = 'tester')
      )
    )
  `;

  const mapDbRowToIssueFormat = row => {
    if (!row) return null;
    return {
      id: row.key,
      key: row.key,
      summary: row.summary || '',
      status: row.status || '',
      statusCategory: row.status_category || '',
      issueType: row.issue_type || '',
      isSubtask: !!row.is_subtask,
      updated: row.updated_at
        ? row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString()
        : null,
      created: row.created_at
        ? row.created_at instanceof Date
          ? row.created_at.toISOString()
          : new Date(row.created_at).toISOString()
        : null,
      timeEstimate: row.remaining_estimate || 0,
      timeSpent: row.time_spent || 0,
      originalEstimate: row.original_estimate || 0,
      remainingEstimate: row.remaining_estimate || 0,
      creator: row.creator || null,
      startDate: formatPlanDateFromDb(row.start_date),
      dueDate: formatPlanDateFromDb(row.due_date),
      description: row.description || '',
      parentKey: row.parent_key || null,
      assignee:
        row.resolved_assignee_email || row.assignee_name || row.assignee_account_id
          ? {
              accountId: row.resolved_assignee_email || row.assignee_account_id || null,
              emailAddress: row.resolved_assignee_email || null,
              displayName: row.assignee_name || null,
              avatarUrl: row.assignee_avatar_url || null,
              role: row.assignee_role_resolved || row.assignee_role || null,
            }
          : null,
      worklogAgg: row.worklogAgg || [],
    };
  };

  /** Đọc trực tiếp PostgreSQL — không cache HTTP. */
  router.getUserDashboardTasksFromDb = async (
    projectKey,
    normalizedMonth,
    normalizedYear,
    userEmail,
    assigneeLookupIn = null
  ) => {
    const t0 = Date.now();
    const assigneeLookup = assigneeLookupIn || (await loadAssigneeLookup(projectKey));
    const monthQuery = normalizedMonth ? parseInt(normalizedMonth, 10) : null;
    const yearQuery = normalizedYear ? parseInt(normalizedYear, 10) : null;
    const weekRange = getCurrentWeekYmdRangeBangkok();
    const worklogOpts = { year: yearQuery, month: monthQuery, weekRange };

    let dbRes;
    const monthWhere = monthPlanDateFilterClause('', 2);

    const cteQuery = `
      WITH month_issues AS (
        SELECT key, parent_key, is_subtask
        FROM jira_issues
        WHERE project_key = $1 AND ${monthWhere}
      ),
      all_keys AS (
        SELECT key FROM month_issues
        UNION
        SELECT parent_key AS key FROM month_issues WHERE is_subtask = true AND parent_key IS NOT NULL
        UNION
        SELECT key FROM jira_issues
        WHERE project_key = $1 AND is_subtask = true AND parent_key IN (
          SELECT key FROM month_issues WHERE is_subtask = false
          UNION
          SELECT parent_key FROM month_issues WHERE is_subtask = true AND parent_key IS NOT NULL
        )
      )
      SELECT ${ISSUE_ROW_SELECT_LIGHT}
      FROM jira_issues i
      WHERE i.project_key = $1 AND i.key IN (SELECT key FROM all_keys)
    `;
    dbRes = await db.query(cteQuery, [
      projectKey,
      ...monthPlanDateFilterParams(yearQuery, monthQuery),
    ]);
    enrichIssueRowsFromLookup(dbRes.rows, assigneeLookup);
    await attachWorklogAggregatesToRows(db, dbRes.rows, worklogOpts);

    console.log(
      `[DB Serve] ${projectKey} ${normalizedMonth}/${normalizedYear} — ${dbRes.rows.length} rows, ${Date.now() - t0}ms`
    );
    const rawIssues = dbRes.rows.map(mapDbRowToIssueFormat);
    const parents = [];
    const subtasks = [];

    rawIssues.forEach(issue => {
      if (issue.isSubtask) {
        subtasks.push(issue);
      } else {
        issue.subTasks = [];
        parents.push(issue);
      }
    });

    const parentMap = new Map();
    parents.forEach(p => parentMap.set(p.key, p));

    const remainingOrphanSubtasks = [];
    subtasks.forEach(s => {
      if (parentMap.has(s.parentKey)) {
        parentMap.get(s.parentKey).subTasks.push(s);
      } else {
        remainingOrphanSubtasks.push(s);
      }
    });

    const synthesizedParents = await router.resolveOrphanSubtasksFromDb(
      parentMap,
      remainingOrphanSubtasks,
      worklogOpts,
      assigneeLookup
    );
    for (const p of synthesizedParents) {
      if (!parentMap.has(p.key)) parentMap.set(p.key, p);
    }
    await router.enrichParentsWithAllSubtasksFromDb(
      parentMap,
      [...parentMap.keys()],
      worklogOpts,
      assigneeLookup
    );

    const result = [...parentMap.values()];

    for (const parent of result) {
      normalizeIssueTreeAssignees(parent, assigneeLookup);
    }

    result.sort((a, b) => {
      const aDone =
        a.statusCategory?.toLowerCase() === 'done' || a.status?.toLowerCase() === 'closed';
      const bDone =
        b.statusCategory?.toLowerCase() === 'done' || b.status?.toLowerCase() === 'closed';
      if (aDone !== bDone) return aDone ? 1 : -1;
      return new Date(b.updated) - new Date(a.updated);
    });

    return { projectKey, issues: result, currentUserEmail: userEmail };
  };

  /**
   * Tester Tasks — đọc DB ổn định: lọc parent bằng SQL (không phụ thuộc merge subtask trong RAM).
   */
  router.getTesterDashboardTasksFromDb = async (
    projectKey,
    normalizedMonth,
    normalizedYear,
    userEmail
  ) => {
    const monthQuery = normalizedMonth ? parseInt(normalizedMonth, 10) : null;
    const yearQuery = normalizedYear ? parseInt(normalizedYear, 10) : null;

    await migrateAssigneeAccountIdsToEmail(projectKey);

    let parentKeys = [];

    if (monthQuery && yearQuery) {
      const monthWhere = monthPlanDateFilterClause('', 2);

      const keysRes = await db.query(
        `
        WITH month_parents AS (
          SELECT key
          FROM jira_issues
          WHERE project_key = $1 AND is_subtask = false AND ${monthWhere}
        ),
        all_keys AS (
          SELECT key FROM month_parents
          UNION
          SELECT key FROM jira_issues
          WHERE project_key = $1 AND is_subtask = true AND parent_key IN (SELECT key FROM month_parents)
        )
        SELECT p.key
        FROM jira_issues p
        WHERE p.project_key = $1
          AND p.key IN (SELECT key FROM all_keys)
          AND p.is_subtask = false
          AND ${STORY_TASK_TYPE_SQL}
        ORDER BY p.key
        `,
        [projectKey, ...monthPlanDateFilterParams(yearQuery, monthQuery)]
      );
      parentKeys = keysRes.rows.map(r => r.key);
    } else {
      const keysRes = await db.query(
        `
        SELECT p.key
        FROM jira_issues p
        WHERE p.project_key = $1
          AND p.is_subtask = false
          AND (p.status_category != 'done' OR p.updated_at >= CURRENT_DATE - INTERVAL '14 days')
          AND ${STORY_TASK_TYPE_SQL}
          AND ${TESTER_RELEVANCE_SQL}
        ORDER BY p.key
        `,
        [projectKey]
      );
      parentKeys = keysRes.rows.map(r => r.key);
    }

    if (parentKeys.length === 0) {
      return { projectKey, issues: [], currentUserEmail: userEmail };
    }

    const assigneeLookup = await loadAssigneeLookup(projectKey);
    const weekRange = getCurrentWeekYmdRangeBangkok();
    const worklogOpts = { year: yearQuery, month: monthQuery, weekRange };

    const [parentsRes, subsRes] = await Promise.all([
      db.query(
        `
        SELECT ${ISSUE_ROW_SELECT_LIGHT}
        FROM jira_issues i
        WHERE i.project_key = $1 AND i.key = ANY($2::text[])
        `,
        [projectKey, parentKeys]
      ),
      db.query(
        `
        SELECT ${ISSUE_ROW_SELECT_LIGHT}
        FROM jira_issues i
        WHERE i.project_key = $1 AND i.is_subtask = true AND i.parent_key = ANY($2::text[])
        ORDER BY i.parent_key, i.key
        `,
        [projectKey, parentKeys]
      ),
    ]);

    enrichIssueRowsFromLookup(parentsRes.rows, assigneeLookup);
    enrichIssueRowsFromLookup(subsRes.rows, assigneeLookup);
    await attachWorklogAggregatesToRows(db, [...parentsRes.rows, ...subsRes.rows], worklogOpts);

    const parentMap = new Map();
    for (const row of parentsRes.rows) {
      const parent = mapDbRowToIssueFormat(row);
      parent.subTasks = [];
      parentMap.set(parent.key, parent);
    }

    for (const row of subsRes.rows) {
      const sub = mapDbRowToIssueFormat(row);
      const parent = parentMap.get(sub.parentKey);
      if (parent) parent.subTasks.push(sub);
    }

    const result = parentKeys.map(key => parentMap.get(key)).filter(Boolean);

    result.sort((a, b) => {
      const aDone =
        a.statusCategory?.toLowerCase() === 'done' || a.status?.toLowerCase() === 'closed';
      const bDone =
        b.statusCategory?.toLowerCase() === 'done' || b.status?.toLowerCase() === 'closed';
      if (aDone !== bDone) return aDone ? 1 : -1;
      return new Date(b.updated) - new Date(a.updated);
    });

    console.log(
      `[Tester DB] ${projectKey} ${normalizedMonth}/${normalizedYear}: ${result.length} story/task`
    );
    return { projectKey, issues: result, currentUserEmail: userEmail };
  };

  router.get('/api/tester/dashboard-tasks', optionalAuth, async (req, res) => {
    try {
      let userEmail = normalizeEmail(req.user?.username) || null;
      let jiraProject = req.user?.jira_project || null;

      if (req.user?.id && !userEmail) {
        const accRes = await db.query(
          'SELECT username, email_address, jira_project FROM jira_users WHERE id = $1',
          [req.user.id]
        );
        const row = accRes.rows[0];
        userEmail = normalizeEmail(row?.username) || normalizeEmail(row?.email_address) || null;
        jiraProject = jiraProject || row?.jira_project || null;
      }

      if (!jiraProject) {
        const fallbackRes = await db.query(
          "SELECT jira_project FROM jira_users WHERE jira_project IS NOT NULL AND jira_project != '' LIMIT 1"
        );
        if (fallbackRes.rows.length > 0) {
          jiraProject = fallbackRes.rows[0].jira_project;
        }
      }

      const projectKey =
        req.query.projectKey || jiraProject || process.env.JIRA_PROJECT_KEY || 'BXDCSDL';

      const { month, year } = req.query;
      const normalizedMonth = month ? String(parseInt(month, 10)).padStart(2, '0') : null;
      const normalizedYear = year ? String(parseInt(year, 10)) : null;

      const { issues, timing } = await fetchTesterDashboard(
        db,
        projectKey,
        normalizedMonth,
        normalizedYear
      );

      console.log(
        `[Tester DB] ${projectKey} ${normalizedMonth}/${normalizedYear} — ${timing.parentCount ?? 0} parents, keys ${timing.keysMs}ms + tree ${timing.treeMs}ms = total ${timing.totalMs}ms`
      );

      return res.json({
        projectKey,
        issues,
        currentUserEmail: userEmail,
      });
    } catch (error) {
      console.error(
        'Jira tester-tasks Error:',
        error.response ? error.response.data : error.message
      );
      if (error.response && error.response.status === 401) {
        return res
          .status(401)
          .json({ error: 'invalid_token', message: 'Token cá nhân không hợp lệ hoặc đã hết hạn.' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/tickets/details/:key', optionalAuth, async (req, res) => {
    const { key } = req.params;
    const t0 = Date.now();

    const parseDetailsWith = () => {
      const raw = req.query.with ?? req.query.include;
      if (raw == null || raw === '') {
        return { content: true, comments: true, attachments: true, worklog: true, full: true };
      }
      const parts = String(raw)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
      if (parts.includes('all')) {
        return { content: true, comments: true, attachments: true, worklog: true, full: false };
      }
      return {
        content: parts.includes('content'),
        comments: parts.includes('comments'),
        attachments: parts.includes('attachments'),
        worklog: parts.includes('worklog'),
        full: false,
      };
    };

    const wants = parseDetailsWith();
    const needRowMeta = wants.comments || wants.full;
    const selectAttachments = wants.attachments || wants.full;
    const selectContent = wants.content || wants.full;
    const selectDates = wants.full || wants.worklog;

    try {
      const result = await db.query(
        `
        SELECT
          i.key,
          i.summary,
          ${selectContent ? 'i.description, i.output,' : ''}
          ${selectAttachments ? 'i.attachments,' : 'COALESCE(jsonb_array_length(i.attachments), 0) AS attachment_count,'}
          ${selectDates ? 'i.start_date, i.due_date, i.updated_at, i.created_at, i.time_spent, i.original_estimate, i.remaining_estimate,' : ''}
          i.creator,
          i.creator_email,
          i.is_subtask,
          i.parent_key,
          i.assignee_account_id,
          i.assignee_name,
          i.assignee_role,
          ${RESOLVED_ASSIGNEE_EMAIL_SQL},
          u.role AS assignee_role_resolved,
          u.avatar_url AS assignee_avatar_url
          ${needRowMeta && !selectContent ? ', i.comments' : ''}
        FROM jira_issues i
        ${JIRA_USER_ASSIGNEE_JOIN}
        WHERE i.key = $1
        `,
        [key]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'not_found',
          message: `Ticket ${key} chưa có trong database. Đợi đồng bộ Jira hoặc mở ticket từ dashboard.`,
        });
      }

      const row = result.rows[0];
      const isSubtask = !!row.is_subtask;
      const parentKey = row.parent_key || null;
      const iso = v => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

      let comments;
      let commentsIncludeRelated = false;
      if (wants.comments || wants.full) {
        if (isSubtask && parentKey) {
          comments = await aggregateSubtaskFamilyComments(db, row.key, parentKey);
          commentsIncludeRelated = true;
        } else if (!isSubtask) {
          comments = await aggregateParentFamilyComments(db, row.key);
          commentsIncludeRelated = comments.some(c => c.sourceType === 'sibling');
        } else {
          comments = normalizeCommentsForResponse(Array.isArray(row.comments) ? row.comments : []);
        }
      }

      let myWorklog = null;
      let timeSpentMonth = null;
      if ((wants.worklog || wants.full) && req.user?.id) {
        const { year, month } = req.query;
        myWorklog = await fetchLatestUserWorklogForIssue(db, req.user.id, key, { year, month });
        if (year && month) {
          timeSpentMonth = await fetchUserMonthSecondsForIssue(db, req.user.id, key, year, month);
        }
      }

      const payload = {
        summary: row.summary || '',
        creator: row.creator || null,
        creatorEmail: row.creator_email || null,
        isSubtask,
        parentKey,
        assignee:
          row.resolved_assignee_email || row.assignee_name || row.assignee_account_id
            ? {
                accountId: row.resolved_assignee_email || row.assignee_account_id || null,
                emailAddress: row.resolved_assignee_email || null,
                displayName: row.assignee_name || null,
                avatarUrl: row.assignee_avatar_url || null,
                role: row.assignee_role_resolved || row.assignee_role || null,
              }
            : null,
      };

      if (selectContent || wants.full) {
        payload.description = row.description ?? '';
        payload.output = row.output || '';
        if (!wants.comments && !wants.full) {
          let commentMeta;
          if (isSubtask && parentKey) {
            commentMeta = await countSubtaskFamilyComments(db, row.key, parentKey);
          } else if (!isSubtask) {
            commentMeta = await countParentFamilyComments(db, row.key);
          } else {
            commentMeta = {
              count: countStoredComments(row.comments),
              includeRelated: false,
            };
          }
          payload.commentCount = commentMeta.count;
          payload.commentsIncludeRelated = commentMeta.includeRelated;
        }
      }
      if (selectDates || wants.full) {
        payload.startDate = formatPlanDateFromDb(row.start_date);
        payload.dueDate = formatPlanDateFromDb(row.due_date);
        payload.updated = iso(row.updated_at);
        payload.created = iso(row.created_at);
        payload.timeSpent = row.time_spent ?? 0;
        payload.originalEstimate = row.original_estimate ?? 0;
        payload.remainingEstimate = row.remaining_estimate ?? 0;
      }
      if (wants.comments || wants.full) {
        payload.commentsIncludeRelated = commentsIncludeRelated;
        payload.comments = comments;
      }
      if (selectAttachments || wants.full) {
        payload.attachments = attachmentsForApiResponse(row.attachments);
      } else if (row.attachment_count != null) {
        payload.attachmentCount = Number(row.attachment_count) || 0;
      }
      if ((wants.worklog || wants.full) && req.user?.id) {
        payload.myWorklog = myWorklog;
        payload.timeSpentMonth = timeSpentMonth;
      }

      const timingMs = Date.now() - t0;
      if (!wants.full && wants.content && !wants.comments) {
        console.log(`[DB Serve] details ${key} with=content — ${timingMs}ms`);
      }

      res.setHeader('Cache-Control', 'private, no-cache');
      res.json(payload);
    } catch (error) {
      console.error('Ticket details (DB) Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch issue details' });
    }
  });

  router.get('/api/tickets/:key/attachments', optionalAuth, async (req, res) => {
    const { key } = req.params;
    try {
      const result = await db.query(`SELECT attachments FROM jira_issues WHERE key = $1`, [key]);
      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: 'not_found', message: `Ticket ${key} chưa có trong database.` });
      }
      const attachments = attachmentsForApiResponse(result.rows[0].attachments);
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.json({ issueKey: key, attachments, source: 'db' });
    } catch (error) {
      console.error('Ticket attachments (DB) Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch attachments' });
    }
  });

  router.get('/api/jira/issues/:key/attachments-meta', authenticateToken, async (req, res) => {
    const { key } = req.params;
    const jiraBaseUrl = process.env.JIRA_URL;

    try {
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;

      const byName = await getIssueAttachmentIndex(jiraBaseUrl, key, token, httpsAgent, db);
      const attachments = [...byName.values()].map(a => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        hasThumbnail: !!a.thumbnail,
      }));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ issueKey: key, attachments, source: 'jira' });
    } catch (error) {
      console.error('Jira attachments-meta Error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to fetch attachment metadata' });
    }
  });

  router.get('/api/jira/issues/:key/attachments/:filename', authenticateToken, async (req, res) => {
    const { key, filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);
    const variant = req.query.variant === 'thumb' ? 'thumb' : 'full';
    const jiraBaseUrl = process.env.JIRA_URL;
    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;

    try {
      const file = await resolveAttachmentFile(
        jiraBaseUrl,
        key,
        decodedFilename,
        token,
        httpsAgent,
        { variant, db }
      );

      if (!file) {
        return res.status(404).json({ error: 'Attachment not found' });
      }

      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(file.buffer);
    } catch (error) {
      console.error('Jira attachment proxy Error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to fetch attachment' });
    }
  });

  router.get(
    '/api/admin/jira/workflow-cache',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
      try {
        const projects = await listWorkflowCacheMeta(db);
        res.json({ projects });
      } catch (error) {
        console.error('Workflow cache meta Error:', error.message);
        res.status(500).json({ error: 'Failed to load workflow cache meta' });
      }
    }
  );

  router.post(
    '/api/admin/jira/sync-workflows',
    authenticateToken,
    requireAdmin,
    async (req, res) => {
      const projectKey = req.body?.projectKey || null;
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;

      try {
        const result = await syncAllWorkflowCaches(
          db,
          token,
          httpsAgent,
          process.env.JIRA_URL,
          projectKey || null
        );
        res.json(result);
      } catch (error) {
        const msg = error.response?.data?.errorMessages?.[0] || error.message;
        console.error('Admin workflow sync Error:', error.response?.data || error.message);
        res.status(500).json({ error: msg || 'Failed to sync Jira workflows' });
      }
    }
  );

  router.get(
    '/api/tickets/:key/transitions',
    authenticateToken,
    requirePermission([
      'update_ticket',
      'tester-tasks',
      'overdue-tasks',
      'dashboard',
      'planning',
      'epics',
      'missing-estimates',
    ]),
    async (req, res) => {
      const { key } = req.params;
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;

      try {
        // Luôn gọi thẳng Jira để lấy transitions chính xác theo trạng thái hiện tại
        const raw = await fetchTransitionsFromJira(process.env.JIRA_URL, key, token, httpsAgent);
        const transitions = normalizeTransitions(raw);
        res.json(transitions);
      } catch (error) {
        console.error('Jira Transitions Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch transitions' });
      }
    }
  );

  router.post(
    '/api/tickets/:key/comments',
    authenticateToken,
    requirePermission([
      'update_ticket',
      'tester-tasks',
      'overdue-tasks',
      'dashboard',
      'planning',
      'epics',
      'missing-estimates',
    ]),
    async (req, res) => {
      const { key } = req.params;
      const { text, images } = req.body;
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;
      const jiraBaseUrl = process.env.JIRA_URL;

      try {
        await buildAndPostComment(jiraBaseUrl, key, { text, images }, token, httpsAgent);
        invalidateIssueAttachmentCache(key);
        const refreshed = await refreshIssueCommentsAndStatus(
          db,
          jiraBaseUrl,
          key,
          token,
          httpsAgent
        );
        res.json({
          success: true,
          status: refreshed.status,
          statusCategory: refreshed.statusCategory,
          comments: normalizeCommentsForResponse(refreshed.comments),
        });
      } catch (error) {
        const msg = error.response?.data?.errorMessages?.[0] || error.message;
        console.error('Jira Comment Post Error:', error.response?.data || error.message);
        res.status(500).json({ error: msg || 'Failed to post comment' });
      }
    }
  );

  router.post(
    '/api/tickets/:key/transitions',
    authenticateToken,
    requirePermission([
      'update_ticket',
      'tester-tasks',
      'overdue-tasks',
      'dashboard',
      'planning',
      'epics',
      'missing-estimates',
    ]),
    async (req, res) => {
      const { key } = req.params;
      const { transitionId, comment, text, images, fields: bodyFields, output } = req.body;
      const url = `${process.env.JIRA_URL}/rest/api/2/issue/${key}/transitions`;
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;
      const jiraBaseUrl = process.env.JIRA_URL;

      if (!transitionId) {
        return res.status(400).json({ error: 'Thiếu transitionId.' });
      }

      try {
        // Luôn fetch transitions từ Jira live để validate transitionId chính xác
        const rawTransitions = await fetchTransitionsFromJira(jiraBaseUrl, key, token, httpsAgent);
        const liveTransitions = normalizeTransitions(rawTransitions);
        const transition = assertTransitionAllowed(liveTransitions, transitionId);

        const transitionInput = {
          comment,
          text,
          images,
          output,
          fields: {
            ...(bodyFields && typeof bodyFields === 'object' ? bodyFields : {}),
          },
        };
        if (output !== undefined && transitionInput.fields[OUTPUT_FIELD_KEY] === undefined) {
          transitionInput.fields[OUTPUT_FIELD_KEY] = output;
        }

        const missing = validateTransitionInput(transition, transitionInput);
        if (missing.length > 0) {
          return res.status(400).json({
            error: `Transition "${transition.name}" yêu cầu: ${missing.map(f => f.name).join(', ')}.`,
            requiredFields: missing,
            transition,
          });
        }

        const jiraFields = buildTransitionFieldsPayload(transition, transitionInput);
        const body = {
          transition: { id: String(transitionId) },
        };
        if (Object.keys(jiraFields).length > 0) {
          body.fields = jiraFields;
        }

        const commentBodyPreview = String(comment || text || '').trim();
        let commentBody = commentBodyPreview;
        if (Array.isArray(images) && images.length > 0) {
          const attachmentNames = await uploadIssueAttachments(
            jiraBaseUrl,
            key,
            images,
            token,
            httpsAgent
          );
          invalidateIssueAttachmentCache(key);
          if (!descriptionHasWikiImages(commentBody)) {
            commentBody = buildWikiCommentBody(commentBody, attachmentNames);
          }
        }

        if (commentBody) {
          body.update = {
            comment: [
              {
                add: {
                  body: commentBody,
                },
              },
            ],
          };
        }

        await axios.post(url, body, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          httpsAgent,
        });

        const issueRes = await db.query('SELECT project_key FROM jira_issues WHERE key = $1', [
          key,
        ]);
        const projectKey = issueRes.rows[0]?.project_key || null;

        const refreshed = await refreshIssueCommentsAndStatus(
          db,
          jiraBaseUrl,
          key,
          token,
          httpsAgent
        );

        if (projectKey) {
          void notificationCron.pollProjectNow(projectKey, jiraBaseUrl);
        }

        res.json({
          success: true,
          status: refreshed.status,
          statusCategory: refreshed.statusCategory,
          comments: [],
        });
      } catch (error) {
        const msg = formatJiraApiError(error);
        const status = error.response?.status;
        console.error('Jira Transition Post Error:', error.response?.data || error.message);
        res.status(status && status >= 400 && status < 500 ? status : 500).json({
          error: msg || 'Failed to update status',
          details: error.response?.data || null,
        });
      }
    }
  );

  router.put(
    '/api/tickets/:key',
    authenticateToken,
    requirePermission([
      'update_ticket',
      'tester-tasks',
      'overdue-tasks',
      'dashboard',
      'planning',
      'epics',
      'missing-estimates',
    ]),
    async (req, res) => {
      const { key } = req.params;
      const { summary, description, output, dueDate, startDate, images, assigneeId } = req.body;
      const url = `${process.env.JIRA_URL}/rest/api/2/issue/${key}`;
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;
      const jiraBaseUrl = process.env.JIRA_URL;

      try {
        const fields = {};
        let savedDescription;
        let responseAssignee;
        if (summary !== undefined) fields.summary = String(summary ?? '');
        if (description !== undefined) {
          let descriptionBody = String(description ?? '');
          if (Array.isArray(images) && images.length > 0) {
            const attachmentNames = await uploadIssueAttachments(
              jiraBaseUrl,
              key,
              images,
              token,
              httpsAgent
            );
            invalidateIssueAttachmentCache(key);
            if (!descriptionHasWikiImages(descriptionBody)) {
              descriptionBody = buildWikiCommentBody(descriptionBody, attachmentNames);
            }
          }
          savedDescription = descriptionBody;
          fields.description = descriptionBody;
        }
        if (output !== undefined) fields.customfield_10304 = output;
        if (dueDate !== undefined) {
          fields.customfield_10302 = formatJiraDate(dueDate);
        }
        if (startDate !== undefined) {
          fields.customfield_10300 = formatJiraDate(startDate);
        }
        if (assigneeId !== undefined) {
          if (assigneeId && String(assigneeId).trim()) {
            fields.assignee = await resolveJiraAssignee(assigneeId);
          } else {
            fields.assignee = null;
          }
        }

        if (Object.keys(fields).length === 0) {
          return res.status(400).json({ error: 'Không có trường nào để cập nhật.' });
        }

        await axios.put(
          url,
          { fields },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            httpsAgent,
          }
        );

        await patchIssueContentInDb(key, {
          summary: fields.summary,
          description: savedDescription,
          output: fields.customfield_10304,
        });
        if (dueDate !== undefined || startDate !== undefined) {
          await patchIssuePlanDatesInDb([key], dueDate, startDate);
        }
        if (Array.isArray(images) && images.length > 0) {
          await refreshIssueCommentsAndStatus(db, jiraBaseUrl, key, token, httpsAgent);
        }
        if (assigneeId !== undefined) {
          const projectKey = key.includes('-') ? key.split('-')[0] : req.user.jira_project || '';
          const lookup = await loadAssigneeLookup(projectKey);
          if (!assigneeId || !String(assigneeId).trim()) {
            responseAssignee = null;
          } else {
            const email =
              normalizeEmail(assigneeId) || lookup.emailByJiraId.get(String(assigneeId)) || null;
            responseAssignee = normalizeAssignee(
              {
                accountId: assigneeId,
                emailAddress: email,
                displayName: email ? lookup.displayNameByEmail.get(email) || null : null,
                avatarUrl: email ? lookup.avatarByEmail?.get(email) || null : null,
              },
              lookup
            );
          }
          await patchIssueAssigneeInDb(key, responseAssignee);
          void (async () => {
            try {
              const mapAssignee = a => normalizeAssignee(a, lookup);
              const raw = await fetchIssueFromJira(jiraBaseUrl, key, token, httpsAgent);
              await enrichRawIssueFromJira(raw, token, jiraBaseUrl);
              const mapped = mapJiraIssue(raw, mapAssignee);
              await upsertJiraIssue(mapped, projectKey, lookup);
            } catch (syncErr) {
              console.error(`assignee db sync ${key}:`, syncErr.message);
            }
          })();
        }
        res.json({
          success: true,
          summary: fields.summary,
          description: savedDescription,
          output: fields.customfield_10304,
          assignee: responseAssignee,
        });
      } catch (error) {
        console.error('Jira Ticket Update Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to update ticket', details: error.response?.data });
      }
    }
  );

  router.post('/api/tickets/batch-reschedule', authenticateToken, async (req, res) => {
    const { keys, dueDate, startDate } = req.body;
    if (!Array.isArray(keys) || keys.length === 0 || !dueDate) {
      return res
        .status(400)
        .json({ error: 'Thiếu danh sách keys hoặc ngày hạn chót mới (dueDate)' });
    }

    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;
    const results = [];
    const errors = [];

    for (const key of keys) {
      const url = `${process.env.JIRA_URL}/rest/api/2/issue/${key}`;
      try {
        const fields = {
          customfield_10302: formatJiraDate(dueDate),
        };
        if (startDate) {
          fields.customfield_10300 = formatJiraDate(startDate);
        }
        await axios.put(
          url,
          { fields },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            httpsAgent,
          }
        );
        results.push(key);
      } catch (err) {
        console.error(`Failed to reschedule ticket ${key}:`, err.response?.data || err.message);
        errors.push({ key, error: err.response?.data || err.message });
      }
    }

    if (results.length > 0) {
      await patchIssuePlanDatesInDb(results, dueDate, startDate);
    }
    res.json({ success: true, rescheduled: results, errors });
  });

  const buildDashboardTicketFromIssue = (
    issue,
    user,
    assigneeLookup,
    weekRange,
    targetYear,
    targetMonth
  ) => {
    let timeLogged = 0;
    let timeLoggedThisWeek = 0;
    const userEmail = normalizeEmail(user.emailAddress) || normalizeEmail(user.accountId);
    const scopeToMonth = targetYear != null && targetMonth != null;
    const aggregates = issue.worklogAgg || [];

    if (aggregates.length > 0) {
      for (const agg of aggregates) {
        const authorEmail =
          normalizeEmail(agg.author_email) ||
          (agg.author_account_id && assigneeLookup.emailByJiraId.get(agg.author_account_id)) ||
          normalizeEmail(agg.author_account_id);
        if (!userEmail || !authorEmail || authorEmail !== userEmail) continue;
        if (scopeToMonth) {
          timeLogged += Number(agg.month_seconds) || 0;
        } else {
          timeLogged += Number(agg.total_seconds) || 0;
        }
        timeLoggedThisWeek += Number(agg.week_seconds) || 0;
      }
    } else {
      const wls = issue.worklog?.worklogs || [];
      for (const wl of wls) {
        const author = wl.author;
        const authorEmail =
          normalizeEmail(author?.emailAddress) ||
          (author?.accountId && assigneeLookup.emailByJiraId.get(author.accountId)) ||
          (author?.key && assigneeLookup.emailByJiraId.get(author.key)) ||
          normalizeEmail(author?.accountId) ||
          normalizeEmail(author?.key);
        if (!userEmail || !authorEmail || authorEmail !== userEmail) continue;
        const seconds = wl.timeSpentSeconds || 0;
        if (scopeToMonth) {
          const ym = yearMonthInWorkTz(wl.started);
          if (ym && ym.year === targetYear && ym.month === targetMonth) {
            timeLogged += seconds;
          }
        } else {
          timeLogged += seconds;
        }
        if (planDateInWeek(wl.started, weekRange)) {
          timeLoggedThisWeek += seconds;
        }
      }
    }

    return {
      id: issue.id,
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      statusCategory: issue.statusCategory,
      issueType: issue.issueType,
      updated: issue.updated,
      created: issue.created || null,
      timeEstimate: issue.originalEstimate || 0,
      timeSpent: timeLogged,
      timeSpentWeek: timeLoggedThisWeek,
      originalEstimate: issue.originalEstimate || 0,
      remainingEstimate: issue.remainingEstimate || 0,
      startDate: issue.startDate,
      dueDate: issue.dueDate,
      creator: issue.creator,
      assignee: issue.assignee ?? null,
      isSubtask: !!issue.isSubtask,
      parentKey: issue.parentKey || null,
      description: issue.description || '',
    };
  };

  const groupSubtasksIntoDashboardUsers = (
    subtasks,
    activeUsers,
    assigneeLookup,
    weekRange,
    { targetYear, targetMonth, scopeToMonth }
  ) => {
    const uniqueIssues = [
      ...new Map(
        (subtasks || [])
          .filter(issue => {
            if (!issue?.key || isCancelledIssueStatus(issue.status)) return false;
            return scopeToMonth
              ? issueMatchesMonthPlanDatesOnly(issue, targetYear, targetMonth)
              : true;
          })
          .map(issue => [issue.key, issue])
      ).values(),
    ];

    const issuesByEmail = new Map();
    const issuesByDisplayName = new Map();
    for (const issue of uniqueIssues) {
      const email =
        normalizeEmail(issue.assignee?.emailAddress) || normalizeEmail(issue.assignee?.accountId);
      if (email) {
        if (!issuesByEmail.has(email)) issuesByEmail.set(email, []);
        issuesByEmail.get(email).push(issue);
      }
      const name = (issue.assignee?.displayName || '').trim().toLowerCase();
      if (name) {
        if (!issuesByDisplayName.has(name)) issuesByDisplayName.set(name, []);
        issuesByDisplayName.get(name).push(issue);
      }
    }

    const issuesForUser = user => {
      const userEmail = normalizeEmail(user.emailAddress) || normalizeEmail(user.accountId);
      if (userEmail && issuesByEmail.has(userEmail)) return issuesByEmail.get(userEmail);
      const userName = (user.displayName || '').trim().toLowerCase();
      if (userName && issuesByDisplayName.has(userName)) return issuesByDisplayName.get(userName);
      return [];
    };

    return activeUsers.map(user => {
      const userTickets = issuesForUser(user).map(issue =>
        buildDashboardTicketFromIssue(
          issue,
          user,
          assigneeLookup,
          weekRange,
          scopeToMonth ? targetYear : null,
          scopeToMonth ? targetMonth : null
        )
      );

      userTickets.sort((a, b) => {
        const dateA = a.startDate ? new Date(a.startDate).getTime() : Infinity;
        const dateB = b.startDate ? new Date(b.startDate).getTime() : Infinity;
        if (dateA !== dateB) {
          return dateA - dateB;
        }
        return new Date(b.updated).getTime() - new Date(a.updated).getTime();
      });

      return {
        user,
        tickets: userTickets,
      };
    });
  };

  const fetchActiveDashboardUsers = async projectKey => {
    const activeUsersRes = await db.query(
      `SELECT account_id AS "accountId", display_name AS "displayName", email_address AS "emailAddress", avatar_url AS "avatarUrl", sort_order AS "sortOrder"
         FROM jira_users
         WHERE is_active = true
           AND string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]
         ORDER BY sort_order DESC, display_name ASC`,
      [projectKey]
    );
    return activeUsersRes.rows.map(u => ({
      ...u,
      emailAddress: normalizeEmail(u.emailAddress),
    }));
  };

  // ==========================================
  // Dashboard Endpoints
  // ==========================================
  router.get('/api/dashboard/search', optionalAuth, async (req, res) => {
    try {
      const rawQ = String(req.query.q || '').trim();
      if (!rawQ) {
        return res.json({ users: [] });
      }

      const projectKey =
        req.query.projectKey ||
        (req.user && req.user.jira_project) ||
        process.env.JIRA_PROJECT_KEY ||
        'BXDCSDL';

      const activeUsers = await fetchActiveDashboardUsers(projectKey);
      if (activeUsers.length === 0) {
        return res.json({ users: [] });
      }

      const assigneeLookup = await loadAssigneeLookup(projectKey);
      const weekRange = getCurrentWeekYmdRangeBangkok();
      const pattern = `%${rawQ}%`;

      const dbRes = await db.query(
        `
        SELECT ${ISSUE_ROW_SELECT}
        FROM jira_issues i
        ${JIRA_USER_ASSIGNEE_JOIN}
        WHERE i.project_key = $1
          ${EXCLUDE_CANCELLED_SQL}
          AND (
            i.key ILIKE $2
            OR i.summary ILIKE $2
            OR i.status ILIKE $2
            OR COALESCE(i.creator, '') ILIKE $2
            OR COALESCE(i.issue_type, '') ILIKE $2
            OR COALESCE(i.assignee_name, '') ILIKE $2
            OR COALESCE(u.display_name, '') ILIKE $2
            OR LOWER(TRIM(COALESCE(i.assignee_account_id, ''))) ILIKE LOWER($2)
          )
        ORDER BY i.updated_at DESC
        LIMIT 500
        `,
        [projectKey, pattern]
      );
      await attachWorklogAggregatesToRows(db, dbRes.rows, { weekRange });

      const matchedIssues = dbRes.rows.map(mapDbRowToIssueFormat).filter(Boolean);
      const dashboardData = groupSubtasksIntoDashboardUsers(
        matchedIssues,
        activeUsers,
        assigneeLookup,
        weekRange,
        { scopeToMonth: false }
      ).filter(group => group.tickets.length > 0);

      console.log(
        `[DB Search] ${projectKey} q="${rawQ}": ${matchedIssues.length} issues → ${dashboardData.reduce((n, g) => n + g.tickets.length, 0)} tickets`
      );

      return res.json({ users: dashboardData });
    } catch (error) {
      console.error('Dashboard search error:', error.message);
      res.status(500).json({
        error: 'Failed to search dashboard tickets',
        details: error.message,
      });
    }
  });

  router.get('/api/dashboard/monthly', optionalAuth, async (req, res) => {
    try {
      const { month, year, projectKey: queryProjectKey } = req.query;
      const now = new Date();
      const targetMonth = month ? parseInt(month, 10) : now.getMonth() + 1; // 1-12
      const targetYear = year ? parseInt(year, 10) : now.getFullYear();

      const projectKey =
        queryProjectKey ||
        (req.user && req.user.jira_project) ||
        process.env.JIRA_PROJECT_KEY ||
        'BXDCSDL';

      const normalizedMonth = String(targetMonth).padStart(2, '0');
      const normalizedYear = String(targetYear);

      const {
        users: dashboardData,
        weekStats,
        timing,
      } = await fetchMonthlyDashboard(db, projectKey, targetYear, targetMonth);

      console.log(
        `[DB Serve] /api/dashboard/monthly ${projectKey} ${normalizedMonth}/${normalizedYear} — ${timing.rowCount ?? 0} subtasks, users ${timing.usersMs}ms + issues ${timing.issuesMs ?? timing.subtasksMs}ms + worklog ${timing.worklogMs ?? 0}ms = total ${timing.totalMs}ms`
      );

      return res.json({ users: dashboardData, weekStats });
    } catch (error) {
      console.error(
        'Jira API Dashboard Error:',
        error.response ? error.response.data : error.message
      );
      res.status(500).json({
        error: 'Failed to fetch dashboard data',
        details: error.response ? error.response.data : error.message,
      });
    }
  });

  router.get('/api/tickets/overdue', authenticateToken, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const projectKey =
        req.query.projectKey || req.user.jira_project || process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
      const showAll = req.query.all === 'true';
      const data = await fetchOverdueFromDb(projectKey, showAll, req.user);
      res.json(data);
    } catch (error) {
      console.error('Failed to fetch overdue tickets:', error.message);
      res.status(500).json({
        error: 'Failed to fetch overdue tickets',
        details: error.message,
      });
    }
  });

  return router;
};
