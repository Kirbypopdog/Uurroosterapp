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
