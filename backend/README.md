# Backend - Het Vlot Roosterplanning

Node.js + Express API met PostgreSQL database.

## Setup (lokaal)

```bash
# Maak database aan
createdb uurroosterapp

# Configureer environment
cp .env.example .env
# Pas DATABASE_URL aan

# Installeer en start
npm install
npm run db:setup    # Schema + seed
npm run dev         # Start met file watching op :3001
```

## Scripts

| Script | Commando | Doel |
|--------|----------|------|
| Start | `npm start` | Productie server |
| Dev | `npm run dev` | Dev server met auto-reload |
| DB Setup | `npm run db:setup` | Schema + seed uitvoeren |
| Seed | `npm run seed` | Alleen seed (teams + admin) |
| Import | `node import-backup.js <bestand>` | JSON backup importeren |

## API Endpoints

### Auth
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| POST | `/auth/register` | Nee | Account aanmaken |
| POST | `/auth/login` | Nee | Inloggen, retourneert JWT |
| GET | `/me` | Ja | Huidige user ophalen |
| PUT | `/me` | Ja | Profiel bijwerken |

### Users
| Method | Endpoint | Auth | Rol | Beschrijving |
|--------|----------|------|-----|-------------|
| GET | `/users` | Ja | Alle | Medewerkers ophalen (gefilterd op rol) |
| GET | `/users/:id` | Ja | Alle | Specifieke medewerker |
| PUT | `/users/:id` | Ja | Admin/Lead | Medewerker bijwerken |
| GET | `/admin/users` | Ja | Admin | Alle users (inclusief inactief) |
| POST | `/admin/users` | Ja | Admin | User aanmaken |
| PATCH | `/admin/users/:id` | Ja | Admin | User gedeeltelijk bijwerken |
| DELETE | `/admin/users/:id` | Ja | Admin | User verwijderen |
| POST | `/admin/users/:id/reset-password` | Ja | Admin | Wachtwoord resetten |

### Shifts
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/shifts?start=&end=` | Ja | Shifts in datumbereik |
| POST | `/shifts` | Ja | Shift aanmaken |
| PUT | `/shifts/:id` | Ja | Shift bijwerken |
| DELETE | `/shifts/:id` | Ja | Shift verwijderen (maakt block aan) |
| DELETE | `/shifts?userId=&start=&end=` | Ja | Bulk delete (admin/lead) |

### Availability (Verlof/Ziekte)
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/availability?start=&end=` | Ja | Beschikbaarheid ophalen |
| POST | `/availability` | Ja | Beschikbaarheid instellen |
| DELETE | `/availability?userId=&start=&end=` | Ja | Beschikbaarheid verwijderen |

### Shift Blocks
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/shift-blocks` | Ja | Alle blocks ophalen |
| POST | `/shift-blocks` | Ja | Block aanmaken |
| DELETE | `/shift-blocks/:id` | Ja | Block verwijderen (admin/hoofd) |

### Swap/Takeover Requests
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/swap-requests` | Ja | Alle requests ophalen |
| POST | `/swap-requests` | Ja | Ruilverzoek aanmaken |
| POST | `/shift-requests/takeover` | Ja | Overnameverzoek aanmaken |
| PUT | `/swap-requests/:id/target-approve` | Ja | Doelmedewerker accepteert |
| PUT | `/swap-requests/:id/target-reject` | Ja | Doelmedewerker wijst af |
| PUT | `/shift-requests/:id/takeover-accept` | Ja | Medewerker neemt shift over |
| PUT | `/swap-requests/:id/approve` | Ja | Lead keurt goed |
| PUT | `/swap-requests/:id/reject` | Ja | Lead wijst af |
| DELETE | `/swap-requests/:id` | Ja | Request annuleren |

### Settings
| Method | Endpoint | Auth | Rol | Beschrijving |
|--------|----------|------|-----|-------------|
| GET | `/settings` | Ja | Alle | Alle instellingen ophalen |
| PUT | `/settings/:key` | Ja | Admin/Hoofd | Instelling opslaan |

### Admin
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| POST | `/import` | Ja | Bulk data import |
| DELETE | `/reset-data` | Ja | Alle data wissen |
| POST | `/admin/migrate` | Ja | Database migratie uitvoeren |
| POST | `/admin/seed-teams` | Ja | Teams opnieuw seeden |
| GET | `/admin/debug` | Ja | Debug info ophalen |

### Shift Activities
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/shift-activities?start=&end=` | Ja | Activiteiten in datumbereik |
| POST | `/shift-activities` | Ja | Activiteit aanmaken |
| PUT | `/shift-activities/:id` | Ja | Activiteit bijwerken |
| DELETE | `/shift-activities/:id` | Ja | Activiteit verwijderen |

### Schedule Drafts
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/schedule-drafts` | Ja | Alle concepten ophalen |
| POST | `/schedule-drafts` | Ja | Concept aanmaken |
| PUT | `/schedule-drafts/:id` | Ja | Concept bijwerken |
| DELETE | `/schedule-drafts/:id` | Ja | Concept verwijderen |
| POST | `/schedule-drafts/:id/apply` | Ja | Concept toepassen op datumbereik |

### Planning
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| POST | `/users/:id/apply-schedule` | Ja | Basisrooster toepassen (atomisch) |
| POST | `/availability/sick-with-takeover` | Ja | Bulk ziekmelding + auto-takeover |
| POST | `/admin/users/:id/replace` | Ja | Medewerker vervangen |

### Audit Log
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/audit-log` | Ja | Audit log met filters en paginatie |

### Email Preferences
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| PUT | `/me/email-preferences` | Ja | Email notificatie voorkeur |

### Health
| Method | Endpoint | Auth | Beschrijving |
|--------|----------|------|-------------|
| GET | `/health` | Nee | Health check |

## Database

Schema: `sql/schema.sql`

Tabellen: `teams`, `users`, `shifts`, `availability`, `settings`, `shift_blocks`, `shift_swap_requests`, `audit_log`, `schedule_drafts`, `shift_activities`

Auto-migratie draait bij elke server start via `ensureSchema()`.
