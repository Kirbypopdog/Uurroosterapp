# Het Vlot Roosterplanning

Shift planning web app voor Het Vlot. Medewerkers kunnen roosters bekijken, shifts ruilen, verlof aanvragen. Admins/leads beheren het rooster.

## Quick Start (lokaal)

```bash
# 1. PostgreSQL moet draaien (brew services start postgresql)
# 2. Database aanmaken: createdb uurroosterapp
cd backend
cp .env.example .env          # Pas DATABASE_URL aan
npm install
npm run db:setup              # Schema + seed (admin + teams)
npm run dev                   # Backend op :3001

# 3. Frontend openen in browser:
open ../frontend/index.html
# Login: admin@hetvlot.be / <zie Render dashboard of .env>
```

## Architectuur

- **Frontend**: Vanilla JavaScript - GEEN framework, GEEN build step, GEEN npm
- **Backend**: Node.js + Express, single server.js met alle endpoints
- **Database**: PostgreSQL (Render hosted in productie)
- **Auth**: JWT tokens (7 dagen geldig), bcrypt password hashing

## Bestandsoverzicht

### Frontend (`frontend/`)
| Bestand | Regels | Doel |
|---------|--------|------|
| `app-globals.js` | ~311 | AppState, constanten, UndoManager, DOM object, IconHelper |
| `app-permissions.js` | ~77 | Rol-checks en permissiefuncties |
| `app-ui.js` | ~479 | Toast, modals, FocusTrap, tooltips, overlays |
| `app-auth.js` | ~231 | Login, logout, sessiecheck, rolevisibility |
| `app-nav.js` | ~890 | Navigatie, switchView, renderHome, week/maand/dag helpers |
| `app-planner.js` | ~1330 | renderPlanning, timeline, maand, heatmap, validatiemeldingen, uren-per-naam |
| `app-shifts.js` | ~1105 | Shift modals, swap modals, shift CRUD, activiteiten |
| `app-swaps.js` | ~512 | renderSwaps, swap- en overnamekaartenrendering |
| `app-leave.js` | ~700 | Verlofplanning: rondes, invullen (week/dag), matrix, goedkeuren, export |
| `app-employees.js` | ~1010 | renderEmployees, profiel, medewerker CRUD, weekrooster |
| `app-availability.js` | ~640 | renderAvailability, afwezigheidsmodal |
| `app-builder.js` | ~3065 | Roosterbouwer: grid, concepten, vergaderingen, staffing |
| `app-settings.js` | ~2697 | renderSettings, alle instellingstabs |
| `app-admin.js` | ~380 | Export/import, debug, migratie, sanitize |
| `app-init.js` | ~472 | initDOM, setupEventListeners, init(), DOMContentLoaded entry |
| `data.js` | ~1.840 | DataStore, API fetch wrappers, data loading |
| `validation.js` | ~593 | Business rules: 11-uur regel, overlap, min bezetting |
| `drag-handler.js` | ~1.201 | Drag & drop shifts tussen medewerkers |
| `styles.css` | ~11.250 | Alle CSS inclusief responsive, themas |
| `index.html` | ~800 | HTML markup: modals, formulieren, planning grid |
| `config/settings.js` | ~62 | API URL auto-detect, shift templates, team kleuren |

### Backend (`backend/`)
| Bestand | Doel |
|---------|------|
| `src/server.js` | Alle API endpoints + auto-migratie bij startup |
| `src/db.js` | PostgreSQL connection pool |
| `src/email.js` | Resend email service (9 notificatie types) |
| `src/utils.js` | Pure datumhulpfuncties (`getMonday`, `formatDateYYYYMMDD`, `parseLocalDate`, `getEasterDate`, `getBelgianPublicHolidays`) |
| `sql/schema.sql` | Database schema (bron van waarheid) |
| `scripts/seed.js` | Seed teams + admin account |
| `scripts/setup-db.js` | Voert schema.sql uit |
| `import-backup.js` | CLI tool voor JSON backup import |

### Tests (`backend/tests/`)
| Bestand | Doel |
|---------|------|
| `utils.test.js` | Unit tests voor `src/utils.js` (33 tests) |
| `email.test.js` | Unit tests voor email helpers: `escapeHtml`, `formatDate`, `formatTime`, `shiftDetailBox`, `baseTemplate` (31 tests) |
| `api.test.js` | Integratietests voor API-endpoints — auth, shifts, teams, settings, swap-requests (46 tests) |
| `validation.test.js` | Unit tests voor frontend pure functies in `validation.js` (15 tests) |

## Database Schema

**Tabellen**: teams, users, shifts, availability, settings, shift_blocks, shift_swap_requests, audit_log, schedule_drafts, shift_activities, leave_rounds, leave_round_blocks, leave_round_entries, leave_round_submissions

Kernrelaties:
- `shifts.user_id` → `users.id`
- `availability.user_id` → `users.id`
- `users.main_team` → `teams.id`
- `users.team_id` → `teams.id` (voor autorisatie, MOET gelijk zijn aan main_team)

Zie `backend/sql/schema.sql` voor volledige schema.

## Rollen & Permissies

| Rol | Kan |
|-----|-----|
| `admin` | Alles, inclusief user management |
| `roosterverantwoordelijke` | Alle shifts/roosters/teams beheren (geen accountbeheer) |
| `medewerker` | Eigen shifts bekijken/bewerken, ruilen, verlof aanvragen (geen basisrooster) |

## Belangrijke Regels

1. **NOOIT** frameworks of build tools toevoegen (React, Vue, Webpack, Vite, etc.)
2. **ALTIJD** `team_id` syncen met `main_team` bij user updates (anders falen permissies)
3. **ALTIJD** parameterized queries gebruiken (nooit string concatenation in SQL)
4. **Backend retourneert BEIDE** `userId` EN `employeeId` (backward compatibility alias)
5. **Permissions** checken in ZOWEL frontend ALS backend
6. **Migraties**: geversioneerd via de `MIGRATIONS`-array + `runMigrations()` in server.js (draait bij elke startup, elke migratie exact één keer). Voeg nieuwe schema changes toe als nieuwe migratie-entry. Migratie `000_base_schema` draait `schema.sql` idempotent, dus een verse database (bv. staging) initialiseert zichzelf; `ensureBootstrapData()` maakt standaardteams + admin-account aan zonder bestaande data te overschrijven
7. **shift_blocks**: Bij shift delete wordt block aangemaakt (voorkomt auto-regeneratie). Manual shift create verwijdert block.
8. **applyTeamColors()**: Niet aanroepen bij elke render — enkel na init en bij team-settings wijziging
9. **Fetch wrapper**: Gebruik uitsluitend `dataApiFetch()` uit `data.js`. `apiFetch()` is verwijderd (issue #26 opgelost). Uitzondering: `fetchPublicHolidays()` gebruikt plain `fetch()` want `/public-holidays` vereist geen auth.
10. **console.log**: Nooit toevoegen zonder debug-guard — `DEBUG` variabele staat bovenaan app.js en onderdrukt logs in productie automatisch
11. **Email optioneel**: Accounts kunnen zonder e-mail worden aangemaakt. Welkomstmail wordt automatisch verstuurd zodra een e-mail voor het eerst wordt ingesteld via PATCH /admin/users of PUT /users/:id

## API Endpoints (belangrijk)

Alle endpoints zijn bereikbaar via `/api/v1/<pad>`. Backward-compat alias op root (`/<pad>`) blijft actief t/m v1.3.

### Auth
- `POST /api/v1/auth/login` - Login, retourneert JWT
- `POST /api/v1/auth/register` - Account aanmaken
- `GET /api/v1/me` - Huidige user info

### Data
- `GET /api/v1/shifts?start=YYYY-MM-DD&end=YYYY-MM-DD` - Shifts ophalen
- `POST /api/v1/shifts` - Shift aanmaken (valideert ook manueel gesloten datums)
- `PUT /api/v1/shifts/:id` - Shift wijzigen
- `DELETE /api/v1/shifts/:id` - Shift verwijderen (maakt shift_block aan)
- `GET /api/v1/availability?start=&end=` - Beschikbaarheid ophalen
- `POST /api/v1/availability` - Beschikbaarheid instellen
- `GET /api/v1/settings` - App instellingen
- `PUT /api/v1/settings/:key` - Setting opslaan (admin/hoofd)
- `GET /api/v1/public-holidays?year=YYYY` - Belgische feestdagen voor een jaar (geen auth)

### Planning
- `CRUD /api/v1/shift-activities` - Activiteiten binnen shifts
- `CRUD /api/v1/schedule-drafts` - Roosterconcepten
- `POST /api/v1/schedule-drafts/:id/apply` - Concept toepassen op datumbereik
- `POST /api/v1/users/:id/apply-schedule` - Basisrooster toepassen (atomisch)
- `POST /api/v1/availability/sick-with-takeover` - Bulk ziekmelding + auto-takeover

### Swap/Takeover
- `POST /api/v1/swap-requests` - Ruilverzoek aanmaken
- `POST /api/v1/shift-requests/takeover` - Overnameverzoek aanmaken
- `PUT /api/v1/swap-requests/:id/approve` - Lead keurt goed
- `PUT /api/v1/swap-requests/:id/reject` - Lead wijst af

### Verlofplanning
- `GET /api/v1/leave-rounds` - Alle verlofrondes (concepten enkel voor beheerders)
- `GET /api/v1/leave-rounds/:id` - Ronde met volledige matrix + indienstatus
- `POST|PUT|DELETE /api/v1/leave-rounds[/:id]` - Ronde beheren (admin/roosterverantw.)
- `PUT /api/v1/leave-rounds/:id/entries` - Invulling opslaan (eigen; beheerder ook voor anderen)
- `POST /api/v1/leave-rounds/:id/submit` - Indienen
- `PUT /api/v1/leave-rounds/:id/submissions/:userId` - Goedkeuren/afwijzen
- `PUT /api/v1/leave-rounds/:id/blocks/:blockId` - Gesloten dagen van een blok opnieuw uit het concept overnemen (409 op een gesloten ronde zonder `?force=1`)
- `PUT /api/v1/leave-rounds/:id/blocks/:blockId/entries` - Definitieve verdeling van een voorkeurblok vastleggen (enkel bij status `gesloten`; vervangt uitsluitend binnen het blokbereik)
- `POST /api/v1/leave-rounds/:id/apply` - Goedgekeurd verlof → availability

### Admin
- `GET /api/v1/audit-log` - Audit log met filters en paginatie
- `POST /api/v1/admin/users/:id/replace` - Medewerker vervangen
- `PUT /api/v1/me/email-preferences` - Email notificatie voorkeur

## Frontend Patronen

- **DataStore** (`data.js`): Centrale data cache, alle API calls gaan hierdoor
- **Settings**: `frontend/config/settings.js` voor defaults, persistent via `PUT /settings/:key`
- **Modals**: `openShiftModal(shift, canEdit)` - view vs edit mode op basis van permissies
- **Scroll preservation**: ScrollY wordt bewaard bij planner re-renders
- **Validation**: `validation.js` draait client-side checks voor shift toewijzingen
- **Verlofplanning**: één ronde = één SCHOOLJAAR, opgebouwd uit blokken (`leave_round_blocks`) die verwijzen naar `settings.holidayPeriods` — dus geen tweede plek waar vakantiedatums staan. Modus staat per BLOK: `binair` (kleine vakanties: werken/verlof) of `voorkeur` (zomer: werken/liever_niet/zeker_niet). De UI groepeert blokken in tabs zoals de Excel: alle binaire blokken samen onder "Kleine vakanties", de voorkeurblokken onder "Zomer". Invulling per DAG (week-snelknoppen in de UI, want de praktijk vult per werkweek + weekend apart in). Een dag moet binnen één van de blokken vallen — de schoolweken ertussen zijn geen geldige invoer. Bij een voorkeurblok legt de beheerder ná het sluiten de definitieve verdeling vast (entries op `verlof` zetten) vóór `apply`. Matrix zichtbaar voor iedereen; invullen enkel voor jezelf en enkel per WEEK — er is geen dag-modus meer, ook niet voor beheerders.
- **Zomerronde afwerken**: `apply` neemt alleen entries met status `verlof` over, terwijl een voorkeurblok enkel `werken`/`liever_niet`/`zeker_niet` bevat. Zonder tussenstap levert een zomerronde dus niets op. De beheerder legt daarom eerst de verdeling vast via het verdeelscherm (`AppState.leaveScreen = 'verdelen'`, knop "Verlof verdelen" bij een gesloten ronde). `leaveVerdeelVoorstel()` zet een voorstel klaar: wie iets anders dan werken vroeg krijgt verlof, wie niets invulde krijgt werken, en een al vastgelegde `verlof` blijft staan zodat heropenen de verdeling niet wist. Bewust géén bezettings- of eerlijkheidsregels — die komen later. Opslaan gebeurt via het blok-scoped entries-endpoint, nooit via `PUT /leave-rounds/:id/entries`: dat vervangt álle entries van een gebruiker in de ronde en zou de kleine vakanties wissen.
- **Gesloten dagen in een verlofronde**: welke dagen tijdens een vakantie gesloten zijn, wordt beslist in het roosterconcept (`draft.grid._pattern.weeks[i].closedDays`, JS-daggetallen met 0=zo, 6=za). De ronde neemt dat bij het openen over in `leave_round_blocks.closed_dates` (absolute datums), zodat een medewerker het ziet zonder `GET /schedule-drafts` te mogen lezen én zodat later na te gaan is welke weekends toen werkweekends waren. Drie toestanden: `null` = onbekend (geen concept gekoppeld), `[]` = alles open, `[...]` = deze dagen dicht — die mogen nooit op één hoop. Bijwerken gebeurt expliciet via de knop "Gesloten dagen bijwerken uit concept", nooit automatisch. **WEEKCONVENTIE**: `_pattern.weeks["i"]` betekent "de i-de maandagweek van de vakantieperiode" — dat is wat de bouwer toont (`getBuilderVakantieWeekStart`), NIET het resultaat van `getWeekNumber()`. `closedDatesFromPattern()` in `app-leave.js` en de shiftgeneratie in `server.js` volgen die conventie.
- **Feestdagen**: `DataStore._publicHolidaysCache` — lazy geladen via `fetchPublicHolidays(year)`. Gebruik `getPublicHoliday(date)` voor rendering. Let op: gebruik hier plain `fetch()`, niet `dataApiFetch()` (endpoint vereist geen auth)
- **Gesloten dagen uit een vakantieconcept**: een basisrooster schrijft zijn patroon bij het toepassen naar `settings.schedule_pattern`, waardoor `isDayClosed()` het kent. Een vakantieconcept doet dat bewust NIET — zijn cyclus is vakantie-relatief en zou het jaarpatroon verzieken. Bij het toepassen worden zijn gesloten dagen daarom als absolute datums weggeschreven naar `settings.conceptClosedDates` (`[{date, reason, draftId}]`), per concept vervangen. `isDayClosed()` en `getClosedDateInfo()` lezen die mee, zodat planning, drag-drop en shift aanmaken kloppen. Ze staan apart van `closedDates` en verschijnen dus niet in het lijstje "manueel gesloten datums" in Instellingen.
- **Manuele sluitingsdagen**: opgeslagen als `settings.closedDates` (array `[{date, reason}]`). `isDayClosed()` checkt dit automatisch → drag-drop, shift aanmaken en beschikbaarheidstabel werken zonder extra aanpassingen
- **Uren bij naam (planning view)**: In timeline- en maandweergave wordt per medewerker week- en periodetotaal getoond onder de naam (`X/Yu` formaat). Berekend via `getEmployeeHoursThisWeek(id, weekStartStr)` en `getEmployeeHoursThisPeriod(id, dateStr)` uit `data.js`. Kleur: rood = boven contractnorm, oranje = onder contractnorm. Periodenorm = `contractHours × 4` (vaste 4-weken-periodes verankerd aan het schooljaar via `getFourWeekPeriodDates()`). Een jaar telt 13 periodes van elk 4 weken.

## MCP Server

De MCP server is actief en verbonden met de productie-API. Dit laat Claude toe om live data te lezen tijdens development, debugging en feature-bouw.

**API URL**: `https://uurrooster-app.onrender.com/api/v1`

### Beschikbare tools

| Tool | Doel |
|------|------|
| `get_api_health` | API bereikbaarheid checken |
| `get_employees` | Medewerkers ophalen (filter op team, actief) |
| `get_shifts` | Shifts ophalen voor een datumbereik |
| `get_availability` | Beschikbaarheid/afwezigheid opvragen |
| `get_staffing_overview` | Bezetting per dag/team bekijken |
| `find_available_employees` | Beschikbare medewerkers voor een shift zoeken |
| `get_swap_requests` | Ruilverzoeken opvragen |
| `get_schedule_drafts` | Roosterconcepten opvragen |
| `get_hours_report` | Uren rapport per medewerker |
| `get_audit_log` | Audit log met filters |
| `query_database` | Directe SQL query op de database |
| `create_shift` | ⚠️ Shift aanmaken (zie veiligheidsregel) |
| `update_shift` | ⚠️ Shift wijzigen (zie veiligheidsregel) |
| `delete_shift` | ⚠️ Shift verwijderen (zie veiligheidsregel) |

### Veiligheidsregel MCP

> ⚠️ **Schrijf-tools** (`create_shift`, `update_shift`, `delete_shift`) raken de **productiedatabase**. Deze tools NOOIT gebruiken zonder expliciete bevestiging van Victor — ook niet als de vraag dit impliciet suggereert. Altijd eerst de actie beschrijven en wachten op "ja, doe het".

### Gebruik tijdens development

- Lees live data om edge cases en echte datastructuren te begrijpen
- Valideer API-gedrag na een bugfix rechtstreeks via MCP
- Gebruik `query_database` voor complexe lookups die de standaard tools niet dekken

## Deploy

Twee permanente branches, elk met een eigen Render-omgeving:

| Branch | Omgeving |
|--------|----------|
| `main` | Productie (live data) |
| `staging` | Testomgeving (eigen database) |

Workflow: ontwikkel → `push origin staging` (test op de staging-URL) → merge naar `main` (live). Ontwikkel bij voorkeur niet rechtstreeks op `main`. De frontend kiest automatisch de juiste backend op basis van zijn hostname (`frontend/config/settings.js`: bevat "staging" → staging-backend).

Zie `DEPLOY.md` voor deployment instructies en `STAGING.md` voor de eenmalige setup van de testomgeving.

## Tests

```bash
cd backend
npm test           # Alle tests uitvoeren (249 tests, ~6 seconden)
```

Testbestanden in `backend/tests/`:

| Bestand | Dekking |
|---------|---------|
| `utils.test.js` | `getMonday`, `formatDateYYYYMMDD`, `parseLocalDate`, `getEasterDate`, `getBelgianPublicHolidays` |
| `email.test.js` | `escapeHtml`, `formatDate`, `formatTime`, `shiftDetailBox`, `baseTemplate` |
| `api.test.js` | API-endpoints: auth, shifts, teams, settings, swap-requests |
| `validation.test.js` | Frontend tijdfuncties: `parseDateTime`, `getShiftEndDateTime`, `getHoursBetweenShifts`, `shiftsOverlap` |

Tests gebruiken Jest + Supertest. De database wordt volledig gemockt — geen echte DB vereist.

## GitHub Issues — Workflow

Alle bugs, technische schuld en features worden bijgehouden via **GitHub Issues**:
<https://github.com/Kirbypopdog/Uurroosterapp/issues>

### Wanneer een issue aanmaken?
- Je vindt een bug tijdens het werken → maak een issue aan, werk dan verder
- Je doet een review → log elke bevinding als apart issue
- Je maakt een plan → schrijf de stappen als issues, niet als commentaar
- Je ziet technische schuld maar lost het nu niet op → issue aanmaken en doorgaan

### Hoe?
```bash
# Bug gevonden tijdens werk
gh issue create --repo Kirbypopdog/Uurroosterapp \
  --title "[BUG] Korte beschrijving" \
  --label "type:bug,prioriteit:hoog" \
  --milestone "v1.1 — Stabilisatie" \
  --body "Beschrijving + stappen + acceptatiecriteria"

# Review bevinding
gh issue create --repo Kirbypopdog/Uurroosterapp \
  --title "[REVIEW] Bevinding" \
  --label "type:tech-debt,prioriteit:medium" \
  --milestone "v1.2 — Refactor" \
  --body "..."
```

### Milestones
| Milestone | Focus |
|-----------|-------|
| v1.1 — Stabilisatie | Bugs fixen, UI stabiliseren, geen nieuwe features |
| v1.2 — Refactor | app.js opsplitsen ✓, tech debt, email config |
| v1.3 — Features | Overuren, seizoenen, setup wizard |

### Labels
- **prioriteit:** `prioriteit:kritiek` / `prioriteit:hoog` / `prioriteit:medium` / `prioriteit:laag`
- **type:** `type:bug` / `type:tech-debt` / `type:feature` / `type:security` / `type:ux` / `type:performance`
- **gebied:** `gebied:frontend` / `gebied:backend` / `gebied:database`

## Prioriteitsregel

> ⚠️ Als er open issues zijn met label `prioriteit:kritiek`, worden die **eerst opgelost** voor nieuwe features worden toegevoegd — tenzij Victor dit expliciet anders vraagt.

Check voor je begint:
```bash
gh issue list --repo Kirbypopdog/Uurroosterapp --label "prioriteit:kritiek" --state open
```

## Actieve Bekende Problemen

Controleer de open issues voor context bij het werken aan deze gebieden:

| Issue | Beschrijving |
|-------|--------------|
| — | Geen kritieke of hoge-prioriteit problemen open |

## Agent Aanbevelingen

Bij elke niet-triviale taak, beveel de best passende agent aan uit `~/.claude/agents/`. De gebruiker kan deze starten via `/agents`. Kies op basis van het type werk:

| Type werk | Aanbevolen agent |
|-----------|-----------------|
| Backend/API werk | `engineering-backend-architect` |
| Frontend/UI werk | `engineering-frontend-developer` of `design-ui-designer` |
| UX verbeteringen | `design-ux-architect` of `design-ux-researcher` |
| Bug investigation | `testing-evidence-collector` |
| Performance issues | `testing-performance-benchmarker` |
| API testen | `testing-api-tester` |
| Feature planning | `product-sprint-prioritizer` |
| Code review/QA | `testing-reality-checker` |
| DevOps/deploy | `engineering-devops-automator` |
| Grote multi-stap projecten | `agents-orchestrator` (coördineert meerdere agents) |

## Environment Variables

```
DATABASE_URL=postgresql://...     # PostgreSQL connection string
JWT_SECRET=...                    # JWT signing secret
ADMIN_EMAIL=admin@hetvlot.be     # Initieel admin account
ADMIN_PASSWORD=...                # Admin wachtwoord
DEFAULT_RESET_PASSWORD=...                # Reset wachtwoord voor nieuwe users (zie Render dashboard)
```
