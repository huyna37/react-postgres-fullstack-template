const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db');
const {
  monthPlanDateFilterClause,
  monthPlanDateFilterParams,
  formatPlanDateFromDb,
} = require('../lib/jiraMonthFilter');
const {
  normalizeEmail,
  JIRA_USER_ASSIGNEE_JOIN,
  RESOLVED_ASSIGNEE_EMAIL_SQL,
} = require('../lib/assigneeIdentity');
const { formatHoursToJiraEstimate } = require('../lib/worklogFromDb');

module.exports = context => {
  const { authenticateToken, optionalAuth, requirePermission } = context;

  const assigneeInActiveSet = (row, activeRows) => {
    if (!row.assignee_account_id && !row.resolved_assignee_email) return false;
    const aEmail = normalizeEmail(row.resolved_assignee_email || row.assignee_account_id);
    const aName = (row.assignee_name || '').trim().toLowerCase();
    for (const u of activeRows) {
      const uEmail = normalizeEmail(u.email_address);
      if (aEmail && uEmail && aEmail === uEmail) return true;
      if (row.assignee_account_id && u.account_id === row.assignee_account_id) return true;
      const uName = (u.display_name || '').trim().toLowerCase();
      if (aName && uName && aName === uName) return true;
    }
    return false;
  };

  const mapMissingEstimateRow = row => ({
    key: row.key,
    summary: row.summary || '',
    description: row.description || '',
    parent_key: row.parent_key || null,
    issue_type: row.issue_type || '',
    status: row.status || '',
    status_category: row.status_category || '',
    assignee_name: row.assignee_name || null,
    assignee_account_id: row.resolved_assignee_email || row.assignee_account_id || null,
    assignee_avatar_url: row.assignee_avatar_url || null,
    creator: row.creator || null,
    start_date: formatPlanDateFromDb(row.start_date),
    due_date: formatPlanDateFromDb(row.due_date),
    original_estimate: row.original_estimate ?? null,
  });

  const fetchMissingEstimatesFromDb = async (projectKey, { month, year } = {}) => {
    const activeUsersRes = await db.query(
      `SELECT account_id, email_address, display_name
       FROM jira_users
       WHERE is_active = true
         AND string_to_array(TRIM(COALESCE(jira_project, '')), ',') @> ARRAY[$1::text]`,
      [projectKey]
    );
    const activeRows = activeUsersRes.rows;

    const queryArgs = [projectKey];
    let monthFilter = '';
    if (month && year) {
      queryArgs.push(...monthPlanDateFilterParams(parseInt(year, 10), parseInt(month, 10)));
      monthFilter = ` AND ${monthPlanDateFilterClause('i', 2)}`;
    }

    const sql = `
      SELECT i.key, i.summary, i.description, i.parent_key, i.creator,
             i.issue_type, i.status, i.status_category,
             i.assignee_name, i.assignee_account_id,
             i.start_date, i.due_date, i.original_estimate,
             ${RESOLVED_ASSIGNEE_EMAIL_SQL},
             u.avatar_url AS assignee_avatar_url
      FROM jira_issues i
      ${JIRA_USER_ASSIGNEE_JOIN}
      WHERE i.project_key = $1
        AND (i.original_estimate IS NULL OR i.original_estimate = 0)
        AND i.assignee_account_id IS NOT NULL
        AND TRIM(i.assignee_account_id) <> ''
        AND LOWER(COALESCE(i.issue_type, '')) NOT SIMILAR TO '%(epic|initiative|feature|theme|capability)%'
        AND LOWER(COALESCE(i.issue_type, '')) NOT LIKE '%story%'
        AND LOWER(COALESCE(i.issue_type, '')) NOT LIKE '%yêu cầu%'
        ${monthFilter}
      ORDER BY i.due_date ASC NULLS LAST, i.key ASC
    `;

    const dbRes = await db.query(sql, queryArgs);
    return dbRes.rows
      .filter(row => {
        if (activeRows.length === 0) return true;
        return assigneeInActiveSet(row, activeRows);
      })
      .map(mapMissingEstimateRow);
  };

  router.get('/api/tickets/missing-estimates', optionalAuth, async (req, res) => {
    try {
      const { month, year, projectKey: queryProjectKey } = req.query;
      const projectKey =
        queryProjectKey ||
        (req.user && req.user.jira_project) ||
        process.env.JIRA_PROJECT_KEY ||
        'BXDCSDL';

      const data = await fetchMissingEstimatesFromDb(projectKey, { month, year });
      res.json(data);
    } catch (error) {
      console.error('[missing-estimates] Error:', error.message);
      res.status(500).json({ error: 'Failed to fetch missing estimates' });
    }
  });

  router.post(
    '/api/tickets/batch-estimate',
    authenticateToken,
    requirePermission(['update_ticket', 'missing-estimates']),
    async (req, res) => {
      try {
        const { updates } = req.body;
        if (!updates || !Array.isArray(updates)) {
          return res.status(400).json({ error: 'updates array is required' });
        }

        const accountRes = await db.query('SELECT jira_token FROM jira_users WHERE id = $1', [
          req.user.id,
        ]);
        if (accountRes.rows.length === 0 || !accountRes.rows[0].jira_token) {
          return res.status(400).json({ error: 'Vui long config Jira token' });
        }
        const token = accountRes.rows[0].jira_token;

        const urlPrefix = `${process.env.JIRA_URL}/rest/api/2/issue`;
        const httpsAgent = new (require('https').Agent)({ rejectUnauthorized: false });

        const results = [];
        for (const update of updates) {
          const { key, estimateHours } = update;
          if (!key || estimateHours === undefined) continue;

          try {
            const issueRes = await db.query(
              'SELECT time_spent FROM jira_issues WHERE key = $1 LIMIT 1',
              [key]
            );
            const timeSpentSeconds = Number(issueRes.rows[0]?.time_spent) || 0;

            const originalEstimateSeconds = Math.round(parseFloat(estimateHours) * 3600);
            const originalEstimateStr = formatHoursToJiraEstimate(estimateHours);

            const remainingEstimateSeconds = Math.max(0, originalEstimateSeconds - timeSpentSeconds);
            const remainingEstimateStr = formatHoursToJiraEstimate(remainingEstimateSeconds / 3600);

            await axios.put(
              `${urlPrefix}/${key}`,
              {
                update: {
                  timetracking: [
                    {
                      edit: {
                        originalEstimate: originalEstimateStr,
                        remainingEstimate: remainingEstimateStr,
                      },
                    },
                  ],
                },
              },
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                httpsAgent,
              }
            );

            await db.query(
              `UPDATE jira_issues
               SET original_estimate = $1, remaining_estimate = $2, updated_at = NOW()
               WHERE key = $3`,
              [originalEstimateSeconds, remainingEstimateSeconds, key]
            );

            results.push({ key, success: true });
          } catch (err) {
            console.error(`[batch-estimate] Failed for ${key}:`, err.response?.data || err.message);
            results.push({
              key,
              success: false,
              error: err.response?.data?.errorMessages?.[0] || err.message,
            });
          }
        }

        res.json({ message: 'Batch update completed', results });
      } catch (error) {
        console.error('[batch-estimate] Error:', error.message);
        res.status(500).json({ error: 'Failed to perform batch estimate update' });
      }
    }
  );

  return router;
};
