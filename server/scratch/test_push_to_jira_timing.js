/**
 * Phân tích tốc độ đẩy ticket lên Jira — đếm HTTP call, đo từng bước, phát hiện retry.
 *
 * Chạy:
 *   node server/scratch/test_push_to_jira_timing.js
 *   node server/scratch/test_push_to_jira_timing.js --live
 *
 * Live cần .env: JIRA_URL, JIRA_TOKEN, JIRA_PROJECT_KEY (+ DB nếu probe field config).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function parseArgs() {
  return { live: process.argv.includes('--live') };
}

function createAxiosTap(label) {
  const calls = [];
  const origGet = axios.get.bind(axios);
  const origPost = axios.post.bind(axios);
  const origPut = axios.put.bind(axios);

  const tap = (method, url, ...rest) => {
    const short = String(url).replace(process.env.JIRA_URL || '', '[JIRA]');
    calls.push({ method, url: short, at: Date.now() });
    const fn = method === 'GET' ? origGet : method === 'POST' ? origPost : origPut;
    return fn(url, ...rest);
  };

  axios.get = (url, ...r) => tap('GET', url, ...r);
  axios.post = (url, ...r) => tap('POST', url, ...r);
  axios.put = (url, ...r) => tap('PUT', url, ...r);

  return {
    calls,
    restore() {
      axios.get = origGet;
      axios.post = origPost;
      axios.put = origPut;
    },
    report() {
      const byKey = new Map();
      for (const c of calls) {
        const key = `${c.method} ${c.url.split('?')[0]}`;
        byKey.set(key, (byKey.get(key) || 0) + 1);
      }
      const retries = [...byKey.entries()].filter(([, n]) => n > 1);
      return { total: calls.length, byKey, retries, calls };
    },
  };
}

async function mockDbWithFieldConfig() {
  const fieldPayload = {
    syncedAt: new Date().toISOString(),
    byIssueType: {
      Story: {
        epicLinkField: 'customfield_10014',
        sprintField: 'customfield_10020',
        startDateField: 'customfield_10300',
        dueDateField: 'duedate',
        supportsTimetracking: true,
      },
      'Sub-task': {
        epicLinkField: null,
        sprintField: null,
        startDateField: 'customfield_10300',
        dueDateField: 'duedate',
        supportsTimetracking: true,
      },
    },
    default: {
      epicLinkField: 'customfield_10014',
      sprintField: 'customfield_10020',
      startDateField: 'customfield_10300',
      dueDateField: 'duedate',
      supportsTimetracking: true,
    },
  };

  return {
    query: async (sql, params) => {
      if (String(sql).includes('app_settings') && params?.[0]?.startsWith('jira_field_config:')) {
        return { rows: [{ value: fieldPayload }] };
      }
      if (String(sql).includes('jira_users')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function runSimulatedPush() {
  console.log('\n=== SIMULATION: 1 lần pushToJira (Story, field config đã cache) ===\n');

  const tap = createAxiosTap('sim');
  process.env.JIRA_PUSH_TIMING = '1';

  const db = await mockDbWithFieldConfig();
  const { getIssueCreateFieldConfig } = require('../lib/jiraIssueFieldConfig');
  const { createPushProfiler } = require('../lib/jiraPushProfiler');

  const projectKey = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
  const token = 'mock-token';
  const profiler = createPushProfiler('simStory');

  axios.get = async (url, opts) => {
    tap.calls.push({ method: 'GET', url: String(url), at: Date.now() });
    if (String(url).includes('/board')) {
      return { data: { values: [{ id: 1, type: 'scrum' }] } };
    }
    if (String(url).includes('/sprint')) {
      return { data: { values: [{ id: 99 }] } };
    }
    throw new Error(`Unexpected GET ${url}`);
  };

  axios.post = async (url, body) => {
    tap.calls.push({ method: 'POST', url: String(url), at: Date.now() });
    if (String(url).includes('/rest/api/2/issue')) {
      return { data: { key: `${projectKey}-SIM-1`, id: '10001' } };
    }
    throw new Error(`Unexpected POST ${url}`);
  };

  const t0 = Date.now();
  await getIssueCreateFieldConfig(db, {
    projectKey,
    issueTypeName: 'Story',
    token,
    httpsAgent,
    jiraBaseUrl: process.env.JIRA_URL || 'https://jira.example',
  });
  profiler.step('fieldConfig');

  await axios.get(`${process.env.JIRA_URL || 'https://jira.example'}/rest/agile/1.0/board`, {
    params: { projectKeyOrId: projectKey },
  });
  await axios.get(
    `${process.env.JIRA_URL || 'https://jira.example'}/rest/agile/1.0/board/1/sprint`,
    { params: { state: 'active' } }
  );
  profiler.step('activeSprint');

  await axios.post(`${process.env.JIRA_URL || 'https://jira.example'}/rest/api/2/issue`, {
    fields: { summary: 'Sim ticket' },
  });
  profiler.step('jiraCreatePost');

  const summary = profiler.finish({ simulated: true });
  const elapsed = Date.now() - t0;
  const rep = tap.report();

  console.log('Thời gian từng bước (ms):');
  for (const s of summary.steps) {
    console.log(`  - ${s.name}: ${s.ms}ms`);
  }
  console.log(`Tổng mô phỏng: ${elapsed}ms`);
  console.log(`HTTP calls: ${rep.total}`);
  for (const [k, n] of rep.byKey) {
    console.log(`  ${n}x ${k}`);
  }
  if (rep.retries.length) {
    console.log('⚠️  Có endpoint bị gọi >1 lần (có thể retry/fallback):');
    for (const [k, n] of rep.retries) console.log(`  ${n}x ${k}`);
  } else {
    console.log('✓ Không phát hiện retry HTTP (mỗi endpoint ≤1 lần trong mô phỏng).');
  }

  tap.restore();
}

function explainSlowPaths() {
  console.log(`
=== PHÂN TÍCH LUỒNG CHẬM (không phải retry khi fail) ===

pushToJira KHÔNG retry khi Jira trả lỗi — fail 1 lần là throw ngay.

Các bước CHẬM trước khi gọi POST /issue:
  1. getIssueCreateFieldConfig
     - Nếu cache DB hết hạn (24h): probeProjectFieldConfig
       → GET /field + GET createmeta TỪNG issue type (5–15+ request tuần tự)
     - Đã sửa: dùng cache cũ ngay, refresh nền (không block push)
  2. getActiveSprintId (chỉ ticket gốc, không sub-task)
     → GET /board + GET /board/{id}/sprint
     - Đã sửa: cache RAM 2 phút / project
  3. resolveJiraAssignee — thường nhanh (DB email lookup)

POST /issue — thường <1s (giống Jira UI).

Sau khi tạo (route /children) — trước đây BLOCK response:
  - fetchIssueFromJira + enrich + upsertJiraIssue (+ upload ảnh nếu có)
  - Đã sửa: trả JSON ngay sau khi Jira tạo xong, sync DB chạy nền

push-manual + sub-task: mỗi sub gọi lại pushToJira (field config cache RAM, không sprint).

Bật log timing thực tế: JIRA_PUSH_TIMING=1 npm run server
`);
}

async function runLivePush() {
  const token = process.env.JIRA_TOKEN;
  const jiraUrl = process.env.JIRA_URL;
  const projectKey = process.env.JIRA_PROJECT_KEY || 'BXDCSDL';

  if (!token || !jiraUrl) {
    console.log('\n--live: thiếu JIRA_TOKEN hoặc JIRA_URL trong .env — bỏ qua live test.\n');
    return;
  }

  console.log('\n=== LIVE: tạo sub-task test (sẽ xóa không tự động — dùng key test) ===\n');
  console.log('Cần parent key — đặt TEST_PARENT_KEY trong .env hoặc bỏ qua.\n');

  const parentKey = process.env.TEST_PARENT_KEY;
  if (!parentKey) {
    console.log('Thiếu TEST_PARENT_KEY — chỉ đo fieldConfig + sprint bằng dry calls.\n');
  }

  process.env.JIRA_PUSH_TIMING = '1';

  try {
    await require('../db').initDB();
  } catch (e) {
    console.warn('DB không kết nối được — live test giới hạn:', e.message);
    return;
  }

  const db = require('../db');
  const { getIssueCreateFieldConfig } = require('../lib/jiraIssueFieldConfig');
  const tap = createAxiosTap('live');

  const t0 = Date.now();
  await getIssueCreateFieldConfig(db, {
    projectKey,
    issueTypeName: 'Story',
    token,
    httpsAgent,
    jiraBaseUrl: jiraUrl,
  });
  const fieldMs = Date.now() - t0;
  console.log(`fieldConfig (live): ${fieldMs}ms`);

  const t1 = Date.now();
  const boardsRes = await axios.get(`${jiraUrl}/rest/agile/1.0/board`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { projectKeyOrId: projectKey },
    httpsAgent,
  });
  const boards = boardsRes.data?.values || [];
  if (boards[0]) {
    await axios.get(`${jiraUrl}/rest/agile/1.0/board/${boards[0].id}/sprint`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { state: 'active' },
      httpsAgent,
    });
  }
  console.log(`activeSprint (live): ${Date.now() - t1}ms`);

  if (parentKey) {
    const t2 = Date.now();
    const body = {
      fields: {
        project: { key: projectKey },
        summary: `[TEST-TIMING] ${new Date().toISOString()}`,
        description: 'Auto timing test — có thể xóa',
        issuetype: { name: 'Sub-task' },
        parent: { key: parentKey },
      },
    };
    const res = await axios.post(`${jiraUrl}/rest/api/2/issue`, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      httpsAgent,
    });
    console.log(`jiraCreatePost sub-task (live): ${Date.now() - t2}ms → ${res.data?.key}`);
  }

  const rep = tap.report();
  console.log(`\nLive HTTP calls: ${rep.total}`);
  if (rep.retries.length) {
    console.log('⚠️  Endpoint gọi lặp:');
    for (const [k, n] of rep.retries) console.log(`  ${n}x ${k}`);
  }

  tap.restore();
}

async function main() {
  const { live } = parseArgs();
  console.log('Jira Push Timing Diagnostic');
  console.log('===========================');

  explainSlowPaths();
  await runSimulatedPush();
  if (live) await runLivePush();

  console.log('\nKết luận: chậm chủ yếu do NHIỀU request phụ trước/sau POST create, không phải retry fail.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
