'use strict';

// Op de ingangsdatum voert voerGeplandeOvernamesUit() de overname af. Wisselt
// de vertrekker alleen van team (vertrekker_blijft_actief), dan mag hij NIET
// gedeactiveerd worden: anders vervalt een overname waarin hij zelf de
// vervanger is, met de check "nieuwe gebruiker niet actief".

jest.mock('../src/db', () => ({ pool: { connect: jest.fn() } }));
const { pool } = require('../src/db');
const { voerGeplandeOvernamesUit } = require('../src/helpers/overnames');

function client(blijftActief) {
  const c = {
    release: jest.fn(),
    query: jest.fn((sql) => {
      if (sql.includes('FROM geplande_overnames')) {
        return Promise.resolve({ rows: [{ id: 5, oude_gebruiker: 117, nieuwe_gebruiker: 181,
          ingangsdatum: '2026-11-26', vertrekker_blijft_actief: blijftActief }] });
      }
      if (sql.includes('week_schedules') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [{ id: 117, name: 'Bryan', main_team: 'vlot1' }] });
      }
      if (sql.includes('SELECT id, name, active FROM users')) {
        return Promise.resolve({ rows: [{ id: 181, name: 'Justine', active: true }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
  pool.connect.mockResolvedValueOnce(c);
  return c;
}
const sqls = (c) => c.query.mock.calls.map(([q]) => q);

test('blijft actief: geen deactivatie, alleen verzoeken over verhuisde diensten vervallen', async () => {
  const c = client(true);
  expect(await voerGeplandeOvernamesUit()).toBe(1);
  expect(sqls(c).some(q => q.includes('SET active = false'))).toBe(false);
  const [sql, params] = c.query.mock.calls.find(([q]) => q.includes('UPDATE shift_swap_requests'));
  expect(sql).toMatch(/s\.date >= \$3/);
  expect(params[2]).toBe('2026-11-26');
  // Team en uren gaan wel naar de vervanger
  expect(sqls(c).some(q => q.includes('main_team = $4'))).toBe(true);
});

test('gewone overname: de vertrekker wordt zoals vroeger gedeactiveerd', async () => {
  const c = client(false);
  expect(await voerGeplandeOvernamesUit()).toBe(1);
  expect(sqls(c).some(q => q.includes('SET active = false'))).toBe(true);
});
