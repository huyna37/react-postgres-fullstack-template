const { resolvePageFromCatalog } = require('../code-intel/page-catalog');
const { buildQueryProfile } = require('../code-intel/query-profile');
const { searchEmbeddings, loadEmbeddings } = require('../code-intel/embedding-store');

const formatPageAnswer = (question, resolution) => {
  if (!resolution?.url) return null;

  const lines = [];
  const title = resolution.menuLabel || resolution.component || 'nghiệp vụ';
  lines.push(`**${title}**`);
  lines.push(`URL: \`${resolution.url}\``);
  if (resolution.component) lines.push(`Component: \`${resolution.component}\``);
  if (resolution.permission) lines.push(`Permission: \`${resolution.permission}\``);

  lines.push('');
  lines.push('**Căn cứ:**');
  for (const e of resolution.evidence || []) lines.push(`- ${e}`);

  if (resolution.ambiguous && resolution.alternatives?.length > 1) {
    lines.push('');
    lines.push('**Ứng viên khác (điểm gần):**');
    for (const alt of resolution.alternatives.slice(0, 2)) {
      lines.push(`- \`${alt.url}\`${alt.label ? ` — ${alt.label}` : ''} (score ${Math.round(alt.score)})`);
    }
  }

  if (resolution.lowConfidence) {
    lines.push('');
    lines.push('*(Độ tin cậy trung bình — nên xác nhận thêm trong menu/route của repo.)*');
  }

  return lines.join('\n');
};

const resolutionToSteps = (resolution) => {
  if (!resolution?.evidence?.length) return [];
  return resolution.evidence.slice(0, 5).map((detail, i) => ({
    title: `Căn cứ ${i + 1}`,
    detail,
  }));
};

const resolvePage = async (question, plan, indexData) => {
  const store = indexData?.store;
  const chunkIndex = indexData?.chunkIndex || [];
  const pageCatalog = indexData?.pageCatalog || [];

  let embeddingScores = new Map();
  if (store && chunkIndex.length) {
    try {
      const profile = buildQueryProfile(question, plan);
      const embIndex = loadEmbeddings(store);
      embeddingScores = await searchEmbeddings(profile.embeddingText, embIndex, 30);
    } catch {
      embeddingScores = new Map();
    }
  }

  return resolvePageFromCatalog(pageCatalog, question, plan, {
    chunkIndex,
    embeddingScores,
  });
};

module.exports = {
  resolvePage,
  formatPageAnswer,
  resolutionToSteps,
};
