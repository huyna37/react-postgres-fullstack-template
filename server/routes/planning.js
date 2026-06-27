const express = require('express');
const { requireUserJiraToken } = require('../lib/jiraToken');
const axios = require('axios');
const db = require('../db');
const { getSmartModel, llmGenerate } = require('../llm');
const {
  balancePlanningWorkload,
  isPlanningBalanced,
  computeWorkloadByMember,
} = require('../planning-workload');
const { upsertJiraIssue } = require('../lib/jiraIssueUpsert');
const {
  buildWikiCommentBody,
  descriptionHasWikiImages,
  uploadIssueAttachments,
} = require('../lib/jiraCommentPost');
const { createJiraEpic } = require('../lib/jiraEpicCreate');

const JIRA_REQUEST_TIMEOUT_MS = Number(process.env.JIRA_REQUEST_TIMEOUT_MS) || 120000;

async function upsertCreatedEpicToDb(issueData, { summary, description, projectKey }) {
  try {
    await upsertJiraIssue(
      {
        id: issueData.id,
        key: issueData.key,
        summary,
        status: 'To Do',
        statusCategory: 'new',
        issueType: 'Epic',
        isSubtask: false,
        updated: new Date().toISOString(),
        created: new Date().toISOString(),
        description: description || '',
        assignee: null,
        timeEstimate: 0,
        timeSpent: 0,
        originalEstimate: 0,
        remainingEstimate: 0,
        creator: null,
        creatorEmail: null,
        startDate: null,
        dueDate: null,
        parentKey: null,
        worklog: null,
        comments: [],
      },
      projectKey
    );
  } catch (err) {
    console.error('[Planning Epic DB upsert] Failed:', err.message);
  }
}

async function pushPlanningIssueWithMedia({
  ticket,
  parentKey,
  assignee,
  estimateStr,
  epicLink,
  token,
  userProject,
  startDate,
  dueDate,
  pushToJira,
  jiraBaseUrl,
  httpsAgent,
}) {
  const descriptionBody = String(ticket.description || '').trim();
  const hasImages = Array.isArray(ticket.images) && ticket.images.length > 0;

  const mainResponse = await pushToJira(
    {
      summary: ticket.summary,
      description: hasImages && !descriptionHasWikiImages(descriptionBody) ? '' : descriptionBody,
      issueType: ticket.issueType || 'Story',
    },
    parentKey,
    assignee || null,
    token,
    userProject,
    startDate || null,
    dueDate || null,
    estimateStr,
    epicLink
  );

  const issueKey = mainResponse.key;

  if (hasImages) {
    const attachmentNames = await uploadIssueAttachments(
      jiraBaseUrl,
      issueKey,
      ticket.images,
      token,
      httpsAgent
    );
    let finalDesc = descriptionBody;
    if (!descriptionHasWikiImages(finalDesc)) {
      finalDesc = buildWikiCommentBody(finalDesc, attachmentNames);
    }
    if (finalDesc) {
      await axios.put(
        `${jiraBaseUrl}/rest/api/2/issue/${issueKey}`,
        { fields: { description: finalDesc } },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          httpsAgent,
          timeout: JIRA_REQUEST_TIMEOUT_MS,
        }
      );
    }
  }

  return mainResponse;
}

module.exports = context => {
  const router = express.Router();
  const {
    authenticateToken,
    optionalAuth,
    httpsAgent,
    pushToJira,
    getActiveSprintId,
    formatJiraDate,
  } = context;

  // Helper to normalize planning tickets structure and auto-assign roles/tester owners
  const normalizePlanningTickets = (tickets, members = [], includeBa = true) => {
    const memberIds = new Set((members || []).map(m => m.accountId).filter(Boolean));
    const pickByRole = role => (members || []).find(m => m.role === role)?.accountId || '';

    const assigneeForSubPrefix = summary => {
      if (/^\[BA\]/i.test(summary)) return pickByRole('ba');
      if (/^\[TEST\]/i.test(summary)) return pickByRole('tester');
      if (/^\[DEV\]/i.test(summary)) return pickByRole('developer');
      return '';
    };

    const subSortKey = summary => {
      if (/^\[BA\]/i.test(summary)) return 0;
      if (/^\[DEV\]/i.test(summary)) return 1;
      if (/^\[TEST\]/i.test(summary)) return 2;
      return 3;
    };

    const normalizeSub = (sub, storySummary) => {
      let summary = String(sub?.summary || '').trim();
      if (!/^\[(DEV|TEST|BA)\]/i.test(summary)) {
        const lower = summary.toLowerCase();
        if (/test|kiểm thử|qc|checklist/.test(lower)) summary = `[TEST] ${summary}`;
        else if (/ba|phân tích|spec|tài liệu|đặc tả/.test(lower)) summary = `[BA] ${summary}`;
        else summary = `[DEV] ${summary}`;
      }
      const roleAssignee = assigneeForSubPrefix(summary);
      return {
        summary,
        description: String(sub?.description || `Sub-task cho Story: ${storySummary}`).trim(),
        issueType: 'Sub-task',
        estimateHours: Math.max(0, Number(sub?.estimateHours) || 4),
        assignee: roleAssignee || (memberIds.has(sub?.assignee) ? sub.assignee : ''),
      };
    };

    return balancePlanningWorkload(
      (Array.isArray(tickets) ? tickets : [])
        .filter(t => String(t?.issueType || '').toLowerCase() !== 'bug')
        .map(t => {
          const summary = String(t?.summary || 'Story mới').trim();
          let subtasks = (Array.isArray(t?.subtasks) ? t.subtasks : []).map(s =>
            normalizeSub(s, summary)
          );

          if (!includeBa) {
            subtasks = subtasks.filter(s => !/^\[BA\]/i.test(s.summary));
          }

          const hasDev = subtasks.some(s => /^\[DEV\]/i.test(s.summary));
          const hasTest = subtasks.some(s => /^\[TEST\]/i.test(s.summary));
          const hasBa = subtasks.some(s => /^\[BA\]/i.test(s.summary));

          if (includeBa && !hasBa && pickByRole('ba')) {
            subtasks.push({
              summary: `[BA] Làm tài liệu / spec — ${summary}`,
              description: 'Phân tích nghiệp vụ, viết spec, acceptance criteria cho chức năng.',
              issueType: 'Sub-task',
              estimateHours: 8,
              assignee: pickByRole('ba'),
            });
          }
          if (!hasDev && pickByRole('developer')) {
            subtasks.push({
              summary: `[DEV] Triển khai — ${summary}`,
              description: 'Phát triển code, API, UI theo spec đã chốt.',
              issueType: 'Sub-task',
              estimateHours: 16,
              assignee: pickByRole('developer'),
            });
          }
          if (!hasTest && pickByRole('tester')) {
            subtasks.push({
              summary: `[TEST] Kiểm thử & checklist — ${summary}`,
              description: 'Soạn checklist, test nghiệp vụ, xác nhận done.',
              issueType: 'Sub-task',
              estimateHours: 8,
              assignee: pickByRole('tester'),
            });
          }

          subtasks = subtasks.sort((a, b) => subSortKey(a.summary) - subSortKey(b.summary));

          const storyHours = subtasks.reduce((s, x) => s + (x.estimateHours || 0), 0);
          const testSub = subtasks.find(s => /^\[TEST\]/i.test(s.summary));
          const storyAssignee = testSub ? testSub.assignee : pickByRole('tester') || '';

          return {
            summary,
            description: String(t?.description || '').trim(),
            issueType: 'Story',
            estimateHours:
              storyHours > 0 ? storyHours : Math.max(0, Number(t?.estimateHours) || 32),
            assignee: storyAssignee,
            subtasks,
          };
        }),
      members
    );
  };

  // AI Planning task decomposition endpoint
  router.post('/api/planning/generate', authenticateToken, async (req, res) => {
    const { planName, goal, members, taskTypes, storyCount, includeBa = true } = req.body;
    if (!goal) {
      return res.status(400).json({ error: 'Missing goal description' });
    }

    const membersList = Array.isArray(members)
      ? members
          .map(
            m =>
              `- ${m.displayName} (Jira ID/accountId: ${m.accountId}, Role: ${m.role || 'developer'})`
          )
          .join('\n')
      : '';

    const testerId = (members || []).find(m => m.role === 'tester')?.accountId || '';
    const storyCountInstruction = storyCount
      ? `\n# SỐ LƯỢNG STORY MONG MUỐN:\nHãy tạo chính xác (hoặc xấp xỉ) ${storyCount} Story để hoàn thành Epic này.`
      : '';

    const subtaskCount = includeBa ? '3' : '2';
    const subtaskInstructions = includeBa
      ? `1. **[BA] ...** — làm tài liệu, spec, acceptance criteria → assignee: role 'ba'
2. **[DEV] ...** — triển khai code/API/UI → assignee: role 'developer'
3. **[TEST] ...** — checklist, test nghiệp vụ, xác nhận → assignee: role 'tester'`
      : `1. **[DEV] ...** — triển khai code/API/UI → assignee: role 'developer'
2. **[TEST] ...** — checklist, test nghiệp vụ, xác nhận → assignee: role 'tester'`;

    const jsonSubtasksSample = includeBa
      ? `[
        { "summary": "[BA] Làm tài liệu / spec — Báo cáo doanh thu trạm", "description": "...", "issueType": "Sub-task", "estimateHours": 8, "assignee": "accountId BA" },
        { "summary": "[DEV] Triển khai — Báo cáo doanh thu trạm", "description": "...", "issueType": "Sub-task", "estimateHours": 16, "assignee": "accountId Dev" },
        { "summary": "[TEST] Kiểm thử & checklist — Báo cáo doanh thu trạm", "description": "...", "issueType": "Sub-task", "estimateHours": 8, "assignee": "accountId Tester" }
      ]`
      : `[
        { "summary": "[DEV] Triển khai — Báo cáo doanh thu trạm", "description": "...", "issueType": "Sub-task", "estimateHours": 16, "assignee": "accountId Dev" },
        { "summary": "[TEST] Kiểm thử & checklist — Báo cáo doanh thu trạm", "description": "...", "issueType": "Sub-task", "estimateHours": 8, "assignee": "accountId Tester" }
      ]`;

    const systemPrompt = `
Bạn là Technical Project Manager.
Phân tách mục tiêu Epic thành các **Story** (chức năng) và **Sub-task** theo vai trò. KHÔNG tạo Bug.${storyCountInstruction}

# Thành viên:
${membersList}

# QUAN TRỌNG — Story là gì?
- **Story** = tên CHỨC NĂNG / deliverable mà user nhận được (ticket tổng quát).
- Story KHÔNG phải công việc của BA/Dev/Test. KHÔNG đặt tiêu đề Story kiểu "Phân tích...", "Chuẩn hóa yêu cầu...", "Viết spec...", "Kiểm thử...".
- Ví dụ Story ĐÚNG: "Báo cáo doanh thu trạm", "Đồng bộ dữ liệu giao dịch sang bảng mới", "Lọc và xuất Excel báo cáo".
- Ví dụ Story SAI: "Phân tích và chuẩn hóa yêu cầu module báo cáo" (đây là việc của sub-task BA).

# Sub-task (bên trong mỗi Story):
Mỗi Story có đúng ${subtaskCount} sub-task (issueType "Sub-task"):
${subtaskInstructions}

# Story assignee (owner):
- Luôn gán Story cho CÙNG MỘT NGƯỜI với người được gán cho sub-task [TEST] của Story đó.
- Người này bắt buộc phải có role 'tester'.
- Tester là người nhận Story và close khi mọi sub-task xong.

# Cân bằng workload (BẮT BUỘC):
- Nếu có **nhiều người cùng role** (vd: 3 Developer), phải **chia đều** sub-task và giờ ước lượng — không gom hết cho 1 người.
- Mục tiêu: chênh lệch giờ giữa các thành viên **cùng role** không quá ~30%.
- Ví dụ: 6 Story × [DEV] 16h, 3 Dev → mỗi Dev ~2 Story (32h), không phải 1 Dev 96h và 2 Dev 0h.

# Quy tắc khác:
- KHÔNG Bug. estimateHours Story = tổng sub-task.
- Chỉ dùng accountId có trong danh sách thành viên.

# Output JSON (không markdown):
{
  "tickets": [
    {
      "summary": "Báo cáo doanh thu trạm",
      "description": "Mô tả chức năng: user xem/tổng hợp doanh thu theo trạm, kỳ báo cáo...",
      "issueType": "Story",
      "estimateHours": 32,
      "assignee": "${testerId || 'accountId của tester'}",
      "subtasks": ${jsonSubtasksSample}
    }
  ]
}
`;

    const userPrompt = `
Tên kế hoạch: ${planName}
Mục tiêu kế hoạch: ${goal}
`;

    try {
      const model = getSmartModel();
      const content = await llmGenerate(userPrompt, { systemInstruction: systemPrompt, model });

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Invalid AI response format');

      const result = JSON.parse(jsonMatch[0]);
      result.tickets = normalizePlanningTickets(result.tickets, members, includeBa);
      const memberIds = (members || []).map(m => m.accountId).filter(Boolean);
      const wl = computeWorkloadByMember(result.tickets, memberIds);
      result.workload = wl;
      result.workloadBalanced = isPlanningBalanced(result.tickets, members);
      res.json(result);
    } catch (error) {
      console.error('Planning generation failed:', error.message);
      res.status(500).json({ error: 'Failed to generate plan using AI', details: error.message });
    }
  });

  // AI Planning bulk stories decomposition endpoint
  router.post('/api/planning/generate-bulk', authenticateToken, async (req, res) => {
    const { planName, stories, members, businessContext, includeBa = true } = req.body;
    if (!Array.isArray(stories) || stories.length === 0) {
      return res.status(400).json({ error: 'Missing stories list' });
    }

    const membersList = Array.isArray(members)
      ? members
          .map(
            m =>
              `- ${m.displayName} (Jira ID/accountId: ${m.accountId}, Role: ${m.role || 'developer'})`
          )
          .join('\n')
      : '';
    const testerId = (members || []).find(m => m.role === 'tester')?.accountId || '';

    const subtaskCount = includeBa ? '3' : '2';
    const subtaskInstructions = includeBa
      ? `1. **[BA] ...** — làm tài liệu, spec, acceptance criteria → assignee: role 'ba'
2. **[DEV] ...** — triển khai code/API/UI → assignee: role 'developer'
3. **[TEST] ...** — checklist, test nghiệp vụ, xác nhận → assignee: role 'tester'`
      : `1. **[DEV] ...** — triển khai code/API/UI → assignee: role 'developer'
2. **[TEST] ...** — checklist, test nghiệp vụ, xác nhận → assignee: role 'tester'`;

    const jsonSubtasksSample = includeBa
      ? `[
        { "summary": "[BA] Làm tài liệu / spec — Tên Story", "description": "Mô tả chi tiết việc BA cần làm cho story này", "issueType": "Sub-task", "estimateHours": 8, "assignee": "accountId BA" },
        { "summary": "[DEV] Triển khai — Tên Story", "description": "Mô tả kỹ thuật chi tiết việc DEV cần làm cho story này", "issueType": "Sub-task", "estimateHours": 16, "assignee": "accountId Dev" },
        { "summary": "[TEST] Kiểm thử & checklist — Tên Story", "description": "Mô tả chi tiết việc TEST cần làm cho story này", "issueType": "Sub-task", "estimateHours": 8, "assignee": "accountId Tester" }
      ]`
      : `[
        { "summary": "[DEV] Triển khai — Tên Story", "description": "Mô tả kỹ thuật chi tiết việc DEV cần làm cho story này", "issueType": "Sub-task", "estimateHours": 16, "assignee": "accountId Dev" },
        { "summary": "[TEST] Kiểm thử & checklist — Tên Story", "description": "Mô tả chi tiết việc TEST cần làm cho story này", "issueType": "Sub-task", "estimateHours": 8, "assignee": "accountId Tester" }
      ]`;

    const systemPrompt = `
Bạn là Technical Project Manager.
Nhiệm vụ của bạn là nhận vào danh sách các Story (chức năng) đã được định nghĩa sẵn, và tự động tạo ra mô tả chi tiết cho từng Story và sinh đúng ${subtaskCount} Sub-task phù hợp tương ứng cho từng Story theo vai trò. KHÔNG tạo thêm Story mới ngoài danh sách được cung cấp. KHÔNG tạo Bug.

# Thành viên dự án:
${membersList}

# Quy tắc tạo Sub-task (bên trong mỗi Story):
Mỗi Story phải có đúng ${subtaskCount} sub-task (issueType "Sub-task"):
${subtaskInstructions}

# Story assignee (owner):
- Luôn gán Story cho CÙNG MỘT NGƯỜI với người được gán cho sub-task [TEST] của Story đó.
- Người này bắt buộc phải có role 'tester'.
- Tester là người nhận Story và close khi mọi sub-task xong.

# Cân bằng workload (BẮT BUỘC):
- Nếu có **nhiều người cùng role** (vd: 3 Developer), phải **chia đều** sub-task và giờ ước lượng — không gom hết cho 1 người.
- Mục tiêu: chênh lệch giờ giữa các thành viên **cùng role** không quá ~30%.

# Quy tắc khác:
- KHÔNG Bug. estimateHours Story = tổng sub-task.
- Chỉ dùng accountId có trong danh sách thành viên.

# Output JSON (không markdown):
{
  "tickets": [
    {
      "summary": "Tên Story được cung cấp",
      "description": "Mô tả chi tiết và mục tiêu của Story này dựa trên tên Story đầu vào",
      "issueType": "Story",
      "estimateHours": 32,
      "assignee": "${testerId || 'accountId của tester'}",
      "subtasks": ${jsonSubtasksSample}
    }
  ]
}
`;

    const userPrompt = `
Tên kế hoạch: ${planName}
${businessContext ? `Nghiệp vụ / Bối cảnh chung: ${businessContext}\n` : ''}Danh sách các Story cần xử lý:
${stories.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}
`;

    try {
      const model = getSmartModel();
      const content = await llmGenerate(userPrompt, { systemInstruction: systemPrompt, model });

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Invalid AI response format');

      const result = JSON.parse(jsonMatch[0]);
      result.tickets = normalizePlanningTickets(result.tickets, members, includeBa);
      const memberIds = (members || []).map(m => m.accountId).filter(Boolean);
      const wl = computeWorkloadByMember(result.tickets, memberIds);
      result.workload = wl;
      result.workloadBalanced = isPlanningBalanced(result.tickets, members);
      res.json(result);
    } catch (error) {
      console.error('Bulk planning generation failed:', error.message);
      res
        .status(500)
        .json({ error: 'Failed to generate bulk plan using AI', details: error.message });
    }
  });

  // Re-balance assignments endpoint
  router.post('/api/planning/balance', authenticateToken, async (req, res) => {
    const { tickets, members } = req.body;
    if (!Array.isArray(tickets)) {
      return res.status(400).json({ error: 'Missing tickets' });
    }
    const balanced = balancePlanningWorkload(tickets, members || []);
    const memberIds = (members || []).map(m => m.accountId).filter(Boolean);
    const wl = computeWorkloadByMember(balanced, memberIds);
    res.json({
      tickets: balanced,
      workload: wl,
      workloadBalanced: isPlanningBalanced(balanced, members || []),
    });
  });

  // Batch push planning tickets to Jira
  router.post('/api/planning/push', authenticateToken, async (req, res) => {
    req.setTimeout(600000); // Tăng timeout lên 10 phút vì đẩy tuần tự nhiều vé rất chậm
    res.setTimeout(600000);
    const { tickets, startDate, dueDate, members, planName, goal, epicMode, selectedEpicKey } =
      req.body;
    if (!Array.isArray(tickets) || tickets.length === 0) {
      return res.status(400).json({ error: 'Missing tickets list' });
    }

    const projectKey = req.user.jira_project || process.env.JIRA_PROJECT_KEY || 'BXDCSDL';
    const token = await requireUserJiraToken(db, req, res);
    if (!token) return;

    let epicKey = null;

    // Determine epic key based on epicMode and inputs
    const mode = epicMode || (planName && planName.trim() !== '' ? 'create' : 'none');

    if (mode === 'existing') {
      epicKey = selectedEpicKey || null;
      console.log(`Using existing Epic key for plan: ${epicKey}`);
    } else if (mode === 'create' && planName && planName.trim() !== '') {
      console.log(`Creating Epic for plan: ${planName}`);
      const epicData = await createJiraEpic({
        db,
        jiraBaseUrl: process.env.JIRA_URL,
        token,
        httpsAgent,
        projectKey,
        summary: planName,
        description: goal || '',
      });
      epicKey = epicData.key;
      console.log(`Successfully created Epic: ${epicKey}`);
    }

    const balancedTickets = members?.length ? balancePlanningWorkload(tickets, members) : tickets;

    const createdKeys = [];
    if (epicKey) {
      createdKeys.push(epicKey);
    }

    const jiraBaseUrl = process.env.JIRA_URL;
    const pushCtx = {
      token,
      userProject: req.user.jira_project,
      startDate: startDate || null,
      dueDate: dueDate || null,
      pushToJira,
      jiraBaseUrl,
      httpsAgent,
    };

    try {
      for (const t of balancedTickets) {
        const originalEstimateStr = t.estimateHours ? `${t.estimateHours}h` : null;

        const mainResponse = await pushPlanningIssueWithMedia({
          ticket: t,
          parentKey: null,
          assignee: t.assignee || null,
          estimateStr: originalEstimateStr,
          epicLink: epicKey,
          ...pushCtx,
        });

        const mainKey = mainResponse.key;
        createdKeys.push(mainKey);

        if (Array.isArray(t.subtasks) && t.subtasks.length > 0) {
          for (const sub of t.subtasks) {
            const subEstStr = sub.estimateHours ? `${sub.estimateHours}h` : null;
            await pushPlanningIssueWithMedia({
              ticket: sub,
              parentKey: mainKey,
              assignee: sub.assignee || null,
              estimateStr: subEstStr,
              epicLink: null,
              ...pushCtx,
            });
          }
        }
      }

      res.json({ success: true, createdKeys });
    } catch (error) {
      console.error('Failed to push plan to Jira:', error.response?.data || error.message);
      res.status(500).json({
        error: 'Failed to push plan to Jira',
        details: error.response?.data || error.message,
      });
    }
  });

  // Fetch all Epics and children in selected Jira project from DB (pure DB)
  const mapDbRowToJiraFormat = row => {
    if (!row) return null;
    return {
      id: row.key,
      key: row.key,
      fields: {
        summary: row.summary,
        status: {
          name: row.status,
          statusCategory: { key: row.status_category },
        },
        issuetype: {
          name: row.issue_type,
          subtask: row.is_subtask,
        },
        updated: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        created: row.created_at ? new Date(row.created_at).toISOString() : null,
        timeoriginalestimate: row.original_estimate || 0,
        timespent: row.time_spent || 0,
        timeestimate: row.remaining_estimate || 0,
        creator: row.creator ? { displayName: row.creator } : null,
        customfield_10300: row.start_date
          ? new Date(row.start_date).toISOString().split('T')[0]
          : null,
        customfield_10302: row.due_date ? new Date(row.due_date).toISOString().split('T')[0] : null,
        description: row.description || '',
        assignee: row.assignee_name
          ? {
              displayName: row.assignee_name,
            }
          : null,
        parent: row.parent_key ? { key: row.parent_key } : null,
        customfield_10008: row.parent_key,
        customfield_10014: row.parent_key,
        customfield_10201: row.parent_key,
      },
    };
  };

  const loadEpicsFromDb = async pKey => {
    const epicsRes = await db.query(
      `SELECT key, summary, status, status_category, issue_type, is_subtask, assignee_name, creator, start_date, due_date, created_at, updated_at, description
       FROM jira_issues
       WHERE project_key = $1 AND issue_type = 'Epic'
       ORDER BY created_at DESC`,
      [pKey]
    );

    const childrenRes = await db.query(
      `SELECT key, parent_key, summary, status, status_category, issue_type, is_subtask, assignee_name, creator, start_date, due_date, created_at, updated_at, original_estimate, time_spent, remaining_estimate, description
       FROM jira_issues
       WHERE project_key = $1
         AND issue_type != 'Epic'
         AND parent_key IN (
           SELECT key FROM jira_issues WHERE project_key = $1 AND issue_type = 'Epic'
         )`,
      [pKey]
    );

    const epics = epicsRes.rows.map(mapDbRowToJiraFormat);
    const children = childrenRes.rows.map(mapDbRowToJiraFormat);
    return { epics, children };
  };

  router.get('/api/epics', authenticateToken, async (req, res) => {
    try {
      const projectKey =
        req.query.projectKey ||
        (req.user && req.user.jira_project) ||
        process.env.JIRA_PROJECT_KEY ||
        'BXDCSDL';
      const dbData = await loadEpicsFromDb(projectKey);
      res.json(dbData);
    } catch (error) {
      console.error('Failed to load epics from DB:', error.message);
      res.status(500).json({ error: 'Failed to load epics from DB', details: error.message });
    }
  });

  // Create Epic
  router.post('/api/epics', authenticateToken, async (req, res) => {
    try {
      const { summary, description, projectKey: bodyProjectKey } = req.body;
      const projectKey =
        bodyProjectKey ||
        (req.user && req.user.jira_project) ||
        process.env.JIRA_PROJECT_KEY ||
        'BXDCSDL';
      const token = await requireUserJiraToken(db, req, res);
      if (!token) return;

      const epicData = await createJiraEpic({
        db,
        jiraBaseUrl: process.env.JIRA_URL,
        token,
        httpsAgent,
        projectKey,
        summary,
        description,
      });
      await upsertCreatedEpicToDb(epicData, { summary, description, projectKey });
      res.json(epicData);
    } catch (error) {
      console.error('Failed to create Epic:', error.message);
      res.status(500).json({ error: 'Failed to create Epic', details: error.message });
    }
  });

  return router;
};
