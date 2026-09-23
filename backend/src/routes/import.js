// #157: het importeren van een JSON-backup, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const bcrypt = require('bcryptjs');
const DEFAULT_RESET_PASSWORD = process.env.DEFAULT_RESET_PASSWORD;

const router = maakRouter();

// Backup terugzetten.
//
// Draait in één transactie, met een SAVEPOINT per item (#214). Zonder
// transactie bleef bij een halverwege afgebroken import de helft staan.
// De savepoints houden het bestaande gedrag intact: een rij die niet
// deugt wordt overgeslagen en gemeld, de rest gaat gewoon door. Zonder
// savepoint zou de eerste fout de hele transactie in aborted-toestand
// zetten en zou alles erna alsnog falen.
router.post('/import', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { users, shifts, availability, settings } = req.body || {};
  const results = { imported: 0, skipped: 0, errors: [] };
  const isAdmin = req.user.role === 'admin';

  const client = await pool.connect();
  // Voert één item uit binnen een savepoint. Faalt het, dan rolt alleen dat
  // item terug en blijft de transactie bruikbaar voor de volgende.
  async function perItem(label, fn) {
    await client.query('SAVEPOINT item');
    try {
      await fn();
      await client.query('RELEASE SAVEPOINT item');
      results.imported++;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT item').catch(() => {});
      results.errors.push({ ...label, error: err.message });
      results.skipped++;
    }
  }

  try {
    await client.query('BEGIN');

    // Import users (with schedule data)
    if (Array.isArray(users)) {
      // Eén keer hashen voor nieuwe users — voorkomt timeout bij bulk-import
      // op beperkte CPU (bv. gratis Render plan). Bestaande users worden
      // geüpdatet zonder nieuw wachtwoord; nieuwe krijgen dit hash (#staging).
      const defaultPasswordHash = users.some(u => u.email) ? await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12) : null;

      for (const user of users) {
        await perItem({ name: user.name }, async () => {
          // Validate team exists if specified
          let mainTeam = user.mainTeam || null;
          if (mainTeam) {
            const teamCheck = await client.query('SELECT id FROM teams WHERE id = $1', [mainTeam]);
            if (teamCheck.rows.length === 0) mainTeam = null;
          }

          const week1Json = JSON.stringify(user.weekScheduleWeek1 || []);
          const week2Json = JSON.stringify(user.weekScheduleWeek2 || []);
          const wsJson = Array.isArray(user.weekSchedules) && user.weekSchedules.length > 0
            ? JSON.stringify(user.weekSchedules)
            : JSON.stringify([user.weekScheduleWeek1 || [], user.weekScheduleWeek2 || []]);

          const existing = await client.query(
            'SELECT id, role, active FROM users WHERE email = $1',
            [user.email?.toLowerCase()]
          );

          if (existing.rows.length > 0) {
            const huidig = existing.rows[0];

            // #200: de import werkte ook `active` bij, en stond open voor een
            // roosterverantwoordelijke. Die kon daarmee het adminaccount
            // deactiveren en zichzelf de hoogste autoriteit maken, terwijl de
            // rollentabel zegt: geen accountbeheer. Alleen een admin mag de
            // actief-vlag nog zetten; voor de rest blijft die ongemoeid.
            const nieuwActief = isAdmin ? (user.active !== false) : huidig.active;

            // Het laatste actieve adminaccount mag door niemand worden
            // uitgeschakeld, ook niet door een andere admin. Anders sluit de
            // organisatie zichzelf buiten en is er geen weg terug via de app.
            if (huidig.role === 'admin' && huidig.active && nieuwActief === false) {
              const anderen = await client.query(
                `SELECT COUNT(*)::int AS n FROM users
                 WHERE role = 'admin' AND active = true AND id != $1`,
                [huidig.id]
              );
              if (anderen.rows[0].n === 0) {
                throw new Error('Het laatste actieve beheerdersaccount kan niet gedeactiveerd worden');
              }
            }

            // #214: team_id ontbrak hier, terwijl main_team wel werd
            // bijgewerkt. Een backup die iemand van team verandert liet die
            // twee scheef achter, en dan wijst de app hem in het ene team aan
            // terwijl de autorisatie hem nog in het andere plaatst
            // (CLAUDE.md regel 2). De import is juist het herstelpad, dus dat
            // is de slechtst denkbare plek om rechten stuk te maken.
            await client.query(`
              UPDATE users SET
                name = $1,
                main_team = $2,
                team_id = $2,
                contract_hours = $3,
                active = $4,
                week_schedule_week1 = $5::jsonb,
                week_schedule_week2 = $6::jsonb,
                week_schedules = $7::jsonb
              WHERE email = $8
            `, [
              user.name, mainTeam, user.contractHours || 0, nieuwActief,
              week1Json, week2Json, wsJson, user.email.toLowerCase()
            ]);
          } else if (user.email) {
            // Create new user with default password (hash berekend vóór de loop).
            // De rol staat vast op 'medewerker': een import mag geen beheerders
            // aanmaken, ook niet als het bestand dat beweert (#200).
            await client.query(`
              INSERT INTO users (name, email, password_hash, role, team_id, main_team, contract_hours, active, week_schedule_week1, week_schedule_week2, week_schedules)
              VALUES ($1, $2, $3, 'medewerker', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
            `, [
              user.name, user.email.toLowerCase(), defaultPasswordHash,
              mainTeam, mainTeam, user.contractHours || 0,
              isAdmin ? (user.active !== false) : true,
              week1Json, week2Json, wsJson
            ]);
          } else {
            throw new Error('Email is required');
          }
        });
      }
    }

    // Import shifts
    if (Array.isArray(shifts)) {
      for (const shift of shifts) {
        await perItem({ shift: shift.date }, async () => {
          await client.query(`
            INSERT INTO shifts (user_id, team, date, start_time, end_time, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [shift.userId, shift.team || null, shift.date, shift.startTime, shift.endTime, shift.notes || '']);
        });
      }
    }

    // Import availability
    if (Array.isArray(availability)) {
      for (const avail of availability) {
        await perItem({ availability: avail.date }, async () => {
          await client.query(`
            INSERT INTO availability (user_id, date, type, reason, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (user_id, date) DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
          `, [avail.userId, avail.date, avail.type, avail.reason || '']);
        });
      }
    }

    // #217: settings werden wel uitgelezen uit de body maar nergens gebruikt.
    // Wie na een reset een backup terugzette, kreeg zijn vakantieperiodes,
    // gesloten dagen, roosterregels en dienstsjablonen niet terug, terwijl de
    // knop wel "backup" heet.
    //
    // Een object per sleutel, want zo staat het ook in de settings-tabel.
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) continue;
        await perItem({ setting: key }, async () => {
          await client.query(`
            INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()
          `, [key, JSON.stringify(value)]);
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /import error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }

  await logAudit(req, 'IMPORT', 'system', '', { imported: results.imported, skipped: results.skipped, errorCount: results.errors.length });
  res.json({ ok: true, results });
});

module.exports = router;
