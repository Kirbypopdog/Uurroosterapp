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
