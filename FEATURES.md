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

- [ ] **Maand View**
  - Maandoverzicht naast bestaande week view
  - Compacte weergave van hele maand
  - Navigatie tussen weken/maanden

### Medium Priority
- [ ] **Diensten Ruil Systeem**
  - Medewerkers kunnen shifts met elkaar ruilen
  - Approval workflow (teamverantwoordelijke/hoofdverantwoordelijke)
  - Notificaties bij ruil verzoeken
  - Voorwaarden: zelfde team, zelfde functie, etc.

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

- [ ] **Drag & Drop Shifts**
  - Shifts verplaatsen met drag & drop
  - Visuele feedback tijdens slepen
  - Validation tijdens drop
  - Undo optie na drop

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
2. **Views** - Maand view (volgende)
3. **Shift Management** - Ruilen, overuren
4. **UX Improvements** - Drag&drop, undo/redo, etc.

## 📝 Notes

- Alle features worden één voor één geïmplementeerd
- Testing is verplicht voordat feature als "done" gemarkeerd wordt
- Code reviews gebeuren via commits
- Breaking changes worden duidelijk gecommuniceerd

## 🔄 Feature Status Legend

- ✅ **Completed**: Geïmplementeerd, getest, en gepusht
- 🚧 **In Progress**: Momenteel in ontwikkeling
- 📋 **Planned**: Nog niet gestart
- ⏸️ **On Hold**: Tijdelijk uitgesteld
- ❌ **Cancelled**: Niet meer relevant

## 📅 Last Updated

2025-02-08 - Added alert features (ziekte + verlof/overuren)
