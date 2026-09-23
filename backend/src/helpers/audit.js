// #157: de audit log, uit server.js gehaald. Bijna elke schrijfroute gebruikt
// deze functie, dus hij hoort niet in één domein thuis.
const { pool } = require('../db');

async function logAudit(req, action, resourceType, resourceId, details = {}) {
  try {
    const actorId = req.user?.id || null;
    const actorName = req.user?.name || req.body?.email || 'System';
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_name, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId, actorName, action, resourceType, String(resourceId || ''), JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

module.exports = { logAudit };
