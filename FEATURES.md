# Het Vlot Roosterplanning - Feature Roadmap

## ✅ Completed Features

### Authentication & Security
- [x] Login bug fix: Wrong password no longer bypasses authentication
- [x] Session cleanup on failed login
- [x] Guard flags to prevent race conditions
- [x] Database migration: Merged employees table into users table

### Alerts & Notifications ✅ COMPLETED (2025-02-08)
- [x] Ziekte alert: "Bel de personeelsdienst om je ziekte door te geven"
- [x] Verlof/Overuren alert: "Vergeet niet dit ook in Eureka aan te passen"
- [x] Fixed: UI now updates immediately after save/delete (async/await fixes)

### Shift Blocks ✅ COMPLETED (2026-02-09)
- [x] Prevent auto-schedule from regenerating deleted shifts
- [x] Shift blocks table with user_id + date unique constraint
- [x] Manual override: creating manual shift removes block
- [x] System cleanup: skipBlock parameter for bulk operations

### UI/UX Improvements ✅ COMPLETED (2026-02-09)
- [x] Renamed "Verlof" tab to "Verlof en ziekte"
- [x] Removed confusing placeholder text from takeover modal
- [x] Fixed nacht shift overflow on Sunday (truncate at midnight)
- [x] Combined "Ruilen" and "Iemand zoeken" into "Shift afstaan" with choice modal
- [x] Scroll position preservation: Planner no longer jumps to top after drag & drop or changes

### Team Validation ✅ COMPLETED (2026-02-09)
- [x] Validate team assignments with warnings (flexible approach)
- [x] Check against mainTeam and extraTeams
- [x] Clear messaging when employee works for wrong team
- [x] Allow manual override with admin/teamverantwoordelijke approval

### Settings Persistence ✅ COMPLETED (2026-02-09)
- [x] Planning horizon persists across page refreshes
- [x] Team colors save/load from backend database
- [x] Settings table migration for persistent storage
- [x] Team colors apply throughout entire app (incl. timeline blocks)

### Diensten Ruil Systeem ✅ COMPLETED
- [x] Medewerkers kunnen shifts ruilen (swap requests)
- [x] Medewerkers kunnen shifts beschikbaar stellen (takeover requests)
- [x] Approval workflow voor team leads
- [x] Status tracking (pending, approved, rejected, cancelled)
- [x] Auto-create takeover requests bij ziekte/verlof

### Code Cleanup
- [x] Removed email mapping fallback code (post-migration)
- [x] Simplified shift endpoints (50-70% less code)
- [x] Simplified availability endpoints

## 📋 Planned Features

### High Priority
- [ ] **Home/Landing Page**
  - Welcome screen voor nieuwe gebruikers
  - Quick actions dashboard
  - Recent activity overview

- [ ] **Overuren Logica**
  - Automatisch bijhouden van overuren
  - Berekening: uren > contract uren = overuren
  - Saldo weergave per medewerker
  - Export mogelijkheden

- [ ] **Conflict Resolution UI**
  - Wanneer validation faalt, toon oplossingen (niet alleen errors)
  - Suggesties voor conflict oplossing
  - "Fix automatically" opties waar mogelijk

### Low Priority (Nice to Have)
- [ ] **Auto-Extend Planning Horizon**
  - Automatisch shifts genereren wanneer gebruiker navigeert buiten horizon
  - "Genereer shifts voor deze week" knop
  - Infinite scroll / on-demand loading
  - Voorkomt dat medewerkers verdwijnen na X weken

- [ ] **Drag & Drop Shifts** 🚧 IN PROGRESS
  - ✅ Shifts verplaatsen met drag & drop (basis implementatie)
  - ✅ Visuele feedback tijdens slepen
  - ✅ Validation tijdens drop
  - ✅ Resize shift duration
  - ✅ Click empty cell to create shift
  - **Toekomstige uitbreidingen (Future Enhancements):**
    - [ ] Multi-select: Meerdere shifts tegelijk selecteren en verplaatsen
    - [ ] Drag to delete: Shift naar prullenbak zone slepen om te verwijderen
    - [ ] Copy shift: Ctrl+drag om shift te dupliceren
    - [ ] Drag to different date: Shift naar andere datum slepen (niet alleen andere medewerker)
    - [ ] Touch gestures: Swipe bewegingen op mobiel voor shift transfer
    - [ ] Keyboard shortcuts: Pijltjestoetsen om geselecteerde shift te verplaatsen
    - [ ] Batch operations: Meerdere shifts selecteren, actie toepassen op allen

- [ ] **Team Coverage Heatmap**
  - Visuele weergave van team bezetting
  - Kleur-gecodeerd (te weinig/genoeg/te veel personeel)
  - Per dag/shift type overzicht
  - Waarschuwingen bij onder-bezetting

- [ ] **Undo/Redo**
  - Action history stack
  - Ctrl+Z / Ctrl+Y ondersteuning
  - Beperkt tot X laatste acties
  - Werkt voor shifts, availability, accounts

- [ ] **Audit Log**
  - Track who changed what and when
  - Zichtbaar voor hoofdverantwoordelijke/admin
  - Filterbaar per medewerker/datum/actie type
  - Export naar CSV

- [ ] **Auto-Scheduling Suggestions**
  - AI-gestuurde shift suggesties
  - Gebaseerd op beschikbaarheid + voorkeuren
  - Rekening houdend met contracturen
  - "Apply suggestion" functie

## 🚀 Implementation Strategy

**Aanpak: One Feature at a Time**
- Plan elke feature grondig voordat implementatie
- Volledige testing voordat verder gaan
- Incrementele releases
- User feedback verzamelen na elke release

**Prioriteit Categorieën:**
1. **Alerts** ✅ - Voltooid
2. **Shift Blocks** ✅ - Voltooid
3. **Diensten Ruil Systeem** ✅ - Voltooid
4. **Team Validation** ✅ - Voltooid
5. **Settings Persistence** ✅ - Voltooid
6. **Overuren Logica** 📋 - Volgende
7. **UX Improvements** 📋 - Drag&drop, undo/redo, etc.

## 📝 Notes

- Alle features worden één voor één geïmplementeerd
- Testing is verplicht voordat feature als "done" gemarkeerd wordt
- Code reviews gebeuren via commits
- Breaking changes worden duidelijk gecommuniceerd

## ❌ Cancelled Features

### Maand View ❌ CANCELLED
- Geprobeerd maar werkte niet goed voor de use case
- Week view blijft de primaire planning interface

## 🔄 Feature Status Legend

- ✅ **Completed**: Geïmplementeerd, getest, en gepusht
- 🚧 **In Progress**: Momenteel in ontwikkeling
- 📋 **Planned**: Nog niet gestart
- ⏸️ **On Hold**: Tijdelijk uitgesteld
- ❌ **Cancelled**: Niet meer relevant

## 📅 Last Updated

2026-02-09 - Added shift blocks, UI improvements, team validation, settings persistence, drag & drop (in progress with future enhancements documented)
