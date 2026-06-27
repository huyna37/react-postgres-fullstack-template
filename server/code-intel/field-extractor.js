const path = require('path');
const { readFileSafe, normalizePath } = require('./utils');

const extractFromHtml = (content) => {
  const displayFields = new Set();
  const tableColumns = new Set();
  const filterFields = new Set();
  const sortFields = new Set();

  // {{ item.field }}
  const interpRe = /\{\{\s*[\w.]+\.?(\w+)\s*\}\}/g;
  let m;
  while ((m = interpRe.exec(content))) {
    if (m[1] && m[1].length > 1 && !/^(true|false|null|undefined)$/i.test(m[1])) displayFields.add(m[1]);
  }

  // p-column field="x"
  const pColRe = /<p-(?:column|tableColumn)[^>]*\sfield\s*=\s*["']([^"']+)["']/gi;
  while ((m = pColRe.exec(content))) tableColumns.add(m[1]);

  // p-column header / localize key
  const pHeaderRe = /<p-column[^>]*\sheader\s*=\s*["']([^"']+)["']/gi;
  while ((m = pHeaderRe.exec(content))) {
    const h = m[1];
    if (h && !h.includes('{{')) displayFields.add(h);
  }

  const locKeyRe = /['"]([A-Za-z][\w.]*)['"]\s*\|\s*localize/g;
  while ((m = locKeyRe.exec(content))) displayFields.add(m[1]);

  // AG Grid columnDefs
  const agRe = /field\s*:\s*['"]([^'"]+)['"]/g;
  while ((m = agRe.exec(content))) tableColumns.add(m[1]);

  // mat-column-def / cdkColumnDef
  const matRe = /matColumnDef\s*=\s*["']([^"']+)["']/gi;
  while ((m = matRe.exec(content))) tableColumns.add(m[1]);

  // filter inputs
  const filterRe = /(?:formControlName|name|ngModel)\s*=\s*["']([^"']+)["']/gi;
  while ((m = filterRe.exec(content))) {
    const name = m[1];
    if (/filter|search|date|from|to|status|lane|plate/i.test(name) || /Filter|Search|Date|Status/.test(name)) {
      filterFields.add(name);
    }
  }

  // p-sortIcon / sortField
  const sortRe = /(?:sortField|pSortableColumn)\s*=\s*["']([^"']+)["']/gi;
  while ((m = sortRe.exec(content))) sortFields.add(m[1]);

  return {
    displayFields: Array.from(displayFields),
    tableColumns: Array.from(tableColumns),
    filterFields: Array.from(filterFields),
    sortFields: Array.from(sortFields),
  };
};

const extractFieldsForComponent = (repoPath, component) => {
  if (!component?.templateUrl) return extractFromHtml('');
  const tpl = readFileSafe(repoPath, component.templateUrl);
  if (!tpl) {
    // try inline template in .ts
    const ts = readFileSafe(repoPath, component.file);
    if (ts) {
      const inline = ts.match(/template\s*:\s*`([\s\S]*?)`/);
      if (inline) return extractFromHtml(inline[1]);
    }
    return { displayFields: [], tableColumns: [], filterFields: [], sortFields: [] };
  }
  return extractFromHtml(tpl);
};

const attachFieldsToComponents = (repoPath, components) => {
  return components.map((c) => ({
    ...c,
    fields: extractFieldsForComponent(repoPath, c),
  }));
};

module.exports = {
  extractFromHtml,
  extractFieldsForComponent,
  attachFieldsToComponents,
};
