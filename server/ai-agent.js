const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { sendTelegramMessage, escapeHTML } = require('./utils');
const { llmGenerate, getActiveLlmInfo, getSmartModel, getFastModel } = require('./llm');
const { buildCodeIndex, searchRelevantSymbols, collectFilesFromSymbols, rebuildIndexInBackground } = require('./code-intel');
const { classifyVerificationError, detectValidationPipeline, shouldPreferScopedEdits } = require('./agent-tools');
const { validateAndPrepareChanges } = require('./agent-actions');
const { applyChangesWithRefinement } = require('./change-applier');
const {
  resolveTargetSubDir,
  ensureDependenciesForStack,
  collectVerificationConfigFiles,
  runValidationPipelineOnce,
} = require('./verification-executor');
const { buildProjectMemoryPromptBlock, appendProjectMemory, buildLessonFromFixRow } = require('./project-ai-memory');
const { performWebResearch } = require('./9router-tools');

const REPOS_BASE_DIR = process.env.AI_REPOS_DIR || path.join(__dirname, '../repos');
const DEFAULT_MAX_CONTEXT_FILES = 72;
const DEFAULT_MAX_PROMPT_FILES = 28;
const DEFAULT_MAX_PROMPT_FILES_WITH_PLAN = 16;
const DEFAULT_MAX_PLANNING_FILES = 32;
const DEFAULT_MAX_SKILLS_CHARS = 22000;
const DEFAULT_MAX_FILE_SNIPPETS = 8;
const DEFAULT_MAX_FILE_SNIPPET_CHARS = 1200;
const DEFAULT_MAX_FILE_CONTEXT_CHARS = 32000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stringifyLlmError = (err) => err?.message || err?.cause?.message || String(err);

const looksLikeGeminiDailyQuotaExhausted = (msg) =>
  /PerDay|RequestsPerDay|quotaValue|free_tier_requests|FreeTier/i.test(msg);

const parseGeminiRetryDelayMs = (msg) => {
  const retryIn = msg.match(/retry in\s+([\d.]+)\s*s/i);
  if (retryIn) return Math.ceil(parseFloat(retryIn[1], 10) * 1000) + 250;
  const retryDelay = msg.match(/retryDelay[":\s]+"?(\d+)s?/i);
  if (retryDelay) return Math.ceil(parseInt(retryDelay[1], 10) * 1000) + 250;
  return null;
};

async function generateContentWithRetry(generateFn, meta = {}) {
  const label = meta.label ? `[${meta.label}] ` : '';
  const httpMax = Math.max(1, Number(process.env.AI_LLM_HTTP_RETRIES) || Number(process.env.AI_GEMINI_HTTP_RETRIES) || 8);

  let lastErr;
  for (let attempt = 1; attempt <= httpMax; attempt += 1) {
    try {
      const text = await generateFn();
      return text;
    } catch (err) {
      lastErr = err;
      const msg = stringifyLlmError(err);
      const isQuota = /\b429\b|Too Many Requests|Resource exhausted|quota|rate limit/i.test(msg);
      if (!isQuota || attempt >= httpMax) {
        throw err;
      }
      if (looksLikeGeminiDailyQuotaExhausted(msg)) {
        throw new Error(
          `${label}LLM đã hết quota/hạn mức (thường là Gemini free-tier theo ngày). Đổi AI_PROVIDER, model, billing hoặc chờ reset. Chi tiết: ${msg}`
        );
      }

      let waitMs =
        parseGeminiRetryDelayMs(msg)
        ?? Math.min(90000, 2000 * 2 ** (attempt - 1));
      waitMs += Math.floor(Math.random() * 400);
      console.log(`${label}[AI Agent] LLM 429/backoff attempt ${attempt}/${httpMax}, waiting ${waitMs}ms`);

      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const resolveVerifyRetryLimit = () => {
  const raw = process.env.AI_MAX_VERIFY_RETRIES;
  if (raw === '-1' || String(raw).toLowerCase() === 'unlimited') {
    return { unlimited: true, limit: Infinity };
  }
  if (raw === undefined || raw === '') {
    return { unlimited: false, limit: Math.max(0, Number(process.env.AI_VERIFY_RETRY_DEFAULT) || 4) };
  }
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    return { unlimited: false, limit: 4 };
  }
  return { unlimited: false, limit: n };
};

const runCommand = (command, cwd) => {
  return new Promise((resolve, reject) => {
    console.log(`[AI Agent] Executing: ${command} in ${cwd}`);
    exec(command, { cwd, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout, stderr });
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

/** Mỗi lần chạy một nhánh mới: ai-fix/<ticket>-<UTC YYYYMMDDHHmmssSSS> — tránh trùng remote / non-fast-forward. */
const buildAiFixBranchName = (ticketKey) => {
  const key = String(ticketKey || 'ticket')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || 'ticket';
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}`;
  return `ai-fix/${key}-${stamp}`;
};

const shellSingleQuote = (str) => `'${String(str).replace(/'/g, `'\\''`)}'`;


const removeAccents = (str) => {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
};

const extractContextSignals = (ticketDetails, additionalContext) => {
  const raw = `${ticketDetails?.summary || ''}\n${ticketDetails?.description || ''}\n${additionalContext || ''}`;
  const signals = new Set();

  // 1. Code snippets in backticks
  const backticks = raw.match(/`([^`]+)`/g) || [];
  for (const m of backticks) {
    const inner = m.slice(1, -1).trim().replace(/\\/g, '/');
    if (inner.length < 2) continue;
    signals.add(inner);
    const bn = path.posix.basename(inner);
    if (bn && bn.includes('.')) signals.add(bn);
  }

  // 2. Path-like strings
  const pathLike = raw.match(/[\w\-./\\]+\.(cs|ts|tsx|js|html|scss|json)(?=\s|$|[\]`'"])/gi) || [];
  for (const p of pathLike) {
    const norm = p.replace(/\\/g, '/');
    signals.add(norm);
    signals.add(path.posix.basename(norm));
  }

  // 3. PascalCase (Classes, Components)
  const pascal = raw.match(/\b[A-Z][a-zA-Z0-9]{7,}\b/g) || [];
  const noise = new Set(['Application', 'Framework', 'Component', 'Repository', 'Controller', 'Attribute', 'Exception', 'Request', 'Response', 'Settings', 'Provider', 'Extension']);
  for (const w of pascal) {
    if (!noise.has(w)) signals.add(w);
  }

  // 4. Natural language keywords (including Vietnamese)
  // Especially focus on words in additionalContext
  const contextWords = (additionalContext || '').split(/[^a-z0-9A-ZÀ-ỹ]+/u).filter(w => w.length >= 3);
  const stopWords = new Set(['ticket', 'jira', 'project', 'error', 'issue', 'fix', 'from', 'with', 'that', 'this', 'have', 'will', 'for', 'and', 'the']);
  for (const w of contextWords) {
    if (!stopWords.has(w.toLowerCase())) {
      signals.add(w);
      const noAcc = removeAccents(w);
      if (noAcc.length >= 3) signals.add(noAcc);
    }
  }

  // 5. Multi-word phrases (e.g. "xe qua trạm")
  const words = raw.split(/[^a-z0-9A-ZÀ-ỹ]+/u).filter(w => w.length >= 3);
  for (let i = 0; i < words.length - 1; i++) {
    const phrase2 = `${words[i]} ${words[i+1]}`;
    if (phrase2.length >= 6) signals.add(phrase2);
    if (i < words.length - 2) {
      const phrase3 = `${words[i]} ${words[i+1]} ${words[i+2]}`;
      if (phrase3.length >= 9) signals.add(phrase3);
    }
  }

  const maxSig = Math.max(10, Number(process.env.AI_GREP_MAX_SIGNALS) || 30);
  const safe = [];
  for (const s of signals) {
    const t = String(s).trim();
    if (t.length < 3) continue;
    // Allow Vietnamese characters, common code chars and spaces for phrases
    if (!/^[\w./\- À-ỹ]+$/u.test(t)) continue;
    safe.push(t);
  }
  return Array.from(new Set(safe)).slice(0, maxSig);
};

const toGrepLiteral = (sig) => {
  const s = String(sig).replace(/\\/g, '/');
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    return parts[parts.length - 1] || s;
  }
  return s;
};

const getGrepPathspecs = (stacks) => {
  const specs = new Set();
  for (const stack of stacks || []) {
    if (stack === 'dotnet') {
      ['*.cs', '*.csproj', '*.sln'].forEach(x => specs.add(x));
    }
    if (stack === 'angular') {
      ['*.ts', '*.html', '*.scss'].forEach(x => specs.add(x));
    }
    if (stack === 'nodejs') {
      ['*.js', '*.ts', '*.json'].forEach(x => specs.add(x));
    }
  }
  if (specs.size === 0) {
    ['*.cs', '*.ts', '*.tsx', '*.js'].forEach(x => specs.add(x));
  }
  return Array.from(specs);
};

const gatherGrepMatchedFiles = async (repoPath, signals, stacks) => {
  if (String(process.env.AI_GREP_ENABLE) === '0') return [];
  const maxPerSignal = Math.max(4, Number(process.env.AI_GREP_MAX_FILES_PER_SIGNAL) || 12);
  const maxTotal = Math.max(12, Number(process.env.AI_GREP_MAX_TOTAL_FILES) || 48);
  const pathspecs = getGrepPathspecs(stacks);
  const specArg = pathspecs.map(p => shellSingleQuote(p)).join(' ');
  const ordered = [];
  const seen = new Set();

  for (const sig of signals) {
    if (ordered.length >= maxTotal) break;
    const literal = toGrepLiteral(sig);
    if (literal.length < 4) continue;
    const quoted = shellSingleQuote(literal);
    try {
      const cmd = `git grep -l -F ${quoted} HEAD -- ${specArg}`;
      const r = await runCommand(cmd, repoPath);
      const lines = r.stdout.split('\n').map(l => l.trim()).filter(Boolean);
      let n = 0;
      for (const file of lines) {
        if (ordered.length >= maxTotal || n >= maxPerSignal) break;
        const norm = file.replace(/\\/g, '/');
        if (!seen.has(norm)) {
          seen.add(norm);
          ordered.push(norm);
          n += 1;
        }
      }
    } catch (e) {
      // no matches or git error — skip signal
    }
  }
  return ordered;
};

/** Gộp tín hiệu grep: skill trước (ưu tiên quét theo EXPERT SKILLS), ticket/context sau. */
const mergeSignalsSkillFirst = (skillSignals, ticketSignals, maxTotal) => {
  const cap = Math.max(8, Number(maxTotal) || 22);
  const seen = new Set();
  const out = [];
  for (const arr of [skillSignals || [], ticketSignals || []]) {
    for (const s of arr) {
      const t = String(s || '').trim();
      if (t.length < 3) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length >= cap) return out;
    }
  }
  return out;
};

/** Token từ nội dung skill để boost điểm path (path-like + từ dài), giảm cần quét mù. */
const extractSkillScoringTokens = (expertSkillsText) => {
  const raw = String(expertSkillsText || '');
  if (!raw.trim()) return [];
  const maxT = Math.max(8, Number(process.env.AI_SKILL_SCORE_TOKEN_CAP) || 40);
  const tokens = new Set();
  const pathLike = raw.match(/[\w\-./\\]+\.(cs|ts|tsx|js|html|scss|json|csproj|razor|cshtml)/gi) || [];
  for (const p of pathLike) {
    const norm = p.replace(/\\/g, '/').toLowerCase();
    tokens.add(norm);
    tokens.add(path.posix.basename(norm).toLowerCase());
    const parts = norm.split('/').filter(Boolean);
    for (const seg of parts) {
      if (seg.length >= 5 && seg.includes('.')) tokens.add(seg);
    }
  }
  const words = raw.toLowerCase().match(/[a-z][a-z0-9_]{4,}/g) || [];
  const noise = new Set([
    'function', 'return', 'example', 'angular', 'typescript', 'javascript', 'project', 'service',
    'component', 'module', 'string', 'number', 'boolean', 'import', 'export', 'public', 'private',
    'interface', 'namespace', 'package', 'default', 'extends', 'implements', 'description',
  ]);
  for (const w of words) {
    if (!noise.has(w) && w.length <= 56) tokens.add(w);
  }
  return Array.from(tokens).filter(Boolean).slice(0, maxT);
};

const mergeUniquePreferFirst = (primary, secondary) => {
  const seen = new Set();
  const out = [];
  for (const f of primary || []) {
    const k = String(f).replace(/\\/g, '/');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  for (const f of secondary || []) {
    const k = String(f).replace(/\\/g, '/');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
};

const getStackPreferredDirs = (stacks) => {
  const dirs = new Set(['src/', 'app/']);
  for (const stack of stacks || []) {
    if (stack === 'dotnet') ['aspnet-core/', 'backend/', 'server/', 'src/'].forEach(d => dirs.add(d));
    if (stack === 'angular') ['angular/', 'frontend/', 'client/', 'src/app/'].forEach(d => dirs.add(d));
    if (stack === 'nodejs') ['server/', 'backend/', 'api/', 'src/'].forEach(d => dirs.add(d));
  }
  return Array.from(dirs);
};

const buildContextFileList = (allFiles, stacks, ticketDetails, additionalContext, expertSkillsText = '') => {
  const sourceExts = new Set(['.js', '.ts', '.tsx', '.cs', '.html', '.css', '.scss', '.json', '.csproj', '.sln', '.xml', '.config']);
  const importantConfigNames = new Set(['package.json', 'angular.json', 'tsconfig.json', 'tsconfig.app.json']);
  const ignoredSegments = ['node_modules/', 'bin/', 'obj/', 'dist/', 'wwwroot/lib/'];
  const preferredDirs = getStackPreferredDirs(stacks);
  const maxContextFiles = Math.max(32, Number(process.env.AI_MAX_CONTEXT_FILES) || DEFAULT_MAX_CONTEXT_FILES);
  const skillTokens = extractSkillScoringTokens(expertSkillsText);

  const contextText = `${ticketDetails?.summary || ''} ${ticketDetails?.description || ''}`.toLowerCase();
  const userText = (additionalContext || '').toLowerCase();
  const stopWords = new Set(['ticket', 'jira', 'project', 'error', 'issue', 'fix', 'from', 'with', 'that', 'this', 'have', 'will', 'for', 'and', 'the']);
  
  const keywords = Array.from(new Set(
    contextText
      .split(/[^a-z0-9_À-ỹ]+/u)
      .map(t => t.trim())
      .filter(t => t.length >= 4 && !stopWords.has(t))
  )).slice(0, 16);

  const userKeywords = Array.from(new Set(
    userText
      .split(/[^a-z0-9_À-ỹ]+/u)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !stopWords.has(t))
  )).slice(0, 16);

  const sourceFiles = allFiles.filter(f => {
    const normalized = f.replace(/\\/g, '/');
    if (ignoredSegments.some(seg => normalized.includes(seg))) return false;
    const ext = path.extname(normalized).toLowerCase();
    if (sourceExts.has(ext)) return true;
    const base = path.basename(normalized).toLowerCase();
    return importantConfigNames.has(base);
  });

  const scored = sourceFiles.map((file) => {
    const normalized = file.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    let score = 0;

    if (preferredDirs.some(d => lower.startsWith(d) || lower.includes(`/${d}`))) score += 3;
    if (importantConfigNames.has(path.basename(lower))) score += 2;
    if (lower.endsWith('.sln') || lower.endsWith('.csproj')) score += 2;
    if (lower.endsWith('.component.ts') || lower.endsWith('.service.ts') || lower.endsWith('.appservice.cs')) score += 2;

    for (const kw of keywords) {
      if (path.basename(lower).includes(kw)) score += 4;
      else if (lower.includes(kw)) score += 2;
    }

    // USER CONTEXT gets huge weight
    const lowerNoAccents = removeAccents(lower);
    for (const ukw of userKeywords) {
      const ukwNoAccents = removeAccents(ukw);
      if (path.basename(lower).includes(ukw) || path.basename(lowerNoAccents).includes(ukwNoAccents)) {
        score += 20; 
      } else if (lower.includes(ukw) || lowerNoAccents.includes(ukwNoAccents)) {
        score += 10;
      }
    }

    for (const st of skillTokens) {
      if (st.length < 4) continue;
      if (path.basename(lower).includes(st)) score += 35;
      else if (lower.includes(st)) score += 16;
    }

    // SPECIAL BOOST for Navigation Service if ticket mentions icons/menu
    const navKeywords = ['menu', 'sidebar', 'navigation', 'icon', 'trùng', 'đổi', 'mục', 'điều hướng'];
    const isNavTicket = navKeywords.some(nk => contextText.includes(nk) || userText.includes(nk));
    if (isNavTicket && (lower.includes('app-navigation.service.ts') || lower.includes('app-navigation.services.ts'))) {
      score += 60;
    }

    return { file, score };
  });

  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));

  return scored.slice(0, maxContextFiles).map((x) => x.file);
};

const buildPlanningCandidateFiles = (filteredFiles, stacks, ticketDetails, additionalContext, expertSkillsText = '') => {
  const maxPlanningFiles = Math.max(24, Number(process.env.AI_MAX_PLANNING_FILES) || DEFAULT_MAX_PLANNING_FILES);
  const contextText = `${ticketDetails?.summary || ''} ${ticketDetails?.description || ''} ${additionalContext || ''}`.toLowerCase();
  const stopWords = new Set(['ticket', 'jira', 'project', 'error', 'issue', 'fix', 'from', 'with', 'that', 'this', 'have', 'will', 'for', 'and', 'the']);
  const keywords = Array.from(new Set(
    contextText
      .split(/[^a-z0-9_À-ỹ]+/u)
      .map(t => t.trim())
      .filter(t => t.length >= 4 && !stopWords.has(t))
  )).slice(0, 18);
  const skillTokens = extractSkillScoringTokens(expertSkillsText);

  const stackHints = [];
  if ((stacks || []).includes('dotnet')) stackHints.push('.cs', '.csproj', '.sln', 'appservice', 'export', 'report', 'dto', 'interface');
  if ((stacks || []).includes('angular')) stackHints.push('.ts', '.html', '.scss', '.component', '.service', 'module', 'proxy');
  if ((stacks || []).includes('nodejs')) stackHints.push('.js', '.ts', 'controller', 'service', 'route', 'api');

  const scored = filteredFiles.map((file) => {
    const lower = file.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (path.basename(lower).includes(kw)) score += 8;
      else if (lower.includes(kw)) score += 4;
    }
    for (const hint of stackHints) {
      if (lower.includes(hint)) score += 2;
    }
    if (lower.endsWith('.sln') || lower.endsWith('.csproj') || lower.endsWith('angular.json') || lower.endsWith('package.json')) score += 3;

    for (const st of skillTokens) {
      if (st.length < 4) continue;
      if (path.basename(lower).includes(st)) score += 14;
      else if (lower.includes(st)) score += 7;
    }

    return { file, score };
  });

  scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file));
  const narrowed = scored.slice(0, maxPlanningFiles).map(x => x.file);
  return narrowed.length > 0 ? narrowed : filteredFiles.slice(0, maxPlanningFiles);
};

/** Prompt planning: số thứ tự + chỉ mục basename → path để model khớp tên file với đúng path. */
const formatPlanningCandidatesForPrompt = (relativePaths) => {
  const paths = (relativePaths || []).map((p) => String(p).replace(/\\/g, '/')).filter(Boolean);
  if (paths.length === 0) {
    return { numberedList: '(empty)', basenameIndex: '(empty)', count: 0 };
  }
  const numberedList = paths.map((f, i) => `${String(i + 1).padStart(3, '0')}  ${f}`).join('\n');
  const byBase = new Map();
  for (const f of paths) {
    const b = path.posix.basename(f);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }
  const lines = [];
  for (const b of Array.from(byBase.keys()).sort((a, x) => a.localeCompare(x))) {
    const ps = [...byBase.get(b)].sort();
    if (ps.length === 1) lines.push(`${b}  →  ${ps[0]}`);
    else {
      lines.push(`${b}  (${ps.length} paths — chọn path khớp module/ticket):`);
      ps.forEach((p) => lines.push(`  - ${p}`));
    }
  }
  return { numberedList, basenameIndex: lines.join('\n'), count: paths.length };
};

const REPO_PLANNING_INDEX_IGNORED = [
  'node_modules/',
  'bin/',
  'obj/',
  'dist/',
  'wwwroot/lib/',
  '/packages/',
  '.angular/',
  'coverage/',
  '__MACOSX/',
  '/.git/',
];

const shouldIncludePathInPlanningRepoIndex = (relPath) => {
  const normalized = String(relPath || '').replace(/\\/g, '/').trim();
  if (!normalized) return false;
  if (REPO_PLANNING_INDEX_IGNORED.some((seg) => normalized.includes(seg))) return false;
  const ext = path.extname(normalized).toLowerCase();
  const sourceExts = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.cjs',
    '.cs',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.json',
    '.xml',
    '.config',
    '.csproj',
    '.sln',
    '.props',
    '.targets',
    '.resx',
    '.xaml',
    '.sql',
    '.razor',
    '.cshtml',
  ]);
  const base = path.basename(normalized).toLowerCase();
  const important = new Set([
    'package.json',
    'angular.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'nx.json',
    'project.json',
  ]);
  return sourceExts.has(ext) || important.has(base);
};

const dirnameShortForPrompt = (relPath, maxLen = 96) => {
  const d = path.posix.dirname(String(relPath || '').replace(/\\/g, '/'));
  if (!d || d === '.') return '';
  return d.length > maxLen ? `...${d.slice(-(maxLen - 3))}` : d;
};

/**
 * Chỉ mục repo cho bước planning — mặc định chỉ phần basename/trùng tên để tránh prompt >128k token.
 * AI_PLANNING_REPO_INDEX_MODE=dupes (mặc định) | basenames | full
 */
const buildRepoPlanningIndexForPrompt = (allRepoFiles) => {
  if (String(process.env.AI_PLANNING_REPO_INDEX_DISABLE || '').toLowerCase() === '1') {
    return { text: '', linesShown: 0, linesTotal: 0, truncatedBy: '', mode: 'off' };
  }
  const filtered = (allRepoFiles || [])
    .map((f) => String(f).replace(/\\/g, '/').trim())
    .filter(Boolean)
    .filter(shouldIncludePathInPlanningRepoIndex)
    .sort((a, b) => a.localeCompare(b));

  const mode = String(process.env.AI_PLANNING_REPO_INDEX_MODE || 'dupes').toLowerCase();
  const maxLines = Math.max(200, Number(process.env.AI_PLANNING_REPO_INDEX_MAX_LINES) || 2800);
  const maxChars = Math.max(8000, Number(process.env.AI_PLANNING_REPO_INDEX_MAX_CHARS) || 72000);
  const maxDupBasenames = Math.max(30, Number(process.env.AI_PLANNING_REPO_INDEX_DUPE_ROWS) || 450);
  const maxPathsPerDupe = Math.max(2, Number(process.env.AI_PLANNING_REPO_INDEX_DUPE_PATHS_EACH) || 10);

  const byBasePaths = new Map();
  for (const f of filtered) {
    const b = path.posix.basename(f);
    if (!byBasePaths.has(b)) byBasePaths.set(b, []);
    byBasePaths.get(b).push(f);
  }

  const buildDupeDetailBody = () => {
    const dupeBases = [...byBasePaths.entries()]
      .filter(([, arr]) => arr.length > 1)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    const lines = [];
    let chars = 0;
    let truncatedBy = '';
    let shownBases = 0;
    for (const [b, arr] of dupeBases) {
      if (shownBases >= maxDupBasenames) {
        truncatedBy = 'dupe-basename-cap';
        break;
      }
      const chunkHead = `${b} (${arr.length} paths):\n`;
      if (chars + chunkHead.length > maxChars) {
        truncatedBy = 'chars';
        break;
      }
      chars += chunkHead.length;
      lines.push(chunkHead.replace(/\n$/, ''));
      const slice = arr.slice(0, maxPathsPerDupe);
      for (const p of slice) {
        const row = `  - ${p}\n`;
        if (chars + row.length > maxChars) {
          truncatedBy = 'chars';
          break;
        }
        chars += row.length;
        lines.push(row.replace(/\n$/, ''));
      }
      if (truncatedBy) break;
      if (arr.length > slice.length) {
        const more = `  - ... +${arr.length - slice.length} path khác\n`;
        if (chars + more.length <= maxChars) {
          chars += more.length;
          lines.push(more.replace(/\n$/, ''));
        }
      }
      shownBases += 1;
      if (truncatedBy) break;
    }
    return { body: lines.join('\n'), lineCount: lines.length, truncatedBy, shownBases };
  };

  const buildBasenamesOnlyBody = () => {
    const uniq = [...byBasePaths.keys()].sort((a, b) => a.localeCompare(b));
    let body = '';
    let lineCount = 0;
    let truncatedBy = '';
    for (const b of uniq) {
      const piece = `${b}\n`;
      if (lineCount >= maxLines) {
        truncatedBy = 'lines';
        break;
      }
      if (body.length + piece.length > maxChars) {
        truncatedBy = 'chars';
        break;
      }
      body += piece;
      lineCount += 1;
    }
    return { body, lineCount, truncatedBy };
  };

  const buildFullPathsBody = () => {
    let body = '';
    let lineCount = 0;
    let truncatedBy = '';
    for (const line of filtered) {
      const piece = `${line}\n`;
      if (lineCount >= maxLines) {
        truncatedBy = 'lines';
        break;
      }
      if (body.length + piece.length > maxChars) {
        truncatedBy = 'chars';
        break;
      }
      body += piece;
      lineCount += 1;
    }
    return { body, lineCount, truncatedBy };
  };

  let body = '';
  let lineCount = 0;
  let truncatedBy = '';
  let headline = '';

  if (mode === 'full') {
    headline = 'REPO FILE INDEX (full path — tốn token; ưu tiên FILE CANDIDATES bên dưới)';
    const r = buildFullPathsBody();
    body = r.body;
    lineCount = r.lineCount;
    truncatedBy = r.truncatedBy;
  } else if (mode === 'basenames') {
    headline = 'REPO FILE INDEX (chỉ danh sách basename đã lọc — disambiguate qua FILE CANDIDATES)';
    const r = buildBasenamesOnlyBody();
    body = r.body;
    lineCount = r.lineCount;
    truncatedBy = r.truncatedBy;
  } else {
    headline =
      'REPO FILE INDEX (chỉ các basename xuất hiện ở NHIỀU path — tiết kiệm token; file basename unique: dựa FILE CANDIDATES + SYMBOL HINTS)';
    const r = buildDupeDetailBody();
    body = r.body;
    lineCount = r.lineCount;
    truncatedBy = r.truncatedBy;
    if (!body.trim()) {
      body = '(no duplicate basenames in filtered set — mọi basename là duy nhất trong tập đã lọc)';
      lineCount = 1;
    }
  }

  const dupeSummary = [...byBasePaths.entries()].filter(([, arr]) => arr.length > 1).length;
  const stats = `Mode=${mode}; ${filtered.length} path sau lọc; basename trùng: ${dupeSummary}; trong prompt ~${lineCount} dòng${truncatedBy ? ` — cắt: ${truncatedBy}` : ''}.`;

  const text = `
${headline}
Thống kê: ${stats}
---
${body}${truncatedBy ? '\n...[REPO INDEX TRUNCATED — chỉnh AI_PLANNING_REPO_INDEX_*]\n' : ''}
`.trim();

  return { text, linesShown: lineCount, linesTotal: filtered.length, truncatedBy, mode };
};

const shellEscapeDoubleQuotes = (value) => String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const deriveAuthorNameFromEmail = (email) => {
  if (!email || typeof email !== 'string') return '';
  const localPart = email.split('@')[0] || '';
  if (!localPart) return '';
  return localPart
    .replace(/[._-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
};

/**
 * Trích object JSON đầu tiên an toàn (cân ngoặc, tôn trọng string JSON có ký tự }).
 * Tránh regex greedy \\{[\\s\\S]*\\} gây parse lỗi / "Unexpected non-whitespace after JSON" với refine-edit.
 */
const extractFirstBalancedJsonObject = (text) => {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
};

const extractJsonFromModelResponse = (responseText) => {
  const raw = String(responseText || '').trim();
  if (!raw) return null;

  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1].trim());
  candidates.push(raw);

  for (const block of candidates) {
    const balanced = extractFirstBalancedJsonObject(block);
    if (!balanced) continue;
    try {
      return JSON.parse(balanced.trim());
    } catch {
      /* thử candidate khác */
    }
  }
  return null;
};

const mergeChangesByPath = (existingChanges, incomingChanges) => {
  const byPath = new Map();
  for (const change of existingChanges || []) {
    const key = String(change?.path || '').trim();
    if (!key) continue;
    byPath.set(key, { ...change, path: key });
  }
  for (const change of incomingChanges || []) {
    const key = String(change?.path || '').trim();
    if (!key) continue;
    // Newer change for same file replaces older content.
    byPath.set(key, { ...(byPath.get(key) || {}), ...change, path: key });
  }
  return Array.from(byPath.values());
};

const truncateText = (value, maxChars) => {
  const str = String(value || '');
  if (!maxChars || str.length <= maxChars) return str;
  return `${str.substring(0, maxChars)}\n...[TRUNCATED]`;
};

/**
 * Chỉ cắt ticket/context khi bạn chủ động đặt env (số > 0). Mặc định: không giới hạn — đọc hết summary, description, pipeline.
 * Ví dụ khẩn cấp: AI_TICKET_DESCRIPTION_MAX_CHARS=500000
 */
const resolveOptionalTicketMaxChars = (envKey) => {
  const n = Number(process.env[envKey]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
};

/**
 * Khối ticket + context người dùng — đưa vào planner/implement (không cắt trừ khi có env).
 * Nhấn mạnh thứ tự: đọc hết ticket → context → mới phân tích mã.
 */
const buildFullTicketContextBlock = (ticketKey, ticketDetails, pipelineContext) => {
  const sumMax = resolveOptionalTicketMaxChars('AI_TICKET_SUMMARY_MAX_CHARS');
  const descMax = resolveOptionalTicketMaxChars('AI_TICKET_DESCRIPTION_MAX_CHARS');
  const pipeMax = resolveOptionalTicketMaxChars('AI_PIPELINE_CONTEXT_MAX_CHARS');

  const summary = truncateText(ticketDetails?.summary || '', sumMax);
  const description = truncateText(ticketDetails?.description || '', descMax);
  const userCtx = truncateText(pipelineContext || '', pipeMax);

  return (
    `=== QUY TRÌNH ĐỌC BẮT BUỘC (theo thứ tự, không được bỏ bước) ===\n` +
    `(1) Đọc HẾT TICKET SUMMARY và TICKET DESCRIPTION: acceptance criteria, phạm vi, bước tái hiện, expected/actual, log, screenshot text, comment Jira.\n` +
    `(2) Đọc HẾT khối USER / PROJECT CONTEXT (memory, phản hồi user, log bổ sung).\n` +
    `(3) Chỉ sau khi (1)(2) xong mới phân tích sâu SYMBOL HINTS, CODE SUMMARIES và FILE CONTENT trong repo.\n` +
    `(4) Mọi target_file / patch phải căn cứ trực tiếp hoặc gián tiếp vào yêu cầu trong (1)(2); không suy diễn ngoài ticket.\n\n` +
    `=== TICKET KEY ===\n${ticketKey}\n\n` +
    `=== TICKET SUMMARY ===\n${summary || '(empty)'}\n\n` +
    `=== TICKET DESCRIPTION (ưu tiên đọc đủ — thường chứa AC và chi tiết lỗi) ===\n${description || '(empty)'}\n\n` +
    `=== USER CONTEXT + PROJECT MEMORY + BỔ SUNG ===\n${userCtx || '(none)'}`
  );
};

/**
 * LLM chọn path từ pool repo (không rule cứng ABP/menu). Chỉ merge path có trong pool.
 */
const suggestPathsViaLlm = async ({
  ticketDetails,
  pipelineContext,
  allRepoFiles,
  expertSkillsPreview,
  llmGenerate,
  generateContentWithRetry,
}) => {
  if (String(process.env.AI_PATH_SUGGEST_ENABLE || '1') === '0') return [];
  const maxPool = Math.max(200, Number(process.env.AI_PATH_SUGGEST_POOL_LINES) || 600);
  const maxPick = Math.min(56, Math.max(6, Number(process.env.AI_PATH_SUGGEST_MAX_PICK) || 28));
  const pool = (allRepoFiles || [])
    .map((f) => String(f).replace(/\\/g, '/').trim())
    .filter(Boolean)
    .filter(shouldIncludePathInPlanningRepoIndex)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, maxPool);
  if (pool.length === 0) return [];
  const baseCount = new Map();
  for (const p of pool) {
    const b = path.posix.basename(p);
    baseCount.set(b, (baseCount.get(b) || 0) + 1);
  }
  const listBlock = pool
    .map((p, i) => {
      const b = path.posix.basename(p);
      const dirHint = baseCount.get(b) > 1 ? dirnameShortForPrompt(p, 88) : '';
      const idx = String(i + 1).padStart(4, '0');
      return dirHint ? `${idx}\t${b}\t${dirHint}` : `${idx}\t${b}`;
    })
    .join('\n');
  const skillsClip = truncateText(
    expertSkillsPreview || '',
    Math.max(1500, Number(process.env.AI_PATH_SUGGEST_SKILL_CHARS) || 8000)
  );
  const ctxClip = (() => {
    const n = Number(process.env.AI_PATH_SUGGEST_CONTEXT_CHARS);
    if (Number.isFinite(n) && n > 0) return truncateText(pipelineContext || '', Math.floor(n));
    return String(pipelineContext || '');
  })();
  const prompt = `Bạn là trợ lý chọn file trong repo. Chỉ trả về một object JSON hợp lệ (không markdown, không code fence).

DANH_SACH (mỗi dòng: STT TAB basename [TAB thư_mục_rút_gọn nếu basename trùng trong list]). Phân tích theo TÊN FILE + ticket/skill; thư mục chỉ để phân biệt khi trùng tên.
${listBlock}

TICKET:
summary: ${JSON.stringify(ticketDetails?.summary || '')}
description: ${JSON.stringify(ticketDetails?.description || '')}

USER_CONTEXT (toàn bộ — không cắt mặc định; chỉ cắt nếu đặt AI_PATH_SUGGEST_CONTEXT_CHARS > 0):
${ctxClip}

EXPERT_SKILLS (rút — ưu tiên đọc tên skill + pattern, không cần nhớ hết chi tiết):
${skillsClip}

Trả về JSON (ưu tiên dùng STT để tiết kiệm token):
{"indices":[1, 5, ...], "paths": [], "reasoning_vi": "..."}
- indices: mảng số thứ tự STT (1-based) từ DANH_SACH, tối đa ${maxPick} phần tử, ưu tiên file cần sửa cho ticket.
- paths: để trống [] nếu dùng indices; nếu gửi paths thì mỗi path phải khớp y nguyên một dòng path đầy đủ trong pool nội bộ (không liệt kê lại ở đây — chỉ dùng indices là đủ).
- Chỉ chọn STT từ 1 đến ${pool.length}. Không bịa STT.`;

  try {
    const model = getFastModel();
    const raw = await generateContentWithRetry(() => llmGenerate(prompt, { model }), { label: 'path-suggest' });
    const parsed = extractJsonFromModelResponse(raw);
    const out = [];
    const set = new Set(pool);
    const idxArr = Array.isArray(parsed?.indices) ? parsed.indices : [];
    for (const x of idxArr) {
      const n = Number(x);
      if (!Number.isFinite(n) || n < 1 || n > pool.length) continue;
      const p = pool[Math.floor(n) - 1];
      if (p && !out.includes(p)) out.push(p);
      if (out.length >= maxPick) break;
    }
    if (out.length < maxPick) {
      const arr = Array.isArray(parsed?.paths) ? parsed.paths : [];
      for (const p of arr) {
        const n = String(p || '').replace(/\\/g, '/').trim();
        if (set.has(n) && !out.includes(n)) out.push(n);
        if (out.length >= maxPick) break;
      }
    }
    return out;
  } catch (e) {
    console.error('[AI Agent] path-suggest skipped:', e.message || e);
    return [];
  }
};

const resolvePositiveLimit = (raw) => {
  if (raw === undefined || raw === null || raw === '') return Infinity;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return Math.floor(n);
};

/** Expert skills: đọc từ PostgreSQL (bảng app_expert_skills). */
const loadProjectSkillsContextAsync = async (selectedSkillsRaw) => {
  const skillsStore = require('./skills-store');
  const maxActiveSkills = resolvePositiveLimit(process.env.AI_MAX_ACTIVE_SKILLS);
  const maxSingleSkillChars = resolvePositiveLimit(process.env.AI_MAX_SINGLE_SKILL_CHARS);
  const maxTotalSkillsChars = Math.max(4000, Number(process.env.AI_MAX_SKILLS_CHARS) || DEFAULT_MAX_SKILLS_CHARS);
  return skillsStore.loadProjectSkillsFromDb(selectedSkillsRaw, {
    maxActiveSkills,
    maxSingleSkillChars,
    maxTotalSkillsChars,
  });
};

const parseChangedLinesFromDiff = (diffText) => {
  const changed = {};
  const lines = String(diffText || '').split('\n');
  let currentFile = null;
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      if (currentFile && !changed[currentFile]) changed[currentFile] = [];
      continue;
    }
    if (!currentFile) continue;
    const m = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!m) continue;
    const start = Number(m[1]);
    const count = Number(m[2] || 1);
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    const end = start + count - 1;
    changed[currentFile].push(start === end ? `${start}` : `${start}-${end}`);
  }
  return changed;
};

const attachChangedLinesFromGitDiff = async (repoPath, changes) => {
  const paths = (changes || []).map(c => String(c.path || '').trim()).filter(Boolean);
  if (paths.length === 0) return changes || [];
  const pathArgs = paths.map(p => shellSingleQuote(p)).join(' ');
  try {
    const diffRes = await runCommand(`git diff --unified=0 -- ${pathArgs}`, repoPath);
    const changedLinesByFile = parseChangedLinesFromDiff(diffRes.stdout || '');
    return (changes || []).map((c) => ({
      ...c,
      changed_lines: changedLinesByFile[c.path] || []
    }));
  } catch (e) {
    return changes || [];
  }
};

const OPTIONAL_CHANGE_VERIFICATION_VI_FIELDS = [
  ['file_correctness_vi', 'Xác nhận đúng file'],
  ['change_rationale_vi', 'Vì sao sửa'],
  ['downstream_impact_vi', 'Ảnh hưởng sau khi sửa'],
  ['consistency_notes_vi', 'Khớp codebase / convention'],
];

/** Gộp các trường xác thực (nếu model trả riêng) vào review_comment để reviewer đọc một chỗ. */
const enrichChangeVerificationComments = (changes) =>
  (changes || []).map((change) => {
    const extras = [];
    for (const [key, label] of OPTIONAL_CHANGE_VERIFICATION_VI_FIELDS) {
      const v = String(change[key] || '').trim();
      if (v) extras.push(`${label}: ${v}`);
    }
    if (extras.length === 0) return change;
    const base = String(change.review_comment || '').trim();
    return {
      ...change,
      review_comment: [base, ...extras].filter(Boolean).join('\n'),
    };
  });

/** Gộp phân tích tác động tổng vào reasoning text (một cột DB). */
const mergeImplementReasoningWithImpact = (fixData) => {
  let r = String(fixData.reasoning || '').trim();
  const impact = String(fixData.impact_analysis_vi || '').trim();
  const consistency = String(fixData.codebase_consistency_vi || '').trim();
  const blocks = [];
  if (impact) blocks.push(`Phân tích tác động (tổng): ${impact}`);
  if (consistency) blocks.push(`Đối chiếu convention/codebase: ${consistency}`);
  if (blocks.length) r = r ? `${r}\n\n---\n${blocks.join('\n\n')}` : blocks.join('\n\n');
  return r;
};

const ensureReviewComments = (changes) => {
  return (changes || []).map((change) => {
    const reviewComment = String(change?.review_comment || '').trim();
    if (reviewComment) return change;
    const editMode = Array.isArray(change?.edits) && change.edits.length > 0 ? 'edits' : 'full-content';
    return {
      ...change,
      review_comment: `Sửa theo chế độ ${editMode}: cập nhật logic theo ticket, cần review nhanh ở các dòng đã đổi.`,
    };
  });
};

const filterErrorLogForChangedFiles = (errorLog, changedPaths) => {
  const text = String(errorLog || '');
  const paths = (changedPaths || []).map((p) => String(p || '').toLowerCase());
  if (paths.length === 0 || !text) return text;
  const lines = text.split('\n');
  const kept = [];
  let keepBlock = false;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const isFileHeader = /\/.*\.(ts|tsx|js|cs|html|scss|css|json)\s*$/.test(lower) || /^\S+\/\S+\.(ts|tsx|js|cs|html|scss|css|json)\s*$/.test(lower);
    if (isFileHeader) {
      keepBlock = paths.some((p) => lower.includes(p));
    }
    if (keepBlock) kept.push(line);
  }
  return kept.length > 0 ? kept.join('\n') : text;
};

const keepOnlyAllowedChanges = (changes, allowedPaths) => {
  const allowed = new Set((allowedPaths || []).map(p => String(p || '').replace(/\\/g, '/').toLowerCase()));
  return (changes || []).filter((c) => {
    const p = String(c?.path || '').replace(/\\/g, '/').toLowerCase();
    return p && allowed.has(p);
  });
};

/** Luôn chạy build khi đụng manifest / lockfile / solution — không hỏi LLM. */
const mustRunBuildVerifyByHeuristic = (changes) =>
  (changes || []).some((c) => {
    const p = String(c?.path || '').replace(/\\/g, '/').toLowerCase();
    if (!p) return false;
    return (
      p.endsWith('package.json') ||
      p.endsWith('package-lock.json') ||
      p.endsWith('pnpm-lock.yaml') ||
      p.endsWith('yarn.lock') ||
      p.endsWith('angular.json') ||
      p.endsWith('nx.json') ||
      p.endsWith('tsconfig.json') ||
      p.endsWith('tsconfig.base.json') ||
      p.endsWith('.csproj') ||
      p.endsWith('.sln') ||
      p.endsWith('dockerfile') ||
      p.endsWith('.props') ||
      p.endsWith('.targets')
    );
  });

const buildChangeSummaryForVerifyGate = (changes, truncateTextFn, maxTotal = 12000) => {
  const parts = [];
  let used = 0;
  for (const c of changes || []) {
    const fp = String(c.path || '');
    const rc = truncateTextFn(String(c.review_comment || ''), 480);
    const lines = Array.isArray(c.changed_lines) ? c.changed_lines.slice(0, 10).join(', ') : '';
    let body = '';
    if (Array.isArray(c.edits) && c.edits.length) {
      body = c.edits
        .map((e, i) => {
          const s = truncateTextFn(String(e.search || ''), 200);
          const r = truncateTextFn(String(e.replace || ''), 200);
          return `edit#${i + 1}:\n- ${s}\n+ ${r}`;
        })
        .join('\n');
    } else if (c.content) {
      body = truncateTextFn(String(c.content), 700);
    }
    const chunk = `FILE: ${fp}\nreview: ${rc}\nlines: ${lines || '(unknown)'}\n${body}\n---\n`;
    if (used + chunk.length > maxTotal) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join('\n') || '(no change summary)';
};

const llmAssessBuildVerificationNeed = async ({
  ticketDetails,
  fixReasoning,
  affectedStacks,
  changeSummary,
  llmGenerate,
  generateContentWithRetry,
  extractJsonFromModelResponse,
  truncateTextFn,
}) => {
  const prompt = `
Bạn là senior engineer review patch trước khi chạy build/lint CI.

TICKET:
Summary: ${truncateTextFn(ticketDetails?.summary || '', undefined)}
Description: ${truncateTextFn(ticketDetails?.description || '', undefined)}

Stacks sẽ được verify nếu cần: ${(affectedStacks || []).join(', ')}

Reasoning implement (AI):
${truncateTextFn(fixReasoning || '', 1600)}

Chi tiết thay đổi (path + excerpt; có thể bị cắt):
${changeSummary}

Trả về MỘT object JSON (không markdown), các key:
- "needs_build_verify": boolean — true nếu NÊN chạy build/lint để bắt lỗi biên dịch hoặc hợp đồng API; false CHỈ khi gần như chắc chắn không cần.
- "risk_level": một trong "none","low","medium","high"
- "reason_vi": 1-4 câu tiếng Việt, kỹ thuật.

QUY TẮC (an toàn hơn tốc độ):
- needs_build_verify = false CHỈ khi thay đổi gần như chắc chắn không thể gây lỗi biên dịch: copy/label UI, placeholder, chuỗi i18n, typo trong string literal, màu/spacing CSS thuần giao diện, comment-only — không đổi chữ ký hàm, generic, import/using, DI, route, permission, attribute ảnh hưởng runtime, SQL, schema JSON đọc lúc chạy.
- needs_build_verify = true nếu có: logic điều kiện/loop, API, type/interface/signature, import/using, DI registration, middleware, auth, migration, Razor/TSX binding thay đổi ngữ nghĩa, bất kỳ nghi ngờ nào.
- Nếu không chắc chắn ~90% là an toàn thì needs_build_verify = true.
`;
  const text = await generateContentWithRetry(() => llmGenerate(prompt, { model: getFastModel() }), { label: 'verify-need-gate' });
  const data = extractJsonFromModelResponse(text);
  if (!data || typeof data.needs_build_verify !== 'boolean') {
    return {
      needs_build_verify: true,
      risk_level: 'medium',
      reason_vi: 'Không parse được JSON đánh giá; mặc định chạy build verify.',
    };
  }
  return {
    needs_build_verify: data.needs_build_verify,
    risk_level: typeof data.risk_level === 'string' ? data.risk_level : 'low',
    reason_vi: String(data.reason_vi || '').trim() || '(no reason)',
  };
};


const selectPromptFiles = (filteredFiles, planData) => {
  const maxPromptFiles = Math.max(10, Number(process.env.AI_MAX_PROMPT_FILES) || DEFAULT_MAX_PROMPT_FILES);
  const maxWithPlan = Math.min(
    maxPromptFiles,
    Math.max(8, Number(process.env.AI_MAX_PROMPT_FILES_WITH_PLAN) || DEFAULT_MAX_PROMPT_FILES_WITH_PLAN)
  );
  const neighborCap = Math.max(0, Number(process.env.AI_PROMPT_NEIGHBOR_CAP) || 2);

  const plannedTargets = Array.isArray(planData?.target_files)
    ? planData.target_files.map(x => String(x || '').trim().replace(/\\/g, '/')).filter(Boolean)
    : [];
  
  // Extract mentioned files from thinking/analysis text
  const reasoningText = `${planData?.thinking_vi || ''} ${planData?.analysis_vi || ''}`;
  const mentionedFiles = new Set();
  const fileRefRegex = /[\w\-./\\]+\.(cs|ts|tsx|js|html|scss|json)/gi;
  let m;
  while ((m = fileRefRegex.exec(reasoningText)) !== null) {
    mentionedFiles.add(m[0].replace(/\\/g, '/').toLowerCase());
  }

  const plannedLower = new Set([
    ...plannedTargets.map(t => t.toLowerCase()),
    ...Array.from(mentionedFiles)
  ]);

  const cap = maxWithPlan;
  const seen = new Set();
  const result = [];
  const add = (f) => {
    const k = String(f).replace(/\\/g, '/');
    if (!k || seen.has(k) || result.length >= cap) return;
    seen.add(k);
    result.push(k);
  };

  // 1. Exact or suffix matches for planned/mentioned files
  for (const t of plannedLower) {
    for (const f of filteredFiles) {
      const lower = f.replace(/\\/g, '/').toLowerCase();
      if (lower === t || lower.endsWith(`/${t}`) || lower.endsWith(t)) add(f);
    }
  }

  // 2. Base name matches
  for (const t of plannedLower) {
    const bt = path.posix.basename(t).toLowerCase();
    if (!bt || bt.length < 4) continue;
    for (const f of filteredFiles) {
      if (path.posix.basename(f).toLowerCase() === bt) add(f);
    }
  }

  // 3. Neighbors (files in the same directory)
  if (neighborCap > 0) {
    const seedDirs = new Set(result.map(f => path.posix.dirname(f.replace(/\\/g, '/'))));
    for (const dir of seedDirs) {
      let n = 0;
      for (const f of filteredFiles) {
        if (result.length >= cap || n >= neighborCap) break;
        const d = path.posix.dirname(f.replace(/\\/g, '/'));
        if (d === dir && !seen.has(f.replace(/\\/g, '/'))) {
          add(f.replace(/\\/g, '/'));
          n += 1;
        }
      }
    }
  }

  // 4. Scored fallback
  const scored = filteredFiles.map((file) => {
    const lower = file.toLowerCase();
    let score = 0;
    for (const t of plannedLower) {
      if (lower === t || lower.endsWith(t)) score += 6;
      else if (lower.includes(t)) score += 3;
      const base = path.basename(lower);
      const baseT = path.basename(t);
      if (base && baseT && base === baseT) score += 4;
    }
    return { file, score };
  });
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  for (const { file } of scored) {
    add(file.replace(/\\/g, '/'));
    if (result.length >= cap) break;
  }

  return result.slice(0, cap);
};

const buildFileContentContext = (repoPath, promptFiles, planData, opts = {}) => {
  const maxFiles = Math.max(
    4,
    Number(opts.maxFiles) ||
      Number(process.env.AI_MAX_FILE_SNIPPETS) ||
      DEFAULT_MAX_FILE_SNIPPETS
  );
  const maxSnippetChars = Math.max(
    400,
    Number(opts.maxSnippetChars) ||
      Number(process.env.AI_MAX_FILE_SNIPPET_CHARS) ||
      DEFAULT_MAX_FILE_SNIPPET_CHARS
  );
  const maxTotalChars = Math.max(
    4000,
    Number(opts.maxTotalChars) ||
      Number(process.env.AI_MAX_FILE_CONTEXT_CHARS) ||
      DEFAULT_MAX_FILE_CONTEXT_CHARS
  );
  const plannedTargets = Array.isArray(planData?.target_files)
    ? planData.target_files.map(x => String(x || '').toLowerCase()).filter(Boolean)
    : [];

  const ranked = promptFiles.map((file) => {
    const lower = file.toLowerCase();
    let score = 0;
    for (const t of plannedTargets) {
      if (lower === t || lower.endsWith(t)) score += 8;
      else if (lower.includes(t)) score += 4;
      if (path.basename(lower) === path.basename(t)) score += 6;
    }
    if (lower.endsWith('.cs') || lower.endsWith('.ts') || lower.endsWith('.tsx')) score += 2;
    if (lower.endsWith('.component.ts') || lower.endsWith('.appservice.cs') || lower.endsWith('excel-exporter.cs')) score += 2;
    return { file, score };
  });
  ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const selected = ranked.slice(0, maxFiles).map(x => x.file);
  let totalChars = 0;
  const chunks = [];

  for (const relPath of selected) {
    const fullPath = path.join(repoPath, relPath);
    if (!fs.existsSync(fullPath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      continue;
    }
    const snippet = truncateText(content, maxSnippetChars);
    const section = `\n--- FILE: ${relPath} ---\n${snippet}\n`;
    if (totalChars + section.length > maxTotalChars) break;
    chunks.push(section);
    totalChars += section.length;
  }

  return chunks.join('\n');
};

const formatExplorationJsonForImplementPrompt = (parsed) => {
  if (!parsed || typeof parsed !== 'object') return '';
  const sum = String(parsed.exploration_summary_vi || '').trim();
  const notes = Array.isArray(parsed.file_reading_notes) ? parsed.file_reading_notes : [];
  const cross = String(parsed.cross_links_vi || '').trim();
  const unknown = String(parsed.unknowns_or_need_more_vi || '').trim();
  const checklist = Array.isArray(parsed.implement_checklist_vi) ? parsed.implement_checklist_vi : [];

  const parts = [];
  if (sum) parts.push(`**Tóm tắt khám phá (luồng + nghi ngờ):**\n${sum}`);
  if (notes.length) {
    const lines = notes
      .map((n) => {
        const p = String(n?.path || '').trim();
        const w = String(n?.what_matters_vi || '').trim();
        const ids = Array.isArray(n?.identifiers_seen)
          ? n.identifiers_seen.map(String).filter(Boolean).slice(0, 14).join(', ')
          : '';
        return p ? `- \`${p}\`: ${w}${ids ? ` — định danh/chuỗi: ${ids}` : ''}` : '';
      })
      .filter(Boolean)
      .join('\n');
    if (lines) parts.push(`**Từng file trong snippet:**\n${lines}`);
  }
  if (cross) parts.push(`**Liên kết chéo (A ↔ B, route, DI, menu, API…):**\n${cross}`);
  if (unknown) parts.push(`**Chưa đủ bằng chứng / cần thận trọng:**\n${unknown}`);
  if (checklist.length) {
    const cl = checklist.map((x) => `- ${String(x).trim()}`).filter((l) => l.length > 2);
    if (cl.length) parts.push(`**Checklist trước khi patch:**\n${cl.join('\n')}`);
  }
  return parts.join('\n\n');
};

/**
 * Bước khám phá read-only trước implement: tổng hợp luồng + file roles từ snippet mở rộng để model implement có “bản đồ”.
 */
async function runCodeExplorationForImplement(
  llmGenerate,
  generateContentWithRetry,
  extractJsonFromModelResponse,
  payload
) {
  const {
    ticketKey,
    ticketContextBlock,
    planData,
    stacks,
    expertSkillsClip,
    symbolHints,
    promptFiles,
    exploreSnippets,
  } = payload;

  const maxOut = Math.max(4000, Number(process.env.AI_EXPLORE_OUTPUT_MAX_CHARS) || 28000);
  const prompt = `Bạn là **kỹ sư khám phá codebase** (read-only). Chưa được sửa file.  
Nhiệm vụ: đọc ticket + kế hoạch + snippet mở rộng bên dưới, **tổng hợp ngữ cảnh đầy đủ** để bước implement sau có đủ “bản đồ” — luồng UI/API, file liên quan, điểm cần chỉnh theo ticket.

TICKET KEY: ${ticketKey}
STACKS: ${(stacks || []).join(', ')}

## TICKET + CONTEXT (đọc trước)
${ticketContextBlock}

## PLAN
- ticket_understood: ${String(planData?.ticket_understood_vi || '').slice(0, 4000)}
- analysis: ${String(planData?.analysis_vi || '').slice(0, 2500)}
- target_files: ${(planData?.target_files || []).join(', ')}
- risk: ${String(planData?.risk_notes_vi || '').slice(0, 1200)}

## SYMBOL HINTS (top)
${(symbolHints || []).slice(0, 24).map((s) => `- ${s.kind} ${s.name} @ ${s.file}:${s.line}`).join('\n') || '(none)'}

## FILE ỨNG VIÊN (path)
${(promptFiles || []).slice(0, 120).join('\n')}

## EXPERT SKILLS (rút)
${expertSkillsClip || '(none)'}

## SNIPPET MỞ RỘNG (ground truth — đọc kỹ)
${exploreSnippets || '(Không có snippet.)'}

---

Trả về **một object JSON** (không markdown fence), schema:
{
  "exploration_summary_vi": "8–22 câu tiếng Việt: ticket cần gì; luồng code liên quan; vì sao các file trong snippet khớp; nghi ngờ bug ở đâu",
  "file_reading_notes": [
    { "path": "relative/path trong snippet hoặc target_files", "what_matters_vi": "Đoạn/identifier liên quan ticket", "identifiers_seen": ["ClassName", "route", "..."] }
  ],
  "cross_links_vi": "6–16 câu: A ↔ B (import, DI, navigation, API, permission, i18n…)",
  "unknowns_or_need_more_vi": "Snippet cắt / thiếu file nào; implement phải trích search từ snippet thật",
  "implement_checklist_vi": ["5–12 mục ngắn cho bước patch"]
}

Quy tắc:
- Chỉ nêu path có trong SNIPPET hoặc target_files / danh sách FILE; không bịa file.
- Ưu tiên trích tên class, method, route string, permission key từ snippet.
- unknowns_or_need_more_vi thật thà nếu thiếu dữ liệu.
`;

  try {
    const raw = await generateContentWithRetry(() => llmGenerate(prompt), { label: 'implement-explore' });
    const parsed = extractJsonFromModelResponse(raw);
    const formatted = formatExplorationJsonForImplementPrompt(parsed);
    const block = formatted
      ? truncateText(formatted, maxOut)
      : truncateText(String(raw || '').trim(), maxOut);
    return { block, parsed };
  } catch (e) {
    console.warn('[AI Agent] implement-explore:', e?.message || e);
    return { block: '', parsed: null };
  }
}

const updateFixStep = async (id, step, log = null) => {
  const timestamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).replace(' ', 'T');
  if (log) {
    await db.query('UPDATE app_ai_fixes SET current_step = $1, log = COALESCE(log, \'\') || $2, updated_at = NOW() WHERE id = $3', [step, `\n[${timestamp}] ${log}`, id]);
  } else {
    await db.query('UPDATE app_ai_fixes SET current_step = $1, updated_at = NOW() WHERE id = $2', [step, id]);
  }
};

const getAuthenticatedUrl = (url, user, pass) => {
  if (!user || !pass) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pass);
    return u.toString();
  } catch (e) {
    return url;
  }
};

const cloneProject = async (project, options = {}) => {
  const updateIfExists = options.updateIfExists !== false;
  const repoPath = project.local_path || path.join(REPOS_BASE_DIR, project.jira_key);
  const authGitUrl = getAuthenticatedUrl(project.git_url, project.git_user, project.git_password);

  if (!fs.existsSync(repoPath)) {
    console.log(`[AI Agent] Cloning project ${project.name}...`);
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    await runCommand(`git clone ${authGitUrl} ${repoPath}`, process.cwd());
  } else if (updateIfExists) {
    console.log(`[AI Agent] Project ${project.name} already exists. Updating remote...`);
    await runCommand(`git remote set-url origin ${authGitUrl}`, repoPath);
    await runCommand(`git fetch origin && git reset --hard origin/${project.base_branch || 'main'}`, repoPath);
  } else {
    console.log(`[AI Agent] Project ${project.name} already exists. Skipping pull/update.`);
  }

  rebuildIndexInBackground(repoPath, {
    stacks: project.stack ? String(project.stack).split(',').map((s) => s.trim()).filter(Boolean) : [],
  });
};

const getFileSummaries = (repoPath, files) => {
  const maxLines = Math.max(12, Number(process.env.AI_PLANNING_SUMMARY_MAX_LINES) || 36);
  const summaries = [];
  for (const f of files) {
    const fullPath = path.join(repoPath, f);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      const slice = lines.slice(0, maxLines).join('\n');
      summaries.push(`--- FILE SUMMARY: ${f} ---\n${slice}${lines.length > maxLines ? '\n... (truncated)' : ''}`);
    } catch (e) {
      // skip
    }
  }
  return summaries.join('\n\n');
};

const triggerAiFix = async (ticketKey, projectId, ticketDetails, additionalContext = '', options = {}) => {
  let fixId = options.resumeFixId || null;
  const approveImmediately = options.approveImmediately || false;
  
  try {
    if (!fixId) {
      // 1. Initialize Fix Record
      const fixRes = await db.query(
        `INSERT INTO app_ai_fixes (ticket_key, project_id, status, current_step, additional_context, ticket_summary, ticket_description)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          ticketKey,
          projectId,
          'in_progress',
          'Initializing',
          additionalContext || null,
          ticketDetails?.summary || null,
          ticketDetails?.description || null,
        ]
      );
      fixId = fixRes.rows[0].id;
    } else {
      await updateFixStep(fixId, 'Resuming', 'Resuming implementation after approval...');
      await db.query('UPDATE app_ai_fixes SET status = $1 WHERE id = $2', ['in_progress', fixId]);
    }

    // Get Project Info
    const projRes = await db.query('SELECT * FROM app_projects WHERE id = $1', [projectId]);
    const project = projRes.rows[0];

    let pipelineContext = additionalContext || '';
    if (String(process.env.AI_PROJECT_MEMORY_DISABLE || '').toLowerCase() !== '1') {
      const memoryBlock = await buildProjectMemoryPromptBlock({ db, projectId, ticketDetails, llmGenerate });
      if (memoryBlock) {
        pipelineContext = [pipelineContext, memoryBlock].filter(Boolean).join('\n\n');
      }
    }

    await sendTelegramMessage(`🤖 <b>[AI Agent]</b> Bắt đầu xử lý Ticket <b>${escapeHTML(ticketKey)}</b> cho dự án <b>${escapeHTML(project.name)}</b>...`);

    // 2. Stage 1: Context Acquisition (Git Clone/Pull)
    const repoPath = project.local_path || path.join(REPOS_BASE_DIR, project.jira_key);
    
    // Perform fast update/clone
    const isNew = !fs.existsSync(repoPath);
    await updateFixStep(fixId, 'Git Operations', isNew ? 'Cloning new repository...' : 'Updating existing repository (fetch & reset)...');
    await cloneProject(project, { updateIfExists: true });

    // 3. Detect Stack
    await updateFixStep(fixId, 'Detecting Stack');
    let stacks = project.stack ? project.stack.split(',') : ['nodejs'];
    
    // Auto-detection logic if polyglot or not specified
    if (stacks.includes('polyglot') || stacks.length === 0) {
      if (fs.existsSync(path.join(repoPath, 'angular.json'))) stacks.push('angular');
      if (fs.readdirSync(repoPath).some(f => f.endsWith('.csproj') || f.endsWith('.sln'))) stacks.push('dotnet');
      // Remove polyglot after detection
      stacks = stacks.filter(s => s !== 'polyglot');
      // Default to nodejs if nothing else found
      if (stacks.length === 0) stacks.push('nodejs');
      // Unique values
      stacks = [...new Set(stacks)];
    }
    
    await updateFixStep(fixId, `Stacks: ${stacks.join(', ')}`, `Active stacks: ${stacks.join(', ')}`);

    // 4. Create Branch (tên có timestamp — luôn nhánh mới, không đè lịch sử nhánh cũ trên remote)
    const branchName = buildAiFixBranchName(ticketKey);
    await updateFixStep(fixId, 'Git Operations', `Creating branch ${branchName}...`);
    await runCommand(`git checkout -B ${branchName}`, repoPath);

    // 4.1. Optional Web Research via 9Router
    if (String(process.env.AI_ENABLE_WEB_RESEARCH) === '1') {
      await updateFixStep(fixId, 'Web Research', 'Performing web research via 9Router...');
      try {
        const researchResult = await performWebResearch(ticketDetails, pipelineContext);
        if (researchResult) {
          pipelineContext = [pipelineContext, researchResult].filter(Boolean).join('\n\n');
          await updateFixStep(fixId, 'Web Research', 'Web research completed and added to context.');
        }
      } catch (researchErr) {
        console.warn('[AI Agent] Web research failed:', researchErr.message);
      }
    }

    // 5. Reasoning & Implementation (LLM — Gemini hoặc OpenAI-compatible)
    await updateFixStep(fixId, 'AI Reasoning', `Calling LLM ${JSON.stringify(await getActiveLlmInfo())}...`);

    const fileListResult = await runCommand('git ls-tree -r --name-only HEAD', repoPath);
    const allRepoFiles = fileListResult.stdout.split('\n').filter(f => f.trim());

    const { activeSkillFiles, expertSkills } = await loadProjectSkillsContextAsync(project.selected_skills);

    const skillGrepSignals = extractContextSignals({ summary: '', description: '' }, expertSkills || '');
    const ticketGrepSignals = extractContextSignals(ticketDetails, pipelineContext);
    const maxGrepSig = Math.max(8, Number(process.env.AI_GREP_MAX_SIGNALS) || 22);
    const grepSignals = mergeSignalsSkillFirst(skillGrepSignals, ticketGrepSignals, maxGrepSig);
    let grepFileHits = [];
    try {
      grepFileHits = await gatherGrepMatchedFiles(repoPath, grepSignals, stacks);
    } catch (e) {
      console.warn('[AI Agent] grep context gather skipped:', e?.message || e);
    }

    let contextFileList = mergeUniquePreferFirst(
      grepFileHits,
      buildContextFileList(allRepoFiles, stacks, ticketDetails, pipelineContext, expertSkills)
    );

    const llmSuggestedPaths = await suggestPathsViaLlm({
      ticketDetails,
      pipelineContext,
      allRepoFiles,
      expertSkillsPreview: expertSkills,
      llmGenerate,
      generateContentWithRetry,
    });
    if (llmSuggestedPaths.length > 0) {
      contextFileList = mergeUniquePreferFirst(llmSuggestedPaths, contextFileList);
    }

    await updateFixStep(
      fixId,
      'Context Gathering',
      'Đang lập chỉ mục symbol nhanh (regex, không gọi AI từng file) để cải thiện discovery…'
    );
    const codeIndex = await buildCodeIndex(repoPath, contextFileList);
    const symbolSkillClip = truncateText(
      expertSkills || '',
      Math.max(300, Number(process.env.AI_SYMBOL_SKILL_CHARS) || 2000)
    );
    const symbolHints = searchRelevantSymbols(
      codeIndex,
      `${ticketDetails?.summary || ''}\n${ticketDetails?.description || ''}\n${pipelineContext || ''}\n${symbolSkillClip}`,
      Math.max(8, Number(process.env.AI_SYMBOL_HINT_COUNT) || 22)
    );
    const symbolHintFiles = collectFilesFromSymbols(symbolHints, Math.max(8, Number(process.env.AI_SYMBOL_FILE_HINT_LIMIT) || 28));
    contextFileList = mergeUniquePreferFirst(symbolHintFiles, contextFileList);
    await updateFixStep(
      fixId,
      'Context Gathering',
      `Summary+description ticket đã nạp vào pipeline; đã chọn ${contextFileList.length} file (grep skill+ticket: ${grepFileHits.length}, path-suggest: ${llmSuggestedPaths.length || 0}) + symbol hints — tiếp theo snippet/plan bám ticket.`
    );

    const planningFiles = buildPlanningCandidateFiles(contextFileList, stacks, ticketDetails, pipelineContext, expertSkills);
    await updateFixStep(fixId, 'Planning', `AI đang lập kế hoạch sửa đổi dựa trên ${planningFiles.length} file quan trọng nhất (ưu tiên file frontend/backend liên quan trực tiếp).`);

    // 4.5 Deep Research Step
    const researchFiles = planningFiles.slice(0, Math.max(4, Number(process.env.AI_RESEARCH_FILE_COUNT) || 8));
    const fileSummaries = getFileSummaries(repoPath, researchFiles);
    await updateFixStep(
      fixId,
      'Deep Research',
      `Đối chiếu ticket/context đã nạp → đọc ${researchFiles.length} file (snippet đầu) để phân tích cấu trúc trước khi plan…`
    );

    let planData;
    if (options.resumeFixId && !options.feedback) {
      const resumeRes = await db.query('SELECT plan FROM app_ai_fixes WHERE id = $1', [fixId]);
      planData = resumeRes.rows[0]?.plan;
      if (typeof planData === 'string') planData = JSON.parse(planData);
    }

    if (!planData) {
      const planningCandidatesFmt = formatPlanningCandidatesForPrompt(planningFiles);
      const repoIdx = buildRepoPlanningIndexForPrompt(allRepoFiles);
      const planningSkillsMax = Math.max(4000, Number(process.env.AI_PLANNING_EXPERT_SKILLS_MAX_CHARS) || 18000);
      const planningSkillsBody = truncateText(expertSkills || '', planningSkillsMax);
      const planningPrompt = `
      Bạn là AI planner cho ticket kỹ thuật.
      Hãy tạo kế hoạch sửa lỗi NGẮN GỌN bằng JSON để giảm phạm vi context.

      STACKS: ${stacks.join(', ')}
      ACTIVE SKILLS (tên file): ${activeSkillFiles.join(', ') || 'No skill files found.'}

      EXPERT SKILLS (nội dung — chỉ đọc sau khi đã nắm ticket (1)(2); map ticket → loại file / layer theo quy ước dự án):
      ${planningSkillsBody || '(none)'}

      ${buildFullTicketContextBlock(ticketKey, ticketDetails, pipelineContext)}
      ${options.feedback ? `
      Lưu ý quan trọng (re-plan): Trong khối USER CONTEXT + PROJECT MEMORY đã gồm kế hoạch cũ, log kỹ thuật, reasoning/changes (nếu có) và phản hồi của user — bạn PHẢI đọc toàn bộ bước (1)(2) trước khi nhìn CODE SUMMARIES; lập kế hoạch MỚI không mâu thuẫn phản hồi trừ khi giải thích rõ trong thinking_vi.` : ''}

      ${repoIdx.text ? `${repoIdx.text}\n\n` : ''}

      FILE CANDIDATES (${planningCandidatesFmt.count} paths — target_files phải trùng y nguyên một path trong danh sách có số thứ tự):
      ${planningCandidatesFmt.numberedList}

      INDEX THEO TÊN FILE (basename → path đầy đủ; đối chiếu tên file / feature trong ticket với đúng path, đặc biệt khi trùng basename):
      ${planningCandidatesFmt.basenameIndex}

      SYMBOL HINTS (top matches):
      ${(symbolHints || []).slice(0, Math.max(8, Number(process.env.AI_SYMBOL_HINT_DISPLAY) || 20)).map(s => `- ${s.kind} ${s.name} @ ${s.file}:${s.line}`).join('\n') || 'No symbol hints'}

      CODE SUMMARIES (Context from top candidates):
      ${fileSummaries}

      Trả về JSON:
      {
        "ticket_understood_vi": "BẮT BUỘC: 5–14 câu tiếng Việt — tóm tắt yêu cầu đã ĐỌC TỪ TICKET + USER CONTEXT: AC/phạm vi, tái hiện, expected vs actual, ràng buộc; phải thể hiện chi tiết lấy từ DESCRIPTION (không chỉ lặp summary). Đây là chứng cứ đã đọc hết context ticket trước khi phân tích code.",
        "thinking_vi": "Suy luận chi tiết: sau khi đã nắm ticket_understood_vi, phân tích cấu trúc code, component, luồng dữ liệu (chain-of-thought)",
        "analysis_vi": "Lý do + hướng xử lý ngắn gọn bằng tiếng Việt",
        "target_files": ["relative/path1", "relative/path2"],
        "target_file_evidence": [
          {
            "path": "relative/path — TRÙNG một phần tử trong target_files",
            "why_this_file_vi": "Vì sao đây là file đúng để sửa (không đoán mò)",
            "evidence_from_context_vi": "Căn cứ cụ thể: SYMBOL HINTS dòng nào, CODE SUMMARY đoạn nào, hay mô tả ticket khớp identifier/route nào trong path đó"
          }
        ],
        "verification_focus": ["dotnet|angular|nodejs"],
        "risk_notes_vi": "rủi ro chính (ngắn gọn); nếu không chắc file đúng — nêu rõ"
      }

      Rules:
      - **Thứ tự đọc:** (1)(2) TICKET + USER CONTEXT trong khối phía trên → (3) EXPERT SKILLS → (4) SYMBOL / FILE CANDIDATES / CODE SUMMARIES. Không được kết luận file sửa chỉ từ tên file đẹp mà bỏ qua mô tả ticket.
      - ticket_understood_vi phải cụ thể (AC, điều kiện lỗi); nếu DESCRIPTION trống ghi rõ "(description trống)" và dựa summary + context.
      - Đọc EXPERT SKILLS sau ticket: đó là nguồn đúng về layer/pattern dự án; map ticket → loại file cần sửa. REPO FILE INDEX (nếu có) chỉ hỗ trợ khi basename trùng nhiều path.
      - CHỈ chọn các file có trong danh sách FILE CANDIDATES (đường dẫn phải khớp ký tự với một dòng trong khối có số thứ tự). Dùng INDEX THEO TÊN FILE + REPO INDEX (basename trùng) để chọn đúng path khi trùng tên file.
      - Trong thinking_vi: nêu ngắn gọn vì sao mỗi target_file được chọn (dựa tên file, module, ticket — không cần giả vờ đã đọc full tree).
      - Nếu file cần thiết không có trong FILE CANDIDATES, hãy nêu tên file đó trong thinking_vi nhưng không đưa vào target_files.
      - Ưu tiên các path đã được LLM path-suggest đưa vào CANDIDATES (thường nằm đầu danh sách) nếu khớp ticket + skill; vẫn phải tự suy luận, không chọn file “đại diện” (vd. app.component.ts) khi ticket yêu cầu sửa dữ liệu cụ thể (menu, icon, provider…).
      - Chỉ chọn tối đa 12 file quan trọng nhất trong target_files (càng ít càng tốt).
      - Ưu tiên file có khả năng chứa bug gốc; không liệt kê file ngoài phạm vi ticket.
      - **BẮT BUỘC:** Mỗi path trong target_files phải có đúng một mục tương ứng trong target_file_evidence (cùng path), giải thích vì sao file đó là đích sửa và **bằng chứng** từ SYMBOL/CODE SUMMARY/ticket — không được chỉ liệt kê file mà không căn cứ.
      - Output JSON only.
      `;
      await updateFixStep(
        fixId,
        'AI Planning',
        `Đang phân tích và lập kế hoạch sửa đổi dựa trên ${planningFiles.length} file ứng viên có độ liên quan cao nhất tới mô tả ticket.`
      );
      const planningText = await generateContentWithRetry(() => llmGenerate(planningPrompt, { model: getSmartModel() }), { label: 'planning' });
      planData = extractJsonFromModelResponse(planningText) || {
        ticket_understood_vi: '(fallback — không parse được plan)',
        analysis_vi: 'Lý do: Không parse được plan JSON. Giải pháp: fallback theo context filter.',
        target_files: [],
        target_file_evidence: [],
        verification_focus: stacks,
        risk_notes_vi: 'Fallback mode',
      };
      
      // Save plan to DB
      await db.query('UPDATE app_ai_fixes SET plan = $1 WHERE id = $2', [JSON.stringify(planData), fixId]);

      if (!approveImmediately) {
        await db.query(
          'UPDATE app_ai_fixes SET status = $1, current_step = $2, updated_at = NOW() WHERE id = $3',
          ['waiting_for_approval', 'Awaiting Approval', fixId]
        );
        const evidenceBlock = (() => {
          const ev = Array.isArray(planData.target_file_evidence) ? planData.target_file_evidence : [];
          if (!ev.length) return '';
          const lines = ev
            .map((e) => {
              const p = String(e?.path || '').trim();
              const why = truncateText(String(e?.why_this_file_vi || ''), 220);
              const cf = truncateText(String(e?.evidence_from_context_vi || ''), 220);
              return p ? `• <code>${p}</code>\n  → ${why}${cf ? `\n  📎 Căn cứ: ${cf}` : ''}` : '';
            })
            .filter(Boolean)
            .join('\n');
          return lines ? `\n📎 <b>Căn cứ từng file:</b>\n${lines}\n` : '';
        })();
        const approveMsg = `📝 <b>[AI Agent] Kế hoạch cho ${ticketKey}</b>\n\n` +
          `📋 <b>Đã đọc ticket:</b>\n${truncateText(planData.ticket_understood_vi || '(chưa có ticket_understood_vi)', 900)}\n\n` +
          `🤔 <b>Suy luận:</b>\n${truncateText(planData.thinking_vi, 400)}\n\n` +
          `🎯 <b>Phân tích:</b>\n${planData.analysis_vi}\n\n` +
          `📂 <b>Files dự kiến:</b>\n<code>${(planData.target_files || []).join('\n')}</code>\n` +
          evidenceBlock +
          `\n⚠️ <b>Rủi ro:</b> ${planData.risk_notes_vi}\n\n` +
          `👉 Vui lòng phê duyệt để Agent thực thi.`;
        await sendTelegramMessage(approveMsg);
        return; // PAUSE HERE
      }
    }

    const promptFiles = selectPromptFiles(contextFileList, planData);
    const fileContentContext = buildFileContentContext(repoPath, promptFiles, planData);
    const exploreSnippets = buildFileContentContext(repoPath, promptFiles, planData, {
      maxFiles: Math.max(6, Number(process.env.AI_EXPLORE_MAX_FILE_SNIPPETS) || 14),
      maxSnippetChars: Math.max(800, Number(process.env.AI_EXPLORE_MAX_FILE_SNIPPET_CHARS) || 16000),
      maxTotalChars: Math.max(8000, Number(process.env.AI_EXPLORE_MAX_FILE_CONTEXT_CHARS) || 56000),
    });

    await updateFixStep(
      fixId,
      'AI Planning',
      `${truncateText(planData.analysis_vi || 'Plan created.', 300)} | Prompt files: ${promptFiles.length} | Snippet chars: ${fileContentContext.length} | Explore chars: ${exploreSnippets.length}`
    );

    let explorationBlockForImplement = '';
    if (String(process.env.AI_IMPLEMENT_EXPLORE_DISABLE || '').toLowerCase() !== '1') {
      await updateFixStep(
        fixId,
        'Code Exploration',
        `Đang khám phá luồng code (snippet mở rộng, read-only) trước khi implement…`
      );
      const exploreSkillsClip = truncateText(
        expertSkills || '',
        Math.max(3000, Number(process.env.AI_EXPLORE_SKILLS_MAX_CHARS) || 12000)
      );
      const exploration = await runCodeExplorationForImplement(
        llmGenerate,
        generateContentWithRetry,
        extractJsonFromModelResponse,
        {
          ticketKey,
          ticketContextBlock: buildFullTicketContextBlock(ticketKey, ticketDetails, pipelineContext),
          planData,
          stacks,
          expertSkillsClip: exploreSkillsClip,
          symbolHints,
          promptFiles,
          exploreSnippets,
        }
      );
      explorationBlockForImplement = exploration.block
        ? `\n\nCODE EXPLORATION (bước khám phá repo — **đối chiếu** với FILE CONTENT CONTEXT bên dưới; khi mâu thuẫn thì ưu tiên **chuỗi trong snippet** khi chọn \`search\`):\n${exploration.block}\n`
        : '';
      await updateFixStep(
        fixId,
        'Code Exploration',
        exploration.block
          ? `Đã tổng hợp exploration (${exploration.block.length} ký tự) → chuyển implement.`
          : 'Exploration không parse được nội dung — implement chỉ dựa plan + snippet.'
      );
    }

    await updateFixStep(
      fixId,
      'AI Reasoning',
      `Implement: ${promptFiles.length} files, skills ${activeSkillFiles.length || 0}${explorationBlockForImplement ? ' + exploration' : ''}.`
    );
    
    const prompt = `
    You are an expert full-stack developer familiar with: ${stacks.join(', ')}. 
    Your task is to fix a Jira ticket.

    ACTIVE EXPERT SKILLS:
    ${activeSkillFiles.join(', ') || 'No skill files found.'}

    EXPERT SKILLS & GUIDELINES:
    ${expertSkills}

    ${buildFullTicketContextBlock(ticketKey, ticketDetails, pipelineContext)}

    APPROVED PLAN (Vietnamese):
    Ticket understood (from planner — đối chiếu khi implement): ${planData.ticket_understood_vi || 'N/A'}
    Analysis: ${planData.analysis_vi || 'N/A'}
    Target files: ${(planData.target_files || []).join(', ') || 'N/A'}
    Verification focus: ${(planData.verification_focus || []).join(', ') || 'N/A'}
    Risk notes: ${planData.risk_notes_vi || 'N/A'}
    Symbol hints: ${(symbolHints || []).slice(0, 12).map(s => `${s.name}@${s.file}:${s.line}`).join(' | ') || 'N/A'}
    
    ${explorationBlockForImplement}
    FILES IN PROJECT (Filtered source files):
    ${promptFiles.join('\n')}

    FILE CONTENT CONTEXT (Top planned files, truncated — dùng làm ground truth cho \`search\`):
    ${fileContentContext || 'No file snippets available.'}
    
    INSTRUCTIONS:
    0. **Thứ tự:** Đọc TICKET + USER CONTEXT → PLAN → (nếu có) CODE EXPLORATION → FILE CONTENT CONTEXT. Exploration là bản đồ; snippet là bằng chứng khi viết patch. Patch phải thỏa đúng yêu cầu trong DESCRIPTION/plan, không chỉ “nhìn giống”.
    1. Tuân thủ EXPERT SKILLS (stack/layer/path convention); chỉ mở rộng sang file khác khi skill + ticket thật sự cần.
    2. **Không đoán mò file:** Chỉ sửa file có trong FILES IN PROJECT / FILE CONTENT CONTEXT hoặc đã nằm trong APPROVED PLAN target_files; path phải khớp ký tự. Trích "search" đúng từ snippet — không bịa đoạn code.
    3. Provide either "content" (FULL file content) or "edits" (list of search-replace blocks).
       - MUST use "edits" for files > 100 lines or when making small changes to large files.
       - Each edit block MUST have "search" (exact code block to find) and "replace" (the new code).
       - "search" text MUST be unique in the file to avoid ambiguity. Include enough surrounding context (lines before/after) to ensure it only matches ONE place.
       - "search" text MUST match EXACTLY, including all whitespace, indentation, and newlines.
       - Copy "search" từ đúng đoạn trong FILE CONTENT CONTEXT (không đoán): path trong "changes[].path" phải trùng path trong danh sách FILES / snippet (vd. monorepo Angular thường là angular/src/..., không bỏ tiền tố angular/).
       - **Phạm vi tối thiểu:** Chỉ sửa đúng phần code mà ticket và APPROVED PLAN yêu cầu; không tự đổi thêm định danh, permission, route, localization key hay chuỗi khác chỉ để “khớp” diễn đạt trong ticket. Coi chuỗi trong FILE CONTENT CONTEXT là ground truth (vd. không đổi key trong code vì ticket mô tả tiếng Việt khác key tiếng Anh trong file). Chi tiết theo stack trong EXPERT SKILLS (bảng ánh xạ, menu, API…) — không suy diễn rộng ngoài skill + plan.
    4. "reasoning" (tiếng Việt): format "Lý do: ... Giải pháp: ..." — ngắn gọn; phải mô tả đáp ứng điểm nào trong ticket/plan.
    5. **impact_analysis_vi** (tiếng Việt, BẮT BUỘC): Đoạn 4–10 câu — với mỗi nhóm thay đổi chính: giá trị/hành vi hiện tại là gì; sau khi sửa ảnh hưởng tới luồng nào (UI, API, permission, dữ liệu); ai/chỗ nào trong codebase có thể bị ảnh hưởng phụ.
    6. **codebase_consistency_vi** (tiếng Việt, BẮT BUỘC): Giải thích vì sao patch **khớp** convention dự án (skill), naming, pattern hiện có; nếu có chỗ có thể không khớp — nêu rõ để reviewer kiểm tra.
    7. Return strict JSON format:
       {
         "reasoning": "...",
         "impact_analysis_vi": "...",
         "codebase_consistency_vi": "...",
         "changes": [
           {
             "path": "src/file1.js",
             "content": "...",
             "review_comment": "Tóm tắt thay đổi cho reviewer (bắt buộc)",
             "file_correctness_vi": "Vì sao chắc đây là đúng file (căn cứ snippet/plan/ticket)",
             "change_rationale_vi": "Vì sao sửa đúng chỗ/giá trị này (không chỉ mô tả diff)",
             "downstream_impact_vi": "Sau khi merge: ảnh hưởng runtime/build/màn hình/API gì",
             "consistency_notes_vi": "Có đảm bảo khớp codebase & ít rủi ro phụ không"
           },
           {
             "path": "src/file2.js",
             "edits": [ { "search": "...", "replace": "..." } ],
             "review_comment": "...",
             "file_correctness_vi": "...",
             "change_rationale_vi": "...",
             "downstream_impact_vi": "...",
             "consistency_notes_vi": "..."
           }
         ]
       }
    8. Mỗi phần tử trong "changes": **review_comment** + bốn key *_vi (file_correctness_vi, change_rationale_vi, downstream_impact_vi, consistency_notes_vi) đều BẮT BUỘC, tiếng Việt, cụ thể — không filler chung chung.
    `;

    const responseText = await generateContentWithRetry(() => llmGenerate(prompt, { model: getSmartModel() }), { label: 'implement' });
    const fixData = extractJsonFromModelResponse(responseText);
    if (!fixData || !Array.isArray(fixData.changes)) throw new Error('AI failed to generate a valid JSON response');
    fixData.changes = enrichChangeVerificationComments(fixData.changes);
    fixData.reasoning = mergeImplementReasoningWithImpact(fixData);
    fixData.changes = ensureReviewComments(fixData.changes);
    const changeValidation = validateAndPrepareChanges(fixData.changes, {
      maxFiles: Number(process.env.AI_MAX_CHANGE_FILES) || 25,
      maxLinesPerFile: Number(process.env.AI_MAX_CHANGE_LINES_PER_FILE) || 1200,
      requireReviewComment: true,
    });
    if (!changeValidation.ok) {
      throw new Error(`Model changes rejected by action contract: ${changeValidation.reason}`);
    }
    fixData.changes = changeValidation.prepared;
    let allAppliedChanges = mergeChangesByPath([], fixData.changes);
    await db.query(
      'UPDATE app_ai_fixes SET reasoning = $1, changes = $2, updated_at = NOW() WHERE id = $3',
      [fixData.reasoning, JSON.stringify(allAppliedChanges), fixId]
    );
    await updateFixStep(fixId, 'Applying Changes', `AI đang tiến hành áp dụng các thay đổi mã nguồn cho ${fixData.changes.length} file. Giải pháp được chọn: ${fixData.reasoning}`);

    const appliedChanges = await applyChangesWithRefinement({
      repoPath,
      changes: fixData.changes,
      ticketKey,
      stackLabel: stacks.join(','),
      shouldPreferScopedEdits,
      updateFixStep,
      fixId,
      llmGenerate,
      generateContentWithRetry,
      extractJsonFromModelResponse,
      truncateText,
    });
    allAppliedChanges = mergeChangesByPath(allAppliedChanges, appliedChanges);

    // Refresh allAppliedChanges with final file contents for UI viewing
    allAppliedChanges = allAppliedChanges.map(c => {
      const fullPath = path.join(repoPath, c.path);
      if (fs.existsSync(fullPath)) {
        return { ...c, content: fs.readFileSync(fullPath, 'utf8') };
      }
      return c;
    });
    allAppliedChanges = await attachChangedLinesFromGitDiff(repoPath, allAppliedChanges);
    await db.query(
      'UPDATE app_ai_fixes SET changes = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(allAppliedChanges), fixId]
    );

    // 6. Selective Verification (cap retries để không đốt quota LLM — override bằng AI_MAX_VERIFY_RETRIES=-1 nếu cần)
    const verifyRetryCfg = resolveVerifyRetryLimit();
    const unlimitedVerifyRetries = verifyRetryCfg.unlimited;
    const maxVerifyRetryRounds = verifyRetryCfg.limit;
    const getAffectedStacks = (changes) => {
      const changedPaths = changes.map(c => String(c.path || '').toLowerCase());
      return stacks.filter(s => {
        if (s === 'dotnet') return changedPaths.some(p => p.endsWith('.cs') || p.endsWith('.csproj') || p.endsWith('.sln') || p.includes('/aspnet-core/'));
        if (s === 'angular') return changedPaths.some(p => p.endsWith('.ts') || p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.scss') || p.includes('/angular/'));
        if (s === 'nodejs') return changedPaths.some(p => p.endsWith('.js') || p.endsWith('.json'));
        return true;
      });
    };
    const affectedStacks = getAffectedStacks(allAppliedChanges);
    const changedPathList = allAppliedChanges.map(c => String(c.path || '')).filter(Boolean);

    const trivialVerifyGateOn = String(process.env.AI_VERIFY_TRIVIAL_GATE || '1').trim() !== '0';
    let skipFullStackVerify = false;
    let skipVerifyReasonVi = '';

    if (affectedStacks.length === 0) {
      await updateFixStep(fixId, 'Verification', 'No stacks affected by changes. Skipping build.');
    } else if (trivialVerifyGateOn && mustRunBuildVerifyByHeuristic(allAppliedChanges)) {
      await updateFixStep(
        fixId,
        'Verification gate',
        'Có thay đổi trên manifest/projek/lockfile — luôn chạy build verify (bỏ qua tối ưu trivial).'
      );
      await updateFixStep(fixId, 'Verification', `Verifying affected stacks: ${affectedStacks.join(', ')}...`);
    } else if (trivialVerifyGateOn) {
      const changeSummary = buildChangeSummaryForVerifyGate(allAppliedChanges, truncateText);
      const assess = await llmAssessBuildVerificationNeed({
        ticketDetails,
        fixReasoning: fixData.reasoning,
        affectedStacks,
        changeSummary,
        llmGenerate,
        generateContentWithRetry,
        extractJsonFromModelResponse,
        truncateTextFn: truncateText,
      });
      if (assess.needs_build_verify === false) {
        skipFullStackVerify = true;
        skipVerifyReasonVi = assess.reason_vi;
        await updateFixStep(
          fixId,
          'Verification',
          `Bỏ qua build/lint sau review AI [risk=${assess.risk_level}]: ${truncateText(skipVerifyReasonVi, 420)}`
        );
      } else {
        await updateFixStep(
          fixId,
          'Verification',
          `AI yêu cầu verify build [risk=${assess.risk_level}]: ${truncateText(assess.reason_vi, 380)} — stacks: ${affectedStacks.join(', ')}`
        );
      }
    } else {
      await updateFixStep(fixId, 'Verification', `Verifying affected stacks: ${affectedStacks.join(', ')}...`);
    }

    for (const s of affectedStacks) {
      if (skipFullStackVerify) break;
      const targetSubDir = resolveTargetSubDir(s, repoPath);
      await ensureDependenciesForStack({ stack: s, targetSubDir, fixId, runCommand, updateFixStep });

      // 3. AI Analysis: Determine the best verification command
      await updateFixStep(fixId, `Verification Planning (${s})`, `AI is analyzing the best way to verify the ${s} stack...`);
      const configFiles = collectVerificationConfigFiles(s, targetSubDir);

      const verifyPlannerPrompt = `
      Bạn là chuyên gia DevOps. Hãy phân tích các file cấu hình sau để tìm ra lệnh build/verify tối ưu nhất cho stack "${s}".
      
      THƯ MỤC: ${targetSubDir}
      CÁC FILE CẤU HÌNH:
      ${configFiles.map(cf => `--- FILE: ${cf.name} ---\n${cf.content}`).join('\n\n')}
      
      Yêu cầu:
      1. Lệnh phải kiểm tra được lỗi biên dịch/build của project.
      2. Nếu là Angular, ưu tiên "npm run build" nếu có script build, hoặc dùng "ng build".
      3. Nếu là .NET, ưu tiên "dotnet build" kèm file .sln hoặc .csproj phù hợp.
      4. Trả về JSON:
      {
        "thinking_vi": "Phân tích ngắn gọn lý do chọn lệnh",
        "command": "lệnh thực thi",
        "env_vars": { "KEY": "VALUE" }
      }
      `;
      
      const plannerText = await generateContentWithRetry(() => llmGenerate(verifyPlannerPrompt, { model: getSmartModel() }), { label: `verify-plan:${s}` });
      const verifyPlan = extractJsonFromModelResponse(plannerText) || { 
        command: s === 'dotnet' ? 'dotnet build' : 'npm run build',
        thinking_vi: 'Fallback to default build command.'
      };

      const verifyCmd = verifyPlan.command;
      if (verifyPlan.env_vars) {
        Object.assign(process.env, verifyPlan.env_vars);
      }

      await updateFixStep(fixId, `Verification Plan (${s})`, `AI chose: "${verifyCmd}". Reason: ${verifyPlan.thinking_vi}`);

      const pipeline = detectValidationPipeline(s, targetSubDir, verifyCmd, {
        includeLint: process.env.AI_VERIFY_INCLUDE_LINT,
        includeTests: process.env.AI_VERIFY_INCLUDE_TESTS,
      });
      let retryCount = 0;
      while (true) {
        try {
          await runValidationPipelineOnce({
            stack: s,
            pipeline,
            targetSubDir,
            runCommand,
            updateFixStep,
            fixId,
          });
          break;
        } catch (e) {
          const fullOutput = `${e.stdout || ''}\n${e.stderr || ''}`;
          const scopedOutput = filterErrorLogForChangedFiles(fullOutput, changedPathList);
          const lastPart = scopedOutput.length > 4000 ? `...${scopedOutput.substring(scopedOutput.length - 4000)}` : scopedOutput;
          const errClass = classifyVerificationError(lastPart);
          await updateFixStep(fixId, `Verification Failed (${s})`, `[${errClass}] ${lastPart}`);
          retryCount += 1;
          if (!unlimitedVerifyRetries && retryCount > maxVerifyRetryRounds) {
            throw new Error(
              `Verification failed for ${s} after ${maxVerifyRetryRounds} auto-fix retries (giới hạn để tránh Gemini quota). Tăng AI_MAX_VERIFY_RETRIES hoặc sửa lỗi build thủ công / nâng plan API.`
            );
          }

          await updateFixStep(
            fixId,
            `AI Retry (${s})`,
            `Verification failed for ${s}. Auto-fixing attempt #${retryCount}${!unlimitedVerifyRetries ? `/${maxVerifyRetryRounds}` : ''}...`
          );

          const retryPrompt = `
          You are fixing a failed verification for stack "${s}" on ticket ${ticketKey}.
          Previous AI reasoning:
          ${fixData.reasoning}

          Verification error log:
          ${lastPart}

          Allowed changed files (strict scope):
          ${changedPathList.join('\n')}

          Active expert skills:
          ${activeSkillFiles.join(', ') || 'No skill files found.'}

          Return strict JSON:
          {
            "reasoning": "Lý do và giải pháp bằng tiếng Việt",
            "impact_analysis_vi": "Ngắn: thay đổi này ảnh hưởng gì (compile/API/UI)",
            "codebase_consistency_vi": "Ngắn: có khớp pattern repo không",
            "changes": [
              {
                "path": "relative/path/file.ext",
                "content": "full updated content",
                "review_comment": "Tóm tắt cho reviewer",
                "file_correctness_vi": "Đúng file vì...",
                "change_rationale_vi": "Vì sao sửa như vậy",
                "downstream_impact_vi": "Ảnh hưởng sau sửa",
                "consistency_notes_vi": "Khớp codebase"
              }
            ]
          }

          Rules:
          - Apply minimal changes only to fix compile/build errors.
          - Do not change unrelated files.
          - CHI DUOC sua file trong "Allowed changed files". Neu can file moi, chi de xuat trong reasoning, KHONG duoc sua truc tiep.
          - "reasoning" must be Vietnamese, concise, format: "Lý do: ... Giải pháp: ...".
          - impact_analysis_vi + codebase_consistency_vi + mỗi change có đủ *_vi như schema (ngắn nếu retry).
          - Ensure output is valid JSON only.
          - For .NET CS0246: locate the actual base exporter class already used in this repo (grep MiniExcelExporterBase / Aspose / EpPlusExcelExporterBase) and match namespaces + package refs; không phát minh tên base class mới.
          `;
          const retryText = await generateContentWithRetry(() => llmGenerate(retryPrompt, { model: getSmartModel() }), { label: `retry:${s}` });
          const retryFixData = extractJsonFromModelResponse(retryText);
          if (!retryFixData || !Array.isArray(retryFixData.changes) || retryFixData.changes.length === 0) {
            throw new Error(`AI retry failed to produce valid patch for ${s}.`);
          }

          retryFixData.changes = enrichChangeVerificationComments(retryFixData.changes);
          retryFixData.reasoning = mergeImplementReasoningWithImpact(retryFixData);
          retryFixData.changes = ensureReviewComments(retryFixData.changes);
          const scopedRetryChanges = keepOnlyAllowedChanges(retryFixData.changes, changedPathList);
          if (scopedRetryChanges.length === 0) {
            throw new Error(`AI retry returned out-of-scope changes for ${s}; no allowed file changes to apply.`);
          }
          const retryValidation = validateAndPrepareChanges(scopedRetryChanges, {
            maxFiles: Number(process.env.AI_MAX_CHANGE_FILES) || 25,
            maxLinesPerFile: Number(process.env.AI_MAX_CHANGE_LINES_PER_FILE) || 1200,
            requireReviewComment: true,
          });
          if (!retryValidation.ok) {
            throw new Error(`AI retry changes rejected by action contract: ${retryValidation.reason}`);
          }

          await updateFixStep(fixId, `Applying Retry Changes (${s})`, retryFixData.reasoning || `Retry patch #${retryCount}`);
          const retryApplied = await applyChangesWithRefinement({
            repoPath,
            changes: retryValidation.prepared,
            ticketKey,
            stackLabel: stacks.join(','),
            shouldPreferScopedEdits,
            updateFixStep,
            fixId,
            llmGenerate,
            generateContentWithRetry,
            extractJsonFromModelResponse,
            truncateText,
          });
          allAppliedChanges = mergeChangesByPath(allAppliedChanges, retryApplied);
          fixData.reasoning = retryFixData.reasoning || fixData.reasoning;
          await db.query(
            'UPDATE app_ai_fixes SET reasoning = $1, changes = $2, updated_at = NOW() WHERE id = $3',
            [fixData.reasoning, JSON.stringify(allAppliedChanges), fixId]
          );
        }
      }
    }

    // 6.5 Critic pass before commit (quality gate)
    const criticPrompt = `
    Bạn là reviewer cuối trước commit.
    Hãy đánh giá thay đổi theo checklist: scope, interface contract, compile risk, regression risk.

    Ticket: ${ticketKey}
    Plan: ${planData.analysis_vi || 'N/A'}
    ${skipFullStackVerify ? `QUAN TRỌNG: Build/lint đã KHÔNG chạy (đánh giá trivial gate). Nếu thấy bất kỳ rủi ro biên dịch/DI/template binding/API contract thì phải set approve=false.\n` : ''}
    Changed files:
    ${allAppliedChanges.map(c => `- ${c.path}`).join('\n')}
    Latest reasoning:
    ${fixData.reasoning || ''}

    Trả về JSON:
    {
      "approve": true,
      "summary_vi": "Đánh giá ngắn gọn bằng tiếng Việt",
      "must_fix": []
    }

    Rules:
    - Nếu có lỗi blocker rõ ràng thì set approve=false và nêu must_fix.
    - Nếu không có blocker thì approve=true.
    - Output JSON only.
    `;
    const criticText = await generateContentWithRetry(() => llmGenerate(criticPrompt, { model: getSmartModel() }), { label: 'critic' });
    const criticData = extractJsonFromModelResponse(criticText);
    if (!criticData) {
      throw new Error('AI critic failed to return valid JSON.');
    }
    await updateFixStep(fixId, 'AI Critic', truncateText(criticData.summary_vi || 'Critic completed.', 500));
    if (!criticData.approve) {
      const mustFix = Array.isArray(criticData.must_fix) ? criticData.must_fix.join('; ') : 'Unknown blocker';
      throw new Error(`AI critic blocked commit: ${mustFix}`);
    }

    // 7. Finalization (Commit & Push)
    await updateFixStep(fixId, 'Pushing to Git');
    const projectGitUser = (project.git_user || '').trim();
    if (!projectGitUser || !projectGitUser.includes('@')) {
      throw new Error('Project git_user must be a valid email for commit author.');
    }
    const gitAuthorEmail = projectGitUser;
    const gitAuthorName = deriveAuthorNameFromEmail(projectGitUser) || 'AI Agent';
    const safeAuthorName = shellEscapeDoubleQuotes(gitAuthorName);
    const safeAuthorEmail = shellEscapeDoubleQuotes(gitAuthorEmail);
    await runCommand('git add .', repoPath);
    await runCommand(
      `git -c user.name="${safeAuthorName}" -c user.email="${safeAuthorEmail}" commit -m "AI Fix for ${ticketKey}"`,
      repoPath
    );
    const pushCmd = `git push -o merge_request.create -o merge_request.target="${project.base_branch || 'main'}" -o merge_request.title="AI Fix for ${ticketKey}" origin ${branchName}`;
    const pushResult = await runCommand(pushCmd, repoPath);
    const pushLog = `${pushResult.stdout || ''}\n${pushResult.stderr || ''}`.trim();
    if (pushLog) {
      const shortPushLog = pushLog.length > 1000 ? `${pushLog.substring(0, 1000)}...` : pushLog;
      await updateFixStep(fixId, 'Pushing to Git', shortPushLog);
    }

    // 8. Success
    await db.query(
      'UPDATE app_ai_fixes SET status = $1, current_step = $2, branch_name = $3, updated_at = NOW() WHERE id = $4',
      ['success', 'Completed', branchName, fixId]
    );
    await sendTelegramMessage(`✅ <b>[AI Agent]</b> Đã xử lý xong Ticket <b>${escapeHTML(ticketKey)}</b>!\n🌿 Branch: <code>${branchName}</code>\n🚀 Trạng thái: Hoàn thành & Đã push.`);

    if (String(process.env.AI_PROJECT_MEMORY_DISABLE || '').toLowerCase() !== '1') {
      try {
        const fr = await db.query('SELECT reasoning, changes, plan FROM app_ai_fixes WHERE id = $1', [fixId]);
        const lesson_vi = buildLessonFromFixRow(fr.rows[0], ticketDetails);
        let files = [];
        try {
          const ch = fr.rows[0]?.changes;
          const parsed = typeof ch === 'string' ? JSON.parse(ch) : ch;
          if (Array.isArray(parsed)) files = parsed.map((c) => c.path).filter(Boolean);
        } catch {
          /* ignore */
        }
        await appendProjectMemory(
          db,
          projectId,
          {
            fix_id: fixId,
            ticket_key: ticketKey,
            outcome: 'success',
            lesson_vi,
            files,
          },
          { llmGenerate }
        );
      } catch (memErr) {
        console.error('[AI Project Memory] append success:', memErr.message);
      }
    }

  } catch (error) {
    console.error(`[AI Agent] Error:`, error);
    const errMsg = error.message || (error.error && error.error.message) || error.stderr || String(error);
    
    if (fixId) {
      await db.query(
        'UPDATE app_ai_fixes SET status = $1, current_step = $2, log = COALESCE(log, \'\') || $3, updated_at = NOW() WHERE id = $4',
        ['failure', 'Failed', `\n[ERROR] ${errMsg}`, fixId]
      );
    }
    if (fixId && String(process.env.AI_PROJECT_MEMORY_DISABLE || '').toLowerCase() !== '1') {
      if (String(process.env.AI_PROJECT_MEMORY_LOG_FAILURES || '1').toLowerCase() !== '0') {
        try {
          const xr = await db.query('SELECT project_id FROM app_ai_fixes WHERE id = $1', [fixId]);
          const pid = xr.rows[0]?.project_id;
          if (pid) {
            await appendProjectMemory(
              db,
              pid,
              {
                fix_id: fixId,
                ticket_key: ticketKey,
                outcome: 'failure',
                lesson_vi: `Lỗi khi xử lý ticket ${ticketKey}: ${errMsg}`,
                files: [],
              },
              { llmGenerate }
            );
          }
        } catch (memErr) {
          console.error('[AI Project Memory] append failure:', memErr.message);
        }
      }
    }
    await sendTelegramMessage(`❌ <b>[AI Agent]</b> Thất bại khi xử lý Ticket <b>${escapeHTML(ticketKey)}</b>!\n⚠️ Lỗi: <code>${escapeHTML(errMsg)}</code>`);
  }
};

const resumeAiFix = async (fixId, feedback = null) => {
  try {
    const fixRes = await db.query('SELECT * FROM app_ai_fixes WHERE id = $1', [fixId]);
    if (fixRes.rows.length === 0) throw new Error('Fix record not found');
    const fix = fixRes.rows[0];

    const ticketDetails = {
      summary: fix.ticket_summary || '',
      description: fix.ticket_description || '',
    };

    let mergedAdditionalContext = fix.additional_context || '';

    if (feedback) {
      const maxPlan = Number(process.env.AI_REPLAN_MAX_PLAN_CHARS) || 30000;
      const maxLog = Number(process.env.AI_REPLAN_MAX_LOG_CHARS) || 20000;
      const maxReasoning = Number(process.env.AI_REPLAN_MAX_REASONING_CHARS) || 12000;
      const maxChanges = Number(process.env.AI_REPLAN_MAX_CHANGES_CHARS) || 20000;

      let planStr = '';
      if (fix.plan) {
        planStr = typeof fix.plan === 'string' ? fix.plan : JSON.stringify(fix.plan, null, 2);
      }
      let reasoningStr = '';
      if (fix.reasoning != null && fix.reasoning !== '') {
        reasoningStr =
          typeof fix.reasoning === 'string' ? fix.reasoning : JSON.stringify(fix.reasoning, null, 2);
      }
      let changesStr = '';
      if (fix.changes != null) {
        changesStr = typeof fix.changes === 'string' ? fix.changes : JSON.stringify(fix.changes, null, 2);
      }

      const replanBundle = [
        '=== RE-PLAN CONTEXT (read fully; do not ignore) ===',
        '--- Previous plan (JSON) ---',
        truncateText(planStr || '(no saved plan)', maxPlan),
        '--- Execution / terminal log (excerpt) ---',
        truncateText(fix.log || '', maxLog),
        '--- Previous reasoning ---',
        truncateText(reasoningStr || '(none)', maxReasoning),
        '--- Previous proposed changes (summary) ---',
        truncateText(changesStr || '(none)', maxChanges),
        '--- User feedback (must address) ---',
        String(feedback).trim(),
      ].join('\n\n');

      mergedAdditionalContext = [fix.additional_context, replanBundle].filter(Boolean).join('\n\n---\n\n');

      await db.query(
        "UPDATE app_ai_fixes SET plan = NULL, status = 'in_progress' WHERE id = $1",
        [fixId]
      );
    }

    return triggerAiFix(fix.ticket_key, fix.project_id, ticketDetails, mergedAdditionalContext, {
      resumeFixId: fixId,
      approveImmediately: !feedback,
      feedback,
    });
  } catch (error) {
    console.error(`[AI Agent] Resume Error:`, error);
  }
};

module.exports = { 
  triggerAiFix, 
  cloneProject,
  extractContextSignals,
  buildContextFileList,
  resumeAiFix
};
