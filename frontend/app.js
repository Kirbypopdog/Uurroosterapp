// HET VLOT ROOSTERPLANNING - MAIN APPLICATION

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
    builderPatternExpanded: false,
    builderPattern: null,         // lokaal patroon (null = gebruik globaal)
    builderStaffingRules: {},     // huidige week bezettingsregels { [dayIndex]: { [hour]: minCount } }
    builderStaffingRulesByWeek: {}, // cache per week (zelfde patroon als builderGridByWeek)
    builderShowStaffingEditor: false, // toggle bezettingsregels editor
    builderShowMeetingsEditor: false, // toggle teamvergaderingen editor
    builderMeetings: {},              // per-concept teamvergaderingen { [teamId]: [{ day, from, to }] }
    showHeatmap: false,
    filterOnlyWithShifts: false,
    settingsDirty: false,
    swapTeamFilter: ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend']
};

// ===== TEAM HELPERS =====
function getTeamOrder() {
    return Object.keys(DataStore.settings.teams || {});
}

function syncTeamFilters() {
    const teams = getTeamOrder();
    if (teams.length > 0) {
        AppState.visibleTeams = [...teams];
        AppState.visibleEmployeeTeams = [...teams];
        AppState.swapTeamFilter = [...teams];
    }
}

function renderTeamToggles() {
    const container = document.getElementById('team-toggles');
    if (!container) return;
    const teams = DataStore.settings.teams || {};
    container.innerHTML = '';
    getTeamOrder().forEach(teamId => {
        const team = teams[teamId];
        const isActive = AppState.visibleTeams.includes(teamId);
        const btn = document.createElement('button');
        btn.className = `team-toggle ${isActive ? 'active' : ''}`;
        btn.dataset.team = teamId;
        btn.textContent = team?.name || teamId;
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            if (btn.classList.contains('active')) {
                if (!AppState.visibleTeams.includes(teamId)) AppState.visibleTeams.push(teamId);
            } else {
                AppState.visibleTeams = AppState.visibleTeams.filter(t => t !== teamId);
            }
            renderCalendar();
        });
        container.appendChild(btn);
    });
}

function renderEmployeeTeamToggles() {
    const container = document.getElementById('employee-team-toggles');
    if (!container) return;
    const teams = DataStore.settings.teams || {};
    container.innerHTML = '';
    getTeamOrder().forEach(teamId => {
        const team = teams[teamId];
        const isActive = AppState.visibleEmployeeTeams.includes(teamId);
        const btn = document.createElement('button');
        btn.className = `team-toggle ${isActive ? 'active' : ''}`;
        btn.dataset.team = teamId;
        btn.textContent = team?.name || teamId;
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            if (btn.classList.contains('active')) {
                if (!AppState.visibleEmployeeTeams.includes(teamId)) AppState.visibleEmployeeTeams.push(teamId);
            } else {
                AppState.visibleEmployeeTeams = AppState.visibleEmployeeTeams.filter(t => t !== teamId);
            }
            renderEmployees();
        });
        container.appendChild(btn);
    });
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

// Get the effective role (simulated if set, otherwise actual)
function getEffectiveRole() {
    // Only admin can simulate roles
    if (AppState.currentUser?.role === 'admin' && AppState.simulatedRole) {
        return AppState.simulatedRole;
    }
    // Normalize legacy role names from old sessions
    const role = AppState.currentUser?.role || 'medewerker';
    if (role === 'hoofdverantwoordelijke' || role === 'teamverantwoordelijke') {
        return 'roosterverantwoordelijke';
    }
    return role;
}

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
    meeting: 'users-round'
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

function hasPermission(permission) {
    const role = getEffectiveRole();
    return PERMISSIONS[permission]?.includes(role) || false;
}

function canManageEmployee(employee) {
    const role = getEffectiveRole();
    return ['admin', 'roosterverantwoordelijke'].includes(role);
}

function canManageAvailability(employeeId) {
    const role = getEffectiveRole();
    const userId = AppState.currentUser?.id;

    if (['admin', 'roosterverantwoordelijke'].includes(role)) return true;
    if (role === 'medewerker') return String(employeeId) === String(userId);
    return false;
}

// ===== SWAP REQUEST PERMISSIONS =====

function canRequestSwap(shift) {
    // Only shift owner can request swap
    const currentUser = AppState.currentUser;
    if (!currentUser || !shift) return false;
    return shift.userId === currentUser.id;
}

function canApproveSwap(swapRequest) {
    const role = getEffectiveRole();
    const currentUser = AppState.currentUser;

    if (!currentUser || !swapRequest) return false;

    // Admin/roosterverantwoordelijke: all swaps
    if (['admin', 'roosterverantwoordelijke'].includes(role)) return true;

    return false;
}

function canCancelSwap(swapRequest) {
    const currentUser = AppState.currentUser;
    if (!currentUser || !swapRequest) return false;

    return swapRequest.requester_user_id === currentUser.id &&
           swapRequest.status === 'pending';
}

function canTargetRespondToSwap(swapRequest) {
    // Target user can approve/reject pending swap requests
    const currentUser = AppState.currentUser;
    if (!currentUser || !swapRequest) return false;

    return swapRequest.target_user_id === currentUser.id &&
           swapRequest.status === 'pending';
}

function getVisibleTeamsForRole() {
    // Iedereen met een login kan alle teams zien in de planner
    return getTeamOrder();
}

// Demo users
const USERS = [
    { username: 'admin', password: 'admin', role: 'admin', name: 'Administrator' },
    { username: 'medewerker', password: 'medewerker', role: 'employee', name: 'Medewerker' }
];

// DOM Elements
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

// ===== TOAST NOTIFICATION SYSTEM =====
const ToastManager = {
    container: null,
    toasts: [],
    maxToasts: 5,

    init() {
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    },

    show(message, type = 'info', duration = null) {
        this.init();

        // Auto-duration based on type
        if (duration === null) {
            duration = {
                'success': 3000,
                'info': 4000,
                'warning': 5000,
                'error': 0 // Don't auto-dismiss errors
            }[type] || 4000;
        }

        // Remove oldest if at max
        if (this.toasts.length >= this.maxToasts) {
            const oldest = this.toasts.shift();
            this.remove(oldest.id);
        }

        const id = Date.now() + Math.random();
        const toast = { id, message, type, duration };
        this.toasts.push(toast);

        this.render(toast);

        // Auto-dismiss if duration > 0
        if (duration > 0) {
            setTimeout(() => this.remove(id), duration);
        }

        return id;
    },

    render(toast) {
        const iconMap = {
            success: ICONS.success,
            error: ICONS.error,
            warning: ICONS.warning,
            info: ICONS.info
        };

        const el = document.createElement('div');
        el.className = `toast toast-${toast.type}`;
        el.dataset.toastId = toast.id;
        el.innerHTML = `
            <span class="toast-icon">${IconHelper.html(iconMap[toast.type], 'sm')}</span>
            <span class="toast-message">${escapeHtml(toast.message)}</span>
            <button class="toast-close" onclick="ToastManager.remove(${toast.id})">${IconHelper.html(ICONS.close, 'xs')}</button>
        `;

        this.container.appendChild(el);
        IconHelper.init(el);

        // Trigger animation
        setTimeout(() => el.classList.add('toast-show'), 10);
    },

    remove(id) {
        const el = this.container.querySelector(`[data-toast-id="${id}"]`);
        if (el) {
            el.classList.remove('toast-show');
            el.classList.add('toast-hide');
            setTimeout(() => {
                el.remove();
                this.toasts = this.toasts.filter(t => t.id !== id);
            }, 300);
        }
    }
};

// Global helper function
function showToast(message, type = 'info', duration = null) {
    return ToastManager.show(message, type, duration);
}

// ===== USER-FRIENDLY ERROR MESSAGES =====
function getUserFriendlyError(err) {
    if (!err) return 'Er is een onbekende fout opgetreden.';
    const msg = err.message || err.error || String(err);
    if (msg.includes('constraint')) return 'Dit kan niet worden opgeslagen — controleer de gegevens.';
    if (msg.includes('duplicate')) return 'Deze waarde bestaat al.';
    if (msg.includes('not found') || msg.includes('404')) return 'Dit item werd niet gevonden.';
    if (msg.includes('unauthorized') || msg.includes('401')) return 'Je bent niet gemachtigd voor deze actie.';
    if (msg.includes('network') || msg.includes('fetch') || msg.includes('Failed to fetch')) return 'Verbindingsfout — controleer je internetverbinding.';
    if (msg.includes('Te veel verzoeken')) return msg;
    return msg;
}

// ===== DATA LOADING OVERLAY =====
function showDataLoading(message = 'Bezig met opslaan...') {
    const overlay = document.getElementById('data-loading-overlay');
    if (overlay) {
        const textEl = overlay.querySelector('.data-loading-text');
        if (textEl) textEl.textContent = message;
        overlay.classList.remove('hidden');
    }
}

function hideDataLoading() {
    const overlay = document.getElementById('data-loading-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
    }
}

function showSectionLoading(viewId, message) {
    const overlay = document.querySelector(`#${viewId} .section-loading-overlay`);
    if (overlay) {
        const text = overlay.querySelector('.section-loading-text');
        if (text) text.textContent = message;
        overlay.classList.remove('hidden');
    }
}

function hideSectionLoading(viewId) {
    const overlay = document.querySelector(`#${viewId} .section-loading-overlay`);
    if (overlay) overlay.classList.add('hidden');
}

function updateShiftRefreshRange() {
    if (!AppState.currentWeekStart) return;
    // Start: 2 weeks before current view
    const start = new Date(AppState.currentWeekStart);
    start.setDate(start.getDate() - 14);
    // End: end of current school year (default: 31 aug) + 2 weeks buffer
    const now = new Date();
    const syStart = getSchoolYearStart();
    let schoolYearStartMonth = 8; // 0-based September
    if (syStart) {
        const syDate = parseDateOnly(syStart);
        if (syDate) schoolYearStartMonth = syDate.getMonth();
    }
    const schoolYearEndMonth = schoolYearStartMonth === 0 ? 11 : schoolYearStartMonth - 1;
    let schoolYearEndYear = now.getFullYear();
    const testEnd = new Date(schoolYearEndYear, schoolYearEndMonth + 1, 0); // last day of end month
    if (testEnd <= now) schoolYearEndYear++;
    const schoolYearEnd = new Date(schoolYearEndYear, schoolYearEndMonth + 1, 0); // last day of end month
    // Use whichever is further: current view + 2 weeks or school year end + 2 weeks
    const viewEnd = new Date(AppState.currentWeekStart);
    viewEnd.setDate(viewEnd.getDate() + 21); // current week + 2 weeks buffer
    const end = new Date(Math.max(schoolYearEnd.getTime(), viewEnd.getTime()));
    end.setDate(end.getDate() + 14); // extra buffer
    setActiveShiftRange(formatDateYYYYMMDD(start), formatDateYYYYMMDD(end));
}

// ===== CONFIRMATION DIALOG SYSTEM =====
function showConfirm(message, title = 'Bevestig actie', options = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        // Set content
        titleEl.textContent = title;
        messageEl.textContent = message;

        // Danger styling
        if (options.danger) {
            okBtn.classList.add('btn-danger');
        } else {
            okBtn.classList.remove('btn-danger');
        }

        // Custom button text
        okBtn.textContent = options.confirmText || 'OK';
        cancelBtn.textContent = options.cancelText || 'Annuleren';

        // Show modal
        modal.classList.remove('hidden');

        // Handle OK
        const handleOk = () => {
            cleanup();
            resolve(true);
        };

        // Handle Cancel
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        // Cleanup function
        const cleanup = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleBackdropClick);
            document.removeEventListener('keydown', handleEscape);
        };

        // Handle backdrop click
        const handleBackdropClick = (e) => {
            if (e.target === modal) {
                handleCancel();
            }
        };

        // Handle Escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                handleCancel();
            }
        };

        // Add event listeners
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleBackdropClick);
        document.addEventListener('keydown', handleEscape);
    });
}

function showInputPrompt(message, title = 'Invoer', defaultValue = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('input-prompt-modal');
        const messageEl = document.getElementById('input-prompt-message');
        const inputEl = document.getElementById('input-prompt-value');
        const okBtn = document.getElementById('input-prompt-ok');
        const cancelBtn = document.getElementById('input-prompt-cancel');

        messageEl.textContent = message;
        inputEl.value = defaultValue;
        modal.classList.remove('hidden');
        setTimeout(() => inputEl.focus(), 50);

        const handleOk = () => { cleanup(); resolve(inputEl.value.trim()); };
        const handleCancel = () => { cleanup(); resolve(null); };
        const cleanup = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.removeEventListener('click', handleBackdropClick);
            document.removeEventListener('keydown', handleKeys);
        };
        const handleBackdropClick = (e) => { if (e.target === modal) handleCancel(); };
        const handleKeys = (e) => {
            if (e.key === 'Escape') handleCancel();
            if (e.key === 'Enter') handleOk();
        };
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.addEventListener('click', handleBackdropClick);
        document.addEventListener('keydown', handleKeys);
    });
}

async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (AppState.authToken) {
        headers.Authorization = `Bearer ${AppState.authToken}`;
    }
    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data.error || 'Request failed';
        throw new Error(message);
    }
    return data;
}

async function syncEmployeeAccountLinks() {
    // No longer needed - users and employees are now merged
    // Keeping function signature for backward compatibility
    return;
}

function getContrastColor(hexColor) {
    if (typeof hexColor !== 'string') return '#ffffff';
    const hex = hexColor.replace('#', '');
    const normalized = hex.length === 3
        ? hex.split('').map(ch => ch + ch).join('')
        : hex;
    if (normalized.length !== 6) return '#ffffff';
    const r = parseInt(normalized.slice(0, 2), 16) / 255;
    const g = parseInt(normalized.slice(2, 4), 16) / 255;
    const b = parseInt(normalized.slice(4, 6), 16) / 255;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.6 ? '#1f2933' : '#ffffff';
}

function applyTeamColors() {
    const styleId = 'team-color-overrides';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = styleId;
        document.head.appendChild(styleEl);
    }

    const teams = DataStore.settings.teams || {};
    let css = '';
    Object.entries(teams).forEach(([teamId, team]) => {
        const color = team.color || '#64748b';
        const textColor = '#ffffff';
        css += `
.team-toggle.active[data-team="${teamId}"] { background: ${color} !important; color: ${textColor} !important; border-color: transparent !important; }
.team-badge.${teamId} { background: ${color} !important; color: ${textColor} !important; }
.team-badge-mini.${teamId} { background: ${color} !important; color: ${textColor} !important; }
.shift-block.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.timeline-block.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.shift-badge.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.shift-team-badge.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.timeline-team-header.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
.team-tab.active.team-${teamId} { background: ${color} !important; color: ${textColor} !important; }
`;
    });
    styleEl.textContent = css;
}

function initDOM() {
    DOM.loginContainer = document.getElementById('login-container');
    DOM.appContainer = document.getElementById('app-container');
    DOM.loginForm = document.getElementById('login-form');
    DOM.usernameInput = document.getElementById('username');
    DOM.passwordInput = document.getElementById('password');
    DOM.navButtons = document.querySelectorAll('.nav-center .nav-btn');
    DOM.logoutBtn = document.getElementById('logout-btn');
    DOM.homeView = document.getElementById('home-view');
    DOM.planningView = document.getElementById('planning-view');
    DOM.employeesView = document.getElementById('employees-view');
    DOM.profileView = document.getElementById('profile-view');
    DOM.profileContent = document.getElementById('profile-content');
    DOM.availabilityView = document.getElementById('availability-view');
    DOM.builderView = document.getElementById('builder-view');
    DOM.swapsView = document.getElementById('swaps-view');
    DOM.settingsView = document.getElementById('settings-view');
    DOM.addShiftBtn = document.getElementById('add-shift-btn');
    DOM.prevWeekBtn = document.getElementById('prev-week');
    DOM.nextWeekBtn = document.getElementById('next-week');
    DOM.todayBtn = document.getElementById('today-btn');
    DOM.currentPeriod = document.getElementById('current-period');
    DOM.viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
    DOM.rosterCalendar = document.getElementById('roster-calendar');
    DOM.validationAlerts = document.getElementById('validation-alerts');
    DOM.addEmployeeBtn = document.getElementById('add-employee-btn');
    DOM.employeesList = document.getElementById('employees-list');
    DOM.shiftModal = document.getElementById('shift-modal');
    DOM.shiftForm = document.getElementById('shift-form');
    DOM.shiftModalTitle = document.getElementById('shift-modal-title');
    DOM.shiftEmployee = document.getElementById('shift-employee');
    DOM.shiftTeam = document.getElementById('shift-team');
    DOM.shiftDate = document.getElementById('shift-date');
    DOM.shiftTemplate = document.getElementById('shift-template');
    DOM.shiftStart = document.getElementById('shift-start');
    DOM.shiftEnd = document.getElementById('shift-end');
    DOM.shiftNotes = document.getElementById('shift-notes');
    DOM.shiftValidationErrors = document.getElementById('shift-validation-errors');
    DOM.shiftCancelBtn = document.getElementById('shift-cancel-btn');
    DOM.shiftSubmitBtn = document.getElementById('shift-submit-btn');
    DOM.shiftDeleteBtn = document.getElementById('shift-delete-btn');
    DOM.employeeModal = document.getElementById('employee-modal');
    DOM.employeeForm = document.getElementById('employee-form');
    DOM.employeeModalTitle = document.getElementById('employee-modal-title');
    DOM.employeeName = document.getElementById('employee-name');
    DOM.employeeEmail = document.getElementById('employee-email');
    DOM.employeeMainTeam = document.getElementById('employee-main-team');
    DOM.employeeContract = document.getElementById('employee-contract');
    DOM.employeeActive = document.getElementById('employee-active');
    DOM.employeeCancelBtn = document.getElementById('employee-cancel-btn');
    DOM.employeeDeleteBtn = document.getElementById('employee-delete-btn');
    DOM.warningDetailsModal = document.getElementById('warning-details-modal');
    DOM.warningDetailsList = document.getElementById('warning-details-list');
    DOM.warningDetailsClose = document.getElementById('warning-details-close');
    DOM.errorDetailsModal = document.getElementById('error-details-modal');
    DOM.errorDetailsList = document.getElementById('error-details-list');
    DOM.errorDetailsClose = document.getElementById('error-details-close');

    // Mobile day navigation
    DOM.mobileDayNav = document.getElementById('mobile-day-nav');
    DOM.mobilePrevDay = document.getElementById('mobile-prev-day');
    DOM.mobileNextDay = document.getElementById('mobile-next-day');
    DOM.mobileDayDisplay = document.getElementById('mobile-day-display');

    // Create tooltip element
    createTooltipElement();
}

// ===== TOOLTIP SYSTEEM =====
let tooltipElement = null;

function createTooltipElement() {
    tooltipElement = document.createElement('div');
    tooltipElement.className = 'custom-tooltip';
    tooltipElement.style.display = 'none';
    document.body.appendChild(tooltipElement);

    // Event delegation voor tooltips
    document.addEventListener('mouseover', handleTooltipShow);
    document.addEventListener('mouseout', handleTooltipHide);
    document.addEventListener('scroll', handleTooltipHide, true);
}

function handleTooltipShow(e) {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;

    const text = target.getAttribute('data-tooltip');
    if (!text) return;

    tooltipElement.textContent = text;
    tooltipElement.style.display = 'block';

    // Positie berekenen
    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const pos = target.getAttribute('data-tooltip-pos') || 'top';

    let top, left;

    switch (pos) {
        case 'bottom':
            top = rect.bottom + 8;
            left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
            break;
        case 'left':
            top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
            left = rect.left - tooltipRect.width - 8;
            break;
        case 'right':
            top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
            left = rect.right + 8;
            break;
        default: // top
            top = rect.top - tooltipRect.height - 8;
            left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
    }

    // Zorg dat tooltip binnen viewport blijft
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
        left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top < 10) {
        // Flip naar bottom als top niet past
        top = rect.bottom + 8;
    }
    if (top + tooltipRect.height > window.innerHeight - 10) {
        // Flip naar top als bottom niet past
        top = rect.top - tooltipRect.height - 8;
        if (top < 10) top = 10;
    }

    tooltipElement.style.top = `${top}px`;
    tooltipElement.style.left = `${left}px`;
}

function handleTooltipHide(e) {
    if (e.type === 'scroll' || !e.relatedTarget?.closest('[data-tooltip]')) {
        tooltipElement.style.display = 'none';
    }
}

function init() {
    try {
        console.log('Het Vlot Roosterplanning start...');
        console.log('Data loaded:', DataStore);
        initDOM();
        applyTeamColors();
        console.log('DOM initialized');
        document.body.setAttribute('data-view-mode', AppState.viewMode);
        setCurrentWeek(new Date());
        // Set initial mobile day to today's day of the week
        const today = new Date();
        const dayOfWeek = today.getDay();
        AppState.mobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        console.log('Current week set');
        setupEventListeners();
        setupAvailabilityModal();
        console.log('Event listeners set up');
        checkSession();
        console.log('Session checked');
    } catch (error) {
        console.error('Error during initialization:', error);
        showToast('Er is een fout opgetreden bij het starten van de applicatie. Probeer de pagina te herladen.', 'error');
    }
}

function setupEventListeners() {
    DOM.loginForm.addEventListener('submit', handleLogin);
    DOM.logoutBtn.addEventListener('click', handleLogout);

    // Role switcher for admin testing
    const roleSwitchSelect = document.getElementById('role-switch-select');
    if (roleSwitchSelect) {
        roleSwitchSelect.addEventListener('change', (e) => {
            const newRole = e.target.value;
            // If admin is selected, clear the simulation
            AppState.simulatedRole = (newRole === 'admin') ? null : newRole;
            // Re-apply role visibility to update UI
            applyRoleVisibility();
            // Switch to planning view to avoid being stuck on hidden view
            switchView('planning');
            // Re-render current view
            renderPlanning();
            console.log(`[Test Mode] Nu werkend als: ${newRole}`);
        });
    }

    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const navMenu = document.getElementById('nav-menu');
    if (mobileMenuBtn && navMenu) {
        mobileMenuBtn.addEventListener('click', () => {
            mobileMenuBtn.classList.toggle('active');
            navMenu.classList.toggle('open');
        });
    }

    // User menu (avatar dropdown) toggle
    const userMenu = document.getElementById('user-menu');
    const userMenuTrigger = document.getElementById('user-menu-trigger');
    if (userMenu && userMenuTrigger) {
        userMenuTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            userMenu.classList.toggle('open');
            userMenuTrigger.setAttribute('aria-expanded', userMenu.classList.contains('open'));
        });
        // Close on click outside
        document.addEventListener('click', (e) => {
            if (!userMenu.contains(e.target)) {
                userMenu.classList.remove('open');
                userMenuTrigger.setAttribute('aria-expanded', 'false');
            }
        });
        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && userMenu.classList.contains('open')) {
                userMenu.classList.remove('open');
                userMenuTrigger.setAttribute('aria-expanded', 'false');
                userMenuTrigger.focus();
            }
        });
        // Dropdown nav items (profile, settings)
        userMenu.querySelectorAll('.user-menu-item[data-view]').forEach(item => {
            item.addEventListener('click', () => {
                userMenu.classList.remove('open');
                userMenuTrigger.setAttribute('aria-expanded', 'false');
                switchView(item.dataset.view);
            });
        });
    }

    DOM.navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Close mobile menu on navigation
            if (mobileMenuBtn && navMenu) {
                mobileMenuBtn.classList.remove('active');
                navMenu.classList.remove('open');
            }
            switchView(btn.dataset.view);
        });
    });
    DOM.addShiftBtn.addEventListener('click', openAddShiftModal);
    DOM.prevWeekBtn.addEventListener('click', () => {
        if (AppState.viewMode === 'month') {
            changeMonth(-1);
        } else if (AppState.viewMode === 'day') {
            changeMobileDay(-1);
        } else {
            changeWeek(-1);
        }
    });
    DOM.nextWeekBtn.addEventListener('click', () => {
        if (AppState.viewMode === 'month') {
            changeMonth(1);
        } else if (AppState.viewMode === 'day') {
            changeMobileDay(1);
        } else {
            changeWeek(1);
        }
    });
    DOM.todayBtn.addEventListener('click', jumpToToday);

    // Mobile day navigation
    if (DOM.mobilePrevDay) {
        DOM.mobilePrevDay.addEventListener('click', () => changeMobileDay(-1));
    }
    if (DOM.mobileNextDay) {
        DOM.mobileNextDay.addEventListener('click', () => changeMobileDay(1));
    }

    // Mobile date picker - jump to specific date
    const mobileDatePicker = document.getElementById('mobile-date-picker');
    if (mobileDatePicker) {
        mobileDatePicker.addEventListener('change', (e) => {
            const selectedDate = new Date(e.target.value);
            if (!isNaN(selectedDate.getTime())) {
                jumpToDate(selectedDate);
            }
        });
    }

    // Click on day display to open date picker
    if (DOM.mobileDayDisplay) {
        DOM.mobileDayDisplay.addEventListener('click', () => {
            const picker = document.getElementById('mobile-date-picker');
            if (picker) {
                if (picker.showPicker) {
                    picker.showPicker();
                } else {
                    picker.click();
                    picker.focus();
                }
            }
        });
    }

    DOM.viewToggleBtns.forEach(btn => {
        btn.addEventListener('click', () => changeViewMode(btn.dataset.mode));
    });

    // Team toggle buttons for planning view — attached dynamically via renderTeamToggles()

    // Team toggle buttons for employees view — attached dynamically via renderEmployeeTeamToggles()

    DOM.addEmployeeBtn.addEventListener('click', openAddEmployeeModal);
    DOM.shiftForm.addEventListener('submit', handleShiftSubmit);
    DOM.shiftForm.addEventListener('input', () => {
        if (AppState._shiftForceOverride) {
            resetShiftSubmitBtn();
            DOM.shiftValidationErrors.innerHTML = '';
        }
    });
    DOM.shiftForm.addEventListener('change', () => {
        if (AppState._shiftForceOverride) {
            resetShiftSubmitBtn();
            DOM.shiftValidationErrors.innerHTML = '';
        }
    });
    DOM.shiftCancelBtn.addEventListener('click', closeShiftModal);
    DOM.shiftDeleteBtn.addEventListener('click', handleShiftDelete);
    DOM.shiftTemplate.addEventListener('change', handleShiftTemplateChange);
    document.querySelectorAll('#shift-modal .modal-close').forEach(btn => {
        btn.addEventListener('click', closeShiftModal);
    });
    DOM.employeeForm.addEventListener('submit', handleEmployeeSubmit);
    DOM.employeeCancelBtn.addEventListener('click', closeEmployeeModal);
    DOM.employeeDeleteBtn.addEventListener('click', handleEmployeeDelete);
    document.querySelectorAll('#employee-modal .modal-close').forEach(btn => {
        btn.addEventListener('click', closeEmployeeModal);
    });
    DOM.warningDetailsClose.addEventListener('click', closeWarningDetailsModal);
    DOM.warningDetailsModal.addEventListener('click', (e) => {
        if (e.target === DOM.warningDetailsModal) closeWarningDetailsModal();
    });
    DOM.errorDetailsClose.addEventListener('click', closeErrorDetailsModal);
    DOM.errorDetailsModal.addEventListener('click', (e) => {
        if (e.target === DOM.errorDetailsModal) closeErrorDetailsModal();
    });
    DOM.shiftModal.addEventListener('click', (e) => {
        if (e.target === DOM.shiftModal) closeShiftModal();
    });
    DOM.employeeModal.addEventListener('click', (e) => {
        if (e.target === DOM.employeeModal) closeEmployeeModal();
    });

    // Swap request modal event listeners
    document.getElementById('swap-request-modal-close').addEventListener('click', closeSwapRequestModal);
    document.getElementById('swap-request-cancel-btn').addEventListener('click', closeSwapRequestModal);
    document.getElementById('swap-request-submit-btn').addEventListener('click', handleSwapRequestSubmit);
    document.getElementById('swap-target-employee').addEventListener('change', handleSwapTargetEmployeeChange);
    document.getElementById('swap-target-shift').addEventListener('change', handleSwapTargetShiftChange);
    document.getElementById('swap-request-modal').addEventListener('click', (e) => {
        if (e.target.id === 'swap-request-modal') closeSwapRequestModal();
    });

    // Swap review modal event listeners
    document.getElementById('swap-review-modal-close').addEventListener('click', closeSwapReviewModal);
    document.getElementById('swap-review-cancel-btn').addEventListener('click', closeSwapReviewModal);
    document.getElementById('swap-review-approve-btn').addEventListener('click', handleSwapApprove);
    document.getElementById('swap-review-reject-btn').addEventListener('click', handleSwapReject);
    document.getElementById('swap-review-modal').addEventListener('click', (e) => {
        if (e.target.id === 'swap-review-modal') closeSwapReviewModal();
    });

    // Takeover request modal event listeners
    document.getElementById('takeover-request-modal-close').addEventListener('click', closeTakeoverRequestModal);
    document.getElementById('takeover-request-cancel-btn').addEventListener('click', closeTakeoverRequestModal);
    document.getElementById('takeover-request-submit-btn').addEventListener('click', handleTakeoverRequestSubmit);
    document.getElementById('takeover-request-modal').addEventListener('click', (e) => {
        if (e.target.id === 'takeover-request-modal') closeTakeoverRequestModal();
    });

    // Shift afstaan choice modal event listeners
    document.getElementById('shift-afstaan-choice-close').addEventListener('click', closeShiftAfstaanChoiceModal);
    document.getElementById('shift-afstaan-choice-cancel').addEventListener('click', closeShiftAfstaanChoiceModal);
    document.getElementById('shift-afstaan-choice-modal').addEventListener('click', (e) => {
        if (e.target.id === 'shift-afstaan-choice-modal') closeShiftAfstaanChoiceModal();
    });

    // Week tabs (static in HTML)
    document.querySelectorAll('.week-tab').forEach(tab => {
        tab.addEventListener('click', () => switchWeekTab(parseInt(tab.dataset.week)));
    });

    DOM.validationAlerts.addEventListener('click', (event) => {
        const errorChip = event.target.closest('.validation-summary-item.validation-error');
        if (errorChip) {
            openErrorDetailsModal();
            return;
        }
        const warningChip = event.target.closest('.validation-summary-item.validation-warning');
        if (warningChip) {
            openWarningDetailsModal();
        }
    });

    // Heatmap toggle
    const heatmapToggle = document.getElementById('heatmap-toggle-btn');
    if (heatmapToggle) {
        heatmapToggle.addEventListener('click', () => {
            AppState.showHeatmap = !AppState.showHeatmap;
            heatmapToggle.classList.toggle('active', AppState.showHeatmap);
            const container = document.getElementById('coverage-heatmap-container');
            if (container) {
                container.innerHTML = AppState.showHeatmap ? renderCoverageHeatmap() : '';
                if (AppState.showHeatmap) IconHelper.init(container);
            }
        });
    }

    // Filter toggle: show only employees with shifts
    const filterToggle = document.getElementById('filter-shifts-toggle');
    if (filterToggle) {
        filterToggle.addEventListener('click', () => {
            AppState.filterOnlyWithShifts = !AppState.filterOnlyWithShifts;
            filterToggle.classList.toggle('active', AppState.filterOnlyWithShifts);
            renderPlanning();
        });
    }

    // Activity modal
    const activityForm = document.getElementById('activity-form');
    if (activityForm) {
        activityForm.addEventListener('submit', handleActivitySubmit);
    }
    document.getElementById('activity-cancel-btn')?.addEventListener('click', closeActivityModal);
    document.getElementById('activity-delete-btn')?.addEventListener('click', handleActivityDelete);
    document.querySelectorAll('#activity-modal .modal-close').forEach(btn => {
        btn.addEventListener('click', closeActivityModal);
    });
    document.getElementById('activity-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'activity-modal') closeActivityModal();
    });

    // Undo/Redo buttons
    document.getElementById('undo-btn')?.addEventListener('click', () => UndoManager.undo());
    document.getElementById('redo-btn')?.addEventListener('click', () => UndoManager.redo());

    // Undo/Redo keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        if (document.querySelector('.modal:not(.hidden)')) return;

        if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            UndoManager.undo();
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
            e.preventDefault();
            UndoManager.redo();
        }
    });

    // Event delegation for inline delete buttons on shift cards
    document.addEventListener('click', async (e) => {
        if (e.target.classList.contains('shift-delete-btn')) {
            e.stopPropagation(); // Prevent opening the shift modal
            const shiftId = parseInt(e.target.dataset.shiftId, 10);
            if (!shiftId) return;

            const shift = getShift(shiftId);
            if (!shift) return;

            // Check permissions before allowing delete
            if (!canUserEditShift(shift)) {
                showToast('Je hebt geen rechten om deze dienst te verwijderen', 'warning');
                return;
            }

            // Call handleShiftDelete with the shift ID and wait for completion
            await handleShiftDelete(shiftId);
        }

        // Activity chip/badge click → edit activity
        const activityEl = e.target.closest('.activity-chip, .activity-badge');
        if (activityEl) {
            e.stopPropagation();
            const activityId = activityEl.dataset.activityId;
            if (activityId) openEditActivityModal(parseInt(activityId, 10));
        }

        // Add activity button click
        const addActivityBtn = e.target.closest('.add-activity-btn');
        if (addActivityBtn) {
            e.stopPropagation();
            const { userId, date, shiftStart, shiftEnd } = addActivityBtn.dataset;
            if (userId && date) openAddActivityModal(parseInt(userId, 10), date, shiftStart, shiftEnd);
        }
    });
}

async function handleLogin(e) {
    e.preventDefault();

    // Prevent concurrent authentication attempts
    if (AppState.isAuthenticating) {
        console.log('Authentication already in progress');
        return;
    }

    const email = DOM.usernameInput.value.trim();
    const password = DOM.passwordInput.value;

    // Prevent double submission
    const submitBtn = DOM.loginForm.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Bezig met inloggen...';

    // Set guard flag
    AppState.isAuthenticating = true;

    try {
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        AppState.currentUser = data.user;
        AppState.authToken = data.token;
        sessionStorage.setItem('hetvlot_user', JSON.stringify(data.user));
        sessionStorage.setItem('hetvlot_token', data.token);
        // Load data from database
        await loadDataFromAPI();
        syncTeamFilters();
        updateShiftRefreshRange();
        applyTeamColors(); // Apply team colors after settings are loaded
        await syncEmployeeAccountLinks();
        showApp();
    } catch (error) {
        console.error('Login error:', error);
        showToast('Ongeldige gebruikersnaam of wachtwoord', 'error');

        // Clear any existing session to prevent staying logged in with old credentials
        AppState.currentUser = null;
        AppState.authToken = null;
        sessionStorage.removeItem('hetvlot_user');
        sessionStorage.removeItem('hetvlot_token');

        // Ensure login screen is visible
        showLogin();
    } finally {
        // Clear guard flag
        AppState.isAuthenticating = false;

        submitBtn.disabled = false;
        submitBtn.textContent = 'Inloggen';
    }
}

function handleLogout() {
    AppState.currentUser = null;
    AppState.authToken = null;
    sessionStorage.removeItem('hetvlot_user');
    sessionStorage.removeItem('hetvlot_token');
    showLogin();
}

async function checkSession() {
    // Don't check session if login is in progress
    if (AppState.isAuthenticating) {
        console.log('Skipping checkSession - authentication in progress');
        return;
    }

    const savedToken = sessionStorage.getItem('hetvlot_token');
    if (!savedToken) {
        showLogin();
        return;
    }
    AppState.authToken = savedToken;
    try {
        const data = await apiFetch('/me');
        AppState.currentUser = data.user;
        sessionStorage.setItem('hetvlot_user', JSON.stringify(data.user));
        // Load data from database
        await loadDataFromAPI();
        syncTeamFilters();
        updateShiftRefreshRange();
        applyTeamColors(); // Apply team colors after settings are loaded
        await syncEmployeeAccountLinks();
        showApp();
    } catch (error) {
        handleLogout();
    }
}

function showLogin() {
    DOM.loginContainer.classList.remove('hidden');
    DOM.appContainer.classList.add('hidden');
    DOM.usernameInput.value = '';
    DOM.passwordInput.value = '';
}

function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function populateUserMenu() {
    const user = AppState.currentUser;
    if (!user) return;
    const avatar = document.getElementById('avatar-circle');
    const menuName = document.getElementById('user-menu-name');
    const dropdownName = document.getElementById('dropdown-user-name');
    const dropdownRole = document.getElementById('dropdown-user-role');
    if (avatar) avatar.textContent = getInitials(user.name);
    if (menuName) menuName.textContent = user.name;
    if (dropdownName) dropdownName.textContent = user.name;
    if (dropdownRole) dropdownRole.textContent = getRoleDescription(user.role);
}

function showApp() {
    DOM.loginContainer.classList.add('hidden');
    DOM.appContainer.classList.remove('hidden');
    populateUserMenu();
    applyRoleVisibility();
    // Restore saved view from localStorage, or use default
    const savedView = localStorage.getItem('hetvlot_activeView');
    if (savedView && ['home', 'planning', 'employees', 'profile', 'availability', 'builder', 'swaps', 'settings'].includes(savedView)) {
        AppState.currentView = savedView;
    }
    switchView(AppState.currentView);
}

function applyRoleVisibility() {
    const role = getEffectiveRole();
    const isRealAdmin = AppState.currentUser?.role === 'admin';
    const allowedViews = new Set(['home', 'planning', 'profile']);

    // Show/hide role switcher for admin
    const roleSwitcher = document.getElementById('role-switcher');
    if (roleSwitcher) {
        if (isRealAdmin) {
            roleSwitcher.classList.remove('hidden');
            const select = document.getElementById('role-switch-select');
            if (select) {
                select.value = AppState.simulatedRole || 'admin';
            }
        } else {
            roleSwitcher.classList.add('hidden');
        }
    }

    // All roles get basic views
    allowedViews.add('availability');
    allowedViews.add('swaps');

    // Employees tab: NOT for medewerker role (they manage their schedule via profile)
    if (role !== 'medewerker') {
        allowedViews.add('employees');
    }

    // Builder tab: roosterverantwoordelijke and admin
    if (['roosterverantwoordelijke', 'admin'].includes(role)) {
        allowedViews.add('builder');
    }

    // Settings only for roosterverantwoordelijke and admin
    if (['roosterverantwoordelijke', 'admin'].includes(role)) {
        allowedViews.add('settings');
    }

    DOM.navButtons.forEach(btn => {
        const view = btn.dataset.view;
        const isAllowed = allowedViews.has(view);
        btn.style.display = isAllowed ? '' : 'none';
    });

    // Show/hide admin nav group based on whether any admin buttons are visible
    const adminGroup = document.querySelector('.nav-group-admin');
    if (adminGroup) {
        const hasVisibleBtn = Array.from(adminGroup.querySelectorAll('.nav-btn')).some(b => b.style.display !== 'none');
        adminGroup.style.display = hasVisibleBtn ? '' : 'none';
    }

    // Show/hide settings item in user dropdown
    const dropdownSettings = document.getElementById('dropdown-settings-item');
    if (dropdownSettings) {
        dropdownSettings.style.display = allowedViews.has('settings') ? '' : 'none';
    }

    if (!allowedViews.has(AppState.currentView)) {
        AppState.currentView = 'home';
    }

    // Team filters: always visible for roles that can see the employee tab
    const employeeFilters = document.getElementById('employee-team-toggles');
    if (employeeFilters) {
        employeeFilters.style.display = '';
    }

    // Hide "Medewerker toevoegen" button - new employees are created via account management
    // This button is now obsolete after the employees/users merge
    if (DOM.addEmployeeBtn) {
        DOM.addEmployeeBtn.style.display = 'none';
    }
}

// ===== HOME DASHBOARD =====

function renderHome() {
    const container = document.getElementById('home-content');
    if (!container) return;

    const user = AppState.currentUser;
    if (!user) return;

    const role = getEffectiveRole();

    let html = '';
    html += renderHomeWelcome(user, role);
    if (role === 'admin') html += renderHomeOnboarding();
    html += '<div class="home-grid">';
    html += renderHomeShifts(user);
    html += renderHomeQuickActions(role);
    html += renderHomeWeekendInfo();
    html += renderHomeRequests(user, role);
    html += '</div>';

    container.innerHTML = html;
    IconHelper.init(container);

    // Attach quick action click handlers
    container.querySelectorAll('.home-action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'add-shift') {
                switchView('planning');
                setTimeout(() => { if (typeof openAddShiftModal === 'function') openAddShiftModal(); }, 100);
            } else if (action === 'request-absence') {
                switchView('availability');
            } else if (action === 'request-swap') {
                switchView('swaps');
            } else if (action === 'view-planning') {
                switchView('planning');
            }
        });
    });

    // Attach request click handlers
    container.querySelectorAll('.home-request-item[data-action="view-swaps"]').forEach(item => {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => switchView('swaps'));
    });
}

function getOnboardingStatus() {
    const teams = DataStore.settings.teams || {};
    const templates = DataStore.settings.shiftTemplates || {};
    const users = DataStore.users || [];
    const holidays = DataStore.settings.holidayPeriods || [];
    const rules = DataStore.settings.rules || {};

    return [
        { id: 'teams', label: 'Teams aanmaken', done: Object.keys(teams).length > 0, view: 'settings', tab: 'teams' },
        { id: 'templates', label: 'Dienst templates instellen', done: Object.keys(templates).length > 0, view: 'settings', tab: 'teams' },
        { id: 'users', label: 'Medewerkers toevoegen', done: users.filter(u => u.role === 'medewerker').length > 0, view: 'settings', tab: 'accounts' },
        { id: 'rules', label: 'Planningsregels controleren', done: AppState.currentUser?.onboardingFlags?.planning_visited === true, view: 'settings', tab: 'planning' },
        { id: 'holidays', label: 'Vakantieperiodes invoeren', done: holidays.length > 0, view: 'settings', tab: 'planning' },
        { id: 'schedule', label: 'Basisrooster maken', done: DataStore.shifts.length > 0, view: 'builder' },
        { id: 'email', label: 'Email notificaties configureren', done: DataStore.settings.emailNotifications?.globalEnabled === true, view: 'settings', tab: 'communicatie' }
    ];
}

function renderHomeOnboarding() {
    if (AppState.currentUser?.onboardingFlags?.checklist_dismissed) return '';

    const steps = getOnboardingStatus();
    const doneCount = steps.filter(s => s.done).length;
    if (doneCount === steps.length) return ''; // All done

    const pct = Math.round((doneCount / steps.length) * 100);

    return `
    <div class="home-card onboarding-checklist mb-md">
        <div class="onboarding-header">
            <h3 class="onboarding-title">App instellen</h3>
            <button class="btn btn-sm btn-ghost onboarding-dismiss" onclick="dismissOnboardingChecklist(this)" title="Verbergen">✕</button>
        </div>
        <div class="onboarding-progress">
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="text-xs text-muted text-nowrap">${doneCount}/${steps.length}</span>
        </div>
        <ul class="onboarding-steps">
            ${steps.map(s => `<li class="${s.done ? 'done' : ''}">
                <span class="step-check">${s.done ? '✓' : '○'}</span>
                <a href="#" onclick="event.preventDefault();${s.tab ? `AppState.settingsActiveTab='${s.tab}';` : ''}switchView('${s.view}');">${s.label}</a>
            </li>`).join('')}
        </ul>
    </div>`;
}

async function dismissOnboardingChecklist(btn) {
    btn.closest('.onboarding-checklist').remove();
    try {
        await fetch(`${API}/me/onboarding-flags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem('token')}` },
            body: JSON.stringify({ checklist_dismissed: true })
        });
        if (AppState.currentUser) AppState.currentUser.onboardingFlags = { ...AppState.currentUser.onboardingFlags, checklist_dismissed: true };
    } catch (e) { console.error('Failed to save onboarding dismiss:', e); }
}

function renderHomeWelcome(user, role) {
    const roleLabels = {
        admin: 'Admin',
        roosterverantwoordelijke: 'Roosterverantwoordelijke',
        medewerker: 'Medewerker'
    };
    const today = new Date();
    const dateStr = today.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    return `
        <div class="home-welcome">
            <h2>Welkom, ${escapeHtml(user.name)}</h2>
            <div class="home-welcome-sub">
                <span>${dateStr}</span>
                <span class="home-role-badge">${escapeHtml(roleLabels[role] || role)}</span>
            </div>
        </div>
    `;
}

function renderHomeShifts(user) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 7);

    const todayStr = formatDateYYYYMMDD(today);
    const userId = user.id || user.userId;

    const myShifts = DataStore.shifts
        .filter(s => {
            const sUserId = s.userId || s.employeeId;
            return Number(sUserId) === Number(userId);
        })
        .filter(s => {
            const shiftDate = parseDateOnly(s.date);
            return shiftDate >= today && shiftDate <= endDate;
        })
        .sort((a, b) => {
            const dateCompare = a.date.localeCompare(b.date, 'nl-BE');
            if (dateCompare !== 0) return dateCompare;
            return (a.startTime || a.start_time || '').localeCompare(b.startTime || b.start_time || '', 'nl-BE');
        });

    const dayNames = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

    let shiftsHtml = '';
    if (myShifts.length === 0) {
        shiftsHtml = '<div class="home-card-empty">Geen diensten gepland voor de komende 7 dagen</div>';
    } else {
        shiftsHtml = '<div class="home-card-body">';
        myShifts.forEach(shift => {
            const shiftDate = parseDateOnly(shift.date);
            const dayNum = shiftDate.getDate();
            const monthShort = shiftDate.toLocaleDateString('nl-BE', { month: 'short' });
            const dayName = dayNames[shiftDate.getDay()];
            const startTime = shift.startTime || shift.start_time || '';
            const endTime = shift.endTime || shift.end_time || '';
            const isToday = shift.date.split('T')[0] === todayStr;
            const teamId = shift.team;
            const teamSettings = DataStore.settings?.teams?.[teamId];
            const teamName = teamSettings?.name || teamId || '';
            const teamColor = teamSettings?.color || '#64748b';

            shiftsHtml += `
                <div class="home-shift-item ${isToday ? 'home-shift-today' : ''}">
                    <div class="home-shift-date">
                        <span class="home-shift-date-num">${dayNum}</span>
                        <span class="day-name">${isToday ? 'Vandaag' : escapeHtml(dayName)}</span>
                    </div>
                    <div class="home-shift-time">${escapeHtml(startTime)} – ${escapeHtml(endTime)}</div>
                    <span class="home-shift-team" style="background:${escapeHtml(teamColor)}">${escapeHtml(teamName)}</span>
                </div>
            `;
        });
        shiftsHtml += '</div>';
    }

    return `
        <div class="home-card home-card-shifts">
            <div class="home-card-header">
                Mijn komende diensten
                ${myShifts.length > 0 ? `<span class="card-count">${myShifts.length}</span>` : ''}
            </div>
            ${shiftsHtml}
        </div>
    `;
}

function renderHomeQuickActions(role) {
    let actions = '';

    if (['admin', 'roosterverantwoordelijke'].includes(role)) {
        actions += `<button class="home-action-btn" data-action="add-shift"><span class="home-action-icon">${IconHelper.html('plus', 'md')}</span>Dienst toevoegen</button>`;
    }

    actions += `<button class="home-action-btn" data-action="view-planning"><span class="home-action-icon">${IconHelper.html(ICONS.planning, 'md')}</span>Planning bekijken</button>`;
    actions += `<button class="home-action-btn" data-action="request-absence"><span class="home-action-icon">${IconHelper.html(ICONS.availability, 'md')}</span>Afwezigheid melden</button>`;
    actions += `<button class="home-action-btn" data-action="request-swap"><span class="home-action-icon">${IconHelper.html(ICONS.swap, 'md')}</span>Dienst ruilen</button>`;

    return `
        <div class="home-card">
            <div class="home-card-header">Snelle acties</div>
            <div class="home-card-body">
                <div class="home-quick-actions">${actions}</div>
            </div>
        </div>
    `;
}

function renderHomeRequests(user, role) {
    const userId = Number(user.id || user.userId);
    const userTeam = user.team_id || user.mainTeam;
    const isLeadOrAdmin = ['admin', 'roosterverantwoordelijke'].includes(role);

    let pendingRequests = (DataStore.swapRequests || []).filter(r => {
        if (r.status !== 'pending' && r.status !== 'pending_lead') return false;

        if (isLeadOrAdmin) return true;
        // Medewerker: eigen requests + takeover requests van eigen team
        return r.requester_user_id === userId || r.target_user_id === userId ||
               (r.request_type === 'takeover' && r.requester_shift_team === userTeam);
    });

    let requestsHtml = '';
    if (pendingRequests.length === 0) {
        requestsHtml = '<div class="home-card-empty">Geen openstaande verzoeken</div>';
    } else {
        requestsHtml = '<div class="home-card-body">';
        pendingRequests.slice(0, 5).forEach(req => {
            const isSwap = req.request_type === 'swap';
            const typeLabel = isSwap ? 'Ruil' : 'Overname';
            const requesterName = escapeHtml(req.requester_name || 'Onbekend');
            const date = req.requester_shift_date ? req.requester_shift_date.split('T')[0] : '';
            const dateDisplay = date ? parseDateOnly(date).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' }) : '';

            const needsMyAction = req.target_user_id === userId && !req.target_approved;
            const statusLabel = needsMyAction ? 'Actie vereist' : 'Wacht op reactie';
            const statusClass = needsMyAction ? 'needs-action' : 'pending';

            requestsHtml += `
                <div class="home-request-item" data-action="view-swaps">
                    <div class="home-request-info">
                        <div class="home-request-type">${typeLabel}</div>
                        <div class="home-request-detail">${requesterName} - ${escapeHtml(dateDisplay)}</div>
                    </div>
                    <span class="home-request-status ${statusClass}">${statusLabel}</span>
                </div>
            `;
        });
        if (pendingRequests.length > 5) {
            requestsHtml += `<div class="home-card-empty" style="padding:8px 0">+ ${pendingRequests.length - 5} meer...</div>`;
        }
        requestsHtml += '</div>';
    }

    return `
        <div class="home-card">
            <div class="home-card-header">
                Openstaande verzoeken
                ${pendingRequests.length > 0 ? `<span class="card-count">${pendingRequests.length}</span>` : ''}
            </div>
            ${requestsHtml}
        </div>
    `;
}

function renderHomeTeamCoverage(role, user) {
    const userTeam = user.team_id || user.mainTeam;
    const teams = DataStore.settings?.teams || {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get this week's dates (Mon-Sun)
    const weekDates = getWeekDates(today);
    const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    // Filter teams based on role
    const teamIds = Object.keys(teams).filter(id => {
        if (['admin', 'roosterverantwoordelijke'].includes(role)) return true;
        return id === userTeam;
    });

    if (teamIds.length === 0) return '';

    let coverageHtml = '<div class="home-card-body">';

    teamIds.forEach(teamId => {
        const team = teams[teamId];
        if (!team) return;
        const teamColor = team.color || '#64748b';

        // Count employees in this team
        const teamEmployees = (DataStore.users || []).filter(u =>
            u.active !== false && (u.main_team === teamId || u.team_id === teamId) && u.role !== 'admin'
        );
        const totalEmployees = teamEmployees.length;
        if (totalEmployees === 0) return;

        coverageHtml += `<div class="home-team-section">`;
        coverageHtml += `<div class="home-team-name"><span class="home-team-color-dot" style="background:${escapeHtml(teamColor)}"></span>${escapeHtml(team.name)}</div>`;

        weekDates.forEach((dateStr, i) => {
            // Count shifts for this team on this date
            const shiftsOnDate = DataStore.shifts.filter(s =>
                s.team === teamId && s.date.split('T')[0] === dateStr
            ).length;

            // Count absences for this team on this date
            const absentOnDate = (DataStore.availability || []).filter(a => {
                const emp = teamEmployees.find(e => Number(e.id) === Number(a.user_id || a.userId));
                return emp && a.date.split('T')[0] === dateStr;
            }).length;

            const presentCount = Math.min(shiftsOnDate, totalEmployees);
            const fillPercent = totalEmployees > 0 ? Math.round((presentCount / totalEmployees) * 100) : 0;
            const barColor = fillPercent >= 70 ? 'var(--success-color)' : fillPercent >= 40 ? 'var(--warning-color)' : 'var(--danger-color)';

            coverageHtml += `
                <div class="home-coverage-bar">
                    <span class="home-coverage-label">${dayLabels[i]}</span>
                    <div class="home-coverage-track">
                        <div class="home-coverage-fill" style="width:${fillPercent}%;background:${barColor}"></div>
                    </div>
                    <span class="home-coverage-count">${presentCount}/${totalEmployees}</span>
                </div>
            `;
        });

        coverageHtml += `</div>`;
    });

    coverageHtml += '</div>';

    return `
        <div class="home-card home-card-full">
            <div class="home-card-header">Team bezetting deze week</div>
            ${coverageHtml}
        </div>
    `;
}

function renderHomeWeekendInfo() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get Monday of current week
    const thisMonday = getMonday(today);

    // Check if currently in a holiday period
    const isHoliday = typeof isHolidayPeriod === 'function' && isHolidayPeriod(today);
    const holidayPeriod = isHoliday && typeof getHolidayPeriod === 'function' ? getHolidayPeriod(today) : null;

    // Find upcoming open weekends (next 4 weeks)
    const upcomingWeekends = [];
    for (let i = 0; i < 4; i++) {
        const weekMonday = new Date(thisMonday);
        weekMonday.setDate(weekMonday.getDate() + (i * 7));

        if (typeof isWeekendOrHolidayWeek === 'function' && isWeekendOrHolidayWeek(weekMonday)) {
            const saturday = new Date(weekMonday);
            saturday.setDate(saturday.getDate() + 5);
            const resp = typeof getOrCalculateResponsible === 'function' ? getOrCalculateResponsible(weekMonday) : null;
            upcomingWeekends.push({ date: saturday, responsible: resp, weekMonday });
        }
    }

    let bodyHtml = '<div class="home-card-body">';

    // Holiday indicator
    if (isHoliday && holidayPeriod) {
        bodyHtml += `
            <div class="warning-banner">
                <div>
                    <strong>Vakantiewerking actief</strong>
                    <div class="text-sm text-muted">${escapeHtml(holidayPeriod.name || 'Vakantieperiode')}</div>
                </div>
            </div>
        `;
    }

    // Upcoming weekends
    if (upcomingWeekends.length > 0) {
        upcomingWeekends.forEach(weekend => {
            const dateStr = weekend.date.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
            const respName = weekend.responsible ? escapeHtml(weekend.responsible.name) : '<em>Niet toegewezen</em>';
            const isThisWeek = weekend.weekMonday.getTime() === thisMonday.getTime();
            const weekHoliday = typeof getHolidayPeriod === 'function' ? getHolidayPeriod(weekend.date) : null;
            const isVakantieResp = weekHoliday && weekHoliday.responsibleId && weekend.responsible;
            const vakantieBadge = isVakantieResp ? '<span class="shift-badge-upcoming">vakantie</span>' : '';

            bodyHtml += `
                <div class="shift-list-item${!isThisWeek ? ' opacity-70' : ''}">
                    <div>
                        <span class="${isThisWeek ? 'fw-600' : ''}">Weekend ${dateStr}</span>
                        ${isThisWeek ? '<span class="shift-badge-today">Deze week</span>' : ''}
                    </div>
                    <span class="text-sm text-muted">${respName}${vakantieBadge}</span>
                </div>
            `;
        });
    } else {
        bodyHtml += '<div class="text-muted text-sm py-sm">Geen open weekenden komende 4 weken</div>';
    }

    bodyHtml += '</div>';

    return `
        <div class="home-card">
            <div class="home-card-header">
                Weekend & Vakantie
                ${isHoliday ? '<span class="shift-badge-upcoming">Vakantie</span>' : ''}
            </div>
            ${bodyHtml}
        </div>
    `;
}

async function switchView(viewName) {
    // Prevent medewerker from accessing settings
    if (viewName === 'settings' && getEffectiveRole() === 'medewerker') {
        viewName = 'home';
    }
    // Warn about unsaved settings changes
    if (AppState.settingsDirty && AppState.currentView === 'settings' && viewName !== 'settings') {
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in instellingen. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        AppState.settingsDirty = false;
    }
    // Warn about unsaved builder changes
    if (AppState.builderIsDirty && AppState.currentView === 'builder' && viewName !== 'builder') {
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in de roosterbouwer. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        // Reset builder state so returning shows overview
        AppState.builderScreen = 'overview';
        AppState.builderIsDirty = false;
        AppState.builderLoadedDraftId = null;
        AppState.builderLoadedDraftName = null;
        AppState.builderPattern = null;
        AppState.builderConceptType = 'basis';
        AppState.builderHolidayPeriodId = null;
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderShowStaffingEditor = false;
        AppState.builderShowMeetingsEditor = false;
        AppState.builderMeetings = {};
    } else if (AppState.currentView === 'builder' && viewName !== 'builder') {
        // Also reset when leaving builder without unsaved changes
        AppState.builderScreen = 'overview';
        AppState.builderPattern = null;
        AppState.builderConceptType = 'basis';
        AppState.builderHolidayPeriodId = null;
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderShowStaffingEditor = false;
        AppState.builderShowMeetingsEditor = false;
        AppState.builderMeetings = {};
    }
    // Clear undo history when switching views
    UndoManager.clear();

    // Cleanup drag handlers when switching views
    if (typeof DragHandler !== 'undefined') {
        DragHandler.cleanup();
    }
    if (typeof BuilderDragHandler !== 'undefined') {
        BuilderDragHandler.cleanup();
    }

    AppState.currentView = viewName;
    // Reset shift range when leaving planning, set when entering
    if (viewName === 'planning') {
        updateShiftRefreshRange();
    } else {
        setActiveShiftRange(null, null);
    }
    // Save to localStorage so we can restore after refresh
    localStorage.setItem('hetvlot_activeView', viewName);
    DOM.navButtons.forEach(btn => {
        if (btn.dataset.view === viewName) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });
    switch (viewName) {
        case 'home':
            DOM.homeView.classList.add('active');
            renderHome();
            break;
        case 'planning':
            DOM.planningView.classList.add('active');
            renderPlanning();
            break;
        case 'employees':
            DOM.employeesView.classList.add('active');
            renderEmployees();
            break;
        case 'profile':
            DOM.profileView.classList.add('active');
            renderProfile();
            break;
        case 'availability':
            DOM.availabilityView.classList.add('active');
            renderAvailability();
            break;
        case 'swaps':
            DOM.swapsView.classList.add('active');
            renderSwaps();
            break;
        case 'builder':
            DOM.builderView.classList.add('active');
            renderBuilder();
            break;
        case 'settings':
            DOM.settingsView.classList.add('active');
            renderSettings();
            break;
    }
}

function setCurrentWeek(date) {
    const d = parseDateOnly(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    AppState.currentWeekStart = d;
    updateShiftRefreshRange();
    updatePeriodDisplay();
}

function getEmployeeWeekStart(employeeId) {
    const base = getMonday(new Date());
    const offset = AppState.employeeWeekOffsets?.[employeeId] || 0;
    const d = new Date(base);
    d.setDate(d.getDate() + (offset * 7));
    d.setHours(0, 0, 0, 0);
    return d;
}

function changeWeek(direction) {
    if (!AppState.currentWeekStart) {
        setCurrentWeek(new Date());
        return;
    }
    const newDate = new Date(AppState.currentWeekStart.getTime());
    newDate.setDate(newDate.getDate() + (direction * 7));
    setCurrentWeek(newDate);
    renderPlanning();
}

// Set current month
function setCurrentMonth(date) {
    const d = parseDateOnly(date);
    d.setDate(1); // Set to 1st of month
    d.setHours(0, 0, 0, 0);
    AppState.currentMonthStart = d;
    updatePeriodDisplay();
}

// Change month (direction: -1 for previous, 1 for next)
function changeMonth(direction) {
    if (!AppState.currentMonthStart) {
        setCurrentMonth(new Date());
        return;
    }
    const newDate = new Date(AppState.currentMonthStart);
    newDate.setMonth(newDate.getMonth() + direction);
    setCurrentMonth(newDate);
    renderPlanning();
}

// Jump to today (unified function for both views)
function jumpToToday() {
    const today = new Date();
    if (AppState.viewMode === 'week' || AppState.viewMode === 'day') {
        setCurrentWeek(today);
        const dayOfWeek = today.getDay();
        AppState.mobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    } else {
        setCurrentMonth(today);
    }
    renderPlanning();
}

// ===== MOBILE DAY NAVIGATION =====
function changeMobileDay(direction) {
    AppState.mobileDayIndex += direction;

    // Wrap around: if < 0, go to Sunday (6), if > 6, go to Monday (0)
    if (AppState.mobileDayIndex < 0) {
        AppState.mobileDayIndex = 6;
        changeWeek(-1); // Go to previous week
    } else if (AppState.mobileDayIndex > 6) {
        AppState.mobileDayIndex = 0;
        changeWeek(1); // Go to next week
    } else {
        updateMobileDayDisplay();
        updateTimelineMobileDayAttribute();
        if (AppState.viewMode === 'day') {
            updatePeriodDisplay();
        }
    }
}

function updateMobileDayDisplay() {
    if (!DOM.mobileDayDisplay || !AppState.currentWeekStart) return;

    const dayNames = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
    const currentDate = new Date(AppState.currentWeekStart);
    currentDate.setDate(currentDate.getDate() + AppState.mobileDayIndex);

    const dayName = dayNames[AppState.mobileDayIndex];
    const dateStr = currentDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
    const dateValue = formatDateYYYYMMDD(currentDate);

    DOM.mobileDayDisplay.innerHTML = `
        <span class="mobile-day-name">${dayName}</span>
        <span class="mobile-day-date">${dateStr}</span>
        <input type="date" id="mobile-date-picker" class="mobile-date-picker" value="${dateValue}">
    `;

    // Re-attach event listener since we replaced the element
    const picker = document.getElementById('mobile-date-picker');
    if (picker) {
        picker.addEventListener('change', (e) => {
            const selectedDate = new Date(e.target.value);
            if (!isNaN(selectedDate.getTime())) {
                jumpToDate(selectedDate);
            }
        });
    }
}

function updateTimelineMobileDayAttribute() {
    const wrapper = document.querySelector('.timeline-view-wrapper');
    if (wrapper) {
        wrapper.setAttribute('data-mobile-day', AppState.mobileDayIndex);
    }
}

function jumpToDate(date) {
    // Set the week to the week containing the selected date
    setCurrentWeek(date);

    // Calculate which day of the week (0=Mon, 6=Sun)
    const dayOfWeek = date.getDay();
    AppState.mobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    renderPlanning();
}

// ===== AVAILABILITY MOBILE DAY NAVIGATION =====
function getAvailabilityMobileDayDisplayHTML() {
    if (!AppState.currentWeekStart) return '';

    const dayNames = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
    const currentDate = new Date(AppState.currentWeekStart);
    currentDate.setDate(currentDate.getDate() + AppState.availabilityMobileDayIndex);

    const dayName = dayNames[AppState.availabilityMobileDayIndex];
    const dateStr = currentDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
    const dateValue = formatDateYYYYMMDD(currentDate);

    return `
        <span class="mobile-day-name">${dayName}</span>
        <span class="mobile-day-date">${dateStr}</span>
        <input type="date" id="availability-mobile-date-picker" class="mobile-date-picker" value="${dateValue}">
    `;
}

function changeAvailabilityMobileDay(direction) {
    AppState.availabilityMobileDayIndex += direction;

    if (AppState.availabilityMobileDayIndex < 0) {
        AppState.availabilityMobileDayIndex = 6;
        AppState.currentWeekStart.setDate(AppState.currentWeekStart.getDate() - 7);
    } else if (AppState.availabilityMobileDayIndex > 6) {
        AppState.availabilityMobileDayIndex = 0;
        AppState.currentWeekStart.setDate(AppState.currentWeekStart.getDate() + 7);
    }

    renderAvailability();
}

function jumpToAvailabilityDate(date) {
    setCurrentWeek(date);
    const dayOfWeek = date.getDay();
    AppState.availabilityMobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    renderAvailability();
}

function changeViewMode(mode) {
    if (mode === AppState.viewMode) return; // Already in this mode

    // Store context before switching
    if (mode === 'month' && AppState.viewMode === 'week') {
        // Switching week → month
        AppState.previousWeekStart = AppState.currentWeekStart;
        setCurrentMonth(AppState.currentWeekStart || new Date());
    } else if (mode === 'week' && AppState.viewMode === 'month') {
        // Switching month → week
        if (AppState.previousWeekStart) {
            AppState.currentWeekStart = AppState.previousWeekStart;
        } else {
            setCurrentWeek(AppState.currentMonthStart || new Date());
        }
    } else if (mode === 'day') {
        // Switching to day mode: default to today's day in current week
        if (!AppState.currentWeekStart) {
            setCurrentWeek(new Date());
        }
        const today = new Date();
        const todayDow = today.getDay();
        AppState.mobileDayIndex = todayDow === 0 ? 6 : todayDow - 1;
    } else if (mode === 'week' && AppState.viewMode === 'day') {
        // Switching day → week: keep current week, no changes needed
    }

    AppState.viewMode = mode;
    document.body.setAttribute('data-view-mode', mode);

    DOM.viewToggleBtns.forEach(btn => {
        if (btn.dataset.mode === mode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    updatePeriodDisplay();
    renderPlanning();
}

function updatePeriodDisplay() {
    if (AppState.viewMode === 'month') {
        // Month view: show "februari 2026"
        if (!AppState.currentMonthStart) {
            setCurrentMonth(new Date());
            return;
        }
        DOM.currentPeriod.textContent = formatMonthDisplay(AppState.currentMonthStart);
    } else if (AppState.viewMode === 'day') {
        // Day view: show "Maandag, 3 maart 2026"
        if (!AppState.currentWeekStart) {
            setCurrentWeek(new Date());
            return;
        }
        const dayNames = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
        const currentDate = new Date(AppState.currentWeekStart);
        currentDate.setDate(currentDate.getDate() + AppState.mobileDayIndex);
        const dateStr = currentDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });
        DOM.currentPeriod.textContent = `${dayNames[AppState.mobileDayIndex]}, ${dateStr}`;
    } else {
        // Week view: show "Week 6 | 3 februari 2026 - 9 februari 2026"
        if (!AppState.currentWeekStart) {
            setCurrentWeek(new Date());
            return;
        }
        const weekEnd = new Date(AppState.currentWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const options = { day: 'numeric', month: 'long', year: 'numeric' };
        const startStr = AppState.currentWeekStart.toLocaleDateString('nl-BE', options);
        const endStr = weekEnd.toLocaleDateString('nl-BE', options);
        DOM.currentPeriod.textContent = `${startStr} - ${endStr}`;
    }
}

function renderPlanning() {
    // Save window scroll position before re-rendering
    const savedScrollY = window.scrollY || document.documentElement.scrollTop;

    if (!AppState.currentWeekStart) {
        setCurrentWeek(new Date());
    }
    updatePeriodDisplay();
    updateMobileDayDisplay();
    renderTeamToggles();
    renderValidationAlerts();
    renderCalendar();
    // Set mobile day attribute after calendar is rendered
    updateTimelineMobileDayAttribute();

    // Update heatmap if visible
    const heatmapContainer = document.getElementById('coverage-heatmap-container');
    if (heatmapContainer && AppState.showHeatmap) {
        heatmapContainer.innerHTML = renderCoverageHeatmap();
        IconHelper.init(heatmapContainer);
    }

    // Sync heatmap button active class with state
    const heatmapBtn = document.getElementById('heatmap-toggle-btn');
    if (heatmapBtn) {
        heatmapBtn.classList.toggle('active', AppState.showHeatmap);
    }

    // Sync filter toggle button state
    const filterBtn = document.getElementById('filter-shifts-toggle');
    if (filterBtn) {
        filterBtn.classList.toggle('active', AppState.filterOnlyWithShifts);
    }

    // Restore window scroll position after DOM updates
    requestAnimationFrame(() => {
        window.scrollTo(0, savedScrollY);
    });
}

function calcPlanningHourlyHeadcount(date, hour) {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});

    // Previous day (for overnight shifts extending into this day)
    const prev = new Date(parseDateOnly(date));
    prev.setDate(prev.getDate() - 1);
    const prevDate = formatDateYYYYMMDD(prev);

    let bruto = 0;
    const workingEmployees = new Set(); // track who is working at this hour

    for (const s of DataStore.shifts) {
        if (!coverageTeams.includes(s.team)) continue;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        const startDec = sh + sm / 60;
        const endDec = eh + em / 60;
        const isNight = endDec <= startDec;

        let isWorking = false;
        if (s.date === date) {
            if (isNight) {
                if (hour >= startDec) isWorking = true;
            } else {
                if (hour >= startDec && hour < endDec) isWorking = true;
            }
        } else if (s.date === prevDate && isNight) {
            if (hour < endDec) isWorking = true;
        }

        if (isWorking) {
            bruto++;
            workingEmployees.add(String(s.employeeId || s.userId || s.user_id));
        }
    }

    // Netto: subtract employees who have an activity at this hour (only if they have a shift)
    let activityCount = 0;
    const activities = DataStore.activities.filter(a => a.date === date);
    for (const act of activities) {
        const empId = String(act.userId);
        if (!workingEmployees.has(empId)) continue; // only count if employee has a shift
        const [ash, asm] = act.startTime.split(':').map(Number);
        const [aeh, aem] = act.endTime.split(':').map(Number);
        const actStart = ash + asm / 60;
        const actEnd = aeh + aem / 60;
        if (hour >= actStart && hour < actEnd) {
            activityCount++;
        }
    }

    return { bruto, netto: bruto - activityCount };
}

function renderCoverageHeatmap() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const coverageTeamNames = coverageTeams.map(t => (DataStore.settings.teams || {})[t]?.name || t).join(' + ');

    let html = '<div class="coverage-heatmap">';
    html += `<div class="heatmap-title">Bezetting (${escapeHtml(coverageTeamNames)})</div>`;
    html += '<div class="heatmap-grid">';

    // Header row
    html += '<div class="heatmap-row heatmap-header">';
    html += '<div class="heatmap-team-cell"></div>';
    const dayNames = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
    weekDates.forEach(date => {
        const d = parseDateOnly(date);
        html += `<div class="heatmap-day-cell">${dayNames[d.getDay()]} ${d.getDate()}</div>`;
    });
    html += '</div>';

    // Single combined row
    html += '<div class="heatmap-row">';
    html += '<div class="heatmap-team-cell">Totaal</div>';

    weekDates.forEach(date => {
        const d = parseDateOnly(date);
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        const closed = isWeekend && typeof isWeekendOpen === 'function' && !isWeekendOpen(date);

        html += `<div class="coverage-heatmap-cell${closed ? ' closed' : ''}" data-date="${date}"
            onclick="showHeatmapDetail(null, '${date}')">`;

        if (!closed) {
            for (let h = 7; h < 24; h += 0.5) {
                const { bruto, netto } = calcPlanningHourlyHeadcount(date, h);
                let segClass = 'heatmap-seg';
                if (netto >= 2) segClass += ' seg-ok';
                else if (netto > 0) segClass += ' seg-warn';
                else segClass += ' seg-danger';

                const leftPct = ((h - 7) / 17) * 100;
                const widthPct = (0.5 / 17) * 100;
                const timeLabel = formatStaffingHour(h);
                const tooltipText = netto < bruto
                    ? `${timeLabel} — ${netto} beschikbaar (${bruto} ingepland, ${bruto - netto} in activiteit)`
                    : `${timeLabel} — ${bruto} medewerkers`;
                html += `<span class="${segClass}" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"
                    data-tooltip="${tooltipText}" data-tooltip-pos="top"></span>`;
            }
        }

        html += '</div>';
    });

    html += '</div>';
    html += '</div>';
    html += `<div class="heatmap-legend">
        <span class="heatmap-legend-item"><span class="heatmap-swatch seg-danger-swatch"></span>Onderbezet</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch seg-warn-swatch"></span>Krap</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch seg-ok-swatch"></span>Op sterkte</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-closed"></span>Gesloten</span>
    </div>`;
    html += '</div>';

    return html;
}

function showHeatmapDetail(teamId, date) {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const teamsToShow = teamId ? [teamId] : coverageTeams;
    const shifts = DataStore.shifts.filter(s => teamsToShow.includes(s.team) && s.date === date);

    let msg = `Bezetting - ${formatDate(date)}\n`;
    if (shifts.length === 0) {
        msg += 'Geen diensten ingepland.';
    } else {
        shifts.forEach(s => {
            const emp = getEmployee(s.employeeId);
            const teamName = (DataStore.settings.teams || {})[s.team]?.name || s.team;
            msg += `${emp?.name || 'Onbekend'} (${teamName}): ${s.startTime} - ${s.endTime}\n`;
        });
    }
    showToast(msg.trim(), 'info', 5000);
}

function renderValidationAlerts() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const startDate = weekDates[0];
    const endDate = weekDates[6];
    const summary = getValidationSummary(startDate, endDate);

    let html = '';

    // Weekend/Vakantie verantwoordelijke sectie
    html += renderResponsibleSection();

    let totalErrors = 0;
    let totalWarnings = 0;

    // Count totals
    Object.keys(summary.dates).forEach(date => {
        const dateIssues = summary.dates[date];
        totalErrors += dateIssues.errors.length;
        totalWarnings += dateIssues.warnings.length;
    });

    // Show compact summary if there are issues
    if (totalErrors > 0 || totalWarnings > 0) {
        html += '<div class="validation-summary">';

        if (totalErrors > 0) {
            AppState.errorBreakdown = buildIssueBreakdown(summary, 'errors');
            html += `<div class="validation-summary-item validation-error">
                <span class="validation-icon">${IconHelper.html(ICONS.info, 'sm')}</span>
                <span class="validation-text">${totalErrors} opmerking${totalErrors > 1 ? 'en' : ''}</span>
            </div>`;
        } else {
            AppState.errorBreakdown = null;
        }

        if (totalWarnings > 0) {
            AppState.warningBreakdown = buildIssueBreakdown(summary, 'warnings');
            html += `<div class="validation-summary-item validation-warning">
                <span class="validation-icon">${IconHelper.html(ICONS.zap, 'sm')}</span>
                <span class="validation-text">${totalWarnings} opmerking${totalWarnings > 1 ? 'en' : ''}</span>
            </div>`;
        } else {
            AppState.warningBreakdown = null;
        }

        html += '<div class="validation-summary-note">Klik voor details per regel</div>';
        html += '</div>';

    }

    DOM.validationAlerts.innerHTML = html;
    IconHelper.init(DOM.validationAlerts);
}

function buildIssueBreakdown(summary, issueType) {
    const issueBreakdown = {};
    const issuesKey = issueType === 'errors' ? 'errors' : 'warnings';
    Object.entries(summary.dates).forEach(([date, dateIssues]) => {
        dateIssues[issuesKey].forEach(issue => {
            const key = issue.rule || 'Onbekende waarschuwing';
            if (!issueBreakdown[key]) {
                issueBreakdown[key] = {
                    count: 0,
                    dates: new Set(),
                    messages: new Set()
                };
            }
            issueBreakdown[key].count += 1;
            issueBreakdown[key].dates.add(date);
            if (issue.message) {
                issueBreakdown[key].messages.add(issue.message);
            }
        });
    });

    return Object.entries(issueBreakdown)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([rule, info]) => {
            const dates = Array.from(info.dates).sort().map(date => formatDate(date));
            const messages = Array.from(info.messages);
            return {
                rule,
                count: info.count,
                dates,
                messages
            };
        });
}

function openWarningDetailsModal() {
    if (!DOM.warningDetailsModal) return;
    DOM.warningDetailsList.innerHTML = '';

    const breakdown = AppState.warningBreakdown || [];
    if (breakdown.length === 0) {
        DOM.warningDetailsList.innerHTML = '<p>Geen waarschuwingen gevonden voor deze periode.</p>';
    } else {
        DOM.warningDetailsList.innerHTML = breakdown.map(item => {
            const dates = item.dates.map(date => `<li>${escapeHtml(date)}</li>`).join('');
            const messageItems = item.messages.map(message => `<li>${escapeHtml(message)}</li>`).join('');
            return `<div class="issue-details-item">
                <div class="issue-details-header">
                    <span class="issue-details-rule">${escapeHtml(item.rule)}</span>
                    <span class="issue-details-count">${item.count}x</span>
                </div>
                <div class="issue-details-messages">
                    <div class="issue-details-label">Context</div>
                    <ul>${messageItems}</ul>
                </div>
                <div class="issue-details-dates">
                    <div class="issue-details-label">Datums</div>
                    <ul>${dates}</ul>
                </div>
            </div>`;
        }).join('');
    }

    DOM.warningDetailsModal.classList.remove('hidden');
}

function closeWarningDetailsModal() {
    if (!DOM.warningDetailsModal) return;
    DOM.warningDetailsModal.classList.add('hidden');
}

function openErrorDetailsModal() {
    if (!DOM.errorDetailsModal) return;
    DOM.errorDetailsList.innerHTML = '';

    const breakdown = AppState.errorBreakdown || [];
    if (breakdown.length === 0) {
        DOM.errorDetailsList.innerHTML = '<p>Geen fouten gevonden voor deze periode.</p>';
    } else {
        DOM.errorDetailsList.innerHTML = breakdown.map(item => {
            const dates = item.dates.map(date => `<li>${escapeHtml(date)}</li>`).join('');
            const messageItems = item.messages.map(message => `<li>${escapeHtml(message)}</li>`).join('');
            return `<div class="issue-details-item">
                <div class="issue-details-header">
                    <span class="issue-details-rule">${escapeHtml(item.rule)}</span>
                    <span class="issue-details-count">${item.count}x</span>
                </div>
                <div class="issue-details-messages">
                    <div class="issue-details-label">Context</div>
                    <ul>${messageItems}</ul>
                </div>
                <div class="issue-details-dates">
                    <div class="issue-details-label">Datums</div>
                    <ul>${dates}</ul>
                </div>
            </div>`;
        }).join('');
    }

    DOM.errorDetailsModal.classList.remove('hidden');
}

function closeErrorDetailsModal() {
    if (!DOM.errorDetailsModal) return;
    DOM.errorDetailsModal.classList.add('hidden');
}

function renderResponsibleSection() {
    // De verantwoordelijke wordt nu in de planning zelf getoond (bij de naam)
    // Deze functie geeft een lege string terug
    return '';
}

// Group shifts that overlap in time into groups
function groupOverlappingShifts(shifts) {
    if (shifts.length === 0) return [];

    // Helper function to check if two shifts overlap
    function shiftsOverlap(shift1, shift2) {
        const [s1StartHour, s1StartMin] = shift1.startTime.split(':').map(Number);
        const [s1EndHour, s1EndMin] = shift1.endTime.split(':').map(Number);
        const [s2StartHour, s2StartMin] = shift2.startTime.split(':').map(Number);
        const [s2EndHour, s2EndMin] = shift2.endTime.split(':').map(Number);

        const s1Start = s1StartHour * 60 + s1StartMin;
        const s1End = (s1EndHour < s1StartHour ? (s1EndHour + 24) * 60 : s1EndHour * 60) + s1EndMin;
        const s2Start = s2StartHour * 60 + s2StartMin;
        const s2End = (s2EndHour < s2StartHour ? (s2EndHour + 24) * 60 : s2EndHour * 60) + s2EndMin;

        return !(s1End <= s2Start || s2End <= s1Start);
    }

    // Sort shifts by start time
    const sortedShifts = [...shifts].sort((a, b) => {
        const [aHour, aMin] = a.startTime.split(':').map(Number);
        const [bHour, bMin] = b.startTime.split(':').map(Number);
        return (aHour * 60 + aMin) - (bHour * 60 + bMin);
    });

    const groups = [];
    const assigned = new Set();

    sortedShifts.forEach(shift => {
        if (assigned.has(shift.id)) return;

        // Start a new group with this shift
        const group = [shift];
        assigned.add(shift.id);

        // Find all shifts that overlap with any shift in the group
        let addedToGroup = true;
        while (addedToGroup) {
            addedToGroup = false;
            for (const otherShift of sortedShifts) {
                if (assigned.has(otherShift.id)) continue;

                // Check if this shift overlaps with any shift in the current group
                const overlapsWithGroup = group.some(groupShift => shiftsOverlap(groupShift, otherShift));

                if (overlapsWithGroup) {
                    group.push(otherShift);
                    assigned.add(otherShift.id);
                    addedToGroup = true;
                }
            }
        }

        groups.push(group);
    });

    return groups;
}

function renderCalendar() {
    try {
        if (AppState.viewMode === 'month') {
            renderMonthView();
        } else {
            renderTimelineView();
        }
    } catch (error) {
        console.error('Error rendering calendar:', error);
        DOM.rosterCalendar.innerHTML = '<div class="no-shifts-message">Planner kon niet geladen worden. Probeer de pagina te herladen.</div>';
    }
}

// Helper: render overnight continuation blocks for day view
function renderOvernightContinuation(empId, date, START_HOUR, TOTAL_HOURS) {
    let html = '';
    const prevDate = new Date(parseDateOnly(date));
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = formatDateYYYYMMDD(prevDate);
    let prevShifts = getShiftsByEmployee(empId, prevDateStr, prevDateStr);
    prevShifts = prevShifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
    prevShifts.forEach(prevShift => {
        const [pH, ] = prevShift.startTime.split(':').map(Number);
        const [eH, eM] = prevShift.endTime.split(':').map(Number);
        const prevIsOvernight = eH < pH;
        if (prevIsOvernight && (eH + eM / 60) > START_HOUR) {
            const endFrac = eH + eM / 60;
            const w = ((endFrac - START_HOUR) / TOTAL_HOURS) * 100;
            html += `<div class="timeline-block team-${prevShift.team} nacht overnight-continuation"
                         data-shift-id="${prevShift.id}"
                         data-employee-id="${prevShift.employeeId}"
                         data-date="${prevShift.date}"
                         data-original-date="${prevDateStr}"
                         data-label="doorloop"
                         style="left: 0%; width: ${w}%; cursor: pointer; opacity: 0.7;"
                         data-tooltip="Doorloop van ${prevDateStr}: ${escapeHtml(prevShift.startTime + '-' + prevShift.endTime)}" data-tooltip-pos="bottom">
                    <span class="block-time">→${prevShift.endTime}</span>
                </div>`;
        }
    });
    return html;
}

function renderTimelineView() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const dayNames = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

    // Get all shifts this week (filtered by visible teams)
    let allShifts = [];
    weekDates.forEach(date => {
        let shifts = getShiftsByDate(date);
        // Filter by visible teams (include shifts without team)
        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
        allShifts = allShifts.concat(shifts);
    });

    // Get employees: those with shifts + all active employees in visible teams
    const employeeIdsWithShifts = new Set(allShifts.map(s => s.employeeId));
    const activeEmployees = getAllEmployees(true).filter(emp =>
        emp.mainTeam && AppState.visibleTeams.includes(emp.mainTeam)
    );
    // Merge: start with active employees, add any with shifts not yet included
    const employeeMap = new Map();
    activeEmployees.forEach(emp => employeeMap.set(emp.id, emp));
    employeeIdsWithShifts.forEach(id => {
        if (!employeeMap.has(id)) {
            const emp = getEmployee(id);
            if (emp) employeeMap.set(id, emp);
        }
    });
    let employees = [...employeeMap.values()];

    // Filter: only show employees with shifts if toggle is active
    if (AppState.filterOnlyWithShifts) {
        employees = employees.filter(emp => employeeIdsWithShifts.has(emp.id));
    }

    // Group employees by their main team - only show visible teams
    const teams = DataStore.settings.teams || {};
    const teamOrder = getTeamOrder()
        .filter(t => AppState.visibleTeams.includes(t));
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    });

    // Add employees without a team to a special "no-team" category
    const employeesWithoutTeam = employees
        .filter(emp => !emp.mainTeam || !teamOrder.includes(emp.mainTeam))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    if (employeesWithoutTeam.length > 0) {
        employeesByTeam['_no_team'] = employeesWithoutTeam;
    }

    // Time range: 7:00 to 24:00 (midnight)
    const START_HOUR = 7;
    const END_HOUR = 24;
    const TOTAL_HOURS = END_HOUR - START_HOUR;

    // Check of deze week een verantwoordelijke nodig heeft en wie dat is
    const currentWeekStart = new Date(AppState.currentWeekStart);
    const needsResponsible = isWeekendOrHolidayWeek(currentWeekStart);
    const responsible = needsResponsible ? getOrCalculateResponsible(currentWeekStart) : null;

    let html = '<div class="timeline-view-wrapper">';

    // Header row with days
    html += '<div class="timeline-header">';
    html += '<div class="timeline-name-header">Medewerker</div>';
    weekDates.forEach((date) => {
        const d = parseDateOnly(date);
        const dayOfWeek = d.getDay();
        const dayName = dayNames[dayOfWeek];
        const dateNum = d.getDate();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isClosed = isDayClosed(date);
        const isHoliday = isHolidayPeriod(date);
        const holidayInfo = isHoliday ? getHolidayPeriod(date) : null;

        let headerClass = 'timeline-day-header';
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        if (isHoliday) headerClass += ' holiday';

        const holidayLabel = escapeHtml(holidayInfo?.name || 'Vakantie');
        const holidayBadge = isHoliday ? `<span class="holiday-badge" data-tooltip="${holidayLabel}">${IconHelper.html(ICONS.holiday, 'xs')}</span>` : '';

        html += `<div class="${headerClass}">
            <span class="day-name">${dayName}</span>
            <span class="day-num">${dateNum}${holidayBadge}</span>
        </div>`;
    });
    html += '</div>';

    // Body with team groups
    html += '<div class="timeline-body">';

    if (employees.length === 0) {
        html += '<div class="empty-state"><p>Geen shifts gepland voor deze periode.</p><small>Pas een concept toe of voeg shifts handmatig toe.</small></div>';
    } else {
        // Render each team group
        teamOrder.forEach(teamKey => {
            const teamEmployees = employeesByTeam[teamKey];
            if (teamEmployees.length === 0) return; // Skip empty teams

            const team = teams[teamKey] || { name: teamKey };
            const teamName = escapeHtml(team.name);

            // Team header row
            html += `<div class="timeline-team-header team-${teamKey}">
                <div class="team-header-name">${teamName}</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            // Employee rows for this team
            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="timeline-row ${isAlt ? 'alt' : ''}">`;

                // Employee name - check if this is the weekend responsible
                const isResponsible = responsible && String(responsible.id) === String(emp.id);
                const responsibleBadge = isResponsible ? `<span class="responsible-badge">${IconHelper.html(ICONS.star, 'xs')}</span>` : '';
                const responsibleClass = isResponsible ? ' is-responsible' : '';
                const responsibleTooltip = isResponsible ? 'data-tooltip="Weekendverantwoordelijke" data-tooltip-pos="right"' : '';

                const employeeName = escapeHtml(emp.name);
                html += `<div class="timeline-employee-cell${responsibleClass}" ${responsibleTooltip}>
                    ${responsibleBadge}<span class="emp-name">${employeeName}</span>
                </div>`;

                // Day cells with time blocks
                weekDates.forEach(date => {
                    const d = parseDateOnly(date);
                    const dayOfWeek = d.getDay();
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    const isClosed = isDayClosed(date);

                    let cellClass = 'timeline-day-cell';
                    if (isWeekend) cellClass += ' weekend';
                    if (isClosed) cellClass += ' closed';

                    // Check if there are shifts for this cell (to add has-shifts class)
                    if (!isClosed) {
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
                        if (shifts.length > 0) cellClass += ' has-shifts';
                    }

                    html += `<div class="${cellClass}" data-date="${date}">`;

                    if (!isClosed) {
                        // Check if there's a shift block for this employee on this date
                        const hasShiftBlock = DataStore.shiftBlocks.some(
                            block => String(block.user_id) === String(emp.id) && block.date === date
                        );

                        // Show shift block indicator if present
                        if (hasShiftBlock) {
                            html += `<div class="shift-block-indicator" data-tooltip="Shift geblokkeerd (auto-schedule overgeslagen)" data-tooltip-pos="top">${IconHelper.html('circle-slash', 'xs')}</div>`;
                        }

                        // Get shifts for this employee on this date
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        // Filter by visible teams (include shifts without team)
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                        const isDayView = AppState.viewMode === 'day';

                        // In day view: also show overnight shifts from previous day (continuation)
                        if (isDayView) {
                            html += renderOvernightContinuation(emp.id, date, START_HOUR, TOTAL_HOURS);
                        }

                        // Render shifts that start on this day
                        shifts.forEach(shift => {
                            const validation = validateShift(shift, shift.id);
                            const availability = getAvailability(shift.employeeId, date);

                            // Check if employee is absent - this is a conflict!
                            const validAbsenceTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
                            const isAbsent = availability && availability.type && validAbsenceTypes.includes(availability.type);

                            const [startHour, startMin] = shift.startTime.split(':').map(Number);
                            const [endHour, endMin] = shift.endTime.split(':').map(Number);

                            // Check if this is an overnight shift
                            const isOvernight = endHour < startHour;

                            // Calculate position and width
                            const startFrac = startHour + startMin / 60;
                            const leftPercent = Math.max(0, ((startFrac - START_HOUR) / TOTAL_HOURS) * 100);

                            let widthPercent;
                            if (isOvernight) {
                                // Nachtdienst: bereken totale breedte over beide dagen
                                // Van starttijd tot middernacht (24:00) op dag 1
                                // Plus van START_HOUR (7:00) tot eindtijd op dag 2
                                const hoursDay1 = END_HOUR - startFrac; // van start tot 24:00
                                const hoursDay2 = Math.max(0, (endHour + endMin / 60) - START_HOUR); // van 7:00 tot eind

                                // Clip to own cell in day view or on Sunday (last day of week)
                                if (dayOfWeek === 0 || isDayView) {
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    widthPercent = `${widthDay1Percent}%`;
                                } else {
                                    // Other days: show full overnight shift spanning two day cells
                                    // We moeten de width berekenen als: dag1 deel + kleine gap + dag2 deel
                                    // De dag cellen zitten naast elkaar, dus 100% = 1 volledige cel
                                    // We gebruiken calc() met een kleine extra voor de grid gap
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;

                                    // Totaal: dag1 + gap (4px) + dag2
                                    widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                                }
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
                            }

                            let blockClass = `timeline-block team-${shift.team}`;
                            // Add auto/manual class
                            if (shift.source === 'auto') {
                                blockClass += ' shift-auto';
                            } else {
                                blockClass += ' shift-manual';
                            }
                            // Absent conflict has highest priority
                            if (isAbsent) {
                                blockClass += ' absent-conflict';
                            } else if (!validation.isValid) {
                                blockClass += ' error';
                            } else if (validation.hasWarnings) {
                                blockClass += ' warning';
                            }
                            if (isOvernight) blockClass += ' nacht';

                            // Build title with absence/error/warning info
                            let titleText = `${shift.startTime} - ${shift.endTime}`;
                            if (isOvernight) {
                                titleText += ' (nachtdienst)';
                            }
                            if (isAbsent) {
                                const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig' };
                                titleText = `CONFLICT: ${absenceLabels[availability.type] || 'Afwezig'}\n${titleText}`;
                            }
                            if (!validation.isValid && validation.errors.length > 0) {
                                titleText += `\n${validation.errors.map(e => e.message).join('\n')}`;
                            }
                            if (validation.hasWarnings && validation.warnings.length > 0) {
                                titleText += `\n${validation.warnings.map(w => w.message).join('\n')}`;
                            }

                            // Width kan een getal of een calc() string zijn
                            const widthStyle = typeof widthPercent === 'string' ? widthPercent : `${widthPercent}%`;

                            // Escape quotes voor data-tooltip
                            const tooltipText = escapeHtml(titleText);

                            // Only make shift clickable if user can edit it
                            const canEdit = canUserEditShift(shift);
                            // Remove inline onclick - handled by DragHandler
                            const cursorStyle = canEdit ? 'cursor: grab;' : 'cursor: default;';

                            // Render activity chips inside the block
                            const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
                            let actChips = '';
                            shiftActivities.forEach(act => {
                                const lbl = ACTIVITY_TYPE_LABELS_SHORT[act.type] || act.type;
                                const t = `${act.startTime.substring(0,5)}-${act.endTime.substring(0,5)}`;
                                actChips += `<span class="activity-chip activity-type-${escapeHtml(act.type)}" data-activity-id="${act.id}" title="${escapeHtml(act.description || lbl)} (${t})">${escapeHtml(lbl)}</span>`;
                            });

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
                                ${actChips ? `<div class="activity-chips-row">${actChips}</div>` : ''}
                                ${canEdit ? '<div class="resize-handle resize-handle-end"></div>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });
        });

        // Render employees without a team (if any)
        const noTeamEmployees = employeesByTeam['_no_team'];
        if (noTeamEmployees && noTeamEmployees.length > 0) {
            // Team header row for "No Team"
            html += `<div class="timeline-team-header team-no-team">
                <div class="team-header-name">Geen Team</div>
                <div class="team-header-count">${noTeamEmployees.length} medewerker${noTeamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            // Employee rows for no-team employees
            noTeamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="timeline-row ${isAlt ? 'alt' : ''}">`;

                const isResponsible = responsible && String(responsible.id) === String(emp.id);
                const responsibleBadge = isResponsible ? `<span class="responsible-badge">${IconHelper.html(ICONS.star, 'xs')}</span>` : '';
                const responsibleClass = isResponsible ? ' is-responsible' : '';
                const responsibleTooltip = isResponsible ? 'data-tooltip="Weekendverantwoordelijke" data-tooltip-pos="right"' : '';

                const employeeName = escapeHtml(emp.name);
                html += `<div class="timeline-employee-cell${responsibleClass}" ${responsibleTooltip}>
                    ${responsibleBadge}<span class="emp-name">${employeeName}</span>
                </div>`;

                weekDates.forEach(date => {
                    const d = parseDateOnly(date);
                    const dayOfWeek = d.getDay();
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    const isClosed = isDayClosed(date);

                    let cellClass = 'timeline-day-cell';
                    if (isWeekend) cellClass += ' weekend';
                    if (isClosed) cellClass += ' closed';

                    // Check if there are shifts for this cell (to add has-shifts class)
                    if (!isClosed) {
                        let shiftsCheck = getShiftsByEmployee(emp.id, date, date);
                        shiftsCheck = shiftsCheck.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
                        if (shiftsCheck.length > 0) cellClass += ' has-shifts';
                    }

                    html += `<div class="${cellClass}" data-date="${date}">`;

                    if (!isClosed) {
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                        const isDayView = AppState.viewMode === 'day';

                        // In day view: also show overnight shifts from previous day (continuation)
                        if (isDayView) {
                            html += renderOvernightContinuation(emp.id, date, START_HOUR, TOTAL_HOURS);
                        }

                        // Render shifts that start on this day
                        shifts.forEach(shift => {
                            const validation = validateShift(shift, shift.id);
                            const availability = getAvailability(shift.employeeId, date);

                            // Check if employee is absent - this is a conflict!
                            const validAbsenceTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
                            const isAbsent = availability && availability.type && validAbsenceTypes.includes(availability.type);

                            const [startHour, startMin] = shift.startTime.split(':').map(Number);
                            const [endHour, endMin] = shift.endTime.split(':').map(Number);

                            // Check if this is an overnight shift
                            const isOvernight = endHour < startHour;

                            // Calculate position and width
                            const startFrac = startHour + startMin / 60;
                            const leftPercent = Math.max(0, ((startFrac - START_HOUR) / TOTAL_HOURS) * 100);

                            let widthPercent;
                            if (isOvernight) {
                                // Nachtdienst: bereken totale breedte over beide dagen
                                const hoursDay1 = END_HOUR - startFrac; // van start tot 24:00
                                const hoursDay2 = Math.max(0, (endHour + endMin / 60) - START_HOUR); // van 7:00 tot eind

                                // Clip to own cell in day view or on Sunday
                                if (dayOfWeek === 0 || isDayView) {
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    widthPercent = `${widthDay1Percent}%`;
                                } else {
                                    // Other days: show full overnight shift spanning two day cells
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;
                                    widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                                }
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
                            }

                            let blockClass = `timeline-block team-${shift.team}`;
                            // Add auto/manual class
                            if (shift.source === 'auto') {
                                blockClass += ' shift-auto';
                            } else {
                                blockClass += ' shift-manual';
                            }
                            // Absent conflict has highest priority
                            if (isAbsent) {
                                blockClass += ' absent-conflict';
                            } else if (!validation.isValid) {
                                blockClass += ' error';
                            } else if (validation.hasWarnings) {
                                blockClass += ' warning';
                            }
                            if (isOvernight) blockClass += ' nacht';

                            // Build title with absence/error/warning info
                            let titleText = `${shift.startTime} - ${shift.endTime}`;
                            if (isOvernight) {
                                titleText += ' (nachtdienst)';
                            }
                            if (isAbsent) {
                                const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig' };
                                titleText = `CONFLICT: ${absenceLabels[availability.type] || 'Afwezig'}\n${titleText}`;
                            }
                            if (!validation.isValid && validation.errors.length > 0) {
                                titleText += `\n${validation.errors.map(e => e.message).join('\n')}`;
                            }
                            if (validation.hasWarnings && validation.warnings.length > 0) {
                                titleText += `\n${validation.warnings.map(w => w.message).join('\n')}`;
                            }

                            // Width kan een getal of een calc() string zijn
                            const widthStyle = typeof widthPercent === 'string' ? widthPercent : `${widthPercent}%`;

                            // Escape quotes voor data-tooltip
                            const tooltipText = escapeHtml(titleText);

                            // Only make shift clickable if user can edit it
                            const canEdit = canUserEditShift(shift);
                            const cursorStyle = canEdit ? 'cursor: grab;' : 'cursor: default;';

                            // Render activity chips inside the block
                            const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
                            let actChips = '';
                            shiftActivities.forEach(act => {
                                const lbl = ACTIVITY_TYPE_LABELS_SHORT[act.type] || act.type;
                                const t = `${act.startTime.substring(0,5)}-${act.endTime.substring(0,5)}`;
                                actChips += `<span class="activity-chip activity-type-${escapeHtml(act.type)}" data-activity-id="${act.id}" title="${escapeHtml(act.description || lbl)} (${t})">${escapeHtml(lbl)}</span>`;
                            });

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
                                ${actChips ? `<div class="activity-chips-row">${actChips}</div>` : ''}
                                ${canEdit ? '<div class="resize-handle resize-handle-end"></div>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });
        }
    }

    html += '</div>'; // Close body
    html += '</div>'; // Close wrapper

    DOM.rosterCalendar.innerHTML = html;
    IconHelper.init(DOM.rosterCalendar);

    // Set team-header sticky offset based on actual header height
    const header = DOM.rosterCalendar.querySelector('.timeline-header');
    if (header) {
        const headerHeight = header.offsetHeight;
        DOM.rosterCalendar.querySelectorAll('.timeline-team-header').forEach(th => {
            th.style.top = (headerHeight - 1) + 'px';
        });
    }

    // Initialize drag & drop handlers
    if (typeof DragHandler !== 'undefined') {
        DragHandler.init();
    }
}

function renderMonthView() {
    const monthStart = AppState.currentMonthStart || getMonthStart(new Date());
    const weeks = getMonthWeeks(monthStart);
    const allDates = getMonthDates(monthStart);

    // Get all shifts this month (filtered by visible teams)
    let allShifts = [];
    allDates.forEach(date => {
        let shifts = getShiftsByDate(date);
        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
        allShifts = allShifts.concat(shifts);
    });

    // Get employees: those with shifts + all active employees in visible teams
    const employeeIdsWithShifts = new Set(allShifts.map(s => s.employeeId));
    const activeEmployees = getAllEmployees(true).filter(emp =>
        emp.mainTeam && AppState.visibleTeams.includes(emp.mainTeam)
    );
    const employeeMap = new Map();
    activeEmployees.forEach(emp => employeeMap.set(emp.id, emp));
    employeeIdsWithShifts.forEach(id => {
        if (!employeeMap.has(id)) {
            const emp = getEmployee(id);
            if (emp) employeeMap.set(id, emp);
        }
    });
    let employees = [...employeeMap.values()];

    // Group by team (reuse logic from renderTimelineView)
    const teams = DataStore.settings.teams || {};
    const teamOrder = getTeamOrder()
        .filter(t => AppState.visibleTeams.includes(t));
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    });

    // Employees without team
    const employeesWithoutTeam = employees
        .filter(emp => !emp.mainTeam || !teamOrder.includes(emp.mainTeam))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    if (employeesWithoutTeam.length > 0) {
        employeesByTeam['_no_team'] = employeesWithoutTeam;
    }

    let html = '<div class="month-view-wrapper">';

    // Header: week rows with dates
    html += '<div class="month-header">';
    html += '<div class="month-name-header">Medewerker</div>';

    weeks.forEach((weekStart) => {
        const weekDates = getWeekDates(weekStart);
        html += '<div class="month-week-header">';

        weekDates.forEach(date => {
            const d = parseDateOnly(date);
            const dayOfWeek = d.getDay();
            const dayNames = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
            const dayName = dayNames[dayOfWeek];
            const dayNum = d.getDate();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isClosed = isDayClosed(date);
            const isHoliday = isHolidayPeriod(date);

            // Highlight dates outside current month
            const currentMonth = monthStart.getMonth();
            const isCurrentMonth = d.getMonth() === currentMonth;

            let headerClass = 'month-day-header';
            if (isWeekend) headerClass += ' weekend';
            if (isClosed) headerClass += ' closed';
            if (isHoliday) headerClass += ' holiday';
            if (!isCurrentMonth) headerClass += ' other-month';

            html += `<div class="${headerClass}">
                <span class="day-name">${dayName}</span>
                <span class="day-num">${dayNum}</span>
            </div>`;
        });

        html += '</div>'; // month-week-header
    });
    html += '</div>'; // month-header

    // Body: employee rows with shift badges
    html += '<div class="month-body">';

    if (employees.length === 0) {
        html += '<div class="empty-state"><p>Geen shifts gepland voor deze periode.</p><small>Pas een concept toe of voeg shifts handmatig toe.</small></div>';
    } else {
        teamOrder.forEach(teamKey => {
            const teamEmployees = employeesByTeam[teamKey];
            if (!teamEmployees || teamEmployees.length === 0) return;

            const team = teams[teamKey] || { name: teamKey };
            const teamName = escapeHtml(team.name);

            // Team header
            html += `<div class="month-team-header team-${teamKey}">
                <div class="team-header-name">${teamName}</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            // Employee rows
            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="month-row ${isAlt ? 'alt' : ''}">`;

                const employeeName = escapeHtml(emp.name);
                html += `<div class="month-employee-cell">
                    <span class="emp-name">${employeeName}</span>
                </div>`;

                // Week columns
                weeks.forEach(weekStart => {
                    const weekDates = getWeekDates(weekStart);
                    html += '<div class="month-week-cells">';

                    weekDates.forEach(date => {
                        const d = parseDateOnly(date);
                        const dayOfWeek = d.getDay();
                        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                        const isClosed = isDayClosed(date);
                        const isCurrentMonth = d.getMonth() === monthStart.getMonth();

                        let cellClass = 'month-day-cell';
                        if (isWeekend) cellClass += ' weekend';
                        if (isClosed) cellClass += ' closed';
                        if (!isCurrentMonth) cellClass += ' other-month';

                        html += `<div class="${cellClass}" data-date="${date}" data-employee="${emp.id}">`;

                        if (!isClosed) {
                            let shifts = getShiftsByEmployee(emp.id, date, date);
                            shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                            const maxVisible = 3;
                            const visibleShifts = shifts.slice(0, maxVisible);
                            const hiddenCount = Math.max(0, shifts.length - maxVisible);

                            visibleShifts.forEach(shift => {
                                const timeStr = `${shift.startTime.substring(0, 5)}-${shift.endTime.substring(0, 5)}`;
                                const validation = validateShift(shift, shift.id);
                                const hasErrors = validation.errors.length > 0;
                                const hasWarnings = validation.warnings.length > 0;

                                let badgeClass = `month-shift-badge team-${shift.team}`;
                                if (hasErrors) badgeClass += ' has-error';
                                else if (hasWarnings) badgeClass += ' has-warning';

                                const canEdit = canUserEditShift(shift);
                                const onClick = canEdit ? `onclick="openEditShiftModal('${shift.id}')"` : '';

                                const shiftTeam = teams[shift.team];
                                const teamNameText = shiftTeam ? shiftTeam.name : shift.team;
                                const tooltipText = `${timeStr}\\n${teamNameText}${shift.notes ? '\\n' + shift.notes : ''}`;

                                html += `<div class="${badgeClass}" ${onClick} title="${escapeHtml(tooltipText)}">${timeStr}</div>`;
                            });

                            if (hiddenCount > 0) {
                                html += `<div class="month-shift-more">+${hiddenCount}</div>`;
                            }
                        }

                        html += '</div>'; // month-day-cell
                    });

                    html += '</div>'; // month-week-cells
                });

                html += '</div>'; // month-row
            });
        });

        // Handle employees without team
        if (employeesByTeam['_no_team']) {
            const teamEmployees = employeesByTeam['_no_team'];
            html += `<div class="month-team-header">
                <div class="team-header-name">Geen team</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="month-row ${isAlt ? 'alt' : ''}">`;

                const employeeName = escapeHtml(emp.name);
                html += `<div class="month-employee-cell">
                    <span class="emp-name">${employeeName}</span>
                </div>`;

                weeks.forEach(weekStart => {
                    const weekDates = getWeekDates(weekStart);
                    html += '<div class="month-week-cells">';

                    weekDates.forEach(date => {
                        const d = parseDateOnly(date);
                        const dayOfWeek = d.getDay();
                        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                        const isClosed = isDayClosed(date);
                        const isCurrentMonth = d.getMonth() === monthStart.getMonth();

                        let cellClass = 'month-day-cell';
                        if (isWeekend) cellClass += ' weekend';
                        if (isClosed) cellClass += ' closed';
                        if (!isCurrentMonth) cellClass += ' other-month';

                        html += `<div class="${cellClass}">`;

                        if (!isClosed) {
                            let shifts = getShiftsByEmployee(emp.id, date, date);
                            shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                            const maxVisible = 3;
                            const visibleShifts = shifts.slice(0, maxVisible);
                            const hiddenCount = Math.max(0, shifts.length - maxVisible);

                            visibleShifts.forEach(shift => {
                                const timeStr = `${shift.startTime.substring(0, 5)}-${shift.endTime.substring(0, 5)}`;
                                const validation = validateShift(shift, shift.id);
                                const hasErrors = validation.errors.length > 0;
                                const hasWarnings = validation.warnings.length > 0;

                                let badgeClass = `month-shift-badge team-${shift.team}`;
                                if (hasErrors) badgeClass += ' has-error';
                                else if (hasWarnings) badgeClass += ' has-warning';

                                const canEdit = canUserEditShift(shift);
                                const onClick = canEdit ? `onclick="openEditShiftModal('${shift.id}')"` : '';

                                const shiftTeam = teams[shift.team];
                                const teamNameText = shiftTeam ? shiftTeam.name : shift.team;
                                const tooltipText = `${timeStr}\\n${teamNameText}${shift.notes ? '\\n' + shift.notes : ''}`;

                                html += `<div class="${badgeClass}" ${onClick} title="${escapeHtml(tooltipText)}">${timeStr}</div>`;
                            });

                            if (hiddenCount > 0) {
                                html += `<div class="month-shift-more">+${hiddenCount}</div>`;
                            }
                        }

                        html += '</div>';
                    });

                    html += '</div>';
                });

                html += '</div>';
            });
        }
    }

    html += '</div>'; // month-body
    html += '</div>'; // month-view-wrapper

    DOM.rosterCalendar.innerHTML = html;
    IconHelper.init(DOM.rosterCalendar);
}

function getShiftsForDateAndTimeSlot(date, slotStart, slotEnd) {
    let shifts = getShiftsByDate(date);
    // Filter by visible teams (include shifts without team)
    shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
    shifts = shifts.filter(shift => {
        const [startHour] = shift.startTime.split(':').map(Number);
        const [endHour] = shift.endTime.split(':').map(Number);
        if (endHour < startHour) {
            return slotStart >= 23 || slotEnd <= 9;
        }
        return startHour >= slotStart && startHour < slotEnd;
    });
    return shifts;
}

// Calculate columns for overlapping shifts
function calculateShiftColumns(shifts) {
    const columns = new Map();

    // Sort shifts by start time
    const sortedShifts = [...shifts].sort((a, b) => {
        const [aHour, aMin] = a.startTime.split(':').map(Number);
        const [bHour, bMin] = b.startTime.split(':').map(Number);
        return (aHour * 60 + aMin) - (bHour * 60 + bMin);
    });

    // Track which columns are occupied at each time
    const columnTracks = [];

    sortedShifts.forEach(shift => {
        const [startHour, startMin] = shift.startTime.split(':').map(Number);
        const [endHour, endMin] = shift.endTime.split(':').map(Number);

        const startMinutes = startHour * 60 + startMin;
        const endMinutes = (endHour < startHour ? (endHour + 24) * 60 : endHour * 60) + endMin;

        // Find first available column
        let column = 0;
        let placed = false;

        while (!placed) {
            if (!columnTracks[column]) {
                columnTracks[column] = [];
            }

            // Check if this column is free during shift time
            const hasConflict = columnTracks[column].some(track => {
                return !(endMinutes <= track.start || startMinutes >= track.end);
            });

            if (!hasConflict) {
                // Place shift in this column
                columnTracks[column].push({ start: startMinutes, end: endMinutes });
                columns.set(shift.id, { column, totalColumns: 0 }); // Will update totalColumns later
                placed = true;
            } else {
                column++;
            }
        }
    });

    // Update total columns for each shift
    const totalColumns = columnTracks.length;
    columns.forEach(info => {
        info.totalColumns = totalColumns;
    });

    return columns;
}

// renderShiftBlock removed — was dead code (never called, timeline renders inline in renderTimelineView)

// Keep old function for backwards compatibility if needed elsewhere
function renderShiftCard(shift) {
    const employee = getEmployee(shift.employeeId);
    if (!employee) return '';
    const validation = validateShift(shift, shift.id);
    const availability = getAvailability(shift.employeeId, shift.date);

    let cardClass = `shift-card team-${shift.team}`;
    if (!validation.isValid) {
        cardClass += ' shift-error';
    } else if (validation.hasWarnings) {
        cardClass += ' shift-warning';
    }

    const [startHour] = shift.startTime.split(':').map(Number);
    const [endHour] = shift.endTime.split(':').map(Number);
    if (endHour < startHour) {
        cardClass += ' shift-nacht';
    }

    // Check availability indicator
    let availabilityIcon = '';
    if (availability && !availability.available) {
        const reason = escapeHtml(availability.reason || 'Geen reden opgegeven');
        availabilityIcon = `<span class="shift-availability-indicator unavailable" title="Medewerker niet beschikbaar: ${reason}">${IconHelper.html(ICONS.warning, 'xs')}</span>`;
    } else if (availability && availability.shiftTypes && availability.shiftTypes.length > 0) {
        // Check if shift matches availability
        let shiftType = null;
        if (startHour >= 7 && startHour < 16) shiftType = 'vroeg';
        else if (startHour >= 16 && startHour < 23) shiftType = 'laat';
        else if (startHour >= 23 || startHour < 9) shiftType = 'nacht';

        if (shiftType && !availability.shiftTypes.includes(shiftType)) {
            const shiftTypes = escapeHtml(availability.shiftTypes.join(', '));
            availabilityIcon = `<span class="shift-availability-indicator partial" title="Alleen beschikbaar voor: ${shiftTypes}">${IconHelper.html(ICONS.zap, 'xs')}</span>`;
        }
    }

    // Activity count for card view
    const activities = getActivitiesByEmployee(shift.employeeId, shift.date);
    const activityBadge = activities.length > 0
        ? `<span class="activity-count-badge" title="${activities.map(a => a.type).join(', ')}">${IconHelper.html('calendar-plus', 'xs')} ${activities.length}</span>`
        : '';

    const employeeName = escapeHtml(employee.name);
    return `<div class="${cardClass}" data-shift-id="${shift.id}">
        <div class="shift-employee-name">${employeeName}${availabilityIcon}</div>
        <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
        <div class="shift-card-footer">
            <span class="shift-team-badge team-${shift.team}">${escapeHtml(DataStore.settings.teams[shift.team].name)}</span>
            ${activityBadge}
            ${hasPermission('MANAGE_SHIFTS') ? `<button class="shift-delete-btn" data-shift-id="${shift.id}">${IconHelper.html(ICONS.close, 'xs')}</button>` : ''}
        </div>
    </div>`;
}

function openAddShiftModal() {
    AppState.editingShiftId = null;
    DOM.shiftModalTitle.textContent = 'Dienst toevoegen';
    DOM.shiftForm.reset();
    DOM.shiftValidationErrors.innerHTML = '';
    DOM.shiftDate.value = formatDateYYYYMMDD(new Date());
    DOM.shiftDeleteBtn.style.display = 'none';

    // Populate dropdown with filtered employees
    populateEmployeeDropdown();

    // Auto-select current user for medewerkers and disable dropdown
    const currentRole = getEffectiveRole();
    if (currentRole === 'medewerker') {
        DOM.shiftEmployee.value = AppState.currentUser.id;
        DOM.shiftEmployee.disabled = true;
        DOM.shiftEmployee.classList.add('readonly');
    } else {
        DOM.shiftEmployee.disabled = false;
        DOM.shiftEmployee.classList.remove('readonly');
    }

    // Show submit button, hide delete button
    DOM.shiftSubmitBtn.style.display = 'inline-block';
    resetShiftSubmitBtn();

    DOM.shiftModal.classList.remove('hidden');
}

function openAddShiftForEmployee(employeeId, date) {
    AppState.editingShiftId = null;
    DOM.shiftModalTitle.textContent = 'Dienst toevoegen';
    DOM.shiftForm.reset();
    DOM.shiftValidationErrors.innerHTML = '';
    DOM.shiftDate.value = date;
    DOM.shiftDeleteBtn.style.display = 'none';
    populateEmployeeDropdown();
    DOM.shiftEmployee.value = employeeId;
    DOM.shiftModal.classList.remove('hidden');
}

function canUserEditShift(shift) {
    if (!shift || !AppState.currentUser) {
        return false;
    }

    const currentRole = getEffectiveRole();
    const currentUserId = AppState.currentUser.id;
    const isOwnShift = shift.employeeId === currentUserId || shift.userId === currentUserId;

    if (currentRole === 'admin' || currentRole === 'roosterverantwoordelijke') {
        return true;
    } else if (currentRole === 'medewerker') {
        return isOwnShift;
    }

    return false;
}

function canUserTransferShift(shift) {
    // Only admin and roosterverantwoordelijke can transfer shifts between employees
    if (!shift || !AppState.currentUser) {
        return false;
    }

    const currentRole = getEffectiveRole();

    if (currentRole === 'admin' || currentRole === 'roosterverantwoordelijke') {
        return true;
    }

    return false;
}

function openEditShiftModal(shiftId) {
    const shift = getShift(shiftId);
    if (!shift) return;

    const canEdit = canUserEditShift(shift);

    // Open modal in view or edit mode
    openShiftModal(shift, canEdit);
}

function openShiftModal(shift, canEdit) {
    AppState.editingShiftId = shift.id;

    // Set modal title
    DOM.shiftModalTitle.textContent = canEdit ? 'Dienst bewerken' : 'Dienst bekijken';

    // Populate employee dropdown
    populateEmployeeDropdown();

    // Fill form with shift data
    DOM.shiftEmployee.value = shift.employeeId;
    DOM.shiftTeam.value = shift.team;
    DOM.shiftDate.value = shift.date;
    DOM.shiftStart.value = shift.startTime;
    DOM.shiftEnd.value = shift.endTime;
    DOM.shiftNotes.value = shift.notes || '';

    // Disable/enable form fields based on permissions
    const formFields = [
        DOM.shiftEmployee,
        DOM.shiftTeam,
        DOM.shiftDate,
        DOM.shiftStart,
        DOM.shiftEnd,
        DOM.shiftNotes
    ];

    formFields.forEach(field => {
        if (canEdit) {
            field.disabled = false;
            field.classList.remove('readonly');
        } else {
            field.disabled = true;
            field.classList.add('readonly');
        }
    });

    // Show/hide action buttons
    DOM.shiftSubmitBtn.style.display = canEdit ? 'inline-block' : 'none';
    DOM.shiftDeleteBtn.style.display = canEdit ? 'block' : 'none';
    resetShiftSubmitBtn();

    // Add combined "Shift afstaan" button if user can request swap
    const existingAfstaanBtn = document.getElementById('shift-afstaan-btn');
    if (existingAfstaanBtn) existingAfstaanBtn.remove();

    if (canRequestSwap(shift)) {
        const afstaanBtn = document.createElement('button');
        afstaanBtn.type = 'button';
        afstaanBtn.id = 'shift-afstaan-btn';
        afstaanBtn.className = 'btn btn-primary';
        afstaanBtn.textContent = 'Shift afstaan';
        afstaanBtn.style.marginRight = 'auto';
        afstaanBtn.addEventListener('click', () => {
            closeShiftModal();
            openShiftAfstaanChoiceModal(shift);
        });

        // Insert before submit button
        const modalActions = DOM.shiftSubmitBtn.parentElement;
        modalActions.insertBefore(afstaanBtn, modalActions.firstChild);
    }

    // Show source info (auto vs manual)
    const isAutoShift = shift.source === 'auto';
    let sourceHtml = '';
    if (isAutoShift) {
        sourceHtml = `<div class="shift-source-info shift-source-auto">
            <span class="source-icon">${IconHelper.html(ICONS.zap, 'sm')}</span>
            <span class="source-text">Automatisch ingepland via basisrooster</span>
        </div>`;
    } else {
        sourceHtml = `<div class="shift-source-info shift-source-manual">
            <span class="source-icon">${IconHelper.html(ICONS.edit, 'sm')}</span>
            <span class="source-text">Handmatig aangepast (beschermd bij regeneratie)</span>
        </div>`;
    }

    // Show existing validation issues for this shift
    const validation = validateShift(shift, shift.id);
    const availability = getAvailability(shift.employeeId, shift.date);
    const isAbsent = availability && availability.type;

    // Show activities for this shift
    const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
    let activitiesListHtml = '';
    if (shiftActivities.length > 0 || canEdit) {
        activitiesListHtml = '<div class="shift-activities-section">';
        activitiesListHtml += `<div class="shift-activities-header"><strong>Activiteiten</strong>`;
        if (canEdit) {
            activitiesListHtml += ` <button type="button" class="btn btn-sm add-activity-btn" data-user-id="${shift.employeeId}" data-date="${shift.date}" data-shift-start="${shift.startTime}" data-shift-end="${shift.endTime}" style="opacity:1;position:static;width:auto;height:auto;">+ Toevoegen</button>`;
        }
        activitiesListHtml += '</div>';
        if (shiftActivities.length > 0) {
            activitiesListHtml += '<div class="shift-activities-list">';
            shiftActivities.forEach(act => {
                const label = ACTIVITY_TYPE_LABELS_FULL[act.type] || act.type;
                const desc = act.description ? ` - ${escapeHtml(act.description)}` : '';
                activitiesListHtml += `<div class="shift-activity-item activity-badge" data-activity-id="${act.id}" style="position:static;display:flex;cursor:pointer;padding:4px 8px;margin-bottom:4px;border-radius:4px;">
                    <span class="activity-type-${escapeHtml(act.type)}" style="display:inline-block;width:4px;border-radius:2px;margin-right:8px;flex-shrink:0;"></span>
                    <span><strong>${escapeHtml(label)}</strong> ${act.startTime.substring(0,5)}-${act.endTime.substring(0,5)}${desc}</span>
                </div>`;
            });
            activitiesListHtml += '</div>';
        }
        activitiesListHtml += '</div>';
    }

    let issuesHtml = sourceHtml + activitiesListHtml;
    if (isAbsent) {
        const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren opnemen', 'vorming': 'Vorming', 'andere': 'Afwezig' };
        const employeeName = escapeHtml(getEmployee(shift.employeeId)?.name || '');
        issuesHtml += `<div class="validation-warning absence">
            <strong>${IconHelper.html(ICONS.warning, 'sm')} Afwezigheid:</strong> ${employeeName} is afwezig (${absenceLabels[availability.type] || 'Afwezig'})
        </div>`;
    }
    if (!validation.isValid && validation.errors.length > 0) {
        issuesHtml += `<div class="validation-error">
            <strong>${IconHelper.html(ICONS.error, 'sm')} Fouten:</strong>
            <ul>${validation.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>
        </div>`;
    }
    if (validation.hasWarnings && validation.warnings.length > 0) {
        issuesHtml += `<div class="validation-warning">
            <strong>${IconHelper.html(ICONS.warning, 'sm')} Waarschuwingen:</strong>
            <ul>${validation.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>
        </div>`;
    }
    DOM.shiftValidationErrors.innerHTML = issuesHtml;
    IconHelper.init(DOM.shiftValidationErrors);

    DOM.shiftModal.classList.remove('hidden');
}

function resetShiftSubmitBtn() {
    DOM.shiftSubmitBtn.textContent = 'Opslaan';
    DOM.shiftSubmitBtn.classList.remove('btn-warning');
    DOM.shiftSubmitBtn.classList.add('btn-primary');
    AppState._shiftForceOverride = false;
}

function closeShiftModal() {
    DOM.shiftModal.classList.add('hidden');
    DOM.shiftForm.reset();
    AppState.editingShiftId = null;
    resetShiftSubmitBtn();
}

async function handleShiftDelete(shiftId = null) {
    // Check if shiftId is an event object (from modal button click) or a number (from inline button)
    const isEvent = shiftId && typeof shiftId === 'object' && 'target' in shiftId;

    // Use provided shiftId (if it's a number) or fall back to AppState.editingShiftId
    const idToDelete = (isEvent || !shiftId) ? AppState.editingShiftId : shiftId;
    if (!idToDelete) return;

    // Get shift details for confirmation message
    const shift = getShift(idToDelete);
    const shiftDescription = shift
        ? `de dienst van ${shift.employeeName || 'deze medewerker'} op ${shift.date}`
        : 'deze dienst';

    if (await showConfirm(`Weet je zeker dat je ${shiftDescription} wilt verwijderen?`, 'Dienst verwijderen', { danger: true, confirmText: 'Verwijderen' })) {
        // Wait for deletion to complete before re-rendering
        await deleteShift(idToDelete);

        // Close modal only if deleting from modal (when shiftId is event or null)
        if (isEvent || !shiftId) {
            closeShiftModal();
        }

        renderPlanning();
    }
}

// ===== SWAP REQUEST MODAL FUNCTIES =====

let swapRequestState = {
    requesterShift: null,
    targetEmployeeId: null,
    targetShiftId: null
};

function openSwapRequestModal(shift) {
    swapRequestState.requesterShift = shift;
    swapRequestState.targetEmployeeId = null;
    swapRequestState.targetShiftId = null;

    // Show requester shift preview
    const requesterPreview = document.getElementById('swap-requester-shift-preview');
    requesterPreview.innerHTML = formatShiftPreview(shift);

    // Clear target preview
    const targetPreview = document.getElementById('swap-target-shift-preview');
    targetPreview.innerHTML = '<p class="text-muted">Selecteer eerst een collega en shift</p>';

    // Populate employee dropdown (exclude current user)
    const employeeSelect = document.getElementById('swap-target-employee');
    let employees = getAllEmployees(true).filter(emp => emp.id !== shift.userId);
    let html = '<option value="">-- Selecteer collega --</option>';
    employees.forEach(emp => {
        html += `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`;
    });
    employeeSelect.innerHTML = html;

    // Reset target shift dropdown
    const shiftSelect = document.getElementById('swap-target-shift');
    shiftSelect.innerHTML = '<option value="">-- Selecteer eerst een collega --</option>';
    shiftSelect.disabled = true;

    // Clear message and validation
    document.getElementById('swap-message').value = '';
    document.getElementById('swap-validation-display').style.display = 'none';

    // Show modal
    document.getElementById('swap-request-modal').classList.remove('hidden');
}

function closeSwapRequestModal() {
    document.getElementById('swap-request-modal').classList.add('hidden');
    swapRequestState = { requesterShift: null, targetEmployeeId: null, targetShiftId: null };
}

function formatShiftPreview(shift) {
    const employee = getEmployee(shift.employeeId || shift.userId);
    const employeeName = employee ? escapeHtml(employee.name) : 'Onbekend';
    const team = escapeHtml(shift.team || shift.teamId || '');
    const date = formatDate(shift.date);
    const time = `${shift.startTime} - ${shift.endTime}`;

    return `
        <p><strong>Medewerker:</strong> ${employeeName}</p>
        <p><strong>Team:</strong> ${team}</p>
        <p><strong>Datum:</strong> ${date}</p>
        <p><strong>Tijd:</strong> ${time}</p>
        ${shift.notes ? `<p><strong>Notities:</strong> ${escapeHtml(shift.notes)}</p>` : ''}
    `;
}

async function handleSwapTargetEmployeeChange() {
    const employeeId = parseInt(document.getElementById('swap-target-employee').value);
    const shiftSelect = document.getElementById('swap-target-shift');

    if (!employeeId) {
        shiftSelect.innerHTML = '<option value="">-- Selecteer eerst een collega --</option>';
        shiftSelect.disabled = true;
        swapRequestState.targetEmployeeId = null;
        swapRequestState.targetShiftId = null;
        document.getElementById('swap-target-shift-preview').innerHTML = '<p class="text-muted">Selecteer eerst een collega en shift</p>';
        return;
    }

    swapRequestState.targetEmployeeId = employeeId;

    // Get shifts for this employee (future shifts only)
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const employeeShifts = DataStore.shifts
        .filter(s => s.userId === employeeId && new Date(s.date) >= now)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (employeeShifts.length === 0) {
        shiftSelect.innerHTML = '<option value="">Geen toekomstige shifts beschikbaar</option>';
        shiftSelect.disabled = true;
        return;
    }

    let html = '<option value="">-- Selecteer shift --</option>';
    employeeShifts.forEach(shift => {
        const dateStr = formatDate(shift.date);
        const timeStr = `${shift.startTime} - ${shift.endTime}`;
        html += `<option value="${shift.id}">${dateStr} | ${timeStr} | ${shift.team || shift.teamId}</option>`;
    });

    shiftSelect.innerHTML = html;
    shiftSelect.disabled = false;
}

function handleSwapTargetShiftChange() {
    const shiftId = parseInt(document.getElementById('swap-target-shift').value);

    if (!shiftId) {
        swapRequestState.targetShiftId = null;
        document.getElementById('swap-target-shift-preview').innerHTML = '<p class="text-muted">Selecteer een shift</p>';
        document.getElementById('swap-validation-display').style.display = 'none';
        return;
    }

    swapRequestState.targetShiftId = shiftId;
    const targetShift = getShift(shiftId);

    if (targetShift) {
        // Show target shift preview
        document.getElementById('swap-target-shift-preview').innerHTML = formatShiftPreview(targetShift);

        // Run validation
        runSwapValidation();
    }
}

function runSwapValidation() {
    if (!swapRequestState.requesterShift || !swapRequestState.targetShiftId) {
        return;
    }

    const requesterShift = swapRequestState.requesterShift;
    const targetShift = getShift(swapRequestState.targetShiftId);

    if (!targetShift) return;

    const validation = validateSwapRequest({
        requesterShift: requesterShift,
        targetShift: targetShift,
        requesterUserId: requesterShift.userId,
        targetUserId: targetShift.userId
    });

    const validationDisplay = document.getElementById('swap-validation-display');
    validationDisplay.style.display = 'block';
    validationDisplay.className = '';

    if (!validation.isValid) {
        validationDisplay.classList.add('has-errors');
        validationDisplay.innerHTML = `
            <div class="validation-errors">
                <strong>${IconHelper.html(ICONS.error, 'sm')} Fouten:</strong>
                <ul>${validation.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
            </div>
        `;
    } else if (validation.hasWarnings) {
        validationDisplay.classList.add('has-warnings');
        validationDisplay.innerHTML = `
            <div class="validation-warnings">
                <strong>${IconHelper.html(ICONS.warning, 'sm')} Waarschuwingen:</strong>
                <ul>${validation.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
            </div>
            <p style="margin-top: 0.5rem; color: #92400e;">Je kunt dit verzoek indienen, maar een verantwoordelijke moet het goedkeuren.</p>
        `;
    } else {
        validationDisplay.classList.add('is-valid');
        validationDisplay.innerHTML = `
            <div class="validation-success">
                <strong>${IconHelper.html(ICONS.success, 'sm')} Geen problemen gevonden</strong>
                <p class="mt-sm">Deze ruil kan worden ingediend voor goedkeuring.</p>
            </div>
        `;
    }
    IconHelper.init(validationDisplay);
}

async function handleSwapRequestSubmit() {
    if (!swapRequestState.requesterShift || !swapRequestState.targetShiftId) {
        showToast('Selecteer eerst een collega en een shift om te ruilen', 'warning');
        return;
    }

    // Get validation result
    const requesterShift = swapRequestState.requesterShift;
    const targetShift = getShift(swapRequestState.targetShiftId);

    const validation = validateSwapRequest({
        requesterShift: requesterShift,
        targetShift: targetShift,
        requesterUserId: requesterShift.userId,
        targetUserId: targetShift.userId
    });

    if (!validation.isValid) {
        showToast('Deze ruil kan niet worden ingediend vanwege fouten. Zie de validatie hierboven.', 'warning');
        return;
    }

    const message = document.getElementById('swap-message').value.trim();

    try {
        await createSwapRequest({
            requesterShiftId: requesterShift.id,
            targetShiftId: targetShift.id,
            message: message || null
        });

        showToast('Ruilverzoek succesvol ingediend', 'success');
        closeSwapRequestModal();

        // Switch to swaps view to show the new request
        switchView('swaps');
    } catch (error) {
        console.error('Error creating swap request:', error);
        showToast('Fout bij indienen ruilverzoek: ' + getUserFriendlyError(error), 'error');
    }
}

// ===== SWAP REVIEW MODAL FUNCTIES =====

let swapReviewState = {
    swapRequestId: null
};

function openSwapReviewModal(swapId) {
    const swapRequest = DataStore.swapRequests.find(sr => sr.id === swapId);

    if (!swapRequest) {
        showToast('Ruilverzoek niet gevonden', 'warning');
        return;
    }

    swapReviewState.swapRequestId = swapId;

    // Fill request info
    document.getElementById('swap-review-requester').textContent = swapRequest.requester_name;
    document.getElementById('swap-review-created').textContent = new Date(swapRequest.created_at).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Fill shift previews
    document.getElementById('swap-review-requester-name').textContent = swapRequest.requester_name;
    document.getElementById('swap-review-target-name').textContent = swapRequest.target_name;

    const requesterShift = {
        employeeId: swapRequest.requester_user_id,
        userId: swapRequest.requester_user_id,
        team: swapRequest.requester_shift_team,
        date: swapRequest.requester_shift_date,
        startTime: swapRequest.requester_shift_start,
        endTime: swapRequest.requester_shift_end
    };

    const targetShift = {
        employeeId: swapRequest.target_user_id,
        userId: swapRequest.target_user_id,
        team: swapRequest.target_shift_team,
        date: swapRequest.target_shift_date,
        startTime: swapRequest.target_shift_start,
        endTime: swapRequest.target_shift_end
    };

    document.getElementById('swap-review-requester-shift').innerHTML = formatShiftPreview(requesterShift);
    document.getElementById('swap-review-target-shift').innerHTML = formatShiftPreview(targetShift);

    // Show message if present
    const messageGroup = document.getElementById('swap-review-message-group');
    const messageDisplay = document.getElementById('swap-review-message');

    if (swapRequest.message) {
        messageGroup.style.display = 'block';
        messageDisplay.textContent = swapRequest.message;
    } else {
        messageGroup.style.display = 'none';
    }

    // Run validation
    const fullRequesterShift = getShift(swapRequest.requester_shift_id);
    const fullTargetShift = getShift(swapRequest.target_shift_id);

    if (fullRequesterShift && fullTargetShift) {
        const validation = validateSwapRequest({
            requesterShift: fullRequesterShift,
            targetShift: fullTargetShift,
            requesterUserId: swapRequest.requester_user_id,
            targetUserId: swapRequest.target_user_id
        });

        const validationDisplay = document.getElementById('swap-review-validation');

        if (!validation.isValid) {
            validationDisplay.className = 'has-errors';
            validationDisplay.innerHTML = `
                <div class="validation-errors">
                    <strong>${IconHelper.html(ICONS.error, 'sm')} Fouten:</strong>
                    <ul>${validation.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
                </div>
                <p style="margin-top: 0.5rem; color: #991b1b; font-weight: 500;">
                    Deze ruil kan niet worden goedgekeurd vanwege bovenstaande fouten.
                </p>
            `;
        } else if (validation.hasWarnings) {
            validationDisplay.className = 'has-warnings';
            validationDisplay.innerHTML = `
                <div class="validation-warnings">
                    <strong>${IconHelper.html(ICONS.warning, 'sm')} Waarschuwingen:</strong>
                    <ul>${validation.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
                </div>
                <p style="margin-top: 0.5rem; color: #92400e;">
                    Je kunt deze ruil goedkeuren ondanks de waarschuwingen.
                </p>
            `;
        } else {
            validationDisplay.className = 'is-valid';
            validationDisplay.innerHTML = `
                <div class="validation-success">
                    <strong>${IconHelper.html(ICONS.success, 'sm')} Geen problemen gevonden</strong>
                    <p class="mt-sm">Deze ruil kan veilig worden goedgekeurd.</p>
                </div>
            `;
        }
        IconHelper.init(validationDisplay);
    }

    // Clear response notes
    document.getElementById('swap-response-notes').value = '';
    document.getElementById('swap-response-notes-required').style.display = 'none';

    // Show modal
    document.getElementById('swap-review-modal').classList.remove('hidden');
}

function closeSwapReviewModal() {
    document.getElementById('swap-review-modal').classList.add('hidden');
    swapReviewState.swapRequestId = null;
}

async function handleSwapApprove() {
    if (!swapReviewState.swapRequestId) return;

    const responseNotes = document.getElementById('swap-response-notes').value.trim();

    if (!await showConfirm('Weet je zeker dat je deze ruil wilt goedkeuren?')) {
        return;
    }

    showSectionLoading('swaps-view', 'Ruil verwerken...');
    try {
        await approveSwapRequest(swapReviewState.swapRequestId, responseNotes || null);
        showToast('Ruil goedgekeurd en uitgevoerd', 'success');
        closeSwapReviewModal();
        renderSwaps();
        renderPlanning(); // Refresh planning view to show swapped shifts
    } catch (error) {
        console.error('Error approving swap:', error);
        showToast('Fout bij goedkeuren: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('swaps-view');
    }
}

async function handleSwapReject() {
    if (!swapReviewState.swapRequestId) return;

    const responseNotes = document.getElementById('swap-response-notes').value.trim();

    if (!responseNotes) {
        showToast('Voeg een reden toe bij afwijzing', 'warning');
        document.getElementById('swap-response-notes-required').style.display = 'inline';
        return;
    }

    if (!await showConfirm('Weet je zeker dat je deze ruil wilt afwijzen?')) {
        return;
    }

    showSectionLoading('swaps-view', 'Ruil verwerken...');
    try {
        await rejectSwapRequest(swapReviewState.swapRequestId, responseNotes);
        showToast('Ruil afgewezen', 'success');
        closeSwapReviewModal();
        renderSwaps();
    } catch (error) {
        console.error('Error rejecting swap:', error);
        showToast('Fout bij afwijzen: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('swaps-view');
    }
}

// ===== SHIFT AFSTAAN CHOICE MODAL FUNCTIES =====

let shiftAfstaanChoiceState = {
    shift: null
};

function openShiftAfstaanChoiceModal(shift) {
    shiftAfstaanChoiceState.shift = shift;
    document.getElementById('shift-afstaan-choice-modal').classList.remove('hidden');

    // Add click handlers for the choice buttons
    document.getElementById('choice-swap-btn').onclick = () => {
        closeShiftAfstaanChoiceModal();
        openSwapRequestModal(shift);
    };

    document.getElementById('choice-takeover-btn').onclick = () => {
        closeShiftAfstaanChoiceModal();
        openTakeoverRequestModal(shift);
    };
}

function closeShiftAfstaanChoiceModal() {
    document.getElementById('shift-afstaan-choice-modal').classList.add('hidden');
    shiftAfstaanChoiceState.shift = null;
}

// ===== TAKEOVER REQUEST MODAL FUNCTIES =====

let takeoverRequestState = {
    shiftToGiveAway: null
};

function openTakeoverRequestModal(shift) {
    takeoverRequestState.shiftToGiveAway = shift;

    // Get team name
    const teamName = shift.team && DataStore.settings.teams?.[shift.team]
        ? DataStore.settings.teams[shift.team].name
        : shift.team || 'Onbekend team';

    // Show shift preview
    const previewHtml = `
        <div class="shift-card">
            <div class="shift-card-header">
                <span class="shift-team">${escapeHtml(teamName)}</span>
                <span class="shift-date">${formatDate(shift.date)}</span>
            </div>
            <div class="shift-card-body">
                <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
                ${shift.notes ? `<div class="shift-notes">${escapeHtml(shift.notes)}</div>` : ''}
            </div>
        </div>
    `;
    document.getElementById('takeover-shift-preview').innerHTML = previewHtml;

    // Clear message
    document.getElementById('takeover-message').value = '';

    // Show modal
    document.getElementById('takeover-request-modal').classList.remove('hidden');
}

function closeTakeoverRequestModal() {
    document.getElementById('takeover-request-modal').classList.add('hidden');
    takeoverRequestState.shiftToGiveAway = null;
}

async function handleTakeoverRequestSubmit() {
    if (!takeoverRequestState.shiftToGiveAway) {
        showToast('Geen shift geselecteerd', 'warning');
        return;
    }

    const message = document.getElementById('takeover-message').value.trim();

    try {
        await createTakeoverRequest(takeoverRequestState.shiftToGiveAway.id, message || null);
        showToast('Verzoek succesvol ingediend! Collega\'s kunnen deze shift nu overnemen.', 'success');
        closeTakeoverRequestModal();

        // Switch to swaps view to show the new request
        switchView('swaps');
    } catch (error) {
        console.error('Error creating takeover request:', error);
        showToast('Fout bij indienen verzoek: ' + getUserFriendlyError(error), 'error');
    }
}

function populateEmployeeDropdown() {
    const currentRole = getEffectiveRole();
    const currentUserId = AppState.currentUser.id;
    const currentUserTeam = AppState.currentUser.team_id || AppState.currentUser.mainTeam;

    let employees = getAllEmployees(true);

    // Filter based on role
    if (currentRole === 'medewerker') {
        // Medewerkers can only create shifts for themselves
        employees = employees.filter(emp => emp.id === currentUserId);
    }
    // Admin and roosterverantwoordelijke see everyone (no filter)

    let html = '<option value="">-- Selecteer medewerker --</option>';
    employees.forEach(emp => {
        html += `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`;
    });
    DOM.shiftEmployee.innerHTML = html;
}

function handleShiftTemplateChange() {
    const template = DOM.shiftTemplate.value;
    if (template && template !== 'custom' && DataStore.settings.shiftTemplates[template]) {
        const t = DataStore.settings.shiftTemplates[template];
        DOM.shiftStart.value = t.start;
        DOM.shiftEnd.value = t.end;
    }
}

async function handleShiftSubmit(e) {
    e.preventDefault();
    console.log('Shift submit clicked');

    // Check required fields
    if (!DOM.shiftEmployee.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Selecteer een medewerker</li></ul>';
        return;
    }
    if (!DOM.shiftTeam.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Selecteer een team</li></ul>';
        return;
    }
    if (!DOM.shiftDate.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Selecteer een datum</li></ul>';
        return;
    }
    if (!DOM.shiftStart.value || !DOM.shiftEnd.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Vul start- en eindtijd in</li></ul>';
        return;
    }
    if (DOM.shiftStart.value === DOM.shiftEnd.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Begintijd en eindtijd mogen niet gelijk zijn</li></ul>';
        return;
    }

    const shiftData = {
        employeeId: parseFloat(DOM.shiftEmployee.value),
        team: DOM.shiftTeam.value,
        date: DOM.shiftDate.value,
        startTime: DOM.shiftStart.value,
        endTime: DOM.shiftEnd.value,
        notes: DOM.shiftNotes.value
    };

    console.log('Shift data:', shiftData);

    try {
        const validation = validateShift(shiftData, AppState.editingShiftId);
        console.log('Validation result:', validation);

        if (!validation.isValid || validation.hasWarnings) {
            // If user already confirmed (flag set), skip validation and proceed
            if (AppState._shiftForceOverride) {
                AppState._shiftForceOverride = false;
                // Fall through to save
            } else {
                // Combine errors and warnings into one overview
                let html = '<div class="conflict-resolution">';

                // Show errors
                validation.errors.forEach(error => {
                    const suggestions = generateSuggestions(error, shiftData);
                    html += `<div class="conflict-item">
                        <div class="conflict-error">${escapeHtml(error.message)}</div>`;
                    if (suggestions.length > 0) {
                        html += '<div class="conflict-suggestions"><span class="suggestions-label">Suggesties:</span>';
                        suggestions.forEach(s => {
                            html += `<button type="button" class="btn btn-sm suggestion-btn"
                                data-field="${escapeHtml(s.field)}"
                                data-value="${s.value !== null ? escapeHtml(String(s.value)) : ''}"
                                ${s.action ? `data-action="${escapeHtml(s.action)}"` : ''}
                                onclick="applySuggestion(this)">${escapeHtml(s.label)}</button>`;
                        });
                        html += '</div>';
                    }
                    html += '</div>';
                });

                // Show warnings
                validation.warnings.forEach(warning => {
                    html += `<div class="conflict-item">
                        <div class="conflict-warning">${escapeHtml(warning.message)}</div>
                    </div>`;
                });

                html += '</div>';
                DOM.shiftValidationErrors.innerHTML = html;
                IconHelper.init(DOM.shiftValidationErrors);

                // Change submit button to indicate override
                DOM.shiftSubmitBtn.textContent = 'Toch opslaan';
                DOM.shiftSubmitBtn.classList.remove('btn-primary');
                DOM.shiftSubmitBtn.classList.add('btn-warning');
                AppState._shiftForceOverride = true;
                return;
            }
        }

        showSectionLoading('planning-view', 'Dienst opslaan...');
        try {
            if (AppState.editingShiftId) {
                const oldShift = getShift(AppState.editingShiftId);
                const previousData = oldShift ? { employeeId: oldShift.employeeId, team: oldShift.team, date: oldShift.date, startTime: oldShift.startTime, endTime: oldShift.endTime, notes: oldShift.notes } : null;
                await updateShift(AppState.editingShiftId, shiftData);
                UndoManager.push({ type: 'update', shiftId: AppState.editingShiftId, shiftData: { ...shiftData }, previousData });
            } else {
                const newShift = await addShift(shiftData);
                UndoManager.push({ type: 'create', shiftData: { ...shiftData }, resultId: newShift.id });
            }

            closeShiftModal();
            renderPlanning();
        } finally {
            hideSectionLoading('planning-view');
        }
    } catch (error) {
        console.error('Error in handleShiftSubmit:', error);
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Er is een fout opgetreden: ' + getUserFriendlyError(error) + '</li></ul>';
    }
}

function applySuggestion(btn) {
    const field = btn.dataset.field;
    const value = btn.dataset.value;
    const action = btn.dataset.action;

    if (action === 'focus-employee') {
        DOM.shiftEmployee.focus();
        return;
    }

    const fieldMap = {
        startTime: DOM.shiftStart,
        endTime: DOM.shiftEnd,
        date: DOM.shiftDate,
        team: DOM.shiftTeam,
        employeeId: DOM.shiftEmployee
    };

    const el = fieldMap[field];
    if (el && value) {
        el.value = value;
        el.classList.add('suggestion-applied');
        setTimeout(() => el.classList.remove('suggestion-applied'), 1500);
    }

    DOM.shiftValidationErrors.innerHTML = '';
    resetShiftSubmitBtn();
    showToast('Suggestie toegepast - controleer en klik Opslaan', 'info');
}

// ===== ACTIVITY MODAL =====

function openAddActivityModal(userId, date, shiftStart, shiftEnd) {
    document.getElementById('activity-modal-title').textContent = 'Activiteit toevoegen';
    document.getElementById('activity-id').value = '';
    document.getElementById('activity-user-id').value = userId;
    document.getElementById('activity-date').value = date;
    document.getElementById('activity-shift-start').value = shiftStart || '';
    document.getElementById('activity-shift-end').value = shiftEnd || '';
    document.getElementById('activity-type').value = '';
    document.getElementById('activity-start').value = '';
    document.getElementById('activity-end').value = '';
    document.getElementById('activity-description').value = '';
    document.getElementById('activity-delete-btn').style.display = 'none';
    document.getElementById('activity-modal').classList.remove('hidden');
    IconHelper.init(document.getElementById('activity-modal'));
}

function openEditActivityModal(activityId) {
    const activity = DataStore.activities.find(a => a.id === activityId);
    if (!activity) return;

    // Find the shift for this activity to get shift hours
    const shift = DataStore.shifts.find(s =>
        String(s.employeeId) === String(activity.userId) && s.date === activity.date
    );
    document.getElementById('activity-modal-title').textContent = 'Activiteit bewerken';
    document.getElementById('activity-id').value = activity.id;
    document.getElementById('activity-user-id').value = activity.userId;
    document.getElementById('activity-date').value = activity.date;
    document.getElementById('activity-shift-start').value = shift ? shift.startTime : '';
    document.getElementById('activity-shift-end').value = shift ? shift.endTime : '';
    document.getElementById('activity-type').value = activity.type;
    document.getElementById('activity-start').value = activity.startTime;
    document.getElementById('activity-end').value = activity.endTime;
    document.getElementById('activity-description').value = activity.description || '';
    document.getElementById('activity-delete-btn').style.display = '';
    document.getElementById('activity-modal').classList.remove('hidden');
    IconHelper.init(document.getElementById('activity-modal'));
}

function closeActivityModal() {
    document.getElementById('activity-modal').classList.add('hidden');
}

async function handleActivitySubmit(e) {
    e.preventDefault();
    const id = document.getElementById('activity-id').value;
    const userId = document.getElementById('activity-user-id').value;
    const date = document.getElementById('activity-date').value;
    const type = document.getElementById('activity-type').value;
    const startTime = document.getElementById('activity-start').value;
    const endTime = document.getElementById('activity-end').value;
    const description = document.getElementById('activity-description').value;

    if (!type || !startTime || !endTime) {
        showToast('Vul alle verplichte velden in', 'warning');
        return;
    }

    if (startTime >= endTime) {
        showToast('Starttijd moet voor eindtijd liggen', 'warning');
        return;
    }

    // Warn if activity falls outside shift hours
    const shiftStart = document.getElementById('activity-shift-start')?.value;
    const shiftEnd = document.getElementById('activity-shift-end')?.value;
    if (shiftStart && shiftEnd) {
        if (startTime < shiftStart || endTime > shiftEnd) {
            if (!await showConfirm('Deze activiteit valt (deels) buiten de shift-uren (' + shiftStart.substring(0,5) + '-' + shiftEnd.substring(0,5) + '). Toch opslaan?')) {
                return;
            }
        }
    }

    try {
        if (id) {
            await updateActivity(parseInt(id, 10), { startTime, endTime, type, description });
        } else {
            await addActivity({ userId: parseInt(userId, 10), date, startTime, endTime, type, description });
        }
        closeActivityModal();
        renderPlanning();
        showToast('Activiteit opgeslagen', 'success');
    } catch (error) {
        showToast('Fout bij opslaan: ' + getUserFriendlyError(error), 'error');
    }
}

async function handleActivityDelete() {
    const id = document.getElementById('activity-id').value;
    if (!id) return;
    if (!await showConfirm('Activiteit verwijderen?')) return;

    try {
        await deleteActivity(parseInt(id, 10));
        closeActivityModal();
        renderPlanning();
        showToast('Activiteit verwijderd', 'success');
    } catch (error) {
        showToast('Fout bij verwijderen: ' + getUserFriendlyError(error), 'error');
    }
}

async function deleteShiftConfirm(shiftId) {
    const shift = getShift(shiftId);
    if (!shift) return;
    const employee = getEmployee(shift.employeeId);
    const msg = `Dienst verwijderen?\n\n${employee?.name || 'Onbekend'}\n${formatDate(shift.date)}\n${shift.startTime} - ${shift.endTime}`;
    if (await showConfirm(msg, 'Dienst verwijderen?')) {
        showSectionLoading('planning-view', 'Dienst verwijderen...');
        try {
            const shiftCopy = { employeeId: shift.employeeId, team: shift.team, date: shift.date, startTime: shift.startTime, endTime: shift.endTime, notes: shift.notes };
            await deleteShift(shiftId);
            UndoManager.push({ type: 'delete', previousData: shiftCopy, resultId: shiftId });
            renderPlanning();
        } finally {
            hideSectionLoading('planning-view');
        }
    }
}

function renderEmployees() {
    renderEmployeeTeamToggles();
    const role = getEffectiveRole();
    const employees = getAllEmployees();
    // Groepeer medewerkers per team - alleen zichtbare teams
    const teams = DataStore.settings.teams;
    const baseTeamOrder = getTeamOrder()
        .filter(t => AppState.visibleEmployeeTeams.includes(t));
    let teamOrder = baseTeamOrder;

    // Medewerker only sees own team
    if (role === 'medewerker') {
        const userTeam = AppState.currentUser?.team_id
            || employees.find(emp => emp.user_id === AppState.currentUser?.id)?.mainTeam
            || employees.find(emp => emp.email && emp.email.toLowerCase() === String(AppState.currentUser?.email || '').toLowerCase())?.mainTeam;
        teamOrder = userTeam ? baseTeamOrder.filter(teamId => teamId === userTeam) : [];
    }
    const employeesByTeam = {};

    // Determine current week start for hours calculations
    const currentWeekStartDate = AppState.currentWeekStart
        ? formatDateYYYYMMDD(AppState.currentWeekStart)
        : formatDateYYYYMMDD(new Date());

    teamOrder.forEach(teamKey => {
        const teamEmps = employees.filter(emp => emp.mainTeam === teamKey);

        teamEmps.sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));

        employeesByTeam[teamKey] = teamEmps;
    });

    let html = '';

    // Render per team
    teamOrder.forEach(teamKey => {
        const teamEmployees = employeesByTeam[teamKey];
        if (teamEmployees.length === 0) return;

        const team = teams[teamKey];
        const teamName = escapeHtml(team.name);

        html += `<div class="employees-team-section">
            <div class="employees-team-header team-${teamKey}">
                <span class="team-header-name">${teamName}</span>
                <span class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="employees-team-grid">`;

        teamEmployees.forEach(emp => {
            html += renderEmployeeCard(emp);
        });

        html += `</div></div>`;
    });

    if (employees.length === 0 || teamOrder.length === 0) {
        html = '<p>Nog geen medewerkers toegevoegd.</p>';
    }

    DOM.employeesList.innerHTML = html;
    IconHelper.init(DOM.employeesList);
    // Add click handler for employee cards based on permissions
    document.querySelectorAll('.employee-card').forEach(card => {
        const employeeId = parseFloat(card.dataset.employeeId);
        const employee = employees.find(e => e.id === employeeId);
        if (employee && canManageEmployee(employee)) {
            card.style.cursor = 'pointer';
            card.addEventListener('click', () => {
                openEditEmployeeModal(employeeId);
            });
        } else {
            card.style.cursor = 'default';
        }
    });
    document.querySelectorAll('.week-nav-btn').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const direction = btn.dataset.direction;
            const employeeId = btn.dataset.employeeId;
            if (!employeeId) return;
            const current = AppState.employeeWeekOffsets?.[employeeId] || 0;
            if (direction === 'prev') {
                AppState.employeeWeekOffsets[employeeId] = current - 1;
            } else if (direction === 'next') {
                AppState.employeeWeekOffsets[employeeId] = current + 1;
            } else if (direction === 'today') {
                AppState.employeeWeekOffsets[employeeId] = 0;
            }
            renderEmployees();
        });
    });
    document.querySelectorAll('.hours-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const card = btn.closest('.employee-card');
            if (!card) return;
            const isOpen = card.classList.toggle('show-month');
            btn.textContent = isOpen ? 'Verberg maand' : 'Toon maand';
        });
    });
}

function renderProfile() {
    const user = AppState.currentUser;
    if (!user) return;

    const roleLabels = {
        admin: 'Admin',
        roosterverantwoordelijke: 'Roosterverantwoordelijke',
        medewerker: 'Medewerker'
    };
    const role = roleLabels[user.role] || user.role || 'Onbekend';
    const roleClass = roleLabels[user.role] ? user.role : 'medewerker';
    const teamId = user.team_id || user.mainTeam;
    const teamName = teamId && DataStore.settings.teams?.[teamId]
        ? DataStore.settings.teams[teamId].name
        : 'Niet gekoppeld';
    const accessMap = {
        admin: 'Alle paginas + instellingen + accountbeheer',
        roosterverantwoordelijke: 'Alle paginas + instellingen (zonder accountbeheer)',
        medewerker: 'Eigen rooster bekijken, verlof en ruilen'
    };
    const accessSummary = accessMap[user.role] || 'Planning + profiel';

    DOM.profileContent.innerHTML = `
        <div class="profile-grid">
            <div class="settings-card">
                <div class="settings-card-header">
                    <h3><span class="settings-icon">${IconHelper.html(ICONS.profile, 'md')}</span> Mijn profiel</h3>
                </div>
                <div class="settings-card-body">
                    <form id="profile-form">
                        <div class="form-group">
                            <label for="profile-name">Naam</label>
                            <input type="text" id="profile-name" value="${escapeHtml(user.name)}" required />
                        </div>
                        <div class="form-group">
                            <label for="profile-email">E-mailadres</label>
                            <input type="email" id="profile-email" value="${escapeHtml(user.email)}" required />
                            <span class="form-hint">Dit e-mailadres gebruik je om in te loggen.</span>
                        </div>
                        <div class="form-group">
                            <label for="profile-password">Nieuw wachtwoord</label>
                            <input type="password" id="profile-password" placeholder="Laat leeg om niet te wijzigen" />
                            <span class="form-hint">Minstens 8 tekens als je wijzigt.</span>
                        </div>
                        <div class="form-group">
                            <label for="profile-password-repeat">Herhaal nieuw wachtwoord</label>
                            <input type="password" id="profile-password-repeat" placeholder="Herhaal het nieuwe wachtwoord" />
                        </div>
                        <div id="profile-message" class="form-message info" aria-live="polite">
                            Werk je gegevens bij en druk op Opslaan.
                        </div>
                        <div class="form-actions">
                            <button type="submit" class="btn btn-primary">Opslaan</button>
                        </div>
                    </form>
                </div>
            </div>

            <div class="settings-card">
                <div class="settings-card-header">
                    <h3><span class="settings-icon">${IconHelper.html(ICONS.calendar, 'md')}</span> Vast werkrooster</h3>
                </div>
                <div class="settings-card-body">
                    <div class="profile-week-toggle" id="profile-week-tabs">
                        ${(() => {
                            const cl = getCycleLength();
                            let tabs = '';
                            for (let w = 1; w <= cl; w++) {
                                tabs += `<button type="button" class="profile-week-btn ${w === 1 ? 'active' : ''}" data-week="${w}">Week ${w}</button>`;
                            }
                            return tabs;
                        })()}
                    </div>
                    <div id="profile-week-schedule-container" class="week-schedule-container"></div>
                </div>
            </div>

            ${(() => {
                const empId = user.id || user.userId || user.employeeId;
                const emp = DataStore.users.find(u => u.id === empId) || user;
                const contractHours = emp.contractHours || emp.contract_hours || 0;
                const resolvedId = emp.id || empId;
                const weekStart = getEmployeeWeekStart(resolvedId);
                const weekDates = getWeekDates(weekStart);
                const hoursWeek = getEmployeeHoursThisWeek(resolvedId, weekDates[0]);
                const hoursMonth = getEmployeeHoursThisMonth(resolvedId, weekDates[0]);

                if (contractHours > 0) {
                    const monthContract = contractHours * 4.33;
                    const weekPct = Math.min((hoursWeek / contractHours) * 100, 100);
                    const monthPct = Math.min((hoursMonth / monthContract) * 100, 100);
                    const weekClr = hoursWeek > contractHours ? '#ef4444' : hoursWeek > contractHours * 0.9 ? '#f59e0b' : '#10b981';
                    const monthClr = hoursMonth > monthContract ? '#ef4444' : hoursMonth > monthContract * 0.9 ? '#f59e0b' : '#10b981';
                    const overtimeWeek = Math.max(0, hoursWeek - contractHours);
                    const overtimeMonth = Math.max(0, hoursMonth - monthContract);
                    return `
                    <div class="settings-card">
                        <div class="settings-card-header">
                            <h3><span class="settings-icon">${IconHelper.html(ICONS.clock, 'md')}</span> Uren overzicht</h3>
                        </div>
                        <div class="settings-card-body">
                            <div class="profile-hours-section">
                                <div class="profile-hours-row">
                                    <span class="profile-hours-label">Deze week</span>
                                    <span class="profile-hours-value">${hoursWeek.toFixed(1)}u / ${contractHours}u</span>
                                </div>
                                <div class="progress-bar" style="margin-bottom:12px">
                                    <div class="progress-fill" style="width:${weekPct}%;background:${weekClr}"></div>
                                </div>
                                <div class="profile-hours-row">
                                    <span class="profile-hours-label">Deze maand</span>
                                    <span class="profile-hours-value">${hoursMonth.toFixed(1)}u / ${monthContract.toFixed(0)}u</span>
                                </div>
                                <div class="progress-bar" style="margin-bottom:4px">
                                    <div class="progress-fill" style="width:${monthPct}%;background:${monthClr}"></div>
                                </div>
                                ${(overtimeWeek > 0 || overtimeMonth > 0) ? `
                                    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                                        ${overtimeWeek > 0 ? `<span class="overtime-chip-sm">+${overtimeWeek.toFixed(1)}u overuren week</span>` : ''}
                                        ${overtimeMonth > 0 ? `<span class="overtime-chip-sm">+${overtimeMonth.toFixed(1)}u overuren maand</span>` : ''}
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    </div>`;
                } else {
                    return `
                    <div class="settings-card">
                        <div class="settings-card-header">
                            <h3><span class="settings-icon">${IconHelper.html(ICONS.clock, 'md')}</span> Uren overzicht</h3>
                        </div>
                        <div class="settings-card-body">
                            <div class="profile-hours-section">
                                <div class="profile-hours-row">
                                    <span class="profile-hours-label">Deze week</span>
                                    <span class="profile-hours-value">${hoursWeek.toFixed(1)}u</span>
                                </div>
                                <div class="profile-hours-row">
                                    <span class="profile-hours-label">Deze maand</span>
                                    <span class="profile-hours-value">${hoursMonth.toFixed(1)}u</span>
                                </div>
                                <p class="form-hint" style="margin-top:8px">Geen contracturen ingesteld.</p>
                            </div>
                        </div>
                    </div>`;
                }
            })()}

            <div class="settings-card col-span-full">
                <div class="settings-card-header">
                    <h3><span class="settings-icon">${IconHelper.html(ICONS.search, 'md')}</span> Account overzicht</h3>
                </div>
                <div class="settings-card-body">
                    <div class="profile-meta profile-meta-inline">
                        <div class="profile-meta-row">
                            <span class="profile-meta-label">Rol</span>
                            <span class="profile-meta-value role-${roleClass}">${escapeHtml(role)}</span>
                        </div>
                        <div class="profile-meta-row">
                            <span class="profile-meta-label">Hoofdteam</span>
                            <span class="profile-meta-value">${escapeHtml(teamName)}</span>
                        </div>
                        <div class="profile-meta-row">
                            <span class="profile-meta-label">Toegang</span>
                            <span class="profile-meta-value">${escapeHtml(accessSummary)}</span>
                        </div>
                        <div class="profile-meta-row">
                            <span class="profile-meta-label">Email notificaties</span>
                            <span class="profile-meta-value">
                                <label class="toggle-switch" title="Ontvang email meldingen bij ruilverzoeken, overnames en ziekmeldingen">
                                    <input type="checkbox" id="email-notifications-toggle" ${user.emailNotificationsEnabled !== false ? 'checked' : ''} />
                                    <span class="toggle-slider"></span>
                                </label>
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    IconHelper.init(DOM.profileContent);

    // Setup week schedule for profile
    generateProfileWeekScheduleHTML();
    loadProfileWeekSchedule();
    setupProfileWeekScheduleListeners();

    const form = document.getElementById('profile-form');
    const message = document.getElementById('profile-message');
    const submitBtn = form.querySelector('button[type="submit"]');

    const setMessage = (text, type = 'info') => {
        message.textContent = text;
        message.className = `form-message ${type}`;
    };

    // Email notifications toggle
    const emailToggle = document.getElementById('email-notifications-toggle');
    if (emailToggle) {
        emailToggle.addEventListener('change', async () => {
            try {
                const data = await apiFetch('/me/email-preferences', {
                    method: 'PUT',
                    body: JSON.stringify({ emailNotificationsEnabled: emailToggle.checked })
                });
                AppState.currentUser.emailNotificationsEnabled = data.emailNotificationsEnabled;
                sessionStorage.setItem('hetvlot_user', JSON.stringify(AppState.currentUser));
                showToast(emailToggle.checked ? 'Email notificaties ingeschakeld' : 'Email notificaties uitgeschakeld', 'success');
            } catch (error) {
                emailToggle.checked = !emailToggle.checked;
                showToast('Kon voorkeur niet opslaan: ' + error.message, 'error');
            }
        });
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = document.getElementById('profile-name').value.trim();
        const email = document.getElementById('profile-email').value.trim();
        const password = document.getElementById('profile-password').value;
        const passwordRepeat = document.getElementById('profile-password-repeat').value;

        if (!name) {
            setMessage('Vul een naam in.', 'error');
            return;
        }
        const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        if (!emailRegex.test(email)) {
            setMessage('Vul een geldig e-mailadres in.', 'error');
            return;
        }
        if (password && password.length < 8) {
            setMessage('Je nieuwe wachtwoord moet minstens 8 tekens zijn.', 'error');
            return;
        }
        if (password !== passwordRepeat) {
            setMessage('De wachtwoorden komen niet overeen.', 'error');
            return;
        }

        const hasChanges = name !== user.name
            || email.toLowerCase() !== String(user.email || '').toLowerCase()
            || Boolean(password);
        if (!hasChanges) {
            setMessage('Geen wijzigingen om op te slaan.', 'info');
            return;
        }

        try {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Opslaan...';
            const payload = { name, email };
            if (password) payload.password = password;
            const data = await apiFetch('/me', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            AppState.currentUser = data.user;
            sessionStorage.setItem('hetvlot_user', JSON.stringify(data.user));
            document.getElementById('profile-password').value = '';
            document.getElementById('profile-password-repeat').value = '';
            setMessage('Profiel opgeslagen.', 'success');
        } catch (error) {
            setMessage(`Opslaan mislukt: ${error.message}`, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Opslaan';
        }
    });
}

// ===== PROFILE WEEK SCHEDULE FUNCTIONS =====

function generateProfileWeekScheduleHTML() {
    const container = document.getElementById('profile-week-schedule-container');
    if (!container) return;

    const dayAbbrev = {
        1: 'Ma', 2: 'Di', 3: 'Wo', 4: 'Do', 5: 'Vr', 6: 'Za', 0: 'Zo'
    };

    function generateWeekHTML(weekNumber, days) {
        let html = `<div class="week-content ${weekNumber === 1 ? 'active' : ''}" data-profile-week="${weekNumber}">`;
        html += '<div class="profile-schedule-grid">';

        days.forEach(dayNum => {
            html += `
            <div class="profile-schedule-row profile-schedule-off" data-profile-row-week="${weekNumber}" data-profile-row-day="${dayNum}">
                <span class="profile-schedule-day">${dayAbbrev[dayNum]}</span>
                <span class="profile-schedule-detail">Vrij</span>
            </div>`;
        });

        html += '</div></div>';
        return html;
    }

    const cycleLen = getCycleLength();
    let weeksHtml = '';
    for (let w = 1; w <= cycleLen; w++) {
        const openDays = getOpenDaysForWeek(w);
        weeksHtml += generateWeekHTML(w, openDays);
    }
    container.innerHTML = weeksHtml;
}

function loadProfileWeekSchedule() {
    const user = AppState.currentUser;
    if (!user) return;

    const cycleLen = getCycleLength();
    for (let w = 1; w <= cycleLen; w++) {
        const schedule = getEmployeeWeekSchedule(user, w);
        if (schedule && schedule.length > 0) {
            loadProfileWeekScheduleData(w, schedule);
        }
    }
}

function loadProfileWeekScheduleData(weekNumber, weekSchedule) {
    if (!Array.isArray(weekSchedule)) return;

    weekSchedule.forEach(daySchedule => {
        if (!daySchedule.enabled) return;

        const row = document.querySelector(`.profile-schedule-row[data-profile-row-week="${weekNumber}"][data-profile-row-day="${daySchedule.dayOfWeek}"]`);
        if (!row) return;

        const start = daySchedule.startTime || '';
        const end = daySchedule.endTime || '';
        if (!start || !end) return;

        // Find matching template name
        let templateName = '';
        const matchedId = Object.keys(DataStore.settings.shiftTemplates || {}).find(id => {
            const t = DataStore.settings.shiftTemplates[id];
            return t.start === start && t.end === end;
        });
        if (matchedId) {
            templateName = DataStore.settings.shiftTemplates[matchedId].name;
        }

        row.classList.remove('profile-schedule-off');
        row.classList.add('profile-schedule-active');
        const detailEl = row.querySelector('.profile-schedule-detail');
        if (detailEl) {
            detailEl.innerHTML = templateName
                ? `${start} – ${end} <span class="profile-schedule-badge">${escapeHtml(templateName)}</span>`
                : `${start} – ${end}`;
        }
    });
}

function setupProfileWeekScheduleListeners() {
    // Tab switching only — profile schedule is read-only, editing via employees tab
    document.querySelectorAll('#profile-week-tabs .profile-week-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            const weekNumber = tab.dataset.week;
            document.querySelectorAll('#profile-week-tabs .profile-week-btn').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('[data-profile-week]').forEach(content => {
                content.classList.toggle('active', content.dataset.profileWeek === weekNumber);
            });
        });
    });
}

function renderEmployeeCard(emp) {
    const statusClass = emp.active ? 'active' : 'inactive';
    const statusText = emp.active ? 'Actief' : 'Inactief';
    const mainTeam = DataStore.settings.teams[emp.mainTeam];
    const employeeName = escapeHtml(emp.name);
    const employeeEmail = escapeHtml(emp.email || '');
    const mainTeamName = escapeHtml(mainTeam.name);
    const contractHours = emp.contractHours || 0;

    const teamName = (DataStore.settings.teams || {})[emp.mainTeam]?.name || emp.mainTeam || '';
    const teamColor = (DataStore.settings.teams || {})[emp.mainTeam]?.color || '#94a3b8';

    return `
        <div class="employee-card" data-employee-id="${emp.id}">
            <div class="employee-header">
                <span class="team-color-dot" style="background: ${teamColor}" title="${escapeHtml(teamName)}"></span>
                <div class="employee-name">${employeeName}</div>
                <span class="employee-status ${statusClass}">${statusText}</span>
            </div>
        </div>
    `;
}

function openAddEmployeeModal() {
    AppState.editingEmployeeId = null;
    DOM.employeeModalTitle.textContent = 'Medewerker toevoegen';
    DOM.employeeForm.reset();
    DOM.employeeActive.value = 'true';
    DOM.employeeDeleteBtn.style.display = 'none';

    // Populate team dropdown
    const mainTeamSelect = DOM.employeeMainTeam;
    mainTeamSelect.innerHTML = '';
    const teams = DataStore.settings.teams || {};
    for (const [teamId, teamInfo] of Object.entries(teams)) {
        const opt = document.createElement('option');
        opt.value = teamId;
        opt.textContent = teamInfo.name || teamId;
        mainTeamSelect.appendChild(opt);
    }

    // Extra teams checkboxes (empty for new)
    const extraTeamsContainer = document.getElementById('employee-extra-teams-checkboxes');
    if (extraTeamsContainer) {
        extraTeamsContainer.innerHTML = '';
        for (const [teamId, teamInfo] of Object.entries(teams)) {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            label.innerHTML = `<input type="checkbox" name="extra_teams" value="${teamId}"> ${teamInfo.name || teamId}`;
            extraTeamsContainer.appendChild(label);
        }
    }

    // Show profile fields and actions
    const profileFields = document.getElementById('employee-profile-fields');
    if (profileFields) profileFields.style.display = '';
    const modalActions = DOM.employeeModal.querySelector('.modal-actions');
    if (modalActions) modalActions.style.display = '';

    generateWeekScheduleHTML();
    resetWeekScheduleForm();
    DOM.employeeModal.classList.remove('hidden');
}

function openEditEmployeeModal(employeeId) {
    const employee = getEmployee(employeeId);
    if (!employee) return;
    AppState.editingEmployeeId = employeeId;
    DOM.employeeModalTitle.textContent = employee.name;

    const canEdit = ['admin', 'roosterverantwoordelijke'].includes(getEffectiveRole());

    // Profile fields
    DOM.employeeName.value = employee.name;
    DOM.employeeEmail.value = employee.email || '';
    DOM.employeeContract.value = employee.contractHours || '';
    DOM.employeeActive.value = employee.active !== false ? 'true' : 'false';

    // Populate team dropdown
    const mainTeamSelect = DOM.employeeMainTeam;
    mainTeamSelect.innerHTML = '';
    const teams = DataStore.settings.teams || {};
    for (const [teamId, teamInfo] of Object.entries(teams)) {
        const opt = document.createElement('option');
        opt.value = teamId;
        opt.textContent = teamInfo.name || teamId;
        mainTeamSelect.appendChild(opt);
    }
    mainTeamSelect.value = employee.mainTeam;

    // Extra teams checkboxes
    const extraTeamsContainer = document.getElementById('employee-extra-teams-checkboxes');
    if (extraTeamsContainer) {
        const currentExtra = employee.extraTeams || employee.extra_teams || [];
        extraTeamsContainer.innerHTML = '';
        for (const [teamId, teamInfo] of Object.entries(teams)) {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            label.innerHTML = `<input type="checkbox" name="extra_teams" value="${teamId}" ${currentExtra.includes(teamId) ? 'checked' : ''}> ${teamInfo.name || teamId}`;
            extraTeamsContainer.appendChild(label);
        }
    }

    // Show/hide profile fields and actions based on permissions
    const profileFields = document.getElementById('employee-profile-fields');
    if (profileFields) profileFields.style.display = canEdit ? '' : 'none';

    const modalActions = DOM.employeeModal.querySelector('.modal-actions');
    if (modalActions) modalActions.style.display = canEdit ? '' : 'none';

    DOM.employeeDeleteBtn.style.display = canEdit ? '' : 'none';

    // Show read-only schedule from active concept
    generateReadOnlyWeekScheduleHTML(employee);

    // Add "Bekijk in planning" button
    const container = document.getElementById('week-schedule-container');
    if (container) {
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-secondary btn-sm';
        viewBtn.style.marginTop = '12px';
        viewBtn.innerHTML = `${IconHelper.html('calendar', 'xs')} Bekijk in weekrooster`;
        viewBtn.addEventListener('click', () => {
            closeEmployeeModal();
            AppState.currentWeekStart = getMondayOfWeek(new Date());
            switchView('planning');
        });
        container.appendChild(viewBtn);
        IconHelper.init(viewBtn);
    }

    DOM.employeeModal.classList.remove('hidden');
}

function generateReadOnlyWeekScheduleHTML(employee) {
    const dayNames = { 1: 'Ma', 2: 'Di', 3: 'Wo', 4: 'Do', 5: 'Vr', 6: 'Za', 0: 'Zo' };
    const cycleLen = getCycleLength();

    // Hide tabs container if it exists
    const tabsContainer = document.getElementById('employee-week-tabs');
    if (tabsContainer) tabsContainer.innerHTML = '';

    const container = document.getElementById('week-schedule-container');
    if (!container) return;

    let html = '<div class="read-only-schedule">';
    html += '<p class="form-hint" style="margin:0 0 12px;color:var(--text-secondary)">Het basisrooster wordt beheerd via Rooster Bouwen.</p>';

    for (let w = 1; w <= cycleLen; w++) {
        const schedule = getEmployeeWeekSchedule(employee, w) || [];
        const activeDays = schedule.filter(s => s.enabled);
        const totalHours = activeDays.reduce((sum, s) => {
            const [sh, sm] = s.startTime.split(':').map(Number);
            const [eh, em] = s.endTime.split(':').map(Number);
            return sum + (eh + em/60) - (sh + sm/60);
        }, 0);

        html += `<div class="ro-week-block">`;
        html += `<div class="ro-week-header">`;
        html += `<span class="ro-week-title">Week ${w}</span>`;
        html += `<span class="ro-week-hours">${totalHours.toFixed(1)}u</span>`;
        html += `</div>`;
        html += '<div class="ro-week-grid">';
        [1, 2, 3, 4, 5, 6, 0].forEach(dayNum => {
            const entry = schedule.find(s => s.dayOfWeek === dayNum && s.enabled);
            if (entry) {
                html += `<div class="ro-day-row">
                    <span class="ro-day-name">${dayNames[dayNum]}</span>
                    <span class="ro-day-time">${entry.startTime} – ${entry.endTime}</span>
                </div>`;
            } else {
                html += `<div class="ro-day-row ro-day-off">
                    <span class="ro-day-name">${dayNames[dayNum]}</span>
                    <span class="ro-day-time">—</span>
                </div>`;
            }
        });
        html += '</div></div>';
    }

    html += '</div>';

    container.innerHTML = html;
    IconHelper.init(container);
}

function closeEmployeeModal() {
    DOM.employeeModal.classList.add('hidden');
    DOM.employeeForm.reset();
    AppState.editingEmployeeId = null;
    DOM.employeeDeleteBtn.style.display = 'none';
    // Restore modal-actions visibility for next open (add mode needs it)
    const modalActions = DOM.employeeModal.querySelector('.modal-actions');
    if (modalActions) modalActions.style.display = '';
}

async function handleEmployeeSubmit(e) {
    e.preventDefault();

    // Collect extra teams from checkboxes
    const extraTeamsChecked = [];
    document.querySelectorAll('#employee-extra-teams-checkboxes input[name="extra_teams"]:checked').forEach(cb => {
        if (cb.value !== DOM.employeeMainTeam.value) extraTeamsChecked.push(cb.value);
    });

    const employeeData = {
        name: DOM.employeeName.value.trim(),
        email: DOM.employeeEmail.value.trim(),
        mainTeam: DOM.employeeMainTeam.value,
        extraTeams: extraTeamsChecked,
        contractHours: parseFloat(DOM.employeeContract.value) || 0,
        active: DOM.employeeActive.value === 'true'
    };
    showSectionLoading('employees-view', 'Medewerker opslaan...');
    try {
        if (AppState.editingEmployeeId) {
            await updateEmployee(AppState.editingEmployeeId, employeeData);
        } else {
            await addEmployee(employeeData);
            showToast('Medewerker aangemaakt. Stel het basisrooster in via Rooster Bouwen.', 'success');
        }
        closeEmployeeModal();
        renderEmployees();

        // Refresh planning view if currently visible
        if (AppState.currentView === 'planning') {
            renderPlanning();
        }
    } catch (error) {
        console.error('Error saving employee:', error);
        showToast('Fout bij opslaan medewerker: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('employees-view');
    }
}

async function handleEmployeeDelete() {
    if (!AppState.editingEmployeeId) return;
    const employee = getEmployee(AppState.editingEmployeeId);
    if (!employee) return;

    const relatedShifts = getShiftsByEmployee(employee.id).length;
    const confirmMsg = `Weet je zeker dat je ${employee.name} wilt verwijderen?\n\nDit verwijdert ook ${relatedShifts} dienst${relatedShifts !== 1 ? 'en' : ''} en eventuele afwezigheden.`;

    if (!await showConfirm(confirmMsg, 'Medewerker verwijderen')) return;

    showSectionLoading('employees-view', 'Medewerker verwijderen...');
    try {
        await deleteEmployee(employee.id);
        closeEmployeeModal();
        renderEmployees();
        renderPlanning();
    } catch (error) {
        console.error('Error deleting employee:', error);
        showToast('Fout bij verwijderen: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('employees-view');
    }
}

// ===== BASISROOSTER FUNCTIES =====

function generateWeekScheduleHTML() {
    // Generate dynamic week tabs
    const tabsContainer = document.getElementById('employee-week-tabs');
    if (tabsContainer) {
        const cl = getCycleLength();
        let tabsHtml = '';
        for (let w = 1; w <= cl; w++) {
            const label = getWeekLabel(w);
            tabsHtml += `<button type="button" class="week-tab ${w === 1 ? 'active' : ''}" data-week="${w}">Week ${w} (${escapeHtml(label)})</button>`;
        }
        tabsContainer.innerHTML = tabsHtml;

        // Add tab click listeners
        tabsContainer.querySelectorAll('.week-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                tabsContainer.querySelectorAll('.week-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('#week-schedule-container .week-content').forEach(content => {
                    content.classList.toggle('active', content.dataset.week === tab.dataset.week);
                });
            });
        });
    }

    const container = document.getElementById('week-schedule-container');
    if (!container) return;

    const dayNames = {
        1: 'Maandag', 2: 'Dinsdag', 3: 'Woensdag',
        4: 'Donderdag', 5: 'Vrijdag', 6: 'Zaterdag', 0: 'Zondag'
    };

    // Build template options
    const templateOptions = Object.keys(DataStore.settings.shiftTemplates).map(templateId => {
        const template = DataStore.settings.shiftTemplates[templateId];
        return `<option value="${templateId}">${escapeHtml(template.name)} (${template.start}-${template.end})</option>`;
    }).join('');

    function generateWeekHTML(weekNumber, days) {
        let html = `<div class="week-content ${weekNumber === 1 ? 'active' : ''}" data-week="${weekNumber}">`;

        days.forEach(dayNum => {
            html += `
            <div class="week-schedule-day">
                <label class="week-schedule-label">
                    <input type="checkbox" class="week-schedule-enabled" data-week="${weekNumber}" data-day="${dayNum}">
                    <span class="day-name">${dayNames[dayNum]}</span>
                </label>
                <select class="week-schedule-template" data-week="${weekNumber}" data-day="${dayNum}" disabled>
                    <option value="">-- Kies template --</option>
                    ${templateOptions}
                    <option value="custom">Aangepast...</option>
                </select>
                <div class="week-schedule-times">
                    <input type="time" class="week-schedule-start" data-week="${weekNumber}" data-day="${dayNum}" disabled>
                    <span class="time-separator">-</span>
                    <input type="time" class="week-schedule-end" data-week="${weekNumber}" data-day="${dayNum}" disabled>
                </div>
            </div>`;
        });

        html += '</div>';
        return html;
    }

    // Dynamisch: genereer HTML voor elke week in de cyclus
    const cycleLen = getCycleLength();
    let weeksHtml = '';
    for (let w = 1; w <= cycleLen; w++) {
        const openDays = getOpenDaysForWeek(w);
        weeksHtml += generateWeekHTML(w, openDays);
    }
    container.innerHTML = weeksHtml;

    // Add event listeners
    setupWeekScheduleListeners();
}

function setupWeekScheduleListeners() {
    // Checkbox listeners
    document.querySelectorAll('.week-schedule-enabled').forEach(checkbox => {
        checkbox.addEventListener('change', () => toggleWeekScheduleDay(checkbox));
    });

    // Template select listeners
    document.querySelectorAll('.week-schedule-template').forEach(select => {
        select.addEventListener('change', () => applyTemplate(select));
    });
}

function applyTemplate(templateSelect) {
    const weekNumber = templateSelect.dataset.week;
    const dayOfWeek = templateSelect.dataset.day;
    const templateId = templateSelect.value;

    const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
    const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);

    if (templateId && templateId !== 'custom') {
        const template = DataStore.settings.shiftTemplates[templateId];
        if (template) {
            startInput.value = template.start;
            endInput.value = template.end;
            startInput.readOnly = true;
            endInput.readOnly = true;
        }
    } else {
        // Custom - allow manual input
        startInput.readOnly = false;
        endInput.readOnly = false;
    }
}

function resetWeekScheduleForm() {
    document.querySelectorAll('.week-schedule-enabled').forEach(checkbox => {
        checkbox.checked = false;
        toggleWeekScheduleDay(checkbox);
    });
}

function loadWeekScheduleForm(weekNumber, weekSchedule) {
    // Reset only the specific week
    document.querySelectorAll(`.week-schedule-enabled[data-week="${weekNumber}"]`).forEach(checkbox => {
        checkbox.checked = false;
        toggleWeekScheduleDay(checkbox);
    });

    weekSchedule.forEach(schedule => {
        const checkbox = document.querySelector(`.week-schedule-enabled[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);
        const templateSelect = document.querySelector(`.week-schedule-template[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);
        const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);
        const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);

        if (checkbox && schedule.enabled) {
            checkbox.checked = true;
            templateSelect.disabled = false;
            startInput.disabled = false;
            endInput.disabled = false;

            startInput.value = schedule.startTime;
            endInput.value = schedule.endTime;

            // Try to match a template
            const matchedTemplate = Object.keys(DataStore.settings.shiftTemplates).find(tid => {
                const t = DataStore.settings.shiftTemplates[tid];
                return t.start === schedule.startTime && t.end === schedule.endTime;
            });
            templateSelect.value = matchedTemplate || 'custom';

            if (matchedTemplate) {
                startInput.readOnly = true;
                endInput.readOnly = true;
            }
        }
    });
}

function getWeekScheduleFromForm(weekNumber) {
    const weekSchedule = [];

    document.querySelectorAll(`.week-schedule-enabled[data-week="${weekNumber}"]`).forEach(checkbox => {
        const dayOfWeek = parseInt(checkbox.dataset.day);
        const enabled = checkbox.checked;

        if (enabled) {
            const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
            const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);

            weekSchedule.push({
                dayOfWeek: dayOfWeek,
                enabled: true,
                startTime: startInput.value,
                endTime: endInput.value
            });
        }
    });

    return weekSchedule;
}

function toggleWeekScheduleDay(checkbox) {
    const weekNumber = checkbox.dataset.week;
    const dayOfWeek = checkbox.dataset.day;
    const enabled = checkbox.checked;

    const templateSelect = document.querySelector(`.week-schedule-template[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
    const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
    const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);

    templateSelect.disabled = !enabled;
    startInput.disabled = !enabled;
    endInput.disabled = !enabled;

    if (!enabled) {
        templateSelect.value = '';
        startInput.value = '';
        endInput.value = '';
        startInput.readOnly = false;
        endInput.readOnly = false;
    }
}

function switchWeekTab(weekNumber) {
    // Update tabs
    document.querySelectorAll('.week-tab').forEach(tab => {
        tab.classList.toggle('active', parseInt(tab.dataset.week) === weekNumber);
    });

    // Update content
    document.querySelectorAll('.week-content').forEach(content => {
        content.classList.toggle('active', parseInt(content.dataset.week) === weekNumber);
    });
}

function renderAvailability() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const role = getEffectiveRole();
    let employees = getAllEmployees(true);
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    const absenceLabels = {
        'verlof': 'Verlof',
        'ziek': 'Ziekte',
        'overuren': 'Overuren',
        'vorming': 'Vorming',
        'andere': 'Andere'
    };

    // Group employees by team (same order as Timeline)
    let teamOrder = getTeamOrder();
    // Medewerker only sees own team
    if (role === 'medewerker') {
        const userTeam = AppState.currentUser?.team_id
            || employees.find(emp => emp.user_id === AppState.currentUser?.id)?.mainTeam
            || employees.find(emp => emp.email && emp.email.toLowerCase() === String(AppState.currentUser?.email || '').toLowerCase())?.mainTeam;
        if (userTeam) {
            teamOrder = teamOrder.filter(teamId => teamId === userTeam);
            employees = employees.filter(emp => emp.mainTeam === userTeam);
        } else {
            teamOrder = [];
            employees = [];
        }
    }
    const employeesByTeam = {};
    teamOrder.forEach(team => {
        employeesByTeam[team] = employees.filter(emp => emp.mainTeam === team);
    });

    let html = `
        <div class="availability-controls">
            <div class="date-navigation">
                <button id="availability-prev-week" class="btn btn-nav">${IconHelper.html(ICONS.left, 'sm')}</button>
                <button id="availability-today" class="btn">Vandaag</button>
                <button id="availability-next-week" class="btn btn-nav">${IconHelper.html(ICONS.right, 'sm')}</button>
            </div>
            <div class="period-display">${formatDate(weekDates[0])} - ${formatDate(weekDates[6])}</div>
            <div class="availability-actions">
                <div class="availability-legend-inline">
                    <span class="legend-chip available">Beschikbaar</span>
                    <span class="legend-chip absent">Afwezig</span>
                    <span class="legend-chip has-shift">Dienst</span>
                </div>
                <button id="add-absence-btn" class="btn-add-absence">+ Afwezigheid</button>
            </div>
        </div>

        <!-- Mobile day navigation for availability -->
        <div id="availability-mobile-day-nav" class="mobile-day-nav availability-mobile-nav">
            <button id="availability-mobile-prev-day" class="btn btn-sm">${IconHelper.html(ICONS.left, 'sm')}</button>
            <div id="availability-mobile-day-display" class="mobile-day-display">
                ${getAvailabilityMobileDayDisplayHTML()}
            </div>
            <button id="availability-mobile-next-day" class="btn btn-sm">${IconHelper.html(ICONS.right, 'sm')}</button>
        </div>

        <div class="availability-container" data-mobile-day="${AppState.availabilityMobileDayIndex}">
            <div class="availability-table">
                <div class="availability-header-row">
                    <div class="availability-employee-col">Medewerker</div>
    `;

    // Header with days
    weekDates.forEach((date, index) => {
        const d = parseDateOnly(date);
        const dayOfWeek = d.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isClosed = isDayClosed(date);
        let dayClass = 'availability-day-col';
        if (isClosed) dayClass += ' closed';
        else if (isWeekend) dayClass += ' weekend';

        html += `<div class="${dayClass}">
            <span class="day-name">${dayNames[index]}</span>
            <span class="day-date">${d.getDate()}/${d.getMonth() + 1}</span>
        </div>`;
    });

    html += `</div>`; // End header row

    // Rows grouped by team
    teamOrder.forEach(teamId => {
        const teamEmployees = employeesByTeam[teamId];
        if (teamEmployees.length === 0) return;

        const teamName = escapeHtml(DataStore.settings.teams[teamId]?.name || teamId);

        // Team header
        html += `<div class="availability-team-header ${teamId}">
            <span class="team-name">${teamName}</span>
            <span class="team-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</span>
        </div>`;

        // Employee rows for this team
        teamEmployees.forEach(emp => {
            const isCurrentUser = emp.id === AppState.currentUser?.id;
            html += `<div class="availability-employee-row${isCurrentUser ? ' current-user' : ''}">
                <div class="availability-employee-col">
                    <span class="emp-name">${escapeHtml(emp.name)}</span>
                </div>
            `;

            // Days for this employee
            weekDates.forEach(date => {
                const d = parseDateOnly(date);
                const dayOfWeek = d.getDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                const isClosed = isDayClosed(date);

                const absence = getAvailability(emp.id, date);
                const hasShift = getShiftsByEmployee(emp.id, date, date).length > 0;

                // Check of medewerker normaal werkt op deze dag volgens basisrooster
                const weekNumber = getWeekNumber(date);
                const weekSchedule = getEmployeeWeekSchedule(emp, weekNumber);
                const scheduledForDay = weekSchedule && weekSchedule.find(s => s.dayOfWeek === dayOfWeek && s.enabled);
                const hasWeekSchedule = hasAnyWeekSchedule(emp);

                let cellClass = 'availability-day-col';
                if (isClosed) cellClass += ' closed';
                else if (isWeekend) cellClass += ' weekend';

                let statusClass = '';
                let statusText = '';
                let tooltipText = '';
                let hasConflict = false;

                if (!isClosed) {
                    // Afwezigheid heeft prioriteit
                    if (absence && absence.type) {
                        statusClass = 'absent';
                        statusText = absenceLabels[absence.type] || 'Afwezig';
                        tooltipText = absence.reason ? `${statusText}: ${absence.reason}` : statusText;

                        // Check voor conflict met dienst
                        if (hasShift) {
                            hasConflict = true;
                            statusClass = 'absent conflict';
                            tooltipText = `CONFLICT: ${statusText} maar heeft nog dienst ingepland!`;
                        }
                    } else if (hasShift) {
                        statusClass = 'has-shift';
                        statusText = 'Dienst';
                        tooltipText = 'Heeft dienst ingepland';
                    } else if (hasWeekSchedule && !scheduledForDay) {
                        // Medewerker heeft een weekrooster maar werkt niet op deze dag
                        statusClass = 'not-scheduled';
                        statusText = 'Vrij';
                        tooltipText = 'Niet ingepland volgens basisrooster';
                    } else {
                        statusClass = 'available';
                        statusText = '';
                        tooltipText = 'Beschikbaar - klik om afwezigheid te registreren';
                    }
                }

                const conflictIcon = hasConflict ? `<span class="conflict-icon">${IconHelper.html(ICONS.warning, 'xs')}</span>` : '';
                const cellContent = !isClosed ? `
                    <div class="availability-cell-content ${statusClass}"
                         data-employee-id="${emp.id}"
                         data-date="${date}"
                         title="${escapeHtml(tooltipText)}">
                        ${conflictIcon}${statusText ? `<span class="status-label">${escapeHtml(statusText)}</span>` : `<span class="status-check">${IconHelper.html(ICONS.check, 'xs')}</span>`}
                    </div>
                ` : '';

                html += `<div class="${cellClass}">${cellContent}</div>`;
            });

            html += `</div>`; // End employee row
        });
    });

    html += `</div></div>`; // End table and container

    DOM.availabilityView.querySelector('#availability-content').innerHTML = html;
    IconHelper.init(DOM.availabilityView.querySelector('#availability-content'));

    // Add event listeners for navigation
    document.getElementById('availability-prev-week').addEventListener('click', () => {
        AppState.currentWeekStart.setDate(AppState.currentWeekStart.getDate() - 7);
        renderAvailability();
    });

    document.getElementById('availability-next-week').addEventListener('click', () => {
        AppState.currentWeekStart.setDate(AppState.currentWeekStart.getDate() + 7);
        renderAvailability();
    });

    document.getElementById('availability-today').addEventListener('click', () => {
        AppState.currentWeekStart = getMonday(new Date());
        // Also set mobile day to today
        const today = new Date();
        const dayOfWeek = today.getDay();
        AppState.availabilityMobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        renderAvailability();
    });

    // Mobile day navigation for availability
    const availMobilePrev = document.getElementById('availability-mobile-prev-day');
    const availMobileNext = document.getElementById('availability-mobile-next-day');
    const availMobileDayDisplay = document.getElementById('availability-mobile-day-display');

    if (availMobilePrev) {
        availMobilePrev.addEventListener('click', () => changeAvailabilityMobileDay(-1));
    }
    if (availMobileNext) {
        availMobileNext.addEventListener('click', () => changeAvailabilityMobileDay(1));
    }
    if (availMobileDayDisplay) {
        availMobileDayDisplay.addEventListener('click', () => {
            const picker = document.getElementById('availability-mobile-date-picker');
            if (picker) {
                if (picker.showPicker) {
                    picker.showPicker();
                } else {
                    picker.click();
                    picker.focus();
                }
            }
        });
    }

    // Date picker for availability
    const availDatePicker = document.getElementById('availability-mobile-date-picker');
    if (availDatePicker) {
        availDatePicker.addEventListener('change', (e) => {
            const selectedDate = new Date(e.target.value);
            if (!isNaN(selectedDate.getTime())) {
                jumpToAvailabilityDate(selectedDate);
            }
        });
    }

    // Add absence button
    document.getElementById('add-absence-btn').addEventListener('click', () => {
        openAvailabilityModal();
    });

    // Event delegation for cell clicks
    document.querySelectorAll('.availability-cell-content').forEach(cell => {
        cell.addEventListener('click', () => {
            const empId = Number(cell.dataset.employeeId);
            const date = cell.dataset.date;
            openAvailabilityModal(empId, date);
        });
    });
}

async function renderSwaps() {
    const swapsList = DOM.swapsView.querySelector('#swaps-list');

    if (!swapsList) {
        console.error('swaps-list element not found');
        return;
    }

    try {
        // Fetch swap requests
        await getSwapRequests();

        const swapRequests = DataStore.swapRequests || [];
        const currentUser = AppState.currentUser;
        const role = getEffectiveRole();

        // Add safety check for currentUser
        if (!currentUser) {
            swapsList.innerHTML = `<div class="empty-state">
                <p>Je moet ingelogd zijn om ruilverzoeken te zien.</p>
            </div>`;
            IconHelper.init(swapsList);
            return;
        }

        // Separate requests by category
        const targetPendingRequests = swapRequests.filter(sr => canTargetRespondToSwap(sr));
        const pendingRequests = swapRequests.filter(sr => (sr.status === 'pending' || sr.status === 'pending_lead') && canApproveSwap(sr));
        // Mijn verzoeken: only show requests where I am the REQUESTER (not target), exclude expired
        const myRequests = swapRequests.filter(sr =>
            sr.requester_user_id === currentUser.id && sr.status !== 'expired'
        );
        const historyRequests = swapRequests.filter(sr =>
            sr.status !== 'pending' && sr.status !== 'pending_lead' && sr.status !== 'expired' && canApproveSwap(sr)
        ).slice(0, 10); // Show last 10
        // Expired requests: own requests that have expired
        const expiredRequests = swapRequests.filter(sr =>
            sr.status === 'expired' && sr.requester_user_id === currentUser.id
        ).slice(0, 10);
        // Open takeover requests: available to everyone except the requester
        const openTakeoverRequests = swapRequests.filter(sr =>
            sr.request_type === 'takeover' &&
            sr.status === 'pending' &&
            sr.requester_user_id !== currentUser.id &&
            AppState.swapTeamFilter.includes(sr.requester_shift_team)
        ).sort((a, b) => (a.requester_shift_date || '').localeCompare(b.requester_shift_date || '', 'nl-BE'));

        // Team filter toggles (dynamisch uit settings)
        const teamSettings = DataStore.settings.teams || {};
        let html = '<div class="swaps-team-filter"><div class="team-toggles" id="swaps-team-toggles">';
        getTeamOrder().forEach(team => {
            const isActive = AppState.swapTeamFilter.includes(team);
            html += `<button class="team-toggle ${isActive ? 'active' : ''}" data-team="${team}">${escapeHtml(teamSettings[team]?.name || team)}</button>`;
        });
        html += '</div></div>';

        html += '<div class="swaps-container">';

        // Section 1: Voor mij (target approval)
        if (targetPendingRequests.length > 0) {
            html += `<div class="swap-section swap-section-target">
                <h3>
                    Voor mij
                    <span class="swap-section-count">${targetPendingRequests.length}</span>
                </h3>
                <p class="text-sm text-muted mb-md">
                    Deze collega's willen graag met jou ruilen
                </p>`;

            targetPendingRequests.forEach(sr => {
                html += renderSwapRequestCard(sr, 'target');
            });

            html += `</div>`;
        }

        // Section 1.5: Beschikbare shifts (open takeover requests)
        if (openTakeoverRequests.length > 0) {
            html += `<div class="swap-section swap-section-available">
                <h3>
                    Beschikbare shifts
                    <span class="swap-section-count">${openTakeoverRequests.length}</span>
                </h3>
                <p class="text-sm text-muted mb-md">
                    Collega's zoeken iemand om hun shift over te nemen
                </p>`;

            openTakeoverRequests.forEach(sr => {
                html += renderTakeoverRequestCard(sr);
            });

            html += `</div>`;
        }

        // Section 2: Pending requests (for lead approvers only - hidden for now)
        if (false && canApproveSwap({ requester_shift_team: 'any', target_shift_team: 'any' })) {
            html += `<div class="swap-section">
                <h3>
                    Te beoordelen
                    ${pendingRequests.length > 0 ? `<span class="swap-section-count">${pendingRequests.length}</span>` : ''}
                </h3>`;

            if (pendingRequests.length === 0) {
                html += `<div class="swap-empty-state">
                    <p>Geen openstaande ruilverzoeken</p>
                </div>`;
            } else {
                pendingRequests.forEach(sr => {
                    html += renderSwapRequestCard(sr, 'approve');
                });
            }

            html += `</div>`;
        }

        // Section 3: My requests (for everyone)
        html += `<div class="swap-section">
            <h3>Mijn verzoeken</h3>`;

        if (myRequests.length === 0) {
            html += `<div class="swap-empty-state">
                <p>Je hebt nog geen ruilverzoeken ingediend</p>
                <button class="btn btn-primary mt-md" onclick="switchView('planning')">Bekijk mijn shifts in de planning</button>
            </div>`;
        } else {
            myRequests.forEach(sr => {
                // Render based on request type
                if (sr.request_type === 'takeover') {
                    html += renderTakeoverRequestCard(sr, 'view');
                } else {
                    html += renderSwapRequestCard(sr, 'view');
                }
            });
        }

        html += `</div>`;

        // Section 3.5: Expired requests (collapsible)
        if (expiredRequests.length > 0) {
            html += `<div class="swap-section swap-section-expired">
                <h3 class="cursor-pointer opacity-60" onclick="this.parentElement.classList.toggle('expanded')">
                    Verlopen
                    <span class="swap-section-count" style="background: #94a3b8;">${expiredRequests.length}</span>
                    <span style="font-size: 0.8rem; font-weight: 400; margin-left: 0.5rem;">klik om te tonen</span>
                </h3>
                <div class="expired-requests-list">`;

            expiredRequests.forEach(sr => {
                if (sr.request_type === 'takeover') {
                    html += renderTakeoverRequestCard(sr, 'view');
                } else {
                    html += renderSwapRequestCard(sr, 'view');
                }
            });

            html += `</div></div>`;
        }

        // Section 4: History (for lead approvers only - hidden for now)
        if (false && canApproveSwap({ requester_shift_team: 'any', target_shift_team: 'any' })) {
            html += `<div class="swap-section">
                <h3>Geschiedenis (laatste 10)</h3>`;

            if (historyRequests.length === 0) {
                html += `<div class="swap-empty-state">
                    <p>Geen verwerkte verzoeken</p>
                </div>`;
            } else {
                historyRequests.forEach(sr => {
                    html += renderSwapRequestCard(sr, 'history');
                });
            }

            html += `</div>`;
        }

        html += '</div>';

        swapsList.innerHTML = html;
        IconHelper.init(swapsList);

        // Attach team filter toggle listeners
        swapsList.querySelectorAll('#swaps-team-toggles .team-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const team = btn.dataset.team;
                if (AppState.swapTeamFilter.includes(team)) {
                    AppState.swapTeamFilter = AppState.swapTeamFilter.filter(t => t !== team);
                } else {
                    AppState.swapTeamFilter.push(team);
                }
                renderSwaps();
            });
        });

        // Attach event listeners to action buttons
        attachSwapActionListeners();

    } catch (error) {
        console.error('Error rendering swaps:', error);
        swapsList.innerHTML = `<div class="empty-state text-danger">
            <h3>${IconHelper.html(ICONS.error, 'md')} Fout bij laden ruilverzoeken</h3>
            <p>${escapeHtml(getUserFriendlyError(error))}</p>
        </div>`;
        IconHelper.init(swapsList);
    }
}

function renderSwapRequestCard(swapRequest, mode) {
    const statusLabels = {
        'pending': 'In behandeling',
        'approved': 'Goedgekeurd',
        'rejected': 'Afgewezen',
        'cancelled': 'Geannuleerd',
        'expired': 'Verlopen'
    };

    const createdDate = new Date(swapRequest.created_at).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    let actionsHtml = '';

    if (mode === 'target' && swapRequest.status === 'pending') {
        actionsHtml = `
            <div class="swap-request-actions d-flex gap-sm">
                <button class="btn btn-primary btn-target-approve-swap" data-swap-id="${swapRequest.id}">
                    ${IconHelper.html(ICONS.check, 'xs')} Accepteren
                </button>
                <button class="btn btn-danger btn-target-reject-swap" data-swap-id="${swapRequest.id}">
                    ${IconHelper.html(ICONS.close, 'xs')} Afwijzen
                </button>
            </div>
        `;
    } else if (mode === 'approve' && swapRequest.status === 'pending') {
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-secondary btn-review-swap" data-swap-id="${swapRequest.id}">
                    Beoordelen
                </button>
            </div>
        `;
    } else if (mode === 'view' && swapRequest.status === 'pending' && canCancelSwap(swapRequest)) {
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-danger btn-cancel-swap" data-swap-id="${swapRequest.id}">
                    Annuleren
                </button>
            </div>
        `;
    }

    let responseHtml = '';
    if (swapRequest.status !== 'pending' && swapRequest.response_notes) {
        responseHtml = `
            <div class="swap-request-message">
                <strong>Reactie:</strong> ${escapeHtml(swapRequest.response_notes)}
                ${swapRequest.responded_by_name ? `<br><small>Door ${escapeHtml(swapRequest.responded_by_name)}</small>` : ''}
            </div>
        `;
    }

    // Show who accepted the swap
    let acceptedByHtml = '';
    if (swapRequest.status === 'approved') {
        const acceptorName = swapRequest.responded_by_name || swapRequest.target_name;
        if (acceptorName) {
            acceptedByHtml = `<div class="swap-accepted-info">${IconHelper.html(ICONS.check, 'xs')} Goedgekeurd door <strong>${escapeHtml(acceptorName)}</strong></div>`;
        }
    }

    let messageHtml = '';
    if (swapRequest.message) {
        messageHtml = `
            <div class="swap-request-message">
                <strong>Bericht:</strong> ${escapeHtml(swapRequest.message)}
            </div>
        `;
    }

    return `
        <div class="swap-request-card">
            <div class="swap-request-header">
                <h4>${escapeHtml(swapRequest.requester_name)} ${IconHelper.html(ICONS.swap, 'sm')} ${escapeHtml(swapRequest.target_name)}</h4>
                <span class="swap-status-badge status-${swapRequest.status}">
                    ${statusLabels[swapRequest.status] || swapRequest.status}
                </span>
            </div>
            <div class="swap-request-body">
                <div class="swap-request-shift">
                    <strong>${escapeHtml(swapRequest.requester_name)}</strong>
                    ${formatDate(swapRequest.requester_shift_date)} |
                    ${swapRequest.requester_shift_start} - ${swapRequest.requester_shift_end} |
                    ${escapeHtml(swapRequest.requester_shift_team || '')}
                </div>
                <div class="swap-request-arrow">${IconHelper.html(ICONS.swap, 'sm')}</div>
                <div class="swap-request-shift">
                    <strong>${escapeHtml(swapRequest.target_name)}</strong>
                    ${formatDate(swapRequest.target_shift_date)} |
                    ${swapRequest.target_shift_start} - ${swapRequest.target_shift_end} |
                    ${escapeHtml(swapRequest.target_shift_team || '')}
                </div>
            </div>
            ${messageHtml}
            ${acceptedByHtml}
            ${responseHtml}
            <p class="text-sm text-muted mt-sm">
                Aangevraagd op ${createdDate}
            </p>
            ${actionsHtml}
        </div>
    `;
}

function renderTakeoverRequestCard(takeoverRequest, mode = 'available') {
    const statusLabels = {
        'pending': 'Beschikbaar',
        'approved': 'Overgenomen',
        'expired': 'Verlopen',
        'rejected': 'Afgewezen',
        'cancelled': 'Geannuleerd'
    };

    const createdDate = new Date(takeoverRequest.created_at).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const shift = takeoverRequest.requester_shift_id ? {
        date: takeoverRequest.requester_shift_date,
        startTime: takeoverRequest.requester_shift_start,
        endTime: takeoverRequest.requester_shift_end,
        team: takeoverRequest.requester_shift_team,
        notes: takeoverRequest.requester_shift_notes
    } : null;

    if (!shift) {
        return ''; // Skip if shift data is missing
    }

    // Get team name
    const teamName = shift.team && DataStore.settings.teams?.[shift.team]
        ? DataStore.settings.teams[shift.team].name
        : shift.team || 'Onbekend team';

    let messageHtml = '';
    if (takeoverRequest.message) {
        messageHtml = `
            <div class="swap-request-message">
                <strong>Bericht:</strong> ${escapeHtml(takeoverRequest.message)}
            </div>
        `;
    }

    // Show who accepted the takeover
    const acceptedByHtml = takeoverRequest.status === 'approved' && takeoverRequest.target_name
        ? `<div class="swap-accepted-info">${IconHelper.html(ICONS.check, 'xs')} Overgenomen door <strong>${escapeHtml(takeoverRequest.target_name)}</strong></div>`
        : '';

    // Actions based on mode
    let actionsHtml = '';
    if (mode === 'available' && takeoverRequest.status === 'pending') {
        // Show "Overnemen" button for available shifts
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-success btn-accept-takeover" data-request-id="${takeoverRequest.id}">
                    ${IconHelper.html(ICONS.check, 'xs')} Overnemen
                </button>
            </div>
        `;
    } else if (mode === 'view' && takeoverRequest.status === 'pending' && canCancelSwap(takeoverRequest)) {
        // Show "Annuleren" button for own pending requests
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-danger btn-cancel-swap" data-swap-id="${takeoverRequest.id}">
                    Annuleren
                </button>
            </div>
        `;
    }

    // Status badge
    const statusClass = takeoverRequest.status === 'pending' ? 'status-available' : `status-${takeoverRequest.status}`;
    const statusLabel = statusLabels[takeoverRequest.status] || takeoverRequest.status;

    // Title based on mode
    const title = mode === 'view'
        ? 'Je zoekt iemand voor deze shift'
        : `${escapeHtml(takeoverRequest.requester_name)} zoekt iemand`;

    return `
        <div class="swap-request-card takeover-card">
            <div class="swap-request-header">
                <h4>${title}</h4>
                <span class="swap-status-badge ${statusClass}">${statusLabel}</span>
            </div>
            <div class="swap-request-body">
                <div class="takeover-shift-info">
                    <strong>Shift:</strong>
                    ${formatDate(shift.date)} |
                    ${shift.startTime} - ${shift.endTime} |
                    ${escapeHtml(teamName)}
                    ${shift.notes ? `<br><em>${escapeHtml(shift.notes)}</em>` : ''}
                </div>
            </div>
            ${acceptedByHtml}
            ${messageHtml}
            <p class="text-sm text-muted mt-sm">
                Geplaatst op ${createdDate}
            </p>
            ${actionsHtml}
        </div>
    `;
}

function attachSwapActionListeners() {
    // Target approve buttons
    document.querySelectorAll('.btn-target-approve-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);
            const notes = await showInputPrompt('Wil je een bericht toevoegen?', 'Ruil accepteren');
            if (notes !== null) {
                try {
                    await targetApproveSwapRequest(swapId, notes);
                    showToast('Ruil geaccepteerd! De shifts zijn omgewisseld.', 'success');
                    switchView('planning'); // Go to planning to see the result
                } catch (error) {
                    console.error('Error approving swap:', error);
                    showToast('Fout bij accepteren: ' + getUserFriendlyError(error), 'error');
                }
            }
        });
    });

    // Target reject buttons
    document.querySelectorAll('.btn-target-reject-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);
            const notes = await showInputPrompt('Waarom wijs je dit ruilverzoek af? (verplicht)', 'Ruil afwijzen');
            if (notes && notes.trim() !== '') {
                try {
                    await targetRejectSwapRequest(swapId, notes);
                    showToast('Ruil afgewezen', 'success');
                    renderSwaps();
                } catch (error) {
                    console.error('Error rejecting swap:', error);
                    showToast('Fout bij afwijzen: ' + getUserFriendlyError(error), 'error');
                }
            } else if (notes !== null) {
                showToast('Je moet een reden opgeven om het verzoek af te wijzen', 'warning');
            }
        });
    });

    // Review buttons (for future lead approval)
    document.querySelectorAll('.btn-review-swap').forEach(btn => {
        btn.addEventListener('click', () => {
            const swapId = parseInt(btn.dataset.swapId);
            openSwapReviewModal(swapId);
        });
    });

    // Cancel buttons
    document.querySelectorAll('.btn-cancel-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);
            if (await showConfirm('Weet je zeker dat je dit ruilverzoek wilt annuleren?')) {
                try {
                    await cancelSwapRequest(swapId);
                    showToast('Ruilverzoek geannuleerd', 'success');
                    renderSwaps();
                } catch (error) {
                    console.error('Error cancelling swap:', error);
                    showToast('Fout bij annuleren: ' + getUserFriendlyError(error), 'error');
                }
            }
        });
    });

    // Accept takeover buttons
    document.querySelectorAll('.btn-accept-takeover').forEach(btn => {
        btn.addEventListener('click', async () => {
            const requestId = parseInt(btn.dataset.requestId);
            const notes = await showInputPrompt('Wil je een bericht toevoegen?', 'Shift overnemen');

            if (notes !== null) {
                if (await showConfirm('Weet je zeker dat je deze shift wilt overnemen?')) {
                    try {
                        await acceptTakeoverRequest(requestId, notes);
                        // Refresh shifts and swap requests
                        await Promise.all([refreshShifts(), getSwapRequests()]);
                        showToast('Shift overgenomen! Je kunt hem nu zien in je planning.', 'success');
                        switchView('planning'); // Go to planning to see the new shift
                    } catch (error) {
                        console.error('Error accepting takeover:', error);
                        showToast('Fout bij overnemen: ' + getUserFriendlyError(error), 'error');
                    }
                }
            }
        });
    });
}

// ===== ROOSTERBOUWER (Schedule Builder) =====
// Simpele week 1 / week 2 bouwer - bouwt basisroosters voor het team

function renderBuilder() {
    const container = document.getElementById('builder-content');
    if (!container) return;

    if (AppState.builderScreen === 'editor') {
        renderBuilderEditor(container);
    } else {
        renderBuilderOverview(container);
    }
}

function renderBuilderEditor(container) {
    const role = getEffectiveRole();
    const userTeam = AppState.currentUser?.team_id || AppState.currentUser?.mainTeam;

    let html = '';

    // Topbar with back button + concept name
    html += `<div class="builder-editor-topbar">
        <button class="btn btn-secondary btn-sm" id="builder-back-to-overview">
            <i data-lucide="arrow-left" class="lucide-sm"></i> Terug
        </button>
        <span class="builder-editor-title">
            ${AppState.builderLoadedDraftName ? escapeHtml(AppState.builderLoadedDraftName) : 'Nieuw concept'}
            ${AppState.builderIsDirty ? ' <span class="builder-dirty-badge">(gewijzigd)</span>' : ''}
        </span>
    </div>`;

    html += renderBuilderControls(role, userTeam);
    html += renderBuilderGrid(role, userTeam);
    html += renderBuilderActions();

    container.innerHTML = html;
    IconHelper.init(container);
    attachBuilderEventListeners(container);
}

function renderBuilderOverview(container) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const newestActiveId = findNewestActiveDraftId(drafts);

    // Classify all drafts by status
    const classified = drafts.map(d => ({ draft: d, status: getDraftStatus(d, newestActiveId) }));

    // Separate active drafts (always shown prominently at top)
    const activeDrafts = classified.filter(c => c.status?.cls === 'active');
    const otherDrafts = classified.filter(c => c.status?.cls !== 'active');

    // Sort others: scheduled first, then rest by date
    const statusOrder = { scheduled: 0, activatable: 1, applied: 2, expired: 3 };
    otherDrafts.sort((a, b) => {
        const oa = statusOrder[a.status?.cls] ?? 2;
        const ob = statusOrder[b.status?.cls] ?? 2;
        if (oa !== ob) return oa - ob;
        return new Date(b.draft.updatedAt || b.draft.createdAt) - new Date(a.draft.updatedAt || a.draft.createdAt);
    });

    // Apply filter to non-active drafts
    const filter = AppState.builderOverviewFilter || 'all';
    const filtered = otherDrafts.filter(c => {
        if (filter === 'all') return true;
        if (filter === 'scheduled') return c.status?.cls === 'scheduled';
        if (filter === 'vakantie') return c.draft.type === 'vakantie';
        if (filter === 'draft') return !c.status || c.status.cls === 'activatable' || !c.draft.lastAppliedAt;
        return true;
    });

    // Check for activatable drafts (notification)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const activatable = drafts.filter(d => {
        if (d.lastAppliedAt || !d.validFrom) return false;
        const vf = new Date(d.validFrom);
        vf.setHours(0, 0, 0, 0);
        return vf <= today;
    });

    let notificationHtml = '';
    if (activatable.length > 0) {
        notificationHtml = activatable.map(d => `
            <div class="builder-notification info">
                <i data-lucide="calendar-check" class="lucide-sm"></i>
                Concept "${escapeHtml(d.name)}" is nu geldig!
                <button class="btn btn-secondary btn-sm concept-card-apply ml-auto" data-draft-id="${escapeHtml(d.id)}">Nu toepassen</button>
            </div>
        `).join('');
    }

    // Active section (always visible, above grid)
    let activeSectionHtml = '';
    if (activeDrafts.length > 0) {
        activeSectionHtml = `
            <div class="builder-active-section">
                <div class="builder-active-label">Actief</div>
                ${activeDrafts.map(c => renderConceptCard(c.draft, newestActiveId)).join('')}
            </div>
        `;
    }

    // Other cards grid
    let cardsHtml = filtered.map(c => renderConceptCard(c.draft, newestActiveId)).join('');
    if (filtered.length === 0 && otherDrafts.length > 0) {
        cardsHtml = '<p class="builder-no-results">Geen concepten gevonden met dit filter.</p>';
    } else if (filtered.length === 0 && otherDrafts.length === 0 && activeDrafts.length === 0) {
        cardsHtml = '<p class="builder-no-results">Nog geen concepten. Maak een nieuw concept aan.</p>';
    }

    const filterOptions = [
        { value: 'all', label: 'Alle' },
        { value: 'scheduled', label: 'Ingepland' },
        { value: 'vakantie', label: 'Vakantie' },
        { value: 'draft', label: 'Concepten' }
    ];

    container.innerHTML = `
        <div class="builder-overview">
            ${notificationHtml}
            <div class="builder-overview-header">
                <div class="builder-overview-title-row">
                    <h3>Concepten</h3>
                    ${getEffectiveRole() === 'admin' ? `<button class="btn btn-secondary btn-sm" id="builder-upload-concept" title="Concept importeren"><i data-lucide="upload" class="lucide-xs"></i> Importeren</button>` : ''}
                </div>
                <div class="builder-overview-filter-row">
                    <select id="builder-overview-filter" class="form-input form-input-sm">
                        ${filterOptions.map(o => `<option value="${o.value}" ${filter === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                    </select>
                </div>
            </div>
            ${activeSectionHtml}
            ${otherDrafts.length > 0 || activeDrafts.length > 0 ? '<div class="builder-other-label">Overige concepten</div>' : ''}
            <div class="builder-concept-grid">
                <div class="builder-concept-card builder-concept-new" id="builder-new-concept-card">
                    <i data-lucide="plus" class="lucide-lg"></i>
                    <span class="text-xs">Nieuw concept</span>
                </div>
                ${cardsHtml}
            </div>
        </div>
    `;
    IconHelper.init(container);
    attachBuilderOverviewListeners(container);
}

function renderConceptCard(draft, newestActiveId) {
    const status = getDraftStatus(draft, newestActiveId);
    const isActive = status?.cls === 'active';
    const statusCls = status?.cls || 'draft';
    const isVakantie = draft.type === 'vakantie';
    const holidayPeriod = isVakantie ? (DataStore.settings.holidayPeriods || []).find(p => String(p.id) === String(draft.holidayPeriodId)) : null;

    const updatedDate = new Date(draft.updatedAt || draft.createdAt);
    const dateStr = updatedDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
    const timeStr = updatedDate.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
    const createdDate = draft.createdAt ? new Date(draft.createdAt) : null;
    const createdStr = createdDate ? createdDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
    const teamLabel = draft.teamFilter
        ? (DataStore.settings.teams?.[draft.teamFilter]?.name || draft.teamFilter)
        : 'Alle teams';

    const draftGrid = draft.grid || {};
    let empCount;
    if (draftGrid._multiWeek) {
        const weeks = Object.keys(draftGrid).filter(k => !k.startsWith('_'));
        const allEmpIds = new Set();
        weeks.forEach(w => Object.keys(draftGrid[w] || {}).forEach(id => allEmpIds.add(id)));
        empCount = allEmpIds.size;
    } else {
        empCount = Object.keys(draftGrid).filter(k => !k.startsWith('_')).length;
    }

    // Period display
    let periodHtml = '';
    if (draft.lastAppliedFrom && draft.lastAppliedUntil) {
        const from = parseDateOnly(draft.lastAppliedFrom).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
        const until = parseDateOnly(draft.lastAppliedUntil).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
        periodHtml = `<span class="concept-card-period">${from} – ${until}</span>`;
    } else if (draft.validFrom) {
        const vf = parseDateOnly(draft.validFrom).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
        const vu = draft.validUntil ? parseDateOnly(draft.validUntil).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' }) : '...';
        periodHtml = `<span class="concept-card-period">Geldig: ${vf} – ${vu}</span>`;
    }

    // Kebab menu (all actions)
    const isAdmin = getEffectiveRole() === 'admin';
    const hasBeenApplied = !!draft.lastAppliedAt;
    const dId = escapeHtml(draft.id);

    let menuItems = '';
    menuItems += isActive
        ? `<button class="concept-menu-item concept-card-edit" data-draft-id="${dId}">${IconHelper.html(ICONS.edit, 'xs')} Bewerken</button>`
        : `<button class="concept-menu-item concept-card-load" data-draft-id="${dId}">${IconHelper.html(ICONS.edit, 'xs')} Laden</button>`;
    menuItems += `<button class="concept-menu-item concept-card-apply" data-draft-id="${dId}">${IconHelper.html(ICONS.check, 'xs')} Toepassen</button>`;
    if (hasBeenApplied) menuItems += `<button class="concept-menu-item concept-card-deactivate" data-draft-id="${dId}">${IconHelper.html(ICONS.close, 'xs')} Uitplannen</button>`;
    menuItems += `<button class="concept-menu-item concept-card-rename" data-draft-id="${dId}">${IconHelper.html(ICONS.edit, 'xs')} Hernoemen</button>`;
    if (isAdmin) menuItems += `<button class="concept-menu-item concept-card-download" data-draft-id="${dId}">${IconHelper.html('download', 'xs')} Download</button>`;
    menuItems += `<hr><button class="concept-menu-item danger concept-card-delete" data-draft-id="${dId}">${IconHelper.html(ICONS.delete, 'xs')} Verwijderen</button>`;

    return `
        <div class="builder-concept-card draft-status-${statusCls}" data-draft-id="${escapeHtml(draft.id)}">
            <div class="concept-card-header">
                <span class="concept-card-name">${escapeHtml(draft.name)}</span>
                <div class="concept-card-menu">
                    <button class="concept-card-menu-trigger" data-draft-id="${dId}">
                        <i data-lucide="more-vertical" class="lucide-sm"></i>
                    </button>
                    <div class="concept-card-menu-dropdown">
                        ${menuItems}
                    </div>
                </div>
            </div>
            <div class="concept-card-badges">
                ${isVakantie ? `<span class="concept-card-badge badge-vakantie">Vakantie</span>` : ''}
                ${status ? `<span class="concept-card-badge badge-${statusCls}">${status.label}</span>` : '<span class="concept-card-badge badge-draft">Concept</span>'}
            </div>
            <div class="concept-card-meta">
                <span>${escapeHtml(teamLabel)} &middot; ${empCount} medewerkers${isVakantie && holidayPeriod ? ` &middot; ${escapeHtml(holidayPeriod.name)}` : ''}</span>
                ${periodHtml}
                <span>Bewerkt: ${dateStr} om ${timeStr}</span>
                <span>Door: ${escapeHtml(draft.updatedByName || draft.createdByName || 'Onbekend')}${createdStr && createdStr !== dateStr ? ` &middot; Aangemaakt: ${createdStr}` : ''}</span>
            </div>
        </div>
    `;
}

// Builder uses local pattern/rotation (not yet saved globally)
function getBuilderPattern() {
    return AppState.builderPattern || getSchedulePattern();
}
function getBuilderCycleLength() {
    return getBuilderPattern().cycleLength || 2;
}
function getBuilderClosedDays(weekNumber) {
    const pattern = getBuilderPattern();
    const weekConfig = pattern.weeks?.[String(weekNumber)];
    return weekConfig?.closedDays || [];
}
function getBuilderWeekLabel(weekNumber) {
    const pattern = getBuilderPattern();
    const weekConfig = pattern.weeks?.[String(weekNumber)];
    if (weekConfig?.label) return weekConfig.label;
    const closedDays = getBuilderClosedDays(weekNumber);
    return closedDays.length > 0 ? formatClosedDays(closedDays) : 'Alle dagen open';
}

// Collect pattern data from the UI inputs (without saving)
function ensureBuilderPattern() {
    if (!AppState.builderPattern) {
        AppState.builderPattern = JSON.parse(JSON.stringify(getSchedulePattern()));
    }
    if (!AppState.builderPattern.weeks) AppState.builderPattern.weeks = {};
    return AppState.builderPattern;
}

function addBuilderWeek() {
    const pattern = ensureBuilderPattern();
    const newLength = (pattern.cycleLength || 1) + 1;
    if (newLength > 8) return;
    pattern.cycleLength = newLength;
    pattern.weeks[String(newLength)] = { closedDays: [], label: 'alle dagen open' };
    AppState.builderIsDirty = true;
    // Switch to new week
    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));
    AppState.builderWeekNumber = newLength;
    AppState.builderGrid = AppState.builderGridByWeek[newLength] || {};
    renderBuilder();
}

function removeBuilderWeek(weekNum) {
    const pattern = ensureBuilderPattern();
    const cl = pattern.cycleLength || 1;
    if (cl <= 1) return;
    // Save current week first
    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));
    // Shift down weeks above the removed one
    const newWeeks = {};
    const newGridByWeek = {};
    let newIdx = 1;
    for (let w = 1; w <= cl; w++) {
        if (w === weekNum) continue;
        newWeeks[String(newIdx)] = pattern.weeks[String(w)] || { closedDays: [], label: 'alle dagen open' };
        newGridByWeek[newIdx] = AppState.builderGridByWeek[w] || {};
        newIdx++;
    }
    pattern.weeks = newWeeks;
    pattern.cycleLength = cl - 1;
    AppState.builderGridByWeek = newGridByWeek;
    // Adjust current week number
    if (AppState.builderWeekNumber > pattern.cycleLength) {
        AppState.builderWeekNumber = pattern.cycleLength;
    }
    AppState.builderGrid = AppState.builderGridByWeek[AppState.builderWeekNumber] || {};
    AppState.builderIsDirty = true;
    renderBuilder();
}

function toggleBuilderClosedDay(jsDow) {
    const wn = AppState.builderWeekNumber;
    const pattern = ensureBuilderPattern();
    const weekConfig = pattern.weeks[String(wn)] || { closedDays: [], label: '' };
    const idx = weekConfig.closedDays.indexOf(jsDow);
    if (idx >= 0) {
        weekConfig.closedDays.splice(idx, 1);
    } else {
        weekConfig.closedDays.push(jsDow);
    }
    weekConfig.label = weekConfig.closedDays.length > 0 ? formatClosedDays(weekConfig.closedDays) : 'alle dagen open';
    pattern.weeks[String(wn)] = weekConfig;
    AppState.builderIsDirty = true;
    renderBuilder();
}


function renderBuilderControls(role, userTeam) {
    const wn = AppState.builderWeekNumber;

    // Team filter - dropdown for all roles that can access builder
    const teams = DataStore.settings.teams || {};
    const teamFilterHtml = `<select id="builder-team-select" class="form-input w-auto">
        <option value="">Alle teams</option>
        ${Object.entries(teams).map(([key, t]) =>
            `<option value="${key}" ${AppState.builderTeamFilter === key ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
        ).join('')}
    </select>`;

    return `
        <div class="builder-controls">
            <div class="builder-controls-row">
                <div class="builder-week-nav">
                    ${(() => {
                        const cl = getBuilderCycleLength();
                        const isVakantie = AppState.builderConceptType === 'vakantie';
                        let btns = '';
                        for (let w = 1; w <= cl; w++) {
                            const label = getBuilderWeekLabel(w);
                            btns += `<button class="btn ${wn === w ? 'btn-primary' : 'btn-secondary'} btn-sm builder-week-btn" id="builder-week-${w}">
                                Week ${w} (${escapeHtml(label)})
                                ${!isVakantie && cl > 1 ? `<span class="builder-week-remove" data-week="${w}" title="Week verwijderen">&times;</span>` : ''}
                            </button>`;
                        }
                        if (!isVakantie && cl < 8) {
                            btns += `<button class="btn btn-secondary btn-sm" id="builder-add-week" title="Week toevoegen">+ Week</button>`;
                        }
                        return btns;
                    })()}
                </div>
                <div class="builder-team-filter">
                    ${teamFilterHtml}
                </div>
            </div>
            <div class="builder-controls-row">
                <div class="builder-load-options">
                    <button class="btn btn-secondary btn-sm" id="builder-load-base">Huidig basisrooster laden</button>
                    <button class="btn btn-secondary btn-sm" id="builder-load-blank">Leeg beginnen</button>
                </div>
                ${AppState.builderLoadedDraftName ? `
                    <div class="builder-loaded-draft">
                        <i data-lucide="file-text" class="lucide-xs"></i>
                        Concept: <strong>${escapeHtml(AppState.builderLoadedDraftName)}</strong>
                        ${AppState.builderIsDirty ? '<span class="builder-draft-unsaved">(gewijzigd)</span>' : '<span class="builder-draft-saved">(opgeslagen)</span>'}
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

function renderBuilderGrid(role, userTeam) {
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    let employees;
    if (AppState.builderTeamFilter) {
        employees = getEmployeesByTeam(AppState.builderTeamFilter, true);
    } else {
        employees = getAllEmployees(true);
    }
    employees = employees.sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));

    if (employees.length === 0) {
        return '<div class="builder-empty">Geen medewerkers gevonden voor het geselecteerde team</div>';
    }

    const teamOrder = getTeamOrder();
    const teams = DataStore.settings.teams || {};

    let html = '<div class="builder-grid-wrapper">';

    // Vakantieconcept info bar
    if (AppState.builderConceptType === 'vakantie') {
        const hp = (DataStore.settings.holidayPeriods || []).find(p => String(p.id) === String(AppState.builderHolidayPeriodId));
        const hpName = hp ? escapeHtml(hp.name) : 'Onbekende periode';
        const hpDates = hp ? `${parseDateOnly(hp.startDate).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })} – ${parseDateOnly(hp.endDate).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
        // Vakantie verantwoordelijke picker (per week)
        const activeEmps = getAllEmployees(true).sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
        const wn = AppState.builderWeekNumber;
        const weeklyResps = hp ? (hp.weeklyResponsibles || {}) : {};
        const currentRespId = String(weeklyResps[String(wn)] || '');
        const respOptions = activeEmps.map(e =>
            `<option value="${e.id}" ${String(e.id) === currentRespId ? 'selected' : ''}>${escapeHtml(e.name)}</option>`
        ).join('');
        html += `<div class="builder-vakantie-bar">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
                <div>
                    <strong>Vakantieconcept voor ${hpName}</strong>${hpDates ? ` <span>(${hpDates})</span>` : ''}
                    <div style="font-size:12px;margin-top:4px;opacity:0.85">Medewerkers die niet in dit rooster staan krijgen geen shift tijdens deze vakantie.</div>
                </div>
                <div class="builder-vakantie-responsible">
                    <label style="font-size:0.8rem;font-weight:600;margin-right:6px">Verantw. week ${wn}:</label>
                    <select class="form-input form-input-sm" id="builder-vakantie-responsible" data-week="${wn}" style="max-width:180px;font-size:0.8rem">
                        <option value="">Geen</option>
                        ${respOptions}
                    </select>
                </div>
            </div>
        </div>`;
    }

    html += '<div class="builder-grid">';

    // Bepaal gesloten dagen voor huidige builder week
    const builderClosedDays = getBuilderClosedDays(AppState.builderWeekNumber);
    // Map dayIndex (0=Ma..6=Zo) naar JS dayOfWeek (0=Zo, 1=Ma..6=Za)
    function dayIndexToJsDow(dayIndex) {
        return dayIndex === 6 ? 0 : dayIndex + 1;
    }

    // Header
    html += '<div class="builder-grid-header">';
    html += '<div class="builder-name-header">Medewerker</div>';
    dayNames.forEach((name, i) => {
        let headerClass = 'builder-day-header builder-day-toggle';
        const jsDow = dayIndexToJsDow(i);
        const isWeekend = i >= 5;
        const isClosed = builderClosedDays.includes(jsDow);
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        const label = isClosed ? `${name}` : name;
        const lockIcon = isClosed ? ` <span class="day-lock-icon">${IconHelper.html(ICONS.lock, 'xs')}</span>` : '';
        html += `<div class="${headerClass}" data-jsdow="${jsDow}" title="Klik om ${isClosed ? 'te openen' : 'te sluiten'}"><span class="day-name">${label}${lockIcon}</span></div>`;
    });
    html += '<div class="builder-hours-header">Uren</div>';
    html += '</div>';
    html += `<div class="builder-day-hint">${IconHelper.html(ICONS.tip, 'xs')} Klik op een dag om te sluiten/openen</div>`;

    // Employee rows grouped by team
    const renderedTeams = AppState.builderTeamFilter ? [AppState.builderTeamFilter] : teamOrder;

    renderedTeams.forEach(teamKey => {
        const teamEmployees = employees.filter(e => e.mainTeam === teamKey);
        if (teamEmployees.length === 0) return;

        const teamName = teams[teamKey]?.name || teamKey;
        html += `<div class="builder-team-section team-${teamKey}">
            <span>${escapeHtml(teamName)} (${teamEmployees.length})</span>
        </div>`;

        teamEmployees.forEach(emp => {
            html += renderBuilderEmployeeRow(emp);
        });
    });

    const knownTeams = new Set(teamOrder);
    const otherEmployees = employees.filter(e => !knownTeams.has(e.mainTeam));
    if (otherEmployees.length > 0) {
        html += `<div class="builder-team-section"><span>Overig (${otherEmployees.length})</span></div>`;
        otherEmployees.forEach(emp => { html += renderBuilderEmployeeRow(emp); });
    }

    html += '</div>';

    // Staffing heatmap (per-hour bezetting)
    html += renderBuilderStaffingHeatmap();

    // Bezettingsregels editor (inklapbaar)
    html += renderBuilderStaffingEditor();

    // Teamvergaderingen editor (inklapbaar)
    html += renderBuilderMeetingsEditor();

    // 11-hour rule warnings across consecutive days
    html += renderBuilderWarnings(employees);

    html += '</div>';
    return html;
}

// Get meetings for an employee on a specific day (only mainTeam — extraTeams zijn bijspring-teams, geen vaste vergaderingen)
function getEmployeeMeetings(employee, dayIndex) {
    const meetings = AppState.builderMeetings || {};
    const teams = DataStore.settings.teams || {};
    const mainTeam = employee.mainTeam;
    if (!mainTeam) return [];
    const result = [];
    for (const m of (meetings[mainTeam] || [])) {
        if (m.day === dayIndex) {
            result.push({ ...m, teamName: teams[mainTeam]?.name || mainTeam });
        }
    }
    return result;
}

// Check if a specific employee is in a meeting at a given hour on a given day (mainTeam only)
function isInMeeting(userId, hour, dayIndex) {
    const meetings = AppState.builderMeetings || {};
    const user = DataStore.users.find(u => u.id == userId);
    if (!user || !user.mainTeam) return false;
    for (const m of (meetings[user.mainTeam] || [])) {
        if (m.day === dayIndex && hour >= m.from && hour < m.to) return true;
    }
    return false;
}

function renderBuilderEmployeeRow(employee) {
    const empGrid = AppState.builderGrid[employee.id] || {};
    let totalHours = 0;
    const contractHours = employee.contractHours || employee.contract_hours || 0;

    let html = `<div class="builder-row" data-employee-id="${employee.id}">`;

    html += `<div class="builder-name-cell">
        <span class="emp-name">${escapeHtml(employee.name)}</span>
        <span class="emp-contract">${contractHours}u/week</span>
    </div>`;

    // Gesloten dagen voor huidige builder week
    const builderClosedDays = getBuilderClosedDays(AppState.builderWeekNumber);

    // 7 day cells (Mon=0 .. Sun=6)
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const jsDow = dayIndex === 6 ? 0 : dayIndex + 1;

        // Gesloten dag
        if (builderClosedDays.includes(jsDow)) {
            html += `<div class="builder-cell closed" data-employee-id="${employee.id}" data-day="${dayIndex}">
                <span class="cell-closed">Gesloten</span>
            </div>`;
            continue;
        }

        const assignment = empGrid[dayIndex];

        let cellClass = 'builder-cell';

        // Check 11-hour rule against adjacent days
        let hasError = false;
        if (assignment) {
            const minHours = DataStore.settings.rules?.minHoursBetweenShifts || 11;
            // Check previous day
            if (dayIndex > 0 && empGrid[dayIndex - 1]) {
                const prev = empGrid[dayIndex - 1];
                const hours = calcHoursBetweenTwoAssignments(prev, assignment);
                if (hours >= 0 && hours < minHours) hasError = true;
            }
            // Check next day
            if (dayIndex < 6 && empGrid[dayIndex + 1]) {
                const next = empGrid[dayIndex + 1];
                const hours = calcHoursBetweenTwoAssignments(assignment, next);
                if (hours >= 0 && hours < minHours) hasError = true;
            }
        }
        if (hasError) cellClass += ' has-error';

        html += `<div class="${cellClass}" data-employee-id="${employee.id}" data-day="${dayIndex}">`;

        if (assignment) {
            const shiftHours = calculateBuilderShiftHours(assignment);
            totalHours += shiftHours;
            const templateName = getTemplateNameForTimes(assignment.startTime, assignment.endTime);
            const teamColor = assignment.team ? `team-${assignment.team}` : '';
            const pos = calcTimePosition(assignment.startTime, assignment.endTime);

            let widthStyle;
            if (pos.isOvernight && dayIndex < 6 && pos.overnightDay2Pct > 0) {
                // Span into next day column: day1% + grid gap (2px) + day2%
                widthStyle = `calc(${pos.widthPct.toFixed(1)}% + 2px + ${pos.overnightDay2Pct.toFixed(1)}%)`;
            } else {
                widthStyle = `${pos.widthPct.toFixed(1)}%`;
            }

            html += `<div class="builder-timeline-block ${teamColor}${pos.isOvernight ? ' nacht' : ''}"
                style="left:${pos.leftPct.toFixed(1)}%;width:${widthStyle}"
                data-start="${assignment.startTime}" data-end="${assignment.endTime}">
                <span class="btb-label">${escapeHtml(templateName)}</span>
                <span class="btb-time">${assignment.startTime}-${assignment.endTime}</span>
            </div>`;

        } else {
            html += '<span class="cell-empty">+</span>';
        }

        // Meeting overlays for this employee on this day (always shown, with or without shift)
        const empMeetings = getEmployeeMeetings(employee, dayIndex);
        empMeetings.forEach(m => {
            const fromStr = formatStaffingHour(m.from);
            const toStr = formatStaffingHour(m.to);
            const mPos = calcTimePosition(fromStr, toStr);
            html += `<div class="builder-meeting-overlay" style="left:${mPos.leftPct.toFixed(1)}%;width:${mPos.widthPct.toFixed(1)}%" data-tooltip="Vergadering ${escapeHtml(m.teamName || '')}" data-tooltip-pos="top">
                <span class="meeting-label">${IconHelper.html(ICONS.meeting, 'xs')}</span>
            </div>`;
        });

        html += '</div>';
    }

    // Hours
    const hoursClass = totalHours > contractHours ? 'over-hours' : (totalHours < contractHours ? 'under-hours' : 'exact-hours');
    html += `<div class="builder-hours-cell ${hoursClass}">
        <span class="planned-hours">${totalHours.toFixed(1)}</span>
        <span class="contract-hours">/ ${contractHours}u</span>
    </div>`;

    html += '</div>';
    return html;
}

function isNightShift(startTime) {
    if (!startTime) return false;
    const hour = parseInt(startTime.split(':')[0], 10);
    return hour >= 20 || hour < 6;
}

// Shared helper: calculate proportional position for a time block within 7:00-24:00 range
function calcTimePosition(startTime, endTime) {
    const START_HOUR = 7, TOTAL_HOURS = 17; // 7:00-24:00
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startDec = sh + sm / 60;
    const endDec = eh + em / 60;
    const isOvernight = endDec <= startDec;

    const leftPct = Math.max(0, ((startDec - START_HOUR) / TOTAL_HOURS) * 100);

    if (isOvernight) {
        // Nachtdienst: van start tot 24:00 op startdag
        const day1Pct = Math.max(2, ((24 - startDec) / TOTAL_HOURS) * 100);
        // Volgende dag: van 7:00 (of 0:00) tot eindtijd
        const day2Pct = endDec > START_HOUR ? ((endDec - START_HOUR) / TOTAL_HOURS) * 100 : 0;
        return { leftPct, widthPct: day1Pct, isOvernight: true, overnightDay2Pct: day2Pct };
    }
    const widthPct = Math.max(2, ((endDec - Math.max(startDec, START_HOUR)) / TOTAL_HOURS) * 100);
    return { leftPct, widthPct, isOvernight: false, overnightDay2Pct: 0 };
}

// Calculate how many employees are working at a given hour on a given day
function calcBuilderHourlyHeadcount(hour, dayIndex) {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    let count = 0;
    for (const [userId, days] of Object.entries(AppState.builderGrid)) {
        // Only count employees whose main_team is in coverageTeams
        const emp = getEmployee(userId);
        if (emp && !coverageTeams.includes(emp.mainTeam || emp.main_team)) continue;

        let isWorking = false;

        // Check shift on THIS day
        const assignment = days[dayIndex];
        if (assignment) {
            const [sh, sm] = assignment.startTime.split(':').map(Number);
            const [eh, em] = assignment.endTime.split(':').map(Number);
            const startDec = sh + sm / 60;
            const endDec = eh + em / 60;
            if (endDec > startDec) {
                if (hour >= startDec && hour < endDec) isWorking = true;
            } else {
                if (hour >= startDec) isWorking = true;
            }
        }

        // Check if PREVIOUS day has overnight shift that extends into this day
        if (!isWorking) {
            const prevDay = dayIndex > 0 ? dayIndex - 1 : 6;
            const prevAssignment = days[prevDay];
            if (prevAssignment) {
                const [psh, psm] = prevAssignment.startTime.split(':').map(Number);
                const [peh, pem] = prevAssignment.endTime.split(':').map(Number);
                const prevStartDec = psh + psm / 60;
                const prevEndDec = peh + pem / 60;
                if (prevEndDec <= prevStartDec && prevEndDec > 0) {
                    if (hour < prevEndDec) isWorking = true;
                }
            }
        }

        // Count if working AND not in a meeting
        if (isWorking && !isInMeeting(userId, hour, dayIndex)) {
            count++;
        }
    }
    return count;
}

function renderBuilderStaffingHeatmap() {
    const builderClosedDays = getBuilderClosedDays(AppState.builderWeekNumber);

    let html = '<div class="builder-heatmap-row">';
    html += '<div class="builder-heatmap-label">Bezetting</div>';

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const jsDow = dayIndex === 6 ? 0 : dayIndex + 1;

        if (builderClosedDays.includes(jsDow)) {
            html += '<div class="builder-heatmap-cell closed"></div>';
            continue;
        }

        html += '<div class="builder-heatmap-cell">';

        for (let h = 7; h < 24; h += 0.5) {
            const actual = calcBuilderHourlyHeadcount(h, dayIndex);
            const required = getStaffingRequirement(dayIndex, h);

            let segClass = 'heatmap-seg';
            if (required < 0) {
                segClass += ' seg-none';
            } else if (required === 0 || actual >= required) {
                segClass += ' seg-ok';
            } else if (actual > 0) {
                segClass += ' seg-warn';
            } else {
                segClass += ' seg-danger';
            }

            const leftPct = ((h - 7) / 17) * 100;
            const widthPct = (0.5 / 17) * 100;
            const timeLabel = formatStaffingHour(h);
            html += `<span class="${segClass}" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"
                data-tooltip="${timeLabel} — ${actual}${required >= 0 ? '/' + required : ''} mdw${required >= 0 ? ' (min ' + required + ')' : ''}" data-tooltip-pos="top"></span>`;
        }

        html += '</div>';
    }

    html += '<div class="builder-heatmap-end"></div>';
    html += '</div>';
    return html;
}

// Get the minimum required staffing for a specific hour on a day (from range-based rules)
// Returns -1 if no rules cover this hour (= no requirement), 0+ if a rule exists
function getStaffingRequirement(dayIndex, hour) {
    const rules = AppState.builderStaffingRules;
    const dayRules = rules[dayIndex];
    if (!dayRules || !Array.isArray(dayRules) || dayRules.length === 0) return -1;
    let maxMin = -1;
    for (const rule of dayRules) {
        if (hour >= rule.from && hour < rule.to) {
            maxMin = Math.max(maxMin, rule.min || 0);
        }
    }
    return maxMin;
}

// Convert old per-hour format to new range-based format
function migrateStaffingRules(rules) {
    if (!rules || typeof rules !== 'object') return {};
    const migrated = {};
    for (const [dayKey, dayData] of Object.entries(rules)) {
        if (Array.isArray(dayData)) {
            migrated[dayKey] = dayData; // Already new format
            continue;
        }
        // Old format: { hour: minCount } → group consecutive hours with same min into ranges
        const hours = Object.keys(dayData).map(Number).sort((a, b) => a - b);
        if (hours.length === 0) continue;
        const ranges = [];
        let rangeStart = hours[0], rangeMin = dayData[hours[0]], prevHour = hours[0];
        for (let i = 1; i < hours.length; i++) {
            const h = hours[i];
            if (h === prevHour + 1 && dayData[h] === rangeMin) {
                prevHour = h;
            } else {
                ranges.push({ from: rangeStart, to: prevHour + 1, min: rangeMin });
                rangeStart = h;
                rangeMin = dayData[h];
                prevHour = h;
            }
        }
        ranges.push({ from: rangeStart, to: prevHour + 1, min: rangeMin });
        migrated[dayKey] = ranges;
    }
    return migrated;
}

// Format decimal hour to HH:MM string (e.g. 7.5 → "7:30", 14 → "14:00")
function formatStaffingHour(dec) {
    const h = Math.floor(dec);
    const m = Math.round((dec - h) * 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

// Parse HH:MM or H string to decimal, snapped to half hours (e.g. "7:30" → 7.5, "7:20" → 7.5, "14" → 14)
function parseStaffingHour(str) {
    str = str.trim();
    let h = 0, m = 0;
    if (str.includes(':')) {
        [h, m] = str.split(':').map(Number);
        h = h || 0;
        m = m || 0;
    } else {
        h = parseFloat(str) || 0;
        m = 0;
    }
    // Snap minutes to nearest 0 or 30
    m = m < 15 ? 0 : (m < 45 ? 30 : 60);
    if (m === 60) { h++; m = 0; }
    return h + m / 60;
}

// Generate <select> options for half-hour time slots (7:00 - 24:00)
function timeSelectOptions(selectedDec, startHour = 7, endHour = 24) {
    let html = '';
    for (let h = startHour; h <= endHour; h += 0.5) {
        const label = h === 24 ? '24:00' : formatStaffingHour(h);
        html += `<option value="${h}" ${h === selectedDec ? 'selected' : ''}>${label}</option>`;
    }
    return html;
}

function renderBuilderStaffingEditor() {
    const isOpen = AppState.builderShowStaffingEditor;
    const arrow = isOpen ? '▲' : '▼';
    let html = `<div class="builder-staffing-editor-wrapper">
        <button class="btn btn-secondary btn-sm" id="builder-staffing-toggle" style="margin:8px 0 4px">
            ${IconHelper.html(ICONS.settings, 'xs')} Bezettingsregels ${arrow}
        </button>`;

    if (isOpen) {
        const builderClosedDays = getBuilderClosedDays(AppState.builderWeekNumber);
        const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
        const rules = AppState.builderStaffingRules;

        html += '<div class="builder-staffing-editor">';
        html += '<div class="staffing-columns">';

        for (let d = 0; d < 7; d++) {
            const jsDow = d === 6 ? 0 : d + 1;
            const closed = builderClosedDays.includes(jsDow);

            html += `<div class="staffing-col${closed ? ' closed' : ''}">`;
            html += `<div class="staffing-col-header">${dayLabels[d]}</div>`;

            if (!closed) {
                const dayRules = Array.isArray(rules[d]) ? rules[d] : [];

                dayRules.forEach((rule, idx) => {
                    html += `<div class="staffing-rule-card" data-day="${d}" data-idx="${idx}">
                        <div class="staffing-rule-times">
                            <select class="staffing-from" data-day="${d}" data-idx="${idx}">${timeSelectOptions(rule.from)}</select>
                            <span>tot</span>
                            <select class="staffing-to" data-day="${d}" data-idx="${idx}">${timeSelectOptions(rule.to)}</select>
                        </div>
                        <div class="staffing-rule-min">
                            <span>min</span>
                            <input type="number" class="form-input staffing-min-input" data-day="${d}" data-idx="${idx}" value="${rule.min != null ? rule.min : 1}" min="0" max="10">
                        </div>
                        <button class="staffing-rule-remove" data-day="${d}" data-idx="${idx}" title="Verwijder">×</button>
                    </div>`;
                });

                html += `<button class="btn btn-xs btn-secondary staffing-rule-add" data-day="${d}">+</button>`;
            }

            html += '</div>';
        }

        html += '</div>'; // staffing-columns

        html += `<div class="staffing-editor-actions">
            <button class="btn btn-secondary btn-xs" id="staffing-copy-all-weeks">Kopieer naar alle weken</button>
            <button class="btn btn-secondary btn-xs" id="staffing-clear-all">Wis alles</button>
        </div>`;
        html += '</div>';
    }

    html += '</div>';
    return html;
}

function renderBuilderMeetingsEditor() {
    const isOpen = AppState.builderShowMeetingsEditor;
    const arrow = isOpen ? '▲' : '▼';
    let html = `<div class="builder-meetings-editor-wrapper">
        <button class="btn btn-secondary btn-sm" id="builder-meetings-toggle" style="margin:4px 0 4px">
            ${IconHelper.html(ICONS.employees, 'xs')} Teamvergaderingen ${arrow}
        </button>`;

    if (isOpen) {
        const teams = DataStore.settings.teams || {};
        const meetings = AppState.builderMeetings || {};
        const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

        html += '<div class="builder-meetings-editor">';
        html += '<div class="meetings-columns">';

        for (const [teamId, teamCfg] of Object.entries(teams)) {
            const teamMeetings = meetings[teamId] || [];
            html += `<div class="meetings-col">`;
            html += `<div class="meetings-col-header" style="background:${teamCfg.color || '#666'};color:#fff">${escapeHtml(teamCfg.name)}</div>`;

            teamMeetings.forEach((m, idx) => {
                const fromDisplay = formatStaffingHour(m.from || 9);
                const toDisplay = formatStaffingHour(m.to || 11);
                html += `<div class="meeting-rule-card">
                    <div class="meeting-rule-row">
                        <select class="meeting-day" data-team="${teamId}" data-idx="${idx}">
                            ${dayLabels.map((d, di) => `<option value="${di}" ${di === m.day ? 'selected' : ''}>${d}</option>`).join('')}
                        </select>
                        <button class="meeting-rule-remove" data-team="${teamId}" data-idx="${idx}" title="Verwijder">&times;</button>
                    </div>
                    <div class="meeting-rule-row">
                        <select class="meeting-from" data-team="${teamId}" data-idx="${idx}">${timeSelectOptions(m.from || 9)}</select>
                        <span class="meeting-sep">–</span>
                        <select class="meeting-to" data-team="${teamId}" data-idx="${idx}">${timeSelectOptions(m.to || 11)}</select>
                    </div>
                </div>`;
            });

            html += `<button class="meeting-rule-add btn btn-xs" data-team="${teamId}">+ Vergadering</button>`;
            html += `</div>`;
        }

        html += '</div>'; // meetings-columns
        html += '</div>'; // builder-meetings-editor
    }

    html += '</div>';
    return html;
}

function renderBuilderWarnings(employees) {
    const minHours = DataStore.settings.rules?.minHoursBetweenShifts || 11;
    const maxDays = DataStore.settings.rules?.maxConsecutiveDays || 6;
    const warnings = [];
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    employees.forEach(emp => {
        const empGrid = AppState.builderGrid[emp.id] || {};
        const days = Object.keys(empGrid).map(Number).sort((a, b) => a - b);

        // 11-hour rule checks
        for (let i = 0; i < days.length; i++) {
            const nextDay = i < days.length - 1 ? days[i + 1] : null;
            const currentShift = empGrid[days[i]];

            const wrapTarget = days[i] === 6 ? empGrid[0] : null;

            const checkPairs = [];
            if (nextDay !== null && nextDay === days[i] + 1) {
                checkPairs.push({ day1: days[i], day2: nextDay, shift2: empGrid[nextDay], isWrap: false });
            }
            if (wrapTarget) {
                checkPairs.push({ day1: 6, day2: 0, shift2: wrapTarget, isWrap: true });
            }

            for (const pair of checkPairs) {
                const endParts = currentShift.endTime.split(':').map(Number);
                const startParts = pair.shift2.startTime.split(':').map(Number);

                let endMinutes = endParts[0] * 60 + endParts[1];
                let startMinutes = startParts[0] * 60 + startParts[1];

                const shift1StartParts = currentShift.startTime.split(':').map(Number);
                const shift1Start = shift1StartParts[0] * 60 + shift1StartParts[1];
                if (endMinutes <= shift1Start) {
                    endMinutes += 24 * 60;
                }

                const restMinutes = (24 * 60 - endMinutes) + startMinutes;
                const restHours = restMinutes / 60;

                if (restHours < minHours) {
                    const label1 = dayNames[pair.day1];
                    const label2 = dayNames[pair.day2];
                    const wrapNote = pair.isWrap ? ' (weekovergang)' : '';
                    warnings.push(
                        `<strong>${escapeHtml(emp.name)}</strong>: ${restHours.toFixed(1)}u rust tussen ${label1} en ${label2}${wrapNote} (min. ${minHours}u)`
                    );
                }
            }
        }

        // Max consecutive days check (including wrap-around for repeating pattern)
        if (days.length > maxDays) {
            // Count longest consecutive run
            let maxConsec = 1, currentConsec = 1;
            for (let i = 1; i < days.length; i++) {
                if (days[i] === days[i - 1] + 1) { currentConsec++; maxConsec = Math.max(maxConsec, currentConsec); }
                else currentConsec = 1;
            }
            // Check wrap-around (zo→ma)
            if (days.includes(6) && days.includes(0)) {
                let tailCount = 0, headCount = 0;
                for (let i = days.length - 1; i >= 0 && days[i] === 6 - (days.length - 1 - i); i--) tailCount++;
                for (let i = 0; i < days.length && days[i] === i; i++) headCount++;
                maxConsec = Math.max(maxConsec, tailCount + headCount);
            }
            if (maxConsec > maxDays) {
                warnings.push(
                    `<strong>${escapeHtml(emp.name)}</strong>: ${maxConsec} opeenvolgende werkdagen in weekpatroon (max ${maxDays})`
                );
            }
        }
    });

    if (warnings.length === 0) return '';

    return `<div class="builder-11h-warnings">
        <div class="builder-11h-warnings-title">Planningsregel waarschuwingen</div>
        <ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </div>`;
}

// Legacy alias
function renderBuilder11HourWarnings(employees) { return renderBuilderWarnings(employees); }

function renderBuilderActions() {
    const hasData = Object.keys(AppState.builderGrid).length > 0 &&
        Object.values(AppState.builderGrid).some(d => Object.keys(d).length > 0);

    const saveLabel = AppState.builderLoadedDraftId ? 'Opslaan' : 'Concept opslaan';
    const showSaveAs = !!AppState.builderLoadedDraftId;

    return `
        <div class="builder-actions">
            <button class="btn btn-primary" id="builder-save-draft" ${!hasData ? 'disabled' : ''}>
                ${saveLabel}
            </button>
            ${showSaveAs ? `<button class="btn btn-secondary" id="builder-save-draft-as" ${!hasData ? 'disabled' : ''}>Opslaan als...</button>` : ''}
        </div>
    `;
}

function getDraftStatus(draft, newestActiveId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (draft.lastAppliedAt) {
        if (draft.lastAppliedFrom && draft.lastAppliedUntil) {
            const fromDate = parseDateOnly(draft.lastAppliedFrom);
            const untilDate = parseDateOnly(draft.lastAppliedUntil);
            fromDate.setHours(0, 0, 0, 0);
            untilDate.setHours(0, 0, 0, 0);
            const from = fromDate.toLocaleDateString('nl-BE');
            const until = untilDate.toLocaleDateString('nl-BE');
            if (today >= fromDate && today <= untilDate) {
                // Only the most recently applied draft with overlapping period is "active"
                if (newestActiveId && draft.id !== newestActiveId) {
                    // Check if overridden by a vacation concept (temporary pause, not permanent override)
                    const allDrafts = DataStore.settings.schedule_drafts || [];
                    const newestDraft = allDrafts.find(d => d.id === newestActiveId);
                    if (newestDraft && newestDraft.type === 'vakantie') {
                        return { label: `Gepauzeerd (vakantie): ${from} – ${until}`, cls: 'scheduled' };
                    }
                    return { label: `Overschreven: ${from} – ${until}`, cls: 'expired' };
                }
                return { label: `Actief: ${from} – ${until}`, cls: 'active' };
            }
            if (fromDate > today) {
                return { label: `Ingepland: ${from} – ${until}`, cls: 'scheduled' };
            }
            return { label: `Verlopen: ${from} – ${until}`, cls: 'expired' };
        }
        return { label: `Toegepast ${new Date(draft.lastAppliedAt).toLocaleDateString('nl-BE')}`, cls: 'applied' };
    }
    if (draft.validFrom) {
        const vf = parseDateOnly(draft.validFrom);
        vf.setHours(0, 0, 0, 0);
        if (vf > today) {
            return { label: `Ingepland vanaf ${vf.toLocaleDateString('nl-BE')}`, cls: 'scheduled' };
        }
        return { label: 'Klaar om toe te passen', cls: 'activatable' };
    }
    return null;
}

// Find the most recently applied draft whose period covers today
function findNewestActiveDraftId(drafts) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let newest = null;
    for (const d of drafts) {
        if (!d.lastAppliedAt || !d.lastAppliedFrom || !d.lastAppliedUntil) continue;
        const from = parseDateOnly(d.lastAppliedFrom);
        const until = parseDateOnly(d.lastAppliedUntil);
        from.setHours(0, 0, 0, 0);
        until.setHours(0, 0, 0, 0);
        if (today >= from && today <= until) {
            if (!newest || new Date(d.lastAppliedAt) > new Date(newest.lastAppliedAt)) {
                newest = d;
            }
        }
    }
    return newest?.id || null;
}

function renderBuilderDrafts() {
    const drafts = DataStore.settings.schedule_drafts || [];
    if (drafts.length === 0) {
        return '<div class="builder-drafts"><p class="builder-drafts-empty">Nog geen opgeslagen concepten</p></div>';
    }

    // Check for activatable drafts (valid_from <= today, not applied)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const activatable = drafts.filter(d => {
        if (d.lastAppliedAt || !d.validFrom) return false;
        const vf = new Date(d.validFrom);
        vf.setHours(0, 0, 0, 0);
        return vf <= today;
    });

    // Determine which draft is the "real" active one (most recently applied covering today)
    const newestActiveId = findNewestActiveDraftId(drafts);

    // Sort: active first, then scheduled, then rest by date
    const statusOrder = { active: 0, scheduled: 1, activatable: 2, applied: 3, expired: 4 };
    const sorted = [...drafts].sort((a, b) => {
        const sa = getDraftStatus(a, newestActiveId);
        const sb = getDraftStatus(b, newestActiveId);
        const oa = statusOrder[sa?.cls] ?? 3;
        const ob = statusOrder[sb?.cls] ?? 3;
        if (oa !== ob) return oa - ob;
        return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    });

    let notificationHtml = '';
    if (activatable.length > 0) {
        notificationHtml = activatable.map(d => `
            <div class="builder-notification info">
                <i data-lucide="calendar-check" class="lucide-sm"></i>
                Concept "${escapeHtml(d.name)}" is nu geldig!
                <button class="btn btn-primary btn-sm builder-draft-apply ml-auto" data-draft-id="${escapeHtml(d.id)}">Nu toepassen</button>
            </div>
        `).join('');
    }

    return `
        <div class="builder-drafts">
            ${notificationHtml}
            <h3>Opgeslagen concepten</h3>
            <div class="builder-drafts-list">
                ${sorted.map(draft => {
                    const date = new Date(draft.updatedAt || draft.createdAt);
                    const dateStr = date.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const teamLabel = draft.teamFilter
                        ? (DataStore.settings.teams?.[draft.teamFilter]?.name || draft.teamFilter)
                        : 'Alle teams';
                    const draftGrid = draft.grid || {};
                    let weekLabel, empCount;
                    if (draftGrid._multiWeek) {
                        const weeks = Object.keys(draftGrid).filter(k => k !== '_multiWeek').sort((a,b) => Number(a) - Number(b));
                        weekLabel = weeks.length > 1 ? `Week ${weeks.join(' & ')}` : `Week ${weeks[0] || draft.weekNumber}`;
                        const allEmpIds = new Set();
                        weeks.forEach(w => Object.keys(draftGrid[w] || {}).forEach(id => allEmpIds.add(id)));
                        empCount = allEmpIds.size;
                    } else {
                        weekLabel = `Week ${draft.weekNumber}`;
                        empCount = Object.keys(draftGrid).length;
                    }
                    const status = getDraftStatus(draft, newestActiveId);
                    const dateRange = (draft.validFrom || draft.validUntil)
                        ? `<span class="builder-draft-meta">Geldig: ${draft.validFrom ? new Date(draft.validFrom).toLocaleDateString('nl-BE') : '...'} – ${draft.validUntil ? new Date(draft.validUntil).toLocaleDateString('nl-BE') : '...'}</span>`
                        : '';
                    return `
                        <div class="builder-draft-card${status?.cls === 'active' ? ' draft-active' : status?.cls === 'activatable' ? ' draft-activatable' : ''}" data-draft-id="${escapeHtml(draft.id)}">
                            <div class="builder-draft-info">
                                <strong>${escapeHtml(draft.name)}</strong>
                                ${status ? `<span class="builder-draft-badge draft-badge-${status.cls}">${status.label}</span>` : ''}
                                <span class="builder-draft-meta">${weekLabel} &middot; ${escapeHtml(teamLabel)} &middot; ${empCount} medewerkers</span>
                                ${dateRange}
                                <span class="builder-draft-meta">${escapeHtml(draft.createdByName || 'Onbekend')} &middot; ${dateStr}</span>
                            </div>
                            <div class="builder-draft-actions">
                                <button class="btn btn-secondary btn-sm builder-draft-rename" data-draft-id="${escapeHtml(draft.id)}" title="Hernoemen">Hernoemen</button>
                                <button class="btn btn-secondary btn-sm builder-draft-load" data-draft-id="${escapeHtml(draft.id)}">Laden</button>
                                <button class="btn btn-primary btn-sm builder-draft-apply" data-draft-id="${escapeHtml(draft.id)}">Toepassen</button>
                                <button class="btn btn-danger btn-sm builder-draft-delete" data-draft-id="${escapeHtml(draft.id)}">Verwijderen</button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

// --- Builder: Cell Editing ---

function openBuilderShiftModal(employeeId, dayIndex) {
    const employee = getEmployee(employeeId);
    if (!employee) return;

    const modal = document.getElementById('builder-shift-modal');
    const titleEl = document.getElementById('builder-shift-modal-title');
    const infoEl = document.getElementById('builder-shift-employee-info');
    const templatesEl = document.getElementById('builder-shift-templates');
    const customTimes = document.getElementById('builder-custom-times');
    const validationEl = document.getElementById('builder-shift-validation');
    const startInput = document.getElementById('builder-shift-start');
    const endInput = document.getElementById('builder-shift-end');

    const dayNames = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
    titleEl.textContent = 'Dienst toewijzen';
    infoEl.innerHTML = `<strong>${escapeHtml(employee.name)}</strong> &mdash; ${dayNames[dayIndex]} (Week ${AppState.builderWeekNumber})`;

    // Template buttons
    const shiftTemplates = DataStore.settings.shiftTemplates || {};
    let buttonsHtml = '';
    Object.entries(shiftTemplates).forEach(([key, template]) => {
        buttonsHtml += `<button class="btn builder-template-btn" data-template="${key}">
            <span class="template-name">${escapeHtml(template.name)}</span>
            <span class="template-time">${template.start} - ${template.end}</span>
        </button>`;
    });
    buttonsHtml += `<button class="btn builder-template-btn" data-template="custom">
        <span class="template-name">Aangepast</span>
        <span class="template-time">Kies zelf</span>
    </button>`;
    templatesEl.innerHTML = buttonsHtml;

    customTimes.style.display = 'none';
    startInput.value = '';
    endInput.value = '';
    validationEl.innerHTML = '';

    // Pre-select current assignment
    const empGrid = AppState.builderGrid[employeeId] || {};
    const current = empGrid[dayIndex];
    if (current) {
        startInput.value = current.startTime;
        endInput.value = current.endTime;
        const matchingKey = Object.entries(shiftTemplates).find(([k, t]) =>
            t.start === current.startTime && t.end === current.endTime
        );
        if (matchingKey) {
            const btn = templatesEl.querySelector(`[data-template="${matchingKey[0]}"]`);
            if (btn) btn.classList.add('active');
        } else {
            customTimes.style.display = 'flex';
            const customBtn = templatesEl.querySelector('[data-template="custom"]');
            if (customBtn) customBtn.classList.add('active');
        }
    }

    // Template button clicks
    templatesEl.querySelectorAll('.builder-template-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            templatesEl.querySelectorAll('.builder-template-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const templateKey = btn.dataset.template;
            if (templateKey === 'custom') {
                customTimes.style.display = 'flex';
            } else {
                customTimes.style.display = 'none';
                const template = shiftTemplates[templateKey];
                startInput.value = template.start;
                endInput.value = template.end;
            }
        });
    });

    // Save button
    const saveBtn = document.getElementById('builder-shift-save');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', () => {
        const start = startInput.value;
        const end = endInput.value;
        if (!start || !end) {
            showToast('Vul start- en eindtijd in', 'warning');
            return;
        }
        if (!AppState.builderGrid[employeeId]) {
            AppState.builderGrid[employeeId] = {};
        }
        AppState.builderGrid[employeeId][dayIndex] = {
            startTime: start,
            endTime: end,
            team: employee.mainTeam || AppState.builderTeamFilter || null
        };
        AppState.builderIsDirty = true;
        modal.classList.add('hidden');
        renderBuilder();
    });

    // Clear button
    const clearBtn = document.getElementById('builder-shift-clear');
    const newClearBtn = clearBtn.cloneNode(true);
    clearBtn.parentNode.replaceChild(newClearBtn, clearBtn);
    newClearBtn.addEventListener('click', () => {
        if (AppState.builderGrid[employeeId]) {
            delete AppState.builderGrid[employeeId][dayIndex];
            if (Object.keys(AppState.builderGrid[employeeId]).length === 0) {
                delete AppState.builderGrid[employeeId];
            }
        }
        AppState.builderIsDirty = true;
        modal.classList.add('hidden');
        renderBuilder();
    });

    // Cancel/Close
    const cancelBtn = document.getElementById('builder-shift-cancel');
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    newCancelBtn.addEventListener('click', () => modal.classList.add('hidden'));

    const closeBtn = document.getElementById('builder-shift-modal-close');
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    newCloseBtn.addEventListener('click', () => modal.classList.add('hidden'));

    modal.classList.remove('hidden');
}

// --- Builder: Loading ---

function loadBuilderFromBaseSchedules() {
    const weekNumber = AppState.builderWeekNumber;

    let employees;
    if (AppState.builderTeamFilter) {
        employees = getEmployeesByTeam(AppState.builderTeamFilter, true);
    } else {
        employees = getAllEmployees(true);
    }

    AppState.builderGrid = {};

    employees.forEach(emp => {
        const weekSchedule = getEmployeeWeekSchedule(emp, weekNumber);

        if (!weekSchedule || weekSchedule.length === 0) return;

        weekSchedule.forEach(entry => {
            if (!entry.enabled) return;

            // entry.dayOfWeek: 0=Sun, 1=Mon, ..., 6=Sat (JS convention in profile)
            // Our dayIndex: 0=Mon, 1=Tue, ..., 6=Sun
            let dayIndex;
            if (entry.dayOfWeek === 0) dayIndex = 6; // Sun
            else dayIndex = entry.dayOfWeek - 1; // Mon=0, Tue=1, ...

            if (dayIndex < 0 || dayIndex > 6) return;

            if (!AppState.builderGrid[emp.id]) {
                AppState.builderGrid[emp.id] = {};
            }
            AppState.builderGrid[emp.id][dayIndex] = {
                startTime: entry.startTime,
                endTime: entry.endTime,
                team: entry.team || emp.mainTeam
            };
        });
    });

    AppState.builderGridByWeek[weekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));
    AppState.builderLoadedDraftId = null;
    AppState.builderLoadedDraftName = null;
    AppState.builderPattern = null;
    AppState.builderConceptType = 'basis';
    AppState.builderHolidayPeriodId = null;
    AppState.builderIsDirty = true;
    renderBuilder();
    showToast(`Basisrooster week ${weekNumber} geladen`, 'success');
}

// --- Builder: Draft management ---

async function saveBuilderDraft() {
    // Sync current week to cache before saving
    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));

    // Build multi-week grid from cache
    const multiGrid = { _multiWeek: true };
    let hasAnyData = false;
    for (const [weekNum, weekGrid] of Object.entries(AppState.builderGridByWeek)) {
        if (Object.keys(weekGrid).length > 0 && Object.values(weekGrid).some(d => Object.keys(d).length > 0)) {
            multiGrid[weekNum] = weekGrid;
            hasAnyData = true;
        }
    }
    if (!hasAnyData) return;

    // If a draft is loaded, UPDATE it directly (no modal needed)
    if (AppState.builderLoadedDraftId) {
        try {
            const updateData = {
                grid: JSON.parse(JSON.stringify(multiGrid)),
                weekNumber: AppState.builderWeekNumber,
                teamFilter: AppState.builderTeamFilter,
                type: AppState.builderConceptType || 'basis',
                holidayPeriodId: AppState.builderHolidayPeriodId || null
            };
            // Include pattern + rotation + staffing rules in grid metadata
            if (AppState.builderPattern) updateData.grid._pattern = AppState.builderPattern;
            // Sync staffing rules cache and save
            AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderStaffingRules));
            if (Object.keys(AppState.builderStaffingRulesByWeek).length > 0) {
                updateData.grid._staffingRules = AppState.builderStaffingRulesByWeek;
            }
            // Save team meetings in draft
            if (Object.keys(AppState.builderMeetings || {}).length > 0) {
                updateData.grid._teamMeetings = AppState.builderMeetings;
            }
            // Rotation is managed via Settings, not stored in draft
            const cached = (DataStore.settings.schedule_drafts || []).find(d => d.id === AppState.builderLoadedDraftId);
            if (cached) cached._previousGrid = JSON.parse(JSON.stringify(cached.grid || {}));
            await updateScheduleDraft(AppState.builderLoadedDraftId, updateData);
            // Update local cache
            if (cached) {
                cached.grid = updateData.grid;
                cached.weekNumber = AppState.builderWeekNumber;
                cached.teamFilter = AppState.builderTeamFilter;
                cached.updatedAt = new Date().toISOString();
                cached.updatedByName = AppState.currentUser?.name || 'Onbekend';
            }
            AppState.builderIsDirty = false;
            AppState.builderScreen = 'overview';
            renderBuilder();
            showToast(`Concept "${AppState.builderLoadedDraftName}" bijgewerkt`, 'success');

            // If this draft is currently active AND grid actually changed, ask to re-apply
            const newestActiveId = findNewestActiveDraftId(DataStore.settings.schedule_drafts || []);
            const previousGrid = cached ? JSON.stringify(cached._previousGrid) : null;
            const newGrid = JSON.stringify(updateData.grid);
            if (newestActiveId === AppState.builderLoadedDraftId && previousGrid !== newGrid) {
                const wantsApply = await showReapplyAfterEditModal(AppState.builderLoadedDraftName);
                if (wantsApply) {
                    await applyBuilderDraft(AppState.builderLoadedDraftId);
                }
            }
            if (cached) delete cached._previousGrid;
        } catch (err) {
            console.error('Error updating draft:', err);
            showToast('Fout bij bijwerken concept', 'error');
        }
        return;
    }

    // No draft loaded: create NEW draft (show save modal)
    const result = await showDraftSaveModal();
    if (!result) return;

    const draftGrid = JSON.parse(JSON.stringify(multiGrid));
    if (AppState.builderPattern) draftGrid._pattern = AppState.builderPattern;
    // Sync staffing rules and save with new draft
    AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderStaffingRules));
    if (Object.keys(AppState.builderStaffingRulesByWeek).length > 0) {
        draftGrid._staffingRules = AppState.builderStaffingRulesByWeek;
    }
    if (Object.keys(AppState.builderMeetings || {}).length > 0) {
        draftGrid._teamMeetings = AppState.builderMeetings;
    }
    // Rotation is managed via Settings, not stored in draft
    const draftData = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: result.name.trim(),
        teamFilter: AppState.builderTeamFilter,
        weekNumber: AppState.builderWeekNumber,
        grid: draftGrid,
        validFrom: null,
        validUntil: null,
        type: AppState.builderConceptType || 'basis',
        holidayPeriodId: AppState.builderHolidayPeriodId || null
    };

    try {
        if (DataStore._draftsFromTable) {
            const apiResult = await createScheduleDraft(draftData);
            DataStore.settings.schedule_drafts.push(apiResult.draft);
            // Track as loaded draft
            AppState.builderLoadedDraftId = apiResult.draft.id;
            AppState.builderLoadedDraftName = apiResult.draft.name;
        } else {
            const drafts = [...(DataStore.settings.schedule_drafts || [])];
            draftData.createdBy = AppState.currentUser?.id;
            draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
            draftData.createdAt = new Date().toISOString();
            draftData.updatedAt = new Date().toISOString();
            drafts.push(draftData);
            await saveSettings('schedule_drafts', drafts);
            DataStore.settings.schedule_drafts = drafts;
            AppState.builderLoadedDraftId = draftData.id;
            AppState.builderLoadedDraftName = draftData.name;
        }
    } catch (err) {
        console.error('Error saving draft:', err);
        showToast('Fout bij opslaan concept', 'error');
        return;
    }

    AppState.builderIsDirty = false;
    AppState.builderScreen = 'overview';
    renderBuilder();
    showToast('Concept opgeslagen', 'success');
}

async function saveBuilderDraftAs() {
    // Force "Save As": always show modal and create new draft
    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));

    const multiGrid = { _multiWeek: true };
    let hasAnyData = false;
    for (const [weekNum, weekGrid] of Object.entries(AppState.builderGridByWeek)) {
        if (Object.keys(weekGrid).length > 0 && Object.values(weekGrid).some(d => Object.keys(d).length > 0)) {
            multiGrid[weekNum] = weekGrid;
            hasAnyData = true;
        }
    }
    if (!hasAnyData) return;

    const result = await showDraftSaveModal();
    if (!result) return;

    const draftGrid = JSON.parse(JSON.stringify(multiGrid));
    if (AppState.builderPattern) draftGrid._pattern = AppState.builderPattern;
    // Sync staffing rules and save with draft-as copy
    AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderStaffingRules));
    if (Object.keys(AppState.builderStaffingRulesByWeek).length > 0) {
        draftGrid._staffingRules = AppState.builderStaffingRulesByWeek;
    }
    if (Object.keys(AppState.builderMeetings || {}).length > 0) {
        draftGrid._teamMeetings = AppState.builderMeetings;
    }
    // Rotation is managed via Settings, not stored in draft
    const draftData = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: result.name.trim(),
        teamFilter: AppState.builderTeamFilter,
        weekNumber: AppState.builderWeekNumber,
        grid: draftGrid,
        validFrom: null,
        validUntil: null,
        type: AppState.builderConceptType || 'basis',
        holidayPeriodId: AppState.builderHolidayPeriodId || null
    };

    try {
        if (DataStore._draftsFromTable) {
            const apiResult = await createScheduleDraft(draftData);
            DataStore.settings.schedule_drafts.push(apiResult.draft);
            AppState.builderLoadedDraftId = apiResult.draft.id;
            AppState.builderLoadedDraftName = apiResult.draft.name;
        } else {
            const drafts = [...(DataStore.settings.schedule_drafts || [])];
            draftData.createdBy = AppState.currentUser?.id;
            draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
            draftData.createdAt = new Date().toISOString();
            draftData.updatedAt = new Date().toISOString();
            drafts.push(draftData);
            await saveSettings('schedule_drafts', drafts);
            DataStore.settings.schedule_drafts = drafts;
            AppState.builderLoadedDraftId = draftData.id;
            AppState.builderLoadedDraftName = draftData.name;
        }
    } catch (err) {
        console.error('Error saving draft as:', err);
        showToast('Fout bij opslaan concept', 'error');
        return;
    }

    AppState.builderIsDirty = false;
    AppState.builderScreen = 'overview';
    renderBuilder();
    showToast(`Nieuw concept "${draftData.name}" aangemaakt`, 'success');
}

function showNewConceptTypeModal() {
    // All holiday periods are available (meerdere concepten per periode toegestaan)
    const availablePeriods = (DataStore.settings.holidayPeriods || []);

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
        <div class="modal-content modal-content--sm">
            <div class="modal-header">
                <h2>Nieuw concept</h2>
                <span class="modal-close">&times;</span>
            </div>
            <div class="modal-body" style="padding:20px">
                <p class="text-sm text-muted mb-md">Kies het type concept dat je wilt aanmaken.</p>
                <div class="concept-type-options">
                    <label class="concept-type-option selected" data-value="basis">
                        <input type="radio" name="concept-type" value="basis" checked>
                        <div class="concept-type-icon">${IconHelper.html(ICONS.calendar, 'md')}</div>
                        <div class="concept-type-info">
                            <strong>Basisrooster</strong>
                            <span>Het standaard weekrooster voor het hele jaar</span>
                        </div>
                    </label>
                    <label class="concept-type-option" data-value="vakantie">
                        <input type="radio" name="concept-type" value="vakantie">
                        <div class="concept-type-icon" style="color:#f59e0b">${IconHelper.html(ICONS.holiday || ICONS.calendar, 'md')}</div>
                        <div class="concept-type-info">
                            <strong>Vakantieconcept</strong>
                            <span>Een apart rooster voor een vakantieperiode</span>
                        </div>
                    </label>
                </div>
                <div id="vakantie-period-select" style="display:none;margin-top:16px">
                    <label class="form-label">Gekoppelde vakantieperiode:</label>
                    ${availablePeriods.length > 0 ? `
                        <select id="vakantie-period-id" class="form-input">
                            <option value="">Selecteer een periode...</option>
                            ${availablePeriods.map(p => {
                                const from = parseDateOnly(p.startDate).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
                                const until = parseDateOnly(p.endDate).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
                                return `<option value="${p.id}">${escapeHtml(p.name)} (${from} – ${until})</option>`;
                            }).join('')}
                        </select>
                    ` : '<p class="no-items-text">Geen beschikbare vakantieperiodes. Voeg eerst een vakantieperiode toe in Instellingen > Planning.</p>'}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="concept-type-cancel">Annuleren</button>
                <button class="btn btn-primary" id="concept-type-confirm">Aanmaken</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    IconHelper.init(overlay);

    // Toggle highlight + vakantie period select
    overlay.querySelectorAll('.concept-type-option').forEach(opt => {
        opt.addEventListener('click', () => {
            overlay.querySelectorAll('.concept-type-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            opt.querySelector('input').checked = true;
            const periodSelect = overlay.querySelector('#vakantie-period-select');
            periodSelect.style.display = opt.dataset.value === 'vakantie' ? 'block' : 'none';
        });
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#concept-type-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#concept-type-confirm').addEventListener('click', () => {
        const type = overlay.querySelector('input[name="concept-type"]:checked')?.value || 'basis';
        let holidayPeriodId = null;
        let conceptName = null;

        if (type === 'vakantie') {
            const selectEl = overlay.querySelector('#vakantie-period-id');
            if (!selectEl || !selectEl.value) {
                showToast('Selecteer een vakantieperiode', 'warning');
                return;
            }
            holidayPeriodId = selectEl.value;
            const period = availablePeriods.find(p => String(p.id) === String(holidayPeriodId));
            conceptName = period ? period.name : 'Vakantieconcept';
        }

        overlay.remove();

        // Initialize new concept
        AppState.builderGrid = {};
        AppState.builderGridByWeek = {};
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderShowStaffingEditor = false;
        AppState.builderShowMeetingsEditor = false;
        AppState.builderMeetings = {};
        AppState.builderLoadedDraftId = null;
        AppState.builderLoadedDraftName = conceptName;

        // Determine cycle length: for vakantie concepts, calculate from period dates
        let initCycleLength = 1;
        if (type === 'vakantie' && holidayPeriodId) {
            const period = (DataStore.settings.holidayPeriods || []).find(p => String(p.id) === String(holidayPeriodId));
            if (period) {
                const pStart = parseDateOnly(period.startDate);
                const pEnd = parseDateOnly(period.endDate);
                const pMonday = getMondayOfWeek(pStart);
                const pEndMonday = getMondayOfWeek(pEnd);
                initCycleLength = Math.floor((pEndMonday - pMonday) / (7 * 86400000)) + 1;
            }
        }

        // Build weeks pattern (all days open)
        const weeksInit = {};
        for (let w = 1; w <= initCycleLength; w++) {
            weeksInit[String(w)] = { closedDays: [], label: 'alle dagen open' };
        }
        AppState.builderPattern = {
            cycleLength: initCycleLength,
            referenceDate: getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate || '',
            weeks: weeksInit
        };
        AppState.builderIsDirty = false;
        AppState.builderWeekNumber = 1;
        AppState.builderConceptType = type;
        AppState.builderHolidayPeriodId = holidayPeriodId;
        AppState.builderScreen = 'editor';
        renderBuilder();
    });
}

function showDraftSaveModal() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.innerHTML = `
            <div class="modal-content modal-content--xs">
                <div class="modal-header">
                    <h2>Concept opslaan</h2>
                    <span class="modal-close" id="draft-save-close"><i data-lucide="x"></i></span>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label>Naam *</label>
                        <input type="text" id="draft-save-name" class="form-input" placeholder="Bijv. Schooljaar 2026-2027">
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary btn-sm" id="draft-save-cancel">Annuleren</button>
                    <button class="btn btn-primary btn-sm" id="draft-save-confirm">Opslaan</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        IconHelper.init(overlay);

        const nameInput = overlay.querySelector('#draft-save-name');
        setTimeout(() => nameInput.focus(), 50);

        function cleanup(result) {
            overlay.remove();
            resolve(result);
        }

        overlay.querySelector('#draft-save-close').addEventListener('click', () => cleanup(null));
        overlay.querySelector('#draft-save-cancel').addEventListener('click', () => cleanup(null));
        overlay.querySelector('#draft-save-confirm').addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) {
                nameInput.focus();
                return;
            }
            // Name uniqueness check
            const drafts = DataStore.settings.schedule_drafts || [];
            const existing = drafts.find(d => d.name.trim().toLowerCase() === name.toLowerCase());
            if (existing) {
                showToast('Er bestaat al een concept met deze naam', 'warning');
                return;
            }
            cleanup({ name });
        });
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') overlay.querySelector('#draft-save-confirm').click();
            if (e.key === 'Escape') cleanup(null);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(null);
        });
    });
}

function loadBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    if (AppState.builderIsDirty) {
        showConfirm('Je hebt onopgeslagen wijzigingen. Wil je doorgaan?').then(confirmed => {
            if (!confirmed) return;
            doLoadDraft(draft);
        });
    } else {
        doLoadDraft(draft);
    }
}

function doLoadDraft(draft) {
    const grid = draft.grid || {};
    AppState.builderTeamFilter = draft.teamFilter || null;
    AppState.builderGridByWeek = {};

    if (grid._multiWeek) {
        // Multi-week draft: load all weeks into cache
        let firstWeek = null;
        for (const [weekNum, weekGrid] of Object.entries(grid)) {
            if (weekNum.startsWith('_')) continue;
            const wn = Number(weekNum);
            AppState.builderGridByWeek[wn] = JSON.parse(JSON.stringify(weekGrid));
            if (firstWeek === null) firstWeek = wn;
        }
        AppState.builderWeekNumber = draft.weekNumber || firstWeek || 1;
        AppState.builderGrid = AppState.builderGridByWeek[AppState.builderWeekNumber]
            ? JSON.parse(JSON.stringify(AppState.builderGridByWeek[AppState.builderWeekNumber]))
            : {};
    } else {
        // Backward compat: single-week draft
        AppState.builderWeekNumber = draft.weekNumber || 1;
        AppState.builderGrid = JSON.parse(JSON.stringify(grid));
        AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(grid));
    }

    // Restore pattern + rotation + staffing rules from draft if saved
    AppState.builderPattern = grid._pattern || null;
    AppState.builderRotation = grid._rotation || null;
    const rawStaffing = grid._staffingRules ? JSON.parse(JSON.stringify(grid._staffingRules)) : {};
    // Migrate old per-hour format to range-based format
    for (const weekKey of Object.keys(rawStaffing)) {
        rawStaffing[weekKey] = migrateStaffingRules(rawStaffing[weekKey]);
    }
    AppState.builderStaffingRulesByWeek = rawStaffing;
    AppState.builderStaffingRules = AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber]
        ? JSON.parse(JSON.stringify(AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber]))
        : {};
    AppState.builderShowStaffingEditor = false;

    // Restore team meetings from draft
    AppState.builderMeetings = grid._teamMeetings ? JSON.parse(JSON.stringify(grid._teamMeetings)) : {};
    AppState.builderShowMeetingsEditor = false;

    AppState.builderLoadedDraftId = draft.id;
    AppState.builderLoadedDraftName = draft.name;
    AppState.builderConceptType = draft.type || 'basis';
    AppState.builderHolidayPeriodId = draft.holidayPeriodId || null;
    AppState.builderIsDirty = false;
    AppState.builderScreen = 'editor';
    renderBuilder();
    showToast(`Concept "${draft.name}" geladen`, 'info');
}

async function deleteBuilderDraft(draftId) {
    const confirmed = await showConfirm('Dit concept verwijderen?');
    if (!confirmed) return;

    try {
        if (DataStore._draftsFromTable) {
            await deleteScheduleDraft(draftId);
        } else {
            const drafts = (DataStore.settings.schedule_drafts || []).filter(d => d.id !== draftId);
            await saveSettings('schedule_drafts', drafts);
        }
        DataStore.settings.schedule_drafts = (DataStore.settings.schedule_drafts || []).filter(d => d.id !== draftId);
    } catch (err) {
        console.error('Error deleting draft:', err);
        showToast('Fout bij verwijderen concept', 'error');
        return;
    }

    renderBuilder();
    showToast('Concept verwijderd', 'success');
}

async function renameBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    const newName = await showInputPrompt('Nieuwe naam voor dit concept:', 'Concept hernoemen', draft.name);
    if (!newName) return;

    // Name uniqueness check
    const existing = drafts.find(d => d.name.trim().toLowerCase() === newName.trim().toLowerCase() && d.id !== draftId);
    if (existing) {
        showToast('Er bestaat al een concept met deze naam', 'warning');
        return;
    }

    try {
        if (DataStore._draftsFromTable) {
            await updateScheduleDraft(draftId, { name: newName });
        } else {
            draft.updatedAt = new Date().toISOString();
            await saveSettings('schedule_drafts', drafts);
        }
        draft.name = newName;
        draft.updatedAt = new Date().toISOString();
    } catch (err) {
        console.error('Error renaming draft:', err);
        showToast('Fout bij hernoemen concept', 'error');
        return;
    }

    renderBuilder();
    showToast('Concept hernoemd', 'success');
}

async function deactivateBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = formatDateYYYYMMDD(today);

    // Check if concept is scheduled (future, not yet started)
    const isScheduled = draft.lastAppliedFrom && parseDateOnly(draft.lastAppliedFrom) > today;

    if (isScheduled) {
        // Ingepland concept: simpele reset, geen shifts verwijderen
        const proceed = await showConfirm(
            `"${draft.name}" is ingepland maar nog niet gestart. Wil je de planning ongedaan maken?\n\nHet concept wordt teruggezet naar een gewoon concept zonder datum.`,
            'Concept uitplannen'
        );
        if (!proceed) return;

        try {
            showSectionLoading('builder-view', 'Uitplannen...');
            await updateScheduleDraft(draftId, {
                lastAppliedAt: null,
                lastAppliedBy: null,
                lastAppliedFrom: null,
                lastAppliedUntil: null
            });
            // Update local cache
            const cached = drafts.find(d => d.id === draftId);
            if (cached) {
                cached.lastAppliedAt = null;
                cached.lastAppliedBy = null;
                cached.lastAppliedFrom = null;
                cached.lastAppliedUntil = null;
            }
            renderBuilder();
            showToast('Concept uitgeplanend', 'success');
        } catch (err) {
            console.error('Error unscheduling draft:', err);
            showToast('Fout bij uitplannen: ' + err.message, 'error');
        } finally {
            hideSectionLoading('builder-view');
        }
        return;
    }

    // Actief/verlopen concept: deactiveer met einddatum
    const result = await new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.innerHTML = `
            <div class="modal-content modal-content--sm">
                <div class="modal-header">
                    <h2>Concept deactiveren</h2>
                    <span class="modal-close" id="deactivate-close"><i data-lucide="x"></i></span>
                </div>
                <div class="modal-body">
                    <p style="margin:0 0 12px"><strong>${escapeHtml(draft.name)}</strong> deactiveren?</p>
                    <div class="form-group">
                        <label>Einddatum (shifts na deze datum worden verwijderd)</label>
                        <input type="date" id="deactivate-end-date" class="form-input" value="${todayStr}">
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;cursor:pointer">
                        <input type="checkbox" id="deactivate-delete-manual">
                        Verwijder ook handmatig aangemaakte shifts
                    </label>
                    <span class="form-hint" style="display:block;margin-top:8px">Auto-gegenereerde shifts na de einddatum worden altijd verwijderd.</span>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary btn-sm" id="deactivate-cancel">Annuleren</button>
                    <button class="btn btn-warning btn-sm" id="deactivate-confirm">Deactiveren</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        IconHelper.init(overlay);

        function cleanup() { overlay.remove(); }

        overlay.querySelector('#deactivate-confirm').addEventListener('click', () => {
            const endDate = overlay.querySelector('#deactivate-end-date').value;
            const deleteManual = overlay.querySelector('#deactivate-delete-manual').checked;
            if (!endDate) { showToast('Kies een einddatum', 'warning'); return; }
            cleanup();
            resolve({ endDate, deleteManual });
        });
        overlay.querySelector('#deactivate-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
        overlay.querySelector('#deactivate-close').addEventListener('click', () => { cleanup(); resolve(null); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
    });

    if (!result) return;

    try {
        showSectionLoading('builder-view', 'Deactiveren...');
        const response = await deactivateDraftShifts(draftId, result);

        // Update local cache
        const cached = drafts.find(d => d.id === draftId);
        if (cached) {
            cached.lastAppliedUntil = result.endDate;
        }

        await refreshShifts();
        renderBuilder();
        showToast(`Concept gedeactiveerd. ${response.shiftsDeleted || 0} shifts verwijderd.`, 'success');
    } catch (err) {
        console.error('Error deactivating draft:', err);
        showToast('Fout bij deactiveren: ' + err.message, 'error');
    } finally {
        hideSectionLoading('builder-view');
    }
}

async function applyBuilderDraft(draftId) {
    if (AppState._applyingDraft) return;
    AppState._applyingDraft = true;

    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) { AppState._applyingDraft = false; return; }

    const isVakantie = draft.type === 'vakantie';

    // Vakantieconcept: simplified apply flow
    if (isVakantie) {
        const hp = (DataStore.settings.holidayPeriods || []).find(p => String(p.id) === String(draft.holidayPeriodId));
        if (!hp) {
            showToast('Gekoppelde vakantieperiode niet gevonden', 'error');
            return;
        }
        const fromStr = parseDateOnly(hp.startDate).toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });
        const untilStr = parseDateOnly(hp.endDate).toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });

        const draftGrid = draft.grid || {};
        const empIds = new Set();
        if (draftGrid._multiWeek) {
            for (const [k, wg] of Object.entries(draftGrid)) {
                if (!k.startsWith('_')) Object.keys(wg).forEach(id => empIds.add(id));
            }
        } else {
            Object.keys(draftGrid).filter(k => !k.startsWith('_')).forEach(id => empIds.add(id));
        }

        const confirmed = await showConfirm(
            `Vakantieconcept "${draft.name}" toepassen?\n\n` +
            `Periode: ${fromStr} – ${untilStr}\n` +
            `${empIds.size} medewerkers krijgen een vakantie-shift.\n` +
            `Overige medewerkers krijgen GEEN shift tijdens deze periode.`,
            'Vakantieconcept toepassen'
        );
        if (!confirmed) { AppState._applyingDraft = false; return; }

        showSectionLoading('planning-view', 'Vakantieconcept toepassen...');
        try {
            let result = await applyScheduleDraft(draftId, { clearBlocks: true });

            // Handmatige wijzigingen detectie
            if (result.needsManualConfirmation) {
                hideSectionLoading('planning-view');
                const overwrite = await showConfirm(
                    `Er zijn ${result.manualShiftCount} handmatige diensten in de vakantieperiode.\n\nOK — Alles verwijderen (handmatige aanpassingen gaan verloren)\nAnnuleren — Alleen automatische diensten verwijderen`,
                    'Handmatige diensten gevonden'
                );
                showSectionLoading('planning-view', 'Vakantieconcept toepassen...');
                result = await applyScheduleDraft(draftId, { clearBlocks: true, confirmOverwrite: overwrite });
            }

            showToast(`Vakantieconcept "${draft.name}" toegepast (${result.shifts.created} shifts aangemaakt)`, 'success');

            const draftToMark = drafts.find(d => d.id === draftId);
            if (draftToMark) {
                draftToMark.lastAppliedAt = new Date().toISOString();
                draftToMark.lastAppliedBy = AppState.currentUser?.name || 'Onbekend';
                draftToMark.lastAppliedFrom = hp.startDate;
                draftToMark.lastAppliedUntil = hp.endDate;
            }

            await Promise.all([refreshShifts(), fetchShiftBlocks(), refreshActivities()]);
            renderBuilder();
        } catch (error) {
            console.error('Error applying vakantie draft:', error);
            showToast('Fout bij toepassen vakantieconcept: ' + getUserFriendlyError(error), 'error');
        } finally {
            hideSectionLoading('planning-view');
            AppState._applyingDraft = false;
        }
        return;
    }

    // ===== Basisrooster apply flow =====
    const draftGrid = draft.grid || {};
    const isMultiWeek = !!draftGrid._multiWeek;

    // Build list of weeks to apply
    const weeksToApply = [];
    if (isMultiWeek) {
        for (const [key, weekGrid] of Object.entries(draftGrid)) {
            if (key === '_multiWeek') continue;
            weeksToApply.push({ weekNumber: Number(key), grid: weekGrid });
        }
        weeksToApply.sort((a, b) => a.weekNumber - b.weekNumber);
    } else {
        weeksToApply.push({ weekNumber: draft.weekNumber || 1, grid: draftGrid });
    }

    // Build preview of changes for ALL employees (not just those in the grid)
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
    let changesSummary = '';
    let changesCount = 0;

    // Get all affected employees (filtered by team if applicable)
    let allEmployees = draft.teamFilter
        ? getEmployeesByTeam(draft.teamFilter, true)
        : getAllEmployees(true);

    const empIdsInGrid = new Set();
    for (const { grid } of weeksToApply) {
        Object.keys(grid).forEach(id => empIdsInGrid.add(String(id)));
    }

    for (const emp of allEmployees) {
        for (const { weekNumber, grid } of weeksToApply) {
            const empGrid = grid[String(emp.id)] || grid[emp.id];
            const prevSchedule = getEmployeeWeekSchedule(emp, weekNumber) || [];
            let empChanges = [];
            for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
                const newAssignment = empGrid ? empGrid[dayIndex] : null;
                const jsDayOfWeek = dayIndex === 6 ? 0 : dayIndex + 1;
                const oldEntry = prevSchedule.find(e => e.dayOfWeek === jsDayOfWeek && e.enabled);
                const hasNew = !!newAssignment;
                const hasOld = !!oldEntry;
                if (hasNew && !hasOld) {
                    empChanges.push(`${dayNames[dayIndex]}: + ${newAssignment.startTime}-${newAssignment.endTime}`);
                } else if (!hasNew && hasOld) {
                    empChanges.push(`${dayNames[dayIndex]}: verwijderd`);
                } else if (hasNew && hasOld && (oldEntry.startTime !== newAssignment.startTime || oldEntry.endTime !== newAssignment.endTime)) {
                    empChanges.push(`${dayNames[dayIndex]}: ${oldEntry.startTime}-${oldEntry.endTime} -> ${newAssignment.startTime}-${newAssignment.endTime}`);
                }
            }
            if (empChanges.length > 0) {
                changesCount++;
                if (changesCount <= 8) {
                    const weekPrefix = isMultiWeek ? `[W${weekNumber}] ` : '';
                    changesSummary += `\n${weekPrefix}${emp.name}: ${empChanges.join(', ')}`;
                }
            }
        }
    }
    if (changesCount > 8) changesSummary += `\n... en ${changesCount - 8} meer`;
    if (changesCount === 0) changesSummary = '\nGeen wijzigingen gevonden.';

    const weekLabel = weeksToApply.length > 1
        ? `week ${weeksToApply.map(w => w.weekNumber).join(' & ')}`
        : `week ${weeksToApply[0].weekNumber}`;

    // Show apply modal with editable dates + changes preview
    const applyResult = await showDraftApplyModal(draft, weekLabel, changesCount, allEmployees.length, changesSummary);
    if (!applyResult) { AppState._applyingDraft = false; return; }

    showSectionLoading('planning-view', 'Concept toepassen...');
    try {
        // Single atomic backend call: generates shifts from concept grid + marks draft
        let result = await applyScheduleDraft(draftId, {
            clearBlocks: true,
            applyStartDate: applyResult.startDate,
            applyEndDate: applyResult.endDate
        });

        // Overlap detectie — ander actief concept overlapt
        if (result.needsOverlapConfirmation) {
            hideSectionLoading('planning-view');
            const overlaps = result.overlappingDrafts;
            const overlapNames = overlaps.map(d => `"${d.name}" (${d.from} → ${d.until})`).join('\n• ');
            const confirmed = await showConfirm(
                `De volgende actieve concepten overlappen met deze periode:\n\n• ${overlapNames}\n\nDeze concepten worden ingekort tot ${result.newStartDate}. Doorgaan?`,
                'Concepten overlappen'
            );
            if (!confirmed) { AppState._applyingDraft = false; return; }
            showSectionLoading('planning-view', 'Concept toepassen...');
            result = await applyScheduleDraft(draftId, {
                clearBlocks: true,
                applyStartDate: applyResult.startDate,
                applyEndDate: applyResult.endDate,
                confirmOverlap: true
            });
        }

        // Handmatige wijzigingen detectie
        if (result.needsManualConfirmation) {
            hideSectionLoading('planning-view');
            const overwrite = await showConfirm(
                `Er zijn ${result.manualShiftCount} diensten die handmatig zijn aangepast (bijv. geruild, tijden gewijzigd of handmatig toegevoegd).\n\nWat wil je doen?\n\n• OK — Alles overschrijven met het concept (handmatige aanpassingen gaan verloren)\n• Annuleren — Alleen automatische diensten vervangen, handmatige aanpassingen behouden`,
                'Handmatige diensten gevonden'
            );
            showSectionLoading('planning-view', 'Concept toepassen...');
            result = await applyScheduleDraft(draftId, {
                clearBlocks: true,
                applyStartDate: applyResult.startDate,
                applyEndDate: applyResult.endDate,
                confirmOverlap: true,
                confirmOverwrite: overwrite
            });
        }

        if (result.scheduled) {
            // Future draft — saved as scheduled, not applied yet
            const vfDate = new Date(result.validFrom).toLocaleDateString('nl-BE');
            showToast(`Concept "${result.draftName}" ingepland vanaf ${vfDate}`, 'success');
            renderBuilder();
            return;
        }

        showToast(`Basisrooster ${weekLabel} toegepast voor ${result.applied} medewerkers (${result.shifts.created} shifts aangemaakt)`, 'success');

        // Update local draft cache with applied dates
        const draftToMark = (DataStore.settings.schedule_drafts || []).find(d => d.id === draftId);
        if (draftToMark) {
            draftToMark.lastAppliedAt = new Date().toISOString();
            draftToMark.lastAppliedBy = AppState.currentUser?.name || 'Onbekend';
            draftToMark.lastAppliedFrom = applyResult.startDate;
            draftToMark.lastAppliedUntil = applyResult.endDate;
        }

        // Auto-update school year start for week numbering
        await saveSchoolYearStart(applyResult.startDate);

        // Apply pattern + rotation from draft globally (date-aware)
        {
            const applyGrid = draft.grid || {};
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const applyFromDate = parseDateOnly(applyResult.startDate);

            if (applyGrid._pattern) {
                const currentPattern = getSchedulePattern();
                // Auto-set referentiedatum op maandag van apply-from datum
                const applyMonday = getMonday(applyFromDate);
                const autoRefDate = formatDateYYYYMMDD(applyMonday);

                let newPatternSetting;

                if (applyFromDate > today) {
                    newPatternSetting = {
                        ...applyGrid._pattern,
                        referenceDate: autoRefDate,
                        effectiveFrom: applyResult.startDate,
                        previousPattern: {
                            cycleLength: currentPattern.cycleLength,
                            referenceDate: currentPattern.referenceDate,
                            weeks: currentPattern.weeks
                        }
                    };
                } else {
                    newPatternSetting = { ...applyGrid._pattern, referenceDate: autoRefDate };
                    delete newPatternSetting.effectiveFrom;
                    delete newPatternSetting.previousPattern;
                }

                await saveSettings('schedule_pattern', newPatternSetting);
                DataStore.settings.schedulePattern = newPatternSetting;
                DataStore.settings.biWeeklyReferenceDate = applyGrid._pattern.referenceDate;

                saveToStorage();
            }
        }
        // Rotation is managed via Settings > Planning, not per concept

        await Promise.all([refreshShifts(), fetchShiftBlocks(), refreshUsers(), refreshActivities()]);
        renderBuilder();
    } catch (error) {
        console.error('Error applying builder draft:', error);
        showToast('Fout bij toepassen concept: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('planning-view');
        AppState._applyingDraft = false;
    }
}

function showDraftApplyModal(draft, weekLabel, changesCount, empCount, changesSummary) {
    // Default dates: pre-fill from last applied, then draft validity, then school year defaults
    const now = new Date();
    let defaultStart, defaultEnd;
    if (draft.lastAppliedFrom && draft.lastAppliedUntil) {
        // Previously applied: use same period
        defaultStart = draft.lastAppliedFrom;
        defaultEnd = draft.lastAppliedUntil;
    } else if (draft.validFrom && draft.validUntil) {
        defaultStart = draft.validFrom;
        defaultEnd = draft.validUntil;
    } else {
        // Smart default: Sept 1 → Aug 31 of current school year
        const septYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
        defaultStart = `${septYear}-09-01`;
        defaultEnd = `${septYear + 1}-08-31`;
    }

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        // Preset date calculations
        const syStart = getSchoolYearStart();
        const syStartDate = parseDateOnly(syStart);
        const septYear = syStartDate.getFullYear();
        const presetSchoolStart = `${septYear}-09-01`;
        const presetSchoolEnd = `${septYear + 1}-08-31`;
        const presetTodayStr = formatDateYYYYMMDD(now);

        overlay.className = 'modal';
        overlay.innerHTML = `
            <div class="modal-content modal-content--md">
                <div class="modal-header">
                    <h2>Concept toepassen</h2>
                    <span class="modal-close" id="draft-apply-close"><i data-lucide="x"></i></span>
                </div>
                <div class="modal-body">
                    <p style="margin:0 0 12px"><strong>${escapeHtml(draft.name)}</strong> toepassen als basisrooster ${weekLabel}?</p>
                    <div class="apply-presets" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="${presetSchoolStart}" data-end="${presetSchoolEnd}">Dit schooljaar (sep – aug)</button>
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="${presetTodayStr}" data-end="${presetSchoolEnd}">Vanaf nu tot aug</button>
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="" data-end="">Aangepaste periode</button>
                    </div>
                    <div class="form-row" style="gap:12px">
                        <div class="form-group flex-1">
                            <label>Van</label>
                            <input type="date" id="draft-apply-start-date" class="form-input" value="${defaultStart}" required>
                        </div>
                        <div class="form-group flex-1">
                            <label>Tot</label>
                            <input type="date" id="draft-apply-end-date" class="form-input" value="${defaultEnd}" required>
                        </div>
                    </div>
                    <span class="form-hint" style="display:block;margin-top:4px">Shifts worden alleen gegenereerd binnen deze periode. Bestaande shifts buiten deze periode blijven ongewijzigd.</span>
                    <div class="code-block">Wijzigingen voor ${changesCount} van ${empCount} medewerkers:${escapeHtml(changesSummary)}</div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary btn-sm" id="draft-apply-cancel">Annuleren</button>
                    <button class="btn btn-primary btn-sm" id="draft-apply-confirm">Toepassen</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        IconHelper.init(overlay);

        function cleanup() {
            overlay.remove();
        }

        // Preset button handlers
        overlay.querySelectorAll('.apply-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const startInput = overlay.querySelector('#draft-apply-start-date');
                const endInput = overlay.querySelector('#draft-apply-end-date');
                if (btn.dataset.start && btn.dataset.end) {
                    startInput.value = btn.dataset.start;
                    endInput.value = btn.dataset.end;
                } else {
                    // "Aangepaste periode" — clear and focus
                    startInput.value = '';
                    endInput.value = '';
                    startInput.focus();
                }
            });
        });

        overlay.querySelector('#draft-apply-confirm').addEventListener('click', () => {
            const startDate = overlay.querySelector('#draft-apply-start-date').value;
            const endDate = overlay.querySelector('#draft-apply-end-date').value;
            if (!startDate || !endDate) {
                showToast('Vul beide datums in', 'warning');
                return;
            }
            if (startDate >= endDate) {
                showToast('Startdatum moet voor einddatum liggen', 'warning');
                return;
            }
            cleanup();
            resolve({ startDate, endDate });
        });

        overlay.querySelector('#draft-apply-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
        overlay.querySelector('#draft-apply-close').addEventListener('click', () => { cleanup(); resolve(null); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
    });
}

function showReapplyAfterEditModal(draftName) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal';
        overlay.innerHTML = `
            <div class="modal-content modal-content--xs">
                <div class="modal-header">
                    <h2>Wijzigingen toepassen?</h2>
                    <span class="modal-close" id="reapply-close"><i data-lucide="x"></i></span>
                </div>
                <div class="modal-body">
                    <p style="margin:0 0 8px">Het concept <strong>"${escapeHtml(draftName)}"</strong> is momenteel actief.</p>
                    <p>Wil je de wijzigingen nu toepassen op het rooster?</p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary btn-sm" id="reapply-no">Nee, later</button>
                    <button class="btn btn-primary btn-sm" id="reapply-yes">Ja, toepassen</button>
                </div>
            </div>`;

        document.body.appendChild(overlay);
        IconHelper.init(overlay);
        function cleanup() { overlay.remove(); }

        overlay.querySelector('#reapply-yes').addEventListener('click', () => { cleanup(); resolve(true); });
        overlay.querySelector('#reapply-no').addEventListener('click', () => { cleanup(); resolve(false); });
        overlay.querySelector('#reapply-close').addEventListener('click', () => { cleanup(); resolve(false); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
    });
}

// --- Builder: Helpers ---

function calculateBuilderShiftHours(assignment) {
    return calculateShiftHours({
        date: '2026-01-01',
        startTime: assignment.startTime,
        endTime: assignment.endTime
    });
}

function getTemplateNameForTimes(startTime, endTime) {
    const templates = DataStore.settings.shiftTemplates || {};
    const match = Object.entries(templates).find(([key, t]) =>
        t.start === startTime && t.end === endTime
    );
    if (match) return match[1].name;
    return `${startTime}-${endTime}`;
}

function calcHoursBetweenTwoAssignments(shift1, shift2) {
    // Assumes consecutive days
    const [eh, em] = shift1.endTime.split(':').map(Number);
    const [sh, sm] = shift1.startTime.split(':').map(Number);

    let endHour = eh + em / 60;
    const startHour = sh + sm / 60;
    // Overnight shift
    if (endHour <= startHour) endHour += 24;

    const [s2h, s2m] = shift2.startTime.split(':').map(Number);
    const nextStartHour = 24 + s2h + s2m / 60; // next day

    return nextStartHour - endHour;
}

function downloadBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    // Build export object with relevant data
    const exportData = {
        name: draft.name,
        weekNumber: draft.weekNumber,
        teamFilter: draft.teamFilter,
        grid: draft.grid,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
        lastAppliedFrom: draft.lastAppliedFrom,
        lastAppliedUntil: draft.lastAppliedUntil,
        exportedAt: new Date().toISOString()
    };

    // Resolve employee names in grid for readability
    const gridCopy = JSON.parse(JSON.stringify(draft.grid || {}));
    const resolveNames = (weekGrid) => {
        Object.keys(weekGrid).forEach(key => {
            if (key.startsWith('_')) return;
            const emp = getEmployee(Number(key));
            if (emp) weekGrid[key]._employeeName = emp.name;
        });
    };
    if (gridCopy._multiWeek) {
        Object.keys(gridCopy).filter(k => !k.startsWith('_')).forEach(w => resolveNames(gridCopy[w]));
    } else {
        resolveNames(gridCopy);
    }
    exportData.grid = gridCopy;

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `concept-${draft.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Concept gedownload', 'success');
}

function uploadBuilderDraft() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.grid || !data.name) {
                showToast('Ongeldig concept bestand', 'error');
                return;
            }
            // Strip _employeeName fields added during export
            const cleanGrid = JSON.parse(JSON.stringify(data.grid));
            const stripNames = (weekGrid) => {
                Object.keys(weekGrid).forEach(key => {
                    if (key.startsWith('_')) return;
                    if (weekGrid[key] && weekGrid[key]._employeeName) delete weekGrid[key]._employeeName;
                });
            };
            if (cleanGrid._multiWeek) {
                Object.keys(cleanGrid).filter(k => !k.startsWith('_')).forEach(w => stripNames(cleanGrid[w]));
            } else {
                stripNames(cleanGrid);
            }

            // Check name uniqueness, append suffix if needed
            const drafts = DataStore.settings.schedule_drafts || [];
            let name = data.name;
            let counter = 1;
            while (drafts.some(d => d.name.trim().toLowerCase() === name.trim().toLowerCase())) {
                counter++;
                name = `${data.name} (${counter})`;
            }

            const draftData = {
                name,
                weekNumber: data.weekNumber || 1,
                teamFilter: data.teamFilter || null,
                grid: cleanGrid
            };

            if (DataStore._draftsFromTable) {
                await createScheduleDraft(draftData);
            } else {
                draftData.id = 'draft_' + Date.now();
                draftData.createdAt = new Date().toISOString();
                draftData.updatedAt = new Date().toISOString();
                drafts.push(draftData);
                await saveSettings('schedule_drafts', drafts);
            }
            await refreshSettings();
            renderBuilder();
            showToast(`Concept "${name}" geïmporteerd`, 'success');
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Fout bij importeren: ongeldig bestand', 'error');
        }
    });
    input.click();
}

// --- Builder: Event Listeners ---

function attachBuilderOverviewListeners(container) {
    // Filter dropdown
    const filterSelect = document.getElementById('builder-overview-filter');
    if (filterSelect) {
        filterSelect.addEventListener('change', (e) => {
            AppState.builderOverviewFilter = e.target.value;
            renderBuilder();
        });
    }

    // Upload concept button
    const uploadBtn = document.getElementById('builder-upload-concept');
    if (uploadBtn) {
        uploadBtn.addEventListener('click', () => uploadBuilderDraft());
    }

    // New concept card (dashed) — show type selection modal
    const newConceptCard = document.getElementById('builder-new-concept-card');
    if (newConceptCard) {
        newConceptCard.addEventListener('click', () => {
            showNewConceptTypeModal();
        });
    }

    // Card action buttons
    container.querySelectorAll('.concept-card-load, .concept-card-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            AppState.builderScreen = 'editor';
            loadBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.concept-card-apply').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applyBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.concept-card-rename').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            renameBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.concept-card-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.concept-card-deactivate').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deactivateBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.concept-card-download').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            downloadBuilderDraft(btn.dataset.draftId);
        });
    });

    // Kebab menu toggle
    container.querySelectorAll('.concept-card-menu-trigger').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = btn.closest('.concept-card-menu');
            const wasOpen = menu.classList.contains('open');
            // Sluit alle open menus
            document.querySelectorAll('.concept-card-menu.open').forEach(m => m.classList.remove('open'));
            if (!wasOpen) {
                menu.classList.add('open');
                // Sluit bij volgende klik ergens
                setTimeout(() => {
                    document.addEventListener('click', function closeMenu() {
                        menu.classList.remove('open');
                        document.removeEventListener('click', closeMenu);
                    }, { once: true });
                }, 0);
            }
        });
    });
}

function attachBuilderEventListeners(container) {
    // Back to overview button
    const backBtn = document.getElementById('builder-back-to-overview');
    if (backBtn) {
        backBtn.addEventListener('click', async () => {
            if (AppState.builderIsDirty) {
                const ok = await showConfirm('Je hebt onopgeslagen wijzigingen. Wil je terug zonder op te slaan?');
                if (!ok) return;
            }
            AppState.builderScreen = 'overview';
            renderBuilder();
        });
    }

    // Week toggle buttons (dynamic based on builder cycle length)
    const cycleLen = getBuilderCycleLength();
    for (let w = 1; w <= cycleLen; w++) {
        const btn = document.getElementById(`builder-week-${w}`);
        if (btn) btn.addEventListener('click', (e) => {
            // Check if × button was clicked
            if (e.target.classList.contains('builder-week-remove')) {
                e.stopPropagation();
                removeBuilderWeek(parseInt(e.target.dataset.week));
                return;
            }
            switchBuilderWeek(w);
        });
    }
    // Add week button
    const addWeekBtn = document.getElementById('builder-add-week');
    if (addWeekBtn) addWeekBtn.addEventListener('click', addBuilderWeek);

    // Day header toggle (open/closed)
    container.querySelectorAll('.builder-day-toggle').forEach(header => {
        header.addEventListener('click', () => {
            const jsDow = parseInt(header.dataset.jsdow);
            if (!isNaN(jsDow)) toggleBuilderClosedDay(jsDow);
        });
    });

    // Vakantie verantwoordelijke picker (per week)
    const vakantieRespSelect = document.getElementById('builder-vakantie-responsible');
    if (vakantieRespSelect) {
        vakantieRespSelect.addEventListener('change', async (e) => {
            const periodId = AppState.builderHolidayPeriodId;
            if (!periodId) return;
            const weekNum = parseInt(e.target.dataset.week) || AppState.builderWeekNumber;
            await setHolidayWeekResponsible(periodId, weekNum, e.target.value);
        });
    }

    // Staffing editor toggle
    const staffingToggle = document.getElementById('builder-staffing-toggle');
    if (staffingToggle) {
        staffingToggle.addEventListener('click', () => {
            AppState.builderShowStaffingEditor = !AppState.builderShowStaffingEditor;
            renderBuilder();
        });
    }

    // Staffing editor: add rule per day column
    container.querySelectorAll('.staffing-rule-add').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            if (!AppState.builderStaffingRules[day]) AppState.builderStaffingRules[day] = [];
            if (!Array.isArray(AppState.builderStaffingRules[day])) AppState.builderStaffingRules[day] = [];
            AppState.builderStaffingRules[day].push({ from: 7, to: 17, min: 1 });
            AppState.builderIsDirty = true;
            renderBuilder();
        });
    });

    // Staffing editor: remove rule
    container.querySelectorAll('.staffing-rule-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const day = parseInt(btn.dataset.day);
            const idx = parseInt(btn.dataset.idx);
            if (Array.isArray(AppState.builderStaffingRules[day])) {
                AppState.builderStaffingRules[day].splice(idx, 1);
                if (AppState.builderStaffingRules[day].length === 0) delete AppState.builderStaffingRules[day];
            }
            AppState.builderIsDirty = true;
            renderBuilder();
        });
    });

    // Staffing editor: change from/to/min → re-render heatmap
    container.querySelectorAll('.staffing-from, .staffing-to, .staffing-min-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const day = parseInt(e.target.dataset.day);
            const idx = parseInt(e.target.dataset.idx);
            if (!Array.isArray(AppState.builderStaffingRules[day])) return;
            const rule = AppState.builderStaffingRules[day][idx];
            if (!rule) return;
            if (e.target.classList.contains('staffing-from')) rule.from = parseFloat(e.target.value);
            else if (e.target.classList.contains('staffing-to')) rule.to = parseFloat(e.target.value);
            else rule.min = Math.max(0, parseInt(e.target.value) || 0);
            AppState.builderIsDirty = true;
            renderBuilder();
        });
    });

    // Staffing editor: copy to all weeks
    const copyAllBtn = document.getElementById('staffing-copy-all-weeks');
    if (copyAllBtn) {
        copyAllBtn.addEventListener('click', () => {
            const cl = getBuilderCycleLength();
            const current = JSON.parse(JSON.stringify(AppState.builderStaffingRules));
            for (let w = 1; w <= cl; w++) {
                AppState.builderStaffingRulesByWeek[w] = JSON.parse(JSON.stringify(current));
            }
            AppState.builderIsDirty = true;
            showToast(`Bezettingsregels gekopieerd naar alle ${cl} weken`, 'success');
        });
    }

    // Staffing editor: clear all
    const clearAllBtn = document.getElementById('staffing-clear-all');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            AppState.builderStaffingRules = {};
            AppState.builderIsDirty = true;
            renderBuilder();
        });
    }

    // Meetings editor toggle
    const meetingsToggle = document.getElementById('builder-meetings-toggle');
    if (meetingsToggle) {
        meetingsToggle.addEventListener('click', () => {
            AppState.builderShowMeetingsEditor = !AppState.builderShowMeetingsEditor;
            renderBuilder();
        });
    }

    // Meetings editor: add meeting per team
    container.querySelectorAll('.meeting-rule-add').forEach(btn => {
        btn.addEventListener('click', () => {
            const teamId = btn.dataset.team;
            if (!AppState.builderMeetings) AppState.builderMeetings = {};
            if (!AppState.builderMeetings[teamId]) AppState.builderMeetings[teamId] = [];
            AppState.builderMeetings[teamId].push({ day: 0, from: 9, to: 11 });
            AppState.builderIsDirty = true;
            renderBuilder();
        });
    });

    // Meetings editor: remove meeting
    container.querySelectorAll('.meeting-rule-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const teamId = btn.dataset.team;
            const idx = parseInt(btn.dataset.idx);
            if (AppState.builderMeetings?.[teamId]) {
                AppState.builderMeetings[teamId].splice(idx, 1);
                if (AppState.builderMeetings[teamId].length === 0) delete AppState.builderMeetings[teamId];
                AppState.builderIsDirty = true;
                renderBuilder();
            }
        });
    });

    // Meetings editor: change day/from/to
    container.querySelectorAll('.meeting-day, .meeting-from, .meeting-to').forEach(input => {
        input.addEventListener('change', (e) => {
            const teamId = e.target.dataset.team;
            const idx = parseInt(e.target.dataset.idx);
            const meetings = AppState.builderMeetings;
            if (!meetings?.[teamId]?.[idx]) return;
            const m = meetings[teamId][idx];
            if (e.target.classList.contains('meeting-day')) m.day = parseInt(e.target.value);
            else if (e.target.classList.contains('meeting-from')) m.from = parseFloat(e.target.value);
            else if (e.target.classList.contains('meeting-to')) m.to = parseFloat(e.target.value);
            AppState.builderIsDirty = true;
            renderBuilder();
        });
    });

    // Team filter
    const teamSelect = document.getElementById('builder-team-select');
    if (teamSelect) {
        teamSelect.addEventListener('change', (e) => {
            AppState.builderTeamFilter = e.target.value || null;
            AppState.builderGrid = {};
            AppState.builderGridByWeek = {};
            AppState.builderStaffingRules = {};
            AppState.builderStaffingRulesByWeek = {};
            AppState.builderMeetings = {};
            AppState.builderIsDirty = false;
            renderBuilder();
        });
    }

    // Load buttons
    const loadBase = document.getElementById('builder-load-base');
    if (loadBase) loadBase.addEventListener('click', loadBuilderFromBaseSchedules);

    const loadBlank = document.getElementById('builder-load-blank');
    if (loadBlank) loadBlank.addEventListener('click', () => {
        AppState.builderGrid = {};
        AppState.builderGridByWeek = {};
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderMeetings = {};
        AppState.builderLoadedDraftId = null;
        AppState.builderLoadedDraftName = null;
        // Reset naar 1 week, alle dagen open
        AppState.builderPattern = {
            cycleLength: 1,
            referenceDate: getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate || '',
            weeks: { '1': { closedDays: [], label: 'alle dagen open' } }
        };
        AppState.builderConceptType = 'basis';
        AppState.builderHolidayPeriodId = null;
            AppState.builderIsDirty = false;
        renderBuilder();
        showToast('Grid leeggemaakt', 'info');
    });

    // Builder drag & drop (handles click, transfer, resize)
    if (typeof BuilderDragHandler !== 'undefined') {
        BuilderDragHandler.init();
    }

    // Save draft button
    const saveDraftBtn = document.getElementById('builder-save-draft');
    if (saveDraftBtn) saveDraftBtn.addEventListener('click', saveBuilderDraft);

    // Save As button (only visible when a draft is loaded)
    const saveDraftAsBtn = document.getElementById('builder-save-draft-as');
    if (saveDraftAsBtn) saveDraftAsBtn.addEventListener('click', saveBuilderDraftAs);

    // Draft action buttons (load, apply, delete)
    container.querySelectorAll('.builder-draft-rename').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            renameBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.builder-draft-load').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            loadBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.builder-draft-apply').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applyBuilderDraft(btn.dataset.draftId);
        });
    });
    container.querySelectorAll('.builder-draft-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteBuilderDraft(btn.dataset.draftId);
        });
    });
}

function switchBuilderWeek(weekNumber) {
    if (weekNumber === AppState.builderWeekNumber) return;

    // Save current week's grid + staffing rules to cache
    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));
    AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderStaffingRules));

    // Switch to new week
    AppState.builderWeekNumber = weekNumber;

    // Restore from cache or start empty
    if (AppState.builderGridByWeek[weekNumber]) {
        AppState.builderGrid = JSON.parse(JSON.stringify(AppState.builderGridByWeek[weekNumber]));
    } else {
        AppState.builderGrid = {};
    }
    AppState.builderStaffingRules = AppState.builderStaffingRulesByWeek[weekNumber]
        ? JSON.parse(JSON.stringify(AppState.builderStaffingRulesByWeek[weekNumber]))
        : {};

    renderBuilder();
}

// ===== END ROOSTERBOUWER =====

// Settings tab configuration: role-based visibility
const SETTINGS_TAB_CONFIG = [
    { id: 'accounts', label: 'Accounts', roles: ['admin'] },
    { id: 'teams', label: 'Teams & Diensten', roles: ['admin', 'roosterverantwoordelijke'] },
    { id: 'planning', label: 'Planning', roles: ['admin', 'roosterverantwoordelijke'] },
    { id: 'communicatie', label: 'Communicatie', roles: ['admin', 'roosterverantwoordelijke'] },
    { id: 'beheer', label: 'Beheer', roles: ['admin'] }
];

function renderSettings() {
    const role = getEffectiveRole();
    const allowedTabs = SETTINGS_TAB_CONFIG.filter(t => t.roles.includes(role));

    // If current tab is not allowed for this role, reset to first allowed
    if (!allowedTabs.find(t => t.id === AppState.activeSettingsTab)) {
        AppState.activeSettingsTab = allowedTabs[0]?.id || 'teams';
    }

    // Dynamically render tab buttons
    const tabsContainer = document.getElementById('settings-tabs');
    if (tabsContainer) {
        tabsContainer.innerHTML = allowedTabs.map(t =>
            `<button class="settings-tab ${t.id === AppState.activeSettingsTab ? 'active' : ''}" data-settings-tab="${t.id}">${t.label}</button>`
        ).join('');
    }

    // Setup tab click listeners
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => switchSettingsTab(tab.dataset.settingsTab);
    });

    // Scroll active tab into view
    const activeTab = document.querySelector('.settings-tab.active');
    if (activeTab) {
        setTimeout(() => {
            activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }, 100);
    }

    // Render the active tab content
    renderSettingsTabContent(AppState.activeSettingsTab);
}

async function switchSettingsTab(tabName) {
    if (AppState.settingsDirty && tabName !== AppState.activeSettingsTab) {
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in deze tab. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        AppState.settingsDirty = false;
    }
    AppState.activeSettingsTab = tabName;

    // Track onboarding: mark planning tab as visited
    if (tabName === 'planning' && AppState.currentUser && !AppState.currentUser.onboardingFlags?.planning_visited) {
        fetch(`${API}/me/onboarding-flags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem('token')}` },
            body: JSON.stringify({ planning_visited: true })
        }).catch(e => console.error('Failed to save onboarding flag:', e));
        if (!AppState.currentUser.onboardingFlags) AppState.currentUser.onboardingFlags = {};
        AppState.currentUser.onboardingFlags.planning_visited = true;
    }

    document.querySelectorAll('.settings-tab').forEach(tab => {
        const isActive = tab.dataset.settingsTab === tabName;
        tab.classList.toggle('active', isActive);
        // Scroll active tab into view on mobile
        if (isActive) {
            tab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    });
    renderSettingsTabContent(tabName);
}

function renderSettingsTabContent(tabName) {
    const content = document.getElementById('settings-tab-content');
    if (!content) return;

    switch (tabName) {
        case 'accounts':
            renderSettingsAccounts(content);
            break;
        case 'planning':
            renderSettingsPlanning(content);
            break;
        case 'teams':
            renderSettingsTeams(content);
            break;
        case 'communicatie':
            renderSettingsEmail(content);
            break;
        case 'beheer':
            renderSettingsBeheer(content);
            break;
        default:
            content.innerHTML = '<p>Ongeldige tab</p>';
    }
    IconHelper.init(content);
    // Track unsaved changes for all settings tabs with form inputs
    if (['planning', 'teams', 'communicatie'].includes(tabName)) {
        trackSettingsDirty(content);
    }
}

function getRoleDescription(role) {
    const descriptions = {
        'medewerker': 'Kan eigen rooster bekijken, diensten ruilen en verlof aanvragen.',
        'roosterverantwoordelijke': 'Kan alle diensten, medewerkers en roosters van alle teams beheren.',
        'admin': 'Volledige toegang inclusief accountbeheer, instellingen en systeembeheer.'
    };
    return descriptions[role] || '';
}

function trackSettingsDirty(container) {
    AppState.settingsDirty = false;
    container.addEventListener('input', () => { AppState.settingsDirty = true; }, true);
    container.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') {
            AppState.settingsDirty = true;
        }
    }, true);
}

function markSettingsSaved() {
    AppState.settingsDirty = false;
}

// ===== SETTINGS TAB: ACCOUNTS =====
function renderSettingsAccounts(container) {
    const role = getEffectiveRole();

    if (role !== 'admin') {
        container.innerHTML = `
            <div class="settings-card">
                <div class="settings-card-body">
                    <div class="info-box neutral">
                        <p>Je hebt geen toegang tot accountbeheer.</p>
                        <p>Neem contact op met een administrator als je toegang nodig hebt.</p>
                    </div>
                </div>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="settings-card" id="settings-accounts">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Accountbeheer</h3>
                    <p class="settings-card-subtitle">Gebruikers, rollen en reset wachtwoorden.</p>
                </div>
                <button type="button" class="btn btn-primary" id="add-user-btn">+ Nieuwe gebruiker</button>
            </div>
            <div class="settings-card-body">
                <div class="admin-users-intro">
                    <p>Beheer rollen en teams per gebruiker. Gebruik "Reset wachtwoord" enkel wanneer nodig.</p>
                </div>
                <div class="admin-filter-bar">
                    <input type="text" id="admin-user-search" class="form-input" placeholder="Zoek op naam of email" />
                    <select id="admin-team-filter" class="form-input">
                        <option value="">Alle teams</option>
                    </select>
                    <select id="admin-status-filter" class="form-input">
                        <option value="active" selected>Actief</option>
                        <option value="inactive">Inactief</option>
                        <option value="">Alle</option>
                    </select>
                </div>
                <div id="admin-users-list">Laden...</div>
            </div>
        </div>
    `;

    // Load and render admin users
    loadAdminUsers(container);
}

async function loadAdminUsers(container) {
    try {
        const teams = await ensureTeamsLoaded();
        const data = await apiFetch('/admin/users');
        const users = data.users || [];

        const teamOptions = ['<option value="">(geen team)</option>']
            .concat(teams.map(team => `<option value="${team.id}">${escapeHtml(team.name)}</option>`))
            .join('');

        const roleOptions = `
            <option value="admin">Admin</option>
            <option value="roosterverantwoordelijke">Roosterverantwoordelijke</option>
            <option value="medewerker">Medewerker</option>
        `;

        const rows = users.map(user => {
            const isInactive = user.active === false;
            return `
            <div class="admin-user-row${isInactive ? ' admin-user-inactive' : ''}" data-user-id="${user.id}" data-name="${escapeHtml(user.name)}" data-email="${escapeHtml(user.email)}" data-team="${user.team_id || ''}" data-role="${user.role}" data-active="${user.active !== false}">
                ${isInactive ? '<span class="status-badge inactive">Inactief</span>' : ''}
                <div class="admin-user-header">
                    <div>
                        <div class="admin-user-name">${escapeHtml(user.name)}</div>
                        <div class="admin-user-email">${escapeHtml(user.email)}</div>
                    </div>
                    <div class="admin-user-header-actions">
                        <div class="admin-user-role-pill">${escapeHtml(user.role)}</div>
                        <button type="button" class="btn btn-sm btn-secondary admin-edit-btn">Bewerken</button>
                    </div>
                </div>
            </div>`;
        }).join('');

        const list = container.querySelector('#admin-users-list');
        list.innerHTML = rows || '<p>Geen accounts gevonden.</p>';
        IconHelper.init(list);

        const teamFilter = container.querySelector('#admin-team-filter');
        if (teamFilter) {
            teamFilter.innerHTML = ['<option value="">Alle teams</option>']
                .concat(teams.map(team => `<option value="${team.id}">${escapeHtml(team.name)}</option>`))
                .join('');
        }

        // Setup event listeners for each user row
        container.querySelectorAll('.admin-user-row').forEach(row => {
            const userId = row.dataset.userId;
            const user = users.find(u => String(u.id) === String(userId));
            if (!user) return;

            // Edit button opens modal
            const editBtn = row.querySelector('.admin-edit-btn');
            if (editBtn) {
                editBtn.addEventListener('click', () => {
                    showEditAccountModal(user, teams, () => {
                        // Callback to refresh the list after save
                        renderSettingsAccounts(document.querySelector('#settings-tab-content'));
                    });
                });
            }
        });

        const applyFilters = () => {
            const searchValue = (container.querySelector('#admin-user-search')?.value || '').toLowerCase().trim();
            const teamValue = container.querySelector('#admin-team-filter')?.value || '';
            const statusValue = container.querySelector('#admin-status-filter')?.value || '';
            container.querySelectorAll('.admin-user-row').forEach(row => {
                const name = (row.dataset.name || '').toLowerCase();
                const email = (row.dataset.email || '').toLowerCase();
                const team = row.dataset.team || '';
                const isActive = row.dataset.active === 'true';
                const matchSearch = !searchValue || name.includes(searchValue) || email.includes(searchValue);
                const matchTeam = !teamValue || team === teamValue;
                const matchStatus = !statusValue || (statusValue === 'active' && isActive) || (statusValue === 'inactive' && !isActive);
                row.classList.toggle('is-hidden', !(matchSearch && matchTeam && matchStatus));
            });
        };

        const searchInput = container.querySelector('#admin-user-search');
        if (searchInput) {
            searchInput.addEventListener('input', applyFilters);
        }
        if (teamFilter) {
            teamFilter.addEventListener('change', applyFilters);
        }
        const statusFilter = container.querySelector('#admin-status-filter');
        if (statusFilter) {
            statusFilter.addEventListener('change', applyFilters);
        }
        // Apply filters on load to hide inactive users by default
        applyFilters();

        // Add user button
        const addUserBtn = container.querySelector('#add-user-btn');
        if (addUserBtn) {
            addUserBtn.addEventListener('click', () => showAddUserModal(teams));
        }
    } catch (error) {
        container.querySelector('#admin-users-list').textContent = `Fout: ${error.message}`;
    }
}

function showAddUserModal(teams) {
    const teamOptions = teams.map(team => `<option value="${team.id}">${escapeHtml(team.name)}</option>`).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'add-user-modal';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content modal-content--sm">
            <div class="modal-header">
                <h2>Nieuwe gebruiker</h2>
                <button class="modal-close" onclick="document.getElementById('add-user-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <form id="add-user-form">
                    <div class="form-group">
                        <label for="new-user-name">Naam</label>
                        <input type="text" id="new-user-name" class="form-input" required />
                    </div>
                    <div class="form-group">
                        <label for="new-user-email">Email</label>
                        <input type="email" id="new-user-email" class="form-input" required />
                    </div>
                    <div class="form-group">
                        <label for="new-user-password">Wachtwoord</label>
                        <input type="password" id="new-user-password" class="form-input" required minlength="6" />
                    </div>
                    <div class="form-group">
                        <label for="new-user-password-confirm">Bevestig wachtwoord</label>
                        <input type="password" id="new-user-password-confirm" class="form-input" required minlength="6" />
                    </div>
                    <div class="form-group">
                        <label for="new-user-role">Rol</label>
                        <select id="new-user-role" class="form-input" required>
                            <option value="medewerker">Medewerker</option>
                            <option value="roosterverantwoordelijke">Roosterverantwoordelijke</option>
                            <option value="admin">Admin</option>
                        </select>
                        <span class="form-hint role-hint" id="new-user-role-hint">${getRoleDescription('medewerker')}</span>
                    </div>
                    <div class="form-group">
                        <label for="new-user-team">Team</label>
                        <select id="new-user-team" class="form-input">
                            <option value="">(geen team)</option>
                            ${teamOptions}
                        </select>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('add-user-modal').remove()">Annuleren</button>
                        <button type="submit" class="btn btn-primary">Aanmaken</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    IconHelper.init(modal);

    // Update role description on change
    const roleSelect = modal.querySelector('#new-user-role');
    const roleHint = modal.querySelector('#new-user-role-hint');
    roleSelect.addEventListener('change', () => {
        roleHint.textContent = getRoleDescription(roleSelect.value);
    });

    const form = modal.querySelector('#add-user-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.querySelector('#new-user-name').value.trim();
        const email = form.querySelector('#new-user-email').value.trim();
        const password = form.querySelector('#new-user-password').value;
        const passwordConfirm = form.querySelector('#new-user-password-confirm').value;
        const role = form.querySelector('#new-user-role').value;
        const team_id = form.querySelector('#new-user-team').value || null;

        // Validate passwords match
        if (password !== passwordConfirm) {
            showToast('Wachtwoorden komen niet overeen. Probeer opnieuw.', 'warning');
            return;
        }

        try {
            const response = await apiFetch('/admin/users', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    email,
                    password,
                    role,
                    team_id,
                    mainTeam: team_id, // Also set mainTeam for schedule/employee grouping
                    employee_id: null
                })
            });
            // Add the new user to the local DataStore cache
            if (response.user) {
                DataStore.users.push(response.user);
            }
            modal.remove();
            showToast('Gebruiker aangemaakt', 'success');
            // Refresh accounts list
            renderSettingsAccounts(document.querySelector('#settings-tab-content'));
        } catch (err) {
            showToast('Fout bij aanmaken: ' + (err.message || 'Onbekende fout'), 'error');
        }
    });
}

function showEditAccountModal(user, teams, onSave) {
    const teamOptions = teams.map(team =>
        `<option value="${team.id}" ${user.team_id === team.id ? 'selected' : ''}>${escapeHtml(team.name)}</option>`
    ).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'edit-account-modal';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content modal-content--md">
            <div class="modal-header">
                <h2>Account bewerken</h2>
                <button class="modal-close" onclick="document.getElementById('edit-account-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body" style="padding: 12px 16px;">
                <form id="edit-account-form">
                    <div class="form-row d-flex gap-10">
                        <div class="form-group flex-1">
                            <label for="edit-user-name">Naam</label>
                            <input type="text" id="edit-user-name" class="form-input" value="${escapeHtml(user.name)}" required />
                        </div>
                        <div class="form-group flex-1">
                            <label for="edit-user-email">Email</label>
                            <input type="email" id="edit-user-email" class="form-input" value="${escapeHtml(user.email)}" required />
                        </div>
                    </div>
                    <div class="form-row d-flex gap-10">
                        <div class="form-group flex-1">
                            <label for="edit-user-role">Rol</label>
                            <select id="edit-user-role" class="form-input" required>
                                <option value="medewerker" ${user.role === 'medewerker' ? 'selected' : ''}>Medewerker</option>
                                <option value="roosterverantwoordelijke" ${user.role === 'roosterverantwoordelijke' ? 'selected' : ''}>Roosterverantw.</option>
                                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                            </select>
                            <span class="form-hint role-hint" id="edit-user-role-hint" style="font-size: 11px;">${getRoleDescription(user.role)}</span>
                        </div>
                        <div class="form-group flex-1">
                            <label for="edit-user-team">Team</label>
                            <select id="edit-user-team" class="form-input">
                                <option value="">(geen team)</option>
                                ${teamOptions}
                            </select>
                        </div>
                    </div>
                    <div class="form-group form-row-inline mb-sm">
                        <label class="toggle-switch flex-shrink-0">
                            <input type="checkbox" id="edit-user-email-notif" ${user.emailNotificationsEnabled !== false ? 'checked' : ''} />
                            <span class="toggle-slider"></span>
                        </label>
                        <label for="edit-user-email-notif" class="text-xs cursor-pointer">Email notificaties</label>
                    </div>
                    <div class="modal-actions modal-actions-split">
                        <div class="modal-actions-left">
                            <button type="button" class="btn btn-danger btn-sm" id="edit-account-delete-btn">${IconHelper.html('trash-2', 'xs')}</button>
                            <button type="button" class="btn btn-secondary btn-sm" id="edit-account-replace-btn">${IconHelper.html('user-round-plus', 'xs')} Vervang</button>
                            <button type="button" class="btn btn-secondary btn-sm" id="edit-account-reset-btn">${IconHelper.html('key-round', 'xs')} Reset ww</button>
                        </div>
                        <button type="submit" class="btn btn-primary btn-sm">Opslaan</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    IconHelper.init(modal);

    // Update role description on change
    const editRoleSelect = modal.querySelector('#edit-user-role');
    const editRoleHint = modal.querySelector('#edit-user-role-hint');
    editRoleSelect.addEventListener('change', () => {
        editRoleHint.textContent = getRoleDescription(editRoleSelect.value);
    });

    const form = modal.querySelector('#edit-account-form');

    // Save form
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newName = form.querySelector('#edit-user-name').value.trim();
        const newEmail = form.querySelector('#edit-user-email').value.trim();
        const newRole = form.querySelector('#edit-user-role').value;
        const newTeamId = form.querySelector('#edit-user-team').value || null;

        if (!newName) {
            showToast('Naam is verplicht', 'warning');
            return;
        }
        if (!newEmail) {
            showToast('Email is verplicht', 'warning');
            return;
        }

        try {
            const emailNotif = form.querySelector('#edit-user-email-notif').checked;
            await apiFetch(`/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    name: newName,
                    email: newEmail,
                    role: newRole,
                    team_id: newTeamId,
                    mainTeam: newTeamId,
                    emailNotificationsEnabled: emailNotif
                })
            });

            // Update local DataStore cache
            const userIndex = DataStore.users.findIndex(u => String(u.id) === String(user.id));
            if (userIndex !== -1) {
                DataStore.users[userIndex] = {
                    ...DataStore.users[userIndex],
                    name: newName,
                    email: newEmail,
                    role: newRole,
                    team_id: newTeamId,
                    mainTeam: newTeamId
                };
            }

            modal.remove();
            showToast('Account bijgewerkt', 'success');
            if (onSave) onSave();
        } catch (error) {
            showToast(`Opslaan mislukt: ${error.message}`, 'error');
        }
    });

    // Reset password button
    modal.querySelector('#edit-account-reset-btn').addEventListener('click', async () => {
        if (!await showConfirm('Wachtwoord resetten naar standaard?')) return;
        try {
            const result = await apiFetch(`/admin/users/${user.id}/reset-password`, {
                method: 'POST'
            });
            const newPw = result.newPassword || '(standaard)';
            showToast(`Wachtwoord gereset naar: ${newPw}`, 'success', 8000);
        } catch (error) {
            showToast(`Reset mislukt: ${error.message}`, 'error');
        }
    });

    // Delete button
    modal.querySelector('#edit-account-delete-btn').addEventListener('click', async () => {
        // Prevent deleting yourself
        if (String(user.id) === String(AppState.currentUser.id)) {
            showToast('Je kunt je eigen account niet verwijderen', 'warning');
            return;
        }

        const confirmMsg = `Weet je zeker dat je het account van "${user.name}" wilt verwijderen?\n\nDit verwijdert ook alle gekoppelde diensten en afwezigheden.\n\nDeze actie kan niet ongedaan worden gemaakt.`;

        if (!await showConfirm(confirmMsg, 'Account verwijderen', { danger: true, confirmText: 'Verwijderen' })) return;

        try {
            await deleteEmployee(Number(user.id));
            modal.remove();
            showToast('Account verwijderd', 'success');
            if (onSave) onSave();
        } catch (error) {
            showToast(`Verwijderen mislukt: ${error.message}`, 'error');
        }
    });

    // Replace button
    modal.querySelector('#edit-account-replace-btn').addEventListener('click', () => {
        modal.remove();
        showReplaceEmployeeModal(user, onSave);
    });
}

function showReplaceEmployeeModal(departingUser, onComplete) {
    const activeUsers = DataStore.users.filter(u =>
        u.active !== false && String(u.id) !== String(departingUser.id)
    );

    if (activeUsers.length === 0) {
        showToast('Geen andere actieve medewerkers beschikbaar', 'warning');
        return;
    }

    const userOptions = activeUsers.map(u =>
        `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.role)})</option>`
    ).join('');

    const today = new Date().toISOString().split('T')[0];

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'replace-employee-modal';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content modal-content--md">
            <div class="modal-header">
                <h2>${IconHelper.html('user-round-plus', 'md')} Medewerker vervangen</h2>
                <button class="modal-close" onclick="document.getElementById('replace-employee-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <div class="info-box neutral" style="margin-bottom: 16px;">
                    <p><strong>${escapeHtml(departingUser.name)}</strong> wordt vervangen. Het basisrooster wordt gekopieerd naar de nieuwe medewerker en ${escapeHtml(departingUser.name)} wordt gedeactiveerd.</p>
                </div>
                <form id="replace-employee-form">
                    <div class="form-group">
                        <label for="replace-new-user">Nieuwe medewerker *</label>
                        <select id="replace-new-user" class="form-input" required>
                            <option value="">-- Kies medewerker --</option>
                            ${userOptions}
                        </select>
                    </div>
                    <div class="form-group form-row-inline">
                        <label class="toggle-switch flex-shrink-0">
                            <input type="checkbox" id="replace-transfer-shifts" />
                            <span class="toggle-slider"></span>
                        </label>
                        <label for="replace-transfer-shifts" class="cursor-pointer">Toekomstige diensten overnemen</label>
                    </div>
                    <div class="form-group" id="replace-date-group" style="display: none;">
                        <label for="replace-from-date">Overnemen vanaf *</label>
                        <input type="date" id="replace-from-date" class="form-input" value="${today}" min="${today}" />
                    </div>
                    <div id="replace-summary" style="display: none; margin-top: 12px;"></div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('replace-employee-modal').remove()">Annuleren</button>
                        <button type="submit" class="btn btn-primary">Vervangen</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    IconHelper.init(modal);

    // Toggle date picker
    const transferCheckbox = modal.querySelector('#replace-transfer-shifts');
    const dateGroup = modal.querySelector('#replace-date-group');
    transferCheckbox.addEventListener('change', () => {
        dateGroup.style.display = transferCheckbox.checked ? '' : 'none';
        updateReplaceSummary();
    });

    // Update summary on changes
    modal.querySelector('#replace-new-user').addEventListener('change', updateReplaceSummary);
    modal.querySelector('#replace-from-date').addEventListener('change', updateReplaceSummary);

    function updateReplaceSummary() {
        const summaryEl = modal.querySelector('#replace-summary');
        const newUserId = modal.querySelector('#replace-new-user').value;
        const newUser = activeUsers.find(u => String(u.id) === String(newUserId));
        const transfer = transferCheckbox.checked;
        const fromDate = modal.querySelector('#replace-from-date').value;

        if (!newUser) {
            summaryEl.style.display = 'none';
            return;
        }

        let summaryHtml = '<div class="info-box warning"><strong>Samenvatting:</strong><ul style="margin: 8px 0 0 0; padding-left: 20px;">';
        summaryHtml += `<li>Basisrooster van <strong>${escapeHtml(departingUser.name)}</strong> wordt gekopieerd naar <strong>${escapeHtml(newUser.name)}</strong></li>`;

        if (transfer && fromDate) {
            const futureShifts = DataStore.shifts.filter(s =>
                String(s.employeeId) === String(departingUser.id) && s.date >= fromDate
            );
            summaryHtml += `<li><strong>${futureShifts.length}</strong> toekomstige diensten worden overgedragen (vanaf ${fromDate})`;
            summaryHtml += `<br><small class="text-muted">Telling op basis van geladen planning — werkelijk aantal kan hoger zijn</small></li>`;
        } else {
            summaryHtml += `<li>Geen diensten overgedragen — pas het actief concept opnieuw toe via Rooster Bouwen</li>`;
        }

        summaryHtml += `<li><strong>${escapeHtml(departingUser.name)}</strong> wordt gedeactiveerd</li>`;
        summaryHtml += '</ul></div>';

        summaryEl.innerHTML = summaryHtml;
        summaryEl.style.display = '';
    }

    // Submit handler
    modal.querySelector('#replace-employee-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const newUserId = modal.querySelector('#replace-new-user').value;
        if (!newUserId) {
            showToast('Selecteer een nieuwe medewerker', 'warning');
            return;
        }

        const transfer = transferCheckbox.checked;
        const fromDate = transfer ? modal.querySelector('#replace-from-date').value : null;

        if (transfer && !fromDate) {
            showToast('Selecteer een datum voor overname', 'warning');
            return;
        }

        const newUser = activeUsers.find(u => String(u.id) === String(newUserId));
        const confirmMsg = `Weet je zeker dat je ${departingUser.name} wilt vervangen door ${newUser.name}?\n\nDeze actie kan niet ongedaan worden gemaakt.`;

        if (!await showConfirm(confirmMsg, 'Medewerker vervangen', { danger: true, confirmText: 'Vervangen' })) return;

        try {
            const result = await replaceEmployee(Number(departingUser.id), Number(newUserId), fromDate);
            modal.remove();

            // Weekendverantwoordelijkheid overerven
            const rotation = DataStore.settings.responsibleRotation;
            if (rotation) {
                let rotationChanged = false;
                // Als vertrekkende medewerker de startpersoon was → vervanger overneemt
                if (String(rotation.rotationStartEmployee) === String(departingUser.id)) {
                    rotation.rotationStartEmployee = String(newUserId);
                    rotationChanged = true;
                }
                // Handmatige toewijzingen overzetten
                if (rotation.assignments) {
                    for (const [dateKey, assignedId] of Object.entries(rotation.assignments)) {
                        if (String(assignedId) === String(departingUser.id)) {
                            rotation.assignments[dateKey] = String(newUserId);
                            rotationChanged = true;
                        }
                    }
                }
                if (rotationChanged) {
                    await saveResponsibleRotationSettings();
                }
            }

            let msg = `${departingUser.name} vervangen door ${newUser.name}`;
            if (result.shiftsTransferred > 0) {
                msg += ` (${result.shiftsTransferred} diensten overgedragen)`;
            }
            if (result.draftsUpdated > 0) {
                msg += ` (${result.draftsUpdated} concept${result.draftsUpdated > 1 ? 'en' : ''} bijgewerkt)`;
            }
            showToast(msg, 'success');

            if (result.hint === 'apply_concept') {
                showToast(`${newUser.name} heeft nog geen diensten. Pas het actief concept opnieuw toe via Rooster Bouwen.`, 'info', 6000);
            }

            if (onComplete) onComplete();
        } catch (error) {
            showToast(`Vervanging mislukt: ${error.message}`, 'error');
        }
    });
}

// ===== SETTINGS TAB: PLANNING =====
function renderSettingsPlanning(container) {
    const rules = DataStore.settings.rules;

    // Check if a holiday period is currently active or upcoming
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const activeHoliday = getHolidayPeriod(todayStr);
    const upcomingHoliday = !activeHoliday ? (DataStore.settings.holidayPeriods || []).find(p => {
        const start = parseDateOnly(p.startDate);
        const diff = (start - today) / (1000 * 60 * 60 * 24);
        return diff > 0 && diff <= 14;
    }) : null;

    const holidayBanner = activeHoliday
        ? `<div class="holiday-status-banner active">
                <span class="holiday-status-icon">${IconHelper.html(ICONS.holiday, 'md')}</span>
                <div class="holiday-status-text">
                    <strong>Vakantiewerking actief: ${escapeHtml(activeHoliday.name)}</strong>
                    <span>${activeHoliday.startDate} t/m ${activeHoliday.endDate}</span>
                </div>
                <a href="#settings-holidays" class="btn btn-sm btn-secondary" onclick="document.getElementById('settings-holidays').scrollIntoView({behavior:'smooth'})">Instellingen</a>
           </div>`
        : upcomingHoliday
        ? `<div class="holiday-status-banner upcoming">
                <span class="holiday-status-icon">${IconHelper.html(ICONS.calendar, 'md')}</span>
                <div class="holiday-status-text">
                    <strong>Komende vakantie: ${escapeHtml(upcomingHoliday.name)}</strong>
                    <span>Start ${upcomingHoliday.startDate}</span>
                </div>
                <a href="#settings-holidays" class="btn btn-sm btn-secondary" onclick="document.getElementById('settings-holidays').scrollIntoView({behavior:'smooth'})">Instellingen</a>
           </div>`
        : '';

    container.innerHTML = `
        ${holidayBanner}
        <!-- Planning regels -->
        <div class="settings-card mt-lg" id="settings-rules">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Planning regels</h3>
                    <p class="settings-card-subtitle">Regels voor rust en minimale bezetting.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="form-group">
                    <label for="rule-min-hours">Minimum uren tussen diensten:</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-min-hours" class="form-input" value="${rules.minHoursBetweenShifts}" min="0" max="24" />
                        <span class="unit">uur</span>
                    </div>
                    <span class="form-hint">Wettelijk minimum is 11 uur</span>
                </div>
                <hr class="my-md">
                <div class="form-group">
                    <label for="rule-max-consecutive">Max opeenvolgende werkdagen:</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-max-consecutive" class="form-input" value="${rules.maxConsecutiveDays || 6}" min="1" max="14" />
                        <span class="unit">dagen</span>
                    </div>
                    <span class="form-hint">Waarschuwing bij overschrijding in planning</span>
                </div>
                <div class="form-group">
                    <label for="rule-rest-after-night">Verplichte rust na nachtdienst:</label>
                    <select id="rule-rest-after-night" class="form-input">
                        <option value="true" ${rules.mandatoryRestAfterNight !== false ? 'selected' : ''}>Ja</option>
                        <option value="false" ${rules.mandatoryRestAfterNight === false ? 'selected' : ''}>Nee</option>
                    </select>
                    <span class="form-hint">Controleert 11u rust na diensten die starten na 20:00 of voor 06:00</span>
                </div>
                <div class="form-group">
                    <label for="rule-free-weekends">Min vrije weekenden per maand:</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-free-weekends" class="form-input" value="${rules.minFreeWeekendsPerMonth || 1}" min="0" max="4" />
                        <span class="unit">weekenden</span>
                    </div>
                    <span class="form-hint">Per kalendermaand, waarschuwing bij weekenddienst toewijzing</span>
                </div>
                <button class="btn btn-primary" onclick="saveRules()">Regels opslaan</button>
            </div>
        </div>

        <!-- Vakantiewerking -->
        <div class="settings-card mt-lg" id="settings-holidays">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Vakantiewerking</h3>
                    <p class="settings-card-subtitle">Regels en periodes voor vakantieplanning.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openAddHolidayModal()">+ Periode</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box info">
                    <p>Tijdens schoolvakanties: <strong>Vlot 1 en Vlot 2 worden samengevoegd</strong> tot 1 leefgroep. Begeleiders van beide teams werken samen.</p>
                </div>

                <div class="holiday-periods-section">
                    <h4>Vakantieperiodes</h4>
                    <div class="holiday-periods-list" id="holiday-periods-list">
                        ${renderHolidayPeriods()}
                    </div>
                </div>
            </div>
        </div>

    `;
}

// ===== SETTINGS TAB: ROOSTER =====
async function saveSchedulePattern() {
    const cycleLengthInput = document.getElementById('schedule-cycle-length');
    const refDateInput = document.getElementById('schedule-reference-date');

    const cycleLength = Math.max(1, Math.min(8, parseInt(cycleLengthInput?.value) || 2));
    const referenceDate = refDateInput?.value;

    if (!referenceDate) {
        showToast('Selecteer een referentie datum', 'warning');
        return;
    }

    // Check if it's a Monday
    const date = parseDateOnly(referenceDate);
    if (date.getDay() !== 1) {
        showToast('De referentie datum moet een maandag zijn', 'warning');
        return;
    }

    // Collect closed days per week
    const weeks = {};
    for (let w = 1; w <= cycleLength; w++) {
        const closedDays = [];
        document.querySelectorAll(`.pattern-closed-day[data-week="${w}"]`).forEach(cb => {
            if (cb.checked) {
                closedDays.push(parseInt(cb.dataset.day));
            }
        });
        const label = closedDays.length > 0 ? formatClosedDays(closedDays) : 'alle dagen open';
        weeks[String(w)] = { closedDays, label };
    }

    const newPattern = { cycleLength, referenceDate, weeks };

    // Save to backend
    try {
        await saveSettings('schedule_pattern', newPattern);

        // Update local state
        DataStore.settings.schedulePattern = newPattern;
        // Backward compat: sync biWeeklyReferenceDate
        DataStore.settings.biWeeklyReferenceDate = referenceDate;

        saveToStorage();
        renderPlanning();
        showToast('Roosterpatroon opgeslagen', 'success');
    } catch (err) {
        console.error('Error saving schedule pattern:', err);
        showToast('Fout bij opslaan van roosterpatroon', 'error');
    }
}

// ===== SETTINGS TAB: TEAMS =====
function renderSettingsTeams(container) {
    container.innerHTML = `
        <!-- Teams configuratie -->
        <div class="settings-card" id="settings-teams">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Teams</h3>
                    <p class="settings-card-subtitle">Naam, kleur en opties per team.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" id="btn-add-team">+ Nieuw</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="team-legend">
                    <span class="team-legend-item">Bezetting = telt mee in bezettingsberekening</span>
                    <span class="team-legend-item">Weekend = draait mee in weekendverantwoordelijke rotatie</span>
                </div>
                <div class="teams-list" id="teams-config">
                    ${renderTeamsConfig()}
                </div>
            </div>
        </div>

        <!-- Dienst templates -->
        <div class="settings-card mt-lg" id="settings-templates">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Dienst templates</h3>
                    <p class="settings-card-subtitle">Standaard diensten voor snelle planning.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openAddTemplateModal()">+ Nieuw</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="templates-list" id="shift-templates-config">
                    ${renderTemplatesConfig()}
                </div>
            </div>
        </div>

        <!-- Weekendverantwoordelijke rotatie -->
        <div class="settings-card mt-lg" id="settings-weekend-responsible">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Weekendverantwoordelijke</h3>
                    <p class="settings-card-subtitle">Rotatie-instellingen en planning.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="rotation-form">
                    ${renderRotationSettingsCompact()}
                </div>
                <div class="upcoming-section" style="margin-top:20px">
                    <h4 style="font-size:14px;margin:0 0 10px">Komende open weekenden</h4>
                    <div class="upcoming-responsibles">
                        ${renderUpcomingResponsibles()}
                    </div>
                </div>
            </div>
        </div>
    `;

    // Event listener for add team button
    document.getElementById('btn-add-team')?.addEventListener('click', openAddTeamModal);

    // Attach click listeners for weekend picker after DOM is set
    requestAnimationFrame(() => {
        const upcomingContainer = container.querySelector('.upcoming-responsibles');
        if (upcomingContainer) attachUpcomingWeekendListeners(upcomingContainer);
    });
}

async function editTeam(teamId) {
    const team = DataStore.settings.teams[teamId];
    if (!team) return;

    const newName = await showInputPrompt('Nieuwe teamnaam:', 'Team bewerken', team.name);
    if (!newName || !newName.trim() || newName.trim() === team.name) return;

    const name = newName.trim();

    try {
        // Update settings (primary source of truth for frontend)
        DataStore.settings.teams[teamId].name = name;
        await saveSettings('teams', DataStore.settings.teams);
        applyTeamColors();
        AppState.apiTeams = null; // Invalidate cache

        // Also update teams DB table (for FK constraints)
        try {
            await apiFetch(`/teams/${teamId}`, {
                method: 'PUT',
                body: JSON.stringify({ name })
            });
        } catch (e) {
            console.warn('Teams DB update skipped:', e.message);
        }

        showToast(`Team "${name}" bijgewerkt`, 'success');
        renderSettings();
    } catch (error) {
        showToast(error.message || 'Fout bij bewerken team', 'error');
    }
}

async function deleteTeam(teamId) {
    const team = DataStore.settings.teams[teamId];
    if (!team) return;

    // Check if team still has members
    const members = DataStore.users.filter(u => u.main_team === teamId || u.team_id === teamId);
    if (members.length > 0) {
        const names = members.slice(0, 5).map(u => u.name).join(', ');
        const extra = members.length > 5 ? ` en ${members.length - 5} anderen` : '';
        showToast(`Kan team "${team.name}" niet verwijderen: ${members.length} medewerker(s) zitten nog in dit team (${names}${extra}). Verplaats ze eerst naar een ander team.`, 'error');
        return;
    }

    const confirmed = await showConfirm(`Weet je zeker dat je team "${team.name}" wilt verwijderen?`);
    if (!confirmed) return;

    try {
        delete DataStore.settings.teams[teamId];
        await saveSettings('teams', DataStore.settings.teams);
        applyTeamColors();
        AppState.apiTeams = null;
        syncTeamFilters();

        try {
            await apiFetch(`/teams/${teamId}`, { method: 'DELETE' });
        } catch (e) {
            console.warn('Teams DB delete skipped:', e.message);
        }

        showToast(`Team "${team.name}" verwijderd`, 'success');
        renderSettings();
    } catch (error) {
        DataStore.settings.teams[teamId] = team;
        showToast(error.message || 'Fout bij verwijderen team', 'error');
    }
}

async function openAddTeamModal() {
    const teamName = await showInputPrompt('Team naam:', 'Nieuw team aanmaken');
    if (!teamName || !teamName.trim()) return;

    const name = teamName.trim();
    const teamId = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

    if (!teamId) {
        showToast('Ongeldige teamnaam', 'error');
        return;
    }

    if (DataStore.settings.teams[teamId]) {
        showToast('Een team met dit ID bestaat al', 'error');
        return;
    }

    const color = '#64748b'; // Default gray

    try {
        // Update settings (primary source of truth for frontend)
        DataStore.settings.teams[teamId] = { name, color };
        await saveSettings('teams', DataStore.settings.teams);

        // Auto-add to coverage teams
        const ct = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams);
        if (!ct.includes(teamId)) { ct.push(teamId); }
        DataStore.settings.coverageTeams = ct;
        await saveSettings('coverageTeams', ct);

        syncTeamFilters();
        applyTeamColors();
        AppState.apiTeams = null; // Invalidate cache

        // Also create in teams DB table (for FK constraints)
        try {
            await apiFetch('/teams', {
                method: 'POST',
                body: JSON.stringify({ id: teamId, name, color })
            });
        } catch (e) {
            console.warn('Teams DB insert skipped:', e.message);
        }

        showToast(`Team "${name}" aangemaakt`, 'success');
        renderSettings();
    } catch (error) {
        showToast(error.message || 'Fout bij aanmaken team', 'error');
    }
}

// ===== SETTINGS TAB: EMAIL =====
function renderSettingsEmail(container) {
    const effectiveRole = getEffectiveRole();
    if (effectiveRole !== 'admin' && effectiveRole !== 'roosterverantwoordelijke') {
        container.innerHTML = '<p>Je hebt geen toegang tot deze instellingen.</p>';
        return;
    }

    const emailSettings = DataStore.settings.emailNotifications || {
        globalEnabled: true,
        types: {
            swap_request: true,
            takeover_available: true,
            sick_leave: true,
            swap_approved: true,
            swap_rejected: true,
            takeover_accepted: true,
            request_cancelled: true,
            welcome: true
        }
    };

    const emailTypes = [
        { key: 'swap_request', label: 'Ruilverzoek aangemaakt', desc: 'Collega ontvangt mail bij een nieuw ruilverzoek' },
        { key: 'takeover_available', label: 'Dienst beschikbaar voor overname', desc: 'Teamleden worden gemaild wanneer een dienst beschikbaar is' },
        { key: 'sick_leave', label: 'Ziekmelding', desc: 'Verantwoordelijken worden gemaild bij een ziekmelding' },
        { key: 'swap_approved', label: 'Ruil goedgekeurd', desc: 'Beide partijen worden gemaild na goedkeuring' },
        { key: 'swap_rejected', label: 'Ruil afgewezen', desc: 'Aanvrager wordt gemaild bij afwijzing' },
        { key: 'takeover_accepted', label: 'Dienst overgenomen', desc: 'Oorspronkelijke eigenaar wordt gemaild' },
        { key: 'request_cancelled', label: 'Verzoek geannuleerd', desc: 'Betrokkenen worden gemaild bij annulering' },
        { key: 'welcome', label: 'Welkomst-email', desc: 'Nieuwe medewerker ontvangt inloggegevens per mail' }
    ];

    const typeToggles = emailTypes.map(t => `
        <div class="email-setting-row ${!emailSettings.globalEnabled ? 'email-disabled' : ''}" id="email-type-row-${t.key}">
            <div class="email-setting-info">
                <span class="email-setting-label">${t.label}</span>
                <span class="email-setting-desc">${t.desc}</span>
            </div>
            <label class="toggle-switch">
                <input type="checkbox" data-email-type="${t.key}" ${emailSettings.types?.[t.key] !== false ? 'checked' : ''} ${!emailSettings.globalEnabled ? 'disabled' : ''} />
                <span class="toggle-slider"></span>
            </label>
        </div>
    `).join('');

    container.innerHTML = `
        <div class="settings-card">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Email & Notificaties</h3>
                    <p class="settings-card-subtitle">Beheer welke emails automatisch verstuurd worden.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="email-setting-row email-setting-global">
                    <div class="email-setting-info">
                        <span class="email-setting-label fw-600">Alle email notificaties</span>
                        <span class="email-setting-desc">Schakel alle email notificaties in of uit</span>
                    </div>
                    <label class="toggle-switch">
                        <input type="checkbox" id="email-global-toggle" ${emailSettings.globalEnabled ? 'checked' : ''} />
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <hr class="my-sm" style="border:none;border-top:1px solid var(--border-color)" />
                ${typeToggles}
                <div class="form-actions mt-md">
                    <button type="button" class="btn btn-primary" id="email-settings-save-btn">Opslaan</button>
                </div>
                <div id="email-settings-message" class="form-message" style="display: none; margin-top: 8px;"></div>
            </div>
        </div>
    `;

    // Global toggle enables/disables individual toggles
    const globalToggle = container.querySelector('#email-global-toggle');
    const typeCheckboxes = container.querySelectorAll('[data-email-type]');

    globalToggle.addEventListener('change', () => {
        typeCheckboxes.forEach(cb => {
            cb.disabled = !globalToggle.checked;
        });
    });

    // Save button
    container.querySelector('#email-settings-save-btn').addEventListener('click', async () => {
        const saveBtn = container.querySelector('#email-settings-save-btn');
        const msg = container.querySelector('#email-settings-message');
        const settings = {
            globalEnabled: globalToggle.checked,
            types: {}
        };
        typeCheckboxes.forEach(cb => {
            settings.types[cb.dataset.emailType] = cb.checked;
        });

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Opslaan...';
            await saveSettings('email_notifications', settings);
            DataStore.settings.emailNotifications = settings;
            msg.textContent = 'Email instellingen opgeslagen.';
            msg.className = 'form-message success';
            msg.style.display = 'block';
            markSettingsSaved();
            showToast('Email instellingen opgeslagen', 'success');
        } catch (err) {
            msg.textContent = 'Opslaan mislukt: ' + (err.message || 'Onbekende fout');
            msg.className = 'form-message error';
            msg.style.display = 'block';
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Opslaan';
        }
    });
}

// ===== SETTINGS TAB: SYSTEEM =====
function renderSettingsSystem(container) {
    const isAdmin = getEffectiveRole() === 'admin';

    container.innerHTML = `
        <!-- Data beheer -->
        <div class="settings-card" id="settings-data">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Data beheer</h3>
                    <p class="settings-card-subtitle">Backup, import en reset van de data.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box neutral">
                    <p>Alle data wordt opgeslagen in de PostgreSQL database.</p>
                    <p>Exporteer regelmatig een backup om dataverlies te voorkomen.</p>
                </div>
                <div class="data-stats">
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.employees.length}</span>
                        <span class="stat-label">Medewerkers</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.shifts.length}</span>
                        <span class="stat-label">Diensten</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.availability.length}</span>
                        <span class="stat-label">Afwezigheden</span>
                    </div>
                </div>
                <div class="button-group">
                    <button class="btn btn-secondary" onclick="exportData()">Exporteer</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('import-file').click()">Importeer</button>
                    <input type="file" id="import-file" accept=".json" style="display: none;" onchange="importData(event)">
                </div>
                ${isAdmin && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:') ? `
                <div class="migration-zone" style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-color);">
                    <h4>Database migratie (dev)</h4>
                    <p>Voer database migraties uit om data te repareren (bijv. weekroosters fixen).</p>
                    <button class="btn btn-secondary" onclick="runMigration()">Database migreren</button>
                    <button class="btn btn-secondary ml-sm" onclick="seedTeams()">Teams aanmaken</button>
                    <button class="btn btn-secondary ml-sm" onclick="showDebugInfo()">Debug info</button>
                </div>
                ` : ''}
                ${isAdmin ? `
                <div class="danger-zone">
                    <h4>Gevarenzone</h4>
                    <p>Deze actie kan niet ongedaan worden gemaakt!</p>
                    <button class="btn btn-danger" onclick="resetData()">Alle data wissen</button>
                </div>
                ` : ''}
            </div>
        </div>

        <!-- App info -->
        <div class="settings-card mt-lg" id="settings-about">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Over de app</h3>
                    <p class="settings-card-subtitle">Versie en korte uitleg.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="app-info">
                    <div class="app-logo">Het Vlot</div>
                    <p class="app-subtitle">Roosterplanning Applicatie</p>
                    <div class="app-version">Versie 1.0.0</div>
                    <p class="app-description">
                        Een planning tool voor Het Vlot om diensten, medewerkers en beschikbaarheid te beheren.
                    </p>
                </div>
            </div>
        </div>
    `;
}

// ===== SETTINGS TAB: BEHEER (combined system + audit) =====
function renderSettingsBeheer(container) {
    const isAdmin = getEffectiveRole() === 'admin';
    if (!isAdmin) {
        container.innerHTML = `<div class="settings-card"><div class="settings-card-body">
            <div class="info-box neutral"><p>Je hebt geen toegang tot deze instellingen.</p></div>
        </div></div>`;
        return;
    }

    container.innerHTML = `
        <!-- Data beheer -->
        <div class="settings-card" id="settings-data">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Data beheer</h3>
                    <p class="settings-card-subtitle">Backup, import en reset van de data.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box neutral">
                    <p>Alle data wordt opgeslagen in de PostgreSQL database.</p>
                    <p>Exporteer regelmatig een backup om dataverlies te voorkomen.</p>
                </div>
                <div class="data-stats">
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.employees.length}</span>
                        <span class="stat-label">Medewerkers</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.shifts.length}</span>
                        <span class="stat-label">Diensten</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-value">${DataStore.availability.length}</span>
                        <span class="stat-label">Afwezigheden</span>
                    </div>
                </div>
                <div class="button-group">
                    <button class="btn btn-secondary" onclick="exportData()">Exporteer</button>
                    <button class="btn btn-secondary" onclick="document.getElementById('import-file').click()">Importeer</button>
                    <input type="file" id="import-file" accept=".json" style="display: none;" onchange="importData(event)">
                </div>
            </div>
        </div>

        <!-- Audit log -->
        <div class="settings-card mt-lg">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Audit Log</h3>
                    <p class="settings-card-subtitle">Overzicht van alle wijzigingen in het systeem.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="audit-filters">
                    <div class="audit-filter-row">
                        <div class="form-group">
                            <label>Van</label>
                            <input type="date" id="audit-start-date" class="form-input">
                        </div>
                        <div class="form-group">
                            <label>Tot</label>
                            <input type="date" id="audit-end-date" class="form-input">
                        </div>
                        <div class="form-group">
                            <label>Actie</label>
                            <select id="audit-action-filter" class="form-input">
                                <option value="">Alle</option>
                                <option value="CREATE">Aangemaakt</option>
                                <option value="UPDATE">Bijgewerkt</option>
                                <option value="DELETE">Verwijderd</option>
                                <option value="APPROVE">Goedgekeurd</option>
                                <option value="REJECT">Afgewezen</option>
                                <option value="CANCEL">Geannuleerd</option>
                                <option value="REPLACE">Vervangen</option>
                                <option value="IMPORT">Geïmporteerd</option>
                                <option value="MIGRATE">Gemigreerd</option>
                                <option value="LOGIN">Login</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Type</label>
                            <select id="audit-resource-filter" class="form-input">
                                <option value="">Alle</option>
                                <option value="shift">Diensten</option>
                                <option value="availability">Afwezigheid</option>
                                <option value="swap_request">Ruilverzoek</option>
                                <option value="user">Gebruiker</option>
                                <option value="settings">Instellingen</option>
                            </select>
                        </div>
                        <div class="form-group self-end">
                            <button class="btn btn-primary" onclick="loadAuditLog(1)">Zoeken</button>
                            <button class="btn btn-secondary" onclick="exportAuditLog()">Exporteer CSV</button>
                        </div>
                    </div>
                </div>
                <div id="audit-log-results"></div>
                <div id="audit-log-pagination" class="audit-pagination"></div>
            </div>
        </div>

        <!-- Gevarenzone (collapsible, starts collapsed) -->
        <div class="settings-card collapsed mt-lg" id="settings-danger-zone">
            <div class="settings-card-header cursor-pointer" onclick="this.parentElement.classList.toggle('collapsed')">
                <div class="settings-card-title">
                    <h3>Gevarenzone</h3>
                    <p class="settings-card-subtitle">Onomkeerbare acties.</p>
                </div>
                <span class="collapse-indicator">&#9660;</span>
            </div>
            <div class="settings-card-body">
                <div class="info-box" style="background: rgba(239, 68, 68, 0.06); border-color: rgba(239, 68, 68, 0.2);">
                    <p class="text-danger fw-600">Let op: deze actie kan niet ongedaan worden gemaakt!</p>
                    <p>Alle planningsdata (diensten, afwezigheden, ruilverzoeken) wordt permanent verwijderd.</p>
                </div>
                <button class="btn btn-danger" onclick="resetData()">Alle data wissen</button>
            </div>
        </div>
    `;

    loadAuditLog(1);
}

const AUDIT_ACTION_LABELS = {
    CREATE: 'Aangemaakt',
    UPDATE: 'Bijgewerkt',
    DELETE: 'Verwijderd',
    APPROVE: 'Goedgekeurd',
    REJECT: 'Afgewezen',
    CANCEL: 'Geannuleerd',
    LOGIN: 'Login'
};

const AUDIT_RESOURCE_LABELS = {
    shift: 'Dienst',
    availability: 'Afwezigheid',
    swap_request: 'Ruilverzoek',
    user: 'Gebruiker',
    settings: 'Instelling'
};

async function loadAuditLog(page) {
    const resultsEl = document.getElementById('audit-log-results');
    const paginationEl = document.getElementById('audit-log-pagination');
    if (!resultsEl) return;

    resultsEl.innerHTML = '<p class="p-md text-muted">Laden...</p>';

    const filters = {
        page,
        limit: 30,
        action: document.getElementById('audit-action-filter')?.value || '',
        resourceType: document.getElementById('audit-resource-filter')?.value || '',
        startDate: document.getElementById('audit-start-date')?.value || '',
        endDate: document.getElementById('audit-end-date')?.value || ''
    };

    try {
        const data = await fetchAuditLog(filters);
        const logs = data.logs || [];

        if (logs.length === 0) {
            resultsEl.innerHTML = '<div class="info-box neutral"><p>Geen resultaten gevonden.</p></div>';
            paginationEl.innerHTML = '';
            return;
        }

        let html = '<table class="audit-log-table"><thead><tr>';
        html += '<th>Tijdstip</th><th>Gebruiker</th><th>Actie</th><th>Type</th><th>Details</th>';
        html += '</tr></thead><tbody>';

        logs.forEach(log => {
            const time = new Date(log.created_at);
            const timeStr = time.toLocaleDateString('nl-BE', { day: '2-digit', month: '2-digit', year: '2-digit' })
                + ' ' + time.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });

            const actionLabel = AUDIT_ACTION_LABELS[log.action] || log.action;
            const resourceLabel = AUDIT_RESOURCE_LABELS[log.resource_type] || log.resource_type;
            const actionClass = log.action.toLowerCase();

            let detailStr = '';
            if (log.details && typeof log.details === 'object') {
                if (log.details.before && log.details.after) {
                    detailStr = formatAuditDiff(log.details.before, log.details.after);
                } else if (log.details.shift) {
                    const s = log.details.shift;
                    detailStr = `${s.date || ''} ${s.startTime || s.start_time || ''}-${s.endTime || s.end_time || ''}`;
                } else if (log.details.availability) {
                    const a = log.details.availability;
                    detailStr = `${a.date || ''} ${a.type || ''}`;
                } else if (log.details.key) {
                    detailStr = log.details.key;
                } else if (log.details.user) {
                    detailStr = log.details.user.name || log.details.user.email || '';
                } else {
                    const keys = Object.keys(log.details);
                    if (keys.length > 0) detailStr = keys.join(', ');
                }
            }

            html += `<tr>
                <td class="audit-time">${escapeHtml(timeStr)}</td>
                <td>${escapeHtml(log.actor_name)}</td>
                <td><span class="audit-action-badge audit-${actionClass}">${escapeHtml(actionLabel)}</span></td>
                <td>${escapeHtml(resourceLabel)}</td>
                <td class="audit-details">${escapeHtml(detailStr)}</td>
            </tr>`;
        });

        html += '</tbody></table>';
        resultsEl.innerHTML = html;
        IconHelper.init(resultsEl);

        // Pagination
        const totalPages = Math.ceil(data.total / data.limit);
        if (totalPages > 1) {
            let pagHtml = '';
            if (page > 1) pagHtml += `<button class="btn btn-sm btn-secondary" onclick="loadAuditLog(${page - 1})">Vorige</button>`;
            pagHtml += `<span class="audit-page-info">Pagina ${page} van ${totalPages} (${data.total} resultaten)</span>`;
            if (page < totalPages) pagHtml += `<button class="btn btn-sm btn-secondary" onclick="loadAuditLog(${page + 1})">Volgende</button>`;
            paginationEl.innerHTML = pagHtml;
        } else {
            paginationEl.innerHTML = `<span class="audit-page-info">${data.total} resultaten</span>`;
        }
    } catch (err) {
        resultsEl.innerHTML = `<div class="info-box neutral"><p>Fout bij laden: ${escapeHtml(err.message)}</p></div>`;
    }
}

function formatAuditDiff(before, after) {
    const changes = [];
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
        if (key === 'createdAt' || key === 'id') continue;
        const oldVal = before?.[key];
        const newVal = after?.[key];
        if (String(oldVal) !== String(newVal)) {
            changes.push(`${key}: ${oldVal || '-'} -> ${newVal || '-'}`);
        }
    }
    return changes.slice(0, 3).join(', ');
}

function formatAuditDetailsForCSV(details) {
    if (!details || typeof details !== 'object') return '';
    if (details.before && details.after) {
        return formatAuditDiff(details.before, details.after);
    } else if (details.shift) {
        const s = details.shift;
        return `${s.date || ''} ${s.startTime || s.start_time || ''}-${s.endTime || s.end_time || ''} ${s.team || ''}`.trim();
    } else if (details.availability) {
        const a = details.availability;
        return `${a.date || ''} ${a.type || ''}`.trim();
    } else if (details.key) {
        return details.key;
    } else if (details.user) {
        return details.user.name || details.user.email || '';
    }
    const keys = Object.keys(details);
    return keys.length > 0 ? keys.join(', ') : '';
}

async function exportAuditLog() {
    showToast('Audit log exporteren...', 'info');
    try {
        const filters = {
            page: 1,
            limit: 10000,
            action: document.getElementById('audit-action-filter')?.value || '',
            resourceType: document.getElementById('audit-resource-filter')?.value || '',
            startDate: document.getElementById('audit-start-date')?.value || '',
            endDate: document.getElementById('audit-end-date')?.value || ''
        };
        const data = await fetchAuditLog(filters);
        const logs = data.logs || [];
        if (logs.length === 0) {
            showToast('Geen resultaten om te exporteren', 'warning');
            return;
        }
        const rows = [['Tijdstip', 'Gebruiker', 'Actie', 'Type', 'Details']];
        logs.forEach(log => {
            rows.push([
                new Date(log.created_at).toLocaleString('nl-BE'),
                log.actor_name || '',
                AUDIT_ACTION_LABELS[log.action] || log.action,
                AUDIT_RESOURCE_LABELS[log.resource_type] || log.resource_type,
                formatAuditDetailsForCSV(log.details)
            ]);
        });
        const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`${logs.length} regels geexporteerd`, 'success');
    } catch (err) {
        showToast('Export mislukt: ' + (err.message || 'Onbekende fout'), 'error');
    }
}

async function ensureTeamsLoaded() {
    // Try loading from API, merge with settings teams
    try {
        const data = await apiFetch('/teams');
        AppState.apiTeams = data.teams || [];
    } catch (e) {
        AppState.apiTeams = AppState.apiTeams || [];
    }

    // Merge teams from settings that might not be in DB yet
    const settingsTeams = DataStore.settings.teams || {};
    const apiIds = new Set(AppState.apiTeams.map(t => t.id));
    Object.entries(settingsTeams).forEach(([id, team]) => {
        if (!apiIds.has(id)) {
            AppState.apiTeams.push({ id, name: team.name, color: team.color });
        }
    });

    // Also update names from settings (settings is source of truth for names)
    AppState.apiTeams.forEach(t => {
        if (settingsTeams[t.id]) {
            t.name = settingsTeams[t.id].name;
            t.color = settingsTeams[t.id].color;
        }
    });

    return AppState.apiTeams;
}

function renderTeamsConfig() {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const eligibleTeams = DataStore.settings.responsibleRotation?.eligibleTeams || [];
    let html = '';
    Object.keys(DataStore.settings.teams).forEach(teamId => {
        const team = DataStore.settings.teams[teamId];
        const teamName = escapeHtml(team.name);
        const inCoverage = coverageTeams.includes(teamId);
        const inWeekend = eligibleTeams.includes(teamId);
        html += `
        <div class="team-config-item" data-team-id="${teamId}">
            <div class="team-color-dot" style="background: ${team.color}"></div>
            <div class="team-info">
                <span class="team-name">${teamName}</span>
                <div class="settings-team-toggles">
                    <label class="team-toggle-label" title="Telt mee in bezettingsberekening">
                        <input type="checkbox" class="coverage-team-cb" data-team-id="${teamId}" ${inCoverage ? 'checked' : ''} onchange="saveTeamToggles()" />
                        <span>Bezetting</span>
                    </label>
                    <label class="team-toggle-label" title="Draait mee in weekendverantwoordelijke rotatie">
                        <input type="checkbox" class="eligible-team-cb" data-team-id="${teamId}" ${inWeekend ? 'checked' : ''} onchange="saveTeamToggles()" />
                        <span>Weekend</span>
                    </label>
                </div>
            </div>
            <div class="team-actions">
                <button class="btn-icon-only" onclick="editTeam('${teamId}')" title="Naam bewerken">${IconHelper.html(ICONS.edit, 'sm')}</button>
                <input type="color" class="color-picker" value="${team.color}"
                       onchange="updateTeamColor('${teamId}', this.value)" title="Kleur wijzigen"/>
                <button class="btn-icon-only danger" onclick="deleteTeam('${teamId}')" title="Verwijderen">${IconHelper.html(ICONS.delete, 'sm')}</button>
            </div>
        </div>`;
    });
    return html;
}

function renderTemplatesConfig() {
    let html = '';
    Object.keys(DataStore.settings.shiftTemplates).forEach(templateId => {
        const template = DataStore.settings.shiftTemplates[templateId];
        const duration = calculateTemplateDuration(template.start, template.end);
        const templateName = escapeHtml(template.name);
        html += `
        <div class="template-config-item" data-template-id="${templateId}">
            <div class="template-icon">${getTemplateIcon(templateId)}</div>
            <div class="template-info">
                <span class="template-name">${templateName}</span>
                <span class="template-times">${template.start} - ${template.end} (${duration})</span>
            </div>
            <div class="template-actions">
                <button class="btn-icon-only" onclick="editTemplate('${templateId}')" title="Bewerken">${IconHelper.html(ICONS.edit, 'sm')}</button>
                <button class="btn-icon-only danger" onclick="deleteTemplate('${templateId}')" title="Verwijderen">${IconHelper.html(ICONS.delete, 'sm')}</button>
            </div>
        </div>`;
    });
    return html;
}

function getTemplateIcon(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (template?.icon) {
        return IconHelper.html(template.icon, 'sm');
    }
    // Fallback for legacy templates without icon property
    const iconMap = {
        'vroeg': ICONS.early,
        'laat': ICONS.late,
        'nacht': ICONS.night,
        'lang': ICONS.long
    };
    return IconHelper.html(iconMap[templateId] || ICONS.clock, 'sm');
}

function calculateTemplateDuration(start, end) {
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);

    let hours = endH - startH;
    let mins = endM - startM;

    if (hours < 0 || (hours === 0 && mins < 0)) {
        hours += 24;
    }
    if (mins < 0) {
        hours -= 1;
        mins += 60;
    }

    if (mins === 0) {
        return `${hours}u`;
    }
    return `${hours}u${mins}`;
}

async function updateTeamColor(teamId, color) {
    if (DataStore.settings.teams[teamId]) {
        DataStore.settings.teams[teamId].color = color;
        saveToStorage();
        applyTeamColors();

        // Save to backend
        try {
            await saveSettings('teams', DataStore.settings.teams);
        } catch (error) {
            console.error('Error saving team color to backend:', error);
            showToast('Kleur is lokaal opgeslagen maar backend sync mislukt. Vernieuw de pagina om te synchroniseren.', 'warning');
        }
    }
}

async function saveRules() {
    const minHours = parseInt(document.getElementById('rule-min-hours').value) || 11;
    const maxConsecutive = parseInt(document.getElementById('rule-max-consecutive')?.value) || 6;
    const restAfterNight = document.getElementById('rule-rest-after-night')?.value !== 'false';
    const freeWeekends = parseInt(document.getElementById('rule-free-weekends')?.value) || 1;

    DataStore.settings.rules.minHoursBetweenShifts = minHours;
    DataStore.settings.rules.maxConsecutiveDays = maxConsecutive;
    DataStore.settings.rules.mandatoryRestAfterNight = restAfterNight;
    DataStore.settings.rules.minFreeWeekendsPerMonth = freeWeekends;

    saveToStorage();
    try {
        await saveSettings('rules', DataStore.settings.rules);
        markSettingsSaved();
        showToast('Planning regels zijn opgeslagen', 'success');
    } catch (err) {
        console.error('Error saving rules to backend:', err);
        showToast('Regels lokaal opgeslagen, maar sync naar server mislukt', 'warning');
    }
}

async function handleSaveSchoolYear() {
    const input = document.getElementById('school-year-start-input');
    const date = input.value;
    if (!date) {
        showToast('Selecteer een startdatum', 'warning');
        return;
    }
    try {
        await saveSchoolYearStart(date);
        markSettingsSaved();
        showToast('Schooljaar startdatum opgeslagen', 'success');
    } catch (error) {
        console.error('Fout bij opslaan schooljaar:', error);
        showToast('Fout bij opslaan schooljaar', 'error');
    }
}


function openAddTemplateModal() {
    openTemplateModal();
}

function editTemplate(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (template) {
        openTemplateModal(templateId, template);
    }
}

async function deleteTemplate(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (!template) return;

    if (await showConfirm(`Weet je zeker dat je de template "${template.name}" wilt verwijderen?`)) {
        delete DataStore.settings.shiftTemplates[templateId];
        saveToStorage();
        renderSettings();
    }
}

function openTemplateModal(templateId = null, template = null) {
    const isEdit = templateId !== null;
    const title = isEdit ? 'Template bewerken' : 'Nieuwe template';
    const safeTemplateName = escapeHtml(template?.name || '');
    const currentIcon = template?.icon || '';

    const iconOptions = [
        { id: 'sunrise', label: 'Ochtend' },
        { id: 'sun', label: 'Middag' },
        { id: 'sunset', label: 'Avond' },
        { id: 'moon', label: 'Nacht' },
        { id: 'star', label: 'Weekend' },
        { id: 'clock', label: 'Standaard' },
        { id: 'coffee', label: 'Pauze' },
        { id: 'briefcase', label: 'Kantoor' },
        { id: 'graduation-cap', label: 'Vorming' },
        { id: 'users', label: 'Overleg' },
        { id: 'heart', label: 'Zorg' },
        { id: 'zap', label: 'Spoed' }
    ];

    let iconPickerHtml = '<div class="template-icon-picker">';
    iconOptions.forEach(opt => {
        const selected = currentIcon === opt.id ? 'selected' : '';
        iconPickerHtml += `<button type="button" class="template-icon-option ${selected}" data-icon="${opt.id}" title="${opt.label}" onclick="selectTemplateIcon(this)">
            ${IconHelper.html(opt.id, 'md')}
            <span class="template-icon-label">${opt.label}</span>
        </button>`;
    });
    iconPickerHtml += '</div>';

    const modalHtml = `
    <div class="modal" id="template-modal-overlay" onclick="closeTemplateModal()">
        <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2>${title}</h2>
                <button class="modal-close" onclick="closeTemplateModal()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <input type="hidden" id="template-id" value="${escapeHtml(templateId || '')}" />
                <div class="form-group">
                    <label for="template-name">Naam:</label>
                    <input type="text" id="template-name" class="form-input"
                           value="${safeTemplateName}"
                           placeholder="bv. Vroege dienst" />
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="template-start">Starttijd:</label>
                        <input type="time" id="template-start" class="form-input"
                               value="${template ? template.start : '09:00'}" />
                    </div>
                    <div class="form-group">
                        <label for="template-end">Eindtijd:</label>
                        <input type="time" id="template-end" class="form-input"
                               value="${template ? template.end : '17:00'}" />
                    </div>
                </div>
                <div class="form-group">
                    <label>Icoon:</label>
                    ${iconPickerHtml}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeTemplateModal()">Annuleren</button>
                <button class="btn btn-primary" onclick="saveTemplate('${templateId || ''}')">Opslaan</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    IconHelper.init(document.getElementById('template-modal-overlay'));
}

function selectTemplateIcon(btn) {
    btn.closest('.template-icon-picker').querySelectorAll('.template-icon-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
}

function closeTemplateModal() {
    const modal = document.getElementById('template-modal-overlay');
    if (modal) modal.remove();
}

function saveTemplate(originalId) {
    const name = document.getElementById('template-name').value.trim();
    const start = document.getElementById('template-start').value;
    const end = document.getElementById('template-end').value;
    const selectedIconBtn = document.querySelector('.template-icon-option.selected');
    const icon = selectedIconBtn ? selectedIconBtn.dataset.icon : '';

    if (!name || !start || !end) {
        showToast('Vul alle velden in', 'warning');
        return;
    }

    if (start === end) {
        showToast('Starttijd en eindtijd mogen niet gelijk zijn', 'warning');
        return;
    }

    // Auto-generate ID from name (slugify)
    let id = originalId || name.toLowerCase()
        .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
        .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u')
        .replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');

    if (!id) {
        showToast('Naam moet minstens één letter of cijfer bevatten', 'warning');
        return;
    }

    // Ensure unique ID for new templates
    if (!originalId && DataStore.settings.shiftTemplates[id]) {
        let suffix = 2;
        while (DataStore.settings.shiftTemplates[`${id}_${suffix}`]) suffix++;
        id = `${id}_${suffix}`;
    }

    if (originalId && originalId !== id) {
        delete DataStore.settings.shiftTemplates[originalId];
    }

    DataStore.settings.shiftTemplates[id] = { name, start, end, icon };
    saveToStorage();
    closeTemplateModal();
    renderSettings();
}

// ===== VAKANTIE FUNCTIES =====

function renderHolidayPeriods() {
    const periods = DataStore.settings.holidayPeriods || [];

    if (periods.length === 0) {
        return '<p class="no-items-text">Nog geen vakantieperiodes ingesteld</p>';
    }

    // Sorteer op startdatum
    const sorted = [...periods].sort((a, b) => parseDateOnly(a.startDate) - parseDateOnly(b.startDate));

    return sorted.map(period => {
        const start = parseDateOnly(period.startDate);
        const end = parseDateOnly(period.endDate);
        const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
        const today = parseDateOnly(new Date());
        const isActive = today >= start && today <= end;
        const isPast = end < today;

        let statusClass = '';
        if (isPast) statusClass = 'past';
        else if (isActive) statusClass = 'active';

        // Calculate weeks in this period
        const periodMonday = getMondayOfWeek(start);
        const periodEndMonday = getMondayOfWeek(end);
        const totalWeeks = Math.floor((periodEndMonday - periodMonday) / (7 * 86400000)) + 1;

        return `
        <div class="holiday-period-item ${statusClass}">
            <div class="holiday-period-info">
                <span class="holiday-period-name">${escapeHtml(period.name)}</span>
                <span class="holiday-period-dates">
                    ${formatDateShort(period.startDate)} - ${formatDateShort(period.endDate)}
                    <span class="holiday-period-days">(${days} dagen, ${totalWeeks} ${totalWeeks === 1 ? 'week' : 'weken'})</span>
                </span>
            </div>
            <button class="btn-icon-only danger" onclick="deleteHolidayPeriod(${period.id})" title="Verwijderen">${IconHelper.html(ICONS.delete, 'sm')}</button>
        </div>`;
    }).join('');
}

function formatDateShort(date) {
    const d = parseDateOnly(date);
    return d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function setHolidayResponsible(periodId, employeeId) {
    const periods = DataStore.settings.holidayPeriods || [];
    const period = periods.find(p => p.id === periodId || String(p.id) === String(periodId));
    if (!period) return;
    period.responsibleId = employeeId || null;
    await saveSettings('holidayPeriods', periods);
    showToast('Verantwoordelijke ingesteld', 'success');
}

async function setHolidayWeekResponsible(periodId, weekNum, employeeId) {
    const periods = DataStore.settings.holidayPeriods || [];
    const period = periods.find(p => p.id === periodId || String(p.id) === String(periodId));
    if (!period) return;
    if (!period.weeklyResponsibles) period.weeklyResponsibles = {};
    if (employeeId) {
        period.weeklyResponsibles[String(weekNum)] = employeeId;
    } else {
        delete period.weeklyResponsibles[String(weekNum)];
    }
    await saveSettings('holidayPeriods', periods);
    showToast(`Verantwoordelijke week ${weekNum} ingesteld`, 'success');
}

function openAddHolidayModal() {
    const modalHtml = `
    <div class="modal" id="holiday-modal" onclick="closeHolidayModal()">
        <div class="modal-content" onclick="event.stopPropagation()" class="modal-content--sm">
            <div class="modal-header">
                <h2>Vakantieperiode toevoegen</h2>
                <button class="modal-close" onclick="closeHolidayModal()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="holiday-name">Naam:</label>
                    <input type="text" id="holiday-name" class="form-input" placeholder="bv. Krokusvakantie 2026" />
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="holiday-start">Startdatum:</label>
                        <input type="date" id="holiday-start" class="form-input" />
                    </div>
                    <div class="form-group">
                        <label for="holiday-end">Einddatum:</label>
                        <input type="date" id="holiday-end" class="form-input" />
                    </div>
                </div>
                <div id="holiday-date-info" class="date-range-info"></div>

                <!-- Snelle selectie voor Belgische schoolvakanties -->
                <div class="quick-select-section">
                    <h4>Snelle selectie (schooljaar 2025-2026)</h4>
                    <div class="quick-select-buttons">
                        <button type="button" class="btn btn-sm btn-outline" onclick="prefillHoliday('Krokusvakantie', '2026-02-16', '2026-02-22')">Krokus</button>
                        <button type="button" class="btn btn-sm btn-outline" onclick="prefillHoliday('Paasvakantie', '2026-04-06', '2026-04-19')">Pasen</button>
                        <button type="button" class="btn btn-sm btn-outline" onclick="prefillHoliday('Zomervakantie', '2026-07-01', '2026-08-31')">Zomer</button>
                        <button type="button" class="btn btn-sm btn-outline" onclick="prefillHoliday('Herfstvakantie', '2026-11-02', '2026-11-08')">Herfst</button>
                        <button type="button" class="btn btn-sm btn-outline" onclick="prefillHoliday('Kerstvakantie', '2026-12-21', '2027-01-03')">Kerst</button>
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" onclick="closeHolidayModal()">Annuleren</button>
                <button class="btn btn-primary" onclick="saveHolidayPeriod()">Toevoegen</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    IconHelper.init(document.getElementById('holiday-modal'));

    // Update info bij datum wijziging
    document.getElementById('holiday-start').addEventListener('change', updateHolidayDateInfo);
    document.getElementById('holiday-end').addEventListener('change', updateHolidayDateInfo);
}

function prefillHoliday(name, start, end) {
    document.getElementById('holiday-name').value = name;
    document.getElementById('holiday-start').value = start;
    document.getElementById('holiday-end').value = end;
    updateHolidayDateInfo();
}

function updateHolidayDateInfo() {
    const start = document.getElementById('holiday-start').value;
    const end = document.getElementById('holiday-end').value;
    const infoDiv = document.getElementById('holiday-date-info');

    if (start && end) {
        const startDate = parseDateOnly(start);
        const endDate = parseDateOnly(end);

        if (endDate >= startDate) {
            const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
            infoDiv.innerHTML = `<span class="info-badge">${days} dagen geselecteerd</span>`;
        } else {
            infoDiv.innerHTML = '<span class="error-text">Einddatum moet na startdatum liggen</span>';
        }
    } else {
        infoDiv.innerHTML = '';
    }
}

function closeHolidayModal() {
    const modal = document.getElementById('holiday-modal');
    if (modal) modal.remove();
}

function saveHolidayPeriod() {
    const name = document.getElementById('holiday-name').value.trim();
    const start = document.getElementById('holiday-start').value;
    const end = document.getElementById('holiday-end').value;

    if (!name || !start || !end) {
        showToast('Vul alle velden in', 'warning');
        return;
    }

    if (parseDateOnly(end) < parseDateOnly(start)) {
        showToast('Einddatum moet na startdatum liggen', 'warning');
        return;
    }

    addHolidayPeriod(name, start, end);
    closeHolidayModal();
    renderSettings();
}

async function deleteHolidayPeriod(id) {
    const linkedDrafts = (DataStore.settings.schedule_drafts || []).filter(d => d.type === 'vakantie' && String(d.holidayPeriodId) === String(id));
    const activeDrafts = linkedDrafts.filter(d => d.lastAppliedAt);
    const savedDrafts = linkedDrafts.filter(d => !d.lastAppliedAt);

    let msg = 'Weet je zeker dat je deze vakantieperiode wilt verwijderen?';
    if (linkedDrafts.length > 0) {
        const names = linkedDrafts.map(d => `"${d.name}"`).join(', ');
        msg += `\n\n${linkedDrafts.length} gekoppeld(e) concept(en): ${names}`;
        if (activeDrafts.length > 0) {
            msg += `\n\nLet op: ${activeDrafts.length} concept(en) ${activeDrafts.length === 1 ? 'is' : 'zijn'} toegepast. Bestaande shifts blijven staan maar het concept wordt ontkoppeld.`;
        }
        msg += '\n\nAlle gekoppelde concepten worden verwijderd.';
    }
    if (await showConfirm(msg)) {
        // Verwijder alle gekoppelde concepten
        if (DataStore._draftsFromTable) {
            for (const draft of linkedDrafts) {
                try {
                    await deleteScheduleDraft(draft.id);
                } catch (e) {
                    console.error('Error deleting linked vakantie draft:', e);
                }
            }
        }
        // Verwijder ook uit lokale cache
        DataStore.settings.schedule_drafts = (DataStore.settings.schedule_drafts || []).filter(
            d => !(d.type === 'vakantie' && String(d.holidayPeriodId) === String(id))
        );
        removeHolidayPeriod(id);
        renderSettings();
    }
}

// ===== TEAM TOGGLES (bezetting + weekend rotatie) =====

async function saveTeamToggles() {
    // Coverage teams
    const coverageTeams = [];
    document.querySelectorAll('.coverage-team-cb').forEach(cb => {
        if (cb.checked) coverageTeams.push(cb.dataset.teamId);
    });
    if (coverageTeams.length > 0) {
        DataStore.settings.coverageTeams = coverageTeams;
        try { await saveSettings('coverageTeams', coverageTeams); } catch (e) { console.error('Error saving coverageTeams:', e); }
    }

    // Eligible teams for weekend rotation
    const eligibleTeams = [];
    document.querySelectorAll('.eligible-team-cb').forEach(cb => {
        if (cb.checked) eligibleTeams.push(cb.dataset.teamId);
    });
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = { eligibleTeams: [], assignments: {} };
    }
    DataStore.settings.responsibleRotation.eligibleTeams = eligibleTeams;

    saveToStorage();

    showToast('Teaminstellingen opgeslagen', 'success');

    // Update heatmap if visible
    if (typeof renderCoverageHeatmap === 'function' && AppState.showHeatmap) {
        renderPlanning();
    }
    // Update upcoming weekends list
    const upcomingContainer = document.querySelector('.upcoming-responsibles');
    if (upcomingContainer) {
        upcomingContainer.innerHTML = renderUpcomingResponsibles();
        IconHelper.init(upcomingContainer);
        attachUpcomingWeekendListeners(upcomingContainer);
    }
}

// Legacy aliases
function saveCoverageTeams() { saveTeamToggles(); }
function saveEligibleTeamsQuiet() { saveTeamToggles(); }
function saveEligibleTeams() { saveTeamToggles(); }
function renderCoverageTeamsCheckboxes() { return ''; }
function renderEligibleTeamsCheckboxes() { return ''; }

function renderRotationSettings() {
    return renderRotationSettingsCompact();
}

function renderRotationSettingsCompact() {
    const rotation = DataStore.settings.responsibleRotation || {};
    const eligible = getEligibleEmployeesForResponsible();

    const referenceDate = getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate || '';
    const currentStart = rotation.rotationStart || referenceDate;
    const currentEmployee = String(rotation.rotationStartEmployee || '');

    let employeeOptions = '<option value="">-- Kies eerste persoon --</option>';
    eligible.forEach(emp => {
        // Compare as strings to avoid precision issues
        const selected = String(emp.id) === currentEmployee ? 'selected' : '';
        employeeOptions += `<option value="${emp.id}" ${selected}>${escapeHtml(emp.name)}</option>`;
    });

    return `
    <div class="form-row compact">
        <div class="form-group">
            <label for="rotation-start-date">Startdatum:</label>
            <input type="date" id="rotation-start-date" class="form-input" value="${escapeHtml(currentStart)}" />
        </div>
        <div class="form-group">
            <label for="rotation-start-employee">Begint met:</label>
            <select id="rotation-start-employee" class="form-input">
                ${employeeOptions}
            </select>
        </div>
        <button class="btn btn-primary btn-sm self-end" onclick="saveRotationSettings()">Opslaan</button>
    </div>`;
}

function saveRotationSettings() {
    const dateInput = document.getElementById('rotation-start-date');
    const employeeSelect = document.getElementById('rotation-start-employee');

    const startDate = dateInput?.value;
    const employeeId = employeeSelect?.value;

    if (!startDate) {
        showToast('Kies een startdatum', 'warning');
        return;
    }

    if (!employeeId) {
        showToast('Selecteer wie begint', 'warning');
        return;
    }

    const date = parseDateOnly(startDate);
    if (date.getDay() !== 1) {
        showToast('De startdatum moet een maandag zijn', 'warning');
        return;
    }

    setRotationStart(date, parseFloat(employeeId));
    renderSettings();
    renderPlanning();
    showToast('Rotatie ingesteld', 'success');
}

function renderUpcomingResponsibles() {
    const eligible = getEligibleEmployeesForResponsible();
    if (eligible.length === 0) {
        return '<p class="no-items-text">Geen medewerkers in aanmerking</p>';
    }

    const rotation = DataStore.settings.responsibleRotation || {};
    if (!rotation.rotationStart || !rotation.rotationStartEmployee) {
        return '<p class="no-items-text">Stel eerst de rotatie in hierboven</p>';
    }

    const assignments = rotation.assignments || {};

    // Toon de komende 8 weekenden
    let html = '<div class="upcoming-list">';
    const today = new Date();
    const currentMonday = getMondayOfWeek(today);

    let count = 0;
    const checkDate = new Date(currentMonday);

    while (count < 8) {
        if (isWeekendOrHolidayWeek(checkDate)) {
            const responsible = getOrCalculateResponsible(checkDate);
            const weekendSat = new Date(checkDate);
            weekendSat.setDate(weekendSat.getDate() + 5);
            const weekendSun = new Date(checkDate);
            weekendSun.setDate(weekendSun.getDate() + 6);
            const dateDisplay = `${weekendSat.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })} – ${weekendSun.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })}`;
            const mondayKey = formatDateYYYYMMDD(checkDate);
            const isManual = !!assignments[mondayKey];

            if (responsible) {
                const teamColor = DataStore.settings.teams[responsible.mainTeam]?.color || '#6b7280';
                const responsibleName = escapeHtml(responsible.name);
                const weekHoliday = typeof getHolidayPeriod === 'function' ? getHolidayPeriod(weekendSat) : null;
                const isVakantieResp = weekHoliday && weekHoliday.responsibleId;
                const badge = isVakantieResp ? ' <span class="upcoming-manual-badge shift-badge-upcoming">vakantie</span>'
                    : isManual ? ' <span class="upcoming-manual-badge">handmatig</span>' : '';
                html += `
                <div class="upcoming-item upcoming-item-clickable" data-monday="${mondayKey}">
                    <span class="upcoming-date">${dateDisplay}</span>
                    <span class="upcoming-name" style="border-left: 3px solid ${teamColor}; padding-left: 8px;">
                        ${responsibleName}${badge}
                    </span>
                    <span class="upcoming-edit-icon">${IconHelper.html(ICONS.edit, 'xs')}</span>
                </div>`;
                count++;
            }
        }
        checkDate.setDate(checkDate.getDate() + 7);

        // Safety: max 52 weken vooruit kijken
        if (checkDate - currentMonday > 365 * 24 * 60 * 60 * 1000) break;
    }

    html += '</div>';
    return html;
}

function showWeekendResponsiblePicker(mondayKey) {
    const eligible = getEligibleEmployeesForResponsible();
    const rotation = DataStore.settings.responsibleRotation || {};
    const assignments = rotation.assignments || {};
    const currentAssignment = assignments[mondayKey] ? String(assignments[mondayKey]) : null;

    const monday = parseDateOnly(mondayKey);
    const sat = new Date(monday);
    sat.setDate(sat.getDate() + 5);
    const sun = new Date(monday);
    sun.setDate(sun.getDate() + 6);
    const dateLabel = `${sat.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' })} – ${sun.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' })}`;

    // Calculate who rotation would pick automatically
    const autoResponsible = (() => {
        const saved = assignments[mondayKey];
        delete assignments[mondayKey];
        const result = getOrCalculateResponsible(monday);
        if (saved !== undefined) assignments[mondayKey] = saved;
        return result;
    })();

    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
        <div class="modal-content modal-content--xs">
            <div class="modal-header">
                <h3>Weekendverantwoordelijke</h3>
                <span class="modal-close" id="weekend-picker-close">&times;</span>
            </div>
            <div class="modal-body" style="padding: 16px;">
                <p style="margin: 0 0 16px; color: var(--text-secondary); font-size: 14px;">${dateLabel}</p>
                <div class="weekend-picker-options">
                    <label class="weekend-picker-option ${!currentAssignment ? 'selected' : ''}" data-value="auto">
                        <input type="radio" name="weekend-responsible" value="auto" ${!currentAssignment ? 'checked' : ''}>
                        <span class="weekend-picker-label">
                            Automatisch (rotatie)
                            ${autoResponsible ? `<span class="weekend-picker-hint">→ ${escapeHtml(autoResponsible.name)}</span>` : ''}
                        </span>
                    </label>
                    ${(() => {
                        // Group eligible employees by team
                        const byTeam = {};
                        eligible.forEach(emp => {
                            const team = emp.mainTeam || 'other';
                            if (!byTeam[team]) byTeam[team] = [];
                            byTeam[team].push(emp);
                        });
                        return Object.entries(byTeam).map(([teamId, emps]) => {
                            const teamInfo = (DataStore.settings.teams || {})[teamId] || {};
                            const teamColor = teamInfo.color || '#6b7280';
                            const teamName = teamInfo.name || teamId;
                            return `<div class="weekend-picker-team-group">
                                <div class="weekend-picker-team-header" style="border-left: 3px solid ${teamColor}; padding-left: 8px; font-size: 12px; color: var(--text-secondary); font-weight: 600; margin: 8px 0 4px;">${escapeHtml(teamName)}</div>
                                ${emps.map(emp => {
                                    const isSelected = currentAssignment === String(emp.id);
                                    return `<label class="weekend-picker-option ${isSelected ? 'selected' : ''}" data-value="${emp.id}">
                                        <input type="radio" name="weekend-responsible" value="${emp.id}" ${isSelected ? 'checked' : ''}>
                                        <span class="weekend-picker-color" style="background: ${teamColor};"></span>
                                        <span class="weekend-picker-label">${escapeHtml(emp.name)}</span>
                                    </label>`;
                                }).join('')}
                            </div>`;
                        }).join('');
                    })()}
                </div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="weekend-picker-cancel">Annuleren</button>
                <button class="btn btn-primary" id="weekend-picker-save">Opslaan</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Highlight selected option
    overlay.querySelectorAll('.weekend-picker-option').forEach(opt => {
        opt.addEventListener('click', () => {
            overlay.querySelectorAll('.weekend-picker-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            opt.querySelector('input').checked = true;
        });
    });

    overlay.querySelector('#weekend-picker-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#weekend-picker-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#weekend-picker-save').addEventListener('click', async () => {
        const selected = overlay.querySelector('input[name="weekend-responsible"]:checked')?.value;
        if (!selected) return;

        if (selected === 'auto') {
            await removeWeekendResponsible(monday);
        } else {
            await setWeekendResponsible(monday, Number(selected));
        }

        overlay.remove();

        // Refresh the upcoming list
        const upcomingContainer = document.querySelector('.upcoming-responsibles');
        if (upcomingContainer) {
            upcomingContainer.innerHTML = renderUpcomingResponsibles();
            IconHelper.init(upcomingContainer);
            attachUpcomingWeekendListeners(upcomingContainer);
        }
        showToast('Weekendverantwoordelijke bijgewerkt', 'success');
    });
}

function attachUpcomingWeekendListeners(container) {
    container.querySelectorAll('.upcoming-item-clickable').forEach(item => {
        item.addEventListener('click', () => {
            const mondayKey = item.dataset.monday;
            if (mondayKey) showWeekendResponsiblePicker(mondayKey);
        });
    });
}

function setupSettingsCollapsibles(scope = document) {
    const cards = [];
    if (scope?.classList?.contains('settings-card') && scope?.dataset?.collapsible) {
        cards.push(scope);
    }
    cards.push(...scope.querySelectorAll('.settings-card[data-collapsible]'));
    cards.forEach(card => {
        const btn = card.querySelector('.settings-toggle-btn');
        if (!btn) return;
        const isOpen = card.dataset.open === 'true';
        card.classList.toggle('is-collapsed', !isOpen);
        btn.textContent = isOpen ? 'Verberg' : 'Toon';
        btn.addEventListener('click', () => {
            const nowCollapsed = !card.classList.toggle('is-collapsed');
            card.dataset.open = nowCollapsed ? 'false' : 'true';
            btn.textContent = nowCollapsed ? 'Toon' : 'Verberg';
        });
    });
}

// ===== AFWEZIGHEID MODAL =====

function setupAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    const closeBtn = document.getElementById('availability-modal-close');
    const cancelBtn = document.getElementById('availability-cancel-btn');
    const saveBtn = document.getElementById('availability-save-btn');
    const removeBtn = document.getElementById('remove-absence-btn');
    const startDateInput = document.getElementById('absence-start-date');
    const endDateInput = document.getElementById('absence-end-date');

    if (!modal || !closeBtn || !cancelBtn || !saveBtn) return;

    closeBtn.addEventListener('click', closeAvailabilityModal);
    cancelBtn.addEventListener('click', closeAvailabilityModal);
    saveBtn.addEventListener('click', handleAvailabilitySave);
    if (removeBtn) removeBtn.addEventListener('click', handleRemoveAbsence);

    // Update date info when dates change
    if (startDateInput) startDateInput.addEventListener('change', updateAbsenceDateInfo);
    endDateInput.addEventListener('change', updateAbsenceDateInfo);
}

function updateAbsenceDateInfo() {
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;
    const infoDiv = document.getElementById('absence-date-info');

    if (startDate && endDate) {
        const start = parseDateOnly(startDate);
        const end = parseDateOnly(endDate);

        if (end >= start) {
            const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
            infoDiv.innerHTML = `<span class="info-badge">${days} dag${days !== 1 ? 'en' : ''} geselecteerd</span>`;
            infoDiv.classList.remove('error');
        } else {
            infoDiv.innerHTML = `<span class="error-text">Einddatum moet na startdatum liggen</span>`;
            infoDiv.classList.add('error');
        }
    } else {
        infoDiv.innerHTML = '';
    }
}

function populateAbsenceEmployeeDropdown() {
    const select = document.getElementById('absence-employee');
    const employees = getAllEmployees(true);

    select.innerHTML = '<option value="">-- Selecteer medewerker --</option>';

    // Group by team
    const teamOrder = getTeamOrder();
    teamOrder.forEach(teamId => {
        const teamEmployees = employees.filter(emp => emp.mainTeam === teamId);
        if (teamEmployees.length > 0) {
            const teamName = DataStore.settings.teams[teamId]?.name || teamId;
            const optgroup = document.createElement('optgroup');
            optgroup.label = teamName;

            teamEmployees.forEach(emp => {
                const option = document.createElement('option');
                option.value = emp.id;
                option.textContent = emp.name;
                optgroup.appendChild(option);
            });

            select.appendChild(optgroup);
        }
    });

    // Medewerkers mogen enkel zichzelf selecteren
    const role = getEffectiveRole();
    if (role === 'medewerker') {
        select.value = AppState.currentUser.id;
        select.disabled = true;
    } else {
        select.disabled = false;
    }
}

function openAvailabilityModal(employeeId = null, date = null) {
    const modal = document.getElementById('availability-modal');
    if (!modal) return;

    const modalTitle = document.getElementById('availability-modal-title');
    const employeeSelect = document.getElementById('absence-employee');
    const startDateInput = document.getElementById('absence-start-date');
    const endDateInput = document.getElementById('absence-end-date');
    const absenceTypeSelect = document.getElementById('absence-type');
    const reasonInput = document.getElementById('availability-reason');
    const removeBtn = document.getElementById('remove-absence-btn');
    const warningDiv = document.getElementById('availability-warning');
    const infoDiv = document.getElementById('absence-date-info');

    // Populate employee dropdown
    populateAbsenceEmployeeDropdown();

    // Check if opening for specific employee/date or general
    if (employeeId && date) {
        const employee = getEmployee(employeeId);
        if (!employee) return;

        modalTitle.textContent = 'Afwezigheid registreren';
        employeeSelect.value = employeeId;
        startDateInput.value = date;
        endDateInput.value = date;

        const absence = getAvailability(employeeId, date);
        const hasShift = getShiftsByEmployee(employeeId, date, date).length > 0;

        // Pre-fill form if absence exists
        if (absence && absence.type) {
            absenceTypeSelect.value = absence.type;
            reasonInput.value = absence.reason || '';
            removeBtn.style.display = 'inline-block';
            modal.dataset.editMode = 'single';
            modal.dataset.originalDate = date;
        } else {
            absenceTypeSelect.value = '';
            reasonInput.value = '';
            removeBtn.style.display = 'none';
            modal.dataset.editMode = 'new';
        }

        // Show warning if employee has shift
        if (hasShift) {
            warningDiv.innerHTML = `<div class="alert alert-warning">${IconHelper.html(ICONS.warning, 'sm')} Deze medewerker heeft al een dienst op deze dag</div>`;
            IconHelper.init(warningDiv);
        } else {
            warningDiv.innerHTML = '';
        }
    } else {
        // Opening fresh (e.g., from button)
        modalTitle.textContent = 'Afwezigheid registreren';
        employeeSelect.value = '';
        startDateInput.value = '';
        endDateInput.value = '';
        absenceTypeSelect.value = '';
        reasonInput.value = '';
        removeBtn.style.display = 'none';
        warningDiv.innerHTML = '';
        modal.dataset.editMode = 'new';
    }

    infoDiv.innerHTML = '';
    updateAbsenceDateInfo();

    modal.classList.remove('hidden');
}

function closeAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    modal.classList.add('hidden');
}

async function handleAvailabilitySave() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;
    const absenceType = document.getElementById('absence-type').value;
    const reason = document.getElementById('availability-reason').value.trim();

    // Validation
    if (!employeeId) {
        showToast('Selecteer een medewerker', 'warning');
        return;
    }
    if (!startDate || !endDate) {
        showToast('Vul beide datums in', 'warning');
        return;
    }
    if (!absenceType) {
        showToast('Selecteer een type afwezigheid', 'warning');
        return;
    }

    // Simple string comparison works for YYYY-MM-DD format
    if (endDate < startDate) {
        showToast('Einddatum moet na startdatum liggen', 'warning');
        return;
    }

    try {
        // Check for conflicts first
        let conflictDates = [];
        // Use string dates to avoid timezone conversion issues
        const startParts = startDate.split('-').map(Number);
        const endParts = endDate.split('-').map(Number);
        let checkDate = new Date(startParts[0], startParts[1] - 1, startParts[2]);
        const endDateObj = new Date(endParts[0], endParts[1] - 1, endParts[2]);

        while (checkDate <= endDateObj) {
            // Format as YYYY-MM-DD without timezone conversion
            const year = checkDate.getFullYear();
            const month = String(checkDate.getMonth() + 1).padStart(2, '0');
            const day = String(checkDate.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;

            const shifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
            if (shifts.length > 0) {
                conflictDates.push(dateStr);
            }
            checkDate.setDate(checkDate.getDate() + 1);
        }

        // Warn about conflicts
        if (conflictDates.length > 0) {
            const employee = getEmployee(employeeId);
            const employeeName = employee?.name || 'Deze medewerker';
            const confirmMsg = `Let op: ${employeeName} heeft nog ${conflictDates.length} dienst(en) ingepland op deze dagen!\n\nDiensten op: ${conflictDates.map(d => formatDate(d)).join(', ')}\n\nDe afwezigheid wordt geregistreerd, maar de diensten blijven staan. Vergeet niet deze diensten te verwijderen of opnieuw toe te wijzen!\n\nDoorgaan?`;
            if (!await showConfirm(confirmMsg, 'Waarschuwing: conflicterende diensten')) {
                return;
            }
        }

        // Determine if we should offer takeover creation (sick/vacation with conflicts)
        let createTakeoverRequests = false;
        if ((absenceType === 'ziek' || absenceType === 'verlof') && conflictDates.length > 0) {
            const confirmTakeover = await showConfirm(
                `Er zijn ${conflictDates.length} dienst(en) op deze dagen.\n\n` +
                `Wil je deze automatisch beschikbaar stellen zodat collega's ze kunnen overnemen?\n\n` +
                `(Ze verschijnen in "Beschikbare shifts" op de Ruilen pagina)`,
                'Shifts beschikbaar stellen?'
            );
            createTakeoverRequests = confirmTakeover;
        }

        showSectionLoading('availability-view', 'Afwezigheid opslaan...');

        // Single atomic API call: availability + optional takeover requests
        const result = await saveBulkAvailabilityWithTakeover(
            employeeId, startDate, endDate, absenceType, reason, createTakeoverRequests
        );

        closeAvailabilityModal();
        renderAvailability();
        renderPlanning(); // Update planning view to show conflicts

        const employee = getEmployee(employeeId);
        const employeeName = employee?.name || 'de medewerker';
        const daysSet = result.availability?.length || 0;
        const typeName = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezigheid' }[absenceType] || 'Afwezigheid';

        let msg = `${typeName} geregistreerd voor ${employeeName} (${daysSet} dag${daysSet !== 1 ? 'en' : ''})`;
        showToast(msg, 'success');

        if (conflictDates.length > 0) {
            showToast(`Vergeet niet de ${conflictDates.length} conflicterende dienst(en) aan te passen in de planning!`, 'warning');
        }

        if (result.takeoverRequests > 0) {
            showToast(`${result.takeoverRequests} takeover verzoek(en) aangemaakt! Collega's kunnen deze shifts nu overnemen via de Ruilen pagina.`, 'success');
        }

        // Show type-specific reminders
        if (absenceType === 'ziek') {
            showToast('Bel de personeelsdienst om je ziekte door te geven', 'info');
        } else if (absenceType === 'verlof' || absenceType === 'overuren') {
            showToast('Vergeet niet dit ook in Eureka aan te passen', 'info');
        }
    } catch (error) {
        console.error('Error saving availability:', error);
        showToast('Er ging iets mis bij het opslaan: ' + error.message, 'error');
    } finally {
        hideSectionLoading('availability-view');
    }
}

async function handleRemoveAbsence() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;

    if (!employeeId || !startDate || !endDate) {
        showToast('Geen afwezigheid om te verwijderen', 'warning');
        return;
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    if (end < start) {
        showToast('Ongeldige datum range', 'warning');
        return;
    }

    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    if (!await showConfirm(`Afwezigheid verwijderen voor ${days} dag${days !== 1 ? 'en' : ''}?`)) {
        return;
    }

    showSectionLoading('availability-view', 'Afwezigheid verwijderen...');

    // Remove absence for each day in range
    let currentDate = parseDateOnly(start);
    const removePromises = [];

    while (currentDate <= end) {
        const dateStr = formatDateYYYYMMDD(currentDate);
        removePromises.push(removeAvailability(employeeId, dateStr, { skipRefresh: true }));
        currentDate.setDate(currentDate.getDate() + 1);
    }

    // Wait for all deletions to complete, then refresh once
    await Promise.all(removePromises);
    await refreshAvailability();

    // Cancel any pending takeover requests for shifts on these dates
    try {
        console.log('[Auto-cancel] Starting auto-cancel for removed absence');
        console.log('[Auto-cancel] Employee ID:', employeeId);
        console.log('[Auto-cancel] Date range:', formatDateYYYYMMDD(start), 'to', formatDateYYYYMMDD(end));

        await getSwapRequests(); // Refresh swap requests
        console.log('[Auto-cancel] Total swap requests in DataStore:', DataStore.swapRequests.length);

        const affectedShifts = [];

        // Find all shifts for this employee in the date range
        let checkDate = parseDateOnly(start);
        while (checkDate <= end) {
            const dateStr = formatDateYYYYMMDD(checkDate);
            const shifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
            console.log(`[Auto-cancel] Date ${dateStr}: Found ${shifts.length} shift(s)`, shifts.map(s => ({ id: s.id, userId: s.userId })));
            affectedShifts.push(...shifts);
            checkDate.setDate(checkDate.getDate() + 1);
        }

        console.log('[Auto-cancel] Total affected shifts:', affectedShifts.length, affectedShifts.map(s => s.id));

        // Debug: Show all takeover requests for this employee
        const employeeTakeoverRequests = DataStore.swapRequests.filter(sr =>
            sr.requester_user_id === employeeId &&
            sr.request_type === 'takeover' &&
            sr.status === 'pending'
        );
        console.log('[Auto-cancel] All pending takeover requests for employee:', employeeTakeoverRequests.map(sr => ({
            id: sr.id,
            requester_shift_id: sr.requester_shift_id,
            status: sr.status
        })));

        // Find and cancel pending takeover requests for these shifts
        const requestsToCancel = DataStore.swapRequests.filter(sr =>
            sr.request_type === 'takeover' &&
            sr.status === 'pending' &&
            sr.requester_user_id === employeeId &&
            affectedShifts.some(shift => shift.id === sr.requester_shift_id)
        );

        console.log('[Auto-cancel] Pending takeover requests for this employee:', DataStore.swapRequests.filter(sr => sr.requester_user_id === employeeId && sr.request_type === 'takeover').length);
        console.log('[Auto-cancel] Requests to cancel:', requestsToCancel.length, requestsToCancel.map(sr => ({ id: sr.id, shiftId: sr.requester_shift_id })));

        if (requestsToCancel.length > 0) {
            const cancelPromises = requestsToCancel.map(sr => {
                console.log(`[Auto-cancel] Cancelling request ${sr.id} for shift ${sr.requester_shift_id}...`);
                return cancelSwapRequest(sr.id)
                    .then(() => console.log(`[Auto-cancel] ✓ Cancelled request ${sr.id}`))
                    .catch(err => {
                        console.error(`[Auto-cancel] ✗ Failed to cancel request ${sr.id}:`, err);
                    });
            });
            await Promise.all(cancelPromises);

            console.log(`[Auto-cancel] Complete: ${requestsToCancel.length} takeover request(s) cancelled`);
        } else {
            console.log('[Auto-cancel] No requests to cancel');
        }
    } catch (error) {
        console.error('[Auto-cancel] Error cancelling takeover requests:', error);
        // Don't block the flow if cancellation fails
    }

    closeAvailabilityModal();
    renderAvailability();
    renderPlanning(); // Update planning view
    hideSectionLoading('availability-view');
}

function exportData() {
    // Export users (with schedule data) - also include as 'employees' for backward compatibility
    const users = DataStore.employees; // Gets non-admin users via getter
    const dataToExport = {
        users: users,
        employees: users, // Backward compatibility
        shifts: DataStore.shifts,
        settings: DataStore.settings,
        exportDate: new Date().toISOString()
    };
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hetvlot-backup-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
}

async function runMigration() {
    if (!await showConfirm('VOLLEDIGE DATABASE MIGRATIE\n\nDit zal:\n- Employees tabel samenvoegen met users\n- Shifts migreren (employee_id -> user_id)\n- Availability migreren (employee_id -> user_id)\n- Employees tabel verwijderen\n- Weekroosters repareren\n\nDit is een grote wijziging, maar 100% veilig:\n- Gebruikt transactions (bij error: automatisch ROLLBACK)\n- Alle data blijft behouden\n- Foreign key mappings correct uitgevoerd\n\nDoorgaan?', 'Database Migratie')) {
        return;
    }

    try {
        const result = await apiFetch('/admin/migrate', { method: 'POST' });
        let message = 'Migratie succesvol!\n\n';

        if (result.results.migrations.length > 0) {
            message += 'Schema updates:\n' + result.results.migrations.map(m => '• ' + m).join('\n') + '\n\n';
        }

        if (result.results.fixes.length > 0) {
            message += 'Data fixes:\n' + result.results.fixes.map(f => '• ' + f).join('\n');
        }

        if (result.results.migrations.length === 0 && result.results.fixes.length === 0) {
            message += 'Geen wijzigingen nodig - database is up-to-date.';
        }

        showToast(message.substring(0, 200), 'success');
        if (message.length > 200) console.log('[Migratie] Volledige output:', message);

        // Reload data to see the fixed weekSchedules
        await loadDataFromAPI();
        renderPlanning();
    } catch (error) {
        showToast('Migratie mislukt: ' + error.message, 'error');
    }
}

async function seedTeams() {
    try {
        const result = await apiFetch('/admin/seed-teams', { method: 'POST' });
        showToast(`Teams aangemaakt! Nieuw: ${result.created}, Bijgewerkt: ${result.updated}, Totaal: ${result.total}`, 'success');

        // Reload data
        await loadDataFromAPI();
        renderSettings();
    } catch (error) {
        showToast('Teams aanmaken mislukt: ' + error.message, 'error');
    }
}

async function showDebugInfo() {
    try {
        const result = await apiFetch('/admin/debug');

        let message = `=== DATABASE DEBUG INFO ===\n\n`;
        message += `TEAMS (${result.teams.length}):\n`;
        result.teams.forEach(t => {
            message += `• ${t.id}: ${t.name}\n`;
        });

        message += `\nMEDEWERKERS (${result.employeeCount}):\n`;
        result.employees.forEach(emp => {
            const ws = emp.weekSchedules;
            const w1 = emp.weekScheduleWeek1;
            const w2 = emp.weekScheduleWeek2;
            message += `\n${emp.name} (ID: ${emp.id}):\n`;
            message += `  mainTeam: ${emp.mainTeam || 'GEEN'}\n`;
            message += `  weekSchedules: type=${ws?.type || typeof ws}, isArray=${Array.isArray(ws)}, length=${ws?.length || 0}\n`;
            message += `  weekScheduleWeek1: type=${w1?.type || typeof w1}, isArray=${w1?.isArray || Array.isArray(w1)}, length=${w1?.length || 0}\n`;
            message += `  weekScheduleWeek2: type=${w2?.type || typeof w2}, isArray=${w2?.isArray || Array.isArray(w2)}, length=${w2?.length || 0}\n`;
        });

        console.log(message);
        console.log('Full debug result:', result);
        showToast(message.length > 200 ? 'Debug info getoond in console (F12)' : message, 'info');
    } catch (error) {
        showToast('Debug info ophalen mislukt: ' + error.message, 'error');
    }
}

function sanitizeString(value, maxLen = 200) {
    if (typeof value !== 'string') return '';
    return value.replace(/\0/g, '').trim().slice(0, maxLen);
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    return formatDateYYYYMMDD(parseDateOnly(value)) === value;
}

function isValidTimeString(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(':').map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function sanitizeSettings(rawSettings) {
    const normalized = normalizeSettings(rawSettings || {});
    const defaults = normalizeSettings(DEFAULT_SETTINGS || {});

    const teams = {};
    Object.keys(normalized.teams || {}).forEach(teamId => {
        const team = normalized.teams[teamId] || {};
        const name = sanitizeString(team.name || defaults.teams?.[teamId]?.name || teamId, 80);
        const color = typeof team.color === 'string' && /^#([0-9a-fA-F]{3}){1,2}$/.test(team.color)
            ? team.color
            : (defaults.teams?.[teamId]?.color || '#64748b');
        teams[teamId] = { name, color };
    });

    const shiftTemplates = {};
    Object.keys(normalized.shiftTemplates || {}).forEach(templateId => {
        if (!/^[a-z0-9_-]+$/i.test(templateId)) return;
        const template = normalized.shiftTemplates[templateId] || {};
        if (!isValidTimeString(template.start) || !isValidTimeString(template.end)) return;
        shiftTemplates[templateId] = {
            name: sanitizeString(template.name || templateId, 80),
            start: template.start,
            end: template.end
        };
    });

    const holidayPeriods = Array.isArray(normalized.holidayPeriods)
        ? normalized.holidayPeriods
            .map(period => ({
                id: Number.isFinite(Number(period?.id)) ? Number(period.id) : Date.now(),
                name: sanitizeString(period?.name || '', 80),
                startDate: period?.startDate,
                endDate: period?.endDate
            }))
            .filter(period => period.name && isValidDateString(period.startDate) && isValidDateString(period.endDate))
        : [];

    const eligibleTeams = Array.isArray(normalized.responsibleRotation?.eligibleTeams)
        ? normalized.responsibleRotation.eligibleTeams.filter(teamId => teams[teamId])
        : (defaults.responsibleRotation?.eligibleTeams || []);

    const assignments = {};
    const rawAssignments = normalized.responsibleRotation?.assignments || {};
    Object.keys(rawAssignments).forEach(dateKey => {
        const employeeId = Number(rawAssignments[dateKey]);
        if (Number.isFinite(employeeId) && isValidDateString(dateKey)) {
            assignments[dateKey] = employeeId;
        }
    });

    const rotationStart = isValidDateString(normalized.responsibleRotation?.rotationStart)
        ? normalized.responsibleRotation.rotationStart
        : (defaults.responsibleRotation?.rotationStart || '');
    const rotationStartEmployee = Number.isFinite(Number(normalized.responsibleRotation?.rotationStartEmployee))
        ? String(normalized.responsibleRotation.rotationStartEmployee)
        : (defaults.responsibleRotation?.rotationStartEmployee || '');

    const rules = {
        minHoursBetweenShifts: Number(normalized.rules?.minHoursBetweenShifts) || defaults.rules?.minHoursBetweenShifts || 11,
        minStaffingDay: Number(normalized.rules?.minStaffingDay) || defaults.rules?.minStaffingDay || 1,
        minStaffingNight: Number(normalized.rules?.minStaffingNight) || defaults.rules?.minStaffingNight || 1,
        maxConsecutiveDays: Number(normalized.rules?.maxConsecutiveDays) || defaults.rules?.maxConsecutiveDays || 6,
        mandatoryRestAfterNight: normalized.rules?.mandatoryRestAfterNight !== false,
        minFreeWeekendsPerMonth: Number(normalized.rules?.minFreeWeekendsPerMonth) || defaults.rules?.minFreeWeekendsPerMonth || 1
    };

    const holidayRules = {
        minStaffingDay: Number(normalized.holidayRules?.minStaffingDay) || defaults.holidayRules?.minStaffingDay || 2,
        minStaffingNight: Number(normalized.holidayRules?.minStaffingNight) || defaults.holidayRules?.minStaffingNight || 1
    };

    return {
        ...normalized,
        teams,
        shiftTemplates,
        holidayPeriods,
        rules,
        holidayRules,
        responsibleRotation: {
            eligibleTeams,
            assignments,
            rotationStart,
            rotationStartEmployee
        }
    };
}

function sanitizeImportedData(rawData) {
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    const settings = sanitizeSettings(data.settings);

    const employees = Array.isArray(data.employees) ? data.employees
        .map(emp => {
            const id = Number(emp?.id);
            if (!Number.isFinite(id)) return null;
            const mainTeam = settings.teams[emp?.mainTeam] ? emp.mainTeam : Object.keys(settings.teams)[0];
            const extraTeams = Array.isArray(emp?.extraTeams) ? emp.extraTeams.filter(teamId => settings.teams[teamId]) : [];
            // Support both new weekSchedules array and old weekScheduleWeek1/2 format
            let weekScheduleWeek1, weekScheduleWeek2, weekSchedules;
            if (Array.isArray(emp?.weekSchedules) && emp.weekSchedules.length >= 2) {
                weekSchedules = emp.weekSchedules;
                weekScheduleWeek1 = Array.isArray(weekSchedules[0]) ? weekSchedules[0] : [];
                weekScheduleWeek2 = Array.isArray(weekSchedules[1]) ? weekSchedules[1] : [];
            } else {
                weekScheduleWeek1 = Array.isArray(emp?.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [];
                weekScheduleWeek2 = Array.isArray(emp?.weekScheduleWeek2) ? emp.weekScheduleWeek2 : [];
                weekSchedules = [weekScheduleWeek1, weekScheduleWeek2];
            }

            function sanitizeScheduleItem(item) {
                const dayOfWeek = Number(item?.dayOfWeek);
                if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
                if (!settings.teams[item?.team]) return null;
                if (!isValidTimeString(item?.startTime) || !isValidTimeString(item?.endTime)) return null;
                return {
                    dayOfWeek,
                    enabled: Boolean(item?.enabled),
                    team: item.team,
                    startTime: item.startTime,
                    endTime: item.endTime
                };
            }

            return {
                id,
                name: sanitizeString(emp?.name || 'Onbekend', 80),
                email: sanitizeString(emp?.email || '', 120),
                mainTeam,
                extraTeams,
                contractHours: Number(emp?.contractHours) || 0,
                active: emp?.active !== false,
                weekScheduleWeek1: weekScheduleWeek1.map(sanitizeScheduleItem).filter(Boolean),
                weekScheduleWeek2: weekScheduleWeek2.map(sanitizeScheduleItem).filter(Boolean),
                weekSchedules: weekSchedules.map(ws => (Array.isArray(ws) ? ws : []).map(sanitizeScheduleItem).filter(Boolean)),
                createdAt: emp?.createdAt || new Date().toISOString()
            };
        })
        .filter(Boolean) : [];

    const employeeIds = new Set(employees.map(emp => String(emp.id)));

    const shifts = Array.isArray(data.shifts) ? data.shifts
        .map(shift => {
            const employeeId = Number(shift?.employeeId);
            if (!Number.isFinite(employeeId) || !employeeIds.has(String(employeeId))) return null;
            if (!settings.teams[shift?.team]) return null;
            if (!isValidDateString(shift?.date)) return null;
            if (!isValidTimeString(shift?.startTime) || !isValidTimeString(shift?.endTime)) return null;
            return {
                id: Number.isFinite(Number(shift?.id)) ? Number(shift.id) : Date.now() + Math.random(),
                employeeId,
                team: shift.team,
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                notes: sanitizeString(shift?.notes || '', 300),
                createdAt: shift?.createdAt || new Date().toISOString()
            };
        })
        .filter(Boolean) : [];

    const availability = Array.isArray(data.availability) ? data.availability
        .map(entry => {
            const employeeId = Number(entry?.employeeId);
            if (!Number.isFinite(employeeId) || !employeeIds.has(String(employeeId))) return null;
            if (!isValidDateString(entry?.date)) return null;
            const type = entry?.type;
            const allowedTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
            if (!allowedTypes.includes(type)) return null;
            return {
                key: `${employeeId}_${entry.date}`,
                employeeId,
                date: entry.date,
                type,
                reason: sanitizeString(entry?.reason || '', 200),
                updatedAt: entry?.updatedAt || new Date().toISOString()
            };
        })
        .filter(Boolean) : [];

    return { employees, shifts, availability, settings };
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) {
        console.log('Geen bestand geselecteerd');
        return;
    }

    console.log('Bestand geselecteerd:', file.name);

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            console.log('Bestand gelezen, parsing JSON...');
            const data = JSON.parse(e.target.result);
            console.log('Data parsed:', data);

            // Support both old (employees) and new (users) format
            const usersToImport = data.users || data.employees || [];
            console.log('Gevonden gebruikers/medewerkers:', usersToImport.length);

            if (usersToImport.length === 0) {
                showToast('Geen medewerkers gevonden in backup bestand', 'warning');
                return;
            }

            if (!await showConfirm(`${usersToImport.length} medewerkers gevonden. Importeren naar de database?\n\nNieuwe medewerkers krijgen het standaard wachtwoord: Welkom123!`, 'Backup importeren')) {
                return;
            }

            // Import via bulk API endpoint
            const importPayload = {
                users: usersToImport.map(emp => ({
                    name: emp.name || 'Onbekend',
                    email: emp.email || null,
                    mainTeam: emp.mainTeam || null,
                    extraTeams: Array.isArray(emp.extraTeams) ? emp.extraTeams : [],
                    contractHours: Number(emp.contractHours) || 0,
                    active: emp.active !== false,
                    weekScheduleWeek1: Array.isArray(emp.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [],
                    weekScheduleWeek2: Array.isArray(emp.weekScheduleWeek2) ? emp.weekScheduleWeek2 : [],
                    weekSchedules: Array.isArray(emp.weekSchedules) ? emp.weekSchedules : [
                        Array.isArray(emp.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [],
                        Array.isArray(emp.weekScheduleWeek2) ? emp.weekScheduleWeek2 : []
                    ]
                }))
            };

            const result = await apiFetch('/import', {
                method: 'POST',
                body: JSON.stringify(importPayload)
            });

            let message = `${result.results.imported} items geïmporteerd`;
            if (result.results.skipped > 0) {
                message += `, ${result.results.skipped} items overgeslagen`;
            }
            showToast(message, 'success');

            if (result.results.errors && result.results.errors.length > 0) {
                console.error('Import fouten:', result.results.errors);
                showToast(`${result.results.errors.length} fouten opgetreden bij import. Niet alle items konden worden verwerkt.`, 'warning');
            }

            // Reload page to show new data
            location.reload();
        } catch (error) {
            console.error('Import error:', error);
            showToast('Fout bij importeren: ' + getUserFriendlyError(error), 'error');
        }
    };

    reader.onerror = (error) => {
        console.error('FileReader error:', error);
        showToast('Fout bij lezen van bestand', 'error');
    };

    reader.readAsText(file);
    // Reset file input zodat hetzelfde bestand opnieuw gekozen kan worden
    event.target.value = '';
}

// Make functions available globally for inline onclick handlers
window.openAvailabilityModal = openAvailabilityModal;
window.closeAvailabilityModal = closeAvailabilityModal;
window.handleAvailabilitySave = handleAvailabilitySave;
window.handleRemoveAbsence = handleRemoveAbsence;

document.addEventListener('DOMContentLoaded', () => {
    init();
    // Aria-labels op icon-only knoppen (accessibility)
    document.querySelectorAll('.modal-close:not([aria-label])').forEach(el => {
        el.setAttribute('aria-label', 'Sluiten');
        el.setAttribute('role', 'button');
    });
    console.log('Het Vlot Roosterplanning is gestart!');
});
