const fs = require('fs');
const file = 'd:/Csdl/jira-agent/server/routes/planning.js';
let content = fs.readFileSync(file, 'utf8');
content = content.replace(/httpsAgent\r?\n\s*\}\);/g, 'httpsAgent,\n          timeout: 600000\n        });');
fs.writeFileSync(file, content);
console.log('Updated routes/planning.js');
