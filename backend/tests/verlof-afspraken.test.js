'use strict';

// De afspraken voor de zomerronde stonden alleen op papier. Nu staan ze in de
// ronde zelf en controleert het invulscherm ze terwijl je klikt:
//   2 weken Zeker niet, 2 weken Liever niet, werken in de startweek (de
//   laatste week van augustus), hoogstens 3 weken na elkaar verlof.
// Een hulp, geen slot: indienen blijft mogelijk.
// Daarnaast toont het verdeelscherm per week wie vrij vroeg, zodat de
// sluitingsweek gekozen kan worden, en geeft één klik die week aan iedereen.

const fs = require('fs');
const path = require('path');
const {
  leaveZomerControle, leaveRondeRegels, leaveVraagtVrijPerWeek, LEAVE_ZOMER_AFSPRAKEN,
} = require('../../frontend/app-leave.js');

const REGELS = { zekerNiet: 2, lieverNiet: 2, laatsteWeekWerken: true, maxAaneen: 3 };
const W = 'werken', L = 'liever_niet', Z = 'zeker_niet';
const okVan = (statussen) => leaveZomerControle(statussen, REGELS).map(p => p.ok);

describe('de controle op de zomerafspraken', () => {
  test('een invulling volgens de afspraken is overal groen', () => {
    expect(okVan([W, Z, Z, W, L, L, W, W, W])).toEqual([true, true, true, true]);
  });

  test('te weinig rood en oranje wordt gemeld, met hoeveel je er hebt', () => {
    const p = leaveZomerControle([W, Z, W, W, L, W, W, W, W], REGELS);
    expect(p[0]).toEqual({ ok: false, tekst: '2 weken Zeker niet: je hebt er 1' });
    expect(p[1].ok).toBe(false);
  });

  test('de startweek (laatste week) moet werken zijn', () => {
    const p = leaveZomerControle([W, Z, Z, W, W, L, W, W, L], REGELS);
    expect(p[2].ok).toBe(false);
    expect(p[2].tekst).toMatch(/Liever niet/);
  });

  test('meer dan 3 weken na elkaar verlof wordt gemeld; rood en oranje tellen samen', () => {
    const p = leaveZomerControle([W, Z, Z, L, L, W, W, W, W], REGELS);
    expect(p[3]).toEqual({ ok: false, tekst: 'Hoogstens 3 weken na elkaar verlof: je hebt er 4 na elkaar' });
    expect(okVan([W, Z, Z, L, W, L, W, W, W])[3]).toBe(true);
  });

  test('een week die nog niet ingevuld is telt niet als werken in de startweek, maar geeft ook geen foutmelding in woorden', () => {
    const p = leaveZomerControle([W, Z, Z, W, L, L, W, W, undefined], REGELS);
    expect(p[2]).toEqual({ ok: false, tekst: 'Werken in de startweek (laatste week)' });
  });

  test('zonder regels (een kleine vakantie) geen controle', () => {
    expect(leaveZomerControle([W, W], undefined)).toEqual([]);
  });
});

describe('de regels die een nieuwe ronde meekrijgt', () => {
  test('een zomerronde krijgt de afspraken en de controle', () => {
    const r = leaveRondeRegels(LEAVE_ZOMER_AFSPRAKEN, true);
    expect(r.afspraken).toMatch(/2 weken ZEKER NIET/);
    expect(r.afspraken).toMatch(/startweek/);
    expect(r.afspraken).toMatch(/maximum 3 weken na elkaar/);
    expect(r.afspraken).not.toMatch(/sluitingsweek/);
    expect(r.controle).toEqual(REGELS);
  });

  test('een ronde met alleen kleine vakanties krijgt geen controle', () => {
    expect(leaveRondeRegels('', false)).toEqual({});
  });
});

describe('de sluitingsweek in het verdeelscherm', () => {
  test('telt per week wie liever of zeker niet wil werken, op basis van wat GEVRAAGD werd', () => {
    const weken = [
      { maandag: '2027-07-19', openDays: ['2027-07-19', '2027-07-20'] },
      { maandag: '2027-07-26', openDays: ['2027-07-26', '2027-07-27'] },
    ];
    const mensen = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const gevraagd = {
      1: { '2027-07-19': Z, '2027-07-20': Z, '2027-07-26': W, '2027-07-27': W },
      2: { '2027-07-19': L, '2027-07-20': L, '2027-07-26': Z, '2027-07-27': Z },
      3: { '2027-07-19': W, '2027-07-20': W, '2027-07-26': W, '2027-07-27': W },
    };
    // De verdeling zelf (perUser) mag de telling niet veranderen.
    const geldt = { 3: { '2027-07-19': 'verlof', '2027-07-20': 'verlof' } };
    expect(leaveVraagtVrijPerWeek(weken, mensen, gevraagd, geldt)).toEqual([2, 1]);
  });
});

describe('in de app aangesloten', () => {
  const bron = fs.readFileSync(path.join(__dirname, '../../frontend/app-leave.js'), 'utf8');

  test('het startvenster vinkt niets aan en toont geen voorbije vakanties', () => {
    const venster = bron.slice(bron.indexOf('function openLeaveRoundModal'), bron.indexOf('function openLeaveRoundModal') + 9000);
    expect(venster).toMatch(/\.filter\(p => \(p\.endDate \|\| ''\) >= vandaag\)/);
    expect(venster).not.toMatch(/data-end="\$\{escapeHtml\(p\.endDate\)\}" checked>/);
    expect(venster).toContain('rules: leaveRondeRegels(');
  });

  test('de afspraken staan bij het invullen en op de rondepagina', () => {
    expect((bron.match(/\$\{leaveAfsprakenHtml\(round\)\}/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(bron).toContain('${leaveControleHtml(round, block, AppState.leaveDraft)}');
  });

  test('één klik geeft de sluitingsweek aan iedereen', () => {
    expect(bron).toContain('data-sluitingsweek=');
    expect(bron).toMatch(/AppState\.leaveVerdeling\[uid\]\[week\] = 'verlof'/);
  });
});
