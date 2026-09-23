// #157: beschikbaarheid en afwezigheid, uit server.js gehaald. De bulkroute
// voor een ziekmelding met automatische overname staat in dit bestand, want
// die hoort bij hetzelfde domein.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { formatDateYYYYMMDD } = require('../utils');
const emailService = require('../email');
const { AFWEZIGHEIDSTYPES, MAX_AFWEZIGHEIDSDAGEN, isGeldigAfwezigheidstype, isGeldigeDatumString } = require('../helpers/dienstregels');

const router = maakRouter();

router.get('/availability', requireAuth, async (req, res) => {
  const { startDate, endDate, userId } = req.query;
  try {
    // #219: dit endpoint gaf het vrije redenveld mee aan iedereen met een
    // login, over teamgrenzen heen en zonder datumgrens. Met het token van een
    // gewone medewerker leverde dat 77 rijen op waarvan nul van hemzelf,
    // inclusief de reden bij ziekmeldingen van andere teams.
    //
    // Dat iedereen ALLE teams ziet is een bewuste keuze (zie
    // getVisibleTeamsForRole: "Iedereen met een login kan alle teams zien in de
    // planner"), dus per team filteren zou de planning breken. Wat niet nodig
    // is, is de reden. Wie "operatie knie" of "burn-out" invult deelt dat
    // anders breder dan hij denkt, en ziektegegevens zijn bijzondere categorie
    // onder artikel 9 AVG.
    //
    // De reden blijft dus alleen zichtbaar voor de betrokkene zelf en voor wie
    // de planning beheert. De app toont bij een afwezigheid zonder reden gewoon
    // het type, dus er breekt niets.
    const magRedenenZien = ['admin', 'roosterverantwoordelijke'].includes(req.user.role);
    let query = `
      SELECT id, user_id as "userId", date::text as date, type, reason, updated_at as "updatedAt"
      FROM availability
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // #378: zonder datums gaf dit de VOLLEDIGE historiek terug, van iedereen,
    // sinds het begin. Bij elke pagina-load van elke gebruiker. Dat groeit mee
    // met de jaren en het is bovendien een patroon dat niet in de browser van
    // elke collega hoeft te liggen: wie was wanneer ziek, de afgelopen jaren.
    //
    // Een oproep zonder datums levert nu het lopende schooljaar op, ruim
    // genomen: een jaar terug tot een jaar vooruit. Wie meer nodig heeft,
    // zoals de backup, vraagt een expliciet bereik.
    const standaardVan = new Date(); standaardVan.setFullYear(standaardVan.getFullYear() - 1);
    const standaardTot = new Date(); standaardTot.setFullYear(standaardTot.getFullYear() + 1);
    const van = startDate && endDate ? startDate : formatDateYYYYMMDD(standaardVan);
    const tot = startDate && endDate ? endDate : formatDateYYYYMMDD(standaardTot);

    query += ` AND date >= $${paramIndex} AND date <= $${paramIndex + 1}`;
    params.push(van, tot);
    paramIndex += 2;

    if (userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(userId);
    }
    query += ' ORDER BY date';

    const result = await pool.query(query, params);
    const rijen = magRedenenZien
      ? result.rows
      : result.rows.map(r => (
          Number(r.userId) === Number(req.user.id) ? r : { ...r, reason: '' }
        ));
    res.json({ availability: rijen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/availability', requireAuth, async (req, res) => {
  const { userId, date, type, reason } = req.body || {};
  if (!userId || !date || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  if (!isGeldigAfwezigheidstype(type)) {
    return res.status(400).json({ error: `Onbekend type afwezigheid. Geldig zijn: ${AFWEZIGHEIDSTYPES.join(', ')}.` });
  }

  // Permission check for availability (skip team check if main_team column doesn't exist)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid registreren' });
  }


  try {
    // #203: dit is een upsert op (gebruiker, datum), dus een bestaande
    // registratie werd stilzwijgend vervangen. Wie ergens 'vrij' stond met
    // reden 'Vaste vrije dag' werd zonder melding 'ziek', het antwoord was
    // 201 Created voor wat in feite een overschrijving was, en de audit log
    // hield alleen de nieuwe waarde bij. Achteraf was dus niet meer na te gaan
    // wat er stond. Eén afwezigheid per persoon per dag blijft de regel, maar
    // de vervanging moet zichtbaar zijn en een spoor nalaten.
    //
    // De CTE leest de oude rij op de snapshot van vóór de insert, dus dit
    // blijft één atomaire opdracht.
    const result = await pool.query(`
      WITH vorige AS (
        SELECT type, reason FROM availability WHERE user_id = $1 AND date = $2::date
      )
      INSERT INTO availability (user_id, date, type, reason, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, date)
      DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
      RETURNING id, user_id as "userId", date::text as date, type, reason, updated_at as "updatedAt",
                (SELECT type FROM vorige) as "previousType",
                (SELECT reason FROM vorige) as "previousReason"
    `, [userId, date, type, reason || '']);

    const row = result.rows[0];
    const previousType = row.previousType;
    const wasOverwrite = previousType !== null && previousType !== undefined;
    const previous = wasOverwrite ? { type: previousType, reason: row.previousReason || '' } : null;

    const availability = {
      id: row.id, userId: row.userId, date: row.date,
      type: row.type, reason: row.reason, updatedAt: row.updatedAt
    };

    await logAudit(req, wasOverwrite ? 'UPDATE' : 'CREATE', 'availability', availability.id,
      wasOverwrite ? { availability, previous } : { availability });
    res.status(wasOverwrite ? 200 : 201).json({ availability, previous });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/availability', requireAuth, async (req, res) => {
  const { userId, date } = req.query;
  if (!userId || !date) {
    return res.status(400).json({ error: 'userId en date zijn verplicht' });
  }

  // Permission check (skip team check if main_team column doesn't exist)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid verwijderen' });
  }

  try {
    await pool.query(
      'DELETE FROM availability WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
    await logAudit(req, 'DELETE', 'availability', '', { userId, date });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== AVAILABILITY BULK WITH TAKEOVER (atomic transaction) =====

router.post('/availability/sick-with-takeover', requireAuth, async (req, res) => {
  const { userId, startDate, endDate, type, reason, createTakeoverRequests } = req.body || {};

  if (!userId || !startDate || !endDate || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken (userId, startDate, endDate, type)' });
  }
  if (!isGeldigAfwezigheidstype(type)) {
    return res.status(400).json({ error: `Onbekend type afwezigheid. Geldig zijn: ${AFWEZIGHEIDSTYPES.join(', ')}.` });
  }
  // #310: het bereik begrenzen vóór er iets gebeurt. De frontend houdt dit ook
  // tegen, maar de route is de plek waar het moet staan: hij is rechtstreeks
  // bereikbaar en de schade is blijvend.
  if (!isGeldigeDatumString(startDate) || !isGeldigeDatumString(endDate)) {
    return res.status(400).json({ error: 'Ongeldige datum. Gebruik JJJJ-MM-DD.' });
  }
  const aantalDagen = Math.round(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000
  ) + 1;
  if (aantalDagen < 1) {
    return res.status(400).json({ error: 'De einddatum ligt voor de startdatum.' });
  }
  if (aantalDagen > MAX_AFWEZIGHEIDSDAGEN) {
    return res.status(400).json({
      error: `Dit bereik beslaat ${aantalDagen} dagen. Maximaal ${MAX_AFWEZIGHEIDSDAGEN} dagen per registratie. Controleer of de einddatum klopt.`
    });
  }

  // Permission check (same logic as POST /availability)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid registreren' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Generate all dates in range
    const dates = [];
    const startParts = startDate.split('-').map(Number);
    const endParts = endDate.split('-').map(Number);
    let current = new Date(startParts[0], startParts[1] - 1, startParts[2]);
    const endObj = new Date(endParts[0], endParts[1] - 1, endParts[2]);

    while (current <= endObj) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(current.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${d}`);
      current.setDate(current.getDate() + 1);
    }

    if (dates.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Geen geldige datums in bereik' });
    }

    // #203: lees eerst wat er al staat, zodat een overschrijving niet
    // spoorloos is. Zie de toelichting bij POST /availability. Dit gebeurt in
    // dezelfde transactie, dus de waarden kloppen met wat er zo meteen
    // vervangen wordt.
    const vorigeResult = await client.query(
      `SELECT date::text as date, type, reason FROM availability
       WHERE user_id = $1 AND date = ANY($2::date[])`,
      [userId, dates]
    );
    const overwritten = vorigeResult.rows.filter(
      r => r.type !== type || (r.reason || '') !== (reason || '')
    );

    // 2. Upsert availability for each date
    // #310: één opdracht in plaats van een INSERT per dag. Bij het maximum van
    // MAX_AFWEZIGHEIDSDAGEN scheelt dat honderden heen-en-weertjes met de
    // database binnen dezelfde transactie.
    const upsertResult = await client.query(`
      INSERT INTO availability (user_id, date, type, reason, updated_at)
      SELECT $1, d::date, $3, $4, NOW() FROM unnest($2::date[]) AS d
      ON CONFLICT (user_id, date)
      DO UPDATE SET type = EXCLUDED.type, reason = EXCLUDED.reason, updated_at = NOW()
      RETURNING id, user_id as "userId", date::text as date, type, reason
    `, [userId, dates, type, reason || '']);
    const availability = upsertResult.rows.sort((a, b) => a.date.localeCompare(b.date));

    // 3. Optionally create takeover requests for conflicting shifts
    let takeoverCount = 0;
    const aangebodenShifts = [];
    let conflictingShiftCount = 0;

    if (createTakeoverRequests) {
      // Find shifts for this user on the affected dates
      const shiftsResult = await client.query(`
        SELECT id, user_id, date::text as date, start_time, end_time, team
        FROM shifts
        WHERE user_id = $1 AND date = ANY($2::date[])
        ORDER BY date, start_time
      `, [userId, dates]);

      conflictingShiftCount = shiftsResult.rows.length;

      // Filter: only create takeover for future shifts
      const now = new Date();
      now.setHours(0, 0, 0, 0);

      for (const shift of shiftsResult.rows) {
        const shiftDate = new Date(shift.date);
        if (shiftDate < now) continue;

        // Check if a pending takeover request already exists for this shift
        const existing = await client.query(
          `SELECT id FROM shift_swap_requests
           WHERE requester_shift_id = $1 AND request_type = 'takeover' AND status = 'pending'`,
          [shift.id]
        );
        if (existing.rows.length > 0) continue;

        const message = type === 'ziek'
          ? 'Ik ben ziek, wie kan mijn shift overnemen?'
          : 'Ik heb verlof, wie kan mijn shift overnemen?';

        await client.query(
          `INSERT INTO shift_swap_requests
           (requester_user_id, requester_shift_id, target_user_id, target_shift_id, request_type, message, status)
           VALUES ($1, $2, NULL, NULL, 'takeover', $3, 'pending')`,
          [userId, shift.id, message]
        );
        takeoverCount++;
        // #225: bijhouden wát er is aangeboden, zodat de collega's er straks
        // één samenvattende mail over kunnen krijgen.
        aangebodenShifts.push({
          date: shift.date, start_time: shift.start_time, end_time: shift.end_time, team: shift.team
        });
      }
    }

    await client.query('COMMIT');

    // Audit log (outside transaction)
    await logAudit(req, overwritten.length > 0 ? 'UPDATE' : 'CREATE', 'availability', '', {
      type: 'bulk_sick_with_takeover',
      userId, startDate, endDate, absenceType: type,
      daysCreated: dates.length,
      takeoverRequestsCreated: takeoverCount,
      conflictingShifts: conflictingShiftCount,
      overwritten
    });

    // #225: de collega's kregen niets. Alleen de beheerders werden verwittigd,
    // en bij verlof ging er helemaal geen mail uit. Precies op het moment
    // waarop er snel een vervanger nodig is hoorde niemand dat er diensten
    // openstonden.
    //
    // Eén samenvattende mail per persoon, niet één per dienst: een week ziekte
    // is al gauw vijf diensten.
    if (aangebodenShifts.length > 0) {
      (async () => {
        try {
          // #283: zie POST /shift-requests/takeover. Ook de samenvattende mail
          // bij een ziekmelding gaat nu naar iedereen.
          const teamLeden = await pool.query(
            `SELECT id, name, email, email_notifications_enabled FROM users
             WHERE active = true AND role != 'admin'`
          );
          const melder = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
          if (melder.rows[0] && teamLeden.rows.length > 0) {
            emailService.notifyTakeoverBatchAvailable(
              teamLeden.rows, melder.rows[0], aangebodenShifts, type
            );
          }
        } catch (e) { console.error('Email notification error (takeover batch):', e.message); }
      })();
    }

    // Email notification to managers (fire-and-forget)
    if (type === 'ziek') {
      (async () => {
        try {
          const mgrs = await pool.query(
            `SELECT id, name, email, email_notifications_enabled FROM users
             WHERE role IN ('admin', 'roosterverantwoordelijke') AND active = true`
          );
          const emp = await pool.query(
            'SELECT id, name, email FROM users WHERE id = $1', [userId]
          );
          if (emp.rows[0] && mgrs.rows.length > 0) {
            emailService.notifySickLeave(mgrs.rows, emp.rows[0], startDate, endDate, conflictingShiftCount);
          }
        } catch (e) { console.error('Email notification error:', e.message); }
      })();
    }

    res.status(201).json({
      availability,
      takeoverRequests: takeoverCount,
      conflictingShifts: conflictingShiftCount,
      overwritten
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /availability/sick-with-takeover error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
