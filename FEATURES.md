# Het Vlot Roosterplanning — Features v1.1.0

## Rooster & Planning

### Weekoverzicht (Planning tab)
- Timeline-weergave per medewerker met uurblokken
- Week navigatie met datum header
- Filter op team (multi-select)
- Zoeken op medewerker naam
- Scroll positie behouden bij wijzigingen
- Mobiele dagweergave met swipe navigatie

### Rooster Bouwen (Builder)
- Visuele grid: medewerkers x dagen
- Klik op cel om dienst toe te wijzen (template of handmatig)
- Drag & drop shifts in het grid
- Bezettings-heatmap per uur/dag (kleurgecodeerd)
- 11-uur regel waarschuwingen in het grid
- Teamvergaderingen markeren per dag
- Contracturen weergave per medewerker
- Multi-week support (week 1/2/3...)

### Concepten (Schedule Drafts)
- Rooster opslaan als concept
- Concept opslaan / opslaan als nieuw
- Concept toepassen op datumbereik (van/tot)
- Overlap detectie met bestaande concepten
- Handmatige shifts behouden of overschrijven
- Status tracking: Actief / Ingepland / Verlopen / Overschreven
- Concept exporteren als JSON

### Schooljaar & Vakantie
- Automatische weeknummering sept-aug (week 1-52/53)
- Vakantieperiodes definieerbaar met naam en datums
- Vakantie-specifieke bezettingsnormen (Vlot 1+2 samengevoegd)
- Vakantie-concepten apart van reguliere concepten
- Quick-select knoppen voor Belgische schoolvakanties

### Feestdagen & Sluitingsdagen
- **Belgische feestdagen** automatisch berekend voor elk jaar (Gregoriaans Computus)
- Feestdagen rood gemarkeerd in timeline- en maandweergave met tooltip en icoon
- **Manuele sluitingsdagen**: rechtsklik op dag → "Dag sluiten" met optionele reden
- Gesloten dagen blokkeren shift aanmaken en drag-drop
- Bij sluiten dag met bestaande shifts: keuze om shifts mee te verwijderen of te behouden
- Overzicht en beheer van sluitingsdagen in Instellingen → Planning
- Basisrooster/concepten slaan manueel gesloten datums automatisch over

### Shift Templates
- 4 standaard templates: Vroeg, Laat, Nacht, Lang
- Aanpasbare start/eindtijden
- Icoon selectie per template (sunrise, sun, sunset, moon)
- Templates toevoegen/bewerken/verwijderen

### Drag & Drop (Planningsweergave)
- Shifts slepen tussen medewerkers
- Visuele feedback tijdens slepen
- Validatie bij drop (11-uur, overlap, team)
- Shift block aangemaakt bij verwijdering

---

## Medewerkers & Teams

### Teams
- 5 teams: Vlot 1, Vlot 2, Cargo, Overkoepelend, Jobstudenten
- Configureerbare teamkleuren (doorwerking in hele app)
- Flexibel roosterpatroon per team (bi-weekly, etc.)
- Gesloten dagen per week instelbaar

### Medewerkers
- Profiel met naam, e-mail (optioneel), rol, team, contracturen
- Hoofd-team + extra teams
- Vast werkrooster (basisrooster) per week
- Actief/inactief status
- Medewerker vervangen: kopieer basisrooster + optioneel shifts/blocks/activities
- Accounts aanmaken zonder e-mail: rooster bouwen, e-mail later toevoegen
- "Geen email" badge op medewerkerkaart als herinnering

### Rollen & Permissies
| Rol | Planning | Medewerkers | Settings | Accounts |
|-----|----------|-------------|----------|----------|
| Admin | Alles | Alles | Alles | Alles |
| Roosterverantwoordelijke | Alles | Alles | Alles | Geen |
| Medewerker | Eigen bekijken | Eigen profiel | Geen | Geen |

---

## Afwezigheid

### Types
- Verlof
- Ziekte
- Overuren
- Opleiding

### Functies
- Per dag registreren met reden
- Bulk ziekmelding (datumbereik) met auto-takeover verzoeken
- Alert bij ziekte: "Bel de personeelsdienst"
- Alert bij verlof/overuren: "Vergeet niet Eureka aan te passen"
- Conflict waarschuwing bij shift op afwezige dag

---

## Ruilen & Overname

### Ruilverzoeken (Swap)
- Medewerker selecteert eigen shift + collega's shift
- Doelpersoon accepteert of weigert
- Bij acceptatie: shifts worden atomisch gewisseld
- Ownership verificatie: shifts mogen niet hertoegewezen zijn

### Overnameverzoeken (Takeover)
- Shift beschikbaar stellen voor teamgenoten
- Elk teamlid kan accepteren
- Originele eigenaar wordt genotificeerd
- Shift behoudt origineel team

### Workflow
- Status: pending → approved / rejected / cancelled / expired
- FOR UPDATE locks tegen race conditions
- Auto-expire bij verlopen shiftdatum
- Annuleren door aanvrager mogelijk

---

## Bezetting & Validatie

### Heatmap
- Bezetting per uur per dag (kleurgecodeerd: rood/geel/groen)
- Configureerbaar welke teams meetellen
- Toggle aan/uit in planningsweergave

### Validatieregels
- **11-uur regel**: minimum rust tussen diensten
- **Shift overlap**: geen dubbele shifts voor 1 persoon
- **Max opeenvolgende dagen**: standaard 6 (instelbaar)
- **Minimum bezetting**: dag en nacht apart (instelbaar)
- **Cross-team waarschuwing**: shift buiten hoofd/extra team
- **Nachtdienst logica**: correcte datum bij middernacht-overgang

---

## Activiteiten

- Activiteiten binnen shifts: oudergesprek, vorming, overleg, afspraak, andere
- CRUD via dedicated endpoints
- Gekleurde chips op timeline blokken
- Start/eindtijd per activiteit

---

## Admin & Instellingen

### Audit Log
- Volledige history: wie heeft wat wanneer gewijzigd
- Filter op actie type, resource type, persoon
- Datum groepering met standaard 7 dagen
- Systeem-acties filter
- Export mogelijkheid

### Undo/Redo
- Ctrl+Z / Ctrl+Y voor shift operaties
- Max 50 acties in history stack
- Toolbar knoppen

### Data Management
- JSON export van alle data
- JSON import (via app of CLI)
- Backup/restore functionaliteit

### Email Notificaties (Resend)
- 9 trigger points: swap aangemaakt, takeover beschikbaar, ziekmelding, goedgekeurd, afgewezen, overname geaccepteerd, geannuleerd, welkom, wachtwoord reset
- Welkomstmail automatisch verstuurd zodra e-mail voor het eerst aan een account wordt toegevoegd
- Fire-and-forget (niet-blokkerend)
- Opt-out per gebruiker
- Graceful degradatie zonder API key
- HTML templates met escaping

### Overige Settings
- Planning horizon (weken vooruit)
- Team kleuren
- Bezettingsteams selectie
- Weekend/vakantie verantwoordelijke rotatie
- Vakantieperiodes
- Onboarding checklist voor nieuwe gebruikers

---

## Technische Kenmerken

### Security (v1.0)
- JWT auth met active-user check bij elk request
- Type-safe permission checks (Number() vergelijking)
- Parameterized SQL queries (geen string concatenation)
- HTML escaping in email templates
- Role-based access op alle endpoints
- Rate limiting (login + globaal)
- CORS restrictie in productie
- Geen error detail/stack trace leaks

### Performance
- DataStore als centrale cache met granulaire refreshes
- Loading overlay per view
- Date-filtered shift queries met merge-strategie
- Database indexes op veelgebruikte kolommen

### Architectuur
- Vanilla JS frontend — geen framework, geen build stap
- Single server.js met alle endpoints
- Auto-migratie via ensureSchema() bij elke startup
- Transacties voor kritieke multi-step operaties
- Atomic draft-apply met overlap detectie

---

## Versie Historie

### v1.1.0 — 2026-04-22 (huidige release)
- Belgische feestdagen automatisch berekend en visueel gemarkeerd
- Manuele sluitingsdagen (brugdagen) met rechtsklik-contextmenu
- Zie CHANGELOG.md voor volledig overzicht

### v1.0.1 — 2026-04-15
- Stabilisatie-patch: bugfixes, security hardening, email optioneel
- Zie CHANGELOG.md voor volledig overzicht

### v1.0 — 2026-03-21
- Volledige roosterplanning applicatie
- 208 commits, 10 database tabellen
- Deep-dive security audit: 25 fixes doorgevoerd
- Productie deployment op Render

### Ontwikkeling
- Gestart: januari 2025
- Ontwikkeld met AI-assistentie (Claude Code)
- 6 feature fases: Quick wins → Activiteiten → Vervang medewerker → Schooljaar/Drafts → Vakantie → Regels/Builder UI
