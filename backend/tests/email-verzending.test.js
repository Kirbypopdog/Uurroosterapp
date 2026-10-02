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
