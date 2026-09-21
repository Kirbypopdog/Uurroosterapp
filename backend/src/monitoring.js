'use strict';

/**
 * Foutmonitoring via Sentry (#156).
 *
 * Inert zonder SENTRY_DSN. Lokaal en in de tests gebeurt er dus niets, en op
 * Render pas zodra de variabele gezet is. Dat is bewust: een monitoringlaag
 * die zich opdringt in ontwikkeling kost meer dan ze oplevert.
 *
 * ===== Waarom hier zoveel filtering staat =====
 *
 * Deze app houdt ziekmeldingen bij. Gezondheidsgegevens zijn een bijzondere
 * categorie onder de AVG (#152), en die horen niet bij een derde partij
 * terecht te komen, ook niet in de EU-regio. Een stacktrace of verzoekcontext
 * draagt zoiets sneller mee dan je denkt: een reden bij een afwezigheid, een
 * e-mailadres in een foutmelding, een verzoekinhoud met type 'ziek' erin.
 *
 * De standaardinstellingen van de SDK zijn ruim: cookies, headers, verzoek- en
 * antwoordinhoud en queryparameters gaan standaard mee. Die staan hieronder
 * allemaal uit, en `schoonEvent` is het tweede net voor wat er alsnog in een
 * foutbericht of stacktrace zou belanden.
 */

const Sentry = require('@sentry/node');

// Velden die nooit mogen vertrekken. Vergeleken op kleine letters, en een
// sleutel telt mee zodra hij een van deze woorden bevat: zo dekt 'reason' ook
// 'absence_reason' en 'availabilityReason'.
const VERBODEN_SLEUTELS = [
  'password', 'password_hash', 'wachtwoord', 'token', 'authorization', 'cookie',
  'jwt', 'secret', 'dsn', 'api_key', 'apikey',
  // afwezigheid en verlof: type 'ziek' is gezondheidsgegeven, reason is vrije tekst
  'reason', 'redenen', 'reden', 'absence', 'availability', 'afwezigheid',
  'requested_status', 'requestedstatus', 'leave_round_entries', 'entries',
  // persoonsgegevens
  'email', 'e-mail', 'name', 'naam', 'ical_feed_token'
];

const WEGGELATEN = '[weggelaten]';

// De sleutel `type` kan niet blind op de verbodenlijst: Sentry gebruikt hem zelf
// voor de soort fout ("Error", "TypeError"). Maar in deze app is `type` ook het
// veld van een afwezigheid, en de waarde 'ziek' is een gezondheidsgegeven en dus
// een bijzondere categorie (#152). Daarom niet op sleutel maar op WAARDE: staat
// er een van deze woorden, dan gaat het weg.
const AFWEZIGHEIDSTYPES = ['verlof', 'ziek', 'overuren', 'vorming', 'andere', 'vrij'];
const VERLOFSTATUSSEN = ['werken', 'liever_niet', 'zeker_niet'];
const GEVOELIGE_WAARDEN = new Set([...AFWEZIGHEIDSTYPES, ...VERLOFSTATUSSEN]);

// Een e-mailadres in een vrije tekst, bijvoorbeeld in een foutmelding uit
// Postgres of in een zelfgeschreven melding.
const EMAIL_PATROON = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

function isVerboden(sleutel) {
  const s = String(sleutel).toLowerCase();
  return VERBODEN_SLEUTELS.some(v => s.includes(v));
}

function schoonTekst(waarde) {
  if (typeof waarde !== 'string') return waarde;
  return waarde.replace(EMAIL_PATROON, WEGGELATEN);
}

/**
 * Loopt recursief door een structuur en vervangt alles wat onder een verboden
 * sleutel hangt. Cycli worden afgevangen, want een Sentry-event kan
 * zelfverwijzingen bevatten.
 */
function schoonDiep(waarde, gezien = new WeakSet(), diepte = 0) {
  if (diepte > 12) return waarde;
  if (waarde === null || typeof waarde !== 'object') return schoonTekst(waarde);
  if (gezien.has(waarde)) return waarde;
  gezien.add(waarde);

  if (Array.isArray(waarde)) {
    return waarde.map(v => schoonDiep(v, gezien, diepte + 1));
  }

  const uit = {};
  for (const [sleutel, v] of Object.entries(waarde)) {
    if (isVerboden(sleutel)) {
      uit[sleutel] = WEGGELATEN;
    } else if (typeof v === 'string' && GEVOELIGE_WAARDEN.has(v.toLowerCase())) {
      // Zie GEVOELIGE_WAARDEN: hier gaat het om wat er staat, niet hoe het heet.
      uit[sleutel] = WEGGELATEN;
    } else {
      uit[sleutel] = schoonDiep(v, gezien, diepte + 1);
    }
  }
  return uit;
}

/**
 * Het tweede net. Apart geëxporteerd zodat het te testen is zonder Sentry te
 * starten: dit is de functie die bepaalt wat er het huis verlaat.
 */
function schoonEvent(event) {
  if (!event || typeof event !== 'object') return event;

  // De gebruiker: alleen het id. Naam en e-mail zeggen bij het opsporen van een
  // fout niets wat het id niet ook zegt.
  if (event.user) {
    event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  }

  // Verzoekgegevens: url en methode volstaan om een fout te plaatsen.
  if (event.request) {
    event.request = {
      method: event.request.method,
      url: schoonTekst(event.request.url)
    };
  }

  if (event.extra) event.extra = schoonDiep(event.extra);

  // contexts is voor het grootste deel door de SDK zelf ingevuld: runtime, os,
  // device, culture. Daar staat niets persoonlijks in, en "name" blind wissen
  // maakt er "[weggelaten]" van waar "node" of "Linux" hoorde te staan. Die
  // blokken blijven dus heel; alles wat de app er zelf in zet gaat wél door de
  // zeef, want daar zit het risico.
  if (event.contexts) {
    const VAN_DE_SDK = new Set(['runtime', 'os', 'device', 'culture', 'app', 'trace', 'cloud_resource', 'response']);
    const uit = {};
    for (const [sleutel, waarde] of Object.entries(event.contexts)) {
      uit[sleutel] = VAN_DE_SDK.has(sleutel) ? waarde : schoonDiep(waarde);
    }
    event.contexts = uit;
  }
  if (event.tags) event.tags = schoonDiep(event.tags);
  if (event.breadcrumbs) event.breadcrumbs = schoonDiep(event.breadcrumbs);

  // Foutmelding en stacktrace: een e-mailadres komt hier het vaakst in terecht,
  // via een databasefout op een unieke sleutel.
  if (Array.isArray(event.exception?.values)) {
    event.exception.values.forEach(v => {
      if (v.value) v.value = schoonTekst(v.value);
      if (Array.isArray(v.stacktrace?.frames)) {
        v.stacktrace.frames.forEach(frame => {
          if (frame.vars) frame.vars = schoonDiep(frame.vars);
        });
      }
    });
  }
  if (event.message) event.message = schoonTekst(event.message);

  return event;
}

function initMonitoring() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    // Geen prestatiemetingen: dit gaat over fouten, en traces vullen de gratis
    // bundel van 5.000 gebeurtenissen per maand zonder dat iemand ernaar kijkt.
    tracesSampleRate: 0,
    // De standaarden van de SDK zijn ruim. Alles wat persoonsgegevens kan
    // dragen staat hier uit; zie de toelichting bovenaan dit bestand.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      queryParams: false,
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false }
    },
    // Lange waarden afkappen: een verzoekinhoud die er toch doorheen komt,
    // wordt dan in elk geval niet voluit bewaard.
    maxValueLength: 2000,
    beforeSend: schoonEvent
  });
  return true;
}

/**
 * Eén regel in het log die zegt of de monitoring aanstaat. Zonder dit is er na
 * een deploy geen enkele manier om dat te zien zonder een fout te veroorzaken,
 * en dan sta je te gissen of de variabele wel goed staat.
 */
function meldMonitoringStatus(aan) {
  if (aan) {
    const dsn = process.env.SENTRY_DSN || '';
    // Alleen de regio en het projectnummer, nooit de sleutel ervoor.
    const staart = dsn.split('@')[1] || '(onbekend)';
    console.log(`[monitoring] Foutmonitoring actief -> ${staart}`);
  } else {
    console.log('[monitoring] Foutmonitoring uit: SENTRY_DSN is niet gezet.');
  }
}

module.exports = {
  initMonitoring, meldMonitoringStatus, schoonEvent, schoonDiep, isVerboden, Sentry,
  // voor de tests
  GEVOELIGE_WAARDEN
};
