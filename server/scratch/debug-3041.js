require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const db = require('../db');
const { syncWorklogEntriesForIssue } = require('../lib/jiraWorklogIndex');

async function main() {
  const key = 'BXDCSDL-3041';
  if (process.argv.includes('--fix')) {
    await syncWorklogEntriesForIssue(db, key, 'BXDCSDL', { worklogs: [] });
    console.log('Applied empty worklog sync');
  }
  const i = await db.query(
    `SELECT key, time_spent, original_estimate, remaining_estimate, updated_at
     FROM jira_issues WHERE key = $1`,
    [key]
  );
  const w = await db.query(
    `SELECT id, time_spent_seconds, time_spent, started_at::text
     FROM jira_worklog_entries WHERE issue_key = $1`,
    [key]
  );
  console.log('issue:', i.rows[0]);
  console.log('worklog_entries:', w.rows);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
