const path = require('path');
const { loadGraphStore } = require('../code-intel/graph-store');
const { ensureIndex, buildPageCatalog } = require('../code-intel/index-builder');
const { buildChunkIndex } = require('../code-intel/chunk-index');
const { expandDependencies } = require('../code-intel/dependency-tracer');
const { searchEmbeddings, loadEmbeddings } = require('../code-intel/embedding-store');
const { gitGrepFallback } = require('../code-intel/grep-fallback');
const { selectSnippets } = require('../code-intel/snippet-selector');
const { analyzeFlow } = require('../code-intel/flow-analyzer');
const { hybridSearch } = require('../code-intel/hybrid-retriever');
const { buildQueryProfile } = require('../code-intel/query-profile');
const { normalizePath, readFileSafe, removeAccents } = require('../code-intel/utils');

const MIN_HYBRID_SCORE = 0.008;
const MAX_SEED_NODES = 10;
const MAX_EXPANDED = 35;

const buildSearchQuery = (question, plan) => {
  const parts = [question, ...(plan?.search_concepts || []), ...(plan?.page_name_hints || [])];
  return parts.filter(Boolean).join(' ');
};

const chunkToGraphNode = (chunk) => ({
  id: chunk.id,
  type: chunk.kind,
  name: chunk.title,
  file: chunk.meta?.file || chunk.meta?.routeFile || chunk.meta?.componentFile,
  path: chunk.url,
  url: chunk.url,
  permission: chunk.meta?.permission,
  label: chunk.title,
  key: chunk.meta?.menuKey,
  retrievalScore: 0,
});

const resolveSemantic = async (repoPath, question, plan, stacks) => {
  const indexData = await ensureIndex(repoPath, { stacks });
  const store = indexData.store || loadGraphStore(repoPath);
  const graph = indexData.graph || store.loadGraph();
  const routes = indexData.routes || store.loadRoutes().routes || [];
  const components = indexData.components || store.loadComponents().components || [];
  const menuItems = indexData.menuItems || store.loadMenus().menuItems || [];
  const i18nEntries = indexData.i18nEntries || store.loadI18n().entries || [];

  let pageCatalog = indexData.pageCatalog || store.loadPages().pages || [];
  let chunkIndex = indexData.chunkIndex || store.loadChunks().chunks || [];
  let fieldRegistry = indexData.fieldRegistry || store.loadFieldRegistry();
  const entities = indexData.entities || store.loadEntities().entities || [];

  if (!pageCatalog.length && (menuItems.length || routes.length)) {
    pageCatalog = buildPageCatalog({ menuItems, routes, components, i18nEntries });
  }
  if (!fieldRegistry?.mappings?.length && components.length) {
    const { buildFieldRegistry } = require('../code-intel/field-registry');
    fieldRegistry = buildFieldRegistry({ components, dtos: [], entities, i18nEntries });
  }
  if (!chunkIndex.length && pageCatalog.length) {
    chunkIndex = buildChunkIndex({
      pageCatalog,
      menuItems,
      routes,
      components,
      i18nEntries,
      fieldRegistry,
    });
  }

  const searchQuery = buildSearchQuery(question, plan);
  const profile = buildQueryProfile(question, plan);

  let embeddingScores = new Map();
  try {
    const embIndex = loadEmbeddings(store);
    embeddingScores = await searchEmbeddings(profile.embeddingText, embIndex, 30);
  } catch {
    embeddingScores = new Map();
  }

  const isDataModel = /\b(truong|field|entity|database|db|cot|column|mapping|trung|khop)\b/i.test(
    removeAccents(question.toLowerCase())
  );

  const { results: hybridResults } = hybridSearch(chunkIndex, question, plan, embeddingScores, {
    topK: MAX_SEED_NODES,
    profile,
    kinds: isDataModel ? ['field', 'entity', 'dto', 'component', 'screen'] : undefined,
  });

  const topRanked = hybridResults
    .filter((r) => r.score >= MIN_HYBRID_SCORE)
    .map((r) => ({
      node: chunkToGraphNode(r.chunk),
      score: r.score * 100,
      reasons: r.reasons,
    }));

  let seedIds = topRanked.map((r) => r.node.id);
  if (seedIds.length === 0) {
    seedIds = graph.nodes.slice(0, 5).map((n) => n.id);
  }

  const expanded = expandDependencies(graph, seedIds, {
    maxHops: 5,
    maxNodes: MAX_EXPANDED,
  });

  const rankedMap = new Map(topRanked.map((r) => [r.node.id, r.score]));
  const mergedNodes = expanded.nodes.map((n) => ({
    ...n,
    retrievalScore: rankedMap.get(n.id) || 0,
  }));
  mergedNodes.sort((a, b) => (b.retrievalScore || 0) - (a.retrievalScore || 0) || (a.hop || 0) - (b.hop || 0));

  const topScreen = hybridResults.find((r) => r.chunk?.url && r.chunk.kind === 'screen');
  if (topScreen?.chunk?.meta?.routeFile) {
    const rf = topScreen.chunk.meta.routeFile;
    if (readFileSafe(repoPath, rf)) {
      mergedNodes.unshift({
        id: `file:${rf}`,
        type: 'route-file',
        name: rf,
        file: rf,
        hop: 0,
        retrievalScore: 100,
      });
    }
  }

  const flow = analyzeFlow(graph, topRanked, routes);
  const snippets = selectSnippets(repoPath, mergedNodes);

  const semanticStrong = topRanked.some((r) => r.score >= MIN_HYBRID_SCORE * 100 * 2);

  return {
    graph,
    routes,
    components,
    menuItems,
    i18nEntries,
    pageCatalog,
    chunkIndex,
    fieldRegistry,
    entities,
    store,
    manifest: indexData.manifest || store.loadManifest(),
    ranked: topRanked,
    expandedNodes: mergedNodes,
    flow,
    snippets,
    semanticStrong,
    indexCached: indexData.cached === true,
    searchQuery,
    embeddingHits: embeddingScores.size,
    hybridTop: hybridResults.slice(0, 5),
  };
};

const fallbackGrepRetrieve = async (repoPath, question, plan, stacks) => {
  const signals = [
    question,
    ...(plan?.search_concepts || []),
    ...(plan?.page_name_hints || []),
    ...(plan?.hypotheses || []),
  ];
  const files = await gitGrepFallback(repoPath, signals, stacks);
  const pseudoNodes = files.map((f, i) => ({
    id: `file:${f}`,
    type: 'file',
    name: f,
    file: f,
    hop: i,
  }));
  const snippets = selectSnippets(repoPath, pseudoNodes, { maxChars: 60000 });
  return { files, snippets, fallback: true };
};

const retrieve = async (repoPath, question, plan, stacks, options = {}) => {
  const semantic = await resolveSemantic(repoPath, question, plan, stacks);

  if (!semantic.semanticStrong && options.allowGrepFallback !== false) {
    const grep = await fallbackGrepRetrieve(repoPath, question, plan, stacks);
    if (grep.files.length > 0 && semantic.ranked.length === 0) {
      return {
        ...semantic,
        snippets: grep.snippets,
        grepFallback: true,
        grepFiles: grep.files,
      };
    }
    if (grep.files.length > 0 && semantic.snippets.files.length < 3) {
      const merged = selectSnippets(repoPath, [
        ...semantic.expandedNodes,
        ...grep.files.slice(0, 5).map((f) => ({ id: f, type: 'file', name: f, file: f, hop: 3 })),
      ]);
      return { ...semantic, snippets: merged, grepFallback: true, grepFiles: grep.files };
    }
  }

  return { ...semantic, grepFallback: false, grepFiles: [] };
};

module.exports = {
  retrieve,
  resolveSemantic,
  buildSearchQuery,
};
