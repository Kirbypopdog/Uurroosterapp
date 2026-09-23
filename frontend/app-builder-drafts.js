// ===== ROOSTERBOUWER: CONCEPTEN (opslaan, laden, toepassen, vergelijken) =====

/**
 * #227: is de GET /schedule-drafts echt mislukt bij het opstarten (niet zomaar
 * "geen rechten"), blokkeer dan elke schrijfactie op concepten. Zonder deze
 * controle schrijft de bouwer stilzwijgend naar de oude settings-opslag in
 * plaats van naar de echte tabel, en dat concept is na een geslaagde herlaad
 * onvindbaar voor de rest van de app.
 * @returns {boolean} true als de aanroeper moet stoppen
 */
function blokkeerBijMislukteDraftLoad() {
    if (!DataStore._draftsLoadFailed) return false;
    showToast('Concepten konden niet geladen worden bij het opstarten. Herlaad de pagina voor je een concept aanmaakt, wijzigt of verwijdert.', 'error');
    return true;
}

// #383: welk concept openstaat woonde op twee plekken die los van elkaar
// bijgewerkt werden: AppState (wat het scherm toont) en localStorage (wat een
// herlading terugzet). Het aanmaken van een nieuw concept schreef alleen het
// eerste, het sluiten van een concept wiste alleen het eerste. Daardoor kon je
// na een herlading in het overzicht belanden terwijl je in een concept zat, of
// omgekeerd terug in een concept dat je net gesloten had. Deze twee functies
// zijn sindsdien de enige plek waar dat paar verandert, zodat het niet meer
// uiteen kan lopen.
function onthoudActiefConcept(id, naam) {
    AppState.builderLoadedDraftId = id;
    AppState.builderLoadedDraftName = naam;
    try {
        localStorage.setItem('hetvlot_activeDraftId', String(id));
    } catch (e) { /* privémodus of volle opslag: het scherm klopt nog wel */ }
}

function vergeetActiefConcept() {
    AppState.builderLoadedDraftId = null;
    AppState.builderLoadedDraftName = null;
    try {
        localStorage.removeItem('hetvlot_activeDraftId');
    } catch (e) { /* zie hierboven */ }
}

// Een concept is meer dan zijn diensten: gesloten dagen, bezettingsregels en
// vergaderingen tellen evengoed. Deze ene bron bepaalt zowel of de
// opslaanknoppen aan staan als of opslaan zin heeft — anders raken die twee
// uit elkaar, zoals eerder gebeurde: een concept met enkel gesloten dagen kon
// je niet opslaan én de knop stond grijs.
function builderHeeftIets() {
    const vulling = g => g && Object.keys(g).length > 0
        && Object.values(g).some(d => d && Object.keys(d).length > 0);

    if (vulling(AppState.builderGrid)) return true;
    if (Object.values(AppState.builderGridByWeek || {}).some(vulling)) return true;
    if (Object.values(AppState.builderPattern?.weeks || {})
        .some(w => Array.isArray(w?.closedDays) && w.closedDays.length > 0)) return true;
    if (Object.keys(AppState.builderStaffingRulesByWeek || {}).length > 0
        || Object.keys(AppState.builderStaffingRules || {}).length > 0) return true;
    if (Object.values(AppState.builderMeetings || {})
        .some(v => Array.isArray(v) && v.length > 0)) return true;
    return false;
}

function builderHeeftInhoud() {
    if (builderHeeftIets()) return true;
    showToast('Er valt nog niets op te slaan.\nVul een dienst in, sluit een dag of stel bezetting in.', 'warning');
    return false;
}

async function saveBuilderDraft() {
    if (blokkeerBijMislukteDraftLoad()) return;

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

    if (!builderHeeftInhoud()) return;

    // If a draft is loaded, UPDATE it directly (no modal needed)
    if (AppState.builderLoadedDraftId) {
        try {
            // #148: hier stond dezelfde opbouw van het volledige raster als in
            // autoSaveBuilderDraft, met dezelfde PUT die alle weken verving.
            // Twee plekken die hetzelfde doen is er een te veel, en de tweede
            // wordt vergeten. Bewaren gaat nu overal via die ene functie, die
            // per week wegschrijft.
            const cached = (DataStore.settings.schedule_drafts || []).find(d => d.id === AppState.builderLoadedDraftId);
            if (cached) cached._previousGrid = JSON.parse(JSON.stringify(cached.grid || {}));

            const gelukt = await autoSaveBuilderDraft();
            if (!gelukt) {
                showToast('Fout bij bijwerken concept', 'error');
                return;
            }

            await unlockScheduleDraft(AppState.builderLoadedDraftId);
            AppState.builderScreen = 'overview';
            renderBuilder();
            showToast(`Concept "${AppState.builderLoadedDraftName}" bijgewerkt`, 'success');

            // If this draft is currently active AND grid actually changed, ask to re-apply
            const newestActiveId = findNewestActiveDraftId(DataStore.settings.schedule_drafts || []);
            const previousGrid = cached ? JSON.stringify(cached._previousGrid) : null;
            const newGrid = cached ? JSON.stringify(cached.grid) : null;
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
            onthoudActiefConcept(apiResult.draft.id, apiResult.draft.name);
        } else {
            const drafts = [...(DataStore.settings.schedule_drafts || [])];
            draftData.createdBy = AppState.currentUser?.id;
            draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
            draftData.createdAt = new Date().toISOString();
            draftData.updatedAt = new Date().toISOString();
            drafts.push(draftData);
            await saveSettings('schedule_drafts', drafts);
            DataStore.settings.schedule_drafts = drafts;
            onthoudActiefConcept(draftData.id, draftData.name);
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
    if (blokkeerBijMislukteDraftLoad()) return;

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
    if (!builderHeeftInhoud()) return;

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
            onthoudActiefConcept(apiResult.draft.id, apiResult.draft.name);
        } else {
            const drafts = [...(DataStore.settings.schedule_drafts || [])];
            draftData.createdBy = AppState.currentUser?.id;
            draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
            draftData.createdAt = new Date().toISOString();
            draftData.updatedAt = new Date().toISOString();
            drafts.push(draftData);
            await saveSettings('schedule_drafts', drafts);
            DataStore.settings.schedule_drafts = drafts;
            onthoudActiefConcept(draftData.id, draftData.name);
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
                <button type="button" class="modal-close" aria-label="Sluiten">&times;</button>
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
    //
    // #363: dit hing alleen aan click. Nu de keuzerondjes weer focusbaar zijn
    // (ze stonden op display:none) kiest de gebruiker met de pijltjestoetsen,
    // en dat geeft change, geen click. Beide gebeurtenissen lopen daarom door
    // dezelfde functie.
    const kiesType = (opt) => {
        overlay.querySelectorAll('.concept-type-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        opt.querySelector('input').checked = true;
        const periodSelect = overlay.querySelector('#vakantie-period-select');
        const isVakantie = opt.dataset.value === 'vakantie';
        periodSelect.classList.toggle('hidden', !isVakantie);
        const nameInput = overlay.querySelector('#concept-name-input');
        if (!isVakantie) nameInput.value = 'Basisrooster';
    };
    overlay.querySelectorAll('.concept-type-option').forEach(opt => {
        opt.addEventListener('click', () => kiesType(opt));
        opt.querySelector('input')?.addEventListener('change', () => kiesType(opt));
    });

    // Auto-fill name when a vakantie period is selected
    overlay.querySelector('#vakantie-period-id')?.addEventListener('change', (e) => {
        const period = availablePeriods.find(p => String(p.id) === e.target.value);
        if (period) overlay.querySelector('#concept-name-input').value = period.name;
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#concept-type-cancel').addEventListener('click', () => overlay.remove());
    // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
    // en de muis buiten het kader loslaat.
    overlay.addEventListener('mousedown', (e) => {
        // #359: niet wegklikken terwijl het concept wordt aangemaakt, anders
        // verdwijnt de dialoog alsnog voor de server geantwoord heeft.
        if (e.target === overlay && !overlay.querySelector('#concept-type-confirm').disabled) overlay.remove();
    });

    // #359: de dialoog sloot vroeger meteen, nog voor de POST vertrok. Bij een
    // trage aanmaak (een koude Render-instantie) gebeurde er zichtbaar niets,
    // en bij een fout was de ingevulde naam weg. De dialoog blijft nu staan tot
    // het concept er echt is. De fout komt in de dialoog zelf, niet als toast
    // op een scherm waar de gebruiker niet meer is.
    const bevestigKnop = overlay.querySelector('#concept-type-confirm');
    const annuleerKnop = overlay.querySelector('#concept-type-cancel');
    const sluitKnop = overlay.querySelector('.modal-close');
    const foutVak = document.createElement('p');
    foutVak.className = 'text-sm text-danger mt-md hidden';
    foutVak.setAttribute('role', 'alert');
    overlay.querySelector('.modal-body').appendChild(foutVak);

    const zetBezig = (bezig) => {
        bevestigKnop.disabled = bezig;
        annuleerKnop.disabled = bezig;
        sluitKnop.disabled = bezig;
        bevestigKnop.textContent = bezig ? 'Aanmaken…' : 'Aanmaken';
    };

    bevestigKnop.addEventListener('click', async () => {
        if (blokkeerBijMislukteDraftLoad()) return;
        if (bevestigKnop.disabled) return;

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
        const nieuwPatroon = {
            cycleLength: initCycleLength,
            referenceDate: getSchedulePattern().referenceDate || DataStore.settings.biWeeklyReferenceDate || '',
            weeks: weeksInit
        };

        // Immediately save new empty concept to DB so auto-save has a valid ID
        const newDraftId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const draftData = {
            id: newDraftId,
            name: conceptName,
            teamFilter: AppState.builderTeamFilter,
            weekNumber: 1,
            grid: { _multiWeek: true, _pattern: nieuwPatroon },
            validFrom: null,
            validUntil: null,
            type,
            holidayPeriodId: holidayPeriodId || null
        };

        // #359: de AppState pas aanraken als het concept er is. Voorheen werd
        // het raster al leeggemaakt voor de POST, dus een mislukte aanmaak liet
        // de bouwer leeg achter met de naam van een concept dat niet bestaat.
        let draftId = newDraftId;
        let draftNaam = conceptName;
        foutVak.classList.add('hidden');
        zetBezig(true);
        try {
            if (DataStore._draftsFromTable) {
                const apiResult = await createScheduleDraft(draftData);
                const savedDraft = apiResult.draft;
                if (!DataStore.settings.schedule_drafts) DataStore.settings.schedule_drafts = [];
                DataStore.settings.schedule_drafts.push(savedDraft);
                draftId = savedDraft.id;
                draftNaam = savedDraft.name;
            } else {
                draftData.createdBy = AppState.currentUser?.id;
                draftData.createdByName = AppState.currentUser?.name || 'Onbekend';
                draftData.createdAt = new Date().toISOString();
                draftData.updatedAt = new Date().toISOString();
                const drafts = [...(DataStore.settings.schedule_drafts || []), draftData];
                await saveSettings('schedule_drafts', drafts);
                DataStore.settings.schedule_drafts = drafts;
            }
        } catch (err) {
            console.error('Error creating draft:', err);
            zetBezig(false);
            foutVak.textContent = `${getUserFriendlyError(err)} Je invulling blijft staan.`;
            foutVak.classList.remove('hidden');
            return;
        }

        overlay.remove();

        // Initialize new concept in AppState
        AppState.builderGrid = {};
        AppState.builderGridByWeek = {};
    AppState.builderVuileWeken = new Set();
        AppState.builderVuileWeken = new Set();
        AppState.builderStaffingRules = {};
        AppState.builderStaffingRulesByWeek = {};
        AppState.builderShowStaffingEditor = false;
        AppState.builderShowMeetingsEditor = false;
        AppState.builderMeetings = {};
        AppState.builderPattern = nieuwPatroon;
        AppState.builderIsDirty = false;
        AppState.builderWeekNumber = 1;
        AppState.builderConceptType = type;
        AppState.builderHolidayPeriodId = holidayPeriodId;
        onthoudActiefConcept(draftId, draftNaam);

        // #304: een nieuw concept nam de vergrendeling niet, terwijl elk concept
        // dat je via de lijst opent dat wel doet. Zonder lock kan een tweede
        // beheerder er meteen in, en ontbreekt de badge "In bewerking door X".
        if (DataStore._draftsFromTable) {
            lockScheduleDraft(draftId, false).catch(fout => {
                console.error('Vergrendelen van het nieuwe concept mislukt:', fout);
            });
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
                    <button type="button" class="modal-close" id="draft-save-close" aria-label="Sluiten"><i data-lucide="x"></i></button>
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
        // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
        // en de muis buiten het kader loslaat.
        overlay.addEventListener('mousedown', (e) => {
            if (e.target === overlay) cleanup(null);
        });
    });
}

// #332: elk vroeg-returnpad hieronder laat de bouwer staan waar hij stond.
// De aanroepers zetten builderScreen niet meer vooraf op 'editor'; dat doet
// doLoadDraft pas als het laden echt doorgaat. Anders bleef er een spookeditor
// achter met de titel "Nieuw concept" en het raster van het vorige concept.
async function loadBuilderDraft(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) {
        showToast('Dit concept bestaat niet meer. Ververs de lijst.', 'error');
        return;
    }

    // Try to acquire lock
    // #332: lockScheduleDraft gebruikt een kale fetch en gooit dus bij een
    // netwerkfout. Zonder deze catch werd dat een stille onbehandelde rejection
    // en gebeurde er op het scherm niets.
    let lockResult;
    try {
        lockResult = await lockScheduleDraft(draftId, false);
    } catch (fout) {
        console.error('Vergrendelen van het concept mislukt:', fout);
        showToast('Het concept kon niet vergrendeld worden. Controleer je verbinding en probeer opnieuw.', 'error');
        return;
    }
    if (!lockResult.ok && lockResult.status === 423) {
        const force = await showConfirm(
            `Dit concept wordt momenteel bewerkt door ${lockResult.lockedByName || 'iemand anders'}. Wil je het toch openen? De andere bewerker verliest dan zijn vergrendeling.`,
            'Concept in gebruik'
        );
        if (!force) return;
        try {
            await lockScheduleDraft(draftId, true);
        } catch (fout) {
            console.error('Vergrendeling overnemen mislukt:', fout);
            showToast('De vergrendeling kon niet overgenomen worden. Controleer je verbinding en probeer opnieuw.', 'error');
            return;
        }
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
    // #305: de bewaarstatus hoort bij het concept dat je verlaat, niet bij het
    // concept dat je opent. Wissen vóór de render, anders toont de statusregel
    // van B meteen "Bewaard om 14:30" van A.
    startBuilderAutoSave();
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

    onthoudActiefConcept(draft.id, draft.name);
    AppState.builderConceptType = draft.type || 'basis';
    AppState.builderHolidayPeriodId = draft.holidayPeriodId || null;
    AppState.builderIsDirty = false;
    AppState.builderScreen = 'editor';
    renderBuilder();
    showToast(`Concept "${draft.name}" geladen`, 'info');

    // #378: de afwezigheden zitten in een venster. Een vakantieconcept kijkt
    // naar een periode die maanden vooruit kan liggen, en de filter "Verberg
    // verlof" leest die afwezigheden. Buiten het venster zou die filter stil
    // niemand verbergen, wat eruitziet als "niemand heeft verlof" in plaats van
    // "we weten het niet".
    const hp = AppState.builderHolidayPeriodId
        ? (DataStore.settings.holidayPeriods || []).find(x => String(x.id) === String(AppState.builderHolidayPeriodId))
        : null;
    if (hp && typeof zorgAfwezigheidVoorBereik === 'function') {
        zorgAfwezigheidVoorBereik(hp.startDate, hp.endDate).then(gelukt => {
            if (!gelukt) {
                showToast('De afwezigheden voor deze vakantieperiode konden niet geladen worden. "Verberg verlof" is daardoor onbetrouwbaar.', 'error');
                return;
            }
            if (AppState.builderScreen === 'editor') renderBuilder();
        });
    }
}

async function deleteBuilderDraft(draftId) {
    if (blokkeerBijMislukteDraftLoad()) return;

    const confirmed = await showConfirm('Dit concept verwijderen?', 'Concept verwijderen',
        { danger: true, confirmText: 'Concept verwijderen' });
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
    if (blokkeerBijMislukteDraftLoad()) return;

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
            showToast('Concept uitgepland', 'success');
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
                    <button type="button" class="modal-close" id="deactivate-close" aria-label="Sluiten"><i data-lucide="x"></i></button>
                </div>
                <div class="modal-body">
                    <p class="mb-sm"><strong>${escapeHtml(draft.name)}</strong> deactiveren?</p>
                    <div class="form-group">
                        <label>Einddatum (diensten na deze datum worden verwijderd)</label>
                        <input type="date" id="deactivate-end-date" class="form-input" value="${todayStr}">
                    </div>
                    <label class="checkbox-label-row">
                        <input type="checkbox" id="deactivate-delete-manual">
                        Verwijder ook handmatig aangemaakte shifts
                    </label>
                    <span class="form-hint form-hint-block mt-sm">Automatisch aangemaakte diensten na de einddatum worden altijd verwijderd.</span>
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
        // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
        // en de muis buiten het kader loslaat.
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
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

/**
 * Past een concept toe, met bescherming tegen dubbel klikken.
 *
 * #303: die bescherming zat vroeger in de functie zelf, en één van de zeven
 * vroege returns zette de vlag niet terug. Dat was de tak "gekoppelde
 * vakantieperiode niet gevonden". Vanaf dat moment was élke volgende
 * toepassing een stille no-op tot de pagina herladen werd, ook bij een ander
 * concept en zonder enige melding: je klikte op Toepassen en er gebeurde
 * niets.
 *
 * De vlag wordt nu hier beheerd, in een try/finally rond het geheel. Zo kan
 * een nieuwe vroege return dit niet opnieuw veroorzaken.
 */
async function applyBuilderDraft(draftId) {
    if (AppState._applyingDraft) return;
    AppState._applyingDraft = true;
    try {
        return await voerConceptToepassenUit(draftId);
    } finally {
        AppState._applyingDraft = false;
    }
}

async function voerConceptToepassenUit(draftId) {
    const drafts = DataStore.settings.schedule_drafts || [];
    const draft = drafts.find(d => d.id === draftId);
    if (!draft) return;

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

        // #263: hetzelfde geval aan de vakantiekant. Dit liep niet vast, maar
        // een leeg concept toepassen wist met clearBlocks wel de blokkades en
        // levert nul shifts op. De melding zei dan "0 medewerkers krijgen een
        // vakantie-shift", wat eruitziet als een geldige keuze in plaats van
        // een concept dat nog niet is ingevuld.
        if (empIds.size === 0) {
            showToast('Dit vakantieconcept bevat nog geen ingevulde dagen. Open het, vul het rooster in en sla het op voor je het toepast.', 'warning');
            return;
        }

        const confirmed = await showConfirm(
            `Vakantieconcept "${draft.name}" toepassen?\n\n` +
            `Periode: ${fromStr} – ${untilStr}\n` +
            `${empIds.size} medewerkers krijgen een vakantiedienst.\n` +
            `Overige medewerkers krijgen GEEN dienst tijdens deze periode.`,
            'Vakantieconcept toepassen'
        );
        if (!confirmed) return;

        showSectionLoading('planning-view', 'Vakantieconcept toepassen...');
        try {
            const result = await applyScheduleDraft(draftId, { clearBlocks: true });
            // Overgeslagen dagen expliciet melden: die komen uit gridcellen die
            // je in de bouwer niet meer ziet omdat de dag intussen gesloten is.
            const gesloten = result.closedDaySkips
                ? `, ${result.closedDaySkips} overgeslagen op gesloten dagen` : '';
            const dicht = result.conceptClosedCount
                ? `, ${result.conceptClosedCount} dagen gesloten in de planning` : '';
            showToast(`Vakantieconcept "${draft.name}" toegepast (${result.shifts.created} shifts aangemaakt${gesloten}${dicht})`, 'success');

            const draftToMark = drafts.find(d => d.id === draftId);
            if (draftToMark) {
                draftToMark.lastAppliedAt = new Date().toISOString();
                draftToMark.lastAppliedBy = AppState.currentUser?.name || 'Onbekend';
                draftToMark.lastAppliedFrom = hp.startDate;
                draftToMark.lastAppliedUntil = hp.endDate;
            }

            // settings mee: de gesloten dagen van dit concept komen daarvandaan
            await Promise.all([refreshShifts(), fetchShiftBlocks(), refreshActivities(), refreshSettings()]);
            renderBuilder();
        } catch (error) {
            console.error('Error applying vakantie draft:', error);
            showToast('Fout bij toepassen vakantieconcept: ' + getUserFriendlyError(error), 'error');
        } finally {
            hideSectionLoading('planning-view');
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
            if (isNaN(Number(key)) || Number(key) <= 0) continue;
            weeksToApply.push({ weekNumber: Number(key), grid: weekGrid });
        }
        weeksToApply.sort((a, b) => a.weekNumber - b.weekNumber);
    } else {
        weeksToApply.push({ weekNumber: draft.weekNumber || 1, grid: draftGrid });
    }

    // #263: een pas aangemaakt basisconcept heeft wel _multiWeek en _pattern,
    // maar nog geen genummerde weken. weeksToApply bleef dan leeg en verderop
    // liep weeksToApply[0].weekNumber stuk op undefined. De fout kwam in de
    // console terecht, er verscheen geen venster en geen melding, dus voor de
    // gebruiker deed Toepassen gewoon niets. Dat is precies de handeling die de
    // installatiechecklist aanraadt.
    //
    // Bewust niet stilletjes doorgaan met een leeg rooster: dat zou ieders
    // basisrooster wissen. Zeggen wat er ontbreekt is de enige zinnige uitweg.
    if (weeksToApply.length === 0) {
        showToast('Dit concept bevat nog geen ingevulde weken. Open het, vul het rooster in en sla het op voor je het toepast.', 'warning');
        return;
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
    if (!applyResult) return;

    showSectionLoading('planning-view', 'Concept toepassen...');
    try {
        // Single atomic backend call: generates shifts from concept grid + marks draft
        let result = await applyScheduleDraft(draftId, {
            clearBlocks: true,
            applyStartDate: applyResult.startDate,
            applyEndDate: applyResult.endDate,
            confirmOverwrite: applyResult.confirmOverwrite ? true : null
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
            if (!confirmed) return;
            showSectionLoading('planning-view', 'Concept toepassen...');
            result = await applyScheduleDraft(draftId, {
                clearBlocks: true,
                applyStartDate: applyResult.startDate,
                applyEndDate: applyResult.endDate,
                confirmOverlap: true,
                confirmOverwrite: applyResult.confirmOverwrite ? true : null
            });
        }

        if (result.scheduled) {
            // Future draft — saved as scheduled, not applied yet
            const vfDate = new Date(result.validFrom).toLocaleDateString('nl-BE');
            showToast(`Concept "${result.draftName}" ingepland vanaf ${vfDate}`, 'success');
            renderBuilder();
            return;
        }

        const preservedNote = result.manualShiftsPreserved > 0
            ? ` · ${result.manualShiftsPreserved} manuele diensten behouden`
            : '';
        const geslotenNote = result.closedDaySkips
            ? `, ${result.closedDaySkips} overgeslagen op gesloten dagen` : '';
        showToast(`Basisrooster ${weekLabel} toegepast voor ${result.applied} medewerkers (${result.shifts.created} shifts aangemaakt${preservedNote}${geslotenNote})`, 'success');

        // Update local draft cache with applied dates
        const draftToMark = (DataStore.settings.schedule_drafts || []).find(d => d.id === draftId);
        if (draftToMark) {
            draftToMark.lastAppliedAt = new Date().toISOString();
            draftToMark.lastAppliedBy = AppState.currentUser?.name || 'Onbekend';
            draftToMark.lastAppliedFrom = applyResult.startDate;
            draftToMark.lastAppliedUntil = applyResult.endDate;
        }

        // #207: hier stond `await saveSchoolYearStart(applyResult.startDate)`,
        // onvoorwaardelijk, dus ook voor een vakantieconcept en ook voor een
        // toepassing midden in het jaar.
        //
        // De schooljaarstart is niet zomaar een etiket: getFourWeekPeriodDates
        // verankert er de vaste vierwekenperiodes aan, en die bepalen het getal
        // "X/152u" dat in de planning onder elke naam staat. Een concept
        // toepassen op 17 november verschoof de periodegrenzen een week en
        // veranderde ieders periodetotaal, zonder dat er één dienst was
        // bijgekomen of verdwenen. De knop "Vanaf nu" maakte dat één klik weg.
        //
        // De schooljaarstart wordt voortaan alleen nog handmatig gezet, in
        // Instellingen, waar hij toch al te zetten is.

        // Apply pattern + rotation from draft globally (date-aware)
        {
            const applyGrid = draft.grid || {};
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const applyFromDate = parseDateOnly(applyResult.startDate);

            if (applyGrid._pattern) {
                const currentPattern = getSchedulePattern();
                // #211: hier werd zelf een anker berekend, de maandag van de
                // startdatum, terwijl de backend met het anker uit het concept
                // genereerde. Die twee liepen uiteen en dan stond het rooster
                // een cycluspositie verschoven ten opzichte van wat je zag.
                //
                // De backend geeft nu terug welk anker hij écht gebruikt heeft.
                // Dat publiceren we, zodat er maar één waarheid is. De oude
                // berekening blijft als terugval voor een backend die het veld
                // nog niet meestuurt.
                const autoRefDate = result.referenceDate
                    || formatDateYYYYMMDD(getMonday(applyFromDate));

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
                    <button type="button" class="modal-close" id="draft-apply-close" aria-label="Sluiten"><i data-lucide="x"></i></button>
                </div>
                <div class="modal-body">
                    <p class="mb-sm text-secondary">Periode kiezen voor <strong>${escapeHtml(draft.name)}</strong>:</p>
                    <div class="apply-presets">
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="${presetSchoolStart}" data-end="${presetSchoolEnd}">Dit schooljaar</button>
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="${presetTodayStr}" data-end="${presetSchoolEnd}">Vanaf nu</button>
                        <button class="btn btn-secondary btn-sm apply-preset" data-start="" data-end="">Aangepast</button>
                    </div>
                    <div class="form-row form-row-gap mt-sm">
                        <div class="form-group flex-1">
                            <label>Van</label>
                            <input type="date" id="draft-apply-start-date" class="form-input" value="${defaultStart}" required>
                        </div>
                        <div class="form-group flex-1">
                            <label>Tot</label>
                            <input type="date" id="draft-apply-end-date" class="form-input" value="${defaultEnd}" required>
                        </div>
                    </div>
                    <p class="form-hint mt-xs">Manuele aanpassingen worden bewaard. Diensten buiten deze periode blijven ongewijzigd.</p>
                    <div class="apply-changes-summary mt-sm">Wijzigingen voor ${changesCount} van ${empCount} medewerkers:${escapeHtml(changesSummary)}</div>
                </div>
                <div class="modal-footer">
                    <span class="modal-footer-left">
                        <button class="btn btn-ghost btn-sm" id="draft-apply-reset" data-tooltip="Verwijdert ook manuele aanpassingen en zet alles terug naar het concept" data-tooltip-pos="top" style="color:var(--color-danger,#dc2626)">Reset alles</button>
                    </span>
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

        function validateDates() {
            const startDate = overlay.querySelector('#draft-apply-start-date').value;
            const endDate = overlay.querySelector('#draft-apply-end-date').value;
            if (!startDate || !endDate) { showToast('Vul beide datums in', 'warning'); return null; }
            if (startDate >= endDate) { showToast('Startdatum moet voor einddatum liggen', 'warning'); return null; }
            return { startDate, endDate };
        }

        overlay.querySelector('#draft-apply-confirm').addEventListener('click', () => {
            const dates = validateDates();
            if (!dates) return;
            cleanup();
            resolve({ ...dates, confirmOverwrite: false });
        });

        overlay.querySelector('#draft-apply-reset').addEventListener('click', async () => {
            // #250: hier stond escapeHtml(draftName). Die variabele bestaat in
            // deze functie niet; ze is een parameter van showReapplyAfterEditModal
            // verderop. De sjabloonstring wordt pas bij de klik uitgevoerd, dus
            // het werd een ReferenceError in een async handler: geen zichtbare
            // fout, geen bevestigingsvraag, de knop deed simpelweg niets.
            //
            // escapeHtml hoort hier sowieso niet: showConfirm zet de boodschap
            // als textContent, dus een concept "Vlot 1 & 2" werd "Vlot 1 &amp; 2".
            try {
                const dates = validateDates();
                if (!dates) return;
                const confirmed = await showConfirm(
                    `Dit verwijdert ALLE diensten in de periode ${dates.startDate} – ${dates.endDate} en zet alles terug naar het concept "${draft.name}", inclusief manuele aanpassingen en leeggemaakte dagen.\n\nDoorgaan?`,
                    'Reset alles naar concept'
                );
                if (!confirmed) return;
                cleanup();
                resolve({ ...dates, confirmOverwrite: true });
            } catch (fout) {
                // Een fout hier bleef stil in een afgewezen promise hangen.
                console.error('Reset alles mislukt:', fout);
                showToast('Reset alles mislukt: ' + getUserFriendlyError(fout), 'error');
            }
        });

        overlay.querySelector('#draft-apply-cancel').addEventListener('click', () => { cleanup(); resolve(null); });
        overlay.querySelector('#draft-apply-close').addEventListener('click', () => { cleanup(); resolve(null); });
        // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
        // en de muis buiten het kader loslaat.
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { cleanup(); resolve(null); } });
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
                    <button type="button" class="modal-close" id="reapply-close" aria-label="Sluiten"><i data-lucide="x"></i></button>
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
        // mousedown i.p.v. click: anders sluit de modal als je tekst selecteert
        // en de muis buiten het kader loslaat.
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { cleanup(); resolve(false); } });
    });
}

// --- Builder: Helpers ---

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
        if (blokkeerBijMislukteDraftLoad()) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.grid || !data.name) {
                showToast('Ongeldig conceptbestand', 'error');
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

// ===== WEEK KOPIËREN =====

function openCopyWeekModal() {
    const cycleLength = getBuilderCycleLength();
    if (cycleLength < 2) {
        showToast('Voeg meer weken toe om weken te kunnen kopiëren', 'warning');
        return;
    }

    const sourceSelect = document.getElementById('copy-week-source');
    const targetSelect = document.getElementById('copy-week-target');
    if (!sourceSelect || !targetSelect) return;

    const options = Array.from({ length: cycleLength }, (_, i) => i + 1)
        .map(w => `<option value="${w}">Week ${w}${w === AppState.builderWeekNumber ? ' (huidig)' : ''}</option>`)
        .join('');
    sourceSelect.innerHTML = options;
    targetSelect.innerHTML = options;

    sourceSelect.value = AppState.builderWeekNumber;
    targetSelect.value = AppState.builderWeekNumber === cycleLength ? 1 : AppState.builderWeekNumber + 1;

    updateCopyWeekConflictWarning();
    toonModal(document.getElementById('copy-week-modal'));
}

function updateCopyWeekConflictWarning() {
    const targetWeek = Number(document.getElementById('copy-week-target')?.value);
    const conflictRow = document.getElementById('copy-week-conflict-row');
    const conflictInfo = document.getElementById('copy-week-conflict-info');
    if (!conflictRow || !conflictInfo) return;

    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));
    const targetGrid = AppState.builderGridByWeek[targetWeek] || {};
    const shiftCount = Object.values(targetGrid).reduce((n, d) => n + Object.keys(d).length, 0);

    if (shiftCount > 0) {
        conflictInfo.textContent = `Week ${targetWeek} heeft al ${shiftCount} toewijzing${shiftCount !== 1 ? 'en' : ''}.`;
        conflictRow.classList.remove('hidden');
    } else {
        conflictRow.classList.add('hidden');
    }
}

function executeCopyWeek() {
    const sourceWeek = Number(document.getElementById('copy-week-source').value);
    const targetWeek = Number(document.getElementById('copy-week-target').value);
    const mode = document.querySelector('input[name="copy-mode"]:checked')?.value || 'replace';

    if (sourceWeek === targetWeek) {
        showToast('Bron- en doelweek mogen niet dezelfde zijn', 'warning');
        return;
    }

    AppState.builderGridByWeek[AppState.builderWeekNumber] = JSON.parse(JSON.stringify(AppState.builderGrid));

    const sourceGrid = JSON.parse(JSON.stringify(AppState.builderGridByWeek[sourceWeek] || {}));
    const targetGrid = AppState.builderGridByWeek[targetWeek] || {};

    let newTargetGrid;
    if (mode === 'replace') {
        newTargetGrid = sourceGrid;
    } else {
        newTargetGrid = JSON.parse(JSON.stringify(targetGrid));
        for (const [empId, days] of Object.entries(sourceGrid)) {
            if (!newTargetGrid[empId]) newTargetGrid[empId] = {};
            for (const [dayIndex, shift] of Object.entries(days)) {
                if (!newTargetGrid[empId][dayIndex]) {
                    newTargetGrid[empId][dayIndex] = shift;
                }
            }
        }
    }

    AppState.builderGridByWeek[targetWeek] = newTargetGrid;
    AppState.builderWeekNumber = targetWeek;
    AppState.builderGrid = JSON.parse(JSON.stringify(newTargetGrid));
    // #210: via setBuilderDirty, anders wordt er geen automatische opslag
    // ingepland en blijft de statusregel "bewaard" tonen.
    setBuilderDirty();

    verbergModal(document.getElementById('copy-week-modal'));
    renderBuilder();
    showToast(`Week ${sourceWeek} gekopieerd naar week ${targetWeek}`, 'success');
}

// ===== CONCEPT VERGELIJKER =====

function openDraftDiffModal() {
    const drafts = DataStore.settings.schedule_drafts || [];
    const selA = document.getElementById('draft-diff-a');
    const selB = document.getElementById('draft-diff-b');
    if (!selA || !selB) return;

    const options = drafts.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('');
    selA.innerHTML = options;
    selB.innerHTML = options;
    if (drafts.length >= 2) selB.selectedIndex = 1;

    document.getElementById('draft-diff-result').innerHTML = '';
    toonModal(document.getElementById('draft-diff-modal'));
}

function diffDrafts(draftA, draftB) {
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
    const results = [];

    const getWeeks = grid => grid?._multiWeek
        ? Object.keys(grid).filter(k => !k.startsWith('_')).map(Number).sort((a, b) => a - b)
        : [1];

    const getWeekGrid = (grid, week) => grid?._multiWeek ? (grid[week] || {}) : (grid || {});

    const weeksA = getWeeks(draftA.grid);
    const weeksB = getWeeks(draftB.grid);
    const allWeeks = [...new Set([...weeksA, ...weeksB])].sort((a, b) => a - b);

    const allEmpIds = new Set();
    allWeeks.forEach(w => {
        Object.keys(getWeekGrid(draftA.grid, w)).forEach(id => allEmpIds.add(Number(id)));
        Object.keys(getWeekGrid(draftB.grid, w)).forEach(id => allEmpIds.add(Number(id)));
    });

    allEmpIds.forEach(empId => {
        const emp = getEmployee(empId);
        const empName = emp ? emp.name : `Medewerker ${empId}`;
        const changes = [];

        allWeeks.forEach(week => {
            const gridA = getWeekGrid(draftA.grid, week);
            const gridB = getWeekGrid(draftB.grid, week);
            const daysA = gridA[empId] || {};
            const daysB = gridB[empId] || {};
            const allDays = new Set([...Object.keys(daysA), ...Object.keys(daysB)].map(Number));

            allDays.forEach(day => {
                const a = daysA[day];
                const b = daysB[day];
                const label = allWeeks.length > 1 ? `W${week} ${dayNames[day]}` : dayNames[day];

                if (!a && b) {
                    changes.push({ label, type: 'new', text: `${b.startTime}–${b.endTime}` });
                } else if (a && !b) {
                    changes.push({ label, type: 'removed', text: `${a.startTime}–${a.endTime}` });
                } else if (a && b && (a.startTime !== b.startTime || a.endTime !== b.endTime)) {
                    changes.push({ label, type: 'changed', textA: `${a.startTime}–${a.endTime}`, textB: `${b.startTime}–${b.endTime}` });
                }
            });
        });

        results.push({ empName, changes });
    });

    return results;
}

function runDraftDiff() {
    const selA = document.getElementById('draft-diff-a');
    const selB = document.getElementById('draft-diff-b');
    const resultEl = document.getElementById('draft-diff-result');
    if (!selA || !selB || !resultEl) return;

    const drafts = DataStore.settings.schedule_drafts || [];
    const draftA = drafts.find(d => d.id === selA.value);
    const draftB = drafts.find(d => d.id === selB.value);

    if (!draftA || !draftB) { resultEl.innerHTML = '<p class="text-warning">Selecteer twee verschillende concepten.</p>'; return; }
    if (draftA.id === draftB.id) { resultEl.innerHTML = '<p class="text-warning">Kies twee verschillende concepten.</p>'; return; }

    const diff = diffDrafts(draftA, draftB);
    const changed = diff.filter(r => r.changes.length > 0);

    if (changed.length === 0) {
        resultEl.innerHTML = '<p class="text-success mt-md">Geen verschillen gevonden.</p>';
        return;
    }

    const html = changed.map(({ empName, changes }) => `
        <div class="diff-emp-block">
            <div class="diff-emp-name">${escapeHtml(empName)}</div>
            <div class="diff-changes">
                ${changes.map(c => {
                    if (c.type === 'new') return `<div class="diff-row diff-new"><span class="diff-day">${escapeHtml(c.label)}</span><span>— → <strong>${escapeHtml(c.text)}</strong></span></div>`;
                    if (c.type === 'removed') return `<div class="diff-row diff-removed"><span class="diff-day">${escapeHtml(c.label)}</span><span><strong>${escapeHtml(c.text)}</strong> → —</span></div>`;
                    return `<div class="diff-row diff-changed"><span class="diff-day">${escapeHtml(c.label)}</span><span>${escapeHtml(c.textA)} → <strong>${escapeHtml(c.textB)}</strong></span></div>`;
                }).join('')}
            </div>
        </div>
    `).join('');

    resultEl.innerHTML = `<div class="diff-legend mb-sm">
        <span class="diff-badge diff-new">Nieuw</span>
        <span class="diff-badge diff-removed">Vervalt</span>
        <span class="diff-badge diff-changed">Gewijzigd</span>
    </div><div class="diff-results">${html}</div>`;
}


// ===== END ROOSTERBOUWER CONCEPTEN =====
