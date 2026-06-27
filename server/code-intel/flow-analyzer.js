const { buildChainFromRoute } = require('./dependency-tracer');

const TYPE_LABELS = {
  route: 'Route',
  component: 'Component',
  service: 'Service',
  serviceProxy: 'ServiceProxy',
  controller: 'API Controller',
  appService: 'AppService',
  repository: 'Repository',
  entity: 'Entity',
  endpoint: 'API Endpoint',
};

const analyzeFlow = (graph, rankedNodes, routes) => {
  // Prefer best-matching component over noisy top route (e.g. /app/ → AccountComponent)
  const topScreen = rankedNodes.find((r) => r.node?.type === 'screen' && r.node?.url)?.node;

  const topComponent = rankedNodes.find(
    (r) => r.node?.type === 'component' && r.score >= 5
  )?.node;

  let topRoute =
    rankedNodes.find((r) => {
      if (r.node?.type !== 'route' && r.node?.type !== 'screen') return false;
      const p = String(r.node.path || '').toLowerCase();
      return p && p !== 'app' && p.length >= 3;
    })?.node || null;

  if (topComponent && graph?.edges) {
    for (const e of graph.edges) {
      if (e.to === topComponent.id && e.kind === 'renders') {
        const linked = graph.nodes.find((n) => n.id === e.from && n.type === 'route');
        if (linked) topRoute = linked;
      }
    }
  }

  if (!topRoute && topScreen) {
    topRoute = routes?.find((r) => r.url === topScreen.url) || { url: topScreen.url, path: topScreen.url, component: topScreen.name };
  }
  if (!topRoute) topRoute = routes?.find((r) => r.path && r.path !== 'app') || routes?.[0] || null;

  const chain = topRoute ? buildChainFromRoute(graph, topRoute) : [];
  const expandedNodes = rankedNodes.slice(0, 15).map((r) => r.node);

  const uiFlow = [];
  const apiFlow = [];
  const dbFlow = [];

  for (const n of chain.length ? chain : expandedNodes) {
    if (!n) continue;
    if (['route', 'component', 'service', 'serviceProxy'].includes(n.type)) {
      uiFlow.push({
        type: TYPE_LABELS[n.type] || n.type,
        name: n.name || n.path,
        file: n.file,
        line: n.line,
      });
    }
    if (['controller', 'endpoint', 'appService'].includes(n.type)) {
      apiFlow.push({
        type: TYPE_LABELS[n.type] || n.type,
        name: n.name,
        route: n.abpRoute || n.route,
        permission: n.permission,
        file: n.file,
      });
    }
    if (['repository', 'entity'].includes(n.type)) {
      dbFlow.push({
        type: TYPE_LABELS[n.type] || n.type,
        name: n.name,
        file: n.file,
        hasQuery: n.hasQuery,
      });
    }
  }

  const permissions = [
    ...new Set(
      expandedNodes.map((n) => n.permission).filter(Boolean)
    ),
  ];

  const fields = expandedNodes.find((n) => n.fields)?.fields || topRoute?.fields || null;

  const filters = fields?.filterFields || [];
  const displayFields = [
    ...new Set([
      ...(fields?.tableColumns || []),
      ...(fields?.displayFields || []),
    ]),
  ];

  const summaryLines = [];
  if (topRoute) {
    summaryLines.push(`URL: ${topRoute.url || topRoute.path}`);
    summaryLines.push(`Route file: ${topRoute.file}`);
  }
  const comp = topComponent || chain.find((n) => n.type === 'component') || expandedNodes.find((n) => n.type === 'component');
  if (comp) summaryLines.push(`Component: ${comp.name} (${comp.file})`);
  const ep = chain.find((n) => n.type === 'endpoint') || expandedNodes.find((n) => n.type === 'endpoint');
  if (ep) summaryLines.push(`API: ${ep.abpRoute || ep.route}`);
  if (permissions.length) summaryLines.push(`Permission: ${permissions.join(', ')}`);
  if (displayFields.length) summaryLines.push(`Display fields: ${displayFields.slice(0, 12).join(', ')}`);
  if (filters.length) summaryLines.push(`Filter fields: ${filters.join(', ')}`);

  const flowChain = [...uiFlow, ...apiFlow, ...dbFlow].map((s) => s.name || s.type).filter(Boolean);

  return {
    url: topRoute?.url || topRoute?.path || null,
    route: topRoute,
    component: comp,
    endpoint: ep,
    permissions,
    displayFields,
    filterFields: filters,
    sortFields: fields?.sortFields || [],
    uiFlow,
    apiFlow,
    dbFlow,
    flowChain,
    summaryText: summaryLines.join('\n'),
    chain,
  };
};

module.exports = {
  analyzeFlow,
  TYPE_LABELS,
};
