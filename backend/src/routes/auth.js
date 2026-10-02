// #157: inloggen, registreren en de twee routes die zonder inloggen werken,
// uit server.js gehaald.
//
// De snelheidsbegrenzer op het inloggen staat hier en niet in server.js: hij
// hoort bij deze ene route en nergens anders. In de tests wordt hij
// overgeslagen, anders valt de elfde poging om.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signToken, requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { getBelgianPublicHolidays } = require('../utils');

const router = maakRouter();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

router.get('/public-holidays', (req, res) => {
  const year = parseInt(req.query.year, 10);
  if (!year || year < 1900 || year > 2100) {
    return res.status(400).json({ error: 'Geef een geldig jaar op (bijv. ?year=2026)' });
  }
  res.json({ year, holidays: getBelgianPublicHolidays(year) });
});

router.post('/auth/register', requireAuth, requireAdmin, async (req, res) => {
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
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [name, email.toLowerCase(), passwordHash, 'medewerker']
    );
    const user = insert.rows[0];
    const token = signToken(user);
    await logAudit(req, 'CREATE', 'user', user.id, { name: user.name, email: user.email, source: 'register' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Rate limiting on login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Te veel inlogpogingen. Probeer opnieuw over 15 minuten.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/auth/login', loginLimiter, async (req, res) => {
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
                week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules",
                -- #255: dit veld ontbrak, terwijl GET /me het wel teruggeeft. De
                -- frontend zet AppState.currentUser rechtstreeks uit dit antwoord en
                -- rendert de schakelaar met !== false, dus een ontbrekende waarde
                -- werd getoond als ingeschakeld. Pas na een paginaherlading klopte
                -- het weer.
                email_notifications_enabled as "emailNotificationsEnabled"
         FROM users WHERE LOWER(email) = LOWER($1)`,
        [email.trim()]
      );
    } catch (schemaErr) {
      // Fallback to old schema (before migration)
      console.log('Using old schema for login (migration not yet run)');
      result = await pool.query(
        'SELECT id, name, email, password_hash, role, team_id FROM users WHERE LOWER(email) = LOWER($1)',
        [email.trim()]
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
    // Gedeactiveerde accounts: juist wachtwoord maar geen toegang. Aparte 403
    // zodat de frontend de gebruiker niet ten onrechte "fout wachtwoord" toont.
    if (user.active === false) {
      return res.status(403).json({ error: 'Account is gedeactiveerd' });
    }
    const token = signToken(user);
    delete user.password_hash;
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
