'use strict';

// #407: een concept toepassen mocht geen tweede Teamvergadering naast de
// bestaande zetten.
//
// De opruiming in draft-apply.js begrenst op `draft_id`. Vergaderingen van
// vóór migratie 038 hebben dat veld niet — in productie 869 stuks, waarvan 324
// in de toekomst — dus die werden niet gevonden en kregen er een dubbele bij.
//
// Deze test leest de route als TEKST, net als schema-drift.test.js en
// routes-inventaris.test.js. Wat hier bewaakt wordt is niet een uitkomst maar
// een VOLGORDE en een SLEUTEL, en allebei zijn ze met het oog op de verkeerde
// kant te "vereenvoudigen".
const fs = require('fs');
const path = require('path');

const BRON = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'draft-apply.js'), 'utf8');

// Commentaar eruit: anders leest de test de uitleg die hierboven staat mee.
const CODE = BRON.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('geen dubbele teamvergaderingen bij het toepassen van een concept', () => {
  test('er wordt opgeruimd op persoon, dag en uur', () => {
    expect(CODE).toMatch(/\(user_id,\s*date,\s*start_time,\s*end_time\)\s*\n?\s*IN \(SELECT/);
  });

  test('die opruiming geldt alleen voor vergaderingen', () => {
    const stuk = CODE.slice(CODE.indexOf('(user_id, date, start_time, end_time)') - 400,
                            CODE.indexOf('(user_id, date, start_time, end_time)'));
    expect(stuk).toContain("type = 'vergadering'");
  });

  test('ze staat VOOR het invoegen, niet erna', () => {
    // Andersom zou ze de rijen wissen die ze net heeft aangemaakt.
    const delete_ = CODE.indexOf('(user_id, date, start_time, end_time)');
    const insert = CODE.indexOf('INSERT INTO shift_activities');
    expect(delete_).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(-1);
    expect(delete_).toBeLessThan(insert);
  });

  test('er wordt niet op de omschrijving gegokt', () => {
    // In #376 bewust afgewezen: een met de hand ingevoerde vergadering kan
    // net zo goed "Teamvergadering" heten, en die mag niet gewist worden.
    expect(CODE).not.toMatch(/description\s*=\s*'Teamvergadering'/);
    expect(CODE).not.toMatch(/description\s*(LIKE|ILIKE)/i);
  });

  test('de oude opruiming op draft_id blijft bestaan', () => {
    // Die is nodig voor het omgekeerde geval: haal je een vergaderregel uit
    // het concept weg, dan is er niets meer om in te voegen en ruimt alleen
    // deze de oude rijen op.
    expect(CODE).toMatch(/DELETE FROM shift_activities[\s\S]{0,200}draft_id = \$3/);
  });

  test('nieuwe vergaderingen dragen nog steeds een draft_id', () => {
    const inserts = CODE.match(/INSERT INTO shift_activities[\s\S]{0,200}?draft_id/g) || [];
    expect(inserts.length).toBe(2); // met en zonder shift_id (migratie 020)
  });
});
