const db = require('../db');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { fetchTesterParentKeys } = require('../lib/dashboardTesterFromDb');

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

async function run() {
  try {
    const projectKey = 'BXDCSDL';
    const month = 6;
    const year = 2026;

    // Load active users lookup
    const resUsers = await db.query(
      `SELECT account_id, email_address, role, display_name, username, is_active FROM jira_users`
    );
    const emailByJiraId = new Map();
    const roleByEmail = new Map();
    const roleByJiraId = new Map();
    const displayNameByEmail = new Map();
    resUsers.rows.forEach(u => {
      const email = u.email_address ? u.email_address.trim().toLowerCase() : null;
      if (email) {
        if (u.role) roleByEmail.set(email, u.role);
        if (u.display_name) displayNameByEmail.set(email, u.display_name);
        if (u.account_id) emailByJiraId.set(u.account_id, email);
      }
      if (u.account_id && u.role) roleByJiraId.set(u.account_id, u.role);
    });

    const assigneeLookup = {
      emailByJiraId,
      roleByEmail,
      roleByJiraId,
      displayNameByEmail
    };

    // Get parent keys for June 2026 using fetchTesterParentKeys
    const parentKeys = await fetchTesterParentKeys(db, projectKey, year, month, assigneeLookup);
    console.log(`TesterTasks parent keys count for June 2026: ${parentKeys.length}`);

    // Query memberStats from backend query
    const memberStatsQuery = `
      SELECT
        COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(i.assignee_name), ''), u.username, u.email_address, i.assignee_account_id, 'Không xác định') as assignee,
        COALESCE(SUM(CASE WHEN i.is_subtask = true AND i.issue_type NOT ILIKE '%bug%' AND i.issue_type NOT ILIKE '%lỗi%' AND COALESCE(u.role, i.assignee_role, '') != 'tester' AND ${doneCondition} THEN 1 ELSE 0 END), 0)::int as dev_tasks_done,
        COALESCE(SUM(CASE WHEN i.is_subtask = true AND i.issue_type NOT ILIKE '%bug%' AND i.issue_type NOT ILIKE '%lỗi%' AND COALESCE(u.role, i.assignee_role, '') = 'tester' AND ${doneCondition} THEN 1 ELSE 0 END), 0)::int as test_tasks_done
      FROM jira_issues i
      LEFT JOIN jira_users u
        ON (
          u.account_id = i.assignee_account_id
          OR (i.assignee_account_id LIKE '%@%' AND LOWER(u.email_address) = LOWER(i.assignee_account_id))
        )
      WHERE i.project_key = ANY($1)
        AND EXTRACT(MONTH FROM i.updated_at) = $2
        AND EXTRACT(YEAR FROM i.updated_at) = $3
      GROUP BY COALESCE(NULLIF(TRIM(u.display_name), ''), NULLIF(TRIM(i.assignee_name), ''), u.username, u.email_address, i.assignee_account_id, 'Không xác định')
    `;
    const repRes = await db.query(memberStatsQuery, [[projectKey], month, year]);
    const reportTotalDev = repRes.rows.reduce((sum, r) => sum + r.dev_tasks_done, 0);
    const reportTotalTest = repRes.rows.reduce((sum, r) => sum + r.test_tasks_done, 0);
    console.log(`Reports Page completed: Dev = ${reportTotalDev}, Test = ${reportTotalTest}`);

    // Let's count from issues that have parents in parentKeys
    const allCompletedSubtasksInMonth = await db.query(
      `
      SELECT i.key, i.parent_key, i.summary, i.status, i.status_category, i.updated_at, i.assignee_account_id, i.assignee_role, i.assignee_name
      FROM jira_issues i
      WHERE i.project_key = $1
        AND i.is_subtask = true
        AND i.issue_type NOT ILIKE '%bug%'
        AND i.issue_type NOT ILIKE '%lỗi%'
        AND EXTRACT(MONTH FROM i.updated_at) = $2
        AND EXTRACT(YEAR FROM i.updated_at) = $3
      `,
      [projectKey, month, year]
    );

    const completedSubs = allCompletedSubtasksInMonth.rows.filter(i => {
      const name = String(i.status || '').trim().toLowerCase();
      const cat = String(i.status_category || '').trim().toLowerCase();
      if (name.includes('reopen') || name.includes('re-open') || name.includes('mở lại')) return false;
      if (name.includes('cancel') || name.includes('hủy') || name.includes('huy')) return false;
      if (cat === 'done') return true;
      return (
        name.includes('resolved') ||
        name.includes('closed') ||
        name === 'close' ||
        name.includes('đóng') ||
        name.includes('dong') ||
        name.includes('done') ||
        name.includes('hoàn thành') ||
        name.includes('hoan thanh') ||
        name.includes('complete')
      );
    });

    let ttTotalDev = 0;
    let ttTotalTest = 0;
    const missingKeys = [];

    completedSubs.forEach(sub => {
      const directEmail = sub.assignee_account_id && sub.assignee_account_id.includes('@')
        ? sub.assignee_account_id.trim().toLowerCase()
        : null;
      const email = directEmail || emailByJiraId.get(sub.assignee_account_id);
      const role = (email && roleByEmail.get(email)) || 
                   (sub.assignee_account_id && roleByJiraId.get(sub.assignee_account_id)) || 
                   sub.assignee_role;
      
      const isTest = role === 'tester';

      if (parentKeys.includes(sub.parent_key)) {
        if (isTest) ttTotalTest++; else ttTotalDev++;
      } else {
        missingKeys.push(`${sub.key} (parent: ${sub.parent_key})`);
      }
    });

    console.log(`TesterTasks Page completed: Dev = ${ttTotalDev}, Test = ${ttTotalTest}`);
    console.log(`Missing keys count: ${missingKeys.length}`);
    if (missingKeys.length > 0) {
      console.log(`Missing keys: ${missingKeys.join(', ')}`);
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
