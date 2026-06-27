/**
 * Backward-compatible facade — delegates to semantic code intelligence layer.
 * Legacy exports used by ai-agent.js remain available.
 */
const { ensureIndex, rebuildIndexInBackground, buildIndex } = require('./code-intel/index-builder');
const { loadGraphStore } = require('./code-intel/graph-store');
const { rankNodes, rankRoutes } = require('./code-intel/semantic-ranker');
const { tokenize, removeAccents } = require('./code-intel/utils');

/** @deprecated Use semantic graph — kept for ai-agent symbol boost */
const buildCodeIndex = async (repoPath, candidateFiles) => {
  const { graph, components, routes } = await ensureIndex(repoPath);
  const symbols = [];
  for (const r of routes || []) {
    symbols.push({ name: r.path, kind: 'route', line: r.line || 0, file: r.file });
    if (r.component) symbols.push({ name: r.component, kind: 'class', line: 0, file: r.file });
  }
  for (const c of components || []) {
    symbols.push({ name: c.name, kind: 'class', line: c.line || 0, file: c.file });
  }
  for (const n of graph?.nodes || []) {
    if (n.type === 'entity') symbols.push({ name: n.name, kind: 'class', line: n.line || 0, file: n.file });
    if (n.type === 'endpoint') symbols.push({ name: n.abpRoute || n.route, kind: 'endpoint', line: n.line || 0, file: n.file });
  }
  const files = [...new Set(symbols.map((s) => s.file))];
  return { files, symbols };
};

const searchRelevantSymbols = (indexData, text, maxResults = 20) => {
  const tokens = new Set(tokenize(text));
  if (tokens.size === 0) return [];
  const scored = [];
  for (const symbol of indexData?.symbols || []) {
    const nameLower = symbol.name.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (nameLower === token) score += 8;
      else if (nameLower.includes(token)) score += 5;
    }
    if (score > 0) scored.push({ ...symbol, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
};

const searchByPageTitle = (indexData, naturalName, maxResults = 10) => {
  const pseudoNodes = (indexData?.symbols || []).map((s) => ({
    id: s.file,
    type: s.kind === 'route' ? 'route' : 'component',
    name: s.name,
    path: s.kind === 'route' ? s.name : undefined,
    file: s.file,
    line: s.line,
  }));
  return rankNodes(pseudoNodes, naturalName).slice(0, maxResults);
};

const collectFilesFromSymbols = (symbols, limit = 40) => {
  const out = [];
  const seen = new Set();
  for (const symbol of symbols || []) {
    const file = String(symbol.file || '').replace(/\\/g, '/');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
};

module.exports = {
  buildCodeIndex,
  searchRelevantSymbols,
  collectFilesFromSymbols,
  searchByPageTitle,
  ensureIndex,
  rebuildIndexInBackground,
  buildIndex,
  loadGraphStore,
  rankNodes,
  rankRoutes,
};
