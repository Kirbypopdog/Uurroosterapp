// Wie is er weekend- of vakantieverantwoordelijke? — de serverkant.
//
// De REGELS staan in `frontend/verantwoordelijke-regels.js` en worden hier
// hergebruikt in plaats van overgeschreven. Dat is met opzet: twee kopieën van
// deze logica lopen uiteen zonder dat iemand het merkt, precies zoals CLAUDE.md
// bij de filtering van de foutmonitoring beschrijft. Dit bestand doet alleen
// het ophalen uit de database en het vertalen naar de invoer die de regels
// vragen.
//
// Let op de sleutelnamen. De database noemt het rooster­patroon
// `schedule_pattern`, de frontend noemt hetzelfde veld `schedulePattern`. De
// regels vragen hun invoer daarom bij naam: geef je de verkeerde sleutel door,
// dan valt de berekening stil terug op de STANDAARD — een omgekeerde
// weekendcyclus, zonder één foutmelding.

const path = require('path');
const { pool } = require('../db');
const regels = require(path.join(__dirname, '..', '..', '..', 'frontend', 'verantwoordelijke-regels.js'));

const SETTING_SLEUTELS = [
  'responsibleRotation',
  'holidayPeriods',
  'schedule_pattern',
  'biWeeklyReferenceDate'
];

async function haalContext(client = pool) {
  const [settingsRes, usersRes] = await Promise.all([
    client.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [SETTING_SLEUTELS]),
    client.query(
      // email_notifications_enabled staat er TWEE keer in, en dat is geen
      // slordigheid: `verstuurReeks` in email.js filtert op de snake_case
      // naam. Geef je alleen de camelCase mee, dan is dat veld daar undefined,
      // is `!== false` waar, en krijgt iemand die de mail net heeft uitgezet
      // hem alsnog — stil, want er gaat niets fout.
      `SELECT id, name, email, role, active,
              main_team AS "mainTeam",
              email_notifications_enabled,
              email_notifications_enabled AS "emailNotificationsEnabled"
         FROM users`
    )
  ]);

  const s = {};
  for (const rij of settingsRes.rows) s[rij.key] = rij.value;

  return {
    medewerkers: usersRes.rows,
    rotatie: s.responsibleRotation || null,
    vakantieperiodes: s.holidayPeriods || [],
    roosterpatroon: s.schedule_pattern || null,
    referentieDatumTweewekelijks: s.biWeeklyReferenceDate || null
  };
}

/**
 * De uitspraak voor één week, mét de reden. `weekStart` mag elke dag in die
 * week zijn; de regels maken er zelf de maandag van.
 *
 * Geeft { persoon, reden, vakantie, vakantieWeek }. `persoon` is null wanneer
 * er niemand is, en `reden` zegt waarom:
 *   handmatig | vakantieweek | vakantieweek-niemand-aangeduid |
 *   weekend-gesloten | rotatie | rotatie-levert-niemand
 */
async function verantwoordelijkeVoorWeek(weekStart, client = pool) {
  const ctx = await haalContext(client);
  return Object.assign({ weekStart }, regels.uitleg(Object.assign({ weekStart }, ctx)));
}

/** Hetzelfde, maar met een context die je al hebt — scheelt queries in een lus. */
function verantwoordelijkeMetContext(weekStart, ctx) {
  return Object.assign({ weekStart }, regels.uitleg(Object.assign({ weekStart }, ctx)));
}

module.exports = {
  haalContext,
  verantwoordelijkeVoorWeek,
  verantwoordelijkeMetContext,
  maandagVan: regels.maandagVan,
  alsTekst: regels.alsTekst,
  weekendIsOpen: regels.weekendIsOpen,
  weekRaaktVakantie: regels.weekRaaktVakantie
};
