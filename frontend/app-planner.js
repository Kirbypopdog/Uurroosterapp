// HET VLOT ROOSTERPLANNING - PLANNING RENDERING

// Welk element scrollt er écht? Op desktop is dat de shell (.app-views met
// overflow:auto), op mobiel het document zelf (zie de 900px-mediaquery in
// styles.css — daar scrollt de pagina natuurlijk zodat de URL-balk meebeweegt).
function getAppScrollEl() {
    const av = document.querySelector('.app-views');
    if (av && getComputedStyle(av).overflowY !== 'visible') return av;
    return document.scrollingElement || document.documentElement;
}

// Waarom is deze dag bewust leeg? De reden staat op de blokkade en bepaalt
// wat er in de tooltip en in de dienstmodal komt te staan. Een dag die is
// vrijgekomen door een ruil is iets anders dan een dag die iemand heeft
// leeggemaakt, en "leeggemaakt" klopt dan gewoon niet.
const BLOCK_REASON_LABELS = {
    manual_delete:   'Dienst hier verwijderd',
    manual_move:     'Dienst verplaatst naar een andere dag of collega',
    manual_swap:     'Dienst weggeruild',
    manual_takeover: 'Dienst afgestaan aan een collega'
};

function blockReasonLabel(reason) {
    return BLOCK_REASON_LABELS[reason] || 'Dag manueel leeggemaakt';
}

function renderPlanning() {
    // Save scroll position before re-rendering
    const scrollEl = getAppScrollEl();
    const savedScrollY = scrollEl ? scrollEl.scrollTop : 0;

    if (!AppState.currentWeekStart) {
        setCurrentWeek(new Date());
    }

    // Lazy-fetch public holidays for the visible days if not yet cached
    //
    // #300: dit haalde alleen het jaar van de zichtbare maandag op. Een week
    // kan over een jaarwissel lopen, en getPublicHoliday geeft null terug zodra
    // het jaar van die dag niet in de cache zit. In de week van maandag
    // 27 december stond 1 januari dus zonder feestdagmarkering, tot je één week
    // verder bladerde en het jaar alsnog werd opgehaald. Nu worden beide jaren
    // van het zichtbare bereik meegenomen.
    const visibleDate = AppState.currentWeekStart || new Date();
    const laatsteZichtbare = new Date(visibleDate);
    laatsteZichtbare.setDate(laatsteZichtbare.getDate() + 6);
    const zichtbareJaren = [...new Set([visibleDate.getFullYear(), laatsteZichtbare.getFullYear()])];
    const ontbrekendeJaren = zichtbareJaren.filter(
        jaar => !DataStore._publicHolidaysCache[jaar] && !DataStore._publicHolidaysFetching.has(jaar)
    );
    if (ontbrekendeJaren.length > 0) {
        Promise.all(ontbrekendeJaren.map(jaar => fetchPublicHolidays(jaar))).then(() => renderCalendar());
        return;
    }

    // #228: een validatieronde per render, zodat de meldingenbalk en het raster
    // hetzelfde antwoord delen in plaats van het twee keer uit te rekenen.
    beginValidatieRonde();

    updatePeriodDisplay();
    updateMobileDayDisplay();
    renderValidationAlerts();
    renderCalendar();
    // Set mobile day attribute after calendar is rendered
    updateTimelineMobileDayAttribute();

    // Update heatmap if visible
    const heatmapContainer = document.getElementById('coverage-heatmap-container');
    if (heatmapContainer && AppState.showHeatmap) {
        heatmapContainer.innerHTML = renderCoverageHeatmap();
        IconHelper.init(heatmapContainer);
    }

    // Sync heatmap button active class with state
    const heatmapBtn = document.getElementById('heatmap-toggle-btn');
    if (heatmapBtn) {
        heatmapBtn.classList.toggle('active', AppState.showHeatmap);
    }

    // Sync filter toggle switch state
    const filterBtn = document.getElementById('filter-shifts-toggle');
    if (filterBtn) {
        filterBtn.checked = AppState.filterOnlyWithShifts;
    }

    // Restore scroll position after DOM updates
    requestAnimationFrame(() => {
        if (scrollEl) scrollEl.scrollTop = savedScrollY;
    });

    // #228: de ronde sluiten, zodat een latere losse validatie (bijvoorbeeld bij
    // het opslaan van een dienst) verse gegevens gebruikt en niet iets uit deze
    // render.
    eindValidatieRonde();
}

// #258: calcPlanningHourlyHeadcount liep per aanroep over de VOLLEDIGE
// DataStore.shifts en parseerde daarbij elke start- en eindtijd opnieuw, ook
// voor de duizenden diensten die niets met die datum te maken hebben. Daarnaast
// deed hij per aanroep opnieuw DataStore.activities.filter(...). De heatmap
// roept hem 7 dagen maal 34 halfuurblokken aan, dus 238 keer per render.
//
// De index zit bewust in de functie zelf en niet in renderCoverageHeatmap:
// validateMinimumStaffing en de startpaginawaarschuwingen gebruiken dezelfde
// functie, en die profiteren nu mee.
//
// De index vervalt zodra een van de drie bronlijsten vervangen wordt. Dat is
// dezelfde identiteitscontrole als bij de validatie-index (#257): de app
// vervangt die arrays bij elke refresh, ze worden niet ter plaatse aangepast.
let _bezettingIndex = null;
let _bezettingBron = null;

function _bouwBezettingIndex() {
    const shifts = DataStore.shifts || [];
    const activities = DataStore.activities || [];
    const availability = DataStore.availability || [];

    // 'vrij' telt als afwezig: dat is een vaste vrije dag, dus die persoon staat
    // niet op de vloer. Zie de toelichting bij #204 verderop.
    const AFWEZIG = ['ziek', 'verlof', 'vrij'];
    const afwezig = new Set();
    for (const a of availability) {
        if (AFWEZIG.includes(a.type)) afwezig.add(`${a.employeeId || a.userId}_${a.date}`);
    }

    // Diensten per datum, met de tijden al omgerekend naar decimalen.
    const perDatum = new Map();
    for (const s of shifts) {
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        const startDec = sh + sm / 60;
        const endDec = eh + em / 60;
        let lijst = perDatum.get(s.date);
        if (!lijst) { lijst = []; perDatum.set(s.date, lijst); }
        lijst.push({
            team: s.team,
            emp: String(s.employeeId || s.userId || s.user_id),
            sleutel: `${s.employeeId || s.userId || s.user_id}_${s.date}`,
            startDec, endDec, isNight: endDec <= startDec
        });
    }

    // Activiteiten per datum, idem.
    const actPerDatum = new Map();
    for (const a of activities) {
        const [ash, asm] = a.startTime.split(':').map(Number);
        const [aeh, aem] = a.endTime.split(':').map(Number);
        let lijst = actPerDatum.get(a.date);
        if (!lijst) { lijst = []; actPerDatum.set(a.date, lijst); }
        lijst.push({ emp: String(a.userId), start: ash + asm / 60, eind: aeh + aem / 60 });
    }

    _bezettingIndex = { perDatum, actPerDatum, afwezig };
    _bezettingBron = {
        ruwShifts: DataStore.shifts,
        ruwActivities: DataStore.activities,
        ruwAvailability: DataStore.availability
    };
}

function _bezetting() {
    // De ruwe waarden vergelijken, niet de || []-variant: die maakt elke keer
    // een nieuwe lege array en zou de index altijd opnieuw laten bouwen.
    if (!_bezettingIndex
        || _bezettingBron.ruwShifts !== DataStore.shifts
        || _bezettingBron.ruwActivities !== DataStore.activities
        || _bezettingBron.ruwAvailability !== DataStore.availability) {
        _bouwBezettingIndex();
    }
    return _bezettingIndex;
}

/**
 * #163: de activiteitenchips stonden op zeven pixels, afgekort tot vier à vijf
 * letters ("Overl", "Vorm"). Dat was voor veel mensen niet te lezen, en groter
 * kon niet: op 8px hadden twee chips al 61 pixels nodig terwijl een dienst van
 * acht uur er 59 geeft.
 *
 * Ik heb het eerst omgebouwd naar een balkje onderaan op de juiste uren. Victor
 * vond de chips beter, omdat je daarmee ziet WAT er staat en niet alleen
 * wanneer. Terecht, en het echte probleem was de tekst en niet de vorm.
 *
 * De codes zijn nu twee letters (zie ACTIVITY_TYPE_LABELS_SHORT). Nagemeten:
 * "Overl" op 7px is 25 pixels breed, "OL" op 11px is 23. Er passen er dus
 * evenveel, maar de letter is de helft groter. De volledige naam en de tijd
 * staan in de tooltip.
 *
 * @param {Array} activiteiten  de activiteiten van deze dienst
 */
function activiteitenChips(activiteiten) {
    if (!activiteiten || !activiteiten.length) return '';
    const chips = activiteiten.map(act => {
        const kort = ACTIVITY_TYPE_LABELS_SHORT[act.type] || act.type;
        const vol = ACTIVITY_TYPE_LABELS_FULL[act.type] || act.type;
        const t = `${String(act.startTime).substring(0, 5)}-${String(act.endTime).substring(0, 5)}`;
        const titel = escapeHtml(`${vol} ${t}${act.description ? ' — ' + act.description : ''}`);
        return `<span class="activity-chip activity-type-${escapeHtml(act.type)}"`
             + ` data-activity-id="${act.id}" data-tooltip="${titel}">${escapeHtml(kort)}</span>`;
    }).join('');
    return `<div class="activity-chips-row">${chips}</div>`;
}

function calcPlanningHourlyHeadcount(date, hour) {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const index = _bezetting();

    // Previous day (for overnight shifts extending into this day)
    const prev = new Date(parseDateOnly(date));
    prev.setDate(prev.getDate() - 1);
    const prevDate = formatDateYYYYMMDD(prev);

    // #204: wie afwezig is telde gewoon mee. Een ziekmelding laat de dienst
    // namelijk staan: sick-with-takeover maakt afwezigheidsrijen en
    // overnameverzoeken aan, maar raakt de diensten niet. De grafiek meldde
    // daardoor drie mensen aan het werk terwijl het er twee waren, precies op
    // het moment dat het ertoe doet.
    //
    // 'vrij' telt hier ook als afwezig: dat is een vaste vrije dag, dus die
    // persoon staat niet op de vloer. Een dienst op zo'n dag is een
    // tegenstrijdigheid die de validatie elders meldt, niet iets om hier als
    // bezetting mee te tellen.
    // De afwezigheid hoort bij de dag waarop de dienst BEGINT, niet bij het uur
    // dat we tellen. Anders zou een nachtdienst van gisteravond wegvallen omdat
    // iemand zich vanochtend ziek meldde, of net blijven staan terwijl hij
    // gisteren al ziek was. Vandaar de sleutel op medewerker plus datum.
    const afwezig = index.afwezig;

    let bruto = 0;
    const workingEmployees = new Set(); // track who is working at this hour

    // Alleen de dag zelf en de dag ervoor; die laatste voor een nachtdienst die
    // doorloopt. De rest van het schooljaar staat hier buiten.
    for (const s of (index.perDatum.get(date) || [])) {
        if (!coverageTeams.includes(s.team)) continue;
        if (afwezig.has(s.sleutel)) continue;
        const isWorking = s.isNight
            ? hour >= s.startDec
            : (hour >= s.startDec && hour < s.endDec);
        if (isWorking) { bruto++; workingEmployees.add(s.emp); }
    }
    for (const s of (index.perDatum.get(prevDate) || [])) {
        if (!s.isNight) continue;
        if (!coverageTeams.includes(s.team)) continue;
        if (afwezig.has(s.sleutel)) continue;
        if (hour < s.endDec) { bruto++; workingEmployees.add(s.emp); }
    }

    // Netto: subtract employees who have an activity at this hour (only if they have a shift)
    let activityCount = 0;
    for (const act of (index.actPerDatum.get(date) || [])) {
        if (!workingEmployees.has(act.emp)) continue; // only count if employee has a shift
        if (hour >= act.start && hour < act.eind) activityCount++;
    }

    return { bruto, netto: bruto - activityCount };
}

// #342 en #350 hebben dezelfde oorzaak: er zijn geen bezettingsnormen. Zonder
// die normen blijft de bezettingsbalk één onzichtbare strook en slaat
// validateMinimumStaffing de controle stil over. Beide plekken vragen dus
// dezelfde vraag, en die staat hier één keer.
//
// De normen komen uit het actieve basisconcept. Er is dus geen norm bij een
// verse installatie, maar ook tussen twee schooljaren in, wanneer geen enkel
// concept de huidige datum dekt.
function heeftBezettingsnormen(datums) {
    if (typeof getStaffingRulesForDay !== 'function') return false;
    return datums.some(d => {
        const regels = getStaffingRulesForDay(d);
        return !!regels && regels.length > 0;
    });
}

// De uitleg die bij het ontbreken van normen hoort. Alleen beheerders kunnen er
// iets aan doen, dus een medewerker krijgt de verwijzing niet te zien.
function bezettingsnormenUitleg(extraKlasse) {
    const magBeheren = typeof hasPermission === 'function' && hasPermission('MANAGE_SHIFTS');
    const verwijzing = magBeheren
        ? ' Stel ze in bij Rooster bouwen, onder Bezetting.'
        : '';
    return `<div class="geen-bezettingsnormen${extraKlasse ? ' ' + extraKlasse : ''}">
        ${IconHelper.html('info', 'sm')}
        <span>Nog geen bezettingsnormen ingesteld, dus onderbezetting wordt niet gecontroleerd.${verwijzing}</span>
    </div>`;
}

function renderCoverageHeatmap() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const coverageTeamNames = coverageTeams.map(t => (DataStore.settings.teams || {})[t]?.name || t).join(' + ');

    let html = '<div class="coverage-heatmap">';
    html += `<div class="heatmap-title">Bezetting (${escapeHtml(coverageTeamNames)})</div>`;
    // #342: zonder normen krijgt elk segment de klasse seg-none, en die heeft
    // precies de achtergrondkleur van het paneel. De balk was dus leeg terwijl
    // de legende eronder vier kleuren aankondigde. Nu staat er waarom.
    if (!heeftBezettingsnormen(weekDates)) {
        html += bezettingsnormenUitleg('in-heatmap');
    }
    html += '<div class="heatmap-grid">';

    // Header row
    html += '<div class="heatmap-row heatmap-header">';
    html += '<div class="heatmap-team-cell"></div>';
    const dayNames = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
    weekDates.forEach(date => {
        const d = parseDateOnly(date);
        html += `<div class="heatmap-day-cell">${dayNames[d.getDay()]} ${d.getDate()}</div>`;
    });
    html += '</div>';

    // Single combined row
    html += '<div class="heatmap-row">';
    html += '<div class="heatmap-team-cell">Totaal</div>';

    weekDates.forEach(date => {
        const d = parseDateOnly(date);
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        const manualClosed = typeof isDayClosed === 'function' && isDayClosed(date);
        const closed = manualClosed || (isWeekend && typeof isWeekendOpen === 'function' && !isWeekendOpen(date));

        html += `<div class="coverage-heatmap-cell${closed ? ' closed' : ''}" data-date="${date}"
            onclick="showHeatmapDetail(null, '${date}')">`;

        if (!closed) {
            const dayRules = typeof getStaffingRulesForDay === 'function' ? getStaffingRulesForDay(date) : null;

            for (let h = 7; h < 24; h += 0.5) {
                const { bruto, netto } = calcPlanningHourlyHeadcount(date, h);

                let required = -1;
                if (dayRules) {
                    for (const rule of dayRules) {
                        if (h >= rule.from && h < rule.to)
                            required = Math.max(required, rule.min);
                    }
                }

                let segClass = 'heatmap-seg';
                if (required < 0) {
                    segClass += ' seg-none';
                } else if (netto >= required) {
                    segClass += ' seg-ok';
                } else if (netto > 0) {
                    segClass += ' seg-warn';
                } else {
                    segClass += ' seg-danger';
                }

                const leftPct = ((h - 7) / 17) * 100;
                const widthPct = (0.5 / 17) * 100;
                const timeLabel = formatStaffingHour(h);
                let tooltipText;
                if (required >= 0) {
                    tooltipText = netto < bruto
                        ? `${timeLabel} · ${netto}/${required} mdw (${bruto - netto} in activiteit)`
                        : `${timeLabel} · ${netto}/${required} mdw`;
                } else {
                    tooltipText = netto < bruto
                        ? `${timeLabel} · ${netto} beschikbaar (${bruto} ingepland, ${bruto - netto} in activiteit)`
                        : `${timeLabel} · ${bruto} medewerkers`;
                }
                html += `<span class="${segClass}" style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"
                    data-tooltip="${tooltipText}" data-tooltip-pos="top"></span>`;
            }
        }

        html += '</div>';
    });

    html += '</div>';
    html += '</div>';
    html += `<div class="heatmap-legend">
        <span class="heatmap-legend-item"><span class="heatmap-swatch seg-danger-swatch"></span>Onderbezet</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch seg-warn-swatch"></span>Krap</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch seg-ok-swatch"></span>Op sterkte</span>
        <span class="heatmap-legend-item"><span class="heatmap-swatch heatmap-closed"></span>Gesloten</span>
    </div>`;
    html += '</div>';

    return html;
}

function showHeatmapDetail(teamId, date) {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const teamsToShow = teamId ? [teamId] : coverageTeams;
    const shifts = DataStore.shifts.filter(s => teamsToShow.includes(s.team) && s.date === date);

    let msg = `Bezetting · ${formatDate(date)}\n`;
    if (shifts.length === 0) {
        msg += 'Geen diensten ingepland.';
    } else {
        shifts.forEach(s => {
            const emp = getEmployee(s.employeeId);
            const teamName = (DataStore.settings.teams || {})[s.team]?.name || s.team;
            msg += `${emp?.name || 'Onbekend'} (${teamName}): ${s.startTime} - ${s.endTime}\n`;
        });
    }
    showToast(msg.trim(), 'info', 5000);
}

const VALIDATION_CATEGORY_CONFIG = {
    'onderbezetting':          { icon: 'users',           label: 'Onderbezetting', level: 'warning' },
    '11-uur regel':            { icon: 'clock',           label: '11-uur regel',   level: 'error'   },
    'overlap':                 { icon: 'layers',          label: 'Overlap',        level: 'error'   },
    'medewerker afwezig':      { icon: 'calendar-x-2',   label: 'Afwezigheid',    level: 'warning' },
    'opeenvolgende diensten':  { icon: 'trending-up',     label: 'Aaneengesloten', level: 'warning' },
};

function renderValidationAlerts() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    // In day view only show alerts for the visible day, not the full week (#142)
    const startDate = AppState.viewMode === 'day' ? weekDates[AppState.mobileDayIndex] : weekDates[0];
    const endDate   = AppState.viewMode === 'day' ? weekDates[AppState.mobileDayIndex] : weekDates[6];
    const summary = getValidationSummary(startDate, endDate);

    let html = '';
    html += renderResponsibleSection();
    html += renderWeekLaadFout();
    // #350: de onderbezettingscontrole werd stil overgeslagen zonder normen.
    // Een week waarin niemand werkt gaf dus geen enkele melding, en de planner
    // ging ervan uit dat de app zou waarschuwen. Alleen tonen aan wie diensten
    // beheert: een medewerker heeft hier niets aan.
    const zichtbareDagen = AppState.viewMode === 'day' ? [weekDates[AppState.mobileDayIndex]] : weekDates;
    if (typeof hasPermission === 'function' && hasPermission('MANAGE_SHIFTS')
        && !heeftBezettingsnormen(zichtbareDagen)) {
        html += bezettingsnormenUitleg();
    }

    const breakdown = buildIssueBreakdown(summary);
    AppState.validationBreakdown = breakdown;

    if (breakdown.length > 0) {
        const totalCount = breakdown.reduce((n, b) => n + b.count, 0);
        const hasErrors = breakdown.some(b => b.isError);
        const titleIcon = hasErrors ? 'alert-circle' : 'alert-triangle';

        html += `<div class="validation-bar">
            <div class="validation-bar-header">
                <span class="validation-bar-title${hasErrors ? ' has-errors' : ''}">
                    ${IconHelper.html(titleIcon, 'sm')}
                    <strong>${totalCount}</strong>&nbsp;melding${totalCount !== 1 ? 'en' : ''}
                </span>
                <button class="btn btn-xs btn-ghost validation-bar-all" onclick="openValidationDetailsModal(null)">
                    Alle bekijken ${IconHelper.html('chevron-right', 'xs')}
                </button>
            </div>
            <div class="validation-chips">`;

        breakdown.forEach(item => {
            const cfg = VALIDATION_CATEGORY_CONFIG[item.rule.toLowerCase()] ||
                { icon: item.isError ? 'alert-circle' : 'alert-triangle', label: item.rule, level: item.isError ? 'error' : 'warning' };
            html += `<button class="validation-chip validation-chip-${cfg.level}" data-rule="${escapeHtml(item.rule)}" data-tooltip="Klik voor details">
                ${IconHelper.html(cfg.icon, 'sm')}
                <span>${escapeHtml(cfg.label)}</span>
                <span class="validation-chip-count">${item.count}</span>
            </button>`;
        });

        html += '</div></div>';
    }

    DOM.validationAlerts.innerHTML = html;
    IconHelper.init(DOM.validationAlerts);
}

function buildIssueBreakdown(summary) {
    const dismissedKeys = new Set(
        (DataStore.settings.dismissedAlerts || [])
            .filter(d => (Date.now() - new Date(d.dismissedAt).getTime()) < 45 * 24 * 60 * 60 * 1000)
            .map(d => d.key)
    );

    const issueBreakdown = {};

    Object.entries(summary.dates).sort().forEach(([date, dateIssues]) => {
        const allIssues = [
            ...dateIssues.errors.map(i => ({ ...i, isError: true })),
            ...dateIssues.warnings.map(i => ({ ...i, isError: false }))
        ];
        allIssues.forEach(issue => {
            const ruleName = issue.rule || 'Onbekende melding';

            // Genereer dismiss key (zelfde formaat als homepage)
            let dismissKey = null;
            if (ruleName === 'onderbezetting') {
                dismissKey = `unstaffed:${date}`;
            } else if (ruleName === '11-uur regel') {
                const empId = issue.shift2?.employeeId || issue.shift1?.employeeId || '';
                if (empId) dismissKey = `11h:${empId}:${date}`;
            } else if (ruleName === 'medewerker afwezig') {
                const empId = issue.shift?.employeeId || '';
                if (empId) dismissKey = `shift-absence:${empId}:${date}`;
            }

            if (dismissKey && dismissedKeys.has(dismissKey)) return;

            if (!issueBreakdown[ruleName]) {
                issueBreakdown[ruleName] = { count: 0, entries: [], isError: issue.isError };
            }
            issueBreakdown[ruleName].count++;
            if (issue.message) {
                issueBreakdown[ruleName].entries.push({
                    label: `${formatDate(date)}: ${issue.message}`,
                    key: dismissKey
                });
            }
        });
    });

    return Object.entries(issueBreakdown)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([rule, info]) => ({ rule, count: info.count, entries: info.entries, isError: info.isError }));
}

function renderIssueEntryList(entries) {
    const COLLAPSE_AT = 7;
    const canDismiss = ['admin', 'roosterverantwoordelijke'].includes(AppState.currentUser?.role);
    const renderEntry = e => `<li class="issue-entry">
        <span class="issue-entry-label">${escapeHtml(e.label)}</span>
        ${e.key && canDismiss ? `<button class="issue-entry-dismiss btn-ghost" data-tooltip="Negeren" onclick="dismissFromPlanningTab('${escapeHtml(e.key)}')">${IconHelper.html('eye-off', 'xs')}</button>` : ''}
    </li>`;
    if (entries.length <= COLLAPSE_AT) {
        return `<ul class="issue-entry-list">${entries.map(renderEntry).join('')}</ul>`;
    }
    const visible = entries.slice(0, COLLAPSE_AT).map(renderEntry).join('');
    const hidden = entries.slice(COLLAPSE_AT).map(renderEntry).join('');
    return `<ul class="issue-entry-list">${visible}</ul>
        <div class="issue-details-more">
            <button class="issue-details-more-toggle" onclick="this.closest('.issue-details-more').classList.toggle('issue-details-more--open')">
                <span class="show-more">Toon ${entries.length - COLLAPSE_AT} meer <i data-lucide="chevron-down" class="lucide-xs"></i></span>
                <span class="show-less">Toon minder <i data-lucide="chevron-up" class="lucide-xs"></i></span>
            </button>
            <ul class="issue-entry-list issue-details-more-list">${hidden}</ul>
        </div>`;
}
// Legacy alias (used by older callers if any)
function renderIssueMessageList(messages) {
    return renderIssueEntryList(messages.map(m => ({ label: m, key: null })));
}

function openValidationDetailsModal(filterRule) {
    if (!DOM.warningDetailsModal) return;
    const breakdown = (AppState.validationBreakdown || [])
        .filter(item => !filterRule || item.rule === filterRule);

    // Update modal title dynamically
    const titleEl = DOM.warningDetailsModal.querySelector('.modal-header h2');
    if (titleEl) {
        if (filterRule) {
            const cfg = VALIDATION_CATEGORY_CONFIG[filterRule.toLowerCase()];
            titleEl.textContent = cfg ? cfg.label : filterRule;
        } else {
            titleEl.textContent = 'Meldingen';
        }
    }

    DOM.warningDetailsList.innerHTML = breakdown.length === 0
        ? '<p>Geen meldingen voor deze periode.</p>'
        : breakdown.map(item => {
            const cfg = VALIDATION_CATEGORY_CONFIG[item.rule.toLowerCase()] ||
                { icon: item.isError ? 'alert-circle' : 'alert-triangle', label: item.rule, level: item.isError ? 'error' : 'warning' };
            return `<div class="issue-details-item issue-details-level-${cfg.level}">
                <div class="issue-details-header">
                    ${IconHelper.html(cfg.icon, 'sm')}
                    <span class="issue-details-rule">${escapeHtml(cfg.label)}</span>
                    <span class="issue-details-count">${item.count}x</span>
                </div>
                ${item.entries.length ? `<div class="issue-details-messages">${renderIssueEntryList(item.entries)}</div>` : ''}
            </div>`;
        }).join('');

    DOM.warningDetailsModal.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeWarningDetailsModal() {
    if (!DOM.warningDetailsModal) return;
    DOM.warningDetailsModal.classList.add('hidden');
}
// Backwards compat aliases
function openWarningDetailsModal() { openValidationDetailsModal(); }
function openErrorDetailsModal() { openValidationDetailsModal(); }
function closeErrorDetailsModal() { closeWarningDetailsModal(); }

async function dismissFromPlanningTab(key) {
    if (typeof dismissAlert === 'function') {
        await dismissAlert(key);
        renderValidationAlerts();
        closeWarningDetailsModal();
    }
}

// #331: de balk voor een week die niet geladen kon worden. Staat boven de
// meldingen, want zolang de diensten onbekend zijn, zeggen die meldingen ook
// niets betrouwbaars over deze week.
function renderWeekLaadFout() {
    const fout = AppState.weekLaadFout;
    if (!fout) return '';
    // Alleen tonen bij de week waar het om ging. Doorbladeren naar een week die
    // wel werkte mag de balk niet meesleuren.
    if (fout.week !== formatDateYYYYMMDD(AppState.currentWeekStart)) return '';
    return `<div class="week-laadfout" role="alert">
        <span class="week-laadfout-tekst">
            ${IconHelper.html('alert-circle', 'sm')}
            <strong>Deze week kon niet geladen worden.</strong>
            De diensten hieronder zijn onbekend, niet leeg.${fout.melding ? ` ${escapeHtml(fout.melding)}` : ''}
        </span>
        <button type="button" class="btn btn-sm btn-primary" id="week-laadfout-opnieuw">Opnieuw proberen</button>
    </div>`;
}

function renderResponsibleSection() {
    // De verantwoordelijke wordt nu in de planning zelf getoond (bij de naam)
    // Deze functie geeft een lege string terug
    return '';
}

// Group shifts that overlap in time into groups
function groupOverlappingShifts(shifts) {
    if (shifts.length === 0) return [];

    // Helper function to check if two shifts overlap
    function shiftsOverlap(shift1, shift2) {
        const [s1StartHour, s1StartMin] = shift1.startTime.split(':').map(Number);
        const [s1EndHour, s1EndMin] = shift1.endTime.split(':').map(Number);
        const [s2StartHour, s2StartMin] = shift2.startTime.split(':').map(Number);
        const [s2EndHour, s2EndMin] = shift2.endTime.split(':').map(Number);

        const s1Start = s1StartHour * 60 + s1StartMin;
        const s1End = (s1EndHour < s1StartHour ? (s1EndHour + 24) * 60 : s1EndHour * 60) + s1EndMin;
        const s2Start = s2StartHour * 60 + s2StartMin;
        const s2End = (s2EndHour < s2StartHour ? (s2EndHour + 24) * 60 : s2EndHour * 60) + s2EndMin;

        return !(s1End <= s2Start || s2End <= s1Start);
    }

    // Sort shifts by start time
    const sortedShifts = [...shifts].sort((a, b) => {
        const [aHour, aMin] = a.startTime.split(':').map(Number);
        const [bHour, bMin] = b.startTime.split(':').map(Number);
        return (aHour * 60 + aMin) - (bHour * 60 + bMin);
    });

    const groups = [];
    const assigned = new Set();

    sortedShifts.forEach(shift => {
        if (assigned.has(shift.id)) return;

        // Start a new group with this shift
        const group = [shift];
        assigned.add(shift.id);

        // Find all shifts that overlap with any shift in the group
        let addedToGroup = true;
        while (addedToGroup) {
            addedToGroup = false;
            for (const otherShift of sortedShifts) {
                if (assigned.has(otherShift.id)) continue;

                // Check if this shift overlaps with any shift in the current group
                const overlapsWithGroup = group.some(groupShift => shiftsOverlap(groupShift, otherShift));

                if (overlapsWithGroup) {
                    group.push(otherShift);
                    assigned.add(otherShift.id);
                    addedToGroup = true;
                }
            }
        }

        groups.push(group);
    });

    return groups;
}

function renderCalendar() {
    try {
        renderTimelineView();
    } catch (error) {
        console.error('Error rendering calendar:', error);
        DOM.rosterCalendar.innerHTML = '<div class="no-shifts-message">Planner kon niet geladen worden. Probeer de pagina te herladen.</div>';
    }
}

// Helper: render overnight continuation blocks for day view
function renderOvernightContinuation(empId, date, START_HOUR, TOTAL_HOURS) {
    let html = '';
    const prevDate = new Date(parseDateOnly(date));
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = formatDateYYYYMMDD(prevDate);
    let prevShifts = getShiftsByEmployee(empId, prevDateStr, prevDateStr);
    prevShifts = prevShifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
    prevShifts.forEach(prevShift => {
        const [pH, ] = prevShift.startTime.split(':').map(Number);
        const [eH, eM] = prevShift.endTime.split(':').map(Number);
        const prevIsOvernight = eH < pH;
        if (prevIsOvernight) {
            const endFrac = eH + eM / 60;
            const w = endFrac > START_HOUR
                ? ((endFrac - START_HOUR) / TOTAL_HOURS) * 100
                : 2; // eindigt voor 7u: toon mini-indicator aan linkerrand
            const reserveBadge = prevShift.isReserve ? '<span class="reserve-badge">R</span>' : '';
            // #356: het doorloopblok kreeg nooit de --xs of --sm klasse die
            // gewone blokken wel krijgen, dus bleef het tijdlabel staan in een
            // blok van 20 pixels waar het er 40 nodig heeft. Je las dan "→07:0"
            // of "→0…", en dat leest als een ander tijdstip. Dezelfde regel als
            // bij de gewone blokken: onder 2,5 zichtbare uren geen label, onder
            // de 6 uur geen activiteitenchips.
            const doorloopUren = endFrac > START_HOUR ? endFrac - START_HOUR : 0;
            let doorloopKlasse = '';
            if (doorloopUren < 2.5)    doorloopKlasse = ' timeline-block--xs';
            else if (doorloopUren < 6) doorloopKlasse = ' timeline-block--sm';
            html += `<div class="timeline-block team-${prevShift.team} nacht overnight-continuation${doorloopKlasse}"
                         data-shift-id="${prevShift.id}"
                         data-employee-id="${prevShift.employeeId}"
                         data-date="${prevShift.date}"
                         data-original-date="${prevDateStr}"
                         data-label="doorloop"
                         style="left: 0%; width: ${w}%; cursor: pointer; opacity: 0.7;"
                         data-tooltip="Doorloop van ${prevDateStr}: ${escapeHtml(prevShift.startTime + '-' + prevShift.endTime)}" data-tooltip-pos="bottom">
                    ${reserveBadge}<span class="block-time">→${prevShift.endTime}</span>
                </div>`;
        }
    });
    return html;
}

function renderTimelineView() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const dayNames = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

    // Get all shifts this week (filtered by visible teams)
    let allShifts = [];
    weekDates.forEach(date => {
        let shifts = getShiftsByDate(date);
        // Filter by visible teams (include shifts without team)
        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
        allShifts = allShifts.concat(shifts);
    });

    // Get employees: those with shifts + all active employees in visible teams
    const employeeIdsWithShifts = new Set(allShifts.map(s => s.employeeId));
    const activeEmployees = getAllEmployees(true).filter(emp =>
        emp.mainTeam && AppState.visibleTeams.includes(emp.mainTeam)
    );
    // Merge: start with active employees, add any with shifts not yet included
    const employeeMap = new Map();
    activeEmployees.forEach(emp => employeeMap.set(emp.id, emp));
    employeeIdsWithShifts.forEach(id => {
        if (!employeeMap.has(id)) {
            const emp = getEmployee(id);
            if (emp) employeeMap.set(id, emp);
        }
    });
    let employees = [...employeeMap.values()];

    // Filter: only show employees with shifts if toggle is active
    if (AppState.filterOnlyWithShifts) {
        employees = employees.filter(emp => employeeIdsWithShifts.has(emp.id));
    }

    // Group employees by their main team - only show visible teams
    const teams = DataStore.settings.teams || {};
    const teamOrder = getTeamOrder()
        .filter(t => AppState.visibleTeams.includes(t));
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    });

    // Add employees without a team to a special "no-team" category
    const employeesWithoutTeam = employees
        .filter(emp => !emp.mainTeam || !teamOrder.includes(emp.mainTeam))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    if (employeesWithoutTeam.length > 0) {
        employeesByTeam['_no_team'] = employeesWithoutTeam;
    }

    // Time range: 7:00 to 24:00 (midnight)
    const START_HOUR = 7;
    const END_HOUR = 24;
    const TOTAL_HOURS = END_HOUR - START_HOUR;

    // Check of deze week een verantwoordelijke nodig heeft en wie dat is
    const currentWeekStart = new Date(AppState.currentWeekStart);
    const needsResponsible = isWeekendOrHolidayWeek(currentWeekStart);
    const responsible = needsResponsible ? getOrCalculateResponsible(currentWeekStart) : null;

    // Bouwt de naam+uren-cel (redesign: initialen-avatar + rustige urennotatie)
    const _teamsMap = DataStore.settings.teams || {};
    const _fmtHrs = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1);
    function buildTimelineEmpCell(emp) {
        const isResp = responsible && String(responsible.id) === String(emp.id);
        const respBadge = isResp ? `<span class="responsible-badge">${IconHelper.html(ICONS.star, 'xs')}</span>` : '';
        const respClass = isResp ? ' is-responsible' : '';
        const respTip = isResp ? 'data-tooltip="Weekendverantwoordelijke" data-tooltip-pos="right"' : '';
        const name = escapeHtml(emp.name);
        const initials = escapeHtml(getInitials(emp.name || ''));
        const teamColor = _teamsMap[emp.mainTeam]?.color || '#8d897c';
        const contractH = emp.contractHours || emp.contract_hours || 0;
        const weekH = getEmployeeHoursThisWeek(emp.id, startDateStr);
        const periodH = getEmployeeHoursThisPeriod(emp.id, startDateStr);
        const periodContract = contractH > 0 ? contractH * 4 : 0;
        const weekCls = contractH > 0 ? (weekH > contractH ? ' over-hours' : ' under-hours') : '';
        const periodCls = periodContract > 0 ? (periodH > periodContract ? ' over-hours' : ' under-hours') : '';
        const weekLabel = contractH > 0 ? `${_fmtHrs(weekH)}/${contractH}u` : `${_fmtHrs(weekH)}u`;
        const periodLabel = periodContract > 0 ? `${_fmtHrs(periodH)}/${periodContract}u` : `${_fmtHrs(periodH)}u`;
        return `<div class="timeline-employee-cell${respClass}" ${respTip}>
            <div class="emp-name-row">
                ${avatarHtml(emp.name, teamColor)}
                ${respBadge}<span class="emp-name">${name}</span>
            </div>
            <div class="emp-hours-line">
                <span class="emp-hours${weekCls}">${weekLabel}</span>
                <span class="emp-hours-sub${periodCls}">${periodLabel}</span>
            </div>
        </div>`;
    }

    let html = '<div class="timeline-view-wrapper">';

    // Header row with days
    const _todayStr = formatDateYYYYMMDD(new Date());
    html += '<div class="timeline-header">';
    html += '<div class="timeline-name-header">Medewerker</div>';
    weekDates.forEach((date) => {
        const d = parseDateOnly(date);
        const dayOfWeek = d.getDay();
        const dayName = dayNames[dayOfWeek];
        const dateNum = d.getDate();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isClosed = isDayClosed(date);
        const isHoliday = isHolidayPeriod(date);
        const holidayInfo = isHoliday ? getHolidayPeriod(date) : null;
        const feestdag = getPublicHoliday(date);
        const closedDateInfo = getClosedDateInfo(date);

        let headerClass = 'timeline-day-header';
        if (date === _todayStr) headerClass += ' today';
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        if (isHoliday) headerClass += ' holiday';
        if (feestdag) headerClass += ' feestdag';
        if (closedDateInfo) headerClass += ' manually-closed';

        // Een vakantiedag herken je al aan de kleur van de kop; een los
        // (bovendien wippend) paraplu-icoontje erbij is enkel ruis. De naam
        // van de vakantie blijft wel bereikbaar via de tooltip op de kop zelf.
        const holidayLabel = escapeHtml(holidayInfo?.name || 'Vakantie');
        const holidayTip = isHoliday ? ` data-tooltip="${holidayLabel}" data-tooltip-pos="bottom"` : '';
        const feestdagBadge = feestdag ? `<span class="feestdag-badge" data-tooltip="${escapeHtml(feestdag.name)}">${IconHelper.html(ICONS.feestdag, 'xs')}</span>` : '';
        const closedBadge = closedDateInfo ? `<span class="closed-date-badge" data-tooltip="${escapeHtml(closedDateInfo.reason || 'Manueel gesloten')}">${IconHelper.html(ICONS.lock, 'xs')}</span>` : '';

        html += `<div class="${headerClass}" data-date="${date}"${holidayTip}>
            <span class="day-name">${dayName}</span>
            <span class="day-num">${dateNum}${feestdagBadge}${closedBadge}</span>
        </div>`;
    });
    html += '</div>';

    // Body with team groups
    html += '<div class="timeline-body">';

    if (employees.length === 0) {
        html += '<div class="empty-state"><i data-lucide="calendar-x" class="empty-state-icon"></i><p>Geen diensten gepland voor deze periode.</p><small>Pas een concept toe of voeg diensten handmatig toe.</small></div>';
    } else {
        // Render each team group
        teamOrder.forEach(teamKey => {
            const teamEmployees = employeesByTeam[teamKey];
            if (teamEmployees.length === 0) return; // Skip empty teams

            const team = teams[teamKey] || { name: teamKey };
            const teamName = escapeHtml(team.name);
            const isCollapsed = AppState.collapsedTeams.has(teamKey);

            html += `<div class="tcard${isCollapsed ? ' collapsed' : ''}" data-tcard-team="${teamKey}">`;

            // Team header row (acts as card head + collapse trigger)
            html += `<div class="tcard-head timeline-team-header team-${teamKey}">
                <span class="team-header-dot"></span>
                <div class="team-header-name">${teamName}</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
                <div class="tcard-spacer"></div>
                <button class="tcard-toggle" aria-label="${isCollapsed ? 'Uitklappen' : 'Inklappen'}">
                    ${IconHelper.html('chevron-up', 'sm')}
                </button>
            </div>`;

            html += `<div class="tcard-body">`;

            // Employee rows for this team
            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="timeline-row ${isAlt ? 'alt' : ''}">`;

                // Employee name + uren (redesign-cel)
                html += buildTimelineEmpCell(emp);

                // Day cells with time blocks
                weekDates.forEach(date => {
                    const d = parseDateOnly(date);
                    const dayOfWeek = d.getDay();
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    const isClosed = isDayClosed(date);

                    let cellClass = 'timeline-day-cell';
                    if (isWeekend) cellClass += ' weekend';
                    if (isClosed) cellClass += ' closed';

                    // Check if there are shifts for this cell (to add has-shifts class)
                    if (!isClosed) {
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
                        if (shifts.length > 0) cellClass += ' has-shifts';
                    }

                    html += `<div class="${cellClass}" data-date="${date}">`;

                    if (!isClosed) {
                        // Check if there's a shift block for this employee on this date
                        const shiftBlock = DataStore.shiftBlocks.find(
                            block => String(block.user_id) === String(emp.id) && block.date === date
                        );

                        // Show shift block indicator if present
                        if (shiftBlock) {
                            const canRelease = hasPermission('MANAGE_SHIFTS');
                            const releaseTip = canRelease ? ' · Klik om dag terug vrij te geven aan het concept' : '';
                            html += `<div class="shift-block-indicator${canRelease ? ' shift-block-indicator--clickable' : ''}" data-block-id="${shiftBlock.id}" data-employee="${emp.id}" data-date="${date}" data-tooltip="${blockReasonLabel(shiftBlock.reason)}${releaseTip}" data-tooltip-pos="top">${IconHelper.html('circle-slash', 'xs')}</div>`;
                        }

                        // Get shifts for this employee on this date
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        // Filter by visible teams (include shifts without team)
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                        // Toon "niet werkzaam" markering op lege cellen (#173)
                        const cellAvail = getAvailability(emp.id, date);
                        if (!shiftBlock && shifts.length === 0 && cellAvail?.type === 'vrij') {
                            const nwReason = cellAvail.reason ? ` · ${escapeHtml(cellAvail.reason)}` : '';
                            html += `<div class="vrij-indicator" data-tooltip="Vrij${nwReason}" data-tooltip-pos="top">${IconHelper.html('minus', 'xs')}</div>`;
                        }

                        const isDayView = AppState.viewMode === 'day';

                        // Doorloop van nachtshift: enkel tonen op maandag (zondag→maandag weekgrens) of in dagweergave
                        if (isDayView || dayOfWeek === 1) {
                            html += renderOvernightContinuation(emp.id, date, START_HOUR, TOTAL_HOURS);
                        }

                        // Render shifts that start on this day
                        shifts.forEach(shift => {
                            const validation = validateBestaandeDienst(shift);
                            const availability = getAvailability(shift.employeeId, date);

                            // Check if employee is absent - this is a conflict!
                            const validAbsenceTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
                            const isAbsent = availability && availability.type && validAbsenceTypes.includes(availability.type);

                            const [startHour, startMin] = shift.startTime.split(':').map(Number);
                            const [endHour, endMin] = shift.endTime.split(':').map(Number);

                            // Check if this is an overnight shift
                            const isOvernight = endHour < startHour;

                            // Calculate position and width
                            const startFrac = startHour + startMin / 60;
                            const leftPercent = Math.max(0, ((startFrac - START_HOUR) / TOTAL_HOURS) * 100);

                            let widthPercent;
                            // #208: hoeveel uren van de tijdlijn het blok ECHT
                            // beslaat. Dat is iets anders dan de duur van de
                            // dienst: de tijdlijn loopt van 07:00 tot 24:00, dus
                            // een nachtdienst van 22:00 tot 07:00 duurt negen uur
                            // maar krijgt op een geknipte cel maar twee uren
                            // breedte. Het tijdlabel moet hierop afgaan.
                            let breedteUren;
                            if (isOvernight) {
                                // Nachtdienst: bereken totale breedte over beide dagen
                                // Van starttijd tot middernacht (24:00) op dag 1
                                // Plus van START_HOUR (7:00) tot eindtijd op dag 2
                                const hoursDay1 = END_HOUR - startFrac; // van start tot 24:00
                                const hoursDay2 = Math.max(0, (endHour + endMin / 60) - START_HOUR); // van 7:00 tot eind

                                // Clip to own cell in day view or on Sunday (last day of week)
                                if (dayOfWeek === 0 || isDayView) {
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    widthPercent = `${widthDay1Percent}%`;
                                    breedteUren = hoursDay1;
                                } else {
                                    // Other days: show full overnight shift spanning two day cells
                                    // We moeten de width berekenen als: dag1 deel + kleine gap + dag2 deel
                                    // De dag cellen zitten naast elkaar, dus 100% = 1 volledige cel
                                    // We gebruiken calc() met een kleine extra voor de grid gap
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;

                                    // Totaal: dag1 + gap (4px) + dag2
                                    widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                                    breedteUren = hoursDay1 + hoursDay2;
                                }
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
                                breedteUren = rightEnd - Math.max(startFrac, START_HOUR);
                            }

                            let blockClass = `timeline-block team-${shift.team}`;
                            // Add auto/manual class
                            if (shift.source === 'auto') {
                                blockClass += ' shift-auto';
                            } else {
                                blockClass += ' shift-manual';
                            }
                            // Absent conflict has highest priority
                            if (isAbsent) {
                                blockClass += ' absent-conflict';
                            } else if (!validation.isValid) {
                                blockClass += ' error';
                            } else if (validation.hasWarnings) {
                                blockClass += ' warning';
                            }
                            if (isOvernight) blockClass += ' nacht';
                            if (shift.isReserve) blockClass += ' shift-reserve';

                            // Build title with absence/error/warning info
                            let titleText = `${shift.startTime} - ${shift.endTime}`;
                            if (shift.isReserve) titleText = `[Reserve] ${titleText}`;
                            if (isOvernight) {
                                titleText += ' (nachtdienst)';
                            }
                            if (isAbsent) {
                                const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig', 'vrij': 'Vrij' };
                                titleText = `CONFLICT: ${absenceLabels[availability.type] || 'Afwezig'}\n${titleText}`;
                            }
                            if (!validation.isValid && validation.errors.length > 0) {
                                titleText += `\n${validation.errors.map(e => e.message).join('\n')}`;
                            }
                            if (validation.hasWarnings && validation.warnings.length > 0) {
                                titleText += `\n${validation.warnings.map(w => w.message).join('\n')}`;
                            }

                            // Width kan een getal of een calc() string zijn
                            const widthStyle = typeof widthPercent === 'string' ? widthPercent : `${widthPercent}%`;

                            // Escape quotes voor data-tooltip
                            const tooltipText = escapeHtml(titleText);

                            // Only make shift clickable if user can edit it
                            const canEdit = canUserEditShift(shift);
                            // Remove inline onclick - handled by DragHandler
                            const cursorStyle = canEdit ? 'cursor: grab;' : 'cursor: default;';

                            // Determine display density based on duration (#147)
                            // #208: dit ging op de DUUR van de dienst, niet op de
                            // breedte die het blok krijgt. Een nachtdienst van
                            // 22:00 tot 07:00 duurt negen uur, dus de smalle
                            // klasse en het korte label bleven uit, terwijl het
                            // blok op een geknipte cel maar 21 pixels breed werd.
                            // Het label werd dan gecentreerd afgeknipt en je las
                            // het MIDDEN van de tekst, zoiets als "0-07", wat op
                            // een geldige tijd lijkt en het niet is.
                            // Drempels gemeten op een dagcel van ongeveer 170px: één uur
                            // is dan een kleine 10px. "22:00" heeft 31px nodig en
                            // "22:00-07:00" 57px, dus ruwweg 2,5 en 6 uur breedte.
                            const zichtbaarUren = Math.max(0, breedteUren || 0);
                            if (zichtbaarUren < 2.5)    blockClass += ' timeline-block--xs';
                            else if (zichtbaarUren < 6) blockClass += ' timeline-block--sm';

                            // #163: activiteiten als balkje onderaan, op de uren waar ze
                            // vallen, in plaats van als tekstchips die om breedte vochten.
                            const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
                            const actChips = activiteitenChips(shiftActivities);

                            // Show only start time when block is too narrow for full range (#147)
                            // Onder ongeveer drie uur breedte past "22:00-07:00" (57px)
                            // niet, dus dan alleen de starttijd. Die is
                            // ondubbelzinnig, een afgeknipte reeks niet.
                            const timeLabel = zichtbaarUren < 6
                                ? shift.startTime
                                : `${shift.startTime}-${shift.endTime}`;

                            // #274: een dienstblok is een div en stond dus niet
                            // in de tabvolgorde; met het toetsenbord was er geen
                            // enkele dienst te openen. Alleen blokken die je mag
                            // bewerken worden focusbaar, want een tabstop die
                            // niets doet is alleen maar in de weg. De gedeelde
                            // handler in app-ui.js maakt Enter en spatie gelijk
                            // aan een klik.
                            // #246: een nachtdienst loopt door in de cel van de
                            // volgende dag, maar updateResizeDrag rekent met de
                            // cel van de eerste dag. De muis ligt dan altijd
                            // voorbij het einde van die cel, dus elke sleep van
                            // het handvat zette de eindtijd op middernacht en
                            // gooide de uren van de nachtdienst weg. Zolang dat
                            // niet tegen de juiste cel gerekend wordt, is geen
                            // handvat eerlijker dan een handvat dat altijd
                            // hetzelfde verkeerde antwoord geeft. Bewerken kan
                            // gewoon via het venster.
                            const isNachtdienst = shift.endTime <= shift.startTime;
                            const blokNaam = getEmployee(shift.employeeId)?.name || 'Medewerker';
                            const toetsAttrs = canEdit
                                ? ` role="button" tabindex="0" aria-label="${escapeHtml(`Dienst ${blokNaam}, ${shift.date}, ${shift.startTime} tot ${shift.endTime}`)}"`
                                : '';

                            html += `<div class="${blockClass}"${toetsAttrs}
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit && !isNachtdienst ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                ${shift.isReserve ? '<span class="reserve-badge">R</span>' : ''}
                                <span class="block-time">${timeLabel}</span>
                                ${actChips}
                                ${canEdit && !isNachtdienst ? '<div class="resize-handle resize-handle-end"></div>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });

            html += '</div>'; // Close tcard-body
            html += '</div>'; // Close tcard
        });

        // Render employees without a team (if any)
        const noTeamEmployees = employeesByTeam['_no_team'];
        if (noTeamEmployees && noTeamEmployees.length > 0) {
            const noTeamCollapsed = AppState.collapsedTeams.has('_no_team');
            html += `<div class="tcard${noTeamCollapsed ? ' collapsed' : ''}" data-tcard-team="_no_team">`;
            html += `<div class="tcard-head timeline-team-header team-no-team">
                <span class="team-header-dot"></span>
                <div class="team-header-name">Geen Team</div>
                <div class="team-header-count">${noTeamEmployees.length} medewerker${noTeamEmployees.length !== 1 ? 's' : ''}</div>
                <div class="tcard-spacer"></div>
                <button class="tcard-toggle" aria-label="${noTeamCollapsed ? 'Uitklappen' : 'Inklappen'}">
                    ${IconHelper.html('chevron-up', 'sm')}
                </button>
            </div>`;
            html += `<div class="tcard-body">`;

            // Employee rows for no-team employees
            noTeamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="timeline-row ${isAlt ? 'alt' : ''}">`;

                html += buildTimelineEmpCell(emp);

                weekDates.forEach(date => {
                    const d = parseDateOnly(date);
                    const dayOfWeek = d.getDay();
                    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                    const isClosed = isDayClosed(date);

                    let cellClass = 'timeline-day-cell';
                    if (isWeekend) cellClass += ' weekend';
                    if (isClosed) cellClass += ' closed';

                    // Check if there are shifts for this cell (to add has-shifts class)
                    if (!isClosed) {
                        let shiftsCheck = getShiftsByEmployee(emp.id, date, date);
                        shiftsCheck = shiftsCheck.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
                        if (shiftsCheck.length > 0) cellClass += ' has-shifts';
                    }

                    html += `<div class="${cellClass}" data-date="${date}">`;

                    if (!isClosed) {
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                        const isDayView = AppState.viewMode === 'day';

                        // Toon "niet werkzaam" markering op lege cellen (#173)
                        // Zelfde blokkade-indicator als in de team-tak hierboven;
                        // ontbrak hier, waardoor medewerkers zonder team geen
                        // enkel teken kregen dat een dag bewust leeg is.
                        const shiftBlock2 = DataStore.shiftBlocks.find(
                            block => String(block.user_id) === String(emp.id) && block.date === date
                        );
                        if (shiftBlock2) {
                            const canRelease2 = hasPermission('MANAGE_SHIFTS');
                            const releaseTip2 = canRelease2 ? ' · Klik om dag terug vrij te geven aan het concept' : '';
                            html += `<div class="shift-block-indicator${canRelease2 ? ' shift-block-indicator--clickable' : ''}" data-block-id="${shiftBlock2.id}" data-employee="${emp.id}" data-date="${date}" data-tooltip="${blockReasonLabel(shiftBlock2.reason)}${releaseTip2}" data-tooltip-pos="top">${IconHelper.html('circle-slash', 'xs')}</div>`;
                        }

                        const cellAvail2 = getAvailability(emp.id, date);
                        if (!shiftBlock2 && shifts.length === 0 && cellAvail2?.type === 'vrij') {
                            const nwReason2 = cellAvail2.reason ? ` · ${escapeHtml(cellAvail2.reason)}` : '';
                            html += `<div class="vrij-indicator" data-tooltip="Vrij${nwReason2}" data-tooltip-pos="top">${IconHelper.html('minus', 'xs')}</div>`;
                        }

                        // Doorloop van nachtshift: enkel tonen op maandag (zondag→maandag weekgrens) of in dagweergave
                        if (isDayView || dayOfWeek === 1) {
                            html += renderOvernightContinuation(emp.id, date, START_HOUR, TOTAL_HOURS);
                        }

                        // Render shifts that start on this day
                        shifts.forEach(shift => {
                            const validation = validateBestaandeDienst(shift);
                            const availability = getAvailability(shift.employeeId, date);

                            // Check if employee is absent - this is a conflict!
                            const validAbsenceTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
                            const isAbsent = availability && availability.type && validAbsenceTypes.includes(availability.type);

                            const [startHour, startMin] = shift.startTime.split(':').map(Number);
                            const [endHour, endMin] = shift.endTime.split(':').map(Number);

                            // Check if this is an overnight shift
                            const isOvernight = endHour < startHour;

                            // Calculate position and width
                            const startFrac = startHour + startMin / 60;
                            const leftPercent = Math.max(0, ((startFrac - START_HOUR) / TOTAL_HOURS) * 100);

                            let widthPercent;
                            // #208: hoeveel uren van de tijdlijn het blok ECHT
                            // beslaat. Dat is iets anders dan de duur van de
                            // dienst: de tijdlijn loopt van 07:00 tot 24:00, dus
                            // een nachtdienst van 22:00 tot 07:00 duurt negen uur
                            // maar krijgt op een geknipte cel maar twee uren
                            // breedte. Het tijdlabel moet hierop afgaan.
                            let breedteUren;
                            if (isOvernight) {
                                // Nachtdienst: bereken totale breedte over beide dagen
                                const hoursDay1 = END_HOUR - startFrac; // van start tot 24:00
                                const hoursDay2 = Math.max(0, (endHour + endMin / 60) - START_HOUR); // van 7:00 tot eind

                                // Clip to own cell in day view or on Sunday
                                if (dayOfWeek === 0 || isDayView) {
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    widthPercent = `${widthDay1Percent}%`;
                                    breedteUren = hoursDay1;
                                } else {
                                    // Other days: show full overnight shift spanning two day cells
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;
                                    widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                                    breedteUren = hoursDay1 + hoursDay2;
                                }
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
                                breedteUren = rightEnd - Math.max(startFrac, START_HOUR);
                            }

                            let blockClass = `timeline-block team-${shift.team}`;
                            // Add auto/manual class
                            if (shift.source === 'auto') {
                                blockClass += ' shift-auto';
                            } else {
                                blockClass += ' shift-manual';
                            }
                            // Absent conflict has highest priority
                            if (isAbsent) {
                                blockClass += ' absent-conflict';
                            } else if (!validation.isValid) {
                                blockClass += ' error';
                            } else if (validation.hasWarnings) {
                                blockClass += ' warning';
                            }
                            if (isOvernight) blockClass += ' nacht';
                            if (shift.isReserve) blockClass += ' shift-reserve';

                            // Build title with absence/error/warning info
                            let titleText = `${shift.startTime} - ${shift.endTime}`;
                            if (shift.isReserve) titleText = `[Reserve] ${titleText}`;
                            if (isOvernight) {
                                titleText += ' (nachtdienst)';
                            }
                            if (isAbsent) {
                                const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig', 'vrij': 'Vrij' };
                                titleText = `CONFLICT: ${absenceLabels[availability.type] || 'Afwezig'}\n${titleText}`;
                            }
                            if (!validation.isValid && validation.errors.length > 0) {
                                titleText += `\n${validation.errors.map(e => e.message).join('\n')}`;
                            }
                            if (validation.hasWarnings && validation.warnings.length > 0) {
                                titleText += `\n${validation.warnings.map(w => w.message).join('\n')}`;
                            }

                            // Width kan een getal of een calc() string zijn
                            const widthStyle = typeof widthPercent === 'string' ? widthPercent : `${widthPercent}%`;

                            // Escape quotes voor data-tooltip
                            const tooltipText = escapeHtml(titleText);

                            // Only make shift clickable if user can edit it
                            const canEdit = canUserEditShift(shift);
                            const cursorStyle = canEdit ? 'cursor: grab;' : 'cursor: default;';

                            // Determine display density based on duration (#147)
                            // #208: dit ging op de DUUR van de dienst, niet op de
                            // breedte die het blok krijgt. Een nachtdienst van
                            // 22:00 tot 07:00 duurt negen uur, dus de smalle
                            // klasse en het korte label bleven uit, terwijl het
                            // blok op een geknipte cel maar 21 pixels breed werd.
                            // Het label werd dan gecentreerd afgeknipt en je las
                            // het MIDDEN van de tekst, zoiets als "0-07", wat op
                            // een geldige tijd lijkt en het niet is.
                            // Drempels gemeten op een dagcel van ongeveer 170px: één uur
                            // is dan een kleine 10px. "22:00" heeft 31px nodig en
                            // "22:00-07:00" 57px, dus ruwweg 2,5 en 6 uur breedte.
                            const zichtbaarUren = Math.max(0, breedteUren || 0);
                            if (zichtbaarUren < 2.5)    blockClass += ' timeline-block--xs';
                            else if (zichtbaarUren < 6) blockClass += ' timeline-block--sm';

                            // #163: activiteiten als balkje onderaan, op de uren waar ze
                            // vallen, in plaats van als tekstchips die om breedte vochten.
                            const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
                            const actChips = activiteitenChips(shiftActivities);

                            // Show only start time when block is too narrow for full range (#147)
                            // Onder ongeveer drie uur breedte past "22:00-07:00" (57px)
                            // niet, dus dan alleen de starttijd. Die is
                            // ondubbelzinnig, een afgeknipte reeks niet.
                            const timeLabel = zichtbaarUren < 6
                                ? shift.startTime
                                : `${shift.startTime}-${shift.endTime}`;

                            // #274: een dienstblok is een div en stond dus niet
                            // in de tabvolgorde; met het toetsenbord was er geen
                            // enkele dienst te openen. Alleen blokken die je mag
                            // bewerken worden focusbaar, want een tabstop die
                            // niets doet is alleen maar in de weg. De gedeelde
                            // handler in app-ui.js maakt Enter en spatie gelijk
                            // aan een klik.
                            // #246: een nachtdienst loopt door in de cel van de
                            // volgende dag, maar updateResizeDrag rekent met de
                            // cel van de eerste dag. De muis ligt dan altijd
                            // voorbij het einde van die cel, dus elke sleep van
                            // het handvat zette de eindtijd op middernacht en
                            // gooide de uren van de nachtdienst weg. Zolang dat
                            // niet tegen de juiste cel gerekend wordt, is geen
                            // handvat eerlijker dan een handvat dat altijd
                            // hetzelfde verkeerde antwoord geeft. Bewerken kan
                            // gewoon via het venster.
                            const isNachtdienst = shift.endTime <= shift.startTime;
                            const blokNaam = getEmployee(shift.employeeId)?.name || 'Medewerker';
                            const toetsAttrs = canEdit
                                ? ` role="button" tabindex="0" aria-label="${escapeHtml(`Dienst ${blokNaam}, ${shift.date}, ${shift.startTime} tot ${shift.endTime}`)}"`
                                : '';

                            html += `<div class="${blockClass}"${toetsAttrs}
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit && !isNachtdienst ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                ${shift.isReserve ? '<span class="reserve-badge">R</span>' : ''}
                                <span class="block-time">${timeLabel}</span>
                                ${actChips}
                                ${canEdit && !isNachtdienst ? '<div class="resize-handle resize-handle-end"></div>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });

            html += '</div>'; // Close tcard-body
            html += '</div>'; // Close tcard
        }
    }

    html += '</div>'; // Close body
    html += '</div>'; // Close wrapper

    DOM.rosterCalendar.innerHTML = html;
    IconHelper.init(DOM.rosterCalendar);

    // Set team-header sticky offset based on actual header height
    const header = DOM.rosterCalendar.querySelector('.timeline-header');
    if (header) {
        const headerHeight = header.offsetHeight;
        DOM.rosterCalendar.querySelectorAll('.timeline-team-header').forEach(th => {
            th.style.top = (headerHeight - 1) + 'px';
        });
    }

    // Initialize drag & drop handlers
    if (typeof DragHandler !== 'undefined') {
        DragHandler.init();
    }
}

function getShiftsForDateAndTimeSlot(date, slotStart, slotEnd) {
    let shifts = getShiftsByDate(date);
    // Filter by visible teams (include shifts without team)
    shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
    shifts = shifts.filter(shift => {
        const [startHour] = shift.startTime.split(':').map(Number);
        const [endHour] = shift.endTime.split(':').map(Number);
        if (endHour < startHour) {
            return slotStart >= 23 || slotEnd <= 9;
        }
        return startHour >= slotStart && startHour < slotEnd;
    });
    return shifts;
}

// Calculate columns for overlapping shifts
function calculateShiftColumns(shifts) {
    const columns = new Map();

    // Sort shifts by start time
    const sortedShifts = [...shifts].sort((a, b) => {
        const [aHour, aMin] = a.startTime.split(':').map(Number);
        const [bHour, bMin] = b.startTime.split(':').map(Number);
        return (aHour * 60 + aMin) - (bHour * 60 + bMin);
    });

    // Track which columns are occupied at each time
    const columnTracks = [];

    sortedShifts.forEach(shift => {
        const [startHour, startMin] = shift.startTime.split(':').map(Number);
        const [endHour, endMin] = shift.endTime.split(':').map(Number);

        const startMinutes = startHour * 60 + startMin;
        const endMinutes = (endHour < startHour ? (endHour + 24) * 60 : endHour * 60) + endMin;

        // Find first available column
        let column = 0;
        let placed = false;

        while (!placed) {
            if (!columnTracks[column]) {
                columnTracks[column] = [];
            }

            // Check if this column is free during shift time
            const hasConflict = columnTracks[column].some(track => {
                return !(endMinutes <= track.start || startMinutes >= track.end);
            });

            if (!hasConflict) {
                // Place shift in this column
                columnTracks[column].push({ start: startMinutes, end: endMinutes });
                columns.set(shift.id, { column, totalColumns: 0 }); // Will update totalColumns later
                placed = true;
            } else {
                column++;
            }
        }
    });

    // Update total columns for each shift
    const totalColumns = columnTracks.length;
    columns.forEach(info => {
        info.totalColumns = totalColumns;
    });

    return columns;
}

// renderShiftBlock removed — was dead code (never called, timeline renders inline in renderTimelineView)

// Keep old function for backwards compatibility if needed elsewhere
