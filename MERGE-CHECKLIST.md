# Merge `staging` → `main`

Voorbereiding, opgesteld op 26 september 2026. **254 commits**, 87 bestanden,
+27.412 / −8.514 regels. Dit bestand hoort niet in de repo te blijven; gooi het
weg na de merge.

---

## 1. De database — nagekeken tegen productie

Bij de eerste opstart na de merge draaien er **17 migraties** die productie nog
niet kent: `020` (die nu elke opstart faalt) plus `033` t/m `047`.

Productie staat op `032`. Alles t/m `019` en `021`–`032` is al gedraaid;
`020` ontbreekt omdat hij faalt.

De riskante migraties zijn defensief geschreven: bij vuile data slaan ze over
met een waarschuwing in plaats van de deploy te laten crashen. Maar ze draaien
**niet opnieuw**, dus zo'n overslag is een stil gat. Daarom vooraf gecontroleerd
tegen de echte productiedata:

| migratie | wat hij eist | in productie |
|---|---|---|
| `040` unieke dienst per start | geen dubbele (medewerker, datum, starttijd) | **0** ✅ |
| `041` één openstaande overname per dienst | geen dubbele openstaande overnames | **0** ✅ |
| `042` check op afwezigheidstype | alleen bekende types | **0** afwijkend ✅ |
| `044` `team_id` = `main_team` | geen scheefstand | **0** ✅ |
| `027` e-mails naar kleine letters | geen adressen die alleen in hoofdletters verschillen | **0** ✅ |

**Geen enkele migratie zal overslaan.** Alle constraints en indexen worden dus
werkelijk aangelegd.

Wat er aan data verandert:

| migratie | effect op productie |
|---|---|
| `020` | **465** activiteiten krijgen alsnog hun `shift_id` (lost #393 op) |
| `039` | **1** dienst met eindtijd `24:00` wordt `00:00` |
| `045` | leadkolommen worden gedropt — **0** rijen hebben er nog iets in staan |
| `033` | foreign keys krijgen `ON DELETE CASCADE` / `SET NULL` (GDPR) |
| `034`–`036`, `043` | nieuwe tabellen voor de verlofplanning, leeg |
| `047` | nieuwe tabel voor geplande overnames, leeg |

Omvang van de database nu: 4.214 diensten, 18 medewerkers, 182 afwezigheden.

> **Maak vooraf een backup.** `045` dropt kolommen en `033` herschrijft foreign
> keys; die twee draai je niet terug met een rollback van de code.

---

## 2. Wat de omgeving nodig heeft

`render.yaml` voegt één variabele toe: **`SENTRY_DSN`**. Leeg laten is een
geldige keuze — dan start de backend geen SDK en haalt de frontend niets van een
CDN, en draait alles precies zoals voorheen. Vul je hem in, dan krijg je
foutmeldingen binnen (EU-regio, met filtering op ziekte- en verlofgegevens).

Verder geen nieuwe variabelen. De bestaande (`DATABASE_URL`, `JWT_SECRET`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `RESEND_API_KEY`, `EMAIL_FROM`,
`FRONTEND_URL`, `DEFAULT_RESET_PASSWORD`) blijven zoals ze zijn.

---

## 3. Wat je collega's meteen zullen merken

Dit is geen stille release. Drie dingen vallen op voor je iets uitlegt:

1. **De hele app ziet er anders uit.** Warme kleuren, nieuw lettertype
   (Hanken Grotesk), een donkere zijbalk in plaats van de bovenbalk, serif-koppen.
2. **Er is een donkere modus.**
3. **De maandweergave is weg.** Die werkte niet en is uit de keuzeknop gehaald.

En er is een compleet nieuwe module: **verlofplanning** — rondes per schooljaar,
met vakantieblokken, een matrix en een verdeelscherm voor de zomer.

Verder nieuw: agendakoppeling (iCal-feed per medewerker), ingelogd blijven
(7 dagen, uitgelogd na 4 uur niets doen), de app op je beginscherm zetten,
medewerker vervangen met een ingangsdatum, en foutmonitoring.

Onder de motorkap: `server.js` ging van 7.213 naar 395 regels, verdeeld over 20
route-modules; 545 tests in 11 bestanden; de snelheidslimiet van 100 naar 600
verzoeken per minuut.

---

## 4. Testen op de staging-URL

Op volgorde van risico. Het bovenste blok is wat kapot gaan écht pijn doet.

### Eerst: kan iedereen werken?

- [ ] Inloggen als admin, als roosterverantwoordelijke, als medewerker
- [ ] Sluit het tabblad, open opnieuw → je bent nog ingelogd
- [ ] Planning laadt, met de juiste diensten en de juiste uren bij elke naam
- [ ] Dienst aanmaken, wijzigen, verwijderen
- [ ] Dienst verslepen naar een andere medewerker
- [ ] Een medewerker ziet alleen wat hij mag zien (geen redenveld bij andermans afwezigheid)

### Dan: de dingen die dagelijks gebruikt worden

- [ ] Ruilverzoek maken, en de tegenpartij aanvaardt het
- [ ] Dienst aanbieden ter overname, een collega neemt hem over
- [ ] Afwezigheid ingeven en achteraf verplaatsen
- [ ] Ziekmelding met automatische overname
- [ ] Uren per week en per periode kloppen met wat je verwacht

### Dan: de roosterbouwer

Dit is het meest complexe deel en er is veel aan veranderd.

- [ ] Concept openen, bewerken, opslaan — de bewaarstatus klopt
- [ ] Twee tabbladen tegelijk open: bewerken in het ene overschrijft het andere niet
- [ ] Concept toepassen op een datumbereik
- [ ] Een handmatig verwijderde dienst blijft weg na opnieuw toepassen
- [ ] Vakantieconcept: gesloten dagen komen door in de planning

### Dan: het nieuwe

- [ ] Verlofronde aanmaken, openen, invullen als medewerker, indienen
- [ ] Goedkeuren, verdelen (zomerblok), en toepassen naar afwezigheid
- [ ] Medewerker vervangen met een ingangsdatum in de toekomst
- [ ] Agendalink aanmaken en in een agenda-app zetten
- [ ] Weekendverantwoordelijke klopt, vakantieverantwoordelijke per week klopt

### Tot slot

- [ ] Donkere modus op elk scherm
- [ ] Op een telefoon: planning, afwezigheid, verlof
- [ ] Verstuurt de app nog mail (ruilverzoek, welkomstmail)

---

## 5. De merge zelf

```bash
git checkout main
git pull origin main
git merge staging
git push origin main
```

Daarna, in volgorde:

1. **Kijk naar de opstartlog van `Uurrooster-backend` op Render.** Daar staat
   welke migraties gedraaid zijn. Verwacht: `020` slaagt nu, en `033` t/m `047`
   draaien voor het eerst. Zie je ergens `Migratie mislukt` of
   `is NIET aangemaakt`, meld dat dan — dat is een stil gat dat niet vanzelf
   dichtgaat.
2. **Controleer #393**: `SELECT count(*) FROM shift_activities WHERE shift_id IS NULL`
   moet flink gedaald zijn ten opzichte van 465.
3. **Log in op productie** en doorloop het eerste blok van de testlijst.

Blijft er iets hangen, dan is terugrollen van de code eenvoudig, maar de
migraties draaien niet terug. Vandaar de backup vooraf.

---

## 6. Wat hier bewust niet in zit

- **#150** (verwerkersovereenkomsten Render/Resend) is geen code en blokkeert
  deze merge niet, maar blijft wel openstaan.
- De Render-service **`MCP-server`** draait op een betaald plan zonder verkeer
  sinds mei. Los van deze merge, maar het kost geld.
