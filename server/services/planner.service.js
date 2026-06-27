const { removeAccents } = require('../code-intel/utils');

const detectQueryIntent = (question) => {
  const q = String(question || '').toLowerCase();
  const noAcc = removeAccents(q);
  const intents = [];

  if (
    /\bở đâu\b|\bnằm ở\b|\btìm.*trang\b|\btrang.*nằm\b|\bfile.*đâu\b|\bcomponent.*đâu\b/.test(q) ||
    /\bwhere\b|\blocate\b|\bfind.*page\b|\bfind.*screen\b/.test(q)
  ) {
    intents.push('locate');
  }
  if (/\broute\b|\burl\b|\bpath\b|\bđường dẫn\b|\blink\b|\bnavigat/.test(q) || /\bapp\/|\/#\//.test(q)) {
    intents.push('routing');
  }
  if (/\bpermission\b|\bquyền\b|\bphân quyền\b|\brole\b|\babp\b|\bauthoriz/.test(q)) {
    intents.push('permission');
  }
  if (/\bapi\b|\bendpoint\b|\bcontroller\b|\bservice\b|\bhttp\b/.test(noAcc)) {
    intents.push('api');
  }
  if (
    /\bentity\b|\bmodel\b|\bdbcontext\b|\btable\b|\bbảng\b|\btrường\b|\bfield\b|\bcolumn\b|\bcột\b/.test(noAcc) ||
    /\b(database|db)\b/.test(noAcc) && /\b(trùng|khớp|map|mapping|tương ứng)\b/.test(q)
  ) {
    intents.push('data-model');
  }
  if (/\b(trường|field).*(database|entity|bảng|db)\b/i.test(q) || /\btrong database\b/i.test(q)) {
    intents.push('field-mapping');
  }
  if (/\bchức năng\b|\bfeature\b|\bmàn hình\b|\bmàn\b|\bmodule\b|\bhoạt động\b|\bflow\b|\bluồng\b/.test(q)) {
    intents.push('feature');
  }
  if (/\bfilter\b|\bsearch\b|\bsort\b|\blọc\b|\bsắp xếp\b|\btìm kiếm\b/.test(noAcc)) {
    intents.push('filter-sort');
  }

  return intents;
};

const extractJsonObject = (text) => {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
};

const defaultPlan = (question) => ({
  intent_summary: 'Semantic retrieval — tìm theo graph index và embedding.',
  search_concepts: [String(question || '').slice(0, 200)],
  layers: ['semantic-graph'],
  hypotheses: [],
  page_name_hints: [],
  clarification_needed: false,
});

async function runIntentPlanner(llmGenerate, { projectMeta, threadText, expertSkillsSection = '' }) {
  const skillsBlock = String(expertSkillsSection || '').trim();
  const prompt = `Bạn là Intent Engine cho semantic code intelligence. Chỉ trả về MỘT object JSON.

Dự án: ${projectMeta}
${skillsBlock ? `${skillsBlock}\n` : ''}
Hội thoại + câu hỏi:
${String(threadText || '').slice(0, 6000)}

Phân tích ý định người dùng và trích khái niệm nghiệp vụ (tiếng Việt → tiếng Anh trong code).

JSON schema:
{
  "intent_summary": "1-3 câu tiếng Việt",
  "search_concepts": ["khái niệm 1", "ETCTransaction", "etc-transaction", ...],
  "layers": ["route", "component", "api", "permission", "fields", "flow"],
  "hypotheses": ["giả thuyết về tên component/route/API"],
  "page_name_hints": ["PascalCase hoặc kebab-case có thể trong code"],
  "clarification_needed": false
}

Quy tắc:
- search_concepts: 4–10 khái niệm — bao gồm bản dịch tiếng Anh (TollTransaction, LaneTransaction, ETCTransaction…)
- KHÔNG liệt kê lệnh grep — chỉ khái niệm semantic
- page_name_hints: tên component/route/menu khả năng cao`;

  try {
    const raw = await llmGenerate(prompt, { label: 'semantic-intent-planner' });
    const parsed = extractJsonObject(raw);
    if (parsed && Array.isArray(parsed.search_concepts) && parsed.search_concepts.length) {
      return {
        intent_summary: String(parsed.intent_summary || '').trim() || defaultPlan().intent_summary,
        search_concepts: parsed.search_concepts.map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
        layers: Array.isArray(parsed.layers) ? parsed.layers.map(String) : [],
        hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses.map(String).slice(0, 8) : [],
        page_name_hints: Array.isArray(parsed.page_name_hints)
          ? parsed.page_name_hints.map((s) => String(s).trim()).filter(Boolean).slice(0, 8)
          : [],
        clarification_needed: parsed.clarification_needed === true,
      };
    }
  } catch (e) {
    console.warn('[PlannerService] intent planner:', e?.message);
  }
  return null;
}

module.exports = {
  detectQueryIntent,
  runIntentPlanner,
  defaultPlan,
  extractJsonObject,
};
