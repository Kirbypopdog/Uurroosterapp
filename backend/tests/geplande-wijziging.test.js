'use strict';

// Een geplande overname is al te zien vóór ze ingaat: in de planning staat een
// label bij de naam, en vanaf de ingangsdatum tellen de uren tegen het NIEUWE
// contract. `geplandeWijzigingVoor()` in data.js beslist dat.
const fs = require('fs');
const path = require('path');
// data.js leest bij het laden window.DEFAULT_SETTINGS.
global.window = global.window || { DEFAULT_SETTINGS: {} };
const { geplandeWijzigingVoor } = require('../../frontend/data.js');

// De echte ketting: Justine neemt Bryans rooster over vanaf 26 november (Bryan
// blijft in dienst), Bryan dat van Marie vanaf 30 november.
const OVERNAMES = [
  { oudeGebruiker: 117, oudeNaam: 'Bryan', nieuweGebruiker: 181, nieuweNaam: 'Justine', ingangsdatum: '2026-11-26',
    vertrekkerBlijftActief: true, oudeContracturen: 32, oudeTeam: 'vlot1' },
  { oudeGebruiker: 119, oudeNaam: 'Marie', nieuweGebruiker: 117, nieuweNaam: 'Bryan', ingangsdatum: '2026-11-30',
    vertrekkerBlijftActief: false, oudeContracturen: 35, oudeTeam: 'cargo' },
];

test('vóór de ingangsdatum: het oude contract, maar het label staat er al', () => {
  const w = geplandeWijzigingVoor(OVERNAMES, 117, '2026-11-23');
  expect(w.contractUren).toBeNull();
  expect(w.labels.map(l => l.soort).sort()).toEqual(['geeft-door', 'neemt-over']);
});

test('vanaf de ingangsdatum: de uren en het team van de vertrekker', () => {
  const w = geplandeWijzigingVoor(OVERNAMES, 117, '2026-11-30');
  expect(w.contractUren).toBe(35);
  expect(w.team).toBe('cargo');
  expect(w.uitDienst).toBe(false);   // Bryan blijft in dienst
});

test('Justine krijgt Bryans 32 uur vanaf 26 november', () => {
  expect(geplandeWijzigingVoor(OVERNAMES, 181, '2026-11-23').contractUren).toBeNull();
  expect(geplandeWijzigingVoor(OVERNAMES, 181, '2026-11-30').contractUren).toBe(32);
});

test('Marie gaat uit dienst op 30 november', () => {
  expect(geplandeWijzigingVoor(OVERNAMES, 119, '2026-11-23').uitDienst).toBe(false);
  expect(geplandeWijzigingVoor(OVERNAMES, 119, '2026-11-30').uitDienst).toBe(true);
});

test('wie nergens in staat, verandert niet', () => {
  expect(geplandeWijzigingVoor(OVERNAMES, 5, '2026-12-01')).toEqual({ contractUren: null, team: null, uitDienst: false, labels: [] });
  expect(geplandeWijzigingVoor(undefined, 5, '2026-12-01').labels).toEqual([]);
});

test('de planning gebruikt het, met een typeof-wacht (#412)', () => {
  const P = fs.readFileSync(path.join(__dirname, '../../frontend/app-planner.js'), 'utf8');
  expect(P).toContain("typeof geplandeWijzigingVoor === 'function'");
  expect(P).toContain('wijziging.contractUren');
  expect(P).toContain('class="emp-gepland"');
});

describe('de planning zet iedereen al in zijn nieuwe situatie', () => {
  const P = fs.readFileSync(path.join(__dirname, '../../frontend/app-planner.js'), 'utf8');
  const tijdlijn = P.slice(P.indexOf('function renderTimelineView'));

  test('de teamindeling volgt het team uit de geplande overname', () => {
    expect(tijdlijn).toContain('const teamVan = (emp) => wijzigingVan(emp).team || emp.mainTeam;');
    expect(tijdlijn).toContain('.filter(emp => teamVan(emp) === teamKey)');
    expect(tijdlijn).not.toContain('.filter(emp => emp.mainTeam === teamKey)');
  });

  test('wie uit dienst gaat valt weg, tenzij hij die week nog een dienst heeft', () => {
    expect(tijdlijn).toContain('!(wijzigingVan(emp).uitDienst && !employeeIdsWithShifts.has(emp.id))');
  });

  test('iedereen laadt de geplande overnames, niet alleen beheerders', () => {
    const D = fs.readFileSync(path.join(__dirname, '../../frontend/data.js'), 'utf8');
    expect(D).toContain('DataStore.geplandeOvernames = await fetchGeplandeOvernames().catch(() => []);');
  });
});
