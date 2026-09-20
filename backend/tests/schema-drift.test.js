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

  // #311: migratie 042 zette een CHECK op availability.type, maar schema.sql
  // kreeg die niet mee. Een verse database miste hem dus, en de drie tests
  // hierboven zagen dat niet: ze kijken naar kolommen, indexen en tabellen.
  //
  // Een naam zoeken is hier niet genoeg. PostgreSQL noemt een naamloze CHECK
  // zelf "<tabel>_<kolom>_check" en een naamloze verwijzing
  // "<tabel>_<kolom>_fkey", dus schema.sql kan de constraint wel degelijk
  // hebben zonder dat die naam ergens in het bestand staat. Daarom wordt de
  // naam teruggerekend naar tabel en kolom, en kijken we of die kolomregel in
  // schema.sql de bijhorende clausule draagt.
  test('elke constraint die een migratie toevoegt staat ook in schema.sql', () => {
    const tabelBlokken = new Map();
    const tabelRegex = /create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi;
    let t;
    while ((t = tabelRegex.exec(schemaSql)) !== null) {
      tabelBlokken.set(t[1].toLowerCase(), t[2].toLowerCase());
    }
    const schema = genormaliseerd(schemaSql);

    const dektSchemaDit = (naam) => {
      if (schema.includes(naam)) return true; // expliciet zo genoemd
      const soort = naam.endsWith('_check') ? 'check' : naam.endsWith('_fkey') ? 'references' : null;
      if (!soort) return false;
      const zonderSuffix = naam.replace(/_(check|fkey)$/, '');
      // De langste tabelnaam die past, want tabelnamen bevatten zelf underscores
      const tabel = [...tabelBlokken.keys()]
        .filter(naamTabel => zonderSuffix.startsWith(naamTabel + '_'))
        .sort((a, b) => b.length - a.length)[0];
      if (!tabel) return false;
      const kolom = zonderSuffix.slice(tabel.length + 1);
      const kolomRegel = tabelBlokken.get(tabel)
        .split('\n')
        .find(regel => new RegExp(`^\\s*${kolom}\\s`).test(regel));
      return !!kolomRegel && kolomRegel.includes(soort);
    };

    const regex = /add\s+constraint\s+(\w+)/gi;
    const ontbreekt = [];
    let m;
    while ((m = regex.exec(migratieBlok)) !== null) {
      const naam = m[1].toLowerCase();
      if (!dektSchemaDit(naam)) ontbreekt.push(naam);
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
