'use strict';

// #418: een algemene activiteit hangt aan een DAG en niet aan een persoon:
// een brandoefening, een teamdag. Iedereen ziet ze — in de dagkop van de
// planning, op het beginscherm en in de agendafeed. Alleen admin en
// roosterverantwoordelijke maken ze aan. Ze verlagen de bezetting niet.

const fs = require('fs');
const path = require('path');

// --- backend: de invoercontrole en de agendafeed ---------------------------
const { controleer } = require('../src/routes/dag-activiteiten');
const { dagActiviteitEvent } = require('../src/routes/me-voorkeuren-en-agenda');

describe('de invoercontrole van de backend', () => {
  test('met uren', () => {
    expect(controleer({ date: '2026-11-19', titel: ' Brandoefening ', startTime: '14:00', endTime: '15:00' }))
      .toEqual({ waarden: { date: '2026-11-19', titel: 'Brandoefening', omschrijving: '', van: '14:00', tot: '15:00' } });
  });

  test('zonder uren is het de hele dag; een leeg tijdveld telt als leeg', () => {
    expect(controleer({ date: '2026-11-20', titel: 'Teamdag', startTime: '', endTime: '' }).waarden)
      .toMatchObject({ van: null, tot: null });
  });

  test.each([
    [{ date: '2026-11-19', titel: '' }, 'Een titel is verplicht'],
    [{ date: '2026-11-19', titel: '   ' }, 'Een titel is verplicht'],
    [{ date: '2026-02-31', titel: 'x' }, 'Ongeldige datum'],
    [{ titel: 'x' }, 'Ongeldige datum'],
    [{ date: '2026-11-19', titel: 'x', startTime: '14:00' }, 'Vul beide uren in, of geen van beide voor de hele dag'],
    [{ date: '2026-11-19', titel: 'x', endTime: '14:00' }, 'Vul beide uren in, of geen van beide voor de hele dag'],
    [{ date: '2026-11-19', titel: 'x', startTime: '15:00', endTime: '14:00' }, 'Het einduur moet na het beginuur liggen'],
    [{ date: '2026-11-19', titel: 'x', startTime: '14:00', endTime: '14:00' }, 'Het einduur moet na het beginuur liggen'],
    [{ date: '2026-11-19', titel: 'x', startTime: '25:00', endTime: '26:00' }, 'Tijdstip moet HH:MM zijn'],
    [{ date: '2026-11-19', titel: 'x'.repeat(121) }, 'De titel mag hoogstens 120 tekens lang zijn'],
  ])('%j wordt geweigerd', (invoer, melding) => {
    expect(controleer(invoer).fout).toBe(melding);
  });
});

describe('in de agendafeed', () => {
  const basis = { id: 7, date: '2026-11-19', titel: 'Brandoefening', omschrijving: 'Verzamelen op de parking',
    updated_at: new Date('2026-11-17T13:00:00Z') };
  const opties = { omschrijvingenMee: false, voorkeurSeq: 1, nu: '20261117T130000Z' };
  const regels = (ev) => ev.split('\r\n');

  test('met uren: in Brusselse tijd, zoals een dienst', () => {
    const ev = regels(dagActiviteitEvent({ ...basis, start_time: '14:00', end_time: '15:00' }, opties));
    expect(ev).toContain('UID:dag-activiteit-7@hetvlot');
    expect(ev).toContain('DTSTART;TZID=Europe/Brussels:20261119T140000');
    expect(ev).toContain('DTEND;TZID=Europe/Brussels:20261119T150000');
    expect(ev).toContain('SUMMARY:Brandoefening');
  });

  test('zonder uren: een gebeurtenis voor de hele dag, met DTEND op de dag erna', () => {
    // In iCal is een DATE-einde exclusief. DTEND op dezelfde dag zou een
    // gebeurtenis van nul dagen zijn.
    const ev = regels(dagActiviteitEvent({ ...basis, start_time: null, end_time: null }, opties));
    expect(ev).toContain('DTSTART;VALUE=DATE:20261119');
    expect(ev).toContain('DTEND;VALUE=DATE:20261120');
  });

  test('over een maandgrens en een jaargrens', () => {
    const ev = regels(dagActiviteitEvent({ ...basis, date: '2026-12-31', start_time: null, end_time: null }, opties));
    expect(ev).toContain('DTEND;VALUE=DATE:20270101');
  });

  test('de omschrijving gaat alleen mee als de medewerker dat zelf aanzette (#410)', () => {
    const zonder = dagActiviteitEvent({ ...basis, start_time: null, end_time: null }, opties);
    const met = dagActiviteitEvent({ ...basis, start_time: null, end_time: null }, { ...opties, omschrijvingenMee: true });
    expect(zonder).not.toContain('DESCRIPTION');
    expect(met).toContain('DESCRIPTION:Verzamelen op de parking');
  });

  test('blokkeert je agenda niet: je bent niet bezet omdat er een brandoefening is', () => {
    expect(dagActiviteitEvent({ ...basis, start_time: '14:00', end_time: '15:00' }, opties)).toContain('TRANSP:TRANSPARENT');
  });

  test('een wijziging geeft een hogere SEQUENCE (#409)', () => {
    const seq = (d) => Number(/SEQUENCE:(\d+)/.exec(dagActiviteitEvent({ ...basis, start_time: null, end_time: null, updated_at: d }, opties))[1]);
    expect(seq(new Date('2026-11-18T10:00:00Z'))).toBeGreaterThan(seq(new Date('2026-11-17T10:00:00Z')));
  });

  test('de feed vraagt ze op voor IEDEREEN, niet alleen voor wie die dag werkt', () => {
    const bron = fs.readFileSync(path.join(__dirname, '../src/routes/me-voorkeuren-en-agenda.js'), 'utf8');
    const query = bron.slice(bron.indexOf('FROM dag_activiteiten'), bron.indexOf('FROM dag_activiteiten') + 200);
    expect(query).not.toMatch(/user_id/);
  });
});

describe('schema en rechten', () => {
  const migraties = fs.readFileSync(path.join(__dirname, '../src/migraties.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/dag-activiteiten.js'), 'utf8');

  test('de tabel staat in de migratie én in schema.sql', () => {
    expect(migraties).toContain("name: '051_dag_activiteiten'");
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS dag_activiteiten/);
  });

  test('de audit log kent het nieuwe soort, anders verdwijnt elke regel stil', () => {
    expect(schema).toMatch(/resource_type IN \([^)]*'dag_activiteit'/);
    expect(migraties).toMatch(/audit_log_resource_type_check CHECK \(resource_type IN \([^)]*'dag_activiteit'/);
  });

  test('lezen mag iedereen, schrijven alleen admin en roosterverantwoordelijke', () => {
    expect(routes).toMatch(/router\.get\('\/dag-activiteiten', requireAuth, async/);
    expect(routes).toMatch(/const BEHEER = requireRole\('admin', 'roosterverantwoordelijke'\)/);
    for (const m of ['post', 'put', 'delete']) {
      expect(routes).toMatch(new RegExp(`router\\.${m}\\('/dag-activiteiten[^']*', requireAuth, BEHEER,`));
    }
  });
});

// --- frontend ---------------------------------------------------------------
global.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
global.ACTIVITY_TYPE_LABELS_FULL = {};
const { dagActiviteitenChips, dagActiviteitTekst, DAGACT_ZICHTBAAR } = require('../../frontend/app-planner.js');
const { dagActiviteitUitVenster } = require('../../frontend/app-shifts.js');
const { komendeDagActiviteiten } = require('../../frontend/app-nav.js');
global.AppState = global.AppState || { currentUser: null, simulatedRole: null };
const { canManageDagActiviteiten } = require('../../frontend/app-permissions.js');

describe('de chips in de dagkop', () => {
  const a = (id, startTime, titel) => ({ id, date: '2026-11-19', startTime, endTime: startTime ? '15:00' : null, titel, omschrijving: '' });

  test('met uur vooraan, zonder uur alleen de titel', () => {
    expect(dagActiviteitTekst(a(1, '14:00', 'Brandoefening'))).toBe('14:00 Brandoefening');
    expect(dagActiviteitTekst(a(2, null, 'Teamdag'))).toBe('Teamdag');
  });

  test('hoogstens twee in de dagkop, daarna +n', () => {
    const html = dagActiviteitenChips([a(1, '10:00', 'A'), a(2, '14:00', 'B'), a(3, '16:00', 'C')], false);
    expect(DAGACT_ZICHTBAAR).toBe(2);
    expect(html.match(/data-dagact-id=/g)).toHaveLength(2);
    expect(html).toContain('>+1</span>');
  });

  test('in de balk van de dagweergave staan ze allemaal', () => {
    const html = dagActiviteitenChips([a(1, '10:00', 'A'), a(2, '14:00', 'B'), a(3, '16:00', 'C')], false, Infinity);
    expect(html.match(/data-dagact-id=/g)).toHaveLength(3);
    expect(html).not.toContain('+');
  });

  test('wie mag beheren krijgt een knop, de anderen tekst', () => {
    // Een knop die niets doet is een valse belofte (#400).
    expect(dagActiviteitenChips([a(1, null, 'Teamdag')], true)).toMatch(/<button type="button" class="dagact-chip"/);
    expect(dagActiviteitenChips([a(1, null, 'Teamdag')], false)).toMatch(/<span class="dagact-chip"/);
  });

  test('de titel wordt ontsnapt', () => {
    const html = dagActiviteitenChips([a(1, null, '<script>x</script>')], false);
    expect(html).not.toContain('<script>');
  });

  test('geen activiteiten, geen lijst', () => {
    expect(dagActiviteitenChips([], true)).toBe('');
  });
});

describe('het venster', () => {
  test('hele dag: geen uren mee', () => {
    expect(dagActiviteitUitVenster({ datum: '2026-11-20', titel: 'Teamdag', heleDag: true, van: '09:00', tot: '17:00' }).waarden)
      .toMatchObject({ startTime: null, endTime: null });
  });

  test.each([
    [{ datum: '', titel: 'x', heleDag: true }, 'Kies een datum.'],
    [{ datum: '2026-11-20', titel: ' ', heleDag: true }, 'Geef de activiteit een titel.'],
    [{ datum: '2026-11-20', titel: 'x', heleDag: false, van: '14:00', tot: '' }, 'Vul een begin- en einduur in, of vink "Hele dag" aan.'],
    [{ datum: '2026-11-20', titel: 'x', heleDag: false, van: '15:00', tot: '14:00' }, 'Het einduur moet na het beginuur liggen.'],
  ])('%j geeft een melding', (invoer, melding) => {
    expect(dagActiviteitUitVenster(invoer).fout).toBe(melding);
  });

  test('de frontend trekt dezelfde grens als de backend (regel 5)', () => {
    const alsRol = (role) => { global.AppState.currentUser = { id: 1, role }; global.AppState.simulatedRole = null; };
    alsRol('medewerker');
    expect(canManageDagActiviteiten()).toBe(false);
    alsRol('roosterverantwoordelijke');
    expect(canManageDagActiviteiten()).toBe(true);
    alsRol('admin');
    expect(canManageDagActiviteiten()).toBe(true);
  });
});

describe('het beginscherm', () => {
  const lijst = [
    { date: '2026-11-16', titel: 'Gisteren' },
    { date: '2026-11-17', startTime: '14:00', titel: 'Vandaag laat' },
    { date: '2026-11-17', startTime: null, titel: 'Vandaag hele dag' },
    { date: '2026-11-24', titel: 'Over zeven dagen' },
    { date: '2026-11-25', titel: 'Over acht dagen' },
  ];

  test('vandaag en de komende zeven dagen, op volgorde, hele dag eerst', () => {
    expect(komendeDagActiviteiten(lijst, '2026-11-17').map((a) => a.titel))
      .toEqual(['Vandaag hele dag', 'Vandaag laat', 'Over zeven dagen']);
  });
});

describe('bezetting', () => {
  test('een algemene activiteit telt niet mee in de bezetting', () => {
    // De bezetting telt alleen DataStore.activities (per persoon). Zou iemand
    // dag_activiteiten daar ooit in mengen, dan telt een brandoefening plots
    // iedereen als "niet op de vloer" — dat is niet wat Victor koos.
    const planner = fs.readFileSync(path.join(__dirname, '../../frontend/app-planner.js'), 'utf8');
    const begin = planner.indexOf('function calcPlanningHourlyHeadcount');
    const eind = planner.indexOf('\nfunction ', begin + 10);
    expect(planner.slice(begin, eind)).not.toMatch(/dagActiviteit/);
  });
});

describe('na de review', () => {
  const F = (f) => fs.readFileSync(path.join(__dirname, '../../frontend', f), 'utf8');

  test('ver vooruit geplande activiteiten worden ook geladen', () => {
    // Met het venster van de diensten (drie maanden) werd een teamdag in maart
    // wel opgeslagen maar nergens getoond.
    const data = F('data.js');
    expect(data).toMatch(/function _getDagActiviteitenVensterEind\(\) \{\s*const d = new Date\(\); d\.setMonth\(d\.getMonth\(\) \+ 24\)/);
    const aanroepen = data.match(/\/dag-activiteiten\?startDate=\$\{[^}]+\}&endDate=\$\{(\w+)\(\)\}/g) || [];
    expect(aanroepen).toHaveLength(2);
    aanroepen.forEach(a => expect(a).toContain('_getDagActiviteitenVensterEind()'));
  });

  test('Escape in "Activiteit verwijderen" sluit het bewerkvenster niet mee', () => {
    const bron = F('app-shifts.js');
    const begin = bron.indexOf('const bijToets = (e) => {');
    const blok = bron.slice(begin, bron.indexOf('};', begin));
    expect(blok).toContain("document.getElementById('confirm-modal')");
    expect(blok).toMatch(/if \(bevestiging && !bevestiging\.classList\.contains\('hidden'\)\) return;/);
  });
});
