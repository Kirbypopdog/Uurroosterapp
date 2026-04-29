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

    employees.forEach(emp => {
        const empGrid = AppState.builderGrid[emp.id] || {};
        const days = Object.keys(empGrid).map(Number).sort((a, b) => a - b);

        // 11-hour rule checks
        for (let i = 0; i < days.length; i++) {
            const nextDay = i < days.length - 1 ? days[i + 1] : null;
            const currentShift = empGrid[days[i]];

            const wrapTarget = days[i] === 6 ? empGrid[0] : null;

            const checkPairs = [];
            if (nextDay !== null && nextDay === days[i] + 1) {
                checkPairs.push({ day1: days[i], day2: nextDay, shift2: empGrid[nextDay], isWrap: false });
            }
            if (wrapTarget) {
                checkPairs.push({ day1: 6, day2: 0, shift2: wrapTarget, isWrap: true });
            }

            for (const pair of checkPairs) {
                const endParts = currentShift.endTime.split(':').map(Number);
                const startParts = pair.shift2.startTime.split(':').map(Number);

                let endMinutes = endParts[0] * 60 + endParts[1];
                let startMinutes = startParts[0] * 60 + startParts[1];

                const shift1StartParts = currentShift.startTime.split(':').map(Number);
                const shift1Start = shift1StartParts[0] * 60 + shift1StartParts[1];
                if (endMinutes <= shift1Start) {
                    endMinutes += 24 * 60;
                }

                const restMinutes = (24 * 60 - endMinutes) + startMinutes;
                const restHours = restMinutes / 60;

                if (restHours < minHours) {
                    const label1 = dayNames[pair.day1];
                    const label2 = dayNames[pair.day2];
                    const wrapNote = pair.isWrap ? ' (weekovergang)' : '';
                    warnings.push(
                        `<strong>${escapeHtml(emp.name)}</strong>: ${restHours.toFixed(1)}u rust tussen ${label1} en ${label2}${wrapNote} (min. ${minHours}u)`
                    );
                }
            }
        }

        // Max consecutive days check (including wrap-around for repeating pattern)
        if (days.length > maxDays) {
            // Count longest consecutive run
            let maxConsec = 1, currentConsec = 1;
            for (let i = 1; i < days.length; i++) {
                if (days[i] === days[i - 1] + 1) { currentConsec++; maxConsec = Math.max(maxConsec, currentConsec); }
                else currentConsec = 1;
            }
            // Check wrap-around (zo→ma)
            if (days.includes(6) && days.includes(0)) {
                let tailCount = 0, headCount = 0;
                for (let i = days.length - 1; i >= 0 && days[i] === 6 - (days.length - 1 - i); i--) tailCount++;
                for (let i = 0; i < days.length && days[i] === i; i++) headCount++;
                maxConsec = Math.max(maxConsec, tailCount + headCount);
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
