const path = require('path');
const { syncAllSkillsToDisk } = require('../server/skills-store');
const db = require('../server/db');

async function run() {
  try {
    // Ensure we are in the correct directory for db/skills-store to find their .env
    process.chdir(path.join(__dirname, '../server'));
    
    await db.initDB();
    console.log('DB initialized. Starting full sync...');
    await syncAllSkillsToDisk();
    console.log('Sync completed successfully. You can now commit the files in server/skills/');
    process.exit(0);
  } catch (e) {
    console.error('Sync failed:', e);
    process.exit(1);
  }
}

run();
