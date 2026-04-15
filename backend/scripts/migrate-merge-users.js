/**
 * Migration Script: Merge Employees into Users Table (Optie C)
 *
 * This script:
 * 1. Adds employee fields to users table
 * 2. Copies employee data to matching users (by email)
 * 3. Creates user accounts for employees without accounts
 * 4. Updates shifts and availability tables to reference users
 * 5. Drops the employees table
 *
 * Run with: node backend/scripts/migrate-merge-users.js
 */

const { pool } = require('../src/db');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const DEFAULT_PASSWORD = process.env.DEFAULT_RESET_PASSWORD;
if (!DEFAULT_PASSWORD) {
  console.error('FATAL: DEFAULT_RESET_PASSWORD env var is required');
  process.exit(1);
}

async function migrate() {
  console.log('Starting migration: Merge employees into users...\n');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Step 1: Add employee columns to users table
    console.log('Step 1: Adding employee columns to users table...');

    // Check if columns already exist before adding
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
        console.log(`  - Added column: ${col.name}`);
      } catch (e) {
        if (!e.message.includes('already exists')) throw e;
        console.log(`  - Column ${col.name} already exists`);
      }
    }

    // Step 2: Check if employees table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'employees'
      )
    `);

    const employeesTableExists = tableCheck.rows[0].exists;

    if (employeesTableExists) {
      // Step 3: Copy employee data to users (match by email)
      console.log('\nStep 2: Copying employee data to matching users...');

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
        RETURNING u.id, u.name, u.email
      `);
      console.log(`  - Updated ${updateResult.rowCount} users with employee data`);

      // Step 4: Create users for employees without accounts
      console.log('\nStep 3: Creating users for employees without accounts...');

      const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

      const employeesWithoutAccounts = await client.query(`
        SELECT e.id, e.name, e.email, e.main_team, e.extra_teams,
               e.contract_hours, e.active, e.week_schedule_week1, e.week_schedule_week2
        FROM employees e
        WHERE e.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(e.email))
      `);

      let createdCount = 0;
      const employeeToUserMapping = new Map(); // Map old employee_id to new user_id

      for (const emp of employeesWithoutAccounts.rows) {
        const result = await client.query(`
          INSERT INTO users (name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
          VALUES ($1, $2, $3, 'medewerker', $4, $5, $6, $7, $8, $9, $10)
          RETURNING id
        `, [
          emp.name,
          emp.email.toLowerCase(),
          passwordHash,
          emp.main_team, // team_id = main_team for role-based access
          emp.main_team,
          emp.extra_teams || [],
          emp.contract_hours || 0,
          emp.active !== false,
          emp.week_schedule_week1 || [],
          emp.week_schedule_week2 || []
        ]);

        employeeToUserMapping.set(emp.id, result.rows[0].id);
        createdCount++;
        console.log(`  - Created user for: ${emp.name} (${emp.email})`);
      }
      console.log(`  - Created ${createdCount} new user accounts`);

      // Also map existing users by email to their employee ids
      const existingMappings = await client.query(`
        SELECT e.id as employee_id, u.id as user_id
        FROM employees e
        JOIN users u ON LOWER(u.email) = LOWER(e.email)
      `);

      for (const row of existingMappings.rows) {
        employeeToUserMapping.set(row.employee_id, row.user_id);
      }

      // Step 5: Update shifts table
      console.log('\nStep 4: Updating shifts table...');

      // Check if shifts still uses employee_id
      const shiftsColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'employee_id'
      `);

      if (shiftsColCheck.rows.length > 0) {
        // First, add user_id column if not exists
        try {
          await client.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_id INTEGER');
        } catch (e) {
          // Column might already exist
        }

        // Update user_id based on employee_id mapping
        for (const [empId, userId] of employeeToUserMapping) {
          await client.query('UPDATE shifts SET user_id = $1 WHERE employee_id = $2', [userId, empId]);
        }

        // Drop old constraint and column, add new constraint
        try {
          await client.query('ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_employee_id_fkey');
        } catch (e) { /* ignore */ }

        try {
          await client.query('ALTER TABLE shifts DROP COLUMN IF EXISTS employee_id');
        } catch (e) { /* ignore */ }

        await client.query('ALTER TABLE shifts ADD CONSTRAINT shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

        console.log('  - Migrated shifts to use user_id');
      } else {
        console.log('  - Shifts already uses user_id, skipping');
      }

      // Step 6: Update availability table
      console.log('\nStep 5: Updating availability table...');

      const availColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'availability' AND column_name = 'employee_id'
      `);

      if (availColCheck.rows.length > 0) {
        // First, add user_id column if not exists
        try {
          await client.query('ALTER TABLE availability ADD COLUMN IF NOT EXISTS user_id INTEGER');
        } catch (e) {
          // Column might already exist
        }

        // Update user_id based on employee_id mapping
        for (const [empId, userId] of employeeToUserMapping) {
          await client.query('UPDATE availability SET user_id = $1 WHERE employee_id = $2', [userId, empId]);
        }

        // Drop old constraints and column
        try {
          await client.query('ALTER TABLE availability DROP CONSTRAINT IF EXISTS availability_employee_id_fkey');
        } catch (e) { /* ignore */ }

        try {
          await client.query('ALTER TABLE availability DROP CONSTRAINT IF EXISTS availability_employee_id_date_key');
        } catch (e) { /* ignore */ }

        try {
          await client.query('ALTER TABLE availability DROP COLUMN IF EXISTS employee_id');
        } catch (e) { /* ignore */ }

        // Add new constraints
        await client.query('ALTER TABLE availability ADD CONSTRAINT availability_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

        try {
          await client.query('ALTER TABLE availability ADD CONSTRAINT availability_user_id_date_key UNIQUE(user_id, date)');
        } catch (e) {
          // Constraint might already exist
        }

        console.log('  - Migrated availability to use user_id');
      } else {
        console.log('  - Availability already uses user_id, skipping');
      }

      // Step 7: Drop employee_id from users if exists
      console.log('\nStep 6: Cleaning up users table...');
      try {
        await client.query('ALTER TABLE users DROP COLUMN IF EXISTS employee_id');
        console.log('  - Removed employee_id column from users');
      } catch (e) {
        console.log('  - employee_id column already removed');
      }

      // Step 8: Drop employees table
      console.log('\nStep 7: Dropping employees table...');
      await client.query('DROP TABLE IF EXISTS employees CASCADE');
      console.log('  - Dropped employees table');

    } else {
      console.log('\nEmployees table does not exist, migration may have already been run.');
    }

    await client.query('COMMIT');
    console.log('\n=== Migration completed successfully! ===\n');

    // Summary
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    console.log(`Total users in database: ${userCount.rows[0].count}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n=== Migration failed! ===');
    console.error(err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
