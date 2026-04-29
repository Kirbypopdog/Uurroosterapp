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
