'use strict';

// #156: deze tests gaan over één vraag: wat verlaat het huis?
//
// De app houdt ziekmeldingen bij, en gezondheidsgegevens zijn een bijzondere
// categorie onder de AVG (#152). Een foutrapport mag die niet meedragen, ook
// niet naar de EU-regio van Sentry. Dit bestand legt vast wat er gefilterd
// wordt; gaat dat ooit stuk, dan lekt er iets zonder dat iemand het ziet.

const { schoonEvent, schoonDiep, isVerboden, initMonitoring } = require('../src/monitoring');

describe('isVerboden herkent gevoelige sleutels', () => {
  test.each([
    'password', 'password_hash', 'authorization', 'token', 'jwt', 'cookie',
    'email', 'name', 'reason', 'absence_reason', 'availabilityReason',
    'requested_status', 'ical_feed_token'
  ])('"%s" is verboden', sleutel => {
    expect(isVerboden(sleutel)).toBe(true);
  });

  test.each(['date', 'shiftId', 'status_code', 'team', 'startTime', 'url'])(
    '"%s" mag blijven', sleutel => {
      expect(isVerboden(sleutel)).toBe(false);
    });
});

describe('schoonEvent haalt persoonsgegevens eruit', () => {
  test('van de gebruiker blijft alleen het id over', () => {
    const uit = schoonEvent({ user: { id: 7, email: 'anna@hetvlot.be', username: 'anna', ip_address: '1.2.3.4' } });
    expect(uit.user).toEqual({ id: '7' });
  });

  test('een gebruiker zonder id verdwijnt helemaal', () => {
    const uit = schoonEvent({ user: { email: 'anna@hetvlot.be' } });
    expect(uit.user).toBeUndefined();
  });

  test('van het verzoek blijven alleen methode en url over', () => {
    const uit = schoonEvent({
      request: {
        method: 'POST', url: 'https://x/api/v1/availability',
        headers: { authorization: 'Bearer geheim' },
        cookies: { sessie: 'abc' },
        data: { type: 'ziek', reason: 'griep' }
      }
    });
    expect(uit.request).toEqual({ method: 'POST', url: 'https://x/api/v1/availability' });
  });

  // Het geval waar het echt om gaat.
  test('een ziekmelding in extra laat geen type of reden achter', () => {
    const uit = schoonEvent({
      extra: {
        payload: { userId: 2, date: '2026-05-06', type: 'ziek', reason: 'griep, ziekenhuisopname' },
        shiftId: 41
      }
    });
    expect(JSON.stringify(uit)).not.toContain('griep');
    expect(JSON.stringify(uit)).not.toContain('ziekenhuisopname');
    // wat niets prijsgeeft mag blijven, anders is een fout niet meer te plaatsen
    expect(uit.extra.payload.userId).toBe(2);
    expect(uit.extra.payload.date).toBe('2026-05-06');
    expect(uit.extra.shiftId).toBe(41);
  });

  test('een e-mailadres in een foutmelding wordt weggehaald', () => {
    const uit = schoonEvent({
      message: 'duplicate key value violates unique constraint: anna@hetvlot.be bestaat al',
      exception: { values: [{ value: 'Kan bram@hetvlot.be niet aanmaken' }] }
    });
    expect(uit.message).not.toContain('anna@hetvlot.be');
    expect(uit.exception.values[0].value).not.toContain('bram@hetvlot.be');
    // de rest van de melding blijft leesbaar, anders is ze nutteloos
    expect(uit.message).toContain('unique constraint');
  });

  test('variabelen in een stacktrace worden mee geschoond', () => {
    const uit = schoonEvent({
      exception: { values: [{ stacktrace: { frames: [{ vars: { reason: 'burn-out', date: '2026-05-06' } }] } }] }
    });
    const frame = uit.exception.values[0].stacktrace.frames[0];
    expect(frame.vars.reason).toBe('[weggelaten]');
    expect(frame.vars.date).toBe('2026-05-06');
  });

  test('breadcrumbs en tags gaan door dezelfde zeef', () => {
    const uit = schoonEvent({
      breadcrumbs: [{ data: { email: 'x@y.be', url: '/shifts' } }],
      tags: { name: 'Anna Proef', team: 'vlot1' }
    });
    expect(uit.breadcrumbs[0].data.email).toBe('[weggelaten]');
    expect(uit.breadcrumbs[0].data.url).toBe('/shifts');
    expect(uit.tags.name).toBe('[weggelaten]');
    expect(uit.tags.team).toBe('vlot1');
  });
});

// Gevonden door de probe tegen de echte Sentry-pijplijn: het veld `type` bleef
// staan met de waarde 'ziek'. Dat is precies het gezondheidsgegeven waar #152
// over gaat. De sleutel `type` kan niet blind verboden worden, want Sentry
// gebruikt hem zelf voor de soort fout, dus de filtering kijkt hier naar de
// WAARDE.
describe('gevoelige waarden gaan weg, ook onder een onschuldige sleutel (#152)', () => {
  test.each(['ziek', 'verlof', 'overuren', 'vorming', 'zeker_niet', 'liever_niet'])(
    'de waarde "%s" wordt weggelaten', waarde => {
      const uit = schoonDiep({ type: waarde });
      expect(uit.type).toBe('[weggelaten]');
    });

  test('de soort fout van Sentry blijft wel staan', () => {
    expect(schoonDiep({ type: 'Error' }).type).toBe('Error');
    expect(schoonDiep({ type: 'TypeError' }).type).toBe('TypeError');
  });

  test('een ziekmelding laat nergens een spoor', () => {
    const uit = schoonEvent({
      extra: { payload: { userId: 2, date: '2026-05-06', type: 'ziek', reason: 'griep' } }
    });
    const tekst = JSON.stringify(uit);
    expect(tekst).not.toContain('ziek');
    expect(tekst).not.toContain('griep');
    expect(tekst).toContain('2026-05-06');
  });
});

// Ook gevonden door de probe: "name" blind wissen maakte van contexts.runtime.name
// ("node") en contexts.os.name ("Linux") een [weggelaten]. Dat kost informatie
// zonder iets te beschermen.
describe('de eigen context van de SDK blijft leesbaar', () => {
  test('runtime en os houden hun naam', () => {
    const uit = schoonEvent({
      contexts: { runtime: { name: 'node', version: 'v22' }, os: { name: 'Linux' } }
    });
    expect(uit.contexts.runtime.name).toBe('node');
    expect(uit.contexts.os.name).toBe('Linux');
  });

  test('maar een context die de app zelf zet gaat wel door de zeef', () => {
    const uit = schoonEvent({
      contexts: { afwezigheid: { reason: 'griep', date: '2026-05-06' } }
    });
    expect(uit.contexts.afwezigheid.reason).toBe('[weggelaten]');
    expect(uit.contexts.afwezigheid.date).toBe('2026-05-06');
  });
});

describe('schoonDiep blijft overeind bij rare invoer', () => {
  test('een cyclus laat hem niet vastlopen', () => {
    const a = { naam: 'x' };
    a.zelf = a;
    expect(() => schoonDiep(a)).not.toThrow();
  });

  test('null en primitieven gaan er ongeschonden doorheen', () => {
    expect(schoonDiep(null)).toBeNull();
    expect(schoonDiep(42)).toBe(42);
    expect(schoonDiep('gewone tekst')).toBe('gewone tekst');
  });

  test('arrays worden per element geschoond', () => {
    const uit = schoonDiep([{ reason: 'ziek' }, { date: '2026-01-01' }]);
    expect(uit[0].reason).toBe('[weggelaten]');
    expect(uit[1].date).toBe('2026-01-01');
  });
});

describe('zonder DSN gebeurt er niets', () => {
  test('initMonitoring geeft false terug en start niets', () => {
    const oud = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    expect(initMonitoring()).toBe(false);
    if (oud !== undefined) process.env.SENTRY_DSN = oud;
  });
});
