'use strict';

// email.js requires a pool connection — mock it before requiring the module
jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] })
  }
}));

const { _helpers } = require('../src/email');
const { escapeHtml, formatDate, formatTime, shiftDetailBox, baseTemplate } = _helpers;

// ===== escapeHtml =====

describe('escapeHtml', () => {
  test('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  test('escapes less-than', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  test('escapes greater-than', () => {
    expect(escapeHtml('1 > 0')).toBe('1 &gt; 0');
  });

  test('escapes double quotes', () => {
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
  });

  test('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  test('escapes all special characters together', () => {
    expect(escapeHtml('<b class="x">a & b</b>')).toBe(
      '&lt;b class=&quot;x&quot;&gt;a &amp; b&lt;/b&gt;'
    );
  });

  test('returns empty string for null', () => {
    expect(escapeHtml(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(escapeHtml(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('coerces numbers to string and escapes', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  test('leaves safe strings unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

// ===== formatDate =====

describe('formatDate', () => {
  test('formats a YYYY-MM-DD string to Dutch locale date', () => {
    const result = formatDate('2026-04-15');
    // Should contain the year 2026
    expect(result).toContain('2026');
    // Should contain day 15
    expect(result).toContain('15');
  });

  test('handles ISO timestamp — strips time component', () => {
    const result = formatDate('2026-03-01T23:00:00.000Z');
    expect(result).toContain('2026');
    expect(result).toContain('1');
  });

  test('formats a Date object', () => {
    const result = formatDate(new Date('2026-06-15T00:00:00'));
    expect(result).toContain('2026');
    expect(result).toContain('15');
  });

  test('returns a non-empty string', () => {
    expect(formatDate('2026-01-01')).toBeTruthy();
  });
});

// ===== formatTime =====

describe('formatTime', () => {
  test('truncates HH:MM:SS to HH:MM', () => {
    expect(formatTime('09:30:00')).toBe('09:30');
  });

  test('leaves HH:MM unchanged', () => {
    expect(formatTime('14:00')).toBe('14:00');
  });

  test('returns empty string for falsy values', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatTime('')).toBe('');
  });

  test('returns first 5 characters for non-standard input', () => {
    expect(formatTime('00:00:00.000')).toBe('00:00');
  });
});

// ===== shiftDetailBox =====

describe('shiftDetailBox', () => {
  const shift = {
    date: '2026-04-15',
    start_time: '09:00:00',
    end_time: '17:00:00',
    team: 'Vlot 1'
  };

  test('returns a string containing start time', () => {
    const html = shiftDetailBox(shift);
    expect(html).toContain('09:00');
  });

  test('returns a string containing end time', () => {
    const html = shiftDetailBox(shift);
    expect(html).toContain('17:00');
  });

  test('contains the team name', () => {
    const html = shiftDetailBox(shift);
    expect(html).toContain('Vlot 1');
  });

  test('escapes team name to prevent XSS', () => {
    const xssShift = { ...shift, team: '<script>alert(1)</script>' };
    const html = shiftDetailBox(xssShift);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('works without a team field', () => {
    const noTeam = { ...shift, team: null };
    const html = shiftDetailBox(noTeam);
    expect(html).toContain('09:00');
    expect(html).not.toContain('middot');
  });

  test('returns HTML string with detail-box class', () => {
    const html = shiftDetailBox(shift);
    expect(html).toContain('detail-box');
  });
});

// ===== baseTemplate =====

describe('baseTemplate', () => {
  test('includes the given title', () => {
    const html = baseTemplate('Test Titel', '<p>Body</p>');
    expect(html).toContain('Test Titel');
  });

  test('includes the body content', () => {
    const html = baseTemplate('Titel', '<p>Hallo wereld</p>');
    expect(html).toContain('Hallo wereld');
  });

  test('is a valid HTML string', () => {
    const html = baseTemplate('X', 'Y');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  test('includes the Het Vlot branding header', () => {
    const html = baseTemplate('X', 'Y');
    expect(html).toContain('Het Vlot Roosterplanning');
  });

  test('includes the app link button', () => {
    const html = baseTemplate('X', 'Y');
    expect(html).toContain('Bekijk in de app');
  });
});
