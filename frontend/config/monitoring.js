// ===== FOUTMONITORING (#156) =====
//
// De frontend rapporteerde niets. Er stonden ruim honderd console.error-regels
// die alleen de console van de gebruiker zelf haalden, dus een fout in de app
// bij iemand anders was onzichtbaar tenzij die persoon het meldde.
//
// Opzet zonder bouwstap, zoals regel 1 voorschrijft: de SDK komt van een CDN en
// wordt pas ingeladen als er een DSN is ingesteld. Zonder DSN gebeurt er niets
// en wordt er ook niets gedownload.
//
// ===== Waarom hier gefilterd wordt =====
//
// Dezelfde reden als in backend/src/monitoring.js: deze app houdt
// ziekmeldingen bij, en gezondheidsgegevens zijn een bijzondere categorie
// (#152). Een breadcrumb van een mislukt verzoek draagt zo een reden of een
// type mee. De filtering hieronder is een kopie van de backendlogica; die twee
// horen gelijk te blijven.
(function () {
    const host = window.location.hostname;
    const isLokaal = host === 'localhost' || host === '127.0.0.1' || window.location.protocol === 'file:';

    // De DSN van een browser-SDK is niet geheim: hij staat per ontwerp in de
    // pagina en kan alleen gebeurtenissen INsturen. Leeg laten schakelt alles uit.
    const DSN = '';

    window.MONITORING_DSN = DSN;
    // Altijd aanwezig, ook als de monitoring uitstaat, zodat app-auth.js hem
    // onvoorwaardelijk kan aanroepen.
    window.monitoringZetGebruiker = function () {};
    if (!DSN || isLokaal) return;

    const WEGGELATEN = '[weggelaten]';
    const VERBODEN = [
        'password', 'wachtwoord', 'token', 'authorization', 'cookie', 'jwt', 'secret',
        'reason', 'reden', 'absence', 'availability', 'afwezigheid',
        'requested_status', 'requestedstatus', 'entries',
        'email', 'e-mail', 'name', 'naam'
    ];
    const GEVOELIGE_WAARDEN = new Set([
        'verlof', 'ziek', 'overuren', 'vorming', 'andere', 'vrij',
        'werken', 'liever_niet', 'zeker_niet'
    ]);
    const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

    const isVerboden = s => VERBODEN.some(v => String(s).toLowerCase().includes(v));
    const schoonTekst = w => typeof w === 'string' ? w.replace(EMAIL, WEGGELATEN) : w;

    function schoonDiep(waarde, diepte) {
        diepte = diepte || 0;
        if (diepte > 12 || waarde === null || typeof waarde !== 'object') return schoonTekst(waarde);
        if (Array.isArray(waarde)) return waarde.map(v => schoonDiep(v, diepte + 1));
        const uit = {};
        for (const sleutel of Object.keys(waarde)) {
            const v = waarde[sleutel];
            if (isVerboden(sleutel)) uit[sleutel] = WEGGELATEN;
            else if (typeof v === 'string' && GEVOELIGE_WAARDEN.has(v.toLowerCase())) uit[sleutel] = WEGGELATEN;
            else uit[sleutel] = schoonDiep(v, diepte + 1);
        }
        return uit;
    }

    function schoonEvent(event) {
        if (!event) return event;
        if (event.user) event.user = event.user.id ? { id: String(event.user.id) } : undefined;
        if (event.request) event.request = { url: schoonTekst(event.request.url) };
        if (event.extra) event.extra = schoonDiep(event.extra);
        if (event.tags) event.tags = schoonDiep(event.tags);
        if (event.breadcrumbs) event.breadcrumbs = schoonDiep(event.breadcrumbs);
        if (event.message) event.message = schoonTekst(event.message);
        if (event.exception && Array.isArray(event.exception.values)) {
            event.exception.values.forEach(v => { if (v.value) v.value = schoonTekst(v.value); });
        }
        return event;
    }
    window.__schoonSentryEvent = schoonEvent;   // zodat het te testen is

    // Alleen het id, nooit naam of e-mail. app-auth.js roept dit aan na het
    // aanmelden en bij het afmelden; peilen met een interval zou het id pas na
    // een halve minuut koppelen, en juist de fouten vlak na het aanmelden zijn
    // interessant. Altijd aanwezig, ook zonder SDK, zodat de aanroeper niet
    // hoeft te weten of de monitoring aanstaat.
    function zetGebruiker() {
        if (!window.Sentry || !window.Sentry.setUser) return;
        // AppState is een top-level const in app-globals.js, en die komt NIET
        // op window terecht. Vandaar typeof en niet window.AppState; dat laatste
        // is altijd undefined en zou het id stilletjes nooit koppelen.
        const huidige = (typeof AppState !== 'undefined') ? AppState.currentUser : null;
        const id = huidige && huidige.id;
        window.Sentry.setUser(id ? { id: String(id) } : null);
    }
    window.monitoringZetGebruiker = zetGebruiker;

    const s = document.createElement('script');
    s.src = 'https://browser.sentry-cdn.com/10.75.0/bundle.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function () {
        if (!window.Sentry) return;
        window.Sentry.init({
            dsn: DSN,
            environment: host.includes('staging') ? 'staging' : 'production',
            tracesSampleRate: 0,
            sendDefaultPii: false,
            // Een breadcrumb van een fetch draagt de url mee. Die kan een id
            // bevatten maar geen inhoud, en zonder breadcrumbs is een
            // frontendfout nauwelijks te plaatsen.
            maxBreadcrumbs: 20,
            beforeSend: schoonEvent,
            beforeBreadcrumb: function (crumb) {
                if (crumb.data) crumb.data = schoonDiep(crumb.data);
                if (crumb.message) crumb.message = schoonTekst(crumb.message);
                return crumb;
            }
        });
        zetGebruiker();
    };
    s.onerror = function () {
        // De CDN is niet bereikbaar. Dat mag de app niet raken.
        console.error('Foutmonitoring kon niet geladen worden.');
    };
    document.head.appendChild(s);
})();
