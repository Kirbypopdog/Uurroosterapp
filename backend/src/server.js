const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const DEFAULT_RESET_PASSWORD = process.env.DEFAULT_RESET_PASSWORD || 'Welkom123!';

app.use(cors());
app.use(express.json());

// ===== AUTO-MIGRATION ON STARTUP =====
// Ensures the database schema is up-to-date
async function ensureSchema() {
  const client = await pool.connect();
  try {
    // Check if new columns exist in users table
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'main_team'
    `);

    if (colCheck.rows.length === 0) {
      console.log('Running auto-migration: adding employee columns to users table...');

      // Add new columns
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
          console.log(`  Added column: ${col.name}`);
        } catch (e) {
          // Column might already exist with different constraints
          console.log(`  Column ${col.name}: ${e.message}`);
        }
      }

      console.log('Auto-migration complete. Run /admin/migrate for full data migration.');
    }

    // Check if source column exists in shifts table
    const sourceColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shifts' AND column_name = 'source'
    `);

    if (sourceColCheck.rows.length === 0) {
      console.log('Adding source column to shifts table...');
      try {
        await client.query(`
          ALTER TABLE shifts
          ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'
          CHECK (source IN ('auto', 'manual'))
        `);
        console.log('  Added column: source');
      } catch (e) {
        console.log(`  Column source: ${e.message}`);
      }
    }

    // Check if shift_swap_requests table exists
    const swapTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'shift_swap_requests'
    `);

    if (swapTableCheck.rows.length === 0) {
      console.log('Creating shift_swap_requests table...');
      try {
        await client.query(`
          CREATE TABLE shift_swap_requests (
            id SERIAL PRIMARY KEY,
            requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            requester_shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
            target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            target_shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
            request_type TEXT NOT NULL DEFAULT 'swap' CHECK (request_type IN ('swap', 'takeover')),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead')),
            message TEXT,
            response_notes TEXT,
            target_approved BOOLEAN DEFAULT NULL,
            target_response_notes TEXT,
            target_responded_at TIMESTAMP,
            lead_approved BOOLEAN DEFAULT NULL,
            lead_response_notes TEXT,
            lead_responded_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            responded_at TIMESTAMP,
            responded_by INTEGER REFERENCES users(id)
          );
        `);
        console.log('  Created table: shift_swap_requests');

        // Create indexes for better query performance
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON shift_swap_requests(status);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_swap_requests_requester ON shift_swap_requests(requester_user_id);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_swap_requests_target ON shift_swap_requests(target_user_id);
        `);
        console.log('  Created indexes for shift_swap_requests');
      } catch (e) {
        console.log(`  Error creating shift_swap_requests table: ${e.message}`);
      }
    } else {
      // Migration: Add target and lead approval columns if they don't exist
      console.log('Checking for target/lead approval columns...');
      try {
        // Check if target_approved column exists
        const targetApprovedCheck = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'shift_swap_requests' AND column_name = 'target_approved'
        `);

        if (targetApprovedCheck.rows.length === 0) {
          console.log('  Adding target/lead approval columns...');
          await client.query(`
            ALTER TABLE shift_swap_requests
            ADD COLUMN target_approved BOOLEAN DEFAULT NULL,
            ADD COLUMN target_response_notes TEXT,
            ADD COLUMN target_responded_at TIMESTAMP,
            ADD COLUMN lead_approved BOOLEAN DEFAULT NULL,
            ADD COLUMN lead_response_notes TEXT,
            ADD COLUMN lead_responded_at TIMESTAMP;
          `);
          console.log('  Added target/lead approval columns');

          // Update CHECK constraint to include new status
          await client.query(`
            ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check;
          `);
          await client.query(`
            ALTER TABLE shift_swap_requests
            ADD CONSTRAINT shift_swap_requests_status_check
            CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead'));
          `);
          console.log('  Updated status constraint');
        }

        // Check if request_type column exists
        const requestTypeCheck = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'shift_swap_requests' AND column_name = 'request_type'
        `);

        if (requestTypeCheck.rows.length === 0) {
          console.log('  Adding request_type column...');
          await client.query(`
            ALTER TABLE shift_swap_requests
            ADD COLUMN request_type TEXT DEFAULT 'swap' CHECK (request_type IN ('swap', 'takeover'));
          `);

          // Make target columns nullable for takeover requests
          await client.query(`
            ALTER TABLE shift_swap_requests
            ALTER COLUMN target_user_id DROP NOT NULL,
            ALTER COLUMN target_shift_id DROP NOT NULL;
          `);

          // Drop constraints that don't apply to takeover requests
          await client.query(`
            ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS different_shifts;
          `);
          await client.query(`
            ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS different_users;
          `);

          // Add conditional constraints (only for swap requests)
          // Note: PostgreSQL doesn't support conditional CHECK constraints easily,
          // so we'll validate in the application layer

          console.log('  Added request_type column and updated constraints');
        }
      } catch (e) {
        console.log(`  Error adding columns: ${e.message}`);
      }
    }

    // Check if shift_blocks table exists
    const blocksTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'shift_blocks'
    `);

    if (blocksTableCheck.rows.length === 0) {
      console.log('Creating shift_blocks table...');
      try {
        await client.query(`
          CREATE TABLE shift_blocks (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER REFERENCES users(id),
            reason TEXT,
            UNIQUE(user_id, date)
          );
        `);
        console.log('  Created table: shift_blocks');

        // Create index for better query performance
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_shift_blocks_user_date ON shift_blocks(user_id, date);
        `);
        console.log('  Created index: idx_shift_blocks_user_date');
      } catch (e) {
        console.log(`  Error creating shift_blocks table: ${e.message}`);
      }
    }
  } catch (err) {
    console.error('Schema check error:', err.message);
  } finally {
    client.release();
  }
}

// Run schema check on startup
ensureSchema().catch(console.error);

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, team_id: user.team_id },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Geen toegang' });
    }
    next();
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const insert = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, team_id, main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active, week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2"`,
      [name, email.toLowerCase(), passwordHash, 'medewerker']
    );
    const user = insert.rows[0];
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    // Try new schema first, fall back to old schema if columns don't exist
    let result;
    try {
      result = await pool.query(
        `SELECT id, name, email, password_hash, role, team_id,
                main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2"
         FROM users WHERE email = $1`,
        [email.toLowerCase()]
      );
    } catch (schemaErr) {
      // Fallback to old schema (before migration)
      console.log('Using old schema for login (migration not yet run)');
      result = await pool.query(
        'SELECT id, name, email, password_hash, role, team_id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
    }
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signToken(user);
    delete user.password_hash;
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== CURRENT USER (ME) API =====

app.get('/me', requireAuth, async (req, res) => {
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT id, name, email, role, team_id,
                main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2"
         FROM users WHERE id = $1`,
        [req.user.id]
      );
    } catch (schemaErr) {
      // Fallback to old schema
      result = await pool.query(
        'SELECT id, name, email, role, team_id FROM users WHERE id = $1',
        [req.user.id]
      );
    }
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/me', requireAuth, async (req, res) => {
  const { name, email, password, mainTeam, extraTeams, contractHours, weekScheduleWeek1, weekScheduleWeek2 } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 12);
    }

    // Serialize JSONB data
    const week1Json = weekScheduleWeek1 ? JSON.stringify(weekScheduleWeek1) : null;
    const week2Json = weekScheduleWeek2 ? JSON.stringify(weekScheduleWeek2) : null;

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           password_hash = COALESCE($3, password_hash),
           main_team = COALESCE($4, main_team),
           extra_teams = COALESCE($5, extra_teams),
           contract_hours = COALESCE($6, contract_hours),
           week_schedule_week1 = COALESCE($7::jsonb, week_schedule_week1),
           week_schedule_week2 = COALESCE($8::jsonb, week_schedule_week2)
       WHERE id = $9
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2"`,
      [name, email.toLowerCase(), passwordHash, mainTeam, extraTeams, contractHours, week1Json, week2Json, req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== TEAMS API =====

app.get('/teams', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, color FROM teams ORDER BY name'
    );
    res.json({ teams: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== USERS API (replaces employees) =====

// Get all users (with schedule data) - for planning views
app.get('/users', requireAuth, async (req, res) => {
  try {
    const { role, team_id } = req.user;

    // Try new schema, fallback to old
    let result;
    try {
      // Everyone can see all users (visibility is universal)
      // Edit permissions differ by role (handled separately in POST/PUT/DELETE endpoints)
      let query = `
        SELECT id, name, email, role, team_id,
               main_team as "mainTeam", extra_teams as "extraTeams",
               contract_hours as "contractHours", active,
               week_schedule_week1 as "weekScheduleWeek1",
               week_schedule_week2 as "weekScheduleWeek2",
               created_at as "createdAt"
        FROM users
        ORDER BY name
      `;
      result = await pool.query(query);
    } catch (schemaErr) {
      // Fallback to old schema
      console.log('Using old schema for /users');
      // Everyone sees all users (no role-based filtering)
      let query = 'SELECT id, name, email, role, team_id, created_at as "createdAt" FROM users ORDER BY name';
      result = await pool.query(query);
    }

    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user
app.get('/users/:id', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, team_id,
              main_team as "mainTeam", extra_teams as "extraTeams",
              contract_hours as "contractHours", active,
              week_schedule_week1 as "weekScheduleWeek1",
              week_schedule_week2 as "weekScheduleWeek2",
              created_at as "createdAt"
       FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN USER MANAGEMENT =====

app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, team_id,
              main_team as "mainTeam", extra_teams as "extraTeams",
              contract_hours as "contractHours", active,
              week_schedule_week1 as "weekScheduleWeek1",
              week_schedule_week2 as "weekScheduleWeek2"
       FROM users ORDER BY name`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new user (with optional schedule data)
app.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role, team_id, mainTeam, extraTeams, contractHours, active, weekScheduleWeek1, weekScheduleWeek2 } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Naam, email, wachtwoord en rol zijn verplicht' });
  }
  try {
    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email bestaat al' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const week1Json = JSON.stringify(weekScheduleWeek1 || []);
    const week2Json = JSON.stringify(weekScheduleWeek2 || []);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2"`,
      [
        name,
        email.toLowerCase(),
        passwordHash,
        role,
        team_id || mainTeam || null, // team_id for role access, defaults to mainTeam
        mainTeam || null,
        extraTeams || [],
        contractHours || 0,
        active !== false,
        week1Json,
        week2Json
      ]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (role, team, and schedule data)
app.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const { role, team_id, name, email, mainTeam, extraTeams, contractHours, active, weekScheduleWeek1, weekScheduleWeek2 } = req.body || {};
  if (!userId || !role) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const week1Json = weekScheduleWeek1 !== undefined ? JSON.stringify(weekScheduleWeek1) : null;
    const week2Json = weekScheduleWeek2 !== undefined ? JSON.stringify(weekScheduleWeek2) : null;

    // Get old email before updating (for syncing with employees table)
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

    const result = await pool.query(
      `UPDATE users
       SET role = $1,
           team_id = $2,
           name = COALESCE($3, name),
           email = COALESCE($4, email),
           main_team = COALESCE($5, main_team),
           extra_teams = COALESCE($6, extra_teams),
           contract_hours = COALESCE($7, contract_hours),
           active = COALESCE($8, active),
           week_schedule_week1 = COALESCE($9::jsonb, week_schedule_week1),
           week_schedule_week2 = COALESCE($10::jsonb, week_schedule_week2)
       WHERE id = $11
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2"`,
      [
        role,
        team_id || mainTeam || null,
        name,
        email ? email.toLowerCase() : null,
        mainTeam,
        extraTeams,
        contractHours,
        active,
        week1Json,
        week2Json,
        userId
      ]
    );

    // If email changed, also update the employees table to keep them in sync
    const newEmail = result.rows[0].email;
    if (email && oldEmail && newEmail && oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
      try {
        await pool.query(
          'UPDATE employees SET email = $1 WHERE LOWER(email) = LOWER($2)',
          [newEmail, oldEmail]
        );
        console.log(`Synced email change from ${oldEmail} to ${newEmail} in employees table`);
      } catch (empErr) {
        console.warn('Could not update employees table email (table may not exist or no matching employee):', empErr.message);
      }
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user schedule data (for non-admin users who can edit employee profiles)
app.put('/users/:id', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const { name, email, mainTeam, extraTeams, contractHours, active, weekScheduleWeek1, weekScheduleWeek2 } = req.body || {};

  // Permission check: admin/hoofdverantwoordelijke can edit anyone,
  // teamverantwoordelijke and medewerker can only edit themselves
  const { role, team_id } = req.user;

  if (role === 'medewerker' && userId !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen profiel bewerken' });
  }

  // Teamverantwoordelijke mag alleen eigen profiel bewerken, niet andere medewerkers
  if (role === 'teamverantwoordelijke' && userId !== req.user.id) {
    return res.status(403).json({ error: 'Alleen hoofdverantwoordelijke mag medewerkergegevens bewerken' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Naam is verplicht' });
  }

  try {
    const week1Json = JSON.stringify(weekScheduleWeek1 || []);
    const week2Json = JSON.stringify(weekScheduleWeek2 || []);

    // Get old email before updating (for syncing with employees table)
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           main_team = $3,
           team_id = $3,
           extra_teams = $4,
           contract_hours = $5,
           active = $6,
           week_schedule_week1 = $7::jsonb,
           week_schedule_week2 = $8::jsonb
       WHERE id = $9
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2"`,
      [name, email || null, mainTeam || null, extraTeams || [], contractHours || 0, active !== false, week1Json, week2Json, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }

    // If email changed, also update the employees table to keep them in sync
    const newEmail = result.rows[0].email;
    if (oldEmail && newEmail && oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
      try {
        await pool.query(
          'UPDATE employees SET email = $1 WHERE LOWER(email) = LOWER($2)',
          [newEmail, oldEmail]
        );
        console.log(`Synced email change from ${oldEmail} to ${newEmail} in employees table`);
      } catch (empErr) {
        console.warn('Could not update employees table email (table may not exist or no matching employee):', empErr.message);
      }
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only)
app.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  try {
    // Don't allow deleting the currently logged in admin
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ error: 'Missing user id' });
  }
  try {
    const passwordHash = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, userId]
    );
    res.json({ ok: true, resetPassword: DEFAULT_RESET_PASSWORD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SHIFTS API =====

app.get('/shifts', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    let query = `
      SELECT id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
             end_time as "endTime", notes, source, created_at as "createdAt"
      FROM shifts
    `;
    const params = [];
    if (startDate && endDate) {
      query += ' WHERE date >= $1 AND date <= $2';
      params.push(startDate, endDate);
    }
    query += ' ORDER BY date, start_time';

    const result = await pool.query(query, params);
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/shifts', requireAuth, async (req, res) => {
  const { userId, team, date, startTime, endTime, notes, source } = req.body || {};
  if (!userId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  // source defaults to 'manual' if not specified
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  try {
    // Insert the new shift
    const result = await pool.query(`
      INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, created_at as "createdAt"
    `, [userId, team || null, date, startTime, endTime, notes || '', shiftSource]);

    const newShift = result.rows[0];

    // Remove shift block ONLY if a MANUAL shift is created (manual overrides the block)
    // Auto shifts should NOT remove blocks (they should respect blocks and not be created at all)
    if (shiftSource === 'manual') {
      await pool.query(
        'DELETE FROM shift_blocks WHERE user_id = $1 AND date = $2',
        [userId, date]
      );
    }

    res.status(201).json({ shift: newShift });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { userId, team, date, startTime, endTime, notes, source } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  // When editing, automatically set source to 'manual' to protect from auto-regeneration
  // Unless explicitly setting to 'auto' (for reset-to-base functionality)
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  try {
    const result = await pool.query(`
      UPDATE shifts
      SET user_id = COALESCE($1, user_id),
          team = COALESCE($2, team),
          date = COALESCE($3, date),
          start_time = COALESCE($4, start_time),
          end_time = COALESCE($5, end_time),
          notes = COALESCE($6, notes),
          source = COALESCE($8, source, 'manual')
      WHERE id = $7
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, created_at as "createdAt"
    `, [userId, team, date, startTime, endTime, notes, id, shiftSource]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dienst niet gevonden' });
    }
    res.json({ shift: result.rows[0] });
  } catch (err) {
    console.error('PUT /shifts/:id error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.delete('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }

  try {
    // Get full shift details for permission check (including date for shift_blocks)
    // Cast date to text to avoid timezone conversion issues
    const shiftResult = await pool.query(
      'SELECT id, user_id, team, source, date::text as date FROM shifts WHERE id = $1',
      [id]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];
    const { role, id: userId, team_id: userTeam } = req.user;

    // AUTO shifts can be deleted by anyone (they're temporary/regenerated)
    if (shift.source !== 'auto') {
      // Permission checks for MANUAL shifts based on role
      if (role === 'admin' || role === 'hoofdverantwoordelijke') {
        // Admin/hoofdverantwoordelijke can delete anything
      } else if (role === 'teamverantwoordelijke') {
        // Teamverantwoordelijke can only delete shifts from own team
        if (shift.team !== userTeam) {
          return res.status(403).json({ error: 'Je kunt alleen diensten van je eigen team verwijderen' });
        }
      } else if (role === 'medewerker') {
        // Medewerker can only delete own shifts
        if (shift.user_id !== userId) {
          return res.status(403).json({ error: 'Je kunt alleen je eigen diensten verwijderen' });
        }
      } else {
        return res.status(403).json({ error: 'Je hebt geen rechten om diensten te verwijderen' });
      }
    }

    // Delete the shift
    await pool.query('DELETE FROM shifts WHERE id = $1', [id]);

    // Create shift block to prevent auto-regeneration
    // Check if caller wants to skip block creation (for system cleanup operations)
    const skipBlock = req.query.skipBlock === 'true';

    if (!skipBlock) {
      // USER-INITIATED deletion (via UI) - always create block for both manual AND auto shifts
      // ON CONFLICT DO NOTHING ensures idempotency (safe to call multiple times)
      // Cast $2 to date explicitly to avoid timezone conversion issues
      await pool.query(`
        INSERT INTO shift_blocks (user_id, date, created_by, reason)
        VALUES ($1, $2::date, $3, $4)
        ON CONFLICT (user_id, date) DO NOTHING
      `, [shift.user_id, shift.date, req.user.id, `${shift.source} shift deleted by user`]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('ERROR in DELETE /shifts/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk delete shifts in date range
// Only supervisors can do bulk delete (admin, hoofdverantwoordelijke, teamverantwoordelijke)
app.delete('/shifts', requireAuth, requireRole('admin', 'hoofdverantwoordelijke', 'teamverantwoordelijke'), async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate en endDate zijn verplicht' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM shifts WHERE date >= $1 AND date <= $2',
      [startDate, endDate]
    );
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== AVAILABILITY API =====

app.get('/availability', requireAuth, async (req, res) => {
  const { startDate, endDate, userId } = req.query;
  try {
    let query = `
      SELECT id, user_id as "userId", date, type, reason, updated_at as "updatedAt"
      FROM availability
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      query += ` AND date >= $${paramIndex} AND date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }
    if (userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(userId);
    }
    query += ' ORDER BY date';

    const result = await pool.query(query, params);
    res.json({ availability: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/availability', requireAuth, async (req, res) => {
  const { userId, date, type, reason } = req.body || {};
  if (!userId || !date || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }

  // Permission check for availability (skip team check if main_team column doesn't exist)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && userId !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid registreren' });
  }

  if (role === 'teamverantwoordelijke') {
    try {
      const targetUser = await pool.query('SELECT main_team FROM users WHERE id = $1', [userId]);
      if (targetUser.rows.length === 0) {
        return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      }
      if (targetUser.rows[0].main_team !== team_id && userId !== req.user.id) {
        return res.status(403).json({ error: 'Je kunt alleen beschikbaarheid van je eigen team registreren' });
      }
    } catch (e) {
      // Skip team check if main_team column doesn't exist yet
      console.log('Skipping team permission check (main_team column not found)');
    }
  }

  try {
    const result = await pool.query(`
      INSERT INTO availability (user_id, date, type, reason, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, date)
      DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
      RETURNING id, user_id as "userId", date, type, reason, updated_at as "updatedAt"
    `, [userId, date, type, reason || '']);

    res.status(201).json({ availability: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/availability', requireAuth, async (req, res) => {
  const { userId, date } = req.query;
  if (!userId || !date) {
    return res.status(400).json({ error: 'userId en date zijn verplicht' });
  }

  // Permission check (skip team check if main_team column doesn't exist)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid verwijderen' });
  }

  if (role === 'teamverantwoordelijke') {
    try {
      const targetUser = await pool.query('SELECT main_team FROM users WHERE id = $1', [userId]);
      if (targetUser.rows.length > 0 && targetUser.rows[0].main_team !== team_id && Number(userId) !== req.user.id) {
        return res.status(403).json({ error: 'Je kunt alleen beschikbaarheid van je eigen team verwijderen' });
      }
    } catch (e) {
      // Skip team check if main_team column doesn't exist yet
      console.log('Skipping team permission check (main_team column not found)');
    }
  }

  try {
    await pool.query(
      'DELETE FROM availability WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SHIFT BLOCKS API =====

app.get('/shift-blocks', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sb.id, sb.user_id, sb.date::text as date, sb.created_at, sb.created_by, sb.reason, u.name as created_by_name
      FROM shift_blocks sb
      LEFT JOIN users u ON sb.created_by = u.id
      ORDER BY sb.date DESC, sb.user_id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift blocks:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/shift-blocks/:id', requireAuth, requireRole(['admin', 'hoofdverantwoordelijke']), async (req, res) => {
  try {
    const blockId = parseInt(req.params.id, 10);
    if (!blockId) {
      return res.status(400).json({ error: 'ID is verplicht' });
    }

    await pool.query('DELETE FROM shift_blocks WHERE id = $1', [blockId]);
    res.json({ message: 'Shift block removed successfully' });
  } catch (err) {
    console.error('Error deleting shift block:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SWAP REQUESTS API =====

app.get('/swap-requests', requireAuth, async (req, res) => {
  const { role, team_id, id: currentUserId } = req.user;

  try {
    let query;
    let params = [];

    // Role-based filtering
    if (['admin', 'hoofdverantwoordelijke'].includes(role)) {
      // Admin/hoofdverantwoordelijke: alle requests
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        ORDER BY sr.created_at DESC
      `;
    } else if (role === 'teamverantwoordelijke') {
      // Teamverantwoordelijke: alleen hun team (including takeover requests)
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        WHERE s1.team = $1 OR s2.team = $1 OR sr.request_type = 'takeover'
        ORDER BY sr.created_at DESC
      `;
      params = [team_id];
    } else {
      // Medewerker: own requests + all open takeover requests
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        WHERE sr.requester_user_id = $1 OR sr.target_user_id = $1 OR sr.request_type = 'takeover'
        ORDER BY sr.created_at DESC
      `;
      params = [currentUserId];
    }

    const result = await pool.query(query, params);
    console.log(`[GET /swap-requests] User ${req.user.name} (ID: ${req.user.id}, role: ${role}): Found ${result.rows.length} requests`);
    if (result.rows.length > 0) {
      console.log(`[GET /swap-requests] First request:`, {
        id: result.rows[0].id,
        request_type: result.rows[0].request_type,
        status: result.rows[0].status,
        requester: result.rows[0].requester_name
      });
    }
    res.json({ swapRequests: result.rows });
  } catch (err) {
    console.error('GET /swap-requests error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/swap-requests', requireAuth, async (req, res) => {
  const { requesterShiftId, targetShiftId, message } = req.body;
  const currentUserId = req.user.id;

  if (!requesterShiftId || !targetShiftId) {
    return res.status(400).json({ error: 'requesterShiftId en targetShiftId zijn verplicht' });
  }

  try {
    // Verify beide shifts bestaan
    const shiftsResult = await pool.query(
      'SELECT id, user_id, date FROM shifts WHERE id = $1 OR id = $2',
      [requesterShiftId, targetShiftId]
    );

    if (shiftsResult.rows.length !== 2) {
      return res.status(404).json({ error: 'Een of beide shifts niet gevonden' });
    }

    const requesterShift = shiftsResult.rows.find(s => s.id === parseInt(requesterShiftId));
    const targetShift = shiftsResult.rows.find(s => s.id === parseInt(targetShiftId));

    // Verify requester owns requester shift
    if (requesterShift.user_id !== currentUserId) {
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts ruilen' });
    }

    // Verify different users
    if (requesterShift.user_id === targetShift.user_id) {
      return res.status(400).json({ error: 'Je kunt niet met jezelf ruilen' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(requesterShift.date);
    const targetDate = new Date(targetShift.date);

    if (requesterDate < now || targetDate < now) {
      return res.status(400).json({ error: 'Kan geen shifts in het verleden ruilen' });
    }

    // Create swap request
    const insertResult = await pool.query(
      `INSERT INTO shift_swap_requests
       (requester_user_id, requester_shift_id, target_user_id, target_shift_id, message, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [currentUserId, requesterShiftId, targetShift.user_id, targetShiftId, message || null]
    );

    res.status(201).json({ swapRequest: insertResult.rows[0] });
  } catch (err) {
    console.error('POST /swap-requests error:', err);
    if (err.code === '23514') { // CHECK constraint violation
      return res.status(400).json({ error: 'Ongeldige swap request data' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Target approval endpoints
app.put('/swap-requests/:id/target-approve', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.user_id as requester_current_user, s1.team as requester_team, s1.date as requester_date,
              s1.start_time as requester_start, s1.end_time as requester_end,
              s2.user_id as target_current_user, s2.team as target_team, s2.date as target_date,
              s2.start_time as target_start, s2.end_time as target_end
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can approve
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek accepteren' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(swap.requester_date);
    const targetDate = new Date(swap.target_date);

    if (requesterDate < now || targetDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shifts zijn al voorbij' });
    }

    // Execute swap: swap user_ids atomically
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.target_current_user, swap.requester_shift_id]
    );

    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.requester_current_user, swap.target_shift_id]
    );

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved',
           target_approved = true,
           target_response_notes = $1,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $2
       WHERE id = $3`,
      [responseNotes || null, currentUserId, swapId]
    );

    await client.query('COMMIT');

    res.json({ ok: true, message: 'Swap geaccepteerd en uitgevoerd' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /swap-requests/:id/target-approve error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.put('/swap-requests/:id/target-reject', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { id: currentUserId } = req.user;

  if (!responseNotes || responseNotes.trim() === '') {
    return res.status(400).json({ error: 'Reden voor afwijzing is verplicht' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request
    const swapResult = await client.query(
      `SELECT * FROM shift_swap_requests WHERE id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can reject
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek afwijzen' });
    }

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'rejected',
           target_approved = false,
           target_response_notes = $1,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $2
       WHERE id = $3`,
      [responseNotes, currentUserId, swapId]
    );

    await client.query('COMMIT');

    res.json({ ok: true, message: 'Swap afgewezen' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /swap-requests/:id/target-reject error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Takeover (open shift request) endpoints
app.post('/shift-requests/takeover', requireAuth, async (req, res) => {
  const { shiftId, message } = req.body;
  const currentUserId = req.user.id;

  if (!shiftId) {
    return res.status(400).json({ error: 'shiftId is verplicht' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify shift exists and belongs to current user
    const shiftResult = await client.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];

    if (shift.user_id !== currentUserId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts aanbieden' });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = new Date(shift.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // Create takeover request
    await client.query(
      `INSERT INTO shift_swap_requests
       (requester_user_id, requester_shift_id, target_user_id, target_shift_id, request_type, message, status)
       VALUES ($1, $2, NULL, NULL, 'takeover', $3, 'pending')`,
      [currentUserId, shiftId, message || null]
    );

    await client.query('COMMIT');

    res.json({ ok: true, message: 'Open verzoek aangemaakt' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /shift-requests/takeover error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.put('/shift-requests/:id/takeover-accept', requireAuth, async (req, res) => {
  const requestId = req.params.id;
  const { responseNotes } = req.body;
  const { id: currentUserId, team_id: acceptorTeam } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch takeover request with shift info
    const requestResult = await client.query(
      `SELECT sr.*, s.user_id as current_shift_owner, s.date, s.start_time, s.end_time, s.team
       FROM shift_swap_requests sr
       JOIN shifts s ON sr.requester_shift_id = s.id
       WHERE sr.id = $1`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verzoek niet gevonden' });
    }

    const request = requestResult.rows[0];

    // Verify it's a takeover request
    if (request.request_type !== 'takeover') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Dit is geen open verzoek' });
    }

    // Verify status is pending
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Verzoek is al verwerkt' });
    }

    // Verify user is not the requester
    if (request.requester_user_id === currentUserId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Je kunt je eigen verzoek niet accepteren' });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = new Date(request.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // Assign shift to acceptor AND update team to acceptor's team
    await client.query(
      `UPDATE shifts SET user_id = $1, team = $2, source = 'manual' WHERE id = $3`,
      [currentUserId, acceptorTeam, request.requester_shift_id]
    );

    // Update request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved',
           target_user_id = $1,
           target_approved = true,
           target_response_notes = $2,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $1
       WHERE id = $3`,
      [currentUserId, responseNotes || null, requestId]
    );

    await client.query('COMMIT');

    res.json({ ok: true, message: 'Shift overgenomen' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /shift-requests/:id/takeover-accept error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Lead approval endpoints (for future use)
app.put('/swap-requests/:id/approve', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { role, team_id, id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.user_id as requester_current_user, s1.team as requester_team, s1.date as requester_date,
              s2.user_id as target_current_user, s2.team as target_team, s2.date as target_date
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check
    if (!['admin', 'hoofdverantwoordelijke'].includes(role)) {
      if (role === 'teamverantwoordelijke') {
        // Must be team of one of the shifts
        if (swap.requester_team !== team_id && swap.target_team !== team_id) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Je kunt alleen swaps van je eigen team goedkeuren' });
        }
      } else {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Geen toestemming om swaps goed te keuren' });
      }
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(swap.requester_date);
    const targetDate = new Date(swap.target_date);

    if (requesterDate < now || targetDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shifts zijn al voorbij' });
    }

    // Execute swap: swap user_ids atomically
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.target_current_user, swap.requester_shift_id]
    );

    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.requester_current_user, swap.target_shift_id]
    );

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved', response_notes = $1, responded_at = NOW(), responded_by = $2
       WHERE id = $3`,
      [responseNotes || null, currentUserId, swapId]
    );

    await client.query('COMMIT');

    res.json({ ok: true, message: 'Swap goedgekeurd en uitgevoerd' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /swap-requests/:id/approve error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

app.put('/swap-requests/:id/reject', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { role, team_id, id: currentUserId } = req.user;

  if (!responseNotes || responseNotes.trim() === '') {
    return res.status(400).json({ error: 'Reden voor afwijzing is verplicht' });
  }

  try {
    // Fetch swap request met shifts info
    const swapResult = await pool.query(
      `SELECT sr.*,
              s1.team as requester_team,
              s2.team as target_team
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check (same as approve)
    if (!['admin', 'hoofdverantwoordelijke'].includes(role)) {
      if (role === 'teamverantwoordelijke') {
        if (swap.requester_team !== team_id && swap.target_team !== team_id) {
          return res.status(403).json({ error: 'Je kunt alleen swaps van je eigen team afwijzen' });
        }
      } else {
        return res.status(403).json({ error: 'Geen toestemming om swaps af te wijzen' });
      }
    }

    // Update swap request status
    await pool.query(
      `UPDATE shift_swap_requests
       SET status = 'rejected', response_notes = $1, responded_at = NOW(), responded_by = $2
       WHERE id = $3`,
      [responseNotes, currentUserId, swapId]
    );

    res.json({ ok: true, message: 'Swap afgewezen' });
  } catch (err) {
    console.error('PUT /swap-requests/:id/reject error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/swap-requests/:id', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const currentUserId = req.user.id;

  try {
    // Fetch swap request
    const swapResult = await pool.query(
      'SELECT * FROM shift_swap_requests WHERE id = $1',
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Only requester can cancel
    if (swap.requester_user_id !== currentUserId) {
      return res.status(403).json({ error: 'Alleen de aanvrager kan dit verzoek annuleren' });
    }

    // Only pending requests can be cancelled
    if (swap.status !== 'pending') {
      return res.status(400).json({ error: 'Alleen pending requests kunnen geannuleerd worden' });
    }

    // Update status to cancelled
    await pool.query(
      `UPDATE shift_swap_requests SET status = 'cancelled' WHERE id = $1`,
      [swapId]
    );

    res.json({ ok: true, message: 'Swap request geannuleerd' });
  } catch (err) {
    console.error('DELETE /swap-requests/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SETTINGS API =====

app.get('/settings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    res.json({ settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/settings/:key', requireAuth, requireRole('admin', 'hoofdverantwoordelijke'), async (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'Key en value zijn verplicht' });
  }
  try {
    await pool.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, JSON.stringify(value)]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== DATA IMPORT API =====

app.post('/import', requireAuth, requireRole('admin', 'hoofdverantwoordelijke'), async (req, res) => {
  const { users, shifts, availability, settings } = req.body || {};
  const results = { imported: 0, skipped: 0, errors: [] };

  // Import users (with schedule data)
  if (Array.isArray(users)) {
    for (const user of users) {
      try {
        // Validate team exists if specified
        let mainTeam = user.mainTeam || null;
        if (mainTeam) {
          const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [mainTeam]);
          if (teamCheck.rows.length === 0) {
            mainTeam = null;
          }
        }

        // Check if user already exists (by email)
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [user.email?.toLowerCase()]);
        if (existing.rows.length > 0) {
          // Update existing user's schedule data
          const week1Json = JSON.stringify(user.weekScheduleWeek1 || []);
          const week2Json = JSON.stringify(user.weekScheduleWeek2 || []);

          await pool.query(`
            UPDATE users SET
              name = $1,
              main_team = $2,
              extra_teams = $3,
              contract_hours = $4,
              active = $5,
              week_schedule_week1 = $6::jsonb,
              week_schedule_week2 = $7::jsonb
            WHERE email = $8
          `, [
            user.name,
            mainTeam,
            user.extraTeams || [],
            user.contractHours || 0,
            user.active !== false,
            week1Json,
            week2Json,
            user.email.toLowerCase()
          ]);
          results.imported++;
        } else if (user.email) {
          // Create new user with default password
          const passwordHash = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12);
          const week1Json = JSON.stringify(user.weekScheduleWeek1 || []);
          const week2Json = JSON.stringify(user.weekScheduleWeek2 || []);

          await pool.query(`
            INSERT INTO users (name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
            VALUES ($1, $2, $3, 'medewerker', $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
          `, [
            user.name,
            user.email.toLowerCase(),
            passwordHash,
            mainTeam,
            mainTeam,
            user.extraTeams || [],
            user.contractHours || 0,
            user.active !== false,
            week1Json,
            week2Json
          ]);
          results.imported++;
        } else {
          results.skipped++;
          results.errors.push({ name: user.name, error: 'Email is required' });
        }
      } catch (err) {
        console.error(`Error importing ${user.name}:`, err.message);
        results.errors.push({ name: user.name, error: err.message });
        results.skipped++;
      }
    }
  }

  // Import shifts
  if (Array.isArray(shifts)) {
    for (const shift of shifts) {
      try {
        await pool.query(`
          INSERT INTO shifts (user_id, team, date, start_time, end_time, notes)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [shift.userId, shift.team || null, shift.date, shift.startTime, shift.endTime, shift.notes || '']);
        results.imported++;
      } catch (err) {
        results.errors.push({ shift: shift.date, error: err.message });
        results.skipped++;
      }
    }
  }

  // Import availability
  if (Array.isArray(availability)) {
    for (const avail of availability) {
      try {
        await pool.query(`
          INSERT INTO availability (user_id, date, type, reason, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (user_id, date) DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
        `, [avail.userId, avail.date, avail.type, avail.reason || '']);
        results.imported++;
      } catch (err) {
        results.errors.push({ availability: avail.date, error: err.message });
        results.skipped++;
      }
    }
  }

  res.json({ ok: true, results });
});

// Reset all data (admin only)
app.delete('/reset-data', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Delete in correct order due to foreign keys
    await pool.query('DELETE FROM availability');
    await pool.query('DELETE FROM shifts');
    await pool.query('DELETE FROM settings');
    // Note: We don't delete users as that would log everyone out

    res.json({ ok: true, message: 'Planning data gewist (gebruikers behouden)' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== MIGRATION ENDPOINTS =====

// Run the merge-employees migration
app.post('/admin/migrate', requireAuth, requireAdmin, async (req, res) => {
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

    res.json({ ok: true, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed: ' + err.message, details: err.stack });
  } finally {
    client.release();
  }
});

// Seed teams endpoint (admin only)
app.post('/admin/seed-teams', requireAuth, requireAdmin, async (req, res) => {
  const teams = [
    { id: 'vlot1', name: 'Vlot 1 (Begeleiding)', color: '#3b82f6' },
    { id: 'vlot2', name: 'Vlot 2 (Begeleiding)', color: '#8b5cf6' },
    { id: 'cargo', name: 'Cargo (Dagbesteding)', color: '#10b981' },
    { id: 'overkoepelend', name: 'Overkoepelend (Kantoor)', color: '#f59e0b' },
    { id: 'jobstudent', name: 'Jobstudenten/Stagiairs', color: '#ec4899' }
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
    res.json({ ok: true, created, updated, total: teams.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to check database state
app.get('/admin/debug', requireAuth, requireAdmin, async (req, res) => {
  try {
    const teams = await pool.query('SELECT * FROM teams ORDER BY id');
    const users = await pool.query(`
      SELECT id, name, email, role, main_team, team_id,
             week_schedule_week1, week_schedule_week2,
             pg_typeof(week_schedule_week1) as type_week1,
             pg_typeof(week_schedule_week2) as type_week2
      FROM users
      ORDER BY name
    `);

    const tableCheck = await pool.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'employees') as employees_exists
    `);

    const userDebug = users.rows.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      mainTeam: u.main_team,
      teamId: u.team_id,
      weekScheduleWeek1: {
        type: u.type_week1,
        value: u.week_schedule_week1,
        isArray: Array.isArray(u.week_schedule_week1),
        length: Array.isArray(u.week_schedule_week1) ? u.week_schedule_week1.length : 'N/A'
      },
      weekScheduleWeek2: {
        type: u.type_week2,
        value: u.week_schedule_week2,
        isArray: Array.isArray(u.week_schedule_week2),
        length: Array.isArray(u.week_schedule_week2) ? u.week_schedule_week2.length : 'N/A'
      }
    }));

    res.json({
      teams: teams.rows,
      userCount: users.rows.length,
      users: userDebug,
      employeesTableExists: tableCheck.rows[0].employees_exists
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`API running on :${PORT}`);
});
