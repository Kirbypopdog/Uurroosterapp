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

const lijst = S.slice(S.indexOf('function geplandeOvernamesHtml'), S.indexOf('function showReplaceEmployeeModal'));

test('het venster toont geplande overnames met Terugdraaien of Annuleren', () => {
  expect(venster).toContain('id="replace-gepland"');
  expect(venster).toContain('geplandeOvernamesHtml(relevant');
  expect(venster).toContain('bindGeplandeOvernameKnoppen(geplandEl');
  expect(lijst).toContain('o.kanTerugdraaien');
  expect(lijst).toContain('terugdraaiGeplandeOvername(knop.dataset.id)');
  expect(lijst).toContain('annuleerGeplandeOvername(knop.dataset.id)');
  expect(D).toMatch(/async function annuleerGeplandeOvername\(id\)/);
  expect(D).toMatch(/async function terugdraaiGeplandeOvername\(id\)/);
});

test('Annuleren zegt dat verhuisde diensten blijven staan', () => {
  expect(lijst).toMatch(/De diensten die al verhuisd zijn, blijven staan waar ze nu staan/);
});

test('de geplande overnames staan niet meer bij Accounts maar in de tab Personeelswissels', () => {
  expect(S).not.toContain('id="settings-gepland"');
  const W = fs.readFileSync(path.join(__dirname, '../../frontend/app-wissels.js'), 'utf8');
  expect(W).toContain('Losse geplande overnames');
});

test('terugdraaien meldt wat het NIET kon terugzetten', () => {
  expect(lijst).toContain('r.conceptenNietHersteld');
  expect(lijst).toContain('r.dienstenNietTerug');
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
