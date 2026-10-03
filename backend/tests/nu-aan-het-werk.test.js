'use strict';

// app-nav.js is een browserbestand; `dienstLooptNu` is puur en wordt via de
// `module.exports`-guard onderaan dat bestand geëxporteerd. Het leunt op twee
// helpers uit validation.js, die we eerst als globals klaarzetten.
global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {}, users: [], shifts: [] };
const { parseDateTime, getShiftEndDateTime } = require('../../frontend/validation.js');
global.parseDateTime = parseDateTime;
global.getShiftEndDateTime = getShiftEndDateTime;

const { dienstLooptNu } = require('../../frontend/app-nav.js');

const op = (d, u, m = 0) => new Date(2026, 9, d, u, m, 0);   // oktober 2026

describe('dienstLooptNu', () => {
  // De gevallen komen uit een echte melding: de kaart "Nu aan het werk" toonde
  // op 3 oktober om 09:45 "Chelsea, Marie" terwijl het "Sam, Chelsea" moest
  // zijn. Dit zijn de diensten die er die dag werkelijk stonden.
  const chelsea = { date: '2026-10-03', startTime: '08:30', endTime: '16:30', isReserve: false };
  const marie   = { date: '2026-10-03', startTime: '08:30', endTime: '16:30', isReserve: true };
  const sam     = { date: '2026-10-02', startTime: '18:00', endTime: '10:00', isReserve: false };
  const thomas  = { date: '2026-10-03', startTime: '18:00', endTime: '10:00', isReserve: false };

  test('een gewone dienst loopt tussen begin en eind', () => {
    expect(dienstLooptNu(chelsea, op(3, 9, 45))).toBe(true);
    expect(dienstLooptNu(chelsea, op(3, 8, 0))).toBe(false);   // nog niet begonnen
    expect(dienstLooptNu(chelsea, op(3, 17, 0))).toBe(false);  // al afgelopen
  });

  test('het eindmoment zelf telt niet meer mee', () => {
    expect(dienstLooptNu(chelsea, op(3, 16, 29))).toBe(true);
    expect(dienstLooptNu(chelsea, op(3, 16, 30))).toBe(false);
  });

  test('een reservedienst telt nooit mee', () => {
    // Marie stond om 09:45 wél op de planning, maar als reserve. Die kan nog
    // ingetrokken worden, dus zij staat niet als vaste kracht op de vloer.
    expect(dienstLooptNu(marie, op(3, 9, 45))).toBe(false);
  });

  test('een nachtdienst van GISTEREN loopt vanochtend nog door', () => {
    // Sam begon op 2 oktober om 18:00 en geeft op 3 oktober om 10:00 af. Zijn
    // dienst draagt de datum van 2 oktober; wie alleen naar vandaag keek, miste
    // hem precies in de ochtenduren.
    expect(dienstLooptNu(sam, op(3, 9, 45))).toBe(true);
    expect(dienstLooptNu(sam, op(3, 10, 0))).toBe(false);   // net afgegeven
    expect(dienstLooptNu(sam, op(2, 19, 0))).toBe(true);    // gisteravond al bezig
  });

  test('een nachtdienst van VANDAAG loopt ook na middernacht door', () => {
    // Met een tekstvergelijking is "23:00 < 10:00" onwaar, waardoor de kaart
    // 's avonds meldde dat er niemand werkte.
    expect(dienstLooptNu(thomas, op(3, 23, 0))).toBe(true);
    expect(dienstLooptNu(thomas, op(4, 3, 0))).toBe(true);   // midden in de nacht
    expect(dienstLooptNu(thomas, op(3, 17, 0))).toBe(false); // nog niet begonnen
  });

  test('onvolledige of ontbrekende gegevens geven false', () => {
    expect(dienstLooptNu(null, op(3, 9, 45))).toBe(false);
    expect(dienstLooptNu({ date: '2026-10-03' }, op(3, 9, 45))).toBe(false);
    expect(dienstLooptNu({ startTime: '08:00', endTime: '16:00' }, op(3, 9, 45))).toBe(false);
  });

  test('de melding van 3 oktober 09:45 in zijn geheel', () => {
    const nu = op(3, 9, 45);
    const aanHetWerk = [['Chelsea', chelsea], ['Marie', marie], ['Sam', sam], ['Thomas', thomas]]
      .filter(([, d]) => dienstLooptNu(d, nu)).map(([n]) => n);
    expect(aanHetWerk).toEqual(['Chelsea', 'Sam']);
  });
});
