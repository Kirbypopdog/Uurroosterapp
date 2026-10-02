// #157: authenticatie en rolcontrole, uit server.js gehaald.
//
// Elke route-module heeft deze drie nodig, dus ze staan hier in plaats van in
// het bestand waar toevallig de eerste route stond die ze gebruikte.
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

// #159: het token was zeven dagen geldig en werd nooit vernieuwd. De duur is
// zeven dagen gebleven, maar hij loopt nu mee zolang je bezig bent.
//
// Dit getal betekent daardoor maar één ding: HOE LANG JE WEG MAG BLIJVEN voor
// je opnieuw moet inloggen. Wie de app dagelijks gebruikt raakt het nooit.
//
// Het stond even op 24 uur. Dat is teruggedraaid omdat een medewerker die zijn
// rooster één keer per week bekijkt dan élke keer opnieuw moest inloggen, en
// dat is de meerderheid. De bescherming tegen een onbewaakte laptop komt niet
// van dit getal maar van het uitloggen na inactiviteit in app-auth.js: een
// kortere geldigheid helpt daar niets, want het token is op dat moment vers.
const TOKEN_GELDIGHEID_UREN = 7 * 24;

// Vanaf wanneer een vers token meegestuurd wordt. Bij de helft: elk verzoek een
// nieuw token maken is verspilling, en pas op het laatste moment vernieuwen
// betekent dat wie precies dan even niets doet alsnog buitenvliegt.
const VERNIEUW_ONDER_UREN = TOKEN_GELDIGHEID_UREN / 2;

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, team_id: user.team_id, name: user.name },
    JWT_SECRET,
    { expiresIn: `${TOKEN_GELDIGHEID_UREN}h` }
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

    // #159: is het token over de helft, dan gaat er een vers exemplaar mee in
    // een header. De frontend bewaart dat stilletjes. Wie de app gebruikt blijft
    // zo ingelogd zonder er ooit iets van te merken; wie hem een dag laat
    // liggen, moet opnieuw inloggen.
    const restUren = (req.user.exp * 1000 - Date.now()) / 3600000;
    if (restUren < VERNIEUW_ONDER_UREN) {
      res.set('X-Vernieuwd-Token', signToken({
        id: req.user.id, role: req.user.role, team_id: req.user.team_id, name: req.user.name,
      }));
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

module.exports = { signToken, requireAuth, requireAdmin, requireRole, TOKEN_GELDIGHEID_UREN };
