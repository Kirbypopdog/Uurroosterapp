'use strict';

// app-permissions.js is een browserbestand; de rolchecks erin zijn puur en
// worden via de `module.exports`-guard onderaan dat bestand geëxporteerd.
// AppState en formatDateYYYYMMDD zijn globals die het verwacht.
global.AppState = { currentUser: null };
global.formatDateYYYYMMDD = (d) => {
  const j = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dg = String(d.getDate()).padStart(2, '0');
  return `${j}-${m}-${dg}`;
};

const { canRequestSwap } = require('../../frontend/app-permissions.js');

const VANDAAG = global.formatDateYYYYMMDD(new Date());
const schuif = (dagen) => {
  const d = new Date();
  d.setDate(d.getDate() + dagen);
  return global.formatDateYYYYMMDD(d);
};

describe('canRequestSwap', () => {
  beforeEach(() => { global.AppState.currentUser = { id: 2, role: 'medewerker' }; });

  test('je eigen dienst van morgen mag je afstaan', () => {
    expect(canRequestSwap({ userId: 2, date: schuif(1) })).toBe(true);
  });

  test('een dienst van VANDAAG mag nog — dezelfde grens als de backend', () => {
    // swaps.js vergelijkt met vandaag om middernacht, dus vandaag telt niet
    // als verleden. Zouden die twee uiteenlopen, dan verdwijnt de knop terwijl
    // de actie nog kan, of omgekeerd.
    expect(canRequestSwap({ userId: 2, date: VANDAAG })).toBe(true);
  });

  test('een dienst van gisteren mag NIET', () => {
    // Hier bood het scherm de knop gewoon aan en liep je vier stappen door
    // voor de backend hem weigerde met "Shift ligt in het verleden".
    expect(canRequestSwap({ userId: 2, date: schuif(-1) })).toBe(false);
  });

  test('een dienst van vorige maand mag NIET', () => {
    expect(canRequestSwap({ userId: 2, date: schuif(-30) })).toBe(false);
  });

  test('de dienst van een collega mag je nooit afstaan', () => {
    expect(canRequestSwap({ userId: 7, date: schuif(1) })).toBe(false);
  });

  test('id als string telt ook als de jouwe', () => {
    // Uit een formulierveld komt een id als tekst terug; `2 === "2"` is false.
    expect(canRequestSwap({ userId: '2', date: schuif(1) })).toBe(true);
  });

  test('zonder ingelogde gebruiker of zonder dienst: nee', () => {
    expect(canRequestSwap({ userId: 2, date: schuif(1) })).toBe(true);
    global.AppState.currentUser = null;
    expect(canRequestSwap({ userId: 2, date: schuif(1) })).toBe(false);
    global.AppState.currentUser = { id: 2 };
    expect(canRequestSwap(null)).toBe(false);
  });
});
