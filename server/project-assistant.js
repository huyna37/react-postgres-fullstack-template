const fs = require('fs');
const path = require('path');
const skillsStore = require('./skills-store');
const { detectStacks, runCommand } = require('./code-intel/utils');
const { detectQueryIntent, runIntentPlanner, defaultPlan } = require('./services/planner.service');
const { retrieve } = require('./services/retrieval.service');
const { traceFromQuestion } = require('./services/trace.service');
const { synthesizeAnswer } = require('./services/summarizer.service');
const { resolvePage, formatPageAnswer, resolutionToSteps } = require('./services/page-resolver.service');
const {
  resolveField,
  formatFieldAnswer,
  isFieldMappingQuestion,
  resolutionToSteps: fieldResolutionToSteps,
} = require('./services/field-mapper.service');

const REPOS_BASE_DIR = process.env.AI_REPOS_DIR || path.join(__dirname, '../repos');
const MAX_HISTORY_MESSAGES = 16;

const normalizeConversationHistory = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : null;
    const content = String(m?.content ?? '').trim();
    if (!role || !content) continue;
    out.push({ role, content });
  }
  return out.slice(-MAX_HISTORY_MESSAGES);
};

const formatThreadForPlanner = (history, currentQuestion) => {
  const parts = [];
  for (const m of history || []) {
    if (m.role === 'user') parts.push(`Người dùng: ${m.content}`);
    else parts.push(`Trợ lý: ${m.content}`);
  }
  parts.push(`Người dùng (hiện tại): ${currentQuestion}`);
  return parts.join('\n\n');
};

const normalizeSelectedSkillsJson = (raw) => {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.map((x) => String(x || '').trim()).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
};

async function loadExpertSkillsForAssistant(selectedRaw) {
  const list = normalizeSelectedSkillsJson(selectedRaw);
  const maxTotal = Math.max(4000, Number(process.env.AI_MAX_SKILLS_CHARS) || 20000);
  const ms = Number(process.env.AI_MAX_SINGLE_SKILL_CHARS);
  const ma = Number(process.env.AI_MAX_ACTIVE_SKILLS);
  const { activeSkillFiles, expertSkills } = await skillsStore.loadProjectSkillsFromDb(list, {
    maxActiveSkills: Number.isFinite(ma) && ma > 0 ? ma : 12,
    maxSingleSkillChars: Number.isFinite(ms) && ms > 0 ? ms : 8000,
    maxTotalSkillsChars: maxTotal,
  });
  const clip = String(expertSkills || '').slice(0, maxTotal);
  const section = clip.trim() ? `\n## Expert skills\n${clip}\n` : '';
  return { activeSkillFiles, expertSkillsSection: section };
};

const isPageLocateQuestion = (intents) =>
  intents.includes('locate') || intents.includes('routing');

async function answerProjectQuestion({ db, projectId, question, conversationHistory, llmGenerate }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Câu hỏi không được để trống');

  const history = normalizeConversationHistory(conversationHistory);
  const projRes = await db.query('SELECT * FROM app_projects WHERE id = $1', [projectId]);
  if (projRes.rows.length === 0) throw new Error('Không tìm thấy dự án');

  const project = projRes.rows[0];
  const repoPath = project.local_path || path.join(REPOS_BASE_DIR, project.jira_key);

  if (!fs.existsSync(repoPath)) {
    throw new Error('Thư mục mã nguồn chưa có trên server. Hãy vào Projects và Clone/Pull dự án trước.');
  }

  try {
    await runCommand('git rev-parse --is-inside-work-tree', repoPath);
  } catch {
    throw new Error('Thư mục dự án không phải git repository hợp lệ.');
  }

  const stacks = detectStacks(repoPath, project.stack);
  const threadText = formatThreadForPlanner(history, q);
  const projectMeta = `${project.name || ''} (Jira: ${project.jira_key || '?'})`;

  const { activeSkillFiles, expertSkillsSection } = await loadExpertSkillsForAssistant(project.selected_skills);
  const queryIntents = detectQueryIntent(q);

  const planMaybe = await runIntentPlanner(llmGenerate, { projectMeta, threadText, expertSkillsSection });
  const plan = planMaybe || defaultPlan(q);

  const retrievalResult = await retrieve(repoPath, q, plan, stacks);
  const trace = traceFromQuestion(retrievalResult.graph, retrievalResult);

  let synthesized = null;
  let pageResolution = null;
  let fieldResolution = null;

  if (isFieldMappingQuestion(queryIntents, q)) {
    fieldResolution = await resolveField(q, plan, {
      fieldRegistry: retrievalResult.fieldRegistry,
      chunkIndex: retrievalResult.chunkIndex,
      components: retrievalResult.components,
      entities: retrievalResult.entities,
      i18nEntries: retrievalResult.i18nEntries,
      store: retrievalResult.store,
    });

    if (fieldResolution?.entityField || fieldResolution?.dtoField) {
      const answer = formatFieldAnswer(fieldResolution);
      if (answer) {
        synthesized = {
          answer,
          steps: fieldResolutionToSteps(fieldResolution),
          confidence: fieldResolution.confident ? 88 : 72,
          caveats: fieldResolution.ambiguous ? 'Có nhiều property khớp một phần.' : '',
          suggested_follow_ups: [],
          field_resolved: true,
        };
      }
    }
  }

  // Ưu tiên: menu + route + i18n (có căn cứ), không suy từ folder component
  if (!synthesized && isPageLocateQuestion(queryIntents)) {
    pageResolution = await resolvePage(q, plan, {
      pageCatalog: retrievalResult.pageCatalog,
      chunkIndex: retrievalResult.chunkIndex,
      store: retrievalResult.store,
    });

    const pageOk =
      pageResolution?.url &&
      (pageResolution.confident || pageResolution.score >= 1.2);

    if (pageOk) {
      const answer = formatPageAnswer(q, pageResolution);
      if (answer) {
        synthesized = {
          answer,
          steps: resolutionToSteps(pageResolution),
          confidence: pageResolution.ambiguous || pageResolution.lowConfidence
            ? 68
            : Math.min(95, 55 + Math.min(pageResolution.score, 40)),
          caveats: pageResolution.ambiguous
            ? 'Có nhiều trang khớp một phần — xem ứng viên thay thế trong căn cứ.'
            : pageResolution.lowConfidence
              ? 'Chỉ có một nguồn xác nhận — nên kiểm tra lại menu/route.'
              : '',
          suggested_follow_ups: [],
          direct: false,
          page_resolved: true,
        };
      }
    }
  }

  if (!synthesized) {
    const conversationBlock = history
      .map((m) => (m.role === 'user' ? `Người dùng: ${m.content}` : `Trợ lý: ${m.content}`))
      .join('\n\n');

    const traceLines = [];
    if (pageResolution?.url) traceLines.push(`URL (page-resolver): ${pageResolution.url}`);
    else if (trace.url) traceLines.push(`URL: ${trace.url}`);
    if (trace.component?.name) traceLines.push(`Component: ${trace.component.name}`);
    if (pageResolution?.evidence?.length) {
      traceLines.push('Evidence:', ...pageResolution.evidence.map((e) => `- ${e}`));
    }

    synthesized = await synthesizeAnswer(llmGenerate, {
      question: q,
      conversationBlock,
      snippets: retrievalResult.snippets.text,
      planSummary: plan.intent_summary,
      traceBlock: traceLines.join('\n'),
      expertSkillsSection,
      queryIntents,
      answerMode: 'standard',
    });
  }

  if (!synthesized?.answer) throw new Error('Project assistant: không tạo được câu trả lời.');

  return {
    answer: synthesized.answer,
    steps: synthesized.steps || [],
    confidence: synthesized.confidence,
    caveats: synthesized.caveats || '',
    suggested_follow_ups: synthesized.suggested_follow_ups || [],
    answer_mode: fieldResolution?.entityField && synthesized?.field_resolved
      ? 'field-registry'
      : pageResolution?.url && synthesized?.page_resolved
        ? 'hybrid-page'
        : 'semantic',
    page_resolution: pageResolution
      ? {
          url: pageResolution.url,
          component: pageResolution.component,
          permission: pageResolution.permission,
          source: Array.isArray(pageResolution.sources) ? pageResolution.sources.join('+') : 'catalog',
          score: pageResolution.score,
          anchor_ratio: pageResolution.anchorRatio,
          confident: pageResolution.confident,
          evidence: pageResolution.evidence,
          alternatives: pageResolution.alternatives,
        }
      : null,
    clarification_needed: plan.clarification_needed === true,
    plan: {
      intent_summary: plan.intent_summary,
      search_queries: plan.search_concepts,
      layers: plan.layers,
      hypotheses: plan.hypotheses || [],
      page_name_hints: plan.page_name_hints || [],
    },
    sources: retrievalResult.snippets.files.map((f) => ({ file: f })),
    retrieval: {
      mode: pageResolution?.url && synthesized?.page_resolved
        ? 'hybrid-rrf'
        : 'semantic-graph',
      index_schema: retrievalResult.manifest?.schemaVersion || null,
      intent_detected: queryIntents,
      trace: {
        url: pageResolution?.url || trace.url,
        component: pageResolution?.component || trace.component?.name,
        permissions: pageResolution?.permission ? [pageResolution.permission] : trace.permissions,
      },
    },
    files_used: retrievalResult.snippets.files.length,
    raw_fallback: synthesized.raw_fallback ?? false,
  };
}

module.exports = {
  answerProjectQuestion,
};
