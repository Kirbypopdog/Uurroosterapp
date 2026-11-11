// #157: e-mailvoorkeuren en de agendakoppeling, uit server.js gehaald. Ze
// staan samen omdat ze allebei over JOUW account gaan en in server.js ook al
// onder dezelfde kop stonden.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { formatDateYYYYMMDD, formatICalDateTime, icalUtcStempel, icalSequence } = require('../utils');
const crypto = require('crypto');

const router = maakRouter();

function icalEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// VTIMEZONE-component voor Europe/Brussels (CET/CEST). Nodig zodat Outlook de
// wall-clock tijd correct interpreteert i.p.v. de niet-officiële X-WR-TIMEZONE
// te negeren en de kale tijd als UTC te lezen (zie issue #172).

const BRUSSELS_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Brussels',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

// PUT /me/onboarding-flags - Update onboarding flags (merge)

router.put('/me/email-preferences', requireAuth, async (req, res) => {
  const { emailNotificationsEnabled } = req.body || {};
  if (typeof emailNotificationsEnabled !== 'boolean') {
    return res.status(400).json({ error: 'emailNotificationsEnabled (boolean) is verplicht' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET email_notifications_enabled = $1 WHERE id = $2
       RETURNING email_notifications_enabled as "emailNotificationsEnabled"`,
      [emailNotificationsEnabled, req.user.id]
    );
    await logAudit(req, 'UPDATE', 'user', req.user.id, { action: 'email_preferences', emailNotificationsEnabled });
    res.json({ emailNotificationsEnabled: result.rows[0].emailNotificationsEnabled });
  } catch (err) {
    console.error('PUT /me/email-preferences error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// #410: gaan de OMSCHRIJVINGEN van je activiteiten mee in je agendafeed?
//
// Alleen voor jezelf, en bewust geen beheerdersinstelling: het is jouw link en
// jouw afweging. `ical_voorkeur_gewijzigd` legt vast wanneer dit omging, zodat
// de feed een hogere SEQUENCE kan meesturen en een agenda die je activiteiten
// al heeft de nieuwe titels ook werkelijk overneemt.
router.put('/me/agenda-omschrijvingen', requireAuth, async (req, res) => {
  const { icalOmschrijvingen } = req.body || {};
  if (typeof icalOmschrijvingen !== 'boolean') {
    return res.status(400).json({ error: 'icalOmschrijvingen (boolean) is verplicht' });
  }
  try {
    const r = await pool.query(
      `UPDATE users SET ical_omschrijvingen = $1, ical_voorkeur_gewijzigd = NOW()
        WHERE id = $2
        RETURNING ical_omschrijvingen AS "icalOmschrijvingen"`,
      [icalOmschrijvingen, req.user.id]
    );
    // Niet WAT er nu meegaat in de audit log, alleen DAT de keuze omging:
    // de omschrijvingen zelf zijn precies het gevoelige deel.
    await logAudit(req, 'UPDATE', 'user', req.user.id,
      { action: 'ical_omschrijvingen', icalOmschrijvingen });
    res.json({ icalOmschrijvingen: r.rows[0].icalOmschrijvingen });
  } catch (err) {
    console.error('PUT /me/agenda-omschrijvingen error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /me/ical-token - Genereer of reset persoonlijke iCal feed token
router.post('/me/ical-token', requireAuth, async (req, res) => {
  try {
    const token = crypto.randomUUID();
    // #154: de nieuwe link begint met een schone lei. ical_last_access moet
    // terug op NULL, anders draagt de nieuwe link het gebruik van de oude mee
    // en zegt het scherm "vorige week opgehaald" over een link die nog nooit
    // gebruikt is.
    const r = await pool.query(
      `UPDATE users SET ical_feed_token = $1, ical_token_created = NOW(), ical_last_access = NULL
        WHERE id = $2 RETURNING ical_token_created AS "icalTokenCreated"`,
      [token, req.user.id]);
    await logAudit(req, 'UPDATE', 'user', req.user.id, { action: 'ical_token_reset' });
    res.json({ token, icalTokenCreated: r.rows[0].icalTokenCreated, icalLastAccess: null });
  } catch (err) {
    console.error('POST /me/ical-token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /calendar/:token.ics - Publieke iCal feed (token = auth)
router.get('/calendar/:token.ics', async (req, res) => {
  try {
    // #154: het ophalen wordt meteen genoteerd. Dat is wat de medewerker op
    // zijn profiel te zien krijgt, zodat een link die hij niet meer gebruikt
    // maar wél opgehaald wordt, opvalt. Alleen het tijdstip, geen IP-adres en
    // geen geschiedenis: zie migratie 046.
    const userResult = await pool.query(
      `UPDATE users SET ical_last_access = NOW()
        WHERE ical_feed_token = $1 AND active = true
        RETURNING id, name, ical_omschrijvingen, ical_voorkeur_gewijzigd`,
      [req.params.token]
    );
    if (!userResult.rows.length) return res.status(404).send('Not found');
    const user = userResult.rows[0];

    const from = new Date(); from.setDate(from.getDate() - 30);
    const to   = new Date(); to.setDate(to.getDate() + 365);
    const [shiftsResult, teamsSettingResult, activiteitenResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.date::text, s.start_time, s.end_time, s.team, s.notes,
                s.updated_at, t.name as team_name
         FROM shifts s
         LEFT JOIN teams t ON t.id = s.team
         WHERE s.user_id = $1 AND s.date >= $2 AND s.date <= $3
         ORDER BY s.date, s.start_time`,
        [user.id, formatDateYYYYMMDD(from), formatDateYYYYMMDD(to)]
      ),
      pool.query(`SELECT value FROM settings WHERE key = 'teams'`),
      // #410: de activiteiten gaan mee als eigen gebeurtenis. Zonder dat zag je
      // op je telefoon alleen "Vlot 2, 13:00-23:00" en niet dat je van 13 tot
      // 16 uur in de teamvergadering zat.
      pool.query(
        `SELECT id, date::text, start_time::text, end_time::text, type, description, updated_at
         FROM shift_activities
         WHERE user_id = $1 AND date >= $2 AND date <= $3
         ORDER BY date, start_time`,
        [user.id, formatDateYYYYMMDD(from), formatDateYYYYMMDD(to)]
      )
    ]);
    // settings.teams is the primary display name source (may differ from teams table)
    const teamNameMap = teamsSettingResult.rows.length ? teamsSettingResult.rows[0].value : {};

    // #409: de terugval voor een dienst zonder `updated_at`. Die kolom is NOT
    // NULL sinds migratie 049, dus in de praktijk komt dit niet voor; het
    // vangt alleen een database op waar die migratie nog niet gedraaid is.
    const nu = icalUtcStempel(new Date());

    const dienstEvents = shiftsResult.rows.map(s => {
      const dateStr = s.date.slice(0, 10);
      const start = formatICalDateTime(dateStr, s.start_time);
      let endDate = dateStr;
      if (s.end_time <= s.start_time) {
        const d = new Date(dateStr); d.setDate(d.getDate() + 1);
        endDate = formatDateYYYYMMDD(d);
      }
      const end = formatICalDateTime(endDate, s.end_time);
      const summary = icalEscape((teamNameMap[s.team] && teamNameMap[s.team].name) || s.team_name || s.team || 'Shift');

      // #409: zonder deze drie regels laat een abonnee-agenda een gebeurtenis
      // staan zoals hij hem al had. Zie icalSequence() in utils.js.
      //
      // DTSTAMP stond hier op "nu", één waarde voor het hele verzoek. Elke
      // ophaling gaf dus élke gebeurtenis een nieuw stempel, ook de honderden
      // die niet veranderd waren — ruis in plaats van een signaal. Het hoort
      // het moment te zijn waarop déze gebeurtenis voor het laatst veranderde.
      const gewijzigd = icalUtcStempel(s.updated_at) || nu;
      const lines = [
        'BEGIN:VEVENT',
        `UID:shift-${s.id}@hetvlot`,
        `DTSTAMP:${gewijzigd}`,
        `LAST-MODIFIED:${gewijzigd}`,
        `SEQUENCE:${icalSequence(s.updated_at)}`,
        `DTSTART;TZID=Europe/Brussels:${start}`,
        `DTEND;TZID=Europe/Brussels:${end}`,
        `SUMMARY:${summary}`,
      ];
      if (s.notes) lines.push(`DESCRIPTION:${icalEscape(s.notes)}`);
      lines.push('END:VEVENT');
      return lines.join('\r\n');
    });

    // #410: elke activiteit als eigen gebeurtenis binnen de dienst.
    //
    // De TITEL hangt af van een keuze die de medewerker zelf maakt. Standaard
    // staat er alleen het soort activiteit ("Vergadering", "Overleg"); wie zijn
    // omschrijvingen wil meesturen zet dat aan in zijn profiel. De feed heeft
    // geen login, en in dat veld staan in productie namen van jongeren, een
    // ziekenhuisbezoek en een kamernummer — dat hoort niet mee te gaan omdat
    // iemand anders dat ooit zo heeft ingesteld.
    const omschrijvingenMee = user.ical_omschrijvingen === true;

    // Het ijkpunt van de SEQUENCE schuift mee met het omzetten van die
    // schakelaar. Doe je dat niet, dan verandert de titel wel in de feed maar
    // blijft elke agenda staan op wat hij al had: de SEQUENCE van een
    // activiteit komt uit háár updated_at, en die beweegt niet als een
    // gebruiker zijn eigen voorkeur wijzigt. Dezelfde fout als #409, één laag
    // dieper.
    const voorkeurSeq = user.ical_voorkeur_gewijzigd
      ? icalSequence(user.ical_voorkeur_gewijzigd) : 1;

    const activiteitEvents = activiteitenResult.rows.map(a => {
      const dateStr = String(a.date).slice(0, 10);
      const van = String(a.start_time).slice(0, 5);
      const tot = String(a.end_time).slice(0, 5);
      const start = formatICalDateTime(dateStr, van);

      // Een activiteit die over middernacht loopt bestaat niet in de praktijk,
      // maar de kolommen laten het toe; dezelfde doorrol als bij een dienst.
      let eindDatum = dateStr;
      if (tot <= van) {
        const d = new Date(dateStr); d.setDate(d.getDate() + 1);
        eindDatum = formatDateYYYYMMDD(d);
      }
      const end = formatICalDateTime(eindDatum, tot);

      // Geen tweede lijstje met labels: `vergadering` wordt `Vergadering`.
      // Alle zes de types zijn één Nederlands woord, dus een hoofdletter
      // volstaat — en een lijstje dat uiteenloopt met de frontend is precies
      // de fout uit #400.
      const soort = String(a.type || '').charAt(0).toUpperCase() + String(a.type || '').slice(1);
      const titel = omschrijvingenMee && a.description ? a.description : (soort || 'Activiteit');

      const gewijzigdAct = icalUtcStempel(a.updated_at) || nu;
      const seq = Math.max(icalSequence(a.updated_at), voorkeurSeq);

      return [
        'BEGIN:VEVENT',
        `UID:activiteit-${a.id}@hetvlot`,
        `DTSTAMP:${gewijzigdAct}`,
        `LAST-MODIFIED:${gewijzigdAct}`,
        `SEQUENCE:${seq}`,
        `DTSTART;TZID=Europe/Brussels:${start}`,
        `DTEND;TZID=Europe/Brussels:${end}`,
        `SUMMARY:${icalEscape(titel)}`,
        'END:VEVENT',
      ].join('\r\n');
    });

    const events = dienstEvents.concat(activiteitEvents).join('\r\n');

    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Het Vlot//Roosterplanning//NL',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Rooster ${icalEscape(user.name)}`,
      'X-WR-TIMEZONE:Europe/Brussels',
      BRUSSELS_VTIMEZONE,
      events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(ical);
  } catch (err) {
    console.error('GET /calendar/:token.ics error:', err);
    res.status(500).send('Server error');
  }
});

router.put('/me/onboarding-flags', requireAuth, async (req, res) => {
  const flags = req.body;
  if (!flags || typeof flags !== 'object') {
    return res.status(400).json({ error: 'Body moet een object zijn met flags' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET onboarding_flags = COALESCE(onboarding_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2
       RETURNING onboarding_flags as "onboardingFlags"`,
      [JSON.stringify(flags), req.user.id]
    );
    res.json({ onboardingFlags: result.rows[0].onboardingFlags });
  } catch (err) {
    console.error('PUT /me/onboarding-flags error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
