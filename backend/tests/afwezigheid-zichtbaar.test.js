'use strict';

// #401: als een collega verlof ingaf, viel dat niemand op in de planning.
//
// Een dienst van iemand die afwezig is kreeg alleen een rode GLOED om het blok;
// het type stond uitsluitend in de tooltip, dus je moest er met de muis op gaan
// staan om te weten wat er aan de hand was. En dat is de normale situatie: van
// de 29 verlofdagen in productie staat er op 28 nog gewoon een dienst.
//
// Het label staat nu in het blok zelf, op de regel van de activiteitenchips.
// Die ruilen is bewust: het blok is te laag voor een derde regel (#163), en
// activiteiten op een dag dat iemand afwezig is zijn toch niet meer aan de orde.

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

  test('het label staat in het blok, in beide weergaven', () => {
    const treffers = BRON.match(/class="absent-label"/g) || [];
    expect(treffers).toHaveLength(2); // week- én dagweergave
  });

  // Het label neemt de plek van de chips in; staan ze er allebei, dan wordt het
  // blok te hoog voor zijn inhoud.
  test('het label vervangt de activiteitenchips en komt er niet bij', () => {
    const treffers = BRON.match(/isAbsent\s*\n?\s*\?\s*`<span class="absent-label">/g) || [];
    expect(treffers.length).toBe(2);
  });

  test('de planner heeft geen eigen labellijstje meer', () => {
    expect(BRON).not.toMatch(/const absenceLabels = \{/);
  });

  test('het label wordt ge-escaped', () => {
    expect(BRON).toContain('escapeHtml(afwezigheidsLabel(');
  });
});

describe('de opmaak van het label', () => {
  const CSS = fs.readFileSync(frontend('styles.css'), 'utf8');
  const blok = CSS.match(/\.absent-label \{[\s\S]*?\n\}/);

  test('bestaat', () => {
    expect(blok).not.toBeNull();
  });

  // CLAUDE.md: gebruik de tokens, nooit een hexwaarde — anders werkt het maar
  // in één thema.
  test('gebruikt de alert-tokens en geen hexkleuren', () => {
    const zonderUitleg = blok[0].replace(/\/\*[\s\S]*?\*\//g, '');
    expect(zonderUitleg).toContain('var(--alert-error-bg)');
    expect(zonderUitleg).toContain('var(--alert-error-text)');
    expect(zonderUitleg).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  // #163: de tijd past op 9px en niet op 10. Groter maken knipt tekst af.
  test('houdt zich aan de 9px van het dienstblok', () => {
    expect(blok[0]).toMatch(/font-size:\s*9px/);
  });

  // Onder de 2,5 uur verdwijnt de tijd al (#147); dan is er ook voor het label
  // geen ruimte en blijft de rode rand het signaal.
  test('verdwijnt op het smalste blok', () => {
    expect(CSS).toMatch(/\.timeline-block--xs \.absent-label \{\s*display:\s*none/);
  });
});
