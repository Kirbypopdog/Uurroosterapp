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

## Branches & PRs

```
main          — productie, altijd werkend
feature/xxx   — nieuwe features
fix/xxx       — bugfixes
refactor/xxx  — technische schuld
```

PR aanmaken:
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

## Reviews

Gebruik `REVIEW.md` als checklist bij elke code review.
Elke bevinding → apart GitHub Issue.

---

## Prioriteiten

Als er open issues zijn met label `prioriteit:kritiek`, worden die eerst opgelost voor nieuwe features.
