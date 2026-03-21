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

    // Check if employee belongs to the assigned team
    if (teamId) {
        const mainTeam = employee.mainTeam || employee.main_team;
        const extraTeams = employee.extraTeams || employee.extra_teams || [];
        const employeeTeams = [mainTeam, ...extraTeams].filter(t => t);

        if (!employeeTeams.includes(teamId)) {
            const teamName = DataStore.settings.teams?.[teamId]?.name || teamId;
            const employeeTeamName = DataStore.settings.teams?.[mainTeam]?.name || mainTeam || 'Onbekend';
            warnings.push({
                type: ValidationRules.WARNING,
                rule: 'Team mismatch',
                message: `${employee.name} hoort bij ${employeeTeamName}, niet bij ${teamName}. Een roosterverantwoordelijke of admin moet deze shift goedkeuren/aanpassen.`
            });
        }
    }

    return { errors, warnings };
}

function validateMinimumStaffing(date, teamId = null) {
    // Bezettingsregels worden nu beheerd via de roosterbouwer (range-based per uur/dag)
    return { errors: [], warnings: [] };
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

function validateRestAfterNight(employeeId, newShift, excludeShiftId = null) {
    const warnings = [];
    if (DataStore.settings.rules?.mandatoryRestAfterNight === false) return { warnings };

    const excludeIds = Array.isArray(excludeShiftId) ? excludeShiftId.map(String) : [String(excludeShiftId)];
    const empShifts = DataStore.shifts.filter(s =>
        String(s.userId) === String(employeeId) && !excludeIds.includes(String(s.id))
    );

    // Check 1: Was there a night shift yesterday? New shift must have enough rest
    const prevDay = new Date(newShift.date + 'T12:00:00');
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayStr = prevDay.toISOString().split('T')[0];

    const nightShiftsBefore = empShifts.filter(s =>
        s.date === prevDayStr && isNightShift(s.startTime)
    );

    for (const nightShift of nightShiftsBefore) {
        const restHours = getHoursBetweenShifts(nightShift, newShift);
        if (restHours < 11) {
            warnings.push({
                type: ValidationRules.WARNING,
                rule: 'Rust na nachtdienst',
                message: `Slechts ${Math.round(restHours)}u rust na nachtdienst (${nightShift.startTime}-${nightShift.endTime}). Minimaal 11u vereist.`,
                shift1: nightShift
            });
        }
    }

    // Check 2: Is the new shift a night shift? Check if tomorrow already has a shift
    if (isNightShift(newShift.startTime)) {
        const nextDay = new Date(newShift.date + 'T12:00:00');
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().split('T')[0];

        const shiftsAfter = empShifts.filter(s => s.date === nextDayStr);
        for (const afterShift of shiftsAfter) {
            const restHours = getHoursBetweenShifts(newShift, afterShift);
            if (restHours < 11) {
                warnings.push({
                    type: ValidationRules.WARNING,
                    rule: 'Rust na nachtdienst',
                    message: `Slechts ${Math.round(restHours)}u rust tussen nachtdienst en volgende dienst (${afterShift.startTime}-${afterShift.endTime}). Minimaal 11u vereist.`,
                    shift1: newShift
                });
            }
        }
    }

    return { warnings };
}

function validateMinFreeWeekends(employeeId, newShift, excludeShiftId = null) {
    const warnings = [];
    const minFree = DataStore.settings.rules?.minFreeWeekendsPerMonth || 1;

    const shiftDate = new Date(newShift.date + 'T12:00:00');
    const dayOfWeek = shiftDate.getDay(); // 0=zo, 6=za

    // Only check if the new shift falls on a weekend
    if (dayOfWeek !== 0 && dayOfWeek !== 6) return { warnings };

    const year = shiftDate.getFullYear();
    const month = shiftDate.getMonth();

    // Count total weekends in this month (count Saturdays)
    let totalWeekends = 0;
    const d = new Date(year, month, 1);
    while (d.getMonth() === month) {
        if (d.getDay() === 6) totalWeekends++;
        d.setDate(d.getDate() + 1);
    }

    // Count weekends where this employee works
    const excludeIds = Array.isArray(excludeShiftId) ? excludeShiftId.map(String) : [String(excludeShiftId)];
    const empShifts = DataStore.shifts
        .filter(s => String(s.userId) === String(employeeId) && !excludeIds.includes(String(s.id)))
        .concat([newShift]);

    const workedWeekends = new Set();
    empShifts.forEach(s => {
        const sd = new Date(s.date + 'T12:00:00');
        if (sd.getFullYear() === year && sd.getMonth() === month && (sd.getDay() === 0 || sd.getDay() === 6)) {
            // Group sa+zo: use Saturday as key (if Sunday, go back 1 day)
            const satDate = new Date(sd);
            if (satDate.getDay() === 0) satDate.setDate(satDate.getDate() - 1);
            workedWeekends.add(satDate.toISOString().split('T')[0]);
        }
    });

    const freeWeekends = totalWeekends - workedWeekends.size;
    const monthNames = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];

    if (freeWeekends < minFree) {
        const employee = getEmployee(employeeId);
        warnings.push({
            type: ValidationRules.WARNING,
            rule: 'Min vrije weekenden',
            message: `${employee?.name || 'Medewerker'} heeft nog maar ${freeWeekends} vrij weekend(en) in ${monthNames[month]} (minimum ${minFree})`
        });
    }

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

    // 7. Check rust na nachtdienst
    const nightRest = validateRestAfterNight(shiftData.employeeId, shiftData, excludeShiftId);
    allWarnings.push(...nightRest.warnings);

    // 8. Check min vrije weekenden
    const weekends = validateMinFreeWeekends(shiftData.employeeId, shiftData, excludeShiftId);
    allWarnings.push(...weekends.warnings);

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
        case 'Weekend gesloten': {
            const d = parseDateOnly(shiftData.date);
            // Find next Monday
            const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
            const nextMonday = new Date(d);
            nextMonday.setDate(d.getDate() + daysUntilMonday);
            const mondayStr = nextMonday.toISOString().split('T')[0];
            suggestions.push({
                label: `Verplaats naar ma ${formatDate(mondayStr)}`,
                field: 'date',
                value: mondayStr
            });
            break;
        }
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
        case 'Rust na nachtdienst': {
            if (error.shift1) {
                const nightEnd = getShiftEndDateTime(error.shift1);
                const safeStart = new Date(nightEnd.getTime() + 11 * 3600000);
                const shiftDate = parseDateOnly(shiftData.date);
                if (safeStart.toDateString() === shiftDate.toDateString()) {
                    const timeStr = `${String(safeStart.getHours()).padStart(2, '0')}:${String(safeStart.getMinutes()).padStart(2, '0')}`;
                    suggestions.push({
                        label: `Starttijd naar ${timeStr} (11u rust)`,
                        field: 'startTime',
                        value: timeStr
                    });
                }
            }
            suggestions.push({
                label: 'Kies andere medewerker',
                field: 'employeeId',
                value: null,
                action: 'focus-employee'
            });
            break;
        }
        case 'Min vrije weekenden': {
            const d = parseDateOnly(shiftData.date);
            const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
            const nextMonday = new Date(d);
            nextMonday.setDate(d.getDate() + daysUntilMonday);
            const mondayStr = nextMonday.toISOString().split('T')[0];
            suggestions.push({
                label: `Verplaats naar ma ${formatDate(mondayStr)}`,
                field: 'date',
                value: mondayStr
            });
            suggestions.push({
                label: 'Kies andere medewerker',
                field: 'employeeId',
                value: null,
                action: 'focus-employee'
            });
            break;
        }
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
