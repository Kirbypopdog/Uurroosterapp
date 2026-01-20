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
    const { role, team_id } = req.user;
    let query = 'SELECT id, name, email, role, team_id FROM users';
    const params = [];
    if (role === 'teamverantwoordelijke') {
      query += ' WHERE team_id = $1';
      params.push(team_id);
    } else if (role === 'medewerker') {
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
      'SELECT id, name, email, role, team_id FROM users ORDER BY name'
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const { role, team_id, name, email } = req.body || {};
  if (!userId || !role) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET role = $1,
           team_id = $2,
           name = COALESCE($3, name),
           email = COALESCE($4, email)
       WHERE id = $5
       RETURNING id, name, email, role, team_id`,
      [role, team_id || null, name, email ? email.toLowerCase() : null, userId]
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

app.listen(PORT, () => {
  console.log(`API running on :${PORT}`);
});
