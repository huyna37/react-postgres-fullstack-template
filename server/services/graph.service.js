const { loadGraphStore } = require('../code-intel/graph-store');
const { expandDependencies, buildChainFromRoute } = require('../code-intel/dependency-tracer');

const lookupNode = (repoPath, nodeId) => {
  const store = loadGraphStore(repoPath);
  return store.getNodeById(nodeId);
};

const lookupByName = (repoPath, name, type = null) => {
  const store = loadGraphStore(repoPath);
  const graph = store.loadGraph();
  const n = String(name || '').toLowerCase();
  return graph.nodes.filter((node) => {
    if (type && node.type !== type) return false;
    const nodeName = String(node.name || node.path || '').toLowerCase();
    return nodeName === n || nodeName.includes(n);
  });
};

const getRoutes = (repoPath) => loadGraphStore(repoPath).loadRoutes().routes || [];

const getComponents = (repoPath) => loadGraphStore(repoPath).loadComponents().components || [];

const getGraph = (repoPath) => loadGraphStore(repoPath).loadGraph();

module.exports = {
  lookupNode,
  lookupByName,
  getRoutes,
  getComponents,
  getGraph,
  expandDependencies,
  buildChainFromRoute,
};
