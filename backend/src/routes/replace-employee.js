// #157: een medewerker vervangen door een ander, uit server.js gehaald.
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireAdmin, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { vandaagInBelgie } = require('../utils');

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
  const {
    replacementUserId,
    transferShiftsFrom,
    // Wat er moet gebeuren met de diensten die de VERVANGER zelf al had staan
    // vanaf de overnamedatum. 'behouden' is de veilige standaard: dat is echt
    // werk waar al op gerekend is.
    eigenDienstenVervanger = 'behouden',
  } = req.body;
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

    // De vervanger moet een werkend account hebben. Het venster toont alleen
    // actieve medewerkers, maar dat is de helft van de controle: wie de API
    // rechtstreeks aanroept kwam er hier gewoon langs, en dan komen er diensten
    // terecht bij iemand die niet meer kan inloggen.
    // Gaat de overname pas later in? Dan verhuizen de DIENSTEN nu wel, want de
    // planning moet vooruit kloppen, maar het deactiveren en het overzetten van
    // team en uren wacht tot die dag. Anders sluit je iemand buiten die nog een
    // week moet werken, en krijgt de vervanger een contract dat nog niet
    // begonnen is.
    // Belgische datum, niet de UTC-datum van de server: anders leest een
    // beheerder die om 00:30 een overname op VANDAAG zet, een ingangsdatum die
    // volgens de server nog in de toekomst ligt, en wordt de vervanging
    // ingepland in plaats van meteen uitgevoerd (#299 in de frontend).
    const vandaag = vandaagInBelgie();
    const gaatLaterIn = !!transferShiftsFrom && transferShiftsFrom > vandaag;

    if (newUser.active === false) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(409).json({ error: `${newUser.name} is niet actief en kan geen diensten overnemen` });
    }

    // 1. Het rooster van de vertrekker overnemen: het weekrooster, maar ook het
    //    TEAM en de CONTRACTUREN.
    //
    //    Die laatste twee stonden hier niet, terwijl ze wel opgehaald werden.
    //    Het gevolg was zichtbaar: de vervanger bleef in haar eigen team staan
    //    en erfde tientallen diensten van een ander team, dus de bezetting per
    //    team klopte langs twee kanten niet. En met de contracturen van de
    //    vervanger tegen het rooster van de vertrekker stond elke week meteen
    //    in het rood.
    //
    //    team_id gaat mee op main_team, niet op de oude team_id: die twee horen
    //    gelijk te zijn (CLAUDE.md regel 2) en anders falen de permissies.
    if (!gaatLaterIn) await client.query(
      `UPDATE users SET
        week_schedules = $1,
        week_schedule_week1 = $2,
        week_schedule_week2 = $3,
        main_team = $4,
        team_id = $4,
        extra_teams = $5,
        contract_hours = $6
       WHERE id = $7`,
      [
        JSON.stringify(oldUser.week_schedules),
        JSON.stringify(oldUser.week_schedule_week1),
        JSON.stringify(oldUser.week_schedule_week2),
        oldUser.main_team,
        oldUser.extra_teams || [],
        oldUser.contract_hours,
        newUserId
      ]
    );

    // 2. Optionally transfer future shifts
    let shiftsTransferred = 0;
    let eigenDienstenVerwijderd = 0;
    if (transferShiftsFrom) {
      // Eerst de eigen diensten van de vervanger, als die weg mogen. Daarna
      // kan er niets meer botsen.
      if (eigenDienstenVervanger === 'verwijderen') {
        const weg = await client.query(
          `DELETE FROM shifts WHERE user_id = $1 AND date >= $2`,
          [newUserId, transferShiftsFrom]
        );
        eigenDienstenVerwijderd = weg.rowCount;
      } else {
        // Botsingen vooraf opzoeken in plaats van de databank erover te laten
        // struikelen. Er staat een unieke index op (gebruiker, datum,
        // starttijd): valt de vervanging daarop, dan draait alles terug en
        // krijgt de beheerder alleen "Server error bij vervanging" te zien,
        // zonder één aanwijzing wélke dag het probleem is.
        //
        // Ook overlappende diensten met een ANDERE starttijd worden gemeld.
        // Die zouden er stilletijds doorglippen en de vervanger twee diensten
        // op één dag geven.
        const botsingen = await client.query(
          `SELECT o.date::text AS datum,
                  o.start_time AS vertrekker_start, o.end_time AS vertrekker_eind,
                  n.start_time AS vervanger_start, n.end_time AS vervanger_eind,
                  (o.start_time = n.start_time) AS zelfde_start
             FROM shifts o
             JOIN shifts n ON n.user_id = $2 AND n.date = o.date
            WHERE o.user_id = $1 AND o.date >= $3
              AND (o.start_time = n.start_time
                   OR (o.start_time < n.end_time AND n.start_time < o.end_time))
            ORDER BY o.date, o.start_time`,
          [oldUserId, newUserId, transferShiftsFrom]
        );
        if (botsingen.rows.length > 0) {
          await client.query('ROLLBACK').catch(() => {});
          return res.status(409).json({
            error: `${newUser.name} heeft zelf al diensten die botsen met die van ${oldUser.name}`,
            botsingen: botsingen.rows.map(r => ({
              datum: r.datum,
              vertrekker: `${String(r.vertrekker_start).slice(0, 5)}-${String(r.vertrekker_eind).slice(0, 5)}`,
              vervanger: `${String(r.vervanger_start).slice(0, 5)}-${String(r.vervanger_eind).slice(0, 5)}`,
              zelfdeStart: r.zelfde_start,
            })),
          });
        }
      }
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

    // 2b. Openstaande ruil- en overnameverzoeken van of naar de vertrekker
    //     intrekken.
    //
    //     Ze bleven anders staan met haar naam erop terwijl haar diensten al
    //     overgedragen waren. De tegenpartij zag dus een verzoek van iemand die
    //     weg is, en aanvaarden verzette de dienst van de VERVANGER. Meeverhuizen
    //     is geen alternatief: dan erft de vervanger een vraag die zij nooit
    //     gesteld heeft.
    const verzoekenResult = gaatLaterIn ? { rowCount: 0 } : await client.query(
      `UPDATE shift_swap_requests
          SET status = 'cancelled', responded_at = NOW(), response_notes = $2
        WHERE status = 'pending' AND (requester_user_id = $1 OR target_user_id = $1)`,
      [oldUserId, `Ingetrokken: ${oldUser.name} is vervangen`]
    );
    const verzoekenGeannuleerd = verzoekenResult.rowCount;

    // 3. De vertrekker deactiveren, of de overname vastleggen voor later.
    if (gaatLaterIn) {
      // Eén openstaande overname per vertrekker; een tweede vervangt de eerste,
      // zodat een verkeerd ingevoerde datum gewoon te corrigeren is.
      await client.query(
        `UPDATE geplande_overnames SET status = 'geannuleerd'
          WHERE oude_gebruiker = $1 AND status = 'gepland'`,
        [oldUserId]
      );
      await client.query(
        `INSERT INTO geplande_overnames
           (oude_gebruiker, nieuwe_gebruiker, ingangsdatum, aangemaakt_door, aangemaakt_door_naam)
         VALUES ($1, $2, $3, $4, $5)`,
        [oldUserId, newUserId, transferShiftsFrom, req.user.id, req.user.name]
      );
    } else {
      await client.query(
        `UPDATE users SET active = false WHERE id = $1`,
        [oldUserId]
      );
    }

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

    // contract_hours is een numeric, en die komt als STRING uit pg. Ongemoeid
    // laten levert "38" op in het antwoord, wat in de frontend als tekst
    // verderleeft en bij optellen aan elkaar plakt.
    const contracturenOvergenomen = oldUser.contract_hours == null
      ? null
      : Number(oldUser.contract_hours);

    await logAudit(req, 'REPLACE', 'user', oldUserId, {
      oldUser: { id: oldUserId, name: oldUser.name },
      newUser: { id: newUserId, name: newUser.name },
      shiftsTransferred,
      draftsUpdated,
      verzoekenGeannuleerd,
      eigenDienstenVerwijderd,
      gaatLaterIn,
      transferFrom: transferShiftsFrom || null,
      scheduleCopied: true,
      teamOvergenomen: oldUser.main_team || null,
      contracturenOvergenomen
    });

    res.json({
      ok: true,
      oldUser: { id: oldUserId, name: oldUser.name },
      newUser: { id: newUserId, name: newUser.name },
      shiftsTransferred,
      draftsUpdated,
      verzoekenGeannuleerd,
      eigenDienstenVerwijderd,
      gaatLaterIn,
      ingangsdatum: gaatLaterIn ? transferShiftsFrom : null,
      teamOvergenomen: oldUser.main_team || null,
      contracturenOvergenomen,
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
