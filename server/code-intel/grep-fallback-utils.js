const shellSingleQuote = (str) => `'${String(str).replace(/'/g, `'\\''`)}'`;

module.exports = { shellSingleQuote };
