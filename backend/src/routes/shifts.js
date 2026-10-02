// #157: de diensten zelf, uit server.js gehaald. De regels waaraan een dienst
// moet voldoen staan in helpers/dienstregels.js, want de ruilverzoeken toetsen
// aan dezelfde regels.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const emailService = require('../email');
const { GELIJKE_TIJDEN_MELDING, blockDayIfEmpty, getMinRustUren, isValidTime, normaliseerTijd, validateShiftRules } = require('../helpers/dienstregels');

const router = maakRouter();

router.get('/shifts', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  const params = [];
  let where = 'WHERE archived = false';
  if (startDate && endDate) {
    where += ' AND date >= $1 AND date <= $2';
    params.push(startDate, endDate);
  }
  const query = `
    SELECT id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
           end_time as "endTime", notes, source, is_reserve as "isReserve", created_at as "createdAt"
    FROM shifts ${where} ORDER BY date, start_time
  `;

  try {
    const result = await pool.query(query, params);
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error('GET /shifts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/shifts', requireAuth, async (req, res) => {
  const { userId, team, date, notes, source, isReserve, force } = req.body || {};
  // #246: '24:00' is middernacht, maar geen geldige waarde voor een tijdveld.
  // #295: de ruwe waarden apart houden. '24:00' wordt hieronder '00:00', en dan
  // lijkt 00:00 tot 24:00 op gelijke tijden terwijl de gebruiker een volle dag
  // bedoelde. Dat is geen tikfout, en isValidTime laat '24:00' bewust toe (#246).
  const ruweStart = (req.body || {}).startTime;
  const ruwEind = (req.body || {}).endTime;
  const startTime = normaliseerTijd(ruweStart);
  const endTime = normaliseerTijd(ruwEind);
  if (!userId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  if (!isValidTime(startTime) || !isValidTime(endTime)) {
    return res.status(400).json({ error: 'Tijdstip moet HH:MM zijn' });
  }
  if (ruweStart === ruwEind) {
    return res.status(400).json({ error: GELIJKE_TIJDEN_MELDING });
  }

  // Permission check: medewerker can only create shifts for themselves
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker' && Number(userId) !== currentUserId) {
    return res.status(403).json({ error: 'Je kunt alleen diensten voor jezelf aanmaken' });
  }

  // source defaults to 'manual' if not specified
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  // #237: de controle en de invoeging stonden los van elkaar, zonder
  // transactie en zonder vergrendeling. Twee verzoeken tegelijk lazen allebei
  // "geen overlap" voordat de eerste INSERT geland was, en kregen allebei een
  // dienst. Twintig tegelijk gaf zeventien diensten. Twee tegelijk is het
  // echte scenario: een dubbelklik op Opslaan, of een slepen dat twee keer
  // afvuurt.
  //
  // Een SELECT ... FOR UPDATE helpt hier niet: als er nog geen rij is, valt er
  // niets te vergrendelen. Een advisory lock op de combinatie medewerker en
  // datum wel. Die duurt tot het einde van de transactie, werkt ook als er
  // ooit een tweede serverproces bijkomt, en vraagt geen schemawijziging met
  // tijdvakberekeningen voor nachtdiensten.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shift:${userId}:${date}`]);

    // Check if the date is manually closed
    const closedDatesResult = await client.query("SELECT value FROM settings WHERE key = 'closedDates'");
    const closedDates = (closedDatesResult.rows[0]?.value || []).map(d => d.date);
    if (closedDates.includes(date)) {
      // #312: .catch erop, zoals overal elders in dit bestand. Valt de
      // verbinding weg, dan faalt ook de ROLLBACK, en dan hoort de gebruiker
      // de melding te krijgen die hier klaarstaat in plaats van een kale 500.
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Deze dag is manueel gesloten' });
    }

    // Valideer 11-uur regel en overlap (force=true slaat enkel rusttijd over, niet overlap)
    const validation = await validateShiftRules(client, userId, { date, start_time: startTime, end_time: endTime }, null, !!force);
    // #247: het antwoord bevatte alleen een tekst, dus de frontend kon niet
    // zien of dit een overlap was (nooit te overrulen) of de rusttijd (wel).
    // Ze bood daardoor bij allebei "Toch opslaan" aan, terwijl force enkel de
    // rustcontrole overslaat. De ruilendpoints gaven dit al mee.
    if (!validation.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: validation.message,
        rule: validation.rule,
        canOverride: validation.rule === 'rest'
      });
    }

    // Insert the new shift
    const result = await client.query(`
      INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source, is_reserve)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, is_reserve as "isReserve", created_at as "createdAt"
    `, [userId, team || null, date, startTime, endTime, notes || '', shiftSource, isReserve ? true : false]);

    const newShift = result.rows[0];

    // Remove shift block ONLY if a MANUAL shift is created (manual overrides the block)
    // Auto shifts should NOT remove blocks (they should respect blocks and not be created at all)
    if (shiftSource === 'manual') {
      await client.query(
        'DELETE FROM shift_blocks WHERE user_id = $1 AND date = $2',
        [userId, date]
      );
    }

    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'shift', newShift.id, { shift: newShift });
    res.status(201).json({ shift: newShift });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /shifts error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.put('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { userId, team, date, notes, source, isReserve, force } = req.body || {};
  // #246: zie POST /shifts. Middernacht heet '00:00', niet '24:00'.
  // #295: zie POST /shifts. De vergelijking gaat op de ruwe waarden, zodat
  // 00:00 tot 24:00 een volle dag blijft en niet als tikfout geweigerd wordt.
  const ruweStart = (req.body || {}).startTime;
  const ruwEind = (req.body || {}).endTime;
  const startTime = ruweStart === undefined ? undefined : normaliseerTijd(ruweStart);
  const endTime = ruwEind === undefined ? undefined : normaliseerTijd(ruwEind);
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  if ((startTime !== undefined && !isValidTime(startTime)) || (endTime !== undefined && !isValidTime(endTime))) {
    return res.status(400).json({ error: 'Tijdstip moet HH:MM zijn' });
  }

  const { role, id: currentUserId } = req.user;

  // When editing, automatically set source to 'manual' to protect from auto-regeneration
  // Unless explicitly setting to 'auto' (for reset-to-base functionality)
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  try {
    const oldResult = await pool.query(
      `SELECT id, user_id as "userId", team, date::text as date, start_time as "startTime", end_time as "endTime", notes, source FROM shifts WHERE id = $1`,
      [id]
    );
    const oldShift = oldResult.rows[0] || null;

    // Permission check: medewerker can only edit own shifts.
    //
    // #215: deze controle stond hiervoor VÓÓR de try, met een eigen
    // pool.query. Ging de database onderuit, dan verliet die afwijzing de
    // handler onafgehandeld en nam Node het proces mee. Nu staat hij binnen de
    // try, en gebruikt hij de dienst die hier toch al opgehaald wordt, dus het
    // scheelt ook een query.
    //
    // #262: een medewerker mag zijn eigen dienst bewerken, maar hem niet naar
    // een ander team of naar een andere collega verplaatsen. Het teamveld bleef
    // in de modal bewerkbaar en de UPDATE hieronder liet zowel team als user_id
    // ongecontroleerd door, dus iemand kon zichzelf in een ander team schrijven
    // of zijn dienst aan een collega toewijzen. Daar bestaat 'Dienst afstaan'
    // voor, met een verzoek dat de ander kan aanvaarden.
    if (role === 'medewerker' && oldShift) {
      if (oldShift.userId !== currentUserId) {
        return res.status(403).json({ error: 'Je kunt alleen je eigen diensten bewerken' });
      }
      if (team !== undefined && team !== null && team !== oldShift.team) {
        return res.status(403).json({ error: 'Je kunt het team van een dienst niet wijzigen' });
      }
      if (userId !== undefined && userId !== null && Number(userId) !== Number(oldShift.userId)) {
        return res.status(403).json({ error: 'Je kunt een dienst niet aan iemand anders toewijzen. Gebruik daarvoor Dienst afstaan.' });
      }
    }

    // Blokeer verplaatsing naar manueel gesloten datum
    const effectiveDate = date || oldShift?.date;
    if (date && date !== oldShift?.date) {
      const cdResult = await pool.query("SELECT value FROM settings WHERE key = 'closedDates'");
      const closedDates = (cdResult.rows[0]?.value || []).map(d => d.date);
      if (closedDates.includes(date)) {
        return res.status(400).json({ error: 'Deze dag is manueel gesloten' });
      }
    }

    // Valideer 11-uur regel en overlap (force=true slaat enkel rusttijd over, niet overlap)
    const updatedShift = {
      date:       date       || oldShift?.date,
      start_time: startTime  || oldShift?.startTime,
      end_time:   endTime    || oldShift?.endTime
    };
    // #295: pas hier, want een PUT kan één van beide tijden meesturen. De
    // gelijkheid geldt voor wat er na de wijziging staat, niet voor wat er in
    // het verzoek zit. Op de ruwe waarden vergelijken kan hier niet zonder de
    // bestaande dienst erbij, dus dit kijkt naar de genormaliseerde tijden. Wie
    // 00:00 tot 24:00 bedoelt, stuurt beide tijden mee en wordt hierboven al
    // doorgelaten; alleen een PUT die één tijd gelijkmaakt aan de andere valt
    // hier af, en dat is precies de tikfout.
    const beideMeegestuurd = ruweStart !== undefined && ruwEind !== undefined;
    const gelijkeRuweTijden = beideMeegestuurd && ruweStart === ruwEind;
    const gelijkNaWijziging = updatedShift.start_time && updatedShift.start_time === updatedShift.end_time;
    if (gelijkeRuweTijden || (!beideMeegestuurd && gelijkNaWijziging)) {
      return res.status(400).json({ error: GELIJKE_TIJDEN_MELDING });
    }
    if (updatedShift.date && updatedShift.start_time && updatedShift.end_time) {
      const targetUserId = userId || oldShift?.userId;
      const validation = await validateShiftRules(pool, targetUserId, updatedShift, id, !!force);
      // #247: zie POST /shifts.
      if (!validation.valid) return res.status(422).json({
        error: validation.message,
        rule: validation.rule,
        canOverride: validation.rule === 'rest'
      });
    }

    // #301: verandert de dienst van dag, tijd of eigenaar, dan wijst een
    // openstaand verzoek daarna naar iets anders dan waar de collega mee
    // instemde. Die keurde een zaterdagochtend goed en kreeg na goedkeuring
    // een andere dienst toegewezen.
    //
    // Alleen de velden die de dienst bepálen tellen mee: een notitie
    // bijwerken of het reservevinkje omzetten verandert niets aan de afspraak.
    const bepalendGewijzigd = oldShift && (
      (userId !== undefined && userId !== null && Number(userId) !== Number(oldShift.userId)) ||
      (date && date !== oldShift.date) ||
      (startTime && startTime !== oldShift.startTime) ||
      (endTime && endTime !== oldShift.endTime)
    );
    let geannuleerd = [];
    if (bepalendGewijzigd) {
      const open = await pool.query(
        `UPDATE shift_swap_requests SET status = 'cancelled'
         WHERE (requester_shift_id = $1 OR target_shift_id = $1)
           AND status = 'pending'
         RETURNING id, requester_user_id, target_user_id`,
        [id]
      );
      geannuleerd = open.rows;
    }

    const result = await pool.query(`
      UPDATE shifts
      SET user_id = COALESCE($1, user_id),
          team = COALESCE($2, team),
          date = COALESCE($3, date),
          start_time = COALESCE($4, start_time),
          end_time = COALESCE($5, end_time),
          notes = COALESCE($6, notes),
          source = COALESCE($8, source, 'manual'),
          is_reserve = COALESCE($9, is_reserve)
      WHERE id = $7
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, is_reserve as "isReserve", created_at as "createdAt"
    `, [userId, team, date, startTime, endTime, notes, id, shiftSource, isReserve !== undefined ? Boolean(isReserve) : null]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dienst niet gevonden' });
    }
    // Is de dienst verhuisd naar een andere dag of een andere medewerker, dan
    // blijft de oorspronkelijke plek leeg achter. Zonder blokkade vult het
    // concept die bij een volgende toepassing gewoon weer op en staat er
    // opeens dubbele bezetting. Verslepen in de planning loopt via dit
    // endpoint, dus dit dekt drag en drop mee.
    const nieuw = result.rows[0];
    const verhuisd = oldShift && (
      String(oldShift.date) !== String(nieuw.date) ||
      Number(oldShift.userId) !== Number(nieuw.userId)
    );
    let blockedOrigin = false;
    if (verhuisd) {
      blockedOrigin = await blockDayIfEmpty(pool, oldShift.userId, oldShift.date, req.user.id, 'manual_move');
    }

    await logAudit(req, 'UPDATE', 'shift', id, {
      before: oldShift, after: nieuw, blockedOrigin,
      ...(geannuleerd.length > 0 ? { geannuleerdeVerzoeken: geannuleerd.map(r => r.id) } : {})
    });

    // #301: de betrokkenen verwittigen dat hun verzoek niet meer geldt, met
    // dezelfde mail als de gewone annulatieroute. Fire-and-forget na de
    // wijziging, zodat een trage mailservice het opslaan niet ophoudt.
    if (geannuleerd.length > 0) {
      (async () => {
        try {
          const betrokkenen = [...new Set(geannuleerd
            .flatMap(r => [r.requester_user_id, r.target_user_id])
            .filter(uid => uid && uid !== req.user.id))];
          if (betrokkenen.length === 0) return;
          const mensen = await pool.query(
            'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1::int[])',
            [betrokkenen]
          );
          const wie = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
          emailService.notifyRequestCancelled(
            mensen.rows, wie.rows[0]?.name || 'Een beheerder',
            { date: oldShift.date, start_time: oldShift.startTime, end_time: oldShift.endTime, team: oldShift.team }
          );
        } catch (e) {
          console.error('Verwittigen na een geannuleerd verzoek mislukt:', e.message);
        }
      })();
    }

    res.json({ shift: nieuw, blockedOrigin, geannuleerdeVerzoeken: geannuleerd.length });
  } catch (err) {
    console.error('PUT /shifts/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get full shift details for permission check (including date for shift_blocks)
    // Cast date to text to avoid timezone conversion issues
    const shiftResult = await client.query(
      'SELECT id, user_id, team, source, date::text as date FROM shifts WHERE id = $1',
      [id]
    );

    if (shiftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];
    const { role, id: userId, team_id: userTeam } = req.user;

    // #184: hier stond `if (shift.source !== 'auto')` om deze hele controle
    // heen. Elke medewerker kon daardoor de auto-dienst van eender welke
    // collega verwijderen, ook uit een ander team. De redenering was dat
    // auto-diensten toch opnieuw worden aangemaakt, maar diezelfde handler
    // maakt hieronder een shift_block aan dat precies dat verhindert. De dag
    // bleef dus permanent leeg. De rolcontrole geldt nu voor elke dienst,
    // ongeacht de bron.
    if (role === 'admin' || role === 'roosterverantwoordelijke') {
      // Admin en roosterverantwoordelijke mogen elke dienst verwijderen
    } else if (role === 'medewerker') {
      // Een medewerker mag alleen zijn eigen dienst verwijderen
      if (shift.user_id !== userId) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(403).json({ error: 'Je kunt alleen je eigen diensten verwijderen' });
      }
    } else {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Je hebt geen rechten om diensten te verwijderen' });
    }

    // #301 en #317: shift_swap_requests verwijst met ON DELETE CASCADE naar
    // shifts, dus een openstaand ruil- of overnameverzoek verdween hier
    // spoorloos mee. De aanvrager zag zijn verzoek weg zonder uitleg en dacht
    // dat de collega niet reageerde; bij de doelpersoon verdween de kaart uit
    // "Actie vereist".
    //
    // De opkuis zelf is correct, alleen mag ze niet stil gebeuren. De
    // openstaande verzoeken worden nu eerst expliciet geannuleerd, zodat er een
    // reden en een tijdstip vastliggen, en daarna wordt iedereen verwittigd met
    // dezelfde mail als de gewone annulatieroute.
    const openVerzoeken = await client.query(
      `SELECT id, requester_user_id, target_user_id, request_type
       FROM shift_swap_requests
       WHERE (requester_shift_id = $1 OR target_shift_id = $1)
         AND status = 'pending'`,
      [id]
    );
    if (openVerzoeken.rows.length > 0) {
      await client.query(
        `UPDATE shift_swap_requests SET status = 'cancelled'
         WHERE id = ANY($1::int[])`,
        [openVerzoeken.rows.map(r => r.id)]
      );
    }

    // Delete the shift (CASCADE handles shift_activities with shift_id set)
    await client.query('DELETE FROM shifts WHERE id = $1', [id]);
    await logAudit(req, 'DELETE', 'shift', id, {
      shift: { id: shift.id, user_id: shift.user_id, team: shift.team, date: shift.date, source: shift.source },
      ...(openVerzoeken.rows.length > 0
        ? { geannuleerdeVerzoeken: openVerzoeken.rows.map(r => r.id) }
        : {})
    });

    // Een manuele verwijdering is een bewuste keuze om die cel leeg te laten.
    // We leggen dat vast als shift_block zodat het concept de dag bij een
    // volgende toepassing NIET opnieuw vult (#146, lek 2 — de stille killer).
    // Systeemopkuis (bv. auto-shifts wissen vóór her-toepassen) geeft
    // skipBlock=true mee en slaat dit over.
    const skipBlock = req.query.skipBlock === 'true';
    if (!skipBlock) {
      await client.query(
        `INSERT INTO shift_blocks (user_id, date, created_by, reason)
         VALUES ($1, $2::date, $3, 'manual_delete')
         ON CONFLICT (user_id, date) DO NOTHING`,
        [shift.user_id, shift.date, userId]
      );
    }

    await client.query('COMMIT');

    // Na de commit, fire-and-forget: een haperende mailservice mag een
    // geslaagde verwijdering niet alsnog laten mislukken.
    if (openVerzoeken.rows.length > 0) {
      (async () => {
        try {
          const betrokkenen = [...new Set(openVerzoeken.rows
            .flatMap(r => [r.requester_user_id, r.target_user_id])
            .filter(uid => uid && uid !== userId))];
          if (betrokkenen.length === 0) return;
          const mensen = await pool.query(
            'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1::int[])',
            [betrokkenen]
          );
          const wie = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
          emailService.notifyRequestCancelled(
            mensen.rows, wie.rows[0]?.name || 'Een beheerder',
            { date: shift.date, start_time: null, end_time: null, team: shift.team }
          );
        } catch (e) {
          console.error('Verwittigen na een geannuleerd verzoek mislukt:', e.message);
        }
      })();
    }

    res.json({ ok: true, geannuleerdeVerzoeken: openVerzoeken.rows.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR in DELETE /shifts/:id:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk delete shifts in date range
// Only supervisors can do bulk delete
router.delete('/shifts', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate en endDate zijn verplicht' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM shifts WHERE date >= $1 AND date <= $2',
      [startDate, endDate]
    );
    await logAudit(req, 'DELETE', 'shift', '', { action: 'bulk_delete', startDate, endDate, deletedCount: result.rowCount });
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk create shifts (for schedule builder)
router.post('/shifts/bulk', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { shifts: shiftsToCreate, overwriteExisting } = req.body || {};

  if (!Array.isArray(shiftsToCreate) || shiftsToCreate.length === 0) {
    return res.status(400).json({ error: 'shifts array is verplicht' });
  }

  if (shiftsToCreate.length > 200) {
    return res.status(400).json({ error: 'Maximum 200 shifts per keer' });
  }

  const { role, team_id: userTeam } = req.user;

  // Role check already handled by requireRole middleware

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load closed dates once for the whole bulk operation
    const cdResult = await client.query("SELECT value FROM settings WHERE key = 'closedDates'");
    const closedDates = new Set((cdResult.rows[0]?.value || []).map(d => d.date));

    // Idem voor de rustnorm: validateShiftRules zou hem anders per dienst
    // opnieuw ophalen, en deze lus loopt over honderden diensten.
    const minRustUren = await getMinRustUren(client);

    const createdShifts = [];
    const skipped = [];

    // #293: hiervoor werden bij overwriteExisting éérst alle bestaande diensten
    // van elk paar medewerker+datum verwijderd, en pas daarna per dienst
    // gecontroleerd op gesloten dagen en op de overlap- en rustregel. Wat de
    // controle niet haalde belandde in `skipped`, maar de verwijdering bleef
    // staan: de bestaande dienst was weg en er kwam niets voor in de plaats.
    // Wie alleen naar het aantal 'aangemaakt' keek, zag dat niet.
    //
    // Het verwijderen kan niet zomaar ná de validatie, want de bestaande dienst
    // is precies wat de overlapcontrole zou afkeuren. Daarom nu per paar, met
    // een savepoint eromheen: verwijderen, invoegen, en als er voor dat paar
    // uiteindelijk niets is ingevoegd, het verwijderen terugdraaien. Een dag
    // wordt dus alleen leeggemaakt als er ook echt iets voor in de plaats komt.
    const paren = new Map();
    for (const shift of shiftsToCreate) {
      if (!shift.userId || !shift.date || !shift.startTime || !shift.endTime) continue;
      const sleutel = `${shift.userId}|${shift.date}`;
      if (!paren.has(sleutel)) paren.set(sleutel, []);
      paren.get(sleutel).push(shift);
    }

    let savepointTeller = 0;
    for (const [sleutel, diensten] of paren) {
      const [paarUserId, paarDatum] = sleutel.split('|');

      // Een gesloten dag nooit leegmaken: daar hoort sowieso niets te staan,
      // dus verwijderen zou puur verlies zijn.
      if (closedDates.has(paarDatum)) {
        for (const shift of diensten) skipped.push({ date: shift.date, reason: 'closed' });
        continue;
      }

      const savepoint = `paar_${savepointTeller++}`;
      if (overwriteExisting) {
        await client.query(`SAVEPOINT ${savepoint}`);
        await client.query('DELETE FROM shifts WHERE user_id = $1 AND date = $2', [paarUserId, paarDatum]);
      }

      let geplaatstVoorDitPaar = 0;
      const overgeslagenVoorDitPaar = [];

      for (const shift of diensten) {
        // Validate rusttijd en overlap
        const validation = await validateShiftRules(client, shift.userId, {
          date: shift.date, start_time: shift.startTime, end_time: shift.endTime
        }, null, false, minRustUren);
        if (!validation.valid) {
          overgeslagenVoorDitPaar.push({ date: shift.date, userId: shift.userId, reason: validation.message });
          continue;
        }

        const result = await client.query(`
          INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source)
          VALUES ($1, $2, $3, $4, $5, $6, 'manual')
          RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as date,
                    start_time as "startTime", end_time as "endTime", notes, source, created_at as "createdAt"
        `, [shift.userId, shift.team || null, shift.date, shift.startTime, shift.endTime, shift.notes || '']);

        createdShifts.push(result.rows[0]);
        geplaatstVoorDitPaar++;

        // Remove shift block (manual shift overrides blocks)
        await client.query('DELETE FROM shift_blocks WHERE user_id = $1 AND date = $2', [shift.userId, shift.date]);
      }

      if (overwriteExisting) {
        if (geplaatstVoorDitPaar === 0) {
          // Niets geplaatst: het verwijderen terugdraaien, inclusief de
          // ingevoegde rijen die er toch niet zijn. De bestaande dienst blijft
          // dus gewoon staan.
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
        }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
      }

      skipped.push(...overgeslagenVoorDitPaar);
    }

    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'shift', '', { action: 'bulk_create', count: createdShifts.length, skipped: skipped.length, overwriteExisting: !!overwriteExisting });
    res.status(201).json({ shifts: createdShifts, count: createdShifts.length, skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /shifts/bulk error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
