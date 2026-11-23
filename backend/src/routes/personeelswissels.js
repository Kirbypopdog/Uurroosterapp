// Personeelswissels: een hele situatie in één keer, in plaats van losse
// vervangingen per account.
//
// Waarom dit bestaat: op 23 november 2026 liep een ketting van twee losse
// vervangingen mis. "Marie → Bryan" werd eerst ingesteld, de botsingsmelding
// raadde één globale keuze "Verwijderen" aan, en 121 diensten van Bryan die
// naar Justine hadden moeten gaan verdwenen. De volgorde was aan de gebruiker,
// er was geen voorbeeld vooraf, en alles gebeurde meteen.
//
// Hier:
//  - beschrijf je ALLE stappen samen, en zoekt de app de volgorde zelf
//    (`ordenStappen`: eerst wie doorschuift, dan wie diens plaats inneemt);
//  - toont het VOORBEELD wat er gebeurt, per persoon en per dag, en vraag je
//    per botsing wat er moet gebeuren in plaats van één knop voor alles;
//  - staat alles eerst als CONCEPT, waarbij nog niets gewijzigd is.
//
// Het voorbeeld voert de wissel ECHT uit, in een transactie die daarna
// teruggedraaid wordt. Zo kan het voorbeeld nooit iets anders tonen dan wat
// Bevestigen doet: het is dezelfde code.
//
// Rollen gaan NIET mee: die staan bewust los van een wissel (beslissing van
// Victor).
const { maakRouter } = require('../veilige-router');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../helpers/audit');
const { vandaagInBelgie } = require('../utils');
const { AFWEZIGHEIDSTYPES } = require('../helpers/dienstregels');
const vervangRouter = require('./replace-employee');

const router = maakRouter();
const BEHEER = requireRole('admin', 'roosterverantwoordelijke');
const DATUM = /^\d{4}-\d{2}-\d{2}$/;
const VENSTER_WEKEN = 8;

function fout(status, body) {
  const e = new Error(body && body.error ? body.error : 'Geweigerd');
  e.status = status;
  e.body = body;
  return e;
}

/** Vorm van de stappen nakijken en gelijktrekken. Gooit fout(400) bij onzin. */
function normaliseerStappen(stappen) {
  if (!Array.isArray(stappen) || stappen.length === 0) {
    throw fout(400, { error: 'Voeg minstens één stap toe.' });
  }
  if (stappen.length > 20) throw fout(400, { error: 'Te veel stappen in één wissel.' });
  return stappen.map((s, i) => {
    const van = Number(s && s.van);
    const naar = Number(s && s.naar);
    const vanaf = s && s.vanaf;
    if (!Number.isInteger(van) || van <= 0 || !Number.isInteger(naar) || naar <= 0) {
      throw fout(400, { error: `Stap ${i + 1}: kies wie vertrekt en wie overneemt.` });
    }
    if (van === naar) throw fout(400, { error: `Stap ${i + 1}: iemand kan zijn eigen rooster niet overnemen.` });
    if (typeof vanaf !== 'string' || !DATUM.test(vanaf)) {
      throw fout(400, { error: `Stap ${i + 1}: kies een geldige ingangsdatum.` });
    }
    return { van, naar, vanaf, blijftInDienst: s.blijftInDienst === true };
  });
}

/**
 * De volgorde waarin de stappen moeten draaien. Wie zijn rooster DOORGEEFT,
 * moet dat doen vóór hij zelf het rooster van een ander krijgt; anders schuift
 * zijn tweede stap het net gekregen rooster meteen door (de fout van 23
 * november). Puur, zodat het te toetsen is.
 *
 * Geweigerd: iemand die in twee stappen vertrekt, en een kring (A neemt B over
 * en B neemt A over) — die heeft geen volgorde.
 */
function ordenStappen(stappen) {
  const vanSet = new Set();
  for (const s of stappen) {
    if (vanSet.has(s.van)) {
      throw fout(400, { error: 'Iemand geeft in twee stappen zijn rooster door. Kies één vervanger per persoon.' });
    }
    vanSet.add(s.van);
  }
  const resterend = stappen.map((s, i) => ({ ...s, _i: i }));
  const volgorde = [];
  while (resterend.length) {
    // Een stap kan als de vertrekker (van) niet nog moet ONTVANGEN in een
    // stap die nog niet gedraaid heeft... omgekeerd: wie ontvangt (naar) en
    // zelf ook doorgeeft, geeft eerst door. Dus: stap s mag pas als er geen
    // resterende stap meer is waarin s.naar de vertrekker is.
    const idx = resterend.findIndex(s => !resterend.some(t => t !== s && t.van === s.naar));
    if (idx === -1) {
      throw fout(400, { error: 'Deze stappen vormen een kring (iemand neemt over van wie hem zelf overneemt). Dat kan niet in één wissel.' });
    }
    volgorde.push(resterend.splice(idx, 1)[0]);
  }
  return volgorde.map(({ _i, ...s }) => s);
}

function tijd(t) { return String(t || '').slice(0, 5); }
function botsen(a, b) {
  const as = tijd(a.start_time), ae = tijd(a.end_time), bs = tijd(b.start_time), be = tijd(b.end_time);
  return as === bs || (as < be && bs < ae);
}
function sleutelVan(stap, eigen) { return `${stap.van}-${stap.naar}-${eigen.id}`; }

/**
 * Voert de wissel uit binnen een transactie van de aanroeper en geeft terug
 * wat er gebeurde. Het voorbeeld draait dit en rolt terug; Bevestigen draait
 * het en legt vast.
 */
async function voerWisselUit(client, { stappen, keuzes = {}, actor, wisselId = null }) {
  const volgorde = ordenStappen(normaliseerStappen(stappen));
  const vandaag = vandaagInBelgie();

  const ids = [...new Set(volgorde.flatMap(s => [s.van, s.naar]))];
  const gebruikers = await client.query(
    `SELECT id, name, active, main_team, contract_hours FROM users WHERE id = ANY($1::int[])`, [ids]);
  const perId = new Map(gebruikers.rows.map(u => [u.id, u]));
  for (const id of ids) {
    if (!perId.has(id)) throw fout(404, { error: `Medewerker ${id} niet gevonden.` });
  }
  const naam = (id) => perId.get(id).name;

  const eerste = volgorde.map(s => s.vanaf).sort()[0];
  const laatste = volgorde.map(s => s.vanaf).sort().slice(-1)[0];
  const tot = (() => {
    const d = new Date(`${laatste}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + VENSTER_WEKEN * 7);
    return d.toISOString().slice(0, 10);
  })();
  const dienstenIn = async () => {
    const r = await client.query(
      `SELECT id, user_id, date::text AS date, start_time, end_time, team, is_reserve
         FROM shifts WHERE user_id = ANY($1::int[]) AND date >= $2 AND date <= $3
        ORDER BY date, start_time`, [ids, eerste, tot]);
    const per = {};
    for (const id of ids) per[id] = [];
    for (const s of r.rows) per[s.user_id].push({
      id: s.id, date: s.date, startTime: tijd(s.start_time), endTime: tijd(s.end_time), team: s.team, isReserve: s.is_reserve,
    });
    return per;
  };
  const voor = await dienstenIn();

  const stapResultaten = [];
  for (const stap of volgorde) {
    // Wat er nu (na de eerdere stappen) bij beide staat.
    const r = await client.query(
      `SELECT id, user_id, team, date::text AS date, start_time, end_time, notes, source, archived,
              is_reserve, draft_id, created_at
         FROM shifts WHERE user_id = ANY($1::int[]) AND date >= $2 ORDER BY date, start_time`,
      [[stap.van, stap.naar], stap.vanaf]);
    const vanDiensten = r.rows.filter(x => x.user_id === stap.van);
    const eigen = r.rows.filter(x => x.user_id === stap.naar);
    const blokken = await client.query(
      `SELECT COUNT(*)::int AS n FROM shift_blocks WHERE user_id = $1 AND date >= $2`, [stap.van, stap.vanaf]);

    // Botsingen per dag, met de keuze van de gebruiker. Standaard neemt de
    // vervanger het rooster over (daar gaat een wissel over); zijn eigen dienst
    // op die dag vervalt. Alles wat vervalt, komt bij het terugdraaien terug.
    const botsingen = [];
    const weg = new Map();
    for (const e of eigen) {
      const tegen = vanDiensten.filter(v => v.date === e.date && botsen(v, e));
      if (!tegen.length) continue;
      const sleutel = sleutelVan(stap, e);
      const keuze = keuzes[sleutel] === 'eigen' ? 'eigen' : 'overnemen';
      botsingen.push({
        sleutel, datum: e.date, keuze,
        eigen: `${tijd(e.start_time)}-${tijd(e.end_time)}`,
        overgenomen: tegen.map(v => `${tijd(v.start_time)}-${tijd(v.end_time)}`).join(', '),
      });
      if (keuze === 'overnemen') weg.set(e.id, e);
      else for (const v of tegen) weg.set(v.id, v);
    }
    const teWissen = [...weg.values()];

    // Diensten die naar de vervanger gaan op een dag dat die zelf afwezig is
    // (verlof, ziekte, ...). Afwezigheden verhuizen NIET mee — iedereen houdt
    // zijn eigen verlof — dus zo'n dienst staat straks met het verloflint in de
    // planning. Beter vooraf weten dan achteraf ontdekken.
    const gaanMee = vanDiensten.filter(v => !weg.has(v.id));
    const afwezig = gaanMee.length ? await client.query(
      `SELECT DISTINCT date::text AS datum FROM availability
        WHERE user_id = $1 AND date = ANY($2::date[]) AND type = ANY($3::text[])
        ORDER BY 1`,
      [stap.naar, [...new Set(gaanMee.map(v => v.date))], AFWEZIGHEIDSTYPES]
    ) : { rows: [] };
    if (teWissen.length) {
      await client.query(`DELETE FROM shifts WHERE id = ANY($1::int[])`, [teWissen.map(x => x.id)]);
    }

    const uit = await vervangRouter.voerVervangingUit(client, {
      oldUserId: stap.van, newUserId: stap.naar, transferShiftsFrom: stap.vanaf,
      eigenDienstenVervanger: 'behouden', blijftActief: stap.blijftInDienst,
      actor, wisselId, extraVerwijderd: teWissen,
    });
    stapResultaten.push({
      van: { id: stap.van, naam: naam(stap.van) },
      naar: { id: stap.naar, naam: naam(stap.naar) },
      vanaf: stap.vanaf,
      blijftInDienst: stap.blijftInDienst,
      onmiddellijk: stap.vanaf <= vandaag,
      verhuisd: uit.shiftsTransferred,
      botsingen,
      leeggemaakteDagen: blokken.rows[0].n,
      afwezigOp: afwezig.rows.map(r => r.datum),
    });
  }
  const na = await dienstenIn();

  // Team en contracturen ervoor en erna. De vervanger krijgt die van de
  // vertrekker ZOALS HIJ NU IS: ook in een ketting, want elke stap draait op
  // zijn eigen datum en de volgende pas later of na hem.
  const personen = ids.map(id => {
    const u = perId.get(id);
    const ontvangt = volgorde.find(s => s.naar === id);
    const geeftDoor = volgorde.find(s => s.van === id);
    const bron = ontvangt ? perId.get(ontvangt.van) : null;
    return {
      id, naam: u.name,
      teamVoor: u.main_team, teamNa: bron ? bron.main_team : u.main_team,
      urenVoor: u.contract_hours == null ? null : Number(u.contract_hours),
      urenNa: bron ? (bron.contract_hours == null ? null : Number(bron.contract_hours))
        : (u.contract_hours == null ? null : Number(u.contract_hours)),
      vanaf: ontvangt ? ontvangt.vanaf : (geeftDoor ? geeftDoor.vanaf : null),
      uitDienst: !!(geeftDoor && !geeftDoor.blijftInDienst),
    };
  });

  return { volgorde: stapResultaten, personen, diensten: { voor, na }, venster: { van: eerste, tot } };
}

/** Een geweigerde wissel als antwoord, met de stap erbij. */
function stuurFout(res, err) {
  if (err && err.status) return res.status(err.status).json(err.body);
  throw err;
}

router.post('/personeelswissels/voorbeeld', requireAuth, BEHEER, async (req, res) => {
  const { stappen, keuzes } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uit = await voerWisselUit(client, { stappen, keuzes, actor: req.user });
    res.json(uit);
  } catch (err) {
    stuurFout(res, err);
  } finally {
    // ALTIJD terugdraaien: dit is een voorbeeld.
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

router.get('/personeelswissels', requireAuth, BEHEER, async (req, res) => {
  const wissels = await pool.query(
    `SELECT w.id, w.omschrijving, w.status, w.stappen, w.keuzes, w.aangemaakt_door_naam AS "aangemaaktDoor",
            w.aangemaakt_op AS "aangemaaktOp", w.bevestigd_op AS "bevestigdOp", w.bevestigd_door_naam AS "bevestigdDoor"
       FROM personeelswissels w
      WHERE w.status <> 'teruggedraaid' OR w.gewijzigd_op > NOW() - INTERVAL '30 days'
      ORDER BY w.aangemaakt_op DESC`);
  const stappen = await pool.query(
    `SELECT g.id, g.wissel_id AS "wisselId", g.oude_gebruiker AS van, o.name AS "vanNaam",
            g.nieuwe_gebruiker AS naar, n.name AS "naarNaam", g.ingangsdatum::text AS vanaf,
            g.status, g.vertrekker_blijft_actief AS "blijftInDienst", (g.terugdraai IS NOT NULL) AS "heeftTerugdraai"
       FROM geplande_overnames g
       JOIN users o ON o.id = g.oude_gebruiker JOIN users n ON n.id = g.nieuwe_gebruiker
      WHERE g.wissel_id IS NOT NULL OR g.status = 'gepland'
      ORDER BY g.id`);
  const vandaag = vandaagInBelgie();
  const namen = await pool.query(`SELECT id, name FROM users`);
  const naamVan = new Map(namen.rows.map(u => [u.id, u.name]));
  const uitgebreid = wissels.rows.map(w => {
    const eigen = stappen.rows.filter(s => s.wisselId === w.id);
    let status = w.status;
    if (status === 'bevestigd' && eigen.length && eigen.every(s => s.status === 'uitgevoerd')) status = 'uitgevoerd';
    const kanTerugdraaien = w.status === 'bevestigd' && eigen.length > 0 &&
      eigen.every(s => s.status === 'gepland' && s.heeftTerugdraai && s.vanaf > vandaag);
    return {
      ...w, status, kanTerugdraaien,
      stappen: (w.stappen || []).map(s => ({ ...s, vanNaam: naamVan.get(Number(s.van)), naarNaam: naamVan.get(Number(s.naar)) })),
      uitvoering: eigen,
    };
  });
  // Geplande overnames van vóór deze pagina (of via de oude knop) staan los.
  const los = stappen.rows.filter(s => !s.wisselId && s.status === 'gepland')
    .map(s => ({ ...s, kanTerugdraaien: s.heeftTerugdraai && s.vanaf > vandaag }));
  res.json({ wissels: uitgebreid, losseOvernames: los });
});

router.post('/personeelswissels', requireAuth, BEHEER, async (req, res) => {
  const { omschrijving = '', stappen, keuzes = {} } = req.body || {};
  try { normaliseerStappen(stappen); } catch (err) { return stuurFout(res, err); }
  const r = await pool.query(
    `INSERT INTO personeelswissels (omschrijving, stappen, keuzes, aangemaakt_door, aangemaakt_door_naam)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5) RETURNING id`,
    [String(omschrijving).slice(0, 200), JSON.stringify(normaliseerStappen(stappen)), JSON.stringify(keuzes || {}),
      req.user.id, req.user.name]);
  await logAudit(req, 'CREATE', 'user', null, { type: 'personeelswissel_concept', wissel: r.rows[0].id });
  res.status(201).json({ id: r.rows[0].id });
});

router.put('/personeelswissels/:id', requireAuth, BEHEER, async (req, res) => {
  const id = Number(req.params.id);
  const { omschrijving = '', stappen, keuzes = {} } = req.body || {};
  let genormaliseerd;
  try { genormaliseerd = normaliseerStappen(stappen); } catch (err) { return stuurFout(res, err); }
  const r = await pool.query(
    `UPDATE personeelswissels SET omschrijving = $1, stappen = $2::jsonb, keuzes = $3::jsonb, gewijzigd_op = NOW()
      WHERE id = $4 AND status = 'concept' RETURNING id`,
    [String(omschrijving).slice(0, 200), JSON.stringify(genormaliseerd), JSON.stringify(keuzes || {}), id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Geen concept gevonden (al bevestigd?)' });
  res.json({ ok: true });
});

router.delete('/personeelswissels/:id', requireAuth, BEHEER, async (req, res) => {
  const r = await pool.query(
    `DELETE FROM personeelswissels WHERE id = $1 AND status = 'concept' RETURNING id`, [Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Alleen een concept kan verwijderd worden.' });
  res.json({ ok: true });
});

router.post('/personeelswissels/:id/bevestigen', requireAuth, BEHEER, async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query(
      `SELECT id, stappen, keuzes, status FROM personeelswissels WHERE id = $1 FOR UPDATE`, [id]);
    if (!w.rows[0] || w.rows[0].status !== 'concept') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Geen concept gevonden (al bevestigd?)' });
    }
    const uit = await voerWisselUit(client, {
      stappen: w.rows[0].stappen, keuzes: w.rows[0].keuzes || {}, actor: req.user, wisselId: id,
    });
    await client.query(
      `UPDATE personeelswissels SET status = 'bevestigd', bevestigd_op = NOW(), bevestigd_door_naam = $2, gewijzigd_op = NOW()
        WHERE id = $1`, [id, req.user.name]);
    await client.query('COMMIT');
    await logAudit(req, 'REPLACE', 'user', null, {
      type: 'personeelswissel_bevestigd', wissel: id,
      stappen: uit.volgorde.map(s => ({ van: s.van, naar: s.naar, vanaf: s.vanaf, verhuisd: s.verhuisd, botsingen: s.botsingen.length })),
    });
    res.json({ ok: true, volgorde: uit.volgorde });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    stuurFout(res, err);
  } finally {
    client.release();
  }
});

router.post('/personeelswissels/:id/terugdraaien', requireAuth, BEHEER, async (req, res) => {
  const id = Number(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query(`SELECT status FROM personeelswissels WHERE id = $1 FOR UPDATE`, [id]);
    if (!w.rows[0] || w.rows[0].status !== 'bevestigd') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Geen bevestigde wissel gevonden.' });
    }
    // In OMGEKEERDE volgorde: de laatste stap eerst, zodat elke stap de
    // toestand terugvindt die hij achterliet.
    const stappen = await client.query(
      `SELECT id FROM geplande_overnames WHERE wissel_id = $1 ORDER BY id DESC`, [id]);
    const resultaten = [];
    for (const s of stappen.rows) {
      const { resultaat } = await vervangRouter.draaiOvernameTerug(client, s.id);
      resultaten.push(resultaat);
    }
    await client.query(
      `UPDATE personeelswissels SET status = 'teruggedraaid', gewijzigd_op = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    const som = (k) => resultaten.reduce((n, r) => n + (r[k] || 0), 0);
    const resultaat = {
      ok: true,
      dienstenTerug: som('dienstenTerug'),
      dienstenNietTerug: som('dienstenNietTerug'),
      verwijderdTeruggezet: som('verwijderdTeruggezet'),
      verwijderdNietTeruggezet: som('verwijderdNietTeruggezet'),
      conceptenNietHersteld: [...new Set(resultaten.flatMap(r => r.conceptenNietHersteld || []))],
      instellingenNietHersteld: [...new Set(resultaten.flatMap(r => r.instellingenNietHersteld || []))],
    };
    await logAudit(req, 'UPDATE', 'user', null, { type: 'personeelswissel_teruggedraaid', wissel: id, ...resultaat });
    res.json(resultaat);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    stuurFout(res, err);
  } finally {
    client.release();
  }
});

router.normaliseerStappen = normaliseerStappen;
router.ordenStappen = ordenStappen;
module.exports = router;
