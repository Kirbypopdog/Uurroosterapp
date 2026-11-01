'use strict';

// #406: activiteiten staan in het dienstblok als een balkje op de uren waarop
// ze werkelijk vallen, in plaats van als tekstchips met het type erin.
// #404: het tijdlabel van een dienstblok mag niet afgekapt worden.
//
// `app-planner.js` is een browserbestand; beide functies zijn puur en worden
// via de module.exports-guard onderaan dat bestand geëxporteerd. Ze leunen op
// twee globals die de browser al heeft staan.
global.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
global.ACTIVITY_TYPE_LABELS_FULL = {
  oudergesprek: 'Oudergesprek', vorming: 'Vorming', overleg: 'Overleg',
  afspraak: 'Afspraak', vergadering: 'Vergadering', andere: 'Andere',
};

const {
  activiteitenBalkjes, tijdLabelVoorBlok, VOLLEDIG_BEREIK_VANAF_UREN,
} = require('../../frontend/app-planner.js');

const act = (type, startTime, endTime, description) => ({ id: 7, type, startTime, endTime, description });

// De getallen hieronder komen uit de twee vergaderingen die in productie
// werkelijk voorkomen: 13:00-16:00 (637 keer) en 09:00-11:00 (234 keer).
const teamvergadering = act('vergadering', '13:00', '16:00', 'Teamvergadering');

const links = (html) => Number(/left:([\d.]+)%/.exec(html)[1]);
const breed = (html) => Number(/width:([\d.]+)%/.exec(html)[1]);

describe('activiteitenBalkjes — plaats op de echte uren', () => {
  test('een vergadering van 13 tot 16 uur in een dienst van 08 tot 16 uur staat in het laatste deel', () => {
    const html = activiteitenBalkjes([teamvergadering], 8, 8, false, false);
    // 13:00 ligt vijf uur na 08:00 van de acht uur die het blok breed is.
    expect(links(html)).toBeCloseTo(62.5, 1);
    expect(breed(html)).toBeCloseTo(37.5, 1);
  });

  test('een vergadering van 09 tot 11 uur staat vooraan', () => {
    const html = activiteitenBalkjes([act('vergadering', '09:00', '11:00', 'Teamvergadering')], 8.5, 8, false, false);
    expect(links(html)).toBeCloseTo(6.25, 2);
    expect(breed(html)).toBeCloseTo(25, 1);
  });

  test('halve uren tellen mee', () => {
    const html = activiteitenBalkjes([act('overleg', '09:30', '10:00', 'Overleg')], 9, 2, false, false);
    expect(links(html)).toBeCloseTo(25, 1);
    expect(breed(html)).toBeCloseTo(25, 1);
  });
});

describe('activiteitenBalkjes — wat er buiten het blok valt', () => {
  // De activiteitenmodal waarschuwt wel bij een activiteit buiten de
  // diensturen, maar staat hem toe. In productie staan er zo een paar.
  test('een activiteit die deels buiten de dienst valt wordt afgeknipt op de rand', () => {
    const html = activiteitenBalkjes([act('vorming', '11:00', '16:00', 'Vorming')], 9, 4, false, false);
    expect(links(html)).toBeCloseTo(50, 1);
    expect(breed(html)).toBeCloseTo(50, 1);   // 11:00-13:00, niet tot 16:00
  });

  test('een activiteit die er helemaal buiten valt krijgt geen balkje', () => {
    // Een balkje aan de rand zou beweren dat de activiteit in de dienst valt.
    expect(activiteitenBalkjes([teamvergadering], 9, 4, false, false)).toBe('');
  });

  test('een nachtdienst over twee dagcellen krijgt geen balkje', () => {
    // De breedte van zo'n blok is calc(dag1% + 4px + dag2%), dus een percentage
    // binnen het blok komt niet overeen met een tijdstip.
    expect(activiteitenBalkjes([teamvergadering], 18, 6, false, true)).toBe('');
  });

  test('zonder activiteiten komt er niets', () => {
    expect(activiteitenBalkjes([], 8, 8, false, false)).toBe('');
    expect(activiteitenBalkjes(null, 8, 8, false, false)).toBe('');
  });
});

describe('activiteitenBalkjes — tekst alleen waar hij past', () => {
  test('in de weekweergave staat er geen tekst in het balkje', () => {
    // Drie uur is daar 25 pixels; er past geen woord in, alleen "Te…".
    const html = activiteitenBalkjes([teamvergadering], 8, 8, false, false);
    expect(html).not.toContain('Teamvergadering<');
    expect(html).toMatch(/><\/span>$/);
    expect(html).not.toContain('activity-band--tekst');
  });

  test('in de dagweergave staat de tijd vóór de omschrijving', () => {
    // Kapt het op een smaller venster toch af, dan verdwijnt de omschrijving
    // en blijft het uur heel. Andersom zou je een half uur lezen (#208).
    const html = activiteitenBalkjes([teamvergadering], 8, 8, true, false);
    expect(html).toContain('activity-band--tekst');
    expect(html).toContain('>13:00-16:00 · Teamvergadering<');
  });

  test('in de dagweergave krijgt een kort balkje nog steeds geen tekst', () => {
    // Een overleg van een uur is daar 59px; daar past niets in.
    const html = activiteitenBalkjes([act('overleg', '13:00', '14:00', 'Overleg')], 8, 8, true, false);
    expect(html).not.toContain('activity-band--tekst');
    expect(html).not.toContain('Overleg<');
  });

  test('zonder omschrijving valt het terug op de volle naam van het type', () => {
    const html = activiteitenBalkjes([act('vorming', '09:00', '13:00', '')], 8, 8, true, false);
    expect(html).toContain('>09:00-13:00 · Vorming<');
  });
});

describe('activiteitenBalkjes — het blijft aanklikbaar en leesbaar', () => {
  test('elk balkje draagt zijn eigen id, zodat de klik het venster opent', () => {
    const html = activiteitenBalkjes([teamvergadering], 8, 8, false, false);
    expect(html).toContain('data-activity-id="7"');
    expect(html).toContain('class="activity-band activity-type-vergadering"');
  });

  test('de tooltip noemt type, uur en omschrijving', () => {
    const html = activiteitenBalkjes([teamvergadering], 8, 8, false, false);
    expect(html).toContain('data-tooltip="Vergadering 13:00-16:00 — Teamvergadering"');
  });

  test('drie activiteiten krijgen drie volwaardige balkjes', () => {
    // #405: als chips kromp elk van de drie tot 19-21px en werd de tekst
    // doorgesneden ("Overl" las als "Over"). Een balkje staat op zijn eigen
    // uren en vecht dus met niets om breedte.
    const html = activiteitenBalkjes([
      act('vergadering', '08:30', '10:00', 'Teamvergadering'),
      act('overleg', '11:00', '12:00', 'Overleg'),
      act('vorming', '14:00', '15:30', 'Vorming'),
    ], 8, 8, false, false);
    expect(html.match(/class="activity-band/g)).toHaveLength(3);
    const breedtes = [...html.matchAll(/width:([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(breedtes).toEqual([18.75, 12.5, 18.75]);
  });

  test('de omschrijving wordt ontsnapt', () => {
    const html = activiteitenBalkjes([act('andere', '09:00', '13:00', '<script>x</script>')], 8, 8, true, false);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('tijdLabelVoorBlok (#404)', () => {
  // Nagemeten op een venster van 1440px: dagcel 143,7px, één uur 8,45px.
  // "09:00-15:00" is 62,9px breed.
  test.each([
    [6,   50.4],
    [7,   59.2],
    [7.4, 62.6],
  ])('een blok van %s uur is %sp breed en toont dus alleen de starttijd', (uren) => {
    expect(tijdLabelVoorBlok('09:00', '15:00', uren)).toBe('09:00');
  });

  test.each([7.5, 8, 9])('een blok van %s uur toont het volledige bereik', (uren) => {
    expect(tijdLabelVoorBlok('09:00', '15:00', uren)).toBe('09:00-15:00');
  });

  test('de drempel staat op 7,5 en niet op 6', () => {
    // Op 6 werd alles tussen 6 en 7,5 uur gecentreerd afgekapt tot "9:00-15:0",
    // en dat leest als een geldige tijd die het niet is.
    expect(VOLLEDIG_BEREIK_VANAF_UREN).toBe(7.5);
  });
});
