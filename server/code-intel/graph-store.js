const fs = require('fs');
const path = require('path');
const { normalizePath } = require('./utils');

const INDEX_DIR = '.ai-index';
const INDEX_FILES = {
  routes: 'routes.json',
  components: 'components.json',
  entities: 'entities.json',
  menus: 'menus.json',
  i18n: 'i18n.json',
  pages: 'pages.json',
  chunks: 'chunks.json',
  fields: 'fields.json',
  manifest: 'manifest.json',
  graph: 'graph.json',
  embeddings: 'embeddings.json',
  meta: 'meta.json',
};

const getIndexDir = (repoPath) => path.join(repoPath, INDEX_DIR);

const ensureIndexDir = (repoPath) => {
  const dir = getIndexDir(repoPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
};

const emptyGraph = () => ({ nodes: [], edges: [], version: 1 });

class GraphStore {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.indexDir = ensureIndexDir(repoPath);
    this._graph = null;
    this._routes = null;
    this._components = null;
    this._entities = null;
  }

  indexPath(name) {
    return path.join(this.indexDir, INDEX_FILES[name] || name);
  }

  loadGraph() {
    if (this._graph) return this._graph;
    this._graph = readJson(this.indexPath('graph'), emptyGraph());
    if (!Array.isArray(this._graph.nodes)) this._graph.nodes = [];
    if (!Array.isArray(this._graph.edges)) this._graph.edges = [];
    return this._graph;
  }

  loadRoutes() {
    if (this._routes) return this._routes;
    this._routes = readJson(this.indexPath('routes'), { routes: [] });
    return this._routes;
  }

  loadComponents() {
    if (this._components) return this._components;
    this._components = readJson(this.indexPath('components'), { components: [] });
    return this._components;
  }

  loadEntities() {
    if (this._entities) return this._entities;
    this._entities = readJson(this.indexPath('entities'), { entities: [] });
    return this._entities;
  }

  loadMenus() {
    return readJson(this.indexPath('menus'), { menuItems: [] });
  }

  loadI18n() {
    return readJson(this.indexPath('i18n'), { entries: [] });
  }

  loadMeta() {
    return readJson(this.indexPath('meta'), { builtAt: null, fileCount: 0, stacks: [] });
  }

  saveGraph(graph) {
    this._graph = graph;
    writeJson(this.indexPath('graph'), graph);
  }

  saveRoutes(routes) {
    this._routes = { routes, version: 1 };
    writeJson(this.indexPath('routes'), this._routes);
  }

  saveComponents(components) {
    this._components = { components, version: 1 };
    writeJson(this.indexPath('components'), this._components);
  }

  saveEntities(entities) {
    this._entities = { entities, version: 1 };
    writeJson(this.indexPath('entities'), this._entities);
  }

  saveMenus(menuItems) {
    writeJson(this.indexPath('menus'), { menuItems, version: 1 });
  }

  saveI18n(entries) {
    writeJson(this.indexPath('i18n'), { entries, version: 1 });
  }

  savePages(pages) {
    writeJson(this.indexPath('pages'), { pages, version: 1 });
  }

  loadPages() {
    return readJson(this.indexPath('pages'), { pages: [] });
  }

  saveChunks(chunks) {
    writeJson(this.indexPath('chunks'), { chunks, version: 1 });
  }

  loadChunks() {
    return readJson(this.indexPath('chunks'), { chunks: [] });
  }

  saveManifest(manifest) {
    writeJson(this.indexPath('manifest'), manifest);
  }

  loadManifest() {
    return readJson(this.indexPath('manifest'), { schemaVersion: 0 });
  }

  saveFieldRegistry(registry) {
    writeJson(this.indexPath('fields'), { ...registry, version: 1 });
  }

  loadFieldRegistry() {
    return readJson(this.indexPath('fields'), { mappings: [], propertyIndex: [], stats: {} });
  }

  saveMeta(meta) {
    writeJson(this.indexPath('meta'), meta);
  }

  getNodeById(id) {
    return this.loadGraph().nodes.find((n) => n.id === id) || null;
  }

  getNodesByType(type) {
    return this.loadGraph().nodes.filter((n) => n.type === type);
  }

  getEdgesFrom(nodeId) {
    return this.loadGraph().edges.filter((e) => e.from === nodeId);
  }

  getEdgesTo(nodeId) {
    return this.loadGraph().edges.filter((e) => e.to === nodeId);
  }

  addNode(node) {
    const graph = this.loadGraph();
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) graph.nodes[idx] = { ...graph.nodes[idx], ...node };
    else graph.nodes.push(node);
    return graph;
  }

  addEdge(edge) {
    const graph = this.loadGraph();
    const key = `${edge.from}|${edge.to}|${edge.kind}`;
    const exists = graph.edges.some((e) => `${e.from}|${e.to}|${e.kind}` === key);
    if (!exists) graph.edges.push(edge);
    return graph;
  }

  isIndexStale(maxAgeMs = 24 * 60 * 60 * 1000) {
    const meta = this.loadMeta();
    if (!meta.builtAt) return true;
    const age = Date.now() - new Date(meta.builtAt).getTime();
    return age > maxAgeMs;
  }

  indexExists() {
    return fs.existsSync(this.indexPath('graph'));
  }
}

const loadGraphStore = (repoPath) => new GraphStore(repoPath);

module.exports = {
  INDEX_DIR,
  INDEX_FILES,
  GraphStore,
  loadGraphStore,
  emptyGraph,
};
