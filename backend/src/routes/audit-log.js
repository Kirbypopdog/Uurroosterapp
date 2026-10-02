// #157: het uitlezen van de audit log, uit server.js gehaald. Het SCHRIJVEN
// zit in helpers/audit.js, want dat doet bijna elke route.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

router.get('/shifts/archived', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { userId, startDate, endDate } = req.query;
  try {
    const params = [];
    let where = 'WHERE archived = true';
    if (userId) { params.push(userId); where += ` AND user_id = $${params.length}`; }
    if (startDate) { params.push(startDate); where += ` AND date >= $${params.length}`; }
    if (endDate) { params.push(endDate); where += ` AND date <= $${params.length}`; }
    const result = await pool.query(
      `SELECT id, user_id as "userId", team, date::text, start_time as "startTime", end_time as "endTime", notes, source
       FROM shifts ${where} ORDER BY date DESC LIMIT 500`,
      params
    );
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/audit-log', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { page = 1, limit = 50, actorId, action, resourceType, startDate, endDate } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let whereClause = 'WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (actorId) { whereClause += ` AND actor_id = $${paramIndex++}`; params.push(Number(actorId)); }
  if (action) { whereClause += ` AND action = $${paramIndex++}`; params.push(action); }
  if (resourceType) { whereClause += ` AND resource_type = $${paramIndex++}`; params.push(resourceType); }
  if (startDate) { whereClause += ` AND created_at >= $${paramIndex++}`; params.push(startDate); }
  if (endDate) { whereClause += ` AND created_at <= $${paramIndex++}::date + interval '1 day'`; params.push(endDate); }

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM audit_log ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    params.push(Number(limit), offset);
    const result = await pool.query(
      `SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    res.json({ logs: result.rows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('GET /audit-log error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
