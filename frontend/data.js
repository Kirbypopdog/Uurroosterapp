// ===== DATA MANAGEMENT SYSTEEM =====
// Dit bestand beheert alle data voor Het Vlot roosterplanning

const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {};

function cloneSettings(settings) {
    if (typeof structuredClone === 'function') {
        return structuredClone(settings);
    }

    return JSON.parse(JSON.stringify(settings));
}

// Globale data store
const DataStore = {
    employees: [],
    shifts: [],
    availability: [],
    swapRequests: [],
    settings: cloneSettings(DEFAULT_SETTINGS)
};

// ===== STORAGE FUNCTIES =====

function saveToStorage() {
    try {
        localStorage.setItem('hetvlot_employees', JSON.stringify(DataStore.employees));
        localStorage.setItem('hetvlot_shifts', JSON.stringify(DataStore.shifts));
        localStorage.setItem('hetvlot_availability', JSON.stringify(DataStore.availability));
        localStorage.setItem('hetvlot_swapRequests', JSON.stringify(DataStore.swapRequests));
        localStorage.setItem('hetvlot_settings', JSON.stringify(DataStore.settings));
        return true;
    } catch (error) {
        console.error('Fout bij opslaan:', error);
        return false;
    }
}

function loadFromStorage() {
    try {
        const employees = localStorage.getItem('hetvlot_employees');
        const shifts = localStorage.getItem('hetvlot_shifts');
        const availability = localStorage.getItem('hetvlot_availability');
        const swapRequests = localStorage.getItem('hetvlot_swapRequests');
        const settings = localStorage.getItem('hetvlot_settings');

        if (employees) DataStore.employees = JSON.parse(employees);
        if (shifts) DataStore.shifts = JSON.parse(shifts);
        if (availability) DataStore.availability = JSON.parse(availability);
        if (swapRequests) DataStore.swapRequests = JSON.parse(swapRequests);
        if (settings) DataStore.settings = { ...DataStore.settings, ...JSON.parse(settings) };

        return true;
    } catch (error) {
        console.error('Fout bij laden:', error);
        return false;
    }
}

function resetData() {
    if (confirm('Weet je zeker dat je alle data wilt verwijderen? Dit kan niet ongedaan worden gemaakt.')) {
        localStorage.removeItem('hetvlot_employees');
        localStorage.removeItem('hetvlot_shifts');
        localStorage.removeItem('hetvlot_availability');
        localStorage.removeItem('hetvlot_swapRequests');
        localStorage.removeItem('hetvlot_settings');
        location.reload();
    }
}

// ===== MEDEWERKERS FUNCTIES =====

function addEmployee(employeeData) {
    const employee = {
        id: Date.now() + Math.random(),
        name: employeeData.name,
        email: employeeData.email || '',
        mainTeam: employeeData.mainTeam,
        extraTeams: employeeData.extraTeams || [],
        contractHours: employeeData.contractHours || 0,
        active: employeeData.active !== false,
        weekScheduleWeek1: employeeData.weekScheduleWeek1 || employeeData.weekSchedule || [], // Week 1 rooster (backward compatibility)
        weekScheduleWeek2: employeeData.weekScheduleWeek2 || [], // Week 2 rooster
        createdAt: new Date().toISOString()
    };

    DataStore.employees.push(employee);
    saveToStorage();
    return employee;
}

function updateEmployee(id, updates) {
    const index = DataStore.employees.findIndex(e => e.id === id);
    if (index !== -1) {
        DataStore.employees[index] = { ...DataStore.employees[index], ...updates };
        saveToStorage();
        return DataStore.employees[index];
    }
    return null;
}

function deleteEmployee(id) {
    const index = DataStore.employees.findIndex(e => e.id === id);
    if (index !== -1) {
        DataStore.employees.splice(index, 1);
        saveToStorage();
        return true;
    }
    return false;
}

function getEmployee(id) {
    return DataStore.employees.find(e => e.id === id);
}

function getAllEmployees(activeOnly = false) {
    if (activeOnly) {
        return DataStore.employees.filter(e => e.active);
    }
    return DataStore.employees;
}

function getEmployeesByTeam(teamId, includeExtra = true) {
    return DataStore.employees.filter(e => {
        if (!e.active) return false;
        if (e.mainTeam === teamId) return true;
        if (includeExtra && e.extraTeams.includes(teamId)) return true;
        return false;
    });
}

// ===== DIENSTEN FUNCTIES =====

function addShift(shiftData) {
    const shift = {
        id: Date.now() + Math.random(),
        employeeId: shiftData.employeeId,
        team: shiftData.team,
        date: shiftData.date,
        startTime: shiftData.startTime,
        endTime: shiftData.endTime,
        notes: shiftData.notes || '',
        createdAt: new Date().toISOString()
    };

    DataStore.shifts.push(shift);
    saveToStorage();
    return shift;
}

function updateShift(id, updates) {
    const index = DataStore.shifts.findIndex(s => s.id === id);
    if (index !== -1) {
        DataStore.shifts[index] = { ...DataStore.shifts[index], ...updates };
        saveToStorage();
        return DataStore.shifts[index];
    }
    return null;
}

function deleteShift(id) {
    const index = DataStore.shifts.findIndex(s => s.id === id);
    if (index !== -1) {
        DataStore.shifts.splice(index, 1);
        saveToStorage();
        return true;
    }
    return false;
}

function getShift(id) {
    return DataStore.shifts.find(s => s.id === id);
}

function getShiftsByDate(date) {
    return DataStore.shifts.filter(s => s.date === date);
}

function getShiftsByDateRange(startDate, endDate) {
    return DataStore.shifts.filter(s => s.date >= startDate && s.date <= endDate);
}

function getShiftsByEmployee(employeeId, startDate = null, endDate = null) {
    let shifts = DataStore.shifts.filter(s => s.employeeId === employeeId);
    if (startDate && endDate) {
        shifts = shifts.filter(s => s.date >= startDate && s.date <= endDate);
    }
    return shifts;
}

function getShiftsByTeam(teamId, startDate = null, endDate = null) {
    let shifts = DataStore.shifts.filter(s => s.team === teamId);
    if (startDate && endDate) {
        shifts = shifts.filter(s => s.date >= startDate && s.date <= endDate);
    }
    return shifts;
}

// ===== WEEKROOSTER FUNCTIES =====

function getWeekNumber(date) {
    // Bepaal of een datum Week 1 of Week 2 is op basis van de referentie datum (bi-weekly patroon)
    const referenceDate = new Date(DataStore.settings.biWeeklyReferenceDate);
    referenceDate.setHours(0, 0, 0, 0);
    const currentDate = new Date(date);
    currentDate.setHours(0, 0, 0, 0);

    // Zet beide datums op maandag van hun week
    const refMonday = getMonday(referenceDate);
    refMonday.setHours(0, 0, 0, 0);
    const currMonday = getMonday(currentDate);
    currMonday.setHours(0, 0, 0, 0);

    // Bereken aantal weken verschil
    const diffTime = currMonday.getTime() - refMonday.getTime();
    const diffWeeks = Math.round(diffTime / (1000 * 60 * 60 * 24 * 7));

    // Week 1 = even aantal weken verschil, Week 2 = oneven
    return (diffWeeks % 2 === 0) ? 1 : 2;
}

function getISOWeekNumber(date) {
    // Geeft het echte ISO weeknummer terug (1-53)
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    // Donderdag van dezelfde week bepaalt het weeknummer
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    // Week 1 is de week met 4 januari
    const week1 = new Date(d.getFullYear(), 0, 4);
    // Bereken weeknummer
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

function applyWeekScheduleForEmployee(employeeId, startDate, endDate) {
    const employee = getEmployee(employeeId);
    if (!employee) {
        return [];
    }

    // Check of er überhaupt roosters zijn ingesteld
    const hasWeek1 = employee.weekScheduleWeek1 && employee.weekScheduleWeek1.length > 0;
    const hasWeek2 = employee.weekScheduleWeek2 && employee.weekScheduleWeek2.length > 0;

    if (!hasWeek1 && !hasWeek2) {
        return [];
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const createdShifts = [];

    // Loop door alle dagen in de periode
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay(); // 0 = zondag, 1 = maandag, etc.
        const dateStr = formatDateYYYYMMDD(d);

        // Check of er al een dienst is op deze dag
        const existingShifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
        if (existingShifts.length > 0) {
            continue; // Skip als er al een dienst is
        }

        // Check of medewerker afwezig is
        const absence = getAvailability(employeeId, dateStr);
        if (absence && absence.type) {
            continue; // Skip als medewerker afwezig is
        }

        // Bepaal welke week het is
        const weekNumber = getWeekNumber(dateStr);
        const weekSchedule = weekNumber === 1 ? employee.weekScheduleWeek1 : employee.weekScheduleWeek2;

        // Zoek vast rooster voor deze dag
        const scheduleForDay = weekSchedule.find(s => s.dayOfWeek === dayOfWeek);
        if (scheduleForDay && scheduleForDay.enabled) {
            // Maak dienst aan
            const shift = {
                id: Date.now() + Math.random(),
                employeeId: employeeId,
                team: scheduleForDay.team,
                date: dateStr,
                startTime: scheduleForDay.startTime,
                endTime: scheduleForDay.endTime,
                notes: `Automatisch ingepland via weekrooster (Week ${weekNumber})`,
                createdAt: new Date().toISOString()
            };

            DataStore.shifts.push(shift);
            createdShifts.push(shift);
        }
    }

    if (createdShifts.length > 0) {
        saveToStorage();
    }

    return createdShifts;
}

function applyWeekScheduleForAllEmployees(startDate, endDate) {
    const employees = getAllEmployees(true);
    let totalShifts = 0;

    employees.forEach(emp => {
        const shifts = applyWeekScheduleForEmployee(emp.id, startDate, endDate);
        totalShifts += shifts.length;
    });

    return totalShifts;
}

// ===== AFWEZIGHEID FUNCTIES =====
// Geen data = beschikbaar (standaard)
// Alleen opslaan als iemand NIET beschikbaar is

function getAvailability(employeeId, date) {
    // Zoek op employeeId en date apart (robuuster dan key matching)
    return DataStore.availability.find(a =>
        String(a.employeeId) === String(employeeId) && a.date === date
    );
}

function setAvailability(employeeId, date, absenceData) {
    const key = `${employeeId}_${date}`;

    // Als geen type opgegeven, verwijder de afwezigheid
    if (!absenceData.type) {
        return removeAvailability(employeeId, date);
    }

    const index = DataStore.availability.findIndex(a => a.key === key);

    const absence = {
        key: key,
        employeeId: employeeId,
        date: date,
        type: absenceData.type, // verlof, ziek, overuren, vorming, andere
        reason: absenceData.reason || '',
        updatedAt: new Date().toISOString()
    };

    if (index !== -1) {
        DataStore.availability[index] = absence;
    } else {
        DataStore.availability.push(absence);
    }

    saveToStorage();
    return absence;
}

function removeAvailability(employeeId, date) {
    const key = `${employeeId}_${date}`;
    const index = DataStore.availability.findIndex(a => a.key === key);
    if (index !== -1) {
        DataStore.availability.splice(index, 1);
        saveToStorage();
        return true;
    }
    return false;
}

function getAvailabilityForWeek(employeeId, weekStartDate) {
    const weekDates = getWeekDates(weekStartDate);
    return weekDates.map(date => ({
        date: date,
        availability: getAvailability(employeeId, date)
    }));
}

// ===== UREN BEREKENING =====

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

function calculateShiftHours(shift) {
    const start = parseDateTime(shift.date, shift.startTime);
    const end = getShiftEndDateTime(shift);

    const diffMs = end - start;
    const hours = diffMs / (1000 * 60 * 60);

    return hours;
}

function getEmployeeHoursInPeriod(employeeId, startDate, endDate) {
    const shifts = getShiftsByEmployee(employeeId, startDate, endDate);
    let totalHours = 0;

    shifts.forEach(shift => {
        totalHours += calculateShiftHours(shift);
    });

    return totalHours;
}

function getEmployeeHoursThisWeek(employeeId, weekStartDate) {
    const weekDates = getWeekDates(weekStartDate);
    const startDate = weekDates[0];
    const endDate = weekDates[6];

    return getEmployeeHoursInPeriod(employeeId, startDate, endDate);
}

function getEmployeeHoursThisMonth(employeeId, date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth();

    // First day of month
    const startDate = formatDateYYYYMMDD(new Date(year, month, 1));

    // Last day of month
    const endDate = formatDateYYYYMMDD(new Date(year, month + 1, 0));

    return getEmployeeHoursInPeriod(employeeId, startDate, endDate);
}

// ===== STAFFING VALIDATIE =====

function getStaffingForTimeSlot(date, startHour, endHour) {
    const shifts = getShiftsByDate(date);

    // Filter shifts that overlap with this time slot
    const relevantShifts = shifts.filter(shift => {
        const shiftStart = parseInt(shift.startTime.split(':')[0]);
        const shiftEnd = parseInt(shift.endTime.split(':')[0]);

        // Handle overnight shifts
        let adjustedShiftEnd = shiftEnd;
        if (shiftEnd < shiftStart) {
            adjustedShiftEnd = shiftEnd + 24;
        }

        // Handle time slot that spans midnight
        let adjustedSlotEnd = endHour;
        if (endHour > 24) {
            adjustedSlotEnd = endHour;
        }

        // Check if shift overlaps with time slot
        return (shiftStart < adjustedSlotEnd && adjustedShiftEnd > startHour);
    });

    // Group by team
    const byTeam = {
        vlot1: [],
        vlot2: [],
        cargo: [],
        overkoepelend: [],
        jobstudent: []
    };

    relevantShifts.forEach(shift => {
        if (byTeam[shift.team]) {
            byTeam[shift.team].push(shift);
        }
    });

    return {
        total: relevantShifts.length,
        byTeam: byTeam,
        shifts: relevantShifts
    };
}

function checkStaffingWarnings(date, timeSlot) {
    const warnings = [];
    const staffing = getStaffingForTimeSlot(date, timeSlot.start, timeSlot.end);

    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // Check if location is closed
    if (!isWeekendOpen(date) && isWeekend) {
        return warnings; // Don't warn for closed days
    }

    // Morning rush (07:00-13:00): minimum 2 across Vlot 1 + Vlot 2
    // Note: overkoepelend en jobstudent tellen niet mee (geen directe begeleiding)
    if (timeSlot.start === 7 || timeSlot.start === 10) {
        const vlotStaff = staffing.byTeam.vlot1.length + staffing.byTeam.vlot2.length;
        if (vlotStaff < 2) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Ochtend: ${vlotStaff}/2 begeleiders (Vlot 1 + Vlot 2)`
            });
        }
    }

    // Evening (16:00-22:00): minimum 2 per Vlot
    // Note: overkoepelend en jobstudent tellen niet mee (geen directe begeleiding)
    if (timeSlot.start === 16 || timeSlot.start === 19) {
        if (staffing.byTeam.vlot1.length < 2) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 1 avond: ${staffing.byTeam.vlot1.length}/2 begeleiders`
            });
        }
        if (staffing.byTeam.vlot2.length < 2) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 2 avond: ${staffing.byTeam.vlot2.length}/2 begeleiders`
            });
        }
    }

    // Night (22:00-07:00): exactly 1 per Vlot
    // Note: overkoepelend en jobstudent tellen niet mee (geen directe begeleiding)
    if (timeSlot.start === 22) {
        if (staffing.byTeam.vlot1.length > 1) {
            warnings.push({
                type: 'overstaffed',
                severity: 'warning',
                message: `Vlot 1 nacht: ${staffing.byTeam.vlot1.length}/1 begeleider (te veel)`
            });
        }
        if (staffing.byTeam.vlot2.length > 1) {
            warnings.push({
                type: 'overstaffed',
                severity: 'warning',
                message: `Vlot 2 nacht: ${staffing.byTeam.vlot2.length}/1 begeleider (te veel)`
            });
        }

        // Check minimum
        if (staffing.byTeam.vlot1.length === 0) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 1 nacht: geen nachtdienst ingepland`
            });
        }
        if (staffing.byTeam.vlot2.length === 0) {
            warnings.push({
                type: 'understaffed',
                severity: 'error',
                message: `Vlot 2 nacht: geen nachtdienst ingepland`
            });
        }
    }

    return warnings;
}

// ===== HELPER FUNCTIES =====

function isWeekendOpen(date) {
    const d = new Date(date);
    const dayOfWeek = d.getDay();

    // Tuesday-Thursday - not part of weekend, always open
    if (dayOfWeek >= 2 && dayOfWeek <= 4) {
        return true;
    }

    // Determine which week the date falls in
    // For Friday/Monday, we need to check the Saturday of that weekend
    let checkDate = date;
    if (dayOfWeek === 5) {
        // Friday - check tomorrow (Saturday) to determine week
        const saturday = new Date(d);
        saturday.setDate(d.getDate() + 1);
        checkDate = formatDateYYYYMMDD(saturday);
    } else if (dayOfWeek === 1) {
        // Monday - check previous Saturday to determine week
        const saturday = new Date(d);
        saturday.setDate(d.getDate() - 2);
        checkDate = formatDateYYYYMMDD(saturday);
    }

    // Week 1 = weekend GESLOTEN, Week 2 = weekend OPEN
    const weekNumber = getWeekNumber(checkDate);
    return weekNumber === 2; // Open if Week 2, closed if Week 1
}

// ===== VAKANTIE FUNCTIES =====

function isHolidayPeriod(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const checkDate = new Date(dateStr);

    return DataStore.settings.holidayPeriods.some(period => {
        const start = new Date(period.startDate);
        const end = new Date(period.endDate);
        return checkDate >= start && checkDate <= end;
    });
}

function getHolidayPeriod(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const checkDate = new Date(dateStr);

    return DataStore.settings.holidayPeriods.find(period => {
        const start = new Date(period.startDate);
        const end = new Date(period.endDate);
        return checkDate >= start && checkDate <= end;
    });
}

function addHolidayPeriod(name, startDate, endDate) {
    const period = {
        id: Date.now(),
        name: name,
        startDate: startDate,
        endDate: endDate
    };
    DataStore.settings.holidayPeriods.push(period);
    saveToStorage();
    return period;
}

function removeHolidayPeriod(id) {
    const index = DataStore.settings.holidayPeriods.findIndex(p => p.id === id);
    if (index !== -1) {
        DataStore.settings.holidayPeriods.splice(index, 1);
        saveToStorage();
        return true;
    }
    return false;
}

function updateHolidayRules(rules) {
    DataStore.settings.holidayRules = { ...DataStore.settings.holidayRules, ...rules };
    saveToStorage();
}

// ===== WEEKEND/VAKANTIE VERANTWOORDELIJKE =====

function getEligibleEmployeesForResponsible() {
    // Haal medewerkers op die in aanmerking komen (vlot1, vlot2, cargo)
    const eligibleTeams = DataStore.settings.responsibleRotation?.eligibleTeams || ['vlot1', 'vlot2', 'cargo'];
    return DataStore.employees.filter(emp =>
        emp.active && eligibleTeams.includes(emp.mainTeam)
    ).sort((a, b) => a.name.localeCompare(b.name));
}

function getMondayOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function getWeekendResponsible(weekStartDate) {
    // weekStartDate = maandag van de week waarvoor iemand verantwoordelijk is
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    const assignments = DataStore.settings.responsibleRotation?.assignments || {};

    if (assignments[dateKey]) {
        return getEmployee(assignments[dateKey]);
    }
    return null;
}

function getOrCalculateResponsible(weekStartDate) {
    // Eerst kijken of er een handmatige toewijzing is
    const manual = getWeekendResponsible(weekStartDate);
    if (manual) return manual;

    // Anders automatisch berekenen op basis van rotatie
    const rotation = DataStore.settings.responsibleRotation;
    if (!rotation?.rotationStart || !rotation?.rotationStartEmployee) {
        return null; // Geen rotatie ingesteld
    }

    const eligible = getEligibleEmployeesForResponsible();
    if (eligible.length === 0) return null;

    // Vind de startpersoon in de lijst (compare as strings to avoid precision issues)
    const startEmployeeId = String(rotation.rotationStartEmployee);
    const startIndex = eligible.findIndex(e => String(e.id) === startEmployeeId);
    if (startIndex === -1) return eligible[0];

    // Tel hoeveel OPEN weekenden/vakanties er zijn tussen start en deze week
    const startDate = new Date(rotation.rotationStart);
    startDate.setHours(0, 0, 0, 0);
    const targetDate = new Date(weekStartDate);
    targetDate.setHours(0, 0, 0, 0);

    // Voor de startdatum: geen verantwoordelijke
    if (targetDate < startDate) return null;

    // Tel hoeveel open weekenden er VOOR deze week zijn geweest (niet inclusief deze week)
    let count = 0;
    const current = new Date(startDate);

    while (current.getTime() < targetDate.getTime()) {
        if (isWeekendOrHolidayWeek(current)) {
            count++;
        }
        current.setDate(current.getDate() + 7);
    }

    // Bereken wie er aan de beurt is
    const currentIndex = (startIndex + count) % eligible.length;
    return eligible[currentIndex];
}

function setRotationStart(startDate, employeeId) {
    // Stel de rotatie start in - vanaf deze datum met deze persoon
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = {
            eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
            assignments: {}
        };
    }
    DataStore.settings.responsibleRotation.rotationStart = formatDateYYYYMMDD(startDate);
    // Store as string to prevent JSON precision issues
    DataStore.settings.responsibleRotation.rotationStartEmployee = String(employeeId);
    saveToStorage();
}

function setWeekendResponsible(weekStartDate, employeeId) {
    // Handmatige override voor een specifieke week
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = {
            eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
            assignments: {}
        };
    }
    DataStore.settings.responsibleRotation.assignments[dateKey] = employeeId;
    saveToStorage();
}

function removeWeekendResponsible(weekStartDate) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    if (DataStore.settings.responsibleRotation?.assignments) {
        delete DataStore.settings.responsibleRotation.assignments[dateKey];
        saveToStorage();
    }
}

function isWeekendOrHolidayWeek(weekStartDate) {
    // Gebruikt bi-weekly logica: Week 2 = open weekend
    const monday = new Date(weekStartDate);
    monday.setHours(0, 0, 0, 0);

    // Check bi-weekly patroon: Week 2 = weekend open
    const biWeeklyNumber = getWeekNumber(monday);
    const isOpenWeekend = biWeeklyNumber === 2;

    // Check ook vakantie (elke dag van de week)
    let hasHoliday = false;
    for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        if (isHolidayPeriod(day)) {
            hasHoliday = true;
            break;
        }
    }

    return isOpenWeekend || hasHoliday;
}

function formatDateYYYYMMDD(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDate(date) {
    const d = new Date(date);
    return d.toLocaleDateString('nl-BE', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function formatTime(time) {
    return time; // Already in HH:MM format
}

function getMonday(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    d.setDate(diff);
    return d;
}

function getWeekDates(date) {
    const monday = getMonday(date);

    const dates = [];
    for (let i = 0; i < 7; i++) {
        const weekDate = new Date(monday);
        weekDate.setDate(monday.getDate() + i);
        dates.push(formatDateYYYYMMDD(weekDate));
    }
    return dates;
}

// ===== DEMO DATA =====

function generateDemoData() {
    // Echte medewerkers van Het Vlot
    const demoEmployees = [
        // Vlot 1 team (residential unit 1)
        { name: 'Quinten', email: 'quinten@hetvlot.be', mainTeam: 'vlot1', extraTeams: [], contractHours: 32, active: true },
        { name: 'Elias', email: 'elias@hetvlot.be', mainTeam: 'vlot1', extraTeams: [], contractHours: 40, active: true },
        { name: 'Victor Bey', email: 'victor.bey@hetvlot.be', mainTeam: 'vlot1', extraTeams: [], contractHours: 40, active: true },
        { name: 'Chloé', email: 'chloe@hetvlot.be', mainTeam: 'vlot1', extraTeams: [], contractHours: 40, active: true },

        // Vlot 2 team (residential unit 2)
        { name: 'Victor G', email: 'victor.g@hetvlot.be', mainTeam: 'vlot2', extraTeams: [], contractHours: 40, active: true },
        { name: 'Chelsea', email: 'chelsea@hetvlot.be', mainTeam: 'vlot2', extraTeams: [], contractHours: 40, active: true },
        { name: 'Sam', email: 'sam@hetvlot.be', mainTeam: 'vlot2', extraTeams: [], contractHours: 40, active: true },
        { name: 'Thomas', email: 'thomas@hetvlot.be', mainTeam: 'vlot2', extraTeams: [], contractHours: 40, active: true },

        // Cargo team (day program / dagbesteding)
        { name: 'Stéfanie', email: 'stefanie@hetvlot.be', mainTeam: 'cargo', extraTeams: [], contractHours: 40, active: true },
        { name: 'Marie', email: 'marie@hetvlot.be', mainTeam: 'cargo', extraTeams: [], contractHours: 40, active: true },
        { name: 'Camille', email: 'camille@hetvlot.be', mainTeam: 'cargo', extraTeams: [], contractHours: 40, active: true },

        // Leadership/Management (overkoepelend) - alleen kantoorwerk, geen begeleiding
        { name: 'Axel', email: 'axel@hetvlot.be', mainTeam: 'overkoepelend', extraTeams: [], contractHours: 40, active: true },
        { name: 'Karen', email: 'karen@hetvlot.be', mainTeam: 'overkoepelend', extraTeams: [], contractHours: 40, active: true },

        // Jobstudenten/Stagiairs
        { name: 'Yana', email: 'yana@hetvlot.be', mainTeam: 'jobstudent', extraTeams: ['vlot1', 'vlot2', 'cargo'], contractHours: 20, active: true }
    ];

    demoEmployees.forEach(emp => addEmployee(emp));

    // Demo diensten voor deze week
    const today = new Date();
    const weekDates = getWeekDates(today);
    const employees = getAllEmployees(true);
    const teams = ['vlot1', 'vlot2', 'cargo'];

    weekDates.forEach((date, dayIndex) => {
        // Skip als weekend gesloten is
        const d = new Date(date);
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        if (isWeekend && !isWeekendOpen(date)) {
            return;
        }

        teams.forEach(team => {
            const teamEmployees = getEmployeesByTeam(team);
            if (teamEmployees.length === 0) return;

            // Vroege dienst
            const vroegEmployee = teamEmployees[Math.floor(Math.random() * teamEmployees.length)];
            addShift({
                employeeId: vroegEmployee.id,
                team: team,
                date: date,
                startTime: '07:30',
                endTime: '16:00',
                notes: ''
            });

            // Late dienst
            const laatEmployee = teamEmployees[Math.floor(Math.random() * teamEmployees.length)];
            addShift({
                employeeId: laatEmployee.id,
                team: team,
                date: date,
                startTime: '16:00',
                endTime: '23:00',
                notes: ''
            });
        });

        // Nachtdienst (overkoepelend - 1 persoon voor alle teams)
        const nachtEmployee = employees[Math.floor(Math.random() * employees.length)];
        addShift({
            employeeId: nachtEmployee.id,
            team: 'overkoepelend',
            date: date,
            startTime: '23:00',
            endTime: '09:00',
            notes: 'Nachtdienst voor alle teams'
        });
    });

    console.log('Demo data aangemaakt!');
}

// ===== INITIALISATIE =====

function initializeData() {
    const loaded = loadFromStorage();

    // Als er geen data is, maak demo data aan
    if (!loaded || DataStore.employees.length === 0) {
        console.log('Geen data gevonden, demo data wordt aangemaakt...');
        generateDemoData();
    } else {
        console.log('Data geladen:', {
            employees: DataStore.employees.length,
            shifts: DataStore.shifts.length
        });
    }
}

// Start direct
initializeData();
