'use strict';

// #402: de afwezigheidstab beweerde in het GROEN dat iemand beschikbaar was.
//
// Er stonden twee takken. Wie een basisrooster had kreeg op een niet-ingeplande
// dag "Vrij"; wie er geen had viel terug op "Beschikbaar" — een groene cel met
// een vinkje. Maar de app weet alleen dat er geen dienst en geen afwezigheid
// staat; of iemand KAN werken volgt daar niet uit. Bij een deeltijdse collega
// zonder basisrooster stond er dus in het groen "beschikbaar" op precies de
// dagen dat ze niet kan.
//
// Daardoor gebruikte zij het afwezigheidstype 'vrij' om dat recht te zetten:
// 44 rijen, met de hand. Dat is nu overbodig — en het type wordt niet meer
// aangeboden, maar blijft wel herkend, zodat die 44 rijen blijven werken.

const fs = require('fs');
const path = require('path');
const frontend = (...p) => path.join(__dirname, '..', '..', 'frontend', ...p);

global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {}, users: [] };

const { ABSENCE_TYPES, teltAlsAfwezigheid } = require(frontend('app-availability.js'));
const BRON = fs.readFileSync(frontend('app-availability.js'), 'utf8');
const CSS = fs.readFileSync(frontend('styles.css'), 'utf8');

describe('"Beschikbaar" bestaat niet meer', () => {
  test('de groene toestand wordt nergens meer gezet', () => {
    expect(BRON).not.toMatch(/statusClass = 'available'/);
  });

  test('een dag zonder dienst heet "Vrij", met of zonder basisrooster', () => {
    // Eén tak, geen onderscheid meer naar hasWeekSchedule voor de STATUS.
    const takken = BRON.match(/statusClass = 'not-scheduled'/g) || [];
    expect(takken).toHaveLength(1);
    expect(BRON).toMatch(/statusText = 'Vrij'/);
  });

  // Het verschil is er nog wel, maar alleen als UITLEG — niet als bewering.
  test('de tooltip zegt nog wel waarom de dag leeg is', () => {
    expect(BRON).toContain('Niet ingepland volgens basisrooster');
    expect(BRON).toContain('Geen dienst ingepland');
  });

  test('het vinkje is weg; er staat altijd een woord', () => {
    expect(BRON).not.toContain('status-check');
  });

  test('de legende noemt de toestand die bestaat', () => {
    expect(BRON).toContain('legend-chip not-scheduled');
    expect(BRON).not.toContain('legend-chip available');
  });

  test('en die legendekleur bestaat, in beide thema\'s', () => {
    expect(CSS).toMatch(/\.legend-chip\.not-scheduled \{/);
    expect(CSS).toMatch(/body\.dark-mode \.legend-chip\.not-scheduled \{/);
  });
});

describe("het type 'vrij' is verouderd, niet verdwenen", () => {
  test('het wordt niet meer aangeboden', () => {
    expect(ABSENCE_TYPES.vrij.verouderd).toBe(true);
    expect(BRON).toMatch(/\.filter\(\(\[, t\]\) => !t\.verouderd\)/);
  });

  // Dit is de hele reden om het niet gewoon te schrappen: in productie staan er
  // 44 rijen van dit type. Verdwijnt het uit de lijst, dan valt hun label terug
  // op "Afwezig", gooit de import ze weg en kent de database ze nog wel.
  test('maar het blijft herkend, met zijn eigen label', () => {
    expect(ABSENCE_TYPES.vrij.label).toBe('Vrij');
    expect(teltAlsAfwezigheid('vrij')).toBe(true);
  });

  test('en de import kent het nog steeds', () => {
    const admin = fs.readFileSync(frontend('app-admin.js'), 'utf8');
    const m = admin.match(/const allowedTypes = \[([^\]]+)\]/);
    expect(m[1]).toContain("'vrij'");
  });

  test('de andere types worden gewoon aangeboden', () => {
    const aangeboden = Object.entries(ABSENCE_TYPES)
      .filter(([, t]) => !t.verouderd).map(([k]) => k).sort();
    expect(aangeboden).toEqual(['andere', 'overuren', 'verlof', 'ziek']);
  });
});

// #403: 'vorming' bestond zowel als AFWEZIGHEID als als ACTIVITEIT. Het hoort
// bij dat laatste — een vorming doe je tijdens je dienst, je bent niet afwezig.
// De productiedata bevestigde het: nul afwezigheidsrijen tegenover zeventien
// activiteiten.
describe("het type 'vorming' is verouderd als afwezigheid", () => {
  test('het wordt niet meer aangeboden', () => {
    expect(ABSENCE_TYPES.vorming.verouderd).toBe(true);
  });

  // Blind schrappen zou een tweede lijstje laten uiteenlopen: de backend en de
  // CHECK-constraint van de database kennen het type nog wel.
  test('maar het blijft herkend, met zijn eigen label', () => {
    expect(ABSENCE_TYPES.vorming.label).toBe('Vorming');
    expect(teltAlsAfwezigheid('vorming')).toBe(true);
  });

  // De activiteit met dezelfde naam blijft bestaan; die is hier de bedoeling.
  test('de activiteit vorming blijft ongemoeid', () => {
    const globals = fs.readFileSync(frontend('app-globals.js'), 'utf8');
    expect(globals).toMatch(/vorming/);
  });
});
