'use strict';

// Het vervangvenster na wat er met Bryan, Marie en Justine gebeurde: Marie →
// Bryan werd eerst ingesteld, de botsingsmelding raadde "Verwijderen" aan, en
// Bryans 121 Vlot 1-diensten verdwenen in plaats van naar Justine te gaan.
// Daarna zei de weigering "annuleer die overname", zonder knop om dat te doen.
const fs = require('fs');
const path = require('path');
const S = fs.readFileSync(path.join(__dirname, '../../frontend/app-settings.js'), 'utf8');
const D = fs.readFileSync(path.join(__dirname, '../../frontend/data.js'), 'utf8');
const venster = S.slice(S.indexOf('function showReplaceEmployeeModal'), S.indexOf('// ===== SETTINGS TAB: PLANNING'));

test('het venster toont geplande overnames met een knop om te annuleren', () => {
  expect(venster).toContain('id="replace-gepland"');
  expect(venster).toContain('replace-gepland-annuleer');
  expect(venster).toContain('annuleerGeplandeOvername(knop.dataset.id)');
  expect(D).toMatch(/async function annuleerGeplandeOvername\(id\)/);
  expect(D).toContain("method: 'DELETE'");
});

test('het venster zegt dat verhuisde diensten blijven staan', () => {
  expect(venster).toMatch(/De diensten die al verhuisd zijn, blijven staan waar ze nu staan/);
});

test('de botsingsmelding raadt Verwijderen niet meer blind aan', () => {
  expect(venster).not.toContain('Kies hierboven "Verwijderen" om de eigen diensten');
  expect(venster).toMatch(/Wisselt \$\{escapeHtml\(newUser\.name\)\} zelf van team/);
});

test('de bevestiging bij Verwijderen zegt hoeveel diensten er verdwijnen', () => {
  expect(venster).toMatch(/worden VERWIJDERD, niet overgedragen/);
});

test('na een volgorde-weigering verschijnt de annuleerknop meteen', () => {
  const blok = venster.slice(venster.indexOf('error.data.volgorde'));
  expect(blok.slice(0, 600)).toContain('await toonGeplandeOvernames()');
});
