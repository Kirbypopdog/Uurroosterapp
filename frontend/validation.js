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
    const [endHours] = shift.endTime.split(':').map(Number);
    const [startHours] = shift.startTime.split(':').map(Number);

    const endDT = parseDateTime(shift.date, shift.endTime);

    // Als eindtijd kleiner is dan starttijd, is het de volgende dag
    if (endHours < startHours) {
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

    return { errors, warnings };
}

function validateMinimumStaffing(date, teamId = null) {
    const warnings = [];
    const errors = [];

    const shiftsOnDate = getShiftsByDate(date);
    const day = parseDateOnly(date).getDay();
    const isWeekend = day === 0 || day === 6;

    // Friday evening closure for closed weekends
    if (day === 5 && !isWeekendOpen(date)) {
        return { errors, warnings };
    }

    if (isWeekend && !isWeekendOpen(date)) {
        return { errors, warnings };
    }

    // Check of dit een vakantieperiode is
    const isHoliday = isHolidayPeriod(date);
    const holidayRules = DataStore.settings.holidayRules || {};
    const normalRules = DataStore.settings.rules;

    // Tijdens vakantie: andere regels (Vlot 1 + Vlot 2 samen)
    const minStaffingDay = isHoliday ? (holidayRules.minStaffingDay || 2) : normalRules.minStaffingDay;
    const minStaffingNight = isHoliday ? (holidayRules.minStaffingNight || 1) : normalRules.minStaffingNight;

    if (teamId) {
        if (teamId === 'jobstudent' || teamId === 'overkoepelend') {
            return { errors, warnings };
        }
        // Check specifiek team (alleen in normale periode)
        if (!isHoliday) {
            const teamShifts = shiftsOnDate.filter(s => s.team === teamId);

            if (teamShifts.length === 0) {
                warnings.push({
                    type: ValidationRules.WARNING,
                    rule: 'Minimale bezetting',
                    message: `Geen diensten ingepland voor ${DataStore.settings.teams[teamId].name} op ${formatDate(date)}`
                });
            } else if (teamShifts.length < minStaffingDay) {
                warnings.push({
                    type: ValidationRules.WARNING,
                    rule: 'Minimale bezetting',
                    message: `Minder dan ${minStaffingDay} persoon/personen voor ${DataStore.settings.teams[teamId].name} op ${formatDate(date)}`
                });
            }
        }
    } else {
        // Tijdens vakantie: Vlot 1 + Vlot 2 samen tellen
        if (isHoliday) {
            // Tel diensten van beide leefgroepen samen
            const combinedShifts = shiftsOnDate.filter(s => s.team === 'vlot1' || s.team === 'vlot2');

            if (combinedShifts.length < minStaffingDay) {
                warnings.push({
                    type: ValidationRules.WARNING,
                    rule: 'Vakantie bezetting',
                    message: `Vakantie (Vlot 1+2 samen): ${combinedShifts.length} personen op ${formatDate(date)}, minimum: ${minStaffingDay}`
                });
            }
        } else {
            // Normale periode: check alle teams apart (jobstudenten tellen niet mee)
            Object.keys(DataStore.settings.teams).forEach(team => {
                if (team === 'jobstudent' || team === 'overkoepelend') return;
                const teamShifts = shiftsOnDate.filter(s => s.team === team);

                if (teamShifts.length < minStaffingDay) {
                    warnings.push({
                        type: ValidationRules.WARNING,
                        rule: 'Minimale bezetting',
                        message: `${DataStore.settings.teams[team].name}: ${teamShifts.length} personen op ${formatDate(date)}`
                    });
                }
            });
        }
    }

    // Check minimale bezetting nacht (totaal)
    const nightShifts = getNightShiftsForDate(date);

    if (minStaffingNight && nightShifts.length < minStaffingNight) {
        warnings.push({
            type: ValidationRules.WARNING,
            rule: 'Minimale bezetting nacht',
            message: `Nachtbezetting: ${nightShifts.length} persoon/personen op ${formatDate(date)}, minimum: ${minStaffingNight}`
        });
    }

    return { errors, warnings };
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

    // Check if weekend is open/closed
    if (isWeekend && !isWeekendOpen(date)) {
        warnings.push({
            type: ValidationRules.WARNING,
            rule: 'Weekend gesloten',
            message: `Dit weekend (${formatDate(date)}) is gesloten volgens het patroon`
        });
    }

    // Check Friday evening (after 18:00) when weekend is closed
    if (dayOfWeek === 5 && startTime) { // Friday
        // Check the Saturday of this weekend (tomorrow)
        const saturday = new Date(d);
        saturday.setDate(d.getDate() + 1);
        if (!isWeekendOpen(saturday)) {
            const [startHour] = startTime.split(':').map(Number);
            if (startHour >= 18) {
                warnings.push({
                    type: ValidationRules.WARNING,
                    rule: 'Weekend gesloten',
                    message: `Vrijdag vanaf 18:00 is gesloten (weekend gesloten patroon)`
                });
            }
        }
    }

    // Check Monday morning (before 7:30) when weekend was closed
    // Diensten kunnen pas starten vanaf 7:30
    if (dayOfWeek === 1 && startTime) { // Monday
        // Check previous weekend (Saturday)
        const saturday = new Date(d);
        saturday.setDate(d.getDate() - 2); // Go back to Saturday
        if (!isWeekendOpen(saturday)) {
            const [startHour, startMin] = startTime.split(':').map(Number);
            const startMinutes = startHour * 60 + startMin;
            const targetMinutes = 7 * 60 + 30; // 7:30

            if (startMinutes < targetMinutes) {
                warnings.push({
                    type: ValidationRules.WARNING,
                    rule: 'Weekend gesloten',
                    message: `Maandag is gesloten tot 7:30 (weekend gesloten patroon). Dienst kan pas starten vanaf 7:30.`
                });
            }
        }
    }

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
    allWarnings.push(...team.warnings);

    // 4. Check weekend status
    const weekend = validateWeekendStatus(shiftData.date, shiftData.startTime, shiftData.endTime);
    allWarnings.push(...weekend.warnings);

    // 5. Check beschikbaarheid
    const availability = validateAvailability(shiftData.employeeId, shiftData.date, shiftData.startTime, shiftData.endTime);
    allWarnings.push(...availability.warnings);

    return {
        isValid: allErrors.length === 0,
        hasWarnings: allWarnings.length > 0,
        errors: allErrors,
        warnings: allWarnings
    };
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
                summary.shiftsWithErrors++;
                dateIssues.errors.push(...validation.errors);
            }

            if (validation.hasWarnings) {
                summary.shiftsWithWarnings++;
                dateIssues.warnings.push(...validation.warnings);
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
