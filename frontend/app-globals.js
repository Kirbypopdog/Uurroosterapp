// HET VLOT ROOSTERPLANNING - GLOBALE STATE EN CONSTANTEN

// Debug guard: console.log alleen actief op localhost
const DEBUG = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
if (!DEBUG) {
  // Silence logs in production; errors/warnings blijven zichtbaar
  console.log = function() {};
  console.debug = function() {};
}

// App State
const AppState = {
    currentUser: null,
    authToken: null,
    isAuthenticating: false, // Prevent concurrent authentication attempts
    currentView: 'home',
    // Verlofplanning
    leaveRounds: [],          // lijst van rondes
    leaveRound: null,         // geladen detail (ronde + entries + submissions)
    leaveRoundId: null,       // welke ronde staat open in de view
    leaveScreen: 'landing',   // 'landing' | 'blok' | 'overzicht'
    leaveBlockId: null,       // welke vakantie staat open
    leaveDraft: {},           // { 'YYYY-MM-DD': status } vóór opslaan
    schedulesGenerated: false, // Flag to prevent duplicate auto-generation
    currentWeekStart: null,
    // #331: gezet wanneer de diensten voor de zichtbare week niet geladen
    // konden worden: { week: 'YYYY-MM-DD', melding: '...' }. De planner toont
    // dan een balk in plaats van stilzwijgend een lege week.
    weekLaadFout: null,
    viewMode: 'week',
    visibleTeams: ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend'],
    visibleEmployeeTeams: ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend'],
    employeeWeekOffsets: {},
    editingShiftId: null,
    editingEmployeeId: null,
    warningBreakdown: null,
    errorBreakdown: null,
    apiTeams: [],
    activeSettingsTab: 'accounts',
    mobileDayIndex: 0, // 0=Monday, 1=Tuesday, ..., 6=Sunday (for mobile day view)
    availabilityMobileDayIndex: 0, // Same for availability view
    simulatedRole: null, // For admin testing: simulates different user roles
    // Builder state
    builderScreen: 'overview',   // 'overview' | 'editor'
    builderOverviewFilter: 'all', // 'all' | 'active' | 'scheduled' | 'draft'
    builderWeekNumber: 1,        // 1 or 2 (bi-weekly)
    builderTeamFilter: null,
    builderGrid: {},             // { [userId]: { [dayIndex0to6]: { startTime, endTime, team } } }
    builderGridByWeek: {},       // { [weekNumber]: builderGrid } — cache per week bij switchen
    builderVuileWeken: new Set(), // #148: welke weken sinds de laatste autosave veranderd zijn
    builderLoadedDraftId: null,   // ID van het geladen concept (null = geen concept geladen)
    builderLoadedDraftName: null, // naam van het geladen concept
    builderIsDirty: false,
    builderAutoSaveTimer: null,
    builderAutoSavedAt: null,
    builderPatternExpanded: false,
    builderPattern: null,         // lokaal patroon (null = gebruik globaal)
    builderStaffingRules: {},     // huidige week bezettingsregels { [dayIndex]: { [hour]: minCount } }
    builderStaffingRulesByWeek: {}, // cache per week (zelfde patroon als builderGridByWeek)
    builderShowStaffingEditor: false, // toggle bezettingsregels editor
    builderShowMeetingsEditor: false, // toggle teamvergaderingen editor
    builderMeetings: {},              // per-concept teamvergaderingen { [teamId]: [{ day, from, to }] }
    showHeatmap: false,
    filterOnlyWithShifts: false,
    planningControlsCollapsed: true,
    settingsDirty: false,
    swapTeamFilter: ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend'],
    collapsedTeams: new Set()
};

// ===== TEAM HELPERS =====
function getTeamOrder() {
    const teams = DataStore.settings.teams || {};
    return Object.keys(teams).sort((a, b) => {
        const oa = teams[a]?.sort_order ?? 9999;
        const ob = teams[b]?.sort_order ?? 9999;
        return oa !== ob ? oa - ob : (teams[a]?.name || '').localeCompare(teams[b]?.name || '');
    });
}

// #370: de ruilmodal zette shift.team ongewijzigd op het scherm, dus daar stond
// "Team: vlot1" terwijl de overnamemodal in dezelfde stroom wél "Vlot 1
// (Begeleiding)" toonde. De opzoeking stond op een handvol plekken uitgeschreven
// en op één plek helemaal niet. Nu één helper, met de sleutel als laatste
// redmiddel zodat een team dat uit de instellingen is gehaald niet als lege
// tekst verschijnt.
function getTeamName(teamId) {
    if (!teamId) return '';
    return DataStore.settings.teams?.[teamId]?.name || teamId;
}

function syncTeamFilters() {
    const teams = getTeamOrder();
    if (teams.length > 0) {
        AppState.visibleTeams = [...teams];
        AppState.visibleEmployeeTeams = [...teams];
        AppState.swapTeamFilter = [...teams];
    }
}

// ===== UNDO/REDO MANAGER =====
const UndoManager = {
    actions: [],
    pointer: -1,
    maxHistory: 50,
    _executing: false, // Guard flag to prevent recording during undo/redo

    canUndo() { return this.pointer >= 0; },
    canRedo() { return this.pointer < this.actions.length - 1; },

    push(action) {
        if (this._executing) return; // Don't record actions triggered by undo/redo
        // Validate action has required data before storing
        if (action.type === 'update' && !action.shiftId) {
            console.warn('[UndoManager] Skipping update action with missing shiftId');
            return;
        }
        if (action.type === 'delete' && !action.resultId && !action.shiftId) {
            console.warn('[UndoManager] Skipping delete action with missing ID');
            return;
        }
        this.actions = this.actions.slice(0, this.pointer + 1);
        this.actions.push(action);
        if (this.actions.length > this.maxHistory) {
            this.actions.shift();
        } else {
            this.pointer++;
        }
        this.updateUI();
    },

    async undo() {
        if (!this.canUndo() || this._executing) return;
        const action = this.actions[this.pointer];
        this.pointer--;
        this._executing = true;
        try {
            await this._executeReverse(action);
            renderPlanning(); // Only render after successful API call
            showToast('Ongedaan gemaakt', 'info');
        } catch (err) {
            this.pointer++; // Restore pointer
            // Re-sync UI from server data to ensure consistency
            try { await refreshShifts(); renderPlanning(); } catch (_) {}
            showToast('Undo mislukt: ' + err.message, 'error');
        }
        this._executing = false;
        this.updateUI();
    },

    async redo() {
        if (!this.canRedo() || this._executing) return;
        this.pointer++;
        const action = this.actions[this.pointer];
        this._executing = true;
        try {
            await this._executeForward(action);
            renderPlanning(); // Only render after successful API call
            showToast('Opnieuw uitgevoerd', 'info');
        } catch (err) {
            this.pointer--; // Restore pointer
            // Re-sync UI from server data to ensure consistency
            try { await refreshShifts(); renderPlanning(); } catch (_) {}
            showToast('Redo mislukt: ' + err.message, 'error');
        }
        this._executing = false;
        this.updateUI();
    },

    async _executeReverse(action) {
        switch (action.type) {
            case 'create':
                // #302: ongedaan maken hoort de vorige toestand te herstellen,
                // niet iets nieuws achter te laten. Zonder skipBlock bleef er
                // een shift_block staan op een cel die er vóór de aanmaak geen
                // had, waardoor het concept die medewerkerdag bij een volgende
                // toepassing niet meer vulde.
                //
                // Bij het opnieuw uitvoeren van een verwijdering hieronder is
                // die blokkade juist wél gewenst: daar is het leegmaken een
                // bewuste keuze die het concept moet respecteren.
                await deleteShift(action.resultId, true);
                break;
            case 'update':
                await updateShift(action.shiftId, action.previousData);
                break;
            case 'delete': {
                const recreated = await addShift(action.previousData);
                action.resultId = recreated.id; // Track new ID for future redo
                break;
            }
        }
    },

    async _executeForward(action) {
        switch (action.type) {
            case 'create': {
                const created = await addShift(action.shiftData);
                action.resultId = created.id; // Track new ID for future undo
                break;
            }
            case 'update':
                await updateShift(action.shiftId, action.shiftData);
                break;
            case 'delete':
                await deleteShift(action.resultId); // Uses latest ID from _executeReverse
                break;
        }
    },

    clear() {
        this.actions = [];
        this.pointer = -1;
        this.updateUI();
    },

    // #182: hier stonden #undo-btn en #redo-btn, die niet meer in de markup
    // staan. Ongedaan maken loopt via Ctrl+Z en Ctrl+Y, en dat werkt gewoon.
    // De functie blijft bestaan omdat _executeReverse en de undo-stapel hem
    // aanroepen; hij heeft alleen geen knoppen meer om bij te werken.
    updateUI() {}
};

// ===== PERMISSIONS SYSTEM =====
const PERMISSIONS = {
    VIEW_ALL_EMPLOYEES: ['admin', 'roosterverantwoordelijke'],
    EDIT_ALL_EMPLOYEES: ['admin', 'roosterverantwoordelijke'],
    EDIT_TEAM_EMPLOYEES: ['admin', 'roosterverantwoordelijke'],
    ADD_EMPLOYEES: ['admin', 'roosterverantwoordelijke'],
    VIEW_ALL_AVAILABILITY: ['admin', 'roosterverantwoordelijke'],
    MANAGE_AVAILABILITY: ['admin', 'roosterverantwoordelijke'],
    MANAGE_SHIFTS: ['admin', 'roosterverantwoordelijke'],
    CHANGE_SETTINGS: ['admin', 'roosterverantwoordelijke'],
    MANAGE_ACCOUNTS: ['admin'],
    EXPORT_DATA: ['admin', 'roosterverantwoordelijke']
};

// ===== AFWEZIGHEID: GRENZEN =====
// #310: het plafond op een bulkregistratie afwezigheid. Dezelfde waarde staat
// in server.js als MAX_AFWEZIGHEIDSDAGEN; de route is de echte grens, dit is de
// meting die de gebruiker al ziet voor hij opslaat. Een jaar plus een
// schrikkeldag dekt elke echte afwezigheid.
const MAX_AFWEZIGHEIDSDAGEN = 366;
// Daarboven vragen we niets, daaronder vragen we het vanaf dit aantal na. Twee
// maanden afwezigheid komt voor, maar zelden per ongeluk.
const BEVESTIG_AFWEZIGHEIDSDAGEN = 60;

// ===== ACTIVITY TYPE LABELS =====
// #163: deze afkortingen passen alleen op zeven pixels in een dienstblok.
// Nagemeten: "Overl" op 7px is 25 pixels breed en er passen er twee in de 59
// pixels die een dienst van acht uur overhoudt; op 8px hebben twee chips 61
// pixels nodig en knipt de tweede af.
//
// Ik heb ze een ronde lang op twee letters gezet ("OL", "VM") zodat ze op 11px
// pasten. Victor vond de volle woorden beter: "Overl" lees je meteen, "OL" is
// een code die je eerst moet leren. Dat weegt zwaarder dan de lettergrootte,
// dus ze staan terug zoals ze waren.
const ACTIVITY_TYPE_LABELS_SHORT = { oudergesprek: 'OG', vorming: 'Vorm', overleg: 'Overl', afspraak: 'Afsp', vergadering: 'Verg', andere: 'And' };
const ACTIVITY_TYPE_LABELS_FULL = { oudergesprek: 'Oudergesprek', vorming: 'Vorming', overleg: 'Overleg', afspraak: 'Afspraak', vergadering: 'Vergadering', andere: 'Andere' };

// ===== LUCIDE ICON HELPERS =====
const ICONS = {
    // Status & Validation
    warning: 'triangle-alert',
    error: 'circle-x',
    success: 'circle-check',
    check: 'check',
    info: 'info',
    zap: 'zap',
    // Navigation
    home: 'house',
    planning: 'calendar-days',
    employees: 'users',
    profile: 'user',
    availability: 'calendar-off',
    swaps: 'arrow-left-right',
    settings: 'settings',
    logout: 'log-out',
    // Actions
    close: 'x',
    delete: 'trash-2',
    edit: 'pencil',
    search: 'search',
    // Arrows
    left: 'chevron-left',
    right: 'chevron-right',
    swap: 'arrow-left-right',
    // Feature Icons
    star: 'star',
    holiday: 'umbrella',
    calendar: 'calendar',
    calendarRange: 'calendar-range',
    tip: 'lightbulb',
    email: 'mail',
    clock: 'clock',
    // Shift Types
    early: 'sunrise',
    late: 'sunset',
    night: 'moon',
    long: 'ruler',
    // Misc
    testMode: 'flask-conical',
    takeover: 'hand',
    repeat: 'repeat-2',
    undo: 'undo-2',
    redo: 'redo-2',
    lock: 'lock',
    meeting: 'users-round',
    feestdag: 'calendar-check'
};

const IconHelper = {
    _pendingRoots: new Set(),
    _debounceTimer: null,
    html(name, size = 'sm', extraClass = '') {
        const cls = `lucide-${size}${extraClass ? ' ' + extraClass : ''}`;
        return `<i data-lucide="${name}" class="${cls}"></i>`;
    },
    init(container) {
        const el = typeof container === 'string'
            ? document.querySelector(container)
            : (container || document.body);
        if (!el) return;
        if (typeof lucide === 'undefined') return;
        // Debounce: batch rapid init calls into a single createIcons pass
        this._pendingRoots.add(el);
        if (this._debounceTimer) cancelAnimationFrame(this._debounceTimer);
        this._debounceTimer = requestAnimationFrame(() => {
            // Find the broadest common root to avoid redundant passes
            const roots = [...this._pendingRoots];
            this._pendingRoots.clear();
            this._debounceTimer = null;
            // If document.body is in the set, just do one pass
            if (roots.includes(document.body)) {
                lucide.createIcons();
                return;
            }
            // Filter out elements contained by other elements in the set
            const unique = roots.filter(r => !roots.some(other => other !== r && other.contains(r)));
            for (const root of unique) {
                lucide.createIcons({ root });
            }
        });
    }
};

// DOM Elements cache (gevuld door initDOM in app-init.js)
const DOM = {};
// API_BASE is set by config/settings.js (loaded before app.js)
const API_BASE = window.API_BASE;

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
