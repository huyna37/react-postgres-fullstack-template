const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { DEFAULT_PUBLIC_PAGES } = require('./public-pages');
const { DEFAULT_PERMISSIONS, localAccountId } = require('./lib/jiraUserAuth');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DEFAULT_PERMISSIONS_JSON = JSON.stringify(DEFAULT_PERMISSIONS);

async function ensureJiraUsersIdConstraint(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'jira_users_id_seq') THEN
        CREATE SEQUENCE jira_users_id_seq;
      END IF;
    END $$;
  `);

  await client.query(`
    UPDATE jira_users
    SET id = nextval('jira_users_id_seq')
    WHERE id IS NULL
  `);

  await client.query(`
    WITH ranked AS (
      SELECT account_id,
             ROW_NUMBER() OVER (PARTITION BY id ORDER BY account_id) AS rn
      FROM jira_users
      WHERE id IS NOT NULL
    )
    UPDATE jira_users ju
    SET id = nextval('jira_users_id_seq')
    FROM ranked r
    WHERE ju.account_id = r.account_id
      AND r.rn > 1
  `);

  await client.query(`
    SELECT setval(
      'jira_users_id_seq',
      GREATEST(COALESCE((SELECT MAX(id) FROM jira_users), 0), 1)
    )
  `);

  await client.query(`DROP INDEX IF EXISTS idx_jira_users_id`);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'jira_users_id_key'
      ) THEN
        ALTER TABLE jira_users ADD CONSTRAINT jira_users_id_key UNIQUE (id);
      END IF;
    END $$;
  `);

  await client.query(`
    ALTER TABLE jira_users
    ALTER COLUMN id SET DEFAULT nextval('jira_users_id_seq')
  `);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'jira_users' AND column_name = 'id' AND is_nullable = 'NO'
      ) THEN
        ALTER TABLE jira_users ALTER COLUMN id SET NOT NULL;
      END IF;
    END $$;
  `);
}

async function migrateAppAccountsToJiraUsers(client) {
  const tableCheck = await client.query(`SELECT to_regclass('public.app_accounts') AS tbl`);
  if (!tableCheck.rows[0]?.tbl) return;

  console.log('Migrating app_accounts → jira_users...');
  const accountsRes = await client.query('SELECT * FROM app_accounts ORDER BY id ASC');
  const usedIds = new Set(
    (await client.query(`SELECT id FROM jira_users WHERE id IS NOT NULL`)).rows.map(r => r.id)
  );

  for (const aa of accountsRes.rows) {
    const username = String(aa.username || '').trim();
    if (!username) continue;

    const matchRes = await client.query(
      `SELECT account_id, id
       FROM jira_users
       WHERE LOWER(TRIM(COALESCE(email_address, ''))) = LOWER($1)
          OR LOWER(TRIM(COALESCE(username, ''))) = LOWER($1)
       ORDER BY CASE WHEN password_hash IS NOT NULL THEN 0 ELSE 1 END
       LIMIT 1`,
      [username]
    );

    const targetId = usedIds.has(aa.id) ? null : aa.id;

    if (matchRes.rows.length > 0) {
      const { account_id: accountId, id: existingId } = matchRes.rows[0];
      const mergedId = targetId ?? existingId;
      if (mergedId != null) usedIds.add(mergedId);

      await client.query(
        `UPDATE jira_users SET
          id = COALESCE($1, id),
          username = $2,
          password_hash = $3,
          app_role = $4,
          permissions = COALESCE($5, permissions),
          jira_token = COALESCE($6, jira_token),
          jira_project = COALESCE(NULLIF($7, ''), jira_project),
          theme_preference = COALESCE($8, theme_preference),
          is_active = true,
          updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $9`,
        [
          targetId,
          username,
          aa.password_hash,
          aa.role || 'user',
          aa.permissions || DEFAULT_PERMISSIONS_JSON,
          aa.jira_token,
          aa.jira_project,
          aa.theme_preference,
          accountId,
        ]
      );

      if (targetId != null && existingId != null && targetId !== existingId) {
        const remapFk = async (table, column) => {
          const exists = await client.query(`SELECT to_regclass($1) AS tbl`, [`public.${table}`]);
          if (!exists.rows[0]?.tbl) return;
          await client.query(`UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`, [
            targetId,
            aa.id,
          ]);
        };
        await remapFk('cron_worklogs', 'user_id');
        await remapFk('app_push_subscriptions', 'user_id');
        await remapFk('app_broadcast_notifications', 'created_by');
      }
      continue;
    }

    const insertId = targetId;
    if (insertId != null) usedIds.add(insertId);

    await client.query(
      `INSERT INTO jira_users (
        id, account_id, display_name, email_address, username, password_hash, app_role,
        permissions, jira_token, jira_project, theme_preference, is_active
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true
      )
      ON CONFLICT (account_id) DO UPDATE SET
        id = COALESCE(EXCLUDED.id, jira_users.id),
        username = EXCLUDED.username,
        password_hash = EXCLUDED.password_hash,
        app_role = EXCLUDED.app_role,
        permissions = EXCLUDED.permissions,
        jira_token = COALESCE(EXCLUDED.jira_token, jira_users.jira_token),
        jira_project = COALESCE(EXCLUDED.jira_project, jira_users.jira_project),
        theme_preference = COALESCE(EXCLUDED.theme_preference, jira_users.theme_preference),
        updated_at = CURRENT_TIMESTAMP`,
      [
        insertId,
        localAccountId(username),
        username,
        username.includes('@') ? username : null,
        username,
        aa.password_hash,
        aa.role || 'user',
        aa.permissions || DEFAULT_PERMISSIONS_JSON,
        aa.jira_token,
        aa.jira_project,
        aa.theme_preference,
      ]
    );
  }

  await ensureJiraUsersIdConstraint(client);

  const rebindFk = async (table, constraint, column, onDelete = '') => {
    const exists = await client.query(`SELECT to_regclass($1) AS tbl`, [`public.${table}`]);
    if (!exists.rows[0]?.tbl) return;
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = '${constraint}'
            AND table_name = '${table}'
        ) THEN
          ALTER TABLE ${table} DROP CONSTRAINT ${constraint};
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = '${constraint}'
            AND table_name = '${table}'
        ) THEN
          ALTER TABLE ${table}
            ADD CONSTRAINT ${constraint}
            FOREIGN KEY (${column}) REFERENCES jira_users(id)${onDelete ? ` ${onDelete}` : ''};
        END IF;
      END $$;
    `);
  };

  await rebindFk('cron_worklogs', 'cron_worklogs_user_id_fkey', 'user_id');
  await rebindFk('app_push_subscriptions', 'app_push_subscriptions_user_id_fkey', 'user_id', 'ON DELETE CASCADE');
  await rebindFk('app_broadcast_notifications', 'app_broadcast_notifications_created_by_fkey', 'created_by');

  await client.query('DROP TABLE IF EXISTS app_accounts');
  console.log('app_accounts merged into jira_users and dropped.');
}

async function ensurePerformanceIndexes(client) {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_jira_users_email_lower
      ON jira_users (LOWER(TRIM(COALESCE(email_address, ''))))
      WHERE email_address IS NOT NULL AND TRIM(email_address) <> '';

    CREATE INDEX IF NOT EXISTS idx_jira_users_active_sort
      ON jira_users (sort_order DESC, display_name)
      WHERE is_active = true;

    CREATE INDEX IF NOT EXISTS idx_jira_users_jira_project_gin
      ON jira_users USING gin (string_to_array(TRIM(COALESCE(jira_project, '')), ','))
      WHERE jira_project IS NOT NULL AND TRIM(jira_project) <> '';

    CREATE INDEX IF NOT EXISTS idx_jira_issues_project_key
      ON jira_issues (project_key, key);

    CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_status_updated
      ON jira_issues (project_key, status, updated_at DESC)
      WHERE status IS NOT NULL AND TRIM(status) <> '';

    CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_parent_subtask
      ON jira_issues (project_key, parent_key, key)
      WHERE is_subtask = true AND parent_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_jira_issues_open_overdue
      ON jira_issues (project_key, due_date, assignee_account_id)
      WHERE assignee_account_id IS NOT NULL
        AND COALESCE(LOWER(status_category), '') <> 'done'
        AND LOWER(COALESCE(status, '')) NOT IN ('done', 'closed', 'resolved');

    CREATE INDEX IF NOT EXISTS idx_jira_issues_missing_estimate
      ON jira_issues (project_key, due_date, key)
      WHERE (original_estimate IS NULL OR original_estimate = 0)
        AND assignee_account_id IS NOT NULL
        AND TRIM(assignee_account_id) <> '';

    CREATE INDEX IF NOT EXISTS idx_jira_issues_key_trgm
      ON jira_issues USING gin (key gin_trgm_ops);

    CREATE INDEX IF NOT EXISTS idx_jira_issues_summary_trgm
      ON jira_issues USING gin (summary gin_trgm_ops);

    CREATE INDEX IF NOT EXISTS idx_jira_issues_status_trgm
      ON jira_issues USING gin (status gin_trgm_ops);

    CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_assignee_email
      ON jira_issues (project_key, LOWER(TRIM(assignee_account_id)))
      WHERE assignee_account_id IS NOT NULL AND TRIM(assignee_account_id) <> '';

    CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_subtask_plan_dates
      ON jira_issues (project_key, start_date, due_date, created_at)
      WHERE is_subtask = true;

    CREATE INDEX IF NOT EXISTS idx_jira_worklog_entries_issue_started
      ON jira_worklog_entries (issue_key, started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_cron_worklogs_pending
      ON cron_worklogs (status, scheduled_at)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_cron_worklogs_user_created
      ON cron_worklogs (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_app_push_subscriptions_user
      ON app_push_subscriptions (user_id);
  `);
}

async function backfillJiraWorklogEntries(client) {
  const countRes = await client.query('SELECT COUNT(*)::bigint AS c FROM jira_worklog_entries');
  if (Number(countRes.rows[0]?.c || 0) > 0) return;

  console.log('Backfilling jira_worklog_entries from raw_data (one-time)...');
  const insertRes = await client.query(`
    INSERT INTO jira_worklog_entries (
      id, issue_key, project_key, author_account_id, author_email,
      started_at, time_spent_seconds, time_spent, comment
    )
    SELECT
      wl.value->>'id',
      i.key,
      i.project_key,
      COALESCE(wl.value->'author'->>'accountId', wl.value->'author'->>'name', wl.value->'author'->>'key'),
      NULLIF(LOWER(TRIM(COALESCE(wl.value->'author'->>'emailAddress', ''))), ''),
      (wl.value->>'started')::timestamptz,
      COALESCE((wl.value->>'timeSpentSeconds')::int, 0),
      wl.value->>'timeSpent',
      wl.value->'comment'
    FROM jira_issues i
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(i.raw_data->'worklog'->'worklogs') = 'array'
        THEN i.raw_data->'worklog'->'worklogs'
        ELSE '[]'::jsonb
      END
    ) AS wl(value)
    WHERE (wl.value->>'id') IS NOT NULL
      AND (wl.value->>'started') IS NOT NULL
    ON CONFLICT (issue_key, id) DO NOTHING
  `);
  console.log(`jira_worklog_entries backfill: ${insertRes.rowCount || 0} row(s).`);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'postgres',
});

// Kiểm tra kết nối và tạo bảng nếu chưa có
const initDB = async (retries = 5) => {
  while (retries > 0) {
    try {
      const client = await pool.connect();
      console.log('Connected to PostgreSQL Database.');
      
      console.log('Initializing tables...');
      
      // Tạo bảng quản lý người dùng Jira
      await client.query(`
        CREATE TABLE IF NOT EXISTS jira_users (
          account_id VARCHAR(255) PRIMARY KEY,
          display_name VARCHAR(255) NOT NULL,
          email_address VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          role VARCHAR(50) DEFAULT 'developer',
          avatar_url VARCHAR(500),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      
      // Migration: Thêm cột role nếu chưa có
      await client.query(`
        DO $$ 
        BEGIN 
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='role') THEN
            ALTER TABLE jira_users ADD COLUMN role VARCHAR(50) DEFAULT 'developer';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='jira_project') THEN
            ALTER TABLE jira_users ADD COLUMN jira_project VARCHAR(255);
          ELSE
            ALTER TABLE jira_users ALTER COLUMN jira_project TYPE VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='avatar_url') THEN
            ALTER TABLE jira_users ADD COLUMN avatar_url VARCHAR(500);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='sort_order') THEN
            ALTER TABLE jira_users ADD COLUMN sort_order INTEGER DEFAULT 0;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='id') THEN
            ALTER TABLE jira_users ADD COLUMN id INTEGER;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='username') THEN
            ALTER TABLE jira_users ADD COLUMN username VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='password_hash') THEN
            ALTER TABLE jira_users ADD COLUMN password_hash VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='app_role') THEN
            ALTER TABLE jira_users ADD COLUMN app_role VARCHAR(50);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='permissions') THEN
            ALTER TABLE jira_users ADD COLUMN permissions TEXT DEFAULT '${DEFAULT_PERMISSIONS_JSON.replace(/'/g, "''")}';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='jira_token') THEN
            ALTER TABLE jira_users ADD COLUMN jira_token VARCHAR(255);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_users' AND column_name='theme_preference') THEN
            ALTER TABLE jira_users ADD COLUMN theme_preference VARCHAR(10);
          END IF;
        END $$;
      `);

      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_jira_users_username ON jira_users(username) WHERE username IS NOT NULL;
      `);

      await ensureJiraUsersIdConstraint(client);
      await migrateAppAccountsToJiraUsers(client);
      await ensureJiraUsersIdConstraint(client);
      console.log('Table "jira_users" ready (auth merged).');

    // Tạo bảng quản lý dự án (Projects Mapping)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_projects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        jira_key VARCHAR(50) UNIQUE NOT NULL,
        git_url TEXT,
        git_user VARCHAR(255),
        git_password TEXT,
        local_path TEXT,
        base_branch VARCHAR(100) DEFAULT 'main',
        stack VARCHAR(50),
        selected_skills JSONB DEFAULT '[]'::jsonb,
        cloned_initialized BOOLEAN DEFAULT false,
        last_cloned_at TIMESTAMP,
        pulled_initialized BOOLEAN DEFAULT false,
        last_pulled_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='git_user') THEN
          ALTER TABLE app_projects ADD COLUMN git_user VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='git_password') THEN
          ALTER TABLE app_projects ADD COLUMN git_password TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='selected_skills') THEN
          ALTER TABLE app_projects ADD COLUMN selected_skills JSONB DEFAULT '[]'::jsonb;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='cloned_initialized') THEN
          ALTER TABLE app_projects ADD COLUMN cloned_initialized BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='last_cloned_at') THEN
          ALTER TABLE app_projects ADD COLUMN last_cloned_at TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='pulled_initialized') THEN
          ALTER TABLE app_projects ADD COLUMN pulled_initialized BOOLEAN DEFAULT false;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='last_pulled_at') THEN
          ALTER TABLE app_projects ADD COLUMN last_pulled_at TIMESTAMP;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_projects' AND column_name='ai_project_memory') THEN
          ALTER TABLE app_projects ADD COLUMN ai_project_memory JSONB DEFAULT '[]'::jsonb;
        END IF;
      END $$;
    `);
    console.log('Table "app_projects" ready.');

    // Insert default project if not exists
    const projectCheck = await client.query(`SELECT id FROM app_projects WHERE jira_key = 'BXDCSDL'`);
    if (projectCheck.rows.length === 0) {
      await client.query(
        `INSERT INTO app_projects (name, jira_key, git_url, local_path, stack) VALUES ($1, $2, $3, $4, $5)`,
        ['BXH CSDl', 'BXDCSDL', 'https://git.etc.vn/etc/ttdvcn/csdldb/mefobase-core', '/app/repos/mefobase-core', 'polyglot']
      );
      console.log('Default project "BXH CSDl" inserted.');
    }

    // Tạo bảng cache Jira issues
    await client.query(`
      CREATE TABLE IF NOT EXISTS jira_issues (
        key VARCHAR(50) PRIMARY KEY,
        project_key VARCHAR(50) NOT NULL,
        parent_key VARCHAR(50),
        summary TEXT NOT NULL,
        status VARCHAR(100),
        status_category VARCHAR(50),
        issue_type VARCHAR(50),
        is_subtask BOOLEAN DEFAULT false,
        assignee_name VARCHAR(255),
        assignee_role VARCHAR(50),
        creator VARCHAR(255),
        start_date DATE,
        due_date DATE,
        created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        time_spent INT DEFAULT 0,
        original_estimate INT DEFAULT 0,
        description TEXT,
        raw_data JSONB,
        assignee_account_id VARCHAR(255),
        creator_email VARCHAR(255)
      );
      
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='resolved_at') THEN
          ALTER TABLE jira_issues ADD COLUMN resolved_at TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='assignee_account_id') THEN
          ALTER TABLE jira_issues ADD COLUMN assignee_account_id VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='creator_email') THEN
          ALTER TABLE jira_issues ADD COLUMN creator_email VARCHAR(255);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='output') THEN
          ALTER TABLE jira_issues ADD COLUMN output TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='comments') THEN
          ALTER TABLE jira_issues ADD COLUMN comments JSONB NOT NULL DEFAULT '[]'::jsonb;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='remaining_estimate') THEN
          ALTER TABLE jira_issues ADD COLUMN remaining_estimate INT DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='jira_issues' AND column_name='attachments') THEN
          ALTER TABLE jira_issues ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
        END IF;
      END $$;

      -- Một lần di chuyển dữ liệu: sao chép updated_at vào resolved_at cho các issue cũ đã hoàn thành
      UPDATE jira_issues
      SET resolved_at = updated_at
      WHERE resolved_at IS NULL AND (
        LOWER(status_category) = 'done'
        OR LOWER(status) LIKE '%resolved%'
        OR LOWER(status) LIKE '%closed%'
        OR LOWER(status) = 'close'
        OR LOWER(status) LIKE '%đóng%'
        OR LOWER(status) LIKE '%dong%'
        OR LOWER(status) LIKE '%done%'
        OR LOWER(status) LIKE '%hoàn thành%'
        OR LOWER(status) LIKE '%hoan thanh%'
        OR LOWER(status) LIKE '%complete%'
      );

      UPDATE jira_issues
      SET output = COALESCE(NULLIF(TRIM(output), ''), NULLIF(TRIM(raw_data->>'output'), ''))
      WHERE (output IS NULL OR TRIM(output) = '')
        AND raw_data->>'output' IS NOT NULL
        AND TRIM(raw_data->>'output') <> '';

      UPDATE jira_issues
      SET comments = raw_data->'comments'
      WHERE (comments IS NULL OR comments = '[]'::jsonb)
        AND jsonb_typeof(raw_data->'comments') = 'array'
        AND jsonb_array_length(raw_data->'comments') > 0;

      CREATE INDEX IF NOT EXISTS idx_jira_issues_project_dates ON jira_issues (project_key, updated_at, start_date, due_date, created_at);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_parent ON jira_issues (parent_key);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_project_assignee ON jira_issues (project_key, assignee_name);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_status ON jira_issues (status);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_is_subtask ON jira_issues (is_subtask);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_summary ON jira_issues (summary);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_assignee_id ON jira_issues (assignee_account_id);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_due_date ON jira_issues (project_key, due_date);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_updated ON jira_issues (project_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_jira_issues_proj_created ON jira_issues (project_key, created_at);
    `);
    console.log('Table "jira_issues" ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS jira_worklog_entries (
        id VARCHAR(64) NOT NULL,
        issue_key VARCHAR(50) NOT NULL REFERENCES jira_issues(key) ON DELETE CASCADE,
        project_key VARCHAR(50) NOT NULL,
        author_account_id VARCHAR(255),
        author_email VARCHAR(255),
        started_at TIMESTAMPTZ NOT NULL,
        time_spent_seconds INT DEFAULT 0,
        time_spent VARCHAR(50),
        comment JSONB,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (issue_key, id)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jira_worklog_entries_started
        ON jira_worklog_entries (started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_jira_worklog_entries_author_started
        ON jira_worklog_entries (author_account_id, started_at DESC)
        WHERE author_account_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_jira_worklog_entries_email_started
        ON jira_worklog_entries (LOWER(author_email), started_at DESC)
        WHERE author_email IS NOT NULL AND TRIM(author_email) <> '';

      CREATE INDEX IF NOT EXISTS idx_jira_worklog_entries_project_started
        ON jira_worklog_entries (project_key, started_at DESC);
    `);
    console.log('Table "jira_worklog_entries" ready.');
    await backfillJiraWorklogEntries(client);

    // Kiểm tra và tạo tài khoản admin mặc định nếu chưa có
    const adminCheck = await client.query(
      `SELECT id FROM jira_users WHERE LOWER(username) = 'admin' AND password_hash IS NOT NULL`
    );
    if (adminCheck.rows.length === 0) {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash('admin', salt);
      await client.query(
        `INSERT INTO jira_users (
          account_id, display_name, username, password_hash, app_role, permissions, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, true)
        ON CONFLICT (account_id) DO UPDATE SET
          username = EXCLUDED.username,
          password_hash = EXCLUDED.password_hash,
          app_role = EXCLUDED.app_role,
          permissions = EXCLUDED.permissions,
          is_active = true,
          updated_at = CURRENT_TIMESTAMP`,
        [localAccountId('admin'), 'admin', 'admin', hash, 'admin', DEFAULT_PERMISSIONS_JSON]
      );
      console.log('Default admin account created (admin/admin)');
    }

    // Tạo bảng quản lý cron worklogs
    await client.query(`
      CREATE TABLE IF NOT EXISTS cron_worklogs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES jira_users(id),
        issue_key VARCHAR(255) NOT NULL,
        time_spent VARCHAR(50) NOT NULL,
        comment TEXT,
        scheduled_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Table "cron_worklogs" ready.');

    // Tạo bảng quản lý AI Fixes
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_ai_fixes (
        id SERIAL PRIMARY KEY,
        ticket_key VARCHAR(50) NOT NULL,
        project_id INTEGER REFERENCES app_projects(id),
        status VARCHAR(20) DEFAULT 'in_progress',
        current_step TEXT,
        log TEXT,
        branch_name TEXT,
        reasoning TEXT,
        changes JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration for existing table
    await client.query(`
      DO $$ 
      BEGIN 
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_ai_fixes' AND column_name='reasoning') THEN
          ALTER TABLE app_ai_fixes ADD COLUMN reasoning TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_ai_fixes' AND column_name='changes') THEN
          ALTER TABLE app_ai_fixes ADD COLUMN changes JSONB;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_ai_fixes' AND column_name='plan') THEN
          ALTER TABLE app_ai_fixes ADD COLUMN plan JSONB;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_ai_fixes' AND column_name='additional_context') THEN
          ALTER TABLE app_ai_fixes ADD COLUMN additional_context TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_ai_fixes' AND column_name='ticket_summary') THEN
          ALTER TABLE app_ai_fixes ADD COLUMN ticket_summary TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_ai_fixes' AND column_name='ticket_description') THEN
          ALTER TABLE app_ai_fixes ADD COLUMN ticket_description TEXT;
        END IF;
      END $$;
    `);
    console.log('Table "app_ai_fixes" ready and migrated.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_expert_skills (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        body TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Table "app_expert_skills" ready.');

    // Cài đặt hệ thống (trang công khai, ...)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(255) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const publicPagesJson = JSON.stringify(DEFAULT_PUBLIC_PAGES);
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      ['public_pages', publicPagesJson]
    );
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      ['default_theme', JSON.stringify('dark')]
    );
    console.log('Table "app_settings" ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS jira_workflow_status (
        project_key VARCHAR(64) NOT NULL,
        status_name VARCHAR(255) NOT NULL,
        sample_issue_key VARCHAR(64),
        transitions JSONB NOT NULL DEFAULT '[]'::jsonb,
        sync_error TEXT,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_key, status_name)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_jira_workflow_status_project
      ON jira_workflow_status (project_key);
    `);

    const legacyWorkflow = await client.query(
      `SELECT key, value FROM app_settings WHERE key LIKE 'jira_workflow_cache:%'`
    );
    for (const row of legacyWorkflow.rows) {
      const projectKey = row.key.slice('jira_workflow_cache:'.length);
      const payload = row.value || {};
      const statuses = payload.statuses || {};
      const syncedAt = payload.syncedAt || new Date().toISOString();
      const errors = Array.isArray(payload.errors) ? payload.errors : [];

      for (const [statusName, transitions] of Object.entries(statuses)) {
        await client.query(
          `INSERT INTO jira_workflow_status (project_key, status_name, transitions, synced_at, sync_error, updated_at)
           VALUES ($1, $2, $3::jsonb, $4::timestamptz, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT (project_key, status_name) DO NOTHING`,
          [projectKey, statusName, JSON.stringify(transitions), syncedAt]
        );
      }
      for (const err of errors) {
        if (!err?.status) continue;
        await client.query(
          `INSERT INTO jira_workflow_status (project_key, status_name, sample_issue_key, transitions, synced_at, sync_error, updated_at)
           VALUES ($1, $2, $3, '[]'::jsonb, $4::timestamptz, $5, CURRENT_TIMESTAMP)
           ON CONFLICT (project_key, status_name) DO UPDATE SET
             sample_issue_key = COALESCE(EXCLUDED.sample_issue_key, jira_workflow_status.sample_issue_key),
             sync_error = EXCLUDED.sync_error,
             synced_at = EXCLUDED.synced_at,
             updated_at = CURRENT_TIMESTAMP`,
          [projectKey, err.status, err.sampleKey || null, syncedAt, err.error || null]
        );
      }
    }
    if (legacyWorkflow.rows.length > 0) {
      await client.query(`DELETE FROM app_settings WHERE key LIKE 'jira_workflow_cache:%'`);
      console.log(
        `Table "jira_workflow_status" ready (migrated ${legacyWorkflow.rows.length} project cache(s) from app_settings).`
      );
    } else {
      console.log('Table "jira_workflow_status" ready.');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_broadcast_notifications (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        created_by INTEGER REFERENCES jira_users(id),
        recipient_ids JSONB DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'app_broadcast_notifications' AND column_name = 'recipient_ids'
        ) THEN
          ALTER TABLE app_broadcast_notifications ADD COLUMN recipient_ids JSONB DEFAULT NULL;
        END IF;
      END $$;
    `);
    console.log('Table "app_broadcast_notifications" ready.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES jira_users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        auth TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, endpoint)
      );
    `);
    console.log('Table "app_push_subscriptions" ready.');

    const skillCountRes = await client.query('SELECT COUNT(*)::int AS c FROM app_expert_skills');
    if (skillCountRes.rows[0].c === 0) {
      const seedDir = path.join(__dirname, 'skills');
      if (fs.existsSync(seedDir)) {
        let n = 0;
        for (const f of fs.readdirSync(seedDir)) {
          if (!/^[\w-]+\.(md|txt)$/i.test(f)) continue;
          try {
            const body = fs.readFileSync(path.join(seedDir, f), 'utf8');
            await client.query(
              `INSERT INTO app_expert_skills (filename, body) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING`,
              [f, body]
            );
            n += 1;
          } catch {
            /* skip bad file */
          }
        }
        if (n > 0) console.log(`Seeded app_expert_skills: ${n} file(s) from server/skills/`);
      }
    }
    
    await ensurePerformanceIndexes(client);
    console.log('Performance indexes ready.');

    console.log('All tables are ready.');
    client.release();
    return;
    } catch (error) {
      retries -= 1;
      console.error(`Error connecting to PostgreSQL (Retries left: ${retries}):`, error.message);
      if (retries === 0) throw error;
      // Đợi 5 giây trước khi thử lại
      await new Promise(res => setTimeout(res, 5000));
    }
  }
};

module.exports = {
  query: (text, params) => pool.query(text, params),
  initDB
};
