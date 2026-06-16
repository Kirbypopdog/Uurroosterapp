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

    const teamDotColor = draft.teamFilter
        ? (DataStore.settings.teams?.[draft.teamFilter]?.color || '#8d897c')
        : 'var(--ink-3)';

    return `
        <div class="builder-concept-card draft-status-${statusCls}" data-draft-id="${escapeHtml(draft.id)}">
            <div class="concept-card-header">
                <span class="concept-card-name-row">
                    <span class="concept-card-dot" style="background:${teamDotColor}" title="${escapeHtml(teamLabel)}"></span>
                    <span class="concept-card-name">${escapeHtml(draft.name)}</span>
                </span>
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

// Returns the Monday Date of week N in a vakantie concept (based on holiday period startDate)
function getBuilderVakantieWeekStart(weekNumber) {
    const hp = (DataStore.settings.holidayPeriods || []).find(p => String(p.id) === String(AppState.builderHolidayPeriodId));
    if (!hp) return null;
    const start = parseDateOnly(hp.startDate);
    const dow = start.getDay(); // 0=Sun
    const daysToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(start);
    monday.setDate(start.getDate() + daysToMonday + (weekNumber - 1) * 7);
    return monday;
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
                            let weekBtnLabel;
                            if (isVakantie) {
                                const ws = getBuilderVakantieWeekStart(w);
                                if (ws) {
                                    const we = new Date(ws);
                                    we.setDate(ws.getDate() + 6);
                                    const fmtS = ws.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
                                    const fmtE = we.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
                                    weekBtnLabel = `${fmtS} – ${fmtE}`;
                                } else {
                                    weekBtnLabel = getBuilderWeekLabel(w);
                                }
                            } else {
                                weekBtnLabel = getBuilderWeekLabel(w);
                            }
                            btns += `<button class="btn ${wn === w ? 'btn-primary' : 'btn-secondary'} btn-sm builder-week-btn" id="builder-week-${w}">
                                Week ${w} (${escapeHtml(weekBtnLabel)})
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
                    ${getBuilderCycleLength() > 1 ? `<button class="btn btn-secondary btn-sm" id="builder-copy-week"><i data-lucide="copy" class="lucide-xs"></i> Kopieer week</button>` : ''}
                    ${AppState.builderConceptType === 'vakantie' ? `<button class="btn btn-sm ${AppState.builderHideOnLeave ? 'btn-primary' : 'btn-secondary'} builder-hide-leave-toggle" id="builder-hide-leave-toggle"><i data-lucide="${AppState.builderHideOnLeave ? 'eye-off' : 'eye'}" class="lucide-xs"></i> ${AppState.builderHideOnLeave ? 'Verlof verborgen' : 'Verberg verlof'}</button>` : ''}
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

    // Filter medewerkers met verlof in de huidige vakantieweek
    let hiddenOnLeaveCount = 0;
    if (AppState.builderConceptType === 'vakantie' && AppState.builderHideOnLeave) {
        const weekStart = getBuilderVakantieWeekStart(AppState.builderWeekNumber);
        if (weekStart) {
            const weekDates = Array.from({ length: 7 }, (_, i) => {
                const d = new Date(weekStart);
                d.setDate(d.getDate() + i);
                return d.toISOString().slice(0, 10);
            });
            employees = employees.filter(emp => {
                const hasLeave = weekDates.some(dateStr => {
                    const avail = getAvailability(emp.id, dateStr);
                    return avail && avail.type === 'verlof';
                });
                if (hasLeave) hiddenOnLeaveCount++;
                return !hasLeave;
            });
        }
    }

    if (employees.length === 0 && hiddenOnLeaveCount === 0) {
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

    // Bereken weekdatums voor vakantie builder
    const isVakantie = AppState.builderConceptType === 'vakantie';
    const vakantieWeekStart = isVakantie ? getBuilderVakantieWeekStart(AppState.builderWeekNumber) : null;

    // Header
    html += '<div class="builder-grid-header">';
    html += `<div class="builder-name-header">Medewerker${hiddenOnLeaveCount > 0 ? `<span class="builder-leave-hidden-badge" title="${hiddenOnLeaveCount} medewerker(s) verborgen wegens verlof">${hiddenOnLeaveCount} verlof</span>` : ''}</div>`;
    dayNames.forEach((name, i) => {
        let headerClass = 'builder-day-header builder-day-toggle';
        const jsDow = dayIndexToJsDow(i);
        const isWeekend = i >= 5;
        const isClosed = builderClosedDays.includes(jsDow);
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        const label = isClosed ? `${name}` : name;
        const lockIcon = isClosed ? ` <span class="day-lock-icon">${IconHelper.html(ICONS.lock, 'xs')}</span>` : '';
        let dateLabel = '';
        if (vakantieWeekStart) {
            const d = new Date(vakantieWeekStart);
            d.setDate(d.getDate() + i);
            dateLabel = `<span class="builder-day-date">${d.getDate()} ${d.toLocaleDateString('nl-BE', { month: 'short' })}</span>`;
        }
        html += `<div class="${headerClass}" data-jsdow="${jsDow}" title="Klik om ${isClosed ? 'te openen' : 'te sluiten'}"><span class="day-name">${label}${lockIcon}</span>${dateLabel}</div>`;
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

    // 11-hour rule warnings across consecutive days (boven heatmap zodat direct zichtbaar)
    html += renderBuilderWarnings(employees);

    // Staffing heatmap (per-hour bezetting)
    html += renderBuilderStaffingHeatmap();

    // Bezettingsregels editor (inklapbaar)
    html += renderBuilderStaffingEditor();

    // Teamvergaderingen editor (inklapbaar)
    html += renderBuilderMeetingsEditor();

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

    const _empColor = DataStore.settings.teams?.[employee.mainTeam]?.color || '#8d897c';
    const _empInitials = escapeHtml(getInitials(employee.name || ''));
    html += `<div class="builder-name-cell">
        <span class="emp-avatar" style="background:${_empColor}">${_empInitials}</span>
        <div class="builder-name-cell-text">
            <span class="emp-name">${escapeHtml(employee.name)}</span>
            <span class="emp-contract">${contractHours}u/week</span>
        </div>
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

        // Toon staart van nachtdienst van vorige week's zondag in maandag-cel
        if (dayIndex === 0) {
            const cycleLength = getBuilderCycleLength();
            const prevWeekNum = AppState.builderWeekNumber > 1 ? AppState.builderWeekNumber - 1 : cycleLength;
            const prevWeekGrid = prevWeekNum === AppState.builderWeekNumber
                ? AppState.builderGrid
                : (AppState.builderGridByWeek[prevWeekNum] || {});
            const prevSunday = (prevWeekGrid[employee.id] || {})[6];
            if (prevSunday) {
                const prevPos = calcTimePosition(prevSunday.startTime, prevSunday.endTime);
                if (prevPos.isOvernight && prevPos.overnightDay2Pct > 0) {
                    const tc = prevSunday.team ? `team-${prevSunday.team}` : '';
                    html += `<div class="builder-timeline-block ${tc} nacht"
                        style="left:0%;width:${prevPos.overnightDay2Pct.toFixed(1)}%;opacity:0.6"
                        data-start="${prevSunday.startTime}" data-end="${prevSunday.endTime}">
                        <span class="btb-time">&hellip;${prevSunday.endTime}</span>
                    </div>`;
                }
            }
        }

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

            const reserveClass = assignment.isReserve ? ' shift-reserve' : '';
            const reserveBadge = assignment.isReserve ? '<span class="reserve-badge">R</span>' : '';
            html += `<div class="builder-timeline-block ${teamColor}${pos.isOvernight ? ' nacht' : ''}${reserveClass}"
                style="left:${pos.leftPct.toFixed(1)}%;width:${widthStyle}"
                data-start="${assignment.startTime}" data-end="${assignment.endTime}">
                ${reserveBadge}<span class="btb-label">${escapeHtml(templateName)}</span>
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
            <div class="builder-drafts-header">
                <h3>Opgeslagen concepten</h3>
                ${drafts.length >= 2 ? '<button class="btn btn-sm btn-secondary" id="builder-compare-btn">Vergelijk concepten</button>' : ''}
            </div>
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

    // Pre-select reserve checkbox
    const reserveCheckbox = document.getElementById('builder-shift-is-reserve');
    if (reserveCheckbox) reserveCheckbox.checked = !!(current?.isReserve);

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
        const isReserveChecked = document.getElementById('builder-shift-is-reserve')?.checked || false;
        AppState.builderGrid[employeeId][dayIndex] = {
            startTime: start,
            endTime: end,
            team: employee.mainTeam || AppState.builderTeamFilter || null,
            isReserve: isReserveChecked
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

function builderGridHasData() {
    const allWeeks = { ...AppState.builderGridByWeek, [AppState.builderWeekNumber]: AppState.builderGrid };
    return Object.values(allWeeks).some(weekGrid =>
        Object.values(weekGrid || {}).some(dayMap => Object.keys(dayMap || {}).length > 0)
    );
}

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

    // Verlof verbergen toggle (alleen vakantie builder)
    const hideLeaveToggle = document.getElementById('builder-hide-leave-toggle');
    if (hideLeaveToggle) {
        hideLeaveToggle.addEventListener('click', () => {
            AppState.builderHideOnLeave = !AppState.builderHideOnLeave;
            renderBuilder();
        });
    }

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
    if (loadBase) loadBase.addEventListener('click', () => {
        if (builderGridHasData()) {
            showConfirm('Het huidige rooster wordt overschreven met het basisrooster. Ben je zeker?', 'Basisrooster laden', {
                confirmText: 'Ja, laden'
            }).then(ok => { if (ok) loadBuilderFromBaseSchedules(); });
        } else {
            loadBuilderFromBaseSchedules();
        }
    });

    const copyWeekBtn = document.getElementById('builder-copy-week');
    if (copyWeekBtn) copyWeekBtn.addEventListener('click', openCopyWeekModal);

    const loadBlank = document.getElementById('builder-load-blank');
    if (loadBlank) loadBlank.addEventListener('click', () => {
        const doReset = () => {
            AppState.builderGrid = {};
            AppState.builderGridByWeek = {};
            AppState.builderStaffingRules = {};
            AppState.builderStaffingRulesByWeek = {};
            AppState.builderMeetings = {};
            AppState.builderLoadedDraftId = null;
            AppState.builderLoadedDraftName = null;
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
        };
        if (builderGridHasData()) {
            showConfirm('Alle shifts in het huidige rooster worden gewist. Ben je zeker?', 'Leeg beginnen', {
                confirmText: 'Ja, leegmaken',
                danger: true
            }).then(ok => { if (ok) doReset(); });
        } else {
            doReset();
        }
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

    const compareBtn = container.querySelector('#builder-compare-btn');
    if (compareBtn) compareBtn.addEventListener('click', openDraftDiffModal);
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
