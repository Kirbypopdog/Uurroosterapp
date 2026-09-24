// ===== DATA MANAGEMENT SYSTEEM =====
// Dit bestand beheert alle data voor Het Vlot roosterplanning
// Alle data wordt opgeslagen in de PostgreSQL database via de API
//
// NOTE: Na Optie C migratie zijn employees en users samengevoegd.
// "Users" bevat nu alle gebruikers met hun rooster/schedule data.
// De term "employee" wordt nog gebruikt in de UI maar verwijst naar users.

const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {};

function parseDateOnly(value) {
    if (value instanceof Date) {
        return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === 'string') {
        // Handle ISO timestamps like "2026-03-01T23:00:00.000Z" → extract date part
        const dateOnly = value.includes('T') ? value.split('T')[0] : value;
        const parts = dateOnly.split('-').map(Number);
        if (parts.length === 3 && parts.every(part => Number.isFinite(part))) {
            return new Date(parts[0], parts[1] - 1, parts[2]);
        }
    }
    return new Date(value);
}

// #313: (eind - start) / 86400000 klopt niet in de week waarin de zomertijd
// eindigt. Die zondag duurt 25 uur, dus de deling komt net boven een heel
// getal uit en Math.ceil telt er een dag bij. Voor 24 tot en met 26 oktober
// 2026 gaf dat 4 in plaats van 3. Door beide datums naar UTC-middernacht te
// vertalen verdwijnt de zomertijd uit de berekening: een UTC-dag duurt altijd
// 24 uur. Inclusief beide uiteinden, want zo tellen de schermen die dit
// gebruiken hun dagen.
function aantalDagenInclusief(start, end) {
    const a = parseDateOnly(start);
    const b = parseDateOnly(end);
    const msA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const msB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((msB - msA) / 86400000) + 1;
}

function cloneSettings(settings) {
    if (typeof structuredClone === 'function') {
        return structuredClone(settings);
    }
    return JSON.parse(JSON.stringify(settings));
}

function normalizeSettings(settings) {
    const defaults = cloneSettings(DEFAULT_SETTINGS);
    const merged = { ...defaults, ...(settings || {}) };

    if (!merged.teams || typeof merged.teams !== 'object') {
        merged.teams = defaults.teams || {};
    } else if (defaults.teams) {
        merged.teams = { ...defaults.teams, ...merged.teams };
    }
    if (!merged.shiftTemplates || typeof merged.shiftTemplates !== 'object' || Object.keys(merged.shiftTemplates).length === 0) {
        merged.shiftTemplates = defaults.shiftTemplates || {};
    } else if (defaults.shiftTemplates) {
        merged.shiftTemplates = { ...defaults.shiftTemplates, ...merged.shiftTemplates };
    }
    if (!merged.rules || typeof merged.rules !== 'object') {
        merged.rules = defaults.rules || {};
    } else if (defaults.rules) {
        merged.rules = { ...defaults.rules, ...merged.rules };
    }
    if (!Array.isArray(merged.holidayPeriods)) {
        merged.holidayPeriods = defaults.holidayPeriods || [];
    }
    if (!Array.isArray(merged.conceptClosedDates)) {
        merged.conceptClosedDates = [];
    }
    if (!merged.holidayRules || typeof merged.holidayRules !== 'object') {
        merged.holidayRules = defaults.holidayRules || {};
    } else if (defaults.holidayRules) {
        merged.holidayRules = { ...defaults.holidayRules, ...merged.holidayRules };
    }
    if (!merged.responsibleRotation || typeof merged.responsibleRotation !== 'object') {
        merged.responsibleRotation = defaults.responsibleRotation || {};
    } else if (defaults.responsibleRotation) {
        merged.responsibleRotation = { ...defaults.responsibleRotation, ...merged.responsibleRotation };
        merged.responsibleRotation.assignments = {
            ...(defaults.responsibleRotation.assignments || {}),
            ...(merged.responsibleRotation.assignments || {})
        };
    }

    // Team meetings normalisatie
    if (!merged.teamMeetings || typeof merged.teamMeetings !== 'object') {
        merged.teamMeetings = defaults.teamMeetings || {};
    }

    // Schedule pattern normalisatie
    if (!merged.schedulePattern || typeof merged.schedulePattern !== 'object') {
        merged.schedulePattern = defaults.schedulePattern || {
            cycleLength: 2,
            referenceDate: merged.biWeeklyReferenceDate || '2025-01-06',
            weeks: {
                "1": { closedDays: [6, 0], label: "Weekend gesloten" },
                "2": { closedDays: [], label: "Weekend open" }
            }
        };
    }

    return merged;
}

// ===== ACTIVE SHIFT RANGE =====
// Gezet door app.js na initial load en bij week-navigatie.
// Als gezet, gebruikt refreshShifts() deze range + merge-strategie.
let _activeShiftRange = null;

function setActiveShiftRange(startDate, endDate) {
    _activeShiftRange = startDate && endDate ? { startDate, endDate } : null;
}

// ===== NORMALIZATION HELPERS =====
// Gebruikt door refresh functies en loadDataFromAPI() voor consistente data transformatie

function normalizeShift(s) {
    return {
        ...s,
        date: typeof s.date === 'string' ? s.date.split('T')[0] : s.date,
        employeeId: s.userId || s.employeeId,
        userId: s.userId || s.employeeId,
        source: s.source || 'manual'
    };
}

function normalizeAvailability(a) {
    const date = typeof a.date === 'string' ? a.date.split('T')[0] : a.date;
    return {
        ...a,
        date,
        employeeId: a.userId || a.employeeId,
        userId: a.userId || a.employeeId,
        key: `${a.userId || a.employeeId}_${date}`
    };
}

function normalizeShiftBlock(b) {
    return {
        ...b,
        date: typeof b.date === 'string' ? b.date.split('T')[0] : b.date
    };
}

function normalizeActivity(a) {
    return {
        ...a,
        date: typeof a.date === 'string' ? a.date.split('T')[0] : a.date,
        userId: a.userId || a.user_id,
        shiftId: a.shiftId || a.shift_id || null
    };
}

// Globale data store (in-memory cache van database data)
// NOTE: employees is nu een alias voor users (minus admin users)
const DataStore = {
    users: [],           // All users with schedule data
    get employees() {    // Backward compatibility: returns non-admin users
        return this.users.filter(u => u.role !== 'admin');
    },
    set employees(val) { // Allow setting for backward compatibility
        // When setting employees, merge with existing admin users
        const admins = this.users.filter(u => u.role === 'admin');
        this.users = [...admins, ...val.filter(u => u.role !== 'admin')];
    },
    shifts: [],
    activities: [],
    availability: [],
    shiftBlocks: [],
    swapRequests: [],
    settings: normalizeSettings(DEFAULT_SETTINGS),
    _loaded: false,
    _publicHolidaysCache: {},           // { [year]: [{ date, name }, ...] }
    _publicHolidaysFetching: new Set()  // years currently being fetched
};

// ===== API HELPER =====

// #388: zie de toelichting in dataApiFetch.
//
// MELD_TRAAG_MS is bewust veel korter dan de pogingen: wie wacht hoort te horen
// dát er gewacht wordt, in plaats van naar een leeg scherm te kijken.
//
// Acht seconden en niet drieënhalf. Een wakkere server antwoordt in
// milliseconden (lokaal gemeten: 3 ms), maar de verbinding van de gebruiker
// telt ook mee, en op een zwakke mobiele verbinding zijn een paar seconden
// niets bijzonders. Onder de acht seconden zou deze melding dus geregeld
// verschijnen terwijl er niets aan de hand is.
//
// Even belangrijk: op dit moment WETEN we niet waarom het traag is. Het kan de
// server zijn, het kan de verbinding zijn. De eerste melding zegt daarom alleen
// dát het lang duurt. Pas als de eerste poging helemaal is afgelopen zonder één
// byte, na twintig seconden, is een slapende server de waarschijnlijke
// verklaring, en pas dan noemen we die. Anders maken we dezelfde fout als de
// melding die we hier vervangen, alleen in spiegelbeeld: die wees naar de
// verbinding van de gebruiker zonder dat te weten.
const MELD_TRAAG_MS = 8000;
const WACHT_KORT_MS = 20000;
const WACHT_LANG_MS = 55000;

/**
 * #159: waar het inlogtoken staat, op één plek.
 *
 * Het stond in sessionStorage, en dat is leeg zodra je het tabblad sluit. De
 * server geeft nochtans een token van ZEVEN DAGEN mee, dus die zeven dagen
 * werden nooit gebruikt: elke keer opnieuw inloggen. Op een app die vanaf het
 * beginscherm start valt dat extra op, want elke start is een nieuwe sessie.
 *
 * Het onderscheid: draait de app vanaf het beginscherm, dan blijft de
 * aanmelding staan zolang het token geldig is, net als bij elke andere app op
 * je telefoon. In een gewoon browsertabblad blijft het zoals het was, tot je
 * het tabblad sluit.
 *
 * Dat onderscheid is er om één reden. De app bevat ziekmeldingen, en dat zijn
 * gezondheidsgegevens (#152). Er is nergens een uitlog-na-inactiviteit, dus op
 * een gedeelde computer zou een blijvende aanmelding betekenen dat de volgende
 * persoon ziet wie er ziek is. Een app op een beginscherm staat per definitie
 * op iemands eigen toestel.
 */
function draaitAlsApp() {
    try {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
    } catch (e) {
        return false;
    }
}

function bewaarToken(token) {
    try {
        (draaitAlsApp() ? localStorage : sessionStorage).setItem('hetvlot_token', token);
    } catch (e) {
        // Privémodus of volle opslag: dan maar voor deze sessie.
        try { sessionStorage.setItem('hetvlot_token', token); } catch (e2) { /* opgeven */ }
    }
}

// Allebei lezen, want de opslag kan tussen twee keer openen verschillen: eerst
// in een tabblad ingelogd en daarna de app geopend, of omgekeerd.
function leesToken() {
    try {
        return sessionStorage.getItem('hetvlot_token') || localStorage.getItem('hetvlot_token');
    } catch (e) {
        return null;
    }
}

function wisToken() {
    try { sessionStorage.removeItem('hetvlot_token'); } catch (e) { /* zie hierboven */ }
    try { localStorage.removeItem('hetvlot_token'); } catch (e) { /* zie hierboven */ }
}

async function dataApiFetch(path, options = {}) {
    const token = leesToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    // #233: zonder tijdslimiet bleef een opslagoverlay ("Dienst opslaan...",
    // "Afwezigheid opslaan...", "Medewerker opslaan...") eeuwig staan als de
    // server het verzoek aanvaardde maar nooit antwoordde. Er was geen enkele
    // manier waarop de await ooit zou teruggeven, dus de finally die
    // hideSectionLoading aanroept werd nooit bereikt. Eén tijdslimiet hier
    // dekt alle aanroepers in de app in één keer, in plaats van dit apart te
    // repareren bij elke plek die een overlay toont.
    //
    // Een aanroeper die zelf al een signal meegeeft (bv. om zelf te kunnen
    // annuleren) houdt voorrang; dan bemoeien we ons er niet mee.
    // #388: de server draait op een plan dat hem slapend legt na een kwartier
    // stilte. De eerstvolgende bezoeker wekt hem, en dat duurt langer dan de
    // twintig seconden die hier stonden. Op één werkdag startte productie
    // twaalf keer koud op; elk van die keren kreeg iemand een foutmelding.
    //
    // Twee pogingen dus. De eerste is kort, want een server die draait
    // antwoordt in een oogwenk en dan willen we niet lang blijven hangen als
    // er werkelijk iets mis is. Blijft die eerste poging stil, dan is de meest
    // waarschijnlijke verklaring dat de server aan het opstarten is, en krijgt
    // de tweede poging ruim de tijd.
    //
    // Een aanroeper die zelf een signal meegeeft (bv. om te kunnen annuleren)
    // houdt voorrang; daar bemoeien we ons niet mee, en die krijgt ook geen
    // tweede poging want hij bepaalt zelf wanneer het genoeg is.
    const eigenSignal = !!options.signal;
    const POGINGEN = eigenSignal ? [null] : [WACHT_KORT_MS, WACHT_LANG_MS];

    // Los van de pogingen: zeg na een paar seconden stilte dát het lang duurt.
    const meldTimer = eigenSignal ? null : setTimeout(() => {
        if (typeof toonDuurtLang === 'function') toonDuurtLang();
    }, MELD_TRAAG_MS);

    let response;
    try {
    for (let i = 0; i < POGINGEN.length; i++) {
        const laatste = i === POGINGEN.length - 1;
        const controller = eigenSignal ? null : new AbortController();
        const timeoutId = controller ? setTimeout(() => controller.abort(), POGINGEN[i]) : null;
        try {
            response = await fetch(`${window.API_BASE}${path}`, {
                ...options,
                headers: { ...headers, ...(options.headers || {}) },
                signal: options.signal || controller.signal
            });
            break;
        } catch (err) {
            if (eigenSignal || err.name !== 'AbortError') throw err;
            if (!laatste) {
                // Twintig seconden lang geen enkele byte. Nu pas is een
                // slapende server de waarschijnlijke verklaring, en nu pas
                // mogen we die noemen.
                if (typeof toonServerWaktOp === 'function') toonServerWaktOp();
                continue;
            }
            const seconden = Math.round((WACHT_KORT_MS + WACHT_LANG_MS) / 1000);
            const fout = new Error(
                `De server antwoordde niet binnen ${seconden} seconden. Hij was waarschijnlijk in slaap en start nog op. Probeer het zo nog eens.`);
            fout.status = 0;
            throw fout;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }
    } finally {
        if (meldTimer) clearTimeout(meldTimer);
    }

    if (!response.ok) {
        if (response.status === 401) {
            // Token ontbreekt of verlopen — sessie opruimen en terug naar login
            wisToken();
            sessionStorage.removeItem('hetvlot_user');
            // #269: 'sessie' zorgt dat handleLogout de openstaande vensters
            // sluit en uitlegt waarom je terug op het loginscherm staat.
            if (typeof handleLogout === 'function') handleLogout('sessie');
            // #268: deze fout kreeg als enige geen status mee. Een aanroeper die
            // op error.status test kon een fout wachtwoord daardoor niet
            // onderscheiden van een netwerkfout.
            const fout401 = new Error('Sessie verlopen. Log opnieuw in.');
            fout401.status = 401;
            throw fout401;
        }
        const data = await response.json().catch(() => ({}));
        // #268: hier stond alleen data.error. De inlogbegrenzer antwoordt met
        // een message-veld, dus die tekst ging verloren en de gebruiker las
        // "HTTP 429" in plaats van hoe lang hij moest wachten.
        const msg = data.error || data.message || `HTTP ${response.status}`;
        const detail = data.detail ? ` (${data.detail})` : '';
        const fout = new Error(msg + detail);
        // De statuscode en het volledige antwoord meegeven, zodat een aanroeper
        // kan reageren op wat de backend zegt in plaats van op de tekst te
        // moeten matchen. Gebruikt door de ruil- en overnameknoppen, die bij
        // canOverride een bevestiging tonen en het opnieuw proberen met force.
        fout.status = response.status;
        fout.data = data;
        throw fout;
    }

    return response.json();
}

// ===== LOAD DATA FROM API =====

// Initieel datumvenster: 3 maanden terug t/m 3 maanden vooruit
// #378: het afwezigheidsvenster is ruimer dan dat van de diensten. Een
// vakantieconcept in de bouwer kijkt naar een periode die maanden vooruit kan
// liggen, en de afwezigheidstabel navigeert per week door het hele schooljaar.
function _getAfwezigheidVensterStart() {
    const d = new Date(); d.setMonth(d.getMonth() - 6); return formatDateYYYYMMDD(d);
}
function _getAfwezigheidVensterEind() {
    const d = new Date(); d.setMonth(d.getMonth() + 12); return formatDateYYYYMMDD(d);
}

function _getInitialWindowStart() {
    const d = new Date(); d.setMonth(d.getMonth() - 3); return formatDateYYYYMMDD(d);
}
function _getInitialWindowEnd() {
    const d = new Date(); d.setMonth(d.getMonth() + 3); return formatDateYYYYMMDD(d);
}

async function loadDataFromAPI() {
    try {
        // Load all data in parallel - users now includes employee/schedule data
        const loadErrors = [];

        // /schedule-drafts is admin-only. Voor een medewerker gaf dit bij elke
        // login een rode 403 in de console — opgevangen, maar verwarrend.
        // Let op: de échte rol, niet getEffectiveRole(): een admin die een
        // medewerker simuleert moet de concepten wél geladen hebben.
        const echteRol = AppState.currentUser?.role;
        const magConcepten = ['admin', 'roosterverantwoordelijke',
            'hoofdverantwoordelijke', 'teamverantwoordelijke'].includes(echteRol);
        const [usersData, shiftsData, availabilityData, shiftBlocksData, settingsData, draftsData, activitiesData, leaveRoundsData, swapRequestsData] = await Promise.all([
            dataApiFetch('/users').catch(err => { loadErrors.push('users'); console.error('[LoadData] Failed to load users:', err); return { users: [] }; }),
            dataApiFetch(`/shifts?startDate=${_getInitialWindowStart()}&endDate=${_getInitialWindowEnd()}`).catch(err => { loadErrors.push('shifts'); console.error('[LoadData] Failed to load shifts:', err); return { shifts: [] }; }),
            // #378: hetzelfde venster als de diensten, maar een jaar breed, want
            // de bouwer en de afwezigheidstabel kijken verder vooruit dan de
            // planning. Alles buiten dit venster wordt bijgeladen via
            // zorgAfwezigheidVoorBereik.
            dataApiFetch(`/availability?startDate=${_getAfwezigheidVensterStart()}&endDate=${_getAfwezigheidVensterEind()}`).catch(err => { loadErrors.push('availability'); console.error('[LoadData] Failed to load availability:', err); return { availability: [] }; }),
            dataApiFetch('/shift-blocks').catch(err => { loadErrors.push('shift-blocks'); console.error('[LoadData] Failed to load shift-blocks:', err); return []; }),
            dataApiFetch('/settings').catch(err => { loadErrors.push('settings'); console.error('[LoadData] Failed to load settings:', err); return { settings: {} }; }),
            // #227: dit ving een echte laadfout af met console.log en gaf altijd
            // { drafts: null } terug, zonder onderscheid tussen "geen rechten"
            // (medewerker) en "de aanroep is mislukt" (bv. tijdens een
            // backend-herstart). console.log is in productie gedempt
            // (app-globals.js), dus dat tweede geval liet letterlijk geen
            // spoor na. De bouwer viel dan stil terug op de oude
            // settings-opslag, die op een moderne database meestal leeg of
            // verouderd is, en een nieuw concept ging vervolgens ook naar die
            // verkeerde plek.
            magConcepten
                ? dataApiFetch('/schedule-drafts').catch(err => {
                    loadErrors.push('concepten');
                    console.error('[LoadData] Failed to load schedule-drafts:', err);
                    return { drafts: null, failed: true };
                })
                : Promise.resolve({ drafts: null }),
            dataApiFetch('/shift-activities').catch(err => { console.log('[LoadData] Activities not available'); return { activities: [] }; }),
            // Nodig op de startpagina: daar herinneren we mensen eraan dat een
            // verlofronde nog op hen wacht, zonder dat ze de verloftab openen.
            dataApiFetch('/leave-rounds').catch(err => { console.log('[LoadData] Verlofrondes niet beschikbaar'); return { rounds: [] }; }),
            // #198: ruilverzoeken werden pas geladen bij het openen van de
            // ruiltab. Daardoor zweeg de kaart "Vraagt je aandacht" op de
            // startpagina precies bij het inloggen, en las de sleepbescherming
            // uit #175 een lege lijst. Wie inlogde, home bekeek en weer wegging
            // miste elke ruil- of overnamevraag.
            dataApiFetch('/swap-requests').catch(err => { loadErrors.push('ruilverzoeken'); console.error('[LoadData] Failed to load swap-requests:', err); return { swapRequests: [] }; })
        ]);

        if (loadErrors.length > 0) {
            // #271: dit stond op 'warning' en verdween dus na vijf seconden.
            // Daarna toont de planning een compleet raster met alle
            // medewerkers en overal 0 uren, zonder enig blijvend teken dat de
            // gegevens ontbreken. Wie de toast miste trok daar conclusies uit.
            // Een 'error'-toast blijft staan tot de gebruiker hem zelf
            // wegklikt (zie ToastManager.show: duration 0 voor 'error').
            if (typeof showToast === 'function') {
                showToast(`Sommige data kon niet geladen worden: ${loadErrors.join(', ')}. Herlaad de pagina om het opnieuw te proberen.`, 'error');
            }
        }

        // Users now contain employee/schedule data
        DataStore.users = usersData.users || [];

        DataStore.shifts = (shiftsData.shifts || []).map(normalizeShift);
        DataStore.activities = (activitiesData.activities || []).map(normalizeActivity);
        DataStore.availability = (availabilityData.availability || []).map(normalizeAvailability);
        // #378: vastleggen welk bereik er nu in de store zit, zodat schermen
        // erbuiten weten dat ze moeten bijladen.
        _geladenAfwezigheidBereik = { startDate: _getAfwezigheidVensterStart(), endDate: _getAfwezigheidVensterEind() };
        _afwezigheidInitieelGeladen = true;
        DataStore.shiftBlocks = (Array.isArray(shiftBlocksData) ? shiftBlocksData : []).map(normalizeShiftBlock);
        AppState.leaveRounds = leaveRoundsData.rounds || [];
        DataStore.swapRequests = swapRequestsData.swapRequests || [];

        // Merge API settings with defaults
        const apiSettings = settingsData.settings || {};
        DataStore.settings = normalizeSettings({
            ...DataStore.settings,
            ...apiSettings.general,
            teams: apiSettings.teams || DataStore.settings.teams,
            rules: apiSettings.rules || DataStore.settings.rules,
            holidayPeriods: apiSettings.holidayPeriods || DataStore.settings.holidayPeriods,
            holidayRules: apiSettings.holidayRules || DataStore.settings.holidayRules,
            closedDates: apiSettings.closedDates || DataStore.settings.closedDates,
            conceptClosedDates: apiSettings.conceptClosedDates || DataStore.settings.conceptClosedDates || [],
            responsibleRotation: apiSettings.responsibleRotation || DataStore.settings.responsibleRotation,
            // planningHorizon: legacy, replaced by school year logic
            schedule_templates: apiSettings.schedule_templates || DataStore.settings.schedule_templates || [],
            schedule_drafts: apiSettings.schedule_drafts || DataStore.settings.schedule_drafts || [],
            schedulePattern: apiSettings.schedule_pattern || DataStore.settings.schedulePattern,
            emailNotifications: apiSettings.email_notifications || DataStore.settings.emailNotifications,
            schoolYearStart: apiSettings.school_year_start || DataStore.settings.schoolYearStart,
            teamMeetings: apiSettings.team_meetings || DataStore.settings.teamMeetings,
            coverageTeams: apiSettings.coverageTeams || DataStore.settings.coverageTeams,
            shiftTemplates: apiSettings.shiftTemplates || DataStore.settings.shiftTemplates,
            nachtForfait: apiSettings.nachtForfait ?? DataStore.settings.nachtForfait,
            dismissedAlerts: apiSettings.dismissedAlerts || DataStore.settings.dismissedAlerts || []
        });

        // Use schedule_drafts from dedicated table if available (overrides settings fallback)
        if (draftsData.drafts) {
            DataStore.settings.schedule_drafts = draftsData.drafts;
            DataStore._draftsFromTable = true;
            DataStore._draftsLoadFailed = false;
        } else if (draftsData.failed) {
            // #227: de tabel-ophaling is echt mislukt (niet zomaar
            // "geen rechten"). DataStore.settings.schedule_drafts houdt de
            // oude/lege fallback dan aan, en de bouwer mag daar niet
            // stilzwijgend naar gaan schrijven: dat concept zou na een
            // geslaagde herlaad onvindbaar zijn voor de rest van de app, want
            // die leest dan weer uit de echte tabel. app-builder-drafts.js
            // controleert deze vlag vóór elke schrijfactie.
            DataStore._draftsLoadFailed = true;
        }

        DataStore._loaded = true;

        // Pre-warm public holiday cache voor dit jaar en aangrenzende jaren
        const now = new Date();
        await Promise.all([
            fetchPublicHolidays(now.getFullYear() - 1),
            fetchPublicHolidays(now.getFullYear()),
            fetchPublicHolidays(now.getFullYear() + 1)
        ]);

        if (DEBUG) console.log('Data geladen van API:', {
            users: DataStore.users.length,
            employees: DataStore.employees.length, // via getter
            shifts: DataStore.shifts.length,
            availability: DataStore.availability.length,
            shiftBlocks: DataStore.shiftBlocks.length
        });

        return true;
    } catch (error) {
        console.error('Fout bij laden van API:', error);
        return false;
    }
}

// ===== MEDEWERKERS/USERS FUNCTIES =====
// Note: These work with users now, but maintain "employee" naming for UI compatibility

async function addEmployee(employeeData) {
    try {
        // Create a user with employee/schedule data
        const userData = {
            ...employeeData,
            // Geen wachtwoord meesturen — backend gebruikt DEFAULT_RESET_PASSWORD
            role: 'medewerker'
        };

        const data = await dataApiFetch('/admin/users', {
            method: 'POST',
            body: JSON.stringify(userData)
        });
        const user = data.user;
        await refreshUsers();
        return user;
    } catch (error) {
        console.error('Fout bij toevoegen medewerker:', error);
        throw error;
    }
}

async function updateEmployee(id, updates) {
    try {
        const index = DataStore.users.findIndex(e => e.id === id);
        if (index === -1) return null;

        const currentUser = DataStore.users[index];
        const updatedData = { ...currentUser, ...updates };

        const data = await dataApiFetch(`/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updatedData)
        });

        const user = data.user;
        await refreshUsers();
        return user;
    } catch (error) {
        console.error('Fout bij bijwerken medewerker:', error);
        throw error;
    }
}

async function deleteEmployee(id) {
    try {
        await dataApiFetch(`/admin/users/${id}`, { method: 'DELETE' });

        // Server cascade deletes related data; refresh all affected caches
        await Promise.all([refreshUsers(), refreshShifts(), refreshAvailability()]);

        return true;
    } catch (error) {
        console.error('Fout bij verwijderen medewerker:', error);
        throw error;
    }
}

async function replaceEmployee(oldUserId, replacementUserId, transferShiftsFrom = null) {
    try {
        const body = { replacementUserId };
        if (transferShiftsFrom) {
            body.transferShiftsFrom = transferShiftsFrom;
        }
        const result = await dataApiFetch(`/admin/users/${oldUserId}/replace`, {
            method: 'POST',
            body: JSON.stringify(body)
        });

        // Refresh all affected caches (including activities which may be transferred)
        await Promise.all([refreshUsers(), refreshShifts(), refreshAvailability(), refreshActivities()]);

        return result;
    } catch (error) {
        console.error('Fout bij vervangen medewerker:', error);
        throw error;
    }
}

function getEmployee(id) {
    // Find in all users (employees are non-admin users)
    return DataStore.users.find(e => e.id === id);
}

function getAllEmployees(activeOnly = false) {
    // Get non-admin users (employees)
    let employees = DataStore.users.filter(u => u.role !== 'admin');
    if (activeOnly) {
        employees = employees.filter(e => e.active !== false);
    }
    return employees;
}

function getEmployeesByTeam(teamId) {
    return getAllEmployees(true).filter(e => e.mainTeam === teamId);
}

// ===== DIENSTEN FUNCTIES =====

async function addShift(shiftData) {
    try {
        // Map employeeId to userId for new API
        const apiData = {
            ...shiftData,
            userId: shiftData.userId || shiftData.employeeId
        };
        delete apiData.employeeId;

        const data = await dataApiFetch('/shifts', {
            method: 'POST',
            body: JSON.stringify(apiData)
        });

        const shift = normalizeShift(data.shift);
        await refreshShifts();
        await fetchShiftBlocks();
        return shift;
    } catch (error) {
        console.error('Fout bij toevoegen dienst:', error);
        throw error;
    }
}

async function addShiftsBulk(shiftsArray, overwriteExisting = false) {
    try {
        const data = await dataApiFetch('/shifts/bulk', {
            method: 'POST',
            body: JSON.stringify({
                shifts: shiftsArray.map(s => ({
                    userId: s.userId || s.employeeId,
                    team: s.team,
                    date: s.date,
                    startTime: s.startTime,
                    endTime: s.endTime,
                    notes: s.notes || ''
                })),
                overwriteExisting
            })
        });

        const newShifts = (data.shifts || []).map(normalizeShift);
        await refreshShifts();
        await fetchShiftBlocks();
        return newShifts;
    } catch (error) {
        console.error('Fout bij bulk toevoegen diensten:', error);
        throw error;
    }
}

async function updateShift(id, updates) {
    try {
        // Map employeeId to userId
        const apiData = { ...updates };
        if (apiData.employeeId && !apiData.userId) {
            apiData.userId = apiData.employeeId;
        }
        delete apiData.employeeId;

        const data = await dataApiFetch(`/shifts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(apiData)
        });

        const shift = normalizeShift(data.shift);
        await refreshShifts();
        return shift;
    } catch (error) {
        console.error('Fout bij bijwerken dienst:', error);
        throw error;
    }
}

// ===== GRANULAIRE REFRESH FUNCTIES =====
// Herladen van specifieke data types van de server (DataStore als pure cache)

async function refreshShifts({ startDate, endDate, merge = false } = {}) {
    // Geen actieve sessie → niets ophalen. Voorkomt 401-ruis wanneer init-code
    // (bv. setCurrentWeek) een refresh triggert vóór de gebruiker is ingelogd.
    if (!leesToken()) return DataStore.shifts;
    try {
        // Auto-use active range if set and no explicit params given
        if (!startDate && !endDate && _activeShiftRange) {
            startDate = _activeShiftRange.startDate;
            endDate = _activeShiftRange.endDate;
            merge = true;
        }

        const params = new URLSearchParams();
        if (startDate && endDate) {
            params.set('startDate', startDate);
            params.set('endDate', endDate);
        }
        const url = '/shifts' + (params.toString() ? '?' + params.toString() : '');
        const data = await dataApiFetch(url);
        const freshShifts = (data.shifts || []).map(normalizeShift);

        if (merge && startDate && endDate) {
            // Partial refresh: replace shifts in range, keep the rest
            DataStore.shifts = DataStore.shifts
                .filter(s => s.date < startDate || s.date > endDate)
                .concat(freshShifts);
        } else {
            DataStore.shifts = freshShifts;
        }
        return DataStore.shifts;
    } catch (error) {
        console.error('[Refresh] Failed to refresh shifts:', error);
        throw error;
    }
}

async function refreshUsers() {
    try {
        const data = await dataApiFetch('/users');
        DataStore.users = data.users || [];
        return DataStore.users;
    } catch (error) {
        console.error('[Refresh] Failed to refresh users:', error);
        throw error;
    }
}

// #378: het bereik dat op dit moment in DataStore.availability zit. Zonder dat
// weten we niet of een scherm iets niet vindt omdat er niets is, of omdat het
// buiten het geladen venster valt. Dat onderscheid is precies wat een windowed
// store gevaarlijk maakt: een scherm blijft stil leeg in plaats van een fout te
// tonen.
let _geladenAfwezigheidBereik = null;
// Tijdens het opstarten roept setCurrentWeek al een bijlading aan, terwijl de
// initiële lading nog onderweg is. Dat leverde twee oproepen op waarvan de
// eerste meteen achterhaald was. Pas bijladen zodra we weten wat er al is.
let _afwezigheidInitieelGeladen = false;

async function refreshAvailability({ startDate, endDate, merge = false } = {}) {
    try {
        const params = new URLSearchParams();
        if (startDate && endDate) {
            params.set('startDate', startDate);
            params.set('endDate', endDate);
        }
        const url = '/availability' + (params.toString() ? '?' + params.toString() : '');
        const data = await dataApiFetch(url);
        const vers = (data.availability || []).map(normalizeAvailability);

        if (merge && startDate && endDate) {
            DataStore.availability = (DataStore.availability || [])
                .filter(a => a.date < startDate || a.date > endDate)
                .concat(vers);
            _geladenAfwezigheidBereik = {
                startDate: _geladenAfwezigheidBereik
                    ? (startDate < _geladenAfwezigheidBereik.startDate ? startDate : _geladenAfwezigheidBereik.startDate)
                    : startDate,
                endDate: _geladenAfwezigheidBereik
                    ? (endDate > _geladenAfwezigheidBereik.endDate ? endDate : _geladenAfwezigheidBereik.endDate)
                    : endDate
            };
        } else {
            DataStore.availability = vers;
            _geladenAfwezigheidBereik = startDate && endDate ? { startDate, endDate } : null;
        }
        return DataStore.availability;
    } catch (error) {
        console.error('[Refresh] Failed to refresh availability:', error);
        throw error;
    }
}

// Zorg dat het gevraagde bereik in de store zit. Laadt bij wanneer nodig en
// geeft terug of dat gelukt is, zodat de aanroeper een melding kan tonen in
// plaats van stil een leeg scherm te laten staan.
async function zorgAfwezigheidVoorBereik(startDate, endDate) {
    if (!_afwezigheidInitieelGeladen) return true;
    const b = _geladenAfwezigheidBereik;
    if (b && startDate >= b.startDate && endDate <= b.endDate) return true;
    try {
        // Ruim nemen, zodat een klik op de volgende week niet meteen weer laadt.
        const van = b && b.startDate < startDate ? b.startDate : startDate;
        const tot = b && b.endDate > endDate ? b.endDate : endDate;
        await refreshAvailability({ startDate: van, endDate: tot, merge: true });
        return true;
    } catch (error) {
        console.error('[Availability] Bijladen mislukt:', error);
        return false;
    }
}

function getGeladenAfwezigheidBereik() { return _geladenAfwezigheidBereik; }

async function fetchShiftBlocks() {
    try {
        const data = await dataApiFetch('/shift-blocks').catch(() => []);
        DataStore.shiftBlocks = (Array.isArray(data) ? data : []).map(normalizeShiftBlock);
        return DataStore.shiftBlocks;
    } catch (error) {
        console.error('Error fetching shift blocks:', error);
        return [];
    }
}

async function deleteShiftBlock(blockId) {
    await dataApiFetch(`/shift-blocks/${blockId}`, { method: 'DELETE' });
    DataStore.shiftBlocks = DataStore.shiftBlocks.filter(b => b.id !== blockId);
}

async function refreshActivities() {
    try {
        const params = new URLSearchParams();
        if (_activeShiftRange) {
            params.set('startDate', _activeShiftRange.startDate);
            params.set('endDate', _activeShiftRange.endDate);
        }
        const url = '/shift-activities' + (params.toString() ? '?' + params.toString() : '');
        const data = await dataApiFetch(url);
        DataStore.activities = (data.activities || []).map(normalizeActivity);
        return DataStore.activities;
    } catch (error) {
        console.error('[Refresh] Failed to refresh activities:', error);
        return [];
    }
}

async function addActivity(activityData) {
    try {
        const data = await dataApiFetch('/shift-activities', {
            method: 'POST',
            body: JSON.stringify(activityData)
        });
        await refreshActivities();
        return normalizeActivity(data.activity);
    } catch (error) {
        console.error('Fout bij aanmaken activiteit:', error);
        throw error;
    }
}

async function updateActivity(id, updates) {
    try {
        const data = await dataApiFetch(`/shift-activities/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
        await refreshActivities();
        return normalizeActivity(data.activity);
    } catch (error) {
        console.error('Fout bij bijwerken activiteit:', error);
        throw error;
    }
}

async function deleteActivity(id) {
    try {
        await dataApiFetch(`/shift-activities/${id}`, { method: 'DELETE' });
        await refreshActivities();
        return true;
    } catch (error) {
        console.error('Fout bij verwijderen activiteit:', error);
        throw error;
    }
}

function getActivitiesByEmployee(userId, date) {
    return DataStore.activities.filter(a =>
        String(a.userId) === String(userId) && a.date === date
    );
}

// skipBlock=true slaat het aanmaken van een shift_block over. Gebruik dat bij
// systeemopkuis, waar het verwijderen geen bewuste keuze is om de cel leeg te
// laten. Zonder blokkade vult een concept de dag bij een volgende toepassing
// gewoon weer.
//
// #189: deze parameter werd wel meegegeven door 'Dag sluiten' maar bestond hier
// niet, dus hij werd stilzwijgend genegeerd en er kwam alsnog een blokkade.
async function deleteShift(id, skipBlock = false) {
    try {
        const url = `/shifts/${id}` + (skipBlock ? '?skipBlock=true' : '');
        await dataApiFetch(url, { method: 'DELETE' });

        await refreshShifts();
        await fetchShiftBlocks();

        return true;
    } catch (error) {
        console.error('Fout bij verwijderen dienst:', error);
        throw error;
    }
}

// #245: dit vergeleek strikt met ===, terwijl id soms als tekst binnenkomt.
// Elke werkende weg parseerde hem eerst naar een getal, maar de maandweergave
// gaf hem via een inline onclick als tekst door ('42'). getShift gaf dan
// undefined, openEditShiftModal deed een stille return, en een klik op een
// dienst opende daar dus niets. Hier vergelijken op getal haalt die valkuil
// voorgoed weg in plaats van hem per aanroeper op te lossen.
function getShift(id) {
    const gezocht = Number(id);
    if (Number.isNaN(gezocht)) return undefined;
    return DataStore.shifts.find(s => Number(s.id) === gezocht);
}

function getShiftsByDate(date) {
    return DataStore.shifts.filter(s => s.date === date);
}

function getShiftsByDateRange(startDate, endDate) {
    return DataStore.shifts.filter(s => s.date >= startDate && s.date <= endDate);
}

async function removeShiftsInDateRange(startDate, endDate) {
    try {
        const data = await dataApiFetch(`/shifts?startDate=${startDate}&endDate=${endDate}`, {
            method: 'DELETE'
        });

        const deletedCount = data.deleted || 0;
        await refreshShifts();
        return deletedCount;
    } catch (error) {
        console.error('Fout bij verwijderen diensten:', error);
        throw error;
    }
}

async function removeAutoShiftsInDateRange(startDate, endDate) {
    try {
        // Get auto shifts in range
        const autoShifts = DataStore.shifts.filter(shift =>
            shift.date >= startDate &&
            shift.date <= endDate &&
            shift.source === 'auto'
        );

        // Delete each auto shift via API
        // Pass skipBlock=true to prevent creating shift_blocks during system cleanup
        let deletedCount = 0;
        for (const shift of autoShifts) {
            try {
                await dataApiFetch(`/shifts/${shift.id}?skipBlock=true`, { method: 'DELETE' });
                deletedCount++;
            } catch (e) {
                console.error(`Fout bij verwijderen auto-shift ${shift.id}:`, e);
            }
        }

        // Update local cache - keep manual shifts, remove auto shifts
        DataStore.shifts = DataStore.shifts.filter(shift =>
            shift.date < startDate ||
            shift.date > endDate ||
            shift.source === 'manual'
        );

        return deletedCount;
    } catch (error) {
        console.error('Fout bij verwijderen auto-diensten:', error);
        throw error;
    }
}

function getShiftsByEmployee(employeeId, startDate = null, endDate = null) {
    // Support both employeeId and userId
    let shifts = DataStore.shifts.filter(s =>
        s.employeeId === employeeId || s.userId === employeeId
    );
    if (startDate && endDate) {
        shifts = shifts.filter(s => s.date >= startDate && s.date <= endDate);
    }
    return shifts;
}

function getShiftsByTeam(teamId, startDate = null, endDate = null) {
    let shifts = DataStore.shifts.filter(s => s.team === teamId);
    if (startDate && endDate) {
        shifts = shifts.filter(s => s.date >= startDate && s.date <= endDate);
    }
    return shifts;
}

// ===== WEEKROOSTER FUNCTIES =====

function getWeekNumber(date) {
    const pattern = getSchedulePattern(date);
    const cycleLength = pattern.cycleLength || 2;
    const referenceDate = parseDateOnly(pattern.referenceDate || DataStore.settings.biWeeklyReferenceDate);
    referenceDate.setHours(0, 0, 0, 0);
    const currentDate = parseDateOnly(date);
    currentDate.setHours(0, 0, 0, 0);

    const refMonday = getMonday(referenceDate);
    refMonday.setHours(0, 0, 0, 0);
    const currMonday = getMonday(currentDate);
    currMonday.setHours(0, 0, 0, 0);

    const diffTime = currMonday.getTime() - refMonday.getTime();
    const diffWeeks = Math.round(diffTime / (1000 * 60 * 60 * 24 * 7));

    // Modulo N for flexible cycle length (1-based: returns 1..cycleLength)
    const mod = diffWeeks % cycleLength;
    return (mod < 0 ? mod + cycleLength : mod) + 1;
}

function getISOWeekNumber(date) {
    const d = parseDateOnly(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

async function applyWeekScheduleForEmployee(employeeId, startDate, endDate) {
    const employee = getEmployee(employeeId);
    if (!employee) {
        return [];
    }

    if (!hasAnyWeekSchedule(employee)) {
        return [];
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);
    const createdShifts = [];

    // Create date copy properly in local timezone to avoid timezone shifts
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= end; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        const dateStr = formatDateYYYYMMDD(d);

        const existingShifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
        if (existingShifts.length > 0) {
            continue;
        }

        const absence = getAvailability(employeeId, dateStr);
        if (absence && absence.type) {
            continue;
        }

        // Skip if there's a shift block for this user/date (from deleted shifts)
        const isBlocked = DataStore.shiftBlocks.some(
            block => block.user_id === employeeId && block.date === dateStr
        );
        if (isBlocked) {
            continue;
        }

        const weekNumber = getWeekNumber(dateStr);
        const weekSchedule = getEmployeeWeekSchedule(employee, weekNumber);

        const scheduleForDay = weekSchedule.find(s => s.dayOfWeek === dayOfWeek);
        if (scheduleForDay && scheduleForDay.enabled) {
            try {
                const shift = await addShift({
                    userId: employeeId,
                    employeeId: employeeId, // Backward compat
                    team: scheduleForDay.team || employee.mainTeam,
                    date: dateStr,
                    startTime: scheduleForDay.startTime,
                    endTime: scheduleForDay.endTime,
                    notes: `Automatisch ingepland via basisrooster (Week ${weekNumber})`,
                    source: 'auto'
                });
                createdShifts.push(shift);
            } catch (error) {
                console.error('Fout bij aanmaken shift:', error);
            }
        }
    }

    return createdShifts;
}

async function applyWeekScheduleForAllEmployees(startDate, endDate) {
    const employees = getAllEmployees(true);
    let totalShifts = 0;

    for (const emp of employees) {
        const shifts = await applyWeekScheduleForEmployee(emp.id, startDate, endDate);
        totalShifts += shifts.length;
    }

    return totalShifts;
}

// ===== AFWEZIGHEID FUNCTIES =====

function getAvailability(employeeId, date) {
    // Support both employeeId and userId
    return DataStore.availability.find(a =>
        (String(a.employeeId) === String(employeeId) || String(a.userId) === String(employeeId)) && a.date === date
    );
}

async function setAvailability(employeeId, date, absenceData, { skipRefresh = false } = {}) {
    if (!absenceData.type) {
        return removeAvailability(employeeId, date, { skipRefresh });
    }

    try {
        const data = await dataApiFetch('/availability', {
            method: 'POST',
            body: JSON.stringify({
                userId: employeeId,
                date,
                type: absenceData.type,
                reason: absenceData.reason || ''
            })
        });

        const absence = normalizeAvailability(data.availability);
        if (!skipRefresh) {
            await refreshAvailability();
        }
        return absence;
    } catch (error) {
        console.error('Fout bij instellen afwezigheid:', error);
        throw error;
    }
}

async function removeAvailability(employeeId, date, { skipRefresh = false } = {}) {
    try {
        await dataApiFetch(`/availability?userId=${employeeId}&date=${date}`, {
            method: 'DELETE'
        });

        if (!skipRefresh) {
            await refreshAvailability();
        }
        return true;
    } catch (error) {
        console.error('Fout bij verwijderen afwezigheid:', error);
        throw error;
    }
}

function getAvailabilityForWeek(employeeId, weekStartDate) {
    const weekDates = getWeekDates(weekStartDate);
    return weekDates.map(date => ({
        date: date,
        availability: getAvailability(employeeId, date)
    }));
}

// ===== SWAP REQUEST FUNCTIES =====

async function getSwapRequests() {
    try {
        const data = await dataApiFetch('/swap-requests');
        DataStore.swapRequests = data.swapRequests || [];
        // #171 en #320: hier stond een telling plus de eerste rij mét
        // requester_name. Namen van medewerkers horen niet in de logs, en de
        // telling is er niet genoeg om dat te rechtvaardigen.
        return DataStore.swapRequests;
    } catch (error) {
        console.error('Fout bij ophalen swap requests:', error);
        throw error;
    }
}

async function createSwapRequest(requestData) {
    try {
        const data = await dataApiFetch('/swap-requests', {
            method: 'POST',
            body: JSON.stringify(requestData)
        });

        // Refresh swap requests list
        await getSwapRequests();

        return data.swapRequest;
    } catch (error) {
        console.error('Fout bij aanmaken swap request:', error);
        throw error;
    }
}

// #285: na een geslaagde mutatie halen deze functies de lijsten opnieuw op.
// Dat gebeurde binnen dezelfde try, en de fout werd doorgegooid. Mislukte die
// verversing, dan meldde de aanroeper "Fout bij overnemen" terwijl de overname
// wél was doorgegaan, en bleef de gebruiker met verouderde gegevens zitten.
//
// De verversing is geen onderdeel van de mutatie. Ze mag dus niet gooien; de
// aanroeper krijgt terug of ze gelukt is en kan daar iets zachters over zeggen.
async function _ververNaMutatie(...taken) {
    try {
        await Promise.all(taken.map(t => t()));
        return true;
    } catch (fout) {
        console.error('Verversen na een geslaagde mutatie mislukt:', fout);
        return false;
    }
}

async function cancelSwapRequest(id) {
    try {
        await dataApiFetch(`/swap-requests/${id}`, { method: 'DELETE' });
    } catch (error) {
        console.error('Fout bij annuleren swap request:', error);
        throw error;
    }
    return { ok: true, ververst: await _ververNaMutatie(getSwapRequests) };
}

async function targetApproveSwapRequest(id, responseNotes, force = false) {
    try {
        await dataApiFetch(`/swap-requests/${id}/target-approve`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes, ...(force ? { force: true } : {}) })
        });
        // De ruil is doorgevoerd; de verversing hierna mag niet meer falen op
        // een manier die dat ongedaan lijkt te maken.
        return { ok: true, ververst: await _ververNaMutatie(getSwapRequests, refreshShifts) };
    } catch (error) {
        console.error('Fout bij target approve swap request:', error);
        throw error;
    }
}

async function targetRejectSwapRequest(id, responseNotes) {
    try {
        await dataApiFetch(`/swap-requests/${id}/target-reject`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes })
        });
        return { ok: true, ververst: await _ververNaMutatie(getSwapRequests) };
    } catch (error) {
        console.error('Fout bij target reject swap request:', error);
        throw error;
    }
}

async function saveBulkAvailabilityWithTakeover(userId, startDate, endDate, type, reason, createTakeoverRequests) {
    const data = await dataApiFetch('/availability/sick-with-takeover', {
        method: 'POST',
        body: JSON.stringify({ userId, startDate, endDate, type, reason, createTakeoverRequests })
    });
    await refreshAvailability();
    return data;
}

async function createTakeoverRequest(shiftId, message) {
    try {
        await dataApiFetch('/shift-requests/takeover', {
            method: 'POST',
            body: JSON.stringify({ shiftId, message })
        });
        await getSwapRequests();
        return true;
    } catch (error) {
        console.error('Fout bij aanmaken takeover request:', error);
        throw error;
    }
}

async function acceptTakeoverRequest(id, responseNotes, force = false) {
    try {
        await dataApiFetch(`/shift-requests/${id}/takeover-accept`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes, ...(force ? { force: true } : {}) })
        });
        // De dienst staat nu op jouw naam. Alles hierna is bijwerken.
        return { ok: true, ververst: await _ververNaMutatie(getSwapRequests, refreshShifts) };
    } catch (error) {
        console.error('Fout bij accepteren takeover:', error);
        throw error;
    }
}

// ===== SETTINGS FUNCTIES =====

async function refreshSettings() {
    try {
        const settingsData = await dataApiFetch('/settings');
        const apiSettings = settingsData.settings || {};
        DataStore.settings = normalizeSettings({
            ...DataStore.settings,
            ...apiSettings.general,
            teams: apiSettings.teams || DataStore.settings.teams,
            rules: apiSettings.rules || DataStore.settings.rules,
            holidayPeriods: apiSettings.holidayPeriods || DataStore.settings.holidayPeriods,
            holidayRules: apiSettings.holidayRules || DataStore.settings.holidayRules,
            closedDates: apiSettings.closedDates || DataStore.settings.closedDates,
            conceptClosedDates: apiSettings.conceptClosedDates || DataStore.settings.conceptClosedDates || [],
            responsibleRotation: apiSettings.responsibleRotation || DataStore.settings.responsibleRotation,
            schedule_templates: apiSettings.schedule_templates || DataStore.settings.schedule_templates || [],
            schedulePattern: apiSettings.schedule_pattern || DataStore.settings.schedulePattern,
            emailNotifications: apiSettings.email_notifications || DataStore.settings.emailNotifications,
            schoolYearStart: apiSettings.school_year_start || DataStore.settings.schoolYearStart,
            teamMeetings: apiSettings.team_meetings || DataStore.settings.teamMeetings,
            coverageTeams: apiSettings.coverageTeams || DataStore.settings.coverageTeams,
            shiftTemplates: apiSettings.shiftTemplates || DataStore.settings.shiftTemplates,
            nachtForfait: apiSettings.nachtForfait ?? DataStore.settings.nachtForfait
        });
    } catch (err) {
        console.error('Fout bij herladen settings:', err);
    }
}

async function saveSettings(key, value) {
    try {
        await dataApiFetch(`/settings/${key}`, {
            method: 'PUT',
            body: JSON.stringify({ value })
        });
        return true;
    } catch (error) {
        console.error('Fout bij opslaan settings:', error);
        throw error;
    }
}

async function saveRulesSettings() {
    await saveSettings('rules', DataStore.settings.rules);
}

async function saveHolidaySettings() {
    await saveSettings('holidayPeriods', DataStore.settings.holidayPeriods);
    await saveSettings('holidayRules', DataStore.settings.holidayRules);
}

async function saveResponsibleRotationSettings() {
    await saveSettings('responsibleRotation', DataStore.settings.responsibleRotation);
}

// ===== UREN BEREKENING =====

// #297: hier stonden een tweede parseDateTime en een tweede
// getShiftEndDateTime. De frontend laadt gewone scripts, dus elke
// functiedeclaratie op het hoogste niveau komt op window terecht en de laatst
// geladene wint. validation.js laadt ná dit bestand, dus deze twee draaiden
// nooit: dode code die er levend uitzag. De valstrik zat in het verschil,
// want deze versie keek alleen naar het UUR (`endHours < startHours`) terwijl
// die in validation.js de volledige tijdstippen vergelijkt. Wie hier de
// nachtdienstlogica aanpaste, zag geen enkel effect.
//
// De enige definities staan nu in validation.js, dat vóór alle app-bestanden
// laadt. De functies hieronder gebruiken ze gewoon.

function calculateShiftHours(shift) {
    const start = parseDateTime(shift.date, shift.startTime);
    const end = getShiftEndDateTime(shift);

    const sleepStart = parseDateTime(shift.date, '23:00');
    const sleepEnd = parseDateTime(shift.date, '07:00');
    sleepEnd.setDate(sleepEnd.getDate() + 1);

    const [startHours] = shift.startTime.split(':').map(Number);
    const [endHours] = shift.endTime.split(':').map(Number);

    // Nachtdienst-forfait: dienst overspant slaapvenster (23:00-07:00)
    // Formule: actieve uren vóór 23u + actieve uren na 07u + forfait
    if (endHours < startHours && endHours >= 7) {
        const nachtForfait = (DataStore.settings && DataStore.settings.nachtForfait != null)
            ? DataStore.settings.nachtForfait
            : 5.25;
        const beforeSleep = Math.max(0, (Math.min(end.getTime(), sleepStart.getTime()) - start.getTime()) / (1000 * 60 * 60));
        const afterSleep = Math.max(0, (end.getTime() - sleepEnd.getTime()) / (1000 * 60 * 60));
        return beforeSleep + afterSleep + nachtForfait;
    }

    // Reguliere berekening: totaal minus slaapoverlap
    const diffMs = end - start;
    let hours = diffMs / (1000 * 60 * 60);

    const overlapStart = Math.max(start.getTime(), sleepStart.getTime());
    const overlapEnd = Math.min(end.getTime(), sleepEnd.getTime());

    if (overlapEnd > overlapStart) {
        hours -= (overlapEnd - overlapStart) / (1000 * 60 * 60);
    }

    return Math.max(0, hours);
}

function _isOvernightWithAfterSleep(shift) {
    const [startH] = shift.startTime.split(':').map(Number);
    const [endH] = shift.endTime.split(':').map(Number);
    return endH < startH && endH >= 7;
}

function _getAfterSleepHours(shift) {
    const end = getShiftEndDateTime(shift);
    const sleepEnd = parseDateTime(shift.date, '07:00');
    sleepEnd.setDate(sleepEnd.getDate() + 1);
    return Math.max(0, (end.getTime() - sleepEnd.getTime()) / (1000 * 60 * 60));
}

function getEmployeeHoursInPeriod(employeeId, startDate, endDate) {
    const shifts = getShiftsByEmployee(employeeId, startDate, endDate);
    let totalHours = 0;

    shifts.forEach(shift => {
        let hours = calculateShiftHours(shift);
        // Nachtshift op de laatste dag van de periode: uren na 07:00 horen bij de volgende periode
        if (shift.date === endDate && _isOvernightWithAfterSleep(shift)) {
            hours -= _getAfterSleepHours(shift);
        }
        totalHours += hours;
    });

    // Nachtshift op de dag vóór de startdatum: uren na 07:00 horen bij deze periode
    const prevDay = new Date(startDate);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = formatDateYYYYMMDD(prevDay);
    getShiftsByEmployee(employeeId, prevDayStr, prevDayStr).forEach(shift => {
        if (_isOvernightWithAfterSleep(shift)) {
            totalHours += _getAfterSleepHours(shift);
        }
    });

    return totalHours;
}

function getEmployeeHoursThisWeek(employeeId, weekStartDate) {
    const weekDates = getWeekDates(weekStartDate);
    const startDate = weekDates[0];
    const endDate = weekDates[6];

    return getEmployeeHoursInPeriod(employeeId, startDate, endDate);
}

function getEmployeeHoursThisMonth(employeeId, date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth();

    const startDate = formatDateYYYYMMDD(new Date(year, month, 1));
    const endDate = formatDateYYYYMMDD(new Date(year, month + 1, 0));

    return getEmployeeHoursInPeriod(employeeId, startDate, endDate);
}

function getFourWeekPeriodDates(date) {
    const schoolWeek = getSchoolWeekNumber(date);
    if (schoolWeek === null) return null;
    const periodIndex = Math.floor((schoolWeek - 1) / 4); // 0-based

    // #244: dit bepaalde het schooljaar zelf, op basis van de datum in plaats
    // van de maandag van de week. Nu dezelfde helper als getSchoolWeekNumber.
    const startMonday = getSchoolYearAnchorMonday(date);
    if (!startMonday) return null;

    const periodStart = new Date(startMonday);
    periodStart.setDate(periodStart.getDate() + periodIndex * 28);
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 27);

    return {
        startDate: formatDateYYYYMMDD(periodStart),
        endDate: formatDateYYYYMMDD(periodEnd)
    };
}

function getEmployeeHoursThisPeriod(employeeId, date) {
    const period = getFourWeekPeriodDates(date);
    if (!period) return 0;
    return getEmployeeHoursInPeriod(employeeId, period.startDate, period.endDate);
}

// ===== STAFFING VALIDATIE =====

function getStaffingForTimeSlot(date, startHour, endHour) {
    const shifts = getShiftsByDate(date);

    const relevantShifts = shifts.filter(shift => {
        const shiftStart = parseInt(shift.startTime.split(':')[0]);
        const shiftEnd = parseInt(shift.endTime.split(':')[0]);

        let adjustedShiftEnd = shiftEnd;
        if (shiftEnd < shiftStart) {
            adjustedShiftEnd = shiftEnd + 24;
        }

        let adjustedSlotEnd = endHour;
        if (endHour > 24) {
            adjustedSlotEnd = endHour;
        }

        return (shiftStart < adjustedSlotEnd && adjustedShiftEnd > startHour);
    });

    const byTeam = {
        vlot1: [],
        vlot2: [],
        cargo: [],
        overkoepelend: [],
        jobstudent: []
    };

    relevantShifts.forEach(shift => {
        if (byTeam[shift.team]) {
            byTeam[shift.team].push(shift);
        }
    });

    return {
        total: relevantShifts.length,
        byTeam: byTeam,
        shifts: relevantShifts
    };
}

function checkStaffingWarnings(date, timeSlot) {
    const warnings = [];
    const staffing = getStaffingForTimeSlot(date, timeSlot.start, timeSlot.end);

    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (!isWeekendOpen(date) && isWeekend) {
        return warnings;
    }

    if (timeSlot.start === 7 || timeSlot.start === 10) {
        const vlotStaff = staffing.byTeam.vlot1.length + staffing.byTeam.vlot2.length;
        if (vlotStaff < 2) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Ochtend: ${vlotStaff}/2 begeleiders (Vlot 1 + Vlot 2)`
            });
        }
    }

    if (timeSlot.start === 16 || timeSlot.start === 19) {
        if (staffing.byTeam.vlot1.length < 2) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 1 avond: ${staffing.byTeam.vlot1.length}/2 begeleiders`
            });
        }
        if (staffing.byTeam.vlot2.length < 2) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 2 avond: ${staffing.byTeam.vlot2.length}/2 begeleiders`
            });
        }
    }

    if (timeSlot.start === 22) {
        if (staffing.byTeam.vlot1.length > 1) {
            warnings.push({
                type: 'overstaffed',
                severity: 'warning',
                message: `Vlot 1 nacht: ${staffing.byTeam.vlot1.length}/1 begeleider (te veel)`
            });
        }
        if (staffing.byTeam.vlot2.length > 1) {
            warnings.push({
                type: 'overstaffed',
                severity: 'warning',
                message: `Vlot 2 nacht: ${staffing.byTeam.vlot2.length}/1 begeleider (te veel)`
            });
        }

        if (staffing.byTeam.vlot1.length === 0) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 1 nacht: geen nachtdienst ingepland`
            });
        }
        if (staffing.byTeam.vlot2.length === 0) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 2 nacht: geen nachtdienst ingepland`
            });
        }
    }

    return warnings;
}

// ===== HELPER FUNCTIES =====

function isWeekendOpen(date) {
    // Backward compat wrapper: checks if this date (or its weekend) is open
    // For adjacent days (Friday, Monday), checks the Saturday of that weekend
    const d = parseDateOnly(date);
    const dayOfWeek = d.getDay();

    // Weekdays (Tue-Thu) are never closed as "weekend"
    if (dayOfWeek >= 2 && dayOfWeek <= 4) {
        return true;
    }

    // For Friday/Monday, check their adjacent Saturday
    let checkDate = date;
    if (dayOfWeek === 5) {
        const saturday = new Date(d);
        saturday.setDate(d.getDate() + 1);
        checkDate = formatDateYYYYMMDD(saturday);
    } else if (dayOfWeek === 1) {
        const saturday = new Date(d);
        saturday.setDate(d.getDate() - 2);
        checkDate = formatDateYYYYMMDD(saturday);
    }

    return !isDayClosed(checkDate);
}

// ===== FLEXIBEL ROOSTERPATROON FUNCTIES =====

function getSchedulePattern(forDate) {
    const stored = DataStore.settings.schedulePattern;
    if (stored && stored.cycleLength) {
        // Date-aware: if effectiveFrom is set and forDate is before it, use previousPattern
        if (forDate && stored.effectiveFrom && stored.previousPattern) {
            const checkDate = parseDateOnly(forDate);
            const effectiveDate = parseDateOnly(stored.effectiveFrom);
            if (checkDate < effectiveDate) {
                return stored.previousPattern;
            }
        }
        return stored;
    }
    // Backward compat: construct from biWeeklyReferenceDate
    return {
        cycleLength: 2,
        referenceDate: DataStore.settings.biWeeklyReferenceDate || '2025-01-06',
        weeks: {
            "1": { closedDays: [6, 0], label: "Weekend gesloten" },
            "2": { closedDays: [], label: "Weekend open" }
        }
    };
}

function getCycleLength(forDate) {
    return getSchedulePattern(forDate).cycleLength || 2;
}

function getClosedDaysForWeek(weekNumber, forDate) {
    const pattern = getSchedulePattern(forDate);
    const weekConfig = pattern.weeks?.[String(weekNumber)];
    return weekConfig?.closedDays || [];
}

function getWeekLabel(weekNumber, forDate) {
    const pattern = getSchedulePattern(forDate);
    const weekConfig = pattern.weeks?.[String(weekNumber)];
    if (weekConfig?.label) return weekConfig.label;
    const closedDays = getClosedDaysForWeek(weekNumber, forDate);
    return closedDays.length > 0 ? `${formatClosedDays(closedDays)}` : 'Alle dagen open';
}

function isDayClosed(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    if (isDateManuallyClosed(dateStr)) return true;
    // Een vakantieconcept schrijft zijn patroon niet naar schedule_pattern —
    // die cyclus is vakantie-relatief. Zijn gesloten dagen staan daarom als
    // absolute datums in conceptClosedDates.
    if (isDateClosedByDraft(dateStr)) return true;
    const d = parseDateOnly(date);
    const dayOfWeek = d.getDay();
    const weekNumber = getWeekNumber(date);
    const closedDays = getClosedDaysForWeek(weekNumber, date);
    return closedDays.includes(dayOfWeek);
}

function isDayClosedForWeek(dayOfWeek, weekNumber) {
    const closedDays = getClosedDaysForWeek(weekNumber);
    return closedDays.includes(dayOfWeek);
}

function getEmployeeWeekSchedule(employee, weekNumber) {
    // Try new format first (array of N week schedules)
    if (Array.isArray(employee.weekSchedules) && employee.weekSchedules.length > 0) {
        return employee.weekSchedules[weekNumber - 1] || [];
    }
    // Fall back to old format (2 fixed columns)
    if (weekNumber === 1) return employee.weekScheduleWeek1 || [];
    if (weekNumber === 2) return employee.weekScheduleWeek2 || [];
    return [];
}

function hasAnyWeekSchedule(employee) {
    if (Array.isArray(employee.weekSchedules)) {
        return employee.weekSchedules.some(ws => Array.isArray(ws) && ws.length > 0);
    }
    return (employee.weekScheduleWeek1?.length > 0) || (employee.weekScheduleWeek2?.length > 0);
}

function formatClosedDays(closedDays) {
    if (!closedDays || closedDays.length === 0) return 'alle dagen open';
    const dayMap = { 0: 'zo', 1: 'ma', 2: 'di', 3: 'wo', 4: 'do', 5: 'vr', 6: 'za' };
    return closedDays.map(d => dayMap[d]).join(', ') + ' gesloten';
}

function getOpenDaysForWeek(weekNumber) {
    const closedDays = getClosedDaysForWeek(weekNumber);
    // Return JS dayOfWeek numbers for open days (0=zo, 1=ma, ..., 6=za)
    return [1, 2, 3, 4, 5, 6, 0].filter(d => !closedDays.includes(d));
}

// ===== VAKANTIE FUNCTIES =====

function isHolidayPeriod(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const checkDate = parseDateOnly(dateStr);

    return DataStore.settings.holidayPeriods.some(period => {
        const start = parseDateOnly(period.startDate);
        const end = parseDateOnly(period.endDate);
        return checkDate >= start && checkDate <= end;
    });
}

function getHolidayPeriod(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const checkDate = parseDateOnly(dateStr);

    return DataStore.settings.holidayPeriods.find(period => {
        const start = parseDateOnly(period.startDate);
        const end = parseDateOnly(period.endDate);
        return checkDate >= start && checkDate <= end;
    });
}

async function addHolidayPeriod(name, startDate, endDate) {
    const period = {
        id: Date.now(),
        name: name,
        startDate: startDate,
        endDate: endDate
    };
    DataStore.settings.holidayPeriods.push(period);
    await saveHolidaySettings();
    return period;
}

async function removeHolidayPeriod(id) {
    const index = DataStore.settings.holidayPeriods.findIndex(p => p.id === id);
    if (index !== -1) {
        DataStore.settings.holidayPeriods.splice(index, 1);
        await saveHolidaySettings();
        return true;
    }
    return false;
}

async function updateHolidayRules(rules) {
    DataStore.settings.holidayRules = { ...DataStore.settings.holidayRules, ...rules };
    await saveHolidaySettings();
}

// ===== BELGISCHE FEESTDAGEN =====

async function fetchPublicHolidays(year) {
    if (DataStore._publicHolidaysCache[year]) return DataStore._publicHolidaysCache[year];
    if (DataStore._publicHolidaysFetching.has(year)) return DataStore._publicHolidaysCache[year] || [];
    DataStore._publicHolidaysFetching.add(year);
    try {
        const response = await fetch(`${window.API_BASE}/public-holidays?year=${year}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        DataStore._publicHolidaysCache[year] = data.holidays || [];
    } catch (err) {
        console.error('[fetchPublicHolidays] Fout:', err);
        DataStore._publicHolidaysCache[year] = [];
    } finally {
        DataStore._publicHolidaysFetching.delete(year);
    }
    return DataStore._publicHolidaysCache[year];
}

function isPublicHoliday(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const year = parseInt(dateStr.slice(0, 4), 10);
    const cached = DataStore._publicHolidaysCache[year];
    if (!cached) return false;
    return cached.some(h => h.date === dateStr);
}

function getPublicHoliday(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const year = parseInt(dateStr.slice(0, 4), 10);
    const cached = DataStore._publicHolidaysCache[year];
    if (!cached) return null;
    return cached.find(h => h.date === dateStr) || null;
}

// ===== MANUEEL GESLOTEN DATUMS =====

function isDateManuallyClosed(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    return (DataStore.settings.closedDates || []).some(d => d.date === dateStr);
}

// Gesloten dagen die uit een toegepast VAKANTIEconcept komen. Ze staan apart
// van closedDates omdat die lijst van de gebruiker is: deze horen bij hun
// concept, worden bij elke toepassing vervangen, en verschijnen daarom niet
// in het lijstje "manueel gesloten datums" in Instellingen.
function isDateClosedByDraft(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    return (DataStore.settings.conceptClosedDates || []).some(d => d.date === dateStr);
}

function getClosedDateInfo(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    return (DataStore.settings.closedDates || []).find(d => d.date === dateStr)
        || (DataStore.settings.conceptClosedDates || []).find(d => d.date === dateStr)
        || null;
}

async function addClosedDate(date, reason = '') {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    if (!DataStore.settings.closedDates) DataStore.settings.closedDates = [];
    if (DataStore.settings.closedDates.some(d => d.date === dateStr)) return;
    DataStore.settings.closedDates.push({ date: dateStr, reason });
    DataStore.settings.closedDates.sort((a, b) => a.date.localeCompare(b.date));
    await saveSettings('closedDates', DataStore.settings.closedDates);
}

async function removeClosedDate(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    DataStore.settings.closedDates = (DataStore.settings.closedDates || []).filter(d => d.date !== dateStr);
    await saveSettings('closedDates', DataStore.settings.closedDates);
}

// ===== WEEKEND/VAKANTIE VERANTWOORDELIJKE =====

function getEligibleEmployeesForResponsible() {
    const eligibleTeams = DataStore.settings.responsibleRotation?.eligibleTeams || ['vlot1', 'vlot2', 'cargo'];
    return getAllEmployees(true).filter(emp =>
        eligibleTeams.includes(emp.mainTeam)
    ).sort((a, b) => a.name.localeCompare(b.name));
}

// Alias — identical to getMonday() but kept for backward compat
function getMondayOfWeek(date) { return getMonday(date); }

function getWeekendResponsible(weekStartDate) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    const assignments = DataStore.settings.responsibleRotation?.assignments || {};

    if (assignments[dateKey]) {
        return getEmployee(assignments[dateKey]);
    }
    return null;
}

function getOrCalculateResponsible(weekStartDate) {
    const manual = getWeekendResponsible(weekStartDate);
    if (manual) return manual;

    // Vakantie verantwoordelijke override: check elke dag in de week
    for (let i = 0; i < 7; i++) {
        const day = new Date(parseDateOnly(weekStartDate));
        day.setDate(day.getDate() + i);
        const hp = getHolidayPeriod(day);
        if (hp) {
            // Per-week responsible (weeklyResponsibles) takes priority over legacy single responsibleId
            if (hp.weeklyResponsibles) {
                const periodStart = parseDateOnly(hp.startDate);
                const periodMonday = getMondayOfWeek(periodStart);
                const thisMonday = getMondayOfWeek(day);
                const weekNum = Math.floor((thisMonday - periodMonday) / (7 * 86400000)) + 1;
                const respId = hp.weeklyResponsibles[String(weekNum)];
                if (respId) {
                    const emp = getEmployee(respId);
                    if (emp) return emp;
                }
            } else if (hp.responsibleId) {
                // Legacy: single responsible for entire period
                const emp = getEmployee(hp.responsibleId);
                if (emp) return emp;
            }
        }
    }

    const rotation = DataStore.settings.responsibleRotation;
    if (!rotation) return null;

    // Date-aware: if effectiveFrom is set and target date is before it, use previousRotation
    let activeRotation = rotation;
    if (rotation.effectiveFrom && rotation.previousRotation) {
        const targetDate = new Date(weekStartDate);
        targetDate.setHours(0, 0, 0, 0);
        const effectiveDate = parseDateOnly(rotation.effectiveFrom);
        if (targetDate < effectiveDate) {
            activeRotation = { ...rotation, ...rotation.previousRotation };
        }
    }

    if (!activeRotation?.rotationStart || !activeRotation?.rotationStartEmployee) {
        return null;
    }

    const eligible = getEligibleEmployeesForResponsible();
    if (eligible.length === 0) return null;

    const startEmployeeId = String(activeRotation.rotationStartEmployee);
    const startIndex = eligible.findIndex(e => String(e.id) === startEmployeeId);
    if (startIndex === -1) return eligible[0];

    const startDate = parseDateOnly(activeRotation.rotationStart);
    startDate.setHours(0, 0, 0, 0);
    const targetDate = parseDateOnly(weekStartDate);
    targetDate.setHours(0, 0, 0, 0);

    if (targetDate < startDate) return null;

    let count = 0;
    const current = new Date(startDate);

    while (current.getTime() < targetDate.getTime()) {
        // Skip vakantieweken in rotatie count — alleen open weekenden buiten vakantie tellen mee
        const inVakantie = (function() {
            for (let i = 0; i < 7; i++) {
                const day = new Date(current);
                day.setDate(current.getDate() + i);
                if (getHolidayPeriod(day)) return true;
            }
            return false;
        })();
        if (!inVakantie && isWeekendOrHolidayWeek(current)) {
            count++;
        }
        current.setDate(current.getDate() + 7);
    }

    const currentIndex = (startIndex + count) % eligible.length;
    return eligible[currentIndex];
}

async function setRotationStart(startDate, employeeId) {
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = {
            eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
            assignments: {}
        };
    }
    DataStore.settings.responsibleRotation.rotationStart = formatDateYYYYMMDD(startDate);
    DataStore.settings.responsibleRotation.rotationStartEmployee = String(employeeId);
    await saveResponsibleRotationSettings();
}

async function setWeekendResponsible(weekStartDate, employeeId) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = {
            eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
            assignments: {}
        };
    }
    DataStore.settings.responsibleRotation.assignments[dateKey] = employeeId;
    await saveResponsibleRotationSettings();
}

async function removeWeekendResponsible(weekStartDate) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    if (DataStore.settings.responsibleRotation?.assignments) {
        delete DataStore.settings.responsibleRotation.assignments[dateKey];
        await saveResponsibleRotationSettings();
    }
}

function isWeekendOrHolidayWeek(weekStartDate) {
    const monday = parseDateOnly(weekStartDate);
    monday.setHours(0, 0, 0, 0);

    // Check if weekend is open (i.e. Saturday is NOT a closed day)
    const weekNumber = getWeekNumber(monday);
    const closedDays = getClosedDaysForWeek(weekNumber, monday);
    const isOpenWeekend = !closedDays.includes(6) && !closedDays.includes(0);

    let hasHoliday = false;
    for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        if (isHolidayPeriod(day)) {
            hasHoliday = true;
            break;
        }
    }

    return isOpenWeekend || hasHoliday;
}

function formatDateYYYYMMDD(date) {
    const d = parseDateOnly(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDate(date) {
    const d = parseDateOnly(date);
    return d.toLocaleDateString('nl-BE', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function formatTime(time) {
    return time;
}

function getMonday(date) {
    const d = parseDateOnly(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d;
}

function getWeekDates(date) {
    const monday = getMonday(date);

    const dates = [];
    for (let i = 0; i < 7; i++) {
        // Create a new date in local timezone to avoid timezone shifts
        const weekDate = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
        dates.push(formatDateYYYYMMDD(weekDate));
    }
    return dates;
}

// Get first day of month (always 1st of month, 00:00:00)
// ===== LEGACY COMPATIBILITY =====
// These functions are kept for compatibility but do nothing with localStorage

// #273: saveToStorage en loadFromStorage waren sinds de overstap naar de API
// lege functies die alleen true teruggaven. Ze stonden er als
// legacy-compatibiliteit, maar de enige gebruikers waren aanroepen die deden
// alsof er iets bewaard werd. Die zijn weg, dus deze twee ook.

async function resetData() {
    const scope = await showSelectPrompt(
        'Wat wil je verwijderen? Dit kan niet ongedaan worden gemaakt!',
        'Data wissen',
        [
            // #292: de verlofrondes werden niet gewist én niet genoemd. Nu
            // worden ze wel gewist, dus hoort de keuze dat ook te zeggen.
            { value: 'data', label: 'Alleen planningsdata (diensten, afwezigheden, verlofrondes, concepten, instellingen)' },
            { value: 'data_users', label: 'Planning data + medewerker-accounts' },
            { value: 'all', label: 'Alles behalve mijn account' }
        ]
    );
    if (!scope) return;

    const labels = { data: 'planningsdata', data_users: 'planningsdata en medewerkeraccounts', all: 'alle data en accounts (behalve jouw account)' };
    if (!await showConfirm(`LAATSTE WAARSCHUWING: ${labels[scope]} wordt permanent verwijderd. Doorgaan?`,
        'Laatste waarschuwing', { danger: true, confirmText: 'Definitief wissen' })) {
        return;
    }

    try {
        await dataApiFetch(`/reset-data?scope=${scope}`, { method: 'DELETE' });
        alert('Data is gewist. De pagina wordt herladen.');
        location.reload();
    } catch (error) {
        showToast('Fout bij wissen: ' + error.message, 'error');
    }
}

// ===== AUDIT LOG =====

async function fetchAuditLog(filters = {}) {
    const params = new URLSearchParams();
    if (filters.page) params.set('page', filters.page);
    if (filters.limit) params.set('limit', filters.limit);
    if (filters.actorId) params.set('actorId', filters.actorId);
    if (filters.action) params.set('action', filters.action);
    if (filters.resourceType) params.set('resourceType', filters.resourceType);
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    return dataApiFetch(`/audit-log?${params.toString()}`);
}

// ===== SCHEDULE DRAFTS =====

async function fetchScheduleDrafts() {
    return dataApiFetch('/schedule-drafts');
}

async function createScheduleDraft(draft) {
    return dataApiFetch('/schedule-drafts', {
        method: 'POST',
        body: JSON.stringify(draft)
    });
}

async function updateScheduleDraft(id, data) {
    return dataApiFetch(`/schedule-drafts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
    });
}

/**
 * #148 stap 1: één week wegschrijven in plaats van het hele concept.
 *
 * updateScheduleDraft hierboven stuurt het VOLLEDIGE raster mee, dus alle weken
 * zoals deze browser ze kent. Zodra twee mensen tegelijk in hetzelfde concept
 * mogen werken, wist de een daarmee het werk van de ander. Deze route raakt
 * alleen de week die je bewerkt hebt; de samenvoeging gebeurt in de databank.
 */
async function updateScheduleDraftWeek(id, week, data) {
    return dataApiFetch(`/schedule-drafts/${id}/weeks/${week}`, {
        method: 'PATCH',
        body: JSON.stringify(data)
    });
}

async function deleteScheduleDraft(id) {
    return dataApiFetch(`/schedule-drafts/${id}`, {
        method: 'DELETE'
    });
}

// #171: deze twee gebruikten een kale fetch, tegen CLAUDE.md regel 9 in. De
// reden was de 423 bij een vergrendeld concept: die is geen fout maar een
// antwoord, en dataApiFetch gooit op alles wat niet ok is.
//
// Dat kan nu gewoon, want de fout uit dataApiFetch draagt sinds #268 zowel
// status als het volledige antwoordlichaam. De vorm die de aanroepers kennen,
// { ok, status, ...data }, blijft daardoor ongewijzigd; alleen komt de
// Authorization-header, de tijdslimiet en de 401-afhandeling er nu bij.
async function lockScheduleDraft(id, force = false) {
    try {
        const data = await dataApiFetch(`/schedule-drafts/${id}/lock`, {
            method: 'POST',
            body: JSON.stringify({ force })
        });
        return { ok: true, status: 200, ...data };
    } catch (fout) {
        // Zonder status is het geen antwoord van de server maar een netwerkfout,
        // en die hoort door te gaan naar de aanroeper (#332).
        if (!fout.status) throw fout;
        return { ok: false, status: fout.status, ...(fout.data || {}) };
    }
}

async function unlockScheduleDraft(id) {
    if (!id) return;
    // Best effort: het ontgrendelen mag nooit de handeling erboven laten falen.
    // De vervaltermijn van dertig minuten vangt een mislukking op (#304).
    await dataApiFetch(`/schedule-drafts/${id}/unlock`, { method: 'POST' }).catch(() => {});
}

async function applyScheduleDraft(draftId, { clearBlocks = true, applyStartDate = null, applyEndDate = null, confirmOverlap = false, confirmOverwrite = null } = {}) {
    return dataApiFetch(`/schedule-drafts/${draftId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ clearBlocks, applyStartDate, applyEndDate, confirmOverlap, confirmOverwrite })
    });
}

async function deactivateDraftShifts(draftId, { endDate, deleteManual = false }) {
    return dataApiFetch(`/schedule-drafts/${draftId}/deactivate`, {
        method: 'POST',
        body: JSON.stringify({ endDate, deleteManual })
    });
}

// ===== SCHOOLJAAR =====

function getSchoolYearStart() {
    const raw = DataStore.settings.schoolYearStart?.date || null;
    if (!raw) {
        // Default: September 1 of the current school year
        const now = new Date();
        const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
        return `${year}-09-01`;
    }
    // Handle ISO timestamps: extract YYYY-MM-DD part
    if (raw.includes('T')) return raw.split('T')[0];
    return raw;
}

// Returns the Monday that anchors the school year:
// - weekday (Mon–Fri): Monday of that same week
// - weekend (Sat/Sun): the following Monday (school doesn't start mid-weekend)
function getSchoolAnchorMonday(date) {
    const d = parseDateOnly(date);
    const day = d.getDay();
    if (day === 6) d.setDate(d.getDate() + 2); // Sat → Mon
    else if (day === 0) d.setDate(d.getDate() + 1); // Sun → Mon
    return getMonday(d);
}

// #244: de ankermaandag van het schooljaar waar deze datum in valt.
//
// Dit stond twee keer uitgeschreven, en de twee kopieën kozen het schooljaar
// net iets anders: getSchoolWeekNumber vergeleek de MAANDAG van de week met de
// startdatum, getFourWeekPeriodDates de datum zelf. Zodra de schooljaarstart
// niet op een maandag valt, kiezen die twee voor de dagen tussen de startdatum
// en de eerstvolgende maandag een verschillend schooljaar. Het weeknummer kwam
// dan uit het vorige schooljaar (week 53, dus periodeIndex 13) terwijl de
// ankermaandag uit het nieuwe kwam, en de periode sprong 364 dagen vooruit.
//
// Met één helper kunnen ze niet opnieuw uit elkaar lopen. De maandag is de
// juiste maatstaf, want zowel het weeknummer als de periode lopen per week.
function getSchoolYearAnchorMonday(date) {
    const start = getSchoolYearStart();
    if (!start) return null;
    const currentMonday = getMonday(parseDateOnly(date));
    currentMonday.setHours(0, 0, 0, 0);

    const startDate = parseDateOnly(start);
    const syMonth = startDate.getMonth();
    const syDay = startDate.getDate();

    // De grens tussen twee schooljaren is de ANKERMAANDAG, niet de ruwe
    // startdatum. Vergeleken we met de startdatum zelf, dan viel de maandag
    // van de startweek nog in het vorige schooljaar terwijl hij tegelijk het
    // anker van het nieuwe was. Bij een start op dinsdag 1 september 2026 gaf
    // dat voor maandag 31 augustus week 53, terwijl diezelfde dag ook week 1
    // van het nieuwe jaar is.
    const ankerVan = (jaar) => {
        const d = new Date(jaar, syMonth, syDay);
        d.setHours(0, 0, 0, 0);
        const m = getSchoolAnchorMonday(d);
        m.setHours(0, 0, 0, 0);
        return m;
    };

    let syYear = currentMonday.getFullYear();
    let startMonday = ankerVan(syYear);
    if (currentMonday < startMonday) {
        syYear--;
        startMonday = ankerVan(syYear);
    }
    return startMonday;
}

function getSchoolWeekNumber(date) {
    const startMonday = getSchoolYearAnchorMonday(date);
    if (!startMonday) return null;
    const currentMonday = getMonday(parseDateOnly(date));
    currentMonday.setHours(0, 0, 0, 0);
    const diffWeeks = Math.round((currentMonday.getTime() - startMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return diffWeeks + 1; // 1-based
}

async function saveSchoolYearStart(date) {
    DataStore.settings.schoolYearStart = { date };
    await dataApiFetch('/settings/school_year_start', {
        method: 'PUT',
        body: JSON.stringify({ value: { date } })
    });
}

function getActiveBasisDraft() {
    const today = formatDateYYYYMMDD(new Date());
    const drafts = DataStore.settings.schedule_drafts || [];
    return drafts.find(d =>
        d.type !== 'vakantie' &&
        d.lastAppliedFrom && d.lastAppliedUntil &&
        d.lastAppliedFrom <= today &&
        d.lastAppliedUntil >= today
    ) || null;
}

function getStaffingRulesForDay(dateStr) {
    const draft = getActiveBasisDraft();
    if (!draft?.grid?._staffingRules) return null;
    const weekNum = getWeekNumber(dateStr);
    const d = parseDateOnly(dateStr);
    const dayIndex = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
    const weekRules = draft.grid._staffingRules[String(weekNum)];
    if (!weekRules) return null;
    const raw = weekRules[String(dayIndex)];
    if (!raw || (Array.isArray(raw) && raw.length === 0)) return null;
    // Normaliseer oud formaat ({hour: min} object) naar nieuw ([{from,to,min}])
    if (!Array.isArray(raw)) {
        return Object.entries(raw).map(([h, min]) =>
            ({ from: Number(h), to: Number(h) + 1, min: Number(min) })
        );
    }
    return raw;
}

function getWeekScheduleFromDraft(employee, weekNumber, draft) {
    if (!draft || !draft.grid) return null;
    const grid = draft.grid;
    const isMultiWeek = !!grid._multiWeek;

    let empGrid;
    if (isMultiWeek) {
        const weekGrid = grid[String(weekNumber)];
        empGrid = weekGrid ? (weekGrid[String(employee.id)] || weekGrid[employee.id]) : null;
    } else {
        if (weekNumber !== 1) return null;
        empGrid = grid[String(employee.id)] || grid[employee.id];
    }

    if (!empGrid) return null;

    // Grid dayIndex 0=ma..6=zo → JS dayOfWeek 0=zo..6=za
    const entries = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const assignment = empGrid[String(dayIndex)] || empGrid[dayIndex];
        if (assignment) {
            const jsDayOfWeek = dayIndex === 6 ? 0 : dayIndex + 1;
            entries.push({
                dayOfWeek: jsDayOfWeek,
                enabled: true,
                startTime: assignment.startTime,
                endTime: assignment.endTime,
                team: assignment.team
            });
        }
    }
    return entries.length > 0 ? entries : null;
}

// ===== INITIALISATIE =====
// Data wordt geladen via loadDataFromAPI() na login in app.js

// Allow the pure school-year helpers to be imported in Node.js (for unit tests).
// This does not affect browser behavior since `module` is not defined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseDateOnly,
    formatDateYYYYMMDD,
    getMonday,
    getSchoolAnchorMonday,
    getSchoolYearAnchorMonday,
    getSchoolWeekNumber,
    getFourWeekPeriodDates
  };
}
