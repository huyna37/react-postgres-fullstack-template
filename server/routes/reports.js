module.exports = (context) => {
  const { db, authenticateToken } = context;
  const express = require('express');
  const router = express.Router();

  const doneCondition = `
    (
      LOWER(i.status_category) = 'done'
      OR LOWER(i.status) ILIKE '%resolved%'
      OR LOWER(i.status) ILIKE '%closed%'
      OR LOWER(i.status) = 'close'
      OR LOWER(i.status) ILIKE '%đóng%'
      OR LOWER(i.status) ILIKE '%dong%'
      OR LOWER(i.status) ILIKE '%done%'
      OR LOWER(i.status) ILIKE '%hoàn thành%'
      OR LOWER(i.status) ILIKE '%hoan thanh%'
      OR LOWER(i.status) ILIKE '%complete%'
    )
    AND LOWER(i.status) NOT ILIKE '%reopen%'
    AND LOWER(i.status) NOT ILIKE '%re-open%'
    AND LOWER(i.status) NOT ILIKE '%mở lại%'
    AND LOWER(i.status) NOT ILIKE '%cancel%'
    AND LOWER(i.status) NOT ILIKE '%hủy%'
    AND LOWER(i.status) NOT ILIKE '%huy%'
  `;

  const assigneeLabel = `COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(i.assignee_name), ''), u.username, u.email_address, i.assignee_account_id, 'Không xác định')`;

  const creatorLabel = `COALESCE(NULLIF(TRIM(cu.display_name), ''), NULLIF(TRIM(i.creator), ''), cu.username, cu.email_address, 'Không xác định')`;

  const userJoin = `
    INNER JOIN jira_users u
      ON (
        u.account_id = i.assignee_account_id
        OR (i.assignee_account_id LIKE '%@%' AND LOWER(u.email_address) = LOWER(i.assignee_account_id))
      )
  `;

  const creatorJoin = `
    INNER JOIN jira_users cu
      ON cu.role = 'tester'
      AND cu.is_active = true
      AND string_to_array(TRIM(COALESCE(cu.jira_project, '')), ',') && $1::text[]
      AND (
        (
          TRIM(COALESCE(i.creator_email, '')) <> ''
          AND LOWER(TRIM(cu.email_address)) = LOWER(TRIM(i.creator_email))
        )
        OR (
          TRIM(COALESCE(i.creator, '')) <> ''
          AND LOWER(TRIM(cu.display_name)) = LOWER(TRIM(i.creator))
        )
      )
  `;

  const monthFilter = `
    i.project_key = ANY($1)
    AND EXTRACT(MONTH FROM COALESCE(i.resolved_at, i.updated_at)) = $2
    AND EXTRACT(YEAR FROM COALESCE(i.resolved_at, i.updated_at)) = $3
    AND u.is_active = true
    AND string_to_array(TRIM(COALESCE(u.jira_project, '')), ',') && $1::text[]
  `;

  const creatorMonthFilter = `
    i.project_key = ANY($1)
    AND i.created_at IS NOT NULL
    AND EXTRACT(MONTH FROM i.created_at) = $2
    AND EXTRACT(YEAR FROM i.created_at) = $3
  `;

  const isBugIssue = `(i.issue_type ILIKE '%bug%' OR i.issue_type ILIKE '%lỗi%')`;

  const bugNotCancelled = `
    ${isBugIssue}
    AND LOWER(i.status) NOT ILIKE '%cancel%'
    AND LOWER(i.status) NOT ILIKE '%hủy%'
    AND LOWER(i.status) NOT ILIKE '%huy%'
  `;

  const isSubtaskNotBug = `
    i.is_subtask = true
    AND i.issue_type NOT ILIKE '%bug%'
    AND i.issue_type NOT ILIKE '%lỗi%'
    AND LOWER(i.status) NOT ILIKE '%cancel%'
    AND LOWER(i.status) NOT ILIKE '%hủy%'
    AND LOWER(i.status) NOT ILIKE '%huy%'
  `;

  const devSubtaskDone = `
    ${isSubtaskNotBug}
    AND ${doneCondition}
    AND (
      i.summary ILIKE '[DEV]%'
      OR (
        i.summary NOT ILIKE '[TEST]%'
        AND COALESCE(u.role, i.assignee_role, '') != 'tester'
      )
    )
  `;

  const testSubtaskDone = `
    ${isSubtaskNotBug}
    AND ${doneCondition}
    AND (
      i.summary ILIKE '[TEST]%'
      OR (
        i.summary NOT ILIKE '[DEV]%'
        AND COALESCE(u.role, i.assignee_role, '') = 'tester'
      )
    )
  `;

  const bugAssigned = `
    ${bugNotCancelled}
  `;

  const bugFixed = `${isBugIssue} AND ${doneCondition}`;

  const statKey = (date, assignee) => `${date}\0${assignee}`;

  const mergeMemberStats = (assigneeRows, creatorBugRows) => {
    const map = new Map();

    for (const row of assigneeRows) {
      map.set(row.assignee, {
        assignee: row.assignee,
        total_tasks: Number(row.total_tasks || 0),
        dev_tasks_done: Number(row.dev_tasks_done || 0),
        test_tasks_done: Number(row.test_tasks_done || 0),
        assigned_bugs: Number(row.assigned_bugs || 0),
        fixed_bugs: Number(row.fixed_bugs || 0),
        bugs_created: 0,
      });
    }

    for (const row of creatorBugRows) {
      const existing = map.get(row.assignee) || {
        assignee: row.assignee,
        total_tasks: 0,
        dev_tasks_done: 0,
        test_tasks_done: 0,
        assigned_bugs: 0,
        fixed_bugs: 0,
        bugs_created: 0,
      };
      existing.bugs_created = Number(row.bugs_created || 0);
      map.set(row.assignee, existing);
    }

    return [...map.values()];
  };

  const mergeMemberDailyStats = (assigneeRows, creatorBugRows) => {
    const map = new Map();

    for (const row of assigneeRows) {
      const key = statKey(row.date, row.assignee);
      map.set(key, {
        date: row.date,
        assignee: row.assignee,
        dev_tasks_done: Number(row.dev_tasks_done || 0),
        test_tasks_done: Number(row.test_tasks_done || 0),
        assigned_bugs: Number(row.assigned_bugs || 0),
        fixed_bugs: Number(row.fixed_bugs || 0),
        bugs_created: 0,
      });
    }

    for (const row of creatorBugRows) {
      const key = statKey(row.date, row.assignee);
      const existing = map.get(key) || {
        date: row.date,
        assignee: row.assignee,
        dev_tasks_done: 0,
        test_tasks_done: 0,
        assigned_bugs: 0,
        fixed_bugs: 0,
        bugs_created: 0,
      };
      existing.bugs_created = Number(row.bugs_created || 0);
      map.set(key, existing);
    }

    return [...map.values()]
      .filter(
        row =>
          row.dev_tasks_done > 0 ||
          row.test_tasks_done > 0 ||
          row.assigned_bugs > 0 ||
          row.fixed_bugs > 0 ||
          row.bugs_created > 0
      )
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.assignee.localeCompare(b.assignee, 'vi')
      );
  };

  // GET /api/reports?projectKey=BXDCSDL&month=6&year=2026
  router.get('/api/reports', authenticateToken, async (req, res) => {
    try {
      const projectKeyRaw = req.query.projectKey;
      const monthRaw = req.query.month;
      const yearRaw = req.query.year;

      if (!projectKeyRaw) {
        return res.status(400).json({ error: 'Vui lòng cung cấp projectKey' });
      }

      const projectKeys = projectKeyRaw.split(',').map(s => s.trim()).filter(Boolean);

      let month = parseInt(monthRaw, 10);
      let year = parseInt(yearRaw, 10);
      if (isNaN(month) || isNaN(year)) {
        const now = new Date();
        month = now.getMonth() + 1;
        year = now.getFullYear();
      }

      const queryParams = [projectKeys, month, year];

      // 1. Thống kê theo người được gán (assignee)
      const memberStatsQuery = `
        SELECT
          ${assigneeLabel} as assignee,
          COUNT(CASE WHEN ${isSubtaskNotBug} THEN 1 END)::int as total_tasks,
          COALESCE(SUM(CASE WHEN ${devSubtaskDone} THEN 1 ELSE 0 END), 0)::int as dev_tasks_done,
          COALESCE(SUM(CASE WHEN ${testSubtaskDone} THEN 1 ELSE 0 END), 0)::int as test_tasks_done,
          COALESCE(SUM(CASE WHEN ${bugAssigned} THEN 1 ELSE 0 END), 0)::int as assigned_bugs,
          COALESCE(SUM(CASE WHEN ${bugFixed} THEN 1 ELSE 0 END), 0)::int as fixed_bugs
        FROM jira_issues i
        ${userJoin}
        WHERE ${monthFilter}
        GROUP BY ${assigneeLabel}
        ORDER BY dev_tasks_done DESC, total_tasks DESC, assignee ASC
      `;
      const memberStats = await db.query(memberStatsQuery, queryParams);

      // Bug do tester tạo (theo người report / creator)
      const memberBugsCreatedQuery = `
        SELECT
          ${creatorLabel} as assignee,
          COUNT(*)::int as bugs_created
        FROM jira_issues i
        ${creatorJoin}
        WHERE ${creatorMonthFilter}
          AND ${bugNotCancelled}
        GROUP BY ${creatorLabel}
        ORDER BY bugs_created DESC, assignee ASC
      `;
      const memberBugsCreated = await db.query(memberBugsCreatedQuery, queryParams);

      // 2. Thống kê theo ngày (Daily stats)
      const dailyStatsQuery = `
        SELECT
          TO_CHAR(COALESCE(i.resolved_at, i.updated_at), 'YYYY-MM-DD') as date,
          COALESCE(SUM(CASE WHEN ${devSubtaskDone} THEN 1 ELSE 0 END), 0)::int as dev_tasks_done,
          COALESCE(SUM(CASE WHEN ${testSubtaskDone} THEN 1 ELSE 0 END), 0)::int as test_tasks_done,
          COALESCE(SUM(CASE WHEN ${bugFixed} THEN 1 ELSE 0 END), 0)::int as fixed_bugs
        FROM jira_issues i
        ${userJoin}
        WHERE ${monthFilter}
          AND (${devSubtaskDone} OR ${testSubtaskDone} OR ${bugFixed})
        GROUP BY TO_CHAR(COALESCE(i.resolved_at, i.updated_at), 'YYYY-MM-DD')
        ORDER BY date ASC
      `;
      const dailyStats = await db.query(dailyStatsQuery, queryParams);

      const memberDailyAssigneeQuery = `
        SELECT
          TO_CHAR(COALESCE(i.resolved_at, i.updated_at), 'YYYY-MM-DD') as date,
          ${assigneeLabel} as assignee,
          COALESCE(SUM(CASE WHEN ${devSubtaskDone} THEN 1 ELSE 0 END), 0)::int as dev_tasks_done,
          COALESCE(SUM(CASE WHEN ${testSubtaskDone} THEN 1 ELSE 0 END), 0)::int as test_tasks_done,
          COALESCE(SUM(CASE WHEN ${bugAssigned} THEN 1 ELSE 0 END), 0)::int as assigned_bugs,
          COALESCE(SUM(CASE WHEN ${bugFixed} THEN 1 ELSE 0 END), 0)::int as fixed_bugs
        FROM jira_issues i
        ${userJoin}
        WHERE ${monthFilter}
        GROUP BY TO_CHAR(COALESCE(i.resolved_at, i.updated_at), 'YYYY-MM-DD'), ${assigneeLabel}
        HAVING
          COALESCE(SUM(CASE WHEN ${devSubtaskDone} THEN 1 ELSE 0 END), 0) > 0
          OR COALESCE(SUM(CASE WHEN ${testSubtaskDone} THEN 1 ELSE 0 END), 0) > 0
          OR COALESCE(SUM(CASE WHEN ${bugAssigned} THEN 1 ELSE 0 END), 0) > 0
          OR COALESCE(SUM(CASE WHEN ${bugFixed} THEN 1 ELSE 0 END), 0) > 0
        ORDER BY date ASC, assignee ASC
      `;
      const memberDailyAssignee = await db.query(memberDailyAssigneeQuery, queryParams);

      const memberDailyBugsCreatedQuery = `
        SELECT
          TO_CHAR(i.created_at, 'YYYY-MM-DD') as date,
          ${creatorLabel} as assignee,
          COUNT(*)::int as bugs_created
        FROM jira_issues i
        ${creatorJoin}
        WHERE ${creatorMonthFilter}
          AND ${bugNotCancelled}
        GROUP BY TO_CHAR(i.created_at, 'YYYY-MM-DD'), ${creatorLabel}
        ORDER BY date ASC, assignee ASC
      `;
      const memberDailyBugsCreated = await db.query(memberDailyBugsCreatedQuery, queryParams);

      const mergedMemberStats = mergeMemberStats(memberStats.rows, memberBugsCreated.rows);
      const memberDailyStats = mergeMemberDailyStats(
        memberDailyAssignee.rows,
        memberDailyBugsCreated.rows
      );

      const activeMemberStats = mergedMemberStats.filter(
        row =>
          row.total_tasks > 0 ||
          row.assigned_bugs > 0 ||
          row.bugs_created > 0 ||
          row.dev_tasks_done > 0 ||
          row.test_tasks_done > 0 ||
          row.fixed_bugs > 0
      );

      res.json({
        success: true,
        data: {
          memberStats: activeMemberStats,
          dailyStats: dailyStats.rows,
          memberDailyStats,
          month,
          year,
        }
      });
    } catch (error) {
      console.error('[API /api/reports] Lỗi:', error);
      res.status(500).json({ error: 'Lỗi máy chủ khi lấy dữ liệu báo cáo' });
    }
  });

  return router;
};
