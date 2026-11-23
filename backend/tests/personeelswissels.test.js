'use strict';

// Personeelswissels: een hele situatie in één keer, met de volgorde door de
// app bepaald. Aanleiding: op 23 november 2026 werd "Marie → Bryan" vóór
// "Bryan → Justine" ingesteld, en verdwenen 121 diensten van Bryan.
const fs = require('fs');
const path = require('path');
jest.mock('../src/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
const router = require('../src/routes/personeelswissels');
const { ordenStappen, normaliseerStappen } = router;

const MARIE = 119, BRYAN = 117, JUSTINE = 181;

describe('de volgorde zoekt de app zelf', () => {
  test('eerst wie doorschuift, dan wie diens plaats inneemt — ook als je het omgekeerd ingeeft', () => {
    const omgekeerd = [
      { van: MARIE, naar: BRYAN, vanaf: '2026-11-30' },
      { van: BRYAN, naar: JUSTINE, vanaf: '2026-11-26', blijftInDienst: true },
    ];
    const v = ordenStappen(normaliseerStappen(omgekeerd));
    expect(v.map(s => `${s.van}->${s.naar}`)).toEqual([`${BRYAN}->${JUSTINE}`, `${MARIE}->${BRYAN}`]);
  });

  test('een langere ketting: A → B → C → D', () => {
    const v = ordenStappen(normaliseerStappen([
      { van: 1, naar: 2, vanaf: '2027-01-01' },
      { van: 2, naar: 3, vanaf: '2027-01-01' },
      { van: 3, naar: 4, vanaf: '2027-01-01' },
    ]));
    expect(v.map(s => s.van)).toEqual([3, 2, 1]);
  });

  test('een kring kan niet', () => {
    expect(() => ordenStappen(normaliseerStappen([
      { van: 1, naar: 2, vanaf: '2027-01-01' },
      { van: 2, naar: 1, vanaf: '2027-01-01' },
    ]))).toThrow(/kring/);
  });

  test('iemand kan maar één keer zijn rooster doorgeven', () => {
    expect(() => ordenStappen(normaliseerStappen([
      { van: 1, naar: 2, vanaf: '2027-01-01' },
      { van: 1, naar: 3, vanaf: '2027-01-01' },
    ]))).toThrow(/twee stappen/);
  });
});

describe('invoer', () => {
  test.each([
    [[], /minstens één stap/],
    [[{ van: 1, naar: 1, vanaf: '2027-01-01' }], /eigen rooster/],
    [[{ van: 1, naar: 2, vanaf: '1 jan' }], /ingangsdatum/],
    [[{ van: 0, naar: 2, vanaf: '2027-01-01' }], /kies wie/],
  ])('%j wordt geweigerd', (stappen, melding) => {
    expect(() => normaliseerStappen(stappen)).toThrow(melding);
  });

  test('"blijft in dienst" staat standaard uit', () => {
    expect(normaliseerStappen([{ van: 1, naar: 2, vanaf: '2027-01-01' }])[0].blijftInDienst).toBe(false);
  });
});

describe('veiligheid van het voorbeeld en de botsingen', () => {
  const BRON = fs.readFileSync(path.join(__dirname, '../src/routes/personeelswissels.js'), 'utf8');

  test('het voorbeeld draait ALTIJD terug', () => {
    const blok = BRON.slice(BRON.indexOf("router.post('/personeelswissels/voorbeeld'"), BRON.indexOf("router.get('/personeelswissels'"));
    expect(blok).toMatch(/finally \{[\s\S]*ROLLBACK/);
    expect(blok).not.toContain('COMMIT');
  });

  test('botsingen worden per dag beslist, en wat vervalt gaat mee in het terugdraaien', () => {
    expect(BRON).toContain("keuzes[sleutel] === 'eigen' ? 'eigen' : 'overnemen'");
    expect(BRON).toContain('extraVerwijderd: teWissen');
    expect(BRON).toContain("eigenDienstenVervanger: 'behouden'");
  });

  test('rollen gaan niet mee', () => {
    expect(BRON).not.toMatch(/SET role\b/);
  });

  test('terugdraaien gaat in omgekeerde volgorde', () => {
    expect(BRON).toMatch(/FROM geplande_overnames WHERE wissel_id = \$1 ORDER BY id DESC/);
  });
});

describe('in de app', () => {
  const F = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');

  test('een eigen tab in Instellingen, voor admin en roosterverantwoordelijke', () => {
    expect(F('app-builder.js')).toContain("{ id: 'wissels', label: 'Personeelswissels', roles: ['admin', 'roosterverantwoordelijke'] }");
    expect(F('app-settings.js')).toContain("if (typeof renderSettingsWissels === 'function') renderSettingsWissels(content);");
    expect(F('index.html')).toMatch(/<script src="app-wissels\.js\?v=\w+"><\/script>/);
  });

  test('de knop in het accountvenster start een personeelswissel in plaats van één losse vervanging', () => {
    const S = F('app-settings.js');
    expect(S).toContain('startPersoneelswisselVoor(user.id)');
    expect(S).toContain(' Personeelswissel</button>');
  });

  test('het voorbeeld waarschuwt voor met de hand leeggemaakte dagen (wat bij Marie misliep)', () => {
    expect(F('app-wissels.js')).toContain('met de hand leeggemaakt');
  });

  test('bevestigen kan pas na een actueel voorbeeld', () => {
    const W = F('app-wissels.js');
    expect(W).toContain("const actueel = !!WisselState.voorbeeld && !WisselState.gewijzigdNaVoorbeeld && !WisselState.bezig;");
    expect(W).toContain('if (bevestig) bevestig.disabled = !actueel;');
    expect(W).toContain('if (!v || WisselState.gewijzigdNaVoorbeeld) return;');
  });

  test('het voorbeeld verschijnt vanzelf, en een trager antwoord overschrijft geen nieuwer', () => {
    const W = F('app-wissels.js');
    expect(W).toContain('wisselPlanVoorbeeld(container)');
    expect(W).toContain('if (nummer !== _wisselVolgnummer) return;');
  });
});

describe('uren per week in het voorbeeld', () => {
  global.window = global.window || {};
  const { wisselWeekUren, wisselStapKlaar } = require('../../frontend/app-wissels.js');

  test('een stap is pas klaar met twee verschillende mensen en een datum', () => {
    expect(wisselStapKlaar({ van: '1', naar: '2', vanaf: '2027-01-01' })).toBe(true);
    expect(wisselStapKlaar({ van: '1', naar: '1', vanaf: '2027-01-01' })).toBe(false);
    expect(wisselStapKlaar({ van: '1', naar: '', vanaf: '2027-01-01' })).toBe(false);
    expect(wisselStapKlaar({ van: '1', naar: '2', vanaf: '' })).toBe(false);
  });
  const M = ['2026-11-30', '2026-12-07', '2026-12-14'];
  const acht = () => 8;

  test('elke dienst telt in zijn eigen week', () => {
    expect(wisselWeekUren([
      { date: '2026-11-30' }, { date: '2026-12-06' }, { date: '2026-12-07' }, { date: '2026-12-20' },
    ], M, acht)).toEqual([16, 8, 8]);
  });

  test('vóór de eerste week en na de laatste telt niets', () => {
    expect(wisselWeekUren([{ date: '2026-11-29' }, { date: '2026-12-21' }], M, acht)).toEqual([0, 0, 0]);
  });
});

test('geen namen van echte collega\'s in wat de gebruiker te zien krijgt', () => {
  // Alleen de tekst buiten de opmerkingen telt: daar staat de aanleiding wel
  // met namen, maar die ziet niemand in de app.
  const W = fs.readFileSync(path.join(__dirname, '../../frontend/app-wissels.js'), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  expect(W).not.toMatch(/Bryan|Marie|Justine/);
});
