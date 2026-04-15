'use strict';

const { getMonday, formatDateYYYYMMDD, parseLocalDate } = require('../src/utils');

// ===== getMonday =====

describe('getMonday', () => {
  test('returns Monday for a Wednesday', () => {
    const wed = new Date(2026, 3, 15); // Wednesday 15 April 2026
    const mon = getMonday(wed);
    expect(mon.getDay()).toBe(1);
    expect(mon.getFullYear()).toBe(2026);
    expect(mon.getMonth()).toBe(3);
    expect(mon.getDate()).toBe(13);
  });

  test('returns Monday for a Monday (no-op)', () => {
    const mon = new Date(2026, 3, 13); // Monday 13 April 2026
    const result = getMonday(mon);
    expect(result.getDate()).toBe(13);
    expect(result.getDay()).toBe(1);
  });

  test('returns previous Monday for a Sunday', () => {
    const sun = new Date(2026, 3, 19); // Sunday 19 April 2026
    const result = getMonday(sun);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(13);
  });

  test('returns previous Monday for a Saturday', () => {
    const sat = new Date(2026, 3, 18); // Saturday 18 April 2026
    const result = getMonday(sat);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(13);
  });

  test('handles end-of-month correctly (month boundary)', () => {
    // Sunday 31 January 2021 → Monday should be 25 January 2021
    const sun = new Date(2021, 0, 31);
    const result = getMonday(sun);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(25);
    expect(result.getMonth()).toBe(0);
  });

  test('handles year boundary (Monday 28 Dec → back to same week)', () => {
    // Wednesday 30 December 2020 → Monday 28 December 2020
    const wed = new Date(2020, 11, 30);
    const result = getMonday(wed);
    expect(result.getDay()).toBe(1);
    expect(result.getDate()).toBe(28);
    expect(result.getMonth()).toBe(11);
    expect(result.getFullYear()).toBe(2020);
  });

  test('does not mutate the original date', () => {
    const original = new Date(2026, 3, 15);
    const originalTime = original.getTime();
    getMonday(original);
    expect(original.getTime()).toBe(originalTime);
  });
});

// ===== formatDateYYYYMMDD =====

describe('formatDateYYYYMMDD', () => {
  test('formats a standard date', () => {
    const d = new Date(2026, 3, 15); // 15 April 2026
    expect(formatDateYYYYMMDD(d)).toBe('2026-04-15');
  });

  test('pads month with zero when single digit', () => {
    const d = new Date(2026, 0, 5); // 5 January 2026
    expect(formatDateYYYYMMDD(d)).toBe('2026-01-05');
  });

  test('pads day with zero when single digit', () => {
    const d = new Date(2026, 11, 3); // 3 December 2026
    expect(formatDateYYYYMMDD(d)).toBe('2026-12-03');
  });

  test('returns correct format for December 31', () => {
    const d = new Date(2026, 11, 31);
    expect(formatDateYYYYMMDD(d)).toBe('2026-12-31');
  });

  test('returns correct format for January 1', () => {
    const d = new Date(2000, 0, 1);
    expect(formatDateYYYYMMDD(d)).toBe('2000-01-01');
  });

  test('output is always 10 characters (YYYY-MM-DD)', () => {
    const d = new Date(2026, 5, 9); // 9 June 2026
    const result = formatDateYYYYMMDD(d);
    expect(result).toHaveLength(10);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ===== parseLocalDate =====

describe('parseLocalDate', () => {
  test('parses a YYYY-MM-DD string without timezone shift', () => {
    const d = parseLocalDate('2026-04-15');
    expect(d).not.toBeNull();
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3); // April is month 3 (0-indexed)
    expect(d.getDate()).toBe(15);
  });

  test('strips ISO timestamp and returns local date', () => {
    // "2026-03-01T23:00:00.000Z" → should give 2026-03-01 locally
    const d = parseLocalDate('2026-03-01T23:00:00.000Z');
    expect(d).not.toBeNull();
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2); // March
    expect(d.getDate()).toBe(1);
  });

  test('returns the Date object as-is when given a valid Date', () => {
    const input = new Date(2026, 3, 15);
    const result = parseLocalDate(input);
    expect(result).toBe(input); // same reference
  });

  test('returns null for completely invalid string', () => {
    expect(parseLocalDate('not-a-date')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseLocalDate('')).toBeNull();
  });

  test('returns null for an invalid Date object', () => {
    expect(parseLocalDate(new Date('invalid'))).toBeNull();
  });

  test('parses the first day of the year correctly', () => {
    const d = parseLocalDate('2026-01-01');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });

  test('parses the last day of the year correctly', () => {
    const d = parseLocalDate('2026-12-31');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(31);
  });
});
