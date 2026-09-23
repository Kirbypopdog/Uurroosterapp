// #157: een concept buiten werking stellen, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

router.post('/schedule-drafts/:id/deactivate', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { endDate, deleteManual = false } = req.body || {};
  if (!endDate) return res.status(400).json({ error: 'endDate is vereist' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load draft
    // last_applied_until wordt hieronder overschreven met endDate, dus we lezen
    // de oorspronkelijke waarde hier uit: die is de bovengrens voor diensten
    // van vóór migratie 037, die nog geen draft_id dragen.
    const draftResult = await client.query(
      `SELECT id, name, grid, team_filter,
              last_applied_from::text  as "lastAppliedFrom",
              last_applied_until::text as "lastAppliedUntil"
       FROM schedule_drafts WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (draftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }

    const draft = draftResult.rows[0];
    const grid = draft.grid || {};

    // 2. Update draft: set last_applied_until = endDate
    await client.query(
      'UPDATE schedule_drafts SET last_applied_until = $1, updated_at = NOW() WHERE id = $2',
      [endDate, req.params.id]
    );

    // 3. Collect user IDs from grid
    //
    // #213: er bestaan twee vormen van een conceptraster, en de sleutels staan
    // er precies omgekeerd in:
    //   single-week : { "<empId>": { "0": {...} }, _pattern: ... }
    //   multi-week  : { _multiWeek: true, "1": { "<empId>": {...} } }
    //
    // Deze lus nam blind het TWEEDE niveau als medewerker-id. Bij een
    // single-week raster leverde dat de dagnummers 0 tot 6 op, die daarna als
    // gebruikers-id's de verwijdering in gingen. apply doet die controle wel
    // (isMultiWeek), deactivate niet. Nu allebei.
    const isMultiWeek = !!grid._multiWeek;
    const userIds = new Set();
    const onthoud = (id) => { const n = parseInt(id); if (!isNaN(n)) userIds.add(n); };

    if (isMultiWeek) {
      // Bovenste niveau is het weeknummer, daaronder staan de medewerkers.
      for (const [key, weekGrid] of Object.entries(grid)) {
        if (key.startsWith('_')) continue;
        if (typeof weekGrid === 'object' && weekGrid !== null) {
          Object.keys(weekGrid).forEach(onthoud);
        }
      }
    } else {
      // Bovenste niveau is de medewerker zelf.
      for (const key of Object.keys(grid)) {
        if (key.startsWith('_')) continue;
        onthoud(key);
      }
    }

    // 4. Verwijder de diensten van DIT concept na endDate.
    //
    // #185: hier stond `user_id = ANY($1) AND date > $2`, zonder bovengrens en
    // zonder koppeling met het concept. Het uitplannen van een paasconcept van
    // twee weken wiste daardoor het volledige toekomstige rooster van iedereen
    // die erin stond, inclusief diensten die een heel ander concept had gemaakt.
    // Sinds migratie 037 draagt elke gegenereerde dienst een draft_id, dus we
    // kunnen precies zijn.
    let shiftsDeleted = 0;
    const byDraft = await client.query(
      `DELETE FROM shifts WHERE draft_id = $1 AND date > $2::date`,
      [req.params.id, endDate]
    );
    shiftsDeleted += byDraft.rowCount;

    // Diensten van vóór migratie 037 hebben geen draft_id. Die kunnen we niet
    // exact toewijzen, dus blijven we binnen wat dit concept aantoonbaar
    // besloeg: zijn eigen toepassingsbereik, zijn eigen medewerkers en zijn
    // eigen teamfilter. Nooit verder.
    //
    // Beide grenzen zijn nodig. Alleen bovenaan begrenzen is niet genoeg: een
    // paasconcept dat enkel 5 t/m 18 april 2027 besloeg wiste bij een endDate
    // van 31 augustus 2026 anders alsnog alle diensten uit september 2026, die
    // onmogelijk van dat concept konden komen.
    //
    // Is het concept nog nooit toegepast, dan heeft het ook niets gegenereerd
    // en gebeurt hier niets.
    const legacyFrom = draft.lastAppliedFrom;
    const legacyUntil = draft.lastAppliedUntil;
    if (userIds.size > 0 && legacyFrom && legacyUntil && legacyUntil > endDate) {
      const params = [Array.from(userIds), endDate, legacyFrom, legacyUntil];
      let legacyQuery = `DELETE FROM shifts
        WHERE draft_id IS NULL
          AND user_id = ANY($1::int[])
          AND date > $2::date
          AND date >= $3::date AND date <= $4::date`;
      if (!deleteManual) legacyQuery += ` AND source = 'auto'`;
      if (draft.team_filter) {
        params.push(draft.team_filter);
        legacyQuery += ` AND team = $${params.length}`;
      }
      const legacy = await client.query(legacyQuery, params);
      shiftsDeleted += legacy.rowCount;
    }

    await client.query('COMMIT');
    await logAudit(req, 'UPDATE', 'settings', req.params.id, {
      action: 'deactivate', endDate, shiftsDeleted, draftName: draft.name,
      scopedFrom: legacyFrom || null, scopedUntil: legacyUntil || null
    });
    res.json({ ok: true, shiftsDeleted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /schedule-drafts/:id/deactivate error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
