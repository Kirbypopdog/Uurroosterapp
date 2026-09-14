'use strict';

// #225: de samenvattende overnamemail bij een ziek- of verlofmelding.
//
// email.js maakt zijn Resend-client aan bij het laden en verstuurt alleen als
// RESEND_API_KEY gezet is. Om te kunnen zien wát er verstuurd wordt, mocken we
// het resend-pakket en zetten we de sleutel vóór het requiren van de module.

const verzonden = [];

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn(async (opts) => { verzonden.push(opts); return { data: { id: 'test' } }; })
    }
  }))
}));

jest.mock('../src/db', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) }
}));

process.env.RESEND_API_KEY = 'test-key';
process.env.EMAIL_FROM = 'test@hetvlot.be';

const { notifyTakeoverBatchAvailable } = require('../src/email');

const melder = { id: 1, name: 'Anna Proef', email: 'anna@test.be' };
const shifts = [
  { date: '2026-09-14', start_time: '09:00', end_time: '17:00', team: 'vlot1' },
  { date: '2026-09-15', start_time: '09:00', end_time: '17:00', team: 'vlot1' },
  { date: '2026-09-16', start_time: '09:00', end_time: '17:00', team: 'vlot1' },
];
const leden = [
  { id: 1, name: 'Anna Proef', email: 'anna@test.be', email_notifications_enabled: true },
  { id: 2, name: 'Bram Proef', email: 'bram@test.be', email_notifications_enabled: true },
  { id: 3, name: 'Carla Proef', email: 'carla@test.be', email_notifications_enabled: false },
  { id: 4, name: 'Dirk Proef', email: 'dirk@test.be', email_notifications_enabled: true },
];

// sendEmailAsync roept sendEmail aan zonder te awaiten, dus even laten landen.
const laatBezinken = () => new Promise(r => setTimeout(r, 10));

describe('notifyTakeoverBatchAvailable', () => {
  beforeEach(() => { verzonden.length = 0; });

  test('stuurt één mail per ontvanger, niet één per dienst', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'ziek');
    await laatBezinken();
    // Drie diensten, maar elke ontvanger krijgt er precies één over.
    expect(verzonden).toHaveLength(2);
    expect(verzonden.map(v => v.to).sort()).toEqual(['bram@test.be', 'dirk@test.be']);
  });

  test('slaat de melder zelf over', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'ziek');
    await laatBezinken();
    expect(verzonden.map(v => v.to)).not.toContain('anna@test.be');
  });

  test('slaat wie meldingen heeft uitgezet over', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'ziek');
    await laatBezinken();
    expect(verzonden.map(v => v.to)).not.toContain('carla@test.be');
  });

  test('noemt alle diensten in de mail', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'ziek');
    await laatBezinken();
    const html = verzonden[0].html;
    expect(html).toMatch(/14 september/);
    expect(html).toMatch(/15 september/);
    expect(html).toMatch(/16 september/);
  });

  test('het onderwerp telt de diensten bij meerdere', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'ziek');
    await laatBezinken();
    expect(verzonden[0].subject).toBe('3 diensten beschikbaar voor overname');
  });

  test('bij één dienst staat de datum in het onderwerp', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, [shifts[0]], 'ziek');
    await laatBezinken();
    expect(verzonden[0].subject).toMatch(/^Dienst beschikbaar: /);
  });

  test('noemt ziekte en verlof met de juiste aanleiding', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'ziek');
    await laatBezinken();
    expect(verzonden[0].html).toMatch(/is ziek gemeld/);

    verzonden.length = 0;
    await notifyTakeoverBatchAvailable(leden, melder, shifts, 'verlof');
    await laatBezinken();
    expect(verzonden[0].html).toMatch(/heeft verlof/);
  });

  test('stuurt niets zonder diensten', async () => {
    await notifyTakeoverBatchAvailable(leden, melder, [], 'ziek');
    await laatBezinken();
    expect(verzonden).toHaveLength(0);
  });

  test('stuurt niets zonder teamleden', async () => {
    await notifyTakeoverBatchAvailable([], melder, shifts, 'ziek');
    await laatBezinken();
    expect(verzonden).toHaveLength(0);
  });

  test('ontsnapt de naam van de melder', async () => {
    await notifyTakeoverBatchAvailable(leden, { id: 9, name: '<b>Hacker</b>', email: 'h@test.be' }, shifts, 'ziek');
    await laatBezinken();
    expect(verzonden[0].html).toContain('&lt;b&gt;Hacker&lt;/b&gt;');
    expect(verzonden[0].html).not.toContain('<b>Hacker</b>');
  });
});
