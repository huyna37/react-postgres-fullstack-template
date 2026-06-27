const axios = require('axios');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const test = async () => {
  const token = process.env.JIRA_TOKEN;
  const jiraUrl = process.env.JIRA_URL;

  try {
    console.log('\nTrying /rest/api/2/field...');
    const res = await axios.get(`${jiraUrl}/rest/api/2/field`, {
      headers: { 'Authorization': `Bearer ${token}` },
      httpsAgent
    });
    console.log('Success! Fields found:', res.data.length);
    const timetracking = res.data.find(f => f.id === 'timetracking');
    console.log('Timetracking field details:', timetracking);
    
    const customfield10300 = res.data.find(f => f.id === 'customfield_10300');
    console.log('customfield_10300 details:', customfield10300);

    const customfield10302 = res.data.find(f => f.id === 'customfield_10302');
    console.log('customfield_10302 details:', customfield10302);
  } catch (err) {
    console.error('Failed to get fields:', err.response?.status, err.message);
  }
};

test();
