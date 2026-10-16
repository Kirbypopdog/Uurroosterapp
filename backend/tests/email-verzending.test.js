'use strict';

// Tests voor de e-mailgroep: #322, #323, #324, #325 en #326.
//
// email.js maakt zijn Resend-client aan bij het laden en verstuurt alleen als
// RESEND_API_KEY gezet is. Om te kunnen zien wát er verstuurd wordt, mocken we
// het resend-pakket en zetten we de sleutel vóór het requiren van de module.

const verzonden = [];
const batchAanroepen = [];
const gedrag = { batchFaalt: false };

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn(async (opts) => { verzonden.push({ ...opts, via: 'los' }); return { data: { id: 'los' } }; })
    },
    batch: {
      send: jest.fn(async (lijst) => {
        if (gedrag.batchFaalt) return { error: { message: 'batch niet beschikbaar' } };
        batchAanroepen.push(lijst);
        lijst.forEach(o => verzonden.push({ ...o, via: 'batch' }));
        return { data: lijst.map((_, i) => ({ id: 'b' + i })) };
      })
    }
  }))
}));

const instellingen = { waarde: null };
jest.mock('../src/db', () => ({
  pool: { query: jest.fn(async () => ({ rows: instellingen.waarde ? [{ value: instellingen.waarde }] : [] })) }
}));

process.env.RESEND_API_KEY = 'test-key';
process.env.EMAIL_FROM = 'test@hetvlot.be';

const email = require('../src/email');
const { formatDate } = email._helpers;

const leeg = () => {
  verzonden.length = 0;
  batchAanroepen.length = 0;
  gedrag.batchFaalt = false;
  // De instellingen worden 60 seconden gecachet, dus die moet leeg voor elke
  // test die de schakelaars anders zet.
  email._resetSettingsCache();
};
const laatBezinken = () => new Promise(r => setTimeout(r, 20));

function maakLeden(aantal) {
  return Array.from({ length: aantal }, (_, i) => ({
    id: i + 10, name: `Lid ${i}`, email: `lid${i}@test.be`, email_notifications_enabled: true
  }));
}

// ===== #326: datums mogen niet verschuiven met de tijdzone =====

describe('#326 formatDate met een Date uit de databank', () => {
  test('geeft de dag die de databank bedoelde, niet de dag ervoor', () => {
    // De pg-driver levert een DATE-kolom als een Date op LOKALE middernacht.
    const uitDeDatabank = new Date(2026, 6, 15); // 15 juli 2026, lokaal
    expect(formatDate(uitDeDatabank)).toContain('15 juli 2026');
  });

  test('een datum vlak na middernacht in een oostelijke zone schuift niet terug', () => {
    // Onder Europe/Brussels is 1 januari 2027 lokaal gelijk aan
    // 2026-12-31T23:00:00Z. toISOString zou hier 31 december opleveren.
    const nieuwjaar = new Date(2027, 0, 1);
    expect(formatDate(nieuwjaar)).toContain('1 januari 2027');
    expect(formatDate(nieuwjaar)).not.toContain('december');
  });

  test('strings blijven werken zoals voordien', () => {
    expect(formatDate('2026-07-15')).toContain('15 juli 2026');
    expect(formatDate('2026-07-15T00:00:00.000Z')).toContain('15 juli 2026');
  });
});

// ===== #325: het onderwerp is geen HTML =====

describe('#325 onderwerpregels zonder HTML-escaping', () => {
  beforeEach(leeg);

  test('een apostrof in de naam blijft een apostrof in het onderwerp', async () => {
    await email.notifySwapRequest(
      { id: 2, email: 'b@test.be', email_notifications_enabled: true },
      { id: 1, name: "Sofie D'Hondt" },
      { date: '2026-09-14', start_time: '09:00', end_time: '17:00' },
      { date: '2026-09-15', start_time: '09:00', end_time: '17:00' }
    );
    await laatBezinken();
    expect(verzonden).toHaveLength(1);
    expect(verzonden[0].subject).toBe("Ruilverzoek van Sofie D'Hondt");
    expect(verzonden[0].subject).not.toContain('&#39;');
  });

  test('een ampersand in de naam blijft een ampersand in het onderwerp', async () => {
    await email.notifySickLeave(
      [{ id: 9, email: 'mgr@test.be', email_notifications_enabled: true }],
      { name: 'Jan & Els' }, '2026-09-14', '2026-09-14', 2
    );
    await laatBezinken();
    expect(verzonden[0].subject).toBe('Ziekmelding: Jan & Els');
    expect(verzonden[0].subject).not.toContain('&amp;');
  });

  test('de body blijft wél geëscaped', async () => {
    leeg();
    await email.notifySickLeave(
      [{ id: 9, email: 'mgr@test.be', email_notifications_enabled: true }],
      { name: 'Jan & Els' }, '2026-09-14', '2026-09-14', 2
    );
    await laatBezinken();
    expect(verzonden[0].html).toContain('Jan &amp; Els');
  });
});

// ===== #324: één API-aanroep in plaats van een ongeremde stortvloed =====

describe('#324 reeksverzending', () => {
  beforeEach(leeg);

  test('twintig teamleden leveren één batch-aanroep op, geen twintig losse', async () => {
    await email.verstuurReeks(maakLeden(20), 'Onderwerp', '<p>body</p>');
    expect(batchAanroepen).toHaveLength(1);
    expect(batchAanroepen[0]).toHaveLength(20);
    expect(verzonden.every(v => v.via === 'batch')).toBe(true);
  });

  test('meer dan honderd ontvangers worden in groepen van honderd verstuurd', async () => {
    await email.verstuurReeks(maakLeden(250), 'Onderwerp', '<p>body</p>');
    expect(batchAanroepen.map(b => b.length)).toEqual([100, 100, 50]);
  });

  test('wie meldingen uit heeft en wie de aanleiding was vallen af', async () => {
    const leden = [
      { id: 1, email: 'aanvrager@test.be', email_notifications_enabled: true },
      { id: 2, email: 'wil@test.be', email_notifications_enabled: true },
      { id: 3, email: 'wilniet@test.be', email_notifications_enabled: false },
      { id: 4, email: null, email_notifications_enabled: true }
    ];
    const uitkomst = await email.verstuurReeks(leden, 'Onderwerp', '<p>body</p>', 1);
    expect(verzonden.map(v => v.to)).toEqual(['wil@test.be']);
    expect(uitkomst.verstuurd).toBe(1);
  });

  test('faalt de batch, dan gaan de mails alsnog één voor één de deur uit', async () => {
    gedrag.batchFaalt = true;
    const uitkomst = await email.verstuurReeks(maakLeden(2), 'Onderwerp', '<p>body</p>');
    expect(batchAanroepen).toHaveLength(0);
    expect(verzonden.map(v => v.via)).toEqual(['los', 'los']);
    expect(uitkomst.verstuurd).toBe(2);
  }, 10000);

  test('een lege lijst stuurt niets en roept de API niet aan', async () => {
    const uitkomst = await email.verstuurReeks([], 'Onderwerp', '<p>body</p>');
    expect(verzonden).toHaveLength(0);
    expect(batchAanroepen).toHaveLength(0);
    expect(uitkomst.verstuurd).toBe(0);
  });
});

// ===== #323: de resetmail hangt niet meer aan de welkomstmail =====

describe('#323 eigen schakelaar voor de resetmail', () => {
  beforeEach(() => { leeg(); instellingen.waarde = null; });
  afterEach(() => { instellingen.waarde = null; });

  test('welkomstmail uit laat de resetmail ongemoeid', async () => {
    instellingen.waarde = { globalEnabled: true, types: { welcome: false, password_reset: true } };
    const gelukt = await email.notifyPasswordReset({ name: 'Jan', email: 'jan@test.be' });
    await laatBezinken();
    expect(gelukt).toBe(true);
    expect(verzonden).toHaveLength(1);
    expect(verzonden[0].subject).toContain('Wachtwoord gereset');
  });

  test('de eigen schakelaar uit houdt de resetmail wél tegen', async () => {
    instellingen.waarde = { globalEnabled: true, types: { welcome: true, password_reset: false } };
    const gelukt = await email.notifyPasswordReset({ name: 'Jan', email: 'jan@test.be' });
    await laatBezinken();
    expect(gelukt).toBe(false);
    expect(verzonden).toHaveLength(0);
  });

  test('de globale schakelaar uit houdt alles tegen', async () => {
    instellingen.waarde = { globalEnabled: false, types: { password_reset: true } };
    const gelukt = await email.notifyPasswordReset({ name: 'Jan', email: 'jan@test.be' });
    await laatBezinken();
    expect(gelukt).toBe(false);
    expect(verzonden).toHaveLength(0);
  });
});

// ===== #397: verlofplanning en verantwoordelijken =====

describe('#397 de nieuwe mails hebben elk hun eigen schakelaar', () => {
  beforeEach(() => { leeg(); instellingen.waarde = null; });
  afterEach(() => { instellingen.waarde = null; });

  const RONDE = { id: 'r1', name: 'Schooljaar 2026-2027', deadline: '2026-11-15' };
  const BLOKKEN = [{ name: 'Herfstvakantie', startDate: '2026-10-26', endDate: '2026-11-01' }];
  const PLOEG = [
    { id: 10, name: 'Bryan', email: 'b@test.be', email_notifications_enabled: true },
    { id: 11, name: 'Chelsea', email: 'c@test.be', email_notifications_enabled: true }
  ];
  const WEEK = { weekStart: '2026-10-19', weekEind: '2026-10-25', reden: 'rotatie' };

  test('ronde geopend gaat naar iedereen die meedraait', async () => {
    instellingen.waarde = { globalEnabled: true, types: { leave_round_opened: true } };
    const uit = await email.notifyLeaveRoundOpened(PLOEG, RONDE, BLOKKEN);
    await laatBezinken();
    expect(uit.verstuurd).toBe(2);
    expect(verzonden[0].subject).toContain('Schooljaar 2026-2027');
  });

  test('de aankondiging uitzetten laat de herinnering staan', async () => {
    instellingen.waarde = { globalEnabled: true, types: { leave_round_opened: false, leave_round_reminder: true } };
    await email.notifyLeaveRoundOpened(PLOEG, RONDE, BLOKKEN);
    await laatBezinken();
    expect(verzonden).toHaveLength(0);

    const uit = await email.notifyLeaveRoundReminder(PLOEG, RONDE, { dagenTot: 2 });
    await laatBezinken();
    expect(uit.verstuurd).toBe(2);
  });

  // Wie de meldingen uitzette, hoort ook deze niet te krijgen. verstuurReeks
  // filtert op de SNAKE_CASE naam; een ontvanger die alleen de camelCase
  // variant draagt glipt er stil doorheen.
  test('wie de meldingen uitzette krijgt niets', async () => {
    instellingen.waarde = { globalEnabled: true, types: { leave_round_reminder: true } };
    const uit = await email.notifyLeaveRoundReminder(
      [{ id: 10, name: 'Bryan', email: 'b@test.be', email_notifications_enabled: false }],
      RONDE, { dagenTot: 2 });
    await laatBezinken();
    expect(uit.verstuurd).toBe(0);
    expect(verzonden).toHaveLength(0);
  });

  test('de herinnering noemt hoeveel dagen er nog zijn', async () => {
    instellingen.waarde = { globalEnabled: true, types: { leave_round_reminder: true } };
    await email.notifyLeaveRoundReminder(PLOEG, RONDE, { dagenTot: 1 });
    await laatBezinken();
    expect(verzonden[0].html).toContain('Nog <strong>1 dag</strong>');
  });

  test('op de dag zelf staat dat er ook zo in', async () => {
    instellingen.waarde = { globalEnabled: true, types: { leave_round_reminder: true } };
    await email.notifyLeaveRoundReminder(PLOEG, RONDE, { dagenTot: 0 });
    await laatBezinken();
    expect(verzonden[0].html).toContain('vandaag');
  });

  test('de verantwoordelijke krijgt zijn week voluit, niet als ISO-datum', async () => {
    instellingen.waarde = { globalEnabled: true, types: { responsible_reminder: true } };
    await email.notifyResponsibleReminder(PLOEG[0], WEEK);
    await laatBezinken();
    expect(verzonden).toHaveLength(1);
    expect(verzonden[0].html).toContain('19 oktober 2026');
    expect(verzonden[0].html).not.toContain('2026-10-19');
  });

  test('een vakantieweek noemt de vakantie bij naam', async () => {
    instellingen.waarde = { globalEnabled: true, types: { responsible_reminder: true } };
    await email.notifyResponsibleReminder(PLOEG[0],
      Object.assign({}, WEEK, { reden: 'vakantieweek', vakantie: 'Herfstvakantie', vakantieWeek: 1 }));
    await laatBezinken();
    expect(verzonden[0].subject).toContain('Vakantieverantwoordelijke');
    expect(verzonden[0].html).toContain('Herfstvakantie');
  });

  test('de melding dat er niemand is, zegt waaróm', async () => {
    instellingen.waarde = { globalEnabled: true, types: { responsible_missing: true } };
    await email.notifyResponsibleMissing(PLOEG,
      Object.assign({}, WEEK, { reden: 'vakantieweek-niemand-aangeduid', vakantie: 'Herfstvakantie' }));
    await laatBezinken();
    expect(verzonden[0].html).toContain('roosterbouwer');
  });

  test('de globale schakelaar uit houdt alle vier tegen', async () => {
    instellingen.waarde = { globalEnabled: false, types: {
      leave_round_opened: true, leave_round_reminder: true,
      responsible_reminder: true, responsible_missing: true } };
    await email.notifyLeaveRoundOpened(PLOEG, RONDE, BLOKKEN);
    await email.notifyLeaveRoundReminder(PLOEG, RONDE, {});
    await email.notifyResponsibleReminder(PLOEG[0], WEEK);
    await email.notifyResponsibleMissing(PLOEG, WEEK);
    await laatBezinken();
    expect(verzonden).toHaveLength(0);
  });
});

// ===== #322: eerlijk melden of er iets vertrekt =====

describe('#322 notifyPasswordReset meldt of er een mail vertrekt', () => {
  beforeEach(() => { leeg(); instellingen.waarde = null; });

  test('zonder e-mailadres vertrekt er niets en dat wordt gemeld', async () => {
    const gelukt = await email.notifyPasswordReset({ name: 'Jan', email: null });
    await laatBezinken();
    expect(gelukt).toBe(false);
    expect(verzonden).toHaveLength(0);
  });

  test('de mail bevat geen wachtwoord, enkel de melding dat er gereset is', async () => {
    const gelukt = await email.notifyPasswordReset({ name: 'Jan', email: 'jan@test.be' });
    await laatBezinken();
    expect(gelukt).toBe(true);
    expect(verzonden[0].html).toContain('gereset door een administrator');
    expect(verzonden[0].html).toContain('persoonlijk mee');
  });
});
