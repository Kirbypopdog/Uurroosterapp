'use strict';

// #400: het afwezigheidstype 'vrij' sprak zichzelf tegen.
//
// #173 voerde het in als "puur informatief, telt niet als conflict, verlaagt de
// bezetting NIET". #204 voegde het daarna toe aan de AFWEZIG-lijst van de
// bezettingsberekening — terecht, want een vaste vrije dag betekent dat die
// persoon niet op de vloer staat. Maar de andere helft bleef staan.
//
// Het gevolg: je kon zonder één waarschuwing een dienst op een vrije dag
// zetten, en die dienst telde vervolgens niet mee in de bezetting. Een dienst
// die er staat maar niet meetelt, en een gat in de bezetting dat niemand meldt.
//
// Er waren vier plekken die elk hun eigen oordeel velden over welke types als
// afwezigheid tellen. Dat oordeel staat nu één keer, in ABSENCE_TYPES.

global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {}, users: [], availability: [], shifts: [] };
global.AppState = {};

const { ABSENCE_TYPES, teltAlsAfwezigheid } = require('../../frontend/app-availability.js');

describe('welke types tellen als afwezigheid', () => {
  test("'vrij' telt mee, net als de rest", () => {
    expect(teltAlsAfwezigheid('vrij')).toBe(true);
  });

  test('alle bekende types tellen mee', () => {
    for (const sleutel of Object.keys(ABSENCE_TYPES)) {
      expect(teltAlsAfwezigheid(sleutel)).toBe(true);
    }
  });

  test('geen type is geen afwezigheid', () => {
    expect(teltAlsAfwezigheid(null)).toBe(false);
    expect(teltAlsAfwezigheid('')).toBe(false);
  });

  // De veilige kant: liever een waarschuwing te veel dan een gemist conflict.
  test('een onbekend type telt mee', () => {
    expect(teltAlsAfwezigheid('iets_nieuws')).toBe(true);
  });
});

describe('een dienst op een vrije dag', () => {
  const { validateAvailability } = require('../../frontend/validation.js');

  beforeEach(() => {
    DataStore.users = [{ id: 7, name: 'Karen', role: 'medewerker', active: true, mainTeam: 'overkoepelend' }];
    DataStore.availability = [];
    global.getEmployee = (id) => DataStore.users.find(u => String(u.id) === String(id)) || null;
    global.getAvailability = (id, datum) => DataStore.availability.find(
      a => String(a.employeeId) === String(id) && a.date === datum) || null;
    global.formatDate = (d) => d;
    global.teltAlsAfwezigheid = teltAlsAfwezigheid;
  });

  afterEach(() => {
    delete global.getEmployee; delete global.getAvailability;
    delete global.formatDate; delete global.teltAlsAfwezigheid;
  });

  // Dit is de kern: vóór #400 kwam hier géén waarschuwing, terwijl de
  // bezettingsbalk die dienst wél al wegliet.
  test('levert een waarschuwing op, net als bij verlof', () => {
    DataStore.availability = [{ employeeId: 7, date: '2026-11-04', type: 'vrij', reason: '' }];
    const uit = validateAvailability(7, '2026-11-04');
    expect(uit.warnings).toHaveLength(1);
    expect(uit.warnings[0].message).toContain('Karen');
    expect(uit.warnings[0].message).toContain('Vrij');
  });

  test('de reden komt mee als die ingevuld is', () => {
    DataStore.availability = [{ employeeId: 7, date: '2026-11-04', type: 'vrij', reason: 'vaste vrije dag' }];
    expect(validateAvailability(7, '2026-11-04').warnings[0].message).toContain('vaste vrije dag');
  });

  test('zonder afwezigheid blijft het stil', () => {
    expect(validateAvailability(7, '2026-11-04').warnings).toHaveLength(0);
  });

  test('verlof werkt onveranderd', () => {
    DataStore.availability = [{ employeeId: 7, date: '2026-11-04', type: 'verlof', reason: '' }];
    const uit = validateAvailability(7, '2026-11-04');
    expect(uit.warnings).toHaveLength(1);
    expect(uit.warnings[0].message).toContain('Verlof');
  });

  // De vlag is de enige bron. Zet hem om, en de waarschuwing hoort te volgen —
  // dat bewijst dat validation.js niet stiekem zijn eigen lijstje terug heeft.
  test('validation.js volgt de vlag en oordeelt niet zelf', () => {
    DataStore.availability = [{ employeeId: 7, date: '2026-11-04', type: 'vrij', reason: '' }];
    global.teltAlsAfwezigheid = (t) => t !== 'vrij';
    expect(validateAvailability(7, '2026-11-04').warnings).toHaveLength(0);
  });
});

// Een herstel uit een JSON-backup liet elke 'vrij'-rij stilzwijgend vallen.
// In productie zijn dat er 44 (alle vrije dagen van één deeltijdse collega).
describe('backup terugzetten', () => {
  const fs = require('fs');
  const path = require('path');
  const BRON = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app-admin.js'), 'utf8');

  test("'vrij' staat bij de toegestane types van de import", () => {
    const m = BRON.match(/const allowedTypes = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    expect(m[1]).toContain("'vrij'");
  });

  // dienstregels.js als TEKST lezen, niet require()-en: dat bestand trekt db.js
  // mee en dus een databankverbinding, terwijl we hier alleen twee lijstjes
  // willen vergelijken. Verhuist het bestand ooit, dan moet deze test mee.
  test('de import kent dezelfde types als de backend', () => {
    const backendBron = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'helpers', 'dienstregels.js'), 'utf8');
    const bm = backendBron.match(/const AFWEZIGHEIDSTYPES = \[([^\]]+)\]/);
    expect(bm).not.toBeNull();
    const vanBackend = bm[1].split(',').map(x => x.trim().replace(/'/g, '')).sort();

    const m = BRON.match(/const allowedTypes = \[([^\]]+)\]/);
    const uitImport = m[1].split(',').map(x => x.trim().replace(/'/g, '')).sort();
    expect(uitImport).toEqual(vanBackend);
  });
});

// De muisaanwijzer moet zeggen wat er gebeurt.
describe('de vrij-markering in de planning', () => {
  const fs = require('fs');
  const path = require('path');
  const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'styles.css'), 'utf8');
  const DRAG = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'drag-handler.js'), 'utf8');

  // `cursor: help` betekent in dit bestand "alleen uitleg, klikken doet niets".
  // De klik viel door naar de cel eronder en opende "nieuwe dienst", dus de
  // aanwijzer beloofde iets anders dan er gebeurde.
  test('de markering heeft geen eigen cursor meer', () => {
    const blok = CSS.match(/\.vrij-indicator \{[\s\S]*?\}/);
    expect(blok).not.toBeNull();
    // Eerst het commentaar eruit: de toelichting bij deze wijziging NOEMT
    // `cursor: help`, en zonder die stap leest de test zijn eigen uitleg.
    const zonderUitleg = blok[0].replace(/\/\*[\s\S]*?\*\//g, '');
    expect(zonderUitleg).not.toMatch(/cursor:\s*help/);
  });

  // Ter vergelijking: die overlay is wél van de klik uitgezonderd, en mag
  // daarom `cursor: help` houden.
  test('.shift-block-indicator blijft uitgezonderd van de klik', () => {
    expect(DRAG).toContain("closest('.shift-block-indicator')");
  });
});
