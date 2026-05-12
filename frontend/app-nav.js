// HET VLOT ROOSTERPLANNING - NAVIGATIE, HOME DASHBOARD EN DATUMNAVIGATIE


function renderTeamToggles() {
    const container = document.getElementById('team-toggles');
    if (!container) return;
    const teams = DataStore.settings.teams || {};
    container.innerHTML = '';
    getTeamOrder().forEach(teamId => {
        const team = teams[teamId];
        const isActive = AppState.visibleTeams.includes(teamId);
        const btn = document.createElement('button');
        btn.className = `team-toggle ${isActive ? 'active' : ''}`;
        btn.dataset.team = teamId;
        btn.textContent = team?.name || teamId;
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            if (btn.classList.contains('active')) {
                if (!AppState.visibleTeams.includes(teamId)) AppState.visibleTeams.push(teamId);
            } else {
                AppState.visibleTeams = AppState.visibleTeams.filter(t => t !== teamId);
            }
            renderCalendar();
        });
        container.appendChild(btn);
    });
}

function renderEmployeeTeamToggles() {
    const container = document.getElementById('employee-team-toggles');
    if (!container) return;
    const teams = DataStore.settings.teams || {};
    container.innerHTML = '';
    getTeamOrder().forEach(teamId => {
        const team = teams[teamId];
        const isActive = AppState.visibleEmployeeTeams.includes(teamId);
        const btn = document.createElement('button');
        btn.className = `team-toggle ${isActive ? 'active' : ''}`;
        btn.dataset.team = teamId;
        btn.textContent = team?.name || teamId;
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            if (btn.classList.contains('active')) {
                if (!AppState.visibleEmployeeTeams.includes(teamId)) AppState.visibleEmployeeTeams.push(teamId);
            } else {
                AppState.visibleEmployeeTeams = AppState.visibleEmployeeTeams.filter(t => t !== teamId);
            }
            renderEmployees();
        });
        container.appendChild(btn);
    });
}




function updateShiftRefreshRange() {
    if (!AppState.currentWeekStart) return;
    // Start: 2 weeks before current view
    const start = new Date(AppState.currentWeekStart);
    start.setDate(start.getDate() - 14);
    // End: end of current school year (default: 31 aug) + 2 weeks buffer
    const now = new Date();
    const syStart = getSchoolYearStart();
    let schoolYearStartMonth = 8; // 0-based September
    if (syStart) {
        const syDate = parseDateOnly(syStart);
        if (syDate) schoolYearStartMonth = syDate.getMonth();
    }
    const schoolYearEndMonth = schoolYearStartMonth === 0 ? 11 : schoolYearStartMonth - 1;
    let schoolYearEndYear = now.getFullYear();
    const testEnd = new Date(schoolYearEndYear, schoolYearEndMonth + 1, 0); // last day of end month
    if (testEnd <= now) schoolYearEndYear++;
    const schoolYearEnd = new Date(schoolYearEndYear, schoolYearEndMonth + 1, 0); // last day of end month
    // Use whichever is further: current view + 2 weeks or school year end + 2 weeks
    const viewEnd = new Date(AppState.currentWeekStart);
    viewEnd.setDate(viewEnd.getDate() + 21); // current week + 2 weeks buffer
    const end = new Date(Math.max(schoolYearEnd.getTime(), viewEnd.getTime()));
    end.setDate(end.getDate() + 14); // extra buffer
    const startStr = formatDateYYYYMMDD(start);
    const endStr   = formatDateYYYYMMDD(end);
    setActiveShiftRange(startStr, endStr);

    // Laad shifts bij als de huidige week niet in de geladen data zit
    if (typeof DataStore !== 'undefined' && typeof refreshShifts === 'function') {
        const weekStart = formatDateYYYYMMDD(AppState.currentWeekStart);
        const weekEnd   = new Date(AppState.currentWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const weekEndStr = formatDateYYYYMMDD(weekEnd);
        const hasData = DataStore.shifts && DataStore.shifts.some(s => s.date >= weekStart && s.date <= weekEndStr);
        if (!hasData) {
            refreshShifts({ startDate: startStr, endDate: endStr, merge: true })
                .then(() => { if (AppState.currentView === 'planning') renderPlanning(); })
                .catch(() => {});
        }
    }
}



// ===== HOME DASHBOARD =====

function renderHome() {
    const container = document.getElementById('home-content');
    if (!container) return;

    const user = AppState.currentUser;
    if (!user) return;

    const role = getEffectiveRole();

    let html = '';
    html += renderHomeWelcome(user, role);
    if (role === 'admin') html += renderHomeOnboarding();
    html += renderHomeAlerts(role);
    html += '<div class="home-grid">';
    html += renderHomeShifts(user);
    html += renderHomeWeekendInfo();
    html += renderHomeRequests(user, role);
    html += '</div>';

    container.innerHTML = html;
    IconHelper.init(container);

    // Attach quick action click handlers
    container.querySelectorAll('.home-action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'add-shift') {
                switchView('planning');
                setTimeout(() => { if (typeof openAddShiftModal === 'function') openAddShiftModal(); }, 100);
            } else if (action === 'request-absence') {
                switchView('availability');
            } else if (action === 'request-swap') {
                switchView('swaps');
            } else if (action === 'view-planning') {
                switchView('planning');
            }
        });
    });

    // Attach request click handlers
    container.querySelectorAll('.home-request-item[data-action="view-swaps"]').forEach(item => {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => switchView('swaps'));
    });
}

function getOnboardingStatus() {
    const teams = DataStore.settings.teams || {};
    const templates = DataStore.settings.shiftTemplates || {};
    const users = DataStore.users || [];
    const holidays = DataStore.settings.holidayPeriods || [];
    const rules = DataStore.settings.rules || {};

    const minHours = rules.minHoursBetweenShifts ?? 11;
    const maxDays = rules.maxConsecutiveDays ?? 6;

    return [
        { id: 'teams', label: 'Teams aanmaken', done: Object.keys(teams).length > 0, view: 'settings', tab: 'teams' },
        { id: 'templates', label: 'Dienst templates instellen', done: Object.keys(templates).length > 0, view: 'settings', tab: 'teams' },
        { id: 'users', label: 'Medewerkers toevoegen', done: users.filter(u => u.role === 'medewerker').length > 0, view: 'settings', tab: 'accounts' },
        { id: 'rules', label: 'Planningsregels controleren', done: AppState.currentUser?.onboardingFlags?.planning_visited === true, view: 'settings', tab: 'planning',
          hint: `Stel de minimale rustperiode tussen diensten en het maximaal aantal opeenvolgende werkdagen in. Dit beschermt het welzijn van medewerkers en voldoet aan wettelijke vereisten. Huidig: ${minHours}u rust, max ${maxDays} dagen.` },
        { id: 'holidays', label: 'Vakantieperiodes invoeren', done: holidays.length > 0, view: 'settings', tab: 'planning' },
        { id: 'schedule', label: 'Basisrooster maken', done: DataStore.shifts.length > 0, view: 'builder' },
        { id: 'email', label: 'Email notificaties configureren', done: DataStore.settings.emailNotifications?.globalEnabled === true, view: 'settings', tab: 'communicatie' }
    ];
}

function renderHomeAlerts(role) {
    if (!['admin', 'roosterverantwoordelijke'].includes(role)) return '';

    const warnings = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayLabelsNL = ['Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag'];
    const maxConsecutive = DataStore.settings?.rules?.maxConsecutiveDays ?? 6;
    const teams = DataStore.settings?.teams || {};

    // 1. Onderbezetting komende 7 dagen per team
    const coverageTeams = DataStore.settings?.coverageTeams || [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const dateStr = formatDateYYYYMMDD(d);
        const dayLabel = dayLabelsNL[d.getDay()];

        if (isDayClosed(dateStr)) continue;

        for (const [teamId, team] of Object.entries(teams)) {
            if (coverageTeams.length > 0 && !coverageTeams.includes(teamId)) continue;
            const teamEmps = (DataStore.users || []).filter(u =>
                u.active !== false && u.role === 'medewerker' &&
                (u.mainTeam === teamId || u.team_id === teamId || u.main_team === teamId)
            );
            if (teamEmps.length === 0) continue;
            const teamShifts = DataStore.shifts.filter(s =>
                s.team === teamId && (s.date || '').split('T')[0] === dateStr
            );
            if (teamShifts.length === 0) {
                warnings.push({ level: 'warning', text: `${dayLabel} ${formatDateShort(d)}: ${escapeHtml(team.name)} heeft geen diensten ingepland` });
            }
        }
    }

    // 2. Medewerkers die max opeenvolgende dagen naderen (>= maxConsecutive - 1)
    const activeEmployees = (DataStore.users || []).filter(u => u.active !== false && u.role === 'medewerker');
    for (const emp of activeEmployees) {
        // Check a 21-day window centred on today
        const windowStart = new Date(today);
        windowStart.setDate(today.getDate() - 7);
        const windowEnd = new Date(today);
        windowEnd.setDate(today.getDate() + 13);
        const startStr = formatDateYYYYMMDD(windowStart);
        const endStr = formatDateYYYYMMDD(windowEnd);

        const empShiftDates = new Set(
            DataStore.shifts
                .filter(s => Number(s.employeeId || s.userId) === emp.id &&
                    (s.date || '').split('T')[0] >= startStr &&
                    (s.date || '').split('T')[0] <= endStr)
                .map(s => (s.date || '').split('T')[0])
        );

        // Find longest consecutive run touching today or future
        let run = 0;
        let maxRun = 0;
        for (let i = -7; i <= 13; i++) {
            const d = new Date(today);
            d.setDate(today.getDate() + i);
            if (empShiftDates.has(formatDateYYYYMMDD(d))) {
                run++;
                maxRun = Math.max(maxRun, run);
            } else {
                run = 0;
            }
        }
        if (maxRun >= maxConsecutive) {
            warnings.push({ level: 'warning', text: `${escapeHtml(emp.name)} werkt ${maxRun} dagen op rij (maximum: ${maxConsecutive})` });
        }
    }

    // 3. Ruilverzoeken ouder dan 48u zonder reactie
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const oldPending = (DataStore.swapRequests || []).filter(r =>
        r.status === 'pending' && new Date(r.createdAt || r.created_at) < cutoff48h
    );
    if (oldPending.length > 0) {
        warnings.push({ level: 'info', text: `${oldPending.length} ruilverzoek${oldPending.length !== 1 ? 'en' : ''} wacht${oldPending.length === 1 ? '' : 'en'} al meer dan 48u op goedkeuring` });
    }

    if (warnings.length === 0) return '';

    const items = warnings.map(w => `
        <div class="alert-item alert-item--${w.level}">
            <i data-lucide="${w.level === 'info' ? 'info' : 'alert-triangle'}" class="lucide-xs"></i>
            <span>${w.text}</span>
        </div>`).join('');

    return `
        <div class="home-alerts home-alerts--collapsed mb-md">
            <button class="home-alerts-header" onclick="this.closest('.home-alerts').classList.toggle('home-alerts--collapsed')" aria-expanded="false">
                <i data-lucide="bell" class="lucide-sm"></i>
                <strong>Attentiepunten</strong>
                <span class="home-alerts-count">${warnings.length}</span>
                <i data-lucide="chevron-down" class="lucide-sm home-alerts-chevron"></i>
            </button>
            <div class="home-alerts-body">${items}</div>
        </div>`;
}

function formatDateShort(date) {
    return date.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
}

function renderHomeOnboarding() {
    if (AppState.currentUser?.onboardingFlags?.checklist_dismissed) return '';

    const steps = getOnboardingStatus();
    const doneCount = steps.filter(s => s.done).length;
    if (doneCount === steps.length) return ''; // All done

    const pct = Math.round((doneCount / steps.length) * 100);

    return `
    <div class="home-card onboarding-checklist mb-md">
        <div class="onboarding-header">
            <h3 class="onboarding-title">App instellen</h3>
            <button class="btn btn-sm btn-ghost onboarding-dismiss" onclick="dismissOnboardingChecklist(this)" title="Verbergen">✕</button>
        </div>
        <div class="onboarding-progress">
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="text-xs text-muted text-nowrap">${doneCount}/${steps.length}</span>
        </div>
        <ul class="onboarding-steps">
            ${steps.map(s => `<li class="${s.done ? 'done' : ''}">
                <span class="step-check">${s.done ? '✓' : '○'}</span>
                <a href="#" onclick="event.preventDefault();${s.tab ? `AppState.settingsActiveTab='${s.tab}';` : ''}switchView('${s.view}');">${s.label}</a>
                ${s.hint ? `<p class="onboarding-hint">${s.hint}</p>` : ''}
            </li>`).join('')}
        </ul>
    </div>`;
}

async function dismissOnboardingChecklist(btn) {
    btn.closest('.onboarding-checklist').remove();
    try {
        await fetch(`${window.API_BASE}/me/onboarding-flags`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionStorage.getItem('hetvlot_token')}` },
            body: JSON.stringify({ checklist_dismissed: true })
        });
        if (AppState.currentUser) AppState.currentUser.onboardingFlags = { ...AppState.currentUser.onboardingFlags, checklist_dismissed: true };
    } catch (e) { console.error('Failed to save onboarding dismiss:', e); }
}

function renderHomeWelcome(user, role) {
    const roleLabels = {
        admin: 'Admin',
        roosterverantwoordelijke: 'Roosterverantwoordelijke',
        medewerker: 'Medewerker'
    };
    const today = new Date();
    const dateStr = today.toLocaleDateString('nl-BE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    return `
        <div class="home-welcome">
            <h2>Welkom, ${escapeHtml(user.name)}</h2>
            <div class="home-welcome-sub">
                <span>${dateStr}</span>
                <span class="home-role-badge">${escapeHtml(roleLabels[role] || role)}</span>
            </div>
        </div>
    `;
}

function renderHomeShifts(user) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 7);

    const todayStr = formatDateYYYYMMDD(today);
    const userId = user.id || user.userId;

    const myShifts = DataStore.shifts
        .filter(s => {
            const sUserId = s.userId || s.employeeId;
            return Number(sUserId) === Number(userId);
        })
        .filter(s => {
            const shiftDate = parseDateOnly(s.date);
            return shiftDate >= today && shiftDate <= endDate;
        })
        .sort((a, b) => {
            const dateCompare = a.date.localeCompare(b.date, 'nl-BE');
            if (dateCompare !== 0) return dateCompare;
            return (a.startTime || a.start_time || '').localeCompare(b.startTime || b.start_time || '', 'nl-BE');
        });

    const dayNames = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

    let shiftsHtml = '';
    if (myShifts.length === 0) {
        shiftsHtml = '<div class="home-card-empty"><i data-lucide="calendar-x" class="empty-state-icon"></i>Geen diensten gepland voor de komende 7 dagen</div>';
    } else {
        shiftsHtml = '<div class="home-card-body">';
        myShifts.forEach(shift => {
            const shiftDate = parseDateOnly(shift.date);
            const dayNum = shiftDate.getDate();
            const monthShort = shiftDate.toLocaleDateString('nl-BE', { month: 'short' });
            const dayName = dayNames[shiftDate.getDay()];
            const startTime = shift.startTime || shift.start_time || '';
            const endTime = shift.endTime || shift.end_time || '';
            const isToday = shift.date.split('T')[0] === todayStr;
            const teamId = shift.team;
            const teamSettings = DataStore.settings?.teams?.[teamId];
            const teamName = teamSettings?.name || teamId || '';
            const teamColor = teamSettings?.color || '#64748b';

            shiftsHtml += `
                <div class="home-shift-item ${isToday ? 'home-shift-today' : ''}">
                    <div class="home-shift-date">
                        <span class="home-shift-date-num">${dayNum}</span>
                        <span class="day-name">${isToday ? 'Vandaag' : escapeHtml(dayName)}</span>
                    </div>
                    <div class="home-shift-time">${escapeHtml(startTime)} – ${escapeHtml(endTime)}</div>
                    <span class="home-shift-team" style="background:${escapeHtml(teamColor)}">${escapeHtml(teamName)}</span>
                </div>
            `;
        });
        shiftsHtml += '</div>';
    }

    return `
        <div class="home-card home-card-shifts">
            <div class="home-card-header">
                Mijn komende diensten
                ${myShifts.length > 0 ? `<span class="card-count">${myShifts.length}</span>` : ''}
            </div>
            ${shiftsHtml}
        </div>
    `;
}

function renderHomeQuickActions(role) {
    let actions = '';

    if (['admin', 'roosterverantwoordelijke'].includes(role)) {
        actions += `<button class="home-action-btn" data-action="add-shift"><span class="home-action-icon">${IconHelper.html('plus', 'md')}</span>Dienst toevoegen</button>`;
    }

    actions += `<button class="home-action-btn" data-action="view-planning"><span class="home-action-icon">${IconHelper.html(ICONS.planning, 'md')}</span>Planning bekijken</button>`;
    actions += `<button class="home-action-btn" data-action="request-absence"><span class="home-action-icon">${IconHelper.html(ICONS.availability, 'md')}</span>Afwezigheid melden</button>`;
    actions += `<button class="home-action-btn" data-action="request-swap"><span class="home-action-icon">${IconHelper.html(ICONS.swap, 'md')}</span>Dienst ruilen</button>`;

    return `
        <div class="home-card">
            <div class="home-card-header">Snelle acties</div>
            <div class="home-card-body">
                <div class="home-quick-actions">${actions}</div>
            </div>
        </div>
    `;
}

function renderHomeRequests(user, role) {
    const userId = Number(user.id || user.userId);
    const userTeam = user.team_id || user.mainTeam;
    const isLeadOrAdmin = ['admin', 'roosterverantwoordelijke'].includes(role);

    let pendingRequests = (DataStore.swapRequests || []).filter(r => {
        if (r.status !== 'pending' && r.status !== 'pending_lead') return false;

        if (isLeadOrAdmin) {
            // Leads zien enkel verzoeken die hun goedkeuring vereisen (pending_lead)
            return r.status === 'pending_lead';
        }
        // Medewerker: eigen requests + takeover requests van eigen team
        return r.requester_user_id === userId || r.target_user_id === userId ||
               (r.request_type === 'takeover' && r.requester_shift_team === userTeam);
    });

    let requestsHtml = '';
    if (pendingRequests.length === 0) {
        requestsHtml = '<div class="home-card-empty"><i data-lucide="inbox" class="empty-state-icon"></i>Geen openstaande verzoeken</div>';
    } else {
        requestsHtml = '<div class="home-card-body">';
        pendingRequests.slice(0, 5).forEach(req => {
            const isSwap = req.request_type === 'swap';
            const typeLabel = isSwap ? 'Ruil' : 'Overname';
            const requesterName = escapeHtml(req.requester_name || 'Onbekend');
            const date = req.requester_shift_date ? req.requester_shift_date.split('T')[0] : '';
            const dateDisplay = date ? parseDateOnly(date).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' }) : '';

            const needsMyAction = req.target_user_id === userId && !req.target_approved;
            const statusLabel = needsMyAction ? 'Actie vereist' : 'Wacht op reactie';
            const statusClass = needsMyAction ? 'needs-action' : 'pending';

            requestsHtml += `
                <div class="home-request-item" data-action="view-swaps">
                    <div class="home-request-info">
                        <div class="home-request-type">${typeLabel}</div>
                        <div class="home-request-detail">${requesterName} - ${escapeHtml(dateDisplay)}</div>
                    </div>
                    <span class="home-request-status ${statusClass}">${statusLabel}</span>
                </div>
            `;
        });
        if (pendingRequests.length > 5) {
            requestsHtml += `<div class="home-card-empty home-card-more">+ ${pendingRequests.length - 5} meer...</div>`;
        }
        requestsHtml += '</div>';
    }

    return `
        <div class="home-card">
            <div class="home-card-header">
                Openstaande verzoeken
                ${pendingRequests.length > 0 ? `<span class="card-count">${pendingRequests.length}</span>` : ''}
            </div>
            ${requestsHtml}
        </div>
    `;
}

function renderHomeTeamCoverage(role, user) {
    const userTeam = user.team_id || user.mainTeam;
    const teams = DataStore.settings?.teams || {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get this week's dates (Mon-Sun)
    const weekDates = getWeekDates(today);
    const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    // Filter teams based on role
    const teamIds = Object.keys(teams).filter(id => {
        if (['admin', 'roosterverantwoordelijke'].includes(role)) return true;
        return id === userTeam;
    });

    if (teamIds.length === 0) return '';

    let coverageHtml = '<div class="home-card-body">';

    teamIds.forEach(teamId => {
        const team = teams[teamId];
        if (!team) return;
        const teamColor = team.color || '#64748b';

        // Count employees in this team
        const teamEmployees = (DataStore.users || []).filter(u =>
            u.active !== false && (u.main_team === teamId || u.team_id === teamId) && u.role !== 'admin'
        );
        const totalEmployees = teamEmployees.length;
        if (totalEmployees === 0) return;

        coverageHtml += `<div class="home-team-section">`;
        coverageHtml += `<div class="home-team-name"><span class="home-team-color-dot" style="background:${escapeHtml(teamColor)}"></span>${escapeHtml(team.name)}</div>`;

        weekDates.forEach((dateStr, i) => {
            if (isDayClosed(dateStr)) return;

            // Count shifts for this team on this date
            const shiftsOnDate = DataStore.shifts.filter(s =>
                s.team === teamId && s.date.split('T')[0] === dateStr
            ).length;

            const presentCount = Math.min(shiftsOnDate, totalEmployees);
            const fillPercent = totalEmployees > 0 ? Math.round((presentCount / totalEmployees) * 100) : 0;
            const barColor = fillPercent >= 70 ? 'var(--success-color)' : fillPercent >= 40 ? 'var(--warning-color)' : 'var(--danger-color)';

            coverageHtml += `
                <div class="home-coverage-bar">
                    <span class="home-coverage-label">${dayLabels[i]}</span>
                    <div class="home-coverage-track">
                        <div class="home-coverage-fill" style="width:${fillPercent}%;background:${barColor}"></div>
                    </div>
                    <span class="home-coverage-count">${presentCount}/${totalEmployees}</span>
                </div>
            `;
        });

        coverageHtml += `</div>`;
    });

    coverageHtml += '</div>';

    return `
        <div class="home-card home-card-full">
            <div class="home-card-header">Team bezetting deze week</div>
            ${coverageHtml}
        </div>
    `;
}

function renderHomeWeekendInfo() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get Monday of current week
    const thisMonday = getMonday(today);

    // Check if currently in a holiday period
    const isHoliday = typeof isHolidayPeriod === 'function' && isHolidayPeriod(today);
    const holidayPeriod = isHoliday && typeof getHolidayPeriod === 'function' ? getHolidayPeriod(today) : null;

    // Find upcoming open weekends (next 4 weeks)
    const upcomingWeekends = [];
    for (let i = 0; i < 4; i++) {
        const weekMonday = new Date(thisMonday);
        weekMonday.setDate(weekMonday.getDate() + (i * 7));

        if (typeof isWeekendOrHolidayWeek === 'function' && isWeekendOrHolidayWeek(weekMonday)) {
            const saturday = new Date(weekMonday);
            saturday.setDate(saturday.getDate() + 5);
            const resp = typeof getOrCalculateResponsible === 'function' ? getOrCalculateResponsible(weekMonday) : null;
            upcomingWeekends.push({ date: saturday, responsible: resp, weekMonday });
        }
    }

    let bodyHtml = '<div class="home-card-body">';

    // Holiday indicator
    if (isHoliday && holidayPeriod) {
        bodyHtml += `
            <div class="warning-banner">
                <div>
                    <strong>Vakantiewerking actief</strong>
                    <div class="text-sm text-muted">${escapeHtml(holidayPeriod.name || 'Vakantieperiode')}</div>
                </div>
            </div>
        `;
    }

    // Upcoming weekends
    if (upcomingWeekends.length > 0) {
        upcomingWeekends.forEach(weekend => {
            const dateStr = weekend.date.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
            const respName = weekend.responsible ? escapeHtml(weekend.responsible.name) : '<em>Niet toegewezen</em>';
            const isThisWeek = weekend.weekMonday.getTime() === thisMonday.getTime();
            const weekHoliday = typeof getHolidayPeriod === 'function' ? getHolidayPeriod(weekend.date) : null;
            const isVakantieResp = weekHoliday && weekHoliday.responsibleId && weekend.responsible;
            const vakantieBadge = isVakantieResp ? '<span class="shift-badge-upcoming">vakantie</span>' : '';

            bodyHtml += `
                <div class="shift-list-item${!isThisWeek ? ' opacity-70' : ''}">
                    <div>
                        <span class="${isThisWeek ? 'fw-600' : ''}">Weekend ${dateStr}</span>
                        ${isThisWeek ? '<span class="shift-badge-today">Deze week</span>' : ''}
                    </div>
                    <span class="text-sm text-muted">${respName}${vakantieBadge}</span>
                </div>
            `;
        });
    } else {
        bodyHtml += '<div class="text-muted text-sm py-sm">Geen open weekenden komende 4 weken</div>';
    }

    bodyHtml += '</div>';

    return `
        <div class="home-card">
            <div class="home-card-header">
                Weekend & Vakantie
                ${isHoliday ? '<span class="shift-badge-upcoming">Vakantie</span>' : ''}
            </div>
            ${bodyHtml}
        </div>
    `;
}

async function switchView(viewName) {
    // Prevent medewerker from accessing settings
    if (viewName === 'settings' && getEffectiveRole() === 'medewerker') {
        viewName = 'home';
    }
    // Warn about unsaved settings changes
    if (AppState.settingsDirty && AppState.currentView === 'settings' && viewName !== 'settings') {
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in instellingen. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        AppState.settingsDirty = false;
    }
    // Warn about unsaved builder changes
    if (AppState.builderIsDirty && AppState.currentView === 'builder' && viewName !== 'builder') {
        stopBuilderAutoSave();
        const proceed = await showConfirm(
            'Je hebt onopgeslagen wijzigingen in de roosterbouwer. Wil je doorgaan zonder op te slaan?',
            'Onopgeslagen wijzigingen'
        );
        if (!proceed) return;
        await unlockScheduleDraft(AppState.builderLoadedDraftId);
        // Reset builder state so returning shows overview
        AppState.builderScreen = 'overview';
        AppState.builderIsDirty = false;
        AppState.builderLoadedDraftId = null;
        AppState.builderLoadedDraftName = null;
        AppState.builderPattern = null;
        AppState.builderConceptType = 'basis';
        AppState.builderHolidayPeriodId = null;
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderShowStaffingEditor = false;
        AppState.builderShowMeetingsEditor = false;
        AppState.builderMeetings = {};
    } else if (AppState.currentView === 'builder' && viewName !== 'builder') {
        stopBuilderAutoSave();
        await unlockScheduleDraft(AppState.builderLoadedDraftId);
        AppState.builderLoadedDraftId = null;
        AppState.builderLoadedDraftName = null;
        // Also reset when leaving builder without unsaved changes
        AppState.builderScreen = 'overview';
        AppState.builderPattern = null;
        AppState.builderConceptType = 'basis';
        AppState.builderHolidayPeriodId = null;
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderShowStaffingEditor = false;
        AppState.builderShowMeetingsEditor = false;
        AppState.builderMeetings = {};
        localStorage.removeItem('hetvlot_activeDraftId');
    }
    // Clear undo history when switching views
    UndoManager.clear();

    // Cleanup drag handlers when switching views
    if (typeof DragHandler !== 'undefined') {
        DragHandler.cleanup();
    }
    if (typeof BuilderDragHandler !== 'undefined') {
        BuilderDragHandler.cleanup();
    }

    AppState.currentView = viewName;
    // Reset shift range when leaving planning, set when entering
    if (viewName === 'planning') {
        updateShiftRefreshRange();
        // Op kleine schermen (≤ 480px) is alleen dagweergave beschikbaar
        if (window.innerWidth <= 480 && AppState.viewMode !== 'day') {
            AppState.viewMode = 'day';
            document.body.setAttribute('data-view-mode', 'day');
        }
    } else {
        setActiveShiftRange(null, null);
    }
    // Save to localStorage so we can restore after refresh
    localStorage.setItem('hetvlot_activeView', viewName);
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
        case 'home':
            DOM.homeView.classList.add('active');
            renderHome();
            break;
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
        case 'builder':
            DOM.builderView.classList.add('active');
            renderBuilder();
            startBuilderAutoSave();
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
    updateShiftRefreshRange();
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

// Set current month
function setCurrentMonth(date) {
    const d = parseDateOnly(date);
    d.setDate(1); // Set to 1st of month
    d.setHours(0, 0, 0, 0);
    AppState.currentMonthStart = d;
    updatePeriodDisplay();
}

// Change month (direction: -1 for previous, 1 for next)
function changeMonth(direction) {
    if (!AppState.currentMonthStart) {
        setCurrentMonth(new Date());
        return;
    }
    const newDate = new Date(AppState.currentMonthStart);
    newDate.setMonth(newDate.getMonth() + direction);
    setCurrentMonth(newDate);
    renderPlanning();
}

// Jump to today (unified function for both views)
function jumpToToday() {
    const today = new Date();
    if (AppState.viewMode === 'week' || AppState.viewMode === 'day') {
        setCurrentWeek(today);
        const dayOfWeek = today.getDay();
        AppState.mobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    } else {
        setCurrentMonth(today);
    }
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
        if (AppState.viewMode === 'day') {
            updatePeriodDisplay();
        }
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
        const prev = new Date(AppState.currentWeekStart);
        prev.setDate(prev.getDate() - 7);
        AppState.currentWeekStart = prev;
    } else if (AppState.availabilityMobileDayIndex > 6) {
        AppState.availabilityMobileDayIndex = 0;
        const next = new Date(AppState.currentWeekStart);
        next.setDate(next.getDate() + 7);
        AppState.currentWeekStart = next;
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
    if (mode === AppState.viewMode) return; // Already in this mode

    // Store context before switching
    if (mode === 'month' && AppState.viewMode === 'week') {
        // Switching week → month
        AppState.previousWeekStart = AppState.currentWeekStart;
        setCurrentMonth(AppState.currentWeekStart || new Date());
    } else if (mode === 'week' && AppState.viewMode === 'month') {
        // Switching month → week
        if (AppState.previousWeekStart) {
            AppState.currentWeekStart = AppState.previousWeekStart;
        } else {
            setCurrentWeek(AppState.currentMonthStart || new Date());
        }
    } else if (mode === 'day') {
        // Switching to day mode: default to today's day in current week
        if (!AppState.currentWeekStart) {
            setCurrentWeek(new Date());
        }
        const today = new Date();
        const todayDow = today.getDay();
        AppState.mobileDayIndex = todayDow === 0 ? 6 : todayDow - 1;
    } else if (mode === 'week' && AppState.viewMode === 'day') {
        // Switching day → week: keep current week, no changes needed
    }

    AppState.viewMode = mode;
    document.body.setAttribute('data-view-mode', mode);

    DOM.viewToggleBtns.forEach(btn => {
        if (btn.dataset.mode === mode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    updatePeriodDisplay();
    renderPlanning();
}

function updatePeriodDisplay() {
    if (AppState.viewMode === 'month') {
        // Month view: show "februari 2026"
        if (!AppState.currentMonthStart) {
            setCurrentMonth(new Date());
            return;
        }
        DOM.currentPeriod.textContent = formatMonthDisplay(AppState.currentMonthStart);
    } else if (AppState.viewMode === 'day') {
        // Day view: show "Maandag, 3 maart 2026"
        if (!AppState.currentWeekStart) {
            setCurrentWeek(new Date());
            return;
        }
        const dayNames = ['Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag', 'Zondag'];
        const currentDate = new Date(AppState.currentWeekStart);
        currentDate.setDate(currentDate.getDate() + AppState.mobileDayIndex);
        const dateStr = currentDate.toLocaleDateString('nl-BE', { day: 'numeric', month: 'long', year: 'numeric' });
        DOM.currentPeriod.textContent = `${dayNames[AppState.mobileDayIndex]}, ${dateStr}`;
    } else {
        // Week view: show "Week 6 | 3 februari 2026 - 9 februari 2026"
        if (!AppState.currentWeekStart) {
            setCurrentWeek(new Date());
            return;
        }
        const weekEnd = new Date(AppState.currentWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const options = { day: 'numeric', month: 'long', year: 'numeric' };
        const startStr = AppState.currentWeekStart.toLocaleDateString('nl-BE', options);
        const endStr = weekEnd.toLocaleDateString('nl-BE', options);
        DOM.currentPeriod.textContent = `${startStr} - ${endStr}`;
    }
}

