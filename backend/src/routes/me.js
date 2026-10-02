// #157: wie ben ik en mijn eigen wachtwoord, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const router = maakRouter();

router.get('/me', requireAuth, async (req, res) => {
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT id, name, email, role, team_id,
                main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules",
                email_notifications_enabled as "emailNotificationsEnabled",
                onboarding_flags as "onboardingFlags",
                ical_feed_token as "icalFeedToken",
                ical_token_created as "icalTokenCreated",
                ical_last_access as "icalLastAccess"
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

// #196: dit endpoint aanvaardde ook mainTeam, contractHours en het volledige
// basisrooster, zonder enige rolcontrole. Een medewerker kon daarmee zijn eigen
// team en contracturen bepalen, en zijn basisrooster zetten terwijl de
// rollentabel zegt dat hij dat niet mag. Erger nog: main_team werd bijgewerkt
// zonder team_id, en die twee moeten altijd gelijk zijn (CLAUDE.md regel 2),
// anders wijst de app hem in het ene team aan en de autorisatie in het andere.
//
// PUT /users/:id blokkeert diezelfde velden al uitdrukkelijk. Er waren dus twee
// wegen naar hetzelfde veld en maar één ervan was bewaakt.
//
// Dit endpoint gaat nu alleen nog over je eigen profiel: naam, e-mail en
// wachtwoord. Precies wat de profielmodal stuurt. De rest loopt via de
// beheerderspaden, waar team_id en main_team samen worden bijgewerkt.
router.put('/me', requireAuth, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 12);
    }

    // #154: rotate iCal token when password changes to invalidate leaked feed URLs
    const newIcalToken = password ? crypto.randomUUID() : null;

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           password_hash = COALESCE($3, password_hash),
           ical_feed_token = COALESCE($5, ical_feed_token)
       WHERE id = $4
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [name, email.toLowerCase(), passwordHash, req.user.id, newIcalToken]
    );
    await logAudit(req, 'UPDATE', 'user', req.user.id, { action: 'self_update', name, email });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
