// De geplande herinneringen (#397): de verlofronde en de weekend- of
// vakantieverantwoordelijke.
//
// **Waarom dit er zo uitziet.** De server slaapt in na een kwartier stilte, dus
// een `setInterval` is géén klok. In de praktijk draait deze taak wanneer de
// eerste bezoeker de server wakker maakt — soms één keer op een dag, soms
// tien keer, en op een dag dat niemand inlogt helemaal niet.
//
// Daar zijn twee dingen uit gevolgd:
//
//  1. **Claimen vóór versturen.** Elke melding legt eerst een regel vast in
//     `verstuurde_meldingen` en verstuurt daarna pas. Een tweede run vindt de
//     claim bezet en doet niets. Loopt het versturen daarna stuk, dan is het
//     gevolg één gemiste mail in plaats van een stroom herhalingen — en dat is
//     de goede kant om op te falen bij iets dat naar iedereen gaat.
//
//  2. **Inhalen in plaats van missen.** Niets kijkt naar "is het vandaag
//     precies dag X". De verlofherinnering vuurt bij "nog hoogstens N dagen",
//     en de verantwoordelijke bij "de week hierna is nog niet aangekondigd".
//     Slaapt de server op de dag zelf, dan vertrekt de mail de eerstvolgende
//     keer dat iemand de app opent, één keer.

const { pool } = require('../db');
const { vandaagInBelgie } = require('../utils');
const { notifyResponsibleReminder, notifyResponsibleMissing } = require('../email');
const { nietIngediend, beheerders, verstuurRondeHerinnering } = require('./verlofmail');
const verantwoordelijke = require('./verantwoordelijke');

// Hoeveel dagen vóór de deadline er een herinnering uitgaat. Van ver naar
// dichtbij; er vertrekt er hoogstens ÉÉN per run, de overgeslagen mijlpalen
// worden mee geclaimd zodat ze niet alsnog een dag later vuren.
const MIJLPALEN = [7, 2];

const DAG_MS = 86400000;

function datumVan(tekst) {
  const [j, m, d] = String(tekst).slice(0, 10).split('-').map(Number);
  return new Date(j, m - 1, d, 0, 0, 0, 0);
}

function tekstVan(datum) {
  const mm = String(datum.getMonth() + 1).padStart(2, '0');
  const dd = String(datum.getDate()).padStart(2, '0');
  return `${datum.getFullYear()}-${mm}-${dd}`;
}

// Hele dagen tussen twee kalenderdatums. Afronden, niet afkappen: over de
// overgang naar zomertijd liggen twee lokale middernachten 23 of 25 uur uit
// elkaar, en afkappen maakt daar een dag te weinig van.
function dagenTussen(vanaf, tot) {
  return Math.round((datumVan(tot).getTime() - datumVan(vanaf).getTime()) / DAG_MS);
}

/**
 * Probeer deze melding te claimen. Geeft true als DEZE run hem mag versturen.
 * Een tweede aanroep met dezelfde sleutel geeft false.
 */
async function claim(soort, sleutel, client = pool) {
  const res = await client.query(
    `INSERT INTO verstuurde_meldingen (soort, sleutel) VALUES ($1, $2)
     ON CONFLICT (soort, sleutel) DO NOTHING RETURNING id`,
    [soort, sleutel]
  );
  return res.rowCount > 0;
}

async function noteerAantal(soort, sleutel, aantal, client = pool) {
  await client.query(
    `UPDATE verstuurde_meldingen SET aantal = $3 WHERE soort = $1 AND sleutel = $2`,
    [soort, sleutel, aantal]
  );
}

// ===== 1. Verlofronde: herinnering aan wie nog niet indiende =====

async function verlofHerinneringen(vandaag, client = pool) {
  const rondes = await client.query(
    `SELECT id, name, deadline::text AS deadline, status
       FROM leave_rounds
      WHERE status = 'open' AND deadline IS NOT NULL`
  );

  const gedaan = [];
  for (const ronde of rondes.rows) {
    const dagenTot = dagenTussen(vandaag, ronde.deadline);
    // Voorbij de deadline houdt het op: dan is herinneren geen hulp meer maar
    // ruis, en hoort de beheerder de ronde te sluiten.
    if (dagenTot < 0) continue;

    // De scherpste mijlpaal die nu van toepassing is.
    const vanToepassing = MIJLPALEN.filter(m => dagenTot <= m).sort((a, b) => a - b)[0];
    if (vanToepassing === undefined) continue;

    // Elke ruimere mijlpaal die we hebben overgeslagen wordt mee geclaimd,
    // anders vuurt "7 dagen" morgen alsnog naast "2 dagen" van vandaag.
    let magVersturen = false;
    for (const m of MIJLPALEN) {
      if (m < vanToepassing) continue;
      const vrij = await claim('verlof_herinnering', `${ronde.id}:${m}`, client);
      if (m === vanToepassing) magVersturen = vrij;
    }
    if (!magVersturen) continue;

    const ontvangers = await nietIngediend(ronde.id, client);
    if (ontvangers.length === 0) {
      gedaan.push({ ronde: ronde.id, verstuurd: 0, reden: 'iedereen-heeft-ingediend' });
      continue;
    }
    const res = await verstuurRondeHerinnering(ontvangers, ronde, { dagenTot });
    await noteerAantal('verlof_herinnering', `${ronde.id}:${vanToepassing}`, res.verstuurd || 0, client);
    gedaan.push({ ronde: ronde.id, mijlpaal: vanToepassing, verstuurd: res.verstuurd || 0 });
  }
  return gedaan;
}

// ===== 2. De weekend- of vakantieverantwoordelijke =====

/**
 * Op de maandag van de week ERVÓÓR, zodat er nog een volle week is om te
 * ruilen als het die week niet lukt.
 *
 * De doelweek is de maandag van deze week plus zeven dagen. Wordt de server pas
 * woensdag wakker, dan is de maandag van "deze week" nog dezelfde en gaat de
 * mail alsnog over dezelfde doelweek — één keer, want de claim hangt aan die
 * doelweek en niet aan de dag van versturen.
 */
async function verantwoordelijkeHerinnering(vandaag, client = pool) {
  const dezeMaandag = verantwoordelijke.maandagVan(vandaag);
  const doelMaandag = new Date(dezeMaandag.getTime());
  doelMaandag.setDate(doelMaandag.getDate() + 7);
  const weekStart = tekstVan(doelMaandag);
  const weekEindDatum = new Date(doelMaandag.getTime());
  weekEindDatum.setDate(weekEindDatum.getDate() + 6);
  const weekEind = tekstVan(weekEindDatum);

  const ctx = await verantwoordelijke.haalContext(client);
  const info = verantwoordelijke.verantwoordelijkeMetContext(weekStart, ctx);
  const volledig = Object.assign({}, info, { weekStart, weekEind });

  // Een dichte week zonder vakantie heeft geen verantwoordelijke, en dat is
  // geen gebrek maar het juiste antwoord. Daar hoort dus ook geen melding bij.
  if (info.reden === 'weekend-gesloten') {
    return { weekStart, gedaan: 'geen-verantwoordelijke-nodig' };
  }

  if (info.persoon) {
    if (!await claim('verantwoordelijke', weekStart, client)) {
      return { weekStart, gedaan: 'al-verstuurd' };
    }
    const res = await notifyResponsibleReminder(info.persoon, volledig);
    await noteerAantal('verantwoordelijke', weekStart, res.verstuurd || 0, client);
    return { weekStart, gedaan: 'herinnering', persoon: info.persoon.id, verstuurd: res.verstuurd || 0 };
  }

  // Er hoort iemand te zijn, maar er is niemand. Dat is precies wat de
  // beheerders moeten weten vóór het weekend er is.
  if (!await claim('verantwoordelijke_ontbreekt', weekStart, client)) {
    return { weekStart, gedaan: 'al-gemeld' };
  }
  const ontvangers = await beheerders(client);
  const res = await notifyResponsibleMissing(ontvangers, volledig);
  await noteerAantal('verantwoordelijke_ontbreekt', weekStart, res.verstuurd || 0, client);
  return { weekStart, gedaan: 'niemand-aangeduid', reden: info.reden, verstuurd: res.verstuurd || 0 };
}

/**
 * Het enige dat `server.js` aanroept. Gooit nooit: een mislukte herinnering
 * mag het opstarten of een verzoek niet in de weg zitten.
 */
async function voerHerinneringenUit(nu = new Date()) {
  const vandaag = vandaagInBelgie(nu);
  const uitkomst = { vandaag, verlof: [], verantwoordelijke: null };
  try {
    uitkomst.verlof = await verlofHerinneringen(vandaag);
  } catch (err) {
    console.error('[herinneringen] verlofronde:', err.message);
  }
  try {
    uitkomst.verantwoordelijke = await verantwoordelijkeHerinnering(vandaag);
  } catch (err) {
    console.error('[herinneringen] verantwoordelijke:', err.message);
  }
  return uitkomst;
}

module.exports = {
  voerHerinneringenUit,
  verlofHerinneringen,
  verantwoordelijkeHerinnering,
  claim,
  dagenTussen,
  MIJLPALEN
};
