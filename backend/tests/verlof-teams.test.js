'use strict';

// Niet elk team vraagt zijn verlof aan via een verlofronde. Jobstudenten,
// stagiairs en het kantoor doen dat anders, maar kregen toch de mail bij het
// openen, de herinneringen, een rij in de matrix en een taak op hun
// beginscherm. Welke teams wél meedoen staat in Instellingen > Teams onder
// "Verlof" (`settings.leaveTeams`).

const fs = require('fs');
const path = require('path');

jest.mock('../src/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../src/email', () => ({
  notifyLeaveRoundOpened: jest.fn(),
  notifyLeaveRoundReminder: jest.fn(),
}));

const { doetMeeAanVerlof, verlofTeams, ontvangersVanRonde, nietIngediend } = require('../src/helpers/verlofmail');
const { draaitMeeInVerlof } = require('../../frontend/app-permissions.js');

const F = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');

describe('wie doet mee', () => {
  const geval = (rol, team, actief = true) => ({ role: rol, mainTeam: team, main_team: team, active: actief });
  const TEAMS = ['vlot1', 'vlot2', 'cargo'];

  test.each([
    ['een begeleider uit een aangevinkt team', geval('medewerker', 'vlot1'), TEAMS, true],
    ['een jobstudent', geval('medewerker', 'jobstudent'), TEAMS, false],
    ['iemand van kantoor, ook als roosterverantwoordelijke', geval('roosterverantwoordelijke', 'overkoepelend'), TEAMS, false],
    ['een roosterverantwoordelijke uit een aangevinkt team', geval('roosterverantwoordelijke', 'vlot2'), TEAMS, true],
    ['een adminaccount, ook in een aangevinkt team (#309)', geval('admin', 'vlot1'), TEAMS, false],
    ['een gedeactiveerd account', geval('medewerker', 'vlot1', false), TEAMS, false],
    ['zonder instelling: elk team, zoals vroeger', geval('medewerker', 'jobstudent'), undefined, true],
    ['alles uitgevinkt: niemand', geval('medewerker', 'vlot1'), [], false],
  ])('%s', (_, gebruiker, teams, verwacht) => {
    // Frontend en backend trekken dezelfde grens (regel 5).
    expect(draaitMeeInVerlof(gebruiker, teams)).toBe(verwacht);
    expect(doetMeeAanVerlof(gebruiker, teams)).toBe(verwacht);
  });
});

describe('de mails en herinneringen', () => {
  const client = (leaveTeams) => ({
    query: jest.fn((sql) => {
      if (sql.includes("key = 'leaveTeams'")) {
        return Promise.resolve({ rows: leaveTeams === undefined ? [] : [{ value: leaveTeams }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  });

  test('verlofTeams: niet ingesteld is null, anders de lijst', async () => {
    expect(await verlofTeams(client())).toBeNull();
    expect(await verlofTeams(client(['vlot1']))).toEqual(['vlot1']);
  });

  test('de mail bij het openen gaat alleen naar de aangevinkte teams', async () => {
    const c = client(['vlot1', 'vlot2']);
    await ontvangersVanRonde(c);
    const [sql, params] = c.query.mock.calls.find(([q]) => q.includes('FROM users'));
    expect(sql).toMatch(/main_team = ANY\(\$1::text\[\]\)/);
    expect(params).toEqual([['vlot1', 'vlot2']]);
  });

  test('de herinnering ook', async () => {
    const c = client(['vlot1']);
    await nietIngediend(7, c);
    const [sql, params] = c.query.mock.calls.find(([q]) => q.includes('FROM users'));
    expect(sql).toMatch(/main_team = ANY\(\$2::text\[\]\)/);
    expect(params).toEqual([7, ['vlot1']]);
  });

  test('zonder instelling geen filter', async () => {
    const c = client();
    await ontvangersVanRonde(c);
    const [, params] = c.query.mock.calls.find(([q]) => q.includes('FROM users'));
    expect(params).toEqual([null]);
  });
});

describe('in de app', () => {
  const LEAVE = F('app-leave.js');

  test('matrix, verdeelscherm en export tonen alleen wie meedoet', () => {
    expect(LEAVE).not.toContain('const medewerkers = getAllEmployees(true);');
    expect(LEAVE.split('const medewerkers = leaveDeelnemers();').length - 1).toBe(3);
  });

  test('wie niet meedoet krijgt geen invulscherm, maar een uitleg', () => {
    expect(LEAVE).not.toMatch(/const beheeraccount = AppState\.currentUser\?\.role === 'admin';/);
    expect(LEAVE).toContain('Jouw team vraagt zijn verlof niet aan via deze ronde');
  });

  test('geen taak op het beginscherm, met een typeof-wacht (#412)', () => {
    expect(F('app-nav.js')).toContain("typeof leaveIkDoeMee === 'function' ? leaveIkDoeMee() : true");
  });

  test('het vinkje staat bij de teams en wordt bewaard', () => {
    const S = F('app-settings.js');
    expect(S).toContain('class="leave-team-cb"');
    expect(S).toContain("saveSettings('leaveTeams', leaveTeams)");
  });

  test('de app neemt de instelling over bij het laden én bij het herladen', () => {
    // Zonder dit bleef DataStore.settings.leaveTeams leeg bij elke herlading,
    // en kreeg een jobstudent gewoon het invulscherm: de vinkjes werkten
    // alleen in de browser van wie ze net had aangeklikt.
    expect(F('data.js').split('leaveTeams: apiSettings.leaveTeams').length - 1).toBe(2);
  });

  test('de backend aanvaardt de instelling', () => {
    const R = fs.readFileSync(path.join(__dirname, '../src/routes/settings.js'), 'utf8');
    expect(R).toMatch(/leaveTeams:\s+'array'/);
  });
});

describe('terug vanaf het overzicht van iedereen', () => {
  test('vraagt niet naar onbewaarde wijzigingen: dat geldt alleen in het invulscherm', () => {
    const bron = F('app-leave.js');
    const blok = bron.slice(bron.indexOf("querySelector('#leave-back')?.addEventListener"));
    expect(blok.slice(0, 2500)).toMatch(/const blok = AppState\.leaveScreen === 'blok'\s*\?/);
  });
});
