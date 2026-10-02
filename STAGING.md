# Testomgeving (Staging) — Het Vlot Roosterplanning

Een aparte test-omgeving zodat je wijzigingen kunt uitproberen **zonder de live data of de live app te raken**.

## Mentaal model

```
staging branch  →  test-omgeving  (eigen backend + eigen database + eigen frontend)
main branch     →  live-omgeving  (de echte app die het team gebruikt)
```

**Workflow voortaan:**
1. Ontwikkel op de `staging`-branch
2. `git push origin staging` → Render deployt automatisch naar de test-omgeving
3. Test op de staging-URL's (eigen testdata, niets kan stuk in productie)
4. Tevreden? Merge `staging` → `main` → gaat live

De frontend detecteert automatisch welke backend hij moet aanspreken op basis van zijn eigen URL (zie `frontend/config/settings.js`): bevat de hostname het woord **`staging`**, dan praat hij met de staging-backend. Geen aparte config per branch nodig.

---

## Eenmalige setup in het Render dashboard

> Deze stappen moet je één keer handmatig doen in Render. Daarna gaat alles automatisch.

### 1. Staging-database aanmaken

1. Render Dashboard → **New → PostgreSQL**
2. Naam: `uurroosterapp-db-staging`
3. Region: **Frankfurt (EU)** (zelfde als productie)
4. Plan: **Basic-256mb** volstaat ruim voor testen.
   - *Goedkoopste optie:* het gratis plan kan ook, maar een gratis Render-database **verloopt na 30 dagen**. Voor een blijvende testomgeving is Basic stabieler; wil je kosten drukken, gebruik gratis en maak hem opnieuw aan wanneer nodig.
5. Na aanmaak: kopieer de **Internal Database URL** (heb je zo nodig).

### 2. Staging-backend aanmaken

1. Render Dashboard → **New → Web Service**
2. Connect dezelfde GitHub-repo
3. Instellingen:
   - **Name**: `uurrooster-backend-staging`
   - **Branch**: `staging`  ← belangrijk: niet `main`
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Environment Variables** (eigen waarden voor staging — deel géén productie-secrets):
   | Key | Waarde |
   |-----|--------|
   | `DATABASE_URL` | Internal URL van de **staging**-database (stap 1) |
   | `JWT_SECRET` | een **andere** sterke waarde dan productie |
   | `ADMIN_EMAIL` | bv. `admin@hetvlot.be` |
   | `ADMIN_PASSWORD` | een testwachtwoord |
   | `DEFAULT_RESET_PASSWORD` | een testwachtwoord |
   | `NODE_ENV` | `production` |
   | `FRONTEND_URL` | de staging-frontend-URL uit stap 3 (bv. `https://uurrooster-frontend-staging.onrender.com`) |
   | `RESEND_API_KEY` | **leeg laten** — zo verstuurt staging geen echte e-mails naar medewerkers |
5. Deploy. De backend initialiseert zichzelf: migratie `000_base_schema` maakt alle tabellen aan en `ensureBootstrapData()` maakt de standaardteams + admin-account aan in de lege staging-database.
6. Noteer de toegewezen URL (bv. `https://uurrooster-backend-staging.onrender.com`).
   - Komt die **niet** exact overeen met de `STAGING_API` in `frontend/config/settings.js`? Pas die ene regel aan en push opnieuw naar `staging`.

### 3. Staging-frontend aanmaken

1. Render Dashboard → **New → Static Site**
2. Connect dezelfde GitHub-repo
3. Instellingen:
   - **Name**: `uurrooster-frontend-staging`  ← de naam **moet** "staging" bevatten (daarop detecteert de frontend de juiste backend)
   - **Branch**: `staging`
   - **Root Directory**: `frontend`
   - **Build Command**: (leeg laten)
   - **Publish Directory**: `.`
4. Deploy. Open de URL → de app praat automatisch met de staging-backend.

### 4. Testdata inladen

De staging-database start leeg (enkel het admin-account). Twee opties:

- **Realistische test:** importeer de productie-export die je eerder downloadde
  (`hetvlot-backup-YYYY-MM-DD.json`) via **de app → Instellingen → Importeer backup**.
  Zo test je op een kopie van echte data, los van productie.
- **Schone test:** handmatig een paar testmedewerkers toevoegen.

> ⚠️ Importeer je productiedata in staging? Dan staan daar persoonsgegevens van medewerkers.
> Behandel de staging-omgeving met dezelfde zorg (zie de GDPR-issues). Gebruik een sterk
> admin-wachtwoord en deel de URL niet breed.

---

## Checklist na setup

- [ ] Staging-database draait (Frankfurt)
- [ ] Staging-backend draait op branch `staging`, met staging-`DATABASE_URL`
- [ ] `FRONTEND_URL` op de backend = staging-frontend-URL (anders CORS-fouten)
- [ ] Staging-frontend draait op branch `staging`, naam bevat "staging"
- [ ] `STAGING_API` in `config/settings.js` = echte staging-backend-URL
- [ ] Testdata ingeladen
- [ ] Inloggen op de staging-app werkt

## Dagelijks gebruik

```bash
# wijziging maken en testen
git checkout staging
# ... aanpassingen ...
git commit -am "test: beschrijving"
git push origin staging          # → staging deployt automatisch

# tevreden na testen? naar productie:
git checkout main
git merge staging
git push origin main             # → productie deployt automatisch
```
