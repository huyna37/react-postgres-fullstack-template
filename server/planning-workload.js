const ROLE_FOR_PREFIX = (summary) => {
  if (/^\[BA\]/i.test(summary)) return 'ba';
  if (/^\[TEST\]/i.test(summary)) return 'tester';
  if (/^\[DEV\]/i.test(summary)) return 'developer';
  return 'developer';
};

const groupMembersByRole = (members) => {
  const byRole = { ba: [], developer: [], tester: [] };
  for (const m of members || []) {
    const id = m.accountId;
    if (!id) continue;
    const role = ['ba', 'developer', 'tester'].includes(m.role) ? m.role : 'developer';
    if (!byRole[role].includes(id)) byRole[role].push(id);
  }
  return byRole;
};

/**
 * Phân công lại sub-task / story sao cho mỗi role được chia đều giờ (least-loaded).
 */
const balancePlanningWorkload = (tickets, members) => {
  const byRole = groupMembersByRole(members);
  const hours = {};
  const storyCount = {};

  for (const m of members || []) {
    if (m.accountId) {
      hours[m.accountId] = 0;
      storyCount[m.accountId] = 0;
    }
  }

  const pickLeastLoaded = (role) => {
    const ids = byRole[role] || [];
    if (!ids.length) return '';
    let best = ids[0];
    for (const id of ids) {
      if ((hours[id] || 0) < (hours[best] || 0)) best = id;
    }
    return best;
  };

  const pickTesterForStory = () => {
    const ids = byRole.tester || [];
    if (!ids.length) return pickLeastLoaded('ba') || pickLeastLoaded('developer') || '';
    let best = ids[0];
    for (const id of ids) {
      const score = (storyCount[id] || 0) * 100 + (hours[id] || 0);
      const bestScore = (storyCount[best] || 0) * 100 + (hours[best] || 0);
      if (score < bestScore) best = id;
    }
    return best;
  };

  return (Array.isArray(tickets) ? tickets : []).map((ticket) => {
    const subtasks = (ticket.subtasks || []).map((sub) => {
      const role = ROLE_FOR_PREFIX(sub.summary);
      const assignee = pickLeastLoaded(role) || sub.assignee || '';
      const est = Math.max(0, Number(sub.estimateHours) || 0);
      if (assignee) hours[assignee] = (hours[assignee] || 0) + est;
      return { ...sub, assignee };
    });

    const storyOwner = pickTesterForStory();
    if (storyOwner) storyCount[storyOwner] = (storyCount[storyOwner] || 0) + 1;

    return {
      ...ticket,
      assignee: storyOwner || ticket.assignee,
      subtasks,
    };
  });
};

const computeWorkloadByMember = (tickets, memberIds) => {
  const map = {};
  for (const id of memberIds) map[id] = 0;

  for (const t of tickets || []) {
    if (t.subtasks?.length) {
      for (const sub of t.subtasks) {
        if (sub.assignee && map[sub.assignee] != null) {
          map[sub.assignee] += Number(sub.estimateHours) || 0;
        }
      }
    } else if (t.assignee && map[t.assignee] != null) {
      map[t.assignee] += Number(t.estimateHours) || 0;
    }
  }
  return map;
};

/** Workload theo từng role — dùng để đánh giá cân bằng (Dev vs Dev, không so Dev vs BA). */
const computeWorkloadByRole = (tickets, members) => {
  const byRole = {};
  for (const m of members || []) {
    const role = ['ba', 'developer', 'tester'].includes(m.role) ? m.role : 'developer';
    if (!byRole[role]) byRole[role] = {};
    byRole[role][m.accountId] = 0;
  }
  for (const t of tickets || []) {
    for (const sub of t.subtasks || []) {
      if (!sub.assignee || !byRole) continue;
      const role = ROLE_FOR_PREFIX(sub.summary);
      if (byRole[role] && byRole[role][sub.assignee] != null) {
        byRole[role][sub.assignee] += Number(sub.estimateHours) || 0;
      }
    }
  }
  return byRole;
};

const workloadImbalanceRatio = (workloads) => {
  const vals = Object.values(workloads || {}).filter((v) => v >= 0);
  if (vals.length < 2) return 1;
  const max = Math.max(...vals);
  const min = Math.min(...vals.filter((v) => v > 0));
  if (max === 0) return 1;
  if (min === 0 || min === undefined) return max > 0 ? 99 : 1;
  return max / min;
};

const isPlanningBalanced = (tickets, members, maxRatio = 1.35) => {
  const byRole = computeWorkloadByRole(tickets, members);
  return Object.values(byRole).every((wl) => {
    const active = Object.values(wl).filter((h) => h > 0);
    if (active.length <= 1) return true;
    return workloadImbalanceRatio(wl) <= maxRatio;
  });
};

module.exports = {
  balancePlanningWorkload,
  computeWorkloadByMember,
  computeWorkloadByRole,
  workloadImbalanceRatio,
  isPlanningBalanced,
  ROLE_FOR_PREFIX,
};
