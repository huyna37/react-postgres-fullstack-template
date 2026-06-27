const path = require('path');
const axios = require('axios');
const https = require('https');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../db');

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function runBenchmark() {
  console.log('--- JIRA-AGENT JQL PERFORMANCE BENCHMARK ---');
  console.log('JIRA_URL:', process.env.JIRA_URL);
  
  const projectKey = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
  const token = process.env.JIRA_TOKEN;
  
  if (!token || !process.env.JIRA_URL) {
    console.error('Missing JIRA_TOKEN or JIRA_URL in env! Please set them first.');
    process.exit(1);
  }

  // Get active users
  const activeUsersRes = await db.query(
    `SELECT account_id FROM jira_users WHERE is_active = true AND jira_project = $1`,
    [projectKey]
  );
  const activeAccountIds = activeUsersRes.rows.map(r => r.account_id).filter(Boolean);
  console.log(`Found ${activeAccountIds.length} active users in local DB.`);

  if (activeAccountIds.length === 0) {
    console.error('No active users found. Benchmark cannot run accurately.');
    process.exit(1);
  }

  // Dates for May 2026
  const startDate = '2026-05-01';
  const endDate = '2026-05-31';

  const idList = activeAccountIds.map(id => `"${id}"`).join(',');
  const assigneeJql = `assignee in (${idList})`;

  // ==========================================
  // Test 1: Single Consolidated JQL Query (1 HTTP Request)
  // ==========================================
  console.log('\n--- Test 1: Single Consolidated JQL Query (1 HTTP Request) ---');
  const singleJql = `project = ${projectKey} AND ${assigneeJql} AND (
    (cf[10300] >= "${startDate}" AND cf[10300] <= "${endDate}") OR 
    (cf[10302] >= "${startDate}" AND cf[10302] <= "${endDate}") OR
    (updated >= "${startDate}" AND updated <= "${endDate} 23:59") OR
    (created >= "${startDate}" AND created <= "${endDate} 23:59")
  ) ORDER BY updated DESC`;

  const url = `${process.env.JIRA_URL}/rest/api/2/search`;
  const fields = 'summary,status,assignee,issuetype,updated,timeoriginalestimate,timeestimate,timespent,customfield_10300,customfield_10301,customfield_10302,worklog,creator';

  const start1 = Date.now();
  try {
    const res = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: {
        jql: singleJql,
        startAt: 0,
        maxResults: 100,
        fields
      },
      httpsAgent
    });
    const issues = res.data.issues || [];
    const duration1 = Date.now() - start1;
    console.log(`SUCCESS: Fetched ${issues.length} issues.`);
    console.log(`TIME ELAPSED: ${duration1}ms`);
  } catch (err) {
    console.error('Test 1 failed:', err.response ? err.response.data : err.message);
  }

  // ==========================================
  // Test 2: Decoupled Parallel 4 Sub-queries + 1 Worklog Fetch (5 HTTP Requests)
  // ==========================================
  console.log('\n--- Test 2: Decoupled Parallel 4 Sub-queries + 1 Worklog Fetch (5 HTTP Requests) ---');
  const lightFields = 'summary,status,assignee,issuetype,updated,timeoriginalestimate,timeestimate,customfield_10300,customfield_10302,creator';
  
  const subJqls = [
    `project = ${projectKey} AND ${assigneeJql} AND cf[10300] >= "${startDate}" AND cf[10300] <= "${endDate}"`,
    `project = ${projectKey} AND ${assigneeJql} AND cf[10302] >= "${startDate}" AND cf[10302] <= "${endDate}"`,
    `project = ${projectKey} AND ${assigneeJql} AND updated >= "${startDate}" AND updated <= "${endDate} 23:59"`,
    `project = ${projectKey} AND ${assigneeJql} AND created >= "${startDate}" AND created <= "${endDate} 23:59"`
  ];

  const fetchIssuesForJql = async (subJql) => {
    const res = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      params: {
        jql: subJql,
        startAt: 0,
        maxResults: 100,
        fields: lightFields
      },
      httpsAgent
    });
    return res.data.issues || [];
  };

  const start2 = Date.now();
  try {
    // Phase 1: 4 light queries in parallel
    const jqlResults = await Promise.all(subJqls.map(fetchIssuesForJql));
    
    // Merge
    const uniqueIssuesMap = new Map();
    for (const batch of jqlResults) {
      for (const issue of batch) {
        if (issue && issue.id) {
          uniqueIssuesMap.set(issue.id, issue);
        }
      }
    }
    const issues = Array.from(uniqueIssuesMap.values());
    console.log(`Phase 1 success: Found ${issues.length} unique issues.`);

    // Phase 2: Bulk fetch worklogs
    if (issues.length > 0) {
      const keys = issues.map(iss => iss.key).filter(Boolean);
      const wlRes = await axios.post(url, {
        jql: `key in (${keys.map(k => `"${k}"`).join(',')})`,
        fields: ['worklog'],
        maxResults: keys.length
      }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        httpsAgent
      });
      console.log(`Phase 2 success: Fetched worklogs for ${wlRes.data.issues?.length} issues.`);
    }

    const duration2 = Date.now() - start2;
    console.log(`SUCCESS: Total decoupled process finished.`);
    console.log(`TIME ELAPSED: ${duration2}ms`);
  } catch (err) {
    console.error('Test 2 failed:', err.response ? err.response.data : err.message);
  }

  process.exit(0);
}

runBenchmark().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
