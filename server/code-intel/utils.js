const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const SUPPORTED_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.html', '.cs']);
const SKIP_DIRS = /(^|[\\/])(node_modules|dist|bin|obj|coverage|\.next|out|build)([\\/]|$)/i;

const normalizePath = (value) => String(value || '').replace(/\\/g, '/');

const shouldIndexFile = (relPath) => {
  const normalized = normalizePath(relPath).toLowerCase();
  if (!normalized || SKIP_DIRS.test(normalized)) return false;
  return SUPPORTED_EXTENSIONS.has(path.extname(normalized));
};

const removeAccents = (str) =>
  String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');

const tokenize = (text) =>
  String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

const camelToTokens = (name) => {
  const s = String(name || '');
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
};

const runCommand = (command, cwd) =>
  new Promise((resolve, reject) => {
    exec(command, { cwd, maxBuffer: 30 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

const listRepoFiles = async (repoPath) => {
  try {
    const { stdout } = await runCommand('git ls-tree -r --name-only HEAD', repoPath);
    return stdout
      .split('\n')
      .map((l) => normalizePath(l.trim()))
      .filter((l) => l && shouldIndexFile(l));
  } catch {
    return walkDir(repoPath, repoPath);
  }
};

const walkDir = (root, dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = normalizePath(path.relative(root, full));
    if (ent.isDirectory()) {
      if (SKIP_DIRS.test(rel)) continue;
      walkDir(root, full, out);
    } else if (shouldIndexFile(rel)) {
      out.push(rel);
    }
  }
  return out;
};

const readFileSafe = (repoPath, relPath) => {
  const full = path.join(repoPath, relPath);
  if (!fs.existsSync(full)) return null;
  try {
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
};

const detectStacks = (repoPath, stackCsv) => {
  let stacks = stackCsv ? String(stackCsv).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const hasAngular = fs.existsSync(path.join(repoPath, 'angular.json'));
  const hasDotnet = fs.existsSync(repoPath) && fs.readdirSync(repoPath).some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));

  if (stacks.includes('polyglot') || stacks.length === 0) {
    if (hasAngular) stacks.push('angular');
    if (hasDotnet) stacks.push('dotnet');
    stacks = stacks.filter((s) => s !== 'polyglot');
    if (stacks.length === 0) stacks.push('nodejs');
    return [...new Set(stacks)];
  }
  if (hasAngular && !stacks.includes('angular')) stacks.push('angular');
  if (hasDotnet && !stacks.includes('dotnet')) stacks.push('dotnet');
  return [...new Set(stacks)];
};

const classifyFeBeRest = (normRaw) => {
  const n = normalizePath(normRaw);
  if (/node_modules|(^|\/)(dist|bin|obj|coverage)\/|vendor\/|^packages\//i.test(n)) return 'rest';
  if (/\.(cs|csproj|sln)$/i.test(n)) return 'be';
  if (/^(angular|client|clientapp|frontend|presentation|spa)\//i.test(n)) return 'fe';
  if (/^apps\/web\//i.test(n)) return 'fe';
  if (/^libs\/[^/]+\//i.test(n) && /\.(ts|tsx|html|scss|css)$/i.test(n)) return 'fe';
  if (/\/src\/app\//i.test(n) && /\.(ts|tsx|html|scss|css)$/i.test(n)) return 'fe';
  if (/aspnet-core\//i.test(n) && /\.cs$/i.test(n)) return 'be';
  if (/^server\/|^aspnet-core\/|^src\/[^/]+\.application\//i.test(n) && /\.cs$/i.test(n)) return 'be';
  return 'rest';
};

const makeNodeId = (type, name, file = '') => {
  const base = `${type}:${String(name || '').trim()}`;
  return file ? `${base}@${normalizePath(file)}` : base;
};

const cosineSimilarity = (a, b) => {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const textSimilarity = (query, target) => {
  const qTokens = new Set(tokenize(removeAccents(query)));
  const tTokens = tokenize(removeAccents(target));
  if (qTokens.size === 0 || tTokens.length === 0) return 0;
  let hits = 0;
  for (const t of tTokens) {
    if (qTokens.has(t)) hits += 1;
    else {
      for (const q of qTokens) {
        if (t.includes(q) || q.includes(t)) {
          hits += 0.5;
          break;
        }
      }
    }
  }
  return hits / Math.max(qTokens.size, tTokens.length);
};

module.exports = {
  SUPPORTED_EXTENSIONS,
  normalizePath,
  shouldIndexFile,
  removeAccents,
  tokenize,
  camelToTokens,
  runCommand,
  listRepoFiles,
  readFileSafe,
  detectStacks,
  classifyFeBeRest,
  makeNodeId,
  cosineSimilarity,
  textSimilarity,
};
