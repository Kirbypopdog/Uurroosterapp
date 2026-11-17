'use strict';

// "Wat is er nieuw": één keer na een update, per gebruiker, en altijd terug te
// lezen via de knop in de zijbalk.
const fs = require('fs');
const path = require('path');

global.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const { PATCH_NOTES, moetPatchNotesTonen, patchNotesHtml, patchNotesSleutel } = require('../../frontend/patchnotes.js');

const F = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');

describe('wanneer het venster verschijnt', () => {
  test('wie de huidige versie nog niet zag, krijgt hem', () => {
    expect(moetPatchNotesTonen(PATCH_NOTES, null)).toBe(true);
    expect(moetPatchNotesTonen(PATCH_NOTES, 'een-oudere-versie')).toBe(true);
  });

  test('wie hem al zag, krijgt hem niet opnieuw', () => {
    expect(moetPatchNotesTonen(PATCH_NOTES, PATCH_NOTES[0].versie)).toBe(false);
  });

  test('een nieuwe versie bovenaan verschijnt opnieuw', () => {
    const nieuw = [{ ...PATCH_NOTES[0], versie: 'later' }, ...PATCH_NOTES];
    expect(moetPatchNotesTonen(nieuw, PATCH_NOTES[0].versie)).toBe(true);
  });

  test('zonder notities nooit', () => {
    expect(moetPatchNotesTonen([], null)).toBe(false);
  });

  test('gezien wordt per gebruiker bijgehouden', () => {
    expect(patchNotesSleutel(3)).not.toBe(patchNotesSleutel(7));
  });
});

describe('de inhoud', () => {
  test('elke versie is uniek en heeft secties met punten', () => {
    const versies = PATCH_NOTES.map(n => n.versie);
    expect(new Set(versies).size).toBe(versies.length);
    PATCH_NOTES.forEach(n => {
      expect(n.secties.length).toBeGreaterThan(0);
      n.secties.forEach(s => expect(s.punten.length).toBeGreaterThan(0));
    });
  });

  test('geen issuenummers: het is voor collega\'s, niet voor ontwikkelaars', () => {
    expect(JSON.stringify(PATCH_NOTES)).not.toMatch(/#\d{2,}/);
  });

  test('de tekst wordt ontsnapt', () => {
    const html = patchNotesHtml([{ versie: 'x', titel: 't', datum: 'd', secties: [{ kop: '<b>', punten: ['<script>'] }] }]);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('aangesloten in de app', () => {
  test('het script, het venster en de knop staan in index.html', () => {
    const html = F('index.html');
    expect(html).toMatch(/<script src="patchnotes\.js\?v=\w+"><\/script>/);
    expect(html).toContain('id="patchnotes-modal"');
    expect(html).toContain('id="patchnotes-btn"');
  });

  test('showApp toont het venster, met een typeof-wacht (#412)', () => {
    expect(F('app-auth.js')).toMatch(/if \(typeof toonPatchNotes === 'function'\) setTimeout\(\(\) => toonPatchNotes\(\), \d+\);/);
  });
});
