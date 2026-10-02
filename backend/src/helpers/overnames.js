// #vervangen: geplande overnames uitvoeren.
//
// Een overname van een contract gaat in op een DATUM. De diensten verhuizen
// meteen bij het instellen, want de planning moet vooruit kloppen. Wat pas op
// die dag mag gebeuren staat hier: de vertrekker deactiveren en team, extra
// teams, contracturen en weekrooster naar de vervanger zetten.
//
// Deed de app dat meteen, dan kon iemand die nog een week moest werken vanaf
// het instellen niet meer inloggen, en droeg de vervanger een contract dat nog
// niet begonnen was.
//
// Draait bij het opstarten en elk uur daarna, net als de bewaartermijnen (#151).
// De backend valt in slaap na een kwartier stilte, dus in de praktijk voert de
// eerste die de app die dag opent de overname uit. Dat is vroeg genoeg: het
// gaat om een grens van een hele dag.
//
// Idempotent: een overname die al uitgevoerd is, staat niet meer op 'gepland'.
const { pool } = require('../db');
const { formatDateYYYYMMDD } = require('../utils');

// pg geeft een `date`-kolom terug als een Date op middernacht lokale tijd.
// `String(date)` levert dan "Fri Sep 25" op, en dat is geen datum die je later
// nog kunt vergelijken of tonen. Een string blijft ongemoeid.
function datumTekst(waarde) {
  return waarde instanceof Date ? formatDateYYYYMMDD(waarde) : String(waarde).slice(0, 10);
}

async function voerGeplandeOvernamesUit() {
  const client = await pool.connect();
  let uitgevoerd = 0;
  try {
    const rijp = await client.query(
      `SELECT id, oude_gebruiker, nieuwe_gebruiker, ingangsdatum
         FROM geplande_overnames
        WHERE status = 'gepland' AND ingangsdatum <= CURRENT_DATE
        ORDER BY ingangsdatum`
    );

    for (const overname of rijp.rows) {
      try {
        await client.query('BEGIN');

        const oud = await client.query(
          `SELECT id, name, main_team, extra_teams, contract_hours,
                  week_schedules, week_schedule_week1, week_schedule_week2
             FROM users WHERE id = $1 FOR UPDATE`,
          [overname.oude_gebruiker]
        );
        const nieuw = await client.query(
          `SELECT id, name, active FROM users WHERE id = $1 FOR UPDATE`,
          [overname.nieuwe_gebruiker]
        );

        // Is een van de twee intussen verdwenen of gedeactiveerd, dan is de
        // overname achterhaald. Ze stilletjes laten staan zou betekenen dat ze
        // elk uur opnieuw geprobeerd wordt.
        if (oud.rows.length === 0 || nieuw.rows.length === 0 || nieuw.rows[0].active === false) {
          await client.query(
            `UPDATE geplande_overnames SET status = 'geannuleerd', uitgevoerd_op = NOW() WHERE id = $1`,
            [overname.id]
          );
          await client.query('COMMIT');
          console.warn(`[overnames] overname ${overname.id} vervalt: betrokkene ontbreekt of is niet actief`);
          continue;
        }

        const o = oud.rows[0];
        // team_id gaat mee op main_team en niet op de oude team_id: die twee
        // horen gelijk te zijn, anders falen de permissies (CLAUDE.md regel 2).
        await client.query(
          `UPDATE users SET
             week_schedules = $1, week_schedule_week1 = $2, week_schedule_week2 = $3,
             main_team = $4, team_id = $4, extra_teams = $5, contract_hours = $6
           WHERE id = $7`,
          [
            JSON.stringify(o.week_schedules), JSON.stringify(o.week_schedule_week1),
            JSON.stringify(o.week_schedule_week2), o.main_team, o.extra_teams || [],
            o.contract_hours, overname.nieuwe_gebruiker,
          ]
        );

        await client.query(
          `UPDATE shift_swap_requests
              SET status = 'cancelled', responded_at = NOW(), response_notes = $2
            WHERE status = 'pending' AND (requester_user_id = $1 OR target_user_id = $1)`,
          [overname.oude_gebruiker, `Ingetrokken: ${o.name} is vervangen`]
        );

        await client.query(`UPDATE users SET active = false WHERE id = $1`, [overname.oude_gebruiker]);

        await client.query(
          `UPDATE geplande_overnames SET status = 'uitgevoerd', uitgevoerd_op = NOW() WHERE id = $1`,
          [overname.id]
        );
        await client.query(
          `INSERT INTO audit_log (actor_id, actor_name, action, resource_type, resource_id, details)
           VALUES (NULL, 'Systeem', 'REPLACE', 'user', $1, $2)`,
          [String(overname.oude_gebruiker), JSON.stringify({
            geplandeOvername: overname.id,
            ingangsdatum: datumTekst(overname.ingangsdatum),
            oud: { id: o.id, name: o.name },
            nieuw: { id: nieuw.rows[0].id, name: nieuw.rows[0].name },
          })]
        );

        await client.query('COMMIT');
        uitgevoerd++;
        console.log(`[overnames] ${o.name} vervangen door ${nieuw.rows[0].name} (ingangsdatum ${datumTekst(overname.ingangsdatum)})`);
      } catch (fout) {
        await client.query('ROLLBACK').catch(() => {});
        // Eén mislukte overname mag de rest niet tegenhouden; ze blijft op
        // 'gepland' staan en wordt bij de volgende ronde opnieuw geprobeerd.
        console.error(`[overnames] overname ${overname.id} mislukt:`, fout && fout.message);
      }
    }
  } catch (fout) {
    console.error('[overnames] kon de geplande overnames niet ophalen:', fout && fout.message);
  } finally {
    client.release();
  }
  return uitgevoerd;
}

module.exports = { voerGeplandeOvernamesUit };
