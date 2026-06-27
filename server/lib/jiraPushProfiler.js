/** Ghi nhận thời gian từng bước khi đẩy ticket lên Jira (debug chậm). */

function nowMs() {
  return Date.now();
}

function createPushProfiler(label = 'pushToJira') {
  const steps = [];
  let t0 = nowMs();

  return {
    step(name, meta) {
      const t = nowMs();
      steps.push({
        name,
        ms: t - t0,
        meta: meta || undefined,
      });
      t0 = t;
    },
    finish(extraMeta) {
      const total = steps.reduce((s, x) => s + x.ms, 0);
      const summary = {
        label,
        totalMs: total,
        steps,
        ...extraMeta,
      };
      if (process.env.JIRA_PUSH_TIMING === '1' || process.env.JIRA_PUSH_TIMING === 'true') {
        console.log(
          `[JiraPushTiming] ${label} ${total}ms — ` +
            steps.map(s => `${s.name}:${s.ms}ms`).join(' | ')
        );
      }
      return summary;
    },
  };
}

module.exports = { createPushProfiler };
