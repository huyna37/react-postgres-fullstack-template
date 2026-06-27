const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../db');
const { loadAssigneeLookup } = require('../lib/assigneeIdentity');
const {
  fetchTesterMonthBundle,
  selectTesterParentKeys,
  fetchTesterIssuesWithSubtasks,
  buildTesterIssues,
} = require('../lib/dashboardTesterFromDb');
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';

async function main() {

  let t = Date.now();
  const [assigneeLookup, bundle] = await Promise.all([
    loadAssigneeLookup(PROJECT),
    fetchTesterMonthBundle(db, PROJECT, 2026, 6),
  ]);
  const parentKeys = selectTesterParentKeys(bundle, assigneeLookup);
  console.log(`keys phase: ${Date.now() - t}ms (${parentKeys.length} parents)`);

  t = Date.now();
  const rows = await fetchTesterIssuesWithSubtasks(db, PROJECT, parentKeys);
  console.log(`tree query: ${Date.now() - t}ms (${rows.length} parents)`);

  t = Date.now();
  buildTesterIssues(rows, assigneeLookup);
  console.log(`js assembly: ${Date.now() - t}ms`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
