'use strict';

// #416: activiteiten staan in het dienstblok als een wit pilletje met een
// pictogram en de uren. Dat vervangt het balkje van #406, dat alleen een plaats
// had en dus in de weekweergave — waar geen urenschaal staat — niets te lezen gaf.
// #404: het tijdlabel van een dienstblok mag niet afgekapt worden.
//
// `app-planner.js` is een browserbestand; de functies hieronder zijn puur en
// worden via de module.exports-guard onderaan dat bestand geëxporteerd. Ze
// leunen op globals die de browser al heeft staan.
global.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
global.ACTIVITY_TYPE_LABELS_FULL = {
  oudergesprek: 'Oudergesprek', vorming: 'Vorming', overleg: 'Overleg',
  afspraak: 'Afspraak', vergadering: 'Vergadering', andere: 'Andere',
};
global.ACTIVITY_TYPE_ICONS = { vergadering: '<path d="M1 1"/>', overleg: '<path d="M2 2"/>' };

const fs = require('fs');
const path = require('path');

const {
  activiteitenPilletjes, kiesPilVorm, kiesPilVormUren,
  activiteitUrenKort, activiteitStartKort,
  tijdLabelVoorBlok, VOLLEDIG_BEREIK_VANAF_UREN,
} = require('../../frontend/app-planner.js');

let volgnummer = 7;
const act = (type, startTime, endTime, description) => ({ id: volgnummer++, type, startTime, endTime, description });
beforeEach(() => { volgnummer = 7; });

// De twee vergaderingen die in productie werkelijk voorkomen: 13:00-16:00
// (282 van de 430 in zestig dagen) en 09:00-11:00 (100).
const teamvergadering = () => act('vergadering', '13:00', '16:00', 'Teamvergadering');

// Een dagdienst van 08:00 tot 16:00, in de weekweergave.
const week = (over = {}) => ({ dienstVan: 8, dienstTot: 16, blokStartUur: 8, blokUren: 8, isDagweergave: false, ...over });
const dag = (over = {}) => week({ isDagweergave: true, ...over });

// De tekenbreedtes zoals ze in Hanken Grotesk 9px/600 gemeten zijn: een cijfer
// 5, een dubbelepunt 2,3, het streepje 3,9, al het andere 5,1.
const meet = (tekst) => [...tekst].reduce((som, c) => som + (/\d/.test(c) ? 5 : c === ':' ? 2.3 : c === '–' ? 3.9 : 5.1), 0);

describe('de uren in het pilletje', () => {
  test('hele uren worden kort geschreven', () => {
    expect(activiteitUrenKort(teamvergadering())).toBe('13–16u');
    expect(activiteitUrenKort(act('vergadering', '09:00', '11:00', ''))).toBe('9–11u');
  });

  test('met minuten staan er aan BEIDE kanten minuten', () => {
    // "10–11:30" leest als tien tot elf.
    expect(activiteitUrenKort(act('overleg', '10:00', '11:30', ''))).toBe('10:00–11:30');
    expect(activiteitUrenKort(act('vorming', '09:30', '16:30', ''))).toBe('9:30–16:30');
  });

  test('het beginuur alleen', () => {
    expect(activiteitStartKort(teamvergadering())).toBe('13u');
    expect(activiteitStartKort(act('overleg', '09:30', '10:00', ''))).toBe('9:30');
  });

  test('seconden uit de database tellen niet mee', () => {
    expect(activiteitUrenKort(act('vergadering', '13:00:00', '16:00:00', ''))).toBe('13–16u');
  });
});

describe('weekweergave — één pilletje per dienst', () => {
  test('het pilletje draagt de uren als getal, niet als plaats', () => {
    // Het balkje van #406 had hier `left:62.50%;width:37.50%`. De weekweergave
    // heeft geen urenschaal, dus die plaats was niet af te lezen.
    const html = activiteitenPilletjes([teamvergadering()], week());
    expect(html).toContain('data-bereik="13–16u"');
    expect(html).toContain('data-start="13u"');
    expect(html).not.toMatch(/style=/);
  });

  test('één activiteit: de klik opent die activiteit', () => {
    const html = activiteitenPilletjes([teamvergadering()], week());
    expect(html.match(/class="activity-pil /g)).toHaveLength(1);
    expect(html).toContain('data-activity-id="7"');
    expect(html).toContain('data-meer=""');
    expect(html).toContain('activity-type-vergadering');
  });

  test('twee activiteiten: één pilletje, de vroegste voorop, met +1', () => {
    const html = activiteitenPilletjes([
      teamvergadering(),
      act('overleg', '11:00', '12:00', 'Gesprek met GJ'),
    ], week());
    expect(html.match(/class="activity-pil /g)).toHaveLength(1);
    expect(html).toContain('data-bereik="11–12u"');
    expect(html).toContain('data-meer="+1"');
    expect(html).toContain('activity-type-overleg');
  });

  test('meer dan één activiteit: geen id, dus de klik opent het dienstvenster', () => {
    // Daar staan ze allemaal in. Met het id van de eerste zou de klik er één
    // openen en de andere verzwijgen.
    const html = activiteitenPilletjes([teamvergadering(), act('overleg', '11:00', '12:00', 'x')], week());
    expect(html).not.toContain('data-activity-id');
  });

  test('de tooltip noemt elke activiteit, met het uur vooraan', () => {
    const html = activiteitenPilletjes([
      teamvergadering(),
      act('overleg', '11:00', '12:00', 'Gesprek met GJ'),
    ], week());
    expect(html).toContain('data-tooltip="11:00–12:00 · Gesprek met GJ · Overleg\n13:00–16:00 · Teamvergadering"');
  });

  test('het type staat niet twee keer in de tooltip', () => {
    // "Teamvergadering · Vergadering" zegt twee keer hetzelfde.
    const html = activiteitenPilletjes([teamvergadering()], week());
    expect(html).toContain('data-tooltip="13:00–16:00 · Teamvergadering"');
  });

  test('zonder omschrijving valt de tooltip terug op de naam van het type', () => {
    const html = activiteitenPilletjes([act('vorming', '09:00', '13:00', '')], week());
    expect(html).toContain('data-tooltip="09:00–13:00 · Vorming"');
  });

  test('het begint als alleen het pictogram: de vorm die altijd past', () => {
    // pasPilletjesAan() vult de tekst in zodra het blok een breedte heeft.
    // Faalt die stap, dan staat er te weinig maar nooit iets afgesnedens.
    const html = activiteitenPilletjes([teamvergadering()], week());
    expect(html).toContain('activity-pil--kaal');
    expect(html).toContain('<span class="activity-pil-tekst"></span>');
    expect(html).toContain('<svg class="activity-pil-icoon"');
  });

  test('een nachtdienst over twee dagcellen krijgt nu ook zijn pilletje', () => {
    // Het balkje kon dat niet: de breedte van zo'n blok is
    // calc(dag1% + 4px + dag2%), dus een percentage erin is geen tijdstip.
    const html = activiteitenPilletjes([act('overleg', '20:00', '21:00', 'Overdracht')],
      week({ dienstVan: 18, dienstTot: 9, blokStartUur: 18, blokUren: 8 }));
    expect(html).toContain('data-bereik="20–21u"');
  });

  test('bij een nachtdienst telt de ochtend erna mee', () => {
    const html = activiteitenPilletjes([act('vergadering', '07:00', '09:00', 'Teamvergadering')],
      week({ dienstVan: 18, dienstTot: 10, blokStartUur: 18, blokUren: 9 }));
    expect(html).toContain('data-bereik="7–9u"');
  });
});

describe('wat er buiten de dienst valt', () => {
  // De activiteitenmodal waarschuwt bij een activiteit buiten de diensturen,
  // maar staat hem toe. In productie staan er zo een paar.
  test('een activiteit die helemaal buiten de dienst valt krijgt geen pilletje', () => {
    // Een pilletje in het blok zou beweren dat de activiteit in de dienst valt.
    expect(activiteitenPilletjes([teamvergadering()], week({ dienstVan: 9, dienstTot: 13, blokStartUur: 9, blokUren: 4 }))).toBe('');
  });

  test('die telt ook niet mee in de +1', () => {
    const html = activiteitenPilletjes([
      act('overleg', '10:00', '11:00', 'Overleg'),
      teamvergadering(),
    ], week({ dienstVan: 9, dienstTot: 13, blokStartUur: 9, blokUren: 4 }));
    expect(html).toContain('data-meer=""');
    expect(html).toContain('data-activity-id="7"');
  });

  test('zonder activiteiten komt er niets', () => {
    expect(activiteitenPilletjes([], week())).toBe('');
    expect(activiteitenPilletjes(null, week())).toBe('');
  });
});

describe('dagweergave — het pilletje staat op de echte uren', () => {
  const links = (html) => Number(/left:([\d.]+)%/.exec(html)[1]);
  const breed = (html) => Number(/width:calc\(([\d.]+)% - 4px\)/.exec(html)[1]);

  test('een vergadering van 13 tot 16 uur in een dienst van 08 tot 16 uur staat in het laatste deel', () => {
    const html = activiteitenPilletjes([teamvergadering()], dag());
    // 13:00 ligt vijf uur na 08:00 van de acht uur die het blok breed is.
    expect(links(html)).toBeCloseTo(62.5, 1);
    expect(breed(html)).toBeCloseTo(37.5, 1);
  });

  test('halve uren tellen mee', () => {
    const html = activiteitenPilletjes([act('overleg', '09:30', '10:00', 'Overleg')],
      dag({ dienstVan: 9, dienstTot: 11, blokStartUur: 9, blokUren: 2 }));
    expect(links(html)).toBeCloseTo(25, 1);
    expect(breed(html)).toBeCloseTo(25, 1);
  });

  test('een activiteit die deels buiten de dienst valt wordt afgeknipt op de rand', () => {
    const html = activiteitenPilletjes([act('vorming', '11:00', '16:00', 'Vorming')],
      dag({ dienstVan: 9, dienstTot: 13, blokStartUur: 9, blokUren: 4 }));
    expect(links(html)).toBeCloseTo(50, 1);
    expect(breed(html)).toBeCloseTo(50, 1);   // 11:00-13:00, niet tot 16:00
  });

  test('elke activiteit krijgt haar eigen pilletje met haar eigen id', () => {
    const html = activiteitenPilletjes([
      act('vergadering', '08:30', '10:00', 'Teamvergadering'),
      act('overleg', '11:00', '12:00', 'Overleg'),
      act('vorming', '14:00', '15:30', 'Vorming'),
    ], dag());
    expect(html.match(/class="activity-pil /g)).toHaveLength(3);
    expect(html).toContain('data-activity-id="7"');
    expect(html).toContain('data-activity-id="8"');
    expect(html).toContain('data-activity-id="9"');
  });

  test('de omschrijving gaat mee, en het volle uur', () => {
    const html = activiteitenPilletjes([teamvergadering()], dag());
    expect(html).toContain('data-lang="13:00–16:00"');
    expect(html).toContain('data-oms="Teamvergadering"');
  });

  test('in de dagweergave stopt een nachtdienst bij middernacht', () => {
    // Het blok is daar geknipt op zijn eigen cel; de ochtend erna staat er niet in.
    const html = activiteitenPilletjes([act('vergadering', '07:00', '09:00', 'Teamvergadering')],
      dag({ dienstVan: 18, dienstTot: 10, blokStartUur: 18, blokUren: 6 }));
    expect(html).toBe('');
  });

  test('de omschrijving wordt ontsnapt', () => {
    const html = activiteitenPilletjes([act('andere', '09:00', '13:00', '<script>x</script>')], dag());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('kiesPilVorm — de langste vorm die past', () => {
  // De binnenbreedte van een blok op een venster van 1440px: een uur is
  // 8,45px, min 3 voor de linkerrand.
  const blokPx = (uren) => uren * (143.7 / 17) - 3;
  const enkel = { bereik: '13–16u', start: '13u', meer: '' };

  test('een dienst van acht uur toont de uren', () => {
    expect(kiesPilVorm(enkel, blokPx(8), meet)).toEqual({ tekst: '13–16u', meer: '' });
  });

  test('een dienst van zeven uur ook — dat is de gewone vrijdag van 09 tot 16', () => {
    expect(kiesPilVorm(enkel, blokPx(7), meet)).toEqual({ tekst: '13–16u', meer: '' });
  });

  test('een dienst van zes uur valt terug op het beginuur', () => {
    expect(kiesPilVorm(enkel, blokPx(6), meet)).toEqual({ tekst: '13u', meer: '' });
  });

  test('een dienst van drie uur houdt alleen het pictogram over', () => {
    expect(kiesPilVorm(enkel, blokPx(3), meet)).toEqual({ tekst: '', meer: '' });
  });

  test('er wordt nooit een halve tijd getoond: het is een vorm of het is niets', () => {
    for (let px = 0; px <= 160; px += 1) {
      const { tekst } = kiesPilVorm(enkel, px, meet);
      expect(['13–16u', '13u', '']).toContain(tekst);
    }
  });

  test('wat gekozen wordt past ook echt', () => {
    for (let px = 20; px <= 160; px += 1) {
      const { tekst, meer } = kiesPilVorm({ bereik: '9:30–16:30', start: '9:30', meer: '' }, px, meet);
      // 10 pictogram, 3 ertussen, 9 vulling, 4 lucht
      const nodig = 10 + (tekst ? 3 + meet(tekst) : 0) + (meer ? 3 + meet(meer) : 0) + 9 + 4;
      if (tekst) expect(nodig).toBeLessThanOrEqual(px);
    }
  });

  test('op een smaller venster past het uur niet meer maar het beginuur nog wel', () => {
    // Dit is waarom de breedte gemeten wordt en niet uit een vaste maat komt:
    // dezelfde dienst van acht uur is op een venster van ~1100px nog 50px
    // breed. Met de maat van 1440 zou het pilletje daar "13–16u" kiezen, dat
    // niet past, en bleef alleen het pictogram over.
    const smal = 8 * (112.3 / 17) - 3;
    expect(kiesPilVorm(enkel, smal, meet)).toEqual({ tekst: '13u', meer: '' });
  });

  test('+1 gaat vóór het uur', () => {
    // Liever weten dát er nog een is dan het uur van de eerste zien en de
    // tweede missen.
    const dubbel = { bereik: '11–12u', start: '11u', meer: '+1' };
    expect(kiesPilVorm(dubbel, blokPx(9), meet)).toEqual({ tekst: '11–12u', meer: '+1' });
    expect(kiesPilVorm(dubbel, blokPx(6), meet)).toEqual({ tekst: '', meer: '+1' });
    expect(kiesPilVorm(dubbel, blokPx(3), meet)).toEqual({ tekst: '', meer: '' });
  });
});

describe('kiesPilVormUren — het pilletje in de dagweergave', () => {
  const vergadering = { bereik: '13–16u', lang: '13:00–16:00', oms: 'Teamvergadering' };

  test('drie uur is daar 178px: het volle uur en de omschrijving', () => {
    expect(kiesPilVormUren(vergadering, 174, meet)).toEqual({ tekst: '13:00–16:00', oms: 'Teamvergadering' });
  });

  test('een uur is 59px: pictogram en korte uren', () => {
    expect(kiesPilVormUren({ bereik: '11–12u', lang: '11:00–12:00', oms: 'Overleg' }, 55, meet))
      .toEqual({ tekst: '11–12u', oms: '' });
  });

  test('een half uur is 30px: alleen het pictogram', () => {
    expect(kiesPilVormUren({ bereik: '11–11:30', lang: '11:00–11:30', oms: 'Overleg' }, 26, meet))
      .toEqual({ tekst: '', oms: '' });
  });

  test('de omschrijving komt er alleen bij als er plaats is voor meer dan één letter', () => {
    // Anders staat er "T…", en dat zegt minder dan niets.
    expect(kiesPilVormUren(vergadering, 80, meet).oms).toBe('');
  });
});

describe('de maten in de CSS zijn de maten waarmee gerekend wordt', () => {
  // PIL_ICOON, PIL_TUSSEN, PIL_VULLING en PIL_LUCHT in app-planner.js beslissen
  // of een vorm past. Lopen ze uiteen met de opmaak, dan kiest het pilletje een
  // vorm die er niet in past — stil, want het vangnet klapt hem dan weg.
  const CSS = fs.readFileSync(path.join(__dirname, '../../frontend/styles.css'), 'utf8');
  const blok = (selector) => {
    const i = CSS.indexOf(`${selector} {`);
    expect(i).toBeGreaterThan(-1);
    return CSS.slice(i, CSS.indexOf('}', i));
  };

  test('vulling 4 + 5, lucht 2 + 2, tussenruimte 3, pictogram 10', () => {
    const pil = blok('.timeline-block .activity-pil');
    expect(pil).toMatch(/padding: 0 5px 0 4px;/);
    expect(pil).toMatch(/max-width: calc\(100% - 4px\);/);
    expect(pil).toMatch(/column-gap: 3px;/);
    expect(blok('.activity-pil-icoon')).toMatch(/width: 10px;/);
  });

  test('het vangnet staat er: wat niet past klapt weg in plaats van af te kappen', () => {
    const pil = blok('.timeline-block .activity-pil');
    expect(pil).toMatch(/flex-wrap: wrap;/);
    expect(pil).toMatch(/overflow: hidden;/);
  });

  test('het pilletje slaat niet om met het thema', () => {
    // Het dienstblok houdt in de donkere modus zijn teamkleur; een pilletje dat
    // wel omsloeg stond daar donker op een helder blok.
    expect(CSS).toMatch(/--pil-bg: #fffdf9;/);
    // Elk blok `body.dark-mode { … }` afzonderlijk: het eerste staat bovenaan
    // het bestand, dus alles erna doorzoeken zou ook de :root hierboven raken.
    const donkereBlokken = [...CSS.matchAll(/body\.dark-mode\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(donkereBlokken.length).toBeGreaterThan(0);
    donkereBlokken.forEach((inhoud) => expect(inhoud).not.toMatch(/--pil-bg|--pil-tekst/));
  });

  test('het balkje van #406 is weg', () => {
    expect(CSS).not.toMatch(/activity-band/);
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

describe('na de review', () => {
  const F = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');

  test('een klik op het pilletje van één activiteit opent niet óók het dienstvenster', () => {
    // De sleepafhandeling nam de klik op het blok over en opende het
    // dienstvenster onder het activiteitenvenster.
    const drag = F('drag-handler.js');
    const guards = drag.match(/if \(e\.target\.closest\('\.activity-pil\[data-activity-id\]'\)\) return;/g) || [];
    expect(guards).toHaveLength(2);  // muis én toetsenbord/telefoon
  });

  test('de korte codes van de oude chips zijn weg', () => {
    expect(F('app-globals.js')).not.toContain('ACTIVITY_TYPE_LABELS_SHORT');
  });
});

describe('op een telefoon (iPhone)', () => {
  const F = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');
  const css = F('styles.css');

  test('geen :has() en geen flexrij meer: Safari liet die omslaan over de tijd', () => {
    // In Chromium stond het pilletje netjes naast de tijd; op de iPhone zakte
    // het eronder en lag het over de tijd van Sam, Victor en Thomas.
    expect(css).not.toMatch(/\.timeline-block:has\(> \.activity-pil--week\)/);
  });

  test('een rondje links in het blok, met plaats vrij voor de tijd', () => {
    const i = css.indexOf('@media (max-width: 768px) {\n    .timeline-block.met-pil {');
    expect(i).toBeGreaterThan(-1);
    const blok = css.slice(i, css.indexOf('\n}\n', i));
    expect(blok).toMatch(/\.timeline-block\.met-pil \{\s*padding-left: 23px;/);
    expect(blok).toMatch(/position: absolute;/);
    expect(blok).toMatch(/left: 4px !important;/);
    expect(blok).toMatch(/\.activity-pil-tekst,[\s\S]*display: none;/);
    expect(blok).toMatch(/\.resize-handle \{\s*display: none;/);
  });

  test('het blok krijgt de klasse in beide tekenpaden', () => {
    expect((F('app-planner.js').match(/if \(actPilletjes\) blockClass \+= ' met-pil';/g) || []).length).toBe(2);
  });
});
