// #418: algemene activiteiten — aan een DAG, niet aan een persoon.
//
// Een brandoefening of een teamdag hoort niet bij één medewerker. Iedereen ziet
// ze (in de dagkop van de planning, op het beginscherm en in de agendafeed);
// alleen admin en roosterverantwoordelijke maken ze aan, zoals het rooster
// zelf. Ze verlagen de bezetting NIET: de app weet niet wie er van de vloer
// gaat, dus ze zijn informatief. Dat is een keuze van Victor.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { isGeldigeDatumString, isValidTime } = require('../helpers/dienstregels');

const router = maakRouter();
const BEHEER = requireRole('admin', 'roosterverantwoordelijke');

const MAX_TITEL = 120;
const MAX_OMSCHRIJVING = 1000;

const KOLOMMEN = `id, date::text AS "date",
  to_char(start_time, 'HH24:MI') AS "startTime",
  to_char(end_time, 'HH24:MI') AS "endTime",
  titel, omschrijving, created_by AS "createdBy", updated_at AS "updatedAt"`;

/**
 * Controleert en normaliseert de invoer. Geeft `{ fout }` of `{ waarden }`.
 *
 * Uren zijn optioneel, maar dan allebei: één ingevuld is geen "hele dag" en
 * ook geen tijdvak. Een lege string telt als niet ingevuld, want zo komt een
 * leeg <input type="time"> binnen.
 */
function controleer(body) {
  const b = body || {};
  const date = b.date;
  const titel = typeof b.titel === 'string' ? b.titel.trim() : '';
  const omschrijving = typeof b.omschrijving === 'string' ? b.omschrijving.trim() : '';
  const van = b.startTime ? String(b.startTime).substring(0, 5) : null;
  const tot = b.endTime ? String(b.endTime).substring(0, 5) : null;

  if (!isGeldigeDatumString(date)) return { fout: 'Ongeldige datum' };
  if (!titel) return { fout: 'Een titel is verplicht' };
  if (titel.length > MAX_TITEL) return { fout: `De titel mag hoogstens ${MAX_TITEL} tekens lang zijn` };
  if (omschrijving.length > MAX_OMSCHRIJVING) return { fout: `De omschrijving mag hoogstens ${MAX_OMSCHRIJVING} tekens lang zijn` };
  if ((van && !tot) || (!van && tot)) return { fout: 'Vul beide uren in, of geen van beide voor de hele dag' };
  if (van && (!isValidTime(van) || !isValidTime(tot))) return { fout: 'Tijdstip moet HH:MM zijn' };
  if (van && tot <= van) return { fout: 'Het einduur moet na het beginuur liggen' };

  return { waarden: { date, titel, omschrijving, van, tot } };
}

router.get('/dag-activiteiten', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  const params = [];
  let waar = '';
  if (startDate || endDate) {
    if (!isGeldigeDatumString(startDate) || !isGeldigeDatumString(endDate)) {
      return res.status(400).json({ error: 'startDate en endDate moeten YYYY-MM-DD zijn' });
    }
    waar = 'WHERE date >= $1 AND date <= $2';
    params.push(startDate, endDate);
  }
  const result = await pool.query(
    `SELECT ${KOLOMMEN} FROM dag_activiteiten ${waar} ORDER BY date, start_time NULLS FIRST, id`, params);
  res.json({ dagActiviteiten: result.rows });
});

router.post('/dag-activiteiten', requireAuth, BEHEER, async (req, res) => {
  const { fout, waarden } = controleer(req.body);
  if (fout) return res.status(400).json({ error: fout });
  const result = await pool.query(
    `INSERT INTO dag_activiteiten (date, start_time, end_time, titel, omschrijving, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${KOLOMMEN}`,
    [waarden.date, waarden.van, waarden.tot, waarden.titel, waarden.omschrijving, req.user.id]);
  await logAudit(req, 'CREATE', 'dag_activiteit', result.rows[0].id, { dagActiviteit: result.rows[0] });
  res.status(201).json({ dagActiviteit: result.rows[0] });
});

router.put('/dag-activiteiten/:id', requireAuth, BEHEER, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig id' });
  const { fout, waarden } = controleer(req.body);
  if (fout) return res.status(400).json({ error: fout });
  const oud = await pool.query(`SELECT ${KOLOMMEN} FROM dag_activiteiten WHERE id = $1`, [id]);
  if (!oud.rows.length) return res.status(404).json({ error: 'Activiteit niet gevonden' });
  const result = await pool.query(
    `UPDATE dag_activiteiten
        SET date = $1, start_time = $2, end_time = $3, titel = $4, omschrijving = $5
      WHERE id = $6
      RETURNING ${KOLOMMEN}`,
    [waarden.date, waarden.van, waarden.tot, waarden.titel, waarden.omschrijving, id]);
  await logAudit(req, 'UPDATE', 'dag_activiteit', id, { voor: oud.rows[0], na: result.rows[0] });
  res.json({ dagActiviteit: result.rows[0] });
});

router.delete('/dag-activiteiten/:id', requireAuth, BEHEER, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig id' });
  const result = await pool.query(`DELETE FROM dag_activiteiten WHERE id = $1 RETURNING ${KOLOMMEN}`, [id]);
  if (!result.rows.length) return res.status(404).json({ error: 'Activiteit niet gevonden' });
  await logAudit(req, 'DELETE', 'dag_activiteit', id, { dagActiviteit: result.rows[0] });
  res.json({ ok: true });
});

module.exports = router;
module.exports.controleer = controleer;
