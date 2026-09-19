// HET VLOT ROOSTERPLANNING - RUILVERZOEKEN EN OVERNAMES

// #285: de mutatie is gelukt, alleen het opnieuw ophalen niet. Dat is geen
// fout in wat de gebruiker deed, dus geen rode melding: zeggen dat het gelukt
// is en dat het scherm even achterloopt.
function meldNaMutatie(uitkomst, gelukteTekst) {
    if (uitkomst && uitkomst.ververst === false) {
        showToast(`${gelukteTekst} Het scherm kon niet bijgewerkt worden; herlaad de pagina om alles te zien.`, 'warning', 6000);
        return false;
    }
    showToast(gelukteTekst, 'success');
    return true;
}

// #348: "Van Carla Demo op vrijdag 12 september 2026, 14:00 tot 22:00."
function beschrijfVerzoekDienst(verzoek) {
    if (!verzoek) return '';
    const wie = verzoek.requester_name ? `Van ${verzoek.requester_name}` : 'Deze dienst';
    const datum = verzoek.requester_shift_date ? ` op ${formatDate(verzoek.requester_shift_date)}` : '';
    const tijd = (verzoek.requester_shift_start && verzoek.requester_shift_end)
        ? `, ${verzoek.requester_shift_start} tot ${verzoek.requester_shift_end}` : '';
    return `${wie}${datum}${tijd}.`;
}

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
            <div class="swap-group-header" data-toggle-group="ruil"
                 role="button" tabindex="0" aria-expanded="${!ruilCollapsed}"
                 aria-label="Ruilverzoeken in- of uitklappen">
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
            <div class="swap-group-header" data-toggle-group="overname"
                 role="button" tabindex="0" aria-expanded="${!overnameCollapsed}"
                 aria-label="Overnames en afstaan in- of uitklappen">
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
                <button class="btn btn-primary mt-md" onclick="switchView('planning')">Bekijk mijn diensten in de planning</button>
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
                <div class="swap-group-header" data-toggle-group="verlopen"
                     role="button" tabindex="0" aria-expanded="${!verlopenCollapsed}"
                     aria-label="Verlopen verzoeken in- of uitklappen">
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
                const ingeklapt = section.classList.contains('collapsed');
                // De kop meldt zijn toestand ook aan een schermlezer, anders
                // blijft aria-expanded op de waarde van de laatste render staan.
                header.setAttribute('aria-expanded', String(!ingeklapt));
                AppState.swapCollapseState[group] = ingeklapt;
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

    const _teams = DataStore.settings.teams || {};
    const reqColor = _teams[swapRequest.requester_shift_team]?.color || '#8d897c';
    const tgtColor = _teams[swapRequest.target_shift_team]?.color || '#8d897c';
    const reqInitials = escapeHtml(getInitials(swapRequest.requester_name || ''));
    const tgtInitials = escapeHtml(getInitials(swapRequest.target_name || ''));
    const reqTeamName = escapeHtml(_teams[swapRequest.requester_shift_team]?.name || swapRequest.requester_shift_team || '');
    const tgtTeamName = escapeHtml(_teams[swapRequest.target_shift_team]?.name || swapRequest.target_shift_team || '');

    return `
        <div class="swap-request-card">
            <div class="swap-request-header">
                <div class="swap-people">
                    <span class="swap-person"><span class="emp-avatar" style="background:${reqColor};color:${getContrastColor(reqColor)}">${reqInitials}</span>${escapeHtml(swapRequest.requester_name)}</span>
                    <span class="swap-people-arrow">${IconHelper.html(ICONS.swap, 'xs')}</span>
                    <span class="swap-person"><span class="emp-avatar" style="background:${tgtColor};color:${getContrastColor(tgtColor)}">${tgtInitials}</span>${escapeHtml(swapRequest.target_name)}</span>
                </div>
                <span class="swap-status-badge status-${swapRequest.status}">
                    ${statusLabels[swapRequest.status] || swapRequest.status}
                </span>
            </div>
            <div class="swap-request-body">
                <div class="swap-request-shift" style="border-left:3px solid ${reqColor}">
                    <strong>${escapeHtml(swapRequest.requester_name)}</strong>
                    ${formatDate(swapRequest.requester_shift_date)} |
                    ${swapRequest.requester_shift_start} - ${swapRequest.requester_shift_end} |
                    ${reqTeamName}
                </div>
                <div class="swap-request-arrow">${IconHelper.html(ICONS.swap, 'sm')}</div>
                <div class="swap-request-shift" style="border-left:3px solid ${tgtColor}">
                    <strong>${escapeHtml(swapRequest.target_name)}</strong>
                    ${formatDate(swapRequest.target_shift_date)} |
                    ${swapRequest.target_shift_start} - ${swapRequest.target_shift_end} |
                    ${tgtTeamName}
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
    const teamName = getTeamName(shift.team) || 'Onbekend team';

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

    // Team color voor avatar + accent
    const takeoverColor = (shift.team && DataStore.settings.teams?.[shift.team]?.color) || '#8d897c';
    const reqInitials = escapeHtml(getInitials(takeoverRequest.requester_name || ''));

    // Title based on mode
    const titleHtml = mode === 'view'
        ? '<span class="swap-person-name">Je zoekt iemand voor deze dienst</span>'
        : `<span class="swap-person"><span class="emp-avatar" style="background:${takeoverColor};color:${getContrastColor(takeoverColor)}">${reqInitials}</span>${escapeHtml(takeoverRequest.requester_name)} zoekt iemand</span>`;

    return `
        <div class="swap-request-card takeover-card">
            <div class="swap-request-header">
                <div class="swap-people">${titleHtml}</div>
                <span class="swap-status-badge ${statusClass}">${statusLabel}</span>
            </div>
            <div class="swap-request-body">
                <div class="takeover-shift-info" style="border-left:3px solid ${takeoverColor}">
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

/**
 * Waarschuwt wanneer je een dienst aanneemt op een dag waarop je zelf afwezig
 * staat.
 *
 * #318: takeover-accept controleert status, type, aanvrager en datum, maar
 * raadpleegt de availability-tabel niet. Wie die dag als ziek of met verlof
 * geregistreerd stond kon de dienst gewoon aannemen, waarna de
 * verlofadministratie en de planning elkaar tegenspraken zonder dat iemand iets
 * te zien kreeg.
 *
 * Bij een ruil bestaat de controle wel (validation.js), maar die draait alleen
 * bij het AANMAKEN van het verzoek. Meldt de goedkeurder zich daarna ziek, dan
 * glipt hij er net zo goed door. Vandaar dat beide knoppen deze bevestiging
 * krijgen.
 *
 * Bewust een bevestiging en geen blokkade: de backend dwingt availability
 * nergens af, ook niet bij een ruil of een handmatige toewijzing. Alleen hier
 * blokkeren zou de app inconsistent maken. En soms klopt het gewoon: je verlof
 * gaat niet door, of je bent weer beter.
 *
 * @returns {Promise<boolean>} true als er doorgegaan mag worden
 */
async function bevestigBijEigenAfwezigheid(datum, watGebeurtEr) {
    if (!datum) return true;
    const eigen = getAvailability(AppState.currentUser?.id, datum);
    if (!eigen || !eigen.type) return true;

    const label = (typeof ABSENCE_LABELS !== 'undefined' && ABSENCE_LABELS[eigen.type]) || eigen.type;
    const dag = formatDateShort(parseDateOnly(datum));

    return showConfirm(
        `Je staat op ${dag} genoteerd als ${label.toLowerCase()}${eigen.reason ? ` (${eigen.reason})` : ''}.\n\n` +
        `${watGebeurtEr} Je afwezigheid en je dienst staan dan allebei in de planning. Klopt dat niet, pas dan eerst je afwezigheid aan.`,
        'Je staat die dag afwezig',
        { confirmText: 'Toch doorgaan', cancelText: 'Annuleren', danger: true }
    );
}

/**
 * Zegt of de backend deze weigering laat doordrukken.
 *
 * #202: ruilen en overnemen sloegen de roosterregels volledig over. Nu weigert
 * de backend, maar een weigering zonder uitweg is even onbruikbaar als geen
 * controle. De app kent dat patroon al bij een dienst opslaan ("Toch opslaan"),
 * en de backend volgt dezelfde afspraak: force slaat enkel de 11-uur rust over,
 * nooit een overlap. Bij een overlap staat er canOverride: false en tonen we
 * dus geen uitweg, want op twee plekken tegelijk staan kan niet.
 */
function magRusttijdOverrulen(error) {
    return !!(error && error.data && error.data.canOverride);
}

/**
 * Toont de bevestiging waarmee een te korte rusttijd doorgedrukt mag worden.
 * @returns {Promise<boolean>} true als de gebruiker wil doordrukken
 */
function bevestigRusttijdOverride(error, bevestigTekst) {
    const data = error.data;
    const uitleg = data.wie === 'aanvrager'
        ? 'De aanvrager houdt hierdoor te weinig rust tussen twee diensten.'
        : 'Je houdt hierdoor te weinig rust tussen twee diensten.';

    // De norm komt uit Instellingen > Planningsregels, dus noem de waarde die
    // daar staat in plaats van een vast getal.
    const norm = data.minRest ?? DataStore.settings?.rules?.minHoursBetweenShifts ?? 11;
    let normUitleg;
    if (norm === 11) {
        normUitleg = 'De rust van 11 uur is een wettelijke norm.';
    } else if (norm > 11) {
        normUitleg = `De ingestelde rust is ${norm} uur, strenger dan het wettelijke minimum van 11 uur.`;
    } else {
        normUitleg = `De ingestelde rust is ${norm} uur, onder het wettelijke minimum van 11 uur.`;
    }
    const slot = `${normUitleg} Doordrukken kan, en wordt bijgehouden in de audit log.`;

    return showConfirm(
        `${data.error}\n\n${uitleg}\n\n${slot}`,
        'Te weinig rust',
        { confirmText: bevestigTekst, cancelText: 'Annuleren', danger: true }
    );
}

function attachSwapActionListeners() {
    // Target approve buttons
    document.querySelectorAll('.btn-target-approve-swap').forEach(btn => {
        btn.addEventListener('click', async () => {
            const swapId = parseInt(btn.dataset.swapId);

            // #318: bij een ruil krijg jij de dienst van de aanvrager. De
            // controle in validation.js draait alleen bij het aanmaken van het
            // verzoek, dus een afwezigheid die daarna is ingevoerd komt hier
            // nooit langs.
            const ruil = (DataStore.swapRequests || []).find(r => Number(r.id) === swapId);
            if (!await bevestigBijEigenAfwezigheid(
                    ruil?.requester_shift_date,
                    'Accepteer je de ruil toch, dan werk je die dag.')) return;

            const notes = await showInputPrompt(
                `${beschrijfVerzoekDienst(ruil)}\n\nWil je een bericht toevoegen? (optioneel)`,
                'Ruil accepteren', '', 'Ruil accepteren');
            if (notes !== null) {
                try {
                    const uitkomst = await targetApproveSwapRequest(swapId, notes);
                    // Alleen doorklikken naar de planning als die ook klopt.
                    if (meldNaMutatie(uitkomst, 'Ruil geaccepteerd. De diensten zijn omgewisseld.')) {
                        switchView('planning');
                    } else {
                        renderSwaps();
                    }
                } catch (error) {
                    // #202: de backend controleert nu overlap en rusttijd. Een te
                    // korte rust mag doorgedrukt worden na bevestiging, zoals bij
                    // een dienst opslaan; een overlap nooit, want dan sta je op
                    // twee plekken tegelijk.
                    if (magRusttijdOverrulen(error)) {
                        if (!await bevestigRusttijdOverride(error, 'Ruil toch accepteren')) {
                            // Bewust afgezien: dat is geen fout, dus ook geen foutmelding.
                            showToast('Ruil niet geaccepteerd.', 'info');
                            return;
                        }
                        try {
                            await targetApproveSwapRequest(swapId, notes, true);
                            showToast('Ruil geaccepteerd, met minder dan 11 uur rust.', 'warning');
                            switchView('planning');
                            return;
                        } catch (tweede) {
                            console.error('Error approving swap (force):', tweede);
                            showToast('Fout bij accepteren: ' + getUserFriendlyError(tweede), 'error');
                            return;
                        }
                    }
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
                    const uitkomst = await targetRejectSwapRequest(swapId, notes);
                    meldNaMutatie(uitkomst, 'Ruil afgewezen.');
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
                    const uitkomst = await cancelSwapRequest(swapId);
                    meldNaMutatie(uitkomst, 'Ruilverzoek geannuleerd.');
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

            // #318: eerst vragen, vóór het berichtvenster. Anders typ je een
            // bericht en krijg je pas daarna te horen dat je die dag afwezig
            // staat.
            const verzoek = (DataStore.swapRequests || []).find(r => Number(r.id) === requestId);
            if (!await bevestigBijEigenAfwezigheid(
                    verzoek?.requester_shift_date,
                    'Neem je de dienst toch over, dan werk je die dag.')) return;

            // #348: de vraag ging alleen over het optionele bericht, terwijl je
            // met deze stap een dienst op je naam zet. De onderliggende kaart is
            // op dat moment verduisterd, dus de gegevens moeten in de vraag zelf.
            const notes = await showInputPrompt(
                `${beschrijfVerzoekDienst(verzoek)}\n\nWil je een bericht toevoegen? (optioneel)`,
                'Dienst overnemen', '', 'Dienst overnemen');

            if (notes !== null) {
                if (await showConfirm('Weet je zeker dat je deze dienst wilt overnemen?')) {
                    try {
                        // #285: de tweede verversing die hier stond was dubbel
                        // werk, en een fout erin belandde in de catch hieronder
                        // met de tekst "Fout bij overnemen" terwijl de overname
                        // al gelukt was. acceptTakeoverRequest ververst zelf en
                        // meldt of dat lukte.
                        const uitkomst = await acceptTakeoverRequest(requestId, notes);
                        if (meldNaMutatie(uitkomst, 'Dienst overgenomen. Je ziet hem nu in je planning.')) {
                            switchView('planning');
                        } else {
                            renderSwaps();
                        }
                    } catch (error) {
                        // #202: zie de toelichting bij de ruilknop hierboven.
                        if (magRusttijdOverrulen(error)) {
                            if (!await bevestigRusttijdOverride(error, 'Toch overnemen')) {
                                // Bewust afgezien: dat is geen fout, dus ook geen foutmelding.
                                showToast('Dienst niet overgenomen.', 'info');
                                return;
                            }
                            try {
                                const tweedeUitkomst = await acceptTakeoverRequest(requestId, notes, true);
                                if (tweedeUitkomst && tweedeUitkomst.ververst === false) {
                                    showToast('Dienst overgenomen, met minder dan 11 uur rust. Het scherm kon niet bijgewerkt worden; herlaad de pagina.', 'warning', 6000);
                                    renderSwaps();
                                } else {
                                    showToast('Dienst overgenomen, met minder dan 11 uur rust.', 'warning');
                                    switchView('planning');
                                }
                                return;
                            } catch (tweede) {
                                console.error('Error accepting takeover (force):', tweede);
                                showToast('Fout bij overnemen: ' + getUserFriendlyError(tweede), 'error');
                                return;
                            }
                        }
                        console.error('Error accepting takeover:', error);
                        showToast('Fout bij overnemen: ' + getUserFriendlyError(error), 'error');
                    }
                }
            }
        });
    });
}

