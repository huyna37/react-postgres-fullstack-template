const axios = require('axios');
const db = require('../db');
const https = require('https');
require('dotenv').config({ path: '../../.env' });

const token = process.env.JIRA_TOKEN || '';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const url = process.env.JIRA_URL + '/rest/api/2/search';
const jql = 'key = BXDCSDL-2817 OR parent = BXDCSDL-2817';

async function run() {
  try {
    const res = await axios.get(url, {
      headers: { 'Authorization': 'Bearer ' + token },
      params: { jql, fields: 'summary,status,issuetype,assignee,updated,description,parent' },
      httpsAgent
    });

    const issues = res.data.issues || [];
    const rolesRes = await db.query(
      'SELECT account_id, display_name, role FROM jira_users WHERE jira_project = $1 AND is_active = true',
      ['BXDCSDL']
    );

    const userRoles = new Map();
    const userRolesByDisplayName = new Map();
    rolesRes.rows.forEach(r => {
      if (r.account_id) userRoles.set(r.account_id, r.role);
      if (r.display_name) userRolesByDisplayName.set(r.display_name.trim().toLowerCase(), r.role);
    });

    const list = issues.map(i => {
      const assignee = i.fields.assignee ? {
        accountId: i.fields.assignee.accountId || i.fields.assignee.key,
        displayName: i.fields.assignee.displayName,
        role: (() => {
          const accId = i.fields.assignee.accountId || i.fields.assignee.key;
          const dispName = i.fields.assignee.displayName ? i.fields.assignee.displayName.trim().toLowerCase() : '';
          return userRoles.get(accId) || userRolesByDisplayName.get(dispName) || 'developer';
        })()
      } : null;

      return {
        key: i.key,
        summary: i.fields.summary,
        assignee
      };
    });

    console.log('Result list:');
    console.log(JSON.stringify(list, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
