/**
 * Phân loại trạng thái / transition cho thông báo dựa trên jira_workflow_status (đã sync từ Jira).
 * Không đoán tên tiếng Việt — ưu tiên statusCategory từ workflow và từ cột jira_issues.status_category.
 */

function normalizeCategory(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  return v || null;
}

/**
 * @param {ReturnType<import('./jiraWorkflowCache').loadWorkflowCache> | null} cache
 */
function buildWorkflowNotifyIndex(cache) {
  const transitionsByFrom = cache?.statuses || {};
  /** @type {Map<string, { statusCategory: string | null, isCommit: boolean }>} */
  const statusByName = new Map();

  const ensureMeta = statusName => {
    if (!statusName) return null;
    if (!statusByName.has(statusName)) {
      statusByName.set(statusName, { statusCategory: null, isCommit: false });
    }
    return statusByName.get(statusName);
  };

  for (const fromStatus of Object.keys(transitionsByFrom)) {
    ensureMeta(fromStatus);
    const transitions = transitionsByFrom[fromStatus] || [];
    for (const t of transitions) {
      const toName = t.to?.name;
      if (!toName) continue;
      const meta = ensureMeta(toName);
      const cat = normalizeCategory(t.to?.statusCategory);
      if (cat) meta.statusCategory = cat;

      const transitionName = (t.name || '').toLowerCase();
      const toLower = toName.toLowerCase();
      if (transitionName.includes('commit') || toLower.includes('commit')) {
        meta.isCommit = true;
      }
    }
  }

  for (const [name, meta] of statusByName) {
    if (name.toLowerCase().includes('commit')) meta.isCommit = true;
  }

  return {
    hasCache: Object.keys(transitionsByFrom).length > 0,

    findTransition(fromStatus, toStatus) {
      if (!fromStatus || !toStatus) return null;
      const list = transitionsByFrom[fromStatus] || [];
      return list.find(t => t.to?.name === toStatus) || null;
    },

    resolveCategory(statusName, statusCategoryFromIssue) {
      const fromIssue = normalizeCategory(statusCategoryFromIssue);
      if (fromIssue) return fromIssue;
      return statusByName.get(statusName)?.statusCategory || null;
    },

    isDone(statusName, statusCategoryFromIssue) {
      return this.resolveCategory(statusName, statusCategoryFromIssue) === 'done';
    },

    isOpen(statusName, statusCategoryFromIssue) {
      const cat = this.resolveCategory(statusName, statusCategoryFromIssue);
      return cat === 'new' || cat === 'todo';
    },

    isCommit(statusName) {
      const meta = statusByName.get(statusName);
      if (meta?.isCommit) return true;
      return (statusName || '').toLowerCase().includes('commit');
    },

    isReopenTransition(transition) {
      if (!transition) return false;
      const name = (transition.name || '').toLowerCase();
      return (
        name.includes('reopen') ||
        name.includes('re-open') ||
        name.includes('re open') ||
        name.includes('mở lại')
      );
    },

    /** ReOpen: transition tên reopen, hoặc từ done → new theo workflow. */
    isReopenStatus(statusName, prevStatusName, prevCategory, transition) {
      if (this.isReopenTransition(transition)) return true;
      const nowCat = this.resolveCategory(statusName, null);
      const prevCat = this.resolveCategory(prevStatusName, prevCategory);
      return nowCat === 'new' && prevCat === 'done';
    },
  };
}

module.exports = {
  buildWorkflowNotifyIndex,
};
