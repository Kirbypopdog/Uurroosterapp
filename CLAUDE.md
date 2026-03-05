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
# Login: admin@hetvlot.be / VlotAdmin2025!
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
| `app.js` | ~7000 | Hoofd UI: modals, event handlers, rendering, admin panel |
| `data.js` | ~1300 | DataStore, API fetch wrappers, data loading |
| `validation.js` | ~570 | Business rules: 11-uur regel, overlap, min bezetting |
| `drag-handler.js` | ~770 | Drag & drop shifts tussen medewerkers |
| `styles.css` | groot | Alle CSS inclusief responsive, themas |
| `index.html` | ~800 | HTML markup: modals, formulieren, planning grid |
| `config/settings.js` | ~60 | API URL auto-detect, shift templates, team kleuren |

### Backend (`backend/`)
| Bestand | Doel |
|---------|------|
| `src/server.js` | Alle API endpoints + auto-migratie bij startup |
| `src/db.js` | PostgreSQL connection pool |
| `sql/schema.sql` | Database schema (bron van waarheid) |
| `scripts/seed.js` | Seed teams + admin account |
| `scripts/setup-db.js` | Voert schema.sql uit |
| `import-backup.js` | CLI tool voor JSON backup import |

## Database Schema

**Tabellen**: teams, users, shifts, availability, settings, shift_blocks, shift_swap_requests

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

## API Endpoints (belangrijk)

### Auth
- `POST /auth/login` - Login, retourneert JWT
- `POST /auth/register` - Account aanmaken
- `GET /me` - Huidige user info

### Data
- `GET /shifts?start=YYYY-MM-DD&end=YYYY-MM-DD` - Shifts ophalen
- `POST /shifts` - Shift aanmaken
- `PUT /shifts/:id` - Shift wijzigen
- `DELETE /shifts/:id` - Shift verwijderen (maakt shift_block aan)
- `GET /availability?start=&end=` - Beschikbaarheid ophalen
- `POST /availability` - Beschikbaarheid instellen
- `GET /settings` - App instellingen
- `PUT /settings/:key` - Setting opslaan (admin/hoofd)

### Swap/Takeover
- `POST /swap-requests` - Ruilverzoek aanmaken
- `POST /shift-requests/takeover` - Overnameverzoek aanmaken
- `PUT /swap-requests/:id/approve` - Lead keurt goed
- `PUT /swap-requests/:id/reject` - Lead wijst af

## Frontend Patronen

- **DataStore** (`data.js`): Centrale data cache, alle API calls gaan hierdoor
- **Settings**: `frontend/config/settings.js` voor defaults, persistent via `PUT /settings/:key`
- **Modals**: `openShiftModal(shift, canEdit)` - view vs edit mode op basis van permissies
- **Scroll preservation**: ScrollY wordt bewaard bij planner re-renders
- **Validation**: `validation.js` draait client-side checks voor shift toewijzingen

## Deploy

Zie `DEPLOY.md` voor deployment instructies (Render platform).

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
DEFAULT_RESET_PASSWORD=Welkom123! # Reset wachtwoord voor nieuwe users
```
