// HET VLOT ROOSTERPLANNING - VERLOFPLANNING
//
// Vervangt de gedeelde Excel "Verlofplanning". Eén ronde = één SCHOOLJAAR.
// In de Excel stonden herfst/kerst/krokus/paas samen in één tab en de zomer
// (andere spelregels) in een aparte tab; dat model is hier overgenomen:
// een ronde bestaat uit blokken die verwijzen naar de vakantieperiodes uit
// Instellingen, elk met een eigen modus:
//   'binair'   → werken / verlof            (kleine vakanties)
//   'voorkeur' → werken / liever niet / zeker niet (zomer)
//
// Invullen kan per week (standaard, weinig kliks op de telefoon) of per dag,
// omdat de praktijk het weekend soms apart aanduidt.

const LEAVE_STATUS = {
    werken:      { label: 'Werken',      kort: 'W', klasse: 'leave-werken' },
    verlof:      { label: 'Verlof',      kort: 'V', klasse: 'leave-verlof' },
    liever_niet: { label: 'Liever niet', kort: 'L', klasse: 'leave-liever-niet' },
    zeker_niet:  { label: 'Zeker niet',  kort: 'Z', klasse: 'leave-zeker-niet' },
};

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

// ===== GESLOTEN DAGEN =====
// Of het toestel tijdens een vakantieweek open is, wordt beslist in het
// roosterconcept. De verlofronde neemt die beslissing bij het openen over
// (leave_round_blocks.closedDates), zodat een medewerker het ziet zonder de
// concepten te mogen lezen, en zodat later nog na te gaan is welke weekends
// toen werkweekends waren.
//
// null = onbekend (geen concept gekoppeld) · lege set = alles open.
function leaveClosedSet(block) {
    return Array.isArray(block?.closedDates) ? new Set(block.closedDates) : null;
}

// WEEKCONVENTIE — niet wijzigen zonder de bouwer mee te nemen.
// `_pattern.weeks["i"]` van een vakantieconcept betekent "de i-de maandagweek
// van de vakantieperiode". Dat is wat de bouwer toont en wat de mens aanklikt
// (app-builder.js getBuilderVakantieWeekStart). Het is NIET het weeknummer dat
// getWeekNumber() teruggeeft — dat rekent modulo een globale referentiedatum.
// Deze functie spiegelt daarom leaveWeeksOfBlock, zodat index i één-op-één
// blijft lopen met de weekrijen in het invulscherm.
function closedDatesFromPattern(periodeStart, blokStart, blokEind, pattern) {
    if (!pattern || !pattern.weeks) return [];
    const start = parseDateOnly(blokStart);
    const eind = parseDateOnly(blokEind);
    const dagen = [];
    let cursor = getMondayOfWeek(parseDateOnly(periodeStart));
    let w = 1;
    while (cursor <= eind) {
        // Weken voorbij de cyclus hebben geen entry: dan claimen we niets.
        const closedDays = pattern.weeks[String(w)]?.closedDays || [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(cursor);
            d.setDate(d.getDate() + i);
            if (d >= start && d <= eind && closedDays.includes(d.getDay())) {
                dagen.push(formatDateYYYYMMDD(d));
            }
        }
        cursor = new Date(cursor);
        cursor.setDate(cursor.getDate() + 7);
        w++;
    }
    return dagen;
}

// ===== WEEKINDELING (per blok) =====
// Een ronde loopt over een heel schooljaar met schoolweken ertussen; alleen
// de weken binnen een vakantieblok zijn relevant. Per week houden we open en
// gesloten dagen apart: op een gesloten dag valt niets in te vullen, dus die
// telt ook niet mee voor "alles ingevuld".
function leaveWeeksOfBlock(block) {
    const start = parseDateOnly(block.startDate);
    const end = parseDateOnly(block.endDate);
    const closed = leaveClosedSet(block);
    const weeks = [];
    let cursor = getMondayOfWeek(start);
    while (cursor <= end) {
        const days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(cursor);
            d.setDate(d.getDate() + i);
            if (d >= start && d <= end) days.push(formatDateYYYYMMDD(d));
        }
        if (days.length) {
            const closedDays = closed ? days.filter(d => closed.has(d)) : [];
            weeks.push({
                maandag: formatDateYYYYMMDD(cursor),
                days,
                closedDays,
                openDays: closed ? days.filter(d => !closed.has(d)) : days,
                weekendBekend: !!closed,
            });
        }
        cursor = new Date(cursor);
        cursor.setDate(cursor.getDate() + 7);
    }
    return weeks;
}

// Wat er deze week gesloten is. Meestal gaat dat over het weekend, maar een
// concept kan evengoed 25 december of 11 juli sluiten — dan moet de rij dát
// benoemen in plaats van "weekend open". Zonder concept: niets, want dan
// tonen we liever niks dan een gok.
function leaveWeekendInfo(week) {
    if (!week.weekendBekend) return null;
    const kort = d => ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'][parseDateOnly(d).getDay()];
    const isWeekend = d => [0, 6].includes(parseDateOnly(d).getDay());
    const weekenddagen = week.days.filter(isWeekend);
    const weekendDicht = weekenddagen.filter(d => week.closedDays.includes(d));

    if (!week.closedDays.length) {
        return weekenddagen.length ? { open: true, label: 'weekend open' } : null;
    }
    // Precies het hele weekend en niets anders: de vertrouwde formulering.
    if (weekenddagen.length && weekendDicht.length === weekenddagen.length
        && week.closedDays.length === weekendDicht.length) {
        return { open: false, label: 'weekend gesloten' };
    }
    // Alle andere gevallen benoemen de dagen zelf, bv. "vr, za, zo gesloten".
    return {
        open: weekendDicht.length < weekenddagen.length,
        deels: true,
        label: `${week.closedDays.map(kort).join(', ')} gesloten`
    };
}

// 'werken'/... = alle dagen gelijk · null = gemengd · undefined = nog leeg.
// Leeg en gemengd moeten uit elkaar blijven, anders krijgt een lege week
// ten onrechte de melding "gemengd".
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

// Alle dagen van een blok
function leaveDaysOfBlock(block) {
    return leaveWeeksOfBlock(block).flatMap(w => w.days);
}

// Enkel de dagen waarop iets in te vullen valt (voor de voortgangsteller)
function leaveOpenDaysOfBlock(block) {
    return leaveWeeksOfBlock(block).flatMap(w => w.openDays);
}

// Hoever staat iemand met één vakantie? Gesloten dagen tellen niet mee —
// anders staat de indienknop permanent op disabled zodra een weekend dicht is.
function leaveBlockProgress(block, entryMap) {
    const dagen = leaveOpenDaysOfBlock(block);
    const ingevuld = dagen.filter(d => entryMap[d]).length;
    return { totaal: dagen.length, ingevuld, klaar: ingevuld === dagen.length };
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
            AppState.leaveScreen = 'rondes';
        }
        // Bovenste niveau: de rondes zelf. Geen ronde gekozen? Altijd hier.
        if ((AppState.leaveScreen || 'rondes') === 'rondes' || !AppState.leaveRoundId) {
            AppState.leaveScreen = 'rondes';
            container.innerHTML = renderLeaveRoundsOverview(rounds);
            IconHelper.init(container);
            bindLeaveRoundsOverview(container);
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

// ===== NIVEAU 1: alle rondes als kaarten (zoals de roosterbouwer) =====

const LEAVE_ROUND_STATUS = {
    concept:   { label: 'Concept',  klasse: 'leave-rs-concept' },
    open:      { label: 'Open',     klasse: 'leave-rs-open' },
    gesloten:  { label: 'Gesloten', klasse: 'leave-rs-gesloten' },
    toegepast: { label: 'Verwerkt', klasse: 'leave-rs-toegepast' },
};

function renderLeaveRoundsOverview(rounds) {
    const lopend  = rounds.filter(r => r.status === 'open' || r.status === 'concept');
    const afgelopen = rounds.filter(r => r.status === 'gesloten' || r.status === 'toegepast');

    if (!rounds.length && !canManageLeave()) {
        return `
            <div class="leave-empty">
                ${IconHelper.html('palmtree', 'lg')}
                <p>Er loopt momenteel geen verlofronde.</p>
                <p class="text-muted text-sm">Je leidinggevende opent een ronde wanneer het zover is.</p>
            </div>`;
    }

    const groep = (titel, lijst) => !lijst.length ? '' : `
        <div class="leave-group">
            <div class="leave-group-title">${titel}</div>
            <div class="leave-round-grid">${lijst.map(renderLeaveRoundCard).join('')}</div>
        </div>`;

    return `
        ${canManageLeave() ? `
            <div class="leave-round-grid leave-round-grid-top">
                <button class="leave-round-card leave-round-new" id="leave-new-round">
                    ${IconHelper.html('plus', 'lg')}
                    <span class="text-xs">Nieuwe ronde</span>
                </button>
            </div>` : ''}
        ${groep('Lopend', lopend)}
        ${groep('Afgelopen', afgelopen)}
    `;
}

function renderLeaveRoundCard(r) {
    const st = LEAVE_ROUND_STATUS[r.status] || LEAVE_ROUND_STATUS.concept;
    const beheer = canManageLeave();

    // Wat de gebruiker zelf nog moet doen weegt zwaarder dan de rondestatus
    const eigen = r.myApproved === true  ? '<span class="leave-card-status leave-card-klaar">goedgekeurd</span>'
               : r.myApproved === false  ? '<span class="leave-card-status leave-card-afgewezen">afgewezen</span>'
               : r.mySubmittedAt         ? '<span class="leave-card-status leave-card-bezig">ingediend</span>'
               : r.status === 'open'     ? '<span class="leave-card-status leave-card-open">nog in te vullen</span>'
               : '';

    return `
        <div class="leave-round-card" data-open-round="${r.id}">
            <div class="leave-round-card-head">
                <strong>${escapeHtml(r.name)}</strong>
                <span class="leave-round-badge ${st.klasse}">${st.label}</span>
            </div>
            <div class="leave-round-card-meta">
                <span>${r.blockCount || 0} vakantie${r.blockCount === 1 ? '' : 's'}</span>
                <span>${leaveDatumKort(r.startDate)} – ${leaveDatumKort(r.endDate)}</span>
                ${r.deadline ? `<span>Indienen vóór ${leaveDatumKort(r.deadline)}</span>` : ''}
                ${beheer ? `<span>${r.submittedCount || 0} ingediend</span>` : ''}
            </div>
            ${eigen ? `<div class="leave-round-card-foot">${eigen}</div>` : ''}
        </div>`;
}

function bindLeaveRoundsOverview(container) {
    container.querySelector('#leave-new-round')?.addEventListener('click', openLeaveRoundModal);
    container.querySelectorAll('[data-open-round]').forEach(card =>
        card.addEventListener('click', () => {
            AppState.leaveRoundId = Number(card.dataset.openRound);
            AppState.leaveScreen = 'landing';
            AppState.leaveDraft = {};
            renderLeave();
        }));
}

// Router: standaard een rustige landingspagina met alleen de vakanties en
// hun status. Pas als je er één aantikt zie je het invulwerk.
function renderLeaveRoundHtml(rounds, data) {
    const { round, blocks = [], entries, submissions } = data;
    const scherm = AppState.leaveScreen || 'rondes';

    if (scherm === 'overzicht') return renderLeaveOverzichtScherm(round, blocks, entries, submissions);
    if (scherm === 'blok') {
        const block = blocks.find(b => String(b.id) === String(AppState.leaveBlockId));
        if (block) return renderLeaveBlokScherm(round, block, entries, submissions);
        AppState.leaveScreen = 'landing';
    }
    return renderLeaveLanding(rounds, round, blocks, entries, submissions);
}

// ===== LANDINGSPAGINA =====

function renderLeaveLanding(rounds, round, blocks, entries, submissions) {
    const me = Number(AppState.currentUser?.id);
    const mySub = submissions.find(s => Number(s.userId) === me);
    const entryMap = {};
    entries.filter(e => Number(e.userId) === me).forEach(e => { entryMap[e.date] = e.status; });
    // De draft is de bron voor opslaan, en "Opnieuw indienen" staat op deze
    // pagina. Zonder deze regel vertrekt hij leeg en wist het indienen alles.
    AppState.leaveDraft = { ...(AppState.leaveDraft || {}), ...entryMap };

    const klein = blocks.filter(b => b.mode === 'binair');
    const zomer = blocks.filter(b => b.mode === 'voorkeur');
    const alleKlaar = blocks.length > 0 && blocks.every(b => leaveBlockProgress(b, entryMap).klaar);
    const bewerkbaar = round.status === 'open';

    const groep = (titel, lijst) => !lijst.length ? '' : `
        <div class="leave-group">
            <div class="leave-group-title">${titel}</div>
            ${lijst.map(b => renderLeaveBlockCard(b, entryMap)).join('')}
        </div>`;

    return `
        <button class="leave-back" id="leave-back-rounds">${IconHelper.html('chevron-left', 'sm')} Alle rondes</button>
        <div class="leave-landing-head">
            <div>
                <h3>${escapeHtml(round.name)}</h3>
                ${round.deadline ? `<p class="text-muted text-sm">Indienen vóór ${escapeHtml(round.deadline)}</p>` : ''}
            </div>
            <div class="leave-header-actions">
                ${canManageLeave() ? `
                    <button class="btn-icon-only leave-round-delete" id="leave-delete" data-tooltip="Ronde verwijderen" data-tooltip-pos="left" aria-label="Ronde verwijderen">
                        ${IconHelper.html(ICONS.delete, 'sm')}
                    </button>` : ''}
            </div>
        </div>

        ${renderLeaveStatusBanner(round, mySub, alleKlaar)}

        ${groep('Kleine vakanties', klein)}
        ${groep('Zomer', zomer)}

        <div class="leave-landing-actions">
            ${bewerkbaar ? `<button class="btn btn-primary" id="leave-submit" ${alleKlaar ? '' : 'disabled'}>
                ${mySub?.submittedAt ? 'Opnieuw indienen' : 'Indienen'}
            </button>` : ''}
            <button class="btn btn-secondary" id="leave-goto-overzicht">Overzicht iedereen</button>
        </div>
        ${bewerkbaar && !alleKlaar
            ? '<p class="text-muted text-xs leave-submit-hint">Vul alle vakanties in om te kunnen indienen.</p>'
            : ''}
    `;
}

function renderLeaveBlockCard(block, entryMap) {
    const p = leaveBlockProgress(block, entryMap);
    const weken = leaveWeeksOfBlock(block).length;
    const status = p.klaar
        ? '<span class="leave-card-status leave-card-klaar">ingevuld</span>'
        : p.ingevuld > 0
            ? `<span class="leave-card-status leave-card-bezig">${p.ingevuld}/${p.totaal} dagen</span>`
            : '<span class="leave-card-status leave-card-open">nog niet ingevuld</span>';
    return `
        <button class="leave-card" data-open-block="${block.id}">
            <div class="leave-card-main">
                <strong>${escapeHtml(block.name)}</strong>
                <span class="text-muted text-xs">
                    ${leaveDatumKort(block.startDate)} – ${leaveDatumKort(block.endDate)} · ${weken} ${weken === 1 ? 'week' : 'weken'}
                </span>
            </div>
            ${status}
            ${IconHelper.html('chevron-right', 'sm', 'leave-card-chevron')}
        </button>`;
}

function leaveDatumKort(iso) {
    return parseDateOnly(iso).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
}

// ===== DETAIL: één vakantie =====

function renderLeaveBlokScherm(round, block, entries, submissions) {
    const me = Number(AppState.currentUser?.id);
    const entryMap = {};
    entries.filter(e => Number(e.userId) === me).forEach(e => { entryMap[e.date] = e.status; });
    AppState.leaveDraft = { ...(AppState.leaveDraft || {}), ...entryMap };

    // Medewerkers duiden hun vakantie per week aan. Per dag is enkel voor
    // beheerders: die leggen na het sluiten van een voorkeurblok de
    // definitieve verdeling vast, en dat kan wel op losse dagen uitkomen.
    const magPerDag = canManageLeave();
    const weergave = magPerDag ? (AppState.leaveFillMode || 'week') : 'week';
    const bewerkbaar = round.status === 'open' || canManageLeave();

    return `
        <button class="leave-back" id="leave-back">${IconHelper.html('chevron-left', 'sm')} Alle vakanties</button>
        <div class="leave-detail-head">
            <h3>${escapeHtml(block.name)}</h3>
            <p class="text-muted text-sm">
                ${leaveDatumKort(block.startDate)} – ${leaveDatumKort(block.endDate)} ·
                ${block.mode === 'voorkeur' ? 'geef je voorkeur' : 'werken of verlof'}
            </p>
        </div>
        <div class="leave-fill">
            <div class="leave-fill-toolbar">
                ${magPerDag ? `
                    <div class="leave-viewtoggle">
                        <button class="leave-viewtoggle-btn ${weergave === 'week' ? 'active' : ''}" data-leave-fillmode="week">Per week</button>
                        <button class="leave-viewtoggle-btn ${weergave === 'dag' ? 'active' : ''}" data-leave-fillmode="dag">Per dag</button>
                    </div>` : ''}
                <div class="leave-legend">
                    ${leaveOptionsFor(block.mode).map(s =>
                        `<span class="leave-legend-chip ${LEAVE_STATUS[s].klasse}">${LEAVE_STATUS[s].label}</span>`).join('')}
                </div>
            </div>
            <div id="leave-fill-body">
                ${weergave === 'dag'
                    ? renderLeaveFillDays(block, AppState.leaveDraft, bewerkbaar)
                    : renderLeaveFillWeeks(block, AppState.leaveDraft, bewerkbaar)}
            </div>
            ${bewerkbaar ? `
                <div class="leave-fill-actions">
                    <button class="btn btn-primary" id="leave-save-block">Bewaren en terug</button>
                </div>` : ''}
        </div>`;
}

function renderLeaveOverzichtScherm(round, blocks, entries, submissions) {
    return `
        <button class="leave-back" id="leave-back">${IconHelper.html('chevron-left', 'sm')} Terug</button>
        ${renderLeaveMatrix(round, blocks, entries, submissions)}`;
}

function renderLeaveStatusBanner(round, mySub, alleKlaar) {
    if (round.status === 'concept')   return '<div class="leave-banner leave-banner-info">Concept — nog niet zichtbaar voor medewerkers.</div>';
    if (round.status === 'toegepast') return '<div class="leave-banner leave-banner-ok">Verwerkt — het verlof staat in de planning.</div>';
    if (round.status === 'gesloten')  return '<div class="leave-banner leave-banner-info">Deze ronde is gesloten.</div>';
    if (mySub?.approved === true)     return '<div class="leave-banner leave-banner-ok">Je verlof is goedgekeurd.</div>';
    if (mySub?.approved === false)    return `<div class="leave-banner leave-banner-warn">Je aanvraag is afgewezen.${
        mySub.responseNote ? ' ' + escapeHtml(mySub.responseNote) : ''}</div>`;
    // Na een bijgewerkte weekendindeling kan een ingediende invulling gaten
    // hebben. "Je hebt al ingediend" zou dan geruststellen zonder reden.
    if (mySub?.submittedAt && alleKlaar === false) return '<div class="leave-banner leave-banner-warn">De weekendindeling is aangepast. Vul de ontbrekende weken opnieuw in en dien opnieuw in.</div>';
    if (mySub?.submittedAt)           return '<div class="leave-banner leave-banner-ok">Je hebt al ingediend, maar je kan nog aanpassen tot de deadline.</div>';
    return '<div class="leave-banner leave-banner-warn">Je hebt nog niets ingediend.</div>';
}

// ===== INVULLEN =====

function renderLeaveFillWeeks(block, entryMap, bewerkbaar) {
    const opties = leaveOptionsFor(block.mode);
    return `<div class="leave-week-list">
        ${leaveWeeksOfBlock(block).map(week => {
            // Alleen open dagen bepalen de status: een week met een gesloten
            // zaterdag zou anders eeuwig "gemengd" heten.
            const status = weekStatus(week.openDays, entryMap);
            const weekend = leaveWeekendInfo(week);
            const volledigDicht = week.openDays.length === 0;
            // Zonder gekoppeld concept tonen we niets over het weekend —
            // een verkeerde indeling tonen is erger dan geen.
            const chip = weekend
                ? `<span class="leave-weekend-chip ${weekend.open ? 'is-open' : 'is-dicht'}">${weekend.label}</span>`
                : '';
            return `
            <div class="leave-week-row ${volledigDicht ? 'is-gesloten' : ''}" data-week="${week.maandag}" data-block="${block.id}">
                <div class="leave-week-info">
                    <strong>${leaveWeekLabel(week)}</strong>
                    <span class="text-muted text-xs">${week.openDays.length} dagen${chip ? ' · ' : ''}</span>
                    ${chip}
                </div>
                ${volledigDicht ? '<span class="leave-week-dicht">volledig gesloten</span>' : `
                <div class="leave-week-choices">
                    ${opties.map(s => `
                        <button class="leave-choice ${LEAVE_STATUS[s].klasse} ${status === s ? 'active' : ''}"
                                data-week-set="${week.maandag}" data-block="${block.id}" data-status="${s}"
                                ${bewerkbaar ? '' : 'disabled'}>${LEAVE_STATUS[s].label}</button>`).join('')}
                </div>`}
                ${status === null && !volledigDicht ? '<span class="leave-mixed">gemengd — zie "per dag"</span>' : ''}
            </div>`;
        }).join('')}
    </div>`;
}

function renderLeaveFillDays(block, entryMap, bewerkbaar) {
    const opties = leaveOptionsFor(block.mode);
    const dagNamen = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
    return `<div class="leave-day-list">
        ${leaveWeeksOfBlock(block).map(week => `
            <div class="leave-day-week">
                <div class="leave-day-week-head">${leaveWeekLabel(week)}</div>
                ${week.days.map(d => {
                    const dt = parseDateOnly(d);
                    const status = entryMap[d] || null;
                    const dicht = week.closedDays.includes(d);
                    return `
                    <div class="leave-day-row ${dicht ? 'is-gesloten' : ''}">
                        <div class="leave-day-label">
                            <strong>${dagNamen[dt.getDay()]}</strong>
                            <span>${dt.getDate()}/${dt.getMonth() + 1}</span>
                        </div>
                        ${dicht ? '<span class="leave-day-dicht">gesloten</span>' : `
                        <div class="leave-day-choices">
                            ${opties.map(s => `
                                <button class="leave-choice leave-choice-sm ${LEAVE_STATUS[s].klasse} ${status === s ? 'active' : ''}"
                                        data-day-set="${d}" data-status="${s}" ${bewerkbaar ? '' : 'disabled'}
                                        data-tooltip="${LEAVE_STATUS[s].label}" data-tooltip-pos="top" aria-label="${LEAVE_STATUS[s].label}">${LEAVE_STATUS[s].kort}</button>`).join('')}
                        </div>`}
                    </div>`;
                }).join('')}
            </div>`).join('')}
    </div>`;
}

// ===== OVERZICHT (matrix zoals de Excel) =====

function renderLeaveMatrix(round, blocks, entries, submissions) {
    const medewerkers = getAllEmployees(true);
    const perUser = {};
    entries.forEach(e => {
        const id = Number(e.userId);
        (perUser[id] = perUser[id] || {})[e.date] = e.status;
    });
    const subMap = {};
    submissions.forEach(s => { subMap[Number(s.userId)] = s; });
    const nogNiet = medewerkers.filter(m => !subMap[Number(m.id)]?.submittedAt);

    const legendeItem = (klasse, label) =>
        `<span class="leave-legend-item"><span class="leave-legend-swatch ${klasse}"></span>${label}</span>`;
    // "verlof" en "zeker niet" delen dezelfde kleur (net als in de Excel).
    // Naast elkaar in één legende zou dat verwarren, dus toont de legende
    // alleen wat in deze ronde effectief voorkomt.
    const toontVoorkeur = blocks.some(b => b.mode === 'voorkeur');
    const toontBinair = blocks.some(b => b.mode !== 'voorkeur');

    const statusPil = m => {
        const sub = subMap[Number(m.id)];
        if (sub?.approved === true)  return '<span class="leave-pill-ok" data-tooltip="Goedgekeurd" data-tooltip-pos="bottom">ok</span>';
        if (sub?.approved === false) return '<span class="leave-pill-nee" data-tooltip="Afgewezen" data-tooltip-pos="bottom">afgewezen</span>';
        if (sub?.submittedAt)        return '<span class="leave-pill-wacht" data-tooltip="Ingediend, wacht op antwoord" data-tooltip-pos="bottom">ingediend</span>';
        return '<span class="leave-pill-leeg" data-tooltip="Nog niet ingediend" data-tooltip-pos="bottom">—</span>';
    };

    return `
        <div class="leave-matrix-wrap">
            ${nogNiet.length ? `
                <div class="leave-banner leave-banner-warn">
                    Nog niet ingediend (${nogNiet.length}): ${nogNiet.map(m => escapeHtml(m.name)).join(', ')}
                </div>` : '<div class="leave-banner leave-banner-ok">Iedereen heeft ingediend.</div>'}

            <div class="leave-legend">
                ${legendeItem('leave-werken', 'werken')}
                ${legendeItem('leave-verlof', toontBinair && toontVoorkeur ? 'verlof of zeker niet'
                                            : toontBinair ? 'verlof' : 'zeker niet')}
                ${toontVoorkeur ? legendeItem('leave-liever-niet', 'liever niet') : ''}
                ${legendeItem('leave-leeg', 'niet ingevuld')}
                ${blocks.some(b => Array.isArray(b.closedDates)) ? legendeItem('leave-gesloten', 'gesloten') : ''}
            </div>

            ${blocks.map(b => renderLeaveMatrixBlock(b, medewerkers, perUser, statusPil)).join('')}

            ${canManageLeave() ? renderLeaveManagerActions(round, medewerkers, subMap, nogNiet) : ''}
        </div>`;
}

// Eén tabel per vakantie, opgebouwd zoals de Excel: elke dag een rij, elke
// medewerker een kolom. De weekweergave die hier eerst stond vatte een week
// samen tot één vakje, waardoor je losse verlofdagen niet meer zag staan.
function renderLeaveMatrixBlock(block, medewerkers, perUser, statusPil) {
    const dagen = leaveDaysOfBlock(block);
    if (!dagen.length) return '';

    const gesloten = leaveClosedSet(block);
    // Op een gesloten dag is iedereen vrij; die meetellen zou een valse piek
    // geven en de "druk"-markering onterecht laten afgaan.
    const perDagVrij = dagen.map(d => gesloten?.has(d) ? null :
        medewerkers.filter(m => {
            const s = (perUser[Number(m.id)] || {})[d];
            return s && s !== 'werken';
        }).length
    );

    return `
        <div class="leave-matrix-block-wrap">
            <div class="leave-matrix-caption">
                <strong>${escapeHtml(block.name)}</strong>
                <span class="text-muted text-xs">${leaveBlockRange(block)} · ${
                    block.mode === 'voorkeur' ? 'voorkeuren' : 'werken of verlof'}</span>
            </div>
            <div class="leave-matrix-scroll">
                <table class="leave-matrix leave-matrix-days">
                    <thead>
                        <tr>
                            <th class="leave-matrix-day">Dag</th>
                            ${medewerkers.map(m => `<th class="leave-matrix-person">${escapeHtml(leaveShortName(m.name))}</th>`).join('')}
                            <th class="leave-matrix-count-head" data-tooltip="Aantal mensen dat die dag niet werkt" data-tooltip-pos="top">vrij</th>
                        </tr>
                        <tr class="leave-matrix-substatus">
                            <th></th>
                            ${medewerkers.map(m => `<th>${statusPil(m)}</th>`).join('')}
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${dagen.map((d, i) => {
                            const datum = parseDateOnly(d);
                            const weekend = datum.getDay() === 0 || datum.getDay() === 6;
                            const dicht = !!gesloten?.has(d);
                            return `<tr class="${weekend ? 'leave-row-weekend' : ''} ${dicht ? 'leave-row-gesloten' : ''}">
                                <td class="leave-matrix-day">${leaveDayLabel(datum)}${dicht ? ' <span class="leave-dicht-tag">dicht</span>' : ''}</td>
                                ${medewerkers.map(m => {
                                    // Gesloten moet visueel verschillen van niet ingevuld,
                                    // anders lijkt het alsof iedereen achterloopt.
                                    if (dicht) return `<td class="leave-cell leave-gesloten"
                                        data-tooltip="${leaveDayLabel(datum)} — gesloten" data-tooltip-pos="top"></td>`;
                                    const s = (perUser[Number(m.id)] || {})[d];
                                    const st = s ? LEAVE_STATUS[s] : null;
                                    return `<td class="leave-cell ${st ? st.klasse : 'leave-leeg'}"
                                        data-tooltip="${escapeHtml(m.name)} — ${leaveDayLabel(datum)} — ${st ? st.label : 'niet ingevuld'}"
                                        data-tooltip-pos="top"></td>`;
                                }).join('')}
                                <td class="leave-matrix-count ${perDagVrij[i] !== null && perDagVrij[i] > medewerkers.length / 2 ? 'leave-druk' : ''}">${perDagVrij[i] === null ? '—' : perDagVrij[i]}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
}

function leaveBlockRange(block) {
    const fmt = d => parseDateOnly(d).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
    return `${fmt(block.startDate)} – ${fmt(block.endDate)}`;
}

function leaveDayLabel(datum) {
    const dag = datum.toLocaleDateString('nl-BE', { weekday: 'short' }).replace('.', '');
    return `${dag} ${datum.getDate()}/${datum.getMonth() + 1}`;
}

// De kolommen zijn smal; "Anna Testerman" past niet. Voornaam + eerste letter
// van de achternaam is genoeg om mensen uit elkaar te houden.
function leaveShortName(naam) {
    const delen = String(naam || '').trim().split(/\s+/);
    return delen.length < 2 ? delen[0] || '' : `${delen[0]} ${delen[delen.length - 1][0]}.`;
}

function renderLeaveManagerActions(round, medewerkers, subMap, nogNiet) {
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
                ${round.status === 'open' ? `<button class="btn btn-secondary" id="leave-close" data-open="${nogNiet.length}">Ronde sluiten</button>` : ''}
                ${round.status === 'gesloten' ? '<button class="btn btn-primary" id="leave-apply">Verlof toepassen op planning</button>' : ''}
                <button class="btn btn-secondary" id="leave-resync">Weekends bijwerken uit concept</button>
                <button class="btn btn-secondary" id="leave-export">Exporteren (CSV)</button>
            </div>
        </div>`;
}

// ===== INTERACTIE =====

function bindLeaveEvents(container, data) {
    const { round, blocks = [] } = data;

    container.querySelector('#leave-new-round')?.addEventListener('click', openLeaveRoundModal);
    container.querySelector('#leave-delete')?.addEventListener('click', () => deleteLeaveRound(round));
    container.querySelector('#leave-back-rounds')?.addEventListener('click', () => {
        AppState.leaveScreen = 'rondes';
        AppState.leaveDraft = {};
        renderLeave();
    });

    // Navigatie tussen landing, één vakantie en het overzicht
    container.querySelectorAll('[data-open-block]').forEach(btn =>
        btn.addEventListener('click', () => {
            AppState.leaveBlockId = btn.dataset.openBlock;
            AppState.leaveScreen = 'blok';
            renderLeave();
        }));
    container.querySelector('#leave-back')?.addEventListener('click', () => {
        AppState.leaveScreen = 'landing';
        renderLeave();
    });
    container.querySelector('#leave-goto-overzicht')?.addEventListener('click', () => {
        AppState.leaveScreen = 'overzicht';
        renderLeave();
    });

    container.querySelectorAll('[data-leave-fillmode]').forEach(btn =>
        btn.addEventListener('click', () => { AppState.leaveFillMode = btn.dataset.leaveFillmode; renderLeave(); }));

    bindLeaveChoiceButtons(container, blocks);

    // Bewaren in het detailscherm keert terug naar het overzicht
    container.querySelector('#leave-save-block')?.addEventListener('click', async () => {
        await saveLeaveDraft(round, false, { terug: true });
    });
    container.querySelector('#leave-submit')?.addEventListener('click', () => saveLeaveDraft(round, true));
    container.querySelector('#leave-close')?.addEventListener('click', e => closeLeaveRound(round, Number(e.currentTarget.dataset.open || 0)));
    container.querySelector('#leave-apply')?.addEventListener('click', () => applyLeaveRound(round));
    container.querySelector('#leave-export')?.addEventListener('click', () => exportLeaveRound(data));
    container.querySelector('#leave-resync')?.addEventListener('click', () => resyncLeaveWeekends(data));

    container.querySelectorAll('[data-leave-approve]').forEach(btn =>
        btn.addEventListener('click', () => decideLeave(round, btn.dataset.leaveApprove, true)));
    container.querySelectorAll('[data-leave-reject]').forEach(btn =>
        btn.addEventListener('click', () => decideLeave(round, btn.dataset.leaveReject, false)));
}

function bindLeaveChoiceButtons(root, blocks) {
    root.querySelectorAll('[data-week-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            const block = blocks.find(b => String(b.id) === btn.dataset.block);
            const week = block && leaveWeeksOfBlock(block).find(w => w.maandag === btn.dataset.weekSet);
            if (!week) return;
            week.openDays.forEach(d => { AppState.leaveDraft[d] = btn.dataset.status; });
            // Een dag die intussen gesloten is mag geen invulling houden:
            // anders zet `apply` daar alsnog verlof op.
            week.closedDays.forEach(d => { delete AppState.leaveDraft[d]; });
            refreshLeaveFillBody(blocks);
        });
    });
    root.querySelectorAll('[data-day-set]').forEach(btn => {
        btn.addEventListener('click', () => {
            AppState.leaveDraft[btn.dataset.daySet] = btn.dataset.status;
            refreshLeaveFillBody(blocks);
        });
    });
}

// Alleen het invulgedeelte hertekenen — scheelt flikkeren bij elke tik
function refreshLeaveFillBody(blocks) {
    const body = document.getElementById('leave-fill-body');
    if (!body) return;
    const round = AppState.leaveRound?.round;
    const block = blocks.find(b => String(b.id) === String(AppState.leaveBlockId));
    if (!block) return;
    const bewerkbaar = round?.status === 'open' || canManageLeave();
    body.innerHTML = (AppState.leaveFillMode === 'dag' && canManageLeave())
        ? renderLeaveFillDays(block, AppState.leaveDraft, bewerkbaar)
        : renderLeaveFillWeeks(block, AppState.leaveDraft, bewerkbaar);
    bindLeaveChoiceButtons(body, blocks);
}

async function saveLeaveDraft(round, ookIndienen, opties = {}) {
    const entries = Object.entries(AppState.leaveDraft || {})
        .filter(([, status]) => status)
        .map(([date, status]) => ({ date, status }));

    // De server vervangt de volledige invulling. Leeg opslaan terwijl er op de
    // server wél iets staat, wist dus alles — dat is nooit de bedoeling van een
    // klik op Opslaan of Indienen.
    const me = Number(AppState.currentUser?.id);
    const opServer = (AppState.leaveRound?.entries || []).some(e => Number(e.userId) === me);
    if (entries.length === 0 && opServer) {
        showToast('Er is niets om op te slaan — je invulling is niet gewijzigd', 'warning');
        return;
    }

    try {
        await dataApiFetch(`/leave-rounds/${round.id}/entries`, {
            method: 'PUT', body: JSON.stringify({ entries })
        });
        if (ookIndienen) {
            await dataApiFetch(`/leave-rounds/${round.id}/submit`, { method: 'POST' });
            showToast('Verlof ingediend', 'success');
        } else {
            showToast('Opgeslagen', 'success');
        }
        if (opties.terug) AppState.leaveScreen = 'landing';
        renderLeave();
    } catch (err) {
        console.error('Verlof opslaan mislukt:', err);
        showToast('Opslaan mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

async function decideLeave(round, userId, approved) {
    try {
        await dataApiFetch(`/leave-rounds/${round.id}/submissions/${userId}`, {
            method: 'PUT', body: JSON.stringify({ approved })
        });
        showToast(approved ? 'Goedgekeurd' : 'Afgewezen', 'success');
        renderLeave();
    } catch (err) {
        showToast('Actie mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

// Sluiten waarschuwt expliciet wie nog niet indiende — anders sluit je een
// ronde dicht terwijl de helft nog niets heeft doorgegeven.
async function closeLeaveRound(round, aantalOpen) {
    const tekst = aantalOpen > 0
        ? `${aantalOpen} medewerker(s) hebben nog niets ingediend. Toch sluiten?\n\nNa het sluiten kunnen ze niets meer invullen.`
        : 'Ronde sluiten? Medewerkers kunnen daarna niets meer aanpassen.';
    if (!await showConfirm(tekst, 'Ronde sluiten')) return;
    try {
        await dataApiFetch(`/leave-rounds/${round.id}`, {
            method: 'PUT', body: JSON.stringify({ status: 'gesloten' })
        });
        renderLeave();
    } catch (err) {
        showToast('Sluiten mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

async function deleteLeaveRound(round) {
    if (!await showConfirm(
        `Verlofronde "${round.name}" verwijderen? Alle ingevulde verlofkeuzes van deze ronde gaan mee weg.\n\nAl toegepaste afwezigheden in de planning blijven staan.`,
        'Ronde verwijderen')) return;
    try {
        await dataApiFetch(`/leave-rounds/${round.id}`, { method: 'DELETE' });
        AppState.leaveRoundId = null;
        AppState.leaveScreen = 'rondes';
        AppState.leaveDraft = {};
        showToast('Verlofronde verwijderd', 'success');
        renderLeave();
    } catch (err) {
        showToast('Verwijderen mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

async function applyLeaveRound(round) {
    if (!await showConfirm(
        'Goedgekeurd verlof wordt omgezet naar afwezigheden in de planning. Doorgaan?',
        'Verlof toepassen')) return;
    try {
        const res = await dataApiFetch(`/leave-rounds/${round.id}/apply`, { method: 'POST' });
        showToast(`${res.applied} verlofdagen toegepast`, 'success');
        if (typeof refreshAvailability === 'function') await refreshAvailability();
        renderLeave();
    } catch (err) {
        showToast('Toepassen mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

// Export in hetzelfde raster als de Excel: rijen = dagen, kolommen = medewerkers
// Weekendindeling per blok opnieuw overnemen uit het gekoppelde concept.
// Bewust handmatig: een wijzigend concept mag de grondslag waarop mensen
// invulden niet stilzwijgend verschuiven.
async function resyncLeaveWeekends(data) {
    const { round, blocks = [] } = data;
    const teDoen = blocks
        .map(b => ({ blok: b, concept: leaveDraftsForPeriod(b.holidayPeriodId)[0] }))
        .filter(x => x.concept);

    if (!teDoen.length) {
        showToast('Geen vakantieconcept gevonden voor de blokken van deze ronde', 'warning');
        return;
    }

    const namen = teDoen.map(x => `${x.blok.name} ← "${x.concept.name}"`).join('\n');
    const gesloten = ['gesloten', 'toegepast'].includes(round.status);
    const bevestigd = await showConfirm(
        `${namen}\n\nInvulling op dagen die daardoor gesloten raken wordt verwijderd; wie al indiende moet die weken opnieuw invullen.${
            gesloten ? '\n\nLet op: deze ronde is al gesloten.' : ''}\n\nDoorgaan?`,
        'Weekends bijwerken uit concept'
    );
    if (!bevestigd) return;

    let gewist = 0;
    try {
        for (const { blok, concept } of teDoen) {
            const res = await dataApiFetch(
                `/leave-rounds/${round.id}/blocks/${blok.id}${gesloten ? '?force=1' : ''}`, {
                method: 'PUT',
                body: JSON.stringify({
                    closedDates: closedDatesFromPattern(blok.startDate, blok.startDate, blok.endDate, concept.grid?._pattern),
                    closedSource: {
                        draftId: String(concept.id), draftName: concept.name,
                        holidayPeriodId: String(blok.holidayPeriodId || ''),
                        syncedAt: new Date().toISOString(),
                        syncedBy: AppState.currentUser?.id ?? null,
                        syncedByName: AppState.currentUser?.name || ''
                    }
                })
            });
            gewist += res.entriesRemoved || 0;
        }
        showToast(gewist ? `Weekends bijgewerkt — ${gewist} ingevulde dagen vervallen` : 'Weekends bijgewerkt', 'success');
        renderLeave();
    } catch (err) {
        console.error('Weekends bijwerken mislukt:', err);
        showToast('Bijwerken mislukt: ' + getUserFriendlyError(err), 'error');
    }
}

function exportLeaveRound(data) {
    const { round, blocks = [], entries } = data;
    const medewerkers = getAllEmployees(true);
    const perUser = {};
    entries.forEach(e => {
        const id = Number(e.userId);
        (perUser[id] = perUser[id] || {})[e.date] = e.status;
    });

    const dagNamen = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
    const rijen = [['vakantie', 'dag', 'datum', 'open', ...medewerkers.map(m => m.name)]];
    blocks.forEach(block => {
        const gesloten = leaveClosedSet(block);
        leaveWeeksOfBlock(block).forEach(week => {
            week.days.forEach(d => {
                const dt = parseDateOnly(d);
                // leeg = geen concept gekoppeld, dus onbekend
                const open = gesloten ? (gesloten.has(d) ? 'nee' : 'ja') : '';
                rijen.push([
                    block.name, dagNamen[dt.getDay()], d, open,
                    ...medewerkers.map(m => {
                        const s = (perUser[Number(m.id)] || {})[d];
                        return s ? LEAVE_STATUS[s].label : '';
                    })
                ]);
            });
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

// ===== RONDE STARTEN =====
// Je kiest welke vakantieperiodes (uit Instellingen) bij dit schooljaar horen
// en per periode of het binair of op voorkeur ingevuld wordt.

// Vakantieconcepten die aan deze periode hangen, nieuwste eerst. Meerdere
// concepten per periode mag, dus laten we de beheerder kiezen in plaats van
// zelf te gokken.
function leaveDraftsForPeriod(periodId) {
    return (DataStore.settings.schedule_drafts || [])
        .filter(d => d.type === 'vakantie' && String(d.holidayPeriodId) === String(periodId))
        .sort((a, b) => (b.lastAppliedAt || '').localeCompare(a.lastAppliedAt || '')
                     || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

// Hoeveel weekends dit concept open respectievelijk gesloten laat.
function leaveWeekendTelling(periode, closedDates) {
    const blok = { startDate: periode.startDate, endDate: periode.endDate, closedDates };
    let open = 0, dicht = 0;
    leaveWeeksOfBlock(blok).forEach(w => {
        const info = leaveWeekendInfo(w);
        if (!info) return;
        if (info.open) open++; else dicht++;
    });
    return { open, dicht };
}

// De weekendindeling komt uit het vakantieconcept. Ontbreekt dat, dan zeggen
// we dat gewoon en blokkeren we niets: een ronde openen zonder concept mag.
function renderLeavePeriodConcept(p) {
    const concepten = leaveDraftsForPeriod(p.id);
    if (!concepten.length) {
        return `<span class="leave-period-concept is-leeg">Geen vakantieconcept — weekendinfo ontbreekt</span>`;
    }
    const beschrijf = d => {
        const t = leaveWeekendTelling(p, closedDatesFromPattern(p.startDate, p.startDate, p.endDate, d.grid?._pattern));
        return `${t.open} open, ${t.dicht} gesloten`;
    };
    if (concepten.length === 1) {
        return `<span class="leave-period-concept">Weekends uit "${escapeHtml(concepten[0].name)}": ${beschrijf(concepten[0])}</span>`;
    }
    return `<span class="leave-period-concept">Weekends uit:
        <select class="lr-period-draft form-input form-input-xs">
            ${concepten.map(d => `<option value="${escapeHtml(String(d.id))}">${escapeHtml(d.name)} — ${beschrijf(d)}</option>`).join('')}
        </select></span>`;
}

function openLeaveRoundModal() {
    const perioden = [...(DataStore.settings.holidayPeriods || [])]
        .sort((a, b) => parseDateOnly(a.startDate) - parseDateOnly(b.startDate));

    if (!perioden.length) {
        showToast('Voeg eerst vakantieperiodes toe bij Instellingen › Planning', 'warning');
        return;
    }

    // Zomervakantie krijgt standaard de voorkeur-modus, de rest binair
    const isZomer = p => /zomer|juli|augustus/i.test(p.name || '');

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
                    <input id="lr-name" class="form-input" placeholder="bv. Schooljaar 2026-2027">
                </div>
                <div class="form-group">
                    <label class="form-label" for="lr-deadline">Indienen vóór (optioneel)</label>
                    <input type="date" id="lr-deadline" class="form-input">
                </div>
                <div class="form-group">
                    <label class="form-label">Welke vakanties horen bij deze ronde?</label>
                    <p class="text-muted text-xs mb-sm">
                        Staat er een vakantie niet bij? Voeg ze toe bij Instellingen › Planning.
                    </p>
                    <div class="leave-period-picker">
                        ${perioden.map(p => `
                            <label class="leave-period-row">
                                <input type="checkbox" class="lr-period" value="${escapeHtml(String(p.id))}"
                                       data-name="${escapeHtml(p.name)}"
                                       data-start="${escapeHtml(p.startDate)}" data-end="${escapeHtml(p.endDate)}" checked>
                                <span class="leave-period-name">
                                    <strong>${escapeHtml(p.name)}</strong>
                                    <span class="text-muted text-xs">${escapeHtml(p.startDate)} – ${escapeHtml(p.endDate)}</span>
                                    ${renderLeavePeriodConcept(p)}
                                </span>
                                <select class="form-input lr-period-mode">
                                    <option value="binair" ${isZomer(p) ? '' : 'selected'}>Werken / verlof</option>
                                    <option value="voorkeur" ${isZomer(p) ? 'selected' : ''}>Voorkeuren</option>
                                </select>
                            </label>`).join('')}
                    </div>
                </div>
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

    overlay.querySelector('#lr-save').addEventListener('click', async () => {
        const naam = overlay.querySelector('#lr-name').value.trim();
        if (!naam) { showToast('Geef de ronde een naam', 'warning'); return; }

        const blocks = [...overlay.querySelectorAll('.lr-period')]
            .filter(cb => cb.checked)
            .map(cb => {
                const rij = cb.closest('.leave-period-row');
                const concepten = leaveDraftsForPeriod(cb.value);
                const gekozenId = rij.querySelector('.lr-period-draft')?.value;
                const concept = gekozenId
                    ? concepten.find(d => String(d.id) === String(gekozenId))
                    : concepten[0];
                const blok = {
                    name: cb.dataset.name,
                    startDate: cb.dataset.start,
                    endDate: cb.dataset.end,
                    holidayPeriodId: cb.value,
                    mode: rij.querySelector('.lr-period-mode').value
                };
                // Zonder concept blijft closedDates weg: dat betekent "onbekend",
                // en dat is iets anders dan "alle weekends open".
                if (concept) {
                    blok.closedDates = closedDatesFromPattern(
                        cb.dataset.start, cb.dataset.start, cb.dataset.end, concept.grid?._pattern);
                    blok.closedSource = {
                        draftId: String(concept.id),
                        draftName: concept.name,
                        holidayPeriodId: String(cb.value),
                        syncedAt: new Date().toISOString(),
                        syncedBy: AppState.currentUser?.id ?? null,
                        syncedByName: AppState.currentUser?.name || ''
                    };
                }
                return blok;
            });
        if (!blocks.length) { showToast('Kies minstens één vakantieperiode', 'warning'); return; }

        try {
            const res = await dataApiFetch('/leave-rounds', {
                method: 'POST',
                body: JSON.stringify({
                    name: naam,
                    deadline: overlay.querySelector('#lr-deadline').value || null,
                    blocks,
                    status: 'open'
                })
            });
            sluit();
            AppState.leaveRoundId = res.round.id;
            AppState.leaveDraft = {};
            AppState.leaveScreen = 'landing';
            showToast(`Verlofronde "${naam}" geopend`, 'success');
            renderLeave();
        } catch (err) {
            console.error('Ronde aanmaken mislukt:', err);
            showToast('Aanmaken mislukt: ' + getUserFriendlyError(err), 'error');
        }
    });
}

// De pure helpers (weekindeling, gesloten dagen, voortgang) hebben geen DOM
// nodig en worden in Node getest. In de browser bestaat `module` niet, dus
// deze guard verandert daar niets.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        leaveClosedSet,
        closedDatesFromPattern,
        leaveWeeksOfBlock,
        leaveWeekendInfo,
        leaveDaysOfBlock,
        leaveOpenDaysOfBlock,
        leaveBlockProgress,
        weekStatus,
    };
}
