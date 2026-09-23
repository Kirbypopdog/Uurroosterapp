// #157: de losse migratie-endpoints, uit server.js gehaald. Dit zijn geen
// gewone routes maar eenmalige ingrepen, en ze horen niet tussen de rest.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const bcrypt = require('bcryptjs');
const DEFAULT_RESET_PASSWORD = process.env.DEFAULT_RESET_PASSWORD;

const router = maakRouter();

// Run the merge-employees migration
router.post('/admin/migrate', requireAuth, requireAdmin, async (req, res) => {
  const results = { migrations: [], fixes: [] };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Step 1: Add employee columns to users if not exist
    const columnsToAdd = [
      { name: 'main_team', def: 'TEXT REFERENCES teams(id)' },
      { name: 'extra_teams', def: "TEXT[] DEFAULT '{}'" },
      { name: 'contract_hours', def: 'NUMERIC DEFAULT 0' },
      { name: 'active', def: 'BOOLEAN DEFAULT true' },
      { name: 'week_schedule_week1', def: "JSONB DEFAULT '[]'" },
      { name: 'week_schedule_week2', def: "JSONB DEFAULT '[]'" }
    ];

    for (const col of columnsToAdd) {
      try {
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
        results.migrations.push(`Added column ${col.name} to users`);
      } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }

    // Step 2: Check if employees table exists and migrate data
    const tableCheck = await client.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'employees')
    `);

    if (tableCheck.rows[0].exists) {
      // Copy employee data to users
      const updateResult = await client.query(`
        UPDATE users u
        SET main_team = e.main_team,
            extra_teams = e.extra_teams,
            contract_hours = e.contract_hours,
            active = e.active,
            week_schedule_week1 = e.week_schedule_week1,
            week_schedule_week2 = e.week_schedule_week2
        FROM employees e
        WHERE LOWER(u.email) = LOWER(e.email)
        RETURNING u.id
      `);
      results.migrations.push(`Updated ${updateResult.rowCount} users with employee data`);

      // Create users for employees without accounts
      const passwordHash = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12);
      const createResult = await client.query(`
        INSERT INTO users (name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
        SELECT e.name, LOWER(e.email), $1, 'medewerker', e.main_team, e.main_team, e.extra_teams, e.contract_hours, e.active, e.week_schedule_week1, e.week_schedule_week2
        FROM employees e
        WHERE e.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(e.email))
        RETURNING id
      `, [passwordHash]);
      results.migrations.push(`Created ${createResult.rowCount} new user accounts from employees`);

      // Build employee_id to user_id mapping
      const mappings = await client.query(`
        SELECT e.id as employee_id, u.id as user_id
        FROM employees e
        JOIN users u ON LOWER(u.email) = LOWER(e.email)
      `);
      const empToUserMap = new Map(mappings.rows.map(r => [r.employee_id, r.user_id]));
      results.migrations.push(`Mapped ${empToUserMap.size} employees to users`);

      // Step 3: Migrate shifts table
      const shiftsColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'employee_id'
      `);

      if (shiftsColCheck.rows.length > 0) {
        // Add user_id column
        await client.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_id INTEGER');

        // Update user_id based on employee_id mapping
        for (const [empId, userId] of empToUserMap) {
          await client.query('UPDATE shifts SET user_id = $1 WHERE employee_id = $2', [userId, empId]);
        }

        // Drop old constraint and column
        await client.query('ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_employee_id_fkey');
        await client.query('ALTER TABLE shifts DROP COLUMN IF EXISTS employee_id');

        // Add new constraint
        await client.query('ALTER TABLE shifts ADD CONSTRAINT shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

        results.migrations.push('Migrated shifts table to use user_id');
      }

      // Step 4: Migrate availability table
      const availColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'availability' AND column_name = 'employee_id'
      `);

      if (availColCheck.rows.length > 0) {
        // Add user_id column
        await client.query('ALTER TABLE availability ADD COLUMN IF NOT EXISTS user_id INTEGER');

        // Update user_id based on employee_id mapping
        for (const [empId, userId] of empToUserMap) {
          await client.query('UPDATE availability SET user_id = $1 WHERE employee_id = $2', [userId, empId]);
        }

        // Drop old constraints and column
        await client.query('ALTER TABLE availability DROP CONSTRAINT IF EXISTS availability_employee_id_fkey');
        await client.query('ALTER TABLE availability DROP CONSTRAINT IF EXISTS availability_employee_id_date_key');
        await client.query('ALTER TABLE availability DROP COLUMN IF EXISTS employee_id');

        // Add new constraints
        await client.query('ALTER TABLE availability ADD CONSTRAINT availability_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
        await client.query('ALTER TABLE availability ADD CONSTRAINT availability_user_id_date_key UNIQUE(user_id, date)');

        results.migrations.push('Migrated availability table to use user_id');
      }

      // Step 5: Drop employees table
      await client.query('DROP TABLE IF EXISTS employees CASCADE');
      results.migrations.push('Dropped employees table');
    } else {
      results.migrations.push('Employees table does not exist, may have been migrated already');
    }

    // Step 6: Fix double-serialized JSONB data
    const usersToFix = await client.query('SELECT id, week_schedule_week1, week_schedule_week2 FROM users');
    let fixedCount = 0;

    for (const user of usersToFix.rows) {
      let week1 = user.week_schedule_week1;
      let week2 = user.week_schedule_week2;
      let needsUpdate = false;

      if (typeof week1 === 'string') {
        try { week1 = JSON.parse(week1); needsUpdate = true; } catch (e) { week1 = []; }
      }
      if (typeof week2 === 'string') {
        try { week2 = JSON.parse(week2); needsUpdate = true; } catch (e) { week2 = []; }
      }

      if (needsUpdate) {
        await client.query(
          'UPDATE users SET week_schedule_week1 = $1, week_schedule_week2 = $2 WHERE id = $3',
          [week1, week2, user.id]
        );
        fixedCount++;
      }
    }

    if (fixedCount > 0) {
      results.fixes.push(`Fixed weekSchedule data for ${fixedCount} users`);
    }

    // Step 7: Sync team_id with main_team for all users
    const teamSyncResult = await client.query(`
      UPDATE users
      SET team_id = main_team
      WHERE team_id IS NULL OR team_id != main_team OR (team_id IS NOT NULL AND main_team IS NULL)
      RETURNING id
    `);
    if (teamSyncResult.rowCount > 0) {
      results.fixes.push(`Synced team_id with main_team for ${teamSyncResult.rowCount} users`);
    }

    await client.query('COMMIT');
    results.migrations.push('✅ Migration completed successfully!');
    await logAudit(req, 'MIGRATE', 'system', '', { migrations: results.migrations, fixes: results.fixes });

    res.json({ ok: true, results });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed' });
  } finally {
    client.release();
  }
});

// Seed teams endpoint (admin only)
router.post('/admin/seed-teams', requireAuth, requireAdmin, async (req, res) => {
  const teams = [
    { id: 'vlot1', name: 'Vlot 1 (Begeleiding)', color: '#4a7c6f' },
    { id: 'vlot2', name: 'Vlot 2 (Begeleiding)', color: '#c08a4a' },
    { id: 'cargo', name: 'Cargo (Dagbesteding)', color: '#5b7fa6' },
    { id: 'overkoepelend', name: 'Overkoepelend (Kantoor)', color: '#9a6a9e' },
    { id: 'jobstudent', name: 'Jobstudenten/Stagiairs', color: '#b9656a' }
  ];

  try {
    let created = 0;
    let updated = 0;
    for (const team of teams) {
      const result = await pool.query(
        `INSERT INTO teams (id, name, color)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color
         RETURNING (xmax = 0) as inserted`,
        [team.id, team.name, team.color]
      );
      if (result.rows[0].inserted) created++;
      else updated++;
    }
    await logAudit(req, 'CREATE', 'system', '', { action: 'seed_teams', created, updated, total: teams.length });
    res.json({ ok: true, created, updated, total: teams.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
