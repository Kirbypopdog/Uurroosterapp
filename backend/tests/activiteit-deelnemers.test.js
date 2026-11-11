'use strict';

// #408: een activiteit aanmaken voor meerdere mensen tegelijk.
//
// Een activiteit staat per persoon in de database — er is geen gedeelde
// gebeurtenis met deelnemers. Voor de teamvergadering viel dat nooit op omdat
// het concept die genereert, maar alles met de hand moest per persoon opnieuw.
// In productie telt een vergadering gemiddeld 3,5 deelnemers; "EE Stage Yana"
// staat er twee keer in, met de hand ingetypt.
const fs = require('fs');
const path = require('path');

const frontend = (f) => path.join(__dirname, '..', '..', 'frontend', f);

// app-shifts.js leunt op een hoop browserglobals; de functie die we testen
// niet, maar het bestand wordt wel uitgevoerd bij require.
global.AppState = { currentUser: null, simulatedRole: null };
global.DataStore = {
  shifts: [], activities: [], users: [],
  settings: { teams: {
    cargo: { name: 'Cargo' }, vlot1: { name: 'Vlot 1' }, vlot2: { name: 'Vlot 2' },
  } },
};
global.PERMISSIONS = {};
const {
  activiteitDeelnemerKandidaten, activiteitDeelnemersPerTeam, dienstDektActiviteit,
} = require(frontend('app-shifts.js'));
const { canCreateActivityForOthers } = require(frontend('app-permissions.js'));

const MEDEWERKERS = {
  3: { id: 3, name: 'Chelsea' },
  7: { id: 7, name: 'Aline' },
  9: { id: 9, name: 'Sam' },
};
const zoek = (id) => MEDEWERKERS[Number(id)] || null;

const DIENSTEN = [
  { id: 101, employeeId: 3, date: '2026-11-10', startTime: '08:30', endTime: '16:30' },
  { id: 102, employeeId: 7, date: '2026-11-10', startTime: '13:00', endTime: '22:30' },
  { id: 103, employeeId: 9, date: '2026-11-10', startTime: '10:00', endTime: '18:00' },
  { id: 104, employeeId: 7, date: '2026-11-11', startTime: '08:30', endTime: '16:30' },
];

describe('wie komt er in de deelnemerslijst', () => {
  test('iedereen die die dag een dienst heeft, behalve jijzelf', () => {
    const kandidaten = activiteitDeelnemerKandidaten(DIENSTEN, 3, '2026-11-10', zoek);
    expect(kandidaten.map((k) => k.emp.name)).toEqual(['Aline', 'Sam']);
  });

  test('een id als tekst sluit dezelfde persoon evengoed uit', () => {
    // Een id komt als getal uit de API maar als string uit een dataset;
    // `3 === "3"` is false en die persoon zou dan een dubbele rij krijgen.
    const kandidaten = activiteitDeelnemerKandidaten(DIENSTEN, '3', '2026-11-10', zoek);
    expect(kandidaten.map((k) => k.emp.id)).not.toContain(3);
    expect(kandidaten).toHaveLength(2);
  });

  test('alleen diensten van diezelfde dag', () => {
    const kandidaten = activiteitDeelnemerKandidaten(DIENSTEN, 3, '2026-11-11', zoek);
    expect(kandidaten.map((k) => k.emp.name)).toEqual(['Aline']);
  });

  test('de lijst staat op naam, niet op de volgorde van de diensten', () => {
    const kandidaten = activiteitDeelnemerKandidaten(DIENSTEN, 999, '2026-11-10', zoek);
    expect(kandidaten.map((k) => k.emp.name)).toEqual(['Aline', 'Chelsea', 'Sam']);
  });

  test('een dienst van iemand die niet meer in de lijst staat valt weg', () => {
    // Anders komt er een naamloos vinkje in beeld.
    const metWees = DIENSTEN.concat([{ id: 105, employeeId: 404, date: '2026-11-10', startTime: '09:00', endTime: '17:00' }]);
    const kandidaten = activiteitDeelnemerKandidaten(metWees, 3, '2026-11-10', zoek);
    expect(kandidaten).toHaveLength(2);
  });

  test('de dienst gaat mee, want daar hangen shiftId en de uren aan', () => {
    const [aline] = activiteitDeelnemerKandidaten(DIENSTEN, 3, '2026-11-10', zoek);
    expect(aline.shift.id).toBe(102);
    expect(aline.shift.startTime).toBe('13:00');
    expect(aline.shift.endTime).toBe('22:30');
  });

  test('een lege of ontbrekende dienstenlijst geeft niets', () => {
    expect(activiteitDeelnemerKandidaten([], 3, '2026-11-10', zoek)).toEqual([]);
    expect(activiteitDeelnemerKandidaten(null, 3, '2026-11-10', zoek)).toEqual([]);
  });
});

describe('wie mag er een activiteit voor iemand anders aanmaken', () => {
  // Dit is de frontendkant van de check in POST /shift-activities. De twee
  // moeten dezelfde grens trekken (regel 5 in CLAUDE.md): staat hij alleen in
  // de backend, dan toont het scherm een deelnemerslijst die bij het opslaan
  // alsnog een 403 oplevert.
  const alsRol = (role) => { global.AppState.currentUser = { id: 1, role }; };

  test.each(['admin', 'roosterverantwoordelijke'])('%s mag het', (role) => {
    alsRol(role);
    expect(canCreateActivityForOthers()).toBe(true);
  });

  test('een medewerker mag het niet', () => {
    alsRol('medewerker');
    expect(canCreateActivityForOthers()).toBe(false);
  });

  test('de oude rolnamen tellen als roosterverantwoordelijke', () => {
    alsRol('hoofdverantwoordelijke');
    expect(canCreateActivityForOthers()).toBe(true);
    alsRol('teamverantwoordelijke');
    expect(canCreateActivityForOthers()).toBe(true);
  });

  test('een admin die een medewerker simuleert mag het niet', () => {
    global.AppState.currentUser = { id: 1, role: 'admin' };
    global.AppState.simulatedRole = 'medewerker';
    expect(canCreateActivityForOthers()).toBe(false);
    global.AppState.simulatedRole = null;
  });
});

describe('wat het formulier doet met de deelnemers', () => {
  const BRON = fs.readFileSync(frontend('app-shifts.js'), 'utf8');
  const HTML = fs.readFileSync(frontend('index.html'), 'utf8');

  test('bij BEWERKEN is er geen deelnemerslijst', () => {
    // Je bewerkt één rij; de rijen van de anderen blijven staan zoals ze
    // stonden. Een vinkje zou het tegendeel suggereren.
    expect(BRON).toMatch(/activity-deelnemers-groep'\)\?\.classList\.add\('hidden'\)/);
  });

  test('er wordt één rij per aangevinkte persoon geschreven', () => {
    expect(BRON).toMatch(/for \(const o of ontvangers\)/);
    expect(BRON).toContain('userId: o.userId, shiftId: o.shiftId');
  });

  test('de waarschuwing over diensturen kijkt naar ELKE ontvanger', () => {
    // De een werkt tot 16:30 en de ander tot 12:30; dezelfde activiteit valt
    // dan voor de een wél en voor de ander niet binnen de dienst.
    expect(BRON).toMatch(/const buitenDienst = ontvangers\.filter/);
  });

  test('het formulier heeft de deelnemersgroep', () => {
    expect(HTML).toContain('id="activity-deelnemers-groep"');
    expect(HTML).toContain('id="activity-deelnemers"');
  });
});

describe('valt de activiteit binnen de dienst? (#411)', () => {
  // Dit stond als tekstvergelijking in handleActivitySubmit:
  // `startTime < shiftStart || endTime > shiftEnd`.
  test('een gewone dienst die de activiteit omvat', () => {
    expect(dienstDektActiviteit('08:30', '16:30', '13:00', '16:00')).toBe(true);
  });

  test('een activiteit die over het einde heen loopt', () => {
    expect(dienstDektActiviteit('08:30', '16:30', '13:00', '17:00')).toBe(false);
  });

  test('een activiteit die vóór de dienst begint', () => {
    expect(dienstDektActiviteit('13:00', '22:30', '09:00', '11:00')).toBe(false);
  });

  test('precies op de randen telt als binnen', () => {
    expect(dienstDektActiviteit('09:00', '16:00', '09:00', '16:00')).toBe(true);
  });

  // Dit is de reden dat deze functie bestaat. Een overleg van 20:00 tot 21:00
  // binnen een nachtdienst van 18:00 tot 09:00 werd gemeld als "buiten de
  // shift-uren", want `"21:00" > "09:00"` is waar. In productie staan zulke
  // rijen; de waarschuwing ging daar dus af terwijl er niets aan de hand was.
  test('de avond van een nachtdienst valt erbinnen', () => {
    expect(dienstDektActiviteit('18:00', '09:00', '20:00', '21:00')).toBe(true);
  });

  test('de ochtend ná middernacht van een nachtdienst valt er ook binnen', () => {
    // De activiteit draagt dezelfde datum als de dienst, dus 07:00-08:00 hoort
    // bij het stuk ná middernacht.
    expect(dienstDektActiviteit('18:00', '09:00', '07:00', '08:00')).toBe(true);
  });

  test('de middag valt wél buiten een nachtdienst', () => {
    expect(dienstDektActiviteit('18:00', '09:00', '13:00', '16:00')).toBe(false);
  });

  test('zonder bruikbare tijden wordt er niets beweerd', () => {
    // Liever niets zeggen dan een waarschuwing die nergens op slaat.
    expect(dienstDektActiviteit('', '', '13:00', '16:00')).toBe(true);
    expect(dienstDektActiviteit('08:30', '16:30', '', '')).toBe(true);
  });
});

describe('de deelnemers per team (#411)', () => {
  // Het lijstje stond in twee kolommen die rij voor rij gevuld werden, dus de
  // volgorde sprong links-rechts-links en je kon geen naam opzoeken. En de
  // structuur die er werkelijk in zit was onzichtbaar: de 294 gebeurtenissen
  // in productie zijn zonder uitzondering van één team.
  const emp = (id, name, mainTeam) => ({ id, name, mainTeam });
  const kand = (e, team) => ({ emp: e, shift: { id: e.id, team, startTime: '09:00', endTime: '17:00' } });

  const victor = emp(1, 'Victor', 'vlot2');
  const eigenShift = { id: 1, team: 'vlot2', startTime: '07:30', endTime: '16:30' };
  const anderen = [
    kand(emp(2, 'Bryan', 'vlot1'), 'vlot1'),
    kand(emp(3, 'Jill', 'cargo'), 'cargo'),
    kand(emp(4, 'Sam', 'vlot2'), 'vlot2'),
  ];

  test('het eigen team staat bovenaan', () => {
    const groepen = activiteitDeelnemersPerTeam(anderen, eigenShift, victor);
    expect(groepen[0].teamId).toBe('vlot2');
  });

  test('de persoon van de dienst staat als eerste in zijn team, en is gemarkeerd', () => {
    const groepen = activiteitDeelnemersPerTeam(anderen, eigenShift, victor);
    expect(groepen[0].leden[0].emp.name).toBe('Victor');
    expect(groepen[0].leden[0].zelf).toBe(true);
    expect(groepen[0].leden[1].zelf).toBe(false);
  });

  test('iedereen komt precies één keer voor', () => {
    const groepen = activiteitDeelnemersPerTeam(anderen, eigenShift, victor);
    const namen = groepen.flatMap(g => g.leden.map(l => l.emp.name));
    expect(namen.sort()).toEqual(['Bryan', 'Jill', 'Sam', 'Victor']);
  });

  test('de overige teams staan op naam', () => {
    const groepen = activiteitDeelnemersPerTeam(anderen, eigenShift, victor);
    expect(groepen.map(g => g.teamId)).toEqual(['vlot2', 'cargo', 'vlot1']);
  });

  test('zonder team valt iemand in een eigen groep in plaats van weg', () => {
    const zonder = [kand(emp(5, 'Niemand', null), null)];
    const groepen = activiteitDeelnemersPerTeam(zonder, eigenShift, victor);
    const namen = groepen.flatMap(g => g.leden.map(l => l.emp.name));
    expect(namen).toContain('Niemand');
  });
});

describe('wat het venster toont (#411)', () => {
  const BRON = fs.readFileSync(frontend('app-shifts.js'), 'utf8');
  const HTML = fs.readFileSync(frontend('index.html'), 'utf8');

  test('de dag staat in de kop', () => {
    // Je opent het venster vanaf een dienst; zonder datum kan je niet nakijken
    // of je op de juiste dag zit.
    expect(HTML).toContain('id="activity-modal-datum"');
    expect(BRON).toMatch(/zetActiviteitVensterDatum\(date\)/);
  });

  test('de datum wordt opgemaakt, niet als ISO getoond', () => {
    expect(BRON).toMatch(/formatDate\(date\)/);
  });

  test('de persoon van de dienst krijgt geen tweede rij', () => {
    // Zijn vinkje staat vast maar is wél `:checked`, dus zonder uitzondering
    // zou hij zowel uit de basisrij als uit de lijst komen.
    expect(BRON).toContain("input:checked:not([data-zelf])");
  });

  test('de waarschuwing gebruikt de nachtdienstberekening', () => {
    expect(BRON).toMatch(/!dienstDektActiviteit\(o\.shiftStart, o\.shiftEnd, startTime, endTime\)/);
    expect(BRON).not.toMatch(/startTime < o\.shiftStart \|\| endTime > o\.shiftEnd/);
  });
});
