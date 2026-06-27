const { removeAccents, tokenize, camelToTokens } = require('./utils');

const STOPWORDS = new Set([
  'app', 'main', 'admin', 'page', 'pages', 'component', 'module', 'service',
  'trang', 'man', 'hinh', 'nam', 'nao', 'nào', 'dau', 'url', 'path', 'the', 'and', 'for',
  'cho', 'cua', 'cac', 'mot', 'nay', 'la', 'co', 'khong', 'o', 'dau', 'nao',
]);

const PHRASE_PATTERNS = [
  { re: /giao\s*dich|giao-dich/gi, tokens: ['giaodich', 'transaction'] },
  { re: /bao\s*cao/gi, tokens: ['baocao', 'report'] },
  { re: /chi\s*tiet/gi, tokens: ['chitiet', 'detail'] },
  { re: /thu\s*phi/gi, tokens: ['thuphi', 'toll'] },
  { re: /xe\s*qua\s*tram/gi, tokens: ['lane', 'station'] },
  { re: /bien\s*so(\s*xe)?/gi, tokens: ['plate', 'bienso', 'licenseplate', 'platenumber'] },
];

const extractPhrases = (text) => {
  const phrases = new Set();
  const raw = String(text || '');
  for (const { re, tokens } of PHRASE_PATTERNS) {
    if (re.test(raw)) tokens.forEach((t) => phrases.add(t));
  }
  return [...phrases];
};

const isSignificantToken = (t) => t && (t.length >= 2) && !STOPWORDS.has(t);

/**
 * Profile chuẩn cho lexical + hybrid search (anchor từ câu hỏi, concept từ planner).
 */
const buildQueryProfile = (question, plan = {}) => {
  const questionOnly = String(question || '').trim();
  const qNorm = removeAccents(questionOnly.toLowerCase());
  const phrases = extractPhrases(questionOnly);

  const anchorTokens = [
    ...tokenize(qNorm).filter(isSignificantToken),
    ...phrases,
  ];
  const anchorUnique = [...new Set(anchorTokens)];

  const expandedRaw = [
    questionOnly,
    ...(plan.search_concepts || []),
    ...(plan.page_name_hints || []),
    ...(plan.hypotheses || []),
  ]
    .filter(Boolean)
    .join(' ');

  const expandedNorm = removeAccents(expandedRaw.toLowerCase());
  const expandedTokens = [
    ...new Set([
      ...tokenize(expandedNorm).filter(isSignificantToken),
      ...phrases,
      ...anchorUnique,
    ]),
  ];

  for (const hint of plan.page_name_hints || []) {
    camelToTokens(hint).forEach((t) => {
      if (isSignificantToken(t)) expandedTokens.push(t);
    });
  }

  const embeddingText = expandedRaw.slice(0, 2000);

  return {
    question: questionOnly,
    questionNorm: qNorm,
    anchorTokens: anchorUnique,
    expandedTokens: [...new Set(expandedTokens)],
    phrases,
    embeddingText,
    expandedRaw,
  };
};

module.exports = {
  STOPWORDS,
  buildQueryProfile,
  extractPhrases,
  isSignificantToken,
};
