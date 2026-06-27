const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../db');
const { fetchMonthlyDashboard } = require('../lib/dashboardMonthlyFromDb');
const { fetchTesterDashboard } = require('../lib/dashboardTesterFromDb');

const PROJECT = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
const YEAR = 2026;
const MONTH = 6;

async function main() {
  for (let i = 0; i < 5; i++) {
    const { timing } = await fetchMonthlyDashboard(db, PROJECT, YEAR, MONTH);
    console.log(
      `dashboard/monthly #${i + 1}: users ${timing.usersMs}ms + issues ${timing.issuesMs ?? timing.subtasksMs}ms + worklog ${timing.worklogMs ?? 0}ms = ${timing.totalMs}ms (${timing.rowCount} rows)`
    );
  }
  for (let i = 0; i < 5; i++) {
    const { timing } = await fetchTesterDashboard(db, PROJECT, '06', '2026');
    console.log(
      `tester/dashboard #${i + 1}: keys ${timing.keysMs}ms + tree ${timing.treeMs}ms = ${timing.totalMs}ms (${timing.parentCount} parents)`
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
