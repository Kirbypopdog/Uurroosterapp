# Het Vlot Roosterplanning v1.4.0

Webapplicatie voor shiftplanning bij Het Vlot. Medewerkers bekijken hun rooster, ruilen shifts en melden afwezigheid. Admins en roosterverantwoordelijken beheren het volledige rooster via een visuele builder.

**Live**: [vlot-dashboard.site](https://vlot-dashboard.site)

---

## Features

### Rooster & Planning
- **Weekoverzicht** met timeline-weergave per medewerker
- **Rooster Bouwen** — visuele drag & drop builder voor weekroosters
- **Concepten (Drafts)** — roosters opslaan, toepassen op datumbereik en naast elkaar vergelijken (diff-view)
- **Schooljaar-logica** — automatische weeknummering sept-aug, vakantieperiodes
- **Belgische feestdagen** — automatisch berekend en rood gemarkeerd in de planning (10 officiële feestdagen)
- **Manuele sluitingsdagen** — brugdagen en uitzonderingen instellen via rechtsklik op de dag
- **Flexibel roosterpatroon** — configureerbaar: bi-weekly, tri-weekly, etc.
- **Shift templates** — Vroeg/Laat/Nacht/Lang met custom tijden en iconen
- **Drag & drop** shifts tussen medewerkers in de planningsweergave
- **Nachtdienst-ondersteuning** — correcte weergave over middernacht heen

### Medewerkers & Teams
- **5 teams**: Vlot 1, Vlot 2, Cargo, Overkoepelend, Jobstudenten
- **Hoofd- en extra teams** per medewerker
- **Contracturen** met week/periode voortgangsbalk in profiel (4-weken-periodes, schooljaaranker)
- **Medewerker vervangen** — kopieer basisrooster naar nieuwe medewerker, deactiveer oude

### Afwezigheid & Ruilen
- **Verlof, ziekte, overuren, opleiding** — per dag registreren
- **Bulk ziekmelding** met automatische overnameverzoeken
- **Ruilverzoeken** — shift swap met goedkeuringsworkflow
- **Overnameverzoeken** — shift beschikbaar stellen voor teamgenoten
- **Auto-expire** — verlopen verzoeken worden automatisch geannuleerd

### Bezetting & Validatie
- **Bezettings-heatmap** — kleurgecodeerd overzicht van teambezetting
- **11-uur regel** — waarschuwing bij te korte rust tussen diensten
- **Overlap detectie** — voorkomt dubbele shifts
- **Max. opeenvolgende dagen** — configureerbaar (standaard 6)
- **Cross-team validatie** — waarschuwing bij toewijzing buiten eigen team

### Activiteiten
- **Activiteiten binnen shifts** — oudergesprek, vorming, overleg, afspraak
- **Gekleurde chips** op timeline blokken

### Admin & Instellingen
- **Audit log** — wie heeft wat wanneer gewijzigd, met filters en export
- **Undo/Redo** — Ctrl+Z/Y voor shift operaties (max 50 acties)
- **Data export/import** — volledige JSON backup
- **Email notificaties** — via Resend bij ruil, overname, ziekmelding (opt-out per user)
- **Weekend/vakantie verantwoordelijke** — rotatieschema op home
- **Team kleuren** — configureerbaar, doorwerking in hele app
- **Planningsregels** — min. bezetting dag/nacht, instelbaar per regulier/vakantie

### Rollen

| Rol | Toegang |
|-----|---------|
| **Admin** | Volledig beheer: users, shifts, settings, accountbeheer |
| **Roosterverantwoordelijke** | Alle shifts, roosters en teams beheren (geen accountbeheer) |
| **Medewerker** | Eigen rooster bekijken, verlof melden, shifts ruilen |

---

## Tech Stack

| Laag | Technologie |
|------|-------------|
| Frontend | Vanilla JavaScript — geen framework, geen build stap |
| Backend | Node.js + Express (single `server.js`) |
| Database | PostgreSQL (Render hosted) |
| Auth | JWT (7 dagen) + bcrypt |
| Email | Resend (fire-and-forget, graceful zonder API key) |
| Hosting | Render (render.com) |

---

## Lokaal Draaien

### Vereisten
- Node.js 20+
- PostgreSQL

### Stappen

```bash
# 1. Database aanmaken
createdb uurroosterapp

# 2. Backend starten
cd backend
cp .env.example .env    # Pas DATABASE_URL aan
npm install
npm run db:setup        # Schema + seed (admin + teams)
npm run dev             # Backend op http://localhost:3001

# 3. Frontend openen
open frontend/index.html
# Of: npx serve frontend
```

### Inloggen
- **Admin**: `admin@hetvlot.be` / wachtwoord uit `.env`
- **Nieuwe medewerkers**: aanmaken via admin panel

---

## Project Structuur

```
├── frontend/                   # Statische web app (vanilla JS)
│   ├── index.html              # HTML markup: modals, formulieren, grid
│   ├── app-globals.js          # AppState, constanten, UndoManager, DOM
│   ├── app-permissions.js      # Rol-checks en permissiefuncties
│   ├── app-ui.js               # Toast, modals, FocusTrap, tooltips
│   ├── app-auth.js             # Login, logout, sessiecheck
│   ├── app-nav.js              # Navigatie, switchView, week/maand helpers
│   ├── app-planner.js          # Planningsweergave, timeline, heatmap
│   ├── app-shifts.js           # Shift modals, CRUD, activiteiten
│   ├── app-swaps.js            # Ruilverzoeken en overnames
│   ├── app-employees.js        # Medewerkers, profiel, urendashboard
│   ├── app-availability.js     # Beschikbaarheid en afwezigheid
│   ├── app-builder.js          # Roosterbouwer: kernlogica en grid
│   ├── app-builder-editors.js  # Staffing, vergaderingen, waarschuwingen
│   ├── app-builder-drafts.js   # Concept-CRUD, vergelijking (diff-view)
│   ├── app-settings.js         # Alle instellingstabs
│   ├── app-admin.js            # Export/import, debug, migratie
│   ├── app-init.js             # DOM-init, event listeners, entry point
│   ├── data.js                 # DataStore, API calls, data loading
│   ├── validation.js           # Business rules (11-uur, overlap, bezetting)
│   ├── drag-handler.js         # Drag & drop shifts (planner + builder)
│   ├── styles.css              # Volledige styling incl. responsive + tokens
│   └── config/settings.js      # API URL auto-detect, defaults
│
├── backend/                    # Node.js API
│   ├── src/server.js           # Alle endpoints + geversioned migratiesysteem
│   ├── src/db.js               # PostgreSQL connection pool
│   ├── src/email.js            # Resend email service (9 notificatie types)
│   ├── src/utils.js            # Pure datumhulpfuncties
│   ├── tests/                  # Jest test suite (194 tests)
│   ├── sql/schema.sql          # Database schema (bron van waarheid)
│   ├── scripts/                # Setup & seed scripts
│   └── import-backup.js        # CLI backup import tool
│
├── CLAUDE.md                   # AI-coding instructies
├── DEPLOY.md                   # Deployment guide (Render)
├── FEATURES.md                 # Volledige feature lijst
└── render.yaml                 # Render deployment config
```

---

## Database

**10 tabellen**: `teams`, `users`, `shifts`, `availability`, `settings`, `shift_blocks`, `shift_swap_requests`, `audit_log`, `schedule_drafts`, `shift_activities`

Auto-migratie bij elke server startup via `ensureSchema()` — geen handmatige migraties nodig.

---

## API

### Auth
| Method | Endpoint | Beschrijving |
|--------|----------|-------------|
| POST | `/auth/login` | Login, retourneert JWT |
| POST | `/auth/register` | Account aanmaken |
| GET | `/me` | Huidige user info |

### Shifts & Planning
| Method | Endpoint | Beschrijving |
|--------|----------|-------------|
| GET | `/shifts` | Shifts ophalen (met date range) |
| POST | `/shifts` | Shift aanmaken |
| PUT | `/shifts/:id` | Shift wijzigen |
| DELETE | `/shifts/:id` | Shift verwijderen (maakt block) |
| CRUD | `/shift-activities` | Activiteiten binnen shifts |
| CRUD | `/shift-blocks` | Shift blocks (voorkom regeneratie) |

### Afwezigheid & Ruilen
| Method | Endpoint | Beschrijving |
|--------|----------|-------------|
| GET/POST | `/availability` | Beschikbaarheid CRUD |
| POST | `/availability/sick-with-takeover` | Bulk ziekmelding + takeover |
| POST | `/swap-requests` | Ruilverzoek aanmaken |
| POST | `/shift-requests/takeover` | Overnameverzoek |
| PUT | `/swap-requests/:id/approve` | Goedkeuren |
| PUT | `/swap-requests/:id/reject` | Afwijzen |

### Admin
| Method | Endpoint | Beschrijving |
|--------|----------|-------------|
| GET/PUT | `/users` | Medewerkers beheren |
| DELETE | `/admin/users/:id` | Account verwijderen |
| POST | `/admin/users/:id/replace` | Medewerker vervangen |
| POST | `/users/:id/apply-schedule` | Basisrooster toepassen |
| CRUD | `/schedule-drafts` | Roosterconcepten |
| POST | `/schedule-drafts/:id/apply` | Concept toepassen |
| GET/PUT | `/settings` | App instellingen |
| GET | `/audit-log` | Audit log met filters |

---

## Deployment

Zie [DEPLOY.md](DEPLOY.md) voor volledige instructies. Korte samenvatting:

1. **Database**: PostgreSQL op Render (Starter plan)
2. **Backend**: Web Service vanuit `backend/` folder
3. **Frontend**: Static Site vanuit `frontend/` folder
4. Auto-deploy bij elke push naar `main`

---

## Ontwikkeling

Dit project is volledig ontwikkeld met AI-assistentie via [Claude Code](https://claude.ai). Zie [CLAUDE.md](CLAUDE.md) voor architectuurregels en coderingsinstructies.

### Tests

```bash
cd backend && npm test   # 117 tests, geen DB vereist
```

| Testbestand | Beschrijving |
|-------------|--------------|
| `tests/utils.test.js` | Pure datumhulpfuncties |
| `tests/email.test.js` | Email helpers (XSS-preventie, templates) |
| `tests/api.test.js` | API-endpoints via supertest (auth, shifts, teams, …) |
| `tests/validation.test.js` | Frontend tijdberekeningsfuncties |

### Belangrijke regels
- **Geen frameworks** — vanilla JS, geen React/Vue/build tools
- **`team_id` = `main_team`** — altijd syncen bij user updates
- **Parameterized queries** — nooit string concatenation in SQL
- **Auto-migratie** — schema changes via `ensureSchema()` in server.js

---

## Licentie

Intern project voor Het Vlot. Niet voor extern gebruik.
