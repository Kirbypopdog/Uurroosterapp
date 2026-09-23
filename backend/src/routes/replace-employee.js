// #157: een medewerker vervangen door een ander, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

// Hernoemt een medewerker-ID in een concept-grid van old → new, zónder de
// dag-van-de-week-indexen (0-6) aan te raken. Vervangt de oude naïeve
// tekstvervanging die elke dagindex met datzelfde nummer corrumpeerde (#141).
// Ondersteunt beide layouts:
//   single-week : { "<empId>": { "0": {...}, "3": {...} }, _pattern: ... }
//   multi-week  : { _multiWeek: true, "1": { "<empId>": {...} }, ... }
function remapDraftGridUser(grid, oldId, newId) {
  if (!grid || typeof grid !== 'object') return { grid, changed: false };
  const oldKey = String(oldId);
  const newKey = String(newId);
  let changed = false;

  // Hernoemt de medewerker-sleutel binnen één employee-laag. Bij een conflict
  // (newKey bestaat al) mergen we per dag, waarbij de overgedragen (oude)
  // toewijzingen winnen.
  const remapEmployeeLayer = (layer) => {
    if (!layer || typeof layer !== 'object' || !(oldKey in layer)) return layer;
    const out = { ...layer };
    const moved = out[oldKey];
    delete out[oldKey];
    out[newKey] = (out[newKey] && typeof out[newKey] === 'object' && moved && typeof moved === 'object')
      ? { ...out[newKey], ...moved }
      : moved;
    changed = true;
    return out;
  };

  if (grid._multiWeek) {
    const out = {};
    for (const [key, val] of Object.entries(grid)) {
      out[key] = key.startsWith('_') ? val : remapEmployeeLayer(val);
    }
    return { grid: out, changed };
  }
  return { grid: remapEmployeeLayer(grid), changed };
}

router.post('/admin/users/:id/replace', requireAuth, requireAdmin, async (req, res) => {
  const oldUserId = Number(req.params.id);
  const { replacementUserId, transferShiftsFrom } = req.body;
  const newUserId = Number(replacementUserId);

  if (!oldUserId || !newUserId) {
    return res.status(400).json({ error: 'Oud en nieuw gebruiker ID zijn verplicht' });
  }
  if (oldUserId === newUserId) {
    return res.status(400).json({ error: 'Oud en nieuw gebruiker mogen niet dezelfde zijn' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock both users to prevent race conditions
    const oldUserResult = await client.query(
      `SELECT id, name, main_team, team_id, extra_teams, contract_hours,
              week_schedules, week_schedule_week1, week_schedule_week2
       FROM users WHERE id = $1 FOR UPDATE`,
      [oldUserId]
    );
    const newUserResult = await client.query(
      `SELECT id, name, active FROM users WHERE id = $1 FOR UPDATE`,
      [newUserId]
    );

    if (oldUserResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Vertrekkende medewerker niet gevonden' });
    }
    if (newUserResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Nieuwe medewerker niet gevonden' });
    }

    const oldUser = oldUserResult.rows[0];
    const newUser = newUserResult.rows[0];

    // 1. Copy week_schedules from old to new
    await client.query(
      `UPDATE users SET
        week_schedules = $1,
        week_schedule_week1 = $2,
        week_schedule_week2 = $3
       WHERE id = $4`,
      [
        JSON.stringify(oldUser.week_schedules),
        JSON.stringify(oldUser.week_schedule_week1),
        JSON.stringify(oldUser.week_schedule_week2),
        newUserId
      ]
    );

    // 2. Optionally transfer future shifts
    let shiftsTransferred = 0;
    if (transferShiftsFrom) {
      const transferResult = await client.query(
        `UPDATE shifts SET user_id = $1 WHERE user_id = $2 AND date >= $3`,
        [newUserId, oldUserId, transferShiftsFrom]
      );
      shiftsTransferred = transferResult.rowCount;

      // Also transfer shift_blocks for transferred dates
      await client.query(
        `UPDATE shift_blocks sb SET user_id = $1
         WHERE sb.user_id = $2 AND sb.date >= $3
         AND NOT EXISTS (SELECT 1 FROM shift_blocks sb2 WHERE sb2.user_id = $1 AND sb2.date = sb.date)`,
        [newUserId, oldUserId, transferShiftsFrom]
      );

      // Transfer activities for transferred dates
      await client.query(
        `UPDATE shift_activities SET user_id = $1 WHERE user_id = $2 AND date >= $3`,
        [newUserId, oldUserId, transferShiftsFrom]
      );
    }

    // 3. Deactivate old user
    await client.query(
      `UPDATE users SET active = false WHERE id = $1`,
      [oldUserId]
    );

    // 4. Update schedule_drafts: vervang oud medewerker-ID door nieuw in het grid.
    //    We parsen het grid in code en hernoemen enkel de medewerker-sleutels,
    //    zodat dag-van-de-week-indexen niet per ongeluk meeveranderen (#141).
    const draftsResult = await client.query(
      `SELECT id, grid FROM schedule_drafts WHERE grid::text LIKE $1 FOR UPDATE`,
      ['%"' + String(oldUserId) + '"%']
    );
    let draftsUpdated = 0;
    for (const row of draftsResult.rows) {
      const { grid: newGrid, changed } = remapDraftGridUser(row.grid, oldUserId, newUserId);
      if (changed) {
        await client.query(
          `UPDATE schedule_drafts SET grid = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(newGrid), row.id]
        );
        draftsUpdated++;
      }
    }

    // 5. No auto-regeneration — user should re-apply active concept via Rooster Bouwen

    await client.query('COMMIT');

    await logAudit(req, 'REPLACE', 'user', oldUserId, {
      oldUser: { id: oldUserId, name: oldUser.name },
      newUser: { id: newUserId, name: newUser.name },
      shiftsTransferred,
      draftsUpdated,
      transferFrom: transferShiftsFrom || null,
      scheduleCopied: true
    });

    res.json({
      ok: true,
      oldUser: { id: oldUserId, name: oldUser.name },
      newUser: { id: newUserId, name: newUser.name },
      shiftsTransferred,
      draftsUpdated,
      shiftsGenerated: 0,
      hint: transferShiftsFrom ? null : 'apply_concept'
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Replace user error:', err);
    res.status(500).json({ error: 'Server error bij vervanging' });
  } finally {
    client.release();
  }
});

module.exports = router;
