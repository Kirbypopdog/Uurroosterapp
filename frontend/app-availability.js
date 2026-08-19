// HET VLOT ROOSTERPLANNING - AFWEZIGHEID TAB EN MODAL

function renderAvailability() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const role = getEffectiveRole();
    let employees = getAllEmployees(true);
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

    const absenceLabels = {
        'verlof': 'Verlof',
        'ziek': 'Ziekte',
        'overuren': 'Overuren',
        'vorming': 'Vorming',
        'andere': 'Andere',
        'vrij': 'Vrij'
    };

    // Group employees by team (same order as Timeline)
    let teamOrder = getTeamOrder();
    // Medewerker only sees own team
    if (role === 'medewerker') {
        const userTeam = AppState.currentUser?.team_id
            || employees.find(emp => emp.user_id === AppState.currentUser?.id)?.mainTeam
            || employees.find(emp => emp.email && emp.email.toLowerCase() === String(AppState.currentUser?.email || '').toLowerCase())?.mainTeam;
        if (userTeam) {
            teamOrder = teamOrder.filter(teamId => teamId === userTeam);
            employees = employees.filter(emp => emp.mainTeam === userTeam);
        } else {
            teamOrder = [];
            employees = [];
        }
    }
    const employeesByTeam = {};
    teamOrder.forEach(team => {
        employeesByTeam[team] = employees.filter(emp => emp.mainTeam === team);
    });

    let html = `
        <div class="planning-controls">
            <div class="planning-controls-row">
                <div class="date-navigation">
                    <button id="availability-prev-week" class="nav-arrow-btn" aria-label="Vorige week">${IconHelper.html(ICONS.left, 'sm')}</button>
                    <button id="availability-today" class="btn btn-secondary btn-sm">Vandaag</button>
                    <button id="availability-next-week" class="nav-arrow-btn" aria-label="Volgende week">${IconHelper.html(ICONS.right, 'sm')}</button>
                </div>
                <div class="period-display">${formatDate(weekDates[0])} – ${formatDate(weekDates[6])}</div>
                <div class="controls-spacer"></div>
                <div class="availability-legend-inline">
                    <span class="legend-chip available">Beschikbaar</span>
                    <span class="legend-chip absent">Afwezig</span>
                    <span class="legend-chip has-shift">Dienst</span>
                </div>
                <button id="add-absence-btn" class="btn-add-absence">+ Afwezigheid</button>
            </div>
        </div>

        <!-- Mobile day navigation for availability -->
        <div id="availability-mobile-day-nav" class="mobile-day-nav availability-mobile-nav">
            <button id="availability-mobile-prev-day" class="btn btn-sm">${IconHelper.html(ICONS.left, 'sm')}</button>
            <div id="availability-mobile-day-display" class="mobile-day-display">
                ${getAvailabilityMobileDayDisplayHTML()}
            </div>
            <button id="availability-mobile-next-day" class="btn btn-sm">${IconHelper.html(ICONS.right, 'sm')}</button>
        </div>

        <div class="availability-container" data-mobile-day="${AppState.availabilityMobileDayIndex}">
            <div class="availability-table">
                <div class="availability-header-row">
                    <div class="availability-employee-col">Medewerker</div>
    `;

    // Header with days
    const todayStr = formatDateYYYYMMDD(new Date());
    weekDates.forEach((date, index) => {
        const d = parseDateOnly(date);
        const dayOfWeek = d.getDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isClosed = isDayClosed(date);
        let dayClass = 'availability-day-col';
        if (date === todayStr) dayClass += ' today';
        if (isClosed) dayClass += ' closed';
        else if (isWeekend) dayClass += ' weekend';

        html += `<div class="${dayClass}">
            <span class="day-name">${dayNames[index]}</span>
            <span class="day-date">${d.getDate()}/${d.getMonth() + 1}</span>
        </div>`;
    });

    html += `</div>`; // End header row

    // Rows grouped by team
    teamOrder.forEach(teamId => {
        const teamEmployees = employeesByTeam[teamId];
        if (teamEmployees.length === 0) return;

        const teamName = escapeHtml(DataStore.settings.teams[teamId]?.name || teamId);
        const teamColor = DataStore.settings.teams[teamId]?.color || '#8d897c';

        // Team header (rustige stijl met team-kleur-dot, consistent met planning/medewerkers)
        html += `<div class="availability-team-header">
            <span class="team-header-dot" style="background:${teamColor}"></span>
            <span class="team-name">${teamName}</span>
            <span class="team-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</span>
        </div>`;

        // Employee rows for this team
        teamEmployees.forEach(emp => {
            const isCurrentUser = emp.id === AppState.currentUser?.id;
            const initials = escapeHtml(getInitials(emp.name || ''));
            html += `<div class="availability-employee-row${isCurrentUser ? ' current-user' : ''}">
                <div class="availability-employee-col">
                    <span class="emp-avatar" style="background:${teamColor}">${initials}</span>
                    <span class="emp-name">${escapeHtml(emp.name)}</span>
                </div>
            `;

            // Days for this employee
            weekDates.forEach(date => {
                const d = parseDateOnly(date);
                const dayOfWeek = d.getDay();
                const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                const isClosed = isDayClosed(date);

                const absence = getAvailability(emp.id, date);
                const hasShift = getShiftsByEmployee(emp.id, date, date).length > 0;

                // Check of medewerker normaal werkt op deze dag volgens basisrooster
                const weekNumber = getWeekNumber(date);
                const weekSchedule = getEmployeeWeekSchedule(emp, weekNumber);
                const scheduledForDay = weekSchedule && weekSchedule.find(s => s.dayOfWeek === dayOfWeek && s.enabled);
                const hasWeekSchedule = hasAnyWeekSchedule(emp);

                let cellClass = 'availability-day-col';
                if (isClosed) cellClass += ' closed';
                else if (isWeekend) cellClass += ' weekend';

                let statusClass = '';
                let statusText = '';
                let tooltipText = '';
                let hasConflict = false;

                if (!isClosed) {
                    // Afwezigheid heeft prioriteit
                    if (absence && absence.type) {
                        statusClass = 'absent';
                        statusText = absenceLabels[absence.type] || 'Afwezig';
                        tooltipText = absence.reason ? `${statusText}: ${absence.reason}` : statusText;

                        // Check voor conflict met dienst
                        if (hasShift) {
                            hasConflict = true;
                            statusClass = 'absent conflict';
                            tooltipText = `CONFLICT: ${statusText} maar heeft nog dienst ingepland!`;
                        }
                    } else if (hasShift) {
                        statusClass = 'has-shift';
                        statusText = 'Dienst';
                        tooltipText = 'Heeft dienst ingepland';
                    } else if (hasWeekSchedule && !scheduledForDay) {
                        // Medewerker heeft een weekrooster maar werkt niet op deze dag
                        statusClass = 'not-scheduled';
                        statusText = 'Vrij';
                        tooltipText = 'Niet ingepland volgens basisrooster';
                    } else {
                        statusClass = 'available';
                        statusText = '';
                        tooltipText = canManageAvailability(emp.id) ? 'Beschikbaar - klik om afwezigheid te registreren' : '';
                    }
                }

                const conflictIcon = hasConflict ? `<span class="conflict-icon">${IconHelper.html(ICONS.warning, 'xs')}</span>` : '';
                const canEdit = canManageAvailability(emp.id);
                const cellContent = !isClosed ? `
                    <div class="availability-cell-content ${statusClass}${canEdit ? '' : ' readonly-cell'}"
                         data-employee-id="${emp.id}"
                         data-date="${date}"
                         title="${escapeHtml(tooltipText)}">
                        ${conflictIcon}${statusText ? `<span class="status-label">${escapeHtml(statusText)}</span>` : `<span class="status-check">${IconHelper.html(ICONS.check, 'xs')}</span>`}
                    </div>
                ` : '';

                html += `<div class="${cellClass}">${cellContent}</div>`;
            });

            html += `</div>`; // End employee row
        });
    });

    html += `</div></div>`; // End table and container

    DOM.availabilityView.querySelector('#availability-content').innerHTML = html;
    IconHelper.init(DOM.availabilityView.querySelector('#availability-content'));

    // Add event listeners for navigation
    document.getElementById('availability-prev-week').addEventListener('click', () => {
        AppState.currentWeekStart.setDate(AppState.currentWeekStart.getDate() - 7);
        updateShiftRefreshRange();
        renderAvailability();
    });

    document.getElementById('availability-next-week').addEventListener('click', () => {
        AppState.currentWeekStart.setDate(AppState.currentWeekStart.getDate() + 7);
        updateShiftRefreshRange();
        renderAvailability();
    });

    document.getElementById('availability-today').addEventListener('click', () => {
        AppState.currentWeekStart = getMonday(new Date());
        // Also set mobile day to today
        const today = new Date();
        const dayOfWeek = today.getDay();
        AppState.availabilityMobileDayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        updateShiftRefreshRange();
        renderAvailability();
    });

    // Mobile day navigation for availability
    const availMobilePrev = document.getElementById('availability-mobile-prev-day');
    const availMobileNext = document.getElementById('availability-mobile-next-day');
    const availMobileDayDisplay = document.getElementById('availability-mobile-day-display');

    if (availMobilePrev) {
        availMobilePrev.addEventListener('click', () => changeAvailabilityMobileDay(-1));
    }
    if (availMobileNext) {
        availMobileNext.addEventListener('click', () => changeAvailabilityMobileDay(1));
    }
    if (availMobileDayDisplay) {
        availMobileDayDisplay.addEventListener('click', () => {
            const picker = document.getElementById('availability-mobile-date-picker');
            if (picker) {
                if (picker.showPicker) {
                    picker.showPicker();
                } else {
                    picker.click();
                    picker.focus();
                }
            }
        });
    }

    // Date picker for availability
    const availDatePicker = document.getElementById('availability-mobile-date-picker');
    if (availDatePicker) {
        availDatePicker.addEventListener('change', (e) => {
            const selectedDate = new Date(e.target.value);
            if (!isNaN(selectedDate.getTime())) {
                jumpToAvailabilityDate(selectedDate);
            }
        });
    }

    // Add absence button
    document.getElementById('add-absence-btn').addEventListener('click', () => {
        openAvailabilityModal();
    });

    // Event delegation for cell clicks
    document.querySelectorAll('.availability-cell-content').forEach(cell => {
        cell.addEventListener('click', () => {
            const empId = Number(cell.dataset.employeeId);
            const date = cell.dataset.date;
            if (!canManageAvailability(empId)) return;
            openAvailabilityModal(empId, date);
        });
    });
}


// ===== AFWEZIGHEID MODAL =====

function setupAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    const closeBtn = document.getElementById('availability-modal-close');
    const cancelBtn = document.getElementById('availability-cancel-btn');
    const saveBtn = document.getElementById('availability-save-btn');
    const removeBtn = document.getElementById('remove-absence-btn');
    const startDateInput = document.getElementById('absence-start-date');
    const endDateInput = document.getElementById('absence-end-date');

    if (!modal || !closeBtn || !cancelBtn || !saveBtn) return;

    closeBtn.addEventListener('click', closeAvailabilityModal);
    cancelBtn.addEventListener('click', closeAvailabilityModal);
    saveBtn.addEventListener('click', handleAvailabilitySave);
    if (removeBtn) removeBtn.addEventListener('click', handleRemoveAbsence);

    // Update conflict info when any relevant field changes
    if (startDateInput) startDateInput.addEventListener('change', updateAbsenceDateInfo);
    endDateInput.addEventListener('change', updateAbsenceDateInfo);
    const employeeSelect = document.getElementById('absence-employee');
    const absenceTypeSelect = document.getElementById('absence-type');
    if (employeeSelect) employeeSelect.addEventListener('change', updateAbsenceDateInfo);
    if (absenceTypeSelect) absenceTypeSelect.addEventListener('change', updateAbsenceDateInfo);
}

function updateAbsenceDateInfo() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;
    const absenceType = document.getElementById('absence-type').value;
    const infoDiv = document.getElementById('absence-date-info');
    const conflictDiv = document.getElementById('absence-conflict-info');
    const takeoverToggle = document.getElementById('absence-takeover-toggle');

    if (conflictDiv) conflictDiv.innerHTML = '';
    if (takeoverToggle) takeoverToggle.classList.add('hidden');

    if (startDate && endDate) {
        const start = parseDateOnly(startDate);
        const end = parseDateOnly(endDate);

        if (end >= start) {
            const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
            infoDiv.innerHTML = `<span class="info-badge">${days} dag${days !== 1 ? 'en' : ''} geselecteerd</span>`;
            infoDiv.classList.remove('error');

            // Inline conflict detection
            if (employeeId && conflictDiv) {
                const conflictDates = [];
                const startParts = startDate.split('-').map(Number);
                const endParts = endDate.split('-').map(Number);
                let checkDate = new Date(startParts[0], startParts[1] - 1, startParts[2]);
                const endDateObj = new Date(endParts[0], endParts[1] - 1, endParts[2]);
                while (checkDate <= endDateObj) {
                    const dateStr = formatDateYYYYMMDD(checkDate);
                    if (getShiftsByEmployee(employeeId, dateStr, dateStr).length > 0) conflictDates.push(dateStr);
                    checkDate.setDate(checkDate.getDate() + 1);
                }

                if (conflictDates.length > 0) {
                    conflictDiv.innerHTML = `<div class="absence-conflict-alert">
                        ${IconHelper.html('alert-triangle', 'sm')}
                        <span>${conflictDates.length} shift${conflictDates.length !== 1 ? 's' : ''} ingepland op deze dag${conflictDates.length !== 1 ? 'en' : ''} — ${conflictDates.map(d => formatDate(d)).join(', ')}</span>
                    </div>`;
                    IconHelper.init(conflictDiv);

                    if (takeoverToggle && (absenceType === 'ziek' || absenceType === 'verlof')) {
                        takeoverToggle.classList.remove('hidden');
                    }
                }
            }
        } else {
            infoDiv.innerHTML = `<span class="error-text">Einddatum moet na startdatum liggen</span>`;
            infoDiv.classList.add('error');
        }
    } else {
        infoDiv.innerHTML = '';
    }
}

function populateAbsenceEmployeeDropdown() {
    const select = document.getElementById('absence-employee');
    const employees = getAllEmployees(true);

    select.innerHTML = '<option value="">-- Selecteer medewerker --</option>';

    // Group by team
    const teamOrder = getTeamOrder();
    teamOrder.forEach(teamId => {
        const teamEmployees = employees.filter(emp => emp.mainTeam === teamId);
        if (teamEmployees.length > 0) {
            const teamName = DataStore.settings.teams[teamId]?.name || teamId;
            const optgroup = document.createElement('optgroup');
            optgroup.label = teamName;

            teamEmployees.forEach(emp => {
                const option = document.createElement('option');
                option.value = emp.id;
                option.textContent = emp.name;
                optgroup.appendChild(option);
            });

            select.appendChild(optgroup);
        }
    });

    // Medewerkers mogen enkel zichzelf selecteren
    const role = getEffectiveRole();
    if (role === 'medewerker') {
        select.value = AppState.currentUser.id;
        select.disabled = true;
    } else {
        select.disabled = false;
    }
}

function openAvailabilityModal(employeeId = null, date = null) {
    const modal = document.getElementById('availability-modal');
    if (!modal) return;

    const modalTitle = document.getElementById('availability-modal-title');
    const employeeSelect = document.getElementById('absence-employee');
    const startDateInput = document.getElementById('absence-start-date');
    const endDateInput = document.getElementById('absence-end-date');
    const absenceTypeSelect = document.getElementById('absence-type');
    const reasonInput = document.getElementById('availability-reason');
    const removeBtn = document.getElementById('remove-absence-btn');
    const warningDiv = document.getElementById('availability-warning');
    const infoDiv = document.getElementById('absence-date-info');

    // Populate employee dropdown
    populateAbsenceEmployeeDropdown();

    // Check if opening for specific employee/date or general
    if (employeeId && date) {
        const employee = getEmployee(employeeId);
        if (!employee) return;

        modalTitle.textContent = 'Afwezigheid registreren';
        employeeSelect.value = employeeId;
        startDateInput.value = date;
        endDateInput.value = date;

        const absence = getAvailability(employeeId, date);
        const hasShift = getShiftsByEmployee(employeeId, date, date).length > 0;

        // Pre-fill form if absence exists
        if (absence && absence.type) {
            absenceTypeSelect.value = absence.type;
            reasonInput.value = absence.reason || '';
            removeBtn.classList.remove('hidden');
            modal.dataset.editMode = 'single';
            modal.dataset.originalDate = date;
        } else {
            absenceTypeSelect.value = '';
            reasonInput.value = '';
            removeBtn.classList.add('hidden');
            modal.dataset.editMode = 'new';
        }

        // Show warning if employee has shift
        if (hasShift) {
            warningDiv.innerHTML = `<div class="alert alert-warning">${IconHelper.html(ICONS.warning, 'sm')} Deze medewerker heeft al een dienst op deze dag</div>`;
            IconHelper.init(warningDiv);
        } else {
            warningDiv.innerHTML = '';
        }
    } else {
        // Opening fresh (e.g., from button)
        modalTitle.textContent = 'Afwezigheid registreren';
        employeeSelect.value = '';
        startDateInput.value = '';
        endDateInput.value = '';
        absenceTypeSelect.value = '';
        reasonInput.value = '';
        removeBtn.classList.add('hidden');
        warningDiv.innerHTML = '';
        modal.dataset.editMode = 'new';
    }

    infoDiv.innerHTML = '';
    updateAbsenceDateInfo();

    modal.classList.remove('hidden');
}

function closeAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    modal.classList.add('hidden');
}

async function handleAvailabilitySave() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;
    const absenceType = document.getElementById('absence-type').value;
    const reason = document.getElementById('availability-reason').value.trim();

    // Validation
    if (!employeeId) {
        showToast('Selecteer een medewerker', 'warning');
        return;
    }
    if (!startDate || !endDate) {
        showToast('Vul beide datums in', 'warning');
        return;
    }
    if (!absenceType) {
        showToast('Selecteer een type afwezigheid', 'warning');
        return;
    }

    // Simple string comparison works for YYYY-MM-DD format
    if (endDate < startDate) {
        showToast('Einddatum moet na startdatum liggen', 'warning');
        return;
    }

    try {
        // Check for conflicts first
        let conflictDates = [];
        // Use string dates to avoid timezone conversion issues
        const startParts = startDate.split('-').map(Number);
        const endParts = endDate.split('-').map(Number);
        let checkDate = new Date(startParts[0], startParts[1] - 1, startParts[2]);
        const endDateObj = new Date(endParts[0], endParts[1] - 1, endParts[2]);

        while (checkDate <= endDateObj) {
            // Format as YYYY-MM-DD without timezone conversion
            const year = checkDate.getFullYear();
            const month = String(checkDate.getMonth() + 1).padStart(2, '0');
            const day = String(checkDate.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;

            const shifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
            if (shifts.length > 0) {
                conflictDates.push(dateStr);
            }
            checkDate.setDate(checkDate.getDate() + 1);
        }

        // Read takeover preference from inline checkbox (no confirm dialogs needed)
        const offerTakeoverCheckbox = document.getElementById('absence-offer-takeover');
        const createTakeoverRequests =
            conflictDates.length > 0 &&
            (absenceType === 'ziek' || absenceType === 'verlof') &&
            offerTakeoverCheckbox?.checked === true;

        showSectionLoading('availability-view', 'Afwezigheid opslaan...');

        // Single atomic API call: availability + optional takeover requests
        const result = await saveBulkAvailabilityWithTakeover(
            employeeId, startDate, endDate, absenceType, reason, createTakeoverRequests
        );

        closeAvailabilityModal();
        renderAvailability();
        renderPlanning(); // Update planning view to show conflicts

        const employee = getEmployee(employeeId);
        const employeeName = employee?.name || 'de medewerker';
        const daysSet = result.availability?.length || 0;
        const typeName = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezigheid', 'vrij': 'Vrij' }[absenceType] || 'Afwezigheid';

        let msg = `${typeName} geregistreerd voor ${employeeName} (${daysSet} dag${daysSet !== 1 ? 'en' : ''})`;
        if (result.takeoverRequests > 0) {
            msg += ` — ${result.takeoverRequests} shift${result.takeoverRequests !== 1 ? 's' : ''} aangeboden voor overname`;
        }
        showToast(msg, 'success');

        if (absenceType === 'ziek') {
            showToast('Vergeet niet de personeelsdienst te verwittigen', 'info');
        } else if (absenceType === 'verlof' || absenceType === 'overuren') {
            showToast('Vergeet niet dit ook in Eureka aan te passen', 'info');
        }
    } catch (error) {
        console.error('Error saving availability:', error);
        showToast('Er ging iets mis bij het opslaan: ' + error.message, 'error');
    } finally {
        hideSectionLoading('availability-view');
    }
}

async function handleRemoveAbsence() {
    const employeeId = Number(document.getElementById('absence-employee').value);
    const startDate = document.getElementById('absence-start-date').value;
    const endDate = document.getElementById('absence-end-date').value;

    if (!employeeId || !startDate || !endDate) {
        showToast('Geen afwezigheid om te verwijderen', 'warning');
        return;
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    if (end < start) {
        showToast('Ongeldig datumbereik', 'warning');
        return;
    }

    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    if (!await showConfirm(`Afwezigheid verwijderen voor ${days} dag${days !== 1 ? 'en' : ''}?`)) {
        return;
    }

    showSectionLoading('availability-view', 'Afwezigheid verwijderen...');

    // Remove absence for each day in range
    let currentDate = parseDateOnly(start);
    const removePromises = [];

    while (currentDate <= end) {
        const dateStr = formatDateYYYYMMDD(currentDate);
        removePromises.push(removeAvailability(employeeId, dateStr, { skipRefresh: true }));
        currentDate.setDate(currentDate.getDate() + 1);
    }

    // Wait for all deletions to complete, then refresh once
    await Promise.all(removePromises);
    await refreshAvailability();

    // Cancel any pending takeover requests for shifts on these dates
    try {
        console.log('[Auto-cancel] Starting auto-cancel for removed absence');
        console.log('[Auto-cancel] Employee ID:', employeeId);
        console.log('[Auto-cancel] Date range:', formatDateYYYYMMDD(start), 'to', formatDateYYYYMMDD(end));

        await getSwapRequests(); // Refresh swap requests
        console.log('[Auto-cancel] Total swap requests in DataStore:', DataStore.swapRequests.length);

        const affectedShifts = [];

        // Find all shifts for this employee in the date range
        let checkDate = parseDateOnly(start);
        while (checkDate <= end) {
            const dateStr = formatDateYYYYMMDD(checkDate);
            const shifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
            console.log(`[Auto-cancel] Date ${dateStr}: Found ${shifts.length} shift(s)`, shifts.map(s => ({ id: s.id, userId: s.userId })));
            affectedShifts.push(...shifts);
            checkDate.setDate(checkDate.getDate() + 1);
        }

        console.log('[Auto-cancel] Total affected shifts:', affectedShifts.length, affectedShifts.map(s => s.id));

        // Debug: Show all takeover requests for this employee
        const employeeTakeoverRequests = DataStore.swapRequests.filter(sr =>
            sr.requester_user_id === employeeId &&
            sr.request_type === 'takeover' &&
            sr.status === 'pending'
        );
        console.log('[Auto-cancel] All pending takeover requests for employee:', employeeTakeoverRequests.map(sr => ({
            id: sr.id,
            requester_shift_id: sr.requester_shift_id,
            status: sr.status
        })));

        // Find and cancel pending takeover requests for these shifts
        const requestsToCancel = DataStore.swapRequests.filter(sr =>
            sr.request_type === 'takeover' &&
            sr.status === 'pending' &&
            sr.requester_user_id === employeeId &&
            affectedShifts.some(shift => shift.id === sr.requester_shift_id)
        );

        console.log('[Auto-cancel] Pending takeover requests for this employee:', DataStore.swapRequests.filter(sr => sr.requester_user_id === employeeId && sr.request_type === 'takeover').length);
        console.log('[Auto-cancel] Requests to cancel:', requestsToCancel.length, requestsToCancel.map(sr => ({ id: sr.id, shiftId: sr.requester_shift_id })));

        if (requestsToCancel.length > 0) {
            const cancelPromises = requestsToCancel.map(sr => {
                console.log(`[Auto-cancel] Cancelling request ${sr.id} for shift ${sr.requester_shift_id}...`);
                return cancelSwapRequest(sr.id)
                    .then(() => console.log(`[Auto-cancel] ✓ Cancelled request ${sr.id}`))
                    .catch(err => {
                        console.error(`[Auto-cancel] ✗ Failed to cancel request ${sr.id}:`, err);
                    });
            });
            await Promise.all(cancelPromises);

            console.log(`[Auto-cancel] Complete: ${requestsToCancel.length} takeover request(s) cancelled`);
        } else {
            console.log('[Auto-cancel] No requests to cancel');
        }
    } catch (error) {
        console.error('[Auto-cancel] Error cancelling takeover requests:', error);
        // Don't block the flow if cancellation fails
    }

    closeAvailabilityModal();
    renderAvailability();
    renderPlanning(); // Update planning view
    hideSectionLoading('availability-view');
}

