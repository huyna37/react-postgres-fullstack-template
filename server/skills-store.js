const fs = require('fs');
const path = require('path');
const db = require('./db');

const SKILL_NAME_RE = /^[\w-]+\.(md|txt)$/i;

const validateFilename = (name) => {
  const s = String(name || '').trim();
  if (!s || !SKILL_NAME_RE.test(s)) {
    return { ok: false, error: 'Filename must match /^[\\w-]+\\.(md|txt)$/i' };
  }
  if (s.includes('..') || s.includes('/') || s.includes('\\')) {
    return { ok: false, error: 'Invalid filename' };
  }
  return { ok: true, filename: s };
};

const labelFromFilename = (filename) =>
  String(filename || '')
    .replace(/\.(md|txt)$/i, '')
    .replace(/[-_]+/g, ' ');

/** Danh sách cho UI /api/skills */
const listSkillsForApi = async () => {
  const r = await db.query(
    `SELECT filename,
            LENGTH(body)::int AS size_chars,
            updated_at
     FROM app_expert_skills
     ORDER BY filename ASC`
  );
  return r.rows.map((row) => ({
    filename: row.filename,
    label: labelFromFilename(row.filename),
    size_chars: row.size_chars,
    updated_at: row.updated_at,
  }));
};

const getSkillRow = async (filename) => {
  const v = validateFilename(filename);
  if (!v.ok) throw new Error(v.error);
  const r = await db.query('SELECT filename, body, updated_at FROM app_expert_skills WHERE filename = $1', [v.filename]);
  if (r.rows.length === 0) throw new Error('Skill not found');
  return r.rows[0];
};

const createSkill = async (filename, content) => {
  const v = validateFilename(filename);
  if (!v.ok) throw new Error(v.error);
  const dup = await db.query('SELECT 1 FROM app_expert_skills WHERE filename = $1', [v.filename]);
  if (dup.rows.length > 0) throw new Error('Skill already exists');
  await db.query(
    `INSERT INTO app_expert_skills (filename, body) VALUES ($1, $2)`,
    [v.filename, String(content ?? '')]
  );
  return v.filename;
};

const updateSkill = async (filename, content) => {
  await getSkillRow(filename);
  const v = validateFilename(filename);
  await db.query(`UPDATE app_expert_skills SET body = $1, updated_at = NOW() WHERE filename = $2`, [
    String(content ?? ''),
    v.filename,
  ]);
  return v.filename;
};

const deleteSkill = async (filename) => {
  const v = validateFilename(filename);
  const r = await db.query('DELETE FROM app_expert_skills WHERE filename = $1 RETURNING filename', [v.filename]);
  if (r.rowCount === 0) throw new Error('Skill not found');
  return v.filename;
};

/** Tập filename có trong DB (để lọc selected_skills). */
const listFilenameSet = async () => {
  const r = await db.query('SELECT filename FROM app_expert_skills');
  return new Set(r.rows.map((x) => x.filename));
};

/**
 * Giống loadProjectSkillsContext cũ: { activeSkillFiles, expertSkills } từ DB.
 * @param {string[]} selectedSkillsRaw
 * @param {{ maxActiveSkills: number, maxSingleSkillChars: number, maxTotalSkillsChars: number }} limits
 */
const loadProjectSkillsFromDb = async (selectedSkillsRaw, limits) => {
  const { maxActiveSkills, maxSingleSkillChars, maxTotalSkillsChars } = limits;
  const available = await listFilenameSet();

  const selectedSkills = Array.isArray(selectedSkillsRaw) ? selectedSkillsRaw : [];
  const deduped = [];
  const seen = new Set();
  for (const s of selectedSkills) {
    const name = String(s || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    deduped.push(name);
  }

  const cap =
    Number.isFinite(maxActiveSkills) && maxActiveSkills > 0 ? Math.floor(maxActiveSkills) : deduped.length;
  const activeSkillFiles = deduped.filter((sf) => available.has(sf)).slice(0, cap);

  if (activeSkillFiles.length === 0) {
    return { activeSkillFiles: [], expertSkills: '' };
  }

  const r = await db.query('SELECT filename, body FROM app_expert_skills WHERE filename = ANY($1::text[])', [
    activeSkillFiles,
  ]);
  const byName = new Map(r.rows.map((row) => [row.filename, row.body]));

  const truncateText = (value, maxChars) => {
    const str = String(value || '');
    if (!maxChars || str.length <= maxChars) return str;
    return `${str.substring(0, maxChars)}\n...[TRUNCATED]`;
  };

  let expertSkills = '';
  let totalChars = 0;
  for (const sf of activeSkillFiles) {
    const raw = byName.get(sf);
    if (raw == null) continue;
    const clipped =
      maxSingleSkillChars === Infinity || !Number.isFinite(maxSingleSkillChars)
        ? raw
        : truncateText(raw, maxSingleSkillChars);
    const section = `\n--- SKILL: ${sf} ---\n${clipped}\n`;
    if (totalChars + section.length > maxTotalSkillsChars) break;
    expertSkills += section;
    totalChars += section.length;
  }

  return { activeSkillFiles, expertSkills };
};

const syncAllSkillsToDisk = async () => {
  const r = await db.query('SELECT filename, body FROM app_expert_skills');
  for (const row of r.rows) {
    syncSkillToDisk(row.filename, row.body);
  }
  console.log(`[SkillsStore] Completed full sync from DB to disk (${r.rowCount} files).`);
};

const syncSkillToDisk = (filename, body) => {
  const v = validateFilename(filename);
  if (!v.ok) return;
  const filePath = path.join(__dirname, 'skills', v.filename);
  try {
    if (!fs.existsSync(path.dirname(filePath))) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(filePath, String(body || ''), 'utf8');
    console.log(`[SkillsStore] Synced to disk: ${v.filename}`);
  } catch (e) {
    console.error(`[SkillsStore] Failed to sync ${v.filename} to disk:`, e.message);
  }
};


module.exports = {
  SKILL_NAME_RE,
  validateFilename,
  labelFromFilename,
  listSkillsForApi,
  getSkillRow,
  createSkill,
  updateSkill,
  deleteSkill,
  listFilenameSet,
  loadProjectSkillsFromDb,
  syncAllSkillsToDisk,
};
