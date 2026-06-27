const { removeAccents, tokenize, textSimilarity, camelToTokens, normalizePath } = require('./utils');

const WEIGHTS = {
  routeMatch: 10,
  componentMatch: 8,
  semanticSimilarity: 8,
  apiMatch: 6,
  entityMatch: 5,
  htmlFieldMatch: 4,
  permissionMatch: 4,
  menuMatch: 5,
  filePathMatch: 12,
};

const NOISE_TOKENS = new Set([
  'app', 'main', 'page', 'pages', 'component', 'module', 'service', 'the', 'and', 'for',
  'trang', 'man', 'hinh', 'nào', 'nao', 'dau', 'url', 'path',
]);

const isNoiseToken = (t) => NOISE_TOKENS.has(t) || t.length < 3;

const scoreNode = (node, query, embeddingScore = 0) => {
  const q = removeAccents(String(query || '').toLowerCase());
  const qTokens = new Set(tokenize(q).filter((t) => !isNoiseToken(t)));
  let score = 0;
  const reasons = [];

  const name = String(node.name || node.path || '').toLowerCase();
  const nameNoAcc = removeAccents(name);
  const nameTokens = [...tokenize(nameNoAcc), ...camelToTokens(node.name || '')];
  const fileLower = normalizePath(node.file || '').toLowerCase();

  const metaText = [
    node.path,
    node.title,
    node.permission,
    node.label,
    node.key,
    fileLower,
    ...(node.fields?.tableColumns || []),
    ...(node.fields?.displayFields || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // File path is strong signal — transaction-station matches "giao dịch ETC"
  for (const t of qTokens) {
    if (fileLower.includes(t)) {
      score += WEIGHTS.filePathMatch;
      reasons.push(`file:${t}`);
    }
  }

  if (node.type === 'route') {
    const pathStr = String(node.path || '').toLowerCase();
    // Penalize empty/generic routes like "app" or very short
    if (!pathStr || pathStr === 'app' || pathStr.length < 3) {
      score -= 15;
    }
    for (const t of qTokens) {
      if (pathStr.includes(t)) {
        score += WEIGHTS.routeMatch;
        reasons.push(`route:${t}`);
      }
    }
    if (node.title && textSimilarity(q, node.title) > 0.3) {
      score += WEIGHTS.routeMatch * 0.8;
      reasons.push('route-title');
    }
  }

  if (node.type === 'component') {
    for (const t of qTokens) {
      if (name.includes(t)) {
        score += WEIGHTS.componentMatch;
        reasons.push(`component:${t}`);
      }
      for (const np of nameTokens) {
        if (np.includes(t) || t.includes(np)) {
          score += 4;
          reasons.push(`component-part:${np}`);
        }
      }
    }
    // Penalize unrelated generic components
    if (/^account|^login|^home|^dashboard/i.test(node.name || '') && score < 10) {
      score -= 25;
      reasons.push('penalty:generic');
    }
  }

  if (node.type === 'endpoint' || node.type === 'controller' || node.type === 'appService') {
    for (const t of qTokens) {
      if (name.includes(t) || (node.abpRoute && node.abpRoute.toLowerCase().includes(t))) {
        score += WEIGHTS.apiMatch;
        reasons.push(`api:${t}`);
      }
    }
  }

  if (node.type === 'entity') {
    for (const t of qTokens) {
      if (name.includes(t)) {
        score += WEIGHTS.entityMatch;
        reasons.push(`entity:${t}`);
      }
    }
  }

  if (node.permission) {
    for (const t of qTokens) {
      if (node.permission.toLowerCase().includes(t)) {
        score += WEIGHTS.permissionMatch;
        reasons.push(`permission:${t}`);
      }
    }
  }

  if (node.fields) {
    const allFields = [
      ...(node.fields.displayFields || []),
      ...(node.fields.tableColumns || []),
      ...(node.fields.filterFields || []),
    ].map((f) => f.toLowerCase());
    for (const t of qTokens) {
      if (allFields.some((f) => f.includes(t))) {
        score += WEIGHTS.htmlFieldMatch;
        reasons.push(`field:${t}`);
      }
    }
  }

  const sim = textSimilarity(q, `${name} ${metaText} ${nameTokens.join(' ')}`);
  if (sim > 0) {
    score += sim * WEIGHTS.semanticSimilarity;
    if (sim > 0.2) reasons.push(`semantic:${sim.toFixed(2)}`);
  }

  if (embeddingScore > 0) {
    score += embeddingScore * WEIGHTS.semanticSimilarity;
    reasons.push(`embedding:${embeddingScore.toFixed(2)}`);
  }

  if (node.type === 'menuItem') {
    const labelSim = textSimilarity(q, `${node.label || ''} ${node.key || ''}`);
    if (labelSim > 0.2) {
      score += labelSim * WEIGHTS.menuMatch;
      reasons.push('menu');
    }
  }

  return { node, score, reasons };
};

const rankNodes = (nodes, query, embeddingScores = new Map()) => {
  const scored = (nodes || []).map((n) => {
    const emb = embeddingScores.get(n.id) || 0;
    return scoreNode(n, query, emb);
  });
  scored.sort((a, b) => b.score - a.score || (a.node.file || '').localeCompare(b.node.file || ''));
  return scored.filter((s) => s.score > 0);
};

const rankRoutes = (routes, query, embeddingScores = new Map()) => {
  const asNodes = routes.map((r) => ({ ...r, type: 'route', name: r.path || r.segment }));
  return rankNodes(asNodes, query, embeddingScores);
};

module.exports = {
  WEIGHTS,
  scoreNode,
  rankNodes,
  rankRoutes,
};
