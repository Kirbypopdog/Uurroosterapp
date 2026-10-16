// Wie krijgt welke verlofmail, en wie heeft er nog niet ingediend (#397).
//
// Dit staat apart van `email.js` omdat het DATABASEVRAGEN zijn, geen opmaak.
// email.js weet hoe een mail eruitziet; dit bestand weet wie hem hoort te
// krijgen.

const { pool } = require('../db');
const {
  notifyLeaveRoundOpened,
  notifyLeaveRoundReminder
} = require('../email');

// email_notifications_enabled staat er zowel onder zijn eigen naam als met een
// alias in: `verstuurReeks` filtert op de snake_case naam. Zonder die kolom is
// dat veld daar undefined, is `!== false` waar, en krijgt iemand die de mail
// net heeft uitgezet hem alsnog.
const ONTVANGER_KOLOMMEN = `
  id, name, email, role,
  email_notifications_enabled,
  email_notifications_enabled AS "emailNotificationsEnabled"
`;

/**
 * Wie moet een verlofronde invullen? Dezelfde groep als de matrix toont:
 * actieve accounts die MEEDRAAIEN in het rooster. Een adminaccount hoort daar
 * niet bij — zie `isRoosterMedewerker` in routes/leave.js (#309): die kan niet
 * indienen, dus een herinnering sturen zou een opdracht zijn die hij niet kan
 * uitvoeren.
 */
async function ontvangersVanRonde(client = pool) {
  const res = await client.query(
    `SELECT ${ONTVANGER_KOLOMMEN} FROM users
      WHERE active IS NOT FALSE AND role <> 'admin'
      ORDER BY name`
  );
  return res.rows;
}

/** De beheerders: admin én roosterverantwoordelijke. */
async function beheerders(client = pool) {
  const res = await client.query(
    `SELECT ${ONTVANGER_KOLOMMEN} FROM users
      WHERE active IS NOT FALSE AND role IN ('admin', 'roosterverantwoordelijke')
      ORDER BY name`
  );
  return res.rows;
}

/**
 * Wie heeft er nog niet INGEDIEND voor deze ronde?
 *
 * Bewust op `submitted_at IS NULL` en niet op "heeft niets ingevuld": een
 * volledig ingevulde ronde die nooit ingediend werd telt bij `apply` niet mee
 * (zie CLAUDE.md), en juist die mensen denken dat ze klaar zijn. Dat is precies
 * de groep die een herinnering nodig heeft.
 */
async function nietIngediend(roundId, client = pool) {
  const res = await client.query(
    `SELECT ${ONTVANGER_KOLOMMEN} FROM users u
      WHERE u.active IS NOT FALSE AND u.role <> 'admin'
        AND NOT EXISTS (
          SELECT 1 FROM leave_round_submissions s
           WHERE s.round_id = $1 AND s.user_id = u.id AND s.submitted_at IS NOT NULL
        )
      ORDER BY u.name`,
    [roundId]
  );
  return res.rows;
}

async function verstuurRondeGeopend(ontvangers, ronde, blokken) {
  return notifyLeaveRoundOpened(ontvangers, ronde, blokken);
}

async function verstuurRondeHerinnering(ontvangers, ronde, opties) {
  return notifyLeaveRoundReminder(ontvangers, ronde, opties);
}

module.exports = {
  ontvangersVanRonde,
  beheerders,
  nietIngediend,
  verstuurRondeGeopend,
  verstuurRondeHerinnering
};
