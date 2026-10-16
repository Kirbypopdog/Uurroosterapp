'use strict';

// #399: de vakantieverantwoordelijke wordt in de ROOSTERBOUWER aangeduid, per
// week. Drie dingen liepen daar mis, en samen leverden ze een scherm op dat
// zichzelf tegensprak:
//
//  1. De keuzelijst in de bouwer bevat alleen ACTIEVE medewerkers. Stond er
//     iemand aangeduid die intussen weg was, dan vond geen enkele <option> dat
//     id en viel de lijst terug op "Geen" — terwijl de waarde bleef staan. Het
//     scherm zei "niemand", de planning toonde de vertrokken collega.
//  2. Instellingen zette een vakantieweek onder zijn WEEKENDdatums, dus een
//     week die je als 28 dec – 3 jan aanduidde verscheen daar als 2 jan – 3 jan.
//  3. De badge "vakantie" keek naar `responsibleId`, het oude veld met één
//     persoon per hele periode, dat de bouwer nooit vult.

global.window = { DEFAULT_SETTINGS: {} };
global.DataStore = { settings: {}, users: [] };

const regels = require('../../frontend/verantwoordelijke-regels.js');

// De echte kerstvakantie uit productie: maandag 21 december tot en met
// zondag 3 januari, precies twee weken.
const KERST = {
  id: 1776772227703, name: 'Kerstvakantie',
  startDate: '2026-12-21', endDate: '2027-01-03',
  weeklyResponsibles: { '1': '112', '2': '123' }
};

const PLOEG = [
  { id: 112, name: 'Victor', role: 'roosterverantwoordelijke', active: true, mainTeam: 'vlot2' },
  { id: 123, name: 'Jill Dias', role: 'medewerker', active: false, mainTeam: 'vlot1' },
  { id: 156, name: 'Yana', role: 'medewerker', active: true, mainTeam: 'vlot1' }
];

const ctx = (weekStart) => ({
  weekStart,
  medewerkers: PLOEG,
  rotatie: { rotationStart: '2026-08-31', rotationStartEmployee: '112', eligibleTeams: ['vlot1', 'vlot2'], assignments: {} },
  vakantieperiodes: [KERST],
  roosterpatroon: { cycleLength: 2, referenceDate: '2026-08-31',
                    weeks: { '1': { closedDays: [] }, '2': { closedDays: [6, 0] } } },
  referentieDatumTweewekelijks: null
});

// ===== 2 en 3: wat het scherm moet kunnen weten =====

describe('de uitleg die Instellingen nodig heeft', () => {
  test('week 1 is een vakantieweek en noemt de vakantie bij naam', () => {
    const u = regels.uitleg(ctx('2026-12-21'));
    expect(u.reden).toBe('vakantieweek');
    expect(u.vakantie).toBe('Kerstvakantie');
    expect(u.vakantieWeek).toBe(1);
    expect(u.persoon.name).toBe('Victor');
  });

  test('week 2 is de week van 28 december, niet van 2 januari', () => {
    const u = regels.uitleg(ctx('2026-12-28'));
    expect(u.vakantieWeek).toBe(2);
    expect(u.persoon.name).toBe('Jill Dias');
  });

  // Dit is waar de badge op moet steunen. `responsibleId` staat er niet eens
  // in: de bouwer vult dat veld nooit.
  test('de uitleg zegt het zonder het oude responsibleId-veld', () => {
    expect(KERST.responsibleId).toBeUndefined();
    expect(regels.uitleg(ctx('2026-12-28')).reden).toBe('vakantieweek');
  });

  test('een gewone week is géén vakantieweek', () => {
    expect(regels.uitleg(ctx('2027-01-04')).reden).not.toBe('vakantieweek');
  });

  // Een vakantieweek is uitgepraat: staat er niemand, dan is er niemand, en
  // valt het bewust NIET terug op de rotatie.
  test('een vakantieweek zonder aanduiding levert niemand op', () => {
    const c = ctx('2026-12-28');
    c.vakantieperiodes = [Object.assign({}, KERST, { weeklyResponsibles: { '1': '112' } })];
    const u = regels.uitleg(c);
    expect(u.persoon).toBeNull();
    expect(u.reden).toBe('vakantieweek-niemand-aangeduid');
  });
});

// ===== 1: het opruimen in de bouwer =====

describe('vertrokken verantwoordelijken opruimen', () => {
  let bewaard, meldingen;

  beforeEach(() => {
    bewaard = [];
    meldingen = [];
    global.AppState = {};
    global.DataStore = { settings: { holidayPeriods: [] }, users: PLOEG };
    global.getAllEmployees = (actiefOnly) => DataStore.users
      .filter(u => u.role !== 'admin' && (!actiefOnly || u.active !== false));
    global.getEmployee = (id) => DataStore.users.find(u => String(u.id) === String(id)) || null;
    global.saveSettings = async (sleutel, waarde) => { bewaard.push({ sleutel, waarde }); };
    global.showToast = (tekst, soort) => { meldingen.push({ tekst, soort }); };
    jest.resetModules();
  });

  const laad = () => require('../../frontend/app-builder.js').ruimVertrokkenVakantieVerantwoordelijkenOp;

  test('de aanduiding van iemand die weg is wordt gewist en gemeld', async () => {
    const periode = JSON.parse(JSON.stringify(KERST));
    DataStore.settings.holidayPeriods = [periode];
    await laad()(periode);

    expect(periode.weeklyResponsibles).toEqual({ '1': '112' });
    expect(bewaard).toHaveLength(1);
    expect(bewaard[0].sleutel).toBe('holidayPeriods');
    expect(meldingen[0].soort).toBe('warning');
    // De NAAM hoort in de melding: anders weet je niet wie je moet vervangen.
    expect(meldingen[0].tekst).toContain('Jill Dias');
    expect(meldingen[0].tekst).toContain('week 2');
  });

  test('wie nog meedraait blijft ongemoeid', async () => {
    const periode = { name: 'K', startDate: '2026-12-21', endDate: '2027-01-03',
                      weeklyResponsibles: { '1': '112', '2': '156' } };
    DataStore.settings.holidayPeriods = [periode];
    await laad()(periode);
    expect(periode.weeklyResponsibles).toEqual({ '1': '112', '2': '156' });
    expect(bewaard).toHaveLength(0);
    expect(meldingen).toHaveLength(0);
  });

  // De belangrijkste waarborg. Zonder deze controle zou een mislukte lading van
  // de medewerkerslijst iedereen "onbekend" maken en de hele periode leegvegen.
  test('met een lege medewerkerslijst wordt er NIETS gewist', async () => {
    DataStore.users = [];
    const periode = JSON.parse(JSON.stringify(KERST));
    DataStore.settings.holidayPeriods = [periode];
    await laad()(periode);
    expect(periode.weeklyResponsibles).toEqual({ '1': '112', '2': '123' });
    expect(bewaard).toHaveLength(0);
  });

  test('een id dat helemaal niet meer bestaat wordt ook gewist', async () => {
    const periode = { name: 'K', startDate: '2026-12-21', endDate: '2027-01-03',
                      weeklyResponsibles: { '1': '999' } };
    DataStore.settings.holidayPeriods = [periode];
    await laad()(periode);
    expect(periode.weeklyResponsibles).toEqual({});
    expect(meldingen[0].tekst).toContain('onbekend (999)');
  });

  // Het schrijven mag maar één keer gebeuren: daarna is de waarde weg en vindt
  // een volgende render niets meer. Anders levert elke render een opslag op.
  test('een tweede keer draaien schrijft niets meer', async () => {
    const periode = JSON.parse(JSON.stringify(KERST));
    DataStore.settings.holidayPeriods = [periode];
    const fn = laad();
    await fn(periode);
    await fn(periode);
    expect(bewaard).toHaveLength(1);
  });

  test('een periode zonder aanduidingen doet niets', async () => {
    const periode = { name: 'K', startDate: '2026-12-21', endDate: '2027-01-03' };
    await laad()(periode);
    expect(bewaard).toHaveLength(0);
  });

  // Een mislukte opslag mag het scherm niet laten crashen.
  test('mislukt het opslaan, dan gooit het niet', async () => {
    global.saveSettings = async () => { throw new Error('netwerk weg'); };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const periode = JSON.parse(JSON.stringify(KERST));
    DataStore.settings.holidayPeriods = [periode];
    await expect(laad()(periode)).resolves.toBeUndefined();
    console.error.mockRestore();
  });
});
