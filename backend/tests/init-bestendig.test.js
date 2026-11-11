'use strict';

// #412: één ontbrekende functie legde de hele app plat.
//
// `setupEventListeners` in app-init.js riep `werkActiviteitDeelnemersBij` aan,
// een functie uit app-shifts.js. Haalt een bezoeker index.html en
// app-shifts.js nog uit zijn cache terwijl app-init.js al nieuw is — wat
// gebeurt als je de pagina herlaadt precies terwijl een deploy uitrolt — dan
// bestaat die functie niet:
//
//   Error during initialization: ReferenceError: werkActiviteitDeelnemersBij
//   is not defined   at setupEventListeners (app-init.js:446)
//
// En omdat `setupEventListeners` daar afbreekt, wordt géén enkele listener
// daarná nog opgehangen. De app laadt wel maar reageert nergens meer op.
//
// Een ontbrekende functie hoort hoogstens zijn eigen stukje uit te schakelen.
const fs = require('fs');
const path = require('path');

const frontend = (f) => path.join(__dirname, '..', '..', 'frontend', f);
const INIT = fs.readFileSync(frontend('app-init.js'), 'utf8');

// Commentaar eruit: anders leest de test de uitleg hierboven en hieronder mee.
const CODE = INIT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('een functie uit een ander bestand wordt niet kaal aangeroepen', () => {
  test('de telfunctie zit achter een typeof-controle', () => {
    // `typeof` op een niet-gedeclareerde naam gooit niets; dat is precies
    // waarom die vorm hier gebruikt wordt en niet `if (werk...)`.
    expect(CODE).toMatch(/typeof werkActiviteitDeelnemersBij === 'function'/);
  });

  test('er staat nergens een kale verwijzing meer', () => {
    // Twee keer: in de typeof-controle en in de toewijzing erachter. Elke
    // extra treffer is een aanroep die bij een verouderde app-shifts.js
    // opnieuw de hele opstart zou breken.
    const treffers = CODE.match(/werkActiviteitDeelnemersBij/g) || [];
    expect(treffers).toHaveLength(2);
  });

  test('de listeners hangen aan de gecontroleerde verwijzing', () => {
    expect(CODE).toMatch(/addEventListener\('change', telDeelnemers\)/);
    expect(CODE).toMatch(/if \(deelnemersLijst && telDeelnemers\)/);
  });

  test('de tijdvelden worden pas gekoppeld als de functie bestaat', () => {
    expect(CODE).toMatch(/if \(telDeelnemers\) \{[\s\S]{0,200}activity-start/);
  });
});

describe('de functie zelf staat waar hij hoort', () => {
  test('werkActiviteitDeelnemersBij staat in app-shifts.js', () => {
    const SHIFTS = fs.readFileSync(frontend('app-shifts.js'), 'utf8');
    expect(SHIFTS).toMatch(/function werkActiviteitDeelnemersBij\(/);
  });

  test('app-shifts.js wordt vóór app-init.js geladen', () => {
    // Bij een normale lading is dat wat de aanroep laat werken; de controle
    // hierboven dekt alleen het geval dat de twee niet bij elkaar horen.
    // Op de <script>-regels zoeken en niet op de naam: die staat ook in een
    // stuk commentaar bovenaan index.html, en dat komt vóór allebei.
    const HTML = fs.readFileSync(frontend('index.html'), 'utf8');
    const regel = (naam) => HTML.indexOf(`<script src="${naam}`);
    expect(regel('app-shifts.js')).toBeGreaterThan(-1);
    expect(regel('app-init.js')).toBeGreaterThan(-1);
    expect(regel('app-shifts.js')).toBeLessThan(regel('app-init.js'));
  });
});
