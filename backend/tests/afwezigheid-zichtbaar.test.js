'use strict';

// #401: als een collega verlof ingaf, viel dat niemand op in de planning.
//
// Een dienst van iemand die afwezig is kreeg alleen een rode GLOED om het blok;
// het type stond uitsluitend in de tooltip, dus je moest er met de muis op gaan
// staan om te weten wat er aan de hand was. En dat is de normale situatie: van
// de 29 verlofdagen in productie staat er op 28 nog gewoon een dienst.
//
// Het type staat nu SCHUIN op de achtergrond van het blok, en het blok krijgt
// een eigen achtergrond uit de alert-tokens.
//
// Twee eerdere pogingen waren fout, en allebei om een reden die de moeite is om
// te onthouden:
//   1. een rood chipje op de regel van de activiteiten — qua vorm, grootte én
//      plaats niet te onderscheiden van een activiteitenchip, dus "Verlof" las
//      als nóg een activiteit;
//   2. het woord schuin maar DOORZICHTIG over de teamkleur — die verschilt per
//      team (blauw, paars, groen, roze, amber), dus het contrast was per team
//      anders. Dezelfde val als bij #163 met de activiteitenchips.

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

  test('het watermerk staat in het blok, in beide weergaven', () => {
    const treffers = BRON.match(/class="absent-watermerk"/g) || [];
    expect(treffers).toHaveLength(2); // week- én dagweergave
  });

  // De activiteitenchips blijven staan: het watermerk ligt eronder en vraagt
  // dus geen eigen regel. Dat was bij het afgekeurde chipje wél zo.
  test('de activiteitenchips blijven staan bij een afwezigheid', () => {
    const treffers = BRON.match(/\$\{actChips\}/g) || [];
    expect(treffers.length).toBe(2);
  });

  // Het is een decoratieve herhaling van wat de tooltip al zegt; een
  // schermlezer hoort het niet twee keer voor te lezen.
  test('het watermerk is verborgen voor een schermlezer', () => {
    const treffers = BRON.match(/class="absent-watermerk" aria-hidden="true"/g) || [];
    expect(treffers.length).toBe(2);
  });

  test('de planner heeft geen eigen labellijstje meer', () => {
    expect(BRON).not.toMatch(/const absenceLabels = \{/);
  });

  test('het label wordt ge-escaped', () => {
    expect(BRON).toContain('escapeHtml(afwezigheidsLabel(');
  });
});

describe('de opmaak van het watermerk', () => {
  const CSS = fs.readFileSync(frontend('styles.css'), 'utf8');
  const blok = CSS.match(/\.absent-watermerk \{[\s\S]*?\n\}/);
  const zonderUitleg = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

  test('bestaat en staat schuin', () => {
    expect(blok).not.toBeNull();
    expect(blok[0]).toMatch(/transform:\s*rotate\(-?\d+deg\)/);
  });

  // CLAUDE.md: gebruik de tokens, nooit een hexwaarde — anders werkt het maar
  // in één thema.
  test('gebruikt de alert-tokens en geen hexkleuren', () => {
    expect(zonderUitleg(blok[0])).toContain('var(--alert-error-text)');
    expect(zonderUitleg(blok[0])).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  // De kern van de tweede afgekeurde poging: onder het blok ligt de TEAMkleur,
  // en die verschilt per team. Een afwezig blok krijgt daarom zijn eigen
  // achtergrond, zodat het contrast van het watermerk voor elk team klopt.
  test('een afwezig blok krijgt een eigen achtergrond, los van het team', () => {
    const regel = CSS.match(/\.timeline-block\.team-vlot1\.absent-conflict[\s\S]*?\n\}/);
    expect(regel).not.toBeNull();
    expect(regel[0]).toContain('var(--alert-error-bg)');
  });

  // Watermerk en tijd hebben dezelfde kleur. Nagerekend: élke dekking die het
  // watermerk zichtbaar maakt, duwt de tijd eroverheen onder de 4,5. De halo
  // maakt de tijd los van zijn ondergrond.
  test('de tijd krijgt een halo zodat hij over het watermerk leesbaar blijft', () => {
    const regel = CSS.match(/\.timeline-block\.absent-conflict \.block-time \{[\s\S]*?\n\}/);
    expect(regel).not.toBeNull();
    expect(regel[0]).toMatch(/text-shadow:[\s\S]*var\(--alert-error-bg\)/);
  });

  // Onder de 2,5 uur verdwijnt de tijd al (#147); dan past er ook geen woord
  // meer, ook niet schuin, en blijft de rode rand het signaal.
  test('verdwijnt op het smalste blok', () => {
    expect(CSS).toMatch(/\.timeline-block--xs \.absent-watermerk \{\s*display:\s*none/);
  });
});
