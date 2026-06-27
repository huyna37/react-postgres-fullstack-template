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
  const projectKey = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';

  const body = {
    fields: {
      project: { key: projectKey },
      summary: 'Test issue creation ' + Date.now(),
      description: 'Test description',
      issuetype: { name: 'Story' },
      timetracking: {
        originalEstimate: '24h'
      }
    }
  };

  console.log('Sending issue creation request with timetracking...');
  try {
    const res = await axios.post(`${jiraUrl}/rest/api/2/issue`, body, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      httpsAgent
    });
    console.log('Success! Created ticket key:', res.data.key);
  } catch (error) {
    const errorData = error.response ? error.response.data : null;
    console.log('Failed as expected with status:', error.response?.status);
    console.log('Jira Error Details:', JSON.stringify(errorData, null, 2));

    if (errorData && errorData.errors && errorData.errors.timetracking) {
      console.log('\nRetrying issue creation WITHOUT timetracking...');
      delete body.fields.timetracking;
      try {
        const resRetry = await axios.post(`${jiraUrl}/rest/api/2/issue`, body, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          httpsAgent
        });
        console.log('Success on retry! Created ticket key:', resRetry.data.key);
      } catch (retryError) {
        console.error('Failed on retry:', retryError.response?.data || retryError.message);
      }
    }
  }
};

test();
