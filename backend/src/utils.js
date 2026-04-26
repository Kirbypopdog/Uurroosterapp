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

// ===== SHIFT TIJDSVALIDATIE =====
// Geport vanuit frontend/validation.js voor server-side gebruik.

/**
 * Parst een datum + tijdstring naar een lokaal Date object.
 * @param {string} dateStr  'YYYY-MM-DD'
 * @param {string} timeStr  'HH:MM'
 * @returns {Date}
 */
function parseShiftDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, h, min, 0, 0);
}

/**
 * Geeft het eindtijdstip van een shift terug.
 * Corrigeert automatisch voor nachtshifts (eindtijd < starttijd).
 * @param {{ date: string, start_time: string, end_time: string }} shift
 * @returns {Date}
 */
function getShiftEndDT(shift) {
  const start = parseShiftDateTime(shift.date, shift.start_time);
  const end   = parseShiftDateTime(shift.date, shift.end_time);
  if (end <= start) end.setDate(end.getDate() + 1);
  return end;
}

/**
 * Berekent het aantal uren rust tussen twee shifts.
 * Negatief = overlap.
 * @param {{ date: string, start_time: string, end_time: string }} a
 * @param {{ date: string, start_time: string, end_time: string }} b
 * @returns {number}
 */
function hoursBetweenShifts(a, b) {
  const startA = parseShiftDateTime(a.date, a.start_time);
  const endA   = getShiftEndDT(a);
  const startB = parseShiftDateTime(b.date, b.start_time);
  const endB   = getShiftEndDT(b);
  const restMs = startA <= startB ? (startB - endA) : (startA - endB);
  return restMs / 3_600_000;
}

/**
 * Controleert of twee shifts overlappen.
 * @param {{ date: string, start_time: string, end_time: string }} a
 * @param {{ date: string, start_time: string, end_time: string }} b
 * @returns {boolean}
 */
function shiftsOverlapCheck(a, b) {
  const s1 = parseShiftDateTime(a.date, a.start_time), e1 = getShiftEndDT(a);
  const s2 = parseShiftDateTime(b.date, b.start_time), e2 = getShiftEndDT(b);
  return s1 < e2 && s2 < e1;
}

module.exports = {
  getMonday, formatDateYYYYMMDD, parseLocalDate, getEasterDate, getBelgianPublicHolidays,
  parseShiftDateTime, getShiftEndDT, hoursBetweenShifts, shiftsOverlapCheck
};
