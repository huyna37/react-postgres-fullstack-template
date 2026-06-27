const { removeAccents, tokenize, camelToTokens } = require('./utils');
const { lookupI18n, searchI18nByQuery } = require('./i18n-indexer');
const { fieldNamesMatch, expandFieldConcepts } = require('./field-synonyms');

const buildSearchText = (parts) =>
  removeAccents(parts.filter(Boolean).join(' ').toLowerCase());

const collectUiFields = (components, i18nEntries) => {
  const ui = [];
  for (const comp of components) {
    const fields = comp.fields || {};
    const names = new Set([
      ...(fields.tableColumns || []),
      ...(fields.displayFields || []),
      ...(fields.filterFields || []),
      ...(fields.sortFields || []),
    ]);
    for (const name of names) {
      ui.push({
        layer: 'ui',
        name,
        component: comp.name,
        componentFile: comp.file,
        labels: [],
        searchText: buildSearchText([name, ...camelToTokens(name), comp.name]),
      });
    }
  }

  const i18nHits = new Map();
  for (const entry of i18nEntries) {
  if (!entry.text) continue;
    const t = removeAccents(entry.text.toLowerCase());
    if (t.length < 3) continue;
    i18nHits.set(entry.key, entry.text);
  }

  for (const row of ui) {
    for (const [key, text] of i18nHits) {
      if (fieldNamesMatch(row.name, key) || key.toLowerCase().includes(row.name.toLowerCase())) {
        row.labels.push(text);
      }
    }
  }

  return ui;
};

const collectCsFields = (items, layer) =>
  (items || []).flatMap((item) =>
    (item.properties || []).map((prop) => ({
      layer,
      name: prop.name,
      column: prop.column || prop.name,
      type: prop.type,
      parent: item.name,
      parentFile: item.file,
      parentLine: prop.line || item.line,
      searchText: buildSearchText([
        prop.name,
        prop.column,
        prop.type,
        item.name,
        ...camelToTokens(prop.name),
        item.namespace,
      ]),
    }))
  );

const linkLayers = (uiFields, dtoFields, entityFields) => {
  const links = [];

  for (const ui of uiFields) {
    const dto = dtoFields.find((d) => fieldNamesMatch(ui.name, d.name));
    const entity = entityFields.find((e) => fieldNamesMatch(ui.name, e.name));

    if (!dto && !entity) continue;

    links.push({
      id: `map:${ui.component}:${ui.name}:${entity?.parent || dto?.parent || '?'}`,
      uiField: ui.name,
      uiLabels: ui.labels,
      component: ui.component,
      componentFile: ui.componentFile,
      dtoField: dto?.name || null,
      dtoType: dto?.parent || null,
      dtoFile: dto?.parentFile || null,
      entityField: entity?.name || dto?.name || null,
      entityType: entity?.parent || null,
      entityFile: entity?.parentFile || null,
      dbColumn: entity?.column || dto?.column || entity?.name || dto?.name || null,
      searchText: buildSearchText([
        ui.name,
        ...(ui.labels || []),
        dto?.name,
        dto?.parent,
        entity?.name,
        entity?.parent,
        entity?.column,
        ui.component,
      ]),
    });
  }

  return links;
};

const buildFieldRegistry = ({ components = [], dtos = [], entities = [], i18nEntries = [] }) => {
  const uiFields = collectUiFields(components, i18nEntries);
  const dtoFields = collectCsFields(dtos, 'dto');
  const entityFields = collectCsFields(entities, 'entity');
  const mappings = linkLayers(uiFields, dtoFields, entityFields);

  const propertyIndex = [...dtoFields, ...entityFields, ...uiFields];

  return {
    mappings,
    propertyIndex,
    stats: {
      ui: uiFields.length,
      dto: dtoFields.length,
      entity: entityFields.length,
      mappings: mappings.length,
    },
  };
};

const scoreMapping = (mapping, concepts, questionNorm) => {
  let score = 0;
  const text = mapping.searchText || '';

  for (const c of concepts) {
    if (text.includes(removeAccents(c.toLowerCase()))) score += 10;
  }

  for (const label of mapping.uiLabels || []) {
    const ln = removeAccents(label.toLowerCase());
    if (questionNorm.includes(ln) || ln.split(/\s+/).every((w) => w.length < 3 || questionNorm.includes(w))) {
      score += 25;
    }
  }

  if (mapping.entityField && mapping.uiField) score += 15;
  if (mapping.dbColumn) score += 5;

  return score;
};

const resolveFieldMapping = (registry, question, plan = {}, i18nEntries = []) => {
  const mappings = registry?.mappings || [];
  if (!mappings.length) return null;

  const questionNorm = removeAccents(String(question).toLowerCase());
  const concepts = expandFieldConcepts(question, plan);

  const i18nExtra = searchI18nByQuery(i18nEntries, question).slice(0, 5);
  for (const hit of i18nExtra) {
    concepts.push(...tokenize(removeAccents(hit.text.toLowerCase())));
  }

  const scored = mappings
    .map((m) => ({ mapping: m, score: scoreMapping(m, concepts, questionNorm) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  const top = scored[0];
  const second = scored[1];
  const ambiguous = second && second.score >= top.score * 0.85;

  const m = top.mapping;
  const evidence = [];
  if (m.uiField) evidence.push(`UI field \`${m.uiField}\` (component \`${m.component}\`, ${m.componentFile})`);
  if (m.uiLabels?.length) evidence.push(`Nhãn i18n: "${m.uiLabels[0]}"`);
  if (m.dtoField) evidence.push(`DTO \`${m.dtoType}.${m.dtoField}\` (${m.dtoFile})`);
  if (m.entityField) evidence.push(`Entity \`${m.entityType}.${m.entityField}\` (${m.entityFile})`);
  if (m.dbColumn) evidence.push(`Cột DB (property/Column): \`${m.dbColumn}\``);

  return {
    uiField: m.uiField,
    uiLabels: m.uiLabels,
    component: m.component,
    dtoField: m.dtoField,
    dtoType: m.dtoType,
    entityField: m.entityField,
    entityType: m.entityType,
    dbColumn: m.dbColumn,
    score: top.score,
    evidence,
    confident: top.score >= 25 && !!m.entityField,
    ambiguous,
    alternatives: ambiguous
      ? scored.slice(0, 3).map((s) => ({
          entityField: s.mapping.entityField,
          entityType: s.mapping.entityType,
          uiField: s.mapping.uiField,
          score: s.score,
        }))
      : [],
  };
};

module.exports = {
  buildFieldRegistry,
  resolveFieldMapping,
  collectUiFields,
  linkLayers,
};
