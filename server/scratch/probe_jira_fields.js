/**
 * Probe Jira createmeta + /field — in ra field đúng cho project.
 * Usage: node server/scratch/probe_jira_fields.js [PROJECT_KEY]
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const https = require('https');
const db = require('../db');
const { probeProjectFieldConfig } = require('../lib/jiraIssueFieldConfig');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function main() {
  const projectKey = process.argv[2] || process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
  const token = process.env.JIRA_TOKEN;
  const jiraBaseUrl = process.env.JIRA_URL;

  if (!token || !jiraBaseUrl) {
    console.error('Cần JIRA_TOKEN và JIRA_URL trong .env');
    process.exit(1);
  }

  await db.initDB();
  const payload = await probeProjectFieldConfig(db, {
    projectKey,
    token,
    httpsAgent,
    jiraBaseUrl,
  });

  console.log('\n=== Kết quả probe ===');
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
