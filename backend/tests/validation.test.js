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
    // endHours (8) is NOT less than startHours (8), so same day
    expect(end.getDate()).toBe(15);
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
});
