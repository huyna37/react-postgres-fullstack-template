require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const db = require('../db');
const { aggregateParentFamilyComments } = require('../lib/jiraComments');

async function main() {
  const key = process.argv[2] || 'BXDCSDL-3124';
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await db.query(
      `SELECT key, summary, description, output, creator, creator_email, is_subtask, parent_key,
              COALESCE(jsonb_array_length(attachments), 0) AS attachment_count
       FROM jira_issues WHERE key = $1`,
      [key]
    );
    console.log(`content #${i + 1}: ${Date.now() - t}ms`);
  }
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await aggregateParentFamilyComments(db, key);
    console.log(`comments agg #${i + 1}: ${Date.now() - t}ms`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
