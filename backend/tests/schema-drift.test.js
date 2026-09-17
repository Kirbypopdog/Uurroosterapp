'use strict';

// #329: schema.sql en de MIGRATIONS-array liepen uit elkaar. Vier objecten die
// de migraties opleverden stonden niet in schema.sql, en later kwamen er twee
// indexen bij die hetzelfde deden.
//
// Dit is een tekstcontrole, geen databankcontrole. Een echte vergelijking zou
// twee wegwerpdatabases vragen, en de rest van deze testsuite draait bewust
// zonder databank. Een tekstcontrole vangt wel precies de drift die hier
// optrad: een migratie die een kolom of index toevoegt zonder dat schema.sql
// meegaat.

const fs = require('fs');
const path = require('path');

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Alleen het stuk tot aan het einde van de MIGRATIONS-array, zodat gewone
// queries in de endpoints niet meetellen.
const migratieBlok = serverJs.slice(
  serverJs.indexOf('const MIGRATIONS'),
  serverJs.indexOf('async function runMigrations')
);

function genormaliseerd(tekst) {
  return tekst.toLowerCase().replace(/\s+/g, ' ');
}

describe('#329 schema.sql loopt niet achter op de migraties', () => {
  test('elke kolom die een migratie toevoegt staat ook in schema.sql', () => {
    const schema = genormaliseerd(schemaSql);
    const regex = /alter\s+table\s+(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
    const ontbreekt = [];
    let m;
    while ((m = regex.exec(migratieBlok)) !== null) {
      const tabel = m[1].toLowerCase();
      const kolom = m[2].toLowerCase();
      // De kolomnaam moet ergens in schema.sql staan. Dat is grof, maar een
      // kolom die nergens in het bestand voorkomt is zeker drift.
      if (!new RegExp(`\\b${kolom}\\b`).test(schema)) ontbreekt.push(`${tabel}.${kolom}`);
    }
    expect(ontbreekt).toEqual([]);
  });

  test('elke index die een migratie aanmaakt staat ook in schema.sql', () => {
    const schema = genormaliseerd(schemaSql);
    const regex = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)/gi;
    const ontbreekt = [];
    let m;
    while ((m = regex.exec(migratieBlok)) !== null) {
      const naam = m[1].toLowerCase();
      if (!schema.includes(naam)) ontbreekt.push(naam);
    }
    expect(ontbreekt).toEqual([]);
  });

  test('elke tabel die een migratie aanmaakt staat ook in schema.sql', () => {
    const schema = genormaliseerd(schemaSql);
    const regex = /create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
    const ontbreekt = [];
    let m;
    while ((m = regex.exec(migratieBlok)) !== null) {
      const naam = m[1].toLowerCase();
      if (!schema.includes(naam)) ontbreekt.push(naam);
    }
    expect(ontbreekt).toEqual([]);
  });
});
