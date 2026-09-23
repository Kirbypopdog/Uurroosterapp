// #157: roosterconcepten, uit server.js gehaald. Het vergrendelen hoort bij
// hetzelfde domein en staat daarom in dit bestand; toepassen en buiten werking
// stellen zijn zo lang dat ze een eigen bestand kregen.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

// Een vergrendeling die niemand vrijgeeft (een gesloten tabblad) moet vanzelf
// vervallen. De PUT hieronder schuift ze op bij elke geslaagde autosave (#304).
const DRAFT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minuten

router.get('/schedule-drafts', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, week_number as "weekNumber", team_filter as "teamFilter",
             grid, created_by as "createdBy", created_by_name as "createdByName",
             last_applied_at as "lastAppliedAt", last_applied_by as "lastAppliedBy",
             last_applied_from::text as "lastAppliedFrom", last_applied_until::text as "lastAppliedUntil",
             valid_from::text as "validFrom", valid_until::text as "validUntil",
             updated_by_name as "updatedByName",
             type, holiday_period_id as "holidayPeriodId",
             locked_by as "lockedBy", locked_by_name as "lockedByName", locked_at as "lockedAt",
             created_at as "createdAt", updated_at as "updatedAt"
      FROM schedule_drafts
      ORDER BY updated_at DESC
    `);
    res.json({ drafts: result.rows });
  } catch (err) {
    console.error('Error fetching schedule drafts:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/schedule-drafts', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id, name, weekNumber, teamFilter, grid, validFrom, validUntil, type, holidayPeriodId } = req.body;
  const draftId = id || `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const draftType = type || 'basis';

  // Validatie: vakantieconcept vereist holidayPeriodId
  if (draftType === 'vakantie' && !holidayPeriodId) {
    return res.status(400).json({ error: 'Vakantieconcept vereist een gekoppelde vakantieperiode' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO schedule_drafts (id, name, week_number, team_filter, grid, created_by, created_by_name, valid_from, valid_until, type, holiday_period_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
       RETURNING id, name, week_number as "weekNumber", team_filter as "teamFilter",
                 grid, created_by_name as "createdByName",
                 last_applied_at as "lastAppliedAt", last_applied_by as "lastAppliedBy",
                 valid_from::text as "validFrom", valid_until::text as "validUntil",
                 type, holiday_period_id as "holidayPeriodId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [draftId, name || 'Naamloos', weekNumber || 1, teamFilter || null, JSON.stringify(grid || {}), req.user.id, req.user.name, validFrom || null, validUntil || null, draftType, holidayPeriodId || null]
    );
    await logAudit(req, 'CREATE', 'settings', draftId, { type: 'schedule_draft', draftType, name });
    res.json({ draft: result.rows[0] });
  } catch (err) {
    console.error('Error creating schedule draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/schedule-drafts/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  const { name, weekNumber, teamFilter, grid, lastAppliedAt, lastAppliedBy, validFrom, validUntil, type, holidayPeriodId } = req.body;

  try {
    // Check if concept is locked by someone else
    const lockCheck = await pool.query(
      'SELECT locked_by, locked_by_name, locked_at FROM schedule_drafts WHERE id = $1',
      [id]
    );
    let vernieuwLock = false;
    if (lockCheck.rows.length > 0) {
      const { locked_by, locked_by_name, locked_at } = lockCheck.rows[0];
      const lockExpired = !locked_at || (Date.now() - new Date(locked_at).getTime()) > DRAFT_LOCK_TTL_MS;
      if (locked_by && locked_by !== req.user.id && !lockExpired) {
        return res.status(423).json({ error: `Concept is vergrendeld door ${locked_by_name}` });
      }
      // #304: de hartslag. De frontend nam de vergrendeling één keer bij het
      // openen en vernieuwde ze nooit, terwijl ze na DRAFT_LOCK_TTL_MS vervalt.
      // Wie langer dan dat in een concept werkt, verloor zijn vergrendeling
      // zonder het te weten, en een tweede beheerder kon het openen zonder de
      // waarschuwing die hij een minuut eerder wel zou krijgen. Elke geslaagde
      // autosave schuift ze nu op. Wie niets wijzigt houdt de vervaltermijn,
      // en dat is precies de bedoeling: er is geen unlock bij het sluiten van
      // een tabblad, dus de TTL is de ontsnapping voor achtergelaten locks.
      vernieuwLock = locked_by === req.user.id;
    }

    const setClauses = ['updated_at = NOW()'];
    if (vernieuwLock) setClauses.push('locked_at = NOW()');
    const params = [];
    let paramIndex = 1;

    // Always track who updated
    setClauses.push(`updated_by = $${paramIndex++}`); params.push(req.user.id);
    setClauses.push(`updated_by_name = $${paramIndex++}`); params.push(req.user.name);

    if (name !== undefined) { setClauses.push(`name = $${paramIndex++}`); params.push(name); }
    if (weekNumber !== undefined) { setClauses.push(`week_number = $${paramIndex++}`); params.push(weekNumber); }
    if (teamFilter !== undefined) { setClauses.push(`team_filter = $${paramIndex++}`); params.push(teamFilter); }
    if (grid !== undefined) { setClauses.push(`grid = $${paramIndex++}`); params.push(JSON.stringify(grid)); }
    if (lastAppliedAt !== undefined) { setClauses.push(`last_applied_at = $${paramIndex++}`); params.push(lastAppliedAt); }
    if (lastAppliedBy !== undefined) { setClauses.push(`last_applied_by = $${paramIndex++}`); params.push(lastAppliedBy); }
    if (validFrom !== undefined) { setClauses.push(`valid_from = $${paramIndex++}`); params.push(validFrom || null); }
    if (validUntil !== undefined) { setClauses.push(`valid_until = $${paramIndex++}`); params.push(validUntil || null); }
    if (type !== undefined) { setClauses.push(`type = $${paramIndex++}`); params.push(type); }
    if (holidayPeriodId !== undefined) { setClauses.push(`holiday_period_id = $${paramIndex++}`); params.push(holidayPeriodId || null); }

    params.push(id);

    const result = await pool.query(
      `UPDATE schedule_drafts SET ${setClauses.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, name, week_number as "weekNumber", team_filter as "teamFilter",
                 grid, created_by_name as "createdByName", updated_by_name as "updatedByName",
                 last_applied_at as "lastAppliedAt", last_applied_by as "lastAppliedBy",
                 valid_from::text as "validFrom", valid_until::text as "validUntil",
                 type, holiday_period_id as "holidayPeriodId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }
    await logAudit(req, 'UPDATE', 'settings', id, { type: 'schedule_draft', name: result.rows[0].name });
    res.json({ draft: result.rows[0] });
  } catch (err) {
    console.error('Error updating schedule draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/schedule-drafts/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM schedule_drafts WHERE id = $1 RETURNING name', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }
    await logAudit(req, 'DELETE', 'settings', id, { type: 'schedule_draft', name: result.rows[0].name });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting schedule draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== LOCK / UNLOCK SCHEDULE DRAFT =====
router.post('/schedule-drafts/:id/lock', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  const { force = false } = req.body || {};
  try {
    const result = await pool.query(
      'SELECT locked_by, locked_by_name, locked_at FROM schedule_drafts WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Concept niet gevonden' });

    const { locked_by, locked_by_name, locked_at } = result.rows[0];
    const expired = !locked_at || (Date.now() - new Date(locked_at).getTime()) > DRAFT_LOCK_TTL_MS;
    const byOther = locked_by && locked_by !== req.user.id && !expired;

    if (byOther && !force) {
      return res.status(423).json({ error: 'locked', lockedByName: locked_by_name, lockedAt: locked_at });
    }

    await pool.query(
      'UPDATE schedule_drafts SET locked_by = $1, locked_by_name = $2, locked_at = NOW() WHERE id = $3',
      [req.user.id, req.user.name, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error locking draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/schedule-drafts/:id/unlock', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE schedule_drafts SET locked_by = NULL, locked_by_name = NULL, locked_at = NULL
       WHERE id = $1 AND (locked_by = $2 OR $3)`,
      [id, req.user.id, req.user.role === 'admin']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error unlocking draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
