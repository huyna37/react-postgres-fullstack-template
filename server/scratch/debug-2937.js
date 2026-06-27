require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const db = require('../db');

const ISSUE_KEY = 'BXDCSDL-2937';
const LOG_DATE = process.argv[2] || '2026-06-08';

async function main() {
  console.log('=== Worklog entries for', ISSUE_KEY, '===');
  const wl = await db.query(
    `SELECT issue_key, author_account_id, author_email, time_spent_seconds, time_spent,
            started_at,
            (started_at AT TIME ZONE 'Asia/Bangkok')::date AS log_day_bkk
     FROM jira_worklog_entries
     WHERE issue_key = $1
     ORDER BY started_at DESC`,
    [ISSUE_KEY]
  );
  console.log(JSON.stringify(wl.rows, null, 2));

  console.log('\n=== Issue row ===');
  const issue = await db.query(
    `SELECT key, assignee_account_id, assignee_name, status, status_category, updated_at,
            (updated_at AT TIME ZONE 'Asia/Bangkok')::date AS updated_day_bkk
     FROM jira_issues WHERE key = $1`,
    [ISSUE_KEY]
  );
  console.log(JSON.stringify(issue.rows, null, 2));

  console.log('\n=== jira_users (active) ===');
  const users = await db.query(
    `SELECT id, username, account_id, email_address, jira_project FROM jira_users WHERE is_active = true ORDER BY id`
  );
  console.log(JSON.stringify(users.rows, null, 2));

  for (const u of users.rows) {
    const accountId = u.account_id;
    const email = u.email_address;
    const exists = await db.query(
      `SELECT EXISTS (
        SELECT 1 FROM jira_worklog_entries w
        WHERE w.issue_key = $1
          AND (w.started_at AT TIME ZONE 'Asia/Bangkok')::date = $2::date
          AND COALESCE(w.time_spent_seconds, 0) > 0
          AND (
            ($3::text IS NOT NULL AND TRIM(COALESCE(w.author_account_id, '')) = TRIM($3))
            OR ($4::text IS NOT NULL AND LOWER(TRIM(COALESCE(w.author_email, ''))) = LOWER(TRIM($4)))
            OR (
              $4::text IS NOT NULL
              AND TRIM(COALESCE(w.author_account_id, '')) LIKE '%@%'
              AND LOWER(TRIM(w.author_account_id)) = LOWER(TRIM($4))
            )
          )
      ) AS has_log`,
      [ISSUE_KEY, LOG_DATE, accountId, email]
    );
    console.log(`\nUser ${u.username} (id=${u.id}): has_log on ${LOG_DATE} =`, exists.rows[0].has_log);
    console.log('  account_id:', accountId, '| email:', email);
  }

  console.log('\n=== Candidates query simulation for logDate', LOG_DATE, '===');
  const u = users.rows[0];
  if (u) {
    const cand = await db.query(
      `SELECT i.key,
        EXISTS (
          SELECT 1 FROM jira_worklog_entries w
          WHERE w.issue_key = i.key
            AND (w.started_at AT TIME ZONE 'Asia/Bangkok')::date = $2::date
            AND COALESCE(w.time_spent_seconds, 0) > 0
        ) AS any_log_that_day,
        EXISTS (
          SELECT 1 FROM jira_worklog_entries w
          WHERE w.issue_key = i.key
            AND (w.started_at AT TIME ZONE 'Asia/Bangkok')::date = $2::date
            AND COALESCE(w.time_spent_seconds, 0) > 0
            AND (
              ($3::text IS NOT NULL AND TRIM(COALESCE(w.author_account_id, '')) = TRIM($3))
              OR ($4::text IS NOT NULL AND LOWER(TRIM(COALESCE(w.author_email, ''))) = LOWER(TRIM($4)))
              OR (
                $4::text IS NOT NULL
                AND TRIM(COALESCE(w.author_account_id, '')) LIKE '%@%'
                AND LOWER(TRIM(w.author_account_id)) = LOWER(TRIM($4))
              )
            )
        ) AS user_log_that_day
       FROM jira_issues i WHERE i.key = $1`,
      [ISSUE_KEY, LOG_DATE, u.account_id, u.email_address]
    );
    console.log(JSON.stringify(cand.rows, null, 2));
  }

  console.log('\n=== Estimate / remaining ===');
  const est = await db.query(
    `SELECT original_estimate, time_spent, remaining_estimate FROM jira_issues WHERE key = $1`,
    [ISSUE_KEY]
  );
  console.log(est.rows[0]);

  console.log('\n=== log_day_bkk as text ===');
  const days = await db.query(
    `SELECT started_at::text,
            to_char((started_at AT TIME ZONE 'Asia/Bangkok')::date, 'YYYY-MM-DD') AS log_day_bkk
     FROM jira_worklog_entries WHERE issue_key = $1`,
    [ISSUE_KEY]
  );
  console.log(days.rows);

  console.log('\n=== huyna has_log on 2026-06-04 ===');
  const huyna = users.rows.find(u => u.username === 'huyna');
  if (huyna) {
    const r = await db.query(
      `SELECT EXISTS (
        SELECT 1 FROM jira_worklog_entries w
        WHERE w.issue_key = $1
          AND (w.started_at AT TIME ZONE 'Asia/Bangkok')::date = '2026-06-04'::date
          AND COALESCE(w.time_spent_seconds, 0) > 0
          AND LOWER(TRIM(COALESCE(w.author_email, w.author_account_id, ''))) = LOWER(TRIM($2))
      )`,
      [ISSUE_KEY, huyna.email_address]
    );
    console.log('has_log 04/06:', r.rows[0].exists);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
