// #157: het lezen van gebruikers, uit server.js gehaald. Het BEHEREN van
// accounts zit in admin-users.js.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

// Het basisrooster van een collega gaat alleen naar wie het ook echt gebruikt.
// Let op: dat zijn NIET alleen beheerders. De afwezigheidstab toont een
// medewerker zijn eigen team, en die tabel leest per collega het basisrooster
// om "werkt hier normaal" te kunnen tonen. Het issue stelde dat het nergens
// voor een collega getoond wordt; dat klopt niet. Buiten het eigen team heeft
// een medewerker het wél nergens voor nodig.
function beperkGebruikerVoor(rij, kijker) {
  const magAlles = kijker.role === 'admin' || kijker.role === 'roosterverantwoordelijke';
  if (magAlles) return rij;

  const isZelf = rij.id === kijker.id;
  const zelfdeTeam = rij.mainTeam != null && rij.mainTeam === kijker.team_id;

  const beperkt = { ...rij };
  if (!isZelf) beperkt.email = null;
  if (!isZelf && !zelfdeTeam) {
    if ('weekScheduleWeek1' in beperkt) beperkt.weekScheduleWeek1 = null;
    if ('weekScheduleWeek2' in beperkt) beperkt.weekScheduleWeek2 = null;
    if ('weekSchedules' in beperkt) beperkt.weekSchedules = null;
  }
  return beperkt;
}

// Get all users (with schedule data) - for planning views
// #290: GET /users stuurde voor iedere gebruiker de volledige rij naar elke
// ingelogde gebruiker, inclusief e-mailadres en basisrooster. Het meeste
// daarvan ziet een collega toch al in de planning, maar twee dingen niet.
//
// Het e-mailadres van het adminaccount hoort niet bij een medewerker terecht te
// komen. Een medewerker krijgt daarom alleen zijn eigen adres; zijn profiel
// haalt dat sowieso bij /me, dus er breekt niets.
//
router.get('/users', requireAuth, async (req, res) => {
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
                week_schedules as "weekSchedules",
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

    res.json({ users: result.rows.map(rij => beperkGebruikerVoor(rij, req.user)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user
router.get('/users/:id', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, team_id,
              main_team as "mainTeam", extra_teams as "extraTeams",
              contract_hours as "contractHours", active,
              week_schedule_week1 as "weekScheduleWeek1",
              week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules",
              created_at as "createdAt"
       FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    // #290: dezelfde beperking als in de lijst, anders is dit endpoint de
    // achterdeur waarlangs het adres van het adminaccount alsnog binnenkomt.
    res.json({ user: beperkGebruikerVoor(result.rows[0], req.user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
