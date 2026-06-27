const OUTPUT_FIELD_KEY = 'customfield_10304';

function isCommentField(key) {
  return key === 'comment';
}

function normalizeAllowedValues(values) {
  if (!Array.isArray(values)) return [];
  return values.map(v => ({
    id: v.id != null ? String(v.id) : null,
    name: v.name || v.value || '',
    value: v.value || v.name || '',
  }));
}

/** Mở rộng metadata field từ Jira transitions API. */
function normalizeTransitionFieldEntry(key, meta) {
  return {
    key,
    name: meta?.name || key,
    required: !!meta?.required || key === OUTPUT_FIELD_KEY,
    schema: meta?.schema || null,
    allowedValues: normalizeAllowedValues(meta?.allowedValues),
  };
}

function normalizeTransitionFields(fields) {
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields).map(([key, meta]) => normalizeTransitionFieldEntry(key, meta));
}

function getFieldInput(input, fieldKey) {
  const fields = input?.fields || {};
  if (fields[fieldKey] !== undefined && fields[fieldKey] !== null) {
    return fields[fieldKey];
  }
  if (fieldKey === OUTPUT_FIELD_KEY && input?.output !== undefined) {
    return input.output;
  }
  return undefined;
}

function hasCommentInput(input) {
  const text = String(input?.comment || input?.text || '').trim();
  return !!(text || (Array.isArray(input?.images) && input.images.length > 0));
}

function validateTransitionInput(transition, input) {
  const missing = [];
  for (const field of (transition?.fields || []).filter(f => f.required)) {
    if (isCommentField(field.key)) {
      if (!hasCommentInput(input)) missing.push(field);
      continue;
    }
    const val = getFieldInput(input, field.key);
    if (val === undefined || val === null || String(val).trim() === '') {
      missing.push(field);
    }
  }
  return missing;
}

function formatFieldValueForJira(field, rawValue) {
  const value = rawValue;
  const type = field?.schema?.type;
  const system = field?.schema?.system;

  if (type === 'resolution' || system === 'resolution' || field.key === 'resolution') {
    const allowed = field.allowedValues || [];
    const str = String(value);
    const found =
      allowed.find(v => v.id === str) ||
      allowed.find(v => v.name === str) ||
      allowed.find(v => v.value === str);
    if (found?.id) return { id: found.id };
    if (found?.name) return { name: found.name };
    return { name: str };
  }

  if (type === 'option' || type === 'priority' || system === 'priority') {
    const allowed = field.allowedValues || [];
    const str = String(value);
    const found =
      allowed.find(v => v.id === str) ||
      allowed.find(v => v.value === str) ||
      allowed.find(v => v.name === str);
    if (found?.id) return { id: found.id };
    if (found?.value) return { value: found.value };
    return { value: str };
  }

  if (type === 'user' || system === 'assignee' || system === 'reporter') {
    if (typeof value === 'object' && value !== null) return value;
    const str = String(value).trim();
    if (str.includes('@')) return { emailAddress: str };
    return { accountId: str };
  }

  const isDatetime = type === 'datetime' || (field?.schema?.custom && field.schema.custom.toLowerCase().includes('datetime'));
  const isDate = type === 'date' || (field?.schema?.custom && field.schema.custom.toLowerCase().includes('datepicker'));

  if (isDatetime) {
    const s = String(value).trim();
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        const tzo = -d.getTimezoneOffset();
        const dif = tzo >= 0 ? '+' : '-';
        const pad = num => String(Math.floor(Math.abs(num))).padStart(2, '0');
        const tzStr = dif + pad(tzo / 60) + pad(tzo % 60);
        return d.getFullYear() +
            '-' + pad(d.getMonth() + 1) +
            '-' + pad(d.getDate()) +
            'T' + pad(d.getHours()) +
            ':' + pad(d.getMinutes()) +
            ':' + pad(d.getSeconds()) +
            '.000' + tzStr;
      }
    } catch(e) {}
    return s;
  }

  if (isDate) {
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
  }

  if (type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }

  return typeof value === 'string' ? value : String(value ?? '');
}

function buildTransitionFieldsPayload(transition, input) {
  const out = {};
  for (const field of transition?.fields || []) {
    if (isCommentField(field.key)) continue;
    const raw = getFieldInput(input, field.key);
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    out[field.key] = formatFieldValueForJira(field, raw);
  }
  return out;
}

function formatJiraApiError(error) {
  const data = error?.response?.data;
  if (!data) return error?.message || 'Jira request failed';
  const parts = [...(data.errorMessages || [])];
  if (data.errors && typeof data.errors === 'object') {
    for (const [key, msg] of Object.entries(data.errors)) {
      parts.push(`${key}: ${msg}`);
    }
  }
  return parts.filter(Boolean).join(' ') || error?.message || 'Jira request failed';
}

module.exports = {
  OUTPUT_FIELD_KEY,
  isCommentField,
  normalizeTransitionFieldEntry,
  normalizeTransitionFields,
  validateTransitionInput,
  buildTransitionFieldsPayload,
  formatJiraApiError,
};
