const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../db');

(async () => {
  await db.initDB();
  const r = await db.query(
    `SELECT key, value FROM app_settings WHERE key LIKE 'jira_createmeta:%' OR key LIKE 'jira_field_config:%'`
  );
  console.log(JSON.stringify(r.rows, null, 2));
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
