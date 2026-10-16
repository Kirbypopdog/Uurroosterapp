'use strict';

// #396: een CDN-verwijzing zonder bestandspad laat de CDN zelf kiezen welk
// bestand uit het npm-pakket hij serveert, en die keuze verschilt per CDN.
// `https://unpkg.com/lucide@0.577.0` gaf de browserbundel, maar de terugval
// `https://cdn.jsdelivr.net/npm/lucide@0.577.0` gaf de CommonJS-bundel — en die
// bevat een `const Infinity` op het hoogste niveau, wat als gewoon <script>
// botst met de globale `Infinity`. De hele bundel faalde dan met een
// SyntaxError, zonder dat `onerror` afging, want de download zelf was gelukt.
//
// Deze test leest index.html als TEKST. Verhuist dat bestand ooit, dan moet
// deze test mee.

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'frontend', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

// De pakket-CDN's waar het zonder pad misgaat. Google Fonts hoort hier niet
// bij: dat is geen npm-pakket en de URL draagt zijn eigen queryparameters.
const PAKKET_CDNS = ['unpkg.com', 'cdn.jsdelivr.net/npm', 'cdn.skypack.dev', 'esm.sh'];

function cdnBronnen() {
  const bronnen = [];
  const re = /(?:src|s\.src)\s*=\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (PAKKET_CDNS.some(c => url.includes(c))) bronnen.push(url);
  }
  return bronnen;
}

describe('scripts van een pakket-CDN', () => {
  test('er staan er, anders meet deze test niets', () => {
    expect(cdnBronnen().length).toBeGreaterThan(0);
  });

  test('elke verwijzing noemt een bestandspad, niet alleen pakket@versie', () => {
    for (const url of cdnBronnen()) {
      const na = url.split(/unpkg\.com\/|cdn\.jsdelivr\.net\/npm\/|cdn\.skypack\.dev\/|esm\.sh\//)[1] || '';
      // Na "pakket@versie" moet er nog een "/bestand" volgen.
      expect(`${url} -> ${na}`).toMatch(/@[^/]+\/.+\.(js|mjs|css)$/);
    }
  });

  test('elke verwijzing pint een exacte versie, geen latest of bereik', () => {
    for (const url of cdnBronnen()) {
      expect(url).toMatch(/@\d+\.\d+\.\d+\//);
      expect(url).not.toMatch(/@(latest|next|\^|~)/);
    }
  });

  test('de pagina valt terug op no-lucide als de bundel niet uitvoert', () => {
    // onerror dekt alleen een mislukte download. Zonder deze controle blijft de
    // pagina bij een bundel die wel binnenkomt maar stukloopt in geen van beide
    // toestanden staan: geen iconen en geen terugvalopmaak.
    expect(html).toMatch(/typeof window\.lucide === 'undefined'/);
    expect(html).toMatch(/classList\.add\('no-lucide'\)/);
  });
});
