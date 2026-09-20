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

        // #268: elke fout werd hier op een verkeerd wachtwoord gegooid. Of de
        // backend nu plat lag, een 500 gaf of de inlogbegrenzing afging, de
        // gebruiker las "Ongeldige gebruikersnaam of wachtwoord". Wie na tien
        // pogingen begrensd is denkt dan dat zijn wachtwoord fout is en blijft
        // proberen, wat de begrenzing alleen maar verlengt.
        const status = error.status;
        const isGedeactiveerd = error.message && error.message.includes('gedeactiveerd');
        // Een technische fout zegt niets over wat je intikte, dus die laat je
        // staan. Alleen bij foute gegevens maken we het formulier leeg.
        let technisch = false;
        let melding;

        if (isGedeactiveerd) {
            melding = 'Je account is gedeactiveerd. Neem contact op met een beheerder.';
        } else if (status === 429) {
            // De servertekst zegt hoe lang je moet wachten; die is bruikbaarder
            // dan wat wij ervan zouden maken.
            melding = error.message || 'Te veel inlogpogingen. Probeer het later opnieuw.';
            technisch = true;
        } else if (status === 0 || status === undefined || status >= 500) {
            melding = 'De server is niet bereikbaar. Probeer het straks opnieuw.';
            technisch = true;
        } else {
            melding = 'Ongeldige gebruikersnaam of wachtwoord';
        }
        showToast(melding, 'error');

        // Clear any existing session to prevent staying logged in with old credentials
        AppState.currentUser = null;
        AppState.authToken = null;
        sessionStorage.removeItem('hetvlot_user');
        sessionStorage.removeItem('hetvlot_token');

        // Ensure login screen is visible
        const bewaardEmail = technisch ? email : '';
        showLogin();
        if (bewaardEmail) {
            DOM.usernameInput.value = bewaardEmail;
            DOM.passwordInput.focus();
        }
    } finally {
        // Clear guard flag
        AppState.isAuthenticating = false;

        submitBtn.disabled = false;
        submitBtn.textContent = 'Inloggen';
    }
}

// #269: bij een 401 riep dataApiFetch dit aan terwijl de dienstmodal nog
// openstond. Die staat buiten #app-container en bleef er dus met z-index 1000
// bovenop hangen, met een knop "Toch opslaan" die niets meer kon doen en een
// loginformulier eronder waar je niet bij kon. Alles wat bovenop de pagina ligt
// gaat nu eerst dicht.
//
// reden mag 'sessie' zijn; dan volgt er een melding waarom je terug op het
// loginscherm staat. Bij een gewone uitlog blijft die uiteraard achterwege.
function handleLogout(reden) {
    AppState.currentUser = null;
    AppState.authToken = null;
    sessionStorage.removeItem('hetvlot_user');
    sessionStorage.removeItem('hetvlot_token');
    // #294: deze twee staan in localStorage, dus zonder dit erven ze over naar
    // de volgende gebruiker op hetzelfde toestel. De toets in showApp vangt een
    // verboden weergave nu wel af, maar iemand hoort ook niet te beginnen op
    // het scherm waar zijn collega gebleven was.
    localStorage.removeItem('hetvlot_activeView');
    localStorage.removeItem('hetvlot_activeDraftId');
    sluitAlleVensters();
    showLogin();
    if (reden === 'sessie') {
        showToast('Je sessie is verlopen. Log opnieuw in.', 'warning');
    }
}

// Sluit elk venster en elke bedekking die over de pagina ligt. De vensters die
// in index.html staan worden verborgen, want de app hergebruikt ze. Alles wat
// door JavaScript is ingevoegd wordt weggehaald, precies zoals de sluitknop van
// die vensters het zelf doet; ze worden bij het volgende gebruik opnieuw
// opgebouwd.
function sluitAlleVensters() {
    const vast = (typeof VASTE_VENSTERS !== 'undefined') ? VASTE_VENSTERS : new Set();
    document.querySelectorAll('.modal').forEach(m => {
        if (vast.has(m)) {
            m.classList.add('hidden');
        } else {
            m.remove();
        }
    });
    document.querySelectorAll('.section-loading-overlay').forEach(o => o.classList.add('hidden'));
    if (typeof FocusTrap !== 'undefined') FocusTrap.deactivate();
    // De opslaanknop van de dienstmodal kan in de stand "Toch opslaan" staan.
    // Die mee terugzetten, anders begint de volgende sessie met een knop die
    // een bevestiging suggereert die niemand gaf.
    if (typeof resetShiftSubmitBtn === 'function') {
        try { resetShiftSubmitBtn(); } catch (e) { /* DOM kan al opgeruimd zijn */ }
    }
    AppState._shiftForceOverride = false;
    AppState._shiftBackendForce = false;
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
    // Sessie blijkt ongeldig/afwezig → de anti-flits-klasse uit index.html
    // moet weg, anders blijft het loginscherm verborgen.
    document.documentElement.classList.remove('session-restoring');
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
    // #294: dezelfde toets als de navigatieknoppen. De vaste lijst hier bevatte
    // 'employees', 'builder' en 'settings', dus een bewaarde weergave van een
    // vorige gebruiker bracht een medewerker in een scherm waarvan de knop
    // verborgen was. De sleutel staat bovendien in localStorage en niet in
    // sessionStorage, dus hij overleeft het uitloggen.
    const savedView = localStorage.getItem('hetvlot_activeView');
    if (savedView && toegelatenWeergaven().has(savedView)) {
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
                // #304: na een herlading stond er wel een concept open maar nam
                // niemand de vergrendeling opnieuw. Meestal staat ze nog op
                // dezelfde gebruiker, maar na de vervaltermijn niet meer, en
                // dan bewerken twee mensen hetzelfde concept zonder dat iemand
                // iets ziet. Niet blokkerend: het scherm staat er al.
                if (DataStore._draftsFromTable && typeof lockScheduleDraft === 'function') {
                    lockScheduleDraft(draft.id, false).then(res => {
                        if (!res.ok && res.status === 423) {
                            showToast(`Dit concept wordt intussen bewerkt door ${res.lockedByName || 'iemand anders'}. Je wijzigingen worden niet bewaard zolang dat zo is.`, 'warning');
                        }
                    }).catch(fout => console.error('Vergrendeling na herladen mislukt:', fout));
                }
                return;
            }
        }
    }
    switchView(AppState.currentView);
}

// #294: de toegelaten weergaven stonden alleen in applyRoleVisibility, die ze
// meteen gebruikte om knoppen te verbergen. showApp las daarna de bewaarde
// weergave uit localStorage en overschreef AppState.currentView zonder opnieuw
// te toetsen, en switchView ving alleen 'settings' af. Op een gedeeld toestel
// kwam een medewerker zo rechtstreeks in de roosterbouwer terecht.
//
// Eén bron voor wie wat mag, zodat de drie plekken niet uiteen kunnen lopen.
function toegelatenWeergaven() {
    const role = getEffectiveRole();
    const toegelaten = new Set(['home', 'planning', 'profile']);

    // All roles get basic views
    toegelaten.add('availability');
    toegelaten.add('swaps');
    toegelaten.add('leave');

    // Employees tab: NOT for medewerker role (they manage their schedule via profile)
    if (role !== 'medewerker') {
        toegelaten.add('employees');
    }

    // Builder en instellingen: roosterverantwoordelijke en admin
    if (['roosterverantwoordelijke', 'admin'].includes(role)) {
        toegelaten.add('builder');
        toegelaten.add('settings');
    }

    return toegelaten;
}

function applyRoleVisibility() {
    const role = getEffectiveRole();
    const isRealAdmin = AppState.currentUser?.role === 'admin';
    const allowedViews = toegelatenWeergaven();

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
