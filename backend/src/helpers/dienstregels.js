// #157: de regels waaraan een dienst moet voldoen, uit server.js gehaald.
//
// Dit is de enige groep helpers die door MEER DAN EEN domein gebruikt wordt:
// zowel de diensten zelf als de ruilverzoeken toetsen hieraan, en de
// beschikbaarheid gebruikt de afwezigheidstypes. Daarom een eigen bestand in
// plaats van meeverhuizen met een van de drie.
const { pool } = require('../db');
const { shiftsOverlapCheck, hoursBetweenShifts, formatDateYYYYMMDD } = require('../utils');

// #236: availability.type werd nergens gecontroleerd. "onzin" als type kwam er
// met een 201 doorheen en bleef permanent in de database staan. Het leidt niet
// tot injectie (de weergave valt terug op "Afwezig"), maar het keuzemenu toont
// bij zo'n waarde niets, dus de gebruiker ziet niet eens wat er staat.
//
// Dit zijn de zes types die de app aanbiedt, letterlijk de opties uit het
// keuzemenu in index.html. Het issue noemde er drie; dat waren de drie die
// toevallig in de database stonden.
const AFWEZIGHEIDSTYPES = ['verlof', 'ziek', 'overuren', 'vorming', 'andere', 'vrij'];

function isGeldigAfwezigheidstype(t) {
  return typeof t === 'string' && AFWEZIGHEIDSTYPES.includes(t);
}

// #310: een bulkregistratie liep van startDate tot endDate zonder bovengrens.
// Een typfout als 2206 in plaats van 2026 schreef ruim 65.000 rijen weg in één
// transactie, en elke rij met een gevuld type telt daarna als afwezigheid, dus
// de shiftgeneratie bleef jarenlang geblokkeerd. Een jaar plus een schrikkeldag
// is ruim genoeg voor elke echte afwezigheid.
const MAX_AFWEZIGHEIDSDAGEN = 366;

// Enkel de vorm controleren is niet genoeg: '2026-02-31' past in het patroon
// maar bestaat niet, en new Date() maakt er stilzwijgend 3 maart van.
function isGeldigeDatumString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidTime(t) {
  // #246: het patroon alleen is niet genoeg. '24:00' en '99:99' kwamen er zo
  // doorheen en werden als tekst opgeslagen, waarna <input type="time"> in de
  // frontend ze weigerde en het veld leeg bleef. De uren moeten 0 tot 23 zijn
  // en de minuten 0 tot 59; middernacht heet in deze app '00:00'.
  if (typeof t !== 'string' || !/^\d{2}:\d{2}$/.test(t)) return false;
  const [u, m] = t.split(':').map(Number);
  return u >= 0 && u <= 23 && m >= 0 && m <= 59;
}

// Een eindtijd van '24:00' betekent middernacht. Oudere clients en bestaande
// rijen kunnen die nog sturen, dus zetten we hem om in plaats van te weigeren.
function normaliseerTijd(t) {
  return t === '24:00' ? '00:00' : t;
}

// #295: een dienst met gelijke start- en eindtijd is dubbelzinnig. getShiftEndDT
// telt er een dag bij (vierentwintig uur), de frontend deed dat niet (nul uur).
// Die grens is nu aan beide kanten gelijk, maar het beste antwoord is de invoer
// weigeren: niemand bedoelt een dienst van precies nul of precies vierentwintig
// uur, en wie dat wel wil kan 00:00 tot 23:59 zetten.
const GELIJKE_TIJDEN_MELDING = 'Begintijd en eindtijd mogen niet gelijk zijn. Kies een eindtijd die verschilt van de begintijd.';

/**
 * Controleert overlap en 11-uur rust voor een nieuwe/gewijzigde shift.
 * @param {object} db - pool (of mock in tests)
 * @param {number} userId
 * @param {{ date: string, start_time: string, end_time: string }} newShift
 * @param {number|null} excludeId - shift-id uitsluiten bij PUT
 * @returns {Promise<{ valid: boolean, message?: string }>}
 */
// Legt vast dat een medewerkerdag bewust leeg is, zodat een concept hem bij
// een volgende toepassing niet opnieuw vult.
//
// Nodig omdat een dienst die WEGBEWEEGT van iemands dag geen spoor achterliet:
// verslepen, ruilen en overnemen zetten user_id of date om, waardoor de
// oorspronkelijke dag leeg achterbleef zonder blokkade. Het concept vulde die
// dag dan opnieuw en de medewerker stond twee keer ingepland, of er stonden
// twee mensen op één dienst. Verwijderen deed dit al wel.
//
// Alleen blokkeren als de dag daarna écht leeg is. Bij een ruil op dezelfde
// dag houdt de medewerker een dienst over, en dan zou een blokkade een
// misleidende indicator opleveren op een dag waar gewoon gewerkt wordt.
async function blockDayIfEmpty(db, userId, date, createdBy, reason) {
  if (!userId || !date) return false;
  const nog = await db.query(
    'SELECT 1 FROM shifts WHERE user_id = $1 AND date = $2::date LIMIT 1',
    [userId, date]
  );
  if (nog.rows.length > 0) return false;
  await db.query(
    `INSERT INTO shift_blocks (user_id, date, created_by, reason)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (user_id, date) DO NOTHING`,
    [userId, date, createdBy || null, reason]
  );
  return true;
}

// De rustnorm staat in Instellingen > Planning regels en wordt bewaard onder
// settings.rules.minHoursBetweenShifts. De frontend leest hem al op zeven
// plekken; de backend hardcodeerde 11, waardoor een aangepaste norm alleen in
// de waarschuwingen doorwerkte en niet in de controle die echt weigert.
const STANDAARD_MIN_RUST = 11;

/**
 * Leest de rustnorm uit de instellingen.
 *
 * Bewust geen cache. Die zou moduletoestand zijn die op Render met meerdere
 * instanties een aangepaste norm nog even laat gelden, en die tussen tests
 * blijft hangen. De query is een enkele rij uit een kleine tabel; waar hij in
 * een lus zou belanden geven we de waarde expliciet mee via minRest.
 */
async function getMinRustUren(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'rules'`);
    const uit = rows[0] && rows[0].value ? Number(rows[0].value.minHoursBetweenShifts) : NaN;
    if (Number.isFinite(uit) && uit >= 0 && uit <= 24) return uit;
  } catch (err) {
    // Instellingen onleesbaar: terugvallen op het wettelijk minimum is veiliger
    // dan de controle stil overslaan.
    console.error('Kon de rustnorm niet lezen, val terug op 11 uur:', err.message);
  }
  return STANDAARD_MIN_RUST;
}

/**
 * @param {number|null} minRest - de rustnorm, als de aanroeper hem al kent.
 *   Laat null om hem hier te laten lezen. Alleen de bulkpaden geven hem mee,
 *   omdat die validateShiftRules per dienst aanroepen.
 */
async function validateShiftRules(db, userId, newShift, excludeId = null, skipRestCheck = false, minRest = null) {
  let MIN_REST = minRest;
  const rangeStart = new Date(newShift.date);
  rangeStart.setDate(rangeStart.getDate() - 2);
  const rangeEnd = new Date(newShift.date);
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const params = [userId, formatDateYYYYMMDD(rangeStart), formatDateYYYYMMDD(rangeEnd)];
  const excludeClause = excludeId ? `AND id != $4` : '';
  if (excludeId) params.push(excludeId);

  const { rows } = await db.query(
    `SELECT id, date::text as date, start_time, end_time FROM shifts
     WHERE user_id = $1 AND date BETWEEN $2 AND $3 ${excludeClause}`,
    params
  );

  for (const existing of rows) {
    if (shiftsOverlapCheck(existing, newShift)) {
      // rule: 'overlap' is nooit te overrulen. Iemand kan niet op twee plekken
      // tegelijk staan, dus dat is geen beleidskeuze maar een feit. force=true
      // slaat alleen de rusttijd over, hier en bij POST/PUT /shifts.
      return { valid: false, rule: 'overlap', message: 'Overlap: medewerker heeft al een shift op dit tijdstip.' };
    }
    if (!skipRestCheck) {
      // Pas hier lezen: op de force-paden is de norm niet nodig en scheelt dat
      // een query.
      if (MIN_REST === null) MIN_REST = await getMinRustUren(db);
      const hours = hoursBetweenShifts(existing, newShift);
      if (hours >= 0 && hours < MIN_REST) {
        return {
          valid: false,
          rule: 'rest',
          hours: Number(hours.toFixed(1)),
          minRest: MIN_REST,
          message: `Rustregel: slechts ${hours.toFixed(1)}u rust tussen shifts (minimum ${MIN_REST}u).`
        };
      }
    }
  }
  return { valid: true };
}

module.exports = {
  AFWEZIGHEIDSTYPES,
  GELIJKE_TIJDEN_MELDING,
  MAX_AFWEZIGHEIDSDAGEN,
  STANDAARD_MIN_RUST,
  blockDayIfEmpty,
  getMinRustUren,
  isGeldigAfwezigheidstype,
  isGeldigeDatumString,
  isValidTime,
  normaliseerTijd,
  validateShiftRules,
};
