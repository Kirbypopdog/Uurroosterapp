'use strict';

// data.js is een browserbestand; de verantwoordelijke-helpers erin zijn puur en
// worden via de `module.exports`-guard onderaan dat bestand geëxporteerd, net
// als de schooljaarhelpers. Ze lezen alles uit DataStore, dus die vullen we per
// test.
global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {}, users: [] };

// LET OP: data.js draait in Node in een modulewrapper, dus zijn `const
// DataStore` is module-scoped. `global.DataStore` vullen bereikt hem niet — dat
// is stil, want de functies lezen dan gewoon de lege standaard. Daarom wordt de
// echte referentie meegeëxporteerd en vullen we DIE.
const {
  DataStore,
  getEmployee,
  getOrCalculateResponsible,
} = require('../../frontend/data.js');

// De echte ploeg uit productie, want de volgorde van de rotatie is alfabetisch
// en die volgorde is precies wat er getest wordt.
const PLOEG = [
  { id: 117, name: 'Bryan',          mainTeam: 'vlot1' },
  { id: 115, name: 'Chelsea',        mainTeam: 'vlot2' },
  { id: 118, name: 'Elias',          mainTeam: 'vlot1' },
  { id: 120, name: 'Jill De Groote', mainTeam: 'cargo' },
  { id: 123, name: 'Jill Dias',      mainTeam: 'vlot1' },
];

// Twee weken in de cyclus vanaf de referentiedatum 2026-08-31 (een maandag).
// Nagerekend met isWeekendOrHolidayWeek: de week die OP 2026-08-31 begint valt
// op de dichte helft, 2026-09-07 op de open helft. Niet op gevoel invullen dus.
const PATROON = {
  weeks: { '1': { closedDays: [] }, '2': { closedDays: [6, 0] } },
  cycleLength: 2,
  referenceDate: '2026-08-31',
};

function zet({ vakanties = [], rotatie = {}, ploeg = PLOEG } = {}) {
  DataStore.users = ploeg.map(p => ({ ...p, role: 'medewerker', active: true }));
  DataStore.settings = {
    schedule_pattern: PATROON,
    holidayPeriods: vakanties,
    closedDates: [],
    conceptClosedDates: [],
    responsibleRotation: {
      assignments: {},
      eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
      rotationStart: '2026-08-31',
      rotationStartEmployee: '117',
      ...rotatie,
    },
  };
}

const naam = (d) => { const r = getOrCalculateResponsible(d); return r ? r.name : null; };

// ===== getEmployee =====

describe('getEmployee vergelijkt id-s als tekst', () => {
  test('vindt iemand met een id als string', () => {
    zet();
    // Dit is de kern: uit de API komt het id als GETAL, uit een <select> als
    // STRING. Met === gaf dit undefined, en daar liep de hele
    // vakantieverantwoordelijke op stuk.
    expect(getEmployee('120')).toBeTruthy();
    expect(getEmployee('120').name).toBe('Jill De Groote');
  });

  test('vindt iemand met een id als getal', () => {
    zet();
    expect(getEmployee(120).name).toBe('Jill De Groote');
  });

  test('geeft undefined voor een id dat niet bestaat', () => {
    zet();
    expect(getEmployee('999')).toBeUndefined();
  });
});

// ===== vakantie =====

describe('de vakantieverantwoordelijke staat per week', () => {
  // Kerstvakantie 2026: twee volle weken, elk met een eigen persoon. Dat is de
  // opzet die Victor beschrijft: week 1 door de een, week 2 door de ander.
  const KERST = [{
    id: 1, name: 'Kerstvakantie', startDate: '2026-12-21', endDate: '2027-01-03',
    weeklyResponsibles: { '1': '112', '2': '123' },
  }];
  const METVICTOR = [...PLOEG, { id: 112, name: 'Victor', mainTeam: 'vlot2' }];

  test('week 1 en week 2 krijgen elk hun eigen persoon', () => {
    zet({ vakanties: KERST, ploeg: METVICTOR });
    expect(naam('2026-12-21')).toBe('Victor');
    expect(naam('2026-12-28')).toBe('Jill Dias');
  });

  test('een vakantieweek zonder aangeduide persoon geeft NIEMAND, niet de rotatie', () => {
    zet({ vakanties: [{ id: 2, name: 'Herfstvakantie', startDate: '2026-11-02',
      endDate: '2026-11-08', weeklyResponsibles: {} }] });
    // Hier viel de code terug op de gewone rotatie. Dan stond er tijdens de
    // vakantie iemand die niet aan de beurt was, en bleef die staan zolang de
    // vakantie duurde omdat vakantieweken de teller niet laten oplopen.
    expect(naam('2026-11-02')).toBeNull();
  });

  test('de vakantieweek verbruikt geen beurt in de rotatie', () => {
    zet({ vakanties: [{ id: 2, name: 'Herfstvakantie', startDate: '2026-11-02',
      endDate: '2026-11-08', weeklyResponsibles: { '1': '120' } }] });
    const voor = naam('2026-10-19');
    expect(naam('2026-11-02')).toBe('Jill De Groote'); // de vakantiepersoon
    // Na de vakantie gaat de rotatie verder waar hij gebleven was.
    const na = naam('2026-11-16');
    expect(na).not.toBe(voor);
    expect([voor, na]).toEqual(['Jill De Groote', 'Jill Dias']);
  });

  test('het weeknummer klopt over de overgang naar zomertijd', () => {
    // De laatste zondag van maart 2027 valt op de 28e. Twee lokale
    // middernachten liggen daarover 6,958 dagen uit elkaar in plaats van 7,
    // en met Math.floor werd week 2 dus week 1.
    zet({ vakanties: [{ id: 3, name: 'Paasvakantie', startDate: '2027-03-22',
      endDate: '2027-04-04', weeklyResponsibles: { '1': '117', '2': '115' } }] });
    expect(naam('2027-03-22')).toBe('Bryan');
    expect(naam('2027-03-29')).toBe('Chelsea');
  });
});

// ===== open weekend =====

describe('alleen een open weekend heeft een verantwoordelijke', () => {
  test('een week met een gesloten weekend geeft niemand', () => {
    zet();
    expect(naam('2026-08-31')).toBeNull();
  });

  test('een week met een open weekend geeft de persoon die aan de beurt is', () => {
    zet();
    expect(naam('2026-09-07')).toBe('Bryan');
  });

  test('elke open week schuift precies één plaats op', () => {
    zet();
    // De dichte weken ertussen (09-14, 09-28, ...) slaan we over.
    expect([naam('2026-09-07'), naam('2026-09-21'), naam('2026-10-05'),
            naam('2026-10-19'), naam('2026-11-02')])
      .toEqual(['Bryan', 'Chelsea', 'Elias', 'Jill De Groote', 'Jill Dias']);
  });

  test('de lijst loopt rond en begint weer bij de eerste', () => {
    zet();
    // Vijf mensen, dus de zesde open week is weer Bryan.
    expect(naam('2026-11-16')).toBe('Bryan');
  });

  test('een handmatige toewijzing gaat voor op alles', () => {
    zet({ rotatie: { assignments: { '2026-08-31': 123 } } });
    // Ook al is dat weekend gesloten: dit is een bewuste keuze van de beheerder.
    expect(naam('2026-08-31')).toBe('Jill Dias');
  });

  test('een handmatige toewijzing werkt ook als het id een string is', () => {
    zet({ rotatie: { assignments: { '2026-09-07': '123' } } });
    // De vervangfunctie schreef hier een string weg; met === verdween de
    // weekendverantwoordelijke van die week dan stilletjes.
    expect(naam('2026-09-07')).toBe('Jill Dias');
  });
});
