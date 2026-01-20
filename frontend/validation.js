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
    // Als tijd over middernacht gaat (bijv. nachtdienst), voeg dag toe
    const [hours, minutes] = time.split(':').map(Number);
    const dt = new Date(date);
    dt.setHours(hours, minutes, 0, 0);
    return dt;
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
    const end1 = getShiftEndDateTime(shift1);
    const start2 = parseDateTime(shift2.date, shift2.startTime);

    const diffMs = Math.abs(start2 - end1);
    const diffHours = diffMs / (1000 * 60 * 60);

    return diffHours;
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

    // Haal alle diensten van deze medewerker op (behalve de dienst die we aanpassen)
    const employeeShifts = DataStore.shifts.filter(s =>
        s.employeeId === employeeId && s.id !== excludeShiftId
    );

    // Check voor elke bestaande dienst
    employeeShifts.forEach(existingShift => {
        const hoursBetween = getHoursBetweenShifts(existingShift, newShift);

        if (hoursBetween < 11) {
            const employee = getEmployee(employeeId);
            errors.push({
                type: ValidationRules.ERROR,
                rule: '11-uur regel',
                message: `${employee.name} heeft minder dan 11 uur rust tussen diensten (${Math.round(hoursBetween * 10) / 10} uur tussen ${formatDate(existingShift.date)} en ${formatDate(newShift.date)})`,
                shift1: existingShift,
                shift2: newShift
            });
        } else if (hoursBetween < 12) {
            const employee = getEmployee(employeeId);
            warnings.push({
                type: ValidationRules.WARNING,
                rule: '11-uur regel',
                message: `${employee.name} heeft weinig rust tussen diensten (${Math.round(hoursBetween * 10) / 10} uur tussen ${formatDate(existingShift.date)} en ${formatDate(newShift.date)})`,
                shift1: existingShift,
                shift2: newShift
            });
        }
    });

    return { errors, warnings };
}

function validateShiftOverlap(employeeId, newShift, excludeShiftId = null) {
    const errors = [];

    const employeeShifts = DataStore.shifts.filter(s =>
        s.employeeId === employeeId && s.id !== excludeShiftId
    );

    employeeShifts.forEach(existingShift => {
        if (shiftsOverlap(existingShift, newShift)) {
            const employee = getEmployee(employeeId);
            errors.push({
                type: ValidationRules.ERROR,
                rule: 'Overlappende diensten',
                message: `${employee.name} heeft al een dienst op ${formatDate(existingShift.date)} van ${existingShift.startTime} tot ${existingShift.endTime}`,
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

    // Check of medewerker op dit team mag werken
    const canWork = employee.mainTeam === teamId || employee.extraTeams.includes(teamId);

    if (!canWork) {
        warnings.push({
            type: ValidationRules.WARNING,
            rule: 'Team toewijzing',
            message: `${employee.name} is niet gekoppeld aan team ${DataStore.settings.teams[teamId].name}. Hoofdteam: ${DataStore.settings.teams[employee.mainTeam].name}`
        });
    }

    return { errors, warnings };
}

function validateMinimumStaffing(date, teamId = null) {
    const warnings = [];
    const errors = [];

    const shiftsOnDate = getShiftsByDate(date);

    // Check of dit een vakantieperiode is
    const isHoliday = isHolidayPeriod(date);
    const holidayRules = DataStore.settings.holidayRules || {};
    const normalRules = DataStore.settings.rules;

    // Tijdens vakantie: andere regels (Vlot 1 + Vlot 2 samen)
    const minStaffingDay = isHoliday ? (holidayRules.minStaffingDay || 2) : normalRules.minStaffingDay;

    if (teamId) {
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
            // Normale periode: check alle teams apart
            Object.keys(DataStore.settings.teams).forEach(team => {
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

    return { errors, warnings };
}

function validateWeekendStatus(date, startTime = null, endTime = null) {
    const warnings = [];
    const d = new Date(date);
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
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(d.toISOString().split('T')[0]);
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

console.log('Validation systeem geladen');
