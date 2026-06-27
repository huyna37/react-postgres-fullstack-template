const fs = require('fs');
const path = require('path');

const classifyVerificationError = (output) => {
  const text = String(output || '').toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('cannot find module') || text.includes('module not found') || text.includes('nu1101') || text.includes('nu1102')) return 'dependency';
  if (text.includes('eslint') || text.includes('lint')) return 'lint';
  if (text.includes('test failed') || text.includes('failing test') || text.includes('jest') || text.includes('xunit')) return 'test';
  if (text.includes('ts2304') || text.includes('cs0246') || text.includes('syntaxerror') || text.includes('compile')) return 'compile';
  return 'unknown';
};

const detectValidationPipeline = (stack, targetDir, verifyCmd, options = {}) => {
  // Keep verification focused on build/compile only.
  return [{ name: 'build', command: verifyCmd }];
};

const shouldPreferScopedEdits = (existingContent, change) => {
  const lineCount = String(existingContent || '').split('\n').length;
  const hasFullContent = change && Object.prototype.hasOwnProperty.call(change, 'content');
  const hasEdits = Array.isArray(change?.edits) && change.edits.length > 0;
  return hasFullContent && !hasEdits && lineCount > 120;
};

module.exports = {
  classifyVerificationError,
  detectValidationPipeline,
  shouldPreferScopedEdits,
};
