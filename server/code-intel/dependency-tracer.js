const { makeNodeId } = require('./utils');

const DEFAULT_MAX_HOPS = 6;
const DEFAULT_MAX_NODES = 40;

/**
 * Expand from seed node IDs along graph edges (BFS).
 */
const expandDependencies = (graph, seedNodeIds, options = {}) => {
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const kinds = options.edgeKinds || null;

  const nodesById = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const outEdges = new Map();
  const inEdges = new Map();

  for (const e of graph.edges || []) {
    if (kinds && !kinds.includes(e.kind)) continue;
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from).push(e);
    if (!inEdges.has(e.to)) inEdges.set(e.to, []);
    inEdges.get(e.to).push(e);
  }

  const visited = new Map(); // id -> hop
  const queue = [];

  for (const id of seedNodeIds || []) {
    if (nodesById.has(id)) {
      visited.set(id, 0);
      queue.push(id);
    }
  }

  // Also match by partial name if exact id missing
  for (const id of seedNodeIds || []) {
    if (visited.has(id)) continue;
    const namePart = id.includes(':') ? id.split(':')[1]?.split('@')[0] : id;
    for (const n of graph.nodes || []) {
      if (n.name && namePart && n.name.toLowerCase() === namePart.toLowerCase()) {
        if (!visited.has(n.id)) {
          visited.set(n.id, 0);
          queue.push(n.id);
        }
      }
    }
  }

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift();
    const hop = visited.get(current);
    if (hop >= maxHops) continue;

    const edges = [...(outEdges.get(current) || []), ...(inEdges.get(current) || [])];
    for (const e of edges) {
      const next = e.from === current ? e.to : e.from;
      if (!visited.has(next) && nodesById.has(next)) {
        visited.set(next, hop + 1);
        queue.push(next);
      }
    }
  }

  const nodes = [];
  for (const [id, hop] of visited) {
    const n = nodesById.get(id);
    if (n) nodes.push({ ...n, hop });
  }
  nodes.sort((a, b) => a.hop - b.hop || (a.type || '').localeCompare(b.type || ''));

  const edgeSet = new Set(visited.keys());
  const edges = (graph.edges || []).filter((e) => edgeSet.has(e.from) && edgeSet.has(e.to));

  return { nodes, edges };
};

const buildChainFromRoute = (graph, routeNode) => {
  const chain = [];
  if (!routeNode) return chain;

  const { nodes } = expandDependencies(graph, [routeNode.id], { maxHops: 5, maxNodes: 25 });
  const order = ['route', 'component', 'service', 'serviceProxy', 'controller', 'appService', 'repository', 'entity', 'endpoint'];
  for (const type of order) {
    const found = nodes.find((n) => n.type === type);
    if (found) chain.push(found);
  }
  return chain;
};

const linkServiceProxyToBackend = (graph, components, endpoints, serviceProxies = []) => {
  const edges = [...(graph.edges || [])];

  for (const comp of components) {
    for (const svc of comp.injectedServices || []) {
      const svcId = makeNodeId('service', svc);
      const proxyName = svc.replace(/Service$/, 'ServiceProxy');
      const ep = endpoints.find(
        (e) =>
          e.controller?.replace(/Controller$/, '') === svc.replace(/ServiceProxy$/, '').replace(/Service$/, '') ||
          e.abpRoute?.toLowerCase().includes(svc.replace(/ServiceProxy$/, '').toLowerCase())
      );
      if (ep) {
        edges.push({ from: svcId, to: ep.id, kind: 'calls_api' });
        const appSvcName = ep.controller?.replace(/Controller$/, 'AppService');
        if (appSvcName) {
          edges.push({
            from: ep.id,
            to: makeNodeId('appService', appSvcName),
            kind: 'handled_by',
          });
        }
      }
    }
  }

  return { ...graph, edges };
};

module.exports = {
  expandDependencies,
  buildChainFromRoute,
  linkServiceProxyToBackend,
};
