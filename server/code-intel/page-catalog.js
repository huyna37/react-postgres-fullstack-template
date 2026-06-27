const { removeAccents, tokenize, camelToTokens } = require('./utils');
const { lookupI18n } = require('./i18n-indexer');
const { buildQueryProfile } = require('./query-profile');
const { searchScreens } = require('./hybrid-retriever');
const { KIND } = require('./chunk-index');

const GENERIC_PATHS = new Set(['/app', '/app/']);

const normalizeUrl = (url) => {
  if (!url) return null;
  const u = String(url).trim().replace(/\/+/g, '/');
  const norm = !u.startsWith('/') ? `/app/${u}`.replace(/\/+/g, '/') : u;
  if (GENERIC_PATHS.has(norm)) return null;
  return norm;
};

const findRouteForUrl = (routes, url) =>
  routes.find((r) => normalizeUrl(r.url) === url || (r.path && url.endsWith(r.path))) || null;

const buildSearchText = (parts) =>
  removeAccents(parts.filter(Boolean).join(' ').toLowerCase());

/**
 * Gộp menu + route + component + i18n thành catalog thống nhất (1 URL = 1 page).
 */
const buildPageCatalog = ({ menuItems = [], routes = [], components = [], i18nEntries = [] }) => {
  const byUrl = new Map();

  const ensurePage = (url) => {
    const norm = normalizeUrl(url);
    if (!norm) return null;
    if (!byUrl.has(norm)) {
      byUrl.set(norm, {
        id: `page:${norm}`,
        url: norm,
        component: null,
        componentFile: null,
        menuKey: null,
        menuLabel: null,
        permission: null,
        routeFile: null,
        routeLine: null,
        menuFile: null,
        menuLine: null,
        routeTitle: null,
        sources: new Set(),
        searchParts: [],
      });
    }
    return byUrl.get(norm);
  };

  for (const menu of menuItems) {
    const url = normalizeUrl(menu.routeUrl);
    if (!url) continue;
    const page = ensurePage(url);
    if (!page) continue;
    const i18nLabel = lookupI18n(i18nEntries, menu.nameKey);
    page.menuKey = menu.nameKey || page.menuKey;
    page.menuLabel = menu.label || i18nLabel || page.menuLabel;
    page.permission = menu.permission || page.permission;
    page.menuFile = menu.file;
    page.menuLine = menu.line;
    page.sources.add('menu');
    page.searchParts.push(menu.nameKey, menu.label, i18nLabel, menu.permission, url);

    const route = findRouteForUrl(routes, url);
    if (route) {
      page.component = route.component || page.component;
      page.routeFile = route.file;
      page.routeLine = route.line;
      page.routeTitle = route.title;
      page.permission = page.permission || route.permission;
      page.sources.add('route');
      page.searchParts.push(route.path, route.component, route.title, route.permission);
    }
  }

  for (const route of routes) {
    const url = normalizeUrl(route.url);
    if (!url) continue;
    const page = ensurePage(url);
    if (!page) continue;
    page.component = route.component || page.component;
    page.routeFile = route.file;
    page.routeLine = route.line;
    page.routeTitle = route.title;
    page.permission = page.permission || route.permission;
    page.sources.add('route');
    page.searchParts.push(route.path, route.segment, route.component, route.title, route.permission, url);

    if (page.menuKey) {
      const i18nLabel = lookupI18n(i18nEntries, page.menuKey);
      if (i18nLabel) {
        page.menuLabel = page.menuLabel || i18nLabel;
        page.sources.add('i18n');
        page.searchParts.push(i18nLabel);
      }
    }
  }

  const compByName = new Map(components.map((c) => [c.name, c]));
  for (const page of byUrl.values()) {
    if (page.component && compByName.has(page.component)) {
      const comp = compByName.get(page.component);
      page.componentFile = comp.file;
      page.sources.add('component');
      page.searchParts.push(comp.name, comp.file, comp.selector, ...(comp.injectedServices || []));
    }
    page.searchText = buildSearchText(page.searchParts);
    page.sources = Array.from(page.sources);
  }

  return Array.from(byUrl.values()).filter((p) => p.url && p.searchText.length > 0);
};

const tokenHitInText = (token, text) => {
  const t = removeAccents(token.toLowerCase());
  const body = removeAccents(String(text || '').toLowerCase());
  if (body.includes(t)) return true;
  return camelToTokens(body).some((p) => p.includes(t) || t.includes(p));
};

const countAnchorHits = (anchorTokens, searchText) => {
  if (!anchorTokens.length) return { hits: 0, ratio: 0, matched: [] };
  const matched = anchorTokens.filter((t) => tokenHitInText(t, searchText));
  return {
    hits: matched.length,
    ratio: matched.length / anchorTokens.length,
    matched,
  };
};

const buildEvidence = (page) => {
  const evidence = [];
  if (page.menuKey && page.menuFile) {
    evidence.push(
      `Menu \`${page.menuKey}\`${page.menuLabel ? ` (${page.menuLabel})` : ''} → \`${page.url}\` tại ${page.menuFile}:${page.menuLine || '?'}`
    );
  }
  if (page.routeFile) {
    evidence.push(
      `Route \`${page.url}\` → \`${page.component || '(lazy)'}\` (${page.routeFile}${page.routeLine ? `:${page.routeLine}` : ''})`
    );
  }
  if (page.menuLabel && page.sources.includes('i18n')) {
    evidence.push(`i18n label: "${page.menuLabel}" (key \`${page.menuKey}\`)`);
  }
  if (page.permission) evidence.push(`Permission: \`${page.permission}\``);
  if (page.componentFile) evidence.push(`Component file: ${page.componentFile}`);
  return evidence;
};

/**
 * Chấm điểm tổng quát — không rule cứng theo domain (ETC/report).
 * Dựa vào: anchor coverage (từ câu hỏi), i18n similarity, concept match, số nguồn xác nhận.
 */
const findScreenChunk = (chunkIndex, chunk) => {
  if (!chunk) return null;
  if (chunk.kind === KIND.SCREEN && chunk.url) return chunk;
  const key = chunk.meta?.menuKey || chunk.meta?.key;
  if (key) {
    const linked = chunkIndex.find(
      (c) => c.kind === KIND.SCREEN && (c.meta?.menuKey === key || c.title?.includes(chunk.title))
    );
    if (linked) return linked;
  }
  if (chunk.url) {
    const byUrl = chunkIndex.find((c) => c.kind === KIND.SCREEN && c.url === chunk.url);
    if (byUrl) return byUrl;
  }
  return null;
};

const chunkToPage = (chunk) => ({
  url: chunk.url,
  component: chunk.meta?.component,
  permission: chunk.meta?.permission,
  menuLabel: chunk.title,
  menuKey: chunk.meta?.menuKey,
  sources: chunk.meta?.sources || [],
  menuFile: chunk.meta?.menuFile,
  menuLine: chunk.meta?.menuLine,
  routeFile: chunk.meta?.routeFile,
  routeLine: chunk.meta?.routeLine,
  componentFile: chunk.meta?.componentFile,
});

/**
 * Hybrid retrieval (BM25 + vector RRF) trên chunk index — chuẩn hiện đại.
 */
const resolvePageFromCatalog = (catalog, question, plan, options = {}) => {
  const chunkIndex = options.chunkIndex || [];
  const embeddingScores = options.embeddingScores || new Map();
  const ambiguousRatio = options.ambiguousRatio ?? 0.88;

  if (!chunkIndex.length && catalog?.length) {
    const { buildChunkIndex } = require('./chunk-index');
    return resolvePageFromCatalog(catalog, question, plan, {
      ...options,
      chunkIndex: buildChunkIndex({ pageCatalog: catalog }),
    });
  }

  const { results } = searchScreens(chunkIndex, question, plan, embeddingScores, { topK: 10 });
  if (!results.length) return null;

  const resolved = [];
  for (const hit of results) {
    const screen = findScreenChunk(chunkIndex, hit.chunk);
    if (screen?.url) resolved.push({ hit, screen });
  }
  if (!resolved.length) return null;

  const top = resolved[0];
  const second = resolved[1];
  const page = chunkToPage(top.screen);
  const profile = buildQueryProfile(question, plan);
  const anchor = countAnchorHits(profile.anchorTokens, top.screen.body);
  const sourceCount = page.sources?.length || 0;
  const rrfScore = top.hit.score * 100;
  const ambiguous = second && second.hit.score >= top.hit.score * ambiguousRatio;

  const evidence = [
    ...buildEvidence(page),
    `Hybrid RRF score: ${top.hit.score.toFixed(4)} (lexical + embedding)`,
  ];

  const confident =
    sourceCount >= 2 &&
    (anchor.ratio >= 0.34 || profile.anchorTokens.length === 0) &&
    rrfScore >= 0.015;

  return {
    url: page.url,
    component: page.component,
    permission: page.permission,
    menuLabel: page.menuLabel,
    menuKey: page.menuKey,
    sources: page.sources,
    score: rrfScore,
    evidence,
    sourceCount,
    anchorRatio: anchor.ratio,
    confident: confident && !ambiguous,
    ambiguous,
    lowConfidence: !confident || ambiguous,
    alternatives: ambiguous
      ? resolved.slice(0, 3).map((r) => ({
          url: r.screen.url,
          label: r.screen.title,
          score: r.hit.score * 100,
          sources: r.screen.meta?.sources,
        }))
      : [],
  };
};

module.exports = {
  buildPageCatalog,
  buildQueryProfile,
  resolvePageFromCatalog,
  buildEvidence,
};
