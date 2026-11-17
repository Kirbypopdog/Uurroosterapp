'use strict';

// #417: wie op "Overnemen" drukt, ziet in één venster de dienst, zijn hele
// week, zijn uren ervoor en erna en de rust tot de dienst ervóór en erná.
// Vroeger kwamen er drie losse vragen na elkaar en zag je je eigen week niet.
//
// `overnameOverzicht()` in app-swaps.js rekent dat uit en is puur.

const fs = require('fs');
const path = require('path');
// De rekenkant gebruikt de tijdfuncties uit validation.js, die in de browser
// als globals bestaan.
const { parseDateTime, getShiftEndDateTime } = require('../../frontend/validation.js');
global.parseDateTime = parseDateTime;
global.getShiftEndDateTime = getShiftEndDateTime;
const { overnameOverzicht } = require('../../frontend/app-swaps.js');

const acht = () => 8;
const basis = (over = {}) => ({
  dienst: { date: '2026-11-19', startTime: '09:30', endTime: '16:30' },
  eigenDiensten: [],
  weekStart: '2026-11-16',
  minRust: 11,
  urenVan: acht,
  ...over,
});

describe('de week', () => {
  test('zeven dagen, van maandag tot zondag', () => {
    const o = overnameOverzicht(basis());
    expect(o.dagen.map((d) => d.datum)).toEqual([
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19',
      '2026-11-20', '2026-11-21', '2026-11-22',
    ]);
  });

  test('de nieuwe dienst staat op zijn dag, gemarkeerd als nieuw', () => {
    const o = overnameOverzicht(basis({
      eigenDiensten: [{ date: '2026-11-19', startTime: '18:00', endTime: '22:00' }],
    }));
    const donderdag = o.dagen[3].diensten;
    expect(donderdag.map((x) => x.startTime)).toEqual(['09:30', '18:00']);
    expect(donderdag[0].nieuw).toBe(true);
    expect(donderdag[1].nieuw).toBeUndefined();
  });

  test('tijden uit de database ("13:00:00") worden kort getoond', () => {
    const o = overnameOverzicht(basis({
      dienst: { date: '2026-11-19', startTime: '09:30:00', endTime: '16:30:00' },
    }));
    expect(o.dagen[3].diensten[0]).toMatchObject({ startTime: '09:30', endTime: '16:30' });
  });

  test('de uren van de week: ervoor en erna', () => {
    const o = overnameOverzicht(basis({
      eigenDiensten: [
        { date: '2026-11-17', startTime: '09:00', endTime: '17:00' },
        { date: '2026-11-18', startTime: '09:00', endTime: '17:00' },
        // de zondag ervóór en de maandag erna tellen niet mee in DEZE week
        { date: '2026-11-15', startTime: '09:00', endTime: '17:00' },
        { date: '2026-11-23', startTime: '09:00', endTime: '17:00' },
      ],
    }));
    expect(o.weekUrenVoor).toBe(16);
    expect(o.weekUrenNa).toBe(24);
    expect(o.nieuweUren).toBe(8);
  });
});

describe('de rust ervoor en erna', () => {
  test('van 23:00 tot 09:30 de dag erna is 10,5 uur: te kort bij een norm van 11', () => {
    const o = overnameOverzicht(basis({
      eigenDiensten: [{ date: '2026-11-18', startTime: '13:00', endTime: '23:00' }],
    }));
    expect(o.rustVoor.uren).toBe(10.5);
    expect(o.rustVoor.teKort).toBe(true);
    expect(o.rustNa).toBeNull();
  });

  test('de norm komt uit de instellingen', () => {
    const o = overnameOverzicht(basis({
      minRust: 10,
      eigenDiensten: [{ date: '2026-11-18', startTime: '13:00', endTime: '23:00' }],
    }));
    expect(o.rustVoor.teKort).toBe(false);
  });

  test('de DICHTSTBIJZIJNDE dienst telt, niet de eerste in de lijst', () => {
    const o = overnameOverzicht(basis({
      eigenDiensten: [
        { date: '2026-11-21', startTime: '09:00', endTime: '17:00' },
        { date: '2026-11-20', startTime: '07:30', endTime: '16:00' },
        { date: '2026-11-16', startTime: '09:00', endTime: '17:00' },
        { date: '2026-11-18', startTime: '09:00', endTime: '16:00' },
      ],
    }));
    expect(o.rustVoor.dienst.date).toBe('2026-11-18');
    expect(o.rustNa.dienst.date).toBe('2026-11-20');
    expect(o.rustNa.uren).toBe(15);
  });

  test('een nachtdienst ervóór eindigt de dag erna', () => {
    // 18:00 tot 09:00 op woensdag: dat eindigt donderdag 09:00, een half uur
    // voor de nieuwe dienst. Als tekst vergeleken zou "09:00" vóór "18:00"
    // liggen en kwam hier 15,5 uur rust uit.
    const o = overnameOverzicht(basis({
      eigenDiensten: [{ date: '2026-11-18', startTime: '18:00', endTime: '09:00' }],
    }));
    expect(o.rustVoor.uren).toBe(0.5);
    expect(o.rustVoor.teKort).toBe(true);
  });

  test('een nachtdienst die je OVERNEEMT eindigt de dag erna', () => {
    const o = overnameOverzicht(basis({
      dienst: { date: '2026-11-19', startTime: '18:00', endTime: '09:00' },
      eigenDiensten: [{ date: '2026-11-20', startTime: '16:00', endTime: '22:00' }],
    }));
    expect(o.rustNa.uren).toBe(7);
  });

  test('zonder eigen diensten in de buurt is er geen rust te melden', () => {
    const o = overnameOverzicht(basis());
    expect(o.rustVoor).toBeNull();
    expect(o.rustNa).toBeNull();
  });
});

describe('een dienst die al op hetzelfde moment staat', () => {
  test('is een overlap en geen kwestie van rust', () => {
    const o = overnameOverzicht(basis({
      eigenDiensten: [{ date: '2026-11-19', startTime: '13:00', endTime: '20:00' }],
    }));
    expect(o.overlap).toHaveLength(1);
    expect(o.rustVoor).toBeNull();
    expect(o.rustNa).toBeNull();
  });

  test('aansluitend is geen overlap', () => {
    const o = overnameOverzicht(basis({
      eigenDiensten: [{ date: '2026-11-19', startTime: '16:30', endTime: '22:00' }],
    }));
    expect(o.overlap).toHaveLength(0);
    expect(o.rustNa.uren).toBe(0);
  });
});

describe('het venster vervangt de drie losse vragen', () => {
  const BRON = fs.readFileSync(path.join(__dirname, '../../frontend/app-swaps.js'), 'utf8');
  const knop = BRON.slice(BRON.indexOf("document.querySelectorAll('.btn-accept-takeover')"));
  const handler = knop.slice(0, knop.indexOf('\n    });\n'));

  test('de overnemen-knop opent het overzichtsvenster', () => {
    expect(handler).toContain('openOvernameVenster(verzoek)');
  });

  test('geen berichtvraag en geen "Weet je zeker" meer na elkaar', () => {
    expect(handler).not.toContain('showInputPrompt(');
    expect(handler).not.toContain("showConfirm('Weet je zeker dat je deze dienst wilt overnemen?')");
  });

  test('de afwezigheid staat in het venster en is geen aparte vraag meer', () => {
    expect(handler).not.toContain('bevestigBijEigenAfwezigheid(');
    expect(BRON).toMatch(/function openOvernameVenster[\s\S]*getAvailability\(ik, datum\)/);
  });

  test('de rustweigering van de backend blijft doordrukbaar', () => {
    expect(handler).toContain('magRusttijdOverrulen(error)');
  });

  test('het venster staat in index.html', () => {
    const HTML = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
    for (const id of ['overname-modal', 'overname-week', 'overname-rust', 'overname-bericht', 'overname-ok']) {
      expect(HTML).toContain(`id="${id}"`);
    }
  });
});

describe('geen eigen tijdrekening', () => {
  test('de rust komt uit parseDateTime en getShiftEndDateTime van validation.js', () => {
    // Daar is de grens bij gelijke begin- en eindtijd al eens rechtgezet (#295).
    const bron = fs.readFileSync(path.join(__dirname, '../../frontend/app-swaps.js'), 'utf8');
    const f = bron.slice(bron.indexOf('function overnameOverzicht'), bron.indexOf('async function openOvernameVenster'));
    expect(f).toContain('parseDateTime(x.date, x.startTime)');
    expect(f).toContain('getShiftEndDateTime(x)');
    expect(f).not.toMatch(/setDate\(e\.getDate\(\) \+ 1\)/);
  });
});
