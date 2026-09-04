// HET VLOT ROOSTERPLANNING - ADMIN TOOLS EN DATA IMPORT/EXPORT

function exportData() {
    // Export users (with schedule data) - also include as 'employees' for backward compatibility
    const users = DataStore.employees; // Gets non-admin users via getter
    const dataToExport = {
        users: users,
        employees: users, // Backward compatibility
        shifts: DataStore.shifts,
        // #206: afwezigheid ontbrak volledig in de backup. Dat is precies de
        // data die niemand achteraf uit zijn hoofd kan reconstrueren: wie
        // wanneer ziek was of verlof had.
        availability: DataStore.availability || [],
        settings: DataStore.settings,
        exportDate: new Date().toISOString()
    };
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hetvlot-backup-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
}

async function runMigration() {
    if (!await showConfirm('VOLLEDIGE DATABASE MIGRATIE\n\nDit zal:\n- Employees tabel samenvoegen met users\n- Shifts migreren (employee_id -> user_id)\n- Availability migreren (employee_id -> user_id)\n- Employees tabel verwijderen\n- Weekroosters repareren\n\nDit is een grote wijziging, maar 100% veilig:\n- Gebruikt transactions (bij error: automatisch ROLLBACK)\n- Alle data blijft behouden\n- Foreign key mappings correct uitgevoerd\n\nDoorgaan?', 'Database Migratie')) {
        return;
    }

    try {
        const result = await dataApiFetch('/admin/migrate', { method: 'POST' });
        let message = 'Migratie succesvol!\n\n';

        if (result.results.migrations.length > 0) {
            message += 'Schema updates:\n' + result.results.migrations.map(m => '• ' + m).join('\n') + '\n\n';
        }

        if (result.results.fixes.length > 0) {
            message += 'Data fixes:\n' + result.results.fixes.map(f => '• ' + f).join('\n');
        }

        if (result.results.migrations.length === 0 && result.results.fixes.length === 0) {
            message += 'Geen wijzigingen nodig - database is up-to-date.';
        }

        showToast(message.substring(0, 200), 'success');
        if (message.length > 200) console.log('[Migratie] Volledige output:', message);

        // Reload data to see the fixed weekSchedules
        await loadDataFromAPI();
        renderPlanning();
    } catch (error) {
        showToast('Migratie mislukt: ' + error.message, 'error');
    }
}

async function seedTeams() {
    try {
        const result = await dataApiFetch('/admin/seed-teams', { method: 'POST' });
        showToast(`Teams aangemaakt! Nieuw: ${result.created}, Bijgewerkt: ${result.updated}, Totaal: ${result.total}`, 'success');

        // Reload data
        await loadDataFromAPI();
        renderSettings();
    } catch (error) {
        showToast('Teams aanmaken mislukt: ' + error.message, 'error');
    }
}

async function showDebugInfo() {
    try {
        const result = await dataApiFetch('/admin/debug');

        let message = `=== DATABASE DEBUG INFO ===\n\n`;
        message += `TEAMS (${result.teams.length}):\n`;
        result.teams.forEach(t => {
            message += `• ${t.id}: ${t.name}\n`;
        });

        message += `\nMEDEWERKERS (${result.employeeCount}):\n`;
        result.employees.forEach(emp => {
            const ws = emp.weekSchedules;
            const w1 = emp.weekScheduleWeek1;
            const w2 = emp.weekScheduleWeek2;
            message += `\n${emp.name} (ID: ${emp.id}):\n`;
            message += `  mainTeam: ${emp.mainTeam || 'GEEN'}\n`;
            message += `  weekSchedules: type=${ws?.type || typeof ws}, isArray=${Array.isArray(ws)}, length=${ws?.length || 0}\n`;
            message += `  weekScheduleWeek1: type=${w1?.type || typeof w1}, isArray=${w1?.isArray || Array.isArray(w1)}, length=${w1?.length || 0}\n`;
            message += `  weekScheduleWeek2: type=${w2?.type || typeof w2}, isArray=${w2?.isArray || Array.isArray(w2)}, length=${w2?.length || 0}\n`;
        });

        console.log(message);
        console.log('Full debug result:', result);
        showToast(message.length > 200 ? 'Debug info getoond in console (F12)' : message, 'info');
    } catch (error) {
        showToast('Debug info ophalen mislukt: ' + error.message, 'error');
    }
}

function sanitizeString(value, maxLen = 200) {
    if (typeof value !== 'string') return '';
    return value.replace(/\0/g, '').trim().slice(0, maxLen);
}

function isValidDateString(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    return formatDateYYYYMMDD(parseDateOnly(value)) === value;
}

function isValidTimeString(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(':').map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function sanitizeSettings(rawSettings) {
    const normalized = normalizeSettings(rawSettings || {});
    const defaults = normalizeSettings(DEFAULT_SETTINGS || {});

    const teams = {};
    Object.keys(normalized.teams || {}).forEach(teamId => {
        const team = normalized.teams[teamId] || {};
        const name = sanitizeString(team.name || defaults.teams?.[teamId]?.name || teamId, 80);
        const color = typeof team.color === 'string' && /^#([0-9a-fA-F]{3}){1,2}$/.test(team.color)
            ? team.color
            : (defaults.teams?.[teamId]?.color || '#64748b');
        teams[teamId] = { name, color };
    });

    const shiftTemplates = {};
    Object.keys(normalized.shiftTemplates || {}).forEach(templateId => {
        if (!/^[a-z0-9_-]+$/i.test(templateId)) return;
        const template = normalized.shiftTemplates[templateId] || {};
        if (!isValidTimeString(template.start) || !isValidTimeString(template.end)) return;
        shiftTemplates[templateId] = {
            name: sanitizeString(template.name || templateId, 80),
            start: template.start,
            end: template.end
        };
    });

    const holidayPeriods = Array.isArray(normalized.holidayPeriods)
        ? normalized.holidayPeriods
            .map(period => ({
                id: Number.isFinite(Number(period?.id)) ? Number(period.id) : Date.now(),
                name: sanitizeString(period?.name || '', 80),
                startDate: period?.startDate,
                endDate: period?.endDate
            }))
            .filter(period => period.name && isValidDateString(period.startDate) && isValidDateString(period.endDate))
        : [];

    const eligibleTeams = Array.isArray(normalized.responsibleRotation?.eligibleTeams)
        ? normalized.responsibleRotation.eligibleTeams.filter(teamId => teams[teamId])
        : (defaults.responsibleRotation?.eligibleTeams || []);

    const assignments = {};
    const rawAssignments = normalized.responsibleRotation?.assignments || {};
    Object.keys(rawAssignments).forEach(dateKey => {
        const employeeId = Number(rawAssignments[dateKey]);
        if (Number.isFinite(employeeId) && isValidDateString(dateKey)) {
            assignments[dateKey] = employeeId;
        }
    });

    const rotationStart = isValidDateString(normalized.responsibleRotation?.rotationStart)
        ? normalized.responsibleRotation.rotationStart
        : (defaults.responsibleRotation?.rotationStart || '');
    const rotationStartEmployee = Number.isFinite(Number(normalized.responsibleRotation?.rotationStartEmployee))
        ? String(normalized.responsibleRotation.rotationStartEmployee)
        : (defaults.responsibleRotation?.rotationStartEmployee || '');

    const rules = {
        minHoursBetweenShifts: Number(normalized.rules?.minHoursBetweenShifts) || defaults.rules?.minHoursBetweenShifts || 11,
        minStaffingDay: Number(normalized.rules?.minStaffingDay) || defaults.rules?.minStaffingDay || 1,
        minStaffingNight: Number(normalized.rules?.minStaffingNight) || defaults.rules?.minStaffingNight || 1,
        maxConsecutiveDays: Number(normalized.rules?.maxConsecutiveDays) || defaults.rules?.maxConsecutiveDays || 6
    };

    const holidayRules = {
        minStaffingDay: Number(normalized.holidayRules?.minStaffingDay) || defaults.holidayRules?.minStaffingDay || 2,
        minStaffingNight: Number(normalized.holidayRules?.minStaffingNight) || defaults.holidayRules?.minStaffingNight || 1
    };

    return {
        ...normalized,
        teams,
        shiftTemplates,
        holidayPeriods,
        rules,
        holidayRules,
        responsibleRotation: {
            eligibleTeams,
            assignments,
            rotationStart,
            rotationStartEmployee
        }
    };
}

function sanitizeImportedData(rawData) {
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    const settings = sanitizeSettings(data.settings);

    const employees = Array.isArray(data.employees) ? data.employees
        .map(emp => {
            const id = Number(emp?.id);
            if (!Number.isFinite(id)) return null;
            const mainTeam = settings.teams[emp?.mainTeam] ? emp.mainTeam : Object.keys(settings.teams)[0];
            // Support both new weekSchedules array and old weekScheduleWeek1/2 format
            let weekScheduleWeek1, weekScheduleWeek2, weekSchedules;
            if (Array.isArray(emp?.weekSchedules) && emp.weekSchedules.length >= 2) {
                weekSchedules = emp.weekSchedules;
                weekScheduleWeek1 = Array.isArray(weekSchedules[0]) ? weekSchedules[0] : [];
                weekScheduleWeek2 = Array.isArray(weekSchedules[1]) ? weekSchedules[1] : [];
            } else {
                weekScheduleWeek1 = Array.isArray(emp?.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [];
                weekScheduleWeek2 = Array.isArray(emp?.weekScheduleWeek2) ? emp.weekScheduleWeek2 : [];
                weekSchedules = [weekScheduleWeek1, weekScheduleWeek2];
            }

            function sanitizeScheduleItem(item) {
                const dayOfWeek = Number(item?.dayOfWeek);
                if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
                if (!settings.teams[item?.team]) return null;
                if (!isValidTimeString(item?.startTime) || !isValidTimeString(item?.endTime)) return null;
                return {
                    dayOfWeek,
                    enabled: Boolean(item?.enabled),
                    team: item.team,
                    startTime: item.startTime,
                    endTime: item.endTime
                };
            }

            return {
                id,
                name: sanitizeString(emp?.name || 'Onbekend', 80),
                email: sanitizeString(emp?.email || '', 120),
                mainTeam,
                contractHours: Number(emp?.contractHours) || 0,
                active: emp?.active !== false,
                weekScheduleWeek1: weekScheduleWeek1.map(sanitizeScheduleItem).filter(Boolean),
                weekScheduleWeek2: weekScheduleWeek2.map(sanitizeScheduleItem).filter(Boolean),
                weekSchedules: weekSchedules.map(ws => (Array.isArray(ws) ? ws : []).map(sanitizeScheduleItem).filter(Boolean)),
                createdAt: emp?.createdAt || new Date().toISOString()
            };
        })
        .filter(Boolean) : [];

    const employeeIds = new Set(employees.map(emp => String(emp.id)));

    const shifts = Array.isArray(data.shifts) ? data.shifts
        .map(shift => {
            const employeeId = Number(shift?.employeeId);
            if (!Number.isFinite(employeeId) || !employeeIds.has(String(employeeId))) return null;
            if (!settings.teams[shift?.team]) return null;
            if (!isValidDateString(shift?.date)) return null;
            if (!isValidTimeString(shift?.startTime) || !isValidTimeString(shift?.endTime)) return null;
            return {
                id: Number.isFinite(Number(shift?.id)) ? Number(shift.id) : Date.now() + Math.random(),
                employeeId,
                team: shift.team,
                date: shift.date,
                startTime: shift.startTime,
                endTime: shift.endTime,
                notes: sanitizeString(shift?.notes || '', 300),
                createdAt: shift?.createdAt || new Date().toISOString()
            };
        })
        .filter(Boolean) : [];

    const availability = Array.isArray(data.availability) ? data.availability
        .map(entry => {
            const employeeId = Number(entry?.employeeId);
            if (!Number.isFinite(employeeId) || !employeeIds.has(String(employeeId))) return null;
            if (!isValidDateString(entry?.date)) return null;
            const type = entry?.type;
            const allowedTypes = ['verlof', 'ziek', 'overuren', 'vorming', 'andere'];
            if (!allowedTypes.includes(type)) return null;
            return {
                key: `${employeeId}_${entry.date}`,
                employeeId,
                date: entry.date,
                type,
                reason: sanitizeString(entry?.reason || '', 200),
                updatedAt: entry?.updatedAt || new Date().toISOString()
            };
        })
        .filter(Boolean) : [];

    return { employees, shifts, availability, settings };
}

async function importData(event) {
    const file = event.target.files[0];
    if (!file) {
        console.log('Geen bestand geselecteerd');
        return;
    }

    console.log('Bestand geselecteerd:', file.name);

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            console.log('Bestand gelezen, parsing JSON...');
            const data = JSON.parse(e.target.result);
            console.log('Data parsed:', data);

            // Support both old (employees) and new (users) format
            const usersToImport = data.users || data.employees || [];
            console.log('Gevonden gebruikers/medewerkers:', usersToImport.length);

            if (usersToImport.length === 0) {
                showToast('Geen medewerkers gevonden in backup bestand', 'warning');
                return;
            }

            // #217: hier ging alleen `users` mee. Diensten, afwezigheid en
            // instellingen stonden wel in het bestand maar werden nooit
            // verstuurd, dus na een reset kwamen vakantieperiodes, gesloten
            // dagen, roosterregels en dienstsjablonen niet terug.
            const shiftsToImport = Array.isArray(data.shifts) ? data.shifts : [];
            const availabilityToImport = Array.isArray(data.availability) ? data.availability : [];
            const settingsToImport = (data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings))
                ? data.settings : null;

            const onderdelen = [`${usersToImport.length} medewerkers`];
            if (shiftsToImport.length) onderdelen.push(`${shiftsToImport.length} diensten`);
            if (availabilityToImport.length) onderdelen.push(`${availabilityToImport.length} afwezigheden`);
            if (settingsToImport) onderdelen.push(`${Object.keys(settingsToImport).length} instellingen`);

            if (!await showConfirm(`Gevonden in de backup:\n${onderdelen.map(o => '• ' + o).join('\n')}\n\nImporteren naar de database?\n\nNieuwe medewerkers krijgen het standaard wachtwoord (DEFAULT_RESET_PASSWORD, in te stellen via Render).`, 'Backup importeren')) {
                return;
            }

            // Import via bulk API endpoint
            const importPayload = {
                shifts: shiftsToImport,
                availability: availabilityToImport,
                ...(settingsToImport ? { settings: settingsToImport } : {}),
                users: usersToImport.map(emp => ({
                    name: emp.name || 'Onbekend',
                    email: emp.email || null,
                    mainTeam: emp.mainTeam || null,
                    contractHours: Number(emp.contractHours) || 0,
                    active: emp.active !== false,
                    weekScheduleWeek1: Array.isArray(emp.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [],
                    weekScheduleWeek2: Array.isArray(emp.weekScheduleWeek2) ? emp.weekScheduleWeek2 : [],
                    weekSchedules: Array.isArray(emp.weekSchedules) ? emp.weekSchedules : [
                        Array.isArray(emp.weekScheduleWeek1) ? emp.weekScheduleWeek1 : [],
                        Array.isArray(emp.weekScheduleWeek2) ? emp.weekScheduleWeek2 : []
                    ]
                }))
            };

            const result = await dataApiFetch('/import', {
                method: 'POST',
                body: JSON.stringify(importPayload)
            });

            let message = `${result.results.imported} items geïmporteerd`;
            if (result.results.skipped > 0) {
                message += `, ${result.results.skipped} items overgeslagen`;
            }
            showToast(message, 'success');

            if (result.results.errors && result.results.errors.length > 0) {
                console.error('Import fouten:', result.results.errors);
                showToast(`${result.results.errors.length} fouten opgetreden bij import. Niet alle items konden worden verwerkt.`, 'warning');
            }

            // Reload page to show new data
            location.reload();
        } catch (error) {
            console.error('Import error:', error);
            showToast('Fout bij importeren: ' + getUserFriendlyError(error), 'error');
        }
    };

    reader.onerror = (error) => {
        console.error('FileReader error:', error);
        showToast('Fout bij lezen van bestand', 'error');
    };

    reader.readAsText(file);
    // Reset file input zodat hetzelfde bestand opnieuw gekozen kan worden
    event.target.value = '';
}

// Make functions available globally for inline onclick handlers
window.openAvailabilityModal = openAvailabilityModal;
window.closeAvailabilityModal = closeAvailabilityModal;
window.handleAvailabilitySave = handleAvailabilitySave;
window.handleRemoveAbsence = handleRemoveAbsence;
window.handleRemoveClosedDate = handleRemoveClosedDate;
window.openAddClosedDateDialog = openAddClosedDateDialog;

