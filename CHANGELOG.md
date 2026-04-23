# CHANGELOG

Alle noemenswaardige wijzigingen worden hier bijgehouden.
Format: [Keep a Changelog](https://keepachangelog.com/nl/1.0.0/)

---

## [Unreleased]

---

## [1.3.0] — 2026-04-23

### Refactor
- **app.js opsplitsing** (issue #25): `frontend/app.js` (13.136 regels) vervangen door 14 afzonderlijke modules. Geen ES6 modules of build stap — alle functies blijven globaal, laadvolgorde in `index.html` beheert dependencies.

### Nieuwe bestanden
| Bestand | Doel |
|---------|------|
| `app-globals.js` | AppState, constanten, UndoManager, DOM object, IconHelper |
| `app-permissions.js` | Rol-checks en permissiefuncties |
| `app-ui.js` | Toast, modals, FocusTrap, tooltips, overlays |
| `app-auth.js` | Login, logout, sessiecheck, rolevisibility |
| `app-nav.js` | Navigatie, switchView, renderHome, week/maand/dag helpers |
| `app-planner.js` | renderPlanning, timeline, maand, heatmap, validatiemeldingen |
| `app-shifts.js` | Shift modals, swap modals, shift CRUD, activiteiten |
| `app-swaps.js` | renderSwaps, swap- en overnamekaartenrendering |
| `app-employees.js` | renderEmployees, profiel, medewerker CRUD, weekrooster |
| `app-availability.js` | renderAvailability, afwezigheidsmodal |
| `app-builder.js` | Roosterbouwer: grid, concepten, vergaderingen, staffing |
| `app-settings.js` | renderSettings, alle instellingstabs |
| `app-admin.js` | Export/import, debug, migratie, sanitize |
| `app-init.js` | initDOM, setupEventListeners, init(), DOMContentLoaded entry |

---

## [1.2.0] — 2026-04-23

### Toegevoegd
- **API versioning** (issue #28): Alle 63 backend endpoints zijn nu bereikbaar via `/api/v1/<pad>`. Frontend gebruikt automatisch het nieuwe pad via `window.API_BASE` in `config/settings.js`.

### Backward-compat
- Oude routes zonder prefix (bijv. `/shifts`, `/auth/login`) blijven tijdelijk werken via een backward-compat alias. Deze alias wordt verwijderd in v1.3.

### Technisch
- `server.js`: alle routes verplaatst naar een `express.Router()` gemonteerd op `/api/v1/`. Middleware (helmet, cors, rate limiter) blijft op `app`-niveau.
- `config/settings.js`: `window.API_BASE` bevat nu `/api/v1` suffix — nul andere frontend-wijzigingen nodig.
- Alle 8 supertest-aanroepen in `api.test.js` bijgewerkt naar `/api/v1/` paden.

---

## [1.1.1] — 2026-04-22

### Gefixt
- **Settings 403 voor medewerkers**: `GET /settings` was onterecht beperkt tot admin/roosterverantwoordelijke. Medewerkers kregen 403 waardoor team-kleuren en -namen niet laadden en op defaults bleven staan.
- **Vergadering badges verdwijnen na refresh** (issue #31): Twee samenhangende bugs in de roosterbouwer save-logica:
  1. Teamfilter-wijziging resette `AppState.builderMeetings = {}` zonder `builderIsDirty = true` te zetten — volgende auto-save schreef lege meetings naar DB.
  2. Conditionele write (`if Object.keys(...).length > 0`) sloeg `_teamMeetings` over bij lege state, waardoor de bestaande DB-waarde onterecht werd overschreven met een grid zónder meetings-sleutel.

### Verbeterd
- **Fetch-wrappers geünificeerd** (issue #26): `apiFetch()` in `app.js` verwijderd, alle 16 aanroepen gemigreerd naar `dataApiFetch()` in `data.js`. Één bron van waarheid voor JWT-token (sessionStorage).

### Technisch
- `AppState.builderMeetings` wordt niet langer gereset bij teamfilter-wijziging (meetings horen bij draft, niet bij filter).
- `_teamMeetings` wordt nu altijd geschreven in alle 4 save-paden (auto-save, bestaand concept, nieuw concept, save-as), ook wanneer `{}`.
- 129 backend tests — geen wijzigingen in backend.

---

## [1.1.0] — 2026-04-22

### Toegevoegd
- **Belgische feestdagen**: 10 officiële feestdagen automatisch berekend via Gregoriaans Computus-algoritme. Zichtbaar als rode kolomkoppen in timeline- en maandweergave met tooltip (naam feestdag) en `calendar-check` icoon. Puur visueel — shifts kunnen gewoon aangemaakt worden.
- **Manuele sluitingsdagen**: admin/roosterverantwoordelijke kan individuele datums sluiten (brugdagen, uitzonderingen) via rechtsklik op een dag-header. Ondersteunt optionele reden. Gesloten dagen blokkeren shift aanmaken, drag-drop en worden overgeslagen bij toepassen van concepten.
- Waarschuwingsdialoog bij sluiten van een dag met bestaande shifts: keuze om shifts mee te verwijderen of te behouden.
- Instellingen → Planning: nieuw overzicht "Manueel gesloten datums" met verwijderknop en "+ Datum toevoegen".
- Nieuw backend endpoint: `GET /public-holidays?year=YYYY` — retourneert de 10 Belgische feestdagen voor een jaar (geen auth vereist).
- `POST /shifts` valideert nu server-side of de datum manueel gesloten is.
- `POST /schedule-drafts/:id/apply` slaat manueel gesloten datums over bij genereren van shifts.

### Technisch
- `utils.js`: `getEasterDate()` + `getBelgianPublicHolidays()` toegevoegd en geëxporteerd
- `data.js`: public holiday cache in `DataStore._publicHolidaysCache` met pre-warm (huidig jaar ±1); `isDayClosed()` uitgebreid met manuele sluitingscheck; `addClosedDate()` / `removeClosedDate()` / `getClosedDateInfo()`
- 129 backend tests (was 117) — 20 nieuwe tests voor Pasen-berekening en feestdagenlijst

---

## [1.0.1] — 2026-04-15

### Toegevoegd
- Modal focus trap (FocusTrap utility via MutationObserver)
- Swap modal: pre-check of collega's ruilbare shifts hebben
- Login pagina: "Wachtwoord vergeten?"-melding
- Accounts aanmaken zonder e-mailadres (e-mail optioneel)
- Welkomstmail wordt automatisch gestuurd zodra een e-mail voor het eerst wordt ingesteld
- "Geen email" badge op medewerkerkaarten voor accounts zonder e-mailadres
- Contracturen zichtbaar en bewerkbaar op de profiel-pagina (admin/roosterverantwoordelijke)

### Gefixt
- Mobiel menu z-index (dropdown viel achter planning content)
- Role-switcher verborgen in productie (alleen localhost)
- Stale ruilverzoeken blijven open staan na verlopen shiftdatum (#30)
- Shifts tijdens vakantie worden niet verwijderd bij toepassen vakantie-concept (#34)
- shift_activities worden nu mee verwijderd bij shift delete (#35)
- Contracturen niet meer instelbaar in UI (#29)
- FK constraints hersteld: shift_blocks.created_by en swap_requests.responded_by ON DELETE SET NULL
- Hardcoded credentials verwijderd uit alle bronbestanden (CONTRIBUTING.md, CLAUDE.md, DEPLOY.md)
- Plaintext wachtwoorden verwijderd uit welkomst- en reset-emails
- /admin/debug endpoint verwijderd (exposeerde systeeminformatie)
- GET /settings beveiligd met role-check

### Verbeterd
- 40+ inline `style.display` toggles → `classList.hidden`
- Onboarding checklist: beschrijvende hints bij stappen
- Reset data: dropdown keuze (data / data+accounts / alles behalve eigen account)
- Extra teams verwijderd uit UI (DB kolom behouden)
- Planning filters standaard ingeklapt
- console.log/debug onderdrukt in productie via DEBUG guard (#32)
- 5 ontbrekende database indexes toegevoegd voor query performance

---

## [1.0.0] — 2026-03-21

### Toegevoegd
- Volledige roosterplanning applicatie voor Het Vlot
- Timeline-weergave per medewerker met uurblokken
- Roosterbouwer met visuele grid en drag & drop
- Concepten (schedule drafts): opslaan, laden, toepassen op datumbereik
- Vakantieperiodes met vakantie-specifieke bezettingsnormen
- Shift activiteiten (oudergesprek, vorming, overleg, afspraak)
- Ruilverzoeken en overnameverzoeken met goedkeuringsflow
- Audit log met filters en export
- Email notificaties via Resend (9 trigger points)
- Navigatie herstructurering: avatar dropdown, nav groepen, mobile nav
- Design systeem: tokens, focus-visible, typography scale
- Component standaardisatie en empty states
- Profiel tab redesign: hero header, weekrooster overzicht

### Security (pre-launch audit)
- 25 security/data/crash fixes
- Rate limiting op login + globaal
- CORS strict in productie
- trust proxy voor Render
- JWT secret bijgewerkt, DB wachtwoord gereset
- HTML escaping in email templates

### Technisch
- 208 commits, 10 database tabellen
- Database indexen op alle veelgebruikte kolommen
- Atomische transacties voor replaceEmployee en applyDraft
- CI workflow: syntaxcheck JS + bestandscontrole

---

## Versie schema

- **Patch** (1.0.x): bugfixes, geen breaking changes
- **Minor** (1.x.0): nieuwe features, backward compatible
- **Major** (x.0.0): breaking changes, schema migraties vereist
