/**
 * Per-project "experience" for AI Agent: JSONB on app_projects.ai_project_memory
 * Entries: { at, fix_id, ticket_key, outcome, lesson_vi, files }
 * Read path + write path go through LLM nén (tối đa giảm context) khi bật AI_PROJECT_MEMORY_LLM.
 */

const { llmGenerate } = require('./llm');

const truncate = (s, max) => {
  const t = String(s || '');
  if (!max || t.length <= max) return t;
  return `${t.slice(0, max - 20)}\n… (truncated)`;
};

const stripCodeFences = (s) =>
  String(s || '')
    .replace(/^```[\w]*\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();

const resolveMaxEntries = () => {
  const n = Number(process.env.AI_PROJECT_MEMORY_MAX_ENTRIES);
  return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 25;
};

const resolveMaxLessonChars = () => {
  const n = Number(process.env.AI_PROJECT_MEMORY_MAX_LESSON_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.min(8000, n) : 2200;
};

const isMemoryDisabled = () => String(process.env.AI_PROJECT_MEMORY_DISABLE || '').toLowerCase() === '1';

/** Bật nén LLM (đọc + ghi). Tắt: AI_PROJECT_MEMORY_LLM=0 → fallback cắt chuỗi thô. */
const isMemoryLlmOn = () => String(process.env.AI_PROJECT_MEMORY_LLM || '1').toLowerCase() !== '0';

const resolveLlmReadMax = () => {
  const n = Number(process.env.AI_PROJECT_MEMORY_LLM_READ_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.min(4000, n) : 900;
};

const resolveLlmStoreMax = () => {
  const n = Number(process.env.AI_PROJECT_MEMORY_LLM_STORE_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.min(3000, n) : 700;
};

/** Tổng độ dài raw đưa vào prompt nén (đọc). */
const resolveLlmInputBundleMax = () => {
  const n = Number(process.env.AI_PROJECT_MEMORY_LLM_INPUT_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.min(48000, n) : 12000;
};

/** Dưới ngưỡng này không gọi LLM khi ghi (tiết kiệm). */
const resolveLlmStoreSkipBelow = () => {
  const n = Number(process.env.AI_PROJECT_MEMORY_LLM_STORE_MIN_CHARS);
  return Number.isFinite(n) && n >= 0 ? Math.min(2000, n) : 120;
};

const normalizeMemory = (raw) => {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
};

/** Fallback không LLM: ghép ngắn (vẫn cắt trần). */
const formatProjectMemoryRaw = (arr) => {
  const maxTotal = Math.min(12000, resolveLlmInputBundleMax());
  const lines = [];
  let used = 0;
  for (const e of arr) {
    const ticket = String(e.ticket_key || '?');
    const out = String(e.outcome || '');
    const at = String(e.at || '').slice(0, 19);
    const lesson = truncate(String(e.lesson_vi || ''), 500);
    const block = `[${at}] ${ticket} (${out})\n${lesson}`;
    if (used + block.length + 2 > maxTotal) break;
    lines.push(block);
    used += block.length + 2;
  }
  if (lines.length === 0) return '';
  return ['KINH NGHIỆM DỰ ÁN (raw, chưa nén LLM):', '---', ...lines].join('\n');
};

const bundleRawMemoriesForLlm = (arr) => {
  const parts = [];
  let total = 0;
  const cap = resolveLlmInputBundleMax();
  for (const e of arr) {
    const line = JSON.stringify({
      at: e.at,
      ticket: e.ticket_key,
      outcome: e.outcome,
      files: Array.isArray(e.files) ? e.files.slice(0, 20) : [],
      lesson_vi: truncate(String(e.lesson_vi || ''), 1600),
    });
    if (total + line.length + 1 > cap) break;
    parts.push(line);
    total += line.length + 1;
  }
  return parts.join('\n');
};

const distillWithLlm = async (llmGenerate, systemVi, userPayload, maxOut) => {
  const prompt = `${systemVi}

${userPayload}

Nhiệm vụ: chỉ trả về bản nén cuối cùng (tiếng Việt), không tiêu đề markdown, không bọc \`\`\`. Tối đa khoảng ${maxOut} ký tự Unicode.`;
  const raw = await llmGenerate(prompt, { label: 'project-memory-distill' });
  return truncate(stripCodeFences(raw), maxOut);
};

/**
 * Khối text đưa vào pipeline (đã qua LLM nén theo ticket hiện tại).
 */
const buildProjectMemoryPromptBlock = async ({ db, projectId, ticketDetails, llmGenerate }) => {
  if (isMemoryDisabled()) return '';
  const r = await db.query('SELECT ai_project_memory FROM app_projects WHERE id = $1', [projectId]);
  const arr = normalizeMemory(r.rows[0]?.ai_project_memory);
  if (arr.length === 0) return '';

  if (!isMemoryLlmOn() || typeof llmGenerate !== 'function') {
    return formatProjectMemoryRaw(arr);
  }

  const bundle = bundleRawMemoriesForLlm(arr);
  const ticketCtx = [
    'Ticket hiện tại cần xử lý:',
    `Tiêu đề: ${String(ticketDetails?.summary || '').trim()}`,
    `Mô tả (rút gọn): ${truncate(String(ticketDetails?.description || ''), 2400)}`,
  ].join('\n');

  try {
    const systemVi =
      'Bạn nén "bộ nhớ kinh nghiệm" từ các lần AI Agent fix trước trên CÙNG project/repo. ' +
      'Chỉ giữ ý liên quan ticket HIỆN TẠI: path file quan trọng, lỗi đã gặp, chỗ hay nhầm (vd menu vs navigation service), pattern đúng. ' +
      'Dạng bullet (- ), cực ngắn, không lặp ý, không copy cả đoạn log dài.';
    const distilled = await distillWithLlm(
      llmGenerate,
      systemVi,
      `${ticketCtx}\n\nDữ liệu lịch sử (JSON lines):\n${bundle}`,
      resolveLlmReadMax()
    );
    if (!distilled.trim()) return formatProjectMemoryRaw(arr);
    return `KINH NGHIỆM DỰ ÁN (đã nén bởi AI, dùng để tránh lặp lỗi):\n${distilled}`;
  } catch (e) {
    console.warn('[project-memory] LLM read-distill failed, fallback raw:', e.message);
    return formatProjectMemoryRaw(arr);
  }
};

const buildLessonFromFixRow = (row, ticketDetails = {}) => {
  let planAnalysis = '';
  if (row?.plan) {
    try {
      const p = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
      planAnalysis = (p && p.analysis_vi) || '';
    } catch {
      planAnalysis = '';
    }
  }
  const reasoning = row?.reasoning || '';
  let files = [];
  if (row?.changes) {
    try {
      const ch = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;
      if (Array.isArray(ch)) files = ch.map((c) => c.path).filter(Boolean);
    } catch {
      files = [];
    }
  }
  const summary = ticketDetails?.summary || '';
  const parts = [
    summary && `Ticket (tóm tắt): ${truncate(summary, 400)}`,
    planAnalysis && `Kế hoạch / phân tích: ${truncate(planAnalysis, 900)}`,
    reasoning && `Thực thi (lý do + giải pháp): ${truncate(reasoning, 1200)}`,
    files.length && `File đã chỉnh: ${files.slice(0, 35).join(', ')}`,
  ].filter(Boolean);
  return truncate(parts.join('\n'), resolveMaxLessonChars());
};

const compressLessonForStorage = async (lessonDraft, entryMeta, llmGenerate) => {
  const draft = String(lessonDraft || '').trim();
  if (!draft) return '';
  const maxOut = resolveLlmStoreMax();
  if (!isMemoryLlmOn() || typeof llmGenerate !== 'function') {
    return truncate(draft, maxOut);
  }
  if (draft.length <= resolveLlmStoreSkipBelow()) {
    return truncate(draft, maxOut);
  }
  try {
    const systemVi =
      'Nén bản ghi kinh nghiệm để lưu lâu dài trong DB (bộ nhớ project). ' +
      'Giữ: ticket key, path file quan trọng, 1–3 ý kỹ thuật không được quên. ' +
      'Bỏ: lặp lại, chi tiết dài, log. Tiếng Việt, bullet hoặc câu rất ngắn.';
    const user = `Ticket: ${entryMeta.ticket_key}\nKết quả: ${entryMeta.outcome}\n\nBản nháp:\n${truncate(draft, 8000)}`;
    return await distillWithLlm(llmGenerate, systemVi, user, maxOut);
  } catch (e) {
    console.warn('[project-memory] LLM store compress failed:', e.message);
    return truncate(draft, maxOut);
  }
};

/**
 * Ghi memory; lesson_vi được LLM nén trước khi lưu (khi bật LLM).
 */
const appendProjectMemory = async (db, projectId, entry, { llmGenerate } = {}) => {
  if (isMemoryDisabled()) return;
  const r = await db.query('SELECT ai_project_memory FROM app_projects WHERE id = $1', [projectId]);
  if (r.rows.length === 0) return;
  let arr = normalizeMemory(r.rows[0]?.ai_project_memory);
  const lessonRaw = String(entry.lesson_vi || '');
  const lesson_vi = await compressLessonForStorage(
    lessonRaw,
    { ticket_key: entry.ticket_key, outcome: entry.outcome },
    llmGenerate
  );
  const normalized = {
    at: new Date().toISOString(),
    fix_id: entry.fix_id != null ? Number(entry.fix_id) : null,
    ticket_key: String(entry.ticket_key || '').slice(0, 80),
    outcome: String(entry.outcome || 'unknown').slice(0, 32),
    lesson_vi,
    files: Array.isArray(entry.files) ? entry.files.map((f) => String(f).slice(0, 500)).slice(0, 40) : [],
  };
  arr = [normalized, ...arr].slice(0, resolveMaxEntries());
  await db.query('UPDATE app_projects SET ai_project_memory = $1::jsonb, updated_at = NOW() WHERE id = $2', [
    JSON.stringify(arr),
    projectId,
  ]);
};

module.exports = {
  buildProjectMemoryPromptBlock,
  appendProjectMemory,
  buildLessonFromFixRow,
  normalizeMemory,
};
