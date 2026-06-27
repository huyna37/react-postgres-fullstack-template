const fs = require('fs');
const { ninerouterEmbeddings } = require('../llm');
const { cosineSimilarity, textSimilarity } = require('./utils');
const { KIND } = require('./chunk-index');

const BATCH_SIZE = 24;
const MAX_EMBED_ITEMS = 1200;

const KIND_PRIORITY = {
  [KIND.FIELD]: 0,
  [KIND.ENTITY]: 1,
  [KIND.DTO]: 2,
  [KIND.SCREEN]: 3,
  [KIND.MENU]: 4,
  [KIND.I18N]: 5,
  [KIND.ROUTE]: 6,
  [KIND.API]: 7,
  [KIND.COMPONENT]: 8,
};

const buildEmbedText = (chunk) => {
  const parts = [chunk.kind, chunk.title, chunk.body, chunk.url];
  return parts.filter(Boolean).join(' ').slice(0, 2500);
};

const loadEmbeddings = (store) => {
  const p = store.indexPath('embeddings');
  return fs.existsSync(p)
    ? JSON.parse(fs.readFileSync(p, 'utf8'))
    : { version: 2, items: [] };
};

const saveEmbeddings = (store, data) => {
  fs.writeFileSync(store.indexPath('embeddings'), JSON.stringify(data, null, 2), 'utf8');
};

const embedBatch = async (texts) => {
  const result = await ninerouterEmbeddings(texts);
  const data = result?.data || [];
  return data.map((d) => d.embedding || null);
};

const selectChunksForEmbedding = (chunks) => {
  const sorted = [...(chunks || [])].sort(
    (a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9)
  );
  return sorted.slice(0, MAX_EMBED_ITEMS);
};

const buildEmbeddingIndex = async (store, chunksOrGraph, options = {}) => {
  const force = options.force === true;
  const existing = loadEmbeddings(store);
  if (!force && existing.items?.length > 0 && existing.version >= 2) return existing;

  const chunks = Array.isArray(chunksOrGraph)
    ? chunksOrGraph
    : selectChunksForEmbedding(
        (chunksOrGraph?.nodes || []).map((n) => ({
          id: n.id,
          kind: n.type,
          title: n.name,
          body: [n.name, n.path, n.label, n.permission].filter(Boolean).join(' '),
        }))
      );

  const toEmbed = selectChunksForEmbedding(chunks);
  const items = [];

  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const texts = batch.map(buildEmbedText);
    const vectors = await embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      items.push({
        id: batch[j].id,
        kind: batch[j].kind,
        text: texts[j],
        vector: vectors[j],
      });
    }
  }

  const data = { version: 2, builtAt: new Date().toISOString(), items };
  saveEmbeddings(store, data);
  return data;
};

const searchEmbeddings = async (query, embeddingIndex, topK = 25) => {
  const result = await ninerouterEmbeddings(query);
  const queryVector = result?.data?.[0]?.embedding || null;

  const scores = new Map();

  if (queryVector) {
    const ranked = [];
    for (const item of embeddingIndex.items || []) {
      if (!item.vector) continue;
      const sim = cosineSimilarity(queryVector, item.vector);
      if (sim > 0.25) ranked.push({ id: item.id, sim });
    }
    ranked.sort((a, b) => b.sim - a.sim);
    for (const r of ranked.slice(0, topK)) scores.set(r.id, r.sim);
  } else {
    for (const item of embeddingIndex.items || []) {
      const sim = textSimilarity(query, item.text);
      if (sim > 0.12) scores.set(item.id, sim);
    }
  }

  return scores;
};

module.exports = {
  buildEmbeddingIndex,
  searchEmbeddings,
  loadEmbeddings,
  buildEmbedText,
  MAX_EMBED_ITEMS,
};
