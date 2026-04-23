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
| `app.js` | ~13.100 | Hoofd UI: modals, event handlers, rendering, admin panel |
| `data.js` | ~1.840 | DataStore, API fetch wrappers, data loading |
| `validation.js` | ~593 | Business rules: 11-uur regel, overlap, min bezetting |
| `drag-handler.js` | ~1.201 | Drag & drop shifts tussen medewerkers |
| `styles.css` | ~10.900 | Alle CSS inclusief responsive, themas |
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

**Tabellen**: teams, users, shifts, availability, settings, shift_blocks, shift_swap_requests, audit_log, schedule_drafts, shift_activities

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
6. **Auto-migratie**: `ensureSchema()` in server.js draait bij elke startup - voeg nieuwe schema changes daar toe
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
- **Feestdagen**: `DataStore._publicHolidaysCache` — lazy geladen via `fetchPublicHolidays(year)`. Gebruik `getPublicHoliday(date)` voor rendering. Let op: gebruik hier plain `fetch()`, niet `dataApiFetch()` (endpoint vereist geen auth)
- **Manuele sluitingsdagen**: opgeslagen als `settings.closedDates` (array `[{date, reason}]`). `isDayClosed()` checkt dit automatisch → drag-drop, shift aanmaken en beschikbaarheidstabel werken zonder extra aanpassingen

## Deploy

Zie `DEPLOY.md` voor deployment instructies (Render platform).

## Tests

```bash
cd backend
npm test           # Alle tests uitvoeren (129 tests, ~3 seconden)
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
| v1.2 — Refactor | app.js opsplitsen, tech debt, email config |
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
| #25 | app.js splitsen — ~13.000 regels, niet aanraken zonder plan |
| #59 | Basisrooster koppelen aan actief concept (nu: één statisch veld per user) |
| #60 | Afwezigheid-tab: medewerkers kunnen afwezigheid van teamgenoten invullen (mag niet) |

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
