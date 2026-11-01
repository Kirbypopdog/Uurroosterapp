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
global.DataStore = { shifts: [], activities: [], users: [] };
global.PERMISSIONS = {};
const { activiteitDeelnemerKandidaten } = require(frontend('app-shifts.js'));
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
