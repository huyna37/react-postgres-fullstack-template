const path = require('path');
const axios = require('axios');
const https = require('https');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function runTesterBenchmark() {
  console.log('--- JIRA-AGENT TESTER DASHBOARD BENCHMARK ---');
  
  const projectKey = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
  const token = process.env.JIRA_TOKEN;
  const url = `${process.env.JIRA_URL}/rest/api/2/search`;
  const fields = 'summary,status,issuetype,assignee,updated,parent,customfield_10300,customfield_10302,timeoriginalestimate,timeestimate,timespent,creator';

  if (!token || !process.env.JIRA_URL) {
    console.error('Missing JIRA_TOKEN or JIRA_URL in env! Please set them first.');
    process.exit(1);
  }

  const startDate = '2026-05-01';
  const endDate = '2026-05-31';

  // 1. Month JQL (optimized to avoid custom fields index scan on subtasks)
  const jql = `project = ${projectKey} AND (
    (issuetype in (Story, Task, Bug) AND (
      (cf[10300] >= "${startDate}" AND cf[10300] <= "${endDate}") OR 
      (cf[10302] >= "${startDate}" AND cf[10302] <= "${endDate}") OR
      (updated >= "${startDate}" AND updated <= "${endDate} 23:59") OR
      (created >= "${startDate}" AND created <= "${endDate} 23:59")
    )) OR
    (issuetype in subTaskIssueTypes() AND updated >= "${startDate}" AND updated <= "${endDate} 23:59")
  ) ORDER BY updated DESC`;

  console.log('JQL query length:', jql.length);
  
  // Phase 1: Month search
  console.log('\n--- Phase 1: Fetching issues matching target month ---');
  const start1 = Date.now();
  const res = await axios.get(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    params: { jql, startAt: 0, maxResults: 100, fields },
    httpsAgent
  });
  const duration1 = Date.now() - start1;
  const issues = res.data.issues || [];
  console.log(`Fetched ${issues.length} issues in ${duration1}ms. (Total matched: ${res.data.total})`);

  // Detect orphan subtasks
  const mainIssuesMap = new Map();
  const subtasks = [];
  issues.forEach(issue => {
    const isSub = issue.fields.issuetype?.subtask || false;
    const parentKey = issue.fields.parent?.key;
    if (isSub && parentKey) {
      subtasks.push({ key: issue.key, parentKey });
    } else {
      mainIssuesMap.set(issue.key, issue);
    }
  });

  const orphanSubtasks = subtasks.filter(s => !mainIssuesMap.has(s.parentKey));
  console.log(`Detected ${subtasks.length} total subtasks, ${orphanSubtasks.length} are orphans (parent not in list).`);

  // Phase 2: Fetching parents for orphan subtasks
  const orphanParentKeys = Array.from(new Set(orphanSubtasks.map(s => s.parentKey).filter(Boolean)));
  console.log(`Unique orphan parent keys to fetch: ${orphanParentKeys.length}`);

  if (orphanParentKeys.length > 0) {
    const start2 = Date.now();
    const parentJql = `key in (${orphanParentKeys.join(',')})`;
    const parentResponse = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      params: { jql: parentJql, maxResults: orphanParentKeys.length, fields },
      httpsAgent
    });
    const duration2 = Date.now() - start2;
    console.log(`Fetched ${parentResponse.data.issues?.length || 0} parent details in ${duration2}ms.`);
  }

  console.log(`\nTOTAL NETWORK TIME: ${duration1 + (orphanParentKeys.length > 0 ? (Date.now() - start1 - duration1) : 0)}ms`);
}

runTesterBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
});
