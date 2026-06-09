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
    schedulesGenerated: false, // Flag to prevent duplicate auto-generation
    currentWeekStart: null,
    currentMonthStart: null, // First day of month for month view
    previousWeekStart: null, // Store week when switching to month view
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
                await deleteShift(action.resultId);
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

    updateUI() {
        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');
        if (undoBtn) undoBtn.disabled = !this.canUndo();
        if (redoBtn) redoBtn.disabled = !this.canRedo();
    }
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

// ===== ACTIVITY TYPE LABELS =====
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

// Demo users (niet gebruikt in productie)
const USERS = [
    { username: 'admin', password: 'admin', role: 'admin', name: 'Administrator' },
    { username: 'medewerker', password: 'medewerker', role: 'employee', name: 'Medewerker' }
];

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
