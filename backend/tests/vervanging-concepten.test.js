'use strict';

// #395: de vervangroute herschrijft ook de ROOSTERCONCEPTEN — in elk grid komt
// het id van de vervanger in de plaats van dat van de vertrekker. De bouwer
// leest die concepten niet opnieuw op, maar uit DataStore, en die kopie werd na
// een vervanging niet ververst. Het raster bleef dus het oude id tonen; dat is
// intussen van een gedeactiveerde medewerker en krijgt geen rij meer, terwijl
// de vervanger er met een lege week bij stond.
//
// data.js is een browserbestand. De aanroepen gaan door dataApiFetch, die
// `fetch` en `window.API_BASE` gebruikt; allebei worden hier nagemaakt zodat
// replaceEmployee echt draait in plaats van dat we de bronregel natellen.

const ANTWOORDEN = {
  '/admin/users/123/replace': { ok: true, draftsUpdated: 2, shiftsTransferred: 7 },
  '/users': { users: [{ id: 156, name: 'Yana' }] },
  '/shifts': { shifts: [] },
  '/availability': { availability: [] },
  '/shift-activities': { activities: [] },
  '/schedule-drafts': {
    drafts: [{ id: 'd1', name: '2026-2027', grid: { _multiWeek: true, 1: { 156: { 0: {} } } } }]
  },
};

const opgevraagd = [];

global.window = { DEFAULT_SETTINGS: {}, API_BASE: 'http://test' };
global.fetch = async (url) => {
  const pad = String(url).replace('http://test', '').split('?')[0];
  opgevraagd.push(pad);
  const body = ANTWOORDEN[pad];
  if (!body) throw new Error(`Onverwacht pad in test: ${pad}`);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
};

const { DataStore, replaceEmployee } = require('../../frontend/data.js');

describe('vervanging ververst de conceptencache', () => {
  beforeEach(() => {
    opgevraagd.length = 0;
    // Zoals het was vóór de vervanging: het grid staat nog op de vertrekker.
    DataStore.settings.schedule_drafts = [
      { id: 'd1', name: '2026-2027', grid: { _multiWeek: true, 1: { 123: { 0: {} } } } }
    ];
  });

  test('de concepten worden opnieuw opgehaald', async () => {
    await replaceEmployee(123, 156);
    expect(opgevraagd).toContain('/schedule-drafts');
  });

  test('het grid in DataStore staat daarna op de vervanger', async () => {
    await replaceEmployee(123, 156);
    const grid = DataStore.settings.schedule_drafts[0].grid;
    expect(Object.keys(grid['1'])).toEqual(['156']);
  });

  test('een mislukte verversing laat de oude lijst staan en gooit niet', async () => {
    const echt = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/schedule-drafts')) throw new Error('netwerk weg');
      return echt(url);
    };
    await expect(replaceEmployee(123, 156)).resolves.toBeDefined();
    expect(DataStore.settings.schedule_drafts[0].grid['1']['123']).toBeDefined();
    global.fetch = echt;
  });
});
