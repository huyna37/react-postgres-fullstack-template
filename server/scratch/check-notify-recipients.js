const db = require('../db');

async function main() {
  const pk = process.argv[2] || 'BXDCSDL';

  const members = await db.query(
    `SELECT j.id, j.username, j.app_role,
            (j.password_hash IS NOT NULL) AS login,
            j.jira_project, j.is_active,
            (SELECT COUNT(*)::int FROM app_push_subscriptions s WHERE s.user_id = j.id) AS push
     FROM jira_users j
     WHERE trim($1) = ANY (
       SELECT trim(x) FROM unnest(string_to_array(COALESCE(j.jira_project, ''), ',')) AS x
     )
     ORDER BY j.id`,
    [pk]
  );

  const recipients = await db.query(
    `SELECT DISTINCT j.id, j.username, j.app_role
     FROM jira_users j
     WHERE trim($1) = ANY (
       SELECT trim(x) FROM unnest(string_to_array(COALESCE(j.jira_project, ''), ',')) AS x
     )
     AND (
       j.password_hash IS NOT NULL
       OR EXISTS (SELECT 1 FROM app_push_subscriptions s WHERE s.user_id = j.id)
     )
     ORDER BY j.id`,
    [pk]
  );

  const admins = await db.query(
    `SELECT id, username, app_role, jira_project,
            (password_hash IS NOT NULL) AS login
     FROM jira_users
     WHERE app_role = 'admin' OR LOWER(username) = 'admin'
     ORDER BY id`
  );

  console.log(`\n=== Project ${pk}: ${members.rows.length} users with jira_project ===`);
  console.table(members.rows);

  console.log(`\n=== Recipients (login OR push): ${recipients.rows.length} ===`);
  console.table(recipients.rows);

  console.log('\n=== Admins ===');
  console.table(admins.rows);

  const recipientIds = new Set(recipients.rows.map(r => r.id));
  const missingAdmins = admins.rows.filter(a => !recipientIds.has(a.id));
  if (missingAdmins.length) {
    console.log('\n=== Admins NOT in recipient list ===');
    console.table(missingAdmins);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
