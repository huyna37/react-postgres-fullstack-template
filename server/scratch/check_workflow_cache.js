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

  const countWorkflowStatus = await db.query("SELECT COUNT(*) FROM jira_workflow_status");
  console.log('Total workflow status rows:', countWorkflowStatus.rows[0].count);

  const sample = await db.query("SELECT project_key, status_name, synced_at FROM jira_workflow_status LIMIT 5");
  console.log('Sample workflow status rows:');
  console.log(sample.rows);

  await db.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
