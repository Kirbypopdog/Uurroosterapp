// ===== GECENTRALISEERDE SETTINGS =====
// Deze file is de centrale plek voor alle standaard instellingen.

window.API_BASE = window.API_BASE || 'http://localhost:3001';

window.DEFAULT_SETTINGS = {
    // Referentie datum voor bi-weekly rooster (Week 1 begint op deze maandag)
    // Dit is de referentie: maandag 6 januari 2025 = Week 1
    // Week 1 = weekend GESLOTEN (vrijdag 18:00 tot maandag 7:30)
    // Week 2 = weekend OPEN
    biWeeklyReferenceDate: '2025-01-06',

    // Planning regels
    rules: {
        minHoursBetweenShifts: 11,
        minStaffingDay: 1, // Minimum 1 persoon overdag per team
        minStaffingNight: 1, // Minimum 1 persoon 's nachts totaal
    },
    // Dienst templates
    shiftTemplates: {
        vroeg: { start: '07:30', end: '16:00', name: 'Vroege dienst' },
        laat: { start: '16:00', end: '23:00', name: 'Late dienst' },
        nacht: { start: '23:00', end: '09:00', name: 'Nachtdienst' },
        lang: { start: '09:00', end: '21:00', name: 'Lange dienst' }
    },
    // Teams configuratie
    teams: {
        vlot1: { name: 'Vlot 1 (Begeleiding)', color: '#3b82f6' },
        vlot2: { name: 'Vlot 2 (Begeleiding)', color: '#8b5cf6' },
        cargo: { name: 'Cargo (Dagbesteding)', color: '#10b981' },
        overkoepelend: { name: 'Overkoepelend (Kantoor)', color: '#f59e0b' },
        jobstudent: { name: 'Jobstudenten/Stagiairs', color: '#ec4899' }
    },
    // Vakantieperiodes
    holidayPeriods: [],
    // Vakantie regels (Vlot 1 + Vlot 2 worden samengevoegd)
    holidayRules: {
        minStaffingDay: 2,   // Minimum bezetting overdag tijdens vakantie (Vlot 1+2 samen)
        minStaffingNight: 1  // Minimum bezetting nacht tijdens vakantie
    },
    // Weekend/vakantie verantwoordelijke rotatie
    responsibleRotation: {
        // Teams die in aanmerking komen
        eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
        // Handmatige toewijzingen per week (key = maandag datum van de week)
        assignments: {}
        // Voorbeeld: { '2026-01-19': employeeId }
    }
};
