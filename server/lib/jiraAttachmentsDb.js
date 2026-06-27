/** Chuẩn hóa metadata attachment từ Jira REST → lưu JSONB. */
function normalizeJiraAttachments(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const att of list) {
    const filename = String(att?.filename || '').trim();
    if (!filename) continue;
    out.push({
      id: att.id != null ? String(att.id) : null,
      filename,
      mimeType: att.mimeType || null,
      size: Number(att.size) || 0,
      content: att.content || null,
      thumbnail: att.thumbnail || null,
      hasThumbnail: !!att.thumbnail,
    });
  }
  return out;
}

function normalizeFilename(name) {
  return String(name || '').trim().toLowerCase();
}

/** Map filename → attachment row (cho proxy ảnh). */
function attachmentIndexFromStored(stored) {
  const byName = new Map();
  const list = Array.isArray(stored) ? stored : [];
  for (const att of list) {
    const filename = String(att?.filename || '').trim();
    if (!filename) continue;
    byName.set(normalizeFilename(filename), {
      id: att.id,
      filename,
      mimeType: att.mimeType || null,
      content: att.content || null,
      thumbnail: att.thumbnail || null,
      size: att.size || 0,
    });
  }
  return byName;
}

function attachmentsForApiResponse(stored) {
  return normalizeJiraAttachments(stored).map(a => ({
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    hasThumbnail: a.hasThumbnail,
  }));
}

module.exports = {
  normalizeJiraAttachments,
  attachmentIndexFromStored,
  attachmentsForApiResponse,
  normalizeFilename,
};
