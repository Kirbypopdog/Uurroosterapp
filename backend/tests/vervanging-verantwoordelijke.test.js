'use strict';

// #398: bij een vervanging verhuizen ook de VERANTWOORDELIJKHEDEN mee.
//
// Dat gebeurde maar half: `responsibleRotation` ging over, `holidayPeriods`
// niet. In productie stond Jill Dias daardoor nog als verantwoordelijke voor de
// tweede kerstvakantieweek, maanden nadat ze door Yana vervangen was — en de
// herinneringsmail van #397 zou haar daarover aangeschreven hebben.
//
// Getoetst wordt de pure functie uit de route: wat verhuist, wat blijft staan,
// en waar de grens ligt.

const path = require('path');
const fs = require('fs');

// De functie staat in de route en wordt daar niet geëxporteerd — de route
// exporteert zijn router. Hem apart uitlezen houdt de route zoals hij is en
// laat deze test toch de ECHTE code toetsen in plaats van een kopie.
const BRON = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'replace-employee.js'), 'utf8');

const start = BRON.indexOf('function verhuisVerantwoordelijkheden(');
const eind = BRON.indexOf('\nfunction remapDraftGridUser(');
if (start === -1 || eind === -1) {
  throw new Error('verhuisVerantwoordelijkheden niet gevonden in replace-employee.js — is hij hernoemd of verplaatst?');
}
const { maandagVan, alsTekst } = require('../src/helpers/verantwoordelijke');
// eslint-disable-next-line no-new-func
const verhuisVerantwoordelijkheden = new Function(
  'maandagVan', 'alsTekst',
  BRON.slice(start, eind) + '\nreturn verhuisVerantwoordelijkheden;'
)(maandagVan, alsTekst);

// De echte vakanties uit productie, met de echte id's.
// 123 = Jill Dias (vertrekt), 156 = Yana (vervangt haar).
const VAKANTIES = () => ([
  { name: 'Zomervakantie',   startDate: '2026-06-29', endDate: '2026-08-30',
    weeklyResponsibles: { '1': '115', '2': '114', '3': '123', '5': '117', '6': '118', '8': '123' } },
  { name: 'Herfstvakantie',  startDate: '2026-11-02', endDate: '2026-11-08',
    weeklyResponsibles: { '1': '120' } },
  { name: 'Kerstvakantie',   startDate: '2026-12-21', endDate: '2027-01-03',
    weeklyResponsibles: { '1': '112', '2': '123' } },
]);

const ROTATIE = () => ({
  rotationStart: '2026-08-31',
  rotationStartEmployee: '117',
  eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
  assignments: { '2026-09-07': 123, '2026-11-09': 123, '2027-01-11': 123 }
});

const VANAF = '2026-10-04'; // de echte ingangsdatum van de vervanging

function doe(vanaf = VANAF, rotatie = ROTATIE(), vakanties = VAKANTIES()) {
  return verhuisVerantwoordelijkheden(rotatie, vakanties, 123, 156, vanaf);
}

describe('vakantieweken', () => {
  // Dit is het geval dat in productie misging.
  test('een vakantieweek NA de ingangsdatum gaat naar de vervanger', () => {
    const { nieuweVakanties } = doe();
    const kerst = nieuweVakanties.find(p => p.name === 'Kerstvakantie');
    expect(kerst.weeklyResponsibles['2']).toBe('156');
  });

  test('wie er niets mee te maken heeft blijft ongemoeid', () => {
    const { nieuweVakanties } = doe();
    const kerst = nieuweVakanties.find(p => p.name === 'Kerstvakantie');
    expect(kerst.weeklyResponsibles['1']).toBe('112');
    const herfst = nieuweVakanties.find(p => p.name === 'Herfstvakantie');
    expect(herfst.weeklyResponsibles['1']).toBe('120');
  });

  // Het verleden hoort te blijven kloppen: zij WAS toen verantwoordelijk.
  test('een vakantieweek VÓÓR de ingangsdatum blijft op haar naam staan', () => {
    const { nieuweVakanties } = doe();
    const zomer = nieuweVakanties.find(p => p.name === 'Zomervakantie');
    expect(zomer.weeklyResponsibles['3']).toBe('123');
    expect(zomer.weeklyResponsibles['8']).toBe('123');
  });

  // Week 1 begint op de MAANDAG van de periode, niet op de startdatum zelf.
  // Een vakantie die op een zaterdag begint, heeft zijn week 1 dus al eerder.
  test('de week telt vanaf de maandag van de periode', () => {
    const vakanties = [{ name: 'Test', startDate: '2026-11-07', endDate: '2026-11-22',
      weeklyResponsibles: { '1': '123', '2': '123' } }];
    // Maandag van 7 nov (zaterdag) is 2 nov; week 2 begint dus op 9 nov.
    const { nieuweVakanties } = doe('2026-11-09', ROTATIE(), vakanties);
    expect(nieuweVakanties[0].weeklyResponsibles['1']).toBe('123');
    expect(nieuweVakanties[0].weeklyResponsibles['2']).toBe('156');
  });

  test('het oudere model met één persoon per periode werkt ook', () => {
    const vakanties = [
      { name: 'Oud toekomst', startDate: '2026-12-21', endDate: '2027-01-03', responsibleId: '123' },
      { name: 'Oud verleden', startDate: '2026-06-29', endDate: '2026-08-30', responsibleId: '123' }
    ];
    const { nieuweVakanties } = doe(VANAF, ROTATIE(), vakanties);
    expect(nieuweVakanties[0].responsibleId).toBe('156');
    expect(nieuweVakanties[1].responsibleId).toBe('123');
  });
});

describe('de rotatie', () => {
  test('een toewijzing na de ingangsdatum verhuist, als GETAL', () => {
    const { nieuweRotatie } = doe();
    expect(nieuweRotatie.assignments['2026-11-09']).toBe(156);
    expect(nieuweRotatie.assignments['2027-01-11']).toBe(156);
    expect(typeof nieuweRotatie.assignments['2026-11-09']).toBe('number');
  });

  test('een toewijzing vóór de ingangsdatum blijft staan', () => {
    const { nieuweRotatie } = doe();
    expect(nieuweRotatie.assignments['2026-09-07']).toBe(123);
  });

  // Het anker is geen toewijzing aan een week maar het punt waar de telling
  // begint. Blijft dat op iemand staan die weg is, dan vindt de berekening hem
  // niet in de kandidatenlijst en schuift de hele rotatie één plaats op.
  test('het anker verhuist altijd, ook als het in het verleden ligt', () => {
    const rotatie = ROTATIE();
    rotatie.rotationStartEmployee = '123';
    const { nieuweRotatie } = doe(VANAF, rotatie);
    expect(nieuweRotatie.rotationStartEmployee).toBe('156');
  });

  test('ook het anker van een vorige rotatie', () => {
    const rotatie = ROTATIE();
    rotatie.previousRotation = { rotationStartEmployee: '123', rotationStart: '2026-01-05' };
    const { nieuweRotatie } = doe(VANAF, rotatie);
    expect(nieuweRotatie.previousRotation.rotationStartEmployee).toBe('156');
  });
});

describe('niets te doen', () => {
  test('raakt het niemand, dan verandert er niets', () => {
    const uit = verhuisVerantwoordelijkheden(ROTATIE(), VAKANTIES(), 999, 156, VANAF);
    expect(uit.nieuweRotatie).toBeNull();
    expect(uit.nieuweVakanties).toBeNull();
    expect(uit.verplaatst).toBe(0);
  });

  test('ontbrekende instellingen leveren geen fout op', () => {
    const uit = verhuisVerantwoordelijkheden(null, null, 123, 156, VANAF);
    expect(uit.nieuweRotatie).toBeNull();
    expect(uit.nieuweVakanties).toBeNull();
  });

  test('het aantal verplaatsingen klopt met wat er werkelijk verzet is', () => {
    // kerstweek 2, plus de twee toewijzingen van 9 nov en 11 jan.
    expect(doe().verplaatst).toBe(3);
  });
});
