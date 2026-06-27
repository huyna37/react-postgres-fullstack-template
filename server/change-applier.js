const fs = require('fs');
const path = require('path');

const normalizePath = (p) => String(p || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');

/**
 * File thật có thể nằm dưới `angular/src/...` trong khi model trả `src/...` hoặc ngược lại.
 */
const resolveRepoRelativePath = (repoPath, relPath) => {
  const base = normalizePath(relPath);
  if (!base) return base;
  const exists = (p) => p && fs.existsSync(path.join(repoPath, p));
  if (exists(base)) return base;
  const alts = new Set();
  if (!/^angular\//i.test(base)) alts.add(`angular/${base}`);
  if (/^angular\//i.test(base)) alts.add(base.replace(/^angular\//i, ''));
  for (const prefix of ['angular/', 'client/', 'frontend/']) {
    if (!base.toLowerCase().startsWith(prefix)) alts.add(prefix + base);
  }
  for (const p of alts) {
    if (exists(p)) return p;
  }
  return base;
};

const stripBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const normalizeSmartQuotes = (s) =>
  String(s || '')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"');

const normNewlines = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const collectQuotedNeedlesFromEdits = (edits) => {
  const out = [];
  for (const e of edits || []) {
    const s = String(e?.search || '');
    const re = /'([^']{4,160})'/g;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[1]);
  }
  return [...new Set(out)];
};

const mergeIntervals = (intervals) => {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const iv of sorted) {
    const a = iv[0];
    const b = iv[1];
    if (!merged.length || a > merged[merged.length - 1][1] + 1) merged.push([a, b]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
  }
  return merged;
};

const sliceLinesNumbered = (lines, from0, to0) => {
  const from = Math.max(0, from0);
  const to = Math.min(lines.length, to0);
  const parts = [];
  for (let i = from; i < to; i++) parts.push(`${i + 1}: ${lines[i]}`);
  return parts.join('\n');
};

/**
 * Khi patch fail, LLM thường nhìn truncate đầu file và bỏ lỡ vùng menu. Gom đoạn có số dòng thật quanh needle / AppMenuItem.
 */
const buildEditFailureAnchoredContext = (existingRaw, failedEdits, maxChars = 24000) => {
  const text = normNewlines(existingRaw);
  const lines = text.split('\n');
  const needles = collectQuotedNeedlesFromEdits(failedEdits);
  const intervals = [];

  for (const needle of needles) {
    if (!needle || !text.includes(needle)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) {
        intervals.push([Math.max(0, i - 30), Math.min(lines.length, i + 30)]);
        break;
      }
    }
  }

  if (intervals.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      if (/AppMenuItem\s*\(/.test(lines[i]) || /new\s+AppMenuItem/.test(lines[i])) {
        intervals.push([Math.max(0, i - 4), Math.min(lines.length, i + 36)]);
      }
    }
  }

  const merged = mergeIntervals(intervals).slice(0, 14);
  let out =
    '=== ĐOẠN FILE CÓ SỐ DÒNG (bắt buộc copy search từ đây, khớp từng khoảng trắng) ===\n\n';
  for (const [a, b] of merged) {
    out += `${sliceLinesNumbered(lines, a, b)}\n\n---\n\n`;
    if (out.length > maxChars) break;
  }
  const missing = needles.filter((n) => n && !text.includes(n));
  if (missing.length) {
    out += `\nChú ý: các chuỗi sau có trong block search LLM nhưng KHÔNG có trong file: ${missing.join(
      ', '
    )} — không dùng lại search cũ; chọn đúng khối code trong các đoạn có số dòng phía trên.\n`;
  }
  return out.slice(0, maxChars);
};

/** Chuẩn hoá LF khi khớp patch; giữ CRLF/BOM khi ghi lại (repo Windows / VS). */
const applyEdits = (content, edits, filePath = 'unknown') => {
  const hadBom = content && content.charCodeAt(0) === 0xfeff;
  let work = stripBom(String(content ?? ''));
  const hadCRLF = /\r\n/.test(work);
  work = work.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  work = normalizeSmartQuotes(work);

  for (const edit of edits || []) {
    if (!edit.search || edit.replace === undefined) continue;
    const search = normalizeSmartQuotes(String(edit.search).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    const replace = normalizeSmartQuotes(String(edit.replace).replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    const occurrences = work.split(search).length - 1;
    if (occurrences === 0) {
      throw new Error(`[Edit Error] Không tìm thấy đoạn code cần thay đổi trong file ${filePath}. Hãy đảm bảo đoạn "search" khớp chính xác từng khoảng trắng và xuống dòng.\n\nĐoạn cần tìm:\n${edit.search}`);
    }
    if (occurrences > 1) {
      throw new Error(`[Edit Error] Đoạn code cần thay đổi không duy nhất trong file ${filePath} (tìm thấy ${occurrences} chỗ khớp). Hãy cung cấp thêm context xung quanh để định vị chính xác.`);
    }
    work = work.replace(search, replace);
  }

  let out = work;
  if (hadCRLF) out = out.replace(/\n/g, '\r\n');
  if (hadBom) out = `\uFEFF${out}`;
  return out;
};

const convertLargeFileRewriteToScopedEdits = async ({
  change,
  existingContent,
  ticketKey,
  stack,
  llmGenerate,
  generateContentWithRetry,
  extractJsonFromModelResponse,
  truncateText,
}) => {
  const refinePrompt = `
  Bạn đang sửa file lớn: ${change.path}
  Ticket: ${ticketKey}
  Stack: ${stack}

  Thay vì trả full content, hãy trả scoped edits tối thiểu.

  CURRENT FILE CONTENT:
  ${truncateText(existingContent, 22000)}

  PROPOSED NEW FULL CONTENT:
  ${truncateText(change.content || '', 22000)}

  Trả về JSON:
  {
    "edits": [
      { "search": "exact old block", "replace": "exact new block" }
    ],
    "review_comment": "Tóm tắt ngắn thay đổi chính"
  }
  Rules:
  - search phải khớp chính xác.
  - edits phải là minimal diff.
  - Output JSON only.
  `;
  const smartModel = require('./llm').getSmartModel();
  const refineText = await generateContentWithRetry(() => llmGenerate(refinePrompt, { model: smartModel }), { label: 'scope-edit' });
  const refineData = extractJsonFromModelResponse(refineText);
  if (!refineData || !Array.isArray(refineData.edits) || refineData.edits.length === 0) {
    return change;
  }
  return {
    ...change,
    edits: refineData.edits,
    review_comment: String(refineData.review_comment || change.review_comment || '').trim(),
    content: undefined,
  };
};

const applyChangesWithRefinement = async ({
  repoPath,
  changes,
  ticketKey,
  stackLabel,
  shouldPreferScopedEdits,
  updateFixStep,
  fixId,
  llmGenerate,
  generateContentWithRetry,
  extractJsonFromModelResponse,
  truncateText,
}) => {
  const applied = [];
  for (const originalChange of changes || []) {
    let change = { ...originalChange, path: resolveRepoRelativePath(repoPath, originalChange.path) };
    if (change.path !== originalChange.path) {
      await updateFixStep(
        fixId,
        'Applying Changes',
        `Đường dẫn đã resolve: ${normalizePath(originalChange.path)} → ${change.path}`
      );
    }
    const fullPath = path.join(repoPath, change.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    if (change.content !== undefined) {
      if (fs.existsSync(fullPath)) {
        const existing = fs.readFileSync(fullPath, 'utf8');
        if (shouldPreferScopedEdits(existing, change)) {
          await updateFixStep(fixId, 'Scoped Edit', `Converting full rewrite to scoped edits for ${change.path}...`);
          change = await convertLargeFileRewriteToScopedEdits({
            change,
            existingContent: existing,
            ticketKey,
            stack: stackLabel,
            llmGenerate,
            generateContentWithRetry,
            extractJsonFromModelResponse,
            truncateText,
          });
        }
      }
      if (change.content !== undefined) {
        fs.writeFileSync(fullPath, change.content);
      }
    } else if (Array.isArray(change.edits)) {
      if (!fs.existsSync(fullPath)) throw new Error(`Cannot apply edits to non-existent file: ${change.path}`);
      const existing = fs.readFileSync(fullPath, 'utf8');
      try {
        const updated = applyEdits(existing, change.edits, change.path);
        fs.writeFileSync(fullPath, updated);
      } catch (err) {
        await updateFixStep(
          fixId,
          'Edit Refinement',
          `Failed to apply edits to ${change.path}. Asking AI to fix search blocks (anchored context)...`
        );
        const anchorCtx = buildEditFailureAnchoredContext(existing, change.edits, 14000);
        const headSnippet =
          existing.length > 32000
            ? `\n(Đầu file — tham khảo; vùng cần sửa thường nằm dưới, ưu tiên khối ANCHOR có số dòng phía trên)\n${truncateText(existing, 5000)}`
            : `\nToàn bộ file:\n${existing}`;

        let lastErr = err;
        let fixed = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const retryHint =
            attempt > 0
              ? `\n\nLần refine trước vẫn không apply được:\n${lastErr.message}\nHãy copy "search" đúng từng ký tự từ khối ANCHOR (chỉ nội dung dòng, KHÔNG gồm tiền tố kiểu "123: ").`
              : '';
          const refinementPrompt = `
        Bạn đang sửa file ${change.path} — apply patch lỗi:
        ${err.message}
        ${retryHint}

        ${anchorCtx}
        ${headSnippet}

        Quy tắc:
        - "search" phải là đoạn liên tục trích đúng từ nội dung file (KHỚP CHÍNH XÁC từng khoảng trắng/tab/xuống dòng). Nếu có khối "số dòng: nội dung" ở ANCHOR thì search chỉ chứa phần nội dung sau ": ".
        - Tuyệt đối không tự ý thêm/bớt dấu phẩy, dấu ngoặc nếu file gốc không có.
        - **Common Pitfalls (CẢNH BÁO)**: 
            1. Không tự ý thay đổi số lượng tham số trong constructor (vd: new AppMenuItem) trừ khi ticket yêu cầu.
            2. Không "phát minh" ra các field mới không có trong code hiện tại.
            3. Quan sát các dòng xung quanh (neighbors) để bắt chước đúng style và số tham số.
        - Không bịa route/permission/icon không xuất hiện trong ANCHOR hoặc file.
        - Chỉ trả MỘT object JSON hợp lệ, không markdown, không code fence, không chữ giải thích trước/sau JSON (parser sẽ lỗi nếu có text thừa).
        - Trả về JSON duy nhất: { "edits": [ { "search": "...", "replace": "..." } ], "review_comment": "tùy chọn" }
        `;
          const label = attempt === 0 ? 'refine-edit' : 'refine-edit-2';
          const smartModel = require('./llm').getSmartModel();
          const refinementText = await generateContentWithRetry(() => llmGenerate(refinementPrompt, { model: smartModel }), { label });
          const refinementData = extractJsonFromModelResponse(refinementText);
          if (!refinementData || !Array.isArray(refinementData.edits) || refinementData.edits.length === 0) {
            lastErr = new Error('Refinement JSON không hợp lệ hoặc edits rỗng');
            continue;
          }
          try {
            const updated = applyEdits(existing, refinementData.edits, change.path);
            fs.writeFileSync(fullPath, updated);
            change = {
              ...change,
              edits: refinementData.edits,
              review_comment: String(
                refinementData.review_comment || change.review_comment || ''
              ).trim(),
            };
            fixed = true;
            break;
          } catch (e2) {
            lastErr = e2;
          }
        }
        if (!fixed) throw lastErr;
      }
    }

    applied.push(change);
    await updateFixStep(fixId, 'Applying Changes', `Đã cập nhật thành công file: ${change.path}`);
  }
  return applied;
};

module.exports = {
  applyChangesWithRefinement,
};
