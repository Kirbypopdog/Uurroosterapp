# CHANGELOG

Alle noemenswaardige wijzigingen worden hier bijgehouden.
Format: [Keep a Changelog](https://keepachangelog.com/nl/1.0.0/)

---

## [Unreleased — v1.1]

### Toegevoegd
- Modal focus trap (FocusTrap utility via MutationObserver)
- Swap modal: pre-check of collega's ruilbare shifts hebben
- Login pagina: "Wachtwoord vergeten?"-melding

### Gefixt
- Mobiel menu z-index (dropdown viel achter planning content)
- Role-switcher verborgen in productie (alleen localhost)

### Verbeterd
- 40+ inline `style.display` toggles → `classList.hidden`
- Onboarding checklist: beschrijvende hints bij stappen
- Reset data: dropdown keuze (data / data+accounts / alles behalve eigen account)
- Extra teams verwijderd uit UI (DB kolom behouden)
- Planning filters standaard ingeklapt

---

## [1.0.0] — 2026-03-21

### Toegevoegd
- Volledige roosterplanning applicatie voor Het Vlot
- Timeline-weergave per medewerker met uurblokken
- Roosterbouwer met visuele grid en drag & drop
- Concepten (schedule drafts): opslaan, laden, toepassen op datumbereik
- Vakantieperiodes met vakantie-specifieke bezettingsnormen
- Shift activiteiten (oudergesprek, vorming, overleg, afspraak)
- Ruilverzoeken en overnameverzoeken met goedkeuringsflow
- Audit log met filters en export
- Email notificaties via Resend (9 trigger points)
- Navigatie herstructurering: avatar dropdown, nav groepen, mobile nav
- Design systeem: tokens, focus-visible, typography scale
- Component standaardisatie en empty states
- Profiel tab redesign: hero header, weekrooster overzicht

### Security (pre-launch audit)
- 25 security/data/crash fixes
- Rate limiting op login + globaal
- CORS strict in productie
- trust proxy voor Render
- JWT secret bijgewerkt, DB wachtwoord gereset
- HTML escaping in email templates

### Technisch
- 208 commits, 10 database tabellen
- Database indexen op alle veelgebruikte kolommen
- Atomische transacties voor replaceEmployee en applyDraft
- CI workflow: syntaxcheck JS + bestandscontrole

---

## Versie schema

- **Patch** (1.0.x): bugfixes, geen breaking changes
- **Minor** (1.x.0): nieuwe features, backward compatible
- **Major** (x.0.0): breaking changes, schema migraties vereist
