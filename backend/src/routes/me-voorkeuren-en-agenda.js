// #157: e-mailvoorkeuren en de agendakoppeling, uit server.js gehaald. Ze
// staan samen omdat ze allebei over JOUW account gaan en in server.js ook al
// onder dezelfde kop stonden.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { formatDateYYYYMMDD, formatICalDateTime } = require('../utils');
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
        RETURNING id, name`,
      [req.params.token]
    );
    if (!userResult.rows.length) return res.status(404).send('Not found');
    const user = userResult.rows[0];

    const from = new Date(); from.setDate(from.getDate() - 30);
    const to   = new Date(); to.setDate(to.getDate() + 365);
    const [shiftsResult, teamsSettingResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.date::text, s.start_time, s.end_time, s.team, s.notes,
                t.name as team_name
         FROM shifts s
         LEFT JOIN teams t ON t.id = s.team
         WHERE s.user_id = $1 AND s.date >= $2 AND s.date <= $3
         ORDER BY s.date, s.start_time`,
        [user.id, formatDateYYYYMMDD(from), formatDateYYYYMMDD(to)]
      ),
      pool.query(`SELECT value FROM settings WHERE key = 'teams'`)
    ]);
    // settings.teams is the primary display name source (may differ from teams table)
    const teamNameMap = teamsSettingResult.rows.length ? teamsSettingResult.rows[0].value : {};

    const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

    const events = shiftsResult.rows.map(s => {
      const dateStr = s.date.slice(0, 10);
      const start = formatICalDateTime(dateStr, s.start_time);
      let endDate = dateStr;
      if (s.end_time <= s.start_time) {
        const d = new Date(dateStr); d.setDate(d.getDate() + 1);
        endDate = formatDateYYYYMMDD(d);
      }
      const end = formatICalDateTime(endDate, s.end_time);
      const summary = icalEscape((teamNameMap[s.team] && teamNameMap[s.team].name) || s.team_name || s.team || 'Shift');
      const lines = [
        'BEGIN:VEVENT',
        `UID:shift-${s.id}@hetvlot`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=Europe/Brussels:${start}`,
        `DTEND;TZID=Europe/Brussels:${end}`,
        `SUMMARY:${summary}`,
      ];
      if (s.notes) lines.push(`DESCRIPTION:${icalEscape(s.notes)}`);
      lines.push('END:VEVENT');
      return lines.join('\r\n');
    }).join('\r\n');

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
