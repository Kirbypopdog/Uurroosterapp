// HET VLOT ROOSTERPLANNING - MEDEWERKERS, PROFIEL EN BASISROOSTER

function renderEmployees() {
    renderEmployeeTeamToggles();
    const role = getEffectiveRole();
    const employees = getAllEmployees();
    // Groepeer medewerkers per team - alleen zichtbare teams
    const teams = DataStore.settings.teams;
    const baseTeamOrder = getTeamOrder()
        .filter(t => AppState.visibleEmployeeTeams.includes(t));
    let teamOrder = baseTeamOrder;

    // Medewerker only sees own team
    if (role === 'medewerker') {
        const userTeam = AppState.currentUser?.team_id
            || employees.find(emp => emp.user_id === AppState.currentUser?.id)?.mainTeam
            || employees.find(emp => emp.email && emp.email.toLowerCase() === String(AppState.currentUser?.email || '').toLowerCase())?.mainTeam;
        teamOrder = userTeam ? baseTeamOrder.filter(teamId => teamId === userTeam) : [];
    }
    const employeesByTeam = {};

    // Determine current week start for hours calculations
    const currentWeekStartDate = AppState.currentWeekStart
        ? formatDateYYYYMMDD(AppState.currentWeekStart)
        : formatDateYYYYMMDD(new Date());

    teamOrder.forEach(teamKey => {
        const teamEmps = employees.filter(emp => emp.mainTeam === teamKey);

        teamEmps.sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));

        employeesByTeam[teamKey] = teamEmps;
    });

    let html = '';

    // Render per team
    teamOrder.forEach(teamKey => {
        const teamEmployees = employeesByTeam[teamKey];
        if (teamEmployees.length === 0) return;

        const team = teams[teamKey];
        const teamName = escapeHtml(team.name);

        html += `<div class="employees-team-section">
            <div class="employees-team-header team-${teamKey}">
                <span class="team-header-name">${teamName}</span>
                <span class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="employees-team-grid">`;

        teamEmployees.forEach(emp => {
            html += renderEmployeeCard(emp);
        });

        html += `</div></div>`;
    });

    if (employees.length === 0 || teamOrder.length === 0) {
        html = '<p>Nog geen medewerkers toegevoegd.</p>';
    }

    DOM.employeesList.innerHTML = html;
    IconHelper.init(DOM.employeesList);
    // Add click handler for employee cards based on permissions
    document.querySelectorAll('.employee-card').forEach(card => {
        const employeeId = parseInt(card.dataset.employeeId, 10);
        const employee = employees.find(e => e.id === employeeId);
        if (employee && canManageEmployee(employee)) {
            card.style.cursor = 'pointer';
            card.addEventListener('click', () => {
                openEditEmployeeModal(employeeId);
            });
        } else {
            card.style.cursor = 'default';
        }
    });
    document.querySelectorAll('.week-nav-btn').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const direction = btn.dataset.direction;
            const employeeId = btn.dataset.employeeId;
            if (!employeeId) return;
            const current = AppState.employeeWeekOffsets?.[employeeId] || 0;
            if (direction === 'prev') {
                AppState.employeeWeekOffsets[employeeId] = current - 1;
            } else if (direction === 'next') {
                AppState.employeeWeekOffsets[employeeId] = current + 1;
            } else if (direction === 'today') {
                AppState.employeeWeekOffsets[employeeId] = 0;
            }
            renderEmployees();
        });
    });
    document.querySelectorAll('.hours-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const card = btn.closest('.employee-card');
            if (!card) return;
            const isOpen = card.classList.toggle('show-month');
            btn.textContent = isOpen ? 'Verberg maand' : 'Toon maand';
        });
    });
}

function renderProfile() {
    const user = AppState.currentUser;
    if (!user) return;

    const roleLabels = {
        admin: 'Admin',
        roosterverantwoordelijke: 'Roosterverantwoordelijke',
        medewerker: 'Medewerker'
    };
    const role = roleLabels[user.role] || user.role || 'Onbekend';
    const roleClass = roleLabels[user.role] ? user.role : 'medewerker';
    const teamId = user.team_id || user.mainTeam;
    const teamSettings = DataStore.settings.teams?.[teamId];
    const teamName = teamSettings ? teamSettings.name : 'Niet gekoppeld';
    const teamColor = teamSettings?.color || 'var(--primary-color)';
    const accessMap = {
        admin: 'Alle paginas + instellingen + accountbeheer',
        roosterverantwoordelijke: 'Alle paginas + instellingen (zonder accountbeheer)',
        medewerker: 'Eigen rooster bekijken, verlof en ruilen'
    };
    const accessSummary = accessMap[user.role] || 'Planning + profiel';
    const initials = getInitials(user.name || '');

    // Hours calculation
    const empId = user.id || user.userId || user.employeeId;
    const emp = DataStore.users.find(u => u.id === empId) || user;
    const contractHours = emp.contractHours || emp.contract_hours || 0;
    const resolvedId = emp.id || empId;
    const weekStart = getEmployeeWeekStart(resolvedId);
    const weekDates = getWeekDates(weekStart);
    const hoursWeek = getEmployeeHoursThisWeek(resolvedId, weekDates[0]);
    const hoursMonth = getEmployeeHoursThisMonth(resolvedId, weekDates[0]);

    const canEditContract = ['admin', 'roosterverantwoordelijke'].includes(user.role);

    // Build hours card content
    let hoursCardContent = '';
    if (contractHours > 0) {
        const monthContract = contractHours * 4.33;
        const weekPct = Math.min((hoursWeek / contractHours) * 100, 100);
        const monthPct = Math.min((hoursMonth / monthContract) * 100, 100);
        const weekClr = hoursWeek > contractHours ? '#ef4444' : hoursWeek > contractHours * 0.9 ? '#f59e0b' : '#10b981';
        const monthClr = hoursMonth > monthContract ? '#ef4444' : hoursMonth > monthContract * 0.9 ? '#f59e0b' : '#10b981';
        const overtimeWeek = Math.max(0, hoursWeek - contractHours);
        const overtimeMonth = Math.max(0, hoursMonth - monthContract);
        hoursCardContent = `
            <div class="profile-hours-section">
                <div class="profile-hours-row">
                    <span class="profile-hours-label">Deze week</span>
                    <span class="profile-hours-value">${hoursWeek.toFixed(1)}u / ${contractHours}u</span>
                </div>
                <div class="progress-bar mb-sm">
                    <div class="progress-fill" style="width:${weekPct}%;background:${weekClr}"></div>
                </div>
                <div class="profile-hours-row">
                    <span class="profile-hours-label">Deze maand</span>
                    <span class="profile-hours-value">${hoursMonth.toFixed(1)}u / ${monthContract.toFixed(0)}u</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width:${monthPct}%;background:${monthClr}"></div>
                </div>
                ${(overtimeWeek > 0 || overtimeMonth > 0) ? `
                    <div class="d-flex gap-sm mt-sm flex-wrap">
                        ${overtimeWeek > 0 ? `<span class="overtime-chip-sm">+${overtimeWeek.toFixed(1)}u overuren week</span>` : ''}
                        ${overtimeMonth > 0 ? `<span class="overtime-chip-sm">+${overtimeMonth.toFixed(1)}u overuren maand</span>` : ''}
                    </div>
                ` : ''}
            </div>`;
    } else {
        hoursCardContent = `
            <div class="profile-hours-section">
                <div class="profile-hours-row">
                    <span class="profile-hours-label">Deze week</span>
                    <span class="profile-hours-value">${hoursWeek.toFixed(1)}u</span>
                </div>
                <div class="profile-hours-row">
                    <span class="profile-hours-label">Deze maand</span>
                    <span class="profile-hours-value">${hoursMonth.toFixed(1)}u</span>
                </div>
                <p class="form-hint mt-sm">Geen contracturen ingesteld.</p>
            </div>`;
    }

    // Week schedule tabs
    const weekTabs = (() => {
        const cl = getCycleLength();
        let tabs = '';
        for (let w = 1; w <= cl; w++) {
            tabs += `<button type="button" class="profile-week-btn ${w === 1 ? 'active' : ''}" data-week="${w}">Week ${w}</button>`;
        }
        return tabs;
    })();

    DOM.profileContent.innerHTML = `
        <!-- Hero header -->
        <div class="profile-hero">
            <div class="profile-hero-avatar" style="background:${teamColor}">${escapeHtml(initials)}</div>
            <div class="profile-hero-info">
                <h2 class="profile-hero-name">${escapeHtml(user.name)}</h2>
                <div class="profile-hero-meta">
                    <span class="profile-hero-role role-${roleClass}">${escapeHtml(role)}</span>
                    <span class="profile-hero-team">${escapeHtml(teamName)}</span>
                </div>
                <div class="profile-hero-email">${escapeHtml(user.email)}</div>
            </div>
            <div class="profile-hero-actions">
                <button class="btn btn-secondary btn-sm" id="profile-edit-btn">
                    ${IconHelper.html(ICONS.edit, 'xs')} Bewerken
                </button>
            </div>
        </div>

        <!-- Cards grid -->
        <div class="profile-cards-grid">
            <div class="settings-card">
                <div class="settings-card-header">
                    <h3><span class="settings-icon">${IconHelper.html(ICONS.calendar, 'md')}</span> Vast werkrooster</h3>
                    <span id="profile-schedule-source" class="badge badge-info hidden"></span>
                </div>
                <div class="settings-card-body">
                    <div class="profile-week-toggle" id="profile-week-tabs">
                        ${weekTabs}
                    </div>
                    <div id="profile-week-schedule-container" class="week-schedule-container"></div>
                </div>
            </div>

            <div class="settings-card">
                <div class="settings-card-header">
                    <h3><span class="settings-icon">${IconHelper.html(ICONS.clock, 'md')}</span> Uren overzicht</h3>
                </div>
                <div class="settings-card-body">
                    ${hoursCardContent}
                </div>
            </div>
        </div>

        <!-- Account overzicht (full width) -->
        <div class="settings-card">
            <div class="settings-card-header">
                <h3><span class="settings-icon">${IconHelper.html(ICONS.info, 'md')}</span> Account overzicht</h3>
            </div>
            <div class="settings-card-body">
                <div class="profile-meta profile-meta-inline">
                    <div class="profile-meta-row">
                        <span class="profile-meta-label">Rol</span>
                        <span class="profile-meta-value role-${roleClass}">${escapeHtml(role)}</span>
                    </div>
                    <div class="profile-meta-row">
                        <span class="profile-meta-label">Hoofdteam</span>
                        <span class="profile-meta-value">${escapeHtml(teamName)}</span>
                    </div>
                    <div class="profile-meta-row">
                        <span class="profile-meta-label">Toegang</span>
                        <span class="profile-meta-value">${escapeHtml(accessSummary)}</span>
                    </div>
                    <div class="profile-meta-row">
                        <span class="profile-meta-label">Contracturen</span>
                        <span class="profile-meta-value" id="profile-contract-cell">
                            <span id="profile-contract-display">${contractHours > 0 ? contractHours + ' u/week' : '—'}</span>
                            ${canEditContract ? `<button type="button" class="btn btn-secondary btn-xs ml-sm" id="profile-contract-edit-btn">Bewerken</button>` : ''}
                        </span>
                    </div>
                    <div class="profile-meta-row">
                        <span class="profile-meta-label">Email notificaties</span>
                        <span class="profile-meta-value">
                            <label class="toggle-switch" title="Ontvang email meldingen bij ruilverzoeken, overnames en ziekmeldingen">
                                <input type="checkbox" id="email-notifications-toggle" ${user.emailNotificationsEnabled !== false ? 'checked' : ''} />
                                <span class="toggle-slider"></span>
                            </label>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    `;
    IconHelper.init(DOM.profileContent);

    // Setup week schedule for profile
    generateProfileWeekScheduleHTML();
    loadProfileWeekSchedule();
    setupProfileWeekScheduleListeners();

    // Edit button opens modal
    document.getElementById('profile-edit-btn')?.addEventListener('click', openProfileEditModal);

    // Email notifications toggle
    const emailToggle = document.getElementById('email-notifications-toggle');
    if (emailToggle) {
        emailToggle.addEventListener('change', async () => {
            try {
                const data = await dataApiFetch('/me/email-preferences', {
                    method: 'PUT',
                    body: JSON.stringify({ emailNotificationsEnabled: emailToggle.checked })
                });
                AppState.currentUser.emailNotificationsEnabled = data.emailNotificationsEnabled;
                sessionStorage.setItem('hetvlot_user', JSON.stringify(AppState.currentUser));
                showToast(emailToggle.checked ? 'Email notificaties ingeschakeld' : 'Email notificaties uitgeschakeld', 'success');
            } catch (error) {
                emailToggle.checked = !emailToggle.checked;
                showToast('Kon voorkeur niet opslaan: ' + error.message, 'error');
            }
        });
    }

    // Contract hours inline edit (admin/roosterverantwoordelijke only)
    const contractEditBtn = document.getElementById('profile-contract-edit-btn');
    if (contractEditBtn) {
        contractEditBtn.addEventListener('click', () => {
            const cell = document.getElementById('profile-contract-cell');
            if (!cell) return;
            const currentVal = contractHours || '';
            cell.innerHTML = `<input type="number" id="profile-contract-input" class="form-input contract-hours-input" value="${currentVal}" min="0" max="60" step="0.5"> u/week
                <button type="button" class="btn btn-primary btn-xs ml-sm" id="profile-contract-save">Opslaan</button>
                <button type="button" class="btn btn-secondary btn-xs ml-sm" id="profile-contract-cancel">Annuleren</button>`;
            document.getElementById('profile-contract-input')?.focus();

            document.getElementById('profile-contract-cancel')?.addEventListener('click', renderProfile);

            document.getElementById('profile-contract-save')?.addEventListener('click', async () => {
                const newHours = parseFloat(document.getElementById('profile-contract-input')?.value) || 0;
                const saveBtn = document.getElementById('profile-contract-save');
                if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Opslaan...'; }
                try {
                    const currentEmpData = DataStore.users.find(u => u.id === resolvedId) || emp;
                    await updateEmployee(resolvedId, { ...currentEmpData, contractHours: newHours });
                    if (AppState.currentUser && AppState.currentUser.id === resolvedId) {
                        AppState.currentUser.contractHours = newHours;
                        sessionStorage.setItem('hetvlot_user', JSON.stringify(AppState.currentUser));
                    }
                    showToast('Contracturen bijgewerkt.', 'success');
                    renderProfile();
                } catch (err) {
                    showToast('Fout bij opslaan: ' + getUserFriendlyError(err), 'error');
                    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Opslaan'; }
                }
            });
        });
    }
}

function openProfileEditModal() {
    const user = AppState.currentUser;
    if (!user) return;

    const modalHtml = `
        <div class="modal-header">
            <h3>Profiel bewerken</h3>
            <button class="modal-close" aria-label="Sluiten">&times;</button>
        </div>
        <form id="profile-edit-form">
            <div class="form-group">
                <label for="profile-name">Naam</label>
                <input type="text" id="profile-name" class="form-input" value="${escapeHtml(user.name)}" required />
            </div>
            <div class="form-group">
                <label for="profile-email">E-mailadres</label>
                <input type="email" id="profile-email" class="form-input" value="${escapeHtml(user.email)}" required />
                <span class="form-hint">Dit e-mailadres gebruik je om in te loggen.</span>
            </div>
            <div class="form-group">
                <label for="profile-password">Nieuw wachtwoord</label>
                <input type="password" id="profile-password" class="form-input" placeholder="Laat leeg om niet te wijzigen" />
                <span class="form-hint">Minstens 8 tekens als je wijzigt.</span>
            </div>
            <div class="form-group">
                <label for="profile-password-repeat">Herhaal nieuw wachtwoord</label>
                <input type="password" id="profile-password-repeat" class="form-input" placeholder="Herhaal het nieuwe wachtwoord" />
            </div>
            <div id="profile-message" class="form-message info" aria-live="polite">
                Wijzig je gegevens en klik op Opslaan.
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary profile-edit-cancel">Annuleren</button>
                <button type="submit" class="btn btn-primary">Opslaan</button>
            </div>
        </form>
    `;

    // Create modal
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.id = 'profile-edit-modal';
    const content = document.createElement('div');
    content.className = 'modal-content';
    content.innerHTML = modalHtml;
    overlay.appendChild(content);
    document.body.appendChild(overlay);
    overlay.classList.add('active');
    IconHelper.init(content);

    const form = document.getElementById('profile-edit-form');
    const message = document.getElementById('profile-message');
    const closeModal = () => {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 200);
    };

    const setMessage = (text, type = 'info') => {
        message.textContent = text;
        message.className = `form-message ${type}`;
    };

    // Close handlers
    overlay.querySelector('.modal-close').addEventListener('click', closeModal);
    overlay.querySelector('.profile-edit-cancel').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); }
    });

    // Focus first field
    document.getElementById('profile-name')?.focus();

    // Form submit
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = document.getElementById('profile-name').value.trim();
        const email = document.getElementById('profile-email').value.trim();
        const password = document.getElementById('profile-password').value;
        const passwordRepeat = document.getElementById('profile-password-repeat').value;

        if (!name) { setMessage('Vul een naam in.', 'error'); return; }
        const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        if (!emailRegex.test(email)) { setMessage('Vul een geldig e-mailadres in.', 'error'); return; }
        if (password && password.length < 8) { setMessage('Je nieuwe wachtwoord moet minstens 8 tekens zijn.', 'error'); return; }
        if (password !== passwordRepeat) { setMessage('De wachtwoorden komen niet overeen.', 'error'); return; }

        const hasChanges = name !== user.name
            || email.toLowerCase() !== String(user.email || '').toLowerCase()
            || Boolean(password);
        if (!hasChanges) { setMessage('Geen wijzigingen om op te slaan.', 'info'); return; }

        const submitBtn = form.querySelector('button[type="submit"]');
        try {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Opslaan...';
            const payload = { name, email };
            if (password) payload.password = password;
            const data = await dataApiFetch('/me', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });
            AppState.currentUser = data.user;
            sessionStorage.setItem('hetvlot_user', JSON.stringify(data.user));
            populateUserMenu();
            showToast('Profiel opgeslagen', 'success');
            closeModal();
            renderProfile();
        } catch (error) {
            setMessage(`Opslaan mislukt: ${error.message}`, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Opslaan';
        }
    });
}

// ===== PROFILE WEEK SCHEDULE FUNCTIONS =====

function generateProfileWeekScheduleHTML() {
    const container = document.getElementById('profile-week-schedule-container');
    if (!container) return;

    const dayAbbrev = {
        1: 'Ma', 2: 'Di', 3: 'Wo', 4: 'Do', 5: 'Vr', 6: 'Za', 0: 'Zo'
    };

    function generateWeekHTML(weekNumber, days) {
        let html = `<div class="week-content ${weekNumber === 1 ? 'active' : ''}" data-profile-week="${weekNumber}">`;
        html += '<div class="profile-schedule-grid">';

        days.forEach(dayNum => {
            html += `
            <div class="profile-schedule-row profile-schedule-off" data-profile-row-week="${weekNumber}" data-profile-row-day="${dayNum}">
                <span class="profile-schedule-day">${dayAbbrev[dayNum]}</span>
                <span class="profile-schedule-detail">Vrij</span>
            </div>`;
        });

        html += '</div></div>';
        return html;
    }

    const cycleLen = getCycleLength();
    let weeksHtml = '';
    for (let w = 1; w <= cycleLen; w++) {
        const openDays = getOpenDaysForWeek(w);
        weeksHtml += generateWeekHTML(w, openDays);
    }
    container.innerHTML = weeksHtml;
}

function loadProfileWeekSchedule() {
    const user = AppState.currentUser;
    if (!user) return;

    // Use DataStore.users for most up-to-date schedule data (AppState.currentUser may be stale)
    const empId = user.id || user.userId || user.employeeId;
    const emp = DataStore.users.find(u => u.id === empId) || user;

    const activeDraft = getActiveBasisDraft();
    const cycleLen = getCycleLength();
    let loadedFromDraft = false;

    for (let w = 1; w <= cycleLen; w++) {
        const draftSchedule = activeDraft ? getWeekScheduleFromDraft(emp, w, activeDraft) : null;
        const schedule = draftSchedule || getEmployeeWeekSchedule(emp, w);
        if (draftSchedule) loadedFromDraft = true;
        if (schedule && schedule.length > 0) {
            loadProfileWeekScheduleData(w, schedule);
        }
    }

    const badge = document.getElementById('profile-schedule-source');
    if (badge) {
        if (loadedFromDraft && activeDraft) {
            badge.textContent = `Actief concept: ${activeDraft.name}`;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

function loadProfileWeekScheduleData(weekNumber, weekSchedule) {
    if (!Array.isArray(weekSchedule)) return;

    weekSchedule.forEach(daySchedule => {
        if (!daySchedule.enabled) return;

        const row = document.querySelector(`.profile-schedule-row[data-profile-row-week="${weekNumber}"][data-profile-row-day="${daySchedule.dayOfWeek}"]`);
        if (!row) return;

        const start = daySchedule.startTime || '';
        const end = daySchedule.endTime || '';
        if (!start || !end) return;

        // Find matching template name
        let templateName = '';
        const matchedId = Object.keys(DataStore.settings.shiftTemplates || {}).find(id => {
            const t = DataStore.settings.shiftTemplates[id];
            return t.start === start && t.end === end;
        });
        if (matchedId) {
            templateName = DataStore.settings.shiftTemplates[matchedId].name;
        }

        row.classList.remove('profile-schedule-off');
        row.classList.add('profile-schedule-active');
        const detailEl = row.querySelector('.profile-schedule-detail');
        if (detailEl) {
            detailEl.innerHTML = templateName
                ? `${start} – ${end} <span class="profile-schedule-badge">${escapeHtml(templateName)}</span>`
                : `${start} – ${end}`;
        }
    });
}

function setupProfileWeekScheduleListeners() {
    // Tab switching only — profile schedule is read-only, editing via employees tab
    document.querySelectorAll('#profile-week-tabs .profile-week-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            const weekNumber = tab.dataset.week;
            document.querySelectorAll('#profile-week-tabs .profile-week-btn').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('[data-profile-week]').forEach(content => {
                content.classList.toggle('active', content.dataset.profileWeek === weekNumber);
            });
        });
    });
}

function renderEmployeeCard(emp) {
    const statusClass = emp.active ? 'active' : 'inactive';
    const statusText = emp.active ? 'Actief' : 'Inactief';
    const mainTeam = DataStore.settings.teams?.[emp.mainTeam];
    const employeeName = escapeHtml(emp.name);
    const employeeEmail = escapeHtml(emp.email || '');
    const mainTeamName = escapeHtml(mainTeam?.name || emp.mainTeam || 'Onbekend');
    const contractHours = emp.contractHours || 0;

    const teamName = (DataStore.settings.teams || {})[emp.mainTeam]?.name || emp.mainTeam || '';
    const teamColor = (DataStore.settings.teams || {})[emp.mainTeam]?.color || '#94a3b8';

    const noEmailBadge = !emp.email ? `<span class="employee-status no-email" title="Geen e-mail — voeg toe om welkomstmail te sturen">Geen email</span>` : '';

    return `
        <div class="employee-card" data-employee-id="${emp.id}">
            <div class="employee-header">
                <span class="team-color-dot" style="background: ${teamColor}" title="${escapeHtml(teamName)}"></span>
                <div class="employee-name">${employeeName}</div>
                ${noEmailBadge}
                <span class="employee-status ${statusClass}">${statusText}</span>
            </div>
        </div>
    `;
}

function openAddEmployeeModal() {
    AppState.editingEmployeeId = null;
    DOM.employeeModalTitle.textContent = 'Medewerker toevoegen';
    DOM.employeeForm.reset();
    DOM.employeeActive.value = 'true';
    DOM.employeeDeleteBtn.classList.add('hidden');

    // Populate team dropdown
    const mainTeamSelect = DOM.employeeMainTeam;
    mainTeamSelect.innerHTML = '';
    const teams = DataStore.settings.teams || {};
    for (const [teamId, teamInfo] of Object.entries(teams)) {
        const opt = document.createElement('option');
        opt.value = teamId;
        opt.textContent = teamInfo.name || teamId;
        mainTeamSelect.appendChild(opt);
    }

    // Show profile fields and actions
    const profileFields = document.getElementById('employee-profile-fields');
    if (profileFields) profileFields.classList.remove('hidden');
    const modalActions = DOM.employeeModal.querySelector('.modal-actions');
    if (modalActions) modalActions.classList.remove('hidden');

    generateWeekScheduleHTML();
    resetWeekScheduleForm();
    DOM.employeeModal.classList.remove('hidden');
}

function openEditEmployeeModal(employeeId) {
    const employee = getEmployee(employeeId);
    if (!employee) return;
    AppState.editingEmployeeId = employeeId;
    DOM.employeeModalTitle.textContent = employee.name;

    const canEdit = ['admin', 'roosterverantwoordelijke'].includes(getEffectiveRole());
    const canEditEmail = getEffectiveRole() === 'admin';

    // Profile fields
    DOM.employeeName.value = employee.name;
    DOM.employeeEmail.value = employee.email || '';
    DOM.employeeEmail.disabled = !canEditEmail;
    DOM.employeeContract.value = employee.contractHours || '';
    DOM.employeeActive.value = employee.active !== false ? 'true' : 'false';

    // Populate team dropdown
    const mainTeamSelect = DOM.employeeMainTeam;
    mainTeamSelect.innerHTML = '';
    const teams = DataStore.settings.teams || {};
    for (const [teamId, teamInfo] of Object.entries(teams)) {
        const opt = document.createElement('option');
        opt.value = teamId;
        opt.textContent = teamInfo.name || teamId;
        mainTeamSelect.appendChild(opt);
    }
    mainTeamSelect.value = employee.mainTeam;

    // Show/hide profile fields and actions based on permissions
    const profileFields = document.getElementById('employee-profile-fields');
    if (profileFields) profileFields.classList.toggle('hidden', !canEdit);

    const modalActions = DOM.employeeModal.querySelector('.modal-actions');
    if (modalActions) modalActions.classList.toggle('hidden', !canEdit);

    DOM.employeeDeleteBtn.classList.toggle('hidden', !canEdit);

    // Show read-only schedule from active concept
    generateReadOnlyWeekScheduleHTML(employee);

    // Add "Bekijk in planning" button
    const container = document.getElementById('week-schedule-container');
    if (container) {
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'btn btn-secondary btn-sm';
        viewBtn.style.marginTop = '12px';
        viewBtn.innerHTML = `${IconHelper.html('calendar', 'xs')} Bekijk in weekrooster`;
        viewBtn.addEventListener('click', () => {
            closeEmployeeModal();
            AppState.currentWeekStart = getMondayOfWeek(new Date());
            switchView('planning');
        });
        container.appendChild(viewBtn);
        IconHelper.init(viewBtn);
    }

    DOM.employeeModal.classList.remove('hidden');
}

function generateReadOnlyWeekScheduleHTML(employee) {
    const dayNames = { 1: 'Ma', 2: 'Di', 3: 'Wo', 4: 'Do', 5: 'Vr', 6: 'Za', 0: 'Zo' };
    const cycleLen = getCycleLength();

    // Hide tabs container if it exists
    const tabsContainer = document.getElementById('employee-week-tabs');
    if (tabsContainer) tabsContainer.innerHTML = '';

    const container = document.getElementById('week-schedule-container');
    if (!container) return;

    let html = '<div class="read-only-schedule">';
    html += '<p class="form-hint mb-sm">Het basisrooster wordt beheerd via Rooster Bouwen.</p>';

    const dayOrder = [1, 2, 3, 4, 5, 6, 0];
    const prevDayMap = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };

    for (let w = 1; w <= cycleLen; w++) {
        const schedule = getEmployeeWeekSchedule(employee, w) || [];
        const activeDays = schedule.filter(s => s.enabled);
        const nachtForfait = (DataStore.settings && DataStore.settings.nachtForfait) ?? 5.25;
        const totalHours = activeDays.reduce((sum, s) => {
            const [sh, sm] = s.startTime.split(':').map(Number);
            const [eh, em] = s.endTime.split(':').map(Number);
            const startDec = sh + sm / 60;
            const endDec = eh + em / 60;
            if (endDec > startDec) return sum + (endDec - startDec);
            // Night shift — use nachtforfait if crossing sleep window (ends >= 07:00)
            if (eh >= 7) return sum + Math.max(0, 23 - startDec) + Math.max(0, endDec - 7) + nachtForfait;
            return sum + (24 - startDec) + endDec;
        }, 0);

        html += `<div class="ro-week-block">`;
        html += `<div class="ro-week-header">`;
        html += `<span class="ro-week-title">Week ${w}</span>`;
        html += `<span class="ro-week-hours">${totalHours.toFixed(1)}u</span>`;
        html += `</div>`;
        html += '<div class="ro-week-grid">';
        dayOrder.forEach(dayNum => {
            const entry = schedule.find(s => s.dayOfWeek === dayNum && s.enabled);
            const prevDay = prevDayMap[dayNum];
            const prevEntry = schedule.find(s => s.dayOfWeek === prevDay && s.enabled);
            const prevIsNight = prevEntry && (() => {
                const [ph, pm] = prevEntry.startTime.split(':').map(Number);
                const [eh2, em2] = prevEntry.endTime.split(':').map(Number);
                return (eh2 + em2/60) < (ph + pm/60);
            })();

            if (entry) {
                html += `<div class="ro-day-row">
                    <span class="ro-day-name">${dayNames[dayNum]}</span>
                    <span class="ro-day-time">${entry.startTime} – ${entry.endTime}</span>
                </div>`;
            } else if (prevIsNight) {
                html += `<div class="ro-day-row ro-day-overnight">
                    <span class="ro-day-name">${dayNames[dayNum]}</span>
                    <span class="ro-day-time">→ ${prevEntry.endTime}</span>
                </div>`;
            } else {
                html += `<div class="ro-day-row ro-day-off">
                    <span class="ro-day-name">${dayNames[dayNum]}</span>
                    <span class="ro-day-time">—</span>
                </div>`;
            }
        });
        html += '</div></div>';
    }

    html += '</div>';

    container.innerHTML = html;
    IconHelper.init(container);
}

function closeEmployeeModal() {
    DOM.employeeModal.classList.add('hidden');
    DOM.employeeForm.reset();
    AppState.editingEmployeeId = null;
    DOM.employeeDeleteBtn.classList.add('hidden');
    // Restore modal-actions visibility for next open (add mode needs it)
    const modalActions = DOM.employeeModal.querySelector('.modal-actions');
    if (modalActions) modalActions.classList.remove('hidden');
}

async function handleEmployeeSubmit(e) {
    e.preventDefault();

    const employeeData = {
        name: DOM.employeeName.value.trim(),
        email: DOM.employeeEmail.value.trim() || null,
        mainTeam: DOM.employeeMainTeam.value,
        contractHours: parseFloat(DOM.employeeContract.value) || 0,
        active: DOM.employeeActive.value === 'true'
    };
    showSectionLoading('employees-view', 'Medewerker opslaan...');
    try {
        if (AppState.editingEmployeeId) {
            await updateEmployee(AppState.editingEmployeeId, employeeData);
        } else {
            await addEmployee(employeeData);
            showToast('Medewerker aangemaakt. Stel het basisrooster in via Rooster Bouwen.', 'success');
        }
        closeEmployeeModal();
        renderEmployees();

        // Refresh planning view if currently visible
        if (AppState.currentView === 'planning') {
            renderPlanning();
        }
    } catch (error) {
        console.error('Error saving employee:', error);
        showToast('Fout bij opslaan medewerker: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('employees-view');
    }
}

async function handleEmployeeDelete() {
    if (!AppState.editingEmployeeId) return;
    const employee = getEmployee(AppState.editingEmployeeId);
    if (!employee) return;

    const relatedShifts = getShiftsByEmployee(employee.id).length;
    const confirmMsg = `Weet je zeker dat je ${employee.name} wilt verwijderen?\n\nDit verwijdert ook ${relatedShifts} dienst${relatedShifts !== 1 ? 'en' : ''} en eventuele afwezigheden.`;

    if (!await showConfirm(confirmMsg, 'Medewerker verwijderen')) return;

    showSectionLoading('employees-view', 'Medewerker verwijderen...');
    try {
        await deleteEmployee(employee.id);
        closeEmployeeModal();
        renderEmployees();
        renderPlanning();
    } catch (error) {
        console.error('Error deleting employee:', error);
        showToast('Fout bij verwijderen: ' + getUserFriendlyError(error), 'error');
    } finally {
        hideSectionLoading('employees-view');
    }
}

// ===== BASISROOSTER FUNCTIES =====

function generateWeekScheduleHTML() {
    // Generate dynamic week tabs
    const tabsContainer = document.getElementById('employee-week-tabs');
    if (tabsContainer) {
        const cl = getCycleLength();
        let tabsHtml = '';
        for (let w = 1; w <= cl; w++) {
            const label = getWeekLabel(w);
            tabsHtml += `<button type="button" class="week-tab ${w === 1 ? 'active' : ''}" data-week="${w}">Week ${w} (${escapeHtml(label)})</button>`;
        }
        tabsContainer.innerHTML = tabsHtml;

        // Add tab click listeners
        tabsContainer.querySelectorAll('.week-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                tabsContainer.querySelectorAll('.week-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('#week-schedule-container .week-content').forEach(content => {
                    content.classList.toggle('active', content.dataset.week === tab.dataset.week);
                });
            });
        });
    }

    const container = document.getElementById('week-schedule-container');
    if (!container) return;

    const dayNames = {
        1: 'Maandag', 2: 'Dinsdag', 3: 'Woensdag',
        4: 'Donderdag', 5: 'Vrijdag', 6: 'Zaterdag', 0: 'Zondag'
    };

    // Build template options
    const templateOptions = Object.keys(DataStore.settings.shiftTemplates).map(templateId => {
        const template = DataStore.settings.shiftTemplates[templateId];
        return `<option value="${templateId}">${escapeHtml(template.name)} (${template.start}-${template.end})</option>`;
    }).join('');

    function generateWeekHTML(weekNumber, days) {
        let html = `<div class="week-content ${weekNumber === 1 ? 'active' : ''}" data-week="${weekNumber}">`;

        days.forEach(dayNum => {
            html += `
            <div class="week-schedule-day">
                <label class="week-schedule-label">
                    <input type="checkbox" class="week-schedule-enabled" data-week="${weekNumber}" data-day="${dayNum}">
                    <span class="day-name">${dayNames[dayNum]}</span>
                </label>
                <select class="week-schedule-template" data-week="${weekNumber}" data-day="${dayNum}" disabled>
                    <option value="">-- Kies template --</option>
                    ${templateOptions}
                    <option value="custom">Aangepast...</option>
                </select>
                <div class="week-schedule-times">
                    <input type="time" class="week-schedule-start" data-week="${weekNumber}" data-day="${dayNum}" disabled>
                    <span class="time-separator">-</span>
                    <input type="time" class="week-schedule-end" data-week="${weekNumber}" data-day="${dayNum}" disabled>
                </div>
            </div>`;
        });

        html += '</div>';
        return html;
    }

    // Dynamisch: genereer HTML voor elke week in de cyclus
    const cycleLen = getCycleLength();
    let weeksHtml = '';
    for (let w = 1; w <= cycleLen; w++) {
        const openDays = getOpenDaysForWeek(w);
        weeksHtml += generateWeekHTML(w, openDays);
    }
    container.innerHTML = weeksHtml;

    // Add event listeners
    setupWeekScheduleListeners();
}

function setupWeekScheduleListeners() {
    // Checkbox listeners
    document.querySelectorAll('.week-schedule-enabled').forEach(checkbox => {
        checkbox.addEventListener('change', () => toggleWeekScheduleDay(checkbox));
    });

    // Template select listeners
    document.querySelectorAll('.week-schedule-template').forEach(select => {
        select.addEventListener('change', () => applyTemplate(select));
    });
}

function applyTemplate(templateSelect) {
    const weekNumber = templateSelect.dataset.week;
    const dayOfWeek = templateSelect.dataset.day;
    const templateId = templateSelect.value;

    const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
    const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);

    if (templateId && templateId !== 'custom') {
        const template = DataStore.settings.shiftTemplates[templateId];
        if (template) {
            startInput.value = template.start;
            endInput.value = template.end;
            startInput.readOnly = true;
            endInput.readOnly = true;
        }
    } else {
        // Custom - allow manual input
        startInput.readOnly = false;
        endInput.readOnly = false;
    }
}

function resetWeekScheduleForm() {
    document.querySelectorAll('.week-schedule-enabled').forEach(checkbox => {
        checkbox.checked = false;
        toggleWeekScheduleDay(checkbox);
    });
}

function loadWeekScheduleForm(weekNumber, weekSchedule) {
    // Reset only the specific week
    document.querySelectorAll(`.week-schedule-enabled[data-week="${weekNumber}"]`).forEach(checkbox => {
        checkbox.checked = false;
        toggleWeekScheduleDay(checkbox);
    });

    weekSchedule.forEach(schedule => {
        const checkbox = document.querySelector(`.week-schedule-enabled[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);
        const templateSelect = document.querySelector(`.week-schedule-template[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);
        const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);
        const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${schedule.dayOfWeek}"]`);

        if (checkbox && schedule.enabled) {
            checkbox.checked = true;
            templateSelect.disabled = false;
            startInput.disabled = false;
            endInput.disabled = false;

            startInput.value = schedule.startTime;
            endInput.value = schedule.endTime;

            // Try to match a template
            const matchedTemplate = Object.keys(DataStore.settings.shiftTemplates).find(tid => {
                const t = DataStore.settings.shiftTemplates[tid];
                return t.start === schedule.startTime && t.end === schedule.endTime;
            });
            templateSelect.value = matchedTemplate || 'custom';

            if (matchedTemplate) {
                startInput.readOnly = true;
                endInput.readOnly = true;
            }
        }
    });
}

function getWeekScheduleFromForm(weekNumber) {
    const weekSchedule = [];

    document.querySelectorAll(`.week-schedule-enabled[data-week="${weekNumber}"]`).forEach(checkbox => {
        const dayOfWeek = parseInt(checkbox.dataset.day);
        const enabled = checkbox.checked;

        if (enabled) {
            const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
            const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);

            weekSchedule.push({
                dayOfWeek: dayOfWeek,
                enabled: true,
                startTime: startInput.value,
                endTime: endInput.value
            });
        }
    });

    return weekSchedule;
}

function toggleWeekScheduleDay(checkbox) {
    const weekNumber = checkbox.dataset.week;
    const dayOfWeek = checkbox.dataset.day;
    const enabled = checkbox.checked;

    const templateSelect = document.querySelector(`.week-schedule-template[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
    const startInput = document.querySelector(`.week-schedule-start[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);
    const endInput = document.querySelector(`.week-schedule-end[data-week="${weekNumber}"][data-day="${dayOfWeek}"]`);

    templateSelect.disabled = !enabled;
    startInput.disabled = !enabled;
    endInput.disabled = !enabled;

    if (!enabled) {
        templateSelect.value = '';
        startInput.value = '';
        endInput.value = '';
        startInput.readOnly = false;
        endInput.readOnly = false;
    }
}

function switchWeekTab(weekNumber) {
    // Update tabs
    document.querySelectorAll('.week-tab').forEach(tab => {
        tab.classList.toggle('active', parseInt(tab.dataset.week) === weekNumber);
    });

    // Update content
    document.querySelectorAll('.week-content').forEach(content => {
        content.classList.toggle('active', parseInt(content.dataset.week) === weekNumber);
    });
}

