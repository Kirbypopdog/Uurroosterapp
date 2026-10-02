// #157: de app-instellingen, uit server.js gehaald. De vormcontrole en het
// inkorten voor de audit log staan hier ook: ze worden nergens anders gebruikt.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

// LET OP: een nieuwe instelling moet hier bij. Zonder die regel weigert het
// endpoint haar met een 400 die precies dat zegt.
const TOEGESTANE_SETTINGS = {
  closedDates:         'array',
  conceptClosedDates:  'array',
  coverageTeams:       'array',
  dismissedAlerts:     'array',
  holidayPeriods:      'array',
  schedule_drafts:     'array',
  email_notifications: 'object',
  holidayRules:        'object',
  responsibleRotation: 'object',
  rules:               'object',
  schedule_pattern:    'object',
  school_year_start:   'object',
  shiftTemplates:      'object',
  teams:               'object'
};

function klopDeVorm(sleutel, waarde) {
  const verwacht = TOEGESTANE_SETTINGS[sleutel];
  if (verwacht === 'array') return Array.isArray(waarde);
  if (verwacht === 'object') return waarde !== null && typeof waarde === 'object' && !Array.isArray(waarde);
  return true;
}

// De vorige waarde gaat mee in de audit, zodat een verkeerde wijziging aan de
// instellingen achteraf terug te vinden en met de hand te herstellen is. Bij
// diensten gebeurde dat al met before en after, bij instellingen niet.
//
// Wel begrensd: schedule_drafts kan als oudere opslagweg een groot object zijn,
// en de audit-tabel is geen back-up. Boven de grens leggen we alleen vast dát
// er iets stond en hoe groot het was.

const AUDIT_WAARDE_MAX = 4000;

function auditWaarde(waarde) {
  if (waarde === undefined) return null;
  const tekst = JSON.stringify(waarde);
  if (tekst && tekst.length > AUDIT_WAARDE_MAX) {
    return { tekort: true, lengte: tekst.length };
  }
  return waarde;
}

router.get('/settings', requireAuth, async (req, res) => {
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

// #328: het endpoint accepteerde elke sleutel en elke vorm. Een typefout in
// een handmatig verzoek maakte stil een nieuwe rij aan, en een verkeerde vorm
// liep pas veel later stuk op een plek die er een array verwachtte.
//
// Deze lijst is niet gegokt maar verzameld uit drie bronnen: elke
// saveSettings-aanroep in de frontend (alle veertien met een letterlijke
// sleutel, geen enkele opgebouwd uit een variabele), elke plek waar de backend
// zelf een settings-rij schrijft, en de sleutels die op de productiedatabank
// staan.
//
router.put('/settings/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'Key en value zijn verplicht' });
  }

  const { role } = req.user;
  if (!['admin', 'roosterverantwoordelijke', 'hoofdverantwoordelijke', 'teamverantwoordelijke'].includes(role)) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }

  // #328: onbekende sleutels en verkeerde vormen worden nu geweigerd.
  if (!Object.prototype.hasOwnProperty.call(TOEGESTANE_SETTINGS, key)) {
    return res.status(400).json({ error: `Onbekende instelling "${key}".` });
  }
  if (!klopDeVorm(key, value)) {
    const verwacht = TOEGESTANE_SETTINGS[key] === 'array' ? 'een lijst' : 'een object';
    return res.status(400).json({ error: `De instelling "${key}" verwacht ${verwacht}.` });
  }
  // #327: de settings-rij werd eerst weggeschreven en de teams-tabel daarna
  // gesynchroniseerd, zonder transactie. Liep die synchronisatie tegen een
  // fout aan, dan gaf het endpoint 500 terwijl de instelling al bewaard was.
  // De gebruiker las "Opslaan mislukt" terwijl het gelukt was, en de
  // teams-tabel liep daarna permanent uit de pas met de instellingen. Alles
  // zit nu in één BEGIN/COMMIT, zodat het antwoord klopt met wat er staat.
  // pool.connect() hoort BINNEN de try: mislukt het verbinden (alle tien de
  // verbindingen bezet, of de databank valt weg terwijl de server draait), dan
  // gooit een async route-handler in Express 4 buiten de try een rejection die
  // niemand opvangt, en blijft het verzoek hangen in plaats van een 500 te
  // geven. Nagemeten: zonder deze opzet komt er binnen zes seconden geen
  // antwoord.
  let client;
  let vorigeWaarde;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // #328: de vorige waarde vastleggen vóór de overschrijving, binnen dezelfde
    // transactie, zodat er geen andere schrijver tussen kan komen.
    const vorige = await client.query('SELECT value FROM settings WHERE key = $1', [key]);
    vorigeWaarde = vorige.rows.length > 0 ? vorige.rows[0].value : undefined;
    await client.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, JSON.stringify(value)]);

    // When teams settings are saved, sync names/colors to the teams table.
    //
    // #256: dit was een kale UPDATE, dus een team-id dat nog geen rij had in
    // de teams-tabel werd nooit ingevoegd. De frontend behandelt
    // settings.teams als bron van waarheid, maar shifts.team en
    // users.main_team hebben een foreign key naar die tabel. Een team dat
    // alleen in de instellingen bestond gaf daardoor 500 zodra je er een
    // dienst of medewerker aan hing. Een upsert lost dat op.
    //
    // Bewust geen verwijderingen hier: daar is DELETE /teams/:id voor, met de
    // controles die daarbij horen. Stil rijen weggooien vanuit een
    // instellingenopslag zou historische diensten losknippen.
    if (key === 'teams' && value && typeof value === 'object') {
      for (const [teamId, teamData] of Object.entries(value)) {
        if (!teamData || !teamData.name) continue;
        // #327: teams.color is NOT NULL. `teamData.color || null` liet een
        // team zonder kleur de hele opslag opblazen. COALESCE valt terug op de
        // kleur die er al staat, en pas als die er ook niet is op een neutraal
        // grijs. Een ontbrekende kleur is geen reden om een naamswijziging te
        // weigeren.
        await client.query(
          `INSERT INTO teams (id, name, color)
           VALUES ($1, $2, COALESCE($3, (SELECT color FROM teams WHERE id = $1), '#8d897c'))
           ON CONFLICT (id) DO UPDATE
             SET name = EXCLUDED.name,
                 color = COALESCE($3, teams.color)`,
          [teamId, teamData.name, teamData.color || null]
        );
      }
    }

    await client.query('COMMIT');
    // Na de commit, niet ervoor: logAudit gebruikt pool.query en zit dus buiten
    // deze transactie. Zou hij ervoor draaien en de commit alsnog falen, dan
    // stond er een auditregel voor een wijziging die niet is doorgegaan.
    await logAudit(req, 'UPDATE', 'settings', key, {
      key,
      before: auditWaarde(vorigeWaarde),
      after: auditWaarde(value)
    });
    res.json({ ok: true });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) { /* verbinding al weg */ }
    }
    console.error('PUT /settings/:key error:', err);
    // #256: idem, een FK-fout hier hoort een leesbaar antwoord te krijgen.
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Een van de teams verwijst naar iets dat niet bestaat.' });
    }
    // #327: een schending van een not-null of een check hoort ook uitgelegd te
    // worden in plaats van als kale 500 te eindigen.
    if (err.code === '23502' || err.code === '23514') {
      return res.status(400).json({ error: 'Een van de teams mist een verplicht veld.' });
    }
    res.status(500).json({ error: 'Server error' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
