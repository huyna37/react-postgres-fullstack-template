const path = require('path');
const { Project, SyntaxKind } = require('ts-morph');
const { normalizePath, readFileSafe, makeNodeId } = require('./utils');

const ANGULAR_FILE_PATTERNS = [
  /routing\.module\.ts$/i,
  /-routing\.module\.ts$/i,
  /app-navigation\.service\.ts$/i,
  /navigation\.service\.ts$/i,
  /\.component\.ts$/i,
  /\.service\.ts$/i,
  /service-proxy\.ts$/i,
  /service-proxies/i,
];

const isAngularCandidate = (relPath) => {
  const n = normalizePath(relPath);
  if (!/\.(ts|tsx)$/i.test(n)) return false;
  if (/node_modules|\.spec\.|\.test\./i.test(n)) return false;
  if (/^(angular|client|frontend|spa)\//i.test(n)) return true;
  if (/\/src\/app\//i.test(n)) return true;
  return ANGULAR_FILE_PATTERNS.some((re) => re.test(n));
};

const getDecoratorArg = (dec, propName) => {
  const arg = dec.getArguments()[0];
  if (!arg || !arg.getKind || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
  const prop = arg.getProperty(propName);
  if (!prop) return null;
  const init = prop.getInitializer();
  if (!init) return null;
  if (init.getKind() === SyntaxKind.StringLiteral) return init.getLiteralValue();
  if (init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) return init.getLiteralText();
  return init.getText().replace(/^['"]|['"]$/g, '');
};

const filePriority = (rel) => {
  const n = normalizePath(rel);
  if (/navigation|app-menu|sidebar-menu|menu\.service|app-navigation/i.test(n)) return 0;
  if (/routing\.module\.ts$/i.test(n)) return 1;
  if (/\.component\.ts$/i.test(n)) return 2;
  if (/\.service\.ts$/i.test(n)) return 3;
  return 4;
};

const indexAngularFiles = (repoPath, filePaths) => {
  const all = filePaths.filter(isAngularCandidate);
  all.sort((a, b) => filePriority(a) - filePriority(b) || a.localeCompare(b));

  const priority = all.filter((f) => filePriority(f) <= 1);
  const componentFiles = all.filter((f) => filePriority(f) === 2);
  const rest = all.filter((f) => filePriority(f) > 2);
  const candidates = [...priority, ...componentFiles.slice(0, 2200), ...rest.slice(0, 300)];
  if (candidates.length === 0) {
    return { components: [], services: [], menuItems: [], permissions: [], localizationKeys: [] };
  }

  const project = new Project({
    compilerOptions: { allowJs: true },
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
  });

  const components = [];
  const services = [];
  const menuItems = [];
  const permissions = new Set();
  const localizationKeys = new Set();

  for (const rel of candidates) {
    const full = path.join(repoPath, rel);
    let sourceFile;
    try {
      sourceFile = project.addSourceFileAtPathIfExists(full) || project.addSourceFileAtPath(full);
    } catch {
      continue;
    }

    for (const cls of sourceFile.getClasses()) {
      const name = cls.getName();
      if (!name) continue;
      const decorators = cls.getDecorators().map((d) => d.getName());
      const line = cls.getStartLineNumber();

      if (decorators.includes('Component')) {
        const selector = cls.getDecorator('Component')
          ? getDecoratorArg(cls.getDecorator('Component'), 'selector')
          : null;
        const templateUrl = cls.getDecorator('Component')
          ? getDecoratorArg(cls.getDecorator('Component'), 'templateUrl')
          : null;
        const injected = [];
        const ctor = cls.getConstructors()[0];
        if (ctor) {
          for (const p of ctor.getParameters()) {
            const t = p.getType().getText(p);
            if (t && !/^(string|number|boolean|any)$/i.test(t)) injected.push(t.replace(/^import\(.+\)\./, ''));
          }
        }
        components.push({
          id: makeNodeId('component', name, rel),
          name,
          file: normalizePath(rel),
          line,
          selector,
          templateUrl: templateUrl ? normalizePath(path.join(path.dirname(rel), templateUrl)) : null,
          injectedServices: injected,
          permissions: [],
        });
      }

      if (decorators.includes('Injectable') || name.endsWith('Service')) {
        services.push({
          id: makeNodeId('service', name, rel),
          name,
          file: normalizePath(rel),
          line,
        });
      }
    }

    // AppMenuItem — Mefobase/ABP: nameKey, permission, icon, route, ...
    const text = sourceFile.getFullText();
    const menuRe = /new\s+AppMenuItem\s*\(([\s\S]*?)\)(?:\s*,|\s*\)|\s*;)/g;
    let mm;
    while ((mm = menuRe.exec(text))) {
      const argsBlock = mm[1];
      const strings = [];
      const strRe = /['"]([^'"]+)['"]/g;
      let sm;
      while ((sm = strRe.exec(argsBlock))) strings.push(sm[1]);

      const routeUrl = strings.find((s) => /^\/app\//.test(s)) || null;
      const permission = strings.find((s) => /^Pages\./.test(s)) || null;
      const nameKey = strings[0] || null;
      const icon = strings.find((s) => /^(flaticon-|fa |fas |material|layers|toll)/i.test(s)) || strings[2] || null;

      menuItems.push({
        nameKey,
        permission,
        icon,
        routeUrl,
        label: strings[1] && !/^Pages\./.test(strings[1]) && !/^\/app\//.test(strings[1]) ? strings[1] : null,
        file: normalizePath(rel),
        line: text.slice(0, mm.index).split('\n').length,
        rawArgs: strings,
      });
    }

    // permission strings
    const permRe = /(?:permission|Permission)\s*:\s*['"]([^'"]+)['"]|Pages\.[A-Za-z0-9_.]+/g;
    let pm;
    while ((pm = permRe.exec(text))) {
      permissions.add(pm[1] || pm[0]);
    }

    // localization keys
    const locRe = /(?:l\(|localize|Localize)\s*\(\s*['"]([^'"]+)['"]/g;
    let lm;
    while ((lm = locRe.exec(text))) {
      localizationKeys.add(lm[1]);
    }
  }

  return {
    components,
    services,
    menuItems,
    permissions: Array.from(permissions),
    localizationKeys: Array.from(localizationKeys),
  };
};

module.exports = {
  isAngularCandidate,
  indexAngularFiles,
};
