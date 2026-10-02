// #157: de teams, uit server.js gehaald.
//
// Dit domein is klein en hangt maar aan vier dingen: de databank, de twee
// controles op inloggen en rol, en de audit log. Daarmee is het de eerste
// die verhuist: als het patroon hier niet klopt, klopt het nergens.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');

const router = maakRouter();

router.get('/teams', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, color FROM teams ORDER BY name'
    );
    res.json({ teams: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/teams', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id, name, color } = req.body;

  if (!id || !name || !color) {
    return res.status(400).json({ error: 'id, name en color zijn verplicht' });
  }

  if (!/^[a-z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: 'Team ID mag alleen lowercase letters, cijfers en underscores bevatten' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO teams (id, name, color) VALUES ($1, $2, $3) RETURNING *',
      [id, name, color]
    );

    await logAudit(req, 'CREATE', 'settings', id, { action: 'create_team', name, color });
    res.status(201).json({ team: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Een team met dit ID bestaat al' });
    }
    console.error('POST /teams error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/teams/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  const { name, color } = req.body;

  if (!name && !color) {
    return res.status(400).json({ error: 'name of color is verplicht' });
  }

  try {
    const existing = await pool.query('SELECT * FROM teams WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Team niet gevonden' });
    }

    const newName = name || existing.rows[0].name;
    const newColor = color || existing.rows[0].color;

    const result = await pool.query(
      'UPDATE teams SET name = $1, color = $2 WHERE id = $3 RETURNING *',
      [newName, newColor, id]
    );

    await logAudit(req, 'UPDATE', 'settings', id, { action: 'update_team', name: newName, color: newColor });
    res.json({ team: result.rows[0] });
  } catch (err) {
    console.error('PUT /teams/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/teams/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;

  try {
    // Check if team has users assigned
    const usersWithTeam = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE team_id = $1 OR main_team = $1', [id]
    );
    if (parseInt(usersWithTeam.rows[0].count) > 0) {
      return res.status(409).json({ error: `Team heeft nog ${usersWithTeam.rows[0].count} medewerker(s). Verplaats ze eerst naar een ander team.` });
    }

    // #256: alleen medewerkers werden geteld, niet de diensten. shifts.team
    // heeft ook een foreign key naar deze tabel, dus een team met historische
    // diensten gaf hier een FK-fout en dus een kale 500. De frontend ving die
    // op in een leeg catch-blok, waardoor het team uit de instellingen
    // verdween maar in de tabel bleef staan en oude diensten "Onbekend" gingen
    // tonen.
    const shiftsWithTeam = await pool.query('SELECT COUNT(*) as count FROM shifts WHERE team = $1', [id]);
    const aantalShifts = parseInt(shiftsWithTeam.rows[0].count, 10);
    if (aantalShifts > 0) {
      return res.status(409).json({
        error: `Team heeft nog ${aantalShifts} dienst(en) in de planning. Verwijder of verplaats die eerst.`
      });
    }

    const result = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team niet gevonden' });
    }

    await logAudit(req, 'DELETE', 'settings', id, { action: 'delete_team', name: result.rows[0].name });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /teams/:id error:', err);
    // #256: 23503 is een foreign key violation. Die als 500 teruggeven zegt
    // de gebruiker niets; het is een geldige vraag met een geldig antwoord.
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Dit team wordt nog gebruikt in de planning of door een medewerker.' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
