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
    builderWeekNumber: 1,        // 1 or 2 (bi-weekly)
    builderTeamFilter: null,
    builderGrid: {},             // { [userId]: { [dayIndex0to6]: { startTime, endTime, team } } }
    builderIsDirty: false,
    showHeatmap: false,
    settingsDirty: false,
    employeeSortMode: 'name',
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
    redo: 'redo-2'
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
    const start = new Date(AppState.currentWeekStart);
    start.setDate(start.getDate() - 14);
    const horizon = DataStore.settings?.planningHorizon?.weeks || 4;
    const end = new Date(AppState.currentWeekStart);
    end.setDate(end.getDate() + (horizon * 7) + 14);
    setActiveShiftRange(formatDateYYYYMMDD(start), formatDateYYYYMMDD(end));
}

// ===== CONFIRMATION DIALOG SYSTEM =====
function showConfirm(message, title = 'Bevestig actie') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');

        // Set content
        titleEl.textContent = title;
        messageEl.textContent = message;

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
    DOM.navButtons = document.querySelectorAll('.nav-btn');
    DOM.logoutBtn = document.getElementById('logout-btn');
    DOM.currentUserSpan = document.getElementById('current-user');
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
        showToast('Er is een fout opgetreden bij het starten van de applicatie. Check de console (F12) voor details.', 'error');
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

    // Employee sort dropdown
    const employeeSortSelect = document.getElementById('employee-sort');
    if (employeeSortSelect) {
        employeeSortSelect.addEventListener('change', (e) => {
            AppState.employeeSortMode = e.target.value;
            renderEmployees();
        });
    }

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
        // Auto-apply base schedules after data loads
        await autoApplyBaseSchedules();
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
        // Auto-apply base schedules after data loads
        await autoApplyBaseSchedules();
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

function showApp() {
    DOM.loginContainer.classList.add('hidden');
    DOM.appContainer.classList.remove('hidden');
    DOM.currentUserSpan.textContent = AppState.currentUser.name;
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
    const isLeadOrAdmin = ['admin', 'roosterverantwoordelijke'].includes(role);

    let html = '';
    html += renderHomeWelcome(user, role);
    html += '<div class="home-grid">';
    html += renderHomeShifts(user);
    html += renderHomeQuickActions(role);
    if (isLeadOrAdmin) {
        html += renderHomeWeekendInfo();
    }
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
            const dateCompare = a.date.localeCompare(b.date);
            if (dateCompare !== 0) return dateCompare;
            return (a.startTime || a.start_time || '').localeCompare(b.startTime || b.start_time || '');
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
        if (r.status !== 'pending') return false;

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
            <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(245, 158, 11, 0.1); border-radius: 8px; margin-bottom: 12px; border-left: 3px solid var(--warning-color);">
                <div>
                    <strong>Vakantiewerking actief</strong>
                    <div style="font-size: 0.85rem; color: var(--text-secondary);">${escapeHtml(holidayPeriod.name || 'Vakantieperiode')}</div>
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

            bodyHtml += `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color); ${!isThisWeek ? 'opacity: 0.7;' : ''}">
                    <div>
                        <span style="font-weight: ${isThisWeek ? '600' : '400'};">Weekend ${dateStr}</span>
                        ${isThisWeek ? '<span style="font-size: 0.75rem; background: var(--primary-color); color: white; padding: 1px 6px; border-radius: 4px; margin-left: 6px;">Deze week</span>' : ''}
                    </div>
                    <span style="font-size: 0.9rem; color: var(--text-secondary);">${respName}</span>
                </div>
            `;
        });
    } else {
        bodyHtml += '<div style="color: var(--text-secondary); font-size: 0.9rem; padding: 8px 0;">Geen open weekenden komende 4 weken</div>';
    }

    bodyHtml += '</div>';

    return `
        <div class="home-card">
            <div class="home-card-header">
                Weekend & Vakantie
                ${isHoliday ? '<span class="card-count" style="background: var(--warning-color); color: white; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; margin-left: 8px;">Vakantie</span>' : ''}
            </div>
            ${bodyHtml}
        </div>
    `;
}

async function switchView(viewName) {
    // Warn about unsaved settings changes
    if (AppState.settingsDirty && AppState.currentView === 'settings' && viewName !== 'settings') {
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in instellingen. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        AppState.settingsDirty = false;
    }
    // Clear undo history when switching views
    UndoManager.clear();

    // Cleanup drag handlers when switching views
    if (typeof DragHandler !== 'undefined') {
        DragHandler.cleanup();
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
        const weekNumber = getWeekNumber(formatDateYYYYMMDD(AppState.currentWeekStart));
        DOM.currentPeriod.textContent = `Week ${weekNumber} | ${startStr} - ${endStr}`;
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

    // Restore window scroll position after DOM updates
    requestAnimationFrame(() => {
        window.scrollTo(0, savedScrollY);
    });
}

function renderCoverageHeatmap() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const teams = DataStore.settings.teams || {};
    const teamOrder = getTeamOrder()
        .filter(t => AppState.visibleTeams.includes(t) && teams[t]);
    const minStaffingDay = DataStore.settings.rules?.minStaffingDay || 2;

    let html = '<div class="coverage-heatmap">';
    html += '<div class="heatmap-title">Team Bezetting</div>';
    html += '<div class="heatmap-grid">';

    // Header row
    html += '<div class="heatmap-row heatmap-header">';
    html += '<div class="heatmap-team-cell">Team</div>';
    const dayNames = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
    weekDates.forEach(date => {
        const d = parseDateOnly(date);
        html += `<div class="heatmap-day-cell">${dayNames[d.getDay()]} ${d.getDate()}</div>`;
    });
    html += '</div>';

    // Team rows
    teamOrder.forEach(teamId => {
        const team = teams[teamId];
        html += '<div class="heatmap-row">';
        html += `<div class="heatmap-team-cell"><span class="heatmap-team-dot" style="background:${escapeHtml(team.color)}"></span>${escapeHtml(team.name)}</div>`;

        weekDates.forEach(date => {
            const count = DataStore.shifts.filter(s => s.team === teamId && s.date === date).length;
            const d = parseDateOnly(date);
            const isWeekend = d.getDay() === 0 || d.getDay() === 6;
            const closed = isWeekend && typeof isWeekendOpen === 'function' && !isWeekendOpen(date);

            let colorClass = 'heatmap-red';
            if (closed) colorClass = 'heatmap-closed';
            else if (count >= minStaffingDay + 1) colorClass = 'heatmap-green';
            else if (count >= minStaffingDay) colorClass = 'heatmap-yellow';
            else if (count > 0) colorClass = 'heatmap-orange';

            html += `<div class="heatmap-cell ${colorClass}" data-date="${date}" data-team="${teamId}"
                onclick="showHeatmapDetail('${teamId}', '${date}')" title="${count} dienst${count !== 1 ? 'en' : ''}">
                ${closed ? '-' : count}
            </div>`;
        });

        html += '</div>';
    });

    html += '</div>';
    html += `<div class="heatmap-legend">
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-red"></span>Geen</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-orange"></span>Onder min.</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-yellow"></span>Minimum</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-green"></span>Boven min.</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-closed"></span>Gesloten</span>
    </div>`;
    html += '</div>';

    return html;
}

function showHeatmapDetail(teamId, date) {
    const team = (DataStore.settings.teams || {})[teamId];
    const shifts = DataStore.shifts.filter(s => s.team === teamId && s.date === date);

    let msg = `${team?.name || teamId} - ${formatDate(date)}\n`;
    if (shifts.length === 0) {
        msg += 'Geen diensten ingepland.';
    } else {
        shifts.forEach(s => {
            const emp = getEmployee(s.employeeId);
            msg += `${emp?.name || 'Onbekend'}: ${s.startTime} - ${s.endTime}\n`;
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
        DOM.rosterCalendar.innerHTML = '<div class="no-shifts-message">Planner kon niet geladen worden. Check de console (F12).</div>';
    }
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

    // Group employees by their main team - only show visible teams
    const teams = DataStore.settings.teams || {};
    const teamOrder = getTeamOrder()
        .filter(t => AppState.visibleTeams.includes(t));
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name));
    });

    // Add employees without a team to a special "no-team" category
    const employeesWithoutTeam = employees
        .filter(emp => !emp.mainTeam || !teamOrder.includes(emp.mainTeam))
        .sort((a, b) => a.name.localeCompare(b.name));
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
        html += '<div class="no-shifts-message">Geen diensten deze week</div>';
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

                                // Check if this is Sunday (last day of week view) - if so, only show day 1 portion
                                // to prevent overflow outside the visible week
                                if (dayOfWeek === 0) {
                                    // Sunday: only show the portion until midnight (don't extend into next week)
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

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
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

                                // Check if this is Sunday (last day of week view)
                                if (dayOfWeek === 0) {
                                    // Sunday: only show the portion until midnight
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

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
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
            .sort((a, b) => a.name.localeCompare(b.name));
    });

    // Employees without team
    const employeesWithoutTeam = employees
        .filter(emp => !emp.mainTeam || !teamOrder.includes(emp.mainTeam))
        .sort((a, b) => a.name.localeCompare(b.name));
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
        html += '<div class="no-shifts-message">Geen diensten deze maand</div>';
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

// Render shift block for Google Calendar-style view
function renderShiftBlock(shift, stackInfo = { offset: 0, total: 1, groupShifts: [] }) {
    const employee = getEmployee(shift.employeeId);
    if (!employee) return '';

    const validation = validateShift(shift, shift.id);
    const availability = getAvailability(shift.employeeId, shift.date);

    // Parse shift times
    const [startHour, startMin] = shift.startTime.split(':').map(Number);
    const [endHour, endMin] = shift.endTime.split(':').map(Number);

    // Calculate position and height (60px per hour, starting from 7:00)
    const HOUR_HEIGHT = 60; // pixels per hour
    const START_HOUR = 7;

    // Convert times to fractional hours from 7:00
    const startFractional = startHour + startMin / 60 - START_HOUR;
    const endFractional = (endHour < startHour ? endHour + 24 : endHour) + endMin / 60 - START_HOUR;

    const top = startFractional * HOUR_HEIGHT;
    const height = (endFractional - startFractional) * HOUR_HEIGHT;

    // Calculate stacking offset for overlapping shifts
    const STACK_OFFSET = 8; // pixels to offset each stacked shift
    const leftOffset = stackInfo.offset * STACK_OFFSET;
    const rightOffset = (stackInfo.total - stackInfo.offset - 1) * STACK_OFFSET;

    // Build CSS class
    let cardClass = `shift-block team-${shift.team}`;

    // Add auto/manual class for visual distinction
    if (shift.source === 'auto') {
        cardClass += ' shift-auto';
    } else {
        cardClass += ' shift-manual';
    }

    // Check if employee is absent - this is a conflict!
    // Only mark as absent if there's a valid absence type (verlof, ziek, etc.)
    const validAbsenceTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
    const isAbsent = availability && availability.type && validAbsenceTypes.includes(availability.type);

    if (isAbsent) {
        cardClass += ' shift-absent-conflict';
    } else if (!validation.isValid) {
        cardClass += ' shift-error';
    } else if (validation.hasWarnings) {
        cardClass += ' shift-warning';
    }

    if (endHour < startHour) {
        cardClass += ' shift-nacht';
    }

    // Add stacked class if there are multiple shifts
    if (stackInfo.total > 1) {
        cardClass += ' shift-stacked';
    }

    // Availability icon with more info
    let availabilityIcon = '';
    if (isAbsent) {
        const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig' };
        const label = absenceLabels[availability.type] || 'Afwezig';
        availabilityIcon = `<span class="shift-availability-indicator unavailable" title="CONFLICT: ${label}">${IconHelper.html(ICONS.warning, 'xs')} ${label}</span>`;
    }

    // Add count badge for stacked shifts (only on the top shift)
    let countBadge = '';
    if (stackInfo.total > 1 && stackInfo.offset === stackInfo.total - 1) {
        countBadge = `<span class="shift-count-badge">${stackInfo.total}</span>`;
    }

    const employeeName = escapeHtml(employee.name);
    return `<div class="${cardClass}"
                 data-shift-id="${shift.id}"
                 style="top: ${top}px; height: ${height}px; left: ${leftOffset}px; right: ${rightOffset}px; z-index: ${100 + stackInfo.offset};">
        <div class="shift-block-content">
            <div class="shift-employee-name">${employeeName}${availabilityIcon}</div>
            <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
            ${countBadge}
            ${hasPermission('MANAGE_SHIFTS') ? `<button class="shift-delete-btn" data-shift-id="${shift.id}">${IconHelper.html(ICONS.close, 'xs')}</button>` : ''}
        </div>
    </div>`;
}

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

    const employeeName = escapeHtml(employee.name);
    return `<div class="${cardClass}" data-shift-id="${shift.id}">
        <div class="shift-employee-name">${employeeName}${availabilityIcon}</div>
        <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
        <div class="shift-card-footer">
            <span class="shift-team-badge team-${shift.team}">${escapeHtml(DataStore.settings.teams[shift.team].name)}</span>
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

    let issuesHtml = sourceHtml;
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

    if (await showConfirm(`Weet je zeker dat je ${shiftDescription} wilt verwijderen?`)) {
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
    targetPreview.innerHTML = '<p style="color: #94a3b8;">Selecteer eerst een collega en shift</p>';

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
        document.getElementById('swap-target-shift-preview').innerHTML = '<p style="color: #94a3b8;">Selecteer eerst een collega en shift</p>';
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
        document.getElementById('swap-target-shift-preview').innerHTML = '<p style="color: #94a3b8;">Selecteer een shift</p>';
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
                <p style="margin-top: 0.5rem;">Deze ruil kan worden ingediend voor goedkeuring.</p>
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
        showToast('Fout bij indienen ruilverzoek: ' + (error.message || 'Onbekende fout'), 'error');
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
                    <p style="margin-top: 0.5rem;">Deze ruil kan veilig worden goedgekeurd.</p>
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
        showToast('Fout bij goedkeuren: ' + (error.message || 'Onbekende fout'), 'error');
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
        showToast('Fout bij afwijzen: ' + (error.message || 'Onbekende fout'), 'error');
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
        showToast('Fout bij indienen verzoek: ' + (error.message || 'Onbekende fout'), 'error');
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
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Er is een fout opgetreden: ' + error.message + '</li></ul>';
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

        if (AppState.employeeSortMode === 'hours-low' || AppState.employeeSortMode === 'hours-high') {
            teamEmps.forEach(emp => {
                const hoursThisWeek = getEmployeeHoursThisWeek(emp.id, currentWeekStartDate);
                const contractHours = emp.contractHours || 0;
                emp._hoursDiff = contractHours > 0 ? hoursThisWeek - contractHours : hoursThisWeek;
            });
            if (AppState.employeeSortMode === 'hours-low') {
                teamEmps.sort((a, b) => a._hoursDiff - b._hoursDiff);
            } else {
                teamEmps.sort((a, b) => b._hoursDiff - a._hoursDiff);
            }
        } else {
            teamEmps.sort((a, b) => a.name.localeCompare(b.name));
        }

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

            <div class="settings-card" style="grid-column: 1 / -1;">
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

    // Calculate hours
    const weekStartDate = getEmployeeWeekStart(emp.id);
    const weekDates = getWeekDates(weekStartDate);
    const startDate = weekDates[0];
    const endDate = weekDates[6];
    const weekNumber = getISOWeekNumber(weekStartDate);
    const hoursThisWeek = getEmployeeHoursThisWeek(emp.id, startDate);
    const hoursThisMonth = getEmployeeHoursThisMonth(emp.id, startDate);
    const contractHours = emp.contractHours || 0;
    const monthContractHours = contractHours * 4.33;
    const overtimeWeek = contractHours > 0 ? Math.max(0, hoursThisWeek - contractHours) : 0;
    const overtimeMonth = contractHours > 0 ? Math.max(0, hoursThisMonth - monthContractHours) : 0;

    // Calculate percentages for progress bars
    const weekPercentage = contractHours > 0 ? Math.min((hoursThisWeek / contractHours) * 100, 100) : 0;
    const monthPercentage = contractHours > 0 ? Math.min((hoursThisMonth / (contractHours * 4.33)) * 100, 100) : 0;

    // Determine status colors
    const weekColor = hoursThisWeek > contractHours ? '#ef4444' : hoursThisWeek > contractHours * 0.9 ? '#f59e0b' : '#10b981';
    const monthColor = hoursThisMonth > (contractHours * 4.33) ? '#ef4444' : hoursThisMonth > (contractHours * 4.33 * 0.9) ? '#f59e0b' : '#10b981';

    return `
        <div class="employee-card" data-employee-id="${emp.id}">
            <div class="employee-header">
                <div class="employee-name">${employeeName}</div>
                <span class="employee-status ${statusClass}">${statusText}</span>
            </div>
            <div class="employee-info">
                ${emp.email ? `<div class="employee-info-item">${IconHelper.html(ICONS.email, 'xs')} ${employeeEmail}</div>` : ''}
                ${emp.contractHours ? `<div class="employee-info-item">${IconHelper.html(ICONS.clock, 'xs')} ${emp.contractHours}u/week contract</div>` : ''}
            </div>
            <div class="employee-teams">
                <span class="team-badge ${emp.mainTeam}">${mainTeamName}</span>
            </div>
            ${contractHours > 0 ? `
                <div class="employee-hours">
                    <div class="hours-week-label">
                        <span class="week-pill">Week ${weekNumber}</span>
                        <span class="week-range">${formatDate(startDate)} - ${formatDate(endDate)}</span>
                    </div>
                    <div class="hours-section">
                        <div class="hours-label">Deze week: ${hoursThisWeek.toFixed(1)}u / ${contractHours}u</div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${weekPercentage}%; background: ${weekColor};"></div>
                        </div>
                    </div>
                    <div class="month-only">
                        <div class="hours-section">
                            <div class="hours-label">Deze maand: ${hoursThisMonth.toFixed(1)}u / ${monthContractHours.toFixed(0)}u</div>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: ${monthPercentage}%; background: ${monthColor};"></div>
                            </div>
                        </div>
                    </div>
                    ${(overtimeWeek > 0 || overtimeMonth > 0) ? `
                        <div class="overtime-summary">
                            ${overtimeWeek > 0 ? `<span class="overtime-chip">Overuren week: ${overtimeWeek.toFixed(1)}u</span>` : ''}
                            ${overtimeMonth > 0 ? `<span class="overtime-chip month-only">Overuren maand: ${overtimeMonth.toFixed(1)}u</span>` : ''}
                        </div>
                    ` : ''}
                    <div class="hours-controls">
                        <div class="hours-week-nav">
                            <button class="week-nav-btn" type="button" data-employee-id="${emp.id}" data-direction="prev" title="Vorige week">${IconHelper.html(ICONS.left, 'xs')}</button>
                            <button class="week-nav-btn" type="button" data-employee-id="${emp.id}" data-direction="today" title="Huidige week">${IconHelper.html('circle-dot', 'xs')}</button>
                            <button class="week-nav-btn" type="button" data-employee-id="${emp.id}" data-direction="next" title="Volgende week">${IconHelper.html(ICONS.right, 'xs')}</button>
                        </div>
                        <button class="hours-toggle-btn" type="button" data-employee-id="${emp.id}">Toon maand</button>
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

function openAddEmployeeModal() {
    AppState.editingEmployeeId = null;
    DOM.employeeModalTitle.textContent = 'Medewerker toevoegen';
    DOM.employeeForm.reset();
    DOM.employeeActive.checked = true;
    DOM.employeeDeleteBtn.style.display = 'none';
    generateWeekScheduleHTML();
    resetWeekScheduleForm();
    DOM.employeeModal.classList.remove('hidden');
}

function openEditEmployeeModal(employeeId) {
    const employee = getEmployee(employeeId);
    if (!employee) return;
    AppState.editingEmployeeId = employeeId;
    DOM.employeeModalTitle.textContent = `Basisrooster: ${employee.name}`;

    // Hidden fields for form submission (preserve existing values)
    DOM.employeeName.value = employee.name;
    DOM.employeeEmail.value = employee.email || '';
    DOM.employeeMainTeam.value = employee.mainTeam;
    DOM.employeeContract.value = employee.contractHours || '';
    DOM.employeeActive.value = employee.active !== false ? 'true' : 'false';

    generateWeekScheduleHTML();
    const cycleLen = getCycleLength();
    for (let w = 1; w <= cycleLen; w++) {
        loadWeekScheduleForm(w, getEmployeeWeekSchedule(employee, w));
    }
    // Delete button hidden - accounts are managed via Settings > Accounts
    DOM.employeeDeleteBtn.style.display = 'none';
    DOM.employeeModal.classList.remove('hidden');
}

function closeEmployeeModal() {
    DOM.employeeModal.classList.add('hidden');
    DOM.employeeForm.reset();
    AppState.editingEmployeeId = null;
    DOM.employeeDeleteBtn.style.display = 'none';
}

async function handleEmployeeSubmit(e) {
    e.preventDefault();
    const cycleLen = getCycleLength();
    const weekSchedules = [];
    for (let w = 1; w <= cycleLen; w++) {
        weekSchedules.push(getWeekScheduleFromForm(w));
    }

    const employeeData = {
        name: DOM.employeeName.value.trim(),
        email: DOM.employeeEmail.value.trim(),
        mainTeam: DOM.employeeMainTeam.value,
        extraTeams: [],
        contractHours: parseFloat(DOM.employeeContract.value) || 0,
        active: DOM.employeeActive.value === 'true',
        weekScheduleWeek1: weekSchedules[0] || [],
        weekScheduleWeek2: weekSchedules[1] || [],
        weekSchedules: weekSchedules
    };
    let targetEmployeeId = AppState.editingEmployeeId;
    showSectionLoading('employees-view', 'Medewerker opslaan...');
    try {
        if (AppState.editingEmployeeId) {
            await updateEmployee(AppState.editingEmployeeId, employeeData);
        } else {
            const newEmp = await addEmployee(employeeData);
            targetEmployeeId = newEmp?.id;
        }
        closeEmployeeModal();
        renderEmployees();

        // Regenerate auto-shifts via backend (atomic transaction)
        if (targetEmployeeId) {
            await applyScheduleViaBackend(targetEmployeeId, { clearBlocks: true });
        }
        await Promise.all([refreshShifts(), fetchShiftBlocks()]);

        // Refresh planning view if currently visible
        if (AppState.currentView === 'planning') {
            renderPlanning();
        }
    } catch (error) {
        console.error('Error saving employee:', error);
        showToast('Fout bij opslaan medewerker: ' + (error.message || 'Onbekende fout'), 'error');
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
        showToast('Fout bij verwijderen: ' + (error.message || 'Onbekende fout'), 'error');
    } finally {
        hideSectionLoading('employees-view');
    }
}

// ===== BASISROOSTER FUNCTIES =====

async function autoApplyBaseSchedules({ clearBlocks = false } = {}) {
    // Skip if already generated in this session
    if (AppState.schedulesGenerated) {
        console.log('[Auto Schedule] Already generated this session, skipping');
        return { created: 0, removed: 0 };
    }

    console.log('[Auto Schedule] Starting server-side schedule application...');

    const employees = getAllEmployees(true);
    const employeesWithSchedule = employees.filter(emp => hasAnyWeekSchedule(emp));
    console.log(`[Auto Schedule] Found ${employees.length} active employees, ${employeesWithSchedule.length} with base schedules configured`);

    let totalCreated = 0;
    let totalDeleted = 0;

    for (const emp of employeesWithSchedule) {
        try {
            const result = await applyScheduleViaBackend(emp.id, { clearBlocks });
            totalCreated += result.created || 0;
            totalDeleted += result.deleted || 0;
        } catch (err) {
            console.error(`[Auto Schedule] Failed for ${emp.name}:`, err);
        }
    }

    console.log(`[Auto Schedule] Created ${totalCreated} shifts (replaced ${totalDeleted} auto shifts)`);

    // Refresh shifts and blocks after batch operation
    await Promise.all([refreshShifts(), fetchShiftBlocks()]);

    // Mark as generated
    AppState.schedulesGenerated = true;

    return { created: totalCreated, removed: totalDeleted };
}

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
            swapsList.innerHTML = `<div style="padding: 40px; text-align: center;">
                <p>Je moet ingelogd zijn om ruilverzoeken te zien.</p>
            </div>`;
            IconHelper.init(swapsList);
            return;
        }

        // Separate requests by category
        const targetPendingRequests = swapRequests.filter(sr => canTargetRespondToSwap(sr));
        const pendingRequests = swapRequests.filter(sr => sr.status === 'pending' && canApproveSwap(sr));
        // Mijn verzoeken: only show requests where I am the REQUESTER (not target)
        const myRequests = swapRequests.filter(sr =>
            sr.requester_user_id === currentUser.id
        );
        const historyRequests = swapRequests.filter(sr =>
            sr.status !== 'pending' && canApproveSwap(sr)
        ).slice(0, 10); // Show last 10
        // Open takeover requests: available to everyone except the requester
        const openTakeoverRequests = swapRequests.filter(sr =>
            sr.request_type === 'takeover' &&
            sr.status === 'pending' &&
            sr.requester_user_id !== currentUser.id &&
            AppState.swapTeamFilter.includes(sr.requester_shift_team)
        ).sort((a, b) => (a.requester_shift_date || '').localeCompare(b.requester_shift_date || ''));

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
                <p style="font-size: 0.9rem; color: #64748b; margin-top: -0.5rem; margin-bottom: 1rem;">
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
                <p style="font-size: 0.9rem; color: #64748b; margin-top: -0.5rem; margin-bottom: 1rem;">
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
                <button class="btn btn-primary" onclick="switchView('planning')" style="margin-top: 1rem;">Bekijk mijn shifts in de planning</button>
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
        swapsList.innerHTML = `<div style="padding: 40px; text-align: center; color: #e11d48;">
            <h3>${IconHelper.html(ICONS.error, 'md')} Fout bij laden ruilverzoeken</h3>
            <p>${escapeHtml(error.message || 'Onbekende fout')}</p>
        </div>`;
        IconHelper.init(swapsList);
    }
}

function renderSwapRequestCard(swapRequest, mode) {
    const statusLabels = {
        'pending': 'In behandeling',
        'approved': 'Goedgekeurd',
        'rejected': 'Afgewezen',
        'cancelled': 'Geannuleerd'
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
            <div class="swap-request-actions" style="display: flex; gap: 0.5rem;">
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
            <p style="font-size: 0.85rem; color: #64748b; margin: 0.5rem 0 0 0;">
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
            <p style="font-size: 0.85rem; color: #64748b; margin: 0.5rem 0 0 0;">
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
                    showToast('Fout bij accepteren: ' + (error.message || 'Onbekende fout'), 'error');
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
                    showToast('Fout bij afwijzen: ' + (error.message || 'Onbekende fout'), 'error');
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
                    showToast('Fout bij annuleren: ' + (error.message || 'Onbekende fout'), 'error');
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
                        showToast('Fout bij overnemen: ' + (error.message || 'Onbekende fout'), 'error');
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

    const role = getEffectiveRole();
    const userTeam = AppState.currentUser?.team_id || AppState.currentUser?.mainTeam;

    // Don't auto-lock team filter - roosterverantwoordelijke can build for all teams

    let html = '';
    html += renderBuilderControls(role, userTeam);
    html += renderBuilderGrid(role, userTeam);
    html += renderBuilderActions();

    container.innerHTML = html;
    IconHelper.init(container);
    attachBuilderEventListeners(container);
}

function renderBuilderControls(role, userTeam) {
    const wn = AppState.builderWeekNumber;

    // Team filter - dropdown for all roles that can access builder
    const teams = DataStore.settings.teams || {};
    const teamFilterHtml = `<select id="builder-team-select" class="form-input" style="width: auto;">
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
                        const cl = getCycleLength();
                        let btns = '';
                        for (let w = 1; w <= cl; w++) {
                            const label = getWeekLabel(w);
                            btns += `<button class="btn ${wn === w ? 'btn-primary' : 'btn-secondary'} btn-sm" id="builder-week-${w}">Week ${w} (${escapeHtml(label)})</button>`;
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
    employees = employees.sort((a, b) => a.name.localeCompare(b.name));

    if (employees.length === 0) {
        return '<div class="builder-empty">Geen medewerkers gevonden voor het geselecteerde team</div>';
    }

    const teamOrder = getTeamOrder();
    const teams = DataStore.settings.teams || {};

    let html = '<div class="builder-grid-wrapper">';
    html += '<div class="builder-grid">';

    // Bepaal gesloten dagen voor huidige builder week
    const builderClosedDays = getClosedDaysForWeek(AppState.builderWeekNumber);
    // Map dayIndex (0=Ma..6=Zo) naar JS dayOfWeek (0=Zo, 1=Ma..6=Za)
    function dayIndexToJsDow(dayIndex) {
        return dayIndex === 6 ? 0 : dayIndex + 1;
    }

    // Header
    html += '<div class="builder-grid-header">';
    html += '<div class="builder-name-header">Medewerker</div>';
    dayNames.forEach((name, i) => {
        let headerClass = 'builder-day-header';
        const jsDow = dayIndexToJsDow(i);
        const isWeekend = i >= 5;
        const isClosed = builderClosedDays.includes(jsDow);
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        const label = isClosed ? `${name} (Gesloten)` : name;
        html += `<div class="${headerClass}"><span class="day-name">${label}</span></div>`;
    });
    html += '<div class="builder-hours-header">Uren</div>';
    html += '</div>';

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

    // Staffing summary
    html += renderBuilderStaffingSummary(employees);

    // 11-hour rule warnings across consecutive days
    html += renderBuilder11HourWarnings(employees);

    html += '</div>';
    return html;
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
    const builderClosedDays = getClosedDaysForWeek(AppState.builderWeekNumber);

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

            html += `<div class="builder-shift ${teamColor}">
                <span class="builder-shift-label">${escapeHtml(templateName)}</span>
                <span class="builder-shift-time">${assignment.startTime}-${assignment.endTime}</span>
            </div>`;
        } else {
            html += '<span class="cell-empty">+</span>';
        }

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

function renderBuilderStaffingSummary(employees) {
    const builderClosedDays = getClosedDaysForWeek(AppState.builderWeekNumber);
    const minStaffDay = DataStore.settings.rules?.minStaffingDay || 1;
    const minStaffNight = DataStore.settings.rules?.minStaffingNight || 1;

    // Day row
    let dayHtml = '<div class="builder-staffing-row">';
    dayHtml += '<div class="builder-staffing-label">Dag</div>';

    // Night row
    let nightHtml = '<div class="builder-staffing-row">';
    nightHtml += '<div class="builder-staffing-label">Nacht</div>';

    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const jsDow = dayIndex === 6 ? 0 : dayIndex + 1;

        if (builderClosedDays.includes(jsDow)) {
            dayHtml += '<div class="builder-staffing-cell closed"></div>';
            nightHtml += '<div class="builder-staffing-cell closed"></div>';
            continue;
        }

        let dayCount = 0;
        let nightCount = 0;
        employees.forEach(emp => {
            const empGrid = AppState.builderGrid[emp.id] || {};
            const shift = empGrid[dayIndex];
            if (shift) {
                if (isNightShift(shift.startTime)) {
                    nightCount++;
                } else {
                    dayCount++;
                }
            }
        });

        const dayClass = dayCount >= minStaffDay ? 'staffing-ok' : 'staffing-low';
        const nightClass = nightCount >= minStaffNight ? 'staffing-ok' : (nightCount === 0 ? '' : 'staffing-low');

        dayHtml += `<div class="builder-staffing-cell ${dayClass}">
            <span class="staffing-count">${dayCount}</span>
            <span class="staffing-min">min: ${minStaffDay}</span>
        </div>`;

        nightHtml += `<div class="builder-staffing-cell ${nightClass}">
            <span class="staffing-count">${nightCount}</span>
            <span class="staffing-min">min: ${minStaffNight}</span>
        </div>`;
    }

    dayHtml += '<div class="builder-staffing-cell"></div></div>';
    nightHtml += '<div class="builder-staffing-cell"></div></div>';

    return dayHtml + nightHtml;
}

function renderBuilder11HourWarnings(employees) {
    const minHours = DataStore.settings.rules?.minHoursBetweenShifts || 11;
    const warnings = [];
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    employees.forEach(emp => {
        const empGrid = AppState.builderGrid[emp.id] || {};
        const days = Object.keys(empGrid).map(Number).sort((a, b) => a - b);

        for (let i = 0; i < days.length; i++) {
            // Check next consecutive day
            const nextDay = i < days.length - 1 ? days[i + 1] : null;
            const currentShift = empGrid[days[i]];

            // Also check wrap-around: Sunday (6) → Monday (0) for repeating patterns
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

                // Handle night shifts (end time < start time means next day)
                const shift1StartParts = currentShift.startTime.split(':').map(Number);
                const shift1Start = shift1StartParts[0] * 60 + shift1StartParts[1];
                if (endMinutes <= shift1Start) {
                    endMinutes += 24 * 60; // shift ends next day
                }

                // Rest = time from end of shift1 (on day N / day N+1 if night) to start of shift2 (on day N+1 / day 0)
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
    });

    if (warnings.length === 0) return '';

    return `<div class="builder-11h-warnings">
        <div class="builder-11h-warnings-title">11-uur regel waarschuwingen</div>
        <ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </div>`;
}

function renderBuilderActions() {
    const hasData = Object.keys(AppState.builderGrid).length > 0 &&
        Object.values(AppState.builderGrid).some(d => Object.keys(d).length > 0);

    return `
        <div class="builder-actions">
            <button class="btn btn-primary" id="builder-save-draft" ${!hasData ? 'disabled' : ''}>
                Concept opslaan
            </button>
        </div>
        ${renderBuilderDrafts()}
    `;
}

function renderBuilderDrafts() {
    const drafts = DataStore.settings.schedule_drafts || [];
    if (drafts.length === 0) {
        return '<div class="builder-drafts"><p class="builder-drafts-empty">Nog geen opgeslagen concepten</p></div>';
    }

    const sorted = [...drafts].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

    return `
        <div class="builder-drafts">
            <h3>Opgeslagen concepten</h3>
            <div class="builder-drafts-list">
                ${sorted.map(draft => {
                    const date = new Date(draft.updatedAt || draft.createdAt);
                    const dateStr = date.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const teamLabel = draft.teamFilter
                        ? (DataStore.settings.teams?.[draft.teamFilter]?.name || draft.teamFilter)
                        : 'Alle teams';
                    const empCount = Object.keys(draft.grid || {}).length;
                    return `
                        <div class="builder-draft-card" data-draft-id="${escapeHtml(draft.id)}">
                            <div class="builder-draft-info">
                                <strong>${escapeHtml(draft.name)}</strong>
                                ${draft.lastAppliedAt ? `<span class="builder-draft-applied-badge">Toegepast ${new Date(draft.lastAppliedAt).toLocaleDateString('nl-BE')}</span>` : ''}
                                <span class="builder-draft-meta">Week ${draft.weekNumber} &middot; ${escapeHtml(teamLabel)} &middot; ${empCount} medewerkers</span>
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

    AppState.builderIsDirty = true;
    renderBuilder();
    showToast(`Basisrooster week ${weekNumber} geladen`, 'success');
}

// --- Builder: Draft management ---

async function saveBuilderDraft() {
    const grid = AppState.builderGrid;
    const hasData = Object.keys(grid).length > 0 &&
        Object.values(grid).some(d => Object.keys(d).length > 0);
    if (!hasData) return;

    const name = await showInputPrompt('Geef een naam voor dit concept:', 'Concept opslaan');
    if (!name) return;

    const draftData = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        teamFilter: AppState.builderTeamFilter,
        weekNumber: AppState.builderWeekNumber,
        grid: JSON.parse(JSON.stringify(grid))
    };

    try {
        if (DataStore._draftsFromTable) {
            const result = await createScheduleDraft(draftData);
            DataStore.settings.schedule_drafts.push(result.draft);
        } else {
            const drafts = [...(DataStore.settings.schedule_drafts || [])];
            draftData.createdBy = AppState.currentUser?.id;
            draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
            draftData.createdAt = new Date().toISOString();
            draftData.updatedAt = new Date().toISOString();
            drafts.push(draftData);
            await saveSettings('schedule_drafts', drafts);
            DataStore.settings.schedule_drafts = drafts;
        }
    } catch (err) {
        console.error('Error saving draft:', err);
        showToast('Fout bij opslaan concept', 'error');
        return;
    }

    AppState.builderIsDirty = false;
    renderBuilder();
    showToast('Concept opgeslagen', 'success');
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
    AppState.builderWeekNumber = draft.weekNumber || 1;
    AppState.builderTeamFilter = draft.teamFilter || null;
    AppState.builderGrid = JSON.parse(JSON.stringify(draft.grid || {}));
    AppState.builderIsDirty = false;
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

async function applyBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    const grid = draft.grid || {};
    const weekNumber = draft.weekNumber || 1;
    const empCount = Object.keys(grid).length;

    // Build preview of changes (client-side, for confirm dialog)
    let changesSummary = '';
    let changesCount = 0;
    for (const [empIdStr, empGrid] of Object.entries(grid)) {
        const emp = getEmployee(Number(empIdStr));
        if (!emp) continue;
        const prevSchedule = getEmployeeWeekSchedule(emp, weekNumber) || [];
        const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
        let empChanges = [];
        for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const newAssignment = empGrid[dayIndex];
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
                changesSummary += `\n${emp.name}: ${empChanges.join(', ')}`;
            }
        }
    }
    if (changesCount > 8) changesSummary += `\n... en ${changesCount - 8} meer`;
    if (changesCount === 0) changesSummary = '\nGeen wijzigingen gevonden.';

    const confirmed = await showConfirm(
        `Concept "${draft.name}" toepassen op basisrooster week ${weekNumber}?\n\nWijzigingen voor ${changesCount} van ${empCount} medewerkers:${changesSummary}`,
        'Concept toepassen'
    );
    if (!confirmed) return;

    showSectionLoading('planning-view', 'Concept toepassen...');
    try {
        // Single atomic backend call: saves schedules + regenerates shifts + marks draft
        const result = await applyScheduleDraft(draftId, { clearBlocks: true });

        showToast(`Basisrooster week ${weekNumber} toegepast voor ${result.applied} medewerkers (${result.shifts.created} shifts aangemaakt)`, 'success');

        // Update local draft cache
        const draftToMark = (DataStore.settings.schedule_drafts || []).find(d => d.id === draftId);
        if (draftToMark) {
            draftToMark.lastAppliedAt = new Date().toISOString();
            draftToMark.lastAppliedBy = AppState.currentUser?.name || 'Onbekend';
        }

        await Promise.all([refreshShifts(), fetchShiftBlocks(), refreshUsers()]);
        renderBuilder();
    } catch (error) {
        console.error('Error applying builder draft:', error);
        showToast('Fout bij toepassen concept: ' + error.message, 'error');
    } finally {
        hideSectionLoading('planning-view');
    }
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

// --- Builder: Event Listeners ---

function attachBuilderEventListeners(container) {
    // Week toggle buttons (dynamic based on cycle length)
    const cycleLen = getCycleLength();
    for (let w = 1; w <= cycleLen; w++) {
        const btn = document.getElementById(`builder-week-${w}`);
        if (btn) btn.addEventListener('click', () => switchBuilderWeek(w));
    }

    // Team filter
    const teamSelect = document.getElementById('builder-team-select');
    if (teamSelect) {
        teamSelect.addEventListener('change', (e) => {
            AppState.builderTeamFilter = e.target.value || null;
            AppState.builderGrid = {};
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
        AppState.builderIsDirty = false;
        renderBuilder();
        showToast('Grid leeggemaakt', 'info');
    });

    // Cell clicks (skip closed cells)
    container.querySelectorAll('.builder-cell:not(.closed)').forEach(cell => {
        cell.addEventListener('click', () => {
            const empId = Number(cell.dataset.employeeId);
            const dayIndex = Number(cell.dataset.day);
            openBuilderShiftModal(empId, dayIndex);
        });
    });

    // Save draft button
    const saveDraftBtn = document.getElementById('builder-save-draft');
    if (saveDraftBtn) saveDraftBtn.addEventListener('click', saveBuilderDraft);

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
    if (AppState.builderIsDirty) {
        showConfirm('Je hebt onopgeslagen wijzigingen. Wil je doorgaan?').then(confirmed => {
            if (confirmed) {
                AppState.builderWeekNumber = weekNumber;
                AppState.builderGrid = {};
                AppState.builderIsDirty = false;
                renderBuilder();
            }
        });
    } else {
        AppState.builderWeekNumber = weekNumber;
        AppState.builderGrid = {};
        AppState.builderIsDirty = false;
        renderBuilder();
    }
}

// ===== END ROOSTERBOUWER =====

function renderSettings() {
    // Update tab active states and scroll active into view
    document.querySelectorAll('.settings-tab').forEach(tab => {
        const isActive = tab.dataset.settingsTab === AppState.activeSettingsTab;
        tab.classList.toggle('active', isActive);
        if (isActive) {
            // Scroll active tab into view after a brief delay
            setTimeout(() => {
                tab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }, 100);
        }
    });

    // Setup tab click listeners
    document.querySelectorAll('.settings-tab').forEach(tab => {
        tab.onclick = () => switchSettingsTab(tab.dataset.settingsTab);
    });

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
        case 'rooster':
            renderSettingsRooster(content);
            break;
        case 'teams':
            renderSettingsTeams(content);
            break;
        case 'systeem':
            renderSettingsSystem(content);
            break;
        case 'audit':
            renderSettingsAudit(content);
            break;
        default:
            content.innerHTML = '<p>Ongeldige tab</p>';
    }
    IconHelper.init(content);
    // Track unsaved changes for all settings tabs with form inputs
    if (['planning', 'rooster', 'teams'].includes(tabName)) {
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

        const rows = users.map(user => `
            <div class="admin-user-row" data-user-id="${user.id}" data-name="${escapeHtml(user.name)}" data-email="${escapeHtml(user.email)}" data-team="${user.team_id || ''}" data-role="${user.role}">
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
            </div>
        `).join('');

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
            container.querySelectorAll('.admin-user-row').forEach(row => {
                const name = (row.dataset.name || '').toLowerCase();
                const email = (row.dataset.email || '').toLowerCase();
                const team = row.dataset.team || '';
                const matchSearch = !searchValue || name.includes(searchValue) || email.includes(searchValue);
                const matchTeam = !teamValue || team === teamValue;
                row.classList.toggle('is-hidden', !(matchSearch && matchTeam));
            });
        };

        const searchInput = container.querySelector('#admin-user-search');
        if (searchInput) {
            searchInput.addEventListener('input', applyFilters);
        }
        if (teamFilter) {
            teamFilter.addEventListener('change', applyFilters);
        }

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

    // Get employees that don't have a linked user yet (for linking)
    const employees = getAllEmployees(true);
    const employeeOptions = employees.map(emp =>
        `<option value="${emp.id}" data-name="${escapeHtml(emp.name)}" data-email="${escapeHtml(emp.email || '')}" data-team="${emp.mainTeam || ''}">${escapeHtml(emp.name)}</option>`
    ).join('');

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'add-user-modal';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 450px;">
            <div class="modal-header">
                <h2>Nieuwe gebruiker</h2>
                <button class="modal-close" onclick="document.getElementById('add-user-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <form id="add-user-form">
                    <div class="form-group">
                        <label for="new-user-employee">Koppel aan medewerker</label>
                        <select id="new-user-employee" class="form-input">
                            <option value="">(nieuwe medewerker)</option>
                            ${employeeOptions}
                        </select>
                        <span class="form-hint">Selecteer een bestaande medewerker om te koppelen, of laat leeg voor een nieuwe</span>
                    </div>
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

    // Auto-fill when selecting an employee
    const employeeSelect = modal.querySelector('#new-user-employee');
    employeeSelect.addEventListener('change', () => {
        const selected = employeeSelect.selectedOptions[0];
        if (selected && selected.value) {
            form.querySelector('#new-user-name').value = selected.dataset.name || '';
            form.querySelector('#new-user-email').value = selected.dataset.email || '';
            if (selected.dataset.team) {
                form.querySelector('#new-user-team').value = selected.dataset.team;
            }
        }
    });

    // Update role description on change
    const roleSelect = modal.querySelector('#new-user-role');
    const roleHint = modal.querySelector('#new-user-role-hint');
    roleSelect.addEventListener('change', () => {
        roleHint.textContent = getRoleDescription(roleSelect.value);
    });

    const form = modal.querySelector('#add-user-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const employee_id = form.querySelector('#new-user-employee').value || null;
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
                    employee_id: employee_id ? Number(employee_id) : null
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
        <div class="modal-content" style="max-width: 450px;">
            <div class="modal-header">
                <h2>Account bewerken</h2>
                <button class="modal-close" onclick="document.getElementById('edit-account-modal').remove()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <form id="edit-account-form">
                    <div class="form-group">
                        <label for="edit-user-name">Naam</label>
                        <input type="text" id="edit-user-name" class="form-input" value="${escapeHtml(user.name)}" required />
                    </div>
                    <div class="form-group">
                        <label for="edit-user-email">Email</label>
                        <input type="email" id="edit-user-email" class="form-input" value="${escapeHtml(user.email)}" required />
                    </div>
                    <div class="form-group">
                        <label for="edit-user-role">Rol</label>
                        <select id="edit-user-role" class="form-input" required>
                            <option value="medewerker" ${user.role === 'medewerker' ? 'selected' : ''}>Medewerker</option>
                            <option value="roosterverantwoordelijke" ${user.role === 'roosterverantwoordelijke' ? 'selected' : ''}>Roosterverantwoordelijke</option>
                            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                        </select>
                        <span class="form-hint role-hint" id="edit-user-role-hint">${getRoleDescription(user.role)}</span>
                    </div>
                    <div class="form-group">
                        <label for="edit-user-team">Team</label>
                        <select id="edit-user-team" class="form-input">
                            <option value="">(geen team)</option>
                            ${teamOptions}
                        </select>
                    </div>
                    <div class="modal-actions" style="display: flex; justify-content: space-between; gap: 8px; width: 100%;">
                        <button type="button" class="btn btn-danger" id="edit-account-delete-btn">Verwijderen</button>
                        <div style="display: flex; gap: 8px;">
                            <button type="button" class="btn btn-secondary" id="edit-account-reset-btn">Reset wachtwoord</button>
                            <button type="submit" class="btn btn-primary">Opslaan</button>
                        </div>
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
            await apiFetch(`/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    name: newName,
                    email: newEmail,
                    role: newRole,
                    team_id: newTeamId,
                    mainTeam: newTeamId
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
            showToast('Wachtwoord is gereset naar het standaard wachtwoord', 'success');
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

        if (!await showConfirm(confirmMsg, 'Account verwijderen')) return;

        try {
            await deleteEmployee(Number(user.id));
            modal.remove();
            showToast('Account verwijderd', 'success');
            if (onSave) onSave();
        } catch (error) {
            showToast(`Verwijderen mislukt: ${error.message}`, 'error');
        }
    });
}

// ===== SETTINGS TAB: PLANNING =====
function renderSettingsPlanning(container) {
    const rules = DataStore.settings.rules;
    const planningHorizon = DataStore.settings.planningHorizon?.weeks || 4;

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
        <!-- Planning horizon -->
        <div class="settings-card" id="settings-horizon">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Planning horizon</h3>
                    <p class="settings-card-subtitle">Hoe ver vooruit worden automatische diensten gegenereerd?</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="form-group">
                    <label for="planning-horizon-select">Horizon:</label>
                    <select id="planning-horizon-select" class="form-input">
                        <option value="4" ${planningHorizon === 4 ? 'selected' : ''}>4 weken</option>
                        <option value="8" ${planningHorizon === 8 ? 'selected' : ''}>8 weken</option>
                        <option value="26" ${planningHorizon === 26 ? 'selected' : ''}>6 maanden (26 weken)</option>
                        <option value="52" ${planningHorizon === 52 ? 'selected' : ''}>1 jaar (52 weken)</option>
                        <option value="unlimited" ${planningHorizon === null || planningHorizon === 'unlimited' ? 'selected' : ''}>Onbeperkt</option>
                    </select>
                    <span class="form-hint">Basisroosters worden automatisch toegepast tot deze horizon</span>
                </div>
                <button class="btn btn-primary" onclick="savePlanningHorizon()">Horizon opslaan</button>
            </div>
        </div>

        <!-- Planning regels -->
        <div class="settings-card" id="settings-rules" style="margin-top: 24px;">
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
                <div class="form-group">
                    <label for="rule-min-staff-day">Minimum bezetting overdag (per team):</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-min-staff-day" class="form-input" value="${rules.minStaffingDay}" min="0" max="10" />
                        <span class="unit">personen</span>
                    </div>
                </div>
                <div class="form-group">
                    <label for="rule-min-staff-night">Minimum bezetting nacht (totaal):</label>
                    <div class="input-with-unit">
                        <input type="number" id="rule-min-staff-night" class="form-input" value="${rules.minStaffingNight}" min="0" max="10" />
                        <span class="unit">personen</span>
                    </div>
                </div>
                <button class="btn btn-primary" onclick="saveRules()">Regels opslaan</button>
            </div>
        </div>

        <!-- Vakantiewerking -->
        <div class="settings-card" id="settings-holidays" style="margin-top: 24px;">
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

                <div class="holiday-rules-section">
                    <h4>Vakantie bezetting</h4>
                    <p class="form-help-text">Minimum aantal begeleiders (Vlot 1 + Vlot 2 samen) tijdens vakantie:</p>
                    <div class="form-row">
                        <div class="form-group">
                            <label for="holiday-min-staff-day">Min. bezetting dag:</label>
                            <input type="number" id="holiday-min-staff-day" class="form-input" value="${DataStore.settings.holidayRules?.minStaffingDay || 2}" min="0" max="10" />
                        </div>
                        <div class="form-group">
                            <label for="holiday-min-staff-night">Min. bezetting nacht:</label>
                            <input type="number" id="holiday-min-staff-night" class="form-input" value="${DataStore.settings.holidayRules?.minStaffingNight || 1}" min="0" max="10" />
                        </div>
                    </div>
                    <button class="btn btn-primary btn-sm" onclick="saveHolidayRules()">Regels opslaan</button>
                </div>

                <div class="holiday-periods-section" style="margin-top: 20px;">
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
function renderSettingsRooster(container) {
    container.innerHTML = `
        <!-- Roosterpatroon -->
        <div class="settings-card" id="settings-schedule-pattern">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Roosterpatroon</h3>
                    <p class="settings-card-subtitle">Configureer de cyclus en gesloten dagen.</p>
                </div>
            </div>
            <div class="settings-card-body">
                ${(() => {
                    const pattern = getSchedulePattern();
                    const cl = pattern.cycleLength || 2;
                    let weeksInfo = '';
                    for (let w = 1; w <= cl; w++) {
                        const closed = getClosedDaysForWeek(w);
                        const label = closed.length > 0 ? formatClosedDays(closed) : 'alle dagen open';
                        weeksInfo += `<p><strong>Week ${w}</strong> = ${escapeHtml(label)}</p>`;
                    }
                    return `<div class="info-box info">
                        ${weeksInfo}
                        <p class="current-setting">Referentie Week 1: <strong>${formatDate(pattern.referenceDate || DataStore.settings.biWeeklyReferenceDate)}</strong></p>
                    </div>`;
                })()}
                <div class="form-group">
                    <label for="schedule-cycle-length">Cycluslengte (aantal weken):</label>
                    <input type="number" id="schedule-cycle-length" class="form-input" min="1" max="8" value="${getSchedulePattern().cycleLength || 2}" style="width: 80px;" />
                </div>
                <div id="schedule-pattern-weeks">
                    ${(() => {
                        const pattern = getSchedulePattern();
                        const cl = pattern.cycleLength || 2;
                        const dayLabels = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
                        let html = '';
                        for (let w = 1; w <= cl; w++) {
                            const closed = getClosedDaysForWeek(w);
                            html += `<div class="form-group schedule-pattern-week">
                                <label>Week ${w} - Gesloten dagen:</label>
                                <div class="schedule-pattern-days">
                                    ${[1,2,3,4,5,6,0].map(d => `<label class="schedule-day-checkbox">
                                        <input type="checkbox" class="pattern-closed-day" data-week="${w}" data-day="${d}" ${closed.includes(d) ? 'checked' : ''}>
                                        <span>${dayLabels[d]}</span>
                                    </label>`).join('')}
                                </div>
                            </div>`;
                        }
                        return html;
                    })()}
                </div>
                <div class="form-group">
                    <label for="schedule-reference-date">Referentie maandag (Week 1 start):</label>
                    <input type="date" id="schedule-reference-date" class="form-input" value="${getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate}" />
                    <span class="form-hint">Selecteer altijd een maandag</span>
                </div>
                <button class="btn btn-primary" id="save-schedule-pattern-btn">Patroon Opslaan</button>
            </div>
        </div>

        <!-- Weekendverantwoordelijke rotatie -->
        <div class="settings-card" id="settings-rotation" style="margin-top: 24px;">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Weekendverantwoordelijke Rotatie</h3>
                    <p class="settings-card-subtitle">Automatische toewijzing tijdens open weekenden.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <p class="form-help-text">Tijdens open weekenden wordt automatisch een verantwoordelijke aangeduid. De rotatie gaat om de beurt door medewerkers van de geselecteerde teams.</p>

                <div class="eligible-teams-compact" style="margin-top: 16px;">
                    ${renderEligibleTeamsCheckboxes()}
                </div>

                <div class="rotation-form" style="margin-top: 16px;">
                    ${renderRotationSettingsCompact()}
                </div>

                <div class="upcoming-section" style="margin-top: 24px;">
                    <h4>Komende open weekenden</h4>
                    <div class="upcoming-responsibles">
                        ${renderUpcomingResponsibles()}
                    </div>
                </div>
            </div>
        </div>
    `;

    // Event listener: Save schedule pattern
    const saveBtn = document.getElementById('save-schedule-pattern-btn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveSchedulePattern);
    }

    // Event listener: Cycle length change → rebuild week rows
    const cycleLengthInput = document.getElementById('schedule-cycle-length');
    if (cycleLengthInput) {
        cycleLengthInput.addEventListener('change', function() {
            const newLength = Math.max(1, Math.min(8, parseInt(this.value) || 2));
            this.value = newLength;
            rebuildSchedulePatternWeeks(newLength);
        });
    }
}

function rebuildSchedulePatternWeeks(cycleLength) {
    const container = document.getElementById('schedule-pattern-weeks');
    if (!container) return;

    const pattern = getSchedulePattern();
    const dayLabels = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
    let html = '';

    for (let w = 1; w <= cycleLength; w++) {
        const closed = (w <= (pattern.cycleLength || 2)) ? getClosedDaysForWeek(w) : [];
        html += `<div class="form-group schedule-pattern-week">
            <label>Week ${w} - Gesloten dagen:</label>
            <div class="schedule-pattern-days">
                ${[1,2,3,4,5,6,0].map(d => `<label class="schedule-day-checkbox">
                    <input type="checkbox" class="pattern-closed-day" data-week="${w}" data-day="${d}" ${closed.includes(d) ? 'checked' : ''}>
                    <span>${dayLabels[d]}</span>
                </label>`).join('')}
            </div>
        </div>`;
    }

    container.innerHTML = html;
    IconHelper.init(container);
}

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

        // Also sync rotation start date
        if (!DataStore.settings.responsibleRotation) {
            DataStore.settings.responsibleRotation = { eligibleTeams: [], assignments: {} };
        }
        DataStore.settings.responsibleRotation.rotationStart = referenceDate;

        saveToStorage();
        renderSettings();
        renderPlanning();
        markSettingsSaved();
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
                    <p class="settings-card-subtitle">Beheer teamnamen en kleuren.</p>
                </div>
                <div class="settings-card-actions">
                    <button class="btn btn-sm btn-secondary" id="btn-add-team">+ Nieuw team</button>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="teams-list" id="teams-config">
                    ${renderTeamsConfig()}
                </div>
            </div>
        </div>

        <!-- Dienst templates -->
        <div class="settings-card" id="settings-templates" style="margin-top: 24px;">
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
    `;

    // Event listener for add team button
    document.getElementById('btn-add-team')?.addEventListener('click', openAddTeamModal);
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
        // Restore on failure
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
                ${isAdmin ? `
                <div class="migration-zone" style="margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border-color);">
                    <h4>Database migratie</h4>
                    <p>Voer database migraties uit om data te repareren (bijv. weekroosters fixen).</p>
                    <button class="btn btn-secondary" onclick="runMigration()">Database migreren</button>
                    <button class="btn btn-secondary" onclick="seedTeams()" style="margin-left: 8px;">Teams aanmaken</button>
                    <button class="btn btn-secondary" onclick="showDebugInfo()" style="margin-left: 8px;">Debug info</button>
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
        <div class="settings-card" id="settings-about" style="margin-top: 24px;">
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

// ===== SETTINGS TAB: AUDIT LOG =====
function renderSettingsAudit(container) {
    const role = getEffectiveRole();
    if (!['admin', 'roosterverantwoordelijke'].includes(role)) {
        container.innerHTML = `<div class="settings-card"><div class="settings-card-body">
            <div class="info-box neutral"><p>Je hebt geen toegang tot het audit log.</p></div>
        </div></div>`;
        return;
    }

    container.innerHTML = `
        <div class="settings-card">
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
                        <div class="form-group" style="align-self: flex-end;">
                            <button class="btn btn-primary" onclick="loadAuditLog(1)">Zoeken</button>
                        </div>
                    </div>
                </div>
                <div id="audit-log-results"></div>
                <div id="audit-log-pagination" class="audit-pagination"></div>
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

    resultsEl.innerHTML = '<p style="padding: 16px; color: var(--text-secondary);">Laden...</p>';

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
    let html = '';
    Object.keys(DataStore.settings.teams).forEach(teamId => {
        const team = DataStore.settings.teams[teamId];
        const teamName = escapeHtml(team.name);
        html += `
        <div class="team-config-item" data-team-id="${teamId}">
            <div class="team-color-dot" style="background: ${team.color}"></div>
            <div class="team-info">
                <span class="team-name">${teamName}</span>
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

function saveRules() {
    const minHours = parseInt(document.getElementById('rule-min-hours').value) || 11;
    const minStaffDay = parseInt(document.getElementById('rule-min-staff-day').value) || 1;
    const minStaffNight = parseInt(document.getElementById('rule-min-staff-night').value) || 1;

    DataStore.settings.rules.minHoursBetweenShifts = minHours;
    DataStore.settings.rules.minStaffingDay = minStaffDay;
    DataStore.settings.rules.minStaffingNight = minStaffNight;

    saveToStorage();
    markSettingsSaved();
    showToast('Planning regels zijn opgeslagen', 'success');
}

async function savePlanningHorizon() {
    const select = document.getElementById('planning-horizon-select');
    const value = select.value;
    const weeks = value === 'unlimited' ? null : parseInt(value);

    DataStore.settings.planningHorizon = { weeks };
    saveToStorage();

    // Sync to backend
    try {
        await apiFetch('/settings/planning_horizon', {
            method: 'PUT',
            body: JSON.stringify({ value: { weeks } })
        });
        markSettingsSaved();
        showToast('Planning horizon is opgeslagen', 'success');

        // Reset flag and re-apply schedules with new horizon
        AppState.schedulesGenerated = false;
        await autoApplyBaseSchedules();

        // Refresh planning view if currently visible
        if (AppState.currentView === 'planning') {
            renderPlanning();
        }
    } catch (error) {
        console.error('Fout bij opslaan planning horizon:', error);
        showToast('Planning horizon is lokaal opgeslagen (server sync mislukt)', 'warning');
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
    const safeTemplateId = escapeHtml(templateId || '');
    const safeTemplateName = escapeHtml(template?.name || '');

    const modalHtml = `
    <div class="modal" id="template-modal-overlay" onclick="closeTemplateModal()">
        <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2>${title}</h2>
                <button class="modal-close" onclick="closeTemplateModal()">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="template-id">Template ID:</label>
                    <input type="text" id="template-id" class="form-input"
                           value="${safeTemplateId}"
                           ${isEdit ? 'readonly' : ''}
                           placeholder="bv. vroeg, laat, nacht" />
                    <span class="form-hint">Korte identifier (geen spaties)</span>
                </div>
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

function closeTemplateModal() {
    const modal = document.getElementById('template-modal-overlay');
    if (modal) modal.remove();
}

function saveTemplate(originalId) {
    const rawId = document.getElementById('template-id').value.trim().toLowerCase().replace(/\s+/g, '_');
    const id = rawId.replace(/[^a-z0-9_-]/g, '');
    const name = document.getElementById('template-name').value.trim();
    const start = document.getElementById('template-start').value;
    const end = document.getElementById('template-end').value;

    if (!id || !name || !start || !end) {
        showToast('Vul alle velden in', 'warning');
        return;
    }

    if (start >= end) {
        showToast('Starttijd moet voor eindtijd liggen', 'warning');
        return;
    }

    if (rawId !== id) {
        showToast('Template ID mag enkel letters, cijfers, _ of - bevatten', 'warning');
        return;
    }

    if (!originalId && DataStore.settings.shiftTemplates[id]) {
        showToast('Een template met deze ID bestaat al', 'warning');
        return;
    }

    if (originalId && originalId !== id) {
        delete DataStore.settings.shiftTemplates[originalId];
    }

    DataStore.settings.shiftTemplates[id] = { name, start, end };
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

        return `
        <div class="holiday-period-item ${statusClass}">
            <div class="holiday-period-info">
                <span class="holiday-period-name">${escapeHtml(period.name)}</span>
                <span class="holiday-period-dates">
                    ${formatDateShort(period.startDate)} - ${formatDateShort(period.endDate)}
                    <span class="holiday-period-days">(${days} dagen)</span>
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

function openAddHolidayModal() {
    const modalHtml = `
    <div class="modal" id="holiday-modal" onclick="closeHolidayModal()">
        <div class="modal-content" onclick="event.stopPropagation()" style="max-width: 450px;">
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
    if (await showConfirm('Weet je zeker dat je deze vakantieperiode wilt verwijderen?')) {
        removeHolidayPeriod(id);
        renderSettings();
    }
}

function saveHolidayRules() {
    const minStaffDay = parseInt(document.getElementById('holiday-min-staff-day').value) || 2;
    const minStaffNight = parseInt(document.getElementById('holiday-min-staff-night').value) || 1;

    updateHolidayRules({
        minStaffingDay: minStaffDay,
        minStaffingNight: minStaffNight
    });

    markSettingsSaved();
    showToast('Vakantie instellingen opgeslagen', 'success');
}

// ===== VERANTWOORDELIJKE SETTINGS FUNCTIES =====

function renderEligibleTeamsCheckboxes() {
    const eligibleTeams = DataStore.settings.responsibleRotation?.eligibleTeams || ['vlot1', 'vlot2', 'cargo'];
    let html = '';

    // Only show Vlot 1, Vlot 2, and Cargo (the teams that can have weekend responsible)
    const relevantTeams = ['vlot1', 'vlot2', 'cargo'];

    relevantTeams.forEach(teamId => {
        const team = DataStore.settings.teams[teamId];
        if (!team) return;
        const checked = eligibleTeams.includes(teamId) ? 'checked' : '';
        html += `
        <label class="checkbox-item">
            <input type="checkbox" id="eligible-team-${teamId}" ${checked} onchange="saveEligibleTeamsQuiet()" />
            <span class="checkbox-label">
                <span class="team-color-dot" style="background: ${team.color}"></span>
                ${escapeHtml(team.name)}
            </span>
        </label>`;
    });

    return html;
}

function saveEligibleTeams() {
    saveEligibleTeamsQuiet();
    showToast('Teams opgeslagen', 'success');
}

function saveEligibleTeamsQuiet() {
    const eligibleTeams = [];
    const relevantTeams = ['vlot1', 'vlot2', 'cargo'];

    relevantTeams.forEach(teamId => {
        const checkbox = document.getElementById(`eligible-team-${teamId}`);
        if (checkbox && checkbox.checked) {
            eligibleTeams.push(teamId);
        }
    });

    if (eligibleTeams.length === 0) {
        return; // Don't save if nothing selected
    }

    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = { eligibleTeams: [], assignments: {} };
    }
    DataStore.settings.responsibleRotation.eligibleTeams = eligibleTeams;
    saveToStorage();

    // Update the upcoming list without re-rendering everything
    const upcomingContainer = document.querySelector('.upcoming-responsibles');
    if (upcomingContainer) {
        upcomingContainer.innerHTML = renderUpcomingResponsibles();
        IconHelper.init(upcomingContainer);
    }
}

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

    // Show current status if set
    let statusHtml = '';
    if (currentStart && currentEmployee) {
        const startPerson = eligible.find(e => String(e.id) === currentEmployee);
        const startPersonName = escapeHtml(startPerson?.name || 'onbekend');
        statusHtml = `<div class="rotation-status">
            Rotatie gestart op ${formatDate(currentStart)} met ${startPersonName}
        </div>`;
    }

    return `
    ${statusHtml}
    <div class="form-row compact">
        <div class="form-group">
            <label for="rotation-start-employee">Eerste:</label>
            <select id="rotation-start-employee" class="form-input">
                ${employeeOptions}
            </select>
        </div>
        <button class="btn btn-primary btn-sm" onclick="saveRotationSettings()" style="align-self: flex-end;">Opslaan</button>
    </div>`;
}

function saveRotationSettings() {
    const employeeSelect = document.getElementById('rotation-start-employee');

    const startDate = getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate;
    const employeeId = employeeSelect.value;

    if (!startDate) {
        showToast('Stel eerst de Week 1 startdatum in', 'warning');
        return;
    }

    if (!employeeId) {
        showToast('Selecteer wie begint', 'warning');
        return;
    }

    // Check if it's a Monday
    const date = parseDateOnly(startDate);
    if (date.getDay() !== 1) {
        showToast('Kies een maandag als startdatum', 'warning');
        return;
    }

    // Use parseFloat to preserve full precision of employee ID
    setRotationStart(date, parseFloat(employeeId));
    renderSettings();
    renderPlanning(); // Update planning page too
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

    // Toon de komende 8 weekenden
    let html = '<div class="upcoming-list">';
    const today = new Date();
    const currentMonday = getMondayOfWeek(today);

    let count = 0;
    const checkDate = new Date(currentMonday);

    while (count < 8) {
        if (isWeekendOrHolidayWeek(checkDate)) {
            const responsible = getOrCalculateResponsible(checkDate);
            const weekNum = getISOWeekNumber(checkDate);
            const dateDisplay = checkDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });

            if (responsible) {
                const teamColor = DataStore.settings.teams[responsible.mainTeam]?.color || '#6b7280';
                const responsibleName = escapeHtml(responsible.name);
                html += `
                <div class="upcoming-item">
                    <span class="upcoming-date">${weekNum} (${dateDisplay})</span>
                    <span class="upcoming-name" style="border-left: 3px solid ${teamColor}; padding-left: 8px;">
                        ${responsibleName}
                    </span>
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
        minStaffingNight: Number(normalized.rules?.minStaffingNight) || defaults.rules?.minStaffingNight || 1
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
                showToast(`${result.results.errors.length} fouten opgetreden. Zie console (F12).`, 'warning');
            }

            // Reload page to show new data
            location.reload();
        } catch (error) {
            console.error('Import error:', error);
            showToast('Fout bij importeren: ' + error.message, 'error');
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
    console.log('Het Vlot Roosterplanning is gestart!');
});
