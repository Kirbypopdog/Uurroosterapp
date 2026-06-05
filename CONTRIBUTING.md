# CONTRIBUTING.md

Welkom. Dit project wordt gebouwd door Victor Goethals met AI-assistentie (Claude Code / Claw).

---

## Lokale omgeving opzetten

```bash
# Vereisten: Node.js 20+, PostgreSQL

git clone https://github.com/Kirbypopdog/Uurroosterapp.git
cd Uurroosterapp

# Database
createdb uurroosterapp
cd backend
cp .env.example .env   # Vul DATABASE_URL, JWT_SECRET in
npm install
npm run db:setup       # Schema + seed (admin + teams)
npm run dev            # Backend op :3001

# Frontend: open frontend/index.html in browser
# Login: admin@hetvlot.be / <zie Render dashboard of .env>
```

---

## Werken met issues

Alle bugs, tech debt en features leven in **GitHub Issues**.
Maak een issue aan vóór je begint — niet achteraf.

```bash
# Bug gevonden
gh issue create --title "[BUG] Korte beschrijving" \
  --label "type:bug,prioriteit:hoog" \
  --milestone "v1.1 — Stabilisatie"

# Review bevinding
gh issue create --title "[REVIEW] Bevinding" \
  --label "type:tech-debt,prioriteit:medium" \
  --milestone "v1.2 — Refactor"
```

Issues sluiten via commit message:
```bash
git commit -m "Fix: vergadering badges na refresh (fixes #31)"
```

---

## Branches & omgevingen

Twee permanente branches, elk gekoppeld aan een eigen Render-omgeving:

| Branch | Omgeving | Doel |
|--------|----------|------|
| `main` | **Productie** — wat het team echt gebruikt | live data, nooit rechtstreeks op experimenteren |
| `staging` | **Testomgeving** — eigen database | veilig uitproberen vóór het live gaat |

Daarnaast korte werk-branches: `feature/xxx`, `fix/xxx`, `refactor/xxx`.

### Workflow

```bash
# 1. Wijziging maken en testen op staging
git checkout staging
# ... aanpassingen ...
git commit -am "test: beschrijving"
git push origin staging          # → staging deployt automatisch

# 2. Tevreden na testen? Naar productie:
git checkout main
git merge staging
git push origin main             # → productie deployt automatisch
```

Zie **STAGING.md** voor de eenmalige setup van de testomgeving op Render.

PR aanmaken (optioneel, bv. voor review):
```bash
gh pr create --title "Fix: stale ruilverzoeken (fixes #30)" \
  --body "Beschrijving van de wijziging"
```

---

## Code regels (samenvatting)

Zie `CLAUDE.md` voor het volledige overzicht. Kritieke regels:

1. **Geen frameworks** (React, Vue, Webpack, Vite)
2. **Parameterized SQL queries** — nooit string concatenation
3. **dataApiFetch()** gebruiken, niet apiFetch()
4. **team_id** syncen met **main_team** bij user updates
5. **Geen console.log** zonder debug-guard in productie
6. **Geen inline styles** in JS-gegenereerde HTML

---

## Tests uitvoeren

```bash
cd backend
npm test        # Alle 188 tests (jest + supertest, geen DB vereist)
```

Voeg tests toe bij elke nieuwe pure functie of backend endpoint. Testbestanden staan in `backend/tests/`:

| Bestand | Wat |
|---------|-----|
| `utils.test.js` | Datumhulpfuncties in `src/utils.js` |
| `email.test.js` | Email helpers (escapeHtml, templates) |
| `api.test.js` | API-endpoints — gebruik `jest.mock('../src/db')` voor de database |
| `validation.test.js` | Frontend pure tijdfuncties |

---

## Reviews

Gebruik `REVIEW.md` als checklist bij elke code review.
Elke bevinding → apart GitHub Issue.

---

## Prioriteiten

Als er open issues zijn met label `prioriteit:kritiek`, worden die eerst opgelost voor nieuwe features.
