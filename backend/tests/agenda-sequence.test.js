'use strict';

// #409: een gewijzigde dienst bleef in een gekoppelde agenda op zijn oude uren
// staan. Gemeld door Victor: Outlook toonde 13:00-23:00 voor donderdag
// 19 november, de app 09:00-16:00. Nagegaan in de productiedata — dienst 54380
// ging op 6 oktober van 13:00-23:00 naar 09:00-23:00 en op 8 oktober naar
// 09:00-16:00. De feed werd die dag nog opgehaald, dus hij was niet verlopen.
//
// De oorzaak: de VEVENT droeg geen SEQUENCE. Een abonnee-agenda koppelt een
// binnenkomende gebeurtenis op UID aan de afspraak die hij al heeft en kijkt
// naar SEQUENCE om te beslissen of dit een nieuwere versie is.
const fs = require('fs');
const path = require('path');

const { icalSequence, icalUtcStempel, ICAL_SEQUENCE_IJKPUNT } = require('../src/utils');

describe('icalUtcStempel', () => {
  test('geeft de iCal-vorm van een moment, in UTC', () => {
    expect(icalUtcStempel(new Date('2026-11-19T13:48:51.123Z'))).toBe('20261119T134851Z');
  });

  test('neemt ook een tekst of een getal aan', () => {
    expect(icalUtcStempel('2026-10-08T12:48:15Z')).toBe('20261008T124815Z');
    expect(icalUtcStempel(Date.UTC(2026, 9, 8, 12, 48, 15))).toBe('20261008T124815Z');
  });

  test('geeft null bij iets dat geen moment is, zodat de aanroeper kan terugvallen', () => {
    expect(icalUtcStempel(undefined)).toBeNull();
    expect(icalUtcStempel('geen datum')).toBeNull();
  });
});

describe('icalSequence', () => {
  test('loopt op met de tijd', () => {
    const vroeg = icalSequence('2026-10-06T07:33:10Z');
    const laat = icalSequence('2026-10-08T12:48:15Z');
    expect(laat).toBeGreaterThan(vroeg);
  });

  test('is stabiel zolang de dienst niet verandert', () => {
    expect(icalSequence('2026-10-08T12:48:15Z')).toBe(icalSequence(new Date('2026-10-08T12:48:15Z')));
  });

  test('telt in hele seconden vanaf het ijkpunt', () => {
    const moment = new Date(ICAL_SEQUENCE_IJKPUNT + 90_000);
    expect(icalSequence(moment)).toBe(90);
  });

  test('is nooit 0 en nooit negatief', () => {
    // Elke bestaande koppeling heeft nog nooit een SEQUENCE gezien en houdt
    // impliciet 0 aan. Door hier minstens 1 te geven wordt zo'n agenda één
    // keer helemaal bijgewerkt, inclusief de dagen die er al fout in stonden.
    expect(icalSequence(new Date(ICAL_SEQUENCE_IJKPUNT))).toBe(1);
    expect(icalSequence('1999-01-01T00:00:00Z')).toBe(1);
    expect(icalSequence(undefined)).toBe(1);
    expect(icalSequence('geen datum')).toBe(1);
  });

  test('blijft onder wat een 32-bits geheel getal aankan', () => {
    // Daarom is het ijkpunt 2020 en niet de Unix-epoch: daarmee stond het
    // getal nu al op 1,7 miljard.
    expect(icalSequence('2026-11-19T00:00:00Z')).toBeLessThan(2_147_483_647);
    expect(icalSequence('2060-01-01T00:00:00Z')).toBeLessThan(2_147_483_647);
  });

  test('het echte geval uit de melding levert een hoger getal op', () => {
    // 54380, 19 november: 13:00-23:00 -> 09:00-23:00 -> 09:00-16:00
    const aangemaakt = icalSequence('2026-05-22T12:19:25Z');
    const eersteWijziging = icalSequence('2026-10-06T07:33:10Z');
    const tweedeWijziging = icalSequence('2026-10-08T12:48:15Z');
    expect(eersteWijziging).toBeGreaterThan(aangemaakt);
    expect(tweedeWijziging).toBeGreaterThan(eersteWijziging);
  });
});

describe('waar updated_at vandaan komt', () => {
  const migraties = fs.readFileSync(path.join(__dirname, '..', 'src', 'migraties.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const migratie049 = migraties.slice(
    migraties.indexOf("name: '049_shifts_updated_at'"),
    migraties.indexOf('async function runMigrations'));

  test('een TRIGGER houdt de kolom bij, geen losse UPDATE-statements', () => {
    // Diensten worden vanuit een stuk of zes routes geschreven (shifts,
    // draft-apply, replace-employee, swaps, de bulkziekmelding, de import).
    // Eén daarvan vergeten betekent een agenda die stil achterloopt, en dat
    // is precies de fout die hier wordt opgelost.
    expect(migratie049).toMatch(/CREATE TRIGGER\s+trg_shifts_updated_at/);
    expect(migratie049).toMatch(/BEFORE UPDATE ON shifts/);
    expect(schema).toMatch(/CREATE TRIGGER\s+trg_shifts_updated_at/);
  });

  test('de trigger gaat eerst AF en dan pas wordt er bijgevuld', () => {
    // schema.sql draait bij elke opstart via migratie 000 en maakt de trigger
    // ook aan. Hij bestaat hier dus al, en een BEFORE UPDATE-trigger vuurt ook
    // op de backfill: die zette alle rijen op created_at en de trigger zette ze
    // meteen weer op NOW(). De backfill deed dan niets, zonder foutmelding.
    const drop = migratie049.indexOf('DROP TRIGGER IF EXISTS trg_shifts_updated_at');
    const backfill = migratie049.indexOf('UPDATE shifts SET updated_at = created_at');
    const create = migratie049.indexOf('CREATE TRIGGER');
    expect(drop).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(drop);
    expect(create).toBeGreaterThan(backfill);
  });

  test('bestaande rijen krijgen hun aanmaakmoment', () => {
    expect(migratie049).toMatch(/UPDATE shifts SET updated_at = created_at/);
  });
});
