// HET VLOT ROOSTERPLANNING - PLANNING RENDERING

function renderPlanning() {
    // Save window scroll position before re-rendering
    const savedScrollY = window.scrollY || document.documentElement.scrollTop;

    if (!AppState.currentWeekStart) {
        setCurrentWeek(new Date());
    }

    // Lazy-fetch public holidays for visible year if not yet cached
    const visibleDate = AppState.viewMode === 'month' && AppState.currentMonthStart
        ? AppState.currentMonthStart
        : AppState.currentWeekStart || new Date();
    const visibleYear = visibleDate.getFullYear();
    if (!DataStore._publicHolidaysCache[visibleYear] && !DataStore._publicHolidaysFetching.has(visibleYear)) {
        fetchPublicHolidays(visibleYear).then(() => renderCalendar());
        return;
    }

    updatePeriodDisplay();
    updateMobileDayDisplay();
    renderTeamToggles();
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

    // Restore window scroll position after DOM updates
    requestAnimationFrame(() => {
        window.scrollTo(0, savedScrollY);
    });
}

function calcPlanningHourlyHeadcount(date, hour) {
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});

    // Previous day (for overnight shifts extending into this day)
    const prev = new Date(parseDateOnly(date));
    prev.setDate(prev.getDate() - 1);
    const prevDate = formatDateYYYYMMDD(prev);

    let bruto = 0;
    const workingEmployees = new Set(); // track who is working at this hour

    for (const s of DataStore.shifts) {
        if (!coverageTeams.includes(s.team)) continue;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        const startDec = sh + sm / 60;
        const endDec = eh + em / 60;
        const isNight = endDec <= startDec;

        let isWorking = false;
        if (s.date === date) {
            if (isNight) {
                if (hour >= startDec) isWorking = true;
            } else {
                if (hour >= startDec && hour < endDec) isWorking = true;
            }
        } else if (s.date === prevDate && isNight) {
            if (hour < endDec) isWorking = true;
        }

        if (isWorking) {
            bruto++;
            workingEmployees.add(String(s.employeeId || s.userId || s.user_id));
        }
    }

    // Netto: subtract employees who have an activity at this hour (only if they have a shift)
    let activityCount = 0;
    const activities = DataStore.activities.filter(a => a.date === date);
    for (const act of activities) {
        const empId = String(act.userId);
        if (!workingEmployees.has(empId)) continue; // only count if employee has a shift
        const [ash, asm] = act.startTime.split(':').map(Number);
        const [aeh, aem] = act.endTime.split(':').map(Number);
        const actStart = ash + asm / 60;
        const actEnd = aeh + aem / 60;
        if (hour >= actStart && hour < actEnd) {
            activityCount++;
        }
    }

    return { bruto, netto: bruto - activityCount };
}

function renderCoverageHeatmap() {
    const startDateStr = formatDateYYYYMMDD(AppState.currentWeekStart);
    const weekDates = getWeekDates(startDateStr);
    const coverageTeams = DataStore.settings.coverageTeams || Object.keys(DataStore.settings.teams || {});
    const coverageTeamNames = coverageTeams.map(t => (DataStore.settings.teams || {})[t]?.name || t).join(' + ');

    let html = '<div class="coverage-heatmap">';
    html += `<div class="heatmap-title">Bezetting (${escapeHtml(coverageTeamNames)})</div>`;
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
                        ? `${timeLabel} — ${netto}/${required} mdw (${bruto - netto} in activiteit)`
                        : `${timeLabel} — ${netto}/${required} mdw`;
                } else {
                    tooltipText = netto < bruto
                        ? `${timeLabel} — ${netto} beschikbaar (${bruto} ingepland, ${bruto - netto} in activiteit)`
                        : `${timeLabel} — ${bruto} medewerkers`;
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

    let msg = `Bezetting - ${formatDate(date)}\n`;
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
    const startDate = weekDates[0];
    const endDate = weekDates[6];
    const summary = getValidationSummary(startDate, endDate);

    let html = '';
    html += renderResponsibleSection();

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
            html += `<button class="validation-chip validation-chip-${cfg.level}" data-rule="${escapeHtml(item.rule)}" title="Klik voor details">
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
        ${e.key && canDismiss ? `<button class="issue-entry-dismiss btn-ghost" title="Negeren" onclick="dismissFromPlanningTab('${escapeHtml(e.key)}')">${IconHelper.html('eye-off', 'xs')}</button>` : ''}
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
        if (AppState.viewMode === 'month') {
            renderMonthView();
        } else {
            renderTimelineView();
        }
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
            html += `<div class="timeline-block team-${prevShift.team} nacht overnight-continuation"
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

    let html = '<div class="timeline-view-wrapper">';

    // Header row with days
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
        if (isWeekend) headerClass += ' weekend';
        if (isClosed) headerClass += ' closed';
        if (isHoliday) headerClass += ' holiday';
        if (feestdag) headerClass += ' feestdag';
        if (closedDateInfo) headerClass += ' manually-closed';

        const holidayLabel = escapeHtml(holidayInfo?.name || 'Vakantie');
        const holidayBadge = isHoliday ? `<span class="holiday-badge" data-tooltip="${holidayLabel}">${IconHelper.html(ICONS.holiday, 'xs')}</span>` : '';
        const feestdagBadge = feestdag ? `<span class="feestdag-badge" data-tooltip="${escapeHtml(feestdag.name)}">${IconHelper.html(ICONS.feestdag, 'xs')}</span>` : '';
        const closedBadge = closedDateInfo ? `<span class="closed-date-badge" data-tooltip="${escapeHtml(closedDateInfo.reason || 'Manueel gesloten')}">${IconHelper.html(ICONS.lock, 'xs')}</span>` : '';

        html += `<div class="${headerClass}" data-date="${date}">
            <span class="day-name">${dayName}</span>
            <span class="day-num">${dateNum}${holidayBadge}${feestdagBadge}${closedBadge}</span>
        </div>`;
    });
    html += '</div>';

    // Body with team groups
    html += '<div class="timeline-body">';

    if (employees.length === 0) {
        html += '<div class="empty-state"><i data-lucide="calendar-x" class="empty-state-icon"></i><p>Geen shifts gepland voor deze periode.</p><small>Pas een concept toe of voeg shifts handmatig toe.</small></div>';
    } else {
        // Render each team group
        teamOrder.forEach(teamKey => {
            const teamEmployees = employeesByTeam[teamKey];
            if (teamEmployees.length === 0) return; // Skip empty teams

            const team = teams[teamKey] || { name: teamKey };
            const teamName = escapeHtml(team.name);

            // Team header row
            html += `<div class="timeline-team-header team-${teamKey}">
                <div class="team-header-name">${teamName}</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            // Employee rows for this team
            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="timeline-row ${isAlt ? 'alt' : ''}">`;

                // Employee name - check if this is the weekend responsible
                const isResponsible = responsible && String(responsible.id) === String(emp.id);
                const responsibleBadge = isResponsible ? `<span class="responsible-badge">${IconHelper.html(ICONS.star, 'xs')}</span>` : '';
                const responsibleClass = isResponsible ? ' is-responsible' : '';
                const responsibleTooltip = isResponsible ? 'data-tooltip="Weekendverantwoordelijke" data-tooltip-pos="right"' : '';

                const employeeName = escapeHtml(emp.name);
                const empContractH = emp.contractHours || emp.contract_hours || 0;
                const empWeekH = getEmployeeHoursThisWeek(emp.id, startDateStr);
                const empMonthH = getEmployeeHoursThisPeriod(emp.id, startDateStr);
                const empMonthContract = empContractH > 0 ? empContractH * 4 : 0;
                const empWeekClass = empContractH > 0 ? (empWeekH > empContractH ? ' over-hours' : ' under-hours') : '';
                const empMonthClass = empMonthContract > 0 ? (empMonthH > empMonthContract ? ' over-hours' : ' under-hours') : '';
                const empWeekLabel = empContractH > 0 ? `${empWeekH.toFixed(2)}/${empContractH}u` : `${empWeekH.toFixed(2)}u`;
                const empMonthLabel = empMonthContract > 0 ? `${empMonthH.toFixed(2)}/${empMonthContract}u` : `${empMonthH.toFixed(2)}u`;
                html += `<div class="timeline-employee-cell${responsibleClass}" ${responsibleTooltip}>
                    <div class="emp-name-row">${responsibleBadge}<span class="emp-name">${employeeName}</span></div>
                    <span class="emp-hours${empWeekClass}">${empWeekLabel}</span>
                    <span class="emp-hours${empMonthClass}">${empMonthLabel}</span>
                </div>`;

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
                        const hasShiftBlock = DataStore.shiftBlocks.some(
                            block => String(block.user_id) === String(emp.id) && block.date === date
                        );

                        // Show shift block indicator if present
                        if (hasShiftBlock) {
                            html += `<div class="shift-block-indicator" data-tooltip="Shift geblokkeerd (auto-schedule overgeslagen)" data-tooltip-pos="top">${IconHelper.html('circle-slash', 'xs')}</div>`;
                        }

                        // Get shifts for this employee on this date
                        let shifts = getShiftsByEmployee(emp.id, date, date);
                        // Filter by visible teams (include shifts without team)
                        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                        const isDayView = AppState.viewMode === 'day';

                        // Doorloop van nachtshift: enkel tonen op maandag (zondag→maandag weekgrens) of in dagweergave
                        if (isDayView || dayOfWeek === 1) {
                            html += renderOvernightContinuation(emp.id, date, START_HOUR, TOTAL_HOURS);
                        }

                        // Render shifts that start on this day
                        shifts.forEach(shift => {
                            const validation = validateShift(shift, shift.id);
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
                                } else {
                                    // Other days: show full overnight shift spanning two day cells
                                    // We moeten de width berekenen als: dag1 deel + kleine gap + dag2 deel
                                    // De dag cellen zitten naast elkaar, dus 100% = 1 volledige cel
                                    // We gebruiken calc() met een kleine extra voor de grid gap
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;

                                    // Totaal: dag1 + gap (4px) + dag2
                                    widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                                }
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
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
                                const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig' };
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

                            // Render activity chips inside the block
                            const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
                            let actChips = '';
                            shiftActivities.forEach(act => {
                                const lbl = ACTIVITY_TYPE_LABELS_SHORT[act.type] || act.type;
                                const t = `${act.startTime.substring(0,5)}-${act.endTime.substring(0,5)}`;
                                actChips += `<span class="activity-chip activity-type-${escapeHtml(act.type)}" data-activity-id="${act.id}" title="${escapeHtml(act.description || lbl)} (${t})">${escapeHtml(lbl)}</span>`;
                            });

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                ${shift.isReserve ? '<span class="reserve-badge">R</span>' : ''}
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
                                ${actChips ? `<div class="activity-chips-row">${actChips}</div>` : ''}
                                ${canEdit ? '<div class="resize-handle resize-handle-end"></div>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });
        });

        // Render employees without a team (if any)
        const noTeamEmployees = employeesByTeam['_no_team'];
        if (noTeamEmployees && noTeamEmployees.length > 0) {
            // Team header row for "No Team"
            html += `<div class="timeline-team-header team-no-team">
                <div class="team-header-name">Geen Team</div>
                <div class="team-header-count">${noTeamEmployees.length} medewerker${noTeamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            // Employee rows for no-team employees
            noTeamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="timeline-row ${isAlt ? 'alt' : ''}">`;

                const isResponsible = responsible && String(responsible.id) === String(emp.id);
                const responsibleBadge = isResponsible ? `<span class="responsible-badge">${IconHelper.html(ICONS.star, 'xs')}</span>` : '';
                const responsibleClass = isResponsible ? ' is-responsible' : '';
                const responsibleTooltip = isResponsible ? 'data-tooltip="Weekendverantwoordelijke" data-tooltip-pos="right"' : '';

                const employeeName = escapeHtml(emp.name);
                const empContractH = emp.contractHours || emp.contract_hours || 0;
                const empWeekH = getEmployeeHoursThisWeek(emp.id, startDateStr);
                const empMonthH = getEmployeeHoursThisPeriod(emp.id, startDateStr);
                const empMonthContract = empContractH > 0 ? empContractH * 4 : 0;
                const empWeekClass = empContractH > 0 ? (empWeekH > empContractH ? ' over-hours' : ' under-hours') : '';
                const empMonthClass = empMonthContract > 0 ? (empMonthH > empMonthContract ? ' over-hours' : ' under-hours') : '';
                const empWeekLabel = empContractH > 0 ? `${empWeekH.toFixed(2)}/${empContractH}u` : `${empWeekH.toFixed(2)}u`;
                const empMonthLabel = empMonthContract > 0 ? `${empMonthH.toFixed(2)}/${empMonthContract}u` : `${empMonthH.toFixed(2)}u`;
                html += `<div class="timeline-employee-cell${responsibleClass}" ${responsibleTooltip}>
                    <div class="emp-name-row">${responsibleBadge}<span class="emp-name">${employeeName}</span></div>
                    <span class="emp-hours${empWeekClass}">${empWeekLabel}</span>
                    <span class="emp-hours${empMonthClass}">${empMonthLabel}</span>
                </div>`;

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

                        // Doorloop van nachtshift: enkel tonen op maandag (zondag→maandag weekgrens) of in dagweergave
                        if (isDayView || dayOfWeek === 1) {
                            html += renderOvernightContinuation(emp.id, date, START_HOUR, TOTAL_HOURS);
                        }

                        // Render shifts that start on this day
                        shifts.forEach(shift => {
                            const validation = validateShift(shift, shift.id);
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
                            if (isOvernight) {
                                // Nachtdienst: bereken totale breedte over beide dagen
                                const hoursDay1 = END_HOUR - startFrac; // van start tot 24:00
                                const hoursDay2 = Math.max(0, (endHour + endMin / 60) - START_HOUR); // van 7:00 tot eind

                                // Clip to own cell in day view or on Sunday
                                if (dayOfWeek === 0 || isDayView) {
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    widthPercent = `${widthDay1Percent}%`;
                                } else {
                                    // Other days: show full overnight shift spanning two day cells
                                    const widthDay1Percent = (hoursDay1 / TOTAL_HOURS) * 100;
                                    const widthDay2Percent = (hoursDay2 / TOTAL_HOURS) * 100;
                                    widthPercent = `calc(${widthDay1Percent}% + 4px + ${widthDay2Percent}%)`;
                                }
                            } else {
                                const endFrac = endHour + endMin / 60;
                                const rightEnd = Math.min(END_HOUR, endFrac);
                                widthPercent = ((rightEnd - Math.max(startFrac, START_HOUR)) / TOTAL_HOURS) * 100;
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
                                const absenceLabels = { 'verlof': 'Verlof', 'ziek': 'Ziekte', 'overuren': 'Overuren', 'vorming': 'Vorming', 'andere': 'Afwezig' };
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

                            // Render activity chips inside the block
                            const shiftActivities = getActivitiesByEmployee(shift.employeeId, shift.date);
                            let actChips = '';
                            shiftActivities.forEach(act => {
                                const lbl = ACTIVITY_TYPE_LABELS_SHORT[act.type] || act.type;
                                const t = `${act.startTime.substring(0,5)}-${act.endTime.substring(0,5)}`;
                                actChips += `<span class="activity-chip activity-type-${escapeHtml(act.type)}" data-activity-id="${act.id}" title="${escapeHtml(act.description || lbl)} (${t})">${escapeHtml(lbl)}</span>`;
                            });

                            html += `<div class="${blockClass}"
                                         data-shift-id="${shift.id}"
                                         data-employee-id="${shift.employeeId}"
                                         data-date="${shift.date}"
                                         style="left: ${leftPercent}%; width: ${widthStyle}; ${cursorStyle}"
                                         data-tooltip="${tooltipText}" data-tooltip-pos="bottom">
                                ${canEdit ? '<div class="resize-handle resize-handle-start"></div>' : ''}
                                ${shift.isReserve ? '<span class="reserve-badge">R</span>' : ''}
                                <span class="block-time">${shift.startTime}-${shift.endTime}</span>
                                ${actChips ? `<div class="activity-chips-row">${actChips}</div>` : ''}
                                ${canEdit ? '<div class="resize-handle resize-handle-end"></div>' : ''}
                            </div>`;
                        });
                    }

                    html += '</div>';
                });

                html += '</div>'; // Close row
            });
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

function renderMonthView() {
    const monthStart = AppState.currentMonthStart || getMonthStart(new Date());
    const weeks = getMonthWeeks(monthStart);
    const allDates = getMonthDates(monthStart);

    // Get all shifts this month (filtered by visible teams)
    let allShifts = [];
    allDates.forEach(date => {
        let shifts = getShiftsByDate(date);
        shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));
        allShifts = allShifts.concat(shifts);
    });

    // Get employees: those with shifts + all active employees in visible teams
    const employeeIdsWithShifts = new Set(allShifts.map(s => s.employeeId));
    const activeEmployees = getAllEmployees(true).filter(emp =>
        emp.mainTeam && AppState.visibleTeams.includes(emp.mainTeam)
    );
    const employeeMap = new Map();
    activeEmployees.forEach(emp => employeeMap.set(emp.id, emp));
    employeeIdsWithShifts.forEach(id => {
        if (!employeeMap.has(id)) {
            const emp = getEmployee(id);
            if (emp) employeeMap.set(id, emp);
        }
    });
    let employees = [...employeeMap.values()];

    // Group by team (reuse logic from renderTimelineView)
    const teams = DataStore.settings.teams || {};
    const teamOrder = getTeamOrder()
        .filter(t => AppState.visibleTeams.includes(t));
    const employeesByTeam = {};

    teamOrder.forEach(teamKey => {
        employeesByTeam[teamKey] = employees
            .filter(emp => emp.mainTeam === teamKey)
            .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    });

    // Employees without team
    const employeesWithoutTeam = employees
        .filter(emp => !emp.mainTeam || !teamOrder.includes(emp.mainTeam))
        .sort((a, b) => a.name.localeCompare(b.name, 'nl-BE'));
    if (employeesWithoutTeam.length > 0) {
        employeesByTeam['_no_team'] = employeesWithoutTeam;
    }

    let html = '<div class="month-view-wrapper">';

    // Header: week rows with dates
    html += '<div class="month-header">';
    html += '<div class="month-name-header">Medewerker</div>';

    weeks.forEach((weekStart) => {
        const weekDates = getWeekDates(weekStart);
        html += '<div class="month-week-header">';

        weekDates.forEach(date => {
            const d = parseDateOnly(date);
            const dayOfWeek = d.getDay();
            const dayNames = ['Zo', 'Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];
            const dayName = dayNames[dayOfWeek];
            const dayNum = d.getDate();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
            const isClosed = isDayClosed(date);
            const isHoliday = isHolidayPeriod(date);
            const feestdag = getPublicHoliday(date);
            const closedDateInfo = getClosedDateInfo(date);

            // Highlight dates outside current month
            const currentMonth = monthStart.getMonth();
            const isCurrentMonth = d.getMonth() === currentMonth;

            let headerClass = 'month-day-header';
            if (isWeekend) headerClass += ' weekend';
            if (isClosed) headerClass += ' closed';
            if (isHoliday) headerClass += ' holiday';
            if (feestdag) headerClass += ' feestdag';
            if (closedDateInfo) headerClass += ' manually-closed';
            if (!isCurrentMonth) headerClass += ' other-month';

            const feestdagBadge = feestdag ? `<span class="feestdag-badge" data-tooltip="${escapeHtml(feestdag.name)}">${IconHelper.html(ICONS.feestdag, 'xs')}</span>` : '';
            const closedBadge = closedDateInfo ? `<span class="closed-date-badge" data-tooltip="${escapeHtml(closedDateInfo.reason || 'Manueel gesloten')}">${IconHelper.html(ICONS.lock, 'xs')}</span>` : '';

            html += `<div class="${headerClass}" data-date="${date}">
                <span class="day-name">${dayName}</span>
                <span class="day-num">${dayNum}${feestdagBadge}${closedBadge}</span>
            </div>`;
        });

        html += '</div>'; // month-week-header
    });
    html += '</div>'; // month-header

    // Body: employee rows with shift badges
    html += '<div class="month-body">';

    if (employees.length === 0) {
        html += '<div class="empty-state"><i data-lucide="calendar-x" class="empty-state-icon"></i><p>Geen shifts gepland voor deze periode.</p><small>Pas een concept toe of voeg shifts handmatig toe.</small></div>';
    } else {
        teamOrder.forEach(teamKey => {
            const teamEmployees = employeesByTeam[teamKey];
            if (!teamEmployees || teamEmployees.length === 0) return;

            const team = teams[teamKey] || { name: teamKey };
            const teamName = escapeHtml(team.name);

            // Team header
            html += `<div class="month-team-header team-${teamKey}">
                <div class="team-header-name">${teamName}</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            // Employee rows
            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="month-row ${isAlt ? 'alt' : ''}">`;

                const employeeName = escapeHtml(emp.name);
                const empContractH = emp.contractHours || emp.contract_hours || 0;
                const empMonthH = getEmployeeHoursThisPeriod(emp.id, formatDateYYYYMMDD(monthStart));
                const monthContract = empContractH > 0 ? empContractH * 4 : 0;
                const empMonthOverClass = monthContract > 0 ? (empMonthH > monthContract ? ' over-hours' : ' under-hours') : '';
                const empMonthLabel = monthContract > 0 ? `${empMonthH.toFixed(2)}/${monthContract}u` : `${empMonthH.toFixed(2)}u`;
                html += `<div class="month-employee-cell">
                    <span class="emp-name">${employeeName}</span>
                    <span class="emp-hours${empMonthOverClass}">${empMonthLabel}</span>
                </div>`;

                // Week columns
                weeks.forEach(weekStart => {
                    const weekDates = getWeekDates(weekStart);
                    html += '<div class="month-week-cells">';

                    weekDates.forEach(date => {
                        const d = parseDateOnly(date);
                        const dayOfWeek = d.getDay();
                        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                        const isClosed = isDayClosed(date);
                        const isCurrentMonth = d.getMonth() === monthStart.getMonth();

                        let cellClass = 'month-day-cell';
                        if (isWeekend) cellClass += ' weekend';
                        if (isClosed) cellClass += ' closed';
                        if (!isCurrentMonth) cellClass += ' other-month';

                        html += `<div class="${cellClass}" data-date="${date}" data-employee="${emp.id}">`;

                        if (!isClosed) {
                            let shifts = getShiftsByEmployee(emp.id, date, date);
                            shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                            const maxVisible = 3;
                            const visibleShifts = shifts.slice(0, maxVisible);
                            const hiddenCount = Math.max(0, shifts.length - maxVisible);

                            visibleShifts.forEach(shift => {
                                const timeStr = `${shift.startTime.substring(0, 5)}-${shift.endTime.substring(0, 5)}`;
                                const validation = validateShift(shift, shift.id);
                                const hasErrors = validation.errors.length > 0;
                                const hasWarnings = validation.warnings.length > 0;

                                let badgeClass = `month-shift-badge team-${shift.team}`;
                                if (hasErrors) badgeClass += ' has-error';
                                else if (hasWarnings) badgeClass += ' has-warning';

                                const canEdit = canUserEditShift(shift);
                                const onClick = canEdit ? `onclick="openEditShiftModal('${shift.id}')"` : '';

                                const shiftTeam = teams[shift.team];
                                const teamNameText = shiftTeam ? shiftTeam.name : shift.team;
                                const tooltipText = `${timeStr}\\n${teamNameText}${shift.notes ? '\\n' + shift.notes : ''}`;

                                html += `<div class="${badgeClass}" ${onClick} title="${escapeHtml(tooltipText)}">${timeStr}</div>`;
                            });

                            if (hiddenCount > 0) {
                                html += `<div class="month-shift-more">+${hiddenCount}</div>`;
                            }
                        }

                        html += '</div>'; // month-day-cell
                    });

                    html += '</div>'; // month-week-cells
                });

                html += '</div>'; // month-row
            });
        });

        // Handle employees without team
        if (employeesByTeam['_no_team']) {
            const teamEmployees = employeesByTeam['_no_team'];
            html += `<div class="month-team-header">
                <div class="team-header-name">Geen team</div>
                <div class="team-header-count">${teamEmployees.length} medewerker${teamEmployees.length !== 1 ? 's' : ''}</div>
            </div>`;

            teamEmployees.forEach((emp, index) => {
                const isAlt = index % 2 === 1;
                html += `<div class="month-row ${isAlt ? 'alt' : ''}">`;

                const employeeName = escapeHtml(emp.name);
                const empContractH = emp.contractHours || emp.contract_hours || 0;
                const empMonthH = getEmployeeHoursThisPeriod(emp.id, formatDateYYYYMMDD(monthStart));
                const monthContract = empContractH > 0 ? empContractH * 4 : 0;
                const empMonthOverClass = monthContract > 0 ? (empMonthH > monthContract ? ' over-hours' : ' under-hours') : '';
                const empMonthLabel = monthContract > 0 ? `${empMonthH.toFixed(2)}/${monthContract}u` : `${empMonthH.toFixed(2)}u`;
                html += `<div class="month-employee-cell">
                    <span class="emp-name">${employeeName}</span>
                    <span class="emp-hours${empMonthOverClass}">${empMonthLabel}</span>
                </div>`;

                weeks.forEach(weekStart => {
                    const weekDates = getWeekDates(weekStart);
                    html += '<div class="month-week-cells">';

                    weekDates.forEach(date => {
                        const d = parseDateOnly(date);
                        const dayOfWeek = d.getDay();
                        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
                        const isClosed = isDayClosed(date);
                        const isCurrentMonth = d.getMonth() === monthStart.getMonth();

                        let cellClass = 'month-day-cell';
                        if (isWeekend) cellClass += ' weekend';
                        if (isClosed) cellClass += ' closed';
                        if (!isCurrentMonth) cellClass += ' other-month';

                        html += `<div class="${cellClass}">`;

                        if (!isClosed) {
                            let shifts = getShiftsByEmployee(emp.id, date, date);
                            shifts = shifts.filter(s => !s.team || AppState.visibleTeams.includes(s.team));

                            const maxVisible = 3;
                            const visibleShifts = shifts.slice(0, maxVisible);
                            const hiddenCount = Math.max(0, shifts.length - maxVisible);

                            visibleShifts.forEach(shift => {
                                const timeStr = `${shift.startTime.substring(0, 5)}-${shift.endTime.substring(0, 5)}`;
                                const validation = validateShift(shift, shift.id);
                                const hasErrors = validation.errors.length > 0;
                                const hasWarnings = validation.warnings.length > 0;

                                let badgeClass = `month-shift-badge team-${shift.team}`;
                                if (hasErrors) badgeClass += ' has-error';
                                else if (hasWarnings) badgeClass += ' has-warning';

                                const canEdit = canUserEditShift(shift);
                                const onClick = canEdit ? `onclick="openEditShiftModal('${shift.id}')"` : '';

                                const shiftTeam = teams[shift.team];
                                const teamNameText = shiftTeam ? shiftTeam.name : shift.team;
                                const tooltipText = `${timeStr}\\n${teamNameText}${shift.notes ? '\\n' + shift.notes : ''}`;

                                html += `<div class="${badgeClass}" ${onClick} title="${escapeHtml(tooltipText)}">${timeStr}</div>`;
                            });

                            if (hiddenCount > 0) {
                                html += `<div class="month-shift-more">+${hiddenCount}</div>`;
                            }
                        }

                        html += '</div>';
                    });

                    html += '</div>';
                });

                html += '</div>';
            });
        }
    }

    html += '</div>'; // month-body
    html += '</div>'; // month-view-wrapper

    DOM.rosterCalendar.innerHTML = html;
    IconHelper.init(DOM.rosterCalendar);
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
