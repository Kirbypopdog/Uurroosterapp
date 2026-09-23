// #157: shift blocks, uit server.js gehaald. Een block houdt bij dat een dag
// bewust leeg is, zodat de generatie er niet opnieuw een dienst neerzet.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

router.get('/shift-blocks', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sb.id, sb.user_id, sb.date::text as date, sb.created_at, sb.created_by, sb.reason, u.name as created_by_name
      FROM shift_blocks sb
      LEFT JOIN users u ON sb.created_by = u.id
      ORDER BY sb.date DESC, sb.user_id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift blocks:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/shift-blocks', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const { user_id, date, reason } = req.body;

    if (!user_id || !date) {
      return res.status(400).json({ error: 'user_id en date zijn verplicht' });
    }

    // Create shift block (ON CONFLICT DO NOTHING to make it idempotent)
    const result = await pool.query(`
      INSERT INTO shift_blocks (user_id, date, created_by, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, date) DO NOTHING
      RETURNING *
    `, [user_id, date, req.user.id, reason || 'Created via drag & drop']);

    if (result.rows[0]) {
      await logAudit(req, 'CREATE', 'shift_block', result.rows[0].id, { user_id, date, reason });
    }
    res.json(result.rows[0] || { message: 'Block already exists' });
  } catch (err) {
    console.error('Error creating shift block:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk delete shift blocks by date range (for schedule regeneration)
router.delete('/shift-blocks/range', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const { startDate, endDate, userId } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate en endDate zijn verplicht' });
    }

    let query = 'DELETE FROM shift_blocks WHERE date >= $1::date AND date <= $2::date';
    const params = [startDate, endDate];

    if (userId) {
      query += ' AND user_id = $3';
      params.push(Number(userId));
    }

    const result = await pool.query(query, params);
    await logAudit(req, 'DELETE', 'shift_block', '', { action: 'bulk_delete', startDate, endDate, userId: userId || 'all', count: result.rowCount });
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Error bulk deleting shift blocks:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/shift-blocks/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const blockId = parseInt(req.params.id, 10);
    if (!blockId) {
      return res.status(400).json({ error: 'ID is verplicht' });
    }

    await pool.query('DELETE FROM shift_blocks WHERE id = $1', [blockId]);
    await logAudit(req, 'DELETE', 'shift_block', blockId, {});
    res.json({ message: 'Shift block removed successfully' });
  } catch (err) {
    console.error('Error deleting shift block:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
