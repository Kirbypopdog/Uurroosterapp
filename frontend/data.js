// ===== DATA MANAGEMENT SYSTEEM =====
// Dit bestand beheert alle data voor Het Vlot roosterplanning
// Alle data wordt opgeslagen in de PostgreSQL database via de API
//
// NOTE: Na Optie C migratie zijn employees en users samengevoegd.
// "Users" bevat nu alle gebruikers met hun rooster/schedule data.
// De term "employee" wordt nog gebruikt in de UI maar verwijst naar users.

const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {};

function parseDateOnly(value) {
    if (value instanceof Date) {
        return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === 'string') {
        // Handle ISO timestamps like "2026-03-01T23:00:00.000Z" → extract date part
        const dateOnly = value.includes('T') ? value.split('T')[0] : value;
        const parts = dateOnly.split('-').map(Number);
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

    // Schedule pattern normalisatie
    if (!merged.schedulePattern || typeof merged.schedulePattern !== 'object') {
        merged.schedulePattern = defaults.schedulePattern || {
            cycleLength: 2,
            referenceDate: merged.biWeeklyReferenceDate || '2025-01-06',
            weeks: {
                "1": { closedDays: [6, 0], label: "Weekend gesloten" },
                "2": { closedDays: [], label: "Weekend open" }
            }
        };
    }

    return merged;
}

// ===== ACTIVE SHIFT RANGE =====
// Gezet door app.js na initial load en bij week-navigatie.
// Als gezet, gebruikt refreshShifts() deze range + merge-strategie.
let _activeShiftRange = null;

function setActiveShiftRange(startDate, endDate) {
    _activeShiftRange = startDate && endDate ? { startDate, endDate } : null;
}

// ===== NORMALIZATION HELPERS =====
// Gebruikt door refresh functies en loadDataFromAPI() voor consistente data transformatie

function normalizeShift(s) {
    return {
        ...s,
        date: typeof s.date === 'string' ? s.date.split('T')[0] : s.date,
        employeeId: s.userId || s.employeeId,
        userId: s.userId || s.employeeId,
        source: s.source || 'manual'
    };
}

function normalizeAvailability(a) {
    const date = typeof a.date === 'string' ? a.date.split('T')[0] : a.date;
    return {
        ...a,
        date,
        employeeId: a.userId || a.employeeId,
        userId: a.userId || a.employeeId,
        key: `${a.userId || a.employeeId}_${date}`
    };
}

function normalizeShiftBlock(b) {
    return {
        ...b,
        date: typeof b.date === 'string' ? b.date.split('T')[0] : b.date
    };
}

function normalizeActivity(a) {
    return {
        ...a,
        date: typeof a.date === 'string' ? a.date.split('T')[0] : a.date,
        userId: a.userId || a.user_id
    };
}

// Globale data store (in-memory cache van database data)
// NOTE: employees is nu een alias voor users (minus admin users)
const DataStore = {
    users: [],           // All users with schedule data
    get employees() {    // Backward compatibility: returns non-admin users
        return this.users.filter(u => u.role !== 'admin');
    },
    set employees(val) { // Allow setting for backward compatibility
        // When setting employees, merge with existing admin users
        const admins = this.users.filter(u => u.role === 'admin');
        this.users = [...admins, ...val.filter(u => u.role !== 'admin')];
    },
    shifts: [],
    activities: [],
    availability: [],
    shiftBlocks: [],
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
        // Load all data in parallel - users now includes employee/schedule data
        const loadErrors = [];
        const [usersData, shiftsData, availabilityData, shiftBlocksData, settingsData, draftsData, activitiesData] = await Promise.all([
            dataApiFetch('/users').catch(err => { loadErrors.push('users'); console.error('[LoadData] Failed to load users:', err); return { users: [] }; }),
            dataApiFetch('/shifts').catch(err => { loadErrors.push('shifts'); console.error('[LoadData] Failed to load shifts:', err); return { shifts: [] }; }),
            dataApiFetch('/availability').catch(err => { loadErrors.push('availability'); console.error('[LoadData] Failed to load availability:', err); return { availability: [] }; }),
            dataApiFetch('/shift-blocks').catch(err => { loadErrors.push('shift-blocks'); console.error('[LoadData] Failed to load shift-blocks:', err); return []; }),
            dataApiFetch('/settings').catch(err => { loadErrors.push('settings'); console.error('[LoadData] Failed to load settings:', err); return { settings: {} }; }),
            dataApiFetch('/schedule-drafts').catch(err => { console.log('[LoadData] Schedule drafts not available (using settings fallback)'); return { drafts: null }; }),
            dataApiFetch('/shift-activities').catch(err => { console.log('[LoadData] Activities not available'); return { activities: [] }; })
        ]);

        if (loadErrors.length > 0) {
            if (typeof showToast === 'function') {
                showToast(`Sommige data kon niet geladen worden: ${loadErrors.join(', ')}`, 'warning');
            }
        }

        // Users now contain employee/schedule data
        DataStore.users = usersData.users || [];

        DataStore.shifts = (shiftsData.shifts || []).map(normalizeShift);
        DataStore.activities = (activitiesData.activities || []).map(normalizeActivity);
        DataStore.availability = (availabilityData.availability || []).map(normalizeAvailability);
        DataStore.shiftBlocks = (Array.isArray(shiftBlocksData) ? shiftBlocksData : []).map(normalizeShiftBlock);

        // Merge API settings with defaults
        const apiSettings = settingsData.settings || {};
        DataStore.settings = normalizeSettings({
            ...DataStore.settings,
            ...apiSettings.general,
            teams: apiSettings.teams || DataStore.settings.teams,
            rules: apiSettings.rules || DataStore.settings.rules,
            holidayPeriods: apiSettings.holidayPeriods || DataStore.settings.holidayPeriods,
            holidayRules: apiSettings.holidayRules || DataStore.settings.holidayRules,
            responsibleRotation: apiSettings.responsibleRotation || DataStore.settings.responsibleRotation,
            // planningHorizon: legacy, replaced by school year logic
            schedule_templates: apiSettings.schedule_templates || DataStore.settings.schedule_templates || [],
            schedule_drafts: apiSettings.schedule_drafts || DataStore.settings.schedule_drafts || [],
            schedulePattern: apiSettings.schedule_pattern || DataStore.settings.schedulePattern,
            emailNotifications: apiSettings.email_notifications || DataStore.settings.emailNotifications,
            schoolYearStart: apiSettings.school_year_start || DataStore.settings.schoolYearStart
        });

        // Use schedule_drafts from dedicated table if available (overrides settings fallback)
        if (draftsData.drafts) {
            DataStore.settings.schedule_drafts = draftsData.drafts;
            DataStore._draftsFromTable = true;
        }

        DataStore._loaded = true;
        console.log('Data geladen van API:', {
            users: DataStore.users.length,
            employees: DataStore.employees.length, // via getter
            shifts: DataStore.shifts.length,
            availability: DataStore.availability.length,
            shiftBlocks: DataStore.shiftBlocks.length
        });

        return true;
    } catch (error) {
        console.error('Fout bij laden van API:', error);
        return false;
    }
}

// ===== MEDEWERKERS/USERS FUNCTIES =====
// Note: These work with users now, but maintain "employee" naming for UI compatibility

async function addEmployee(employeeData) {
    try {
        // Create a user with employee/schedule data
        const userData = {
            ...employeeData,
            password: 'Welkom123!', // Default password
            role: 'medewerker'
        };

        const data = await dataApiFetch('/admin/users', {
            method: 'POST',
            body: JSON.stringify(userData)
        });
        const user = data.user;
        await refreshUsers();
        return user;
    } catch (error) {
        console.error('Fout bij toevoegen medewerker:', error);
        throw error;
    }
}

async function updateEmployee(id, updates) {
    try {
        const index = DataStore.users.findIndex(e => e.id === id);
        if (index === -1) return null;

        const currentUser = DataStore.users[index];
        const updatedData = { ...currentUser, ...updates };

        const data = await dataApiFetch(`/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updatedData)
        });

        const user = data.user;
        await refreshUsers();
        return user;
    } catch (error) {
        console.error('Fout bij bijwerken medewerker:', error);
        throw error;
    }
}

async function deleteEmployee(id) {
    try {
        await dataApiFetch(`/admin/users/${id}`, { method: 'DELETE' });

        // Server cascade deletes related data; refresh all affected caches
        await Promise.all([refreshUsers(), refreshShifts(), refreshAvailability()]);

        return true;
    } catch (error) {
        console.error('Fout bij verwijderen medewerker:', error);
        throw error;
    }
}

async function replaceEmployee(oldUserId, replacementUserId, transferShiftsFrom = null) {
    try {
        const body = { replacementUserId };
        if (transferShiftsFrom) {
            body.transferShiftsFrom = transferShiftsFrom;
        }
        const result = await dataApiFetch(`/admin/users/${oldUserId}/replace`, {
            method: 'POST',
            body: JSON.stringify(body)
        });

        // Refresh all affected caches (including activities which may be transferred)
        await Promise.all([refreshUsers(), refreshShifts(), refreshAvailability(), refreshActivities()]);

        return result;
    } catch (error) {
        console.error('Fout bij vervangen medewerker:', error);
        throw error;
    }
}

function getEmployee(id) {
    // Find in all users (employees are non-admin users)
    return DataStore.users.find(e => e.id === id);
}

function getAllEmployees(activeOnly = false) {
    // Get non-admin users (employees)
    let employees = DataStore.users.filter(u => u.role !== 'admin');
    if (activeOnly) {
        employees = employees.filter(e => e.active !== false);
    }
    return employees;
}

function getEmployeesByTeam(teamId, includeExtra = true) {
    return getAllEmployees(true).filter(e => {
        if (e.mainTeam === teamId) return true;
        if (includeExtra && e.extraTeams && e.extraTeams.includes(teamId)) return true;
        return false;
    });
}

// ===== DIENSTEN FUNCTIES =====

async function addShift(shiftData) {
    try {
        // Map employeeId to userId for new API
        const apiData = {
            ...shiftData,
            userId: shiftData.userId || shiftData.employeeId
        };
        delete apiData.employeeId;

        const data = await dataApiFetch('/shifts', {
            method: 'POST',
            body: JSON.stringify(apiData)
        });

        const shift = normalizeShift(data.shift);
        await refreshShifts();
        await fetchShiftBlocks();
        return shift;
    } catch (error) {
        console.error('Fout bij toevoegen dienst:', error);
        throw error;
    }
}

async function addShiftsBulk(shiftsArray, overwriteExisting = false) {
    try {
        const data = await dataApiFetch('/shifts/bulk', {
            method: 'POST',
            body: JSON.stringify({
                shifts: shiftsArray.map(s => ({
                    userId: s.userId || s.employeeId,
                    team: s.team,
                    date: s.date,
                    startTime: s.startTime,
                    endTime: s.endTime,
                    notes: s.notes || ''
                })),
                overwriteExisting
            })
        });

        const newShifts = (data.shifts || []).map(normalizeShift);
        await refreshShifts();
        await fetchShiftBlocks();
        return newShifts;
    } catch (error) {
        console.error('Fout bij bulk toevoegen diensten:', error);
        throw error;
    }
}

async function updateShift(id, updates) {
    try {
        // Map employeeId to userId
        const apiData = { ...updates };
        if (apiData.employeeId && !apiData.userId) {
            apiData.userId = apiData.employeeId;
        }
        delete apiData.employeeId;

        const data = await dataApiFetch(`/shifts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(apiData)
        });

        const shift = normalizeShift(data.shift);
        await refreshShifts();
        return shift;
    } catch (error) {
        console.error('Fout bij bijwerken dienst:', error);
        throw error;
    }
}

// ===== GRANULAIRE REFRESH FUNCTIES =====
// Herladen van specifieke data types van de server (DataStore als pure cache)

async function refreshShifts({ startDate, endDate, merge = false } = {}) {
    try {
        // Auto-use active range if set and no explicit params given
        if (!startDate && !endDate && _activeShiftRange) {
            startDate = _activeShiftRange.startDate;
            endDate = _activeShiftRange.endDate;
            merge = true;
        }

        const params = new URLSearchParams();
        if (startDate && endDate) {
            params.set('startDate', startDate);
            params.set('endDate', endDate);
        }
        const url = '/shifts' + (params.toString() ? '?' + params.toString() : '');
        const data = await dataApiFetch(url);
        const freshShifts = (data.shifts || []).map(normalizeShift);

        if (merge && startDate && endDate) {
            // Partial refresh: replace shifts in range, keep the rest
            DataStore.shifts = DataStore.shifts
                .filter(s => s.date < startDate || s.date > endDate)
                .concat(freshShifts);
        } else {
            DataStore.shifts = freshShifts;
        }
        return DataStore.shifts;
    } catch (error) {
        console.error('[Refresh] Failed to refresh shifts:', error);
        throw error;
    }
}

async function refreshUsers() {
    try {
        const data = await dataApiFetch('/users');
        DataStore.users = data.users || [];
        return DataStore.users;
    } catch (error) {
        console.error('[Refresh] Failed to refresh users:', error);
        throw error;
    }
}

async function refreshAvailability() {
    try {
        const data = await dataApiFetch('/availability');
        DataStore.availability = (data.availability || []).map(normalizeAvailability);
        return DataStore.availability;
    } catch (error) {
        console.error('[Refresh] Failed to refresh availability:', error);
        throw error;
    }
}

async function fetchShiftBlocks() {
    try {
        const data = await dataApiFetch('/shift-blocks').catch(() => []);
        DataStore.shiftBlocks = (Array.isArray(data) ? data : []).map(normalizeShiftBlock);
        return DataStore.shiftBlocks;
    } catch (error) {
        console.error('Error fetching shift blocks:', error);
        return [];
    }
}

async function refreshActivities() {
    try {
        const params = new URLSearchParams();
        if (_activeShiftRange) {
            params.set('startDate', _activeShiftRange.startDate);
            params.set('endDate', _activeShiftRange.endDate);
        }
        const url = '/shift-activities' + (params.toString() ? '?' + params.toString() : '');
        const data = await dataApiFetch(url);
        DataStore.activities = (data.activities || []).map(normalizeActivity);
        return DataStore.activities;
    } catch (error) {
        console.error('[Refresh] Failed to refresh activities:', error);
        return [];
    }
}

async function addActivity(activityData) {
    try {
        const data = await dataApiFetch('/shift-activities', {
            method: 'POST',
            body: JSON.stringify(activityData)
        });
        await refreshActivities();
        return normalizeActivity(data.activity);
    } catch (error) {
        console.error('Fout bij aanmaken activiteit:', error);
        throw error;
    }
}

async function updateActivity(id, updates) {
    try {
        const data = await dataApiFetch(`/shift-activities/${id}`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
        await refreshActivities();
        return normalizeActivity(data.activity);
    } catch (error) {
        console.error('Fout bij bijwerken activiteit:', error);
        throw error;
    }
}

async function deleteActivity(id) {
    try {
        await dataApiFetch(`/shift-activities/${id}`, { method: 'DELETE' });
        await refreshActivities();
        return true;
    } catch (error) {
        console.error('Fout bij verwijderen activiteit:', error);
        throw error;
    }
}

function getActivitiesByEmployee(userId, date) {
    return DataStore.activities.filter(a =>
        String(a.userId) === String(userId) && a.date === date
    );
}

async function deleteShift(id) {
    try {
        await dataApiFetch(`/shifts/${id}`, { method: 'DELETE' });

        await refreshShifts();
        await fetchShiftBlocks();

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

        const deletedCount = data.deleted || 0;
        await refreshShifts();
        return deletedCount;
    } catch (error) {
        console.error('Fout bij verwijderen diensten:', error);
        throw error;
    }
}

// @deprecated — Gebruik applyScheduleViaBackend() voor atomische shift regeneratie via backend.
// Deze functie wordt niet meer actief aangeroepen maar blijft beschikbaar als fallback.
async function removeAutoShiftsInDateRange(startDate, endDate) {
    try {
        // Get auto shifts in range
        const autoShifts = DataStore.shifts.filter(shift =>
            shift.date >= startDate &&
            shift.date <= endDate &&
            shift.source === 'auto'
        );

        // Delete each auto shift via API
        // Pass skipBlock=true to prevent creating shift_blocks during system cleanup
        let deletedCount = 0;
        for (const shift of autoShifts) {
            try {
                await dataApiFetch(`/shifts/${shift.id}?skipBlock=true`, { method: 'DELETE' });
                deletedCount++;
            } catch (e) {
                console.error(`Fout bij verwijderen auto-shift ${shift.id}:`, e);
            }
        }

        // Update local cache - keep manual shifts, remove auto shifts
        DataStore.shifts = DataStore.shifts.filter(shift =>
            shift.date < startDate ||
            shift.date > endDate ||
            shift.source === 'manual'
        );

        return deletedCount;
    } catch (error) {
        console.error('Fout bij verwijderen auto-diensten:', error);
        throw error;
    }
}

function getShiftsByEmployee(employeeId, startDate = null, endDate = null) {
    // Support both employeeId and userId
    let shifts = DataStore.shifts.filter(s =>
        s.employeeId === employeeId || s.userId === employeeId
    );
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
    const pattern = getSchedulePattern(date);
    const cycleLength = pattern.cycleLength || 2;
    const referenceDate = parseDateOnly(pattern.referenceDate || DataStore.settings.biWeeklyReferenceDate);
    referenceDate.setHours(0, 0, 0, 0);
    const currentDate = parseDateOnly(date);
    currentDate.setHours(0, 0, 0, 0);

    const refMonday = getMonday(referenceDate);
    refMonday.setHours(0, 0, 0, 0);
    const currMonday = getMonday(currentDate);
    currMonday.setHours(0, 0, 0, 0);

    const diffTime = currMonday.getTime() - refMonday.getTime();
    const diffWeeks = Math.round(diffTime / (1000 * 60 * 60 * 24 * 7));

    // Modulo N for flexible cycle length (1-based: returns 1..cycleLength)
    const mod = diffWeeks % cycleLength;
    return (mod < 0 ? mod + cycleLength : mod) + 1;
}

function getISOWeekNumber(date) {
    const d = parseDateOnly(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}

// @deprecated — Gebruik applyScheduleViaBackend() voor atomische shift regeneratie via backend.
async function applyWeekScheduleForEmployee(employeeId, startDate, endDate) {
    const employee = getEmployee(employeeId);
    if (!employee) {
        return [];
    }

    if (!hasAnyWeekSchedule(employee)) {
        return [];
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);
    const createdShifts = [];

    // Create date copy properly in local timezone to avoid timezone shifts
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= end; d.setDate(d.getDate() + 1)) {
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

        // Skip if there's a shift block for this user/date (from deleted shifts)
        const isBlocked = DataStore.shiftBlocks.some(
            block => block.user_id === employeeId && block.date === dateStr
        );
        if (isBlocked) {
            continue;
        }

        const weekNumber = getWeekNumber(dateStr);
        const weekSchedule = getEmployeeWeekSchedule(employee, weekNumber);

        const scheduleForDay = weekSchedule.find(s => s.dayOfWeek === dayOfWeek);
        if (scheduleForDay && scheduleForDay.enabled) {
            try {
                const shift = await addShift({
                    userId: employeeId,
                    employeeId: employeeId, // Backward compat
                    team: scheduleForDay.team || employee.mainTeam,
                    date: dateStr,
                    startTime: scheduleForDay.startTime,
                    endTime: scheduleForDay.endTime,
                    notes: `Automatisch ingepland via basisrooster (Week ${weekNumber})`,
                    source: 'auto'
                });
                createdShifts.push(shift);
            } catch (error) {
                console.error('Fout bij aanmaken shift:', error);
            }
        }
    }

    return createdShifts;
}

// @deprecated — Gebruik applyScheduleViaBackend() voor atomische shift regeneratie via backend.
async function applyWeekScheduleForAllEmployees(startDate, endDate) {
    const employees = getAllEmployees(true);
    let totalShifts = 0;

    for (const emp of employees) {
        const shifts = await applyWeekScheduleForEmployee(emp.id, startDate, endDate);
        totalShifts += shifts.length;
    }

    return totalShifts;
}

// Apply schedule via backend (atomic, single transaction)
async function applyScheduleViaBackend(userId, { clearBlocks = false } = {}) {
    try {
        const result = await dataApiFetch(`/users/${userId}/apply-schedule`, {
            method: 'POST',
            body: JSON.stringify({ clearBlocks })
        });
        console.log(`[Backend Schedule] User ${userId}: created ${result.created}, deleted ${result.deleted}, blocks cleared ${result.blocksCleared || 0}`);
        return result;
    } catch (error) {
        console.error(`[Backend Schedule] Error for user ${userId}:`, error);
        throw error;
    }
}

// ===== AFWEZIGHEID FUNCTIES =====

function getAvailability(employeeId, date) {
    // Support both employeeId and userId
    return DataStore.availability.find(a =>
        (String(a.employeeId) === String(employeeId) || String(a.userId) === String(employeeId)) && a.date === date
    );
}

async function setAvailability(employeeId, date, absenceData, { skipRefresh = false } = {}) {
    if (!absenceData.type) {
        return removeAvailability(employeeId, date, { skipRefresh });
    }

    try {
        const data = await dataApiFetch('/availability', {
            method: 'POST',
            body: JSON.stringify({
                userId: employeeId,
                date,
                type: absenceData.type,
                reason: absenceData.reason || ''
            })
        });

        const absence = normalizeAvailability(data.availability);
        if (!skipRefresh) {
            await refreshAvailability();
        }
        return absence;
    } catch (error) {
        console.error('Fout bij instellen afwezigheid:', error);
        throw error;
    }
}

async function removeAvailability(employeeId, date, { skipRefresh = false } = {}) {
    try {
        await dataApiFetch(`/availability?userId=${employeeId}&date=${date}`, {
            method: 'DELETE'
        });

        if (!skipRefresh) {
            await refreshAvailability();
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

// ===== SWAP REQUEST FUNCTIES =====

async function getSwapRequests() {
    try {
        const data = await dataApiFetch('/swap-requests');
        DataStore.swapRequests = data.swapRequests || [];
        console.log(`[getSwapRequests] Received ${DataStore.swapRequests.length} swap requests from backend`);
        if (DataStore.swapRequests.length > 0) {
            console.log('[getSwapRequests] First request:', {
                id: DataStore.swapRequests[0].id,
                request_type: DataStore.swapRequests[0].request_type,
                status: DataStore.swapRequests[0].status,
                requester_name: DataStore.swapRequests[0].requester_name
            });
        }
        return DataStore.swapRequests;
    } catch (error) {
        console.error('Fout bij ophalen swap requests:', error);
        throw error;
    }
}

async function createSwapRequest(requestData) {
    try {
        const data = await dataApiFetch('/swap-requests', {
            method: 'POST',
            body: JSON.stringify(requestData)
        });

        // Refresh swap requests list
        await getSwapRequests();

        return data.swapRequest;
    } catch (error) {
        console.error('Fout bij aanmaken swap request:', error);
        throw error;
    }
}

async function approveSwapRequest(id, responseNotes) {
    try {
        await dataApiFetch(`/swap-requests/${id}/approve`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes })
        });

        // Refresh swap requests + shifts (approval can swap shift ownership)
        await getSwapRequests();
        await refreshShifts();

        return true;
    } catch (error) {
        console.error('Fout bij goedkeuren swap request:', error);
        throw error;
    }
}

async function rejectSwapRequest(id, responseNotes) {
    try {
        await dataApiFetch(`/swap-requests/${id}/reject`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes })
        });

        await getSwapRequests();

        return true;
    } catch (error) {
        console.error('Fout bij afwijzen swap request:', error);
        throw error;
    }
}

async function cancelSwapRequest(id) {
    try {
        await dataApiFetch(`/swap-requests/${id}`, {
            method: 'DELETE'
        });

        // Refresh swap requests list
        await getSwapRequests();

        return true;
    } catch (error) {
        console.error('Fout bij annuleren swap request:', error);
        throw error;
    }
}

async function targetApproveSwapRequest(id, responseNotes) {
    try {
        await dataApiFetch(`/swap-requests/${id}/target-approve`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes })
        });

        // Refresh swap requests + shifts (target approval executes the swap)
        await getSwapRequests();
        await refreshShifts();

        return true;
    } catch (error) {
        console.error('Fout bij target approve swap request:', error);
        throw error;
    }
}

async function targetRejectSwapRequest(id, responseNotes) {
    try {
        await dataApiFetch(`/swap-requests/${id}/target-reject`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes })
        });

        // Refresh swap requests list
        await getSwapRequests();

        return true;
    } catch (error) {
        console.error('Fout bij target reject swap request:', error);
        throw error;
    }
}

async function saveBulkAvailabilityWithTakeover(userId, startDate, endDate, type, reason, createTakeoverRequests) {
    const data = await dataApiFetch('/availability/sick-with-takeover', {
        method: 'POST',
        body: JSON.stringify({ userId, startDate, endDate, type, reason, createTakeoverRequests })
    });
    await refreshAvailability();
    return data;
}

async function createTakeoverRequest(shiftId, message) {
    try {
        await dataApiFetch('/shift-requests/takeover', {
            method: 'POST',
            body: JSON.stringify({ shiftId, message })
        });
        await getSwapRequests();
        return true;
    } catch (error) {
        console.error('Fout bij aanmaken takeover request:', error);
        throw error;
    }
}

async function acceptTakeoverRequest(id, responseNotes) {
    try {
        await dataApiFetch(`/shift-requests/${id}/takeover-accept`, {
            method: 'PUT',
            body: JSON.stringify({ responseNotes })
        });
        await getSwapRequests();
        return true;
    } catch (error) {
        console.error('Fout bij accepteren takeover:', error);
        throw error;
    }
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
    // Backward compat wrapper: checks if this date (or its weekend) is open
    // For adjacent days (Friday, Monday), checks the Saturday of that weekend
    const d = parseDateOnly(date);
    const dayOfWeek = d.getDay();

    // Weekdays (Tue-Thu) are never closed as "weekend"
    if (dayOfWeek >= 2 && dayOfWeek <= 4) {
        return true;
    }

    // For Friday/Monday, check their adjacent Saturday
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

    return !isDayClosed(checkDate);
}

// ===== FLEXIBEL ROOSTERPATROON FUNCTIES =====

function getSchedulePattern(forDate) {
    const stored = DataStore.settings.schedulePattern;
    if (stored && stored.cycleLength) {
        // Date-aware: if effectiveFrom is set and forDate is before it, use previousPattern
        if (forDate && stored.effectiveFrom && stored.previousPattern) {
            const checkDate = parseDateOnly(forDate);
            const effectiveDate = parseDateOnly(stored.effectiveFrom);
            if (checkDate < effectiveDate) {
                return stored.previousPattern;
            }
        }
        return stored;
    }
    // Backward compat: construct from biWeeklyReferenceDate
    return {
        cycleLength: 2,
        referenceDate: DataStore.settings.biWeeklyReferenceDate || '2025-01-06',
        weeks: {
            "1": { closedDays: [6, 0], label: "Weekend gesloten" },
            "2": { closedDays: [], label: "Weekend open" }
        }
    };
}

function getCycleLength(forDate) {
    return getSchedulePattern(forDate).cycleLength || 2;
}

function getClosedDaysForWeek(weekNumber, forDate) {
    const pattern = getSchedulePattern(forDate);
    const weekConfig = pattern.weeks?.[String(weekNumber)];
    return weekConfig?.closedDays || [];
}

function getWeekLabel(weekNumber, forDate) {
    const pattern = getSchedulePattern(forDate);
    const weekConfig = pattern.weeks?.[String(weekNumber)];
    if (weekConfig?.label) return weekConfig.label;
    const closedDays = getClosedDaysForWeek(weekNumber, forDate);
    return closedDays.length > 0 ? `${formatClosedDays(closedDays)}` : 'Alle dagen open';
}

function isDayClosed(date) {
    const d = parseDateOnly(date);
    const dayOfWeek = d.getDay();
    const weekNumber = getWeekNumber(date);
    const closedDays = getClosedDaysForWeek(weekNumber, date);
    return closedDays.includes(dayOfWeek);
}

function isDayClosedForWeek(dayOfWeek, weekNumber) {
    const closedDays = getClosedDaysForWeek(weekNumber);
    return closedDays.includes(dayOfWeek);
}

function getEmployeeWeekSchedule(employee, weekNumber) {
    // Try new format first (array of N week schedules)
    if (Array.isArray(employee.weekSchedules) && employee.weekSchedules.length > 0) {
        return employee.weekSchedules[weekNumber - 1] || [];
    }
    // Fall back to old format (2 fixed columns)
    if (weekNumber === 1) return employee.weekScheduleWeek1 || [];
    if (weekNumber === 2) return employee.weekScheduleWeek2 || [];
    return [];
}

function hasAnyWeekSchedule(employee) {
    if (Array.isArray(employee.weekSchedules)) {
        return employee.weekSchedules.some(ws => Array.isArray(ws) && ws.length > 0);
    }
    return (employee.weekScheduleWeek1?.length > 0) || (employee.weekScheduleWeek2?.length > 0);
}

function formatClosedDays(closedDays) {
    if (!closedDays || closedDays.length === 0) return 'alle dagen open';
    const dayMap = { 0: 'zo', 1: 'ma', 2: 'di', 3: 'wo', 4: 'do', 5: 'vr', 6: 'za' };
    return closedDays.map(d => dayMap[d]).join(', ') + ' gesloten';
}

function getOpenDaysForWeek(weekNumber) {
    const closedDays = getClosedDaysForWeek(weekNumber);
    // Return JS dayOfWeek numbers for open days (0=zo, 1=ma, ..., 6=za)
    return [1, 2, 3, 4, 5, 6, 0].filter(d => !closedDays.includes(d));
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
    return getAllEmployees(true).filter(emp =>
        eligibleTeams.includes(emp.mainTeam)
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
    if (!rotation) return null;

    // Date-aware: if effectiveFrom is set and target date is before it, use previousRotation
    let activeRotation = rotation;
    if (rotation.effectiveFrom && rotation.previousRotation) {
        const targetDate = new Date(weekStartDate);
        targetDate.setHours(0, 0, 0, 0);
        const effectiveDate = parseDateOnly(rotation.effectiveFrom);
        if (targetDate < effectiveDate) {
            activeRotation = { ...rotation, ...rotation.previousRotation };
        }
    }

    if (!activeRotation?.rotationStart || !activeRotation?.rotationStartEmployee) {
        return null;
    }

    const eligible = getEligibleEmployeesForResponsible();
    if (eligible.length === 0) return null;

    const startEmployeeId = String(activeRotation.rotationStartEmployee);
    const startIndex = eligible.findIndex(e => String(e.id) === startEmployeeId);
    if (startIndex === -1) return eligible[0];

    const startDate = new Date(activeRotation.rotationStart);
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

    // Check if weekend is open (i.e. Saturday is NOT a closed day)
    const weekNumber = getWeekNumber(monday);
    const closedDays = getClosedDaysForWeek(weekNumber, monday);
    const isOpenWeekend = !closedDays.includes(6) && !closedDays.includes(0);

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
        // Create a new date in local timezone to avoid timezone shifts
        const weekDate = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
        dates.push(formatDateYYYYMMDD(weekDate));
    }
    return dates;
}

// Get first day of month (always 1st of month, 00:00:00)
function getMonthStart(date) {
    const d = parseDateOnly(date);
    return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Get all weeks in a month (array of Monday date strings YYYY-MM-DD)
// Returns 4-6 weeks, starting from Monday before or on month start
function getMonthWeeks(monthStartDate) {
    const monthStart = parseDateOnly(monthStartDate);
    const firstMonday = getMonday(monthStart); // Monday on or before 1st

    // Find last day of month
    const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
    const lastDay = new Date(nextMonth.getTime() - 1);

    const weeks = [];
    let currentMonday = new Date(firstMonday);

    // Add weeks until we cover the entire month
    while (currentMonday <= lastDay) {
        weeks.push(formatDateYYYYMMDD(currentMonday));
        currentMonday.setDate(currentMonday.getDate() + 7);
    }

    return weeks;
}

// Get all dates in a month (array of date strings YYYY-MM-DD)
function getMonthDates(monthStartDate) {
    const weeks = getMonthWeeks(monthStartDate);
    const dates = [];
    weeks.forEach(weekStart => {
        dates.push(...getWeekDates(weekStart));
    });
    return dates;
}

// Format month display (e.g., "februari 2026")
function formatMonthDisplay(monthStartDate) {
    const d = parseDateOnly(monthStartDate);
    return d.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
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
    if (!await showConfirm('Weet je zeker dat je ALLE data wilt verwijderen?\n\nDit verwijdert alle diensten en afwezigheden.\nGebruikers blijven behouden.\nDit kan niet ongedaan worden gemaakt!', 'Alle data verwijderen')) {
        return;
    }

    if (!await showConfirm('LAATSTE WAARSCHUWING: Alle planning data wordt permanent verwijderd. Doorgaan?', 'Laatste waarschuwing')) {
        return;
    }

    try {
        await dataApiFetch('/reset-data', { method: 'DELETE' });
        alert('Alle planning data is gewist. De pagina wordt herladen.');
        location.reload();
    } catch (error) {
        showToast('Fout bij wissen: ' + error.message, 'error');
    }
}

// ===== AUDIT LOG =====

async function fetchAuditLog(filters = {}) {
    const params = new URLSearchParams();
    if (filters.page) params.set('page', filters.page);
    if (filters.limit) params.set('limit', filters.limit);
    if (filters.actorId) params.set('actorId', filters.actorId);
    if (filters.action) params.set('action', filters.action);
    if (filters.resourceType) params.set('resourceType', filters.resourceType);
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    return dataApiFetch(`/audit-log?${params.toString()}`);
}

// ===== SCHEDULE DRAFTS =====

async function fetchScheduleDrafts() {
    return dataApiFetch('/schedule-drafts');
}

async function createScheduleDraft(draft) {
    return dataApiFetch('/schedule-drafts', {
        method: 'POST',
        body: JSON.stringify(draft)
    });
}

async function updateScheduleDraft(id, data) {
    return dataApiFetch(`/schedule-drafts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
    });
}

async function deleteScheduleDraft(id) {
    return dataApiFetch(`/schedule-drafts/${id}`, {
        method: 'DELETE'
    });
}

async function applyScheduleDraft(draftId, { clearBlocks = true, applyStartDate = null, applyEndDate = null } = {}) {
    return dataApiFetch(`/schedule-drafts/${draftId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ clearBlocks, applyStartDate, applyEndDate })
    });
}

async function deactivateDraftShifts(draftId, { endDate, deleteManual = false }) {
    return dataApiFetch(`/schedule-drafts/${draftId}/deactivate`, {
        method: 'POST',
        body: JSON.stringify({ endDate, deleteManual })
    });
}

// ===== SCHOOLJAAR =====

function getSchoolYearStart() {
    const raw = DataStore.settings.schoolYearStart?.date || null;
    if (!raw) {
        // Default: September 1 of the current school year
        const now = new Date();
        const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
        return `${year}-09-01`;
    }
    // Handle ISO timestamps: extract YYYY-MM-DD part
    if (raw.includes('T')) return raw.split('T')[0];
    return raw;
}

function getSchoolWeekNumber(date) {
    const start = getSchoolYearStart();
    if (!start) return null;
    const currentMonday = getMonday(parseDateOnly(date));
    currentMonday.setHours(0, 0, 0, 0);
    // Find the school year that contains this date (adjusts year automatically)
    const startDate = parseDateOnly(start);
    const syMonth = startDate.getMonth();
    const syDay = startDate.getDate();
    let syYear = currentMonday.getFullYear();
    let thisYearStart = new Date(syYear, syMonth, syDay);
    thisYearStart.setHours(0, 0, 0, 0);
    if (currentMonday < thisYearStart) {
        syYear--;
        thisYearStart = new Date(syYear, syMonth, syDay);
        thisYearStart.setHours(0, 0, 0, 0);
    }
    const startMonday = getMonday(thisYearStart);
    startMonday.setHours(0, 0, 0, 0);
    const diffWeeks = Math.round((currentMonday.getTime() - startMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    return diffWeeks + 1; // 1-based
}

async function saveSchoolYearStart(date) {
    DataStore.settings.schoolYearStart = { date };
    saveToStorage();
    await apiFetch('/settings/school_year_start', {
        method: 'PUT',
        body: JSON.stringify({ value: { date } })
    });
}

// ===== INITIALISATIE =====
// Data wordt geladen via loadDataFromAPI() na login in app.js
