const { rankLexical } = require('./lexical-scorer');
const { buildQueryProfile } = require('./query-profile');
const { KIND } = require('./chunk-index');

const RRF_K = 60;

const reciprocalRankFusion = (rankedLists, weights = []) => {
  const fused = new Map();

  rankedLists.forEach((list, listIdx) => {
    const w = weights[listIdx] ?? 1;
    list.forEach((item, rank) => {
      const id = item.chunk?.id || item.id;
      if (!id) return;
      const prev = fused.get(id) || { score: 0, chunk: item.chunk, reasons: [] };
      prev.score += w * (1 / (RRF_K + rank + 1));
      if (item.reason) prev.reasons.push(item.reason);
      fused.set(id, prev);
    });
  });

  return [...fused.entries()]
    .map(([id, v]) => ({ id, score: v.score, chunk: v.chunk, reasons: v.reasons }))
    .sort((a, b) => b.score - a.score);
};

/**
 * Hybrid search: lexical (BM25) + dense (embeddings) → RRF.
 */
const hybridSearch = (chunks, question, plan, embeddingScores = new Map(), options = {}) => {
  const kinds = options.kinds || null;
  const topK = options.topK ?? 15;
  const profile = options.profile || buildQueryProfile(question, plan);

  let pool = chunks || [];
  if (kinds?.length) pool = pool.filter((c) => kinds.includes(c.kind));

  const lexicalRanked = rankLexical(pool, profile).slice(0, topK * 2);
  const lexicalList = lexicalRanked.map((r) => ({
    chunk: r.chunk,
    reason: `lex:${r.score.toFixed(2)}`,
  }));

  const vectorRanked = pool
    .map((chunk) => ({
      chunk,
      vecScore: embeddingScores.get(chunk.id) || 0,
    }))
    .filter((r) => r.vecScore > 0.2)
    .sort((a, b) => b.vecScore - a.vecScore)
    .slice(0, topK * 2)
    .map((r) => ({
      chunk: r.chunk,
      reason: `vec:${r.vecScore.toFixed(2)}`,
    }));

  const fused =
    vectorRanked.length > 0
      ? reciprocalRankFusion([lexicalList, vectorRanked], [1.2, 1])
      : reciprocalRankFusion([lexicalList], [1]);

  return {
    profile,
    results: fused.slice(0, topK),
    lexicalTop: lexicalRanked.slice(0, 5),
  };
};

const searchScreens = (chunks, question, plan, embeddingScores, options = {}) =>
  hybridSearch(chunks, question, plan, embeddingScores, {
    ...options,
    kinds: [KIND.SCREEN, KIND.MENU, KIND.I18N],
    topK: options.topK ?? 8,
  });

module.exports = {
  RRF_K,
  hybridSearch,
  searchScreens,
  reciprocalRankFusion,
};
