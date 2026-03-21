// ===== GECENTRALISEERDE SETTINGS =====
// Deze file is de centrale plek voor alle standaard instellingen.

// Automatisch detecteren: lokaal = localhost, productie = Render URL
// Ook file:// protocol wordt als lokaal gezien (voor development)
if (window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:') {
    window.API_BASE = 'http://localhost:3001';
} else {
    window.API_BASE = 'https://uurrooster-app.onrender.com';
}

window.DEFAULT_SETTINGS = {
    // Referentie datum voor bi-weekly rooster (backward compat)
    biWeeklyReferenceDate: '2025-01-06',

    // Flexibel roosterpatroon - vervangt de hardcoded bi-weekly logica
    // cycleLength: aantal weken in de cyclus (1 = wekelijks, 2 = bi-weekly, 3 = tri-weekly, ...)
    // weeks: per weeknummer de gesloten dagen (JS dayOfWeek: 0=zo, 1=ma, ..., 6=za)
    schedulePattern: {
        cycleLength: 2,
        referenceDate: '2025-01-06',
        weeks: {
            "1": { closedDays: [6, 0], label: "Weekend gesloten" },
            "2": { closedDays: [], label: "Weekend open" }
        }
    },

    // Planning horizon - hoe ver vooruit worden automatische diensten gegenereerd
    planningHorizon: {
        weeks: 4 // 4 weken vooruit (kan ook 8, 26, 52 of null voor onbeperkt)
    },
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
    // Teams die meetellen voor bezettingsnormen (heatmap)
    // Cargo, Overkoepelend en Jobstudenten tellen standaard niet mee
    coverageTeams: ['vlot1', 'vlot2'],
    // Vakantieperiodes
    holidayPeriods: [],
    // Vakantie regels (Vlot 1 + Vlot 2 worden samengevoegd)
    holidayRules: {
        minStaffingDay: 2,   // Minimum bezetting overdag tijdens vakantie (Vlot 1+2 samen)
        minStaffingNight: 1  // Minimum bezetting nacht tijdens vakantie
    },
    // Teamvergaderingen: per team een lijst van vaste vergadermomenten
    // day: 0=Ma..6=Zo, from/to: decimale uren (9.5 = 9:30)
    teamMeetings: {},
    // Weekend/vakantie verantwoordelijke rotatie
    responsibleRotation: {
        // Teams die in aanmerking komen
        eligibleTeams: ['vlot1', 'vlot2', 'cargo'],
        // Handmatige toewijzingen per week (key = maandag datum van de week)
        assignments: {}
        // Voorbeeld: { '2026-01-19': employeeId }
    }
};
