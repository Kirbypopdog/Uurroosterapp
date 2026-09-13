'use strict';

// validation.js is a browser-side file that references DataStore as a global.
// The pure time-calculation functions (parseDateTime, getShiftEndDateTime,
// getHoursBetweenShifts, shiftsOverlap) have no external dependencies and are
// exported via the `module.exports` guard added at the bottom of the file.
//
// We mock DataStore so that requiring the file doesn't fail on the console.log at the end.
global.DataStore = { shifts: [], users: [], settings: { rules: {} } };
global.getEmployee = () => null;
global.formatDate = (d) => d;

const {
  parseDateTime,
  getShiftEndDateTime,
  getHoursBetweenShifts,
  shiftsOverlap
} = require('../../frontend/validation.js');

// ===== parseDateTime =====

describe('parseDateTime', () => {
  test('parses a standard date+time pair', () => {
    const dt = parseDateTime('2026-04-15', '09:30');
    expect(dt.getFullYear()).toBe(2026);
    expect(dt.getMonth()).toBe(3); // April
    expect(dt.getDate()).toBe(15);
    expect(dt.getHours()).toBe(9);
    expect(dt.getMinutes()).toBe(30);
  });

  test('parses midnight (00:00)', () => {
    const dt = parseDateTime('2026-01-01', '00:00');
    expect(dt.getHours()).toBe(0);
    expect(dt.getMinutes()).toBe(0);
  });

  test('parses end of day (23:59)', () => {
    const dt = parseDateTime('2026-12-31', '23:59');
    expect(dt.getHours()).toBe(23);
    expect(dt.getMinutes()).toBe(59);
  });

  test('returns a Date object', () => {
    const dt = parseDateTime('2026-04-15', '08:00');
    expect(dt).toBeInstanceOf(Date);
  });
});

// ===== getShiftEndDateTime =====

describe('getShiftEndDateTime', () => {
  test('returns same day when end time > start time', () => {
    const shift = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getDate()).toBe(15);
    expect(end.getHours()).toBe(16);
  });

  test('returns next day when end time < start time (overnight shift)', () => {
    const shift = { date: '2026-04-15', startTime: '22:00', endTime: '06:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getDate()).toBe(16); // next day
    expect(end.getHours()).toBe(6);
  });

  test('handles midnight end time', () => {
    // A shift ending at 00:00 with start at 10:00 → next day midnight
    const shift = { date: '2026-04-15', startTime: '10:00', endTime: '00:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getDate()).toBe(16);
    expect(end.getHours()).toBe(0);
  });

  test('same start and end time → same day (no overnight detection)', () => {
    const shift = { date: '2026-04-15', startTime: '08:00', endTime: '08:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getDate()).toBe(15);
  });

  test('same hour but earlier minute → next day (edge case)', () => {
    // 22:30 → 22:00: eindtijd vóór starttijd, ook al is het uur gelijk
    const shift = { date: '2026-04-26', startTime: '22:30', endTime: '22:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getDate()).toBe(27); // maandag
    expect(end.getHours()).toBe(22);
    expect(end.getMinutes()).toBe(0);
  });
});

// ===== getHoursBetweenShifts =====

describe('getHoursBetweenShifts', () => {
  test('returns 0 for back-to-back shifts (no gap)', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-15', startTime: '16:00', endTime: '22:00' };
    const hours = getHoursBetweenShifts(shift1, shift2);
    expect(hours).toBe(0);
  });

  test('returns correct hours for a 11-hour gap', () => {
    const shift1 = { date: '2026-04-15', startTime: '06:00', endTime: '14:00' };
    const shift2 = { date: '2026-04-16', startTime: '01:00', endTime: '09:00' };
    // Shift 1 ends at 14:00, shift 2 starts at next-day 01:00 → gap = 11 hours
    const hours = getHoursBetweenShifts(shift1, shift2);
    expect(hours).toBeCloseTo(11, 1);
  });

  test('returns correct hours for a same-day gap', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '12:00' };
    const shift2 = { date: '2026-04-15', startTime: '14:00', endTime: '18:00' };
    // Gap between 12:00 and 14:00 = 2 hours
    const hours = getHoursBetweenShifts(shift1, shift2);
    expect(hours).toBeCloseTo(2, 1);
  });

  test('is symmetric (order of arguments does not affect result)', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-16', startTime: '08:00', endTime: '16:00' };
    expect(getHoursBetweenShifts(shift1, shift2)).toBeCloseTo(
      getHoursBetweenShifts(shift2, shift1),
      5
    );
  });

  test('returns negative hours for overlapping shifts', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-15', startTime: '12:00', endTime: '20:00' };
    const hours = getHoursBetweenShifts(shift1, shift2);
    // Overlapping by 4 hours → negative rest time
    expect(hours).toBeLessThan(0);
  });

  test('handles overnight first shift', () => {
    const night = { date: '2026-04-15', startTime: '22:00', endTime: '06:00' };
    const next = { date: '2026-04-16', startTime: '18:00', endTime: '22:00' };
    // Night shift ends at 06:00 on 16th, next starts 18:00 on 16th → 12 hour gap
    const hours = getHoursBetweenShifts(night, next);
    expect(hours).toBeCloseTo(12, 1);
  });

  test('zondag nachtdienst → maandag ochtend: minder dan 11 uur gedetecteerd', () => {
    // Zondag 22:00 → maandag 06:00, dan maandag 08:00 shift → slechts 2 uur rust
    const sunday = { date: '2026-04-26', startTime: '22:00', endTime: '06:00' };
    const monday = { date: '2026-04-27', startTime: '08:00', endTime: '16:00' };
    const hours = getHoursBetweenShifts(sunday, monday);
    expect(hours).toBeCloseTo(2, 1);
    expect(hours).toBeLessThan(11);
  });

  test('zondag nachtdienst → maandag middag: meer dan 11 uur, geen overtreding', () => {
    // Zondag 22:00 → maandag 06:00, dan maandag 18:00 shift → 12 uur rust
    const sunday = { date: '2026-04-26', startTime: '22:00', endTime: '06:00' };
    const monday = { date: '2026-04-27', startTime: '18:00', endTime: '22:00' };
    const hours = getHoursBetweenShifts(sunday, monday);
    expect(hours).toBeCloseTo(12, 1);
    expect(hours).toBeGreaterThanOrEqual(11);
  });

  test('nachtdienst met zelfde-uur-edge-case over weekgrens', () => {
    // Zondag 22:30 → maandag 22:00 (edge case: zelfde uur, vroeger minuut)
    const sunday = { date: '2026-04-26', startTime: '22:30', endTime: '22:00' };
    const monday = { date: '2026-04-27', startTime: '23:30', endTime: '07:00' };
    // sunday eindigt maandag 22:00, monday start 23:30 → 1,5 uur rust
    const hours = getHoursBetweenShifts(sunday, monday);
    expect(hours).toBeCloseTo(1.5, 1);
    expect(hours).toBeLessThan(11);
  });
});

// ===== shiftsOverlap =====

describe('shiftsOverlap', () => {
  test('returns false for non-overlapping shifts on different days', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-16', startTime: '08:00', endTime: '16:00' };
    expect(shiftsOverlap(shift1, shift2)).toBe(false);
  });

  test('returns false for adjacent (back-to-back) shifts', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-15', startTime: '16:00', endTime: '22:00' };
    expect(shiftsOverlap(shift1, shift2)).toBe(false);
  });

  test('returns true for fully overlapping shifts', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-15', startTime: '09:00', endTime: '15:00' };
    expect(shiftsOverlap(shift1, shift2)).toBe(true);
  });

  test('returns true for partially overlapping shifts', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '14:00' };
    const shift2 = { date: '2026-04-15', startTime: '12:00', endTime: '18:00' };
    expect(shiftsOverlap(shift1, shift2)).toBe(true);
  });

  test('returns true for identical shifts', () => {
    const shift1 = { date: '2026-04-15', startTime: '09:00', endTime: '17:00' };
    const shift2 = { date: '2026-04-15', startTime: '09:00', endTime: '17:00' };
    expect(shiftsOverlap(shift1, shift2)).toBe(true);
  });

  test('returns true for overnight shift overlapping next day shift', () => {
    const overnight = { date: '2026-04-15', startTime: '23:00', endTime: '05:00' };
    const nextDay = { date: '2026-04-16', startTime: '04:00', endTime: '12:00' };
    expect(shiftsOverlap(overnight, nextDay)).toBe(true);
  });

  test('returns false for overnight shift not reaching next day shift', () => {
    const overnight = { date: '2026-04-15', startTime: '23:00', endTime: '03:00' };
    const nextDay = { date: '2026-04-16', startTime: '10:00', endTime: '18:00' };
    expect(shiftsOverlap(overnight, nextDay)).toBe(false);
  });

  test('is symmetric', () => {
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '14:00' };
    const shift2 = { date: '2026-04-15', startTime: '12:00', endTime: '18:00' };
    expect(shiftsOverlap(shift1, shift2)).toBe(shiftsOverlap(shift2, shift1));
  });

  test('returns false for two overnight shifts on consecutive nights (no overlap)', () => {
    // Night 1: 22:00 → 06:00 (day 16), Night 2: 22:00 → 06:00 (day 17)
    const night1 = { date: '2026-04-15', startTime: '22:00', endTime: '06:00' };
    const night2 = { date: '2026-04-16', startTime: '22:00', endTime: '06:00' };
    expect(shiftsOverlap(night1, night2)).toBe(false);
  });

  test('returns true when overnight shift fully contains a short day shift', () => {
    // 22:00 → 08:00 next day contains 02:00 → 05:00 on next day
    const long = { date: '2026-04-15', startTime: '22:00', endTime: '08:00' };
    const short = { date: '2026-04-16', startTime: '02:00', endTime: '05:00' };
    expect(shiftsOverlap(long, short)).toBe(true);
  });

  test('adjacent overnight shifts do not overlap (end equals start of next)', () => {
    // Shift 1 ends 06:00, shift 2 starts 06:00
    const night = { date: '2026-04-15', startTime: '22:00', endTime: '06:00' };
    const morning = { date: '2026-04-16', startTime: '06:00', endTime: '14:00' };
    expect(shiftsOverlap(night, morning)).toBe(false);
  });
});

// ===== getHoursBetweenShifts — extra grensgevallen =====

describe('getHoursBetweenShifts — extra grensgevallen', () => {
  test('exact 11-hour gap (boundary) is not a violation', () => {
    // Shift ends 07:00, next starts 18:00 on same day → 11 hours
    const shift1 = { date: '2026-04-15', startTime: '23:00', endTime: '07:00' };
    const shift2 = { date: '2026-04-16', startTime: '18:00', endTime: '22:00' };
    const hours = getHoursBetweenShifts(shift1, shift2);
    expect(hours).toBeCloseTo(11, 1);
  });

  test('one-minute less than 11 hours is a violation', () => {
    // Shift ends 07:00, next starts 17:59 → 10h 59min gap
    const shift1 = { date: '2026-04-15', startTime: '23:00', endTime: '07:00' };
    const shift2 = { date: '2026-04-16', startTime: '17:59', endTime: '22:00' };
    const hours = getHoursBetweenShifts(shift1, shift2);
    expect(hours).toBeLessThan(11);
  });

  test('multi-day gap returns correct large number', () => {
    // Monday ends 16:00 → Thursday starts 08:00 = 64 hours gap
    const monday = { date: '2026-04-13', startTime: '08:00', endTime: '16:00' };
    const thursday = { date: '2026-04-16', startTime: '08:00', endTime: '16:00' };
    const hours = getHoursBetweenShifts(monday, thursday);
    expect(hours).toBeCloseTo(64, 0);
    expect(hours).toBeGreaterThan(11);
  });

  test('back-to-back overnight shifts (negative overlap)', () => {
    // Two shifts assigned same employee at same time → negative rest
    const shift1 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const shift2 = { date: '2026-04-15', startTime: '08:00', endTime: '16:00' };
    const hours = getHoursBetweenShifts(shift1, shift2);
    expect(hours).toBeLessThanOrEqual(0);
  });
});

// ===== getShiftEndDateTime — extra grensgevallen =====

describe('getShiftEndDateTime — extra grensgevallen', () => {
  test('shift ending exactly at midnight (00:00) advances to next day', () => {
    const shift = { date: '2026-04-15', startTime: '16:00', endTime: '00:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getDate()).toBe(16);
    expect(end.getHours()).toBe(0);
    expect(end.getMinutes()).toBe(0);
  });

  test('standard day shift: end date is same day', () => {
    const shift = { date: '2026-04-30', startTime: '09:00', endTime: '17:30' };
    const end = getShiftEndDateTime(shift);
    expect(end.getMonth()).toBe(3); // April (0-indexed)
    expect(end.getDate()).toBe(30);
    expect(end.getHours()).toBe(17);
    expect(end.getMinutes()).toBe(30);
  });

  test('overnight shift crossing month boundary', () => {
    const shift = { date: '2026-04-30', startTime: '22:00', endTime: '06:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getMonth()).toBe(4); // May (0-indexed)
    expect(end.getDate()).toBe(1);
    expect(end.getHours()).toBe(6);
  });

  test('overnight shift crossing year boundary', () => {
    const shift = { date: '2026-12-31', startTime: '23:00', endTime: '07:00' };
    const end = getShiftEndDateTime(shift);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(0); // January
    expect(end.getDate()).toBe(1);
  });
});

// ===== VERLOFPLANNING: gesloten dagen uit het roosterconcept =====
//
// app-leave.js is browsercode, maar de weekindeling en de afleiding van
// gesloten dagen zijn pure functies. Ze leunen op drie datumhelpers uit
// data.js; die zetten we hier als globals klaar, net zoals hierboven met
// DataStore gebeurt.
global.parseDateOnly = (value) => {
  const [y, m, d] = String(value).split('-').map(Number);
  return new Date(y, m - 1, d);
};
global.getMondayOfWeek = (date) => {
  const x = new Date(date);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
};
global.formatDateYYYYMMDD = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const {
  closedDatesFromPattern,
  leaveWeeksOfBlock,
  leaveClosedInfo,
  leaveOpenDaysOfBlock,
  leaveBlockProgress,
  leaveVerdeelVoorstel,
  leaveWeekWens,
  leaveBlockDates,
  leaveBlockGewijzigd,
  leaveBlockHerstel,
  leaveConceptVoorBlok,
  leaveBlokIsVerdeeld
} = require('../../frontend/app-leave.js');

// Kerstvakantie 21 dec 2026 t/m 3 jan 2027 = twee volle maandagweken.
const KERST = { startDate: '2026-12-21', endDate: '2027-01-03' };
const PATROON = { cycleLength: 2, weeks: { '1': { closedDays: [6, 0] }, '2': { closedDays: [] } } };

describe('closedDatesFromPattern', () => {
  test('sluit het weekend van week 1 en laat week 2 open', () => {
    const dicht = closedDatesFromPattern(KERST.startDate, KERST.startDate, KERST.endDate, PATROON);
    expect(dicht).toEqual(['2026-12-26', '2026-12-27']);
  });

  test('geeft niets terug zonder patroon', () => {
    expect(closedDatesFromPattern(KERST.startDate, KERST.startDate, KERST.endDate, null)).toEqual([]);
  });

  // Weken voorbij de cyclus hebben geen entry: dan claimen we niets, in
  // plaats van het patroon te laten herhalen.
  test('claimt niets voor weken voorbij de cyclus', () => {
    const kort = { cycleLength: 1, weeks: { '1': { closedDays: [6, 0] } } };
    const dicht = closedDatesFromPattern(KERST.startDate, KERST.startDate, KERST.endDate, kort);
    expect(dicht).toEqual(['2026-12-26', '2026-12-27']);
  });

  test('neemt alleen dagen binnen het blok mee als het blok midden in een week start', () => {
    // Blok start op woensdag 23 dec; de zaterdag erna valt nog in week 1.
    const dicht = closedDatesFromPattern('2026-12-21', '2026-12-23', '2027-01-03', PATROON);
    expect(dicht).toEqual(['2026-12-26', '2026-12-27']);
  });
});

describe('leaveWeeksOfBlock met gesloten dagen', () => {
  const blok = { ...KERST, closedDates: ['2026-12-26', '2026-12-27'] };

  test('splitst open en gesloten dagen per week', () => {
    const weken = leaveWeeksOfBlock(blok);
    expect(weken).toHaveLength(2);
    expect(weken[0].openDays).toHaveLength(5);
    expect(weken[0].closedDays).toEqual(['2026-12-26', '2026-12-27']);
    expect(weken[1].openDays).toHaveLength(7);
  });

  test('benoemt het weekend per week', () => {
    const weken = leaveWeeksOfBlock(blok);
    expect(leaveClosedInfo(weken[0])).toMatchObject({ open: false, label: 'weekend gesloten' });
    expect(leaveClosedInfo(weken[1])).toMatchObject({ open: true, label: 'weekend open' });
  });

  // Een concept kan ook een doordeweekse dag sluiten — 25 december, 11 juli.
  // Dan moet de rij die dag benoemen in plaats van "weekend open".
  test('benoemt een gesloten doordeweekse dag', () => {
    const kerstdag = { ...KERST, closedDates: ['2026-12-25'] };
    const weken = leaveWeeksOfBlock(kerstdag);
    expect(weken[0].openDays).toHaveLength(6);
    expect(leaveClosedInfo(weken[0])).toMatchObject({ open: true, label: 'vr gesloten' });
  });

  test('somt weekdag en weekend samen op', () => {
    const nieuwjaar = { ...KERST, closedDates: ['2027-01-01', '2027-01-02', '2027-01-03'] };
    const weken = leaveWeeksOfBlock(nieuwjaar);
    expect(leaveClosedInfo(weken[1])).toMatchObject({ open: false, label: 'vr, za, zo gesloten' });
  });

  // Zonder gekoppeld concept weten we niets: dan tonen we ook niets.
  test('zegt niets over het weekend zonder closedDates', () => {
    const weken = leaveWeeksOfBlock(KERST);
    expect(weken[0].openDays).toHaveLength(7);
    expect(leaveClosedInfo(weken[0])).toBeNull();
  });
});

describe('leaveBlockProgress', () => {
  const blok = { ...KERST, closedDates: ['2026-12-26', '2026-12-27'] };

  // Zonder deze regel blijft de indienknop permanent uitgeschakeld zodra
  // er ergens een weekend dicht staat.
  test('is klaar wanneer enkel de open dagen ingevuld zijn', () => {
    const map = {};
    leaveOpenDaysOfBlock(blok).forEach(d => { map[d] = 'werken'; });
    expect(leaveBlockProgress(blok, map)).toEqual({ totaal: 12, ingevuld: 12, klaar: true });
  });

  test('telt gesloten dagen niet mee als ontbrekend', () => {
    expect(leaveBlockProgress(blok, {}).totaal).toBe(12);
  });

  test('een volledig gesloten blok is meteen klaar', () => {
    const dicht = { startDate: '2026-12-26', endDate: '2026-12-27', closedDates: ['2026-12-26', '2026-12-27'] };
    expect(leaveBlockProgress(dicht, {}).klaar).toBe(true);
  });
});

// ===== VERDELING VAN EEN ZOMERBLOK =====
//
// In een voorkeurblok kiezen mensen werken/liever niet/zeker niet, maar `apply`
// neemt alleen 'verlof' over. De beheerder legt daarom de definitieve verdeling
// vast; deze functie zet het voorstel klaar.
describe('leaveVerdeelVoorstel', () => {
  // 5 juli t/m 18 juli 2027 = twee volle weken; het eerste weekend is dicht.
  const ZOMER = { startDate: '2027-07-05', endDate: '2027-07-18', closedDates: ['2027-07-10', '2027-07-11'] };
  const MENSEN = [{ id: 2 }, { id: 3 }, { id: 4 }];

  test('zeker niet en liever niet worden allebei verlof', () => {
    const v = leaveVerdeelVoorstel(ZOMER, MENSEN, {
      2: { '2027-07-05': 'zeker_niet' },
      3: { '2027-07-12': 'liever_niet' },
      4: {}
    });
    expect(v[2]['2027-07-05']).toBe('verlof');
    expect(v[3]['2027-07-12']).toBe('verlof');
  });

  test('alleen werken blijft werken', () => {
    const v = leaveVerdeelVoorstel(ZOMER, MENSEN, { 2: { '2027-07-05': 'werken', '2027-07-06': 'werken' } });
    expect(v[2]['2027-07-05']).toBe('werken');
  });

  // Nooit ongevraagd verlof toekennen aan wie niets indiende.
  test('wie niets invulde krijgt werken', () => {
    const v = leaveVerdeelVoorstel(ZOMER, MENSEN, {});
    expect(v[4]['2027-07-05']).toBe('werken');
    expect(v[4]['2027-07-12']).toBe('werken');
  });

  // Na het vastleggen staan er verlof/werken in plaats van voorkeuren. Zonder
  // deze regel zou heropenen de verdeling terugzetten naar 'iedereen werkt'.
  test('een al vastgelegde verdeling blijft staan', () => {
    const v = leaveVerdeelVoorstel(ZOMER, MENSEN, {
      2: { '2027-07-05': 'verlof', '2027-07-06': 'verlof', '2027-07-12': 'werken' }
    });
    expect(v[2]['2027-07-05']).toBe('verlof');
    expect(v[2]['2027-07-12']).toBe('werken');
  });

  test('een volledig gesloten week komt niet in het voorstel', () => {
    const dicht = {
      startDate: '2027-07-05', endDate: '2027-07-18',
      closedDates: ['2027-07-05','2027-07-06','2027-07-07','2027-07-08','2027-07-09','2027-07-10','2027-07-11']
    };
    const v = leaveVerdeelVoorstel(dicht, MENSEN, {});
    expect(Object.keys(v[2])).toEqual(['2027-07-12']);
  });

  // Het voorstel corrigeert niets: als iedereen weg wil, toont het scherm dat
  // en beslist de mens. Zo blijft het voorspelbaar.
  test('als iedereen vrij wil, werkt niemand in het voorstel', () => {
    const v = leaveVerdeelVoorstel(ZOMER, MENSEN, {
      2: { '2027-07-05': 'zeker_niet' }, 3: { '2027-07-05': 'zeker_niet' }, 4: { '2027-07-05': 'liever_niet' }
    });
    expect(MENSEN.every(m => v[m.id]['2027-07-05'] === 'verlof')).toBe(true);
  });
});

describe('leaveWeekWens', () => {
  const week = { days: ['2027-07-05','2027-07-06'], openDays: ['2027-07-05','2027-07-06'], closedDays: [], closedBekend: true };

  test('de zwaarste wens weegt door', () => {
    expect(leaveWeekWens(week, { '2027-07-05': 'werken', '2027-07-06': 'zeker_niet' })).toBe('zeker_niet');
  });

  test('geeft niets terug als er niets ingevuld is', () => {
    expect(leaveWeekWens(week, {})).toBeNull();
  });
});


// ===== VERLOFPLANNING: de draft per blok (#252) =====
//
// De draft wordt over alle vakantieblokken heen opgebouwd en in één keer
// verstuurd. Wie een blok invulde en terugklikte zonder te bewaren, liet zijn
// keuzes gewoon in de draft staan. De kaart toonde daarna "nog niet ingevuld",
// dus het leek vervallen, maar bij het bewaren van een ándere vakantie gingen
// ze alsnog mee naar de server en werden ze echt verlof in de planning.
describe('leaveBlockDates', () => {
  const KROKUS = { startDate: '2027-02-22', endDate: '2027-02-28' };

  test('geeft elke dag van het blok, ook de gesloten', () => {
    const dagen = leaveBlockDates(KROKUS);
    expect(dagen).toHaveLength(7);
    expect(dagen[0]).toBe('2027-02-22');
    expect(dagen[6]).toBe('2027-02-28');
  });

  test('blijft binnen het blok, ook als het middenin een week start', () => {
    // Woensdag tot en met vrijdag: de weekindeling begint op maandag, maar
    // dagen buiten het blok horen er niet bij.
    const dagen = leaveBlockDates({ startDate: '2027-02-24', endDate: '2027-02-26' });
    expect(dagen).toEqual(['2027-02-24', '2027-02-25', '2027-02-26']);
  });
});

describe('leaveBlockGewijzigd', () => {
  const BLOK = { startDate: '2027-02-22', endDate: '2027-02-28' };

  afterEach(() => { global.AppState = undefined; });

  test('ziet een nieuwe keuze die nog niet op de server staat', () => {
    global.AppState = { leaveDraft: { '2027-02-22': 'verlof' } };
    expect(leaveBlockGewijzigd(BLOK, {})).toBe(true);
  });

  test('ziet een gewijzigde keuze', () => {
    global.AppState = { leaveDraft: { '2027-02-22': 'verlof' } };
    expect(leaveBlockGewijzigd(BLOK, { '2027-02-22': 'werken' })).toBe(true);
  });

  test('meldt niets wanneer draft en server gelijk zijn', () => {
    global.AppState = { leaveDraft: { '2027-02-22': 'verlof' } };
    expect(leaveBlockGewijzigd(BLOK, { '2027-02-22': 'verlof' })).toBe(false);
  });

  test('kijkt alleen naar dit blok, niet naar een andere vakantie', () => {
    // De kerstkeuze zit in dezelfde draft maar hoort bij een ander blok
    global.AppState = { leaveDraft: { '2026-12-24': 'verlof' } };
    expect(leaveBlockGewijzigd(BLOK, {})).toBe(false);
  });
});

describe('leaveBlockHerstel', () => {
  const BLOK = { startDate: '2027-02-22', endDate: '2027-02-28' };

  afterEach(() => { global.AppState = undefined; });

  test('wist een keuze die nergens op de server staat', () => {
    global.AppState = { leaveDraft: { '2027-02-22': 'verlof', '2027-02-23': 'verlof' } };
    leaveBlockHerstel(BLOK, {});
    expect(global.AppState.leaveDraft).toEqual({});
  });

  test('zet een gewijzigde dag terug op de serverwaarde', () => {
    global.AppState = { leaveDraft: { '2027-02-22': 'verlof' } };
    leaveBlockHerstel(BLOK, { '2027-02-22': 'werken' });
    expect(global.AppState.leaveDraft).toEqual({ '2027-02-22': 'werken' });
  });

  test('laat de andere vakanties in de draft ongemoeid', () => {
    global.AppState = { leaveDraft: { '2026-12-24': 'verlof', '2027-02-22': 'verlof' } };
    leaveBlockHerstel(BLOK, {});
    expect(global.AppState.leaveDraft).toEqual({ '2026-12-24': 'verlof' });
  });
});

// ===== SCHOOLVAKANTIES: snelle selectie (#352) =====
//
// De vijf knoppen in "Vakantieperiode toevoegen" stonden hard in de code met
// vaste datums. Herfst en Kerst waren bijgewerkt naar 2026-2027, Krokus, Pasen
// en Zomer niet, en de kop beloofde "schooljaar 2025-2026". Zomer gaf 1 juli
// tot 31 augustus 2026, dus het verleden, terwijl de vakantieperiodes de basis
// zijn van elke verlofronde.
//
// app-settings.js is browsercode met een IIFE onderaan die aan document hangt.
// Drie stubs volstaan om het in Node te laden; de berekening zelf is puur.
global.document = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { insertAdjacentHTML() {} },
};
global.window = { addEventListener() {} };

const { belgischeSchoolvakanties } = require('../../frontend/app-settings.js');

describe('belgischeSchoolvakanties', () => {
  // Pasen 2026 viel op 5 april. Dit schooljaar loopt van september 2025 tot
  // augustus 2026, en de datums hieronder zijn precies die welke eerder hard
  // in de code stonden en klopten.
  const SJ2025 = belgischeSchoolvakanties(2025, '2026-04-05');
  const vind = (lijst, deel) => lijst.find(v => v.naam.startsWith(deel));

  test('krokus valt zeven weken vóór Pasen', () => {
    expect(vind(SJ2025, 'Krokus')).toMatchObject({ start: '2026-02-16', eind: '2026-02-22' });
  });

  test('pasen loopt twee weken vanaf de maandag na Paaszondag', () => {
    expect(vind(SJ2025, 'Paas')).toMatchObject({ start: '2026-04-06', eind: '2026-04-19' });
  });

  test('zomer loopt van 1 juli tot en met 31 augustus van het eindjaar', () => {
    expect(vind(SJ2025, 'Zomer')).toMatchObject({ start: '2026-07-01', eind: '2026-08-31' });
  });

  // Pasen 2027 viel op 28 maart. Dit schooljaar levert de herfst- en
  // kerstdatums die eerder hard in de code stonden.
  const SJ2026 = belgischeSchoolvakanties(2026, '2027-03-28');

  test('herfst schuift een week op als 1 november in het weekend valt', () => {
    // 1 november 2026 was een zondag, dus de vakantie begint op 2 november
    expect(vind(SJ2026, 'Herfst')).toMatchObject({ start: '2026-11-02', eind: '2026-11-08' });
  });

  test('kerst begint op de maandag van de week met Kerstmis en duurt twee weken', () => {
    // 25 december 2026 was een vrijdag, dus de maandag ervoor
    expect(vind(SJ2026, 'Kerst')).toMatchObject({ start: '2026-12-21', eind: '2027-01-03' });
  });

  test('elke vakantie begint op een maandag', () => {
    for (const v of [...SJ2025, ...SJ2026]) {
      if (v.naam.startsWith('Zomer')) continue;   // zomer is datumgebonden
      const dag = new Date(...v.start.split('-').map((n, i) => i === 1 ? Number(n) - 1 : Number(n))).getDay();
      expect(dag).toBe(1);
    }
  });

  test('de naam draagt het jaar van de startdatum', () => {
    expect(vind(SJ2026, 'Herfst').naam).toBe('Herfstvakantie 2026');
    expect(vind(SJ2026, 'Kerst').naam).toBe('Kerstvakantie 2026');
    expect(vind(SJ2026, 'Krokus').naam).toBe('Krokusvakantie 2027');
    expect(vind(SJ2026, 'Zomer').naam).toBe('Zomervakantie 2027');
  });

  test('geeft vijf periodes terug', () => {
    expect(SJ2025).toHaveLength(5);
  });
});


// ===== VERLOFPLANNING: welk concept levert de gesloten dagen (#308) =====
//
// De resync nam het concept dat het recentst was toegepast of bijgewerkt. Bij
// het openen van de ronde koos de beheerder echter expliciet welk concept de
// gesloten dagen levert, en die keuze staat in closed_source.draftId. Dat veld
// werd niet gelezen, dus invulling van medewerkers kon verdwijnen op basis van
// een concept dat niet aan deze ronde hangt.
describe('leaveConceptVoorBlok', () => {
  // leaveDraftsForPeriod sorteert op lastAppliedAt, dan updatedAt, nieuwste
  // eerst. "Nieuw" staat dus vooraan, ook al hangt de ronde aan "Oud".
  const OUD    = { id: 11, type: 'vakantie', holidayPeriodId: 'kerst', name: 'Oud',   updatedAt: '2026-01-01T00:00:00Z' };
  const NIEUW  = { id: 22, type: 'vakantie', holidayPeriodId: 'kerst', name: 'Nieuw', updatedAt: '2026-06-01T00:00:00Z' };

  const zetConcepten = (lijst) => {
    global.DataStore = { shifts: [], users: [], settings: { rules: {}, schedule_drafts: lijst } };
  };

  afterEach(() => {
    global.DataStore = { shifts: [], users: [], settings: { rules: {} } };
  });

  test('neemt het concept dat aan de ronde hangt, niet het nieuwste', () => {
    zetConcepten([OUD, NIEUW]);
    const blok = { holidayPeriodId: 'kerst', closedSource: { draftId: '11' } };
    expect(leaveConceptVoorBlok(blok)).toMatchObject({ herkomst: 'ronde' });
    expect(leaveConceptVoorBlok(blok).concept.name).toBe('Oud');
  });

  test('valt terug op het nieuwste als het concept van de ronde weg is', () => {
    zetConcepten([NIEUW]);
    const blok = { holidayPeriodId: 'kerst', closedSource: { draftId: '11' } };
    const uit = leaveConceptVoorBlok(blok);
    expect(uit.herkomst).toBe('vervangen');
    expect(uit.concept.name).toBe('Nieuw');
  });

  test('neemt het nieuwste als er nooit een keuze bewaard is', () => {
    zetConcepten([OUD, NIEUW]);
    const blok = { holidayPeriodId: 'kerst', closedSource: {} };
    const uit = leaveConceptVoorBlok(blok);
    expect(uit.herkomst).toBe('nieuwste');
    expect(uit.concept.name).toBe('Nieuw');
  });

  test('meldt geen concept wanneer er niets aan de periode hangt', () => {
    zetConcepten([]);
    const blok = { holidayPeriodId: 'zomer', closedSource: { draftId: '11' } };
    expect(leaveConceptVoorBlok(blok)).toEqual({ concept: null, herkomst: 'geen' });
  });

  test('vergelijkt het id als tekst, niet als getal', () => {
    // De backend geeft draftId als string terug, de concepten hebben een getal
    zetConcepten([OUD, NIEUW]);
    const blok = { holidayPeriodId: 'kerst', closedSource: { draftId: 22 } };
    expect(leaveConceptVoorBlok(blok).concept.name).toBe('Nieuw');
    expect(leaveConceptVoorBlok(blok).herkomst).toBe('ronde');
  });
});


// ===== VERLOFPLANNING: is een voorkeurblok al verdeeld (#307) =====
//
// Het vastleggen vervangt elke entry in het blok door verlof of werken, dus
// liever_niet en zeker_niet zijn daarna weg. Het verdeelscherm bleef beweren
// dat de letter toont wat die persoon vroeg, terwijl het voortaan de eigen
// beslissing van de beheerder toont.
//
// Het invulscherm van een voorkeurblok biedt alleen werken, liever niet en
// zeker niet aan. Een entry met status 'verlof' kan er dus alleen staan door
// het vastleggen. Dat is het kenmerk waarop we gaan.
describe('leaveBlokIsVerdeeld', () => {
  const ZOMER = { mode: 'voorkeur', startDate: '2027-07-05', endDate: '2027-07-18' };
  const KERST = { mode: 'binair',   startDate: '2027-07-05', endDate: '2027-07-18' };

  test('nog niet verdeeld zolang er voorkeuren staan', () => {
    const entries = { 7: { '2027-07-05': 'liever_niet', '2027-07-06': 'zeker_niet' } };
    expect(leaveBlokIsVerdeeld(ZOMER, entries)).toBe(false);
  });

  test('nog niet verdeeld bij een leeg blok', () => {
    expect(leaveBlokIsVerdeeld(ZOMER, {})).toBe(false);
  });

  test('nog niet verdeeld wanneer iedereen werken invulde', () => {
    const entries = { 7: { '2027-07-05': 'werken', '2027-07-06': 'werken' } };
    expect(leaveBlokIsVerdeeld(ZOMER, entries)).toBe(false);
  });

  test('wel verdeeld zodra er verlof in staat', () => {
    const entries = { 7: { '2027-07-05': 'verlof', '2027-07-06': 'werken' } };
    expect(leaveBlokIsVerdeeld(ZOMER, entries)).toBe(true);
  });

  test('kijkt alleen naar dagen binnen dit blok', () => {
    // Verlof in de kerstvakantie zegt niets over de zomer
    const entries = { 7: { '2027-12-24': 'verlof' } };
    expect(leaveBlokIsVerdeeld(ZOMER, entries)).toBe(false);
  });

  test('geldt niet voor een binair blok, daar is verlof gewoon invulling', () => {
    const entries = { 7: { '2027-07-05': 'verlof' } };
    expect(leaveBlokIsVerdeeld(KERST, entries)).toBe(false);
  });
});
