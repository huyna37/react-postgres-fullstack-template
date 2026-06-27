/** Lưu nguyên field Jira (wiki string hoặc ADF object → JSON string). */
function jiraFieldToStorage(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/** Chuyển Jira ADF / string → plain text (AI, preview rút gọn). */
function jiraDescriptionToPlain(val) {
  if (val == null) return '';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === 'doc') return jiraDescriptionToPlain(parsed);
      } catch {
        /* wiki / plain string */
      }
    }
    return val;
  }
  if (typeof val === 'object' && val !== null && val.type === 'doc' && Array.isArray(val.content)) {
    const extract = (nodes) => {
      if (!Array.isArray(nodes)) return '';
      return nodes
        .map((n) => {
          if (!n || typeof n !== 'object') return '';
          if (typeof n.text === 'string') return n.text;
          if (Array.isArray(n.content)) return extract(n.content);
          return '';
        })
        .join('');
    };
    return extract(val.content).trim();
  }
  return '';
}

/** Chuẩn hóa comment đã lưu (string hoặc ADF) để trả API */
function normalizeCommentsForResponse(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((c) => ({
      id: c?.id != null ? String(c.id) : '',
      author: {
        displayName: c?.author?.displayName || 'Ẩn danh',
        emailAddress: c?.author?.emailAddress || '',
      },
      body: jiraFieldToStorage(c?.body),
      created: c?.created || null,
    }))
    .filter((c) => c.body || c.created)
    .sort((a, b) => new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime());
}

function buildCommentSourceLabel(sourceType, key, summary) {
  const title = summary ? ` — ${summary}` : '';
  if (sourceType === 'self') return `Ticket này · ${key}${title}`;
  if (sourceType === 'parent') return `Story cha · ${key}${title}`;
  return `Sub-task · ${key}${title}`;
}

function annotateCommentsWithSource(comments, sourceKey, sourceSummary, sourceType) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  return comments.map((c) => ({
    ...c,
    sourceKey,
    sourceSummary: sourceSummary || '',
    sourceType,
    sourceLabel: buildCommentSourceLabel(sourceType, sourceKey, sourceSummary),
  }));
}

function countStoredComments(comments) {
  return normalizeCommentsForResponse(Array.isArray(comments) ? comments : []).length;
}

/** Đếm comment gộp (story + sub-task) — nhẹ hơn aggregate đầy đủ. */
async function countParentFamilyComments(db, parentKey) {
  if (!parentKey) return { count: 0, includeRelated: false };

  const result = await db.query(
    `SELECT key, comments
     FROM jira_issues
     WHERE key = $1
        OR (parent_key = $1 AND is_subtask = true)`,
    [parentKey]
  );

  let count = 0;
  let includeRelated = false;
  for (const row of result.rows) {
    count += countStoredComments(row.comments);
    if (row.key !== parentKey && countStoredComments(row.comments) > 0) {
      includeRelated = true;
    }
  }
  return { count, includeRelated };
}

/** Đếm comment gộp (sub-task + story cha + sibling). */
async function countSubtaskFamilyComments(db, currentKey, parentKey) {
  if (!currentKey || !parentKey) return { count: 0, includeRelated: false };

  const result = await db.query(
    `SELECT key, comments
     FROM jira_issues
     WHERE key = $1
        OR key = $2
        OR (parent_key = $2 AND is_subtask = true)`,
    [currentKey, parentKey]
  );

  let count = 0;
  for (const row of result.rows) {
    count += countStoredComments(row.comments);
  }
  return { count, includeRelated: true };
}

/** Story/Task cha: gộp comment từ story và tất cả sub-task con. */
async function aggregateParentFamilyComments(db, parentKey) {
  if (!parentKey) return [];

  const result = await db.query(
    `SELECT key, summary, comments
     FROM jira_issues
     WHERE key = $1
        OR (parent_key = $1 AND is_subtask = true)
     ORDER BY key`,
    [parentKey]
  );

  const merged = [];
  for (const row of result.rows) {
    const stored = Array.isArray(row.comments) ? row.comments : [];
    const normalized = normalizeCommentsForResponse(stored);
    const sourceType = row.key === parentKey ? 'self' : 'sibling';
    merged.push(
      ...annotateCommentsWithSource(normalized, row.key, row.summary, sourceType)
    );
  }

  return merged.sort(
    (a, b) => new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime()
  );
}

/** Sub-task: gộp comment từ ticket hiện tại, story cha và các sub-task cùng parent. */
async function aggregateSubtaskFamilyComments(db, currentKey, parentKey) {
  if (!currentKey || !parentKey) return [];

  const result = await db.query(
    `SELECT key, summary, comments
     FROM jira_issues
     WHERE key = $1
        OR key = $2
        OR (parent_key = $2 AND is_subtask = true)
     ORDER BY key`,
    [currentKey, parentKey]
  );

  const merged = [];
  for (const row of result.rows) {
    const stored = Array.isArray(row.comments) ? row.comments : [];
    const normalized = normalizeCommentsForResponse(stored);
    let sourceType = 'sibling';
    if (row.key === currentKey) sourceType = 'self';
    else if (row.key === parentKey) sourceType = 'parent';

    merged.push(
      ...annotateCommentsWithSource(normalized, row.key, row.summary, sourceType)
    );
  }

  return merged.sort(
    (a, b) => new Date(b.created || 0).getTime() - new Date(a.created || 0).getTime()
  );
}

/** Từ field `comment` của Jira REST hoặc mảng đã lưu */
function normalizeJiraComments(commentField) {
  if (Array.isArray(commentField)) {
    return normalizeCommentsForResponse(commentField);
  }
  const list = commentField?.comments;
  if (!Array.isArray(list) || list.length === 0) return [];
  return normalizeCommentsForResponse(
    list.map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      created: c.created,
    }))
  );
}

module.exports = {
  jiraFieldToStorage,
  jiraDescriptionToPlain,
  normalizeJiraComments,
  normalizeCommentsForResponse,
  annotateCommentsWithSource,
  countStoredComments,
  countParentFamilyComments,
  countSubtaskFamilyComments,
  aggregateParentFamilyComments,
  aggregateSubtaskFamilyComments,
};
