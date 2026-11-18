// HET VLOT ROOSTERPLANNING - PERMISSIES EN ROL-CHECKS

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

// Mag je een activiteit voor IEMAND ANDERS aanmaken? (#408)
//
// Dit is de frontendkant van de check in POST /shift-activities: daar wordt een
// `medewerker` geweigerd die een andere userId meestuurt. De twee moeten
// dezelfde grens trekken (regel 5 in CLAUDE.md) — staat de check alleen in de
// backend, dan toont het scherm een deelnemerslijst die bij het opslaan
// alsnog een 403 oplevert.
// #418: een algemene activiteit (brandoefening, teamdag) zet iets voor
// IEDEREEN in de planning en in ieders agenda. Dezelfde grens als in
// POST /dag-activiteiten (regel 5): admin en roosterverantwoordelijke.
function canManageDagActiviteiten() {
    return ['admin', 'roosterverantwoordelijke'].includes(getEffectiveRole());
}

function canCreateActivityForOthers() {
    return getEffectiveRole() !== 'medewerker';
}

// ===== SWAP REQUEST PERMISSIONS =====

function canRequestSwap(shift) {
    // Only shift owner can request swap
    const currentUser = AppState.currentUser;
    if (!currentUser || !shift) return false;
    // Id's als tekst vergelijken: ze komen als getal uit de API maar als string
    // uit een formulierveld, en `2 === "2"` is false. Zie CLAUDE.md bij de
    // weekendverantwoordelijke, waar precies dat een bug opleverde.
    if (String(shift.userId) !== String(currentUser.id)) return false;

    // Een dienst die voorbij is, kan niet meer afgestaan worden. De backend
    // weigert dat al (`Shift ligt in het verleden`, swaps.js), maar zonder deze
    // regel bood het scherm de knop gewoon aan: je koos "Dienst afstaan", koos
    // hoe, vulde het venster in, klikte "Verzoek plaatsen" — en pas dán kwam de
    // weigering. Vier stappen tot aan een muur.
    //
    // Dezelfde grens als de backend: die vergelijkt met vandaag om middernacht,
    // dus een dienst van VANDAAG mag nog. En formatDateYYYYMMDD in plaats van
    // toISOString, want die laatste geeft vlak na middernacht nog gisteren
    // (#299) en zou de knop dan een paar uur te lang laten staan.
    if (typeof formatDateYYYYMMDD === 'function' && shift.date) {
        if (shift.date < formatDateYYYYMMDD(new Date())) return false;
    }
    return true;
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

/**
 * Doet deze gebruiker mee aan de verlofrondes?
 *
 * Niet elk team vraagt zijn verlof aan via een ronde: jobstudenten, stagiairs
 * en het kantoor doen dat anders. Welke teams wél, staat in Instellingen >
 * Teams onder "Verlof" (`settings.leaveTeams`). Ontbreekt die instelling, dan
 * doet elk team mee, zoals vroeger.
 *
 * Een adminaccount doet nooit mee (#309). Dezelfde regel staat aan de
 * serverkant als `doetMeeAanVerlof()` in backend/src/helpers/verlofmail.js
 * (regel 5); de test bewaakt dat ze hetzelfde zeggen.
 */
function draaitMeeInVerlof(user, verlofTeams) {
    if (arguments.length < 2) {
        verlofTeams = (typeof DataStore !== 'undefined' && DataStore.settings) ? DataStore.settings.leaveTeams : undefined;
    }
    if (!user || user.role === 'admin' || user.active === false) return false;
    if (!Array.isArray(verlofTeams)) return true;
    return verlofTeams.map(String).includes(String(user.mainTeam ?? user.main_team));
}

function getVisibleTeamsForRole() {
    // Iedereen met een login kan alle teams zien in de planner
    return getTeamOrder();
}


// Zodat de pure rolchecks in Node getest kunnen worden. In de browser bestaat
// `module` niet, dus dit heeft daar geen effect.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { canRequestSwap, canCancelSwap, canTargetRespondToSwap, canCreateActivityForOthers, canManageDagActiviteiten, draaitMeeInVerlof };
}
