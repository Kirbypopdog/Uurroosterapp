'use strict';

// Een verlofronde als CONCEPT klaarzetten: alleen zichtbaar voor beheerders,
// en niemand krijgt een mail. Pas bij het openen gaat de mail naar iedereen
// die meedoet.
//
// Daarbij kwam een fout boven: een ronde die meteen OPEN aangemaakt werd (de
// knop "Ronde openen" in het startvenster) mailde niemand. De mail hing alleen
// aan een PUT naar 'open'.

const fs = require('fs');
const path = require('path');

jest.mock('../src/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../src/email', () => ({
  notifyLeaveRoundOpened: jest.fn(async () => ({ verstuurd: 0 })),
  notifyLeaveRoundReminder: jest.fn(),
}));
process.env.JWT_SECRET = 'test-secret-key-for-unit-tests';

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { pool } = require('../src/db');
const email = require('../src/email');

let app;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  app = require('../src/server');
});
beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  email.notifyLeaveRoundOpened.mockClear();
});

const beheerder = { id: 4, name: 'Anna', role: 'roosterverantwoordelijke', team_id: 'cargo' };
const token = () => jwt.sign(beheerder, 'test-secret-key-for-unit-tests');
const wacht = () => new Promise((r) => setTimeout(r, 30));

function arrangeAanmaken(status) {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT active FROM users/i.test(sql) || /active/i.test(sql) && /users/i.test(sql) && /WHERE id/i.test(sql)) return { rows: [{ active: true }] };
    return { rows: [] };
  });
  const client = {
    query: jest.fn(async (sql) => {
      if (/INSERT INTO leave_rounds/.test(sql)) return { rows: [{ id: 9, name: 'Zomer 2027', status }] };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
}

const RONDE = {
  name: 'Zomer 2027',
  blocks: [{ name: 'Zomervakantie 2027', mode: 'voorkeur', startDate: '2027-06-28', endDate: '2027-08-29' }],
};

test('als concept aangemaakt: niemand krijgt een mail', async () => {
  arrangeAanmaken('concept');
  const res = await request(app).post('/api/v1/leave-rounds')
    .set('Authorization', `Bearer ${token()}`).send({ ...RONDE, status: 'concept' });
  expect(res.status).toBe(200);
  await wacht();
  expect(email.notifyLeaveRoundOpened).not.toHaveBeenCalled();
});

test('meteen open aangemaakt: de openingsmail vertrekt', async () => {
  arrangeAanmaken('open');
  const res = await request(app).post('/api/v1/leave-rounds')
    .set('Authorization', `Bearer ${token()}`).send({ ...RONDE, status: 'open' });
  expect(res.status).toBe(200);
  await wacht();
  expect(email.notifyLeaveRoundOpened).toHaveBeenCalledTimes(1);
});

describe('in de app', () => {
  const bron = fs.readFileSync(path.join(__dirname, '../../frontend/app-leave.js'), 'utf8');

  test('het startvenster heeft "Als concept bewaren" naast "Ronde openen"', () => {
    expect(bron).toContain('id="lr-concept"');
    expect(bron).toMatch(/status: alsConcept \? 'concept' : 'open'/);
  });

  test('een concept opent met een knop, die zegt dat er gemaild wordt', () => {
    expect(bron).toContain('function openConceptRonde(round)');
    expect(bron).toMatch(/JSON\.stringify\(\{ status: 'open' \}\)/);
    expect(bron).toContain('Openen en mailen');
  });
});
