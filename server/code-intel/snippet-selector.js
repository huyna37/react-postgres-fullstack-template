const path = require('path');
const { readFileSafe, normalizePath } = require('./utils');

const DEFAULT_MAX_CHARS = 80000;
const MAX_METHOD_LINES = 80;
const MAX_CLASS_LINES = 120;

const extractMethodBlock = (content, lineHint) => {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, (lineHint || 1) - 5);
  let depth = 0;
  let started = false;
  const out = [];
  for (let i = start; i < lines.length && out.length < MAX_METHOD_LINES; i++) {
    const line = lines[i];
    out.push(line);
    if (/^\s*(?:public|private|protected|internal|async|export|function|\w+\s*\()/.test(line)) started = true;
    depth += (line.match(/{/g) || []).length;
    depth -= (line.match(/}/g) || []).length;
    if (started && depth <= 0 && out.length > 5) break;
  }
  return out.join('\n');
};

const extractClassRegion = (content, className, lineHint) => {
  const lines = content.split(/\r?\n/);
  let start = Math.max(0, (lineHint || 1) - 3);
  if (className) {
    const idx = lines.findIndex((l, i) => i >= start - 10 && new RegExp(`class\\s+${className}\\b`).test(l));
    if (idx >= 0) start = idx;
  }
  return lines.slice(start, start + MAX_CLASS_LINES).join('\n');
};

const selectSnippets = (repoPath, nodes, options = {}) => {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const parts = [];
  let budget = maxChars;
  const seenFiles = new Set();

  const sorted = [...(nodes || [])].sort((a, b) => (a.hop ?? 0) - (b.hop ?? 0));

  for (const node of sorted) {
    if (!node?.file || seenFiles.has(node.file)) continue;
    if (budget < 500) break;

    const content = readFileSafe(repoPath, node.file);
    if (!content) continue;

    let snippet = '';
    const ext = path.extname(node.file).toLowerCase();

    if (node.line && (node.type === 'endpoint' || node.type === 'component' || node.type === 'appService')) {
      snippet = extractMethodBlock(content, node.line);
    } else if (node.name && ext === '.cs') {
      snippet = extractClassRegion(content, node.name, node.line);
    } else if (node.name && (ext === '.ts' || ext === '.tsx')) {
      snippet = extractClassRegion(content, node.name, node.line);
    } else if (ext === '.html' && node.templateUrl) {
      const tpl = readFileSafe(repoPath, node.templateUrl);
      snippet = tpl ? tpl.slice(0, 4000) : content.slice(0, 3000);
    } else {
      snippet = content.slice(0, 3500);
    }

    if (node.fields && node.templateUrl) {
      const tpl = readFileSafe(repoPath, node.templateUrl);
      if (tpl) {
        snippet += `\n\n<!-- template: ${node.templateUrl} -->\n${tpl.slice(0, 2500)}`;
      }
    }

    const header = `### ${node.type}: ${node.name || node.path} (${node.file}${node.line ? `:${node.line}` : ''})\n`;
    const block = `${header}\`\`\`${ext.slice(1) || 'text'}\n${snippet}\n\`\`\`\n`;

    if (block.length <= budget) {
      parts.push(block);
      budget -= block.length;
      seenFiles.add(node.file);
      if (node.templateUrl) seenFiles.add(normalizePath(node.templateUrl));
    }
  }

  return {
    text: parts.join('\n'),
    files: Array.from(seenFiles),
    charCount: maxChars - budget,
  };
};

module.exports = {
  selectSnippets,
  extractMethodBlock,
  extractClassRegion,
};
