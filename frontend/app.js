// HET VLOT ROOSTERPLANNING - MAIN APPLICATION

// App State
const AppState = {
    currentUser: null,
    authToken: null,
    currentView: 'planning',
    currentWeekStart: null,
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
    availabilityMobileDayIndex: 0 // Same for availability view
};

// ===== PERMISSIONS SYSTEM =====
const PERMISSIONS = {
    VIEW_ALL_EMPLOYEES: ['admin', 'hoofdverantwoordelijke'],
    EDIT_ALL_EMPLOYEES: ['admin', 'hoofdverantwoordelijke'],
    EDIT_TEAM_EMPLOYEES: ['admin', 'hoofdverantwoordelijke', 'teamverantwoordelijke'],
    ADD_EMPLOYEES: ['admin', 'hoofdverantwoordelijke', 'teamverantwoordelijke'],
    VIEW_ALL_AVAILABILITY: ['admin', 'hoofdverantwoordelijke'],
    MANAGE_AVAILABILITY: ['admin', 'hoofdverantwoordelijke', 'teamverantwoordelijke'],
    CHANGE_SETTINGS: ['admin', 'hoofdverantwoordelijke'],
    MANAGE_ACCOUNTS: ['admin'],
    EXPORT_DATA: ['admin', 'hoofdverantwoordelijke']
};

function hasPermission(permission) {
    const role = AppState.currentUser?.role;
    return PERMISSIONS[permission]?.includes(role) || false;
}

function canManageEmployee(employee) {
    const role = AppState.currentUser?.role;
    const userTeam = AppState.currentUser?.team_id;

    if (['admin', 'hoofdverantwoordelijke'].includes(role)) return true;
    if (role === 'teamverantwoordelijke') {
        const empTeam = typeof employee === 'object' ? employee.mainTeam : employee;
        return empTeam === userTeam;
    }
    return false;
}

function canManageAvailability(employeeId) {
    const role = AppState.currentUser?.role;
    const userId = AppState.currentUser?.id;
    const userTeam = AppState.currentUser?.team_id;

    if (['admin', 'hoofdverantwoordelijke'].includes(role)) return true;
    if (role === 'teamverantwoordelijke') {
        const emp = DataStore.employees.find(e => String(e.id) === String(employeeId));
        return emp?.mainTeam === userTeam;
    }
    if (role === 'medewerker') return String(employeeId) === String(userId);
    return false;
}

function getVisibleTeamsForRole() {
    const role = AppState.currentUser?.role;
    const userTeam = AppState.currentUser?.team_id;
    const allTeams = ['vlot1', 'vlot2', 'cargo', 'overkoepelend', 'jobstudent'];

    if (['admin', 'hoofdverantwoordelijke'].includes(role)) {
        return allTeams;
    }
    if (role === 'teamverantwoordelijke' && userTeam) {
        return [userTeam];
    }
    if (role === 'medewerker' && userTeam) {
        return [userTeam];
    }
    return allTeams;
}

// Demo users
const USERS = [
    { username: 'admin', password: 'admin', role: 'admin', name: 'Administrator' },
    { username: 'medewerker', password: 'medewerker', role: 'employee', name: 'Medewerker' }
];

// DOM Elements
const DOM = {};
const API_BASE = window.API_BASE || 'http://localhost:3001';

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
    if (!AppState.currentUser || !Array.isArray(DataStore.employees)) return;
    try {
        const data = await apiFetch('/users');
        const users = data.users || [];
        if (users.length === 0) return;
        const usersByEmail = new Map(users.map(user => [String(user.email || '').toLowerCase(), user]));
        let changed = false;
        DataStore.employees = DataStore.employees.map(emp => {
            const email = String(emp.email || '').toLowerCase();
            const linked = usersByEmail.get(email);
            if (!linked) return emp;
            if (emp.user_id === linked.id) return emp;
            changed = true;
            return { ...emp, user_id: linked.id };
        });
        if (changed) {
            saveToStorage();
        }
    } catch (error) {
        console.warn('Kon accounts niet koppelen:', error.message);
    }
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
    DOM.planningView = document.getElementById('planning-view');
    DOM.employeesView = document.getElementById('employees-view');
    DOM.profileView = document.getElementById('profile-view');
    DOM.profileContent = document.getElementById('profile-content');
    DOM.availabilityView = document.getElementById('availability-view');
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
    DOM.generateScheduleBtn = document.getElementById('generate-schedule-btn');
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
        alert('Er is een fout opgetreden bij het starten van de applicatie. Check de console (F12) voor details.');
    }
}

function setupEventListeners() {
    DOM.loginForm.addEventListener('submit', handleLogin);
    DOM.logoutBtn.addEventListener('click', handleLogout);

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
    DOM.prevWeekBtn.addEventListener('click', () => changeWeek(-1));
    DOM.nextWeekBtn.addEventListener('click', () => changeWeek(1));
    DOM.todayBtn.addEventListener('click', () => {
        setCurrentWeek(new Date());
        // Set mobile day to today's day of the week (0=Mon, 6=Sun)
        const today = new Date();
        const dayOfWeek = today.getDay();
        // Convert from JS day (0=Sun, 6=Sat) to our format (0=Mon, 6=Sun)
        AppState.mobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        renderPlanning();
    });

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

    // Team toggle buttons for planning view
    document.querySelectorAll('#team-toggles .team-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const team = btn.dataset.team;
            btn.classList.toggle('active');

            if (btn.classList.contains('active')) {
                if (!AppState.visibleTeams.includes(team)) {
                    AppState.visibleTeams.push(team);
                }
            } else {
                AppState.visibleTeams = AppState.visibleTeams.filter(t => t !== team);
            }

            renderCalendar();
        });
    });

    // Team toggle buttons for employees view
    document.querySelectorAll('#employee-team-toggles .team-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const team = btn.dataset.team;
            btn.classList.toggle('active');

            if (btn.classList.contains('active')) {
                if (!AppState.visibleEmployeeTeams.includes(team)) {
                    AppState.visibleEmployeeTeams.push(team);
                }
            } else {
                AppState.visibleEmployeeTeams = AppState.visibleEmployeeTeams.filter(t => t !== team);
            }

            renderEmployees();
        });
    });

    DOM.addEmployeeBtn.addEventListener('click', openAddEmployeeModal);
    DOM.shiftForm.addEventListener('submit', handleShiftSubmit);
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

    // Week tabs (static in HTML)
    document.querySelectorAll('.week-tab').forEach(tab => {
        tab.addEventListener('click', () => switchWeekTab(parseInt(tab.dataset.week)));
    });

    // Generate schedule button
    DOM.generateScheduleBtn.addEventListener('click', handleGenerateSchedule);

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
}

async function handleLogin(e) {
    e.preventDefault();
    const email = DOM.usernameInput.value.trim();
    const password = DOM.passwordInput.value;
    try {
        const data = await apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password })
        });
        AppState.currentUser = data.user;
        AppState.authToken = data.token;
        sessionStorage.setItem('hetvlot_user', JSON.stringify(data.user));
        sessionStorage.setItem('hetvlot_token', data.token);
        if (typeof window.initializeData === 'function') {
            await window.initializeData();
        }
        await syncEmployeeAccountLinks();
        showApp();
    } catch (error) {
        alert('Ongeldige gebruikersnaam of wachtwoord');
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
        if (typeof window.initializeData === 'function') {
            await window.initializeData();
        }
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

function showApp() {
    DOM.loginContainer.classList.add('hidden');
    DOM.appContainer.classList.remove('hidden');
    DOM.currentUserSpan.textContent = AppState.currentUser.name;
    applyRoleVisibility();
    switchView(AppState.currentView);
}

function applyRoleVisibility() {
    const role = AppState.currentUser?.role || 'medewerker';
    const allowedViews = new Set(['planning', 'profile']);

    // All roles get basic views
    allowedViews.add('employees');
    allowedViews.add('availability');
    allowedViews.add('swaps');

    // Settings only for hoofdverantwoordelijke and admin
    if (['hoofdverantwoordelijke', 'admin'].includes(role)) {
        allowedViews.add('settings');
    }

    DOM.navButtons.forEach(btn => {
        const view = btn.dataset.view;
        const isAllowed = allowedViews.has(view);
        btn.style.display = isAllowed ? '' : 'none';
    });

    if (!allowedViews.has(AppState.currentView)) {
        AppState.currentView = 'planning';
    }

    // Team filters: hide for medewerker, show limited for teamverantwoordelijke
    const hideTeamFilters = role === 'medewerker';
    const limitTeamFilters = role === 'teamverantwoordelijke';
    const planningFilters = document.getElementById('team-toggles');
    const employeeFilters = document.getElementById('employee-team-toggles');

    if (planningFilters) planningFilters.style.display = hideTeamFilters ? 'none' : '';
    if (employeeFilters) employeeFilters.style.display = hideTeamFilters ? 'none' : '';

    // For teamverantwoordelijke, limit visible teams to their own
    if (limitTeamFilters) {
        const visibleTeams = getVisibleTeamsForRole();
        AppState.visibleTeams = visibleTeams;
        AppState.visibleEmployeeTeams = visibleTeams;
    }
}

function switchView(viewName) {
    AppState.currentView = viewName;
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
    AppState.viewMode = mode;
    DOM.viewToggleBtns.forEach(btn => {
        if (btn.dataset.mode === mode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    renderPlanning();
}

function updatePeriodDisplay() {
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

function renderPlanning() {
    if (!AppState.currentWeekStart) {
        setCurrentWeek(new Date());
    }
    updatePeriodDisplay();
    updateMobileDayDisplay();
    renderValidationAlerts();
    renderCalendar();
    // Set mobile day attribute after calendar is rendered
    updateTimelineMobileDayAttribute();
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
                <span class="validation-icon">⚠️</span>
                <span class="validation-text">${totalErrors} fout${totalErrors > 1 ? 'en' : ''} (klik voor details)</span>
            </div>`;
        } else {
            AppState.errorBreakdown = null;
        }

        if (totalWarnings > 0) {
            AppState.warningBreakdown = buildIssueBreakdown(summary, 'warnings');
            html += `<div class="validation-summary-item validation-warning">
                <span class="validation-icon">⚡</span>
                <span class="validation-text">${totalWarnings} waarschuwing${totalWarnings > 1 ? 'en' : ''} (klik voor details)</span>
            </div>`;
        } else {
            AppState.warningBreakdown = null;
        }

        html += '<div class="validation-summary-note">Klik op een dienst in de kalender om details te zien</div>';
        html += '</div>';

    }

    DOM.validationAlerts.innerHTML = html;
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
        renderTimelineView();
    } catch (error) {
        console.error('Error rendering calendar:', error);
        DOM.rosterCalendar.innerHTML = '<div class="no-shifts-message">Planner kon niet geladen worden. Check de console (F12).</div>';
    }
}

function renderTimelineView() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const dayNames = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

    // Get all employees who have shifts this week
    let allShifts = [];
    weekDates.forEach(date => {
        let shifts = getShiftsByDate(date);
        // Filter by visible teams
        shifts = shifts.filter(s => AppState.visibleTeams.includes(s.team));
        allShifts = allShifts.concat(shifts);
    });

    // Get unique employees with shifts
    const employeeIds = [...new Set(allShifts.map(s => s.employeeId))];
    let employees = employeeIds.map(id => getEmployee(id)).filter(e => e);

    // Group employees by their main team - only show visible teams
    const teams = DataStore.settings.teams || {};
    // Custom order: Vlot 1, Jobstudent, Vlot 2, Cargo, Overkoepelend
    const teamOrder = ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend']
        .filter(t => AppState.visibleTeams.includes(t));
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name));
    });

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
        const isClosed = isWeekend && !isWeekendOpen(date);
        const isHoliday = isHolidayPeriod(date);
        const holidayInfo = isHoliday ? getHolidayPeriod(date) : null;

        let headerClass = 'timeline-day-header';
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        if (isHoliday) headerClass += ' holiday';

        const holidayLabel = escapeHtml(holidayInfo?.name || 'Vakantie');
        const holidayBadge = isHoliday ? `<span class="holiday-badge" data-tooltip="${holidayLabel}">🏖️</span>` : '';

        html += `<div class="${headerClass}">
            <span class="day-name">${dayName}</span>
            <span class="day-num">${dateNum}${holidayBadge}</span>
        </div>`;
    });
    html += '</div>';

    // Time scale row
    html += '<div class="timeline-scale-row">';
    html += '<div class="timeline-scale-label"></div>';
    weekDates.forEach((date) => {
        html += '<div class="timeline-scale">';
        // Show markers at 7u, 11u, 15u, 19u, 23u, 24u
        for (let h = START_HOUR; h <= END_HOUR; h += 4) {
            const leftPercent = ((h - START_HOUR) / TOTAL_HOURS) * 100;
            const label = h === 24 ? '0u' : `${h}u`;
            html += `<span class="scale-marker" style="left: ${leftPercent}%">${label}</span>`;
        }
        html += '</div>';
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
                const responsibleBadge = isResponsible ? '<span class="responsible-badge">⭐</span>' : '';
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
                    const isClosed = isWeekend && !isWeekendOpen(date);

                    let cellClass = 'timeline-day-cell';
                    if (isWeekend) cellClass += ' weekend';
                    if (isClosed) cellClass += ' closed';

                    html += `<div class="${cellClass}">`;

                    if (!isClosed) {
                        // Get shifts for this employee on this date
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        // Filter by visible teams
                        shifts = shifts.filter(s => AppState.visibleTeams.includes(s.team));

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

                                // Totale uren in percentage van één dag
                                // We moeten de width berekenen als: dag1 deel + kleine gap + dag2 deel
                                // De dag cellen zitten naast elkaar, dus 100% = 1 volledige cel
                                // We gebruiken calc() met een kleine extra voor de grid gap
                                const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;

                                // Totaal: dag1 + gap (4px) + dag2
                                widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
                            }

                            let blockClass = `timeline-block team-${shift.team}`;
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
                                titleText = `⚠️ CONFLICT: ${absenceLabels[availability.type] || 'Afwezig'}\n${titleText}`;
                            }
                            if (!validation.isValid && validation.errors.length > 0) {
                                titleText += `\n❌ ${validation.errors.map(e => e.message).join('\n❌ ')}`;
                            }
                            if (validation.hasWarnings && validation.warnings.length > 0) {
                                titleText += `\n⚠️ ${validation.warnings.map(w => w.message).join('\n⚠️ ')}`;
                            }

                            // Width kan een getal of een calc() string zijn
                            const widthStyle = typeof widthPercent === 'string' ? widthPercent : `${widthPercent}%`;

                            // Escape quotes voor data-tooltip
                            const tooltipText = escapeHtml(titleText);

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         onclick="openEditShiftModal(${shift.id})"
                                         style="left: ${leftPercent}%; width: ${widthStyle};"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
                                ${isAbsent ? '<span class="absent-badge">⚠️</span>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });
        });
    }

    html += '</div>'; // Close body
    html += '</div>'; // Close wrapper

    DOM.rosterCalendar.innerHTML = html;
}

function getShiftsForDateAndTimeSlot(date, slotStart, slotEnd) {
    let shifts = getShiftsByDate(date);
    // Filter by visible teams
    shifts = shifts.filter(s => AppState.visibleTeams.includes(s.team));
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
        availabilityIcon = `<span class="shift-availability-indicator unavailable" title="⚠️ CONFLICT: ${label}">⚠️ ${label}</span>`;
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
            <button class="shift-delete-btn" data-shift-id="${shift.id}">×</button>
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
        availabilityIcon = `<span class="shift-availability-indicator unavailable" title="Medewerker niet beschikbaar: ${reason}">⚠️</span>`;
    } else if (availability && availability.shiftTypes && availability.shiftTypes.length > 0) {
        // Check if shift matches availability
        let shiftType = null;
        if (startHour >= 7 && startHour < 16) shiftType = 'vroeg';
        else if (startHour >= 16 && startHour < 23) shiftType = 'laat';
        else if (startHour >= 23 || startHour < 9) shiftType = 'nacht';

        if (shiftType && !availability.shiftTypes.includes(shiftType)) {
            const shiftTypes = escapeHtml(availability.shiftTypes.join(', '));
            availabilityIcon = `<span class="shift-availability-indicator partial" title="Alleen beschikbaar voor: ${shiftTypes}">⚡</span>`;
        }
    }

    const employeeName = escapeHtml(employee.name);
    return `<div class="${cardClass}" data-shift-id="${shift.id}">
        <div class="shift-employee-name">${employeeName}${availabilityIcon}</div>
        <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
        <div class="shift-card-footer">
            <span class="shift-team-badge team-${shift.team}">${escapeHtml(DataStore.settings.teams[shift.team].name)}</span>
            <button class="shift-delete-btn" data-shift-id="${shift.id}">×</button>
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
    populateEmployeeDropdown();
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

function openEditShiftModal(shiftId) {
    const shift = getShift(shiftId);
    if (!shift) return;
    AppState.editingShiftId = shiftId;
    DOM.shiftModalTitle.textContent = 'Dienst bewerken';
    DOM.shiftDeleteBtn.style.display = 'block';
    populateEmployeeDropdown();
    DOM.shiftEmployee.value = shift.employeeId;
    DOM.shiftTeam.value = shift.team;
    DOM.shiftDate.value = shift.date;
    DOM.shiftStart.value = shift.startTime;
    DOM.shiftEnd.value = shift.endTime;
    DOM.shiftNotes.value = shift.notes || '';

    // Show existing validation issues for this shift
    const validation = validateShift(shift, shift.id);
    const availability = getAvailability(shift.employeeId, shift.date);
    const isAbsent = availability && availability.type;

    let issuesHtml = '';
    if (isAbsent) {
        const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren opnemen', 'vorming': 'Vorming', 'andere': 'Afwezig' };
        const employeeName = escapeHtml(getEmployee(shift.employeeId)?.name || '');
        issuesHtml += `<div class="validation-warning absence">
            <strong>⚠️ Afwezigheid:</strong> ${employeeName} is afwezig (${absenceLabels[availability.type] || 'Afwezig'})
        </div>`;
    }
    if (!validation.isValid && validation.errors.length > 0) {
        issuesHtml += `<div class="validation-error">
            <strong>❌ Fouten:</strong>
            <ul>${validation.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>
        </div>`;
    }
    if (validation.hasWarnings && validation.warnings.length > 0) {
        issuesHtml += `<div class="validation-warning">
            <strong>⚠️ Waarschuwingen:</strong>
            <ul>${validation.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>
        </div>`;
    }
    DOM.shiftValidationErrors.innerHTML = issuesHtml;

    DOM.shiftModal.classList.remove('hidden');
}

function closeShiftModal() {
    DOM.shiftModal.classList.add('hidden');
    DOM.shiftForm.reset();
    AppState.editingShiftId = null;
}

function handleShiftDelete() {
    if (!AppState.editingShiftId) return;

    if (confirm('Weet je zeker dat je deze dienst wilt verwijderen?')) {
        deleteShift(AppState.editingShiftId);
        closeShiftModal();
        renderPlanning();
    }
}

function populateEmployeeDropdown() {
    const employees = getAllEmployees(true);
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

function handleShiftSubmit(e) {
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

        if (!validation.isValid) {
            let html = '<ul>';
            validation.errors.forEach(error => {
                html += `<li>${error.message}</li>`;
            });
            html += '</ul>';
            DOM.shiftValidationErrors.innerHTML = html;
            return;
        }
        if (validation.hasWarnings) {
            let warningMsg = 'Waarschuwingen:\n\n';
            validation.warnings.forEach(warning => {
                warningMsg += `- ${warning.message}\n`;
            });
            warningMsg += '\nToch opslaan?';
            if (!confirm(warningMsg)) {
                return;
            }
        }
        if (AppState.editingShiftId) {
            updateShift(AppState.editingShiftId, shiftData);
        } else {
            addShift(shiftData);
        }
        closeShiftModal();
        renderPlanning();
    } catch (error) {
        console.error('Error in handleShiftSubmit:', error);
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Er is een fout opgetreden: ' + error.message + '</li></ul>';
    }
}

function deleteShiftConfirm(shiftId) {
    const shift = getShift(shiftId);
    if (!shift) return;
    const employee = getEmployee(shift.employeeId);
    const msg = `Dienst verwijderen?\n\n${employee.name}\n${formatDate(shift.date)}\n${shift.startTime} - ${shift.endTime}`;
    if (confirm(msg)) {
        deleteShift(shiftId);
        renderPlanning();
    }
}

function renderEmployees() {
    const role = AppState.currentUser?.role || 'medewerker';
    const employees = getAllEmployees();
    // Groepeer medewerkers per team - alleen zichtbare teams
    const teams = DataStore.settings.teams;
    const baseTeamOrder = ['vlot1', 'vlot2', 'cargo', 'overkoepelend', 'jobstudent']
        .filter(t => AppState.visibleEmployeeTeams.includes(t));
    let teamOrder = baseTeamOrder;

    // Filter teams based on role
    if (['medewerker', 'teamverantwoordelijke'].includes(role)) {
        const userTeam = AppState.currentUser?.team_id
            || employees.find(emp => emp.user_id === AppState.currentUser?.id)?.mainTeam
            || employees.find(emp => emp.email && emp.email.toLowerCase() === String(AppState.currentUser?.email || '').toLowerCase())?.mainTeam;
        teamOrder = userTeam ? baseTeamOrder.filter(teamId => teamId === userTeam) : [];
    }
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name));
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
        hoofdverantwoordelijke: 'Hoofdverantwoordelijke',
        teamverantwoordelijke: 'Teamverantwoordelijke',
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
        hoofdverantwoordelijke: 'Alle paginas + instellingen (zonder accountbeheer)',
        teamverantwoordelijke: 'Eigen team beheren + verlof registreren',
        medewerker: 'Alle paginas behalve instellingen'
    };
    const accessSummary = accessMap[user.role] || 'Planning + profiel';

    DOM.profileContent.innerHTML = `
        <div class="profile-grid">
            <div class="settings-card">
                <div class="settings-card-header">
                    <h3><span class="settings-icon">👤</span> Mijn profiel</h3>
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
                    <h3><span class="settings-icon">🔎</span> Account overzicht</h3>
                </div>
                <div class="settings-card-body">
                    <div class="profile-meta">
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
            setMessage('Profiel opgeslagen.', 'success');
        } catch (error) {
            setMessage(`Opslaan mislukt: ${error.message}`, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Opslaan';
        }
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
                ${emp.email ? `<div class="employee-info-item">📧 ${employeeEmail}</div>` : ''}
                ${emp.contractHours ? `<div class="employee-info-item">⏰ ${emp.contractHours}u/week contract</div>` : ''}
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
                            <button class="week-nav-btn" type="button" data-employee-id="${emp.id}" data-direction="prev" title="Vorige week">&larr;</button>
                            <button class="week-nav-btn" type="button" data-employee-id="${emp.id}" data-direction="today" title="Huidige week">•</button>
                            <button class="week-nav-btn" type="button" data-employee-id="${emp.id}" data-direction="next" title="Volgende week">&rarr;</button>
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
    DOM.employeeModalTitle.textContent = 'Medewerker bewerken';
    DOM.employeeName.value = employee.name;
    DOM.employeeEmail.value = employee.email || '';
    DOM.employeeMainTeam.value = employee.mainTeam;
    DOM.employeeContract.value = employee.contractHours || '';
    DOM.employeeActive.checked = employee.active;
    generateWeekScheduleHTML();
    loadWeekScheduleForm(1, employee.weekScheduleWeek1 || []);
    loadWeekScheduleForm(2, employee.weekScheduleWeek2 || []);
    DOM.employeeDeleteBtn.style.display = 'inline-flex';
    DOM.employeeModal.classList.remove('hidden');
}

function closeEmployeeModal() {
    DOM.employeeModal.classList.add('hidden');
    DOM.employeeForm.reset();
    AppState.editingEmployeeId = null;
    DOM.employeeDeleteBtn.style.display = 'none';
}

function handleEmployeeSubmit(e) {
    e.preventDefault();
    const weekScheduleWeek1 = getWeekScheduleFromForm(1);
    const weekScheduleWeek2 = getWeekScheduleFromForm(2);

    const employeeData = {
        name: DOM.employeeName.value.trim(),
        email: DOM.employeeEmail.value.trim(),
        mainTeam: DOM.employeeMainTeam.value,
        extraTeams: [],
        contractHours: parseFloat(DOM.employeeContract.value) || 0,
        active: DOM.employeeActive.checked,
        weekScheduleWeek1: weekScheduleWeek1,
        weekScheduleWeek2: weekScheduleWeek2
    };
    if (AppState.editingEmployeeId) {
        updateEmployee(AppState.editingEmployeeId, employeeData);
    } else {
        addEmployee(employeeData);
    }
    closeEmployeeModal();
    renderEmployees();
}

function handleEmployeeDelete() {
    if (!AppState.editingEmployeeId) return;
    const employee = getEmployee(AppState.editingEmployeeId);
    if (!employee) return;

    const relatedShifts = getShiftsByEmployee(employee.id).length;
    const confirmMsg = `Weet je zeker dat je ${employee.name} wilt verwijderen?\n\nDit verwijdert ook ${relatedShifts} dienst${relatedShifts !== 1 ? 'en' : ''} en eventuele afwezigheden.`;

    if (!confirm(confirmMsg)) return;

    deleteEmployee(employee.id);
    closeEmployeeModal();
    renderEmployees();
    renderPlanning();
}

// ===== WEEKROOSTER FUNCTIES =====

function handleGenerateSchedule() {
    // Get current week dates
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const startDate = weekDates[0];
    const endDate = weekDates[6];

    if (!confirm(`Wil je de weekroosters genereren voor deze week (${formatDate(startDate)} t/m ${formatDate(endDate)})?\\n\\nBestaande diensten in deze week worden verwijderd en opnieuw gegenereerd.`)) {
        return;
    }

    const removedShifts = removeShiftsInDateRange(startDate, endDate);
    const totalShifts = applyWeekScheduleForAllEmployees(startDate, endDate);

    if (totalShifts > 0 || removedShifts > 0) {
        const removedLabel = removedShifts > 0 ? ` (${removedShifts} bestaande dienst${removedShifts !== 1 ? 'en' : ''} verwijderd)` : '';
        alert(`✅ ${totalShifts} dienst${totalShifts !== 1 ? 'en' : ''} automatisch aangemaakt op basis van weekroosters!${removedLabel}`);
        renderPlanning();
    } else {
        alert('Geen nieuwe diensten aangemaakt. Medewerkers hebben geen weekrooster ingesteld.');
    }
}

function generateWeekScheduleHTML() {
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

    // Week 1: ma-vr (geen weekend want gesloten)
    // Week 2: ma-zo (weekend open)
    container.innerHTML =
        generateWeekHTML(1, [1, 2, 3, 4, 5]) +
        generateWeekHTML(2, [1, 2, 3, 4, 5, 6, 0]);

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
    const role = AppState.currentUser?.role || 'medewerker';
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
    let teamOrder = ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend'];
    // Filter by team for medewerker and teamverantwoordelijke
    if (['medewerker', 'teamverantwoordelijke'].includes(role)) {
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
                <button id="availability-prev-week" class="btn btn-nav">&larr;</button>
                <button id="availability-today" class="btn">Vandaag</button>
                <button id="availability-next-week" class="btn btn-nav">&rarr;</button>
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
            <button id="availability-mobile-prev-day" class="btn btn-sm">&larr;</button>
            <div id="availability-mobile-day-display" class="mobile-day-display">
                ${getAvailabilityMobileDayDisplayHTML()}
            </div>
            <button id="availability-mobile-next-day" class="btn btn-sm">&rarr;</button>
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
        const isClosed = isWeekend && !isWeekendOpen(date);
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
            html += `<div class="availability-employee-row">
                <div class="availability-employee-col">
                    <span class="emp-name">${escapeHtml(emp.name)}</span>
                </div>
            `;

            // Days for this employee
            weekDates.forEach(date => {
                const d = parseDateOnly(date);
                const dayOfWeek = d.getDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                const isClosed = isWeekend && !isWeekendOpen(date);

                const absence = getAvailability(emp.id, date);
                const hasShift = getShiftsByEmployee(emp.id, date, date).length > 0;

                // Check of medewerker normaal werkt op deze dag volgens weekrooster
                const weekNumber = getWeekNumber(date);
                const weekSchedule = weekNumber === 1 ? emp.weekScheduleWeek1 : emp.weekScheduleWeek2;
                const scheduledForDay = weekSchedule && weekSchedule.find(s => s.dayOfWeek === dayOfWeek && s.enabled);
                const hasWeekSchedule = (emp.weekScheduleWeek1 && emp.weekScheduleWeek1.length > 0) ||
                                        (emp.weekScheduleWeek2 && emp.weekScheduleWeek2.length > 0);

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
                            tooltipText = `⚠️ CONFLICT: ${statusText} maar heeft nog dienst ingepland!`;
                        }
                    } else if (hasShift) {
                        statusClass = 'has-shift';
                        statusText = 'Dienst';
                        tooltipText = 'Heeft dienst ingepland';
                    } else if (hasWeekSchedule && !scheduledForDay) {
                        // Medewerker heeft een weekrooster maar werkt niet op deze dag
                        statusClass = 'not-scheduled';
                        statusText = 'Vrij';
                        tooltipText = 'Niet ingepland volgens weekrooster';
                    } else {
                        statusClass = 'available';
                        statusText = '';
                        tooltipText = 'Beschikbaar - klik om afwezigheid te registreren';
                    }
                }

                const conflictIcon = hasConflict ? '<span class="conflict-icon">⚠️</span>' : '';
                const cellContent = !isClosed ? `
                    <div class="availability-cell-content ${statusClass}"
                         data-employee-id="${emp.id}"
                         data-date="${date}"
                         title="${escapeHtml(tooltipText)}">
                        ${conflictIcon}${statusText ? `<span class="status-label">${escapeHtml(statusText)}</span>` : '<span class="status-check">✓</span>'}
                    </div>
                ` : '';

                html += `<div class="${cellClass}">${cellContent}</div>`;
            });

            html += `</div>`; // End employee row
        });
    });

    html += `</div></div>`; // End table and container

    DOM.availabilityView.querySelector('#availability-content').innerHTML = html;

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

function renderSwaps() {
    DOM.swapsView.querySelector('#swaps-list').innerHTML = `<div style="padding: 40px; text-align: center; color: #64748b;"><h3>Dienstenruil systeem</h3><p>Deze functie wordt binnenkort toegevoegd.</p><p>Hier kunnen medewerkers verzoeken indienen om diensten te ruilen.</p></div>`;
}

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

function switchSettingsTab(tabName) {
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
        default:
            content.innerHTML = '<p>Ongeldige tab</p>';
    }
}

// ===== SETTINGS TAB: ACCOUNTS =====
function renderSettingsAccounts(container) {
    const role = AppState.currentUser?.role;

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
            <option value="hoofdverantwoordelijke">Hoofdverantwoordelijke</option>
            <option value="teamverantwoordelijke">Teamverantwoordelijke</option>
            <option value="medewerker">Medewerker</option>
        `;

        const rows = users.map(user => `
            <div class="admin-user-row is-collapsed" data-user-id="${user.id}" data-name="${escapeHtml(user.name)}" data-email="${escapeHtml(user.email)}" data-team="${user.team_id || ''}" data-role="${user.role}">
                <div class="admin-user-header">
                    <div>
                        <div class="admin-user-name">${escapeHtml(user.name)}</div>
                        <div class="admin-user-email">${escapeHtml(user.email)}</div>
                    </div>
                    <div class="admin-user-header-actions">
                        <div class="admin-user-role-pill">${escapeHtml(user.role)}</div>
                        <button type="button" class="btn btn-sm btn-secondary admin-user-toggle">Details</button>
                    </div>
                </div>
                <div class="admin-user-details">
                    <div class="admin-user-controls">
                    <div class="admin-field">
                        <label>Rol</label>
                        <div class="role-pill-group">
                            <button type="button" class="role-pill-btn" data-role="admin">Admin</button>
                            <button type="button" class="role-pill-btn" data-role="hoofdverantwoordelijke">Hoofd</button>
                            <button type="button" class="role-pill-btn" data-role="teamverantwoordelijke">Team</button>
                            <button type="button" class="role-pill-btn" data-role="medewerker">Medewerker</button>
                        </div>
                        <select class="admin-role-select role-select-hidden">
                            ${roleOptions}
                        </select>
                    </div>
                    <div class="admin-field">
                        <label>Team</label>
                        <select class="admin-team-select">
                            ${teamOptions}
                        </select>
                    </div>
                    <div class="admin-actions">
                        <button class="btn btn-sm btn-primary admin-save-btn">Opslaan</button>
                        <button class="btn btn-sm btn-secondary admin-reset-btn">Reset wachtwoord</button>
                    </div>
                    </div>
                </div>
            </div>
        `).join('');

        const list = container.querySelector('#admin-users-list');
        list.innerHTML = rows || '<p>Geen accounts gevonden.</p>';

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
            const roleSelect = row.querySelector('.admin-role-select');
            const teamSelect = row.querySelector('.admin-team-select');
            roleSelect.value = user.role;
            teamSelect.value = user.team_id || '';
            const roleButtons = Array.from(row.querySelectorAll('.role-pill-btn'));
            const rolePill = row.querySelector('.admin-user-role-pill');
            const syncRoleButtons = (role) => {
                roleButtons.forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.role === role);
                });
                if (rolePill) rolePill.textContent = role;
                row.dataset.role = role;
            };
            syncRoleButtons(user.role);
            roleButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const nextRole = btn.dataset.role;
                    roleSelect.value = nextRole;
                    syncRoleButtons(nextRole);
                });
            });

            const toggleBtn = row.querySelector('.admin-user-toggle');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const isCollapsed = row.classList.toggle('is-collapsed');
                    toggleBtn.textContent = isCollapsed ? 'Details' : 'Verberg';
                });
            }

            row.querySelector('.admin-save-btn').addEventListener('click', async () => {
                try {
                    const payload = {
                        role: roleSelect.value,
                        team_id: teamSelect.value || null
                    };
                    await apiFetch(`/admin/users/${userId}`, {
                        method: 'PATCH',
                        body: JSON.stringify(payload)
                    });
                    alert('Account bijgewerkt');
                } catch (error) {
                    alert(`Opslaan mislukt: ${error.message}`);
                }
            });

            row.querySelector('.admin-reset-btn').addEventListener('click', async () => {
                if (!confirm('Wachtwoord resetten naar standaard?')) return;
                try {
                    const result = await apiFetch(`/admin/users/${userId}/reset-password`, {
                        method: 'POST'
                    });
                    alert(`Wachtwoord gereset naar: ${result.resetPassword}`);
                } catch (error) {
                    alert(`Reset mislukt: ${error.message}`);
                }
            });
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
    } catch (error) {
        container.querySelector('#admin-users-list').textContent = `Fout: ${error.message}`;
    }
}

// ===== SETTINGS TAB: PLANNING =====
function renderSettingsPlanning(container) {
    const rules = DataStore.settings.rules;

    container.innerHTML = `
        <!-- Planning regels -->
        <div class="settings-card" id="settings-rules">
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
        <!-- Bi-weekly rooster -->
        <div class="settings-card" id="settings-biweekly">
            <div class="settings-card-header">
                <div class="settings-card-title">
                    <h3>Bi-weekly Patroon</h3>
                    <p class="settings-card-subtitle">Week 1 en Week 2 wisselen elkaar af.</p>
                </div>
            </div>
            <div class="settings-card-body">
                <div class="info-box info">
                    <p><strong>Week 1</strong> = weekend GESLOTEN (vrij 18:00 - ma 7:30)</p>
                    <p><strong>Week 2</strong> = weekend OPEN</p>
                    <p class="current-setting">Huidige Week 1 start: <strong>${formatDate(DataStore.settings.biWeeklyReferenceDate)}</strong></p>
                </div>
                <div class="form-group">
                    <label for="biweekly-reference-date">Referentie maandag voor Week 1:</label>
                    <div class="input-with-button">
                        <input type="date" id="biweekly-reference-date" class="form-input" value="${DataStore.settings.biWeeklyReferenceDate}" />
                        <button class="btn btn-primary" onclick="updateBiWeeklyReference()">Opslaan</button>
                    </div>
                    <span class="form-hint">Selecteer altijd een maandag</span>
                </div>
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
                <p class="form-help-text">Tijdens open weekenden (Week 2) wordt automatisch een verantwoordelijke aangeduid. De rotatie gaat om de beurt door medewerkers van de geselecteerde teams.</p>

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
}

// ===== SETTINGS TAB: SYSTEEM =====
function renderSettingsSystem(container) {
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
                    <p>Alle data wordt lokaal opgeslagen in je browser (LocalStorage).</p>
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
                <div class="danger-zone">
                    <h4>Gevarenzone</h4>
                    <p>Deze actie kan niet ongedaan worden gemaakt!</p>
                    <button class="btn btn-danger" onclick="resetData()">Alle data wissen</button>
                </div>
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

async function ensureTeamsLoaded() {
    if (AppState.apiTeams && AppState.apiTeams.length > 0) {
        return AppState.apiTeams;
    }
    const data = await apiFetch('/teams');
    AppState.apiTeams = data.teams || [];
    return AppState.apiTeams;
}

function renderTeamsConfig() {
    let html = '';
    Object.keys(DataStore.settings.teams).forEach(teamId => {
        const team = DataStore.settings.teams[teamId];
        const teamName = escapeHtml(team.name);
        const teamKey = escapeHtml(teamId);
        html += `
        <div class="team-config-item" data-team-id="${teamId}">
            <div class="team-color-dot" style="background: ${team.color}"></div>
            <div class="team-info">
                <span class="team-name">${teamName}</span>
                <span class="team-id">${teamKey}</span>
            </div>
            <div class="team-actions">
                <input type="color" class="color-picker" value="${team.color}"
                       onchange="updateTeamColor('${teamId}', this.value)" title="Kleur wijzigen"/>
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
                <button class="btn-icon-only" onclick="editTemplate('${templateId}')" title="Bewerken">✏️</button>
                <button class="btn-icon-only danger" onclick="deleteTemplate('${templateId}')" title="Verwijderen">🗑️</button>
            </div>
        </div>`;
    });
    return html;
}

function getTemplateIcon(templateId) {
    const icons = {
        'vroeg': '🌅',
        'laat': '🌆',
        'nacht': '🌙',
        'lang': '📏'
    };
    return icons[templateId] || '🕐';
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

function updateTeamColor(teamId, color) {
    if (DataStore.settings.teams[teamId]) {
        DataStore.settings.teams[teamId].color = color;
        saveToStorage();
        applyTeamColors();
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
    alert('✅ Planning regels zijn opgeslagen!');
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

function deleteTemplate(templateId) {
    const template = DataStore.settings.shiftTemplates[templateId];
    if (!template) return;

    if (confirm(`Weet je zeker dat je de template "${template.name}" wilt verwijderen?`)) {
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
    <div class="modal-overlay active" id="template-modal-overlay" onclick="closeTemplateModal()">
        <div class="modal" onclick="event.stopPropagation()">
            <div class="modal-header">
                <h2>${title}</h2>
                <button class="modal-close" onclick="closeTemplateModal()">&times;</button>
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
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="closeTemplateModal()">Annuleren</button>
                <button class="btn btn-primary" onclick="saveTemplate('${templateId || ''}')">Opslaan</button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
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
        alert('Vul alle velden in');
        return;
    }

    if (rawId !== id) {
        alert('Template ID mag enkel letters, cijfers, _ of - bevatten');
        return;
    }

    if (!originalId && DataStore.settings.shiftTemplates[id]) {
        alert('Een template met deze ID bestaat al');
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
            <button class="btn-icon-only danger" onclick="deleteHolidayPeriod(${period.id})" title="Verwijderen">🗑️</button>
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
                <button class="modal-close" onclick="closeHolidayModal()">&times;</button>
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
        alert('Vul alle velden in');
        return;
    }

    if (parseDateOnly(end) < parseDateOnly(start)) {
        alert('Einddatum moet na startdatum liggen');
        return;
    }

    addHolidayPeriod(name, start, end);
    closeHolidayModal();
    renderSettings();
}

function deleteHolidayPeriod(id) {
    if (confirm('Weet je zeker dat je deze vakantieperiode wilt verwijderen?')) {
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

    alert('✅ Vakantie instellingen opgeslagen!');
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
    alert('✅ Teams opgeslagen!');
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
    }
}

function renderRotationSettings() {
    return renderRotationSettingsCompact();
}

function renderRotationSettingsCompact() {
    const rotation = DataStore.settings.responsibleRotation || {};
    const eligible = getEligibleEmployeesForResponsible();

    const referenceDate = DataStore.settings.biWeeklyReferenceDate || '';
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

    const startDate = DataStore.settings.biWeeklyReferenceDate;
    const employeeId = employeeSelect.value;

    if (!startDate) {
        alert('Stel eerst de Week 1 startdatum in');
        return;
    }

    if (!employeeId) {
        alert('Selecteer wie begint');
        return;
    }

    // Check if it's a Monday
    const date = parseDateOnly(startDate);
    if (date.getDay() !== 1) {
        alert('⚠️ Kies een maandag als startdatum');
        return;
    }

    // Use parseFloat to preserve full precision of employee ID
    setRotationStart(date, parseFloat(employeeId));
    renderSettings();
    renderPlanning(); // Update planning page too
    alert('✅ Rotatie ingesteld!');
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

function updateBiWeeklyReference() {
    const dateInput = document.getElementById('biweekly-reference-date');
    const selectedDate = dateInput.value;

    if (!selectedDate) {
        alert('Selecteer eerst een datum');
        return;
    }

    // Check if it's a Monday
    const date = parseDateOnly(selectedDate);
    const dayOfWeek = date.getDay();

    if (dayOfWeek !== 1) {
        alert('⚠️ De geselecteerde datum is geen maandag. Kies een maandag als referentie datum.');
        return;
    }

    DataStore.settings.biWeeklyReferenceDate = selectedDate;
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = { eligibleTeams: [], assignments: {} };
    }
    DataStore.settings.responsibleRotation.rotationStart = selectedDate;
    saveToStorage();
    renderSettings();
    renderPlanning(); // Update the current week display
    alert('✅ Referentie datum voor Week 1 is bijgewerkt!');
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
    const teamOrder = ['vlot1', 'jobstudent', 'vlot2', 'cargo', 'overkoepelend'];
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
            warningDiv.innerHTML = '<div class="alert alert-warning">⚠️ Deze medewerker heeft al een dienst op deze dag</div>';
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

function handleAvailabilitySave() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;
    const absenceType = document.getElementById('absence-type').value;
    const reason = document.getElementById('availability-reason').value.trim();

    // Validation
    if (!employeeId) {
        alert('Selecteer een medewerker');
        return;
    }
    if (!startDate || !endDate) {
        alert('Vul beide datums in');
        return;
    }
    if (!absenceType) {
        alert('Selecteer een type afwezigheid');
        return;
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    if (end < start) {
        alert('Einddatum moet na startdatum liggen');
        return;
    }

    try {
        // Check for conflicts first
        let conflictDates = [];
        let checkDate = parseDateOnly(start);
        while (checkDate <= end) {
            const dateStr = formatDateYYYYMMDD(checkDate);
            const shifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
            if (shifts.length > 0) {
                conflictDates.push(dateStr);
            }
            checkDate.setDate(checkDate.getDate() + 1);
        }

        // Warn about conflicts
        if (conflictDates.length > 0) {
            const employee = getEmployee(employeeId);
            const confirmMsg = `⚠️ Let op: ${employee.name} heeft nog ${conflictDates.length} dienst(en) ingepland op deze dagen!\n\nDiensten op: ${conflictDates.map(d => formatDate(d)).join(', ')}\n\nDe afwezigheid wordt geregistreerd, maar de diensten blijven staan. Vergeet niet deze diensten te verwijderen of opnieuw toe te wijzen!\n\nDoorgaan?`;
            if (!confirm(confirmMsg)) {
                return;
            }
        }

        // Apply absence for each day in range
        let currentDate = parseDateOnly(start);
        let daysSet = 0;

        while (currentDate <= end) {
            const dateStr = formatDateYYYYMMDD(currentDate);
            setAvailability(employeeId, dateStr, {
                type: absenceType,
                reason: reason
            });
            daysSet++;
            currentDate.setDate(currentDate.getDate() + 1);
        }

        closeAvailabilityModal();
        renderAvailability();
        renderPlanning(); // Update planning view to show conflicts

        const employee = getEmployee(employeeId);
        const typeName = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezigheid' }[absenceType] || 'Afwezigheid';

        let msg = `${typeName} geregistreerd voor ${employee.name} (${daysSet} dag${daysSet !== 1 ? 'en' : ''})`;
        if (conflictDates.length > 0) {
            msg += `\n\n⚠️ Vergeet niet de ${conflictDates.length} conflicterende dienst(en) aan te passen in de planning!`;
        }
        alert(msg);
    } catch (error) {
        console.error('Error saving availability:', error);
        alert('Er ging iets mis bij het opslaan: ' + error.message);
    }
}

function handleRemoveAbsence() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;

    if (!employeeId || !startDate || !endDate) {
        alert('Geen afwezigheid om te verwijderen');
        return;
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    if (end < start) {
        alert('Ongeldige datum range');
        return;
    }

    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    if (!confirm(`Afwezigheid verwijderen voor ${days} dag${days !== 1 ? 'en' : ''}?`)) {
        return;
    }

    // Remove absence for each day in range
    let currentDate = parseDateOnly(start);
    while (currentDate <= end) {
        const dateStr = formatDateYYYYMMDD(currentDate);
        removeAvailability(employeeId, dateStr);
        currentDate.setDate(currentDate.getDate() + 1);
    }

    closeAvailabilityModal();
    renderAvailability();
    renderPlanning(); // Update planning view
}

function exportData() {
    const dataToExport = {employees: DataStore.employees, shifts: DataStore.shifts, settings: DataStore.settings, exportDate: new Date().toISOString()};
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hetvlot-backup-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
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
            const weekScheduleWeek1 = Array.isArray(emp?.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [];
            const weekScheduleWeek2 = Array.isArray(emp?.weekScheduleWeek2) ? emp.weekScheduleWeek2 : [];

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

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            const sanitized = sanitizeImportedData(data);
            if (confirm('Data importeren? Dit overschrijft huidige data!')) {
                DataStore.employees = sanitized.employees;
                DataStore.shifts = sanitized.shifts;
                DataStore.availability = sanitized.availability;
                DataStore.settings = sanitizeSettings({
                    ...DataStore.settings,
                    ...sanitized.settings
                });
                saveToStorage();
                alert('Data geïmporteerd!');
                location.reload();
            }
        } catch (error) {
            alert('Fout bij importeren: ' + error.message);
        }
    };
    reader.readAsText(file);
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
