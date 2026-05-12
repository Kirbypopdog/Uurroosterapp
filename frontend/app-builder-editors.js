// ===== ROOSTERBOUWER: EDITORS (staffing, vergaderingen, berekeningen) =====

function migrateStaffingRules(rules) {
    if (!rules || typeof rules !== 'object') return {};
    const migrated = {};
    for (const [dayKey, dayData] of Object.entries(rules)) {
        if (Array.isArray(dayData)) {
            migrated[dayKey] = dayData; // Already new format
            continue;
        }
        // Old format: { hour: minCount } → group consecutive hours with same min into ranges
        const hours = Object.keys(dayData).map(Number).sort((a, b) => a - b);
        if (hours.length === 0) continue;
        const ranges = [];
        let rangeStart = hours[0], rangeMin = dayData[hours[0]], prevHour = hours[0];
        for (let i = 1; i < hours.length; i++) {
            const h = hours[i];
            if (h === prevHour + 1 && dayData[h] === rangeMin) {
                prevHour = h;
            } else {
                ranges.push({ from: rangeStart, to: prevHour + 1, min: rangeMin });
                rangeStart = h;
                rangeMin = dayData[h];
                prevHour = h;
            }
        }
        ranges.push({ from: rangeStart, to: prevHour + 1, min: rangeMin });
        migrated[dayKey] = ranges;
    }
    return migrated;
}

// Format decimal hour to HH:MM string (e.g. 7.5 → "7:30", 14 → "14:00")
function formatStaffingHour(dec) {
    const h = Math.floor(dec);
    const m = Math.round((dec - h) * 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

// Parse HH:MM or H string to decimal, snapped to half hours (e.g. "7:30" → 7.5, "7:20" → 7.5, "14" → 14)
function parseStaffingHour(str) {
    str = str.trim();
    let h = 0, m = 0;
    if (str.includes(':')) {
        [h, m] = str.split(':').map(Number);
        h = h || 0;
        m = m || 0;
    } else {
        h = parseFloat(str) || 0;
        m = 0;
    }
    // Snap minutes to nearest 0 or 30
    m = m < 15 ? 0 : (m < 45 ? 30 : 60);
    if (m === 60) { h++; m = 0; }
    return h + m / 60;
}

// Generate <select> options for half-hour time slots (7:00 - 24:00)
function timeSelectOptions(selectedDec, startHour = 7, endHour = 24) {
    let html = '';
    for (let h = startHour; h <= endHour; h += 0.5) {
        const label = h === 24 ? '24:00' : formatStaffingHour(h);
        html += `<option value="${h}" ${h === selectedDec ? 'selected' : ''}>${label}</option>`;
    }
    return html;
}

function renderBuilderStaffingEditor() {
    const isOpen = AppState.builderShowStaffingEditor;
    const arrow = isOpen ? '▲' : '▼';
    let html = `<div class="builder-staffing-editor-wrapper">
        <button class="btn btn-secondary btn-sm builder-section-toggle" id="builder-staffing-toggle">
            ${IconHelper.html(ICONS.settings, 'xs')} Bezettingsregels ${arrow}
        </button>`;

    if (isOpen) {
        const builderClosedDays = getBuilderClosedDays(AppState.builderWeekNumber);
        const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
        const rules = AppState.builderStaffingRules;

        html += '<div class="builder-staffing-editor">';
        html += '<div class="staffing-columns">';

        for (let d = 0; d < 7; d++) {
            const jsDow = d === 6 ? 0 : d + 1;
            const closed = builderClosedDays.includes(jsDow);

            html += `<div class="staffing-col${closed ? ' closed' : ''}">`;
            html += `<div class="staffing-col-header">${dayLabels[d]}</div>`;

            if (!closed) {
                const dayRules = Array.isArray(rules[d]) ? rules[d] : [];

                dayRules.forEach((rule, idx) => {
                    html += `<div class="staffing-rule-card" data-day="${d}" data-idx="${idx}">
                        <div class="staffing-rule-times">
                            <select class="staffing-from" data-day="${d}" data-idx="${idx}">${timeSelectOptions(rule.from)}</select>
                            <span>tot</span>
                            <select class="staffing-to" data-day="${d}" data-idx="${idx}">${timeSelectOptions(rule.to)}</select>
                        </div>
                        <div class="staffing-rule-min">
                            <span>min</span>
                            <input type="number" class="form-input staffing-min-input" data-day="${d}" data-idx="${idx}" value="${rule.min != null ? rule.min : 1}" min="0" max="10">
                        </div>
                        <button class="staffing-rule-remove" data-day="${d}" data-idx="${idx}" title="Verwijder">×</button>
                    </div>`;
                });

                html += `<button class="btn btn-xs btn-secondary staffing-rule-add" data-day="${d}">+</button>`;
            }

            html += '</div>';
        }

        html += '</div>'; // staffing-columns

        html += `<div class="staffing-editor-actions">
            <button class="btn btn-secondary btn-xs" id="staffing-copy-all-weeks">Kopieer naar alle weken</button>
            <button class="btn btn-secondary btn-xs" id="staffing-clear-all">Wis alles</button>
        </div>`;
        html += '</div>';
    }

    html += '</div>';
    return html;
}

function renderBuilderMeetingsEditor() {
    const isOpen = AppState.builderShowMeetingsEditor;
    const arrow = isOpen ? '▲' : '▼';
    let html = `<div class="builder-meetings-editor-wrapper">
        <button class="btn btn-secondary btn-sm builder-section-toggle builder-meetings-toggle-btn" id="builder-meetings-toggle">
            ${IconHelper.html(ICONS.employees, 'xs')} Teamvergaderingen ${arrow}
        </button>`;

    if (isOpen) {
        const teams = DataStore.settings.teams || {};
        const meetings = AppState.builderMeetings || {};
        const dayLabels = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];

        html += '<div class="builder-meetings-editor">';
        html += '<div class="meetings-columns">';

        for (const [teamId, teamCfg] of Object.entries(teams)) {
            const teamMeetings = meetings[teamId] || [];
            html += `<div class="meetings-col">`;
            html += `<div class="meetings-col-header" style="background:${teamCfg.color || '#666'};color:#fff">${escapeHtml(teamCfg.name)}</div>`;

            teamMeetings.forEach((m, idx) => {
                const fromDisplay = formatStaffingHour(m.from || 9);
                const toDisplay = formatStaffingHour(m.to || 11);
                html += `<div class="meeting-rule-card">
                    <div class="meeting-rule-row">
                        <select class="meeting-day" data-team="${teamId}" data-idx="${idx}">
                            ${dayLabels.map((d, di) => `<option value="${di}" ${di === m.day ? 'selected' : ''}>${d}</option>`).join('')}
                        </select>
                        <button class="meeting-rule-remove" data-team="${teamId}" data-idx="${idx}" title="Verwijder">&times;</button>
                    </div>
                    <div class="meeting-rule-row">
                        <select class="meeting-from" data-team="${teamId}" data-idx="${idx}">${timeSelectOptions(m.from || 9)}</select>
                        <span class="meeting-sep">–</span>
                        <select class="meeting-to" data-team="${teamId}" data-idx="${idx}">${timeSelectOptions(m.to || 11)}</select>
                    </div>
                </div>`;
            });

            html += `<button class="meeting-rule-add btn btn-xs" data-team="${teamId}">+ Vergadering</button>`;
            html += `</div>`;
        }

        html += '</div>'; // meetings-columns
        html += '</div>'; // builder-meetings-editor
    }

    html += '</div>';
    return html;
}

function renderBuilderWarnings(employees) {
    const minHours = DataStore.settings.rules?.minHoursBetweenShifts || 11;
    const maxDays = DataStore.settings.rules?.maxConsecutiveDays || 6;
    const warnings = [];
    const dayNames = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
    const cycleLength = getBuilderCycleLength();
    const currentWeek = AppState.builderWeekNumber;

    function restHoursBetween(shift1, shift2) {
        let endMin = shift1.endTime.split(':').map(Number);
        let startMin = shift2.startTime.split(':').map(Number);
        let end = endMin[0] * 60 + endMin[1];
        const start2 = startMin[0] * 60 + startMin[1];
        const startOfShift1 = shift1.startTime.split(':').map(Number);
        const s1Start = startOfShift1[0] * 60 + startOfShift1[1];
        if (end <= s1Start) end += 24 * 60; // overnight
        return ((24 * 60 - end) + start2) / 60;
    }

    employees.forEach(emp => {
        const empGrid = AppState.builderGrid[emp.id] || {};
        const days = Object.keys(empGrid).map(Number).sort((a, b) => a - b);

        // 11-hour rule: within current week (consecutive days only, no wrap)
        for (let i = 0; i < days.length - 1; i++) {
            if (days[i + 1] !== days[i] + 1) continue;
            const rest = restHoursBetween(empGrid[days[i]], empGrid[days[i + 1]]);
            if (rest < minHours) {
                warnings.push(
                    `<strong>${escapeHtml(emp.name)}</strong>: ${rest.toFixed(1)}u rust tussen ${dayNames[days[i]]} en ${dayNames[days[i + 1]]} (min. ${minHours}u)`
                );
            }
        }

        // 11-hour rule: week boundary (Sunday of week N → Monday of week N+1)
        const sundayShift = empGrid[6];
        if (sundayShift) {
            const nextWeek = currentWeek < cycleLength ? currentWeek + 1 : 1;
            const nextWeekEmpGrid = (AppState.builderGridByWeek[nextWeek] || {})[emp.id] || {};
            const nextMonday = nextWeekEmpGrid[0];
            if (nextMonday) {
                const rest = restHoursBetween(sundayShift, nextMonday);
                const weekNote = cycleLength > 1 ? ` (week ${currentWeek}→${nextWeek})` : ' (weekovergang)';
                if (rest < minHours) {
                    warnings.push(
                        `<strong>${escapeHtml(emp.name)}</strong>: ${rest.toFixed(1)}u rust tussen Zo en Ma${weekNote} (min. ${minHours}u)`
                    );
                }
            }
        }

        // Max consecutive days check (within current week only)
        if (days.length > maxDays) {
            let maxConsec = 1, currentConsec = 1;
            for (let i = 1; i < days.length; i++) {
                if (days[i] === days[i - 1] + 1) { currentConsec++; maxConsec = Math.max(maxConsec, currentConsec); }
                else currentConsec = 1;
            }
            if (maxConsec > maxDays) {
                warnings.push(
                    `<strong>${escapeHtml(emp.name)}</strong>: ${maxConsec} opeenvolgende werkdagen in weekpatroon (max ${maxDays})`
                );
            }
        }
    });

    if (warnings.length === 0) return '';

    return `<div class="builder-11h-warnings">
        <div class="builder-11h-warnings-title">Planningsregel waarschuwingen</div>
        <ul>${warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </div>`;
}

// Legacy alias
function renderBuilder11HourWarnings(employees) { return renderBuilderWarnings(employees); }

function calculateBuilderShiftHours(assignment) {
    return calculateShiftHours({
        date: '2026-01-01',
        startTime: assignment.startTime,
        endTime: assignment.endTime
    });
}

function getTemplateNameForTimes(startTime, endTime) {
    const templates = DataStore.settings.shiftTemplates || {};
    const match = Object.entries(templates).find(([key, t]) =>
        t.start === startTime && t.end === endTime
    );
    if (match) return match[1].name;
    return `${startTime}-${endTime}`;
}

function calcHoursBetweenTwoAssignments(shift1, shift2) {
    // Assumes consecutive days
    const [eh, em] = shift1.endTime.split(':').map(Number);
    const [sh, sm] = shift1.startTime.split(':').map(Number);

    let endHour = eh + em / 60;
    const startHour = sh + sm / 60;
    // Overnight shift
    if (endHour <= startHour) endHour += 24;

    const [s2h, s2m] = shift2.startTime.split(':').map(Number);
    const nextStartHour = 24 + s2h + s2m / 60; // next day

    return nextStartHour - endHour;
}


// ===== END ROOSTERBOUWER EDITORS =====
