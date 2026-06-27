const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');
const { normalizePath, makeNodeId } = require('./utils');

const ROUTING_FILE_RE = /routing\.module\.ts$/i;

const resolveLazyModulePath = (importPath, fromFile) => {
  const base = path.dirname(fromFile);
  let p = importPath.replace(/\.module$/, '.module.ts');
  if (!p.endsWith('.ts')) p += '.ts';
  return normalizePath(path.join(base, p));
};

const parseRouteObject = (objNode, parentPath, fromFile, routes, edges) => {
  if (!objNode || objNode.getKind() !== SyntaxKind.ObjectLiteralExpression) return;

  let routePath = '';
  let component = '';
  let loadChildren = '';
  let permission = '';
  let dataTitle = '';
  let childrenNode = null;

  for (const prop of objNode.getProperties()) {
    const key = prop.getName && prop.getName();
    const init = prop.getInitializer && prop.getInitializer();
    if (!init) continue;

    if (key === 'path') {
      if (init.getKind() === SyntaxKind.StringLiteral) routePath = init.getLiteralValue();
    } else if (key === 'component') {
      component = init.getText().replace(/\s/g, '');
    } else if (key === 'loadChildren') {
      const importMatch = init.getText().match(/import\s*\(\s*['"]([^'"]+)['"]/);
      if (importMatch) loadChildren = importMatch[1];
    } else if (key === 'data' && init.getKind() === SyntaxKind.ObjectLiteralExpression) {
      const permProp = init.getProperty('permission');
      if (permProp) {
        const pi = permProp.getInitializer();
        if (pi?.getKind() === SyntaxKind.StringLiteral) permission = pi.getLiteralValue();
      }
      const titleProp = init.getProperty('title') || init.getProperty('breadcrumb');
      if (titleProp) {
        const ti = titleProp.getInitializer();
        if (ti?.getKind() === SyntaxKind.StringLiteral) dataTitle = ti.getLiteralValue();
      }
    } else if (key === 'children' && init.getKind() === SyntaxKind.ArrayLiteralExpression) {
      childrenNode = init;
    }
  }

  const fullPath = [parentPath, routePath].filter(Boolean).join('/').replace(/\/+/g, '/');

  if (fullPath || component || loadChildren) {
    const routeId = makeNodeId('route', fullPath || routePath || component, fromFile);
    routes.push({
      id: routeId,
      path: fullPath,
      segment: routePath,
      component: component || null,
      loadChildren: loadChildren || null,
      permission: permission || null,
      title: dataTitle || null,
      parentPath: parentPath || null,
      file: normalizePath(fromFile),
      url: fullPath.startsWith('/') ? fullPath : `/app/${fullPath}`.replace(/\/+/g, '/'),
    });

    if (component) {
      edges.push({ from: routeId, to: makeNodeId('component', component), kind: 'renders' });
    }
    if (loadChildren) {
      edges.push({
        from: routeId,
        to: makeNodeId('module', loadChildren, resolveLazyModulePath(loadChildren, fromFile)),
        kind: 'lazy_loads',
      });
    }
  }

  if (childrenNode) {
    for (const child of childrenNode.getElements()) {
      parseRouteObject(child, fullPath, fromFile, routes, edges);
    }
  }
};

const parseRouteArrayLiteral = (node, parentPath, fromFile, routes, edges) => {
  if (!node || node.getKind() !== SyntaxKind.ArrayLiteralExpression) return;
  for (const el of node.getElements()) {
    parseRouteObject(el, parentPath, fromFile, routes, edges);
  }
};

const indexRoutes = (repoPath, filePaths) => {
  const routingFiles = filePaths
    .filter((f) => ROUTING_FILE_RE.test(f))
    .sort((a, b) => a.localeCompare(b));
  const routes = [];
  const edges = [];

  if (routingFiles.length === 0) return { routes, edges };

  const project = new Project({
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
  });

  for (const rel of routingFiles) {
    const full = path.join(repoPath, rel);
    let sf;
    try {
      sf = project.addSourceFileAtPathIfExists(full) || project.addSourceFileAtPath(full);
    } catch {
      continue;
    }

    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const expr = node.getExpression().getText();
      if (!/RouterModule\.for(?:Child|Root)/.test(expr)) return;
      const args = node.getArguments();
      if (args[0]) parseRouteArrayLiteral(args[0], '', rel, routes, edges);
    });
  }

  return { routes, edges };
};

module.exports = {
  indexRoutes,
  ROUTING_FILE_RE,
};
