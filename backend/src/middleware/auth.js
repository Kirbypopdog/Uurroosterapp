// #157: authenticatie en rolcontrole, uit server.js gehaald.
//
// Elke route-module heeft deze drie nodig, dus ze staan hier in plaats van in
// het bestand waar toevallig de eerste route stond die ze gebruikte.
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, team_id: user.team_id, name: user.name },
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
    // Normalize legacy role names from old JWTs (7-day transition period)
    if (req.user.role === 'hoofdverantwoordelijke' || req.user.role === 'teamverantwoordelijke') {
      req.user.role = 'roosterverantwoordelijke';
    }
    // Check if user is still active in the database
    const activeCheck = await pool.query('SELECT active FROM users WHERE id = $1', [req.user.id]);
    if (!activeCheck.rows.length || activeCheck.rows[0].active === false) {
      return res.status(401).json({ error: 'Account is gedeactiveerd' });
    }
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

module.exports = { signToken, requireAuth, requireAdmin, requireRole };
