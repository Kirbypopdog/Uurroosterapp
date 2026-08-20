// HET VLOT ROOSTERPLANNING - VERLOFPLANNING
//
// Vervangt de gedeelde Excel "Verlofplanning". Twee modi per ronde:
//   'binair'   → kleine vakanties: werken / verlof
//   'voorkeur' → zomer: werken / liever niet / zeker niet (voorkeuren die de
//                planner daarna verdeelt)
//
// Invullen kan per week (standaard, weinig kliks op de telefoon) of per dag
// (schakelaar) omdat de praktijk soms het weekend apart aanduidt.

const LEAVE_STATUS = {
    werken:      { label: 'Werken',      kort: 'W', klasse: 'leave-werken' },
    verlof:      { label: 'Verlof',      kort: 'V', klasse: 'leave-verlof' },
    liever_niet: { label: 'Liever niet', kort: 'L', klasse: 'leave-liever-niet' },
    zeker_niet:  { label: 'Zeker niet',  kort: 'Z', klasse: 'leave-zeker-niet' },
};

// Welke keuzes een medewerker krijgt, afhankelijk van de modus
function leaveOptionsFor(mode) {
    return mode === 'voorkeur'
        ? ['werken', 'liever_niet', 'zeker_niet']
        : ['werken', 'verlof'];
}

function canManageLeave() {
    return ['admin', 'roosterverantwoordelijke'].includes(getEffectiveRole());
}

// ===== DATA =====

async function fetchLeaveRounds() {
    const data = await dataApiFetch('/leave-rounds');
    AppState.leaveRounds = data.rounds || [];
    return AppState.leaveRounds;
}

async function fetchLeaveRound(id) {
    const data = await dataApiFetch(`/leave-rounds/${id}`);
    AppState.leaveRound = data;
    return data;
}

// ===== WEEKINDELING =====
// Splitst de ronde in kalenderweken (ma-zo), begrensd door de rondedatums.
function leaveWeeksOf(round) {
    const start = parseDateOnly(round.startDate);
    const end = parseDateOnly(round.endDate);
    const weeks = [];
    let cursor = getMondayOfWeek(start);
    while (cursor <= end) {
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(cursor);
            d.setDate(d.getDate() + i);
            if (d >= start && d <= end) days.push(formatDateYYYYMMDD(d));
        }
        if (days.length) weeks.push({ maandag: formatDateYYYYMMDD(cursor), days });
        cursor = new Date(cursor);
        cursor.setDate(cursor.getDate() + 7);
    }
    return weeks;
}

// Status van een hele week:
//   'werken'/'verlof'/...  → alle dagen delen deze status
//   null                   → gemengd (dagen verschillen onderling)
//   undefined              → nog niets ingevuld
// Leeg en gemengd moeten uit elkaar gehouden worden, anders krijgt een nog
// lege week ten onrechte de melding "gemengd — zie per dag".
function weekStatus(days, entryMap) {
    const set = new Set(days.map(d => entryMap[d] || ''));
    if (set.size !== 1) return null;
    const enige = [...set][0];
    return enige === '' ? undefined : enige;
}

function leaveWeekLabel(week) {
    const first = parseDateOnly(week.days[0]);
    const last = parseDateOnly(week.days[week.days.length - 1]);
    const fmt = d => d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
    return `${fmt(first)} – ${fmt(last)}`;
}

// ===== HOOFDWEERGAVE =====

async function renderLeave() {
    const container = document.getElementById('leave-content');
    if (!container) return;
    container.innerHTML = '<p class="no-items-text">Laden…</p>';

    try {
        const rounds = await fetchLeaveRounds();
        if (AppState.leaveRoundId && !rounds.some(r => r.id === AppState.leaveRoundId)) {
            AppState.leaveRoundId = null;
        }
        // Standaard de eerstvolgende open ronde tonen
        if (!AppState.leaveRoundId) {
            const open = rounds.find(r => r.status === 'open') || rounds[0];
            AppState.leaveRoundId = open ? open.id : null;
        }
        if (!AppState.leaveRoundId) {
            container.innerHTML = renderLeaveEmptyState();
            IconHelper.init(container);
            bindLeaveManageButtons(container);
            return;
        }
        const data = await fetchLeaveRound(AppState.leaveRoundId);
        container.innerHTML = renderLeaveRoundHtml(rounds, data);
        IconHelper.init(container);
        bindLeaveEvents(container, data);
    } catch (err) {
        console.error('Verlof laden mislukt:', err);
        container.innerHTML = '<p class="no-items-text">Verlofplanning kon niet geladen worden.</p>';
    }
}

function renderLeaveEmptyState() {
    return `
        <div class="leave-empty">
            ${IconHelper.html('palmtree', 'lg')}
            <p>Er loopt momenteel geen verlofronde.</p>
            ${canManageLeave()
                ? '<button class="btn btn-primary" id="leave-new-round">Verlofronde starten</button>'
                : '<p class="text-muted text-sm">Je leidinggevende opent een ronde wanneer het zover is.</p>'}
        </div>`;
}

function renderLeaveRoundHtml(rounds, data) {
    const { round, entries, submissions } = data;
    const mode = round.mode;
    const me = Number(AppState.currentUser?.id);
    const mySub = submissions.find(s => Number(s.userId) === me);
    const tab = AppState.leaveTab || 'invullen';

    const roundPicker = rounds.length > 1 ? `
        <select id="leave-round-select" class="form-input leave-round-select">
            ${rounds.map(r => `<option value="${r.id}" ${r.id === round.id ? 'selected' : ''}>
                ${escapeHtml(r.name)}${r.status !== 'open' ? ` (${escapeHtml(r.status)})` : ''}
            </option>`).join('')}
        </select>` : '';

    return `
        <div class="leave-header-card">
            <div class="leave-header-top">
                <div>
                    <h3>${escapeHtml(round.name)}</h3>
                    <p class="text-muted text-sm">
                        ${mode === 'voorkeur' ? 'Voorkeuren doorgeven' : 'Verlof aanduiden'}
                        · ${escapeHtml(round.startDate)} t/m ${escapeHtml(round.endDate)}
                        ${round.deadline ? ` · indienen vóór ${escapeHtml(round.deadline)}` : ''}
                    </p>
                </div>
                ${roundPicker}
            </div>
            ${renderLeaveStatusBanner(round, mySub)}
            ${renderLeaveRules(round)}
        </div>

        <div class="leave-tabs">
            <button class="leave-tab ${tab === 'invullen' ? 'active' : ''}" data-leave-tab="invullen">Mijn verlof</button>
            <button class="leave-tab ${tab === 'overzicht' ? 'active' : ''}" data-leave-tab="overzicht">Overzicht iedereen</button>
        </div>

        ${tab === 'invullen'
            ? renderLeaveFill(round, entries, mySub)
            : renderLeaveMatrix(round, entries, submissions)}
    `;
}

function renderLeaveStatusBanner(round, mySub) {
    if (round.status === 'concept') {
        return '<div class="leave-banner leave-banner-info">Deze ronde is nog een concept en niet zichtbaar voor medewerkers.</div>';
    }
    if (round.status === 'toegepast') {
        return '<div class="leave-banner leave-banner-ok">Deze ronde is verwerkt — het verlof staat in de planning.</div>';
    }
    if (round.status === 'gesloten') {
        return '<div class="leave-banner leave-banner-info">Deze ronde is gesloten. Je kan niets meer aanpassen.</div>';
    }
    if (mySub?.approved === true) {
        return '<div class="leave-banner leave-banner-ok">Je verlof is goedgekeurd.</div>';
    }
    if (mySub?.approved === false) {
        return `<div class="leave-banner leave-banner-warn">Je aanvraag is afgewezen.${
            mySub.responseNote ? ' ' + escapeHtml(mySub.responseNote) : ''}</div>`;
    }
    if (mySub?.submittedAt) {
        return '<div class="leave-banner leave-banner-ok">Ingediend — wacht op goedkeuring. Je kan nog aanpassen tot de deadline.</div>';
    }
    return '<div class="leave-banner leave-banner-warn">Je hebt nog niets ingediend.</div>';
}

function renderLeaveRules(round) {
    const r = round.rules || {};
    const regels = [];
    if (r.zekerNietWeken)  regels.push(`Duid ${r.zekerNietWeken} week(en) <strong>zeker niet</strong> aan`);
    if (r.lieverNietWeken) regels.push(`Duid ${r.lieverNietWeken} week(en) <strong>liever niet</strong> aan`);
    if (r.maxOpeenvolgend) regels.push(`Maximum ${r.maxOpeenvolgend} weken verlof na elkaar`);
    if (r.minWerkweken)    regels.push(`Minstens ${r.minWerkweken} week(en) werken`);
    if (r.toelichting)     regels.push(escapeHtml(r.toelichting));
    if (!regels.length) return '';
    return `<ul class="leave-rules">${regels.map(x => `<li>${x}</li>`).join('')}</ul>`;
}

// ===== INVULLEN =====

function renderLeaveFill(round, entries, mySub) {
    const me = Number(AppState.currentUser?.id);
    const entryMap = {};
    entries.filter(e => Number(e.userId) === me).forEach(e => { entryMap[e.date] = e.status; });
    AppState.leaveDraft = { ...entryMap };

    const weergave = AppState.leaveFillMode || 'week';
    const bewerkbaar = round.status === 'open' || canManageLeave();

    return `
        <div class="leave-fill">
            <div class="leave-fill-toolbar">
                <div class="leave-viewtoggle">
                    <button class="leave-viewtoggle-btn ${weergave === 'week' ? 'active' : ''}" data-leave-fillmode="week">Per week</button>
                    <button class="leave-viewtoggle-btn ${weergave === 'dag' ? 'active' : ''}" data-leave-fillmode="dag">Per dag</button>
                </div>
                ${renderLeaveLegend(round.mode)}
            </div>
            <div id="leave-fill-body">
                ${weergave === 'week'
                    ? renderLeaveFillWeeks(round, entryMap, bewerkbaar)
                    : renderLeaveFillDays(round, entryMap, bewerkbaar)}
            </div>
            <div id="leave-validation" class="leave-validation"></div>
            ${bewerkbaar ? `
                <div class="leave-fill-actions">
                    <button class="btn btn-secondary" id="leave-save">Opslaan</button>
                    <button class="btn btn-primary" id="leave-submit">
                        ${mySub?.submittedAt ? 'Opnieuw indienen' : 'Indienen'}
                    </button>
                </div>` : ''}
        </div>`;
}

function renderLeaveLegend(mode) {
    return `<div class="leave-legend">
        ${leaveOptionsFor(mode).map(s =>
            `<span class="leave-legend-chip ${LEAVE_STATUS[s].klasse}">${LEAVE_STATUS[s].label}</span>`
        ).join('')}
    </div>`;
}

function renderLeaveFillWeeks(round, entryMap, bewerkbaar) {
    const opties = leaveOptionsFor(round.mode);
    return `<div class="leave-week-list">
        ${leaveWeeksOf(round).map(week => {
            const status = weekStatus(week.days, entryMap);
            return `
            <div class="leave-week-row" data-week="${week.maandag}">
                <div class="leave-week-info">
                    <strong>${leaveWeekLabel(week)}</strong>
                    <span class="text-muted text-xs">${week.days.length} dagen</span>
                </div>
                <div class="leave-week-choices">
                    ${opties.map(s => `
                        <button class="leave-choice ${LEAVE_STATUS[s].klasse} ${status === s ? 'active' : ''}"
                                data-week-set="${week.maandag}" data-status="${s}"
                                ${bewerkbaar ? '' : 'disabled'}>
                            ${LEAVE_STATUS[s].label}
                        </button>`).join('')}
                </div>
                ${status === null ? '<span class="leave-mixed">gemengd — zie "per dag"</span>' : ''}
            </div>`;
        }).join('')}
    </div>`;
}

function renderLeaveFillDays(round, entryMap, bewerkbaar) {
    const opties = leaveOptionsFor(round.mode);
    const dagNamen = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
    return `<div class="leave-day-list">
        ${leaveWeeksOf(round).map(week => `
            <div class="leave-day-week">
                <div class="leave-day-week-head">${leaveWeekLabel(week)}</div>
                ${week.days.map(d => {
                    const dt = parseDateOnly(d);
                    const status = entryMap[d] || null;
                    return `
                    <div class="leave-day-row">
                        <div class="leave-day-label">
                            <strong>${dagNamen[dt.getDay()]}</strong>
                            <span>${dt.getDate()}/${dt.getMonth() + 1}</span>
                        </div>
                        <div class="leave-day-choices">
                            ${opties.map(s => `
                                <button class="leave-choice leave-choice-sm ${LEAVE_STATUS[s].klasse} ${status === s ? 'active' : ''}"
                                        data-day-set="${d}" data-status="${s}"
                                        ${bewerkbaar ? '' : 'disabled'}
                                        title="${LEAVE_STATUS[s].label}">
                                    ${LEAVE_STATUS[s].kort}
                                </button>`).join('')}
                        </div>
                    </div>`;
                }).join('')}
            </div>`).join('')}
    </div>`;
}

// ===== REGELCONTROLE =====
// Telt in hele weken: een week telt mee zodra hij volledig die status heeft.
function validateLeaveDraft(round) {
    const r = round.rules || {};
    const draft = AppState.leaveDraft || {};
    const weken = leaveWeeksOf(round);
    const statussen = weken.map(w => weekStatus(w.days, draft));
    const tel = s => statussen.filter(x => x === s).length;

    const meldingen = [];
    const nietIngevuld = weken.filter(w => w.days.some(d => !draft[d])).length;
    if (nietIngevuld) meldingen.push({ type: 'info', tekst: `${nietIngevuld} week(en) nog niet volledig ingevuld` });

    if (r.zekerNietWeken && tel('zeker_niet') < r.zekerNietWeken) {
        meldingen.push({ type: 'warn', tekst: `Nog ${r.zekerNietWeken - tel('zeker_niet')} week(en) "zeker niet" aan te duiden` });
    }
    if (r.lieverNietWeken && tel('liever_niet') < r.lieverNietWeken) {
        meldingen.push({ type: 'warn', tekst: `Nog ${r.lieverNietWeken - tel('liever_niet')} week(en) "liever niet" aan te duiden` });
    }
    if (r.minWerkweken && tel('werken') < r.minWerkweken) {
        meldingen.push({ type: 'warn', tekst: `Je moet minstens ${r.minWerkweken} week(en) werken` });
    }
    if (r.maxOpeenvolgend) {
        let reeks = 0, max = 0;
        statussen.forEach(s => {
            const vrij = s === 'verlof' || s === 'zeker_niet';
            reeks = vrij ? reeks + 1 : 0;
            max = Math.max(max, reeks);
        });
        if (max > r.maxOpeenvolgend) {
            meldingen.push({ type: 'warn', tekst: `${max} weken verlof na elkaar — maximum is ${r.maxOpeenvolgend}` });
        }
    }
    return meldingen;
}

function renderLeaveValidation(round) {
    const el = document.getElementById('leave-validation');
    if (!el) return;
    const meldingen = validateLeaveDraft(round);
    if (!meldingen.length) {
        el.innerHTML = '<div class="leave-check-ok">Alles ingevuld volgens de regels.</div>';
        return;
    }
    el.innerHTML = meldingen.map(m =>
        `<div class="leave-check leave-check-${m.type}">${escapeHtml(m.tekst)}</div>`
    ).join('');
}

// ===== OVERZICHT (matrix zoals de Excel) =====

function renderLeaveMatrix(round, entries, submissions) {
    const weken = leaveWeeksOf(round);
    const medewerkers = getAllEmployees(true);
    const perUser = {};
    entries.forEach(e => {
        const id = Number(e.userId);
        (perUser[id] = perUser[id] || {})[e.date] = e.status;
    });
    const subMap = {};
    submissions.forEach(s => { subMap[Number(s.userId)] = s; });

    const nogNiet = medewerkers.filter(m => !subMap[Number(m.id)]?.submittedAt);

    return `
        <div class="leave-matrix-wrap">
            ${nogNiet.length ? `
                <div class="leave-banner leave-banner-warn">
                    Nog niet ingediend: ${nogNiet.map(m => escapeHtml(m.name)).join(', ')}
                </div>` : ''}
            <div class="leave-matrix-scroll">
                <table class="leave-matrix">
                    <thead>
                        <tr>
                            <th class="leave-matrix-name">Medewerker</th>
                            ${weken.map(w => `<th title="${leaveWeekLabel(w)}">${
                                parseDateOnly(w.days[0]).getDate()}/${parseDateOnly(w.days[0]).getMonth() + 1}</th>`).join('')}
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${medewerkers.map(m => {
                            const map = perUser[Number(m.id)] || {};
                            const sub = subMap[Number(m.id)];
                            return `<tr>
                                <td class="leave-matrix-name">${escapeHtml(m.name)}</td>
                                ${weken.map(w => {
                                    const s = weekStatus(w.days, map);
                                    // null = gemengd (deels ingevuld), undefined = nog niets
                                    const kl = s ? LEAVE_STATUS[s].klasse : (s === null ? 'leave-gemengd' : 'leave-leeg');
                                    const titel = s ? LEAVE_STATUS[s].label : (s === null ? 'gemengd' : 'niet ingevuld');
                                    return `<td class="leave-cell ${kl}" title="${leaveWeekLabel(w)} — ${titel}"></td>`;
                                }).join('')}
                                <td class="leave-matrix-status">${
                                    sub?.approved === true ? '<span class="leave-pill-ok">goedgekeurd</span>'
                                    : sub?.approved === false ? '<span class="leave-pill-nee">afgewezen</span>'
                                    : sub?.submittedAt ? '<span class="leave-pill-wacht">ingediend</span>'
                                    : '<span class="leave-pill-leeg">—</span>'
                                }</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            ${canManageLeave() ? renderLeaveManagerActions(round, medewerkers, subMap) : ''}
        </div>`;
}

function renderLeaveManagerActions(round, medewerkers, subMap) {
    const teBeoordelen = medewerkers.filter(m => subMap[Number(m.id)]?.submittedAt && subMap[Number(m.id)]?.approved == null);
    return `
        <div class="leave-manager">
            <h4>Beheer</h4>
            ${teBeoordelen.length ? `
                <div class="leave-approve-list">
                    ${teBeoordelen.map(m => `
                        <div class="leave-approve-row">
                            <span>${escapeHtml(m.name)}</span>
                            <div>
                                <button class="btn btn-sm btn-secondary" data-leave-reject="${m.id}">Afwijzen</button>
                                <button class="btn btn-sm btn-primary" data-leave-approve="${m.id}">Goedkeuren</button>
                            </div>
                        </div>`).join('')}
                </div>` : '<p class="text-muted text-sm">Niets te beoordelen.</p>'}
            <div class="leave-manager-actions">
                ${round.status === 'open' ? '<button class="btn btn-secondary" id="leave-close">Ronde sluiten</button>' : ''}
                ${round.status === 'gesloten' ? '<button class="btn btn-primary" id="leave-apply">Verlof toepassen op planning</button>' : ''}
                <button class="btn btn-secondary" id="leave-export">Exporteren (CSV)</button>
            </div>
        </div>`;
}

// ===== INTERACTIE =====

function bindLeaveManageButtons(container) {
    container.querySelector('#leave-new-round')?.addEventListener('click', openLeaveRoundModal);
}

function bindLeaveEvents(container, data) {
    const { round } = data;

    container.querySelector('#leave-round-select')?.addEventListener('change', e => {
        AppState.leaveRoundId = Number(e.target.value);
        renderLeave();
    });

    container.querySelectorAll('[data-leave-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.leaveTab = btn.dataset.leaveTab;
            renderLeave();
        });
    });

    container.querySelectorAll('[data-leave-fillmode]').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.leaveFillMode = btn.dataset.leaveFillmode;
            renderLeave();
        });
    });

    // Hele week in één tik
    container.querySelectorAll('[data-week-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            const week = leaveWeeksOf(round).find(w => w.maandag === btn.dataset.weekSet);
            if (!week) return;
            week.days.forEach(d => { AppState.leaveDraft[d] = btn.dataset.status; });
            refreshLeaveFillBody(round);
        });
    });

    // Losse dag
    container.querySelectorAll('[data-day-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.leaveDraft[btn.dataset.daySet] = btn.dataset.status;
            refreshLeaveFillBody(round);
        });
    });

    container.querySelector('#leave-save')?.addEventListener('click', () => saveLeaveDraft(round, false));
    container.querySelector('#leave-submit')?.addEventListener('click', () => saveLeaveDraft(round, true));
    container.querySelector('#leave-close')?.addEventListener('click', () => setLeaveRoundStatus(round, 'gesloten'));
    container.querySelector('#leave-apply')?.addEventListener('click', () => applyLeaveRound(round));
    container.querySelector('#leave-export')?.addEventListener('click', () => exportLeaveRound(data));

    container.querySelectorAll('[data-leave-approve]').forEach(btn =>
        btn.addEventListener('click', () => decideLeave(round, btn.dataset.leaveApprove, true)));
    container.querySelectorAll('[data-leave-reject]').forEach(btn =>
        btn.addEventListener('click', () => decideLeave(round, btn.dataset.leaveReject, false)));

    if (AppState.leaveTab !== 'overzicht') renderLeaveValidation(round);
}

// Alleen het invulgedeelte hertekenen — scheelt flikkeren bij elke tik
function refreshLeaveFillBody(round) {
    const body = document.getElementById('leave-fill-body');
    if (!body) return;
    const bewerkbaar = round.status === 'open' || canManageLeave();
    body.innerHTML = (AppState.leaveFillMode === 'dag')
        ? renderLeaveFillDays(round, AppState.leaveDraft, bewerkbaar)
        : renderLeaveFillWeeks(round, AppState.leaveDraft, bewerkbaar);

    body.querySelectorAll('[data-week-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            const week = leaveWeeksOf(round).find(w => w.maandag === btn.dataset.weekSet);
            if (!week) return;
            week.days.forEach(d => { AppState.leaveDraft[d] = btn.dataset.status; });
            refreshLeaveFillBody(round);
        });
    });
    body.querySelectorAll('[data-day-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.leaveDraft[btn.dataset.daySet] = btn.dataset.status;
            refreshLeaveFillBody(round);
        });
    });
    renderLeaveValidation(round);
}

async function saveLeaveDraft(round, ookIndienen) {
    const entries = Object.entries(AppState.leaveDraft || {})
        .filter(([, status]) => status)
        .map(([date, status]) => ({ date, status }));

    if (ookIndienen) {
        const meldingen = validateLeaveDraft(round).filter(m => m.type === 'warn');
        if (meldingen.length) {
            const ok = await showConfirm(
                `Je invulling voldoet nog niet aan alle regels:\n\n${meldingen.map(m => '• ' + m.tekst).join('\n')}\n\nToch indienen?`,
                'Indienen'
            );
            if (!ok) return;
        }
    }

    try {
        await dataApiFetch(`/leave-rounds/${round.id}/entries`, {
            method: 'PUT',
            body: JSON.stringify({ entries })
        });
        if (ookIndienen) {
            await dataApiFetch(`/leave-rounds/${round.id}/submit`, { method: 'POST' });
            showToast('Verlof ingediend', 'success');
        } else {
            showToast('Opgeslagen', 'success');
        }
        renderLeave();
    } catch (err) {
        console.error('Verlof opslaan mislukt:', err);
        showToast('Opslaan mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

async function decideLeave(round, userId, approved) {
    try {
        await dataApiFetch(`/leave-rounds/${round.id}/submissions/${userId}`, {
            method: 'PUT',
            body: JSON.stringify({ approved })
        });
        showToast(approved ? 'Goedgekeurd' : 'Afgewezen', 'success');
        renderLeave();
    } catch (err) {
        showToast('Actie mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

async function setLeaveRoundStatus(round, status) {
    const ok = await showConfirm(
        status === 'gesloten'
            ? 'Ronde sluiten? Medewerkers kunnen daarna niets meer aanpassen.'
            : 'Status wijzigen?',
        'Verlofronde'
    );
    if (!ok) return;
    try {
        await dataApiFetch(`/leave-rounds/${round.id}`, {
            method: 'PUT',
            body: JSON.stringify({ status })
        });
        renderLeave();
    } catch (err) {
        showToast('Wijzigen mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

async function applyLeaveRound(round) {
    const ok = await showConfirm(
        'Goedgekeurd verlof wordt omgezet naar afwezigheden in de planning. Doorgaan?',
        'Verlof toepassen'
    );
    if (!ok) return;
    try {
        const res = await dataApiFetch(`/leave-rounds/${round.id}/apply`, { method: 'POST' });
        showToast(`${res.applied} verlofdagen toegepast`, 'success');
        await refreshAvailability?.();
        renderLeave();
    } catch (err) {
        showToast('Toepassen mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

// Export in hetzelfde raster als de Excel: rijen = dagen, kolommen = medewerkers
function exportLeaveRound(data) {
    const { round, entries } = data;
    const medewerkers = getAllEmployees(true);
    const perUser = {};
    entries.forEach(e => {
        const id = Number(e.userId);
        (perUser[id] = perUser[id] || {})[e.date] = e.status;
    });

    const dagNamen = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
    const rijen = [['dag', 'datum', ...medewerkers.map(m => m.name)]];
    leaveWeeksOf(round).forEach(week => {
        week.days.forEach(d => {
            const dt = parseDateOnly(d);
            rijen.push([
                dagNamen[dt.getDay()],
                d,
                ...medewerkers.map(m => {
                    const s = (perUser[Number(m.id)] || {})[d];
                    return s ? LEAVE_STATUS[s].label : '';
                })
            ]);
        });
    });

    const csv = rijen.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `verlofplanning-${round.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Export gedownload', 'success');
}

// ===== RONDE AANMAKEN (beheer) =====

function openLeaveRoundModal() {
    const perioden = DataStore.settings.holidayPeriods || [];
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.innerHTML = `
        <div class="modal-content modal-content--sm">
            <div class="modal-header">
                <h2>Verlofronde starten</h2>
                <button class="modal-close" aria-label="Sluiten">${IconHelper.html(ICONS.close, 'sm')}</button>
            </div>
            <div class="modal-body modal-body-padded">
                <div class="form-group">
                    <label class="form-label" for="lr-name">Naam</label>
                    <input id="lr-name" class="form-input" placeholder="bv. Zomer 2026">
                </div>
                <div class="form-group">
                    <label class="form-label">Soort</label>
                    <div class="concept-type-options">
                        <label class="concept-type-option selected" data-value="binair">
                            <input type="radio" name="lr-mode" value="binair" checked>
                            <div class="concept-type-info">
                                <strong>Kleine vakantie</strong>
                                <span>Werken of verlof — je duidt gewoon aan wanneer je vrij bent</span>
                            </div>
                        </label>
                        <label class="concept-type-option" data-value="voorkeur">
                            <input type="radio" name="lr-mode" value="voorkeur">
                            <div class="concept-type-info">
                                <strong>Zomer (voorkeuren)</strong>
                                <span>Werken / liever niet / zeker niet — jij verdeelt daarna</span>
                            </div>
                        </label>
                    </div>
                </div>
                ${perioden.length ? `
                <div class="form-group">
                    <label class="form-label" for="lr-period">Vakantieperiode overnemen</label>
                    <select id="lr-period" class="form-input">
                        <option value="">-- datums zelf invullen --</option>
                        ${perioden.map(p => `<option value="${escapeHtml(String(p.id))}"
                            data-start="${escapeHtml(p.startDate)}" data-end="${escapeHtml(p.endDate)}">
                            ${escapeHtml(p.name)} (${escapeHtml(p.startDate)} – ${escapeHtml(p.endDate)})
                        </option>`).join('')}
                    </select>
                </div>` : ''}
                <div class="form-row">
                    <div class="form-group">
                        <label class="form-label" for="lr-start">Van</label>
                        <input type="date" id="lr-start" class="form-input">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="lr-end">Tot</label>
                        <input type="date" id="lr-end" class="form-input">
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label" for="lr-deadline">Indienen vóór (optioneel)</label>
                    <input type="date" id="lr-deadline" class="form-input">
                </div>
                <details class="leave-rules-editor">
                    <summary>Regels (optioneel)</summary>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label" for="lr-zeker">Weken "zeker niet"</label>
                            <input type="number" id="lr-zeker" class="form-input" min="0" placeholder="bv. 2">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="lr-liever">Weken "liever niet"</label>
                            <input type="number" id="lr-liever" class="form-input" min="0" placeholder="bv. 2">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label" for="lr-minwerk">Minstens werken (weken)</label>
                            <input type="number" id="lr-minwerk" class="form-input" min="0" placeholder="bv. 1">
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="lr-maxop">Max verlof na elkaar</label>
                            <input type="number" id="lr-maxop" class="form-input" min="0" placeholder="bv. 3">
                        </div>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="lr-toelichting">Extra toelichting</label>
                        <input id="lr-toelichting" class="form-input"
                               placeholder="bv. wie kerst met weekend werkte, hoeft paas met weekend niet">
                    </div>
                </details>
            </div>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="lr-cancel">Annuleren</button>
                <button class="btn btn-primary" id="lr-save">Ronde openen</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    IconHelper.init(overlay);

    const sluit = () => overlay.remove();
    overlay.querySelector('.modal-close').addEventListener('click', sluit);
    overlay.querySelector('#lr-cancel').addEventListener('click', sluit);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) sluit(); });

    overlay.querySelectorAll('.concept-type-option').forEach(opt => {
        opt.addEventListener('click', () => {
            overlay.querySelectorAll('.concept-type-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            opt.querySelector('input').checked = true;
        });
    });

    // Vakantieperiode overnemen vult de datums in
    overlay.querySelector('#lr-period')?.addEventListener('change', e => {
        const opt = e.target.selectedOptions[0];
        if (opt?.dataset.start) {
            overlay.querySelector('#lr-start').value = opt.dataset.start;
            overlay.querySelector('#lr-end').value = opt.dataset.end;
            if (!overlay.querySelector('#lr-name').value.trim()) {
                overlay.querySelector('#lr-name').value = opt.textContent.trim().split(' (')[0];
            }
        }
    });

    overlay.querySelector('#lr-save').addEventListener('click', async () => {
        const naam = overlay.querySelector('#lr-name').value.trim();
        const start = overlay.querySelector('#lr-start').value;
        const eind = overlay.querySelector('#lr-end').value;
        if (!naam || !start || !eind) {
            showToast('Naam, van en tot zijn verplicht', 'warning');
            return;
        }
        if (eind < start) {
            showToast('De einddatum ligt vóór de startdatum', 'warning');
            return;
        }
        const getal = sel => {
            const v = parseInt(overlay.querySelector(sel).value, 10);
            return Number.isFinite(v) && v > 0 ? v : undefined;
        };
        const regels = {};
        const z = getal('#lr-zeker');        if (z) regels.zekerNietWeken = z;
        const l = getal('#lr-liever');       if (l) regels.lieverNietWeken = l;
        const w = getal('#lr-minwerk');      if (w) regels.minWerkweken = w;
        const m = getal('#lr-maxop');        if (m) regels.maxOpeenvolgend = m;
        const t = overlay.querySelector('#lr-toelichting').value.trim();
        if (t) regels.toelichting = t;

        try {
            const res = await dataApiFetch('/leave-rounds', {
                method: 'POST',
                body: JSON.stringify({
                    name: naam,
                    mode: overlay.querySelector('input[name="lr-mode"]:checked').value,
                    startDate: start,
                    endDate: eind,
                    deadline: overlay.querySelector('#lr-deadline').value || null,
                    holidayPeriodId: overlay.querySelector('#lr-period')?.value || null,
                    rules: regels,
                    status: 'open'
                })
            });
            sluit();
            AppState.leaveRoundId = res.round.id;
            showToast(`Verlofronde "${naam}" geopend`, 'success');
            renderLeave();
        } catch (err) {
            console.error('Ronde aanmaken mislukt:', err);
            showToast('Aanmaken mislukt: ' + getUserFriendlyError(err), 'error');
        }
    });
}
