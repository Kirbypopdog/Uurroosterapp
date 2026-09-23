// #157: de verlofplanning, uit server.js gehaald. Twaalf endpoints, en het
// grootste domein na de diensten zelf. Alles wat deze routes nodig hebben is
// hier ook alleen nodig, dus het verhuist mee.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

const LEAVE_MANAGER_ROLES = ['admin', 'roosterverantwoordelijke'];

// Gesloten dagen van een verlofblok. De frontend leidt ze af uit het
// vakantieconcept en stuurt ze mee; hier controleren we enkel dat het
// geldige datums binnen het blok zijn. `undefined`/`null` blijft "onbekend".

const isLeaveManager = (user) => LEAVE_MANAGER_ROLES.includes(user?.role);

/**
 * Zegt of dit account verlof mag invullen en indienen voor zichzelf.
 *
 * #309: het adminaccount is in deze app geen roostermedewerker. De matrix, de
 * goedkeurlijst en het verdeelscherm bouwen hun lijst met getAllEmployees(true)
 * en die filtert admins weg. Een admin kon toch invullen en indienen, maar zijn
 * indiening kwam nooit in de lijst 'te beoordelen', kon dus niet goedgekeurd
 * worden, en apply sloeg hem over omdat `approved IS TRUE` nooit waar werd.
 * Wat overbleef was een account dat eindeloos 'Je hebt al ingediend' te zien
 * kreeg zonder dat er ooit iets gebeurde.
 *
 * Een beheerder die wél meedraait in het rooster heeft de rol
 * roosterverantwoordelijke; voor die rol werkt de hele keten correct.
 */

const isRoosterMedewerker = (rol) => rol !== 'admin';

// Kolommen van een ronde. De alias is nodig zodra er gejoind wordt: zowel
// leave_rounds als leave_round_submissions hebben een kolom `id`.

function normalizeClosedDates(waarde, startDate, endDate, blokNaam) {
  if (waarde === undefined || waarde === null) return { ok: true, value: null };
  if (!Array.isArray(waarde)) {
    return { ok: false, error: `Gesloten dagen bij "${blokNaam}" moeten een lijst zijn` };
  }
  const uniek = new Set();
  for (const d of waarde) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { ok: false, error: `Ongeldige gesloten dag bij "${blokNaam}"` };
    }
    if (d < startDate || d > endDate) {
      return { ok: false, error: `Gesloten dag ${d} valt buiten "${blokNaam}"` };
    }
    uniek.add(d);
  }
  return { ok: true, value: [...uniek].sort() };
}

const roundSelect = (a = '') => {
  const p = a ? `${a}.` : '';
  return `
  ${p}id, ${p}name, ${p}mode, ${p}start_date::text AS "startDate", ${p}end_date::text AS "endDate",
  ${p}deadline::text AS deadline, ${p}status, ${p}holiday_period_id AS "holidayPeriodId",
  ${p}rules, ${p}created_by AS "createdBy", ${p}created_at AS "createdAt", ${p}updated_at AS "updatedAt"`;
};

const ROUND_SELECT = roundSelect();

// Alle rondes (iedereen mag ze zien; concepten enkel voor beheerders).
// Bevat meteen wat de overzichtskaarten nodig hebben, zodat die niet elke
// ronde apart hoeven op te halen.

// Vervangt de gedeelde Excel. Twee modi:
//   'binair'   → kleine vakanties: werken / verlof
//   'voorkeur' → zomer: werken / liever_niet / zeker_niet
// De matrix is voor iedereen zichtbaar (zoals de gedeelde Excel), maar
// invullen mag je enkel voor jezelf — tenzij je de ronde beheert.

router.get('/leave-rounds', requireAuth, async (req, res) => {
  try {
    const showConcepts = isLeaveManager(req.user);
    const result = await pool.query(
      `SELECT ${roundSelect('r')},
              (SELECT COUNT(*) FROM leave_round_blocks b WHERE b.round_id = r.id)::int AS "blockCount",
              (SELECT COUNT(*) FROM leave_round_submissions s
                WHERE s.round_id = r.id AND s.submitted_at IS NOT NULL)::int AS "submittedCount",
              ms.submitted_at AS "mySubmittedAt",
              ms.approved     AS "myApproved"
       FROM leave_rounds r
       LEFT JOIN leave_round_submissions ms ON ms.round_id = r.id AND ms.user_id = $1
       ${showConcepts ? '' : `WHERE r.status <> 'concept'`}
       ORDER BY r.start_date DESC`,
      [req.user.id]
    );
    res.json({ rounds: result.rows });
  } catch (err) {
    console.error('Error fetching leave rounds:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Eén ronde met de volledige matrix (alle medewerkers) + indienstatus
router.get('/leave-rounds/:id', requireAuth, async (req, res) => {
  try {
    const roundRes = await pool.query(`SELECT ${ROUND_SELECT} FROM leave_rounds WHERE id = $1`, [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    const round = roundRes.rows[0];
    if (round.status === 'concept' && !isLeaveManager(req.user)) {
      return res.status(403).json({ error: 'Deze ronde is nog niet geopend' });
    }

    const [entries, subs, blocks] = await Promise.all([
      pool.query(
        `SELECT user_id AS "userId", date::text AS date, status,
                COALESCE(requested_status, status) AS "requestedStatus", note
         FROM leave_round_entries WHERE round_id = $1`, [req.params.id]),
      pool.query(
        `SELECT s.user_id AS "userId", s.submitted_at AS "submittedAt", s.approved,
                s.approved_by AS "approvedBy", s.approved_at AS "approvedAt",
                s.response_note AS "responseNote", u.name AS "userName"
         FROM leave_round_submissions s JOIN users u ON u.id = s.user_id
         WHERE s.round_id = $1`, [req.params.id]),
      pool.query(
        `SELECT id, name, mode, start_date::text AS "startDate", end_date::text AS "endDate",
                holiday_period_id AS "holidayPeriodId", sort_order AS "sortOrder",
                closed_dates AS "closedDates", closed_source AS "closedSource"
         FROM leave_round_blocks WHERE round_id = $1 ORDER BY sort_order, start_date`, [req.params.id]),
    ]);
    res.json({ round, blocks: blocks.rows, entries: entries.rows, submissions: subs.rows });
  } catch (err) {
    console.error('Error fetching leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Een ronde wordt aangemaakt mét zijn blokken (de vakanties van het
// schooljaar). De ronde-datums zijn de omhullende van die blokken.
router.post('/leave-rounds', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { name, deadline, rules, status, blocks } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: 'Kies minstens één vakantieperiode' });
  }
  for (const b of blocks) {
    if (!b || !b.name || !b.startDate || !b.endDate) {
      return res.status(400).json({ error: 'Elk blok heeft een naam, start- en einddatum nodig' });
    }
    if (b.mode && !['binair', 'voorkeur'].includes(b.mode)) {
      return res.status(400).json({ error: 'Ongeldige modus' });
    }
    if (new Date(b.endDate) < new Date(b.startDate)) {
      return res.status(400).json({ error: `Einddatum ligt voor de startdatum bij "${b.name}"` });
    }
    const cd = normalizeClosedDates(b.closedDates, b.startDate, b.endDate, b.name);
    if (!cd.ok) return res.status(400).json({ error: cd.error });
    b._closedDates = cd.value;
  }

  const startDate = blocks.reduce((m, b) => (b.startDate < m ? b.startDate : m), blocks[0].startDate);
  const endDate   = blocks.reduce((m, b) => (b.endDate   > m ? b.endDate   : m), blocks[0].endDate);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO leave_rounds (name, mode, start_date, end_date, deadline, status, rules, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING ${ROUND_SELECT}`,
      [name, blocks[0].mode || 'binair', startDate, endDate, deadline || null,
       status === 'concept' ? 'concept' : 'open', JSON.stringify(rules || {}), req.user.id]
    );
    const round = result.rows[0];
    let i = 0;
    for (const b of blocks) {
      await client.query(
        `INSERT INTO leave_round_blocks (round_id, name, mode, start_date, end_date, holiday_period_id, sort_order, closed_dates, closed_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
        [round.id, b.name, b.mode || 'binair', b.startDate, b.endDate, b.holidayPeriodId || null, i++,
         b._closedDates === null ? null : JSON.stringify(b._closedDates),
         JSON.stringify(b._closedDates === null ? {} : (b.closedSource || {}))]
      );
    }
    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'settings', String(round.id), { type: 'leave_round', name, blocks: blocks.length });
    res.json({ round });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error creating leave round:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.put('/leave-rounds/:id', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { name, mode, startDate, endDate, deadline, status, holidayPeriodId, rules,
          clearDeadline } = req.body || {};
  if (status && !['concept', 'open', 'gesloten', 'toegepast'].includes(status)) {
    return res.status(400).json({ error: 'Ongeldige status' });
  }
  try {
    // #386: hier werd alleen getoetst of de nieuwe status bestond, niet of de
    // overgang zinnig was. Een toegepaste ronde kon terug open, waarna iemand
    // zijn invulling wijzigde terwijl zijn verlof al in de planning stond. De
    // afstemming uit #384 draait alleen bij apply, en die wordt dan nooit meer
    // aangeroepen: er was geen enkel pad dat dit vanzelf rechttrok.
    //
    // Alleen wég van 'toegepast' is verboden. Een ronde die per ongeluk
    // gesloten is terug openen blijft gewoon mogelijk, en een fout in een
    // toegepaste ronde herstel je zonder heropenen: het verdeelendpoint werkt
    // bij 'toegepast' (#201) en apply stemt af (#384).
    const huidige = await pool.query('SELECT status, id FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (huidige.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    if (huidige.rows[0].status === 'toegepast' && status && status !== 'toegepast') {
      return res.status(409).json({
        error: 'Deze ronde is al toegepast. Het verlof staat in de planning, dus heropenen zou de ronde en de planning uit elkaar laten lopen. Pas de verdeling aan en pas opnieuw toe.',
        status: 'toegepast'
      });
    }

    // #386: de omhullende datums zijn afgeleid, geen invoer. Bij het aanmaken
    // worden ze berekend uit de blokken; via deze PUT konden ze losgemaakt
    // worden van diezelfde blokken. Ze volgen nu altijd de blokken, en alleen
    // een ronde zonder blokken valt terug op wat de aanvraag meestuurt.
    const omhullend = await pool.query(
      `SELECT MIN(start_date)::text AS "startDate", MAX(end_date)::text AS "endDate"
         FROM leave_round_blocks WHERE round_id = $1`, [req.params.id]);
    const afgeleid = omhullend.rows[0] || {};
    const nieuweStart = afgeleid.startDate || startDate || null;
    const nieuwEind   = afgeleid.endDate   || endDate   || null;
    // #280: deadline stond hier als enige veld zonder COALESCE, dus elke PUT
    // zonder deadline in de body zette de kolom op NULL. Het sluiten van een
    // ronde stuurt enkel {status:'gesloten'} en wiste zo de indiendatum,
    // precies op het moment dat je hem nodig hebt om na te gaan wie te laat
    // was. Leegmaken kan nog wel, maar dan expliciet via clearDeadline.
    const result = await pool.query(
      `UPDATE leave_rounds SET
         name = COALESCE($2, name), mode = COALESCE($3, mode),
         start_date = COALESCE($4, start_date), end_date = COALESCE($5, end_date),
         deadline = CASE WHEN $10 THEN NULL ELSE COALESCE($6, deadline) END,
         status = COALESCE($7, status),
         holiday_period_id = COALESCE($8, holiday_period_id),
         rules = COALESCE($9::jsonb, rules), updated_at = NOW()
       WHERE id = $1 RETURNING ${ROUND_SELECT}`,
      [req.params.id, name || null, mode || null, nieuweStart, nieuwEind,
       deadline || null, status || null, holidayPeriodId || null,
       rules ? JSON.stringify(rules) : null, clearDeadline === true]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    await logAudit(req, 'UPDATE', 'settings', req.params.id, { type: 'leave_round', status });
    res.json({ round: result.rows[0] });
  } catch (err) {
    console.error('Error updating leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Weekends van één blok opnieuw overnemen uit het roosterconcept. Bewust een
// aparte, expliciete actie: een concept dat na het openen van de ronde wijzigt
// mag de grondslag waarop mensen invulden niet stilzwijgend verschuiven.
router.put('/leave-rounds/:id/blocks/:blockId', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { closedDates, closedSource } = req.body || {};
  const client = await pool.connect();
  try {
    const blokRes = await client.query(
      `SELECT b.id, b.name, b.start_date::text AS "startDate", b.end_date::text AS "endDate",
              b.closed_dates AS "closedDates", r.status
       FROM leave_round_blocks b JOIN leave_rounds r ON r.id = b.round_id
       WHERE b.id = $1 AND b.round_id = $2`,
      [req.params.blockId, req.params.id]
    );
    if (blokRes.rows.length === 0) return res.status(404).json({ error: 'Blok niet gevonden in deze ronde' });
    const blok = blokRes.rows[0];

    // Een gesloten of toegepaste ronde herschrijven raakt afspraken die al
    // goedgekeurd zijn — dat mag alleen bewust.
    if (['gesloten', 'toegepast'].includes(blok.status) && req.query.force !== '1') {
      return res.status(409).json({
        error: 'Deze ronde is al gesloten. Bevestig dat je de weekendindeling toch wil aanpassen.',
        status: blok.status
      });
    }

    const cd = normalizeClosedDates(closedDates, blok.startDate, blok.endDate, blok.name);
    if (!cd.ok) return res.status(400).json({ error: cd.error });

    await client.query('BEGIN');
    await client.query(
      `UPDATE leave_round_blocks SET closed_dates = $1::jsonb, closed_source = $2::jsonb WHERE id = $3`,
      [cd.value === null ? null : JSON.stringify(cd.value),
       JSON.stringify(cd.value === null ? {} : (closedSource || {})), blok.id]
    );

    // Invulling op een dag die nu gesloten is moet weg: anders zet `apply`
    // daar alsnog verlof op, en telt die dag mee in latere weekendtellingen.
    let entriesRemoved = 0;
    if (cd.value && cd.value.length > 0) {
      const del = await client.query(
        `DELETE FROM leave_round_entries WHERE round_id = $1 AND date = ANY($2::date[])`,
        [req.params.id, cd.value]
      );
      entriesRemoved = del.rowCount || 0;
    }
    await client.query('COMMIT');

    await logAudit(req, 'UPDATE', 'settings', String(req.params.id), {
      type: 'leave_block_closed_dates', blockId: blok.id,
      closed: cd.value ? cd.value.length : null, entriesRemoved
    });
    res.json({ block: { id: blok.id, closedDates: cd.value, closedSource: closedSource || {} }, entriesRemoved });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating leave block:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// De definitieve verdeling van een voorkeurblok (de zomer) vastleggen.
//
// Bewust NIET via PUT /leave-rounds/:id/entries: dat vervangt alle entries van
// een gebruiker in de héle ronde, en een ronde beslaat het volledige schooljaar.
// Dit endpoint blijft binnen één blok en raakt de kleine vakanties dus nooit.
router.put('/leave-rounds/:id/blocks/:blockId/entries', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries moet een array zijn' });

  const client = await pool.connect();
  try {
    const blokRes = await client.query(
      `SELECT b.id, b.name, b.start_date::text AS "startDate", b.end_date::text AS "endDate",
              b.closed_dates AS "closedDates", r.status
       FROM leave_round_blocks b JOIN leave_rounds r ON r.id = b.round_id
       WHERE b.id = $1 AND b.round_id = $2`,
      [req.params.blockId, req.params.id]
    );
    if (blokRes.rows.length === 0) return res.status(404).json({ error: 'Blok niet gevonden in deze ronde' });
    const blok = blokRes.rows[0];

    // Bij een open ronde kunnen medewerkers hun invulling nog wijzigen; een
    // verdeling zou dan stil overschreven worden.
    //
    // #201: 'toegepast' hoort hier ook bij. Die reden geldt daar namelijk net
    // zo min als bij 'gesloten', want de ronde staat voor medewerkers dicht.
    // Wie per ongeluk toepaste vóór het verdelen, liep anders vast: de
    // verdeling werd geweigerd met een 409 en er was geen weg vooruit. Nu kan
    // hij alsnog verdelen en daarna opnieuw toepassen.
    if (blok.status !== 'gesloten' && blok.status !== 'toegepast') {
      return res.status(409).json({
        error: 'De verdeling kan pas vastgelegd worden als de ronde gesloten is',
        status: blok.status
      });
    }

    const valid = ['werken', 'verlof', 'liever_niet', 'zeker_niet'];
    const userIds = new Set();
    for (const e of entries) {
      if (!e || !Number.isInteger(Number(e.userId))) {
        return res.status(400).json({ error: 'Elke regel heeft een geldige userId nodig' });
      }
      if (typeof e.date !== 'string' || e.date < blok.startDate || e.date > blok.endDate) {
        return res.status(400).json({ error: `Datum ${e.date} valt buiten "${blok.name}"` });
      }
      if (!valid.includes(e.status)) {
        return res.status(400).json({ error: `Ongeldige status ${e.status}` });
      }
      userIds.add(Number(e.userId));
    }

    // #306: ook hier geen verlof op een dag waarop het huis dicht is. De
    // verdeling wordt door een beheerder vastgelegd, dus dit is eerder een
    // vergissing dan een verouderd scherm, maar het resultaat zou hetzelfde
    // zijn: apply zet er verlof op en niemand ziet het.
    const geslotenDagen = new Set(Array.isArray(blok.closedDates) ? blok.closedDates : []);
    const teBewaren = entries.filter(e => !geslotenDagen.has(e.date));
    const overgeslagen = entries.length - teBewaren.length;

    await client.query('BEGIN');
    if (userIds.size > 0) {
      // #377: de DELETE hieronder gooit de rijen weg en daarmee ook wat de
      // medewerker oorspronkelijk vroeg. Die waarde wordt eerst opgehaald en
      // bij het opnieuw invoegen meegegeven, zodat het verdeelscherm na het
      // vastleggen nog steeds kan tonen wie "zeker niet" zei en wie alleen
      // "liever niet". Staat er nog geen rij, dan vroeg die persoon niets en
      // blijft requested_status leeg: een lege cel is eerlijker dan doen alsof
      // hij om dit verlof gevraagd heeft.
      const vorige = await client.query(
        `SELECT user_id, date::text AS date, COALESCE(requested_status, status) AS gevraagd
         FROM leave_round_entries
         WHERE round_id = $1 AND user_id = ANY($2::int[]) AND date BETWEEN $3 AND $4`,
        [req.params.id, [...userIds], blok.startDate, blok.endDate]
      );
      const gevraagd = new Map();
      vorige.rows.forEach(r => gevraagd.set(`${r.user_id}|${r.date}`, r.gevraagd));

      await client.query(
        `DELETE FROM leave_round_entries
         WHERE round_id = $1 AND user_id = ANY($2::int[]) AND date BETWEEN $3 AND $4`,
        [req.params.id, [...userIds], blok.startDate, blok.endDate]
      );
      // #334: dit was één INSERT per medewerker per dag. Bij 40 medewerkers
      // maal circa 62 zomerdagen zijn dat ruim 2.400 losse opdrachten, en op
      // Render komt daar per stuk retourtijd bij. Nu één opdracht, met unnest
      // om onder de bindparameterlimiet te blijven (zie apply hieronder).
      if (teBewaren.length > 0) {
        await client.query(
          `INSERT INTO leave_round_entries (round_id, user_id, date, status, requested_status)
           SELECT $1, u, d::date, st, rs
           FROM unnest($2::int[], $3::date[], $4::text[], $5::text[]) AS t(u, d, st, rs)`,
          [
            req.params.id,
            teBewaren.map(e => Number(e.userId)),
            teBewaren.map(e => e.date),
            teBewaren.map(e => e.status),
            teBewaren.map(e => gevraagd.get(`${Number(e.userId)}|${e.date}`) ?? null)
          ]
        );
      }
    }
    await client.query('COMMIT');

    await logAudit(req, 'UPDATE', 'settings', String(req.params.id), {
      type: 'leave_block_verdeling', blockId: blok.id,
      medewerkers: userIds.size, dagen: teBewaren.length, overgeslagen
    });
    res.json({ ok: true, saved: teBewaren.length, medewerkers: userIds.size, overgeslagen });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error saving leave distribution:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.delete('/leave-rounds/:id', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM leave_rounds WHERE id = $1 RETURNING name', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    await logAudit(req, 'DELETE', 'settings', req.params.id, { type: 'leave_round', name: result.rows[0].name });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Invulling opslaan. Medewerkers enkel voor zichzelf; beheerders ook voor
// anderen (nodig om na een voorkeurronde de definitieve verdeling vast te leggen).
router.put('/leave-rounds/:id/entries', requireAuth, async (req, res) => {
  const { entries, userId } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries moet een array zijn' });

  const targetUserId = userId && isLeaveManager(req.user) ? Number(userId) : req.user.id;
  if (userId && Number(userId) !== req.user.id && !isLeaveManager(req.user)) {
    return res.status(403).json({ error: 'Je kan enkel je eigen verlof invullen' });
  }

  const client = await pool.connect();
  try {
    // #309: een adminaccount draait niet mee in het rooster, dus invulling voor
    // dat account leidt nergens toe. Dit geldt ook wanneer een beheerder het
    // voor iemand anders doet, want de doelgebruiker kan zelf een admin zijn.
    const doelRes = await client.query('SELECT role FROM users WHERE id = $1', [targetUserId]);
    if (doelRes.rows.length === 0) {
      return res.status(404).json({ error: 'Medewerker niet gevonden' });
    }
    if (!isRoosterMedewerker(doelRes.rows[0].role)) {
      return res.status(403).json({
        error: 'Een beheeraccount draait niet mee in het rooster en kan geen verlof invullen.'
      });
    }

    const roundRes = await client.query('SELECT status, start_date, end_date FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    const round = roundRes.rows[0];
    // Een gesloten ronde is enkel nog door beheerders aan te passen
    if (round.status !== 'open' && !isLeaveManager(req.user)) {
      return res.status(403).json({ error: 'Deze ronde is gesloten' });
    }

    const valid = ['werken', 'verlof', 'liever_niet', 'zeker_niet'];
    // Een ronde beslaat een heel schooljaar met gaten ertussen (schoolweken).
    // Een dag moet dus binnen een van de vakantieblokken vallen, niet enkel
    // tussen de omhullende rondedatums.
    const blockRes = await client.query(
      'SELECT start_date, end_date, closed_dates AS "closedDates" FROM leave_round_blocks WHERE round_id = $1',
      [req.params.id]);
    const blokken = blockRes.rows.length
      ? blockRes.rows.map(b => [new Date(b.start_date), new Date(b.end_date)])
      : [[new Date(round.start_date), new Date(round.end_date)]];

    // #306: dit keek alleen of een datum binnen een blok viel, niet of die dag
    // gesloten is. Dat botste met de resync, die invulling op nieuw gesloten
    // dagen juist wél weghaalt "anders zet apply daar alsnog verlof op". Wie de
    // verlofpagina open had staan toen een beheerder de gesloten dagen
    // bijwerkte, stuurde die dagen bij de volgende opslag gewoon terug, en in
    // de matrix was dat onzichtbaar omdat een gesloten cel apart getekend wordt.
    const geslotenDagen = new Set(
      blockRes.rows.flatMap(b => Array.isArray(b.closedDates) ? b.closedDates : [])
    );

    for (const e of entries) {
      if (!e || !e.date || !valid.includes(e.status)) {
        return res.status(400).json({ error: `Ongeldige invulling voor ${e && e.date}` });
      }
      const d = new Date(e.date);
      if (!blokken.some(([s, t]) => d >= s && d <= t)) {
        return res.status(400).json({ error: `Datum ${e.date} valt buiten de ronde` });
      }
    }

    // Stil overslaan in plaats van weigeren: het verzoek komt van een scherm dat
    // een paar minuten oud is, en de rest van die week hoort gewoon bewaard te
    // worden. Het aantal gaat wel mee terug, zodat de app het kan melden.
    const teBewaren = entries.filter(e => !geslotenDagen.has(e.date));
    const overgeslagen = entries.length - teBewaren.length;

    await client.query('BEGIN');

    // #194: dit verving ALLE invulling van deze medewerker in de hele ronde,
    // ook die van vakanties waar de aanvraag niet over ging. De app stuurt
    // altijd de volledige ronde mee, dus via de knoppen ging er niets verloren,
    // maar elke andere aanroep kon iemands zomervoorkeuren wissen door één
    // kerstweek op te slaan. Het blok-scoped endpoint begrenst wel al netjes.
    //
    // De vervanging blijft nu binnen het bereik dat in de aanvraag zit. Een
    // lege lijst raakt dus niets aan, wat ook de eerdere fix bewaart dat leeg
    // indienen de invulling niet mag wissen.
    // #306: het bereik komt bewust uit ALLE aangeleverde datums, ook de gesloten.
    // Staat er nog een oude rij op een dag die intussen dicht is, dan hoort die
    // hier weg; hij wordt alleen niet opnieuw ingevoegd.
    const datums = entries.map(e => e.date).sort();
    if (datums.length > 0) {
      await client.query(
        `DELETE FROM leave_round_entries
         WHERE round_id = $1 AND user_id = $2 AND date BETWEEN $3 AND $4`,
        [req.params.id, targetUserId, datums[0], datums[datums.length - 1]]
      );
    }

    for (const e of teBewaren) {
      // #377: hier wordt de wens uitgesproken, dus gevraagd en geldend zijn
      // hetzelfde. Alleen het verdeelendpoint laat ze daarna uiteenlopen.
      await client.query(
        `INSERT INTO leave_round_entries (round_id, user_id, date, status, requested_status, note)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [req.params.id, targetUserId, e.date, e.status, e.note || '']
      );
    }

    // #194: een wijziging ná de goedkeuring liet die goedkeuring gewoon staan,
    // met de oorspronkelijke datum. De beheerder zag in het overzicht nog
    // altijd "goedgekeurd" zonder enig signaal dat er daarna iets veranderd
    // was, en apply nam over wat er op dat moment stond.
    //
    // Elke wijziging trekt de goedkeuring nu in, precies zoals submit dat al
    // deed. De medewerker moet dus opnieuw indienen en de beheerder opnieuw
    // beslissen. Een beheerder die voor iemand anders invult raakt zijn eigen
    // goedkeuring niet kwijt, want targetUserId bepaalt wiens rij het is.
    await client.query(
      `INSERT INTO leave_round_submissions (round_id, user_id) VALUES ($1, $2)
       ON CONFLICT (round_id, user_id)
       DO UPDATE SET approved = NULL, approved_by = NULL, approved_at = NULL`,
      [req.params.id, targetUserId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, saved: teBewaren.length, overgeslagen });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error saving leave entries:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Indienen (medewerker bevestigt zijn invulling)
router.post('/leave-rounds/:id/submit', requireAuth, async (req, res) => {
  try {
    // #309: zie de toelichting bij isRoosterMedewerker. Indienen met een
    // adminaccount leverde een indiening op die nergens terechtkwam.
    if (!isRoosterMedewerker(req.user.role)) {
      return res.status(403).json({
        error: 'Een beheeraccount draait niet mee in het rooster en kan geen verlof indienen.'
      });
    }

    const roundRes = await pool.query('SELECT status FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    if (roundRes.rows[0].status !== 'open') return res.status(403).json({ error: 'Deze ronde is gesloten' });

    await pool.query(
      `INSERT INTO leave_round_submissions (round_id, user_id, submitted_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (round_id, user_id)
       DO UPDATE SET submitted_at = NOW(), approved = NULL, approved_by = NULL, approved_at = NULL`,
      [req.params.id, req.user.id]
    );
    await logAudit(req, 'UPDATE', 'settings', req.params.id, { type: 'leave_round_submit' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error submitting leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Goedkeuren of afwijzen van één medewerker binnen een ronde
router.put('/leave-rounds/:id/submissions/:userId', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { approved, responseNote } = req.body || {};
  if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved moet true of false zijn' });
  try {
    const result = await pool.query(
      `INSERT INTO leave_round_submissions (round_id, user_id, approved, approved_by, approved_at, response_note)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (round_id, user_id)
       DO UPDATE SET approved = $3, approved_by = $4, approved_at = NOW(), response_note = $5
       RETURNING user_id AS "userId", approved`,
      [req.params.id, req.params.userId, approved, req.user.id, responseNote || '']
    );
    await logAudit(req, approved ? 'APPROVE' : 'REJECT', 'settings', req.params.id,
      { type: 'leave_round', targetUser: req.params.userId });
    res.json({ submission: result.rows[0] });
  } catch (err) {
    console.error('Error updating leave submission:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toepassen: goedgekeurd verlof wordt echte afwezigheid, zodat het in de
// planning en het afwezigheidsoverzicht verschijnt.
router.post('/leave-rounds/:id/apply', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const client = await pool.connect();
  try {
    const roundRes = await client.query('SELECT name, status FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    const roundName = roundRes.rows[0].name;

    // #385: de status werd hier nergens getoetst. Een ronde die nog openstaat
    // kon dus toegepast worden: half ingevulde voorkeuren werden echte
    // afwezigheden, en de sprong naar 'toegepast' sloot iedereen buiten die
    // nog bezig was. De knop verschijnt alleen bij 'gesloten' en 'toegepast',
    // dus via het scherm kwam je er niet, maar de controle hoort aan beide
    // kanten te staan. Bij een voorkeurronde ving de onverdeeld-controle
    // hieronder dit toevallig op; bij een binaire ronde ving niets het op.
    //
    // 'toegepast' hoort er bewust bij: opnieuw toepassen na een herziene
    // verdeling is precies wat #384 mogelijk moet houden.
    if (roundRes.rows[0].status !== 'gesloten' && roundRes.rows[0].status !== 'toegepast') {
      return res.status(409).json({
        error: 'Sluit de ronde eerst. Zolang ze openstaat is iedereen nog aan het invullen.',
        status: roundRes.rows[0].status
      });
    }

    // #201: apply neemt alleen dagen met status 'verlof' over, maar in een
    // voorkeurblok staat op dat moment uitsluitend werken, liever_niet of
    // zeker_niet. Wie op 'Verlof toepassen' drukte vóór 'Verlof verdelen',
    // kreeg dus nul zomerdagen terwijl de melding als succes las, en beide
    // knoppen verdwenen omdat die alleen bij status 'gesloten' verschijnen.
    //
    // We weigeren nu zolang een voorkeurblok nog niets op 'verlof' heeft
    // staan. Een blok waarin niemand verlof kreeg is ononderscheidbaar van
    // een onverdeeld blok, maar dat is een randgeval dat in de praktijk niet
    // voorkomt: er wordt altijd iemand ingewilligd.
    const onverdeeld = await client.query(
      `SELECT b.id, b.name
         FROM leave_round_blocks b
        WHERE b.round_id = $1
          AND b.mode = 'voorkeur'
          AND NOT EXISTS (
            SELECT 1 FROM leave_round_entries e
             WHERE e.round_id = b.round_id
               AND e.status = 'verlof'
               AND e.date BETWEEN b.start_date AND b.end_date
          )`,
      [req.params.id]
    );
    if (onverdeeld.rows.length > 0) {
      const namen = onverdeeld.rows.map(b => b.name).join(', ');
      return res.status(409).json({
        error: `Leg eerst de verdeling vast voor: ${namen}. Zonder verdeling levert het toepassen voor die vakantie geen enkele verlofdag op.`,
        undistributedBlocks: onverdeeld.rows.map(b => ({ id: b.id, name: b.name }))
      });
    }

    // Enkel dagen met status 'verlof' van goedgekeurde medewerkers
    const rows = await client.query(
      `SELECT e.user_id, e.date::text AS date
       FROM leave_round_entries e
       JOIN leave_round_submissions s
         ON s.round_id = e.round_id AND s.user_id = e.user_id
       WHERE e.round_id = $1 AND e.status = 'verlof' AND s.approved IS TRUE`,
      [req.params.id]
    );

    const reden = `Verlofplanning: ${roundName}`;

    await client.query('BEGIN');
    // #334: dit schreef rij voor rij weg, bij een volledige zomerronde zo'n
    // 1.200 losse INSERTs binnen één transactie. Nu één opdracht.
    //
    // Bewust met unnest en niet met een VALUES-lijst van duizend rijen: een
    // VALUES-lijst bindt twee parameters per rij en loopt bij een groot
    // schooljaar tegen de Postgres-limiet van 65.535 bindparameters aan. Met
    // unnest zijn het er altijd drie, hoeveel dagen het ook zijn, en is
    // chunking dus niet nodig.
    const applied = rows.rows.length;
    if (applied > 0) {
      await client.query(
        `INSERT INTO availability (user_id, date, type, reason, updated_at)
         SELECT u, d::date, 'verlof', $3, NOW()
         FROM unnest($1::int[], $2::date[]) AS t(u, d)
         ON CONFLICT (user_id, date)
         DO UPDATE SET type = 'verlof', reason = EXCLUDED.reason, updated_at = NOW()`,
        [rows.rows.map(r => r.user_id), rows.rows.map(r => r.date), reden]
      );
    }

    // #384: apply voegde alleen toe en haalde nooit iets weg. Wie een
    // verdeling herzag en opnieuw toepaste, hield het oude verlof ernaast
    // staan: de ronde zei dat alleen Bram vrij was, de planning zette Anna én
    // Bram vrij. Het verlofscherm toonde intussen de juiste toestand, dus er
    // was geen enkel signaal dat er iets fout zat.
    //
    // We ruimen dus op binnen de blokken van deze ronde. Drie voorwaarden
    // bakenen af wat van ons is:
    //  - `reason = reden`, en die tekst wordt op precies één plek geschreven,
    //    namelijk de INSERT hierboven. Zet iemand die dag op ziek, dan
    //    verandert de reden mee en blijft de rij dus staan.
    //  - binnen een blok van deze ronde, zodat een andere vakantie niet
    //    geraakt wordt.
    //  - niet in de lijst die we net toegepast hebben.
    //
    // Bekende grens: wordt de ronde tussen twee keer toepassen hernoemd, dan
    // wijst `reden` naar de nieuwe naam en blijven de oude rijen staan. Dat is
    // het gedrag van vóór deze fix, dus geen achteruitgang. Waterdicht zou een
    // kolom source_round_id op availability zijn, en dat is een migratie waard.
    const opgeruimd = await client.query(
      `DELETE FROM availability a
        USING leave_round_blocks b
        WHERE b.round_id = $1
          AND a.date BETWEEN b.start_date AND b.end_date
          AND a.type = 'verlof'
          AND a.reason = $2
          AND NOT EXISTS (
            SELECT 1 FROM unnest($3::int[], $4::date[]) AS t(u, d)
             WHERE t.u = a.user_id AND t.d = a.date
          )`,
      [req.params.id, reden, rows.rows.map(r => r.user_id), rows.rows.map(r => r.date)]
    );

    await client.query(`UPDATE leave_rounds SET status = 'toegepast', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    await logAudit(req, 'UPDATE', 'settings', req.params.id,
      { type: 'leave_round_apply', applied, opgeruimd: opgeruimd.rowCount });
    res.json({ ok: true, applied, removed: opgeruimd.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error applying leave round:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Reset all data (admin only)
router.delete('/reset-data', requireAuth, requireAdmin, async (req, res) => {
  const scope = req.query.scope || 'data';
  if (!['data', 'data_users', 'all'].includes(scope)) {
    return res.status(400).json({ error: 'Invalid scope. Use: data, data_users, or all' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deletedTables = [];

    // Always delete planning data (correct order for foreign keys)
    await client.query('DELETE FROM shift_swap_requests');
    deletedTables.push('shift_swap_requests');
    await client.query('DELETE FROM shift_blocks');
    deletedTables.push('shift_blocks');
    await client.query('DELETE FROM shift_activities');
    deletedTables.push('shift_activities');
    await client.query('DELETE FROM availability');
    deletedTables.push('availability');
    await client.query('DELETE FROM shifts');
    deletedTables.push('shifts');

    // #292: de vier verloftabellen stonden niet in deze lijst. Bij scope 'data'
    // bleven de rondes dus staan mét de ingevulde voorkeuren en de
    // goedkeuringen, terwijl `settings` (en daarmee holidayPeriods, waar de
    // blokken naar verwijzen) net wél gewist werd. De melding beloofde
    // "Planning data gewist" en dat klopte niet, en voor persoonsgegevens is
    // het een restje dat blijft hangen terwijl de beheerder denkt dat alles
    // weg is.
    //
    // De FK's cascaden vanaf leave_rounds, maar we wissen expliciet in
    // afhankelijkheidsvolgorde: dat leest duidelijker en het blijft kloppen op
    // een database waar die cascade ooit ontbrak.
    await client.query('DELETE FROM leave_round_entries');
    deletedTables.push('leave_round_entries');
    await client.query('DELETE FROM leave_round_submissions');
    deletedTables.push('leave_round_submissions');
    await client.query('DELETE FROM leave_round_blocks');
    deletedTables.push('leave_round_blocks');
    await client.query('DELETE FROM leave_rounds');
    deletedTables.push('leave_rounds');

    await client.query('DELETE FROM settings');
    deletedTables.push('settings');
    await client.query('DELETE FROM schedule_drafts');
    deletedTables.push('schedule_drafts');

    // Delete users if requested
    if (scope === 'data_users') {
      // Delete non-admin users
      await client.query('DELETE FROM users WHERE role != $1', ['admin']);
      deletedTables.push('users (non-admin)');
    } else if (scope === 'all') {
      // Delete all users except the requesting admin
      await client.query('DELETE FROM users WHERE id != $1', [req.user.id]);
      deletedTables.push('users (all except self)');
    }

    await client.query('COMMIT');
    await logAudit(req, 'DELETE', 'system', '', { action: 'reset_data', scope, tables: deletedTables });

    const messages = {
      data: 'Planning data gewist (gebruikers behouden)',
      data_users: 'Planning data en medewerker-accounts gewist',
      all: 'Alle data en accounts gewist (behalve eigen account)'
    };
    // deletedTables ging alleen naar de audit log. Wie wist wat er gebeurd is,
    // hoort dat ook te kunnen zien in het antwoord.
    res.json({ ok: true, message: messages[scope], deletedTables });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
