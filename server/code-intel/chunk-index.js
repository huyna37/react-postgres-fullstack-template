const { removeAccents, tokenize, makeNodeId } = require('./utils');
const { lookupI18n } = require('./i18n-indexer');

const KIND = {
  SCREEN: 'screen',
  MENU: 'menu',
  ROUTE: 'route',
  I18N: 'i18n',
  API: 'api',
  COMPONENT: 'component',
  FIELD: 'field',
  ENTITY: 'entity',
  DTO: 'dto',
};

const tokenizeBody = (text) => tokenize(removeAccents(String(text || '').toLowerCase()));

const buildChunk = ({ id, kind, title, body, url, meta }) => ({
  id,
  kind,
  title: title || '',
  body: removeAccents(String(body || '').toLowerCase()),
  url: url || null,
  meta: meta || {},
  tokens: tokenizeBody(`${title} ${body}`),
});

/**
 * Unified chunk index — đơn vị tìm kiếm chuẩn (giống RAG codebase tools).
 */
const buildChunkIndex = ({
  pageCatalog = [],
  menuItems = [],
  routes = [],
  components = [],
  i18nEntries = [],
  endpoints = [],
  fieldRegistry = null,
}) => {
  const chunks = [];
  const seenIds = new Set();

  const push = (chunk) => {
    if (!chunk?.id || seenIds.has(chunk.id)) return;
    seenIds.add(chunk.id);
    chunks.push(chunk);
  };

  for (const page of pageCatalog) {
    const title = page.menuLabel || page.menuKey || page.component || page.url;
    const body = [
      title,
      page.menuKey,
      page.menuLabel,
      page.url,
      page.component,
      page.permission,
      page.routeTitle,
      page.searchText,
      ...(page.sources || []),
    ]
      .filter(Boolean)
      .join(' ');

    push(
      buildChunk({
        id: page.id || `screen:${page.url}`,
        kind: KIND.SCREEN,
        title,
        body,
        url: page.url,
        meta: {
          component: page.component,
          menuKey: page.menuKey,
          permission: page.permission,
          sources: page.sources,
          menuFile: page.menuFile,
          menuLine: page.menuLine,
          routeFile: page.routeFile,
          routeLine: page.routeLine,
          componentFile: page.componentFile,
        },
      })
    );
  }

  for (const menu of menuItems) {
    if (!menu.routeUrl && !menu.nameKey) continue;
    const label = menu.label || lookupI18n(i18nEntries, menu.nameKey);
    push(
      buildChunk({
        id: makeNodeId('menu', menu.nameKey || menu.routeUrl, menu.file),
        kind: KIND.MENU,
        title: label || menu.nameKey,
        body: [menu.nameKey, label, menu.permission, menu.routeUrl, menu.icon].filter(Boolean).join(' '),
        url: menu.routeUrl,
        meta: {
          menuKey: menu.nameKey,
          permission: menu.permission,
          file: menu.file,
          line: menu.line,
        },
      })
    );
  }

  const menuKeys = [...new Set(menuItems.map((m) => m.nameKey).filter(Boolean))];
  const i18nLinkedToMenu = (key) =>
    menuKeys.some((k) => key === k || key.endsWith(`.${k}`) || key.includes(k));

  for (const entry of i18nEntries) {
    if (!entry.key || !entry.text) continue;
    if (!i18nLinkedToMenu(entry.key) && entry.text.length > 80) continue;
    push(
      buildChunk({
        id: makeNodeId('i18n', entry.key, entry.file),
        kind: KIND.I18N,
        title: entry.text.slice(0, 120),
        body: `${entry.key} ${entry.text}`,
        url: null,
        meta: { key: entry.key, file: entry.file },
      })
    );
  }

  for (const route of routes) {
    if (!route.url || route.url === '/app/' || route.path === 'app') continue;
    push(
      buildChunk({
        id: route.id || makeNodeId('route', route.path || route.url, route.file),
        kind: KIND.ROUTE,
        title: route.title || route.path,
        body: [route.path, route.segment, route.component, route.title, route.permission, route.url].filter(Boolean).join(' '),
        url: route.url,
        meta: { component: route.component, file: route.file, permission: route.permission },
      })
    );
  }

  for (const comp of components.slice(0, 800)) {
    push(
      buildChunk({
        id: comp.id || makeNodeId('component', comp.name, comp.file),
        kind: KIND.COMPONENT,
        title: comp.name,
        body: [comp.name, comp.file, comp.selector, ...(comp.injectedServices || [])].join(' '),
        url: null,
        meta: { file: comp.file },
      })
    );
  }

  for (const ep of endpoints.slice(0, 400)) {
    push(
      buildChunk({
        id: ep.id || makeNodeId('api', ep.method || ep.name, ep.file),
        kind: KIND.API,
        title: ep.name || ep.method,
        body: [ep.method, ep.controller, ep.abpRoute, ep.name].filter(Boolean).join(' '),
        url: ep.abpRoute || null,
        meta: { controller: ep.controller, file: ep.file },
      })
    );
  }

  for (const m of fieldRegistry?.mappings || []) {
    push(
      buildChunk({
        id: m.id || `field:${m.component}:${m.uiField}`,
        kind: KIND.FIELD,
        title: `${m.uiField} → ${m.entityField || m.dtoField}`,
        body: m.searchText,
        url: null,
        meta: {
          uiField: m.uiField,
          entityField: m.entityField,
          entityType: m.entityType,
          dtoField: m.dtoField,
          dtoType: m.dtoType,
          dbColumn: m.dbColumn,
          component: m.component,
        },
      })
    );
  }

  for (const p of (fieldRegistry?.propertyIndex || []).slice(0, 1500)) {
    if (p.layer === 'ui') continue;
    push(
      buildChunk({
        id: `prop:${p.layer}:${p.parent}:${p.name}`,
        kind: p.layer === 'entity' ? KIND.ENTITY : KIND.DTO,
        title: `${p.parent}.${p.name}`,
        body: p.searchText,
        url: null,
        meta: { parent: p.parent, name: p.name, column: p.column, file: p.parentFile },
      })
    );
  }

  return chunks;
};

const chunksByKind = (chunks, kinds) => {
  const set = new Set(kinds);
  return chunks.filter((c) => set.has(c.kind));
};

module.exports = {
  KIND,
  buildChunkIndex,
  buildChunk,
  chunksByKind,
  tokenizeBody,
};
