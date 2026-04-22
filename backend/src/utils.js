// ===== PURE DATE HELPER FUNCTIONS =====
// Shared utilities used by the schedule/apply-schedule endpoint.
// These are pure functions with no side-effects and no external dependencies,
// making them easy to unit-test in isolation.

/**
 * Returns the Monday of the ISO week containing `date`.
 * @param {Date} date
 * @returns {Date}
 */
function getMonday(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}

/**
 * Formats a Date as 'YYYY-MM-DD'.
 * @param {Date} date
 * @returns {string}
 */
function formatDateYYYYMMDD(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parses a date value into a local Date (no timezone shift).
 * Accepts 'YYYY-MM-DD', ISO timestamps, or Date objects.
 * Returns null for invalid input.
 * @param {string|Date} value
 * @returns {Date|null}
 */
function parseLocalDate(value) {
  if (typeof value === 'string') {
    // Handle ISO timestamps like "2026-03-01T23:00:00.000Z" → extract date part
    const dateOnly = value.includes('T') ? value.split('T')[0] : value;
    const parts = dateOnly.split('-').map(Number);
    if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
  }
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Anoniem Gregoriaans Computus algoritme voor Pasen
function getEasterDate(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function getBelgianPublicHolidays(year) {
  const easter = getEasterDate(year);
  const add = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  return [
    { date: new Date(year, 0,  1), name: 'Nieuwjaar' },
    { date: add(easter, 1),        name: 'Paasmaandag' },
    { date: new Date(year, 4,  1), name: 'Dag van de Arbeid' },
    { date: add(easter, 39),       name: 'Hemelvaartsdag' },
    { date: add(easter, 50),       name: 'Pinkstermaandag' },
    { date: new Date(year, 6, 21), name: 'Nationale Feestdag' },
    { date: new Date(year, 7, 15), name: 'O.L.V. Hemelvaart' },
    { date: new Date(year, 10, 1), name: 'Allerheiligen' },
    { date: new Date(year, 10,11), name: 'Wapenstilstand' },
    { date: new Date(year, 11,25), name: 'Kerstmis' },
  ].map(h => ({ date: formatDateYYYYMMDD(h.date), name: h.name }));
}

module.exports = { getMonday, formatDateYYYYMMDD, parseLocalDate, getEasterDate, getBelgianPublicHolidays };
