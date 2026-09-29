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

function getVisibleTeamsForRole() {
    // Iedereen met een login kan alle teams zien in de planner
    return getTeamOrder();
}


// Zodat de pure rolchecks in Node getest kunnen worden. In de browser bestaat
// `module` niet, dus dit heeft daar geen effect.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { canRequestSwap, canCancelSwap, canTargetRespondToSwap };
}
