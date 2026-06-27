const { textSimilarity } = require('./utils');

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const termFreq = (tokens) => {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
};

/**
 * BM25-lite trên corpus nhỏ (chunks) — chuẩn lexical retrieval.
 */
const scoreBM25 = (queryTokens, docTokens, avgDocLen) => {
  if (!queryTokens.length || !docTokens.length) return 0;
  const tf = termFreq(docTokens);
  const docLen = docTokens.length;
  let score = 0;

  for (const qt of queryTokens) {
    const freq = tf.get(qt) || 0;
    if (freq === 0) continue;
    const idf = Math.log(1 + 1 / (freq * 0.5 + 0.5));
    const num = freq * (BM25_K1 + 1);
    const den = freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / (avgDocLen || 1)));
    score += idf * (num / den);
  }
  return score;
};

const scoreChunkLexical = (chunk, profile, avgDocLen) => {
  const queryTokens = profile.expandedTokens;
  let score = scoreBM25(queryTokens, chunk.tokens, avgDocLen);

  for (const anchor of profile.anchorTokens) {
    if (chunk.tokens.includes(anchor) || chunk.body.includes(anchor)) score += 4;
  }

  for (const phrase of profile.phrases || []) {
    if (chunk.body.includes(phrase)) score += 8;
  }

  const sim = textSimilarity(profile.questionNorm, chunk.body);
  score += sim * 12;

  if (chunk.kind === 'screen' && chunk.meta?.sources?.includes('menu')) score += 3;
  if (chunk.kind === 'screen' && chunk.meta?.sources?.includes('route')) score += 2;

  return score;
};

const rankLexical = (chunks, profile) => {
  if (!chunks.length) return [];
  const avgDocLen =
    chunks.reduce((s, c) => s + (c.tokens?.length || 0), 0) / Math.max(chunks.length, 1);

  return chunks
    .map((chunk) => ({
      chunk,
      score: scoreChunkLexical(chunk, profile, avgDocLen),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
};

module.exports = {
  scoreBM25,
  scoreChunkLexical,
  rankLexical,
};
