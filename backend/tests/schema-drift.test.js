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
// #157: de migraties stonden in server.js en staan nu in migraties.js.
const migratiesJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'migraties.js'), 'utf8');

// Alleen het stuk tot aan het einde van de MIGRATIONS-array, zodat andere
// queries in dat bestand niet meetellen.
const migratieBlok = migratiesJs.slice(
  migratiesJs.indexOf('const MIGRATIONS'),
  migratiesJs.indexOf('async function runMigrations')
);

function genormaliseerd(tekst) {
  return tekst.toLowerCase().replace(/\s+/g, ' ');
}

// #315: een kolom die een migratie toevoegt en een latere migratie weer dropt,
// hoort juist NIET in schema.sql te staan. Zonder deze uitzondering meldt de
// test die als drift, terwijl het net goed zit.
function gedropteKolommen(blok) {
  const weg = new Set();
  const regex = /alter\s+table\s+(\w+)\s+drop\s+column\s+(?:if\s+exists\s+)?(\w+)/gi;
  let m;
  while ((m = regex.exec(blok)) !== null) weg.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  return weg;
}

describe('#329 schema.sql loopt niet achter op de migraties', () => {
  test('elke kolom die een migratie toevoegt staat ook in schema.sql', () => {
    const schema = genormaliseerd(schemaSql);
    const gedropt = gedropteKolommen(migratieBlok);
    const regex = /alter\s+table\s+(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
    const ontbreekt = [];
    let m;
    while ((m = regex.exec(migratieBlok)) !== null) {
      const tabel = m[1].toLowerCase();
      const kolom = m[2].toLowerCase();
      if (gedropt.has(`${tabel}.${kolom}`)) continue;
      // De kolomnaam moet ergens in schema.sql staan. Dat is grof, maar een
      // kolom die nergens in het bestand voorkomt is zeker drift.
      if (!new RegExp(`\\b${kolom}\\b`).test(schema)) ontbreekt.push(`${tabel}.${kolom}`);
    }
    expect(ontbreekt).toEqual([]);
  });

  // De andere kant op: een kolom die een migratie dropt mag niet blijven staan
  // in schema.sql, anders levert een verse database hem alsnog op.
  test('een kolom die een migratie dropt staat niet meer in schema.sql', () => {
    const blijftStaan = [];
    for (const naam of gedropteKolommen(migratieBlok)) {
      const [tabel, kolom] = naam.split('.');
      const blok = new RegExp(
        `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${tabel}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'
      ).exec(schemaSql);
      if (!blok) continue;
      const heeftKolom = blok[1].split('\n')
        .filter(r => !r.trim().startsWith('--'))
        .some(r => new RegExp(`^\\s*${kolom}\\s`, 'i').test(r));
      if (heeftKolom) blijftStaan.push(naam);
    }
    expect(blijftStaan).toEqual([]);
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

  // #409: migratie 049 zette een trigger en een functie op `shifts`, en die
  // vielen buiten de vier controles hierboven — die kijken naar kolommen,
  // indexen, constraints en tabellen. Een trigger die alleen in de migratie
  // staat betekent dat een VERSE database hem mist, en dan loopt `updated_at`
  // daar stil achter zonder dat iets het meldt.
  test('elke trigger en functie die een migratie aanmaakt staat ook in schema.sql', () => {
    const schema = genormaliseerd(schemaSql);
    // #410: dezelfde uitzondering als bij de kolommen hierboven. Migratie 049
    // maakte `shifts_zet_updated_at` en 050 hernoemde die naar `zet_updated_at`
    // en liet de oude vallen. Zo'n functie hoort juist NIET meer in schema.sql.
    const weg = new Set();
    const dropRegex = /drop\s+(trigger|function)\s+(?:if\s+exists\s+)?(\w+)/gi;
    let d;
    while ((d = dropRegex.exec(migratieBlok)) !== null) weg.add(d[2].toLowerCase());

    const ontbreekt = [];
    const regex = /create\s+(?:or\s+replace\s+)?(trigger|function)\s+(\w+)/gi;
    let m;
    while ((m = regex.exec(migratieBlok)) !== null) {
      const naam = m[2].toLowerCase();
      // Een trigger wordt vlak voor zijn CREATE gedropt; dat telt niet als
      // "weggehaald". Alleen wat NERGENS meer aangemaakt wordt, mag ontbreken.
      const wordtLaterNogGemaakt = new RegExp(
        `create\\s+(?:or\\s+replace\\s+)?(?:trigger|function)\\s+${naam}\\b`, 'i'
      ).test(migratieBlok.slice(m.index + m[0].length));
      if (weg.has(naam) && !wordtLaterNogGemaakt && !schema.includes(naam)) continue;
      if (!schema.includes(naam)) ontbreekt.push(`${m[1].toLowerCase()} ${naam}`);
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
