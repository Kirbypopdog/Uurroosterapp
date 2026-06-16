// HET VLOT ROOSTERPLANNING - AUTHENTICATIE EN SESSIE BEHEER

async function syncEmployeeAccountLinks() {
    // No longer needed - users and employees are now merged
    // Keeping function signature for backward compatibility
    return;
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
        const data = await dataApiFetch('/auth/login', {
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
        const isDeactivated = error.message && error.message.includes('gedeactiveerd');
        showToast(
            isDeactivated
                ? 'Je account is gedeactiveerd. Neem contact op met een beheerder.'
                : 'Ongeldige gebruikersnaam of wachtwoord',
            'error'
        );

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
        const data = await dataApiFetch('/me');
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
    if (avatar) avatar.textContent = getInitials(user.name);
    if (menuName) menuName.textContent = user.name;
}

function showApp() {
    DOM.loginContainer.classList.add('hidden');
    DOM.appContainer.classList.remove('hidden');
    IconHelper.init(document.getElementById('current-period'));
    populateUserMenu();
    applyRoleVisibility();
    // Restore saved view from localStorage, or use default
    const savedView = localStorage.getItem('hetvlot_activeView');
    if (savedView && ['home', 'planning', 'employees', 'profile', 'availability', 'builder', 'swaps', 'settings'].includes(savedView)) {
        AppState.currentView = savedView;
    }
    // If builder was active with a loaded draft, restore it (incl. meeting badges)
    if (AppState.currentView === 'builder') {
        const savedDraftId = localStorage.getItem('hetvlot_activeDraftId');
        if (savedDraftId) {
            const drafts = DataStore.settings.schedule_drafts || [];
            const draft = drafts.find(d => String(d.id) === savedDraftId);
            if (draft) {
                doLoadDraft(draft); // restores AppState incl. meetings, calls renderBuilder()
                return;
            }
        }
    }
    switchView(AppState.currentView);
}

function applyRoleVisibility() {
    const role = getEffectiveRole();
    const isRealAdmin = AppState.currentUser?.role === 'admin';
    const allowedViews = new Set(['home', 'planning', 'profile']);

    // Show/hide role switcher for admin (only on localhost/dev)
    const roleSwitcher = document.getElementById('role-switcher');
    if (roleSwitcher) {
        const isDevHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
        if (isRealAdmin && isDevHost) {
            roleSwitcher.classList.remove('hidden');
            const select = document.getElementById('role-switch-select');
            if (select) {
                select.value = AppState.simulatedRole || 'admin';
            }
        } else {
            roleSwitcher.classList.add('hidden');
            AppState.simulatedRole = null; // Clear any simulated role in production
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
        btn.classList.toggle('hidden', !isAllowed);
    });

    // Show/hide the "Beheer" sidebar label based on whether any admin button is visible
    const adminLabel = document.querySelector('.sidebar-nav-label.nav-group-admin');
    if (adminLabel) {
        const adminBtns = document.querySelectorAll('.nav-btn.nav-group-admin');
        const hasVisibleBtn = Array.from(adminBtns).some(b => !b.classList.contains('hidden'));
        adminLabel.classList.toggle('hidden', !hasVisibleBtn);
    }

    if (!allowedViews.has(AppState.currentView)) {
        AppState.currentView = 'home';
    }

    // Team filters: always visible for roles that can see the employee tab
    const employeeFilters = document.getElementById('employee-team-toggles');
    if (employeeFilters) {
        employeeFilters.classList.remove('hidden');
    }

    // Hide "Medewerker toevoegen" button - new employees are created via account management
    // This button is now obsolete after the employees/users merge
    if (DOM.addEmployeeBtn) {
        DOM.addEmployeeBtn.classList.add('hidden');
    }
}
