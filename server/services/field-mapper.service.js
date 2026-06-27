const { resolveFieldMapping, buildFieldRegistry } = require('../code-intel/field-registry');
const { hybridSearch } = require('../code-intel/hybrid-retriever');
const { buildQueryProfile } = require('../code-intel/query-profile');
const { KIND } = require('../code-intel/chunk-index');
const { searchEmbeddings, loadEmbeddings } = require('../code-intel/embedding-store');
const { expandFieldConcepts } = require('../code-intel/field-synonyms');

const isFieldMappingQuestion = (intents, question) => {
  const q = String(question || '').toLowerCase();
  if (intents.includes('data-model')) return true;
  return (
    /\b(truong|trường|field|column|cột)\b.*\b(database|db|entity|bảng|table)\b/i.test(q) ||
    /\b(trùng|khớp|map|mapping|tương ứng|tuong ung)\b/i.test(q) ||
    /\btrong database\b/i.test(q)
  );
};

const formatFieldAnswer = (resolution) => {
  if (!resolution?.entityField && !resolution?.dtoField) return null;

  const lines = [];
  const label = resolution.uiLabels?.[0] || resolution.uiField;
  lines.push(`Trường **${label || resolution.uiField}** (màn hình \`${resolution.component}\`):`);

  if (resolution.entityField && resolution.entityType) {
    lines.push(`- **Entity:** \`${resolution.entityType}.${resolution.entityField}\``);
  }
  if (resolution.dbColumn) {
    lines.push(`- **Cột DB:** \`${resolution.dbColumn}\``);
  }
  if (resolution.dtoField && resolution.dtoType) {
    lines.push(`- **DTO:** \`${resolution.dtoType}.${resolution.dtoField}\``);
  }

  lines.push('');
  lines.push('**Căn cứ:**');
  for (const e of resolution.evidence || []) lines.push(`- ${e}`);

  if (resolution.ambiguous && resolution.alternatives?.length) {
    lines.push('');
    lines.push('**Ứng viên khác:**');
    for (const alt of resolution.alternatives.slice(0, 2)) {
      lines.push(`- \`${alt.entityType}.${alt.entityField}\` (UI: ${alt.uiField})`);
    }
  }

  return lines.join('\n');
};

const resolutionToSteps = (resolution) =>
  (resolution?.evidence || []).slice(0, 5).map((detail, i) => ({
    title: `Căn cứ ${i + 1}`,
    detail,
  }));

const resolveField = async (question, plan, indexData) => {
  let registry = indexData?.fieldRegistry;
  if (!registry?.mappings?.length && indexData?.components?.length) {
    registry = buildFieldRegistry({
      components: indexData.components,
      dtos: indexData.dtos || [],
      entities: indexData.entities || [],
      i18nEntries: indexData.i18nEntries || [],
    });
  }

  let resolution = resolveFieldMapping(registry, question, plan, indexData?.i18nEntries || []);

  if (!resolution?.entityField && indexData?.chunkIndex?.length) {
    const profile = buildQueryProfile(question, plan);
    profile.expandedTokens = [...new Set([...profile.expandedTokens, ...expandFieldConcepts(question, plan)])];

    let embeddingScores = new Map();
    if (indexData.store) {
      try {
        embeddingScores = await searchEmbeddings(profile.embeddingText, loadEmbeddings(indexData.store), 25);
      } catch {
        /* skip */
      }
    }

    const fieldChunks = indexData.chunkIndex.filter((c) =>
      [KIND.FIELD, KIND.ENTITY, KIND.DTO].includes(c.kind)
    );
    const { results } = hybridSearch(fieldChunks, question, plan, embeddingScores, {
      topK: 8,
      profile,
    });

    const top = results[0]?.chunk;
    if (top?.meta) {
      resolution = {
        uiField: top.meta.uiField || top.meta.name,
        entityField: top.meta.entityField || top.meta.name,
        entityType: top.meta.entityType || top.meta.parent,
        dtoField: top.meta.dtoField,
        dtoType: top.meta.dtoType,
        dbColumn: top.meta.dbColumn || top.meta.column,
        component: top.meta.component,
        uiLabels: [],
        score: results[0].score * 100,
        evidence: [
          `Chunk \`${top.kind}\`: ${top.title}`,
          `File: ${top.meta.file || top.meta.entityFile || top.meta.dtoFile || '—'}`,
          `Hybrid RRF: ${results[0].score.toFixed(4)}`,
        ],
        confident: results[0].score > 0.02,
        ambiguous: results[1] && results[1].score >= results[0].score * 0.88,
        alternatives: [],
      };
    }
  }

  return resolution;
};

module.exports = {
  isFieldMappingQuestion,
  resolveField,
  formatFieldAnswer,
  resolutionToSteps,
};
