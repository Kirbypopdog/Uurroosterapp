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

module.exports = { getMonday, formatDateYYYYMMDD, parseLocalDate };
