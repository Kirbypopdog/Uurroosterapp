const fs = require('fs');
const bcrypt = require('bcryptjs');
const { pool } = require('./src/db');

async function importBackup() {
  const client = await pool.connect();

  try {
    // Read backup file
    const backupPath = process.argv[2];
    if (!backupPath) {
      console.error('❌ ERROR: Geef het pad naar het backup bestand mee als argument.');
      console.error('Gebruik: node import-backup.js /pad/naar/backup.json');
      process.exit(1);
    }
    console.log(`Reading backup from: ${backupPath}`);

    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

    await client.query('BEGIN');

    // Clear existing data (except shift_swap_requests)
    console.log('Clearing existing data...');
    await client.query('DELETE FROM availability');
    await client.query('DELETE FROM shifts');
    await client.query('DELETE FROM users WHERE id > 1'); // Keep admin

    // Reset sequences
    await client.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
    await client.query("SELECT setval('shifts_id_seq', 1, false)");

    // Generate default password hash for imported users
    const importPassword = process.env.DEFAULT_RESET_PASSWORD;
    if (!importPassword) {
      console.error('❌ ERROR: DEFAULT_RESET_PASSWORD env var is niet ingesteld.');
      process.exit(1);
    }
    const defaultPasswordHash = await bcrypt.hash(importPassword, 12);

    // Import users
    console.log(`Importing ${backup.users.length} users...`);
    console.log('ℹ️  Alle geïmporteerde users krijgen het wachtwoord uit DEFAULT_RESET_PASSWORD.');
    for (const user of backup.users) {
      await client.query(`
        INSERT INTO users (id, name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (email) DO UPDATE SET
          name = EXCLUDED.name,
          password_hash = EXCLUDED.password_hash,
          role = EXCLUDED.role,
          team_id = EXCLUDED.team_id,
          main_team = EXCLUDED.main_team,
          extra_teams = EXCLUDED.extra_teams,
          contract_hours = EXCLUDED.contract_hours,
          active = EXCLUDED.active,
          week_schedule_week1 = EXCLUDED.week_schedule_week1,
          week_schedule_week2 = EXCLUDED.week_schedule_week2
      `, [
        user.id,
        user.name,
        user.email,
        defaultPasswordHash,
        user.role,
        user.team_id || user.mainTeam,
        user.mainTeam,
        user.extraTeams || [],
        user.contractHours || 0,
        user.active !== false,
        JSON.stringify(user.weekScheduleWeek1 || []),
        JSON.stringify(user.weekScheduleWeek2 || [])
      ]);
    }

    // Import shifts
    console.log(`Importing ${backup.shifts.length} shifts...`);
    for (const shift of backup.shifts) {
      await client.query(`
        INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        shift.userId || shift.employeeId,
        shift.team || shift.teamId,
        shift.date,
        shift.startTime,
        shift.endTime,
        shift.notes || '',
        shift.source || 'manual',
        shift.createdAt || new Date()
      ]);
    }

    // Import availability
    if (backup.availability && backup.availability.length > 0) {
      console.log(`Importing ${backup.availability.length} availability records...`);
      for (const avail of backup.availability) {
        // #206: hier stond `notes`, maar die kolom bestaat niet op
        // availability. Het is `reason`. Elke backup met afwezigheid erin
        // liep hier stuk op "column notes of relation availability does not
        // exist", dus er was geen enkele werkende weg terug.
        // `avail.notes` blijft aanvaard voor oudere backupbestanden.
        await client.query(`
          INSERT INTO availability (user_id, date, type, reason)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (user_id, date) DO UPDATE SET
            type = EXCLUDED.type,
            reason = EXCLUDED.reason
        `, [
          avail.userId || avail.employeeId,
          avail.date,
          avail.type,
          avail.reason || avail.notes || ''
        ]);
      }
    }

    // Update sequences
    await client.query("SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))");
    await client.query("SELECT setval('shifts_id_seq', (SELECT MAX(id) FROM shifts))");

    await client.query('COMMIT');

    console.log('\n✅ Import successful!');
    console.log(`- ${backup.users.length} users`);
    console.log(`- ${backup.shifts.length} shifts`);
    console.log(`- ${backup.availability?.length || 0} availability records`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Import failed:', err);
    throw err;
  } finally {
    client.release();
    process.exit(0);
  }
}

// Check if DATABASE_URL is set to local
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes('localhost')) {
  console.error('❌ ERROR: DATABASE_URL must point to localhost!');
  console.error('Current DATABASE_URL:', process.env.DATABASE_URL);
  process.exit(1);
}

importBackup().catch(console.error);
