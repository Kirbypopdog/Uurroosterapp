// ===== VALIDATIE SYSTEEM =====
// Dit bestand controleert alle planning regels

const ValidationRules = {
    // Resultaat types
    VALID: 'valid',
    WARNING: 'warning',
    ERROR: 'error'
};

// ===== TIJD BEREKENINGEN =====

function parseDateTime(date, time) {
    const [year, month, day] = date.split('-').map(Number);
    const [hours, minutes] = time.split(':').map(Number);
    return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function getShiftEndDateTime(shift) {
    const startDT = parseDateTime(shift.date, shift.startTime);
    const endDT = parseDateTime(shift.date, shift.endTime);

    // Als eindtijd vóór starttijd valt (ook bij zelfde uur maar vroeger minuut), eindigt de dienst de volgende dag
    if (endDT < startDT) {
        endDT.setDate(endDT.getDate() + 1);
    }

    return endDT;
}

function getHoursBetweenShifts(shift1, shift2) {
    const start1 = parseDateTime(shift1.date, shift1.startTime);
    const end1 = getShiftEndDateTime(shift1);
    const start2 = parseDateTime(shift2.date, shift2.startTime);
    const end2 = getShiftEndDateTime(shift2);

    const restMs = start1 <= start2 ? (start2 - end1) : (start1 - end2);
    const restMinutes = restMs / (1000 * 60);

    return restMinutes / 60;
}

function shiftsOverlap(shift1, shift2) {
    const start1 = parseDateTime(shift1.date, shift1.startTime);
    const end1 = getShiftEndDateTime(shift1);
    const start2 = parseDateTime(shift2.date, shift2.startTime);
    const end2 = getShiftEndDateTime(shift2);

    return (start1 < end2 && start2 < end1);
}

// ===== VALIDATIE FUNCTIES =====

function validate11HourRule(employeeId, newShift, excludeShiftId = null) {
    const errors = [];
    const warnings = [];
    const minHoursBetweenShifts = DataStore.settings.rules?.minHoursBetweenShifts || 11;

    // Haal alle diensten van deze medewerker op (behalve de dienst(en) die we aanpassen)
    // excludeShiftId can be a single ID or an array of IDs
    const excludeIds = Array.isArray(excludeShiftId) ? excludeShiftId : (excludeShiftId ? [excludeShiftId] : []);
    const employeeShifts = DataStore.shifts.filter(s =>
        s.employeeId === employeeId && !excludeIds.includes(s.id)
    );

    // Check voor elke bestaande dienst
    employeeShifts.forEach(existingShift => {
        const hoursBetween = getHoursBetweenShifts(existingShift, newShift);
        const displayHours = Math.max(0, Math.round(hoursBetween * 10) / 10);

        if (hoursBetween < minHoursBetweenShifts) {
            const employee = getEmployee(employeeId);
            const employeeName = employee?.name || `Medewerker #${employeeId}`;
            errors.push({
                type: ValidationRules.ERROR,
                rule: '11-uur regel',
                message: `${employeeName} heeft minder dan ${minHoursBetweenShifts} uur rust tussen diensten (${displayHours} uur tussen ${formatDate(existingShift.date)} en ${formatDate(newShift.date)})`,
                shift1: existingShift,
                shift2: newShift
            });
        }
    });

    return { errors, warnings };
}

function validateShiftOverlap(employeeId, newShift, excludeShiftId = null) {
    const errors = [];

    // excludeShiftId can be a single ID or an array of IDs
    const excludeIds = Array.isArray(excludeShiftId) ? excludeShiftId : (excludeShiftId ? [excludeShiftId] : []);
    const employeeShifts = DataStore.shifts.filter(s =>
        s.employeeId === employeeId && !excludeIds.includes(s.id)
    );

    employeeShifts.forEach(existingShift => {
        if (shiftsOverlap(existingShift, newShift)) {
            const employee = getEmployee(employeeId);
            const employeeName = employee?.name || `Medewerker #${employeeId}`;
            errors.push({
                type: ValidationRules.ERROR,
                rule: 'Overlappende diensten',
                message: `${employeeName} heeft al een dienst op ${formatDate(existingShift.date)} van ${existingShift.startTime} tot ${existingShift.endTime}`,
                shift1: existingShift,
                shift2: newShift
            });
        }
    });

    return { errors, warnings: [] };
}

function validateTeamAssignment(employeeId, teamId) {
    const errors = [];
    const warnings = [];
    const employee = getEmployee(employeeId);

    if (!employee) {
        errors.push({
            type: ValidationRules.ERROR,
            rule: 'Medewerker niet gevonden',
            message: 'Medewerker bestaat niet in het systeem'
        });
        return { errors, warnings };
    }

    // Cross-team shifts zijn toegestaan voor alle rollen: medewerkers wijzen alleen
    // zichzelf toe, en admins/leads kennen bewust iemand aan een ander team toe.

    return { errors, warnings };
}

function validateMinimumStaffing(date, teamId = null) {
    const warnings = [];
    if (typeof isDayClosed === 'function' && isDayClosed(date)) return { errors: [], warnings };
    if (typeof getStaffingRulesForDay !== 'function' || typeof calcPlanningHourlyHeadcount !== 'function') {
        return { errors: [], warnings };
    }
    const dayRules = getStaffingRulesForDay(date);
    if (!dayRules || dayRules.length === 0) return { errors: [], warnings };

    let wStart = null, wEnd = null, wNetto = null, wMin = null;
    const badWindows = [];
    for (let h = 7; h < 24; h += 0.5) {
        let required = -1;
        for (const rule of dayRules) {
            if (h >= rule.from && h < rule.to) required = Math.max(required, rule.min);
        }
        if (required < 0) {
            if (wStart !== null) { badWindows.push({ from: wStart, to: wEnd, netto: wNetto, min: wMin }); wStart = null; }
            continue;
        }
        const { netto } = calcPlanningHourlyHeadcount(date, h);
        if (netto < required) {
            if (wStart === null) { wStart = h; wNetto = netto; wMin = required; }
            wEnd = h + 0.5;
        } else {
            if (wStart !== null) { badWindows.push({ from: wStart, to: wEnd, netto: wNetto, min: wMin }); wStart = null; }
        }
    }
    if (wStart !== null) badWindows.push({ from: wStart, to: wEnd, netto: wNetto, min: wMin });

    if (badWindows.length > 0) {
        const fmtH = h => `${String(Math.floor(h)).padStart(2,'0')}:${h%1 === 0.5 ? '30' : '00'}`;
        const detail = badWindows.map(w => `${fmtH(w.from)}–${fmtH(w.to)}: ${w.netto}/${w.min} mdw`).join(', ');
        warnings.push({ rule: 'onderbezetting', message: `Onderbezet: ${detail}` });
    }
    return { errors: [], warnings };
}

function shiftOverlapsNightWindow(shift, targetDate) {
    if (shift.team === 'jobstudent' || shift.team === 'overkoepelend') return false;
    const shiftStart = parseDateTime(shift.date, shift.startTime);
    const shiftEnd = getShiftEndDateTime(shift);
    const nightStart = parseDateTime(targetDate, '22:00');
    const nightEnd = parseDateTime(targetDate, '07:00');
    nightEnd.setDate(nightEnd.getDate() + 1);

    return shiftStart < nightEnd && shiftEnd > nightStart;
}

function getNightShiftsForDate(date) {
    const nightShifts = [];
    const currentDate = parseDateOnly(date);
    const prevDate = parseDateOnly(currentDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateStr = formatDateYYYYMMDD(prevDate);

    const candidateShifts = [
        ...getShiftsByDate(date),
        ...getShiftsByDate(prevDateStr)
    ];

    candidateShifts.forEach(shift => {
        if (shiftOverlapsNightWindow(shift, date)) {
            nightShifts.push(shift);
        }
    });

    return nightShifts;
}

function validateWeekendStatus(date, startTime = null, endTime = null) {
    const warnings = [];
    const d = parseDateOnly(date);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // Weekend gesloten warnings removed — gesloten dagen zijn al visueel zichtbaar in het rooster

    return { errors: [], warnings };
}

function validateAvailability(employeeId, date, startTime = null, endTime = null) {
    const warnings = [];
    const employee = getEmployee(employeeId);

    if (!employee) return { warnings };

    const absence = getAvailability(employeeId, date);

    // Geen data = beschikbaar, dus geen waarschuwing
    if (!absence || !absence.type) {
        return { warnings };
    }

    // Medewerker is afwezig
    const absenceLabels = {
        'verlof': 'Verlof',
        'ziek': 'Ziekte',
        'overuren': 'Overuren opnemen',
        'vorming': 'Vorming/Opleiding',
        'andere': 'Andere'
    };

    const absenceType = absenceLabels[absence.type] || 'Afwezig';
    const reason = absence.reason ? ` (${absence.reason})` : '';

    warnings.push({
        type: ValidationRules.WARNING,
        rule: 'Afwezigheid',
        message: `${employee.name} is afwezig op ${formatDate(date)}: ${absenceType}${reason}`
    });

    return { warnings };
}


// ===== PLANNINGREGELS =====

function validateMaxConsecutiveDays(employeeId, newShift, excludeShiftId = null) {
    const warnings = [];
    const maxDays = DataStore.settings.rules?.maxConsecutiveDays || 6;

    // Collect all work dates for this employee (including new shift)
    const excludeIds = Array.isArray(excludeShiftId) ? excludeShiftId.map(String) : [String(excludeShiftId)];
    const empDates = DataStore.shifts
        .filter(s => String(s.userId) === String(employeeId) && !excludeIds.includes(String(s.id)))
        .map(s => s.date);
    if (!empDates.includes(newShift.date)) empDates.push(newShift.date);
    const uniqueDates = [...new Set(empDates)].sort();

    // Count consecutive days around the new shift date
    const targetStr = newShift.date;
    let consecutiveCount = 1;

    // Count backwards
    let checkDate = new Date(targetStr + 'T12:00:00');
    while (true) {
        checkDate.setDate(checkDate.getDate() - 1);
        const dateStr = checkDate.toISOString().split('T')[0];
        if (uniqueDates.includes(dateStr)) consecutiveCount++;
        else break;
    }

    // Count forwards
    checkDate = new Date(targetStr + 'T12:00:00');
    while (true) {
        checkDate.setDate(checkDate.getDate() + 1);
        const dateStr = checkDate.toISOString().split('T')[0];
        if (uniqueDates.includes(dateStr)) consecutiveCount++;
        else break;
    }

    if (consecutiveCount > maxDays) {
        const employee = getEmployee(employeeId);
        warnings.push({
            type: ValidationRules.WARNING,
            rule: 'Max opeenvolgende dagen',
            message: `${employee?.name || 'Medewerker'} werkt ${consecutiveCount} opeenvolgende dagen (max ${maxDays})`
        });
    }

    return { warnings };
}

// validateRestAfterNight and validateMinFreeWeekends removed per user request

// ===== VOLLEDIGE VALIDATIE =====

function validateShift(shiftData, excludeShiftId = null) {
    const allErrors = [];
    const allWarnings = [];

    // 1. Check 11-uur regel
    const rule11h = validate11HourRule(shiftData.employeeId, shiftData, excludeShiftId);
    allErrors.push(...rule11h.errors);
    allWarnings.push(...rule11h.warnings);

    // 2. Check overlappende diensten
    const overlap = validateShiftOverlap(shiftData.employeeId, shiftData, excludeShiftId);
    allErrors.push(...overlap.errors);

    // 3. Check team toewijzing
    const team = validateTeamAssignment(shiftData.employeeId, shiftData.team);
    allErrors.push(...team.errors);
    allWarnings.push(...team.warnings);

    // 4. Check weekend status
    const weekend = validateWeekendStatus(shiftData.date, shiftData.startTime, shiftData.endTime);
    allWarnings.push(...weekend.warnings);

    // 5. Check beschikbaarheid
    const availability = validateAvailability(shiftData.employeeId, shiftData.date, shiftData.startTime, shiftData.endTime);
    allWarnings.push(...availability.warnings);

    // 6. Check max opeenvolgende dagen
    const consecutive = validateMaxConsecutiveDays(shiftData.employeeId, shiftData, excludeShiftId);
    allWarnings.push(...consecutive.warnings);

    return {
        isValid: allErrors.length === 0,
        hasWarnings: allWarnings.length > 0,
        errors: allErrors,
        warnings: allWarnings
    };
}

// ===== CONFLICT RESOLUTION: SUGGESTIES =====

function generateSuggestions(error, shiftData) {
    const suggestions = [];

    switch (error.rule) {
        case '11-uur regel': {
            const minHours = DataStore.settings.rules?.minHoursBetweenShifts || 11;
            if (error.shift1) {
                // Suggest adjusting start time to meet rest requirement
                const existingEnd = getShiftEndDateTime(error.shift1);
                const suggestedStart = new Date(existingEnd.getTime() + minHours * 3600000);
                const shiftDate = parseDateOnly(shiftData.date);

                if (suggestedStart.toDateString() === shiftDate.toDateString()) {
                    const timeStr = `${String(suggestedStart.getHours()).padStart(2, '0')}:${String(suggestedStart.getMinutes()).padStart(2, '0')}`;
                    suggestions.push({
                        label: `Starttijd naar ${timeStr} (${minHours}u rust)`,
                        field: 'startTime',
                        value: timeStr
                    });
                }

                // Suggest the next day
                const nextDay = new Date(shiftDate);
                nextDay.setDate(nextDay.getDate() + 1);
                const nextDayStr = nextDay.toISOString().split('T')[0];
                suggestions.push({
                    label: `Verplaats naar ${formatDate(nextDayStr)}`,
                    field: 'date',
                    value: nextDayStr
                });
            }
            break;
        }
        case 'Overlappende diensten': {
            if (error.shift1) {
                suggestions.push({
                    label: `Start na ${error.shift1.endTime}`,
                    field: 'startTime',
                    value: error.shift1.endTime
                });
                suggestions.push({
                    label: 'Kies andere medewerker',
                    field: 'employeeId',
                    value: null,
                    action: 'focus-employee'
                });
            }
            break;
        }
        case 'Team mismatch': {
            const employee = getEmployee(shiftData.employeeId);
            if (employee) {
                const mainTeam = employee.mainTeam || employee.main_team;
                if (mainTeam) {
                    const teamName = DataStore.settings.teams?.[mainTeam]?.name || mainTeam;
                    suggestions.push({
                        label: `Team naar ${teamName}`,
                        field: 'team',
                        value: mainTeam
                    });
                }
            }
            break;
        }
        // 'Weekend gesloten' case removed — warnings no longer generated
        case 'Afwezigheid': {
            // Suggest available employees for this slot
            const allEmployees = getAllEmployees ? getAllEmployees(true) : DataStore.employees;
            const available = allEmployees.filter(emp => {
                if (emp.id === shiftData.employeeId) return false;
                const absence = getAvailability(emp.id, shiftData.date);
                return !absence || !absence.type;
            }).slice(0, 3);

            available.forEach(emp => {
                suggestions.push({
                    label: `Toewijzen aan ${emp.name}`,
                    field: 'employeeId',
                    value: String(emp.id)
                });
            });
            break;
        }
        case 'Max opeenvolgende dagen': {
            suggestions.push({
                label: 'Kies andere medewerker',
                field: 'employeeId',
                value: null,
                action: 'focus-employee'
            });
            break;
        }
        // 'Rust na nachtdienst' and 'Min vrije weekenden' cases removed
    }

    return suggestions;
}

function validateAllShifts() {
    const allIssues = [];

    // Check elke dienst
    DataStore.shifts.forEach(shift => {
        const validation = validateShift(shift, shift.id);

        if (!validation.isValid || validation.hasWarnings) {
            allIssues.push({
                shift,
                validation
            });
        }
    });

    return allIssues;
}

// ===== HELPER FUNCTIES =====

function getValidationSummary(startDate, endDate) {
    const dates = [];
    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    for (let d = parseDateOnly(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(formatDateYYYYMMDD(d));
    }

    const summary = {
        totalShifts: 0,
        shiftsWithErrors: 0,
        shiftsWithWarnings: 0,
        dates: {}
    };

    // Bijhouden van al gerapporteerde shift-paren om duplicaten te voorkomen
    const seenPairs = new Set();

    dates.forEach(date => {
        const shiftsOnDate = getShiftsByDate(date);
        summary.totalShifts += shiftsOnDate.length;

        const dateIssues = {
            errors: [],
            warnings: []
        };

        shiftsOnDate.forEach(shift => {
            const validation = validateShift(shift, shift.id);

            if (!validation.isValid) {
                const uniqueErrors = validation.errors.filter(err => {
                    if (err.shift1?.id != null && err.shift2?.id != null) {
                        const key = [err.shift1.id, err.shift2.id].sort().join('-');
                        if (seenPairs.has(key)) return false;
                        seenPairs.add(key);
                    }
                    return true;
                });
                if (uniqueErrors.length > 0) {
                    summary.shiftsWithErrors++;
                    dateIssues.errors.push(...uniqueErrors);
                }
            }

            if (validation.hasWarnings) {
                const uniqueWarnings = validation.warnings.filter(w => {
                    if (w.shift1?.id != null && w.shift2?.id != null) {
                        const key = [w.shift1.id, w.shift2.id].sort().join('-');
                        if (seenPairs.has(key)) return false;
                        seenPairs.add(key);
                    }
                    return true;
                });
                if (uniqueWarnings.length > 0) {
                    summary.shiftsWithWarnings++;
                    dateIssues.warnings.push(...uniqueWarnings);
                }
            }
        });

        // Check minimale bezetting
        const staffing = validateMinimumStaffing(date);
        dateIssues.warnings.push(...staffing.warnings);

        summary.dates[date] = dateIssues;
    });

    return summary;
}

// ===== SWAP REQUEST VALIDATIE =====

function validateSwapRequest(swapData) {
    const { requesterShift, targetShift, requesterUserId, targetUserId } = swapData;

    const result = {
        isValid: true,
        hasWarnings: false,
        errors: [],
        warnings: []
    };

    // 1. Verify beide shifts bestaan
    if (!requesterShift || !targetShift) {
        result.isValid = false;
        result.errors.push('Een of beide shifts niet gevonden');
        return result;
    }

    // 2. Verify shifts haven't passed
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const requesterDate = new Date(requesterShift.date);
    const targetDate = new Date(targetShift.date);

    if (requesterDate < now) {
        result.isValid = false;
        result.errors.push('Je eigen shift ligt in het verleden');
    }

    if (targetDate < now) {
        result.isValid = false;
        result.errors.push('De gewenste shift ligt in het verleden');
    }

    // 3. Check for active leave/sickness on swap dates
    // Requester getting target shift (on target date)
    const requesterAvailabilityOnTargetDate = getAvailability(requesterUserId, targetShift.date);
    if (requesterAvailabilityOnTargetDate && ['ziek', 'verlof'].includes(requesterAvailabilityOnTargetDate.type)) {
        result.isValid = false;
        result.errors.push(
            `Je hebt al ${requesterAvailabilityOnTargetDate.type === 'ziek' ? 'ziekte' : 'verlof'} op ${formatDate(targetShift.date)} (de datum van de gewenste shift)`
        );
    }

    // Target getting requester shift (on requester date)
    const targetAvailabilityOnRequesterDate = getAvailability(targetUserId, requesterShift.date);
    if (targetAvailabilityOnRequesterDate && ['ziek', 'verlof'].includes(targetAvailabilityOnRequesterDate.type)) {
        result.isValid = false;
        result.errors.push(
            `${DataStore.users.find(u => u.id === targetUserId)?.name || 'De ander'} heeft al ${targetAvailabilityOnRequesterDate.type === 'ziek' ? 'ziekte' : 'verlof'} op ${formatDate(requesterShift.date)}`
        );
    }

    // 4. Validate post-swap: requester gets target shift
    // IMPORTANT: Exclude BOTH shifts being swapped to avoid false positives
    const excludeShiftIds = [requesterShift.id, targetShift.id];

    const requesterPostSwapShift = {
        ...targetShift,
        userId: requesterUserId,
        employeeId: requesterUserId // Alias for compatibility
    };

    const requesterValidation = validateShift(requesterPostSwapShift, excludeShiftIds);

    if (!requesterValidation.isValid) {
        result.isValid = false;
        result.errors.push(`Na ruilen zou jij een probleem hebben: ${requesterValidation.errors.map(e => e.message).join(', ')}`);
    }

    if (requesterValidation.hasWarnings) {
        result.hasWarnings = true;
        result.warnings.push(`Waarschuwing voor jou na ruilen: ${requesterValidation.warnings.map(w => w.message).join(', ')}`);
    }

    // 5. Validate post-swap: target gets requester shift
    const targetPostSwapShift = {
        ...requesterShift,
        userId: targetUserId,
        employeeId: targetUserId // Alias for compatibility
    };

    const targetValidation = validateShift(targetPostSwapShift, excludeShiftIds);

    if (!targetValidation.isValid) {
        result.isValid = false;
        result.errors.push(
            `Na ruilen zou ${DataStore.users.find(u => u.id === targetUserId)?.name || 'de ander'} een probleem hebben: ${targetValidation.errors.map(e => e.message).join(', ')}`
        );
    }

    if (targetValidation.hasWarnings) {
        result.hasWarnings = true;
        result.warnings.push(
            `Waarschuwing voor ${DataStore.users.find(u => u.id === targetUserId)?.name || 'de ander'} na ruilen: ${targetValidation.warnings.map(w => w.message).join(', ')}`
        );
    }

    return result;
}

console.log('Validation systeem geladen');

// Allow pure utility functions to be imported in Node.js (for unit tests)
// This does not affect browser behavior since `module` is not defined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDateTime, getShiftEndDateTime, getHoursBetweenShifts, shiftsOverlap };
}
