# CHANGELOG

Alle noemenswaardige wijzigingen worden hier bijgehouden.
Format: [Keep a Changelog](https://keepachangelog.com/nl/1.0.0/)

---

## [Unreleased]

---

## [1.4.0] — 2026-04-29

### Toegevoegd
- **Urendashboard voor medewerkers** (issue #75): Eigen profiel toont nu week- en periodeuren als voortgangsbalk met kleurcodering (rood = boven norm, oranje = onder norm). Periodeberekening op basis van vaste 4-weken-periodes verankerd aan het schooljaar.
- **Proactieve waarschuwingen op dashboard** (issue #80): De homepagina toont nu contextgevoelige alerts — medewerkers zien openstaande ruilverzoeken en komende shiften, beheerders zien onderbezette dagen en aflopende periodes.
- **Week kopiëren in roosterbouwer** (issue #71): Knop om een ingevulde week te dupliceren naar een volgende week binnen een multi-week concept. Conflicten worden gedetecteerd en getoond voor de kopie wordt uitgevoerd.
- **Live validatie tijdens slepen in builder** (issue #70): Terwijl een shift gesleept wordt in de roosterbouwer verschijnt de doelcel rood (11-uur schending), oranje (waarschuwing) of groen (ok). Bij neerleggen toont een toast de reden — de plaatsing wordt nooit geblokkeerd.
- **Teamvolgorde drag-and-drop** (issue #101): Teams in de instellingentab zijn nu herordend met drag-and-drop. Volgorde wordt opgeslagen en doorgestuurd naar alle weergaven die `getTeamOrder()` gebruiken.
- **Concept-vergelijking (diff-view)** (issue #72): Twee roosterconcepten naast elkaar vergelijken via "Vergelijk concepten"-knop in het conceptenoverzicht. Gewijzigde, nieuwe en verwijderde diensten worden visueel onderscheiden.
- **Data-archivering** (issue #66): Shifts ouder dan 12 maanden worden automatisch gearchiveerd bij serverstart (`archived = true`). De planning laadt enkel actieve shifts. Beheerders kunnen gearchiveerde shifts raadplegen via `GET /shifts/archived`.

### Verbeterd
- **Genummerd migratiesysteem** (issue #88): `ensureSchema()` vervangen door een geversioned migratiesysteem met een `migrations`-tabel in de database. 29 genummerde migraties (000–028 + 029 voor archivering). Idempotent, transactioneel, terugwaarts compatibel.
- **Testdekking uitgebreid** (issue #65 + #83): Van 138 naar 194 tests. Nieuwe tests voor concept-toepassen, beschikbaarheid, ruilverzoeken en 15 edge cases voor frontend tijdvalidatie.
- **app-builder.js opgesplitst** (issue #67): Het bestand van 3065 regels is opgesplitst in drie bestanden: `app-builder.js` (~1575 regels, kernlogica), `app-builder-editors.js` (~298 regels, staffing/vergaderingen/waarschuwingen), `app-builder-drafts.js` (~1403 regels, concept-CRUD en vergelijking).
- **Informatieteksten herzien** (issue #98): Diverse labels, placeholders en foutmeldingen in de UI gelijkgetrokken: "Ongeldige datum range" → "Ongeldig datumbereik", "Bijv:" → "Bijv.", undo/redo knoppen vertaald naar "Ongedaan"/"Opnieuw", swap-placeholder verduidelijkt.

### Gefixt
- **shift_activities cascade** (issue #86): Activiteiten van een shift werden ook verwijderd bij verwijderen van een andere shift. Opgelost via expliciete `shift_id` FK-constraint met `ON DELETE CASCADE`.
- **Email wijzigen beperkt tot admin** (issue #94): Roosterverantwoordelijken konden het eigen e-mailadres aanpassen. Alleen admins mogen e-mailadressen van andere accounts wijzigen.
- **Medewerkers kunnen shifts van anderen bewerken** (issue #92 + #93): Frontend-check aangescherpt — shift-klikken en bewerkmodals zijn nu volledig geblokkeerd voor shifts die niet van de ingelogde medewerker zijn.
- **Shifts niet zichtbaar na reload** (issue #91): Bij herlogin of harde refresh bleven shifts weg tot de eerste navigatieactie. Opgelost door de initialisatievolgorde aan te passen.
- **POST /shifts/bulk validatie** (issue #90): Bulk shift aanmaken riep `validateShiftRules()` niet aan. Validatie nu ook actief op het bulk-endpoint.
- **PUT /shifts sluitingsdagencheck** (issue #87): Shift wijzigen controleerde niet of de doeldatum manueel gesloten was. Check toegevoegd.
- **Basisrooster urentotaal** (issue #96): Periodeuren berekend met factor 4.33 (maanden) in plaats van 4 (vaste 4-weken-periodes). Gecorrigeerd naar `contractHours × 4` consistent met de schooljaar-logica.
- **Nachtshift basisrooster** (issue #97): Nachtshift in het basisrooster eindigde op dezelfde dag i.p.v. de volgende. Datum-rollover nu correct toegepast.

### UX
- **Maanduren verborgen op mobiel** (issue #95): Het uren-totaal per periode werd ook op kleine schermen getoond en veroorzaakte layout-problemen. Nu enkel zichtbaar vanaf `min-width: 600px`.
- **Navigatie opgeschoond** (issue #99): Onnodige scheidingslijn in de navigatiebalk verwijderd, uitlijning gelijkgetrokken.
- **Instellingen in hoofdmenu** (issue #100): Instellingen verplaatst van het avatar-dropdown naar het hoofdmenu. Avatar-dropdown toont nu "Profiel" als primaire actie.

---

## [1.3.2] — 2026-04-23

### Refactor
- **Inline styles fase 3** (issue #39): Resterende statische inline styles in `app-builder.js`, `app-shifts.js` en `app-nav.js` gemigreerd naar CSS klassen. Dynamische waarden (berekende posities, teamkleuren, progress percentages) blijven inline — dat is de verwachte uitzondering.

---

## [1.3.1] — 2026-04-23

### Toegevoegd
- **Email configuratie UI** (issue #37): Nieuw kaartje in de e-mailinstellingen toont of Resend correct is geconfigureerd (API-sleutel aanwezig), het afzendadres en een knop om een testmail te sturen naar het admin-account. Endpoint `GET /admin/email-status` en `POST /admin/test-email` toegevoegd.

### Verbeterd
- **Save-patroon consistentie** (issue #36): Instellingstabs tonen nu een *"● Niet opgeslagen"* badge naast de opslaan-knop zolang er niet-opgeslagen wijzigingen zijn. Teamkleur opslaan toont een succestoast na bewaren.
- **Inline styles → CSS-klassen** (issue #39): 43 resterende inline stijlen in `app-settings.js` en `app-employees.js` vervangen door CSS-klassen (`settings-dirty-indicator`, `quick-dialog`, `contract-hours-input`, `closed-dates-list`, `closed-date-item`, `migration-zone`, e.a.).

### Gefixt
- **11-uur check over weekgrens** (issue #43): `getShiftEndDateTime()` vergeleek alleen het uur van de eindtijd met dat van de starttijd. Bij een zelfde uur maar vroeger minuut (bijv. 22:30 → 22:00) werd het einduur foutief op dezelfde dag gezet. Nu wordt de volledige datum+tijd vergeleken (`endDT < startDT`).

---

## [1.3.0] — 2026-04-23

### Toegevoegd
- **Basisrooster profiel gekoppeld aan actief concept** (issue #59): Het profiel leest het basisrooster nu uit het actieve basisconcept (`lastAppliedFrom ≤ vandaag ≤ lastAppliedUntil`) in plaats van het statische `week_schedules`-veld. Bij een actief concept toont een badge de naam van het concept. Vakantieconcepten worden genegeerd. Fallback naar `week_schedules` als er geen actief concept is.

### Gefixt
- **Afwezigheid-tab permissie** (issue #60): Medewerkers konden afwezigheid van teamgenoten invullen. Cellen van andere medewerkers zijn nu niet klikbaar en gestyled als `readonly-cell`. Backend-check bestond al.
- **Email hoofdlettergevoeligheid**: Login, accountbeheer en profielbewerking behandelden e-mailadressen als hoofdlettergevoelig. E-mailadressen worden nu altijd als kleine letters opgeslagen en vergeleken. Bestaande hoofdlettervarianten worden genormaliseerd bij de eerstvolgende serverstart via een idempotente migratie.

### Performance
- **N+1 query in `applyDraft` opgelost** (issue #27): Het toepassen van een concept deed voorheen ~260 DB-queries (DELETE + 2× SELECT + INSERT per medewerker). Nu 4 queries ongeacht het aantal medewerkers: bulk DELETE, bulk SELECT shifts, bulk SELECT afwezigheid, bulk INSERT.

---

## [1.2.0] — 2026-04-23

### Toegevoegd
- **API versioning** (issue #28): Alle 63 backend endpoints zijn nu bereikbaar via `/api/v1/<pad>`. Frontend gebruikt automatisch het nieuwe pad via `window.API_BASE` in `config/settings.js`.

### Refactor
- **app.js opsplitsing** (issue #25): `frontend/app.js` (13.136 regels) vervangen door 14 afzonderlijke modules. Geen ES6 modules of build stap — alle functies blijven globaal, laadvolgorde in `index.html` beheert dependencies.

### Backward-compat
- Oude routes zonder prefix (bijv. `/shifts`, `/auth/login`) blijven tijdelijk werken via een backward-compat alias. Deze alias wordt verwijderd in v1.3.

### Technisch
- `server.js`: alle routes verplaatst naar een `express.Router()` gemonteerd op `/api/v1/`. Middleware (helmet, cors, rate limiter) blijft op `app`-niveau.
- `config/settings.js`: `window.API_BASE` bevat nu `/api/v1` suffix — nul andere frontend-wijzigingen nodig.
- Alle 8 supertest-aanroepen in `api.test.js` bijgewerkt naar `/api/v1/` paden.
- Nieuwe frontend-modules: `app-globals.js`, `app-permissions.js`, `app-ui.js`, `app-auth.js`, `app-nav.js`, `app-planner.js`, `app-shifts.js`, `app-swaps.js`, `app-employees.js`, `app-availability.js`, `app-builder.js`, `app-settings.js`, `app-admin.js`, `app-init.js`

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
