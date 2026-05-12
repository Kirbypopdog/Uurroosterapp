// HET VLOT ROOSTERPLANNING - ROOSTERBOUWER

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
        <span id="builder-autosave-status" class="builder-autosave-status">${AppState.builderAutoSavedAt ? `Automatisch opgeslagen om ${AppState.builderAutoSavedAt}` : ''}</span>
    </div>`;

    html += renderBuilderControls(role, userTeam);
    html += renderBuilderGrid(role, userTeam);
    html += renderBuilderActions();

    container.innerHTML = html;
    IconHelper.init(container);
    attachBuilderEventListeners(container);
}