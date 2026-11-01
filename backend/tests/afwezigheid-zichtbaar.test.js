'use strict';

// #401: als een collega verlof ingaf, viel dat niemand op in de planning.
//
// Een dienst van iemand die afwezig is kreeg alleen een rode GLOED om het blok;
// het type stond uitsluitend in de tooltip, dus je moest er met de muis op gaan
// staan om te weten wat er aan de hand was. En dat is de normale situatie: van
// de 29 verlofdagen in productie staat er op 28 nog gewoon een dienst.
//
// Het type staat nu als een schuin LINTJE over de rechterbovenhoek.
//
// Drie ontwerpen sneuvelden daarvoor, en elk om een reden die het onthouden
// waard is:
//   1. een rood chipje op de regel van de activiteiten — niet te onderscheiden
//      van een activiteitenchip. Wat het verraadde was niet de tekst maar het
//      PIL-VLAK eronder;
//   2. het woord schuin maar DOORZICHTIG over de teamkleur — die verschilt per
//      team (blauw, paars, groen, roze, amber), dus het contrast was per team
//      anders. Dezelfde val als bij #163 met de activiteitenchips;
//   3. datzelfde woord als behang, herhaald — een tegelpatroon heeft een groot
//      vlak nodig, en op een blok van ~75 bij 75 lopen de woorden in elkaar.
//
// Het lint lost alle drie tegelijk op: eigen ondergrond (leesbaar op elk team),
// in de hoek (raakt de tijd niet, deelt niets met de chips), en één element in
// plaats van een patroon dat om ruimte vecht.

const fs = require('fs');
const path = require('path');

const frontend = (...p) => path.join(__dirname, '..', '..', 'frontend', ...p);

global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {}, users: [], shifts: [], availability: [], activities: [] };
global.AppState = {};

const { ABSENCE_LABELS } = (() => {
  const mod = require(frontend('app-availability.js'));
  // ABSENCE_LABELS is een global in de browser; in Node zetten we hem klaar
  // zoals app-availability.js dat doet, uit dezelfde bron.
  const labels = Object.fromEntries(
    Object.entries(mod.ABSENCE_TYPES).map(([k, t]) => [k, t.label]));
  global.ABSENCE_LABELS = labels;
  return { ABSENCE_LABELS: labels };
})();

const { afwezigheidsLabel } = require(frontend('app-planner.js'));

describe('het label van een afwezigheidstype', () => {
  test('komt uit ABSENCE_TYPES en niet uit een eigen lijstje', () => {
    for (const [sleutel, label] of Object.entries(ABSENCE_LABELS)) {
      expect(afwezigheidsLabel(sleutel)).toBe(label);
    }
  });

  test('verlof en ziekte staan er voluit', () => {
    expect(afwezigheidsLabel('verlof')).toBe('Verlof');
    expect(afwezigheidsLabel('ziek')).toBe('Ziekte');
  });

  // De terugval is het neutrale woord en niet het ruwe type: `ziek` in beeld
  // is iets anders dan "Ziekte", en een onbekende sleutel hoort geen
  // databasewaarde op het scherm te zetten.
  test('een onbekend type wordt neutraal "Afwezig"', () => {
    expect(afwezigheidsLabel('bestaat_niet')).toBe('Afwezig');
    expect(afwezigheidsLabel(undefined)).toBe('Afwezig');
  });
});

describe('wat de planner rendert', () => {
  const BRON = fs.readFileSync(frontend('app-planner.js'), 'utf8');

  test('het lint staat in het blok, in beide weergaven', () => {
    const treffers = BRON.match(/afwezigheidsLint\(availability\.type\)/g) || [];
    expect(treffers).toHaveLength(2); // week- én dagweergave
  });

  // De activiteitenchips blijven staan: het lint ligt in de hoek en vraagt geen
  // eigen regel. Bij het afgekeurde chipje was dat wél zo.
  test('de activiteitenchips blijven staan bij een afwezigheid', () => {
    const treffers = BRON.match(/\$\{actChips\}/g) || [];
    expect(treffers.length).toBe(2);
  });

  // Het herhaalt wat de tooltip al zegt; een schermlezer hoort het niet twee
  // keer voor te lezen.
  test('het lint is verborgen voor een schermlezer', () => {
    expect(BRON).toMatch(/class="afwezig-lint" aria-hidden="true"/);
  });

  test('de planner heeft geen eigen labellijstje meer', () => {
    expect(BRON).not.toMatch(/const absenceLabels = \{/);
  });

  test('het label wordt ge-escaped', () => {
    expect(BRON).toContain('escapeHtml(afwezigheidsLabel(');
  });

  // Het watermerk is helemaal weg; blijven er resten staan, dan vecht er stille
  // CSS met het lint.
  test('er staat geen watermerk meer in de code', () => {
    expect(BRON).not.toContain('absent-watermerk');
    const CSS = fs.readFileSync(frontend('styles.css'), 'utf8');
    expect(CSS).not.toContain('absent-watermerk');
  });
});

describe('de opmaak van het lint', () => {
  const CSS = fs.readFileSync(frontend('styles.css'), 'utf8');
  const band = CSS.match(/\.afwezig-lint-band \{[\s\S]*?\n\}/);
  const houder = CSS.match(/\.afwezig-lint \{[\s\S]*?\n\}/);
  const zonderUitleg = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

  test('bestaat en staat schuin', () => {
    expect(band).not.toBeNull();
    expect(band[0]).toMatch(/transform:\s*rotate\(-?\d+deg\)/);
  });

  // De houder knipt de band af tot een hoek; zonder overflow steekt hij buiten
  // het blok en loopt hij over de buurcel heen.
  test('de houder knipt de band af tot een hoek', () => {
    expect(houder).not.toBeNull();
    expect(houder[0]).toMatch(/overflow:\s*hidden/);
    expect(houder[0]).toMatch(/pointer-events:\s*none/);
  });

  // CLAUDE.md: gebruik de tokens, nooit een hexwaarde — anders werkt het maar
  // in één thema. De tekst OP de band heeft een eigen token nodig, want hij
  // staat op alert-error-text en niet op een achtergrondkleur.
  test('gebruikt de tokens en geen hexkleuren', () => {
    expect(zonderUitleg(band[0])).toContain('var(--alert-error-text)');
    expect(zonderUitleg(band[0])).toContain('var(--alert-lint-tekst)');
    expect(zonderUitleg(band[0])).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test('en dat token bestaat in beide thema\'s', () => {
    const treffers = CSS.match(/--alert-lint-tekst:/g) || [];
    expect(treffers.length).toBeGreaterThanOrEqual(2);
  });

  // Een lang woord als "Overuren" mag niet over de rand van de band vallen.
  test('een te lang woord wordt netjes afgekapt', () => {
    expect(band[0]).toMatch(/text-overflow:\s*ellipsis/);
    expect(band[0]).toMatch(/white-space:\s*nowrap/);
  });

  // Onder de 2,5 uur verdwijnt de tijd al (#147); dan past er ook geen lint
  // meer en blijft de rode rand het signaal.
  test('verdwijnt op het smalste blok', () => {
    expect(CSS).toMatch(/\.timeline-block--xs \.afwezig-lint \{\s*display:\s*none/);
  });

  // De eigen achtergrond is wat het blok in de rij laat opvallen; zonder die
  // regel staat het lint op de teamkleur en is het contrast weer per team
  // anders.
  test('een afwezig blok houdt zijn eigen achtergrond', () => {
    const regel = CSS.match(/\.timeline-block\.team-vlot1\.absent-conflict[\s\S]*?\n\}/);
    expect(regel).not.toBeNull();
    expect(regel[0]).toContain('var(--alert-error-bg)');
  });
});
