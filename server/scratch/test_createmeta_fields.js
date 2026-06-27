const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function main() {
  const token = process.env.JIRA_TOKEN;
  const base = process.env.JIRA_URL.replace(/\/$/, '');
  const projectKey = 'BXDCSDL';
  const issueTypeId = process.argv[2] || '10100';

  const url = `${base}/rest/api/2/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    httpsAgent,
    params: { expand: 'fields' },
  });

  console.log('top keys:', Object.keys(res.data || {}));
  const values = res.data?.values || [];
  console.log('Field count:', values.length);
  const interesting = values.filter(v => {
    const id = v.fieldId || '';
    return (
      id.includes('10008') ||
      id.includes('10014') ||
      id.includes('10201') ||
      id === 'timetracking' ||
      id.includes('10206') ||
      id.includes('10300') ||
      id.includes('10302') ||
      /epic|sprint/i.test(v.name || '')
    );
  });
  for (const v of interesting) {
    console.log(v.fieldId, '->', v.name);
  }
}

main().catch(e => console.error(e.response?.data || e.message));
