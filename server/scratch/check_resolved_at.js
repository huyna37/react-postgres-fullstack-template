const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
});

async function main() {
  await db.connect();
  console.log('Connected to DB');

  const countTotal = await db.query("SELECT COUNT(*) FROM jira_issues");
  console.log('Total issues:', countTotal.rows[0].count);

  const countResolvedAt = await db.query("SELECT COUNT(*) FROM jira_issues WHERE resolved_at IS NOT NULL");
  console.log('Issues with resolved_at:', countResolvedAt.rows[0].count);

  const countNullResolvedAtDone = await db.query(`
    SELECT COUNT(*) FROM jira_issues 
    WHERE resolved_at IS NULL AND (
      LOWER(status_category) = 'done'
      OR LOWER(status) LIKE '%resolved%'
      OR LOWER(status) LIKE '%closed%'
      OR LOWER(status) = 'close'
      OR LOWER(status) LIKE '%đóng%'
      OR LOWER(status) LIKE '%dong%'
      OR LOWER(status) LIKE '%done%'
      OR LOWER(status) LIKE '%hoàn thành%'
      OR LOWER(status) LIKE '%hoan thanh%'
      OR LOWER(status) LIKE '%complete%'
    )
  `);
  console.log('Done/resolved issues with resolved_at IS NULL:', countNullResolvedAtDone.rows[0].count);

  const sample = await db.query(`
    SELECT key, status, updated_at, resolved_at 
    FROM jira_issues 
    WHERE resolved_at IS NOT NULL 
    LIMIT 5
  `);
  console.log('Sample resolved issues:');
  console.log(sample.rows);

  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
