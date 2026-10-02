// #157: ruilverzoeken en overnames, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { parseLocalDate } = require('../utils');
const emailService = require('../email');
const { blockDayIfEmpty, validateShiftRules } = require('../helpers/dienstregels');

const router = maakRouter();

router.get('/swap-requests', requireAuth, async (req, res) => {
  const { role, team_id, id: currentUserId } = req.user;

  try {
    // Lazy expiry: auto-expire pending requests where the shift date has passed
    //
    // #316: dit keek alleen naar requester_shift_id. Bij een ruil kan de dienst
    // van de DOELPERSOON eerder vallen dan die van de aanvrager. Zo'n verzoek
    // bleef op pending staan, terwijl target-approve het weigert met "Shifts
    // zijn al voorbij". De doelpersoon hield dus een kaart onder "Actie
    // vereist" die bij elke klik een foutmelding gaf, en kon hem alleen
    // wegkrijgen door af te wijzen met een verplichte reden.
    //
    // Is een van beide diensten voorbij, dan kan de ruil niet meer doorgaan.
    await pool.query(`
      UPDATE shift_swap_requests sr
      SET status = 'expired', responded_at = NOW()
      WHERE sr.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM shifts s
          WHERE s.id IN (sr.requester_shift_id, sr.target_shift_id)
            AND s.date < CURRENT_DATE
        )
    `);

    let query;
    let params = [];

    // Role-based filtering
    if (['admin', 'roosterverantwoordelijke'].includes(role)) {
      // Admin/roosterverantwoordelijke: alle requests
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date::text as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date::text as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        ORDER BY sr.created_at DESC
      `;
    } else {
      // Medewerker: own requests + open takeover requests from own team only
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date::text as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date::text as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        WHERE sr.requester_user_id = $1 OR sr.target_user_id = $1
              OR (sr.request_type = 'takeover' AND sr.status = 'pending')
        ORDER BY sr.created_at DESC
      `;
      params = [currentUserId];
    }

    const result = await pool.query(query, params);
    // #320: hier stonden twee console.log-regels die bij ELKE paginaweergave de
    // naam, het id en de rol van de gebruiker naar de log schreven, plus de
    // naam van de aanvrager van het eerste verzoek. Namen van medewerkers
    // hoorden niet in de Render-logs, en de functie werkt, dus ze zijn weg in
    // plaats van achter een vlag gezet. Een echte fout wordt hieronder nog
    // altijd gelogd, zonder persoonsgegevens.
    res.json({ swapRequests: result.rows });
  } catch (err) {
    console.error('GET /swap-requests error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/swap-requests', requireAuth, async (req, res) => {
  const { requesterShiftId, targetShiftId, message } = req.body;
  const currentUserId = req.user.id;

  if (!requesterShiftId || !targetShiftId) {
    return res.status(400).json({ error: 'requesterShiftId en targetShiftId zijn verplicht' });
  }

  try {
    // Verify beide shifts bestaan
    const shiftsResult = await pool.query(
      'SELECT id, user_id, date FROM shifts WHERE id = $1 OR id = $2',
      [requesterShiftId, targetShiftId]
    );

    if (shiftsResult.rows.length !== 2) {
      return res.status(404).json({ error: 'Een of beide shifts niet gevonden' });
    }

    const requesterShift = shiftsResult.rows.find(s => s.id === parseInt(requesterShiftId));
    const targetShift = shiftsResult.rows.find(s => s.id === parseInt(targetShiftId));

    // Verify requester owns requester shift
    if (requesterShift.user_id !== currentUserId) {
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts ruilen' });
    }

    // Verify different users
    if (requesterShift.user_id === targetShift.user_id) {
      return res.status(400).json({ error: 'Je kunt niet met jezelf ruilen' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(requesterShift.date);
    const targetDate = new Date(targetShift.date);

    if (requesterDate < now || targetDate < now) {
      return res.status(400).json({ error: 'Kan geen shifts in het verleden ruilen' });
    }

    // Create swap request
    const insertResult = await pool.query(
      `INSERT INTO shift_swap_requests
       (requester_user_id, requester_shift_id, target_user_id, target_shift_id, message, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [currentUserId, requesterShiftId, targetShift.user_id, targetShiftId, message || null]
    );

    await logAudit(req, 'CREATE', 'swap_request', insertResult.rows[0].id, { requester: currentUserId, target: targetShift.user_id, type: 'swap' });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[currentUserId, targetShift.user_id]]
        );
        const fullShifts = await pool.query(
          'SELECT id, user_id, date::text as date, start_time, end_time, team FROM shifts WHERE id = ANY($1)',
          [[requesterShiftId, targetShiftId]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === currentUserId);
        const targetUser = usersResult.rows.find(u => u.id === targetShift.user_id);
        const rShift = fullShifts.rows.find(s => s.id === parseInt(requesterShiftId));
        const tShift = fullShifts.rows.find(s => s.id === parseInt(targetShiftId));
        if (requesterUser && targetUser && rShift && tShift) {
          emailService.notifySwapRequest(targetUser, requesterUser, rShift, tShift);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.status(201).json({ swapRequest: insertResult.rows[0] });
  } catch (err) {
    console.error('POST /swap-requests error:', err);
    if (err.code === '23514') { // CHECK constraint violation
      return res.status(400).json({ error: 'Ongeldige swap request data' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Target approval endpoints
router.put('/swap-requests/:id/target-approve', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes, force } = req.body;
  const { id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info (FOR UPDATE locks rows to prevent concurrent modification)
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.user_id as requester_current_user, s1.team as requester_team, s1.date::text as requester_date,
              s1.start_time as requester_start, s1.end_time as requester_end,
              s2.user_id as target_current_user, s2.team as target_team, s2.date::text as target_date,
              s2.start_time as target_start, s2.end_time as target_end
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s1, s2`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can approve
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek accepteren' });
    }

    // #316: deze twee controles weigerden wel, maar lieten het verzoek op
    // 'pending' staan. De doelpersoon hield dus een kaart onder "Actie vereist"
    // die bij elke klik dezelfde fout gaf, en kon hem alleen wegkrijgen door af
    // te wijzen met een verplichte reden. Zo'n verzoek kan nooit meer slagen,
    // dus krijgt het meteen een eindstatus, net als het overnameverzoek dat na
    // #188 al zo werkt.
    const kanNooitMeer = async (melding) => {
      await client.query(
        `UPDATE shift_swap_requests SET status = 'expired', responded_at = NOW() WHERE id = $1`,
        [swapId]
      );
      await client.query('COMMIT');
      return res.status(400).json({ error: melding, expired: true });
    };

    // Verify shift ownership hasn't changed since swap was created
    if (swap.requester_current_user !== swap.requester_user_id || swap.target_current_user !== swap.target_user_id) {
      return await kanNooitMeer('Een van de diensten is inmiddels hertoegewezen. Dit ruilverzoek is niet meer geldig.');
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = parseLocalDate(swap.requester_date);
    const targetDate = parseLocalDate(swap.target_date);

    if (requesterDate < now || targetDate < now) {
      return await kanNooitMeer('Een van de diensten is al voorbij. Dit ruilverzoek kan niet meer doorgaan.');
    }

    // #202: een ruil ging tot nu toe volledig langs de roosterregels heen. De
    // shifts wisselden van eigenaar zonder te controleren of de nieuwe eigenaar
    // die dag al werkt of te weinig rust overhoudt. Dezelfde dienst via
    // POST /shifts aanmaken wordt wel geweigerd, dus de ruil was een sluipweg
    // om de overlapcontrole en de 11-uur regel te omzeilen.
    //
    // Elke medewerker staat zijn eigen dienst af, dus die telt niet mee als
    // conflict: hij wordt uitgesloten via excludeId.
    //
    // force=true slaat, net als bij POST /shifts en PUT /shifts/:id, ALLEEN de
    // 11-uur rust over en nooit de overlap. De frontend zet die vlag pas nadat
    // de gebruiker de melding heeft gezien en bevestigd heeft.
    const requesterShift = { date: swap.requester_date, start_time: swap.requester_start, end_time: swap.requester_end };
    const targetShift = { date: swap.target_date, start_time: swap.target_start, end_time: swap.target_end };

    const targetCheck = await validateShiftRules(client, swap.target_user_id, requesterShift, swap.target_shift_id, !!force);
    if (!targetCheck.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: `Deze ruil kan niet doorgaan. ${targetCheck.message}`,
        rule: targetCheck.rule,
        minRest: targetCheck.minRest,
        wie: 'jij',
        canOverride: targetCheck.rule === 'rest'
      });
    }

    const requesterCheck = await validateShiftRules(client, swap.requester_user_id, targetShift, swap.requester_shift_id, !!force);
    if (!requesterCheck.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: `Deze ruil kan niet doorgaan voor de aanvrager. ${requesterCheck.message}`,
        rule: requesterCheck.rule,
        minRest: requesterCheck.minRest,
        wie: 'aanvrager',
        canOverride: requesterCheck.rule === 'rest'
      });
    }

    // Execute swap: swap user_ids atomically
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.target_current_user, swap.requester_shift_id]
    );

    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.requester_current_user, swap.target_shift_id]
    );

    // Na de ruil is de dag van de aanvrager leeg, en die van de doelpersoon
    // ook. Zonder blokkade vult het concept beide bij een volgende toepassing
    // weer op, en dan werkt iedereen zijn oude én zijn geruilde dienst.
    // blockDayIfEmpty raakt niets aan als de medewerker die dag toch nog een
    // dienst heeft, bijvoorbeeld bij een ruil binnen dezelfde dag.
    await blockDayIfEmpty(client, swap.requester_current_user, swap.requester_date, req.user.id, 'manual_swap');
    await blockDayIfEmpty(client, swap.target_current_user, swap.target_date, req.user.id, 'manual_swap');

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved',
           target_approved = true,
           target_response_notes = $1,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $2
       WHERE id = $3`,
      [responseNotes || null, currentUserId, swapId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'APPROVE', 'swap_request', swapId, {
      swap: { requester: swap.requester_user_id, target: swap.target_user_id, type: 'swap' },
      ...(force ? { rusttijdOverruled: true } : {})
    });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[swap.requester_user_id, swap.target_user_id]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === swap.requester_user_id);
        const targetUser = usersResult.rows.find(u => u.id === swap.target_user_id);
        const approverName = targetUser ? targetUser.name : 'Collega';
        const rShift = { date: swap.requester_date, start_time: swap.requester_start, end_time: swap.requester_end, team: swap.requester_team };
        const tShift = { date: swap.target_date, start_time: swap.target_start, end_time: swap.target_end, team: swap.target_team };
        emailService.notifySwapApproved([requesterUser, targetUser].filter(Boolean), approverName, rShift, tShift, requesterUser, targetUser);
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap geaccepteerd en uitgevoerd' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /swap-requests/:id/target-approve error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.put('/swap-requests/:id/target-reject', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { id: currentUserId } = req.user;

  if (!responseNotes || responseNotes.trim() === '') {
    return res.status(400).json({ error: 'Reden voor afwijzing is verplicht' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request
    const swapResult = await client.query(
      `SELECT * FROM shift_swap_requests WHERE id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can reject
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek afwijzen' });
    }

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'rejected',
           target_approved = false,
           target_response_notes = $1,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $2
       WHERE id = $3`,
      [responseNotes, currentUserId, swapId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'REJECT', 'swap_request', swapId, { swap: { requester: swap.requester_user_id, target: swap.target_user_id, reason: responseNotes } });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[swap.requester_user_id, swap.target_user_id]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === swap.requester_user_id);
        const targetUser = usersResult.rows.find(u => u.id === swap.target_user_id);
        const rejectorName = targetUser ? targetUser.name : 'Collega';
        if (requesterUser) {
          emailService.notifySwapRejected([requesterUser], rejectorName, responseNotes);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap afgewezen' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /swap-requests/:id/target-reject error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Takeover (open shift request) endpoints
router.post('/shift-requests/takeover', requireAuth, async (req, res) => {
  const { shiftId, message } = req.body;
  const currentUserId = req.user.id;
  const { role, team_id } = req.user;

  if (!shiftId) {
    return res.status(400).json({ error: 'shiftId is verplicht' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify shift exists
    const shiftResult = await client.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];

    // Permission check: Allow admin, roosterverantwoordelijke, or own shifts
    const isOwnShift = shift.user_id === currentUserId;
    const isAdmin = role === 'admin';
    const isRoosterverantwoordelijke = role === 'roosterverantwoordelijke';

    if (!isOwnShift && !isAdmin && !isRoosterverantwoordelijke) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts aanbieden, tenzij je admin of verantwoordelijke bent' });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = new Date(shift.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // #243: hier ontbrak de duplicaatcontrole die de automatische ziekmelding
    // wel doet. Dezelfde dienst kon onbeperkt aangeboden worden, en dan zien
    // drie collega's drie verzoeken op dezelfde dienst staan.
    //
    // Een SELECT ... FOR UPDATE is hier niet genoeg: is er nog geen verzoek,
    // dan valt er niets te vergrendelen en lezen twee gelijktijdige verzoeken
    // allebei "geen openstaand verzoek". Gemeten met vijf tegelijk vanaf nul
    // gaven er dan twee een 200. Dezelfde valkuil als in #237, dus dezelfde
    // oplossing: een advisory lock op de dienst, die tot het einde van de
    // transactie duurt.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`takeover:${shiftId}`]);
    const bestaand = await client.query(
      `SELECT id FROM shift_swap_requests
       WHERE requester_shift_id = $1 AND request_type = 'takeover' AND status = 'pending'`,
      [shiftId]
    );
    if (bestaand.rows.length > 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(409).json({
        error: 'Deze dienst staat al open voor overname.',
        requestId: bestaand.rows[0].id
      });
    }

    // Create takeover request
    // Use shift owner (shift.user_id) as requester, not currentUserId
    // This ensures auto-cancel can find requests by employee ID when absence is removed
    // #319: hier stond geen RETURNING, dus ging er een lege string als
    // resourceId naar logAudit. De CREATE-regel was daardoor niet aan de latere
    // APPROVE- of CANCEL-regel van hetzelfde verzoek te koppelen, terwijl die
    // twee het echte id wél loggen.
    const nieuwVerzoek = await client.query(
      `INSERT INTO shift_swap_requests
       (requester_user_id, requester_shift_id, target_user_id, target_shift_id, request_type, message, status)
       VALUES ($1, $2, NULL, NULL, 'takeover', $3, 'pending')
       RETURNING id`,
      [shift.user_id, shiftId, message || null]
    );
    const verzoekId = nieuwVerzoek.rows[0]?.id;

    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'swap_request', verzoekId, { type: 'takeover', shiftId, shiftOwner: shift.user_id, createdBy: currentUserId });

    // Email notification to team members (fire-and-forget)
    (async () => {
      try {
        // #283: dit ging alleen naar het team van de dienst. Nu naar iedereen,
        // want iedereen mag de dienst ook overnemen. verstuurReeks laat de
        // aanvrager zelf weg en respecteert email_notifications_enabled, dus
        // wie geen mail wil krijgt er ook geen.
        const teamMembers = await pool.query(
          `SELECT id, name, email, email_notifications_enabled FROM users
           WHERE active = true AND role != 'admin'`
        );
        const requester = await pool.query(
          'SELECT id, name, email FROM users WHERE id = $1', [shift.user_id]
        );
        if (requester.rows[0]) {
          const fullShift = { date: shift.date, start_time: shift.start_time, end_time: shift.end_time, team: shift.team };
          emailService.notifyTakeoverAvailable(teamMembers.rows, requester.rows[0], fullShift);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Open verzoek aangemaakt' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /shift-requests/takeover error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.put('/shift-requests/:id/takeover-accept', requireAuth, async (req, res) => {
  const requestId = req.params.id;
  const { responseNotes, force } = req.body;
  const { id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch takeover request with shift info (FOR UPDATE locks rows to prevent concurrent modification)
    const requestResult = await client.query(
      `SELECT sr.*, s.user_id as current_shift_owner, s.date::text as date, s.start_time, s.end_time, s.team
       FROM shift_swap_requests sr
       JOIN shifts s ON sr.requester_shift_id = s.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Verzoek niet gevonden' });
    }

    const request = requestResult.rows[0];

    // Verify it's a takeover request
    if (request.request_type !== 'takeover') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Dit is geen open verzoek' });
    }

    // Verify status is pending
    if (request.status !== 'pending') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Verzoek is al verwerkt' });
    }

    // Verify user is not the requester
    if (request.requester_user_id === currentUserId) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Je kunt je eigen verzoek niet accepteren' });
    }

    // #283: hier stond sinds #281 een teamcontrole. Die is er bewust weer uit.
    //
    // #281 ging over een gat: de lijst toonde alleen het eigen team maar
    // aanvaarden kon over teams heen. Dat gat kan langs twee kanten dicht, en
    // Victor heeft gekozen voor de ruime kant: een openstaande dienst wordt aan
    // iedereen aangeboden en iedereen mag hem overnemen. De lijst en de mail
    // hieronder zijn mee verbreed, dus de drie plekken zeggen weer hetzelfde.
    //
    // Gevolg dat hierbij hoort: iemand kan een dienst van een ander team
    // overnemen. De dienst houdt zijn eigen team, alleen de persoon verandert.

    // #188: de dienst mag intussen niet aan iemand anders zijn toegewezen.
    // current_shift_owner werd hierboven wel geselecteerd maar nergens gebruikt.
    // Daardoor kon een oud, nog openstaand overnameverzoek de dienst afpakken
    // van de collega die hem intussen had gekregen, bijvoorbeeld doordat de
    // roosterverantwoordelijke het gat zelf had opgevuld. Die collega werd
    // niets gevraagd en kreeg geen bericht, want de melding gaat naar de
    // oorspronkelijke aanvrager.
    //
    // Het zusterendpoint voor gewone ruilverzoeken doet deze controle al
    // (zie 'Verify shift ownership hasn't changed' hierboven).
    if (request.current_shift_owner !== request.requester_user_id) {
      // Het verzoek kan nooit meer slagen, dus zetten we het meteen op een
      // eindstatus. Anders blijft de kaart onder 'Actie vereist' staan en
      // geeft elke klik dezelfde fout, wat precies de val uit #316 is.
      await client.query(
        `UPDATE shift_swap_requests SET status = 'expired', responded_at = NOW() WHERE id = $1`,
        [requestId]
      );
      await client.query('COMMIT');
      return res.status(400).json({
        error: 'Deze dienst is inmiddels aan iemand anders toegewezen. Dit overnameverzoek is niet meer geldig.'
      });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = parseLocalDate(request.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // #202: ook een overname sloeg de roosterregels over. Wie de dienst
    // overneemt kon er een krijgen die overlapt met zijn eigen dienst, of die
    // te kort op zijn vorige of volgende dienst volgt. De 11-uur rust is geen
    // huisregel maar arbeidswetgeving, en dit is juist het scenario waar de
    // planner het minst naar kijkt: een overname voelt als iets dat de
    // collega's onderling geregeld hebben.
    //
    // force=true slaat, net als bij POST /shifts en PUT /shifts/:id, ALLEEN de
    // 11-uur rust over en nooit de overlap. De frontend zet die vlag pas nadat
    // de gebruiker de melding heeft gezien en bevestigd heeft.
    const takeoverShift = { date: request.date, start_time: request.start_time, end_time: request.end_time };
    const acceptorCheck = await validateShiftRules(client, currentUserId, takeoverShift, null, !!force);
    if (!acceptorCheck.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: `Je kunt deze dienst niet overnemen. ${acceptorCheck.message}`,
        rule: acceptorCheck.rule,
        minRest: acceptorCheck.minRest,
        canOverride: acceptorCheck.rule === 'rest'
      });
    }

    // Assign shift to acceptor, keep original team (don't change team on takeover)
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [currentUserId, request.requester_shift_id]
    );

    // De dag van wie de dienst afstond is nu leeg. Zonder blokkade vult het
    // concept die opnieuw op en werkt hij alsnog de dienst die hij net had
    // weggegeven, terwijl de collega hem ook heeft.
    await blockDayIfEmpty(client, request.requester_user_id, request.date, req.user.id, 'manual_takeover');

    // Update request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved',
           target_user_id = $1,
           target_approved = true,
           target_response_notes = $2,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $1
       WHERE id = $3`,
      [currentUserId, responseNotes || null, requestId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'APPROVE', 'swap_request', requestId, {
      type: 'takeover', requester: request.requester_user_id, acceptedBy: currentUserId,
      ...(force ? { rusttijdOverruled: true } : {})
    });

    // Email notification to original owner (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[request.requester_user_id, currentUserId]]
        );
        const originalOwner = usersResult.rows.find(u => u.id === request.requester_user_id);
        const acceptor = usersResult.rows.find(u => u.id === currentUserId);
        if (originalOwner && acceptor) {
          const shiftInfo = { date: request.date, start_time: request.start_time, end_time: request.end_time, team: request.team };
          emailService.notifyTakeoverAccepted(originalOwner, acceptor, shiftInfo);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Shift overgenomen' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /shift-requests/:id/takeover-accept error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.delete('/swap-requests/:id', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const currentUserId = req.user.id;
  const { role, team_id } = req.user;

  try {
    // Fetch swap request with team info
    const swapResult = await pool.query(
      `SELECT sr.*,
              s1.team as requester_team,
              s2.team as target_team
       FROM shift_swap_requests sr
       LEFT JOIN shifts s1 ON sr.requester_shift_id = s1.id
       LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Permission check: Allow requester, admin, or roosterverantwoordelijke
    const isRequester = swap.requester_user_id === currentUserId;
    const isAdmin = role === 'admin';
    const isRoosterverantwoordelijke = role === 'roosterverantwoordelijke';

    if (!isRequester && !isAdmin && !isRoosterverantwoordelijke) {
      return res.status(403).json({ error: 'Alleen de aanvrager of een verantwoordelijke kan dit verzoek annuleren' });
    }

    // Only pending requests can be cancelled
    if (swap.status !== 'pending') {
      return res.status(400).json({ error: 'Alleen pending requests kunnen geannuleerd worden' });
    }

    // Update status to cancelled
    await pool.query(
      `UPDATE shift_swap_requests SET status = 'cancelled' WHERE id = $1`,
      [swapId]
    );

    await logAudit(req, 'CANCEL', 'swap_request', swapId, { type: swap.request_type, requester: swap.requester_user_id, cancelledBy: currentUserId });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const affectedIds = [swap.requester_user_id, swap.target_user_id].filter(Boolean);
        if (affectedIds.length > 0) {
          const usersResult = await pool.query(
            'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
            [affectedIds]
          );
          const canceller = usersResult.rows.find(u => u.id === currentUserId);
          const cancellerName = canceller ? canceller.name : 'Iemand';
          const recipients = usersResult.rows.filter(u => u.id !== currentUserId);
          if (recipients.length > 0) {
            const shiftResult = await pool.query(
              'SELECT date::text as date, start_time, end_time, team FROM shifts WHERE id = $1',
              [swap.requester_shift_id]
            );
            emailService.notifyRequestCancelled(recipients, cancellerName, shiftResult.rows[0] || null);
          }
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap request geannuleerd' });
  } catch (err) {
    console.error('DELETE /swap-requests/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
