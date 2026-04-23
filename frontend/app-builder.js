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
        cardsHtml = '<div class="builder-no-results"><i data-lucide="search-x" class="empty-state-icon"></i><p>Geen concepten gevonden met dit filter.</p></div>';
    } else if (filtered.length === 0 && otherDrafts.length === 0 && activeDrafts.length === 0) {
        cardsHtml = '<div class="builder-no-results"><i data-lucide="file-plus" class="empty-state-icon"></i><p>Nog geen concepten. Maak een nieuw concept aan.</p></div>';
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
    setBuilderDirty();
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
    setBuilderDirty();
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
    setBuilderDirty();
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
        employees = getEmployeesByTeam(AppState.builderTeamFilter);
    } else {
        employees = getAllEmployees(true);
    }
    employees = employees.sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));

    if (employees.length === 0) {
        return '<div class="builder-empty"><i data-lucide="users" class="empty-state-icon"></i>Geen medewerkers gevonden voor het geselecteerde team</div>';
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
            <div class="builder-vakantie-bar-inner">
                <div>
                    <strong>Vakantieconcept voor ${hpName}</strong>${hpDates ? ` <span>(${hpDates})</span>` : ''}
                    <div class="builder-vakantie-note">Medewerkers die niet in dit rooster staan krijgen geen shift tijdens deze vakantie.</div>
                </div>
                <div class="builder-vakantie-responsible">
                    <label class="builder-vakantie-label">Verantw. week ${wn}:</label>
                    <select class="form-input form-input-sm builder-vakantie-select" id="builder-vakantie-responsible" data-week="${wn}">
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

// Get meetings for an employee on a specific day
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
        <span class="planned-hours">${+totalHours.toFixed(2)}</span>
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
        <button class="btn btn-secondary btn-sm builder-section-toggle" id="builder-staffing-toggle">
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
        <button class="btn btn-secondary btn-sm builder-section-toggle builder-meetings-toggle-btn" id="builder-meetings-toggle">
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

function isDraftLockActive(lockedAt) {
    if (!lockedAt) return false;
    return (Date.now() - new Date(lockedAt).getTime()) < 30 * 60 * 1000;
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
                        <div class="builder-draft-card${status?.cls === 'active' ? ' draft-active' : status?.cls === 'activatable' ? ' draft-activatable' : ''}${isDraftLockActive(draft.lockedAt) && draft.lockedBy !== AppState.currentUser?.id ? ' draft-locked' : ''}" data-draft-id="${escapeHtml(draft.id)}">
                            <div class="builder-draft-info">
                                <strong>${escapeHtml(draft.name)}</strong>
                                ${status ? `<span class="builder-draft-badge draft-badge-${status.cls}">${status.label}</span>` : ''}
                                ${isDraftLockActive(draft.lockedAt) && draft.lockedBy !== AppState.currentUser?.id ? `<span class="builder-draft-badge draft-badge-locked"><i data-lucide="lock" class="lucide-xs"></i> In bewerking door ${escapeHtml(draft.lockedByName || 'iemand')}</span>` : ''}
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

    customTimes.classList.add('hidden');
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
            customTimes.classList.remove('hidden');
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
                customTimes.classList.remove('hidden');
            } else {
                customTimes.classList.add('hidden');
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
        setBuilderDirty();
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
        setBuilderDirty();
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
        employees = getEmployeesByTeam(AppState.builderTeamFilter);
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
    setBuilderDirty();
    renderBuilder();
    showToast(`Basisrooster week ${weekNumber} geladen`, 'success');
}

// --- Builder: Auto-save ---

function setBuilderDirty() {
    AppState.builderIsDirty = true;
    scheduleBuilderAutoSave();
}

function scheduleBuilderAutoSave() {
    if (!AppState.builderLoadedDraftId) return;
    if (AppState.builderAutoSaveTimer) clearTimeout(AppState.builderAutoSaveTimer);
    AppState.builderAutoSaveTimer = setTimeout(() => autoSaveBuilderDraft(), 3000);
}

function startBuilderAutoSave() {
    AppState.builderAutoSavedAt = null;
}

function stopBuilderAutoSave() {
    if (AppState.builderAutoSaveTimer) {
        clearTimeout(AppState.builderAutoSaveTimer);
        AppState.builderAutoSaveTimer = null;
    }
}

async function autoSaveBuilderDraft() {
    AppState.builderAutoSaveTimer = null;
    if (!AppState.builderIsDirty || !AppState.builderLoadedDraftId) return;

    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));
    const multiGrid = { _multiWeek: true };
    for (const [weekNum, weekGrid] of Object.entries(AppState.builderGridByWeek)) {
        if (Object.keys(weekGrid).length > 0 && Object.values(weekGrid).some(d => Object.keys(d).length > 0)) {
            multiGrid[weekNum] = weekGrid;
        }
    }

    const updateData = {
        grid: JSON.parse(JSON.stringify(multiGrid)),
        weekNumber: AppState.builderWeekNumber,
        teamFilter: AppState.builderTeamFilter,
        type: AppState.builderConceptType || 'basis',
        holidayPeriodId: AppState.builderHolidayPeriodId || null
    };
    if (AppState.builderPattern) updateData.grid._pattern = AppState.builderPattern;
    AppState.builderStaffingRulesByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderStaffingRules));
    if (Object.keys(AppState.builderStaffingRulesByWeek).length > 0) {
        updateData.grid._staffingRules = AppState.builderStaffingRulesByWeek;
    }
    updateData.grid._teamMeetings = AppState.builderMeetings || {};

    try {
        await updateScheduleDraft(AppState.builderLoadedDraftId, updateData);
        const cached = (DataStore.settings.schedule_drafts || []).find(d => d.id === AppState.builderLoadedDraftId);
        if (cached) {
            cached.grid = updateData.grid;
            cached.weekNumber = AppState.builderWeekNumber;
            cached.updatedAt = new Date().toISOString();
        }
        AppState.builderIsDirty = false;
        const now = new Date();
        AppState.builderAutoSavedAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const statusEl = document.getElementById('builder-autosave-status');
        if (statusEl) statusEl.textContent = `Automatisch opgeslagen om ${AppState.builderAutoSavedAt}`;
    } catch (err) {
        console.error('Auto-save failed:', err);
    }
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
            updateData.grid._teamMeetings = AppState.builderMeetings || {};
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
            await unlockScheduleDraft(AppState.builderLoadedDraftId);
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
    draftGrid._teamMeetings = AppState.builderMeetings || {};
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
    draftGrid._teamMeetings = AppState.builderMeetings || {};
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
            <div class="modal-body modal-body-padded">
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
                        <div class="concept-type-icon concept-type-icon--holiday">${IconHelper.html(ICONS.holiday || ICONS.calendar, 'md')}</div>
                        <div class="concept-type-info">
                            <strong>Vakantieconcept</strong>
                            <span>Een apart rooster voor een vakantieperiode</span>
                        </div>
                    </label>
                </div>
                <div class="mt-md">
                    <label class="form-label" for="concept-name-input">Naam:</label>
                    <input id="concept-name-input" type="text" class="form-input" placeholder="Basisrooster" value="Basisrooster">
                </div>
                <div id="vakantie-period-select" class="hidden mt-md">
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
            const isVakantie = opt.dataset.value === 'vakantie';
            periodSelect.style.display = isVakantie ? 'block' : 'none';
            const nameInput = overlay.querySelector('#concept-name-input');
            if (!isVakantie) nameInput.value = 'Basisrooster';
        });
    });

    // Auto-fill name when a vakantie period is selected
    overlay.querySelector('#vakantie-period-id')?.addEventListener('change', (e) => {
        const period = availablePeriods.find(p => String(p.id) === e.target.value);
        if (period) overlay.querySelector('#concept-name-input').value = period.name;
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#concept-type-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#concept-type-confirm').addEventListener('click', async () => {
        const type = overlay.querySelector('input[name="concept-type"]:checked')?.value || 'basis';
        let holidayPeriodId = null;

        if (type === 'vakantie') {
            const selectEl = overlay.querySelector('#vakantie-period-id');
            if (!selectEl || !selectEl.value) {
                showToast('Selecteer een vakantieperiode', 'warning');
                return;
            }
            holidayPeriodId = selectEl.value;
        }

        const nameInputEl = overlay.querySelector('#concept-name-input');
        const conceptName = (nameInputEl?.value || '').trim() || (type === 'vakantie' ? 'Vakantieconcept' : 'Basisrooster');

        overlay.remove();

        // Initialize new concept in AppState
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

        // Immediately save new empty concept to DB so auto-save has a valid ID
        const newDraftId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const draftData = {
            id: newDraftId,
            name: conceptName,
            teamFilter: AppState.builderTeamFilter,
            weekNumber: 1,
            grid: { _multiWeek: true, _pattern: AppState.builderPattern },
            validFrom: null,
            validUntil: null,
            type,
            holidayPeriodId: holidayPeriodId || null
        };
        try {
            if (DataStore._draftsFromTable) {
                const apiResult = await createScheduleDraft(draftData);
                const savedDraft = apiResult.draft;
                if (!DataStore.settings.schedule_drafts) DataStore.settings.schedule_drafts = [];
                DataStore.settings.schedule_drafts.push(savedDraft);
                AppState.builderLoadedDraftId = savedDraft.id;
                AppState.builderLoadedDraftName = savedDraft.name;
            } else {
                draftData.createdBy = AppState.currentUser?.id;
                draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
                draftData.createdAt = new Date().toISOString();
                draftData.updatedAt = new Date().toISOString();
                const drafts = [...(DataStore.settings.schedule_drafts || []), draftData];
                await saveSettings('schedule_drafts', drafts);
                DataStore.settings.schedule_drafts = drafts;
                AppState.builderLoadedDraftId = newDraftId;
                AppState.builderLoadedDraftName = conceptName;
            }
        } catch (err) {
            console.error('Error creating draft:', err);
            showToast('Fout bij aanmaken concept', 'error');
            return;
        }

        AppState.builderScreen = 'editor';
        startBuilderAutoSave();
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

async function loadBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

    // Try to acquire lock
    const lockResult = await lockScheduleDraft(draftId, false);
    if (!lockResult.ok && lockResult.status === 423) {
        const force = await showConfirm(
            `Dit concept wordt momenteel bewerkt door ${escapeHtml(lockResult.lockedByName || 'iemand anders')}. Wil je het toch openen? De andere bewerker verliest dan zijn vergrendeling.`,
            'Concept in gebruik'
        );
        if (!force) return;
        await lockScheduleDraft(draftId, true);
    }

    if (AppState.builderIsDirty) {
        const confirmed = await showConfirm('Je hebt onopgeslagen wijzigingen. Wil je doorgaan?');
        if (!confirmed) {
            await unlockScheduleDraft(draftId);
            return;
        }
    }
    doLoadDraft(draft);
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
    localStorage.setItem('hetvlot_activeDraftId', String(draft.id));
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
                    <p class="mb-sm"><strong>${escapeHtml(draft.name)}</strong> deactiveren?</p>
                    <div class="form-group">
                        <label>Einddatum (shifts na deze datum worden verwijderd)</label>
                        <input type="date" id="deactivate-end-date" class="form-input" value="${todayStr}">
                    </div>
                    <label class="checkbox-label-row">
                        <input type="checkbox" id="deactivate-delete-manual">
                        Verwijder ook handmatig aangemaakte shifts
                    </label>
                    <span class="form-hint form-hint-block mt-sm">Auto-gegenereerde shifts na de einddatum worden altijd verwijderd.</span>
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
        ? getEmployeesByTeam(draft.teamFilter)
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
                    <p class="mb-sm"><strong>${escapeHtml(draft.name)}</strong> toepassen als basisrooster ${weekLabel}?</p>
                    <div class="apply-presets">
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="${presetSchoolStart}" data-end="${presetSchoolEnd}">Dit schooljaar (sep – aug)</button>
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="${presetTodayStr}" data-end="${presetSchoolEnd}">Vanaf nu tot aug</button>
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="" data-end="">Aangepaste periode</button>
                    </div>
                    <div class="form-row form-row-gap">
                        <div class="form-group flex-1">
                            <label>Van</label>
                            <input type="date" id="draft-apply-start-date" class="form-input" value="${defaultStart}" required>
                        </div>
                        <div class="form-group flex-1">
                            <label>Tot</label>
                            <input type="date" id="draft-apply-end-date" class="form-input" value="${defaultEnd}" required>
                        </div>
                    </div>
                    <span class="form-hint form-hint-block mt-xs">Shifts worden alleen gegenereerd binnen deze periode. Bestaande shifts buiten deze periode blijven ongewijzigd.</span>
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
                    <p class="mb-xs">Het concept <strong>"${escapeHtml(draftName)}"</strong> is momenteel actief.</p>
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
                stopBuilderAutoSave();
            }
            await unlockScheduleDraft(AppState.builderLoadedDraftId);
            AppState.builderLoadedDraftId = null;
            AppState.builderLoadedDraftName = null;
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
            setBuilderDirty();
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
            setBuilderDirty();
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
            setBuilderDirty();
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
            setBuilderDirty();
            showToast(`Bezettingsregels gekopieerd naar alle ${cl} weken`, 'success');
        });
    }

    // Staffing editor: clear all
    const clearAllBtn = document.getElementById('staffing-clear-all');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            AppState.builderStaffingRules = {};
            setBuilderDirty();
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
            setBuilderDirty();
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
                setBuilderDirty();
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
            setBuilderDirty();
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

