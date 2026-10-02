/**
 * #157: een net onder het opsplitsen van server.js.
 *
 * De opsplitsing verplaatst 77 routes naar aparte modules. Het risico daarbij
 * is niet dat een handler stuk gaat, want die verhuist ongewijzigd, maar dat
 * een route ONDERWEG VERDWIJNT of op een ander pad terechtkomt. Dat merk je
 * pas in productie, want de integratietests raken ongeveer de helft van de
 * endpoints.
 *
 * Deze test leest uit welke paden Express werkelijk kent en vergelijkt die met
 * een vaste lijst. Verplaatsen mag; verliezen niet.
 *
 * Komt er bewust een endpoint bij of gaat er een weg, dan hoort de lijst
 * hieronder in dezelfde commit mee te veranderen.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testgeheim';
jest.mock('../src/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));

const app = require('../src/server');

function geregistreerdePaden(stack, voorvoegsel = '') {
  const uit = [];
  for (const laag of stack) {
    if (laag.route) {
      for (const methode of Object.keys(laag.route.methods)) {
        uit.push(`${methode.toUpperCase()} ${voorvoegsel}${laag.route.path}`);
      }
    } else if (laag.handle && laag.handle.stack) {
      // Het montagepad staat als reguliere expressie op de laag. Voor een
      // router zonder eigen pad is dat de uitdrukking voor "de wortel".
      const bron = (laag.regexp && laag.regexp.source) || '';
      const isWortel = bron === '^\\/?(?=\\/|$)';
      const pad = isWortel ? '' : bron
        .replace(/^\^/, '')
        .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
        .replace(/\\\//g, '/');
      uit.push(...geregistreerdePaden(laag.handle.stack, voorvoegsel + pad));
    }
  }
  return uit;
}

// De volledige lijst, vastgelegd vóór de opsplitsing begon.
const VERWACHT = require('./routes-inventaris.json');

describe('#157 alle routes blijven bestaan bij het opsplitsen van server.js', () => {
  const gevonden = geregistreerdePaden(app._router.stack).sort();

  test('de router hangt onder /api/v1 en op de wortel, dus elk pad twee keer', () => {
    const onderV1 = gevonden.filter(p => p.includes(' /api/v1/'));
    const opWortel = gevonden.filter(p => !p.includes(' /api/v1/'));
    expect(onderV1).toHaveLength(opWortel.length);
    expect(onderV1.length).toBeGreaterThan(0);
  });

  test('geen enkel pad is verdwenen', () => {
    const kwijt = VERWACHT.filter(p => !gevonden.includes(p));
    expect(kwijt).toEqual([]);
  });

  test('er is geen pad bijgekomen dat niet in de lijst staat', () => {
    const nieuw = gevonden.filter(p => !VERWACHT.includes(p));
    expect(nieuw).toEqual([]);
  });

  test('het aantal klopt', () => {
    expect(gevonden).toHaveLength(VERWACHT.length);
  });
});
