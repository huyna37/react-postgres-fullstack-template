const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const db = require('../db');

// Mock dependencies
const mockContext = {
  authenticateToken: (req, res, next) => next(),
  optionalAuth: (req, res, next) => next(),
  httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
  pushToJira: async (ticket, parentKey, assigneeId, token, project, startDate, dueDate, estimate, epicKey) => {
    console.log(`[PUSH MOCK] Creating ${ticket.issueType} "${ticket.summary}" (Parent: ${parentKey}, Assignee: ${assigneeId}, Epic: ${epicKey})`);
    return { key: `MOCK-${Math.floor(Math.random() * 1000) + 1}` };
  },
  getActiveSprintId: async () => 27,
  formatJiraDate: (d) => d
};

const planningRouter = require('../planning')(mockContext);

// Express mock req/res
const runTest = async (body) => {
  const req = {
    body,
    user: {
      jira_project: process.env.JIRA_PROJECT_KEY || 'BXDCSDL',
      jira_token: process.env.JIRA_TOKEN
    }
  };

  const res = {
    json: (data) => console.log('Response Success:', data),
    status: (code) => {
      console.log('Response Status:', code);
      return res;
    }
  };

  // Find the POST handler for /api/planning/push
  const routeStack = planningRouter.stack;
  const pushRoute = routeStack.find(layer => layer.route && layer.route.path === '/api/planning/push');
  
  if (pushRoute) {
    const handler = pushRoute.route.stack[pushRoute.route.stack.length - 1].handle;
    try {
      await handler(req, res);
    } catch (err) {
      console.error('Error running route handler:', err);
    }
  } else {
    console.error('Could not find /api/planning/push route.');
  }
};

const main = async () => {
  console.log('--- TEST 1: epicMode = "create" ---');
  await runTest({
    tickets: [{ summary: 'Feature A', description: 'Desc A', estimateHours: 8, subtasks: [] }],
    members: [],
    planName: 'New Epic Name',
    goal: 'Objective details',
    epicMode: 'create'
  });

  console.log('\n--- TEST 2: epicMode = "existing" ---');
  await runTest({
    tickets: [{ summary: 'Feature B', description: 'Desc B', estimateHours: 8, subtasks: [] }],
    members: [],
    planName: 'New Epic Name',
    goal: 'Objective details',
    epicMode: 'existing',
    selectedEpicKey: 'BXDCSDL-100'
  });

  console.log('\n--- TEST 3: epicMode = "none" ---');
  await runTest({
    tickets: [{ summary: 'Feature C', description: 'Desc C', estimateHours: 8, subtasks: [] }],
    members: [],
    planName: 'New Epic Name',
    goal: 'Objective details',
    epicMode: 'none'
  });
};

main();
