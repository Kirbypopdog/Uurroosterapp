// HET VLOT ROOSTERPLANNING - RUILVERZOEKEN EN OVERNAMES

async function renderSwaps() {
    const swapsList = DOM.swapsView.querySelector('#swaps-list');

    if (!swapsList) {
        console.error('swaps-list element not found');
        return;
    }

    try {
        // Fetch swap requests
        await getSwapRequests();

        const swapRequests = DataStore.swapRequests || [];
        const currentUser = AppState.currentUser;
        const role = getEffectiveRole();

        // Add safety check for currentUser
        if (!currentUser) {
            swapsList.innerHTML = `<div class="empty-state">
                <p>Je moet ingelogd zijn om ruilverzoeken te zien.</p>
            </div>`;
            IconHelper.init(swapsList);
            return;
        }

        // Categorize requests
        const targetPendingRequests = swapRequests.filter(sr => canTargetRespondToSwap(sr));
        const openTakeoverRequests = swapRequests.filter(sr =>
            sr.request_type === 'takeover' &&
            sr.status === 'pending' &&
            sr.requester_user_id !== currentUser.id &&
            AppState.swapTeamFilter.includes(sr.requester_shift_team)
        ).sort((a, b) => (a.requester_shift_date || '').localeCompare(b.requester_shift_date || '', 'nl-BE'));

        // Group by type (excluding action-required and expired)
        const actionRequired = [...targetPendingRequests, ...openTakeoverRequests];
        const swapTypeRequests = swapRequests.filter(sr =>
            sr.request_type === 'swap' && sr.status !== 'expired' &&
            sr.requester_user_id === currentUser.id
        );
        const takeoverTypeRequests = swapRequests.filter(sr =>
            sr.request_type === 'takeover' && sr.status !== 'expired' &&
            sr.requester_user_id === currentUser.id
        );
        const expiredRequests = swapRequests.filter(sr =>
            sr.status === 'expired' && sr.requester_user_id === currentUser.id
        ).slice(0, 10);

        // Collapse state (persist in localStorage)
        if (!AppState.swapCollapseState) {
            try {
                AppState.swapCollapseState = JSON.parse(localStorage.getItem('swapCollapseState')) || { ruil: false, overname: false, verlopen: true };
            } catch { AppState.swapCollapseState = { ruil: false, overname: false, verlopen: true }; }
        }

        // Team filter toggles
        const teamSettings = DataStore.settings.teams || {};
        let html = '<div class="swaps-team-filter"><div class="team-toggles" id="swaps-team-toggles">';
        getTeamOrder().forEach(team => {
            const isActive = AppState.swapTeamFilter.includes(team);
            html += `<button class="team-toggle ${isActive ? 'active' : ''}" data-team="${team}">${escapeHtml(teamSettings[team]?.name || team)}</button>`;
        });
        html += '</div></div>';

        html += '<div class="swaps-container">';

        // === Section: Actie vereist ===
        if (actionRequired.length > 0) {
            html += `<div class="swap-group swap-group-action">
                <div class="swap-group-header swap-group-action-header">
                    <h3>
                        ${IconHelper.html('bell', 'sm')}
                        Actie vereist
                        <span class="swap-section-count">${actionRequired.length}</span>
                    </h3>
                </div>
                <div class="swap-group-body">`;

            targetPendingRequests.forEach(sr => {
                html += renderSwapRequestCard(sr, 'target');
            });
            openTakeoverRequests.forEach(sr => {
                html += renderTakeoverRequestCard(sr);
            });

            html += `</div></div>`;
        }

        // === Section: Ruilverzoeken (swap type) ===
        const ruilCollapsed = AppState.swapCollapseState.ruil;
        html += `<div class="swap-group ${ruilCollapsed ? 'collapsed' : ''}" data-group="ruil">
            <div class="swap-group-header" data-toggle-group="ruil">
                <h3>
                    ${IconHelper.html('arrow-left-right', 'sm')}
                    Ruilverzoeken
                    ${swapTypeRequests.length > 0 ? `<span class="swap-section-count">${swapTypeRequests.length}</span>` : ''}
                    <i data-lucide="chevron-down" class="swap-group-chevron"></i>
                </h3>
            </div>
            <div class="swap-group-body">`;

        if (swapTypeRequests.length === 0) {
            html += `<div class="swap-empty-state">
                <i data-lucide="arrow-left-right" class="empty-state-icon"></i>
                <p>Geen ruilverzoeken</p>
            </div>`;
        } else {
            swapTypeRequests.forEach(sr => {
                html += renderSwapRequestCard(sr, 'view');
            });
        }
        html += `</div></div>`;

        // === Section: Overnames / Afstaan (takeover type) ===
        const overnameCollapsed = AppState.swapCollapseState.overname;
        html += `<div class="swap-group ${overnameCollapsed ? 'collapsed' : ''}" data-group="overname">
            <div class="swap-group-header" data-toggle-group="overname">
                <h3>
                    ${IconHelper.html('hand', 'sm')}
                    Overnames / Afstaan
                    ${takeoverTypeRequests.length > 0 ? `<span class="swap-section-count">${takeoverTypeRequests.length}</span>` : ''}
                    <i data-lucide="chevron-down" class="swap-group-chevron"></i>
                </h3>
            </div>
            <div class="swap-group-body">`;

        if (takeoverTypeRequests.length === 0) {
            html += `<div class="swap-empty-state">
                <i data-lucide="hand" class="empty-state-icon"></i>
                <p>Geen overnameverzoeken</p>
                <button class="btn btn-primary mt-md" onclick="switchView('planning')">Bekijk mijn shifts in de planning</button>
            </div>`;
        } else {
            takeoverTypeRequests.forEach(sr => {
                html += renderTakeoverRequestCard(sr, 'view');
            });
        }
        html += `</div></div>`;

        // === Section: Verlopen (collapsed by default) ===
        if (expiredRequests.length > 0) {
            const verlopenCollapsed = AppState.swapCollapseState.verlopen;
            html += `<div class="swap-group swap-group-expired ${verlopenCollapsed ? 'collapsed' : ''}" data-group="verlopen">
                <div class="swap-group-header" data-toggle-group="verlopen">
                    <h3>
                        ${IconHelper.html('clock', 'sm')}
                        Verlopen
                        <span class="swap-section-count swap-count-muted">${expiredRequests.length}</span>
                        <i data-lucide="chevron-down" class="swap-group-chevron"></i>
                    </h3>
                </div>
                <div class="swap-group-body">`;

            expiredRequests.forEach(sr => {
                if (sr.request_type === 'takeover') {
                    html += renderTakeoverRequestCard(sr, 'view');
                } else {
                    html += renderSwapRequestCard(sr, 'view');
                }
            });

            html += `</div></div>`;
        }

        html += '</div>';

        swapsList.innerHTML = html;
        IconHelper.init(swapsList);

        // Attach team filter toggle listeners
        swapsList.querySelectorAll('#swaps-team-toggles .team-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const team = btn.dataset.team;
                if (AppState.swapTeamFilter.includes(team)) {
                    AppState.swapTeamFilter = AppState.swapTeamFilter.filter(t => t !== team);
                } else {
                    AppState.swapTeamFilter.push(team);
                }
                renderSwaps();
            });
        });

        // Attach collapse/expand toggle listeners
        swapsList.querySelectorAll('[data-toggle-group]').forEach(header => {
            header.addEventListener('click', () => {
                const group = header.dataset.toggleGroup;
                const section = header.closest('.swap-group');
                section.classList.toggle('collapsed');
                AppState.swapCollapseState[group] = section.classList.contains('collapsed');
                try { localStorage.setItem('swapCollapseState', JSON.stringify(AppState.swapCollapseState)); } catch {}
                IconHelper.init(section);
            });
        });

        // Attach event listeners to action buttons
        attachSwapActionListeners();

    } catch (error) {
        console.error('Error rendering swaps:', error);
        swapsList.innerHTML = `<div class="empty-state text-danger">
            <h3>${IconHelper.html(ICONS.error, 'md')} Fout bij laden ruilverzoeken</h3>
            <p>${escapeHtml(getUserFriendlyError(error))}</p>
        </div>`;
        IconHelper.init(swapsList);
    }
}

function renderSwapRequestCard(swapRequest, mode) {
    const statusLabels = {
        'pending': 'In behandeling',
        'approved': 'Goedgekeurd',
        'rejected': 'Afgewezen',
        'cancelled': 'Geannuleerd',
        'expired': 'Verlopen'
    };

    const createdDate = new Date(swapRequest.created_at).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    let actionsHtml = '';

    if (mode === 'target' && swapRequest.status === 'pending') {
        actionsHtml = `
            <div class="swap-request-actions d-flex gap-sm">
                <button class="btn btn-primary btn-target-approve-swap" data-swap-id="${swapRequest.id}">
                    ${IconHelper.html(ICONS.check, 'xs')} Accepteren
                </button>
                <button class="btn btn-danger btn-target-reject-swap" data-swap-id="${swapRequest.id}">
                    ${IconHelper.html(ICONS.close, 'xs')} Afwijzen
                </button>
            </div>
        `;
    } else if (mode === 'view' && swapRequest.status === 'pending' && canCancelSwap(swapRequest)) {
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-danger btn-cancel-swap" data-swap-id="${swapRequest.id}">
                    Annuleren
                </button>
            </div>
        `;
    }

    let responseHtml = '';
    if (swapRequest.status !== 'pending' && swapRequest.response_notes) {
        responseHtml = `
            <div class="swap-request-message">
                <strong>Reactie:</strong> ${escapeHtml(swapRequest.response_notes)}
                ${swapRequest.responded_by_name ? `<br><small>Door ${escapeHtml(swapRequest.responded_by_name)}</small>` : ''}
            </div>
        `;
    }

    // Show who accepted the swap
    let acceptedByHtml = '';
    if (swapRequest.status === 'approved') {
        const acceptorName = swapRequest.responded_by_name || swapRequest.target_name;
        if (acceptorName) {
            acceptedByHtml = `<div class="swap-accepted-info">${IconHelper.html(ICONS.check, 'xs')} Goedgekeurd door <strong>${escapeHtml(acceptorName)}</strong></div>`;
        }
    }

    let messageHtml = '';
    if (swapRequest.message) {
        messageHtml = `
            <div class="swap-request-message">
                <strong>Bericht:</strong> ${escapeHtml(swapRequest.message)}
            </div>
        `;
    }

    return `
        <div class="swap-request-card">
            <div class="swap-request-header">
                <h4>${escapeHtml(swapRequest.requester_name)} ${IconHelper.html(ICONS.swap, 'sm')} ${escapeHtml(swapRequest.target_name)}</h4>
                <span class="swap-status-badge status-${swapRequest.status}">
                    ${statusLabels[swapRequest.status] || swapRequest.status}
                </span>
            </div>
            <div class="swap-request-body">
                <div class="swap-request-shift">
                    <strong>${escapeHtml(swapRequest.requester_name)}</strong>
                    ${formatDate(swapRequest.requester_shift_date)} |
                    ${swapRequest.requester_shift_start} - ${swapRequest.requester_shift_end} |
                    ${escapeHtml(swapRequest.requester_shift_team || '')}
                </div>
                <div class="swap-request-arrow">${IconHelper.html(ICONS.swap, 'sm')}</div>
                <div class="swap-request-shift">
                    <strong>${escapeHtml(swapRequest.target_name)}</strong>
                    ${formatDate(swapRequest.target_shift_date)} |
                    ${swapRequest.target_shift_start} - ${swapRequest.target_shift_end} |
                    ${escapeHtml(swapRequest.target_shift_team || '')}
                </div>
            </div>
            ${messageHtml}
            ${acceptedByHtml}
            ${responseHtml}
            <p class="text-sm text-muted mt-sm">
                Aangevraagd op ${createdDate}
            </p>
            ${actionsHtml}
        </div>
    `;
}

function renderTakeoverRequestCard(takeoverRequest, mode = 'available') {
    const statusLabels = {
        'pending': 'Beschikbaar',
        'approved': 'Overgenomen',
        'expired': 'Verlopen',
        'rejected': 'Afgewezen',
        'cancelled': 'Geannuleerd'
    };

    const createdDate = new Date(takeoverRequest.created_at).toLocaleDateString('nl-NL', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    const shift = takeoverRequest.requester_shift_id ? {
        date: takeoverRequest.requester_shift_date,
        startTime: takeoverRequest.requester_shift_start,
        endTime: takeoverRequest.requester_shift_end,
        team: takeoverRequest.requester_shift_team,
        notes: takeoverRequest.requester_shift_notes
    } : null;

    if (!shift) {
        return ''; // Skip if shift data is missing
    }

    // Get team name
    const teamName = shift.team && DataStore.settings.teams?.[shift.team]
        ? DataStore.settings.teams[shift.team].name
        : shift.team || 'Onbekend team';

    let messageHtml = '';
    if (takeoverRequest.message) {
        messageHtml = `
            <div class="swap-request-message">
                <strong>Bericht:</strong> ${escapeHtml(takeoverRequest.message)}
            </div>
        `;
    }

    // Show who accepted the takeover
    const acceptedByHtml = takeoverRequest.status === 'approved' && takeoverRequest.target_name
        ? `<div class="swap-accepted-info">${IconHelper.html(ICONS.check, 'xs')} Overgenomen door <strong>${escapeHtml(takeoverRequest.target_name)}</strong></div>`
        : '';

    // Actions based on mode
    let actionsHtml = '';
    if (mode === 'available' && takeoverRequest.status === 'pending') {
        // Show "Overnemen" button for available shifts
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-success btn-accept-takeover" data-request-id="${takeoverRequest.id}">
                    ${IconHelper.html(ICONS.check, 'xs')} Overnemen
                </button>
            </div>
        `;
    } else if (mode === 'view' && takeoverRequest.status === 'pending' && canCancelSwap(takeoverRequest)) {
        // Show "Annuleren" button for own pending requests
        actionsHtml = `
            <div class="swap-request-actions">
                <button class="btn btn-danger btn-cancel-swap" data-swap-id="${takeoverRequest.id}">
                    Annuleren
                </button>
            </div>
        `;
    }

    // Status badge
    const statusClass = takeoverRequest.status === 'pending' ? 'status-available' : `status-${takeoverRequest.status}`;
    const statusLabel = statusLabels[takeoverRequest.status] || takeoverRequest.status;

    // Title based on mode
    const title = mode === 'view'
        ? 'Je zoekt iemand voor deze shift'
        : `${escapeHtml(takeoverRequest.requester_name)} zoekt iemand`;

    return `
        <div class="swap-request-card takeover-card">
            <div class="swap-request-header">
                <h4>${title}</h4>
                <span class="swap-status-badge ${statusClass}">${statusLabel}</span>
            </div>
            <div class="swap-request-body">
                <div class="takeover-shift-info">
                    <strong>Shift:</strong>
                    ${formatDate(shift.date)} |
                    ${shift.startTime} - ${shift.endTime} |
                    ${escapeHtml(teamName)}
                    ${shift.notes ? `<br><em>${escapeHtml(shift.notes)}</em>` : ''}
                </div>
            </div>
            ${acceptedByHtml}
            ${messageHtml}
            <p class="text-sm text-muted mt-sm">
                Geplaatst op ${createdDate}
            </p>
            ${actionsHtml}
        </div>
    `;
}

function attachSwapActionListeners() {
    // Target approve buttons
    document.querySelectorAll('.btn-target-approve-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);
            const notes = await showInputPrompt('Wil je een bericht toevoegen?', 'Ruil accepteren');
            if (notes !== null) {
                try {
                    await targetApproveSwapRequest(swapId, notes);
                    showToast('Ruil geaccepteerd! De shifts zijn omgewisseld.', 'success');
                    switchView('planning'); // Go to planning to see the result
                } catch (error) {
                    console.error('Error approving swap:', error);
                    showToast('Fout bij accepteren: ' + getUserFriendlyError(error), 'error');
                }
            }
        });
    });

    // Target reject buttons
    document.querySelectorAll('.btn-target-reject-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);
            const notes = await showInputPrompt('Waarom wijs je dit ruilverzoek af? (verplicht)', 'Ruil afwijzen');
            if (notes && notes.trim() !== '') {
                try {
                    await targetRejectSwapRequest(swapId, notes);
                    showToast('Ruil afgewezen', 'success');
                    renderSwaps();
                } catch (error) {
                    console.error('Error rejecting swap:', error);
                    showToast('Fout bij afwijzen: ' + getUserFriendlyError(error), 'error');
                }
            } else if (notes !== null) {
                showToast('Je moet een reden opgeven om het verzoek af te wijzen', 'warning');
            }
        });
    });

    // Cancel buttons
    document.querySelectorAll('.btn-cancel-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);
            if (await showConfirm('Weet je zeker dat je dit ruilverzoek wilt annuleren?')) {
                try {
                    await cancelSwapRequest(swapId);
                    showToast('Ruilverzoek geannuleerd', 'success');
                    renderSwaps();
                } catch (error) {
                    console.error('Error cancelling swap:', error);
                    showToast('Fout bij annuleren: ' + getUserFriendlyError(error), 'error');
                }
            }
        });
    });

    // Accept takeover buttons
    document.querySelectorAll('.btn-accept-takeover').forEach(btn => {
        btn.addEventListener('click', async () => {
            const requestId = parseInt(btn.dataset.requestId);
            const notes = await showInputPrompt('Wil je een bericht toevoegen?', 'Shift overnemen');

            if (notes !== null) {
                if (await showConfirm('Weet je zeker dat je deze shift wilt overnemen?')) {
                    try {
                        await acceptTakeoverRequest(requestId, notes);
                        // Refresh shifts and swap requests
                        await Promise.all([refreshShifts(), getSwapRequests()]);
                        showToast('Shift overgenomen! Je kunt hem nu zien in je planning.', 'success');
                        switchView('planning'); // Go to planning to see the new shift
                    } catch (error) {
                        console.error('Error accepting takeover:', error);
                        showToast('Fout bij overnemen: ' + getUserFriendlyError(error), 'error');
                    }
                }
            }
        });
    });
}

