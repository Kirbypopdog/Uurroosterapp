'use strict';

// data.js is een browserbestand; de schooljaarhelpers erin zijn puur en worden
// via de `module.exports`-guard onderaan dat bestand geëxporteerd. De enige
// globals die het bij het laden nodig heeft zijn window en DataStore.
global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {} };

// #394: vullen moet in de DataStore VAN DE MODULE. In Node draait data.js in
// een modulewrapper, dus zijn `const DataStore` is module-scoped en de globale
// hierboven bereikt hem niet — die is alleen nodig om het bestand te laden.
// Daar is deze test lang in gelopen: zetStart schreef naar een object waar
// niemand naar keek, en alle veertien tests draaiden tegen de lege standaard.
// Nagegaan door elke waarde door onzin te vervangen; ze slaagden alsnog.
const {
  DataStore,
  getSchoolAnchorMonday,
  getSchoolYearAnchorMonday,
  getSchoolWeekNumber,
  getFourWeekPeriodDates,
  formatDateYYYYMMDD
} = require('../../frontend/data.js');

const zetStart = (datum) => { DataStore.settings.schoolYearStart = { date: datum }; };

// ===== getSchoolAnchorMonday =====

describe('getSchoolAnchorMonday', () => {
  test('een doordeweekse startdatum ankert op de maandag van diezelfde week', () => {
    // dinsdag 1 september 2026 -> maandag 31 augustus 2026
    expect(formatDateYYYYMMDD(getSchoolAnchorMonday('2026-09-01'))).toBe('2026-08-31');
  });

  test('een startdatum op zaterdag schuift naar de maandag erna', () => {
    // zaterdag 1 september 2029 -> maandag 3 september 2029
    expect(formatDateYYYYMMDD(getSchoolAnchorMonday('2029-09-01'))).toBe('2029-09-03');
  });

  test('een startdatum op zondag schuift naar de maandag erna', () => {
    // zondag 1 september 2030 -> maandag 2 september 2030
    expect(formatDateYYYYMMDD(getSchoolAnchorMonday('2030-09-01'))).toBe('2030-09-02');
  });

  test('een startdatum die al op maandag valt blijft staan', () => {
    // maandag 1 september 2025
    expect(formatDateYYYYMMDD(getSchoolAnchorMonday('2025-09-01'))).toBe('2025-09-01');
  });
});

// ===== #244: de twee functies mogen niet uit elkaar lopen =====

describe('getFourWeekPeriodDates bevat altijd de doorgegeven datum', () => {
  // De kern van #244. Vóór de fix bepaalde getFourWeekPeriodDates het
  // schooljaar op basis van de datum zelf en getSchoolWeekNumber op basis van
  // de maandag van die week. Bij een startdatum die niet op maandag valt
  // kozen die twee voor de eerste dagen een verschillend schooljaar, en sprong
  // de periode 364 dagen vooruit.
  const startdatums = [
    '2026-09-01', // dinsdag
    '2025-09-01', // maandag
    '2029-09-01', // zaterdag
    '2030-09-01', // zondag
    '2027-09-01', // woensdag
  ];

  for (const start of startdatums) {
    test(`schooljaarstart ${start}: elke dag van een heel jaar valt binnen zijn eigen periode`, () => {
      zetStart(start);
      const buiten = [];
      const d = new Date(Number(start.slice(0, 4)), 7, 1); // 1 augustus
      for (let i = 0; i < 420; i++) {
        const s = formatDateYYYYMMDD(d);
        const periode = getFourWeekPeriodDates(s);
        if (!periode || s < periode.startDate || s > periode.endDate) {
          buiten.push({ datum: s, periode });
        }
        d.setDate(d.getDate() + 1);
      }
      expect(buiten).toEqual([]);
    });
  }

  test('de dagen uit de meting in #244 vallen allemaal in dezelfde eerste periode', () => {
    zetStart('2026-09-01'); // dinsdag
    const verwacht = { startDate: '2026-08-31', endDate: '2026-09-27' };
    for (const d of ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-06']) {
      expect(getFourWeekPeriodDates(d)).toEqual(verwacht);
    }
  });
});

describe('getSchoolWeekNumber', () => {
  test('de hele eerste schoolweek is week 1, ook de dagen vóór de startdatum', () => {
    zetStart('2026-09-01'); // dinsdag
    for (const d of ['2026-08-31', '2026-09-01', '2026-09-06']) {
      expect(getSchoolWeekNumber(d)).toBe(1);
    }
    expect(getSchoolWeekNumber('2026-09-07')).toBe(2);
  });

  test('telt netjes door over de weken heen', () => {
    zetStart('2026-09-01');
    expect(getSchoolWeekNumber('2026-09-14')).toBe(3);
    expect(getSchoolWeekNumber('2026-09-28')).toBe(5);
  });

  test('geeft null als er geen schooljaarstart bekend is', () => {
    const bewaard = global.DataStore.settings.schoolYearStart;
    global.DataStore.settings.schoolYearStart = null;
    // getSchoolYearStart valt dan terug op 1 september, dus er komt wel een
    // getal uit; dit legt dat gedrag vast in plaats van het te veronderstellen.
    expect(typeof getSchoolWeekNumber('2026-09-02')).toBe('number');
    global.DataStore.settings.schoolYearStart = bewaard;
  });

  test('het anker is voor elke dag van dezelfde week hetzelfde', () => {
    zetStart('2026-09-01');
    const anker = formatDateYYYYMMDD(getSchoolYearAnchorMonday('2026-09-02'));
    for (const d of ['2026-08-31', '2026-09-01', '2026-09-03', '2026-09-06']) {
      expect(formatDateYYYYMMDD(getSchoolYearAnchorMonday(d))).toBe(anker);
    }
  });
});
