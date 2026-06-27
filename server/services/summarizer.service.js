const { extractJsonObject } = require('./planner.service');

const MODE_INSTRUCTIONS = {
  'url-only': `Câu hỏi hỏi URL/path. Trả lời CHỈ URL (một dòng), ví dụ: /app/admin/reports/transaction-station
KHÔNG thêm giải thích, KHÔNG thêm "khả năng cao", KHÔNG thêm section markdown, KHÔNG gợi ý đọc thêm file.`,
  'permission-only': `Trả lời CHỈ tên permission (một dòng), ví dụ: Pages.ETC.Transaction`,
  'api-only': `Trả lời CHỈ API endpoint (một dòng), ví dụ: /api/services/app/EtcTransaction/GetAll`,
  'fields-only': `Trả lời danh sách field ngắn gọn, cách nhau bởi dấu phẩy.`,
  flow: `Giải thích flow ngắn gọn 3-5 dòng.`,
  standard: `Trả lời đúng trọng tâm câu hỏi, ngắn gọn. Không lan man.`,
};

async function synthesizeAnswer(llmGenerate, payload) {
  const {
    question,
    conversationBlock,
    snippets,
    planSummary,
    traceBlock,
    expertSkillsSection = '',
    queryIntents = [],
    answerMode = 'standard',
  } = payload;

  const modeRule = MODE_INSTRUCTIONS[answerMode] || MODE_INSTRUCTIONS.standard;

  const prompt = [
    `Trả lời câu hỏi về codebase. Ngắn gọn, đúng trọng tâm.`,
    modeRule,
    expertSkillsSection ? String(expertSkillsSection).trim() : '',
    traceBlock ? `Bằng chứng:\n${traceBlock}` : '',
    `Câu hỏi: ${question}`,
    snippets ? `Snippet:\n${snippets.slice(0, 40000)}` : '',
    '---',
    `JSON:
{
  "answer": "...",
  "steps": [],
  "confidence": 0-100,
  "confidence_explanation": "",
  "caveats": "",
  "suggested_follow_ups": []
}

QUY TẮC BẮT BUỘC:
- Trả lời đúng những gì được hỏi, không thêm phần không hỏi
- KHÔNG dùng "khả năng cao", "chưa xác định", "cần mở thêm file"
- steps: để mảng rỗng [] trừ khi user hỏi "tại sao" / "giải thích"
- caveats: để rỗng nếu đã trả lời được
- suggested_follow_ups: để mảng rỗng []`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const raw = await llmGenerate(prompt, { label: 'semantic-answer-synthesis' });
  const parsed = extractJsonObject(raw);

  if (parsed && typeof parsed.answer === 'string' && parsed.answer.trim()) {
    return {
      answer: parsed.answer.trim(),
      steps: Array.isArray(parsed.steps)
        ? parsed.steps
            .filter((s) => s && (s.title || s.detail))
            .map((s) => ({
              title: String(s.title || '').trim() || 'Bước',
              detail: String(s.detail || '').trim(),
            }))
            .slice(0, 5)
        : [],
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.min(100, Math.max(0, Math.round(parsed.confidence)))
          : null,
      caveats: String(parsed.caveats || '').trim(),
      suggested_follow_ups: Array.isArray(parsed.suggested_follow_ups)
        ? parsed.suggested_follow_ups.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
        : [],
      raw_fallback: false,
    };
  }

  return {
    answer: String(raw || '').trim(),
    steps: [],
    caveats: '',
    suggested_follow_ups: [],
    raw_fallback: true,
  };
}

module.exports = {
  synthesizeAnswer,
};
