// #157: activiteiten binnen een dienst, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

router.get('/shift-activities', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  const buildActivitiesQuery = (withShiftId) => {
    const shiftIdCol = withShiftId ? 'shift_id as "shiftId"' : 'NULL as "shiftId"';
    const params = [];
    let q = `SELECT id, user_id as "userId", ${shiftIdCol}, date::text as "date", start_time as "startTime",
             end_time as "endTime", type, description, created_at as "createdAt"
             FROM shift_activities`;
    if (startDate && endDate) {
      q += ' WHERE date >= $1 AND date <= $2';
      params.push(startDate, endDate);
    }
    q += ' ORDER BY date, start_time';
    return { query: q, params };
  };

  try {
    const { query, params } = buildActivitiesQuery(true);
    const result = await pool.query(query, params);
    res.json({ activities: result.rows });
  } catch (err) {
    if (err.code === '42703') {
      // shift_id kolom bestaat nog niet — fallback zonder shift_id
      try {
        const { query, params } = buildActivitiesQuery(false);
        const result = await pool.query(query, params);
        return res.json({ activities: result.rows });
      } catch (err2) {
        console.error('GET /shift-activities error (fallback):', err2);
        return res.status(500).json({ error: 'Server error' });
      }
    }
    console.error('GET /shift-activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/shift-activities', requireAuth, async (req, res) => {
  const { userId, shiftId, date, startTime, endTime, type, description } = req.body || {};
  if (!userId || !date || !startTime || !endTime || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken (userId, date, startTime, endTime, type)' });
  }

  // Permission check: medewerker can only create for themselves
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker' && Number(userId) !== currentUserId) {
    return res.status(403).json({ error: 'Je kunt alleen activiteiten voor jezelf aanmaken' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO shift_activities (user_id, shift_id, date, start_time, end_time, type, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id as "userId", shift_id as "shiftId", date::text as "date", start_time as "startTime",
                end_time as "endTime", type, description, created_at as "createdAt"
    `, [userId, shiftId || null, date, startTime, endTime, type, description || '']);

    await logAudit(req, 'CREATE', 'shift_activity', result.rows[0].id, { activity: result.rows[0] });
    res.status(201).json({ activity: result.rows[0] });
  } catch (err) {
    console.error('POST /shift-activities error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

router.put('/shift-activities/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { startTime, endTime, type, description } = req.body || {};

  const { role, id: currentUserId } = req.user;

  try {
    // Permission check: medewerker can only edit own activities.
    // #215: stond hiervoor buiten de try, waardoor een databasestoring hier
    // een onafgehandelde afwijzing opleverde en het proces meenam.
    if (role === 'medewerker') {
      const existing = await pool.query('SELECT user_id FROM shift_activities WHERE id = $1', [id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
        return res.status(403).json({ error: 'Je kunt alleen je eigen activiteiten bewerken' });
      }
    }

    const result = await pool.query(`
      UPDATE shift_activities
      SET start_time = COALESCE($1, start_time),
          end_time = COALESCE($2, end_time),
          type = COALESCE($3, type),
          description = COALESCE($4, description)
      WHERE id = $5
      RETURNING id, user_id as "userId", date::text as "date", start_time as "startTime",
                end_time as "endTime", type, description, created_at as "createdAt"
    `, [startTime, endTime, type, description, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activiteit niet gevonden' });
    }
    await logAudit(req, 'UPDATE', 'shift_activity', id, { activity: result.rows[0] });
    res.json({ activity: result.rows[0] });
  } catch (err) {
    console.error('PUT /shift-activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/shift-activities/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  const { role, id: currentUserId } = req.user;

  try {
    // Permission check: medewerker can only delete own activities.
    // #215: zie de PUT hierboven, zelfde reden.
    if (role === 'medewerker') {
      const existing = await pool.query('SELECT user_id FROM shift_activities WHERE id = $1', [id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
        return res.status(403).json({ error: 'Je kunt alleen je eigen activiteiten verwijderen' });
      }
    }

    const result = await pool.query('DELETE FROM shift_activities WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activiteit niet gevonden' });
    }
    await logAudit(req, 'DELETE', 'shift_activity', id, {});
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /shift-activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
