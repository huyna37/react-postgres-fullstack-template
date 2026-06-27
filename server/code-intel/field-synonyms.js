const { removeAccents, tokenize } = require('./utils');

/** Cụm nghiệp vụ VN → token code / DB thường gặp */
const DOMAIN_PHRASES = [
  { re: /bien\s*so(\s*xe)?|license\s*plate|plate\s*number/gi, tokens: ['plate', 'bienso', 'licenseplate', 'platenumber', 'vehicleplate', 'carplate'] },
  { re: /giao\s*dich/gi, tokens: ['transaction', 'giaodich'] },
  { re: /thu\s*phi|etc/gi, tokens: ['toll', 'etc', 'etctransaction'] },
  { re: /tram|station/gi, tokens: ['station', 'lane', 'hub'] },
  { re: /thoi\s*gian|datetime/gi, tokens: ['time', 'date', 'datetime', 'timestamp'] },
  { re: /so\s*tien|amount/gi, tokens: ['amount', 'fee', 'price', 'money'] },
];

const expandFieldConcepts = (question, plan = {}) => {
  const raw = [question, ...(plan.search_concepts || [])].join(' ');
  const q = removeAccents(raw.toLowerCase());
  const tokens = new Set(tokenize(q).filter((t) => t.length >= 2));

  for (const { re, toks } of DOMAIN_PHRASES.map((p) => ({ re: p.re, toks: p.tokens }))) {
    if (re.test(raw)) toks.forEach((t) => tokens.add(t));
  }

  return [...tokens];
};

const normalizeFieldName = (name) =>
  removeAccents(String(name || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const fieldNamesMatch = (a, b) => {
  const na = normalizeFieldName(a);
  const nb = normalizeFieldName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  if (na.endsWith(nb) || nb.endsWith(na)) return true;
  return false;
};

module.exports = {
  DOMAIN_PHRASES,
  expandFieldConcepts,
  normalizeFieldName,
  fieldNamesMatch,
};
