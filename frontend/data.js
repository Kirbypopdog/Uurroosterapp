// ===== DATA MANAGEMENT SYSTEEM =====
// Dit bestand beheert alle data voor Het Vlot roosterplanning
// Alle data wordt opgeslagen in de PostgreSQL database via de API

const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {};

function parseDateOnly(value) {
    if (value instanceof Date) {
        return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === 'string') {
        const parts = value.split('-').map(Number);
        if (parts.length === 3 && parts.every(part => Number.isFinite(part))) {
            return new Date(parts[0], parts[1] - 1, parts[2]);
        }
    }
    return new Date(value);
}

function cloneSettings(settings) {
    if (typeof structuredClone === 'function') {
        return structuredClone(settings);
    }
    return JSON.parse(JSON.stringify(settings));
}

function normalizeSettings(settings) {
    const defaults = cloneSettings(DEFAULT_SETTINGS);
    const merged = { ...defaults, ...(settings || {}) };

    if (!merged.teams || typeof merged.teams !== 'object') {
        merged.teams = defaults.teams || {};
    } else if (defaults.teams) {
        merged.teams = { ...defaults.teams, ...merged.teams };
    }
    if (!merged.shiftTemplates || typeof merged.shiftTemplates !== 'object' || Object.keys(merged.shiftTemplates).length === 0) {
        merged.shiftTemplates = defaults.shiftTemplates || {};
    } else if (defaults.shiftTemplates) {
        merged.shiftTemplates = { ...defaults.shiftTemplates, ...merged.shiftTemplates };
    }
    if (!merged.rules || typeof merged.rules !== 'object') {
        merged.rules = defaults.rules || {};
    } else if (defaults.rules) {
        merged.rules = { ...defaults.rules, ...merged.rules };
    }
    if (!Array.isArray(merged.holidayPeriods)) {
        merged.holidayPeriods = defaults.holidayPeriods || [];
    }
    if (!merged.holidayRules || typeof merged.holidayRules !== 'object') {
        merged.holidayRules = defaults.holidayRules || {};
    } else if (defaults.holidayRules) {
        merged.holidayRules = { ...defaults.holidayRules, ...merged.holidayRules };
    }
    if (!merged.responsibleRotation || typeof merged.responsibleRotation !== 'object') {
        merged.responsibleRotation = defaults.responsibleRotation || {};
    } else if (defaults.responsibleRotation) {
        merged.responsibleRotation = { ...defaults.responsibleRotation, ...merged.responsibleRotation };
        merged.responsibleRotation.assignments = {
            ...(defaults.responsibleRotation.assignments || {}),
            ...(merged.responsibleRotation.assignments || {})
        };
    }

    return merged;
}

// Globale data store (in-memory cache van database data)
const DataStore = {
    employees: [],
    shifts: [],
    availability: [],
    swapRequests: [],
    settings: normalizeSettings(DEFAULT_SETTINGS),
    _loaded: false
};

// ===== API HELPER =====

async function dataApiFetch(path, options = {}) {
    const token = sessionStorage.getItem('hetvlot_token');
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    const response = await fetch(`${window.API_BASE}${path}`, {
        ...options,
        headers: { ...headers, ...(options.headers || {}) }
    });

    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${response.status}`);
    }

    return response.json();
}

// ===== LOAD DATA FROM API =====

async function loadDataFromAPI() {
    try {
        // Load all data in parallel
        const [employeesData, shiftsData, availabilityData, settingsData] = await Promise.all([
            dataApiFetch('/employees').catch(() => ({ employees: [] })),
            dataApiFetch('/shifts').catch(() => ({ shifts: [] })),
            dataApiFetch('/availability').catch(() => ({ availability: [] })),
            dataApiFetch('/settings').catch(() => ({ settings: {} }))
        ]);

        DataStore.employees = employeesData.employees || [];
        DataStore.shifts = (shiftsData.shifts || []).map(s => ({
            ...s,
            date: typeof s.date === 'string' ? s.date.split('T')[0] : s.date
        }));
        DataStore.availability = (availabilityData.availability || []).map(a => ({
            ...a,
            date: typeof a.date === 'string' ? a.date.split('T')[0] : a.date,
            key: `${a.employeeId}_${typeof a.date === 'string' ? a.date.split('T')[0] : a.date}`
        }));

        // Merge API settings with defaults
        const apiSettings = settingsData.settings || {};
        DataStore.settings = normalizeSettings({
            ...DataStore.settings,
            ...apiSettings.general,
            rules: apiSettings.rules || DataStore.settings.rules,
            holidayPeriods: apiSettings.holidayPeriods || DataStore.settings.holidayPeriods,
            holidayRules: apiSettings.holidayRules || DataStore.settings.holidayRules,
            responsibleRotation: apiSettings.responsibleRotation || DataStore.settings.responsibleRotation
        });

        DataStore._loaded = true;
        console.log('Data geladen van API:', {
            employees: DataStore.employees.length,
            shifts: DataStore.shifts.length,
            availability: DataStore.availability.length
        });

        return true;
    } catch (error) {
        console.error('Fout bij laden van API:', error);
        return false;
    }
}

// ===== MEDEWERKERS FUNCTIES =====

async function addEmployee(employeeData) {
    try {
        const data = await dataApiFetch('/employees', {
            method: 'POST',
            body: JSON.stringify(employeeData)
        });
        const employee = data.employee;
        DataStore.employees.push(employee);
        return employee;
    } catch (error) {
        console.error('Fout bij toevoegen medewerker:', error);
        throw error;
    }
}

async function updateEmployee(id, updates) {
    try {
        const index = DataStore.employees.findIndex(e => e.id === id);
        if (index === -1) return null;

        const currentEmployee = DataStore.employees[index];
        const updatedData = { ...currentEmployee, ...updates };

        const data = await dataApiFetch(`/employees/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updatedData)
        });

        DataStore.employees[index] = data.employee;
        return data.employee;
    } catch (error) {
        console.error('Fout bij bijwerken medewerker:', error);
        throw error;
    }
}

async function deleteEmployee(id) {
    try {
        await dataApiFetch(`/employees/${id}`, { method: 'DELETE' });

        const index = DataStore.employees.findIndex(e => e.id === id);
        if (index !== -1) {
            DataStore.employees.splice(index, 1);
        }
        // Remove related shifts and availability from cache
        DataStore.shifts = DataStore.shifts.filter(shift => shift.employeeId !== id);
        DataStore.availability = DataStore.availability.filter(entry => entry.employeeId !== id);

        return true;
    } catch (error) {
        console.error('Fout bij verwijderen medewerker:', error);
        throw error;
    }
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
        if (includeExtra && e.extraTeams && e.extraTeams.includes(teamId)) return true;
        return false;
    });
}

// ===== DIENSTEN FUNCTIES =====

async function addShift(shiftData) {
    try {
        const data = await dataApiFetch('/shifts', {
            method: 'POST',
            body: JSON.stringify(shiftData)
        });
        const shift = {
            ...data.shift,
            date: typeof data.shift.date === 'string' ? data.shift.date.split('T')[0] : data.shift.date
        };
        DataStore.shifts.push(shift);
        return shift;
    } catch (error) {
        console.error('Fout bij toevoegen dienst:', error);
        throw error;
    }
}

async function updateShift(id, updates) {
    try {
        const data = await dataApiFetch(`/shifts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });

        const shift = {
            ...data.shift,
            date: typeof data.shift.date === 'string' ? data.shift.date.split('T')[0] : data.shift.date
        };

        const index = DataStore.shifts.findIndex(s => s.id === id);
        if (index !== -1) {
            DataStore.shifts[index] = shift;
        }
        return shift;
    } catch (error) {
        console.error('Fout bij bijwerken dienst:', error);
        throw error;
    }
}

async function deleteShift(id) {
    try {
        await dataApiFetch(`/shifts/${id}`, { method: 'DELETE' });

        const index = DataStore.shifts.findIndex(s => s.id === id);
        if (index !== -1) {
            DataStore.shifts.splice(index, 1);
        }
        return true;
    } catch (error) {
        console.error('Fout bij verwijderen dienst:', error);
        throw error;
    }
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

async function removeShiftsInDateRange(startDate, endDate) {
    try {
        const data = await dataApiFetch(`/shifts?startDate=${startDate}&endDate=${endDate}`, {
            method: 'DELETE'
        });

        // Update local cache
        DataStore.shifts = DataStore.shifts.filter(shift => shift.date < startDate || shift.date > endDate);

        return data.deleted || 0;
    } catch (error) {
        console.error('Fout bij verwijderen diensten:', error);
        throw error;
    }
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
    const referenceDate = parseDateOnly(DataStore.settings.biWeeklyReferenceDate);
    referenceDate.setHours(0, 0, 0, 0);
    const currentDate = parseDateOnly(date);
    currentDate.setHours(0, 0, 0, 0);

    const refMonday = getMonday(referenceDate);
    refMonday.setHours(0, 0, 0, 0);
    const currMonday = getMonday(currentDate);
    currMonday.setHours(0, 0, 0, 0);

    const diffTime = currMonday.getTime() - refMonday.getTime();
    const diffWeeks = Math.round(diffTime / (1000 * 60 * 60 * 24 * 7));

    return (diffWeeks % 2 === 0) ? 1 : 2;
}

function getISOWeekNumber(date) {
    const d = parseDateOnly(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

async function applyWeekScheduleForEmployee(employeeId, startDate, endDate) {
    const employee = getEmployee(employeeId);
    if (!employee) {
        return [];
    }

    const hasWeek1 = employee.weekScheduleWeek1 && employee.weekScheduleWeek1.length > 0;
    const hasWeek2 = employee.weekScheduleWeek2 && employee.weekScheduleWeek2.length > 0;

    if (!hasWeek1 && !hasWeek2) {
        return [];
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const createdShifts = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        const dateStr = formatDateYYYYMMDD(d);

        const existingShifts = getShiftsByEmployee(employeeId, dateStr, dateStr);
        if (existingShifts.length > 0) {
            continue;
        }

        const absence = getAvailability(employeeId, dateStr);
        if (absence && absence.type) {
            continue;
        }

        const weekNumber = getWeekNumber(dateStr);
        const weekSchedule = weekNumber === 1 ? employee.weekScheduleWeek1 : employee.weekScheduleWeek2;

        const scheduleForDay = weekSchedule.find(s => s.dayOfWeek === dayOfWeek);
        if (scheduleForDay && scheduleForDay.enabled) {
            try {
                const shift = await addShift({
                    employeeId: employeeId,
                    team: scheduleForDay.team || employee.mainTeam,
                    date: dateStr,
                    startTime: scheduleForDay.startTime,
                    endTime: scheduleForDay.endTime,
                    notes: `Automatisch ingepland via weekrooster (Week ${weekNumber})`
                });
                createdShifts.push(shift);
            } catch (error) {
                console.error('Fout bij aanmaken shift:', error);
            }
        }
    }

    return createdShifts;
}

async function applyWeekScheduleForAllEmployees(startDate, endDate) {
    const employees = getAllEmployees(true);
    let totalShifts = 0;

    for (const emp of employees) {
        const shifts = await applyWeekScheduleForEmployee(emp.id, startDate, endDate);
        totalShifts += shifts.length;
    }

    return totalShifts;
}

// ===== AFWEZIGHEID FUNCTIES =====

function getAvailability(employeeId, date) {
    return DataStore.availability.find(a =>
        String(a.employeeId) === String(employeeId) && a.date === date
    );
}

async function setAvailability(employeeId, date, absenceData) {
    if (!absenceData.type) {
        return removeAvailability(employeeId, date);
    }

    try {
        const data = await dataApiFetch('/availability', {
            method: 'POST',
            body: JSON.stringify({
                employeeId,
                date,
                type: absenceData.type,
                reason: absenceData.reason || ''
            })
        });

        const absence = {
            ...data.availability,
            date: typeof data.availability.date === 'string' ? data.availability.date.split('T')[0] : data.availability.date,
            key: `${employeeId}_${date}`
        };

        // Update cache
        const index = DataStore.availability.findIndex(a => a.key === absence.key);
        if (index !== -1) {
            DataStore.availability[index] = absence;
        } else {
            DataStore.availability.push(absence);
        }

        return absence;
    } catch (error) {
        console.error('Fout bij instellen afwezigheid:', error);
        throw error;
    }
}

async function removeAvailability(employeeId, date) {
    try {
        await dataApiFetch(`/availability?employeeId=${employeeId}&date=${date}`, {
            method: 'DELETE'
        });

        const key = `${employeeId}_${date}`;
        const index = DataStore.availability.findIndex(a => a.key === key);
        if (index !== -1) {
            DataStore.availability.splice(index, 1);
        }
        return true;
    } catch (error) {
        console.error('Fout bij verwijderen afwezigheid:', error);
        throw error;
    }
}

function getAvailabilityForWeek(employeeId, weekStartDate) {
    const weekDates = getWeekDates(weekStartDate);
    return weekDates.map(date => ({
        date: date,
        availability: getAvailability(employeeId, date)
    }));
}

// ===== SETTINGS FUNCTIES =====

async function saveSettings(key, value) {
    try {
        await dataApiFetch(`/settings/${key}`, {
            method: 'PUT',
            body: JSON.stringify({ value })
        });
        return true;
    } catch (error) {
        console.error('Fout bij opslaan settings:', error);
        throw error;
    }
}

async function saveRulesSettings() {
    await saveSettings('rules', DataStore.settings.rules);
}

async function saveHolidaySettings() {
    await saveSettings('holidayPeriods', DataStore.settings.holidayPeriods);
    await saveSettings('holidayRules', DataStore.settings.holidayRules);
}

async function saveResponsibleRotationSettings() {
    await saveSettings('responsibleRotation', DataStore.settings.responsibleRotation);
}

// ===== UREN BEREKENING =====

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

    if (endHours < startHours) {
        endDT.setDate(endDT.getDate() + 1);
    }

    return endDT;
}

function calculateShiftHours(shift) {
    const start = parseDateTime(shift.date, shift.startTime);
    const end = getShiftEndDateTime(shift);

    const diffMs = end - start;
    let hours = diffMs / (1000 * 60 * 60);

    const sleepStart = parseDateTime(shift.date, '23:00');
    const sleepEnd = parseDateTime(shift.date, '07:00');
    sleepEnd.setDate(sleepEnd.getDate() + 1);

    const overlapStart = Math.max(start.getTime(), sleepStart.getTime());
    const overlapEnd = Math.min(end.getTime(), sleepEnd.getTime());

    if (overlapEnd > overlapStart) {
        const sleepMs = overlapEnd - overlapStart;
        hours -= sleepMs / (1000 * 60 * 60);
    }

    return Math.max(0, hours);
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

    const startDate = formatDateYYYYMMDD(new Date(year, month, 1));
    const endDate = formatDateYYYYMMDD(new Date(year, month + 1, 0));

    return getEmployeeHoursInPeriod(employeeId, startDate, endDate);
}

// ===== STAFFING VALIDATIE =====

function getStaffingForTimeSlot(date, startHour, endHour) {
    const shifts = getShiftsByDate(date);

    const relevantShifts = shifts.filter(shift => {
        const shiftStart = parseInt(shift.startTime.split(':')[0]);
        const shiftEnd = parseInt(shift.endTime.split(':')[0]);

        let adjustedShiftEnd = shiftEnd;
        if (shiftEnd < shiftStart) {
            adjustedShiftEnd = shiftEnd + 24;
        }

        let adjustedSlotEnd = endHour;
        if (endHour > 24) {
            adjustedSlotEnd = endHour;
        }

        return (shiftStart < adjustedSlotEnd && adjustedShiftEnd > startHour);
    });

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

    if (!isWeekendOpen(date) && isWeekend) {
        return warnings;
    }

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
    const d = parseDateOnly(date);
    const dayOfWeek = d.getDay();

    if (dayOfWeek >= 2 && dayOfWeek <= 4) {
        return true;
    }

    let checkDate = date;
    if (dayOfWeek === 5) {
        const saturday = new Date(d);
        saturday.setDate(d.getDate() + 1);
        checkDate = formatDateYYYYMMDD(saturday);
    } else if (dayOfWeek === 1) {
        const saturday = new Date(d);
        saturday.setDate(d.getDate() - 2);
        checkDate = formatDateYYYYMMDD(saturday);
    }

    const weekNumber = getWeekNumber(checkDate);
    return weekNumber === 2;
}

// ===== VAKANTIE FUNCTIES =====

function isHolidayPeriod(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const checkDate = parseDateOnly(dateStr);

    return DataStore.settings.holidayPeriods.some(period => {
        const start = parseDateOnly(period.startDate);
        const end = parseDateOnly(period.endDate);
        return checkDate >= start && checkDate <= end;
    });
}

function getHolidayPeriod(date) {
    const dateStr = typeof date === 'string' ? date : formatDateYYYYMMDD(date);
    const checkDate = parseDateOnly(dateStr);

    return DataStore.settings.holidayPeriods.find(period => {
        const start = parseDateOnly(period.startDate);
        const end = parseDateOnly(period.endDate);
        return checkDate >= start && checkDate <= end;
    });
}

async function addHolidayPeriod(name, startDate, endDate) {
    const period = {
        id: Date.now(),
        name: name,
        startDate: startDate,
        endDate: endDate
    };
    DataStore.settings.holidayPeriods.push(period);
    await saveHolidaySettings();
    return period;
}

async function removeHolidayPeriod(id) {
    const index = DataStore.settings.holidayPeriods.findIndex(p => p.id === id);
    if (index !== -1) {
        DataStore.settings.holidayPeriods.splice(index, 1);
        await saveHolidaySettings();
        return true;
    }
    return false;
}

async function updateHolidayRules(rules) {
    DataStore.settings.holidayRules = { ...DataStore.settings.holidayRules, ...rules };
    await saveHolidaySettings();
}

// ===== WEEKEND/VAKANTIE VERANTWOORDELIJKE =====

function getEligibleEmployeesForResponsible() {
    const eligibleTeams = DataStore.settings.responsibleRotation?.eligibleTeams || ['vlot1', 'vlot2', 'cargo'];
    return DataStore.employees.filter(emp =>
        emp.active && eligibleTeams.includes(emp.mainTeam)
    ).sort((a, b) => a.name.localeCompare(b.name));
}

function getMondayOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function getWeekendResponsible(weekStartDate) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    const assignments = DataStore.settings.responsibleRotation?.assignments || {};

    if (assignments[dateKey]) {
        return getEmployee(assignments[dateKey]);
    }
    return null;
}

function getOrCalculateResponsible(weekStartDate) {
    const manual = getWeekendResponsible(weekStartDate);
    if (manual) return manual;

    const rotation = DataStore.settings.responsibleRotation;
    if (!rotation?.rotationStart || !rotation?.rotationStartEmployee) {
        return null;
    }

    const eligible = getEligibleEmployeesForResponsible();
    if (eligible.length === 0) return null;

    const startEmployeeId = String(rotation.rotationStartEmployee);
    const startIndex = eligible.findIndex(e => String(e.id) === startEmployeeId);
    if (startIndex === -1) return eligible[0];

    const startDate = new Date(rotation.rotationStart);
    startDate.setHours(0, 0, 0, 0);
    const targetDate = new Date(weekStartDate);
    targetDate.setHours(0, 0, 0, 0);

    if (targetDate < startDate) return null;

    let count = 0;
    const current = new Date(startDate);

    while (current.getTime() < targetDate.getTime()) {
        if (isWeekendOrHolidayWeek(current)) {
            count++;
        }
        current.setDate(current.getDate() + 7);
    }

    const currentIndex = (startIndex + count) % eligible.length;
    return eligible[currentIndex];
}

async function setRotationStart(startDate, employeeId) {
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = {
            eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
            assignments: {}
        };
    }
    DataStore.settings.responsibleRotation.rotationStart = formatDateYYYYMMDD(startDate);
    DataStore.settings.responsibleRotation.rotationStartEmployee = String(employeeId);
    await saveResponsibleRotationSettings();
}

async function setWeekendResponsible(weekStartDate, employeeId) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    if (!DataStore.settings.responsibleRotation) {
        DataStore.settings.responsibleRotation = {
            eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
            assignments: {}
        };
    }
    DataStore.settings.responsibleRotation.assignments[dateKey] = employeeId;
    await saveResponsibleRotationSettings();
}

async function removeWeekendResponsible(weekStartDate) {
    const dateKey = formatDateYYYYMMDD(weekStartDate);
    if (DataStore.settings.responsibleRotation?.assignments) {
        delete DataStore.settings.responsibleRotation.assignments[dateKey];
        await saveResponsibleRotationSettings();
    }
}

function isWeekendOrHolidayWeek(weekStartDate) {
    const monday = parseDateOnly(weekStartDate);
    monday.setHours(0, 0, 0, 0);

    const biWeeklyNumber = getWeekNumber(monday);
    const isOpenWeekend = biWeeklyNumber === 2;

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
    const d = parseDateOnly(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatDate(date) {
    const d = parseDateOnly(date);
    return d.toLocaleDateString('nl-BE', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function formatTime(time) {
    return time;
}

function getMonday(date) {
    const d = parseDateOnly(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
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

// ===== LEGACY COMPATIBILITY =====
// These functions are kept for compatibility but do nothing with localStorage

function saveToStorage() {
    // No-op - data is saved via API
    return true;
}

function loadFromStorage() {
    // No-op - data is loaded via API
    return true;
}

async function resetData() {
    if (!confirm('Weet je zeker dat je ALLE data wilt verwijderen?\n\nDit verwijdert alle medewerkers, diensten en afwezigheden.\nDit kan niet ongedaan worden gemaakt!')) {
        return;
    }

    if (!confirm('LAATSTE WAARSCHUWING: Alle data wordt permanent verwijderd. Doorgaan?')) {
        return;
    }

    try {
        await dataApiFetch('/reset-data', { method: 'DELETE' });
        alert('Alle data is gewist. De pagina wordt herladen.');
        location.reload();
    } catch (error) {
        alert('Fout bij wissen: ' + error.message);
    }
}

// ===== INITIALISATIE =====
// Data wordt geladen via loadDataFromAPI() na login in app.js
