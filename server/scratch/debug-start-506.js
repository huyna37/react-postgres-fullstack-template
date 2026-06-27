require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const db = require('../db');
const { fetchAutoLogworkCandidates } = require('../lib/autoLogworkFromDb');

const WORK_DATE = '2026-06-05';
const USER_ID = 46; // huyna

async function main() {
  console.log('=== Tickets start_date = 2026-06-05 (huyna assignee) ===');
  const rows = await db.query(
    `SELECT key, summary, status, status_category,
            start_date::text, due_date::text,
            (updated_at AT TIME ZONE 'Asia/Bangkok')::date AS done_day_bkk,
            updated_at::text,
            assignee_account_id
     FROM jira_issues
     WHERE start_date::date = '2026-06-05'::date
       AND LOWER(assignee_account_id) = 'huyna@etc.vn'
     ORDER BY key`
  );
  console.log(rows.rows);

  console.log('\n=== Candidates workDate=logDate=2026-06-05 ===');
  const cand = await fetchAutoLogworkCandidates(db, USER_ID, WORK_DATE, WORK_DATE);
  console.log('keys:', cand.issues.map(i => i.key));

  console.log('\n=== Candidates workDate=logDate=2026-06-08 ===');
  const cand8 = await fetchAutoLogworkCandidates(db, USER_ID, '2026-06-08', '2026-06-08');
  console.log('keys:', cand8.issues.map(i => i.key));

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
