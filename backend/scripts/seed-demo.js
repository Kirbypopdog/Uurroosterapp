// Vult de database met realistische demodata: testmedewerkers, shifts voor
// deze en volgende week, wat afwezigheden en één ruilverzoek. Bedoeld voor
// staging/lokale ontwikkeling — NOOIT op productie draaien.
//
// Idempotent: bestaande testaccounts (herkenbaar aan @test.be e-mails)
// worden bijgewerkt i.p.v. gedupliceerd; shifts/availability worden alleen
// aangemaakt als ze nog niet bestaan voor die combinatie.
//
// Gebruik: npm run db:seed-demo   (leest DATABASE_URL uit .env)

const { pool } = require('../src/db');
const bcrypt = require('bcryptjs');
const { getMonday, formatDateYYYYMMDD } = require('../src/utils');
require('dotenv').config();

const TEST_EMAIL_DOMAIN = '@test.be';

const EMPLOYEES = [
  { name: 'Dirk Voorbeeld',   email: 'dirk',  role: 'medewerker',              team: 'vlot2', hours: 38 },
  { name: 'Eva Testema',      email: 'eva',   role: 'medewerker',              team: 'vlot2', hours: 30.4 },
  { name: 'Femke Proef',      email: 'femke', role: 'medewerker',              team: 'vlot2', hours: 38 },
  { name: 'Anna Testerman',   email: 'anna',  role: 'roosterverantwoordelijke', team: 'vlot1', hours: 38 },
  { name: 'Bram Proefsma',    email: 'bram',  role: 'medewerker',              team: 'vlot1', hours: 38 },
  { name: 'Carla Demo',       email: 'carla', role: 'medewerker',              team: 'vlot1', hours: 19 },
  { name: 'Gert Testaert',    email: 'gert',  role: 'medewerker',              team: 'cargo', hours: 38 },
  { name: 'Hanne Demos',      email: 'hanne', role: 'medewerker',              team: 'cargo', hours: 19 },
];

// dagIndex: 0 = maandag van de week ... 6 = zondag
const SHIFTS_WEEK1 = [
  ['dirk',  0, '07:30', '16:00'], ['dirk',  2, '16:00', '23:00'], ['dirk',  4, '18:00', '09:00'],
  ['eva',   1, '07:30', '16:00'], ['eva',   3, '07:30', '16:00'], ['eva',   5, '16:00', '23:00'],
  ['femke', 1, '18:00', '09:00'], ['femke', 4, '07:30', '16:00'],
  ['anna',  0, '11:00', '16:00'], ['anna',  2, '16:00', '20:30'], ['anna',  3, '07:30', '16:00'],
  ['bram',  1, '16:00', '23:00'], ['bram',  3, '16:00', '23:00'], ['bram',  5, '07:30', '16:00'],
  ['carla', 0, '07:30', '16:00'], ['carla', 2, '07:30', '16:00'],
  ['gert',  0, '09:00', '17:00'], ['gert',  1, '09:00', '17:00'], ['gert',  3, '09:00', '17:00'],
  ['hanne', 1, '09:00', '17:00'], ['hanne', 2, '09:00', '13:00'],
];

const SHIFTS_WEEK2 = [
  ['dirk', 0, '07:30', '16:00'],
  ['eva',  1, '07:30', '16:00'],
  ['anna', 0, '07:30', '16:00'],
];

// [medewerker, dagIndex, type, reden]
const AVAILABILITY_WEEK1 = [
  ['femke', 2, 'verlof', 'Jaarlijks verlof'],
  ['hanne', 4, 'ziek', ''],
  ['carla', 4, 'vrij', 'Vaste vrije dag'],
];

async function upsertEmployee(client, passwordHash, emp) {
  const email = `${emp.email}${TEST_EMAIL_DOMAIN}`;
  const res = await client.query(
    `INSERT INTO users (name, email, password_hash, role, team_id, main_team, contract_hours, active)
     VALUES ($1, $2, $3, $4, $5, $5, $6, true)
     ON CONFLICT (email) DO UPDATE SET
       name = EXCLUDED.name, role = EXCLUDED.role,
       team_id = EXCLUDED.team_id, main_team = EXCLUDED.main_team,
       contract_hours = EXCLUDED.contract_hours, active = true
     RETURNING id`,
    [emp.name, email, passwordHash, emp.role, emp.team, emp.hours]
  );
  return res.rows[0].id;
}

async function upsertShift(client, userId, team, date, start, end) {
  const existing = await client.query(
    `SELECT id FROM shifts WHERE user_id = $1 AND date = $2 AND start_time = $3`,
    [userId, date, start]
  );
  if (existing.rows.length > 0) return;
  await client.query(
    `INSERT INTO shifts (user_id, team, date, start_time, end_time, source) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [userId, team, date, start, end]
  );
}

async function upsertAvailability(client, userId, date, type, reason) {
  await client.query(
    `INSERT INTO availability (user_id, date, type, reason) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, date) DO UPDATE SET type = EXCLUDED.type, reason = EXCLUDED.reason`,
    [userId, date, type, reason]
  );
}

async function run() {
  const password = process.env.DEFAULT_RESET_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('Geen DEFAULT_RESET_PASSWORD of ADMIN_PASSWORD in .env — kan geen testwachtwoord zetten');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const ids = {};

    await client.query('BEGIN');

    for (const emp of EMPLOYEES) {
      ids[emp.email] = await upsertEmployee(client, passwordHash, emp);
    }
    console.log(`${EMPLOYEES.length} testmedewerkers klaar (wachtwoord = DEFAULT_RESET_PASSWORD/ADMIN_PASSWORD)`);

    const week1Start = getMonday(new Date());
    const week2Start = new Date(week1Start);
    week2Start.setDate(week2Start.getDate() + 7);

    const dateFor = (weekStart, dayIndex) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + dayIndex);
      return formatDateYYYYMMDD(d);
    };

    const empByKey = Object.fromEntries(EMPLOYEES.map(e => [e.email, e]));

    let shiftCount = 0;
    for (const [key, day, start, end] of SHIFTS_WEEK1) {
      await upsertShift(client, ids[key], empByKey[key].team, dateFor(week1Start, day), start, end);
      shiftCount++;
    }
    for (const [key, day, start, end] of SHIFTS_WEEK2) {
      await upsertShift(client, ids[key], empByKey[key].team, dateFor(week2Start, day), start, end);
      shiftCount++;
    }
    console.log(`${shiftCount} shifts klaar (week van ${formatDateYYYYMMDD(week1Start)} + volgende week)`);

    for (const [key, day, type, reason] of AVAILABILITY_WEEK1) {
      await upsertAvailability(client, ids[key], dateFor(week1Start, day), type, reason);
    }
    console.log(`${AVAILABILITY_WEEK1.length} afwezigheden klaar`);

    // Eén demo-ruilverzoek: Eva biedt haar shift op dag 5 aan Dirk aan
    const evaShift = await client.query(
      `SELECT id FROM shifts WHERE user_id = $1 AND date = $2`,
      [ids.eva, dateFor(week1Start, 5)]
    );
    if (evaShift.rows.length > 0) {
      const existingRequest = await client.query(
        `SELECT id FROM shift_swap_requests WHERE requester_shift_id = $1 AND status = 'pending'`,
        [evaShift.rows[0].id]
      );
      if (existingRequest.rows.length === 0) {
        await client.query(
          `INSERT INTO shift_swap_requests
             (requester_user_id, requester_shift_id, target_user_id, status, request_type, message)
           VALUES ($1, $2, $3, 'pending', 'takeover', $4)`,
          [ids.eva, evaShift.rows[0].id, ids.dirk, 'Kan iemand deze avondshift overnemen? Familiefeest.']
        );
        console.log('1 demo-ruilverzoek klaar');
      } else {
        console.log('Demo-ruilverzoek bestond al — overgeslagen');
      }
    }

    await client.query('COMMIT');
    console.log('Seed-demo compleet.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Seed-demo mislukt:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
