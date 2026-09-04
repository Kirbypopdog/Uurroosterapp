# Deployment Guide - Het Vlot Roosterplanning

## Platform: Render (render.com)

De app bestaat uit 3 onderdelen op Render:
1. **Web Service** (backend) - Node.js Express API
2. **Static Site** (frontend) - Vanilla HTML/CSS/JS
3. **PostgreSQL** (database) - Starter plan ($6.30/maand)

---

## Eerste Keer Deployen

### 1. Database aanmaken
1. Render Dashboard → New → PostgreSQL
2. Kies **Starter** plan (Basic-256mb, 1GB storage)
3. Naam: `uurrooster-db`
4. Region: Frankfurt (EU)
5. Na aanmaak: kopieer de **Internal Database URL**

### 2. Backend deployen
1. Render Dashboard → New → Web Service
2. Connect GitHub repo
3. Instellingen:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Environment Variables toevoegen:
   - `DATABASE_URL` = (Internal Database URL van stap 1)
   - `JWT_SECRET` = (genereer een sterk wachtwoord)
   - `ADMIN_EMAIL` = `admin@hetvlot.be`
   - `ADMIN_PASSWORD` = (kies een sterk wachtwoord)
   - `DEFAULT_RESET_PASSWORD` = (kies een sterk wachtwoord voor nieuwe accounts)
   - `NODE_ENV` = `production`
5. Deploy → Backend start en initialiseert zichzelf: migratie `000_base_schema` maakt alle tabellen, `ensureBootstrapData()` maakt standaardteams + admin-account aan

### 3. Frontend deployen
1. Render Dashboard → New → Static Site
2. Connect zelfde GitHub repo
3. Instellingen:
   - **Root Directory**: `frontend`
   - **Build Command**: (leeg laten)
   - **Publish Directory**: `.`
4. Deploy

### 4. Data importeren
- Open de app → Login als admin
- Ga naar Instellingen → Importeer backup (als je data hebt)
- Of: data wordt leeg opgestart, handmatig medewerkers toevoegen

---

## Code Updates Deployen

Er zijn twee omgevingen, elk gekoppeld aan een eigen branch:

| Branch | Omgeving |
|--------|----------|
| `main` | **Productie** (wat het team gebruikt) |
| `staging` | **Testomgeving** (eigen database, veilig testen) |

**Aanbevolen workflow** — eerst testen, dan live:

```bash
# 1. Testen op staging
git checkout staging
git commit -am "beschrijving van wijziging"
git push origin staging          # → staging deployt automatisch

# 2. Tevreden na testen? Naar productie:
git checkout main
git merge staging
git push origin main             # → productie deployt automatisch
```

Render detecteert de push en:
- Backend: Herbouwt + herstart (duurt ~1-2 min)
- Frontend: Herlaadt statische bestanden (duurt ~30 sec)

> Zie **STAGING.md** voor de eenmalige setup van de testomgeving.

---

## Database Backup & Restore

### Backup maken (via de app)
1. Login als admin
2. Ga naar **Instellingen** tab
3. Scroll naar **Data Management**
4. Klik **Exporteer** → JSON bestand wordt gedownload

### Backup maken (via Render)
- Render Dashboard → Database → Backups
- Render maakt automatisch dagelijkse backups (Starter plan)

### Restore (via de app)
1. Login als admin
2. Instellingen → Data Management → **Importeer**
3. Selecteer JSON backup bestand

### Restore (via CLI - voor grote imports)
```bash
cd backend
# Zorg dat .env naar de juiste database wijst
node import-backup.js /pad/naar/hetvlot-backup-DATUM.json
```

---

## Environment Variables Overzicht

| Variable | Verplicht | Beschrijving |
|----------|-----------|-------------|
| `DATABASE_URL` | Ja | PostgreSQL connection string |
| `JWT_SECRET` | Ja | Secret voor JWT token signing |
| `ADMIN_EMAIL` | Ja | Email voor admin account (seed) |
| `ADMIN_PASSWORD` | Ja | Wachtwoord voor admin account (seed) |
| `DEFAULT_RESET_PASSWORD` | Ja | Tijdelijk wachtwoord voor nieuwe/gereset accounts |
| `NODE_ENV` | Nee | `production` op Render |
| `PORT` | Nee | Render stelt dit automatisch in |

---

## Troubleshooting

### Backend crashed / herstart steeds
- Check Render logs: Dashboard → Web Service → Logs
- Meest voorkomend: `DATABASE_URL` is fout of database is niet bereikbaar
- Check of PostgreSQL instance online is

### Database is leeg na deploy
- Bij de eerste deploy initialiseert de backend zichzelf: migratie `000_base_schema` maakt alle tabellen aan en `ensureBootstrapData()` maakt de standaardteams + een admin-account (uit `ADMIN_EMAIL`/`ADMIN_PASSWORD`). Geen handmatige `npm run db:setup` of shell-toegang nodig.
- Inhoudelijke data (medewerkers, shifts) blijft leeg → importeer een backup of voeg handmatig medewerkers toe
- De admin-bootstrap is veilig herhaalbaar: een bestaand admin-wachtwoord wordt **nooit** overschreven (`ON CONFLICT DO NOTHING`)

### Frontend toont "kan niet verbinden"
- Check of backend online is: ga naar `https://vlot-dashboard.site/health`
- Check `frontend/config/settings.js` - de productie URL moet kloppen
- Free tier backend gaat slapen na 15 min inactiviteit (eerste request duurt ~30 sec)

### Gratis backend is traag
- Render free tier: backend slaapt na 15 min inactiviteit
- Eerste request na sleep duurt 30-60 seconden
- Overweeg upgrade naar Starter ($7/maand) voor always-on

### Database migratie nodig
- Schema changes worden automatisch toegepast door `runMigrations()` in server.js
- Voeg een nieuwe entry toe aan de `MIGRATIONS`-array (genummerd, idempotent)
- Backend herstart → nieuwe migraties draaien automatisch (elke exact één keer)
