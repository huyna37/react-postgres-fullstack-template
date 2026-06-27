const normalizePath = (value) => String(value || '').replace(/\\/g, '/').trim();

const countLines = (text) => String(text || '').split('\n').length;

const validateAndPrepareChanges = (changes, options = {}) => {
  const maxFiles = Math.max(1, Number(options.maxFiles) || 25);
  const maxLinesPerFile = Math.max(20, Number(options.maxLinesPerFile) || 1200);
  const requireReviewComment = options.requireReviewComment !== false;

  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: false, reason: 'No changes returned from model.', prepared: [] };
  }
  if (changes.length > maxFiles) {
    return { ok: false, reason: `Too many changed files (${changes.length}/${maxFiles}).`, prepared: [] };
  }

  const prepared = [];
  const seen = new Set();
  for (const raw of changes) {
    const path = normalizePath(raw?.path);
    if (!path) return { ok: false, reason: 'Change path is missing.', prepared: [] };
    if (seen.has(path)) return { ok: false, reason: `Duplicate change path: ${path}`, prepared: [] };
    seen.add(path);

    const hasContent = Object.prototype.hasOwnProperty.call(raw || {}, 'content');
    const hasEdits = Array.isArray(raw?.edits) && raw.edits.length > 0;
    if (!hasContent && !hasEdits) {
      return { ok: false, reason: `Change "${path}" must include content or edits.`, prepared: [] };
    }

    const reviewComment = String(raw?.review_comment || '').trim();
    if (requireReviewComment && !reviewComment) {
      return { ok: false, reason: `Change "${path}" is missing review_comment.`, prepared: [] };
    }

    const estimatedLines = hasContent
      ? countLines(raw.content)
      : raw.edits.reduce((acc, e) => acc + Math.max(countLines(e?.search || ''), countLines(e?.replace || '')), 0);
    if (estimatedLines > maxLinesPerFile) {
      return { ok: false, reason: `Change "${path}" exceeds line guard (${estimatedLines}/${maxLinesPerFile}).`, prepared: [] };
    }

    prepared.push({
      ...raw,
      path,
      review_comment: reviewComment,
      action_type: hasEdits ? 'scoped_edits' : 'full_content',
      estimated_lines: estimatedLines,
    });
  }

  return { ok: true, reason: '', prepared };
};

module.exports = {
  validateAndPrepareChanges,
};
