// HET VLOT ROOSTERPLANNING - SHIFT MODAL EN HANDLERS

function renderShiftCard(shift) {
    const employee = getEmployee(shift.employeeId);
    if (!employee) return '';
    const validation = validateShift(shift, shift.id);
    const availability = getAvailability(shift.employeeId, shift.date);

    let cardClass = `shift-card team-${shift.team}`;
    if (!validation.isValid) {
        cardClass += ' shift-error';
    } else if (validation.hasWarnings) {
        cardClass += ' shift-warning';
    }

    const [startHour] = shift.startTime.split(':').map(Number);
    const [endHour] = shift.endTime.split(':').map(Number);
    if (endHour < startHour) {
        cardClass += ' shift-nacht';
    }

    // Check availability indicator
    let availabilityIcon = '';
    if (availability && !availability.available) {
        const reason = escapeHtml(availability.reason || 'Geen reden opgegeven');
        availabilityIcon = `<span class="shift-availability-indicator unavailable" title="Medewerker niet beschikbaar: ${reason}">${IconHelper.html(ICONS.warning, 'xs')}</span>`;
    } else if (availability && availability.shiftTypes && availability.shiftTypes.length > 0) {
        // Check if shift matches availability
        let shiftType = null;
        if (startHour >= 7 && startHour < 16) shiftType = 'vroeg';
        else if (startHour >= 16 && startHour < 23) shiftType = 'laat';
        else if (startHour >= 23 || startHour < 9) shiftType = 'nacht';

        if (shiftType && !availability.shiftTypes.includes(shiftType)) {
            const shiftTypes = escapeHtml(availability.shiftTypes.join(', '));
            availabilityIcon = `<span class="shift-availability-indicator partial" title="Alleen beschikbaar voor: ${shiftTypes}">${IconHelper.html(ICONS.zap, 'xs')}</span>`;
        }
    }

    // Activity count for card view
    const activities = getActivitiesByEmployee(shift.employeeId, shift.date);
    const activityBadge = activities.length > 0
        ? `<span class="activity-count-badge" title="${activities.map(a => a.type).join(', ')}">${IconHelper.html('calendar-plus', 'xs')} ${activities.length}</span>`
        : '';

    const employeeName = escapeHtml(employee.name);
    return `<div class="${cardClass}" data-shift-id="${shift.id}">
        <div class="shift-employee-name">${employeeName}${availabilityIcon}</div>
        <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
        <div class="shift-card-footer">
            <span class="shift-team-badge team-${shift.team}">${escapeHtml(DataStore.settings.teams?.[shift.team]?.name || shift.team || 'Onbekend')}</span>
            ${activityBadge}
            ${hasPermission('MANAGE_SHIFTS') ? `<button class="shift-delete-btn" data-shift-id="${shift.id}">${IconHelper.html(ICONS.close, 'xs')}</button>` : ''}
        </div>
    </div>`;
}

function populateShiftTemplateDropdown() {
    const sel = DOM.shiftTemplate;
    if (!sel) return;
    const templates = DataStore.settings.shiftTemplates || {};
    sel.innerHTML = '<option value="">-- Kies template --</option>';
    Object.entries(templates).forEach(([key, t]) => {
        const label = t.name || key;
        const times = ` (${t.start}–${t.end})`;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = label + times;
        sel.appendChild(opt);
    });
}

function openAddShiftModal() {
    AppState.editingShiftId = null;
    DOM.shiftModalTitle.textContent = 'Dienst toevoegen';
    DOM.shiftForm.reset();
    DOM.shiftValidationErrors.innerHTML = '';
    DOM.shiftDate.value = formatDateYYYYMMDD(new Date());
    DOM.shiftDeleteBtn.classList.add('hidden');
    populateShiftTemplateDropdown();

    // Populate dropdown with filtered employees
    populateEmployeeDropdown();

    // Auto-select current user for medewerkers and disable dropdown
    const currentRole = getEffectiveRole();
    if (currentRole === 'medewerker') {
        DOM.shiftEmployee.value = AppState.currentUser.id;
        DOM.shiftEmployee.disabled = true;
        DOM.shiftEmployee.classList.add('readonly');
    } else {
        DOM.shiftEmployee.disabled = false;
        DOM.shiftEmployee.classList.remove('readonly');
    }

    // Show submit button, hide delete button
    DOM.shiftSubmitBtn.classList.remove('hidden');
    resetShiftSubmitBtn();

    DOM.shiftModal.classList.remove('hidden');
}

function openAddShiftForEmployee(employeeId, date) {
    AppState.editingShiftId = null;
    DOM.shiftModalTitle.textContent = 'Dienst toevoegen';
    DOM.shiftForm.reset();
    DOM.shiftValidationErrors.innerHTML = '';
    DOM.shiftDate.value = date;
    DOM.shiftDeleteBtn.classList.add('hidden');
    populateEmployeeDropdown();
    DOM.shiftEmployee.value = employeeId;
    DOM.shiftModal.classList.remove('hidden');
}

function canUserEditShift(shift) {
    if (!shift || !AppState.currentUser) {
        return false;
    }

    const currentRole = getEffectiveRole();
    const currentUserId = AppState.currentUser.id;
    const isOwnShift = shift.employeeId === currentUserId || shift.userId === currentUserId;

    if (currentRole === 'admin' || currentRole === 'roosterverantwoordelijke') {
        return true;
    } else if (currentRole === 'medewerker') {
        return isOwnShift;
    }

    return false;
}

function canUserTransferShift(shift) {
    // Only admin and roosterverantwoordelijke can transfer shifts between employees
    if (!shift || !AppState.currentUser) {
        return false;
    }

    const currentRole = getEffectiveRole();

    if (currentRole === 'admin' || currentRole === 'roosterverantwoordelijke') {
        return true;
    }

    return false;
}

function openEditShiftModal(shiftId) {
    const shift = getShift(shiftId);
    if (!shift) return;

    const canEdit = canUserEditShift(shift);

    // Open modal in view or edit mode
    openShiftModal(shift, canEdit);
}

function openShiftModal(shift, canEdit) {
    AppState.editingShiftId = shift.id;

    // Set modal title
    DOM.shiftModalTitle.textContent = canEdit ? 'Dienst bewerken' : 'Dienst bekijken';

    // Populate dropdowns
    populateEmployeeDropdown();
    populateShiftTemplateDropdown();

    // Fill form with shift data
    DOM.shiftEmployee.value = shift.employeeId;
    DOM.shiftTeam.value = shift.team;
    DOM.shiftDate.value = shift.date;
    DOM.shiftStart.value = shift.startTime;
    DOM.shiftEnd.value = shift.endTime;
    DOM.shiftNotes.value = shift.notes || '';
    const reserveCheckbox = document.getElementById('shift-is-reserve');
    if (reserveCheckbox) reserveCheckbox.checked = !!shift.isReserve;

    // Disable/enable form fields based on permissions
    const formFields = [
        DOM.shiftEmployee,
        DOM.shiftTeam,
        DOM.shiftDate,
        DOM.shiftStart,
        DOM.shiftEnd,
        DOM.shiftNotes
    ];

    formFields.forEach(field => {
        if (canEdit) {
            field.disabled = false;
            field.classList.remove('readonly');
        } else {
            field.disabled = true;
            field.classList.add('readonly');
        }
    });

    // Show/hide action buttons
    DOM.shiftSubmitBtn.classList.toggle('hidden', !canEdit);
    DOM.shiftDeleteBtn.classList.toggle('hidden', !canEdit);
    resetShiftSubmitBtn();

    // Add combined "Shift afstaan" button if user can request swap
    const existingAfstaanBtn = document.getElementById('shift-afstaan-btn');
    if (existingAfstaanBtn) existingAfstaanBtn.remove();

    if (canRequestSwap(shift)) {
        const afstaanBtn = document.createElement('button');
        afstaanBtn.type = 'button';
        afstaanBtn.id = 'shift-afstaan-btn';
        afstaanBtn.className = 'btn btn-primary';
        afstaanBtn.textContent = 'Shift afstaan';
        afstaanBtn.style.marginRight = 'auto';
        afstaanBtn.addEventListener('click', () => {
            closeShiftModal();
            openShiftAfstaanChoiceModal(shift);
        });

        // Insert before submit button
        const modalActions = DOM.shiftSubmitBtn.parentElement;
        modalActions.insertBefore(afstaanBtn, modalActions.firstChild);
    }

    // Show source info (auto vs manual)
    const isAutoShift = shift.source === 'auto';
    let sourceHtml = '';
    if (isAutoShift) {
        sourceHtml = `<div class="shift-source-info shift-source-auto">
            <span class="source-icon">${IconHelper.html(ICONS.zap, 'sm')}</span>
            <span class="source-text">Automatisch ingepland via basisrooster</span>
        </div>`;
    } else {
        sourceHtml = `<div class="shift-source-info shift-source-manual">
            <span class="source-icon">${IconHelper.html(ICONS.edit, 'sm')}</span>
            <span class="source-text">Handmatig aangepast (beschermd bij regeneratie)</span>
        </div>`;
    }

    // Show existing validation issues for this shift
    const validation = validateShift(shift, shift.id);
    const availability = getAvailability(shift.employeeId, shift.date);
    const isAbsent = availability && availability.type;

    // Show activities for this shift
    const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
    let activitiesListHtml = '';
    if (shiftActivities.length > 0 || canEdit) {
        activitiesListHtml = '<div class="shift-activities-section">';
        activitiesListHtml += `<div class="shift-activities-header"><strong>Activiteiten</strong>`;
        if (canEdit) {
            activitiesListHtml += ` <button type="button" class="btn btn-sm add-activity-btn add-activity-btn--inline" data-user-id="${shift.employeeId}" data-date="${shift.date}" data-shift-start="${shift.startTime}" data-shift-end="${shift.endTime}" data-shift-id="${shift.id}">+ Toevoegen</button>`;
        }
        activitiesListHtml += '</div>';
        if (shiftActivities.length > 0) {
            activitiesListHtml += '<div class="shift-activities-list">';
            shiftActivities.forEach(act => {
                const label = ACTIVITY_TYPE_LABELS_FULL[act.type] || act.type;
                const desc = act.description ? ` - ${escapeHtml(act.description)}` : '';
                activitiesListHtml += `<div class="shift-activity-item activity-badge activity-badge--list" data-activity-id="${act.id}">
                    <span class="activity-type-${escapeHtml(act.type)} activity-type-bar"></span>
                    <span><strong>${escapeHtml(label)}</strong> ${act.startTime.substring(0,5)}-${act.endTime.substring(0,5)}${desc}</span>
                </div>`;
            });
            activitiesListHtml += '</div>';
        }
        activitiesListHtml += '</div>';
    }

    let issuesHtml = sourceHtml + activitiesListHtml;
    if (isAbsent) {
        const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren opnemen', 'vorming': 'Vorming', 'andere': 'Afwezig' };
        const employeeName = escapeHtml(getEmployee(shift.employeeId)?.name || '');
        issuesHtml += `<div class="validation-warning absence">
            <strong>${IconHelper.html(ICONS.warning, 'sm')} Afwezigheid:</strong> ${employeeName} is afwezig (${absenceLabels[availability.type] || 'Afwezig'})
        </div>`;
    }
    if (!validation.isValid && validation.errors.length > 0) {
        issuesHtml += `<div class="validation-error">
            <strong>${IconHelper.html(ICONS.error, 'sm')} Fouten:</strong>
            <ul>${validation.errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('')}</ul>
        </div>`;
    }
    if (validation.hasWarnings && validation.warnings.length > 0) {
        issuesHtml += `<div class="validation-warning">
            <strong>${IconHelper.html(ICONS.warning, 'sm')} Waarschuwingen:</strong>
            <ul>${validation.warnings.map(w => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>
        </div>`;
    }
    DOM.shiftValidationErrors.innerHTML = issuesHtml;
    IconHelper.init(DOM.shiftValidationErrors);

    DOM.shiftModal.classList.remove('hidden');
}

function resetShiftSubmitBtn() {
    DOM.shiftSubmitBtn.textContent = 'Opslaan';
    DOM.shiftSubmitBtn.classList.remove('btn-warning');
    DOM.shiftSubmitBtn.classList.add('btn-primary');
    AppState._shiftForceOverride = false;
    AppState._shiftBackendForce = false;
}

function closeShiftModal() {
    DOM.shiftModal.classList.add('hidden');
    DOM.shiftForm.reset();
    AppState.editingShiftId = null;
    resetShiftSubmitBtn();
}

async function handleShiftDelete(shiftId = null) {
    // Check if shiftId is an event object (from modal button click) or a number (from inline button)
    const isEvent = shiftId && typeof shiftId === 'object' && 'target' in shiftId;

    // Use provided shiftId (if it's a number) or fall back to AppState.editingShiftId
    const idToDelete = (isEvent || !shiftId) ? AppState.editingShiftId : shiftId;
    if (!idToDelete) return;

    // Get shift details for confirmation message
    const shift = getShift(idToDelete);
    const shiftDescription = shift
        ? `de dienst van ${shift.employeeName || 'deze medewerker'} op ${shift.date}`
        : 'deze dienst';

    if (await showConfirm(`Weet je zeker dat je ${shiftDescription} wilt verwijderen?`, 'Dienst verwijderen', { danger: true, confirmText: 'Verwijderen' })) {
        // Wait for deletion to complete before re-rendering
        await deleteShift(idToDelete);

        // Close modal only if deleting from modal (when shiftId is event or null)
        if (isEvent || !shiftId) {
            closeShiftModal();
        }

        renderPlanning();
    }
}

// ===== SWAP REQUEST MODAL FUNCTIES =====

let swapRequestState = {
    requesterShift: null,
    targetEmployeeId: null,
    targetShiftId: null
};

function openSwapRequestModal(shift) {
    // Pre-check: are there colleagues with shifts to swap with?
    const colleagues = getAllEmployees(true).filter(emp => emp.id !== shift.userId);
    const colleagueIds = new Set(colleagues.map(c => c.id));
    const colleagueShifts = DataStore.shifts.filter(s =>
        colleagueIds.has(s.userId) || colleagueIds.has(s.user_id)
    );
    if (colleagueShifts.length === 0) {
        showToast('Geen ruilbare diensten gevonden bij collega\'s.', 'warning');
        return;
    }

    swapRequestState.requesterShift = shift;
    swapRequestState.targetEmployeeId = null;
    swapRequestState.targetShiftId = null;

    // Show requester shift preview
    const requesterPreview = document.getElementById('swap-requester-shift-preview');
    requesterPreview.innerHTML = formatShiftPreview(shift);

    // Clear target preview
    const targetPreview = document.getElementById('swap-target-shift-preview');
    targetPreview.innerHTML = '<p class="text-muted">Selecteer eerst een collega en shift</p>';

    // Populate employee dropdown (exclude current user)
    const employeeSelect = document.getElementById('swap-target-employee');
    let employees = colleagues;
    let html = '<option value="">-- Selecteer collega --</option>';
    employees.forEach(emp => {
        html += `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`;
    });
    employeeSelect.innerHTML = html;

    // Reset target shift dropdown
    const shiftSelect = document.getElementById('swap-target-shift');
    shiftSelect.innerHTML = '<option value="">-- Selecteer eerst een collega --</option>';
    shiftSelect.disabled = true;

    // Clear message and validation
    document.getElementById('swap-message').value = '';
    document.getElementById('swap-validation-display').classList.add('hidden');

    // Show modal
    document.getElementById('swap-request-modal').classList.remove('hidden');
}

function closeSwapRequestModal() {
    document.getElementById('swap-request-modal').classList.add('hidden');
    swapRequestState = { requesterShift: null, targetEmployeeId: null, targetShiftId: null };
}

function formatShiftPreview(shift) {
    const employee = getEmployee(shift.employeeId || shift.userId);
    const employeeName = employee ? escapeHtml(employee.name) : 'Onbekend';
    const team = escapeHtml(shift.team || shift.teamId || '');
    const date = formatDate(shift.date);
    const time = `${shift.startTime} - ${shift.endTime}`;

    return `
        <p><strong>Medewerker:</strong> ${employeeName}</p>
        <p><strong>Team:</strong> ${team}</p>
        <p><strong>Datum:</strong> ${date}</p>
        <p><strong>Tijd:</strong> ${time}</p>
        ${shift.notes ? `<p><strong>Notities:</strong> ${escapeHtml(shift.notes)}</p>` : ''}
    `;
}

async function handleSwapTargetEmployeeChange() {
    const employeeId = parseInt(document.getElementById('swap-target-employee').value);
    const shiftSelect = document.getElementById('swap-target-shift');

    if (!employeeId) {
        shiftSelect.innerHTML = '<option value="">-- Selecteer eerst een collega --</option>';
        shiftSelect.disabled = true;
        swapRequestState.targetEmployeeId = null;
        swapRequestState.targetShiftId = null;
        document.getElementById('swap-target-shift-preview').innerHTML = '<p class="text-muted">Selecteer eerst een collega en shift</p>';
        return;
    }

    swapRequestState.targetEmployeeId = employeeId;

    // Get shifts for this employee (future shifts only)
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const employeeShifts = DataStore.shifts
        .filter(s => s.userId === employeeId && new Date(s.date) >= now)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    if (employeeShifts.length === 0) {
        shiftSelect.innerHTML = '<option value="">Geen toekomstige shifts beschikbaar</option>';
        shiftSelect.disabled = true;
        return;
    }

    let html = '<option value="">-- Selecteer shift --</option>';
    employeeShifts.forEach(shift => {
        const dateStr = formatDate(shift.date);
        const timeStr = `${shift.startTime} - ${shift.endTime}`;
        html += `<option value="${shift.id}">${dateStr} | ${timeStr} | ${shift.team || shift.teamId}</option>`;
    });

    shiftSelect.innerHTML = html;
    shiftSelect.disabled = false;
}

function handleSwapTargetShiftChange() {
    const shiftId = parseInt(document.getElementById('swap-target-shift').value);

    if (!shiftId) {
        swapRequestState.targetShiftId = null;
        document.getElementById('swap-target-shift-preview').innerHTML = '<p class="text-muted">Selecteer een shift</p>';
        document.getElementById('swap-validation-display').classList.add('hidden');
        return;
    }

    swapRequestState.targetShiftId = shiftId;
    const targetShift = getShift(shiftId);

    if (targetShift) {
        // Show target shift preview
        document.getElementById('swap-target-shift-preview').innerHTML = formatShiftPreview(targetShift);

        // Run validation
        runSwapValidation();
    }
}

function runSwapValidation() {
    if (!swapRequestState.requesterShift || !swapRequestState.targetShiftId) {
        return;
    }

    const requesterShift = swapRequestState.requesterShift;
    const targetShift = getShift(swapRequestState.targetShiftId);

    if (!targetShift) return;

    const validation = validateSwapRequest({
        requesterShift: requesterShift,
        targetShift: targetShift,
        requesterUserId: requesterShift.userId,
        targetUserId: targetShift.userId
    });

    const validationDisplay = document.getElementById('swap-validation-display');
    validationDisplay.classList.remove('hidden');
    validationDisplay.className = '';

    if (!validation.isValid) {
        validationDisplay.classList.add('has-errors');
        validationDisplay.innerHTML = `
            <div class="validation-errors">
                <strong>${IconHelper.html(ICONS.error, 'sm')} Fouten:</strong>
                <ul>${validation.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
            </div>
        `;
    } else if (validation.hasWarnings) {
        validationDisplay.classList.add('has-warnings');
        validationDisplay.innerHTML = `
            <div class="validation-warnings">
                <strong>${IconHelper.html(ICONS.warning, 'sm')} Waarschuwingen:</strong>
                <ul>${validation.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
            </div>
            <p class="validation-hint text-warning">Je kunt dit verzoek indienen. Je collega moet het nog accepteren.</p>
        `;
    } else {
        validationDisplay.classList.add('is-valid');
        validationDisplay.innerHTML = `
            <div class="validation-success">
                <strong>${IconHelper.html(ICONS.success, 'sm')} Geen problemen gevonden</strong>
                <p class="mt-sm">Deze ruil kan worden ingediend voor goedkeuring.</p>
            </div>
        `;
    }
    IconHelper.init(validationDisplay);
}

async function handleSwapRequestSubmit() {
    if (!swapRequestState.requesterShift || !swapRequestState.targetShiftId) {
        showToast('Selecteer eerst een collega en een shift om te ruilen', 'warning');
        return;
    }

    // Get validation result
    const requesterShift = swapRequestState.requesterShift;
    const targetShift = getShift(swapRequestState.targetShiftId);

    const validation = validateSwapRequest({
        requesterShift: requesterShift,
        targetShift: targetShift,
        requesterUserId: requesterShift.userId,
        targetUserId: targetShift.userId
    });

    if (!validation.isValid) {
        showToast('Deze ruil kan niet worden ingediend vanwege fouten. Zie de validatie hierboven.', 'warning');
        return;
    }

    const message = document.getElementById('swap-message').value.trim();

    try {
        await createSwapRequest({
            requesterShiftId: requesterShift.id,
            targetShiftId: targetShift.id,
            message: message || null
        });

        showToast('Ruilverzoek succesvol ingediend', 'success');
        closeSwapRequestModal();

        // Switch to swaps view to show the new request
        switchView('swaps');
    } catch (error) {
        console.error('Error creating swap request:', error);
        showToast('Fout bij indienen ruilverzoek: ' + getUserFriendlyError(error), 'error');
    }
}

// ===== SHIFT AFSTAAN CHOICE MODAL FUNCTIES =====

let shiftAfstaanChoiceState = {
    shift: null
};

function openShiftAfstaanChoiceModal(shift) {
    shiftAfstaanChoiceState.shift = shift;
    document.getElementById('shift-afstaan-choice-modal').classList.remove('hidden');

    // Add click handlers for the choice buttons
    document.getElementById('choice-swap-btn').onclick = () => {
        closeShiftAfstaanChoiceModal();
        openSwapRequestModal(shift);
    };

    document.getElementById('choice-takeover-btn').onclick = () => {
        closeShiftAfstaanChoiceModal();
        openTakeoverRequestModal(shift);
    };
}

function closeShiftAfstaanChoiceModal() {
    document.getElementById('shift-afstaan-choice-modal').classList.add('hidden');
    shiftAfstaanChoiceState.shift = null;
}

// ===== TAKEOVER REQUEST MODAL FUNCTIES =====

let takeoverRequestState = {
    shiftToGiveAway: null
};

function openTakeoverRequestModal(shift) {
    takeoverRequestState.shiftToGiveAway = shift;

    // Get team name
    const teamName = shift.team && DataStore.settings.teams?.[shift.team]
        ? DataStore.settings.teams[shift.team].name
        : shift.team || 'Onbekend team';

    // Show shift preview
    const previewHtml = `
        <div class="shift-card">
            <div class="shift-card-header">
                <span class="shift-team">${escapeHtml(teamName)}</span>
                <span class="shift-date">${formatDate(shift.date)}</span>
            </div>
            <div class="shift-card-body">
                <div class="shift-time">${shift.startTime} - ${shift.endTime}</div>
                ${shift.notes ? `<div class="shift-notes">${escapeHtml(shift.notes)}</div>` : ''}
            </div>
        </div>
    `;
    document.getElementById('takeover-shift-preview').innerHTML = previewHtml;

    // Clear message
    document.getElementById('takeover-message').value = '';

    // Show modal
    document.getElementById('takeover-request-modal').classList.remove('hidden');
}

function closeTakeoverRequestModal() {
    document.getElementById('takeover-request-modal').classList.add('hidden');
    takeoverRequestState.shiftToGiveAway = null;
}

async function handleTakeoverRequestSubmit() {
    if (!takeoverRequestState.shiftToGiveAway) {
        showToast('Geen shift geselecteerd', 'warning');
        return;
    }

    const message = document.getElementById('takeover-message').value.trim();

    try {
        await createTakeoverRequest(takeoverRequestState.shiftToGiveAway.id, message || null);
        showToast('Verzoek succesvol ingediend! Collega\'s kunnen deze shift nu overnemen.', 'success');
        closeTakeoverRequestModal();

        // Switch to swaps view to show the new request
        switchView('swaps');
    } catch (error) {
        console.error('Error creating takeover request:', error);
        showToast('Fout bij indienen verzoek: ' + getUserFriendlyError(error), 'error');
    }
}

function populateEmployeeDropdown() {
    const currentRole = getEffectiveRole();
    const currentUserId = AppState.currentUser.id;
    const currentUserTeam = AppState.currentUser.team_id || AppState.currentUser.mainTeam;

    let employees = getAllEmployees(true);

    // Filter based on role
    if (currentRole === 'medewerker') {
        // Medewerkers can only create shifts for themselves
        employees = employees.filter(emp => emp.id === currentUserId);
    }
    // Admin and roosterverantwoordelijke see everyone (no filter)

    let html = '<option value="">-- Selecteer medewerker --</option>';
    employees.forEach(emp => {
        html += `<option value="${emp.id}">${escapeHtml(emp.name)}</option>`;
    });
    DOM.shiftEmployee.innerHTML = html;
}

function handleShiftTemplateChange() {
    const template = DOM.shiftTemplate.value;
    if (template && template !== 'custom' && DataStore.settings.shiftTemplates[template]) {
        const t = DataStore.settings.shiftTemplates[template];
        DOM.shiftStart.value = t.start;
        DOM.shiftEnd.value = t.end;
    }
}

async function handleShiftSubmit(e) {
    e.preventDefault();
    console.log('Shift submit clicked');

    // Check required fields
    if (!DOM.shiftEmployee.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Selecteer een medewerker</li></ul>';
        return;
    }
    if (!DOM.shiftTeam.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Selecteer een team</li></ul>';
        return;
    }
    if (!DOM.shiftDate.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Selecteer een datum</li></ul>';
        return;
    }
    if (!DOM.shiftStart.value || !DOM.shiftEnd.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Vul start- en eindtijd in</li></ul>';
        return;
    }
    if (DOM.shiftStart.value === DOM.shiftEnd.value) {
        DOM.shiftValidationErrors.innerHTML = '<ul><li>Begintijd en eindtijd mogen niet gelijk zijn</li></ul>';
        return;
    }

    const shiftData = {
        employeeId: parseInt(DOM.shiftEmployee.value, 10),
        team: DOM.shiftTeam.value,
        date: DOM.shiftDate.value,
        startTime: DOM.shiftStart.value,
        endTime: DOM.shiftEnd.value,
        notes: DOM.shiftNotes.value,
        isReserve: document.getElementById('shift-is-reserve')?.checked || false,
        // force=true zodra de gebruiker één keer "Toch opslaan" heeft bevestigd
        ...((AppState._shiftForceOverride || AppState._shiftBackendForce) ? { force: true } : {})
    };

    try {
        // Als de gebruiker al een backend-override heeft bevestigd, sla frontend validatie over
        if (!AppState._shiftBackendForce) {
            const validation = validateShift(shiftData, AppState.editingShiftId);

            if (!validation.isValid || validation.hasWarnings) {
                // If user already confirmed (flag set), skip validation and proceed
                if (AppState._shiftForceOverride) {
                    AppState._shiftForceOverride = false;
                    // Fall through to save
                } else {
                    // Combine errors and warnings into one overview
                    let html = '<div class="conflict-resolution">';

                    // Show errors
                    validation.errors.forEach(error => {
                        const suggestions = generateSuggestions(error, shiftData);
                        html += `<div class="conflict-item">
                            <div class="conflict-error">${escapeHtml(error.message)}</div>`;
                        if (suggestions.length > 0) {
                            html += '<div class="conflict-suggestions"><span class="suggestions-label">Suggesties:</span>';
                            suggestions.forEach(s => {
                                html += `<button type="button" class="btn btn-sm suggestion-btn"
                                    data-field="${escapeHtml(s.field)}"
                                    data-value="${s.value !== null ? escapeHtml(String(s.value)) : ''}"
                                    ${s.action ? `data-action="${escapeHtml(s.action)}"` : ''}
                                    onclick="applySuggestion(this)">${escapeHtml(s.label)}</button>`;
                            });
                            html += '</div>';
                        }
                        html += '</div>';
                    });

                    // Show warnings
                    validation.warnings.forEach(warning => {
                        html += `<div class="conflict-item">
                            <div class="conflict-warning">${escapeHtml(warning.message)}</div>
                        </div>`;
                    });

                    html += '</div>';
                    DOM.shiftValidationErrors.innerHTML = html;
                    IconHelper.init(DOM.shiftValidationErrors);

                    // Change submit button to indicate override
                    DOM.shiftSubmitBtn.textContent = 'Toch opslaan';
                    DOM.shiftSubmitBtn.classList.remove('btn-primary');
                    DOM.shiftSubmitBtn.classList.add('btn-warning');
                    AppState._shiftForceOverride = true;
                    return;
                }
            }
        }

        showSectionLoading('planning-view', 'Dienst opslaan...');
        try {
            if (AppState.editingShiftId) {
                const oldShift = getShift(AppState.editingShiftId);
                const previousData = oldShift ? { employeeId: oldShift.employeeId, team: oldShift.team, date: oldShift.date, startTime: oldShift.startTime, endTime: oldShift.endTime, notes: oldShift.notes } : null;
                await updateShift(AppState.editingShiftId, shiftData);
                UndoManager.push({ type: 'update', shiftId: AppState.editingShiftId, shiftData: { ...shiftData }, previousData });
            } else {
                const newShift = await addShift(shiftData);
                UndoManager.push({ type: 'create', shiftData: { ...shiftData }, resultId: newShift.id });
            }

            closeShiftModal();
            renderPlanning();
        } finally {
            hideSectionLoading('planning-view');
        }
    } catch (error) {
        const msg = getUserFriendlyError(error);
        // 422 = backend 11-uur validatie — geef "Toch opslaan" optie
        if (error.status === 422 || (error.message && error.message.includes('11-uur'))) {
            DOM.shiftValidationErrors.innerHTML =
                `<div class="conflict-resolution"><div class="conflict-item"><div class="conflict-warning">${escapeHtml(msg)}</div></div></div>`;
            IconHelper.init(DOM.shiftValidationErrors);
            DOM.shiftSubmitBtn.textContent = 'Toch opslaan';
            DOM.shiftSubmitBtn.classList.remove('btn-primary');
            DOM.shiftSubmitBtn.classList.add('btn-warning');
            AppState._shiftBackendForce = true;
        } else {
            AppState._shiftBackendForce = false;
            DOM.shiftValidationErrors.innerHTML = '<ul><li>Er is een fout opgetreden: ' + escapeHtml(msg) + '</li></ul>';
        }
    }
}

function applySuggestion(btn) {
    const field = btn.dataset.field;
    const value = btn.dataset.value;
    const action = btn.dataset.action;

    if (action === 'focus-employee') {
        DOM.shiftEmployee.focus();
        return;
    }

    const fieldMap = {
        startTime: DOM.shiftStart,
        endTime: DOM.shiftEnd,
        date: DOM.shiftDate,
        team: DOM.shiftTeam,
        employeeId: DOM.shiftEmployee
    };

    const el = fieldMap[field];
    if (el && value) {
        el.value = value;
        el.classList.add('suggestion-applied');
        setTimeout(() => el.classList.remove('suggestion-applied'), 1500);
    }

    DOM.shiftValidationErrors.innerHTML = '';
    resetShiftSubmitBtn();
    showToast('Suggestie toegepast - controleer en klik Opslaan', 'info');
}

// ===== ACTIVITY MODAL =====

function openAddActivityModal(userId, date, shiftStart, shiftEnd, shiftId) {
    document.getElementById('activity-modal-title').textContent = 'Activiteit toevoegen';
    document.getElementById('activity-id').value = '';
    document.getElementById('activity-user-id').value = userId;
    document.getElementById('activity-shift-id').value = shiftId || '';
    document.getElementById('activity-date').value = date;
    document.getElementById('activity-shift-start').value = shiftStart || '';
    document.getElementById('activity-shift-end').value = shiftEnd || '';
    document.getElementById('activity-type').value = '';
    document.getElementById('activity-start').value = '';
    document.getElementById('activity-end').value = '';
    document.getElementById('activity-description').value = '';
    document.getElementById('activity-delete-btn').classList.add('hidden');
    document.getElementById('activity-modal').classList.remove('hidden');
    IconHelper.init(document.getElementById('activity-modal'));
}

function openEditActivityModal(activityId) {
    const activity = DataStore.activities.find(a => a.id === activityId);
    if (!activity) return;

    // Find the shift for this activity using shiftId if available, fallback to user+date match
    const shift = activity.shiftId
        ? DataStore.shifts.find(s => s.id === activity.shiftId)
        : DataStore.shifts.find(s => String(s.employeeId) === String(activity.userId) && s.date === activity.date);
    document.getElementById('activity-modal-title').textContent = 'Activiteit bewerken';
    document.getElementById('activity-id').value = activity.id;
    document.getElementById('activity-user-id').value = activity.userId;
    document.getElementById('activity-shift-id').value = activity.shiftId || '';
    document.getElementById('activity-date').value = activity.date;
    document.getElementById('activity-shift-start').value = shift ? shift.startTime : '';
    document.getElementById('activity-shift-end').value = shift ? shift.endTime : '';
    document.getElementById('activity-type').value = activity.type;
    document.getElementById('activity-start').value = activity.startTime;
    document.getElementById('activity-end').value = activity.endTime;
    document.getElementById('activity-description').value = activity.description || '';
    document.getElementById('activity-delete-btn').classList.remove('hidden');
    document.getElementById('activity-modal').classList.remove('hidden');
    IconHelper.init(document.getElementById('activity-modal'));
}

function closeActivityModal() {
    document.getElementById('activity-modal').classList.add('hidden');
}

async function handleActivitySubmit(e) {
    e.preventDefault();
    const id = document.getElementById('activity-id').value;
    const userId = document.getElementById('activity-user-id').value;
    const shiftId = document.getElementById('activity-shift-id').value;
    const date = document.getElementById('activity-date').value;
    const type = document.getElementById('activity-type').value;
    const startTime = document.getElementById('activity-start').value;
    const endTime = document.getElementById('activity-end').value;
    const description = document.getElementById('activity-description').value;

    if (!type || !startTime || !endTime) {
        showToast('Vul alle verplichte velden in', 'warning');
        return;
    }

    if (startTime >= endTime) {
        showToast('Starttijd moet voor eindtijd liggen', 'warning');
        return;
    }

    // Warn if activity falls outside shift hours
    const shiftStart = document.getElementById('activity-shift-start')?.value;
    const shiftEnd = document.getElementById('activity-shift-end')?.value;
    if (shiftStart && shiftEnd) {
        if (startTime < shiftStart || endTime > shiftEnd) {
            if (!await showConfirm('Deze activiteit valt (deels) buiten de shift-uren (' + shiftStart.substring(0,5) + '-' + shiftEnd.substring(0,5) + '). Toch opslaan?')) {
                return;
            }
        }
    }

    try {
        if (id) {
            await updateActivity(parseInt(id, 10), { startTime, endTime, type, description });
        } else {
            await addActivity({ userId: parseInt(userId, 10), shiftId: shiftId ? parseInt(shiftId, 10) : null, date, startTime, endTime, type, description });
        }
        closeActivityModal();
        renderPlanning();
        // Herrender de open shift-modal zodat de nieuwe activiteit meteen zichtbaar is
        if (AppState.editingShiftId) openEditShiftModal(AppState.editingShiftId);
        showToast('Activiteit opgeslagen', 'success');
    } catch (error) {
        showToast('Fout bij opslaan: ' + getUserFriendlyError(error), 'error');
    }
}

async function handleActivityDelete() {
    const id = document.getElementById('activity-id').value;
    if (!id) return;
    if (!await showConfirm('Activiteit verwijderen?')) return;

    try {
        await deleteActivity(parseInt(id, 10));
        closeActivityModal();
        renderPlanning();
        if (AppState.editingShiftId) openEditShiftModal(AppState.editingShiftId);
        showToast('Activiteit verwijderd', 'success');
    } catch (error) {
        showToast('Fout bij verwijderen: ' + getUserFriendlyError(error), 'error');
    }
}

async function deleteShiftConfirm(shiftId) {
    const shift = getShift(shiftId);
    if (!shift) return;
    const employee = getEmployee(shift.employeeId);
    const msg = `Dienst verwijderen?\n\n${employee?.name || 'Onbekend'}\n${formatDate(shift.date)}\n${shift.startTime} - ${shift.endTime}`;
    if (await showConfirm(msg, 'Dienst verwijderen?')) {
        showSectionLoading('planning-view', 'Dienst verwijderen...');
        try {
            const shiftCopy = { employeeId: shift.employeeId, team: shift.team, date: shift.date, startTime: shift.startTime, endTime: shift.endTime, notes: shift.notes };
            await deleteShift(shiftId);
            UndoManager.push({ type: 'delete', previousData: shiftCopy, resultId: shiftId });
            renderPlanning();
        } finally {
            hideSectionLoading('planning-view');
        }
    }
}

