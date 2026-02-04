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

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           main_team = $3,
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
    // Try new schema (user_id), fallback to old (employee_id)
    let result;
    let needsMapping = false;
    try {
      let query = `
        SELECT id, user_id as "userId", team, date, start_time as "startTime",
               end_time as "endTime", notes, source, created_at as "createdAt"
        FROM shifts
      `;
      const params = [];
      if (startDate && endDate) {
        query += ' WHERE date >= $1 AND date <= $2';
        params.push(startDate, endDate);
      }
      query += ' ORDER BY date, start_time';
      result = await pool.query(query, params);
    } catch (schemaErr) {
      // Fallback to old schema with employee_id - need to map to user_id
      console.log('Using old schema for /shifts - will map employee_id to user_id');
      needsMapping = true;
      let query = `
        SELECT s.id, s.employee_id, s.team, s.date, s.start_time as "startTime",
               s.end_time as "endTime", s.notes, s.created_at as "createdAt",
               e.email as employee_email
        FROM shifts s
        LEFT JOIN employees e ON s.employee_id = e.id
      `;
      const params = [];
      if (startDate && endDate) {
        query += ' WHERE s.date >= $1 AND s.date <= $2';
        params.push(startDate, endDate);
      }
      query += ' ORDER BY s.date, s.start_time';
      result = await pool.query(query, params);
    }

    let shifts = result.rows;

    // If using old schema, map employee_ids to user_ids via email
    if (needsMapping && shifts.length > 0) {
      // Get all users to create email -> user_id mapping
      const usersResult = await pool.query('SELECT id, email FROM users');
      const emailToUserId = new Map();
      usersResult.rows.forEach(u => {
        if (u.email) emailToUserId.set(u.email.toLowerCase(), u.id);
      });

      shifts = shifts.map(s => ({
        id: s.id,
        userId: s.employee_email ? (emailToUserId.get(s.employee_email.toLowerCase()) || s.employee_id) : s.employee_id,
        team: s.team,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        notes: s.notes,
        source: s.source || 'manual',
        createdAt: s.createdAt
      }));
    }

    res.json({ shifts });
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
    // Try new schema (user_id) first
    let result;
    try {
      result = await pool.query(`
        INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, user_id as "userId", team, date, start_time as "startTime",
                  end_time as "endTime", notes, source, created_at as "createdAt"
      `, [userId, team || null, date, startTime, endTime, notes || '', shiftSource]);
    } catch (schemaErr) {
      // Fallback to old schema - need to map user_id to employee_id via email
      console.log('Using old schema for POST /shifts - mapping user to employee');

      // Get user's email
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      }
      const userEmail = userResult.rows[0].email;

      // Find matching employee by email
      const empResult = await pool.query('SELECT id FROM employees WHERE LOWER(email) = LOWER($1)', [userEmail]);
      if (empResult.rows.length === 0) {
        return res.status(404).json({ error: 'Geen gekoppelde medewerker gevonden. Voer eerst de migratie uit.' });
      }
      const employeeId = empResult.rows[0].id;

      result = await pool.query(`
        INSERT INTO shifts (employee_id, team, date, start_time, end_time, notes)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, employee_id as "userId", team, date, start_time as "startTime",
                  end_time as "endTime", notes, created_at as "createdAt"
      `, [employeeId, team || null, date, startTime, endTime, notes || '']);

      // Return the original userId for frontend compatibility
      result.rows[0].userId = userId;
    }
    res.status(201).json({ shift: result.rows[0] });
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
    // Try new schema (user_id), fallback to old (employee_id)
    let result;
    try {
      result = await pool.query(`
        UPDATE shifts
        SET user_id = COALESCE($1, user_id),
            team = COALESCE($2, team),
            date = COALESCE($3, date),
            start_time = COALESCE($4, start_time),
            end_time = COALESCE($5, end_time),
            notes = COALESCE($6, notes),
            source = $8
        WHERE id = $7
        RETURNING id, user_id as "userId", team, date, start_time as "startTime",
                  end_time as "endTime", notes, source, created_at as "createdAt"
      `, [userId, team, date, startTime, endTime, notes, id, shiftSource]);
    } catch (schemaErr) {
      // Fallback to old schema with employee_id
      console.log('Using old schema for PUT /shifts (employee_id)');
      result = await pool.query(`
        UPDATE shifts
        SET employee_id = COALESCE($1, employee_id),
            team = COALESCE($2, team),
            date = COALESCE($3, date),
            start_time = COALESCE($4, start_time),
            end_time = COALESCE($5, end_time),
            notes = COALESCE($6, notes)
        WHERE id = $7
        RETURNING id, employee_id as "userId", team, date, start_time as "startTime",
                  end_time as "endTime", notes, created_at as "createdAt"
      `, [userId, team, date, startTime, endTime, notes, id]);
    }
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dienst niet gevonden' });
    }
    res.json({ shift: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }

  // Permission check: medewerker cannot delete shifts
  const { role } = req.user;
  if (role === 'medewerker') {
    return res.status(403).json({ error: 'Je hebt geen rechten om diensten te verwijderen' });
  }

  try {
    await pool.query('DELETE FROM shifts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
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
    // Try new schema (user_id), fallback to old (employee_id)
    let result;
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
      result = await pool.query(query, params);
    } catch (schemaErr) {
      // Fallback to old schema with employee_id
      console.log('Using old schema for /availability (employee_id)');
      let query = `
        SELECT id, employee_id as "userId", date, type, reason, updated_at as "updatedAt"
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
        query += ` AND employee_id = $${paramIndex}`;
        params.push(userId);
      }
      query += ' ORDER BY date';
      result = await pool.query(query, params);
    }
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
    // Try new schema (user_id), fallback to old (employee_id)
    let result;
    try {
      result = await pool.query(`
        INSERT INTO availability (user_id, date, type, reason, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id, date)
        DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
        RETURNING id, user_id as "userId", date, type, reason, updated_at as "updatedAt"
      `, [userId, date, type, reason || '']);
    } catch (schemaErr) {
      // Fallback to old schema with employee_id
      console.log('Using old schema for POST /availability (employee_id)');
      result = await pool.query(`
        INSERT INTO availability (employee_id, date, type, reason, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (employee_id, date)
        DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
        RETURNING id, employee_id as "userId", date, type, reason, updated_at as "updatedAt"
      `, [userId, date, type, reason || '']);
    }
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
    // Try new schema (user_id), fallback to old (employee_id)
    try {
      await pool.query(
        'DELETE FROM availability WHERE user_id = $1 AND date = $2',
        [userId, date]
      );
    } catch (schemaErr) {
      // Fallback to old schema with employee_id
      console.log('Using old schema for DELETE /availability (employee_id)');
      await pool.query(
        'DELETE FROM availability WHERE employee_id = $1 AND date = $2',
        [userId, date]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
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

  try {
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
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
        results.migrations.push(`Added column ${col.name} to users`);
      } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }

    // Step 2: Check if employees table exists and migrate data
    const tableCheck = await pool.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'employees')
    `);

    if (tableCheck.rows[0].exists) {
      // Copy employee data to users
      const updateResult = await pool.query(`
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
      const createResult = await pool.query(`
        INSERT INTO users (name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
        SELECT e.name, LOWER(e.email), $1, 'medewerker', e.main_team, e.main_team, e.extra_teams, e.contract_hours, e.active, e.week_schedule_week1, e.week_schedule_week2
        FROM employees e
        WHERE e.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(e.email))
        RETURNING id
      `, [passwordHash]);
      results.migrations.push(`Created ${createResult.rowCount} new user accounts from employees`);
    }

    // Step 3: Fix double-serialized JSONB data
    const usersToFix = await pool.query('SELECT id, week_schedule_week1, week_schedule_week2 FROM users');
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
        await pool.query(
          'UPDATE users SET week_schedule_week1 = $1, week_schedule_week2 = $2 WHERE id = $3',
          [week1, week2, user.id]
        );
        fixedCount++;
      }
    }

    if (fixedCount > 0) {
      results.fixes.push(`Fixed weekSchedule data for ${fixedCount} users`);
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Migration failed: ' + err.message });
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
