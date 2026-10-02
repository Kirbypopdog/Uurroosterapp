# REVIEW.md — Checklist voor code reviews

Gebruik dit bestand bij elke review (Claw, Claude Code, of manueel).
Elke bevinding wordt gelogd als GitHub Issue, niet als commentaar in de code.

```bash
# Snelle manier om een bevinding te loggen:
gh issue create --repo Kirbypopdog/Uurroosterapp \
  --title "[REVIEW] Beschrijving" \
  --label "type:bug,prioriteit:hoog" \
  --milestone "v1.1 — Stabilisatie"
```

---

## 1. Security

- [ ] Geen string concatenation in SQL (altijd parameterized queries)
- [ ] Geen gevoelige data in API responses (bv. password_hash in user-objecten)
- [ ] Role checks aanwezig op ZOWEL frontend als backend
- [ ] Geen hardcoded credentials of tokens in de code
- [ ] HTML escaping bij user-generated content in templates
- [ ] Geen nieuwe `console.log` zonder debug-guard

## 2. Performance

- [ ] Geen N+1 queries (geen DB calls in een loop)
- [ ] `applyTeamColors()` niet toegevoegd aan renders
- [ ] Geen onnodige `refreshAll()` of volledige DataStore-reloads
- [ ] Geen nieuwe `<style>` injecties bij elke render
- [ ] Geen synchrone operaties die de UI blokkeren

## 3. Code consistentie

- [ ] Geen inline `style=""` attributen in JS-gegenereerde HTML → CSS classes
- [ ] Gebruik `dataApiFetch()` uit `data.js` (niet `apiFetch()` uit app.js)
- [ ] `team_id` gesynchroniseerd met `main_team` bij user updates
- [ ] Nieuwe schema changes als migratie-entry in de `MIGRATIONS`-array (`runMigrations()` in server.js, niet los SQL)
- [ ] Geen nieuwe globale functies zonder duidelijke namespace

## 4. Toegankelijkheid (a11y)

- [ ] Knoppen zijn `<button>` (niet `<span>` of `<a>`)
- [ ] Interactieve elementen hebben `aria-label` of zichtbare tekst
- [ ] Modals hebben focus trap (FocusTrap utility aanwezig)
- [ ] Geen `user-scalable=no` in nieuwe viewport meta tags

## 5. UX & Feedback

- [ ] Async operaties tonen loading state
- [ ] Succes- en foutmeldingen via ToastManager (niet alert())
- [ ] Lege states aanwezig bij lege lijsten
- [ ] Destructieve acties hebben bevestigingsdialoog

## 6. Backend API

- [ ] Nieuwe endpoints gebruiken parameterized queries
- [ ] Juiste HTTP-methode (GET/POST/PUT/DELETE)
- [ ] Foutresponses geven geen stack traces terug
- [ ] Transacties gebruikt bij multi-step operaties

---

## Na de review

1. Log elke bevinding als GitHub Issue
2. Sluit af met een samenvatting: X kritiek / Y hoog / Z medium gevonden
3. Update `CLAUDE.md` als er nieuwe permanente regels uit komen
