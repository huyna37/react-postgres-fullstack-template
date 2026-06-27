const fs = require('fs');
const path = require('path');
const { normalizePath, readFileSafe, removeAccents, textSimilarity } = require('./utils');

const I18N_JSON_RE = /assets[\\/]i18n[\\/][^\\/]+\.json$/i;
const I18N_XML_RE = /Localization[\\/][^\\/]+\.xml$/i;

const indexI18nFiles = (repoPath, filePaths) => {
  const entries = [];

  for (const rel of filePaths) {
    const n = normalizePath(rel);
    if (I18N_JSON_RE.test(n)) {
      const content = readFileSafe(repoPath, rel);
      if (!content) continue;
      try {
        const json = JSON.parse(content);
        flattenJson(json, '', rel, entries);
      } catch {
        /* skip */
      }
    }

    if (I18N_XML_RE.test(n)) {
      const content = readFileSafe(repoPath, rel);
      if (!content) continue;
      const re = /<text\s+name="([^"]+)"[^>]*>([^<]+)<\/text>/gi;
      let m;
      while ((m = re.exec(content))) {
        entries.push({
          key: m[1],
          text: m[2].trim(),
          file: n,
          lang: 'xml',
        });
      }
    }
  }

  return entries;
};

const flattenJson = (obj, prefix, file, out) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenJson(v, key, file, out);
    else if (typeof v === 'string' && v.length >= 2) {
      out.push({ key, text: v, file: normalizePath(file), lang: 'json' });
    }
  }
};

const lookupI18n = (entries, nameKey) => {
  if (!nameKey) return null;
  const exact = entries.find((e) => e.key === nameKey || e.key.endsWith(`.${nameKey}`));
  return exact?.text || null;
};

const searchI18nByQuery = (entries, query) => {
  const q = removeAccents(String(query || '').toLowerCase());
  const scored = [];
  for (const e of entries) {
    const text = removeAccents(e.text.toLowerCase());
    const sim = textSimilarity(q, text);
    if (sim >= 0.35 || text.includes(q) || q.includes(text)) {
      scored.push({ ...e, score: sim + (text.includes('etc') && q.includes('etc') ? 0.5 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10);
};

module.exports = {
  indexI18nFiles,
  lookupI18n,
  searchI18nByQuery,
};
