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
 * Welke teams vragen hun verlof aan via een verlofronde? Instelling
 * `leaveTeams` (Instellingen > Teams > "Verlof"). Jobstudenten, stagiairs en
 * het kantoor doen dat niet, en kregen toch de mail, de herinnering en een
 * rij in de matrix.
 *
 * `null` = de instelling bestaat nog niet = elk team doet mee. Dat was het
 * gedrag tot nu toe, dus een database zonder deze instelling verandert niet.
 */
async function verlofTeams(client = pool) {
  const res = await client.query(`SELECT value FROM settings WHERE key = 'leaveTeams'`);
  const waarde = res.rows[0] && res.rows[0].value;
  return Array.isArray(waarde) ? waarde.map(String) : null;
}

/**
 * Doet deze gebruiker mee aan de verlofrondes? Dezelfde regel als
 * `draaitMeeInVerlof()` in frontend/app-permissions.js: geen adminaccount
 * (#309), en zijn hoofdteam staat in `leaveTeams`.
 */
function doetMeeAanVerlof(gebruiker, teams) {
  if (!gebruiker || gebruiker.role === 'admin' || gebruiker.active === false) return false;
  if (!Array.isArray(teams)) return true;
  return teams.includes(String(gebruiker.main_team ?? gebruiker.mainTeam));
}

/**
 * Wie moet een verlofronde invullen? Dezelfde groep als de matrix toont:
 * actieve accounts die MEEDRAAIEN in het rooster, uit een team dat verlof
 * aanvraagt. Een adminaccount hoort daar niet bij — zie `isRoosterMedewerker`
 * in routes/leave.js (#309): die kan niet indienen, dus een herinnering sturen
 * zou een opdracht zijn die hij niet kan uitvoeren.
 */
async function ontvangersVanRonde(client = pool) {
  const teams = await verlofTeams(client);
  const res = await client.query(
    `SELECT ${ONTVANGER_KOLOMMEN} FROM users
      WHERE active IS NOT FALSE AND role <> 'admin'
        AND ($1::text[] IS NULL OR main_team = ANY($1::text[]))
      ORDER BY name`,
    [teams]
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
  const teams = await verlofTeams(client);
  const res = await client.query(
    `SELECT ${ONTVANGER_KOLOMMEN} FROM users u
      WHERE u.active IS NOT FALSE AND u.role <> 'admin'
        AND ($2::text[] IS NULL OR u.main_team = ANY($2::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM leave_round_submissions s
           WHERE s.round_id = $1 AND s.user_id = u.id AND s.submitted_at IS NOT NULL
        )
      ORDER BY u.name`,
    [roundId, teams]
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
  verlofTeams,
  doetMeeAanVerlof,
  ontvangersVanRonde,
  beheerders,
  nietIngediend,
  verstuurRondeGeopend,
  verstuurRondeHerinnering
};
