# Het Vlot Roosterplanning

Webapplicatie voor het beheren van werkroosters bij Het Vlot. Medewerkers kunnen hun rooster bekijken, shifts ruilen, en verlof/ziekte melden. Team leads en admins beheren het volledige rooster.

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JavaScript (geen framework, geen build stap)
- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Auth**: JWT tokens + bcrypt
- **Hosting**: Render (render.com)

## Lokaal Draaien

### Vereisten
- Node.js 20+
- PostgreSQL (lokaal of remote)

### Stappen

```bash
# 1. Database aanmaken
createdb uurroosterapp

# 2. Backend starten
cd backend
cp .env.example .env    # Pas DATABASE_URL aan naar je lokale DB
npm install
npm run db:setup        # Maakt tabellen + seed data (admin + teams)
npm run dev             # Start backend op http://localhost:3001

# 3. Frontend openen
open frontend/index.html
# Of start een simpele HTTP server:
# npx serve frontend
```

### Inloggen
- Admin: `admin@hetvlot.be` / wachtwoord uit `.env`
- Nieuwe medewerkers: aanmaken via admin panel

## Project Structuur

```
/
├── frontend/                   # Statische web app
│   ├── index.html              # Main HTML
│   ├── app.js                  # UI logica, modals, event handlers
│   ├── data.js                 # API calls, DataStore
│   ├── validation.js           # Business rules (11-uur regel, overlaps)
│   ├── drag-handler.js         # Drag & drop voor shifts
│   ├── styles.css              # Alle styling
│   └── config/settings.js      # Configuratie (API URL, teams, templates)
│
├── backend/                    # Node.js API
│   ├── src/server.js           # Alle endpoints + auto-migratie
│   ├── src/db.js               # Database connection
│   ├── sql/schema.sql          # Database schema
│   ├── scripts/                # Setup & seed scripts
│   └── import-backup.js        # CLI backup import tool
│
├── CLAUDE.md                   # AI-coding instructies
├── DEPLOY.md                   # Deployment guide
├── FEATURES.md                 # Feature roadmap
└── render.yaml                 # Render deployment config
```

## Rollen

| Rol | Toegang |
|-----|---------|
| Admin | Volledig beheer (users, shifts, settings) |
| Hoofdverantwoordelijke | Alle shifts en medewerkers beheren |
| Teamverantwoordelijke | Eigen team beheren |
| Medewerker | Eigen rooster bekijken, shifts ruilen, verlof melden |

## Teams

Vlot 1, Vlot 2, Cargo, Overkoepelend, Jobstudenten

Bi-weekly rooster: week 1 = weekend gesloten, week 2 = weekend open.

## Deployment

Zie [DEPLOY.md](DEPLOY.md) voor volledige deployment instructies.

## AI-Coderen

Dit project wordt ontwikkeld met AI-assistentie (Claude Code). Zie [CLAUDE.md](CLAUDE.md) voor project regels en architectuur.
