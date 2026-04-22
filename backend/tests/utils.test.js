'use strict';

const { getMonday, formatDateYYYYMMDD, parseLocalDate, getEasterDate, getBelgianPublicHolidays } = require('../src/utils');

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

// ===== getEasterDate =====

describe('getEasterDate', () => {
  test('returns a Date object', () => {
    expect(getEasterDate(2026)).toBeInstanceOf(Date);
  });

  test('2024: 31 maart', () => {
    const d = getEasterDate(2024);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(2); // maart = index 2
    expect(d.getDate()).toBe(31);
  });

  test('2025: 20 april', () => {
    const d = getEasterDate(2025);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(3); // april = index 3
    expect(d.getDate()).toBe(20);
  });

  test('2026: 5 april', () => {
    const d = getEasterDate(2026);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(5);
  });

  test('2000: 23 april (Y2K regressie)', () => {
    const d = getEasterDate(2000);
    expect(d.getFullYear()).toBe(2000);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(23);
  });

  test('2030: 21 april', () => {
    const d = getEasterDate(2030);
    expect(d.getFullYear()).toBe(2030);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(21);
  });
});

// ===== getBelgianPublicHolidays =====

describe('getBelgianPublicHolidays', () => {
  test('retourneert precies 10 feestdagen', () => {
    expect(getBelgianPublicHolidays(2026)).toHaveLength(10);
    expect(getBelgianPublicHolidays(2025)).toHaveLength(10);
  });

  test('elk object heeft date (YYYY-MM-DD) en name velden', () => {
    const holidays = getBelgianPublicHolidays(2026);
    for (const h of holidays) {
      expect(h).toHaveProperty('date');
      expect(h).toHaveProperty('name');
      expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof h.name).toBe('string');
    }
  });

  test('2026 vaste feestdagen correct', () => {
    const holidays = getBelgianPublicHolidays(2026);
    const byDate = Object.fromEntries(holidays.map(h => [h.date, h.name]));
    expect(byDate['2026-01-01']).toBe('Nieuwjaar');
    expect(byDate['2026-05-01']).toBe('Dag van de Arbeid');
    expect(byDate['2026-07-21']).toBe('Nationale Feestdag');
    expect(byDate['2026-08-15']).toBe('O.L.V. Hemelvaart');
    expect(byDate['2026-11-01']).toBe('Allerheiligen');
    expect(byDate['2026-11-11']).toBe('Wapenstilstand');
    expect(byDate['2026-12-25']).toBe('Kerstmis');
  });

  test('2026 Pasen-relatieve feestdagen correct (Pasen = 5 april)', () => {
    const holidays = getBelgianPublicHolidays(2026);
    const byDate = Object.fromEntries(holidays.map(h => [h.date, h.name]));
    expect(byDate['2026-04-06']).toBe('Paasmaandag');    // Pasen+1
    expect(byDate['2026-05-14']).toBe('Hemelvaartsdag'); // Pasen+39
    expect(byDate['2026-05-25']).toBe('Pinkstermaandag'); // Pasen+50
  });

  test('geen dubbele datums', () => {
    const holidays = getBelgianPublicHolidays(2026);
    const dates = holidays.map(h => h.date);
    const unique = new Set(dates);
    expect(unique.size).toBe(dates.length);
  });

  test('2025 Pasen-relatieve feestdagen correct (Pasen = 20 april)', () => {
    const holidays = getBelgianPublicHolidays(2025);
    const byDate = Object.fromEntries(holidays.map(h => [h.date, h.name]));
    expect(byDate['2025-04-21']).toBe('Paasmaandag');
    expect(byDate['2025-05-29']).toBe('Hemelvaartsdag');
    expect(byDate['2025-06-09']).toBe('Pinkstermaandag');
  });
});
