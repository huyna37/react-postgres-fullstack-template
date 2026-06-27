const { normalizePath, removeAccents, tokenize, camelToTokens } = require('../code-intel/utils');

const NOISE_TOKENS = new Set([
  'app', 'main', 'admin', 'page', 'pages', 'component', 'module', 'service',
  'the', 'and', 'for', 'with', 'this', 'that', 'trang', 'man', 'hinh', 'chuc', 'nang',
  'giao', 'dich', // too generic alone — handled via multi-token
]);

const isNoiseToken = (t) => NOISE_TOKENS.has(t) || t.length < 3;

/** Câu hỏi chỉ cần một thông tin cụ thể — trả lời ngắn, không giải thích dài. */
const detectAnswerMode = (question, intents = []) => {
  const q = removeAccents(String(question || '').toLowerCase());

  const asksUrl =
    /\burl\b|\bduong dan\b|\bpath\b|\bo dau\b|\bnam o\b|\bnào\b|\bnào\?|\bwhere\b/.test(q) ||
    (/trang/.test(q) && /(o dau|nam o|url|duong dan)/.test(q));

  const asksPermission = /\bpermission\b|\bquyen\b|\bphan quyen\b/.test(q);
  const asksApi = /\bapi\b|\bendpoint\b/.test(q);
  const asksFields = /\bfield\b|\bcot\b|\bhiển thị\b|\bhien thi\b|\bcolumn\b/.test(q);
  const asksFlow = /\bflow\b|\bluong\b|\bhoat dong\b|\bhoạt động\b|\bfilter\b|\bsort\b|\bloc\b/.test(q);

  if (asksUrl && !asksPermission && !asksApi && !asksFields && !asksFlow) return 'url-only';
  if (asksPermission && !asksUrl && !asksApi && !asksFlow) return 'permission-only';
  if (asksApi && !asksUrl && !asksPermission) return 'api-only';
  if (asksFields && !asksUrl && !asksFlow) return 'fields-only';
  if (asksFlow || intents.includes('feature')) return 'flow';

  if (intents.includes('locate') || intents.includes('routing')) return 'url-only';
  return 'standard';
};

const deriveUrlFromComponentPath = (file) => {
  const f = normalizePath(file || '');
  const m = f.match(/(?:^|\/)(?:angular\/src\/app|src\/app)\/(.+?)\/[^/]+\.component\.(ts|js)$/i);
  if (!m) return null;
  const segments = m[1].split('/').filter((s) => s && !s.startsWith('.'));
  if (segments.length === 0) return null;
  return `/app/${segments.join('/')}`.replace(/\/+/g, '/');
};

const findRouteForComponent = (componentName, routes = [], graph = null) => {
  if (!componentName) return null;

  const direct = routes.find((r) => r.component === componentName);
  if (direct) return direct.url || `/app/${direct.path}`.replace(/\/+/g, '/');

  if (graph?.edges) {
    const compId = graph.nodes?.find((n) => n.type === 'component' && n.name === componentName)?.id;
    if (compId) {
      for (const e of graph.edges) {
        if (e.to === compId && e.kind === 'renders') {
          const routeNode = graph.nodes.find((n) => n.id === e.from && n.type === 'route');
          if (routeNode) return routeNode.url || `/app/${routeNode.path}`.replace(/\/+/g, '/');
        }
      }
    }
  }

  return null;
};

const pickBestComponent = (ranked = [], searchQuery = '') => {
  const qTokens = tokenize(removeAccents(searchQuery)).filter((t) => !isNoiseToken(t));

  let best = null;
  let bestScore = 0;

  for (const r of ranked) {
    if (r.node?.type !== 'component') continue;
    let score = r.score || 0;
    const file = normalizePath(r.node.file || '').toLowerCase();
    const name = String(r.node.name || '').toLowerCase();
    const nameParts = camelToTokens(r.node.name || '');

    for (const t of qTokens) {
      if (file.includes(t)) score += 15;
      if (name.includes(t)) score += 10;
      if (nameParts.some((p) => p.includes(t) || t.includes(p))) score += 8;
    }

    // Penalize generic/unrelated components
    if (/account|login|home|dashboard/i.test(name) && !qTokens.some((t) => name.includes(t))) {
      score -= 20;
    }

    if (score > bestScore) {
      bestScore = score;
      best = r.node;
    }
  }

  return best;
};

const resolveUrl = (trace, ranked, routes, graph, searchQuery) => {
  const comp = pickBestComponent(ranked, searchQuery) || trace.component;

  const fromRoute = findRouteForComponent(comp?.name, routes, graph);
  if (fromRoute && fromRoute !== '/app/' && fromRoute !== '/app') return fromRoute;

  const fromPath = deriveUrlFromComponentPath(comp?.file);
  if (fromPath) return fromPath;

  const topRoute = ranked.find((r) => r.node?.type === 'route' && r.score > 5)?.node;
  if (topRoute?.url && topRoute.url !== '/app/' && topRoute.path !== '') {
    return topRoute.url;
  }

  return trace.url && trace.url !== '/app/' ? trace.url : null;
};

const buildDirectAnswer = (mode, trace, ranked, routes, graph, searchQuery) => {
  const url = resolveUrl(trace, ranked, routes, graph, searchQuery);
  const comp = pickBestComponent(ranked, searchQuery) || trace.component;

  if (mode === 'url-only') {
    if (url) {
      return {
        answer: url,
        steps: [],
        confidence: 90,
        caveats: '',
        suggested_follow_ups: [],
        direct: true,
      };
    }
    if (comp?.file) {
      const derived = deriveUrlFromComponentPath(comp.file);
      if (derived) {
        return { answer: derived, steps: [], confidence: 75, caveats: '', suggested_follow_ups: [], direct: true };
      }
    }
    return null;
  }

  if (mode === 'permission-only') {
    const perms = trace.permissions?.filter(Boolean);
    if (perms?.length) {
      return {
        answer: perms.join(', '),
        steps: [],
        confidence: 85,
        caveats: '',
        suggested_follow_ups: [],
        direct: true,
      };
    }
    return null;
  }

  if (mode === 'api-only' && trace.endpoint) {
    return {
      answer: trace.endpoint.abpRoute || trace.endpoint.route || '',
      steps: [],
      confidence: 85,
      caveats: '',
      suggested_follow_ups: [],
      direct: true,
    };
  }

  if (mode === 'fields-only') {
    const fields = trace.displayFields?.length
      ? trace.displayFields
      : trace.filterFields?.length
        ? trace.filterFields
        : null;
    if (fields?.length) {
      return {
        answer: fields.join(', '),
        steps: [],
        confidence: 80,
        caveats: '',
        suggested_follow_ups: [],
        direct: true,
      };
    }
    return null;
  }

  return null;
};

module.exports = {
  detectAnswerMode,
  deriveUrlFromComponentPath,
  findRouteForComponent,
  pickBestComponent,
  resolveUrl,
  buildDirectAnswer,
};
