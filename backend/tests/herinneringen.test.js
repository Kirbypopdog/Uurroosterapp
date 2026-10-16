'use strict';

// #397: de geplande herinneringen. Wat hier getoetst wordt is niet de opmaak
// van de mail maar de BESLISSING: gaat er iets uit, naar wie, en — het
// belangrijkste — gaat hij maar één keer uit.
//
// Dat laatste is geen detail. De server slaapt in na een kwartier stilte, dus
// deze taak draait wanneer een bezoeker hem wakker maakt: soms één keer op een
// dag, soms tien keer. Zonder de claim in `verstuurde_meldingen` zou elke
// bezoeker een ronde herinneringen naar het hele team afvuren.

jest.mock('../src/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));

const verstuurd = [];
jest.mock('../src/email', () => ({
  notifyLeaveRoundOpened: jest.fn(async () => ({ verstuurd: 0 })),
  notifyLeaveRoundReminder: jest.fn(async (ontvangers, ronde, opties) => {
    verstuurd.push({ soort: 'verlof_herinnering', aan: ontvangers.map(o => o.id), ronde: ronde.id, opties });
    return { verstuurd: ontvangers.length };
  }),
  notifyResponsibleReminder: jest.fn(async (persoon, info) => {
    verstuurd.push({ soort: 'verantwoordelijke', aan: [persoon.id], info });
    return { verstuurd: 1 };
  }),
  notifyResponsibleMissing: jest.fn(async (ontvangers, info) => {
    verstuurd.push({ soort: 'verantwoordelijke_ontbreekt', aan: ontvangers.map(o => o.id), info });
    return { verstuurd: ontvangers.length };
  })
}));

const { pool } = require('../src/db');
const herinneringen = require('../src/helpers/herinneringen');

// ===== een databank die genoeg onthoudt =====
// De claimtabel MOET echt onthouden, anders toetst de dubbel-verstuurtest niets.

let geclaimd;
let rondes;
let gebruikers;
let instellingen;
let nietIngediendIds;

function zetDbOp() {
  geclaimd = new Set();
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/INSERT INTO verstuurde_meldingen/i.test(sql)) {
      const sleutel = `${params[0]}|${params[1]}`;
      if (geclaimd.has(sleutel)) return { rows: [], rowCount: 0 };
      geclaimd.add(sleutel);
      return { rows: [{ id: geclaimd.size }], rowCount: 1 };
    }
    if (/UPDATE verstuurde_meldingen/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM leave_rounds/i.test(sql)) return { rows: rondes, rowCount: rondes.length };
    if (/FROM settings/i.test(sql)) return { rows: instellingen, rowCount: instellingen.length };
    if (/NOT EXISTS[\s\S]*leave_round_submissions/i.test(sql)) {
      const r = gebruikers.filter(u => nietIngediendIds.includes(u.id));
      return { rows: r, rowCount: r.length };
    }
    if (/role IN \('admin', 'roosterverantwoordelijke'\)/i.test(sql)) {
      const r = gebruikers.filter(u => ['admin', 'roosterverantwoordelijke'].includes(u.role));
      return { rows: r, rowCount: r.length };
    }
    if (/FROM users/i.test(sql)) return { rows: gebruikers, rowCount: gebruikers.length };
    return { rows: [], rowCount: 0 };
  });
}

// Een patroon met een cyclus van twee weken: week 1 dicht weekend, week 2 open,
// vanaf maandag 31 augustus 2026. Dat is een FIXTURE en niet het patroon van
// productie — de fasering daar is omgekeerd. Wat hier telt is dat de weken
// hieronder nagerekend zijn tegen DIT patroon: 2026-10-19 valt op week 2 (open
// weekend) en 2026-10-26 op week 1 (dicht).
const PATROON = {
  cycleLength: 2,
  referenceDate: '2026-08-31',
  weeks: { '1': { closedDays: [6, 0] }, '2': { closedDays: [] } }
};

const PLOEG = [
  { id: 1, name: 'Admin', role: 'admin', active: true, mainTeam: null, email: 'a@x.be', email_notifications_enabled: true },
  { id: 10, name: 'Bryan', role: 'medewerker', active: true, mainTeam: 'vlot1', email: 'b@x.be', email_notifications_enabled: true },
  { id: 11, name: 'Chelsea', role: 'medewerker', active: true, mainTeam: 'vlot2', email: 'c@x.be', email_notifications_enabled: true },
  { id: 12, name: 'Dries', role: 'roosterverantwoordelijke', active: true, mainTeam: 'vlot1', email: 'd@x.be', email_notifications_enabled: true }
];

beforeEach(() => {
  verstuurd.length = 0;
  rondes = [];
  gebruikers = PLOEG;
  nietIngediendIds = [10, 11];
  instellingen = [
    { key: 'schedule_pattern', value: PATROON },
    { key: 'holidayPeriods', value: [] },
    { key: 'responsibleRotation', value: {
        rotationStart: '2026-09-07', rotationStartEmployee: '10',
        eligibleTeams: ['vlot1', 'vlot2'], assignments: {} } }
  ];
  zetDbOp();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

// ===== dagen tellen =====

describe('dagen tussen twee datums', () => {
  test('gewone week', () => {
    expect(herinneringen.dagenTussen('2026-10-01', '2026-10-08')).toBe(7);
  });

  // Over de overgang naar zomertijd liggen twee lokale middernachten 23 uur
  // uit elkaar. Met afkappen wordt dat 0 dagen in plaats van 1, en dan vuurt
  // een mijlpaal een dag te vroeg of te laat.
  test('over de overgang naar zomertijd', () => {
    expect(herinneringen.dagenTussen('2026-03-28', '2026-03-29')).toBe(1);
    expect(herinneringen.dagenTussen('2026-03-25', '2026-04-01')).toBe(7);
  });

  test('over de overgang naar wintertijd', () => {
    expect(herinneringen.dagenTussen('2026-10-24', '2026-10-25')).toBe(1);
  });
});

// ===== verlofronde =====

describe('herinnering verlofronde', () => {
  const ronde = (deadline, status = 'open') =>
    [{ id: 'r1', name: 'Schooljaar 2026-2027', deadline, status }];

  test('acht dagen op voorhand gaat er nog niets uit', async () => {
    rondes = ronde('2026-10-24');
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd).toHaveLength(0);
  });

  test('zeven dagen op voorhand gaat de eerste eruit', async () => {
    rondes = ronde('2026-10-23');
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd).toHaveLength(1);
    expect(verstuurd[0].aan).toEqual([10, 11]);
    expect(verstuurd[0].opties.dagenTot).toBe(7);
  });

  test('alleen naar wie nog niet indiende', async () => {
    rondes = ronde('2026-10-23');
    nietIngediendIds = [11];
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd[0].aan).toEqual([11]);
  });

  test('heeft iedereen ingediend, dan vertrekt er niets', async () => {
    rondes = ronde('2026-10-23');
    nietIngediendIds = [];
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd).toHaveLength(0);
  });

  // De kern: de server wordt op één dag meermaals wakker.
  test('twee keer draaien op dezelfde dag stuurt één mail', async () => {
    rondes = ronde('2026-10-23');
    await herinneringen.verlofHerinneringen('2026-10-16');
    await herinneringen.verlofHerinneringen('2026-10-16');
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd).toHaveLength(1);
  });

  test('de tweede mijlpaal volgt later, maar niet naast de eerste', async () => {
    rondes = ronde('2026-10-23');
    await herinneringen.verlofHerinneringen('2026-10-16'); // 7 dagen
    await herinneringen.verlofHerinneringen('2026-10-21'); // 2 dagen
    expect(verstuurd).toHaveLength(2);
    expect(verstuurd.map(v => v.opties.dagenTot)).toEqual([7, 2]);
  });

  // Een ronde die pas twee dagen vóór de deadline opengaat, mag niet eerst de
  // "nog 7 dagen"-mail sturen en daarna alsnog de tweede.
  test('een late ronde stuurt één mail, niet twee', async () => {
    rondes = ronde('2026-10-18');
    await herinneringen.verlofHerinneringen('2026-10-16'); // nog 2 dagen
    await herinneringen.verlofHerinneringen('2026-10-17');
    await herinneringen.verlofHerinneringen('2026-10-18');
    expect(verstuurd).toHaveLength(1);
    expect(verstuurd[0].opties.dagenTot).toBe(2);
  });

  test('voorbij de deadline houdt het op', async () => {
    rondes = ronde('2026-10-15');
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd).toHaveLength(0);
  });

  test('een gesloten ronde of een ronde zonder deadline doet niets', async () => {
    rondes = [];
    await herinneringen.verlofHerinneringen('2026-10-16');
    expect(verstuurd).toHaveLength(0);
  });

  // Slaapt de server op dag 7, dan hoort de mail de eerstvolgende keer alsnog
  // te vertrekken in plaats van voorgoed overgeslagen te worden.
  test('een gemiste dag wordt ingehaald', async () => {
    rondes = ronde('2026-10-23');
    await herinneringen.verlofHerinneringen('2026-10-19'); // dag 7 gemist
    expect(verstuurd).toHaveLength(1);
    expect(verstuurd[0].opties.dagenTot).toBe(4);
  });
});

// ===== verantwoordelijke =====

describe('herinnering verantwoordelijke', () => {
  // 2026-10-12 is een maandag. De doelweek is die van 2026-10-19.
  test('de doelweek is de week ERNA', async () => {
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-12');
    expect(uit.weekStart).toBe('2026-10-19');
  });

  test('ook midden in de week blijft het dezelfde doelweek', async () => {
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-14');
    expect(uit.weekStart).toBe('2026-10-19');
  });

  test('bij een open weekend krijgt de verantwoordelijke bericht', async () => {
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-12');
    expect(uit.gedaan).toBe('herinnering');
    expect(verstuurd).toHaveLength(1);
    expect(verstuurd[0].soort).toBe('verantwoordelijke');
    expect(verstuurd[0].info.weekEind).toBe('2026-10-25');
  });

  test('twee keer draaien stuurt één mail', async () => {
    await herinneringen.verantwoordelijkeHerinnering('2026-10-12');
    await herinneringen.verantwoordelijkeHerinnering('2026-10-13');
    await herinneringen.verantwoordelijkeHerinnering('2026-10-14');
    expect(verstuurd).toHaveLength(1);
  });

  // Een dicht weekend heeft geen verantwoordelijke, en dat is het juiste
  // antwoord — geen gebrek. Er hoort dus ook geen melding bij.
  test('bij een gesloten weekend vertrekt er niets', async () => {
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-19');
    expect(uit.gedaan).toBe('geen-verantwoordelijke-nodig');
    expect(verstuurd).toHaveLength(0);
  });

  test('een vakantieweek zonder aanduiding meldt de beheerders', async () => {
    instellingen = instellingen.map(s => s.key === 'holidayPeriods'
      ? { key: 'holidayPeriods', value: [{ name: 'Herfstvakantie', startDate: '2026-10-19', endDate: '2026-11-01', weeklyResponsibles: {} }] }
      : s);
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-12');
    expect(uit.gedaan).toBe('niemand-aangeduid');
    expect(uit.reden).toBe('vakantieweek-niemand-aangeduid');
    expect(verstuurd[0].soort).toBe('verantwoordelijke_ontbreekt');
    expect(verstuurd[0].aan.sort()).toEqual([1, 12]);
  });

  test('een vakantieweek mét aanduiding gaat naar die persoon', async () => {
    instellingen = instellingen.map(s => s.key === 'holidayPeriods'
      ? { key: 'holidayPeriods', value: [{ name: 'Herfstvakantie', startDate: '2026-10-19', endDate: '2026-11-01', weeklyResponsibles: { '1': 11 } }] }
      : s);
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-12');
    expect(uit.gedaan).toBe('herinnering');
    expect(verstuurd[0].aan).toEqual([11]);
  });

  // Het id komt als GETAL uit de API maar als STRING uit elke <select>.
  // `120 === "120"` is false, en dat liet de vakantie-override vroeger zonder
  // een spoor terugvallen op de rotatie.
  test('een id als tekst vindt dezelfde persoon', async () => {
    instellingen = instellingen.map(s => s.key === 'holidayPeriods'
      ? { key: 'holidayPeriods', value: [{ name: 'Herfstvakantie', startDate: '2026-10-19', endDate: '2026-11-01', weeklyResponsibles: { '1': '11' } }] }
      : s);
    const uit = await herinneringen.verantwoordelijkeHerinnering('2026-10-12');
    expect(uit.gedaan).toBe('herinnering');
    expect(verstuurd[0].aan).toEqual([11]);
  });
});

// ===== de vertaling van instellingen naar regels =====

describe('de context die de server opbouwt', () => {
  const { haalContext } = require('../src/helpers/verantwoordelijke');

  // De database noemt het veld `schedule_pattern`, de frontend
  // `schedulePattern`. Wie de verkeerde naam doorgeeft krijgt stil de
  // STANDAARD terug — een omgekeerde weekendcyclus, zonder foutmelding.
  test('schedule_pattern komt terecht als roosterpatroon', async () => {
    const ctx = await haalContext();
    expect(ctx.roosterpatroon).toEqual(PATROON);
  });

  // verstuurReeks filtert op de snake_case naam. Ontbreekt die kolom, dan is
  // het veld daar undefined, is `!== false` waar, en krijgt iemand die de mail
  // net heeft uitgezet hem alsnog.
  test('de medewerkers dragen email_notifications_enabled mee', async () => {
    const ctx = await haalContext();
    expect(ctx.medewerkers[0]).toHaveProperty('email_notifications_enabled');
  });
});
