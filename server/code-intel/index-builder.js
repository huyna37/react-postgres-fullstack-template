const fs = require('fs');
const { listRepoFiles, detectStacks, makeNodeId } = require('./utils');
const { GraphStore } = require('./graph-store');
const { indexAngularFiles } = require('./angular-indexer');
const { indexRoutes } = require('./route-indexer');
const { indexDotnetFiles } = require('./dotnet-indexer');
const { indexI18nFiles } = require('./i18n-indexer');
const { attachFieldsToComponents } = require('./field-extractor');
const { linkServiceProxyToBackend } = require('./dependency-tracer');
const { buildEmbeddingIndex } = require('./embedding-store');
const { buildPageCatalog } = require('./page-catalog');
const { buildChunkIndex } = require('./chunk-index');
const { buildFieldRegistry } = require('./field-registry');

/** Schema 5: + field registry (UI → DTO → Entity/DB) */
const INDEX_SCHEMA_VERSION = 5;
const building = new Map();

const buildGraphFromIndexes = (angular, routes, dotnet, repoPath) => {
  const nodes = [];
  const edges = [...(routes.edges || [])];

  const components = attachFieldsToComponents(repoPath, angular.components || []);
  for (const c of components) {
    nodes.push({ ...c, type: 'component' });
    for (const svc of c.injectedServices || []) {
      edges.push({ from: c.id, to: makeNodeId('service', svc), kind: 'injects' });
    }
  }

  for (const r of routes.routes || []) {
    nodes.push({ ...r, type: 'route', name: r.path });
    if (r.component) {
      const comp = components.find((c) => c.name === r.component);
      if (comp) {
        comp.permission = r.permission || comp.permission;
        edges.push({ from: r.id, to: comp.id, kind: 'renders' });
      }
    }
  }

  for (const s of angular.services || []) nodes.push({ ...s, type: 'service' });

  for (const m of angular.menuItems || []) {
    const menuId = makeNodeId('menuItem', m.nameKey || m.routeUrl || 'unknown', m.file);
    nodes.push({
      id: menuId,
      type: 'menuItem',
      name: m.nameKey,
      label: m.label,
      key: m.nameKey,
      routeUrl: m.routeUrl,
      permission: m.permission,
      file: m.file,
      line: m.line,
    });

    if (m.routeUrl) {
      const routeNode = (routes.routes || []).find(
        (r) => r.url === m.routeUrl || (r.path && m.routeUrl.endsWith(r.path))
      );
      if (routeNode) {
        edges.push({ from: menuId, to: routeNode.id, kind: 'menu_links' });
      }
    }
  }

  for (const c of dotnet.controllers || []) nodes.push({ ...c, type: 'controller' });
  for (const a of dotnet.appServices || []) nodes.push({ ...a, type: 'appService' });
  for (const r of dotnet.repositories || []) nodes.push({ ...r, type: 'repository' });
  for (const e of dotnet.entities || []) nodes.push({ ...e, type: 'entity' });
  for (const ep of dotnet.endpoints || []) {
    nodes.push({ ...ep, type: 'endpoint', name: ep.method || ep.controller });
    edges.push({ from: ep.id, to: makeNodeId('controller', ep.controller), kind: 'belongs_to' });
  }

  for (const app of dotnet.appServices || []) {
    const repo = dotnet.repositories.find(
      (r) => r.name.replace(/Repository$/, '') === app.name.replace(/AppService$/, '')
    );
    if (repo) edges.push({ from: app.id, to: repo.id, kind: 'uses' });
  }

  let graph = { version: 1, nodes, edges };
  graph = linkServiceProxyToBackend(graph, components, dotnet.endpoints || []);

  return {
    graph,
    components,
    routes: routes.routes || [],
    entities: dotnet.entities || [],
    menuItems: angular.menuItems || [],
    endpoints: dotnet.endpoints || [],
  };
};

const buildIndex = async (repoPath, options = {}) => {
  const key = repoPath;
  if (building.has(key)) return building.get(key);

  const task = (async () => {
    const start = Date.now();
    const store = new GraphStore(repoPath);
    const stacks = options.stacks || detectStacks(repoPath);
    const files = await listRepoFiles(repoPath);

    console.log(`[CodeIntel] Building index v${INDEX_SCHEMA_VERSION} for ${repoPath} (${files.length} files)...`);

    const angular = stacks.includes('angular')
      ? indexAngularFiles(repoPath, files)
      : { components: [], services: [], menuItems: [] };
    const routes = stacks.includes('angular') ? indexRoutes(repoPath, files) : { routes: [], edges: [] };
    const dotnet = stacks.includes('dotnet')
      ? indexDotnetFiles(repoPath, files)
      : { controllers: [], appServices: [], repositories: [], entities: [], dtos: [], endpoints: [] };
    const i18nEntries = indexI18nFiles(repoPath, files);

    const { graph, components, routes: routeList, entities, menuItems, endpoints } =
      buildGraphFromIndexes(angular, routes, dotnet, repoPath);

    const fieldRegistry = buildFieldRegistry({
      components,
      dtos: dotnet.dtos || [],
      entities,
      i18nEntries,
    });

    const pageCatalog = buildPageCatalog({
      menuItems,
      routes: routeList,
      components,
      i18nEntries,
    });

    const chunkIndex = buildChunkIndex({
      pageCatalog,
      menuItems,
      routes: routeList,
      components,
      i18nEntries,
      endpoints,
      fieldRegistry,
    });

    store.saveGraph(graph);
    store.saveRoutes(routeList);
    store.saveComponents(components);
    store.saveEntities(entities);
    store.saveMenus(menuItems);
    store.saveI18n(i18nEntries);
    store.savePages(pageCatalog);
    store.saveChunks(chunkIndex);
    store.saveFieldRegistry(fieldRegistry);

    const manifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      builtAt: new Date().toISOString(),
      stacks,
      stats: {
        files: files.length,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        pages: pageCatalog.length,
        chunks: chunkIndex.length,
        fieldMappings: fieldRegistry.stats?.mappings || 0,
        entityProps: fieldRegistry.stats?.entity || 0,
        menus: menuItems.length,
        routes: routeList.length,
        components: components.length,
        i18n: i18nEntries.length,
      },
      retrieval: 'hybrid-rrf+field-registry',
    };
    store.saveManifest(manifest);
    store.saveMeta({
      ...manifest.stats,
      builtAt: manifest.builtAt,
      stacks,
      durationMs: Date.now() - start,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
    });

    if (options.buildEmbeddings !== false) {
      try {
        await buildEmbeddingIndex(store, chunkIndex, { force: true });
      } catch (e) {
        console.warn('[CodeIntel] Embedding build skipped:', e?.message);
      }
    }

    console.log(
      `[CodeIntel] Index built: ${pageCatalog.length} pages, ${chunkIndex.length} chunks (${Date.now() - start}ms)`
    );

    return {
      store,
      graph,
      components,
      routes: routeList,
      entities,
      menuItems,
      i18nEntries,
      pageCatalog,
      chunkIndex,
      fieldRegistry,
      manifest,
      stacks,
    };
  })();

  building.set(key, task);
  try {
    return await task;
  } finally {
    building.delete(key);
  }
};

const ensureIndex = async (repoPath, options = {}) => {
  const store = new GraphStore(repoPath);
  const meta = store.loadMeta();
  const stale = store.isIndexStale(options.maxAgeMs);
  const needsMenus = !fs.existsSync(store.indexPath('menus'));
  const needsI18n = !fs.existsSync(store.indexPath('i18n'));
  const needsPages = !fs.existsSync(store.indexPath('pages'));
  const needsChunks = !fs.existsSync(store.indexPath('chunks'));
  const needsFields = !fs.existsSync(store.indexPath('fields'));
  const needsSchemaUpgrade = Number(meta.indexSchemaVersion || 0) < INDEX_SCHEMA_VERSION;

  if (
    !options.force &&
    store.indexExists() &&
    !stale &&
    !needsMenus &&
    !needsI18n &&
    !needsPages &&
    !needsChunks &&
    !needsFields &&
    !needsSchemaUpgrade
  ) {
    return {
      store,
      graph: store.loadGraph(),
      components: store.loadComponents().components || [],
      routes: store.loadRoutes().routes || [],
      entities: store.loadEntities().entities || [],
      menuItems: store.loadMenus().menuItems || [],
      i18nEntries: store.loadI18n().entries || [],
      pageCatalog: store.loadPages().pages || [],
      chunkIndex: store.loadChunks().chunks || [],
      fieldRegistry: store.loadFieldRegistry(),
      manifest: store.loadManifest(),
      stacks: meta.stacks || detectStacks(repoPath),
      cached: true,
    };
  }

  return buildIndex(repoPath, options);
};

const rebuildIndexInBackground = (repoPath, options = {}) => {
  setImmediate(() => {
    buildIndex(repoPath, { ...options, force: true }).catch((e) => {
      console.warn('[CodeIntel] Background rebuild failed:', e?.message);
    });
  });
};

module.exports = {
  INDEX_SCHEMA_VERSION,
  buildGraphFromIndexes,
  buildIndex,
  ensureIndex,
  rebuildIndexInBackground,
  buildPageCatalog,
};
