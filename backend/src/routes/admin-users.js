// #157: accountbeheer door een beheerder, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const emailService = require('../email');
const DEFAULT_RESET_PASSWORD = process.env.DEFAULT_RESET_PASSWORD;

const router = maakRouter();

// De beheerder leest dit hardop voor aan een collega, of schrijft het over.
// Vandaar geen base64: geen hoofdletter-o naast een nul, geen kleine L naast
// een één, en groepjes van vier die je kan uitspreken zonder je plaats kwijt
// te raken. 3 x 4 tekens uit een alfabet van 30 is ruim 58 bits, en dit
// wachtwoord leeft maar tot de medewerker zelf iets kiest.
const WACHTWOORD_ALFABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function genereerWachtwoord() {
  const groep = () => Array.from({ length: 4 },
    () => WACHTWOORD_ALFABET[crypto.randomInt(0, WACHTWOORD_ALFABET.length)]).join('');
  return `${groep()}-${groep()}-${groep()}`;
}

router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, team_id,
              main_team as "mainTeam", extra_teams as "extraTeams",
              contract_hours as "contractHours", active,
              week_schedule_week1 as "weekScheduleWeek1",
              week_schedule_week2 as "weekScheduleWeek2",
              week_schedules as "weekSchedules",
              email_notifications_enabled as "emailNotificationsEnabled"
       FROM users ORDER BY name`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new user (with optional schedule data)
router.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role, team_id, mainTeam, contractHours, active, weekScheduleWeek1, weekScheduleWeek2, weekSchedules } = req.body || {};
  if (!name || !role) {
    return res.status(400).json({ error: 'Naam en rol zijn verplicht' });
  }
  try {
    // Check if email already exists (only when email is provided)
    const normalizedEmail = email ? email.trim().toLowerCase() : null;
    if (normalizedEmail) {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email bestaat al' });
      }
    }

    // #379: liet de beheerder het wachtwoordveld leeg, dan kreeg dit account
    // DEFAULT_RESET_PASSWORD. Dat is het bredere lek, want dat veld leeg laten
    // is de weg van de minste weerstand: er staat letterlijk "Laat leeg voor
    // standaard wachtwoord" bij. Nu krijgt zo'n account een eigen willekeurig
    // wachtwoord, dat één keer in het antwoord meegaat zodat de beheerder het
    // kan doorgeven. Koos de beheerder zelf een wachtwoord, dan blijft dat.
    const gegenereerd = (password && password.trim()) ? null : genereerWachtwoord();
    const userPassword = gegenereerd || password;
    const passwordHash = await bcrypt.hash(userPassword, 12);
    const week1Json = JSON.stringify(weekScheduleWeek1 || []);
    const week2Json = JSON.stringify(weekScheduleWeek2 || []);
    const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
      ? JSON.stringify(weekSchedules)
      : JSON.stringify([weekScheduleWeek1 || [], weekScheduleWeek2 || []]);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, team_id, main_team, contract_hours, active, week_schedule_week1, week_schedule_week2, week_schedules)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [
        name,
        normalizedEmail,
        passwordHash,
        role,
        team_id || mainTeam || null,
        mainTeam || null,
        contractHours || 0,
        active !== false,
        week1Json,
        week2Json,
        weekSchedulesJson
      ]
    );
    await logAudit(req, 'CREATE', 'user', result.rows[0].id, { user: { name, email: normalizedEmail, role, mainTeam } });

    // Welkomst-email alleen als er een email is (fire-and-forget)
    if (normalizedEmail) {
      emailService.notifyWelcome({ name, email: normalizedEmail });
    }

    // #379: alleen wanneer wij het wachtwoord gekozen hebben. Koos de
    // beheerder er zelf een, dan kent hij het al en hoeft het niet terug over
    // de lijn. De welkomstmail bevat geen wachtwoord, dus dit venster is de
    // enige plek waar het te zien is.
    res.status(201).json({ user: result.rows[0], newPassword: gegenereerd || undefined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (role, team, and schedule data)
router.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const { role, team_id, name, email, mainTeam, contractHours, active, weekScheduleWeek1, weekScheduleWeek2, weekSchedules, emailNotificationsEnabled } = req.body || {};
  if (!userId || !role) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const week1Json = weekScheduleWeek1 !== undefined ? JSON.stringify(weekScheduleWeek1) : null;
    const week2Json = weekScheduleWeek2 !== undefined ? JSON.stringify(weekScheduleWeek2) : null;
    const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
      ? JSON.stringify(weekSchedules)
      : null;

    // Get old email before updating (for syncing with employees table)
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

    const result = await pool.query(
      `UPDATE users
       SET role = $1,
           team_id = COALESCE($2, team_id),
           name = COALESCE($3, name),
           email = COALESCE($4, email),
           main_team = COALESCE($5, main_team),
           contract_hours = COALESCE($6, contract_hours),
           active = COALESCE($7, active),
           week_schedule_week1 = COALESCE($8::jsonb, week_schedule_week1),
           week_schedule_week2 = COALESCE($9::jsonb, week_schedule_week2),
           -- #392: de terugval hieronder bouwt week_schedules op uit week1 en
           -- week2, dus uit precies TWEE weken. Die stond vroeger meteen achter
           -- COALESCE($10), waardoor élke PATCH zonder roosterveld hem uitvoerde:
           -- een rolwijziging of een deactivatie knipte de cyclus van iemand met
           -- drie of meer weken terug naar twee. Herbouwen mag alleen wanneer
           -- week1 of week2 werkelijk meegestuurd is; anders blijft de kolom
           -- zoals hij was.
           week_schedules = CASE
             WHEN $10::jsonb IS NOT NULL THEN $10::jsonb
             WHEN $8::jsonb IS NOT NULL OR $9::jsonb IS NOT NULL
               THEN jsonb_build_array(
                 COALESCE($8::jsonb, week_schedule_week1),
                 COALESCE($9::jsonb, week_schedule_week2)
               )
             ELSE week_schedules
           END,
           email_notifications_enabled = COALESCE($12, email_notifications_enabled)
       WHERE id = $11
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                 week_schedules as "weekSchedules",
                 email_notifications_enabled as "emailNotificationsEnabled"`,
      [
        role,
        team_id || mainTeam || null,
        name,
        email ? email.toLowerCase() : null,
        mainTeam,
        contractHours,
        active,
        week1Json,
        week2Json,
        weekSchedulesJson,
        userId,
        typeof emailNotificationsEnabled === 'boolean' ? emailNotificationsEnabled : null
      ]
    );

    await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });

    // Welkomst-email als email voor het eerst wordt ingesteld (fire-and-forget)
    const newEmail = email ? email.toLowerCase() : null;
    if (!oldEmail && newEmail) {
      emailService.notifyWelcome({ name: result.rows[0].name, email: newEmail });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user schedule data (for non-admin users who can edit employee profiles)
router.put('/users/:id', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const { name, email, mainTeam, contractHours, active, weekScheduleWeek1, weekScheduleWeek2, weekSchedules } = req.body || {};

  // Permission check: admin/roosterverantwoordelijke can edit anyone,
  // medewerker can only edit themselves
  const { role, team_id } = req.user;

  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen profiel bewerken' });
  }

  // Medewerker cannot modify base schedule fields
  if (role === 'medewerker' && (weekScheduleWeek1 !== undefined || weekScheduleWeek2 !== undefined || weekSchedules !== undefined)) {
    return res.status(403).json({ error: 'Medewerkers kunnen hun basisrooster niet aanpassen. Neem contact op met je roosterverantwoordelijke.' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Naam is verplicht' });
  }

  // Medewerker can only update name and email
  if (role === 'medewerker') {
    try {
      const oldMedResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      const oldMedEmail = oldMedResult.rows.length > 0 ? oldMedResult.rows[0].email : null;
      const result = await pool.query(
        `UPDATE users SET name = $1, email = $2 WHERE id = $3
         RETURNING id, name, email, role, team_id,
                   main_team as "mainTeam", extra_teams as "extraTeams",
                   contract_hours as "contractHours", active,
                   week_schedule_week1 as "weekScheduleWeek1",
                   week_schedule_week2 as "weekScheduleWeek2",
                   week_schedules as "weekSchedules"`,
        [name, email ? email.trim().toLowerCase() : null, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      }
      await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });
      const newMedEmail = email ? email.trim().toLowerCase() : null;
      if (!oldMedEmail && newMedEmail) {
        emailService.notifyWelcome({ name: result.rows[0].name, email: newMedEmail });
      }
      return res.json({ user: result.rows[0] });
    } catch (err) {
      // #357: users.email heeft een UNIQUE-constraint (users_email_key). Een
      // adres dat al bij een ander account hoort gaf een kale 500 met de tekst
      // "Server error", terwijl POST /users diezelfde botsing wél netjes meldt.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Dit e-mailadres is al in gebruik door een ander account.' });
      }
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  try {
    // Get old email before updating
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

    // Only admins may change email; roosterverantwoordelijke cannot
    const newEmail = role === 'admin' && email ? email.trim().toLowerCase() : oldEmail;

    // #391: de SET wordt opgebouwd uit alleen de velden die MEEGESTUURD zijn.
    // Hier stonden alle kolommen onvoorwaardelijk in, met de waarden
    // rechtstreeks uit req.body. Een verzoek met enkel { name, active } zette
    // daardoor main_team, team_id en de weekroosters op null en
    // contract_hours op 0 — zonder foutmelding, dus de medewerker hield zijn
    // naam en account maar was zijn team en uren kwijt. In de planning valt
    // dat pas op als de bezetting niet meer klopt.
    //
    // Het venster in de app stuurt telkens het volledige formulier mee, dus
    // langs die weg viel het niet op. Het bijt zodra iets anders deze route
    // met een deelverzoek gebruikt.
    const zetters = [];
    const waarden = [];
    const zet = (kolommen, waarde, cast = '') => {
      waarden.push(waarde);
      for (const kolom of [].concat(kolommen)) zetters.push(`${kolom} = $${waarden.length}${cast}`);
    };

    zet('name', name);
    zet('email', newEmail);
    // team_id deelt bewust dezelfde plaatshouder als main_team: die twee horen
    // gelijk te zijn, anders falen de permissies (CLAUDE.md regel 2).
    if (mainTeam !== undefined) zet(['main_team', 'team_id'], mainTeam || null);
    if (contractHours !== undefined) zet('contract_hours', contractHours || 0);
    if (active !== undefined) zet('active', active !== false);

    // De drie roosterkolommen vormen één groep. Wie er één meestuurt, stuurt
    // het hele rooster; wie er geen enkele meestuurt, raakt ze geen van drieën
    // aan. Dat houdt het gedrag voor het volledige formulier precies gelijk.
    if (weekScheduleWeek1 !== undefined || weekScheduleWeek2 !== undefined || weekSchedules !== undefined) {
      // Use weekSchedules directly if provided (for cycles > 2 weeks), otherwise build from week1/week2
      const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
        ? JSON.stringify(weekSchedules)
        : JSON.stringify([weekScheduleWeek1 || [], weekScheduleWeek2 || []]);
      zet('week_schedule_week1', JSON.stringify(weekScheduleWeek1 || []), '::jsonb');
      zet('week_schedule_week2', JSON.stringify(weekScheduleWeek2 || []), '::jsonb');
      zet('week_schedules', weekSchedulesJson, '::jsonb');
    }

    waarden.push(userId);

    const result = await pool.query(
      `UPDATE users
       SET ${zetters.join(',\n           ')}
       WHERE id = $${waarden.length}
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      waarden
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }

    await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });

    // Welkomst-email als email voor het eerst wordt ingesteld (fire-and-forget, admin only)
    if (!oldEmail && newEmail) {
      emailService.notifyWelcome({ name: result.rows[0].name, email: newEmail });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    // #221: main_team/team_id verwijzen naar teams(id). Kwam een team ooit
    // half aan (in settings.teams maar niet in de tabel, zie POST /teams),
    // dan gaf dit een kale 500 met de echte reden alleen in de serverlog.
    // 23503 is Postgres' foreign_key_violation.
    // main_team en team_id zijn de enige foreign keys in deze query, dus de
    // code alleen is genoeg: er is hier maar één plek waar 23503 vandaan kan
    // komen.
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Dit team bestaat niet in de database. Maak het team opnieuw aan.' });
    }
    // #357: zie de medewerkerstak hierboven. 23505 is Postgres'
    // unique_violation, en users_email_key is de enige unieke sleutel die deze
    // query kan raken.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Dit e-mailadres is al in gebruik door een ander account.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only) — explicit transaction with FOR UPDATE lock
router.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  // Don't allow deleting the currently logged in admin
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deletedUser = await client.query('SELECT name, email, role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (deletedUser.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    // Anonymize audit log before deleting — GDPR: actor_name stays queryable but
    // is no longer personal data. Must run before DELETE triggers SET NULL on actor_id.
    await client.query(
      `UPDATE audit_log SET actor_name = 'Verwijderde gebruiker' WHERE actor_id = $1`,
      [userId]
    );
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    await logAudit(req, 'DELETE', 'user', userId, { user: deletedUser.rows[0] });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ error: 'Missing user id' });
  }
  try {
    const nieuwWachtwoord = genereerWachtwoord();
    const passwordHash = await bcrypt.hash(nieuwWachtwoord, 12);
    // #154: een zelfgekozen wachtwoordwijziging roteerde de agendalink al
    // (zie PUT /users/:id), een beheerdersreset niet. Net het geval waarin je
    // het het hardst wil: er wordt gereset ómdat er iets mis is met dat
    // account. De oude feed-URL bleef dan gewoon werken.
    //
    // De link wordt hier niet vervangen maar gewist. Een nieuwe aanmaken heeft
    // geen zin als niemand hem te zien krijgt; de medewerker activeert zelf
    // opnieuw vanuit zijn profiel wanneer hij hem weer nodig heeft.
    //
    // De CTE leest de oude waarde vóór de UPDATE, zodat we weten of er
    // werkelijk een link ingetrokken is. Een subquery rechtstreeks in RETURNING
    // zou hier op de snapshot leunen en dat leest te subtiel.
    const reset = await pool.query(
      `WITH oud AS (SELECT ical_feed_token FROM users WHERE id = $2)
       UPDATE users
          SET password_hash = $1,
              ical_feed_token = NULL, ical_token_created = NULL, ical_last_access = NULL
        WHERE id = $2
        RETURNING (SELECT ical_feed_token FROM oud) IS NOT NULL AS "hadLink"`,
      [passwordHash, userId]
    );
    const agendalinkIngetrokken = reset.rows[0]?.hadLink === true;
    await logAudit(req, 'UPDATE', 'user', userId, { action: 'password_reset' });
    const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [userId]);
    const targetUser = userResult.rows[0];

    // #322: het wachtwoord werd verzwegen zodra de medewerker een e-mailadres
    // had, want "die krijgt het wel per mail". Dat klopte niet: de resetmail
    // bevat geen wachtwoord en verwijst juist terug naar de beheerder. Niemand
    // kreeg het dus te zien. Het wachtwoord gaat nu altijd mee in het antwoord,
    // zodat de beheerder het één keer te zien krijgt en persoonlijk kan
    // doorgeven, en de mail meldt enkel dát er gereset is.
    //
    // emailSent zegt of er effectief een mail vertrekt. Zonder adres, of met
    // het mailtype uit, is dat niet zo, en dan mag de app dat ook niet beweren.
    const emailSent = await emailService.notifyPasswordReset(targetUser, { agendalinkIngetrokken });

    res.json({
      ok: true, newPassword: nieuwWachtwoord, emailSent: !!emailSent,
      agendalinkIngetrokken
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
