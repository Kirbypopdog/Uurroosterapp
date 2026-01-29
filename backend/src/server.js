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
       RETURNING id, name, email, role, team_id`,
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
    const result = await pool.query(
      'SELECT id, name, email, password_hash, role, team_id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
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

app.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, team_id FROM users WHERE id = $1',
      [req.user.id]
    );
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
  const { name, email, password } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 12);
    }
    const result = await pool.query(
      `UPDATE users
       SET name = $1, email = $2, password_hash = COALESCE($3, password_hash)
       WHERE id = $4
       RETURNING id, name, email, role, team_id`,
      [name, email.toLowerCase(), passwordHash, req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

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

app.get('/users', requireAuth, async (req, res) => {
  try {
    const { role } = req.user;
    let query = 'SELECT id, name, email, role, team_id FROM users';
    const params = [];
    if (role === 'medewerker') {
      query += ' WHERE id = $1';
      params.push(req.user.id);
    }
    query += ' ORDER BY name';
    const result = await pool.query(query, params);
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, role, team_id, employee_id FROM users ORDER BY name'
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role, team_id, employee_id } = req.body || {};
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
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, team_id, employee_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role, team_id, employee_id`,
      [name, email.toLowerCase(), passwordHash, role, team_id || null, employee_id || null]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const { role, team_id, name, email, employee_id } = req.body || {};
  if (!userId || !role) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET role = $1,
           team_id = $2,
           name = COALESCE($3, name),
           email = COALESCE($4, email),
           employee_id = $5
       WHERE id = $6
       RETURNING id, name, email, role, team_id, employee_id`,
      [role, team_id || null, name, email ? email.toLowerCase() : null, employee_id || null, userId]
    );
    res.json({ user: result.rows[0] });
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

// ===== EMPLOYEES API =====

app.get('/employees', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, email, main_team as "mainTeam", extra_teams as "extraTeams",
             contract_hours as "contractHours", active,
             week_schedule_week1 as "weekScheduleWeek1",
             week_schedule_week2 as "weekScheduleWeek2",
             created_at as "createdAt"
      FROM employees
      ORDER BY name
    `);
    res.json({ employees: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/employees', requireAuth, async (req, res) => {
  const { name, email, mainTeam, extraTeams, contractHours, active, weekScheduleWeek1, weekScheduleWeek2 } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Naam is verplicht' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO employees (name, email, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, email, main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2",
                created_at as "createdAt"
    `, [name, email || null, mainTeam || null, extraTeams || [], contractHours || 0, active !== false, weekScheduleWeek1 || [], weekScheduleWeek2 || []]);
    res.status(201).json({ employee: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/employees/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, mainTeam, extraTeams, contractHours, active, weekScheduleWeek1, weekScheduleWeek2 } = req.body || {};
  if (!id || !name) {
    return res.status(400).json({ error: 'ID en naam zijn verplicht' });
  }
  try {
    const result = await pool.query(`
      UPDATE employees
      SET name = $1, email = $2, main_team = $3, extra_teams = $4,
          contract_hours = $5, active = $6,
          week_schedule_week1 = $7, week_schedule_week2 = $8
      WHERE id = $9
      RETURNING id, name, email, main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2",
                created_at as "createdAt"
    `, [name, email || null, mainTeam || null, extraTeams || [], contractHours || 0, active !== false, weekScheduleWeek1 || [], weekScheduleWeek2 || [], id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Medewerker niet gevonden' });
    }
    res.json({ employee: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/employees/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  try {
    await pool.query('DELETE FROM employees WHERE id = $1', [id]);
    res.json({ ok: true });
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
      SELECT id, employee_id as "employeeId", team, date, start_time as "startTime",
             end_time as "endTime", notes, created_at as "createdAt"
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
  const { employeeId, team, date, startTime, endTime, notes } = req.body || {};
  if (!employeeId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  try {
    const result = await pool.query(`
      INSERT INTO shifts (employee_id, team, date, start_time, end_time, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, employee_id as "employeeId", team, date, start_time as "startTime",
                end_time as "endTime", notes, created_at as "createdAt"
    `, [employeeId, team || null, date, startTime, endTime, notes || '']);
    res.status(201).json({ shift: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { employeeId, team, date, startTime, endTime, notes } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  try {
    const result = await pool.query(`
      UPDATE shifts
      SET employee_id = COALESCE($1, employee_id),
          team = $2,
          date = COALESCE($3, date),
          start_time = COALESCE($4, start_time),
          end_time = COALESCE($5, end_time),
          notes = COALESCE($6, notes)
      WHERE id = $7
      RETURNING id, employee_id as "employeeId", team, date, start_time as "startTime",
                end_time as "endTime", notes, created_at as "createdAt"
    `, [employeeId, team, date, startTime, endTime, notes, id]);
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
  try {
    await pool.query('DELETE FROM shifts WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk delete shifts in date range
app.delete('/shifts', requireAuth, async (req, res) => {
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
  const { startDate, endDate, employeeId } = req.query;
  try {
    let query = `
      SELECT id, employee_id as "employeeId", date, type, reason, updated_at as "updatedAt"
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
    if (employeeId) {
      query += ` AND employee_id = $${paramIndex}`;
      params.push(employeeId);
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
  const { employeeId, date, type, reason } = req.body || {};
  if (!employeeId || !date || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  try {
    // Upsert - insert or update if exists
    const result = await pool.query(`
      INSERT INTO availability (employee_id, date, type, reason, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (employee_id, date)
      DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
      RETURNING id, employee_id as "employeeId", date, type, reason, updated_at as "updatedAt"
    `, [employeeId, date, type, reason || '']);
    res.status(201).json({ availability: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/availability', requireAuth, async (req, res) => {
  const { employeeId, date } = req.query;
  if (!employeeId || !date) {
    return res.status(400).json({ error: 'employeeId en date zijn verplicht' });
  }
  try {
    await pool.query(
      'DELETE FROM availability WHERE employee_id = $1 AND date = $2',
      [employeeId, date]
    );
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

app.put('/settings/:key', requireAuth, async (req, res) => {
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

app.post('/import', requireAuth, async (req, res) => {
  const { role } = req.user;
  if (!['admin', 'hoofdverantwoordelijke'].includes(role)) {
    return res.status(403).json({ error: 'Geen toegang' });
  }

  const { employees, shifts, availability, settings } = req.body || {};
  const results = { imported: 0, skipped: 0, errors: [] };

  // Import employees
  if (Array.isArray(employees)) {
    for (const emp of employees) {
      try {
        // Validate team exists if specified
        let mainTeam = emp.mainTeam || null;
        if (mainTeam) {
          const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [mainTeam]);
          if (teamCheck.rows.length === 0) {
            mainTeam = null; // Set to null if team doesn't exist
          }
        }

        await pool.query(`
          INSERT INTO employees (name, email, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          emp.name,
          emp.email || null,
          mainTeam,
          emp.extraTeams || [],
          emp.contractHours || 0,
          emp.active !== false,
          emp.weekScheduleWeek1 || [],
          emp.weekScheduleWeek2 || []
        ]);
        results.imported++;
      } catch (err) {
        console.error(`Error importing ${emp.name}:`, err.message);
        results.errors.push({ name: emp.name, error: err.message });
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
    await pool.query('DELETE FROM employees');
    await pool.query('DELETE FROM settings');

    res.json({ ok: true, message: 'Alle data gewist' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Database migration endpoint (admin only)
app.post('/admin/migrate', requireAuth, requireAdmin, async (req, res) => {
  const results = { migrations: [], fixes: [] };

  try {
    // Migration 1: Add employee_id column to users if not exists
    try {
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL');
      results.migrations.push('Added employee_id column to users table');
    } catch (e) {
      if (!e.message.includes('already exists')) {
        throw e;
      }
    }

    // Fix: Double-serialized weekSchedule data
    const employees = await pool.query('SELECT id, week_schedule_week1, week_schedule_week2 FROM employees');
    let fixedCount = 0;

    for (const emp of employees.rows) {
      let week1 = emp.week_schedule_week1;
      let week2 = emp.week_schedule_week2;
      let needsUpdate = false;

      // Check if week1 is a string that looks like JSON
      if (typeof week1 === 'string') {
        try {
          week1 = JSON.parse(week1);
          needsUpdate = true;
        } catch (e) {
          week1 = [];
        }
      }

      // Check if week2 is a string that looks like JSON
      if (typeof week2 === 'string') {
        try {
          week2 = JSON.parse(week2);
          needsUpdate = true;
        } catch (e) {
          week2 = [];
        }
      }

      if (needsUpdate) {
        await pool.query(
          'UPDATE employees SET week_schedule_week1 = $1, week_schedule_week2 = $2 WHERE id = $3',
          [week1, week2, emp.id]
        );
        fixedCount++;
      }
    }

    if (fixedCount > 0) {
      results.fixes.push(`Fixed weekSchedule data for ${fixedCount} employees`);
    }

    res.json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Migration failed: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`API running on :${PORT}`);
});
