const { exec } = require('child_process');
const { shellSingleQuote } = require('./grep-fallback-utils');
const { normalizePath, classifyFeBeRest } = require('./utils');

const MAX_GREP_FILES = 30;
const MAX_GREP_SIGNALS = 12;

const runCommand = (command, cwd) =>
  new Promise((resolve, reject) => {
    exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) resolve({ stdout: stdout || '' });
      else resolve({ stdout });
    });
  });

const gitGrepFallback = async (repoPath, signals, stacks, limit = MAX_GREP_FILES) => {
  const specs = [];
  for (const s of stacks || []) {
    if (s === 'dotnet') specs.push('*.cs', '*.ts');
    if (s === 'angular') specs.push('*.ts', '*.html');
    if (s === 'nodejs') specs.push('*.js', '*.ts');
  }
  if (specs.length === 0) specs.push('*.ts', '*.cs', '*.html');
  const specArg = [...new Set(specs)].map((p) => `'${p}'`).join(' ');

  const found = [];
  const seen = new Set();

  for (const sig of (signals || []).slice(0, MAX_GREP_SIGNALS)) {
    const literal = String(sig).trim();
    if (literal.length < 3) continue;
    const quoted = shellSingleQuote(literal);
    const cmd = `git grep -l -F ${quoted} HEAD -- ${specArg}`;
    const { stdout } = await runCommand(cmd, repoPath);
    for (const line of stdout.split('\n')) {
      const norm = normalizePath(line.trim());
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      found.push({ file: norm, rank: classifyFeBeRest(norm) === 'fe' ? 0 : 1 });
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
  }

  found.sort((a, b) => a.rank - b.rank);
  return found.map((f) => f.file);
};

module.exports = {
  gitGrepFallback,
  MAX_GREP_FILES,
};
