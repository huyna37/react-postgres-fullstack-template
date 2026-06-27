const { normalizePath, readFileSafe, makeNodeId } = require('./utils');

const CS_FILE_RE = /\.cs$/i;
const SKIP_CS = /(^|[\\/])(obj|bin|Migrations|Designer)\//i;

const isDotnetCandidate = (relPath) => {
  const n = normalizePath(relPath);
  if (!CS_FILE_RE.test(n) || SKIP_CS.test(n)) return false;
  return (
    /Controller\.cs$|AppService\.cs$|Repository\.cs$|Entity\.cs$|Dto\.cs$|\.Web\.Host/i.test(n) ||
    /aspnet-core/i.test(n) ||
    /Core\//i.test(n)
  );
};

const dotnetFilePriority = (rel) => {
  const n = normalizePath(rel);
  if (/Dto\.cs$/i.test(n)) return 0;
  if (/Entity\.cs$/i.test(n)) return 1;
  if (/AppService\.cs$/i.test(n)) return 2;
  if (/Repository\.cs$/i.test(n)) return 3;
  if (/Controller\.cs$/i.test(n)) return 4;
  return 5;
};

const parseCSharpFile = (content, relPath) => {
  const lines = content.split(/\r?\n/);
  const controllers = [];
  const appServices = [];
  const repositories = [];
  const entities = [];
  const dtos = [];
  const endpoints = [];

  let currentClass = null;
  let currentKind = null;
  let currentNamespace = '';
  let braceDepth = 0;
  let inClass = false;
  let pendingProp = null;

  const flushClass = () => {
    if (!currentClass || !currentKind) return;
    const target =
      currentKind === 'controller'
        ? controllers
        : currentKind === 'appService'
          ? appServices
          : currentKind === 'repository'
            ? repositories
            : currentKind === 'entity'
              ? entities
              : currentKind === 'dto'
                ? dtos
                : null;
    if (target && target[target.length - 1]?.name === currentClass) return;
  };

  const startClass = (name, lineNum) => {
    currentClass = name;
    inClass = true;
    braceDepth = 0;
    pendingProp = null;

    if (name.endsWith('Controller')) {
      currentKind = 'controller';
      controllers.push({
        id: makeNodeId('controller', name, relPath),
        name,
        namespace: currentNamespace,
        file: normalizePath(relPath),
        line: lineNum,
        properties: [],
      });
    } else if (name.endsWith('AppService')) {
      currentKind = 'appService';
      appServices.push({
        id: makeNodeId('appService', name, relPath),
        name,
        namespace: currentNamespace,
        file: normalizePath(relPath),
        line: lineNum,
        properties: [],
      });
    } else if (name.endsWith('Repository')) {
      currentKind = 'repository';
      repositories.push({
        id: makeNodeId('repository', name, relPath),
        name,
        namespace: currentNamespace,
        file: normalizePath(relPath),
        line: lineNum,
        properties: [],
      });
    } else if (name.endsWith('Dto') || /Dto$/i.test(name)) {
      currentKind = 'dto';
      dtos.push({
        id: makeNodeId('dto', name, relPath),
        name,
        namespace: currentNamespace,
        file: normalizePath(relPath),
        line: lineNum,
        properties: [],
      });
    } else if (
      /Entity\.cs$/i.test(relPath) ||
      /:.*\b(?:Entity|FullAuditedEntity|AuditedEntity)\b/.test(lines.slice(lineNum - 1, lineNum + 3).join(' '))
    ) {
      currentKind = 'entity';
      entities.push({
        id: makeNodeId('entity', name, relPath),
        name,
        namespace: currentNamespace,
        file: normalizePath(relPath),
        line: lineNum,
        properties: [],
      });
    } else {
      currentKind = null;
    }
  };

  const currentTypeList = () => {
    if (currentKind === 'dto') return dtos;
    if (currentKind === 'entity') return entities;
    if (currentKind === 'appService') return appServices;
    if (currentKind === 'repository') return repositories;
    if (currentKind === 'controller') return controllers;
    return null;
  };

  const addProperty = (propName, propType, lineNum, columnName) => {
    const list = currentTypeList();
    if (!list?.length || !currentClass) return;
    const last = list[list.length - 1];
    if (last.name !== currentClass) return;
    last.properties.push({
      name: propName,
      type: propType,
      column: columnName || propName,
      line: lineNum,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trim = line.trim();
    const lineNum = i + 1;

    const nsMatch = trim.match(/^namespace\s+([\w.]+)/);
    if (nsMatch) currentNamespace = nsMatch[1];

    const classMatch = trim.match(
      /(?:public|internal|protected|private)?\s*(?:abstract|sealed|static|partial)?\s*class\s+(\w+)(?:\s*:\s*([\w.<>,\s]+))?/
    );
    if (classMatch) {
      const bases = classMatch[2] || '';
      startClass(classMatch[1], lineNum);
      if (/\bEntity\b/.test(bases) && !classMatch[1].endsWith('Dto')) {
        if (!entities.find((e) => e.name === classMatch[1])) {
          currentKind = 'entity';
          entities.push({
            id: makeNodeId('entity', classMatch[1], relPath),
            name: classMatch[1],
            namespace: currentNamespace,
            file: normalizePath(relPath),
            line: lineNum,
            properties: [],
          });
        } else {
          currentKind = 'entity';
        }
      }
    }

    if (inClass && currentClass) {
      const colMatch = trim.match(/\[Column\s*\(\s*Name\s*=\s*"([^"]+)"/i);
      if (colMatch) pendingProp = { column: colMatch[1] };

      const routeMatch = trim.match(/\[Route\s*\(\s*"([^"]+)"\s*\)\]/);
      const httpMatch = trim.match(/\[Http(?:Get|Post|Put|Delete|Patch)(?:\s*\(\s*"([^"]*)"\s*\))?\]/);
      const abpAuth = trim.match(/\[AbpAuthorize\s*\(\s*(?:PermissionNames\.)?([A-Za-z0-9_.]+)\s*\)\]/);

      if (routeMatch || httpMatch) {
        const methodMatch = trim.match(/(?:public|private|protected|internal)\s+(?:async\s+)?[\w<>,\[\]?]+\s+(\w+)\s*\(/);
        const actionRoute = httpMatch?.[1] ?? '';
        endpoints.push({
          id: makeNodeId('endpoint', `${currentClass}.${methodMatch?.[1] || lineNum}`, relPath),
          controller: currentClass,
          method: methodMatch?.[1] || null,
          httpVerb: httpMatch ? httpMatch[0].replace(/\[Http(\w+).*/, '$1').toLowerCase() : 'get',
          abpRoute: `/api/services/app/${currentClass.replace(/Controller$/, '')}/${methodMatch?.[1] || actionRoute || ''}`
            .replace(/\/+/g, '/')
            .replace(/\/$/, ''),
          permission: abpAuth ? abpAuth[1] : null,
          file: normalizePath(relPath),
          line: lineNum,
        });
      }

      const propMatch = trim.match(
        /public\s+([\w<>,\[\]?]+)\s+(\w+)\s*\{\s*get(?:\s*;\s*|\s+).*set/
      );
      if (propMatch) {
        addProperty(propMatch[2], propMatch[1], lineNum, pendingProp?.column);
        pendingProp = null;
      }

      if (trim.match(/:\s*(?:Entity|FullAuditedEntity|AuditedEntity)/) && currentKind !== 'entity' && currentKind !== 'dto') {
        const list = entities;
        if (!list.find((e) => e.name === currentClass)) {
          currentKind = 'entity';
          entities.push({
            id: makeNodeId('entity', currentClass, relPath),
            name: currentClass,
            namespace: currentNamespace,
            file: normalizePath(relPath),
            line: lineNum,
            properties: [],
          });
        }
      }
    }

    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;
    if (inClass && braceDepth <= 0 && trim === '}') {
      inClass = false;
      currentClass = null;
      currentKind = null;
      pendingProp = null;
    }
  }

  return { controllers, appServices, repositories, entities, dtos, endpoints };
};

const indexDotnetFiles = (repoPath, filePaths) => {
  const candidates = filePaths
    .filter(isDotnetCandidate)
    .sort((a, b) => dotnetFilePriority(a) - dotnetFilePriority(b))
    .slice(0, 2000);

  const controllers = [];
  const appServices = [];
  const repositories = [];
  const entities = [];
  const dtos = [];
  const endpoints = [];

  for (const rel of candidates) {
    const content = readFileSafe(repoPath, rel);
    if (!content) continue;
    const parsed = parseCSharpFile(content, rel);
    controllers.push(...parsed.controllers);
    appServices.push(...parsed.appServices);
    repositories.push(...parsed.repositories);
    entities.push(...parsed.entities);
    dtos.push(...parsed.dtos);
    endpoints.push(...parsed.endpoints);
  }

  return { controllers, appServices, repositories, entities, dtos, endpoints };
};

module.exports = {
  isDotnetCandidate,
  indexDotnetFiles,
  parseCSharpFile,
};
