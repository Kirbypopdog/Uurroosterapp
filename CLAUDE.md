# Het Vlot Roosterplanning

Shift planning web app voor Het Vlot. Medewerkers kunnen roosters bekijken, shifts ruilen, verlof aanvragen. Admins/leads beheren het rooster.

## Quick Start (lokaal)

```bash
# 1. PostgreSQL moet draaien (brew services start postgresql)
# 2. Database aanmaken: createdb uurroosterapp
cd backend
cp .env.example .env          # Pas DATABASE_URL aan
npm install
npm run db:setup              # Schema + seed (admin + teams)
npm run dev                   # Backend op :3001

# 3. Frontend openen in browser:
open ../frontend/index.html
# Login: admin@hetvlot.be / <zie Render dashboard of .env>
```

## Architectuur

- **Frontend**: Vanilla JavaScript - GEEN framework, GEEN build step, GEEN npm
- **Backend**: Node.js + Express, single server.js met alle endpoints
- **Database**: PostgreSQL (Render hosted in productie)
- **Auth**: JWT tokens (7 dagen geldig, vernieuwen mee zolang je bezig bent), bcrypt password hashing

## Bestandsoverzicht

### Frontend (`frontend/`)

De regelaantallen stonden hier vroeger bij, maar die verouderden per week en
zeiden niets nuttigs (#291). De kolom "doel" is wat telt.

| Bestand | Doel |
|---------|------|
| `app-globals.js` | AppState, constanten, UndoManager, DOM object, IconHelper, labels en pictogrammen van de activiteitstypes |
| `app-permissions.js` | Rol-checks en permissiefuncties |
| `app-ui.js` | Toast, modals, FocusTrap, tooltips, overlays |
| `app-auth.js` | Login, logout, sessiecheck, rolevisibility |
| `app-nav.js` | Navigatie, switchView, renderHome, week/maand/dag helpers |
| `app-planner.js` | renderPlanning, timeline, heatmap, validatiemeldingen, uren-per-naam |
| `app-shifts.js` | Shift modals, swap modals, shift CRUD, activiteiten |
| `app-swaps.js` | renderSwaps, swap- en overnamekaartenrendering |
| `app-leave.js` | Verlofplanning: rondes, invullen, matrix, goedkeuren, verdelen, export |
| `app-employees.js` | renderEmployees, profiel, medewerker CRUD, weekrooster |
| `app-availability.js` | renderAvailability, afwezigheidsmodal, ABSENCE_TYPES |
| `app-builder.js` | Roosterbouwer: grid, rendering, bewaarstatus, vergaderingen, staffing |
| `app-builder-drafts.js` | Concepten: aanmaken, laden, vergrendelen, toepassen, diff, import/export |
| `app-builder-editors.js` | Bouwer-deelschermen: staffing, vergaderingen, waarschuwingen, urenberekening |
| `app-settings.js` | renderSettings, alle instellingstabs |
| `app-wissels.js` | De tab Personeelswissels: stappen invoeren, voorbeeld per persoon en week, botsingen per dag, concept → bevestigd → terugdraaien |
| `app-admin.js` | Export/import, debug, migratie, sanitize |
| `app-init.js` | initDOM, setupEventListeners, init(), DOMContentLoaded entry |
| `data.js` | DataStore, API fetch wrappers, data loading |
| `verantwoordelijke-regels.js` | Wie er weekend- of vakantieverantwoordelijke is. Pure functies, ook door de BACKEND ingeladen (#397) — zie Mail hieronder |
| `validation.js` | Business rules: 11-uur regel, overlap, min bezetting, datumhelpers |
| `drag-handler.js` | Drag & drop shifts tussen medewerkers |
| `styles.css` | Alle CSS inclusief responsive, themas |
| `index.html` | HTML markup: modals, formulieren, planning grid |
| `patchnotes.js` | "Wat is er nieuw": de notities per versie en het venster dat één keer na een update verschijnt (#421). Een nieuwe versie zet je BOVENAAN `PATCH_NOTES` |
| `config/settings.js` | API URL auto-detect, shift templates, team kleuren |

### Backend (`backend/`)
| Bestand | Doel |
|---------|------|
| `src/server.js` | Express opzetten, opstarten, de routers monteren. Was 7213 regels met alle endpoints erin; sinds #157 nog 395 |
| `src/routes/personeelswissels.js` | Personeelswissels: `ordenStappen` (de volgorde), het voorbeeld (voert de wissel uit en rolt terug), concept, bevestigen, terugdraaien. Gebruikt `voerVervangingUit` en `draaiOvernameTerug` uit `replace-employee.js` |
| `src/routes/*.js` | De endpoints, één bestand per domein. Elk bestand maakt zijn router met `maakRouter()` en exporteert hem; `server.js` hangt ze met `v1.use()` op in de volgorde waarin ze vroeger stonden |
| `src/veilige-router.js` | `maakRouter()`: een router die een afwijzende async handler naar `next(err)` stuurt (#380). Gebruik deze, nooit `express.Router()` rechtstreeks, anders krijgt een verzoek bij een fout géén antwoord |
| `src/middleware/auth.js` | `signToken`, `requireAuth`, `requireAdmin`, `requireRole` |
| `src/helpers/audit.js` | `logAudit`: het schrijven naar de audit log. Het LEZEN is een route en staat in `routes/audit-log.js` |
| `src/helpers/overnames.js` | `voerGeplandeOvernamesUit()`: de overnames uit `geplande_overnames` afmaken die vandaag ingaan. Draait bij opstart en elk uur |
| `src/helpers/verantwoordelijke.js` | De serverkant van de verantwoordelijke: haalt de instellingen op en laat `frontend/verantwoordelijke-regels.js` het antwoord geven |
| `src/helpers/verlofmail.js` | Wie krijgt welke verlofmail, en wie heeft er nog niet ingediend |
| `src/helpers/herinneringen.js` | De geplande herinneringen (verlofronde, verantwoordelijke). Draait bij opstart en elk uur |
| `src/helpers/dienstregels.js` | Waar een dienst aan moet voldoen: `validateShiftRules`, `blockDayIfEmpty`, `getMinRustUren`, de afwezigheidstypes en de tijdcontroles. De enige helpers die meer dan één domein deelt |
| `src/migraties.js` | De `MIGRATIONS`-array en `runMigrations()` |
| `src/db.js` | PostgreSQL connection pool |
| `src/email.js` | Resend email service (9 notificatie types) |
| `src/utils.js` | Pure datumhulpfuncties (`getMonday`, `formatDateYYYYMMDD`, `parseLocalDate`, `getEasterDate`, `getBelgianPublicHolidays`, `vandaagInBelgie`) |
| `sql/schema.sql` | Volledig schema van de eindtoestand. Spiegelt wat de migraties samen opleveren, zodat een verse database in één keer goed staat |
| `scripts/seed.js` | Seed teams + admin account |
| `scripts/setup-db.js` | Voert schema.sql uit |
| `import-backup.js` | CLI tool voor JSON backup import |

### Tests (`backend/tests/`)
| Bestand | Doel |
|---------|------|
| `api.test.js` | Integratietests voor de API-endpoints, met een volledig gemockte database |
| `utils.test.js` | Unit tests voor `src/utils.js` |
| `validation.test.js` | Unit tests voor de pure functies uit `frontend/validation.js` |
| `email.test.js` | Unit tests voor de e-mailhelpers (`escapeHtml`, `formatDate`, `shiftDetailBox`, …) |
| `email-batch.test.js` | Bulkverzending via `resend.batch.send`, inclusief de seriële terugval |
| `email-verzending.test.js` | Wat er wel en niet verstuurd wordt, en naar wie |
| `schooljaar.test.js` | Schooljaar- en periodeberekeningen |
| `schema-drift.test.js` | Bewaakt dat `sql/schema.sql` niet achterloopt op de migraties (#329, #311) |
| `monitoring.test.js` | Wat de foutmonitoring wegfiltert, op sleutelnaam én op waarde (#156) |
| `permissies.test.js` | De pure rolchecks uit `frontend/app-permissions.js`, zoals wie een dienst mag afstaan |
| `nu-aan-het-werk.test.js` | `dienstLooptNu()`: wie er op een moment werkelijk aan het werk is, inclusief nachtdiensten en reserve |
| `verantwoordelijke.test.js` | Wie er weekend- of vakantieverantwoordelijke is: de rotatie, de vakantie per week en de id-vergelijking |
| `cdn-scripts.test.js` | Dat elke verwijzing naar een pakket-CDN in `index.html` een bestandspad én een vaste versie draagt (#396) |
| `vervanging-concepten.test.js` | Dat `replaceEmployee()` na een vervanging ook de conceptencache ververst (#395) |
| `overnames-blijft-actief.test.js` | Dat een geplande overname met "blijft in dienst" de vertrekker op de ingangsdatum niet deactiveert |
| `geplande-wijziging.test.js` | `geplandeWijzigingVoor()`: vanaf de ingangsdatum staat iemand al in zijn nieuwe team, met de uren tegen het nieuwe contract |
| `personeelswissels.test.js` | De volgorde die de app zelf kiest, de invoercontrole, dat het voorbeeld altijd terugrolt, botsingen per dag en de tab in Instellingen |
| `vervang-venster.test.js` | Het vervangvenster: geplande overnames annuleren, en dat de botsingsmelding "Verwijderen" niet meer blind aanraadt |
| `vervanging-verantwoordelijke.test.js` | Dat een vervanging ook de weekend- en vakantieverantwoordelijke overzet, en alleen vooruit (#398) |
| `vakantieverantwoordelijke.test.js` | Dat de bouwer de waarheid is: opruimen van vertrokken aanduidingen, en de uitleg waar Instellingen op steunt (#399) |
| `vrij-telt-mee.test.js` | Dat 'vrij' overal als afwezigheid telt, en dat één bron dat bepaalt (#400) |
| `afwezigheid-zichtbaar.test.js` | Dat het type afwezigheid in het dienstblok staat en niet alleen in de tooltip (#401) |
| `beschikbaar-weg.test.js` | Dat een dag zonder dienst "Vrij" heet in plaats van groen "Beschikbaar", en dat 'vrij' verouderd is maar herkend blijft (#402) |
| `herinneringen.test.js` | De geplande herinneringen: wanneer ze vertrekken, naar wie, en dat ze maar één keer vertrekken (#397) |
| `activiteiten-pilletje.test.js` | Dat een activiteit als wit pilletje met pictogram en uren in het dienstblok staat, welke vorm er past, en dat het tijdlabel van een dienstblok niet afgekapt wordt (#404, #416) |
| `dag-activiteiten.test.js` | Algemene activiteiten (aan een dag, niet aan een persoon): invoercontrole, rechten, agendafeed, chips in de dagkop en dat ze de bezetting niet raken (#418) |
| `overname-overzicht.test.js` | Het venster bij "Overnemen": je week, je uren ervoor en erna, de rust tot de dienst ervóór en erná, en dat het de drie losse vragen vervangt (#417) |
| `patchnotes.test.js` | Wanneer "Wat is er nieuw" verschijnt (één keer per versie, per gebruiker) en dat het in de app aangesloten is (#421) |
| `activiteit-deelnemers.test.js` | Wie er in de deelnemerslijst van een activiteit komt, en wie er een activiteit voor anderen mag aanmaken (#408) |
| `agenda-sequence.test.js` | Dat een gewijzigde dienst een hogere `SEQUENCE` krijgt in de agendafeed, en dat de migratie de trigger pas ná de backfill zet (#409) |
| `vergadering-dubbel.test.js` | Dat een concept toepassen geen tweede Teamvergadering naast de bestaande zet (#407) |
| `init-bestendig.test.js` | Dat `setupEventListeners` geen kale verwijzing naar een functie uit een ander bestand bevat, want één ontbrekende functie legde de hele opstart plat (#412) |
| `verlof-teams.test.js` | Welke teams meedoen aan de verlofrondes (`settings.leaveTeams`): matrix, mails, herinneringen, invullen en indienen, en dat frontend en backend dezelfde grens trekken |
| `routes-inventaris.test.js` | Bewaakt dat er bij het verplaatsen van routes geen pad verdwijnt of van naam verandert (#157). Komt er bewust een endpoint bij of gaat er een weg, werk dan `routes-inventaris.json` in dezelfde commit bij |

Aantallen staan hier bewust niet bij; `npm test` noemt ze en ze verouderen
sneller dan dit bestand (#291).

### MCP server (`mcp-server/`)
| Bestand | Doel |
|---------|------|
| `stdio.js` | De server die `.mcp.json` start onder de naam `uurroosterapp`. Leest zijn gegevens uit `mcp-server/.env`, dat niet in git staat — zie MCP Server verderop |
| `index.js` | Dezelfde tools als HTTP-server, voor een gehoste opzet |
| `.env.example` | Welke variabelen `stdio.js` nodig heeft |

## Database Schema

**Tabellen**: teams, users, shifts, availability, settings, shift_blocks, shift_swap_requests, audit_log, schedule_drafts, shift_activities, dag_activiteiten, leave_rounds, leave_round_blocks, leave_round_entries, leave_round_submissions, geplande_overnames, verstuurde_meldingen

Kernrelaties:
- `shifts.user_id` → `users.id`
- `availability.user_id` → `users.id`
- `users.main_team` → `teams.id`
- `users.team_id` → `teams.id` (voor autorisatie, MOET gelijk zijn aan main_team)

Zie `backend/sql/schema.sql` voor volledige schema.

## Rollen & Permissies

| Rol | Kan |
|-----|-----|
| `admin` | Alles, inclusief user management |
| `roosterverantwoordelijke` | Alle shifts/roosters/teams beheren (geen accountbeheer) |
| `medewerker` | Eigen shifts bekijken/bewerken, ruilen, verlof aanvragen (geen basisrooster) |

## Belangrijke Regels

1. **NOOIT** frameworks of build tools toevoegen (React, Vue, Webpack, Vite, etc.)
2. **ALTIJD** `team_id` syncen met `main_team` bij user updates (anders falen permissies)
3. **ALTIJD** parameterized queries gebruiken (nooit string concatenation in SQL)
4. **Backend retourneert BEIDE** `userId` EN `employeeId` (backward compatibility alias)
5. **Permissions** checken in ZOWEL frontend ALS backend. Alleen de backend is veilig maar niet genoeg: staat de check daar alleen, dan biedt het scherm een actie aan die pas bij de laatste klik geweigerd wordt. Zo bood "Dienst afstaan" zich aan op een dienst uit het verleden, en liep je vier stappen door voor de backend `Shift ligt in het verleden` terugstuurde. De twee moeten dezelfde grens trekken — de backend vergelijkt met vandaag om middernacht, dus `canRequestSwap` doet dat ook, en een dienst van vandaag mag nog
6. **Migraties**: geversioneerd via de `MIGRATIONS`-array + `runMigrations()` in `src/migraties.js` (draait bij elke startup, elke migratie exact één keer). Voeg nieuwe schema changes toe als nieuwe migratie-entry **én werk `sql/schema.sql` bij**, zodat beide wegen dezelfde database opleveren. `backend/tests/schema-drift.test.js` bewaakt dat: een kolom, index, tabel of constraint die alleen in een migratie staat laat die test falen. Die test leest `src/migraties.js` als TEKST, dus verhuist dat bestand ooit, dan moet de test mee. Migratie `000_base_schema` draait `schema.sql` idempotent, dus een verse database (bv. staging) initialiseert zichzelf; `ensureBootstrapData()` maakt standaardteams + admin-account aan zonder bestaande data te overschrijven
7. **shift_blocks**: Bij shift delete wordt block aangemaakt (voorkomt auto-regeneratie). Manual shift create verwijdert block.
8. **applyTeamColors()**: Niet aanroepen bij elke render — enkel na init en bij team-settings wijziging
9. **Fetch wrapper**: Gebruik uitsluitend `dataApiFetch()` uit `data.js`. `apiFetch()` is verwijderd (issue #26 opgelost). Uitzondering: `fetchPublicHolidays()` gebruikt plain `fetch()` want `/public-holidays` vereist geen auth.
10. **console.log**: Nooit toevoegen zonder debug-guard — `DEBUG` variabele staat bovenaan app.js en onderdrukt logs in productie automatisch
11. **Email optioneel**: Accounts kunnen zonder e-mail worden aangemaakt. Welkomstmail wordt automatisch verstuurd zodra een e-mail voor het eerst wordt ingesteld via PATCH /admin/users of PUT /users/:id
12. **Wachtwoorden zijn per account** (#379): `genereerWachtwoord()` maakt bij elke reset én bij elk nieuw account zonder opgegeven wachtwoord een eigen waarde. Die gaat één keer mee in het antwoord (`newPassword`) en wordt door de beheerder persoonlijk doorgegeven; geen enkele mail bevat een wachtwoord en het staat niet in de audit log. Het alfabet mijdt tekens die je bij het voorlezen verwart (geen `o`/`0`, geen `l`/`1`). `DEFAULT_RESET_PASSWORD` is daarmee teruggebracht tot de bulkimport en de oude migratiescripts, waar niemand veertig losse wachtwoorden kan uitdelen

## API Endpoints (belangrijk)

Alle endpoints zijn bereikbaar via `/api/v1/<pad>`. Backward-compat alias op root (`/<pad>`) blijft actief t/m v1.3.

### Auth
- `POST /api/v1/auth/login` - Login, retourneert JWT
- `POST /api/v1/auth/register` - Account aanmaken
- `GET /api/v1/me` - Huidige user info

### Data
- `GET /api/v1/shifts?start=YYYY-MM-DD&end=YYYY-MM-DD` - Shifts ophalen
- `POST /api/v1/shifts` - Shift aanmaken (valideert ook manueel gesloten datums)
- `PUT /api/v1/shifts/:id` - Shift wijzigen
- `DELETE /api/v1/shifts/:id` - Shift verwijderen (maakt shift_block aan)
- `GET /api/v1/availability?start=&end=` - Beschikbaarheid ophalen
- `POST /api/v1/availability` - Beschikbaarheid instellen
- `GET /api/v1/settings` - App instellingen
- `PUT /api/v1/settings/:key` - Setting opslaan (admin/hoofd)
- `GET /api/v1/public-holidays?year=YYYY` - Belgische feestdagen voor een jaar (geen auth)

### Planning
- `CRUD /api/v1/shift-activities` - Activiteiten binnen shifts
- `POST /api/v1/shift-activities/batch` - Dezelfde activiteit voor meerdere mensen, in één transactie: alles of niets (#420)
- `CRUD /api/v1/dag-activiteiten` - Algemene activiteiten aan een dag (#418). Lezen: iedereen; schrijven: admin en roosterverantwoordelijke
- `CRUD /api/v1/schedule-drafts` - Roosterconcepten
- `POST /api/v1/schedule-drafts/:id/apply` - Concept toepassen op datumbereik
- `POST /api/v1/availability/sick-with-takeover` - Bulk ziekmelding + auto-takeover

### Swap/Takeover
- `POST /api/v1/swap-requests` - Ruilverzoek aanmaken
- `POST /api/v1/shift-requests/takeover` - Overnameverzoek aanmaken
- `PUT /api/v1/swap-requests/:id/target-approve` - Doelpersoon accepteert de ruil
- `PUT /api/v1/swap-requests/:id/target-reject` - Doelpersoon wijst de ruil af
- `PUT /api/v1/shift-requests/:id/takeover-accept` - Collega neemt de dienst over

Er is GEEN goedkeuringsstap door een lead: die is in #114 verwijderd. De
doelpersoon handelt een ruil zelf af. De statuswaarde `pending_lead` en de
kolommen `lead_approved`, `lead_response_notes` en `lead_responded_at` zijn in
migratie 045 uit het schema gehaald (#315).

**Bereik van een overname (#281, #283)**: een openstaande overname gaat naar
IEDEREEN, ongeacht team. Drie plekken moeten daarover hetzelfde zeggen, anders
ontstaat er een gat:

| plek | voorwaarde |
|------|-----------|
| `GET /swap-requests` (wat een medewerker ziet) | elke openstaande overname |
| `PUT /shift-requests/:id/takeover-accept` | geen teamvoorwaarde |
| de mail bij een nieuw overnameverzoek | alle actieve niet-adminaccounts |

Dit is een bewuste keuze van Victor (#283). #281 stelde vast dat de lijst en het
aanvaarden niet hetzelfde zeiden; dat gat is eerst met een teamcontrole gedicht
en daarna langs de ruime kant opgelost. Een dienst houdt zijn eigen team, alleen
de persoon verandert.

De enige grens die overblijft: je eigen aanbod aanvaarden kan niet. Daarvoor is
annuleren.

Wie geen overnamemail wil, zet die uit via `PUT /me/email-preferences`;
`verstuurReeks` in `email.js` filtert daarop en laat de aanvrager zelf weg.
Blijkt de hoeveelheid mail in de praktijk te veel, dan zijn de twee versmallingen
uit #283 nog beschikbaar: alleen verbreden bij een dienst binnen 48 uur, of één
dagelijkse samenvatting naast de directe mail aan het eigen team.

### Verlofplanning
- `GET /api/v1/leave-rounds` - Alle verlofrondes (concepten enkel voor beheerders)
- `GET /api/v1/leave-rounds/:id` - Ronde met volledige matrix + indienstatus
- `POST|PUT|DELETE /api/v1/leave-rounds[/:id]` - Ronde beheren (admin/roosterverantw.)
- `PUT /api/v1/leave-rounds/:id/entries` - Invulling opslaan (eigen; beheerder ook voor anderen)
- `POST /api/v1/leave-rounds/:id/submit` - Indienen
- `PUT /api/v1/leave-rounds/:id/submissions/:userId` - Goedkeuren/afwijzen
- `PUT /api/v1/leave-rounds/:id/blocks/:blockId` - Gesloten dagen van een blok opnieuw uit het concept overnemen (409 op een gesloten ronde zonder `?force=1`)
- `PUT /api/v1/leave-rounds/:id/blocks/:blockId/entries` - Definitieve verdeling van een voorkeurblok vastleggen (enkel bij status `gesloten`; vervangt uitsluitend binnen het blokbereik)
- `POST /api/v1/leave-rounds/:id/apply` - Goedgekeurd verlof → availability
- `POST /api/v1/leave-rounds/:id/remind` - Met de hand een herinnering naar wie nog niet indiende (409 op een ronde die niet openstaat)

### Admin
- `GET /api/v1/audit-log` - Audit log met filters en paginatie
- `GET|POST /api/v1/personeelswissels`, `PUT|DELETE /api/v1/personeelswissels/:id` - Personeelswissels (admin en roosterverantwoordelijke); alleen een concept is te wijzigen of te verwijderen
- `POST /api/v1/personeelswissels/voorbeeld` - Wat een wissel zou doen; draait hem echt en rolt ALTIJD terug
- `POST /api/v1/personeelswissels/:id/bevestigen` en `/terugdraaien` - Uitvoeren, en tot de eerste ingangsdatum terugdraaien
- `POST /api/v1/admin/users/:id/replace` - Eén losse vervanging (oud; het accountvenster opent nu de personeelswissels)
- `GET|DELETE /api/v1/admin/geplande-overnames[/:id]` - Geplande overnames bekijken en annuleren (stopt alleen de stap op de ingangsdatum)
- `POST /api/v1/admin/geplande-overnames/:id/terugdraaien` - Alles terugzetten zoals vóór de vervanging, tot de ingangsdatum
- `PUT /api/v1/me/email-preferences` - Email notificatie voorkeur

**Personeelswissels — de manier om iemand te vervangen.** Een tab in
Instellingen (admin en roosterverantwoordelijke), los van de accounts; de knop
in het accountvenster start er een met die persoon ingevuld. Een wissel
beschrijft de HELE situatie in één keer: "Marie gaat uit dienst, Bryan neemt
haar rooster over, Justine dat van Bryan". Aanleiding: op 23 november 2026
liep die ketting als twee losse vervangingen mis (zie verderop).

| | |
|---|---|
| volgorde | zoekt de app zelf (`ordenStappen`): wie doorgeeft vóór wie zijn plaats inneemt. Een kring of iemand die twee keer doorgeeft wordt geweigerd |
| voorbeeld | `POST /personeelswissels/voorbeeld` voert de wissel ECHT uit in een transactie en rolt ALTIJD terug. Zo kan het voorbeeld niet afwijken van wat Bevestigen doet: het is dezelfde code |
| botsingen | per DAG een keuze: rooster overnemen (eigen dienst vervalt) of eigen dienst houden (dienst van de vertrekker vervalt). Wat vervalt gaat mee in `terugdraai.verwijderd` van die stap |
| waarschuwingen | met de hand leeggemaakte dagen (`shift_blocks`) van de vertrekker, en een stap die meteen ingaat (niet terug te draaien) |
| statussen | `concept` (niets gewijzigd) → `bevestigd` (elke stap een `geplande_overnames`-rij met `wissel_id`) → `uitgevoerd` (afgeleid: alle stappen uitgevoerd); `teruggedraaid` |
| terugdraaien | alle stappen in OMGEKEERDE volgorde via `draaiOvernameTerug`, tot de eerste ingangsdatum |
| rollen | gaan NIET mee — bewust los van een wissel |
| afwezigheid | verhuist NIET: iedereen houdt zijn eigen verlof en ziekte. Het voorbeeld meldt wel elke dag waarop een verhuisde dienst op een afwezigheid van de vervanger valt (`afwezigOp`) |
| afwezigheidstab | volgt de wissel per week zoals de planning (`geplandeWijzigingVoor` in `renderAvailability`): vanaf de ingangsdatum de vervanger in zijn nieuwe team, wie vertrekt weg tenzij hij die week nog iets heeft |
| roosterbouwer | volgt de wissel METEEN na het bevestigen, want de concepten zijn dan al herschreven: `builderMedewerkers()` / `conceptWijzigingVoor()` in `data.js` zetten de vervanger in zijn nieuwe team en laten wie vertrekt weg. Vergaderingen en de bezetting in de bouwer gebruiken `builderTeamVan()` |

Op dezelfde ingangsdatum voert `voerGeplandeOvernamesUit()` de stappen uit op
`id`, dus in de volgorde waarin de wissel ze invoegde. De vervanger krijgt team
en uren van de vertrekker zoals die op dat moment zijn — in een ketting dus nog
de oude, want wie doorgeeft heeft zijn eigen nieuwe stap pas later of na hem.

**Een medewerker vervangen (één stap).** Eén verzoek, maar twee momenten. Wat de planning
vooruit laat kloppen gebeurt METEEN: de diensten, de blokkades en de
activiteiten vanaf `transferShiftsFrom` verhuizen naar de vervanger. Wat aan het
CONTRACT hangt — weekrooster, team, extra teams, contracturen, en het
deactiveren van de vertrekker — gebeurt pas op die datum.

Dat onderscheid komt uit de praktijk: iemand neemt een contract over op een
afgesproken dag, maar de vertrekker werkt tot dan gewoon door. Deed de app alles
ineens, dan kon zij vanaf het instellen niet meer inloggen en droeg de vervanger
een contract dat nog niet begonnen was.

| ligt `transferShiftsFrom` in de toekomst? | wat er nu gebeurt |
|---|---|
| nee (of niet meegegeven) | alles ineens, zoals vroeger |
| ja | diensten verhuizen; de rest komt in `geplande_overnames` te staan |

`voerGeplandeOvernamesUit()` in `src/helpers/overnames.js` maakt rijpe overnames
af. Die draait bij het opstarten en elk uur daarna, net als de bewaartermijnen.
De server slaapt in na een kwartier stilte, dus in de praktijk voert de eerste
die de app die dag opent de overname uit — vroeg genoeg voor een grens van een
hele dag. Is een van de twee intussen weg of niet actief, dan vervalt de rij op
`geannuleerd` in plaats van elk uur opnieuw te mislukken. Een partiële unieke
index laat maar één `gepland`-rij per vertrekker toe.

`eigenDienstenVervanger` zegt wat er met de EIGEN diensten van de vervanger
gebeurt vanaf die datum: `behouden` (standaard) of `verwijderen`. Bij
`behouden` zoekt de route eerst botsingen op en weigert met **409** plus een
lijst `botsingen: [{datum, vertrekker, vervanger, zelfdeStart}]`. Zonder die
controle liep de vervanging tegen de unieke index
`idx_shifts_uniek_per_start` aan en las de beheerder alleen "Server error bij
vervanging", zonder één aanwijzing wélke dag het probleem was. Een overlap met
een ANDERE starttijd wordt óók gemeld: die glipt langs de index en zou de
vervanger stilletjes twee diensten op één dag geven.

De route herschrijft ook de ROOSTERCONCEPTEN: in elk grid komt het id van de
vervanger in de plaats van dat van de vertrekker. De bouwer leest die concepten
niet op bij het openen maar uit `DataStore.settings.schedule_drafts`, de kopie
van bij het opstarten. `replaceEmployee()` in `data.js` moet die dus mee
verversen (#395). Deed het dat niet, dan bleef het raster het OUDE id tonen —
dat is nu van een gedeactiveerde medewerker en krijgt geen rij meer, dus de
vervanger stond erbij met een lege week terwijl de database haar diensten
gewoon had. Elke nieuwe cache die de vervangroute raakt hoort in diezelfde
`Promise.all`.

De VERANTWOORDELIJKHEDEN verhuizen ook mee, maar alleen VOORUIT (#398). De
grens is dezelfde als bij de diensten: `transferShiftsFrom`, of vandaag als die
er niet is. Wat daarvóór ligt blijft op naam van de vertrekker — dat is geen
fout maar de waarheid, zij was toen verantwoordelijk.

| wat | gedrag |
|---|---|
| `holidayPeriods[].weeklyResponsibles` na de ingangsdatum | verhuist |
| idem vóór de ingangsdatum | blijft staan |
| `responsibleRotation.assignments` | idem, en wordt als GETAL weggeschreven |
| `rotationStartEmployee` (het anker) | verhuist **altijd**, ook achterwaarts |

Dat anker is geen toewijzing aan een week maar het punt waar de telling begint.
Blijft het op iemand staan die weg is, dan vindt de berekening hem niet terug in
de kandidatenlijst en schuift de hele rotatie één plaats op.

Dit stond eerst in de FRONTEND, ná de aanroep van `replaceEmployee`, en dekte
alleen `responsibleRotation` — `holidayPeriods` niet. Een vakantieweek bleef dus
wijzen naar iemand die weg was; in productie stond Jill Dias maanden na haar
vervanging nog als verantwoordelijke voor de tweede kerstvakantieweek, en de
herinneringsmail van #397 zou háár daarover aangeschreven hebben.

Het hoort in de BACKEND en nergens anders: liet je dat frontendblok staan, dan
schreef het zijn eigen verouderde `DataStore`-kopie meteen weer terug over de
waarde die de route net gezet had. Om dezelfde reden ververst `replaceEmployee()`
in `data.js` nu ook de instellingen.

**Wisselt de vertrekker alleen van team of functie**, vink dan "blijft in dienst"
aan (`vertrekkerBlijftActief`, bewaard als
`geplande_overnames.vertrekker_blijft_actief`, migratie 052). Hij wordt dan
NIET gedeactiveerd, en alleen de verzoeken over diensten vanaf de ingangsdatum
vervallen. Zonder dat vinkje liep een ketting als "Justine neemt Bryans rooster
over vanaf 26 november, Bryan dat van Marie vanaf 30 november" stuk: Bryan werd
op 26 november gedeactiveerd, de tweede overname verviel dan op "niet actief",
en Marie's diensten stonden al op naam van iemand zonder rij in de planning.

**De volgorde in zo'n ketting doet ertoe**: eerst de vervanging van wie
doorschuift (Bryan → Justine), dan die waarin hij zelf de vervanger is
(Marie → Bryan). Omgekeerd zou de tweede Marie's diensten, die dan al bij Bryan
staan, mee naar Justine schuiven, net als zijn plek in de concepten. De route
weigert dat met een **409** en `volgorde: true`.

**Een geplande overname annuleren** kan in het vervangvenster: bovenaan staat
wat er voor die medewerker al gepland is, met een knop "Annuleren"
(`GET` en `DELETE /admin/geplande-overnames[/:id]`). Annuleren stopt ALLEEN wat
er op de ingangsdatum nog moest gebeuren — team, uren, weekrooster,
deactivatie. De diensten die bij het instellen al verhuisd zijn blijven staan,
en eigen diensten die met "Verwijderen" gewist zijn komen niet terug. Het
venster en het antwoord zeggen dat allebei.

Dat "Verwijderen" was precies wat in productie misging (23 november 2026): bij
Marie → Bryan meldde de app botsingen met Bryans eigen Vlot 1-diensten, de
melding raadde "Verwijderen" aan, en 121 diensten die naar Justine hadden
moeten gaan verdwenen. Ze zijn uit het basisconcept opnieuw opgebouwd. De
botsingsmelding raadt dat nu niet meer blind aan maar wijst op de volgorde, en
de bevestiging zegt hoeveel diensten er verdwijnen.

**Terugdraaien tot de ingangsdatum.** Een geplande overname legt bij het
instellen in `geplande_overnames.terugdraai` (JSONB, migratie 053) vast wat ze
deed: de id's van de verhuisde diensten, blokkades en activiteiten, de GEWISTE
diensten zelf (volledige rijen), de concepten van vóór de wijziging met hun
`updated_at` erna, en de verantwoordelijkheden voor en na.
`POST /admin/geplande-overnames/:id/terugdraaien` zet dat terug en zet de
status op `teruggedraaid`, alleen vóór de ingangsdatum. Wat intussen door
iemand anders gewijzigd is, wordt NIET overschreven — een dienst waar de
vertrekker op dat uur intussen zelf iets heeft, een concept met een andere
`updated_at`, een instelling met een andere waarde — en het antwoord noemt
dat. Een overname van vóór migratie 053 heeft geen vastlegging en kent alleen
Annuleren.

**Al zichtbaar vóór ze ingaat, voor IEDEREEN.** `GET /admin/geplande-overnames`
mag elke ingelogde gebruiker lezen (wie de overname instelde alleen de
beheerders); annuleren en terugdraaien blijven bij de admin.
`geplandeWijzigingVoor()` in `data.js` (puur) zegt per medewerker en datum wat
er verandert. De planning gebruikt dat per WEEK (op de maandag): vanaf de
ingangsdatum staat de vervanger in zijn nieuwe team (`teamVan()` in
`renderTimelineView`) en valt wie uit dienst gaat weg — tenzij hij die week nog
een dienst heeft, want een dienst zonder rij is onzichtbaar. De uren tellen
vanaf de ingangsdatum tegen het NIEUWE contract. Er stond ook een label onder
de naam ("Vanaf 30 nov: Cargo · 35u"); Victor vond dat overbodig naast de
teamindeling en het is weggehaald. De database zelf volgt pas op de
ingangsdatum. Instellingen > Accounts toont alle geplande wijzigingen met
Terugdraaien of Annuleren.

Openstaande ruil- en overnameverzoeken van of naar de vertrekker worden
ingetrokken — maar pas op de ingangsdatum, want zolang zij werkt zijn ze geldig.
Ze laten staan betekende dat de tegenpartij een verzoek zag van iemand die weg
is, en dat aanvaarden de dienst van de VERVANGER verzette. Meeverhuizen is geen
alternatief: dan erft de vervanger een vraag die zij nooit gesteld heeft.

### Mail: aankondigingen en herinneringen (#397)

Drie mails die er niet waren, plus de reden waarom ze eruitzien zoals ze
eruitzien.

| mail | wanneer | naar wie |
|------|---------|----------|
| `leave_round_opened` | bij de OVERGANG naar `open` | iedereen die meedraait in het rooster |
| `leave_round_reminder` | 7 en 2 dagen vóór de deadline, én via de knop | wie nog niet INDIENDE |
| `responsible_reminder` | maandag, over de week dáárna | de verantwoordelijke zelf |
| `responsible_missing` | idem, als er niemand is | admin + roosterverantwoordelijke |

Elk type heeft een eigen schakelaar in Instellingen, zodat de herinneringen uit
kunnen zonder de aankondiging zelf — en omgekeerd.

**De server is geen klok.** Hij slaapt in na een kwartier stilte, dus
`setInterval` levert geen betrouwbaar moment. In de praktijk draait deze taak
wanneer de eerste bezoeker hem wakker maakt: soms één keer op een dag, soms
tien keer, en op een dag dat niemand inlogt helemaal niet. Daar volgt alles uit:

1. **Claimen vóór versturen.** Elke melding legt eerst een regel vast in
   `verstuurde_meldingen` (`soort` + `sleutel`, uniek) en verstuurt daarna pas.
   Een tweede run vindt de claim bezet en doet niets. Loopt het versturen
   daarna stuk, dan is het gevolg één gemiste mail in plaats van een stroom
   herhalingen — en dat is de goede kant om op te falen bij iets dat naar
   iedereen gaat.
2. **Inhalen, niet missen.** Niets kijkt naar "is het vandaag precies dag X".
   De verlofherinnering vuurt bij "nog hoogstens N dagen", de verantwoordelijke
   bij "de week hierna is nog niet aangekondigd". Slaapt de server op de dag
   zelf, dan vertrekt de mail de eerstvolgende keer — één keer.
3. **Mijlpalen claimen die je overslaat.** Gaat een ronde pas twee dagen vóór
   de deadline open, dan is 7 niet meer van toepassing maar wél nog vrij. Zonder
   die mijlpaal mee te claimen zou hij een dag later alsnog vuren, naast die van
   2. De run claimt daarom elke mijlpaal die ruimer is dan de huidige.
4. **Daarom is er óók een knop.** "Herinnering sturen" bij een open ronde werkt
   op het moment dat je hem indrukt, en dat is wat je nodig hebt als de deadline
   morgen is. Die knop claimt bewust NIET: een beheerder mag twee keer
   herinneren. Het antwoord noemt wie er niet bereikt is en wie er geen
   e-mailadres heeft — anders sluit je de ronde in de overtuiging dat iedereen
   bericht kreeg.

**Eén gat, met opzet.** Slaapt de server een hele week, dan wordt die week
overgeslagen in plaats van achteraf aangekondigd. Mailen over een weekend dat al
bezig is helpt niemand.

**De verantwoordelijke staat één keer beschreven.** `getOrCalculateResponsible()`
stond volledig in `data.js` en was dus alleen in de BROWSER beschikbaar. Voor
deze mail moet de server dezelfde vraag kunnen beantwoorden. De regels zijn
daarom verhuisd naar `frontend/verantwoordelijke-regels.js`, als pure functies
zonder DataStore; `data.js` en `backend/src/helpers/verantwoordelijke.js`
vertalen allebei alleen nog hun eigen gegevens naar diezelfde invoer. Overschrijf
die logica NIET aan de serverkant — twee kopieën lopen uiteen zonder dat iemand
het merkt, precies zoals bij de filtering van de foutmonitoring.

Die module vraagt zijn invoer **bij naam** (`roosterpatroon`, `vakantieperiodes`,
`rotatie`, …) en niet als settings-blob. Dat is met opzet omslachtig: de
frontend noemt het veld `schedulePattern` en de database `schedule_pattern`, en
wie de verkeerde sleutel doorgeeft krijgt stil de STANDAARD terug — een
omgekeerde weekendcyclus, zonder één foutmelding.

**Let op bij elke nieuwe ontvangerslijst**: `verstuurReeks` filtert op de
SNAKE_CASE kolom `email_notifications_enabled`. Selecteer je alleen de camelCase
alias, dan is dat veld daar `undefined`, is `!== false` waar, en krijgt iemand
die de mail net heeft uitgezet hem alsnog. De queries in `verlofmail.js` en
`verantwoordelijke.js` selecteren daarom allebei de namen.

### Agendakoppeling (iCal)
- `POST /api/v1/me/ical-token` - Persoonlijke feedlink aanmaken of vervangen
- `PUT /api/v1/me/agenda-omschrijvingen` - Gaan de omschrijvingen van je activiteiten mee? (#410)
- `GET /api/v1/calendar/:token.ics` - De feed zelf (geen auth, het token ís de auth)

De feed geeft dertien maanden rooster (30 dagen terug, een jaar vooruit) plus de
naam van de medewerker en de notities per dienst, aan iedereen die de URL heeft.
Het token is dus een geheim, en daar hangen vier regels aan (#154):

| wanneer | wat er gebeurt |
|---------|----------------|
| eigen wachtwoord wijzigen (`PUT /users/:id`) | het token roteert |
| beheerdersreset (`POST /admin/users/:id/reset-password`) | het token wordt **gewist**, niet vervangen |
| elke ophaling van de feed | `ical_last_access` wordt bijgewerkt |
| 60 dagen aangemaakt zonder één ophaling | `enforceRetentionPolicies()` trekt het in |

Die laatste is met opzet géén rotatie op tijd. Een link die iemand werkelijk
gebruikt ongeldig maken breekt zijn agenda zonder dat hij begrijpt waarom, en
hij merkt het pas als hij een dienst mist. Een link die nooit opgehaald is, kan
per definitie niets breken.

Bij een beheerdersreset wordt het token gewist en niet vervangen: een nieuwe
link heeft geen zin als niemand hem te zien krijgt. De medewerker activeert zelf
opnieuw. Het antwoord draagt `agendalinkIngetrokken`, en zowel het venster bij
de beheerder als de resetmail zegt het, anders merkt de medewerker alleen dat
zijn agenda stilletjes achterloopt.

**Geen toegangstabel.** `ical_last_access` is één tijdstempel op de gebruiker,
geen rij per ophaling. Een agenda-app haalt elk kwartier op, dus dat zou een
eindeloos groeiende tabel met verbindingsgegevens van medewerkers zijn: meer
persoonsgegevens aanmaken om persoonsgegevens te beschermen.

**Een gewijzigde dienst moet een hogere `SEQUENCE` krijgen** (#409). Een
abonnee-agenda koppelt een binnenkomende VEVENT op `UID` aan de afspraak die hij
al heeft, en gebruikt `SEQUENCE` om te beslissen of dit een nieuwere versie is.
Stuur je er geen mee, dan houdt hij impliciet 0 aan en laat hij staan wat hij
heeft: een dienst die van 13:00–23:00 naar 09:00–16:00 ging, bleef in Outlook op
13:00–23:00 staan, maanden lang, terwijl de feed gewoon opgehaald werd.

| regel | waarde |
|---|---|
| `SEQUENCE` | seconden tussen 1 jan 2020 en `shifts.updated_at`, minstens 1 |
| `LAST-MODIFIED` | `updated_at` in UTC |
| `DTSTAMP` | idem — per GEBEURTENIS, niet per verzoek |

Dat laatste stond op "nu", één waarde voor het hele verzoek, dus elke ophaling
gaf élke gebeurtenis een nieuw stempel: ruis in plaats van een signaal.

Het ijkpunt is **2020 en niet de Unix-epoch**, anders staat het getal nu al op
1,7 miljard en komt het in de buurt van wat een client in een 32-bits geheel
getal kwijt kan. En het is **nooit 0**: elke bestaande koppeling heeft nog nooit
een `SEQUENCE` gezien en houdt dus 0 aan, dus een minimum van 1 werkt elke
bestaande agenda één keer helemaal bij — inclusief de dagen die er al verkeerd
in stonden.

**`shifts.updated_at` wordt door een TRIGGER bijgehouden**
(`trg_shifts_updated_at`), niet door de routes. Diensten worden vanuit een stuk
of zes routes geschreven — shifts, draft-apply, replace-employee, swaps, de
bulkziekmelding, de import — en één daarvan vergeten betekent een agenda die
stil achterloopt, precies de fout die hier wordt opgelost.

**Let op de volgorde in migratie 049.** Migratie `000_base_schema` draait
`schema.sql` bij élke opstart, en die maakt de trigger ook aan. Hij bestaat dus
al wanneer 049 draait, en een `BEFORE UPDATE`-trigger vuurt óók op de backfill:
die zette alle rijen op `created_at` en de trigger zette ze meteen weer op
`NOW()`. De backfill deed dan niets, zonder één foutmelding. De migratie laat
de trigger daarom eerst vallen, vult bij, en zet hem daarna terug. Dit kwam
alleen aan het licht door de migratie tegen een ECHTE PostgreSQL te draaien; de
testsuite draait met een gemockte database en ziet dit soort dingen niet.

**Een dienst op een afwezigheidsdag gaat NIET mee** (#419). De dienst blijft
in de planning staan tot iemand hem overneemt (#401), dus de feed stuurde hem
door en wie verlof nam zag in Outlook nog steeds dat hij moest werken — 73
diensten in het feedvenster, bij 9 mensen met een agendalink. De queries voor
diensten én activiteiten sluiten nu elke dag uit waarop een rij in
`availability` staat met een type uit `AFWEZIGHEIDSTYPES`. Er komt bewust
GEEN afwezigheid in de plaats: de feed heeft geen login en ziekte is
gezondheidsinformatie (#152). Een abonnee-agenda vervangt zijn inhoud bij elke
ophaling, dus de dienst verdwijnt vanzelf, en komt terug als de afwezigheid
geschrapt wordt.

**Activiteiten gaan mee, hun omschrijving alleen op eigen verzoek** (#410). Een
vergadering van 13 tot 16 uur stond niet in je agenda: je zag alleen de dienst.
Elke activiteit is nu een eigen VEVENT (`UID:activiteit-<id>@hetvlot`) binnen
die dienst.

De TITEL is de keuze. Standaard staat er alleen het soort — `Overleg`,
`Vergadering` — en pas met `users.ical_omschrijvingen` aan komt de eigen
omschrijving erin. Dat is geen voorzichtigheid om de voorzichtigheid: de feed
heeft geen login, en in dat veld staan in productie `Eind evaluatie Lois`,
`AZ sint-lucas met J.` en `Samen met kamer 12 collect & go doen` — jongeren bij
naam, een ziekenhuisbezoek, een kamernummer. De schakelaar staat per MEDEWERKER
in zijn eigen profiel en is bewust geen beheerdersinstelling: het is zijn link.

**Het omzetten van die schakelaar moet de SEQUENCE verhogen.** De SEQUENCE van
een activiteit komt uit haar eigen `updated_at`, en die beweegt niet als een
gebruiker zijn voorkeur wijzigt — dus zou de titel wel in de feed veranderen
maar in de agenda blijven staan zoals hij was. Daarom legt
`users.ical_voorkeur_gewijzigd` dat moment vast en neemt de feed
`Math.max(seq(activiteit), seq(voorkeur))`. Dezelfde fout als #409, één laag
dieper.

**Geen tweede lijstje met labels.** Zonder omschrijving wordt `vergadering`
gewoon `Vergadering`: alle zes de types zijn één Nederlands woord, dus een
hoofdletter volstaat. Een labellijst aan de serverkant zou uiteenlopen met
`ACTIVITY_TYPE_LABELS_FULL` in de frontend — de fout uit #400.

**Eén trigger-functie voor beide tabellen.** `shifts_zet_updated_at` uit #409
deed niets tabel-specifieks en heet sinds migratie 050 `zet_updated_at`;
`shifts` en `shift_activities` hangen er allebei aan. Een tweede kopie ernaast
zetten is precies diezelfde drift. Let op de volgorde in die migratie: de oude
functie kan pas vallen nádat beide triggers omgehangen zijn, want een functie
waar nog een trigger aan hangt laat zich niet droppen.

## Frontend Patronen

- **DataStore** (`data.js`): Centrale data cache, alle API calls gaan hierdoor
- **Settings**: `frontend/config/settings.js` voor defaults, persistent via `PUT /settings/:key`
- **Modals**: `openShiftModal(shift, canEdit)` - view vs edit mode op basis van permissies
- **Scroll preservation**: ScrollY wordt bewaard bij planner re-renders
- **Validation**: `validation.js` draait client-side checks voor shift toewijzingen
- **Verlofplanning**: één ronde = één SCHOOLJAAR, opgebouwd uit blokken (`leave_round_blocks`) die verwijzen naar `settings.holidayPeriods` — dus geen tweede plek waar vakantiedatums staan. Modus staat per BLOK: `binair` (kleine vakanties: werken/verlof) of `voorkeur` (zomer: werken/liever_niet/zeker_niet). De UI groepeert blokken in tabs zoals de Excel: alle binaire blokken samen onder "Kleine vakanties", de voorkeurblokken onder "Zomer". Invulling per DAG (week-snelknoppen in de UI, want de praktijk vult per werkweek + weekend apart in). Een dag moet binnen één van de blokken vallen — de schoolweken ertussen zijn geen geldige invoer. Bij een voorkeurblok legt de beheerder ná het sluiten de definitieve verdeling vast (entries op `verlof` zetten) vóór `apply`. Matrix zichtbaar voor iedereen; invullen enkel voor jezelf en enkel per WEEK — er is geen dag-modus meer, ook niet voor beheerders.
- **Welke teams doen mee aan een verlofronde**: niet elk team vraagt zijn verlof via een ronde aan — jobstudenten, stagiairs en het kantoor niet. Instellingen > Teams heeft daarvoor een vinkje **Verlof**, naast Bezetting en Weekend, bewaard als `settings.leaveTeams` (team-id's). Ontbreekt de instelling, dan doet elk team mee, zoals vroeger. Wie niet meedoet krijgt geen mail bij het openen, geen herinnering, geen rij in de matrix, geen taak op het beginscherm en een uitleg in plaats van het invulscherm; de backend weigert invullen en indienen met een 403. De regel staat twee keer: `draaitMeeInVerlof()` in `app-permissions.js` en `doetMeeAanVerlof()` in `helpers/verlofmail.js`, en `verlof-teams.test.js` toetst ze tegen dezelfde gevallen. Het telt op het HOOFDteam (`main_team`). Let op: `data.js` neemt bij het laden alleen een vaste lijst instellingen over (twee keer: laden en herladen); een nieuwe instelling die daar ontbreekt werkt alleen in de browser van wie hem net aanklikte.
- **Zomerronde afwerken**: `apply` neemt alleen entries met status `verlof` over, terwijl een voorkeurblok enkel `werken`/`liever_niet`/`zeker_niet` bevat. Zonder tussenstap levert een zomerronde dus niets op. De beheerder legt daarom eerst de verdeling vast via het verdeelscherm (`AppState.leaveScreen = 'verdelen'`, knop "Verlof verdelen" bij een gesloten ronde). `leaveVerdeelVoorstel()` zet een voorstel klaar: wie iets anders dan werken vroeg krijgt verlof, wie niets invulde krijgt werken. Bewust géén bezettings- of eerlijkheidsregels — die komen later. Opslaan gebeurt via het blok-scoped entries-endpoint, nooit via `PUT /leave-rounds/:id/entries`: dat vervangt álle entries van een gebruiker in de ronde en zou de kleine vakanties wissen.
- **Statusovergangen van een ronde**: `concept` → `open` → `gesloten` → `toegepast`, en vanuit `gesloten` kan je terug naar `open` met de knop "Ronde heropenen". Terug vanuit `toegepast` kan NIET, en dat is een beslissing (#386): het verlof staat dan in de planning, en een heropende ronde zou daarvan los gaan lopen. Een fout in een toegepaste ronde herstel je via "Verlof verdelen" en opnieuw toepassen — `apply` stemt de planning dan af (#384). De knop verschijnt daarom alleen bij `gesloten`; hem ook bij `toegepast` tonen levert enkel de 409 van de backend op.

- **`apply` neemt alleen GOEDGEKEURD verlof**: de query joint op `leave_round_submissions` met `s.approved IS TRUE`. Ingevulde dagen van iemand die niet heeft ingediend, of wiens indiening nog niet beoordeeld is, tellen dus niet mee. Dat is de bedoeling, maar het leverde een scherm op dat zichzelf tegensprak: een matrix vol rode cellen en een groene melding "0 verlofdagen toegepast", waarna de ronde alsnog op `toegepast` sprong. Staat er verlof klaar dat van niemand goedgekeurd is, dan weigert `apply` nu met **409** en noemt hij wie het tegenhoudt, opgesplitst naar niet ingediend / niet beoordeeld / afgewezen. Die weigering geldt alleen bij status `gesloten`: bij een ronde die al `toegepast` is moet het opruimen van #384 kunnen draaien, ook als er intussen geen goedkeuring meer over is. Zijn er helemaal geen `verlof`-dagen ingevuld, dan is nul het juiste antwoord en gaat het gewoon door.

- **Gevraagd naast vastgelegd** (#377): `leave_round_entries` heeft twee kolommen. `status` is wat er GELDT, `requested_status` is wat de medewerker VROEG. Bij het invullen zijn ze gelijk; alleen het blok-scoped verdeelendpoint laat ze uiteenlopen, en dat draagt de gevraagde waarde expliciet over de DELETE heen. Het verdeelscherm kleurt de cel naar `status` en zet de letter naar `requestedStatus`, zodat de beheerder ná het vastleggen nog ziet wie "zeker niet" zei en wie alleen "liever niet". `leaveWensenBewaard()` toetst of gevraagd en geldend ergens uiteenlopen — NIET of er een gevraagde waarde bestaat, want migratie 043 heeft die voor bestaande rijen gelijkgezet aan `status`. Bij een ronde die vóór die migratie verdeeld is, valt het scherm daarom terug op de oude tekst "letter = de vastgelegde verdeling".
- **Gesloten dagen in een verlofronde**: welke dagen tijdens een vakantie gesloten zijn, wordt beslist in het roosterconcept (`draft.grid._pattern.weeks[i].closedDays`, JS-daggetallen met 0=zo, 6=za). De ronde neemt dat bij het openen over in `leave_round_blocks.closed_dates` (absolute datums), zodat een medewerker het ziet zonder `GET /schedule-drafts` te mogen lezen én zodat later na te gaan is welke weekends toen werkweekends waren. Drie toestanden: `null` = onbekend (geen concept gekoppeld), `[]` = alles open, `[...]` = deze dagen dicht — die mogen nooit op één hoop. Bijwerken gebeurt expliciet via de knop "Gesloten dagen bijwerken uit concept", nooit automatisch. **WEEKCONVENTIE**: `_pattern.weeks["i"]` betekent "de i-de maandagweek van de vakantieperiode" — dat is wat de bouwer toont (`getBuilderVakantieWeekStart`), NIET het resultaat van `getWeekNumber()`. `closedDatesFromPattern()` in `app-leave.js` en de shiftgeneratie in `server.js` volgen die conventie.
- **Feestdagen**: `DataStore._publicHolidaysCache` — lazy geladen via `fetchPublicHolidays(year)`. Gebruik `getPublicHoliday(date)` voor rendering. Let op: gebruik hier plain `fetch()`, niet `dataApiFetch()` (endpoint vereist geen auth)
- **Gesloten dagen uit een vakantieconcept**: een basisrooster schrijft zijn patroon bij het toepassen naar `settings.schedule_pattern`, waardoor `isDayClosed()` het kent. Een vakantieconcept doet dat bewust NIET — zijn cyclus is vakantie-relatief en zou het jaarpatroon verzieken. Bij het toepassen worden zijn gesloten dagen daarom als absolute datums weggeschreven naar `settings.conceptClosedDates` (`[{date, reason, draftId}]`), per concept vervangen. `isDayClosed()` en `getClosedDateInfo()` lezen die mee, zodat planning, drag-drop en shift aanmaken kloppen. Ze staan apart van `closedDates` en verschijnen dus niet in het lijstje "manueel gesloten datums" in Instellingen.
- **Meldingen** (#119): één component in `styles.css`, met vier soorten plus een neutrale. `.alert` is de canonieke naam (flex, dus met pictogram naast de tekst); `.info-box`, `.warning-banner`, `.validation-warning`, `.builder-11h-warnings` en `.leave-banner` delen dezelfde declaraties in plaats van ze te herhalen. Kleuren komen uit de `--alert-{error,warning,info,ok}-{bg,border,text}` tokens, die per thema omslaan, dus een nieuwe melding werkt automatisch in donkere modus. Voeg nooit een eigen achtergrond of rand toe aan een melding: gebruik `class="alert alert-warning"` en laat de tokens hun werk doen
- **Kleuren** (#180): gebruik de tokens, nooit een hexwaarde. De warme palette staat bovenaan `styles.css`; voor alles wat een betekenis draagt zijn dat de `--alert-*`-tokens (zie Meldingen hierboven). Een hardgecodeerde kleur werkt per definitie maar in één thema, en dat is hoe de oude Tailwind-waarden hier binnenkwamen. Teamkleuren zijn de uitzondering: die horen bij een team en hebben hun eigen `--team-*`-tokens
- **Zijbalk** (#162): de zijbalk is in BEIDE thema's donker, want hij is een eigen vlak en geen stuk pagina. Alles wat erin staat gebruikt daarom de `--sidebar-*`-tokens (`-bg`, `-text`, `-text-active`, `-label`, `-active-bg`, `-hover-bg`, `-line`) en nooit de tekstkleuren van de pagina zoals `--text-primary`. Een `body.dark-mode`-uitzondering op iets in de zijbalk is bijna altijd fout: die zou de zijbalk juist terug naar de paginakleuren trekken. De dekkingen zijn gemeten op contrast, niet gekozen op smaak: navigatietekst `.72` haalt 8,1 en het groepslabel `.55` haalt 5,4
- **Dienstblok in de tijdlijn** (#163): het blok is smal, en dat bepaalt wat erin past. Nagemeten op 1440 pixels in weekweergave houdt een dienst van acht uur 59 pixels over: de tijd past daar op 9px en niet op 10. Grotere tekst knipt de tijd af, en een afgeknipte tijd leest als een ANDERE tijd. Verhoog die maten dus niet zonder opnieuw te meten. Activiteiten stonden hier als tekstchips; dat is via een balkje (#406) een pilletje geworden (#416, zie verderop). Wat ervan overblijft is de les: de achtergronden van `.activity-type-*` zijn ondoorzichtig, want onder een dienstblok ligt de teamkleur en die verschilt per team; met iets doorzichtigs hangt het leescontrast af van wie er in welk team zit. Het verloop van het blok loopt van 78 naar 88 procent teamkleur en niet tot 100: bij de volle kleur zakte de tekst op drie van de vijf teams onder de contrasteis
- **Afwezigheid zichtbaar in de planning** (#401): een dienst van iemand die
  afwezig is kreeg alleen een rode GLOED om het blok, en het type stond
  uitsluitend in de tooltip. Je moest er dus met de muis op gaan staan om te
  zien dát een collega verlof had, en daardoor viel het niemand op.

  Dat is géén randgeval: van de 29 verlofdagen in productie staat er op 28 nog
  gewoon een dienst. De dienst blijft namelijk staan tot iemand hem overneemt of
  verwijdert. De markering hoort dus op het BLOK, niet op de celachtergrond —
  die ligt eronder.

  Het type staat als een schuin **lintje** over de rechterbovenhoek
  (`.afwezig-lint`). Het blok kreeg daarbij ook een EIGEN beige achtergrond uit
  de alert-tokens, maar **die is er in #414 weer uit**: het lint heeft zijn
  eigen ondergrond — precies waarom het de drie afgekeurde ontwerpen versloeg —
  dus het leest op elke teamkleur hetzelfde, met of zonder beige eronder. Wat
  het beige wél deed was de teamkleur wegnemen, en die draagt informatie: in
  een rij vol blokken zie je daaraan bij welk team een dienst hoort. Een
  afwezigheid is geen reden om dat te verbergen. Het signaal is het lint plus
  de rode gloed.

  **Drie ontwerpen sneuvelden hiervoor**, en elk om een reden die het onthouden
  waard is:

  1. **Een rood chipje op de regel van de activiteiten.** Niet te onderscheiden
     van een activiteitenchip, dus "Verlof" las als nóg een activiteit. Wat het
     verraadde was niet de tekst maar het PIL-VLAK eronder — kale tekst zonder
     achtergrond leest niet als een chip.
  2. **Het woord schuin maar DOORZICHTIG over de teamkleur.** Dezelfde val als
     bij #163 met de chips: onder het blok ligt de teamkleur, en die verschilt
     per team (blauw, paars, groen, roze, amber). Op het ene team las je het
     woord, op het andere niet.
  3. **Datzelfde woord als behang, herhaald.** Een tegelpatroon heeft een groot
     vlak nodig; dit blok is ~75 bij 75 en dan lopen de woorden in elkaar — op
     staging stond er letterlijk "VerlofVerlofVerlof".

  Het lint lost alle drie tegelijk op: het heeft zijn **eigen ondergrond** (dus
  leesbaar op elke teamkleur), het ligt in de **hoek** (dus de tijd blijft
  gecentreerd en de activiteitenchips houden hun regel), en het is **één
  element** in plaats van een patroon dat om ruimte vecht.

  De tekst OP de band heeft een eigen token nodig, `--alert-lint-tekst`: hij
  staat op `--alert-error-text` en niet op een achtergrondkleur. Nagerekend:
  6,9 in de lichte modus en 6,0 in de donkere (eis 4,5). Een lang woord als
  "Overuren" wordt met `text-overflow: ellipsis` afgekapt in plaats van over de
  rand te vallen. Onder de 2,5 uur verdwijnt het lint, net als de tijd (#147);
  dan blijft de rode rand het signaal.

  **Les voor de volgende keer**: beoordeel dit soort blokken op WARE grootte.
  Alle drie de afgekeurde ontwerpen zagen er uitvergroot prima uit.

  **Een afwezigheid op een dag ZONDER dienst** (#415): het lint hangt aan een
  dienstblok, dus wie die dag niets ingepland had was in de planning niet te
  zien als afwezig. Je merkte het pas als je er een dienst probeerde te zetten
  — of helemaal niet. Karen bracht het op.

  Geen randgeval: in productie staan **116 afwezigheidsdagen** op een dag
  zonder dienst — 59 van de 108 verlofdagen, 48 van de 133 ziektedagen, en alle
  zes de "andere" van Karen. Er stónd al zoiets (#173), maar alleen voor het
  type `vrij`, net het type dat in #402 verouderd is verklaard.

  `afwezigheidsCelMarkering()` zet het WOORD in de cel. Dat kan hier, want een
  lege cel is 143,7px breed waar een dienstblok van acht uur er 67 krijgt — het
  lint in de hoek was een antwoord op krapte die op deze plek niet bestaat.

  Drie dingen die erbij horen:
  - **Het redenveld gaat er NIET in.** De oude tooltip zette hem er wel in. Bij
    ziekte is dat gezondheidsinformatie (#152), en `GET /availability` maakt
    `reason` juist daarom leeg voor wie geen beheerder is.
  - **`pointer-events: none`**, dus de cel blijft zich gedragen zoals hij deed.
    Een overlay die de klik opslokt zonder zelf iets te doen was de fout bij
    `.vrij-indicator` (#400). Daarom staat er ook geen tooltip op: die vraagt
    hover, en het woord staat er al.
  - Welke types meetellen komt van `teltAlsAfwezigheid()`, niet uit een eigen
    lijstje.

  In de CSS staan nog twee stukken DODE stijl uit een oudere planner:
  `.absent-badge` en de hele `.shift-absent-conflict`-behandeling met rode
  diagonale strepen. Die horen bij `.shift-block`, en de tijdlijn gebruikt
  `.timeline-block`. Ze worden nergens gerenderd.

  Het label toont het TYPE, nooit het redenveld: `GET /availability` maakt
  `reason` leeg voor wie geen beheerder is, en bij ziekte is dat
  gezondheidsinformatie (#152).

- **Hoe lang je ingelogd blijft** (#159): drie dingen die samen werken, en die je niet los van elkaar moet aanpassen.
  1. **Waar het token staat.** Niet rechtstreeks in de opslag maar via `bewaarToken()`, `leesToken()` en `wisToken()` in `data.js`. Het staat in `localStorage`, dus het overleeft het sluiten van een tabblad. `leesToken()` kijkt in ALLEBEI de opslagen, want er kan nog een token uit `sessionStorage` staan van vroeger en de terugval bij geblokkeerde `localStorage` schrijft daar ook naartoe; `wisToken()` leegt er allebei. De controle vóór de eerste paint in `index.html` doet hetzelfde nog eens inline, want `data.js` is daar nog niet geladen.
  2. **Het token is 7 dagen geldig en loopt mee.** `TOKEN_GELDIGHEID_UREN` in `middleware/auth.js`. Is een token over de helft, dan stuurt `requireAuth` een vers exemplaar mee in de header `X-Vernieuwd-Token` en bewaart `dataApiFetch` dat stilletjes. Die header staat in de CORS bij `exposedHeaders`; zonder dat is hij voor JavaScript onzichtbaar, zonder foutmelding. Door dat meelopen betekent dit getal alleen nog: HOE LANG JE WEG MAG BLIJVEN voor je opnieuw moet inloggen. Het heeft even op 24 uur gestaan; dat is teruggedraaid omdat een medewerker die zijn rooster één keer per week bekijkt dan élke keer opnieuw moest inloggen, en dat is de meerderheid. Verkort dit getal dus niet om een onbewaakte laptop te beschermen: daar gaat punt 3 over.
  3. **Vier uur niets aanraken en de sessie wordt gewist.** `INACTIEF_UITLOGGEN_MS` in `app-auth.js`. Dit werkt op een TIJDSTEMPEL in `localStorage` en niet op een aflopende timer: een timer telt niet door terwijl een laptop dicht is en bestaat niet meer na een herlading. Daarom wordt hij ook bij het OPSTARTEN nagekeken in `checkSession()` en niet alleen in de minuutcontrole. De stempel wordt hoogstens eens per minuut geschreven, dus een actieve gebruiker loopt nooit meer dan die minuut achter op een grens van vier uur.

  **Waarom alle drie.** De app bevat ziekmeldingen, dus gezondheidsgegevens (#152). De laptops worden gedeeld maar iedereen heeft zijn eigen login en dus zijn eigen browserprofiel, dus een collega komt niet zomaar in jouw opslag. Wat overblijft is de laptop die onbewaakt open blijft staan, en daar helpt alleen punt 3 tegen: een kortere geldigheid doet niets als het token op dat moment vers is.
- **Een functie uit een ander bestand aanroepen in `setupEventListeners`**
  (#412): zet er een `typeof ... === 'function'`-controle omheen als hij NIEUW
  is. De frontend bestaat uit losse `<script>`-bestanden zonder bouwstap, dus
  een bezoeker kan index.html en app-shifts.js uit zijn cache halen terwijl
  app-init.js al nieuw is — dat gebeurt als je de pagina herlaadt precies
  terwijl een deploy uitrolt. De functie bestaat dan niet, en omdat
  `setupEventListeners` daar afbreekt wordt géén enkele listener daarná nog
  opgehangen: de app laadt wel maar reageert nergens meer op, met alleen
  `Error during initialization` in de console.

  `typeof` op een niet-gedeclareerde naam gooit niets; `if (naam)` wél. Dat is
  waarom die vorm er staat. Een ontbrekende functie hoort hoogstens zijn eigen
  stukje uit te schakelen.

  De cachebusters (`?v=`) helpen hier niet tegen: die staan ín index.html, dus
  wie een oude index.html vasthoudt vraagt ook de oude URL's op — en krijgt van
  de server toch de nieuwe inhoud, want de queryparameter zegt de server niets.

- **Opstartscherm** (#389): `index.html` zet de klasse `session-restoring` op `<html>` zodra er een token in `sessionStorage` staat. Die verbergt het loginscherm (anders flitst dat voorbij bij wie al ingelogd is) en `#app-container` staat dan nog op `hidden`. In dat gat toont `#opstartscherm` het KADER van de app: dezelfde zijbalk op dezelfde plek, met vlakken waar de inhoud komt. Puur markup en CSS, dus het staat er al bij de eerste paint. **De klasse moet op élk pad weggehaald worden**: in `showApp()` (geslaagd), in de twee foutafhandelingen van `checkSession()` en in `showLogin()`. Vergeet je er één, dan blijft het opstartscherm over de app heen staan
- **Stat-kaarten op home** (#166): twee reeksen, elk met een eigen doelgroep. `renderHomeEigenUren()` toont JOUW uren deze week en deze periode tegen je contract, plus wat op jou wacht; alleen voor wie meedraait in het rooster, want een adminaccount heeft geen diensten. `renderHomeStats()` toont de BEHEERcijfers en is er alleen voor admin en roosterverantwoordelijke. Zonder contracturen verschijnt er geen balk en geen "van": `32/0u` zou onzin zijn. De kleurregel is dezelfde als bij de uren in de planning: rood boven de norm, oranje eronder
- **Activiteiten in het dienstblok** (#416): een wit pilletje vlak onder de
  diensttijd, met het pictogram van de soort en de uren als GETAL: `👥 13–16u`.
  Dit is de vierde vorm; `activiteitenPilletjes()` in `app-planner.js` vertelt
  de hele geschiedenis. Kort:

  | | wat | waarom het niet bleef |
  |---|---|---|
  | #163 | tekstchips met het type | 96% is een vergadering, dus overal hetzelfde woord; drie chips sneden hun eigen tekst door (#405) |
  | #406 | balkje van 4px op de echte uren | de weekweergave heeft geen urenschaal: een streepje op twee derde van 67px is geen tijdstip |
  | #416 | pilletje met pictogram en uren | — |

  **Weekweergave**: één pilletje per dienst. Het staat niet op de uren van de
  activiteit, het ZEGT ze. Meer dan één activiteit: de eerste, met `+1` — dat
  komt weinig voor (9 van de 414 diensten met een activiteit in zestig dagen).
  Zo'n pilletje draagt geen `data-activity-id`, dus de klik opent het
  dienstvenster waar ze allemaal in staan.

  **Dagweergave**: één pilletje per activiteit, uitgerekt over de echte uren,
  met de omschrijving erin. Daar is een uur 59px en ligt de bezettingsbalk er
  recht boven, dus daar betekent de plaats wél iets.

  **De vorm wordt GEMETEN, niet berekend uit een vaste maat.** Het pilletje
  heeft 13px vulling en lucht rond zijn tekst nodig en zit dus dichter op de
  rand dan het tijdlabel. `pasPilletjesAan()` leest na het tekenen de echte
  breedte van elk blok en kiest de langste vorm die past:

      👥 13–16u +1   →   👥 13–16u   →   👥 13u   →   👥

  Rekenen met de maat van een scherm van 1440px klopt alleen dáár: in de proef
  viel op een smaller venster bij 15 van de 28 testblokken het uur weg terwijl
  het beginuur nog paste. Die functie draait ook bij een vensterwijziging, als
  het weblettertype binnenkomt, en in `updateTimelineMobileDayAttribute()` —
  het raster tekent alle zeven dagen en verbergt er zes, en een pilletje in een
  verborgen kolom heeft geen breedte. Zonder dat laatste bleef na een tik op de
  dagpijl elk pilletje een rondje.

  Vijf dingen die je niet moet terugdraaien zonder opnieuw te meten:

  1. **Het echte blok is 56 of 73px hoog**, niet de 36px waarop alle eerdere
     proeven getekend waren. De rij krijgt zijn hoogte van de naamcel. Daarom
     paste er niets en leek alles "clunky". Meet het blok in de echte app.
  2. **Het pilletje staat 9px onder het midden**, niet tegen de onderrand: zo
     hoort het bij de tijd, in een blok van 56 én van 73.
  3. **Centreren met `left:0; right:0; margin:auto`**, niet met `left:50%`. Een
     absoluut element met alleen `left` krijgt als beschikbare breedte wat er
     rechts van overblijft — de helft van het blok — en klapte zijn eigen
     tekst weg.
  4. **`flex-wrap` is het vangnet.** Wat niet naast het pictogram past zakt
     naar een tweede regel buiten de hoogte en verdwijnt als geheel. Nooit een
     half getal (#208).
  5. **Wit en bijna-zwart, in beide thema's** (`--pil-bg`, `--pil-tekst`). Het
     dienstblok houdt in de donkere modus zijn teamkleur, dus een pilletje dat
     omsloeg stond daar donker op een helder blok.

  Op een **telefoon** is het blok 35px hoog; daar staat het pilletje NAAST de
  tijd (`:has()` in een media query) en trekt `pasPilletjesAan()` de breedte
  van de tijd af.

  De **pictogrammen** staan inline in `ACTIVITY_TYPE_ICONS` (`app-globals.js`)
  en niet als `data-lucide`: het pilletje bestaat in zijn smalste vorm úit het
  pictogram, dus een weggevallen CDN (#396) gaf een leeg wit rondje. De kleur
  van het pictogram is `--act-donker` van het type.

  De maten staan TWEE keer: als `PIL_*` in `app-planner.js` (om te rekenen) en
  in `styles.css` (om te tekenen). De test bewaakt dat ze gelijk blijven.

  Een activiteit **buiten de diensturen** krijgt geen pilletje en telt niet mee
  in `+1`. Een **nachtdienst over twee dagcellen** krijgt nu wél zijn
  activiteit; het balkje kon dat niet omdat een percentage binnen dat blok geen
  tijdstip is.

  Elk type draagt in `styles.css` nog steeds drie waarden: `--act-licht`,
  `--act-donker` en `--act-tekst`. Eén bron per type.

- **Het tijdlabel van een dienstblok** (#404): het volle bereik verschijnt pas
  vanaf **7,5 uur** breedte, niet vanaf 6. `09:00-15:00` is 62,9px en een blok
  van zes uur maar 50,4px, van zeven uur 59,2px. Alles daartussen werd
  gecentreerd afgekapt tot `9:00-15:0`, en dat leest als een geldige tijd die
  het niet is — dezelfde fout als bij het doorloopblok in #208. De drempel
  staat als `VOLLEDIG_BEREIK_VANAF_UREN` in `app-planner.js`; verlaag hem niet
  zonder opnieuw te meten.

  Die drempel is alleen nog de EERSTE tekening. Daarna meet
  `pasTijdlabelsAan()` (aangeroepen vanuit `pasPilletjesAan()`, dus op
  dezelfde momenten) de echte breedte en kiest `kiesTijdLabel()`: het volle
  bereik waar het past, anders het beginuur. Op een telefoon en in de
  dagweergave is een blok van zeven uur twee keer zo breed als op de
  computer, en daar stond eerst toch alleen "09:00".

- **Geen dubbele teamvergaderingen** (#407): `draft-apply.js` ruimt vlak vóór
  het invoegen de rijen op die het gaat schrijven, op `(user_id, date,
  start_time, end_time)` met `type = 'vergadering'`. Dat is nodig naast de
  opruiming op `draft_id`: de 879 vergaderingen in productie dateren allemaal
  van vóór migratie 038 en dragen dat veld niet, dus die werden niet gevonden
  en kregen er elk een tweede naast — 324 daarvan in de toekomst. Gok hier
  NOOIT op `description = 'Teamvergadering'`: dat is in #376 afgewezen omdat
  een handmatig ingevoerde vergadering net zo goed zo kan heten. De tuple is de
  veilige sleutel, want een bestaande vergadering op dezelfde persoon, dag en
  uur ÍS deze vergadering.

- **Algemene activiteit** (#418): een brandoefening, een teamdag — iets dat
  aan een DAG hangt en niet aan een persoon. Eigen tabel `dag_activiteiten`,
  want `shift_activities.user_id` is verplicht en een rij per medewerker zou
  bij elke nieuwe collega en elke vervanging bijgewerkt moeten worden.

  | | |
  |---|---|
  | uren | optioneel; allebei leeg = hele dag (CHECK in de database) |
  | wie maakt aan | admin en roosterverantwoordelijke (`canManageDagActiviteiten`, `requireRole`) |
  | waar te zien | dagkop van de planning, beginscherm, agendafeed |
  | bezetting | telt NIET mee — de app weet niet wie er van de vloer gaat |

  **Planning**: chips in de dagkop, hoogstens twee en daarna `+n`, want een
  derde regel duwt het hele raster omlaag. In de dagweergave en op een telefoon
  is die kop verborgen; daar staat een balk boven het raster met een groep per
  dag, en CSS toont de groep die past bij `data-mobile-day`. Bij het wisselen
  van dag hoeft er dus niets opnieuw getekend te worden. Wie mag beheren krijgt
  knoppen (klik = bewerken), de rest tekst met een tooltip.

  **Aanmaken** via de knop "Activiteit voor iedereen" in de planningbalk of
  rechtsklik op een dagkop. De klikken hangen in `app-shifts.js` zelf, niet in
  `setupEventListeners` (#412).

  **Agendafeed**: voor IEDEREEN met een gekoppelde agenda, of hij die dag werkt
  of niet. Zonder uren een DATE-gebeurtenis met DTEND op de dag erna (iCal-einde
  is exclusief). `TRANSP:TRANSPARENT`: een brandoefening maakt je niet bezet. De
  titel gaat altijd mee, de omschrijving alleen met `ical_omschrijvingen` (#410).

  De audit log weigert een onbekend `resource_type` via een CHECK, en
  `logAudit` slikt die fout in. Zonder `dag_activiteit` in die lijst zou elke
  regel STIL verdwijnen. Migratie 051 breidt hem uit.

- **"Wat is er nieuw"** (#421): na een update verschijnt één keer een venster
  met de wijzigingen in gewone taal (`patchnotes.js`, aangeroepen aan het eind
  van `showApp()`). Gezien wordt per gebruiker in `localStorage` bewaard onder
  `hetvlot_patchnotes_gezien_<id>`; sluiten op welke manier ook telt als gezien.
  Een nieuwe versie zet je BOVENAAN `PATCH_NOTES` met een nieuwe `versie`, en
  wie de vorige zag krijgt de nieuwe vanzelf. Schrijf voor collega's: wat ze
  zien en wat ze ermee kunnen, zonder issuenummers (de test bewaakt dat). Het
  sterretje onderaan de zijbalk opent het venster altijd opnieuw.

- **Dienst overnemen** (#417): één venster (`openOvernameVenster()` in
  `app-swaps.js`) met de dienst, je HELE week, je weekuren ervoor → erna tegen
  je contract, en de rust tot je eigen dienst ervóór en erná. Het vervangt drie
  vragen die vroeger na elkaar kwamen: de afwezigheidswaarschuwing (#318), de
  berichtvraag (#348) en "Weet je zeker...?". Afwezig staan is nu een melding
  IN het venster; wie daarna op "Dienst overnemen" drukt, heeft gekozen.

  De rekenkant is `overnameOverzicht()`, puur. Twee dingen daarin:
  - De rust gaat naar de DICHTSTBIJZIJNDE eigen dienst, met nachtdiensten die
    de dag erna eindigen. Een dienst die met de nieuwe overlapt is geen rust
    maar een botsing, en staat apart.
  - De week wordt opgehaald als hij buiten de drie maanden valt die de planning
    laadt; anders toonde het venster een lege week bij iemand die wél werkt.

  Het venster toont wat de backend zal zeggen, maar de backend blijft de grens:
  de rustweigering van #202 met "Toch overnemen" draait gewoon na de klik.
  Alleen bij overnemen, bewust niet bij ruilen.

- **Een activiteit voor meerdere mensen** (#408): een activiteit staat PER
  PERSOON in de database; er is geen gedeelde gebeurtenis met deelnemers. In
  productie zijn 254 werkelijke vergaderingen opgeslagen als 879 rijen,
  gemiddeld 3,5 deelnemers per stuk. Voor de teamvergadering viel dat nooit op
  — die genereert het concept — maar alles met de hand moest per persoon
  opnieuw ingetypt worden.

  Het activiteitenvenster heeft daarom een deelnemerslijst: wie die dag een
  dienst heeft, met zijn uren erachter. Er worden nog steeds LOSSE rijen
  geschreven; dit scheelt alleen de herhaling.

  Voor meer dan één persoon gaat dat in ÉÉN verzoek naar
  `POST /shift-activities/batch`, in één transactie (#420). Eerst was het een
  POST per persoon: liep de derde mis, dan stonden de eerste twee al opgeslagen
  en gaf opnieuw opslaan hen de activiteit dubbel. Iedereen staat er ook maar
  één keer in, ook wie twee diensten op die dag heeft. Een echte gedeelde gebeurtenis
  is een schemawijziging en een apart gesprek.

  Vier dingen die erbij horen:
  - **Alleen bij aanmaken.** Bij bewerken bewerk je één rij; de rijen van de
    anderen blijven staan. Een vinkje zou het tegendeel suggereren.
  - **De waarschuwing over diensturen geldt per ONTVANGER.** De een werkt tot
    16:30 en de ander tot 12:30, dus dezelfde activiteit valt voor de een wél
    en voor de ander niet binnen de dienst. De melding noemt wie.
  - **Een medewerker ziet de lijst niet**: `canCreateActivityForOthers()` is de
    frontendkant van de check in `POST /shift-activities` (regel 5).
  - Id's worden als TEKST vergeleken. Een id komt als getal uit de API maar als
    string uit een `dataset`; zonder dat zou de persoon voor wie de activiteit
    al is er nóg eens in staan en een dubbele rij krijgen.

  **Het venster zelf is in #411 herzien.** Beoordeeld met de dertien mensen die
  op een echte dag ingepland stonden, niet met een handvol:

  1. **De dag staat in de kop.** Je opent het venster vanaf een dienst, en
     daarvóór stond er alleen de titel — je kon niet nakijken of je goed zat.
  2. **Eén kolom, gegroepeerd per TEAM**, met de teamkleur en een "Allemaal"
     per team. Het stond in twee kolommen die rij voor rij gevuld werden, dus
     de volgorde sprong links-rechts-links en je kon geen naam opzoeken. En het
     team is de structuur die er werkelijk in zit: de 294 gebeurtenissen in
     productie zijn zonder uitzondering van één team.
  3. **De persoon van de dienst staat IN de lijst**, bovenaan zijn eigen team,
     vastgezet. Hij stond alleen tussen haakjes in het label. Let op: zijn
     vinkje is uitgeschakeld maar telt wél mee voor `:checked`, dus de
     verzamelaar in `handleActivitySubmit` sluit hem uit met `:not([data-zelf])`
     — anders krijgt hij twee rijen.
  4. **Wie er op het gekozen uur niet is, krijgt "buiten dienst"** en staat
     gedimd, bijgewerkt terwijl je de tijden typt. Aanvinken blijft mogelijk;
     soms komt iemand er speciaal voor.

  **Twee stukken CSS die daar niets deden** (#413), allebei gevonden door te
  METEN in plaats van te kijken:
  - `grid-template-columns` op `.form-row` doet niets: die klasse wordt
    verderop in `styles.css` opnieuw gedefinieerd als `display: flex` met
    `.form-row .form-group { flex: 1 }`, en die regel wint op volgorde. Gebruik
    `flex-basis` als je daar een kolom een eigen breedte wil geven.
  - `.modal-content--sm` (450px) staat vóór `.modal-content` (600px) en verliest
    dus bij gelijke specificiteit. Elk venster met die modifier is 600px. Het
    activiteitenvenster heeft daarom een eigen `max-width: 520px`.

  De deelnemerslijst krijgt een **vervaging onderaan** in plaats van een
  hoogte die op de rijen past: teamkoppen zijn lager dan naamrijen, dus zo'n
  veelvoud bestaat niet en er werd altijd een rij doormidden gesneden. De
  scroll-listener wordt opgehangen in `app-shifts.js` zelf, niet in
  `app-init.js` — zie #412 hieronder.

  `dienstDektActiviteit()` beslist dat, en bestaat omdat de oude controle de
  tijden als TEKST vergeleek (`startTime < shiftStart || endTime > shiftEnd`).
  Bij een NACHTDIENST klopt dat niet: een overleg van 20:00 tot 21:00 binnen
  een dienst van 18:00 tot 09:00 werd gemeld als buiten de uren, want
  `"21:00" > "09:00"` is waar. Let in die functie ook op de lege tekst:
  `Number('')` is 0 en dus "eindig", dus zonder controle leest een leeg
  tijdveld als middernacht.

- **Bezetting en activiteiten** (#145): `calcPlanningHourlyHeadcount()` in `app-planner.js` geeft `bruto` (wie een dienst heeft) en `netto` (bruto min wie op dat uur een activiteit heeft). ALLE zes de activiteittypes verminderen de netto bezetting, voor hun volle duur. Dat is nagevraagd en bevestigd: bij oudergesprek, vorming, overleg, vergadering, afspraak én andere staat de begeleider niet bij de groep. Er is bewust geen uitzondering per type en geen vinkje "ik blijf bereikbaar" per activiteit: dan moet iemand dat elke keer beoordelen en kan het vergeten worden, en te vaak waarschuwen is bij bezetting de veilige kant. Netto voedt precies drie plekken: de onderbezettingsmeldingen in `renderHomeAlerts`, de bezettingsbalk in de planning en `validateMinimumStaffing` in `validation.js`. Activiteittypes worden verder nergens in logica onderscheiden, alleen voor kleur en label
- **Weekend- en vakantieverantwoordelijke**: je bent verantwoordelijk voor het WEEKEND, dus alleen in een week waarin het weekend open is. Staat het weekend dicht, dan is er niemand aan de beurt en toont de app niemand. Tijdens een vakantie staat de verantwoordelijke PER WEEK, aan te duiden in de roosterbouwer: in de kerstvakantie doet de ene persoon week 1 en een ander week 2. Een vakantieweek is daarmee uitgepraat — is er voor die week niemand aangeduid, dan is er niemand, en valt de app bewust NIET terug op de rotatie. Een vakantieweek verbruikt ook geen beurt, dus na de vakantie gaat de rotatie verder waar hij gebleven was.

  **De ROOSTERBOUWER is de waarheid voor een vakantieweek** (#399). Daar duid je
  per week iemand aan; dat schrijft `holidayPeriods[].weeklyResponsibles`. In
  Instellingen staat dezelfde week in het lijstje "komende weekends", maar daar
  is hij **alleen-lezen**: klikken schreef er een handmatige toewijzing weg, en
  die wint van de vakantieweek, dus je overschreef stilletjes het concept.

  Drie dingen die daar samen één onbegrijpelijk scherm van maakten:
  1. **De keuzelijst in de bouwer toont alleen ACTIEVE medewerkers.** Stond er
     iemand die intussen weg is, dan vond geen enkele `<option>` dat id, werd er
     niets geselecteerd en viel de lijst terug op "Geen" — terwijl de waarde
     gewoon bleef staan. Het scherm zei "niemand" en de planning toonde de
     vertrokken collega. `ruimVertrokkenVakantieVerantwoordelijkenOp()` wist zo'n
     aanduiding nu en MELDT het met de naam erbij. Die functie wist bewust niets
     zolang `DataStore.users` leeg is: zonder die controle zou een mislukte
     lading de hele periode leegvegen.
  2. **Instellingen zette een vakantieweek onder zijn WEEKENDdatums.** De week
     die je in de bouwer als 28 dec – 3 jan aanduidt, verscheen daar als
     2 jan – 3 jan. Een vakantieverantwoordelijke is er voor de hele week, dus
     daar staan nu de weekdatums.
  3. **De badge "vakantie" keek naar `responsibleId`** — het oude veld met één
     persoon per hele periode, dat de bouwer nooit vult. Hij verscheen dus
     nooit, en een vakantieverantwoordelijke was niet te onderscheiden van een
     uitkomst van de rotatie. Gebruik `verklaarVerantwoordelijke()`: die geeft
     het antwoord mét de reden, de naam van de vakantie en het weeknummer.

  De REGELS staan in `frontend/verantwoordelijke-regels.js`, als pure functies zonder DataStore, en worden door ALLEBEI de kanten ingeladen: `getOrCalculateResponsible()` in `data.js` en `backend/src/helpers/verantwoordelijke.js` vertalen alleen nog hun eigen gegevens naar diezelfde invoer (#397). Dat stond tot dan toe uitsluitend in de frontend; de server moest het kunnen beantwoorden voor de herinneringsmail. Schrijf die logica NIET over aan de serverkant — zie Mail hierboven. De volgorde is: handmatige toewijzing → vakantieweek → open weekend → rotatie. De rotatie loopt alfabetisch op naam.

  **Drie valkuilen die hier alle drie tegelijk in zaten** en die samen twee klachten opleverden ("hij blijft hangen op X" en "de vakantieverantwoordelijke komt niet in de planning" — één gebeurtenis, twee kanten):
  1. `getEmployee()` vergeleek met `===`. Een id komt als GETAL uit de API maar als STRING uit elke `<select>`, en `weeklyResponsibles` bewaart precies zo'n keuze. `120 === "120"` is false, dus de vakantie-override vond nooit iemand en viel zonder een spoor terug op de rotatie. Vergelijk id-s daarom altijd als tekst.
  2. Het weeknummer binnen een vakantie werd met `Math.floor` uit een verschil in milliseconden gehaald. Over de overgang naar zomertijd liggen twee lokale middernachten 6,958 dagen uit elkaar, dus een paasvakantie toonde in week 2 de persoon van week 1. Gebruik `Math.round` voor hele weken.
  3. De regel "alleen bij een open weekend" stond drie keer los bij de aanroepers (planning, beginscherm, instellingen) en ontbrak bij de vierde. Hij hoort in `getOrCalculateResponsible()` zelf.

  `backend/tests/verantwoordelijke.test.js` bewaakt dit. Let op bij het schrijven van zo'n test: `data.js` draait in Node in een modulewrapper, dus zijn `const DataStore` is module-scoped en `global.DataStore` vullen bereikt hem NIET — stil, want de functies lezen dan de lege standaard. Importeer `DataStore` uit de module en vul die.

- **Uurwisseling en "vandaag"**: twee valkuilen die er los van elkaar uitzien maar allebei één uur opleveren.

  **Een week uit milliseconden halen.** Twee lokale middernachten liggen over de overgang naar ZOMERTIJD 6,958 dagen uit elkaar in plaats van 7. `Math.floor(verschil / (7 * 86400000))` telt daar een week te weinig; `Math.round` niet. Dit zat op drie plekken: het weeknummer van de vakantieverantwoordelijke, de cycluslengte van een nieuw vakantieconcept (`app-builder-drafts.js`) en het weken-label bij een vakantieperiode (`app-settings.js`). Het slaat alleen toe bij een periode die de grens OVERSPANT — een paasvakantie die eind maart begint. De overgang naar wintertijd geeft 7,042 dagen en is met afkappen toevallig ongevaarlijk; vertrouw daar niet op.

  **De datum van vandaag.** De server draait in UTC, de gebruikers zitten in België. `new Date().toISOString().slice(0, 10)` geeft daardoor tussen middernacht en 01:00 (winter) of 02:00 (zomer) nog de datum van GISTEREN. In de frontend is dat #299 (gebruik daar `formatDateYYYYMMDD`); in de backend helpt die niet, want die leest de tijdzone van de SERVER. Gebruik daar `vandaagInBelgie()` uit `src/utils.js`, dat de tijdzone expliciet zet. Een tijdSTEMPEL (`createdAt`, `syncedAt`, iCal-`DTSTAMP`) is iets anders: dat is een moment en hoort wél in UTC.

  **Wat hier géén probleem is:** de urenberekening. `calculateShiftHours()` rekent in verstreken milliseconden, maar de wisseling valt om 02:00 en dat ligt in het slaapvenster 23:00–07:00, dat als vast forfait telt in plaats van als verstreken tijd. De enige nachtdiensten in gebruik (18:00→09:00 en 18:00→10:00) nemen dat pad, dus geen enkele dienst verandert van lengte. Zou er ooit een dienst komen die 02:00–03:00 overspant zonder door het slaapvenster te lopen, dan telt die op de wisselnacht een uur minder of meer — fysiek correct, maar het verschilt dan van wat de klok op het rooster zegt.

- **"Nu aan het werk"**: `dienstLooptNu()` in `app-nav.js` bepaalt of iemand op dit moment werkt. Drie dingen zaten daar tegelijk fout en leverden samen een kaart op die zelden klopte:
  1. **Een reservedienst telde mee.** Die kan nog ingetrokken worden, dus die persoon staat niet als vaste kracht op de vloer.
  2. **De tijden werden als TEKST vergeleken** (`"23:00" < "10:00"` is onwaar). Tussen 18:00 en middernacht meldde de kaart daardoor "Niemand is op dit moment aan het werk" terwijl de nachtdienst liep. Gebruik `getShiftEndDateTime()` uit `validation.js`, dat netjes naar de volgende dag doorrolt.
  3. **Alleen diensten van VANDAAG werden bekeken.** Een nachtdienst draagt de datum waarop hij BEGINT, dus wie gisteravond om 18:00 begon en vanochtend om 10:00 afgeeft, ontbrak precies in de ochtenduren. De aanroeper neemt nu ook de dag ervoor mee — dezelfde aanpak als `calcPlanningHourlyHeadcount()` in `app-planner.js`, die dat al goed deed.

  Let op het verschil met de bezettingsbalk: die telt een reservedienst wél mee. Of dat zo hoort is niet nagevraagd; dit is alleen besloten voor deze kaart.

- **Datums in tekst die een mens leest**: nooit de kale ISO-vorm. `2026-10-05` is eenduidig voor een machine, maar wie hem in een zin tegenkomt moet gokken tussen oktober en mei — de Belgische (`05/10/2026`) en de Amerikaanse (`10/05/2026`) notatie zien er immers identiek uit. Gebruik `formatDateShortMetJaar()` ("5 okt 2026") in lopende tekst en `formatDate()` ("maandag 5 oktober 2026") in een **aria-label**, want dat wordt voorgelezen en losse getallen zijn daar onverstaanbaar.

  Een ISO-datum hoort wél ongemoeid in: de `value` van een `date`-veld, een `data-date`-attribuut, een sleutel in een Set of Map, een queryparameter en een vergelijking. Dat zijn waarden, geen tekst.

  Er is één ronde over de hele frontend gegaan die tien plekken opleverde — twee bevestigingsvensters in de bouwer, twee vakantiebanners, twee regels in de audit log, "Datum:" in het dienstvenster, en drie schermlezerlabels. Zoek met `\$\{[a-zA-Z_.]*(date|Date|datum|from|until)\}` en filter de attributen en sleutels eruit; let op dat een variabele die `from` of `dateStr` heet vaak al opgemaakt is.

- **Scripts van een CDN** (#396): noem ALTIJD het bestandspad voluit, nooit
  alleen `pakket@versie`. Zonder pad kiest de CDN zelf welk bestand uit het
  npm-pakket hij serveert, en die keuze verschilt per CDN: unpkg leest het veld
  `unpkg` uit `package.json`, jsDelivr het veld `jsdelivr` — en ontbreekt dat,
  dan valt hij terug op `main`, dat doorgaans naar de CommonJS-bundel wijst. Zo
  haalde onze terugval `cdn.jsdelivr.net/npm/lucide@0.577.0` de CJS-bundel op;
  die bevat een icoon dat `Infinity` heet en dus een `const Infinity` op het
  hoogste niveau, wat als gewoon `<script>` botst met de globale `Infinity` en
  de hele bundel laat falen met een SyntaxError.

  Let ook op wat `onerror` wél en níét dekt: alleen een MISLUKTE download. Een
  bundel die met HTTP 200 binnenkomt en pas bij het uitvoeren stukloopt, gaat
  daar stilletjes langs. Toets daarom het RESULTAAT — staat `window.lucide` er
  na `load` niet, dan gaat `no-lucide` alsnog aan.

- **Afwezigheidstypes: één oordeel, één plek** (#400): `ABSENCE_TYPES` in
  `app-availability.js` is de enige plaats die zegt welke types als afwezigheid
  tellen (`teltAlsAfwezig`). Maak nergens een eigen lijstje — `validation.js`,
  `app-planner.js` (twee keer) en `app-admin.js` deden dat wel, en liepen
  uiteen.

  Het gevolg bij `vrij`: #173 voerde het in als "puur informatief, verlaagt de
  bezetting NIET", #204 voegde het toe aan de AFWEZIG-lijst van de
  bezettingsberekening — terecht, een vaste vrije dag betekent dat die persoon
  niet op de vloer staat — maar de andere helft bleef staan. Je kon dus zonder
  één waarschuwing een dienst op een vrije dag zetten, en die dienst telde
  daarna niet mee in de bezetting: een dienst die er staat maar niet meetelt,
  en een gat in de bezetting dat niemand meldt. `teltAlsAfwezig` staat nu op
  `true` en de drie andere plekken vragen die vlag.

  `app-admin.js` liet bij een herstel uit een JSON-backup elke `vrij`-rij
  stilzwijgend vallen, omdat het type in zijn `allowedTypes` ontbrak. Die lijst
  moet gelijk zijn aan `AFWEZIGHEIDSTYPES` in `backend/src/helpers/dienstregels.js`.

  **Over de cursor**: `cursor: help` betekent in `styles.css` "alleen uitleg,
  klikken doet niets" — zo werkt `.shift-block-indicator`, en die wordt in
  `drag-handler.js` ook echt van de klik uitgezonderd. `.vrij-indicator` had die
  cursor zonder die uitzondering, dus de klik viel door naar de cel en opende
  "nieuwe dienst". Geef een overlay die cursor alleen als klikken er werkelijk
  niets doet.

  **"Beschikbaar" bestond niet echt** (#402). De afwezigheidstab had twee
  takken: wie een basisrooster had kreeg op een niet-ingeplande dag "Vrij", wie
  er geen had viel terug op "Beschikbaar" — een GROENE cel met een vinkje. Maar
  de app weet alleen dat er geen dienst en geen afwezigheid staat; of iemand KAN
  werken volgt daar niet uit. Bij een deeltijdse collega zonder basisrooster
  stond er dus in het groen "beschikbaar" op precies de dagen dat ze niet kan.

  Een dag zonder dienst heet nu voor iedereen "Vrij", met of zonder
  basisrooster. Het verschil blijft bestaan als UITLEG in de tooltip ("Niet
  ingepland volgens basisrooster" tegenover "Geen dienst ingepland"), niet als
  bewering in kleur.

  Daarmee is het TYPE `vrij` overbodig: niemand hoeft nog met de hand in te
  geven wat de cel vanzelf toont. Het staat op `verouderd: true` — het wordt
  niet meer aangeboden in het keuzemenu, maar blijft overal herkend. Dat laatste
  moet: schrap je het uit `ABSENCE_TYPES`, dan valt het label van de bestaande
  rijen terug op "Afwezig", gooit de import ze weg en kent de CHECK-constraint
  van de database ze nog wel.

  **`vorming` is óók verouderd** (#403), om een andere reden: het bestond zowel
  als afwezigheidstype als als ACTIVITEITstype. Het hoort bij dat laatste — een
  vorming doe je tijdens je dienst, je bent niet afwezig. De productiedata was
  eenduidig: nul afwezigheidsrijen tegenover zeventien activiteiten. De
  activiteit blijft dus gewoon bestaan.

  Het keuzemenu voor afwezigheid houdt over: **Verlof, Ziekte, Overuren
  opnemen, Andere**.

  **Waarom `verouderd` en niet schrappen**, ook bij nul rijen: de backend
  (`AFWEZIGHEIDSTYPES`), de import (`allowedTypes`) en de CHECK-constraint van
  de database kennen het type nog. Het alleen in de frontend weghalen laat
  precies die lijstjes uiteenlopen — de fout uit #400.

  **Waarom het weekrooster hier geen antwoord is**: die ene collega heeft er
  geen, en kan er geen hebben — haar begin- en eindtijden liggen nooit vast
  (09:00-16:00, 12:00-16:00, 09:30-15:00, 11:00-17:30…), terwijl een weekrooster
  vaste tijden per dag vraagt. Ze maakt haar rooster zelf per maand en wordt
  door niemand ingepland, dus de "plan mij hier niet in"-kant van `vrij` deed
  voor haar sowieso niets.

- **Manuele sluitingsdagen**: opgeslagen als `settings.closedDates` (array `[{date, reason}]`). `isDayClosed()` checkt dit automatisch → drag-drop, shift aanmaken en beschikbaarheidstabel werken zonder extra aanpassingen
- **Uren bij naam (planning view)**: In timeline- en maandweergave wordt per medewerker week- en periodetotaal getoond onder de naam (`X/Yu` formaat). Berekend via `getEmployeeHoursThisWeek(id, weekStartStr)` en `getEmployeeHoursThisPeriod(id, dateStr)` uit `data.js`. Kleur: rood = boven contractnorm, oranje = onder contractnorm. Periodenorm = `contractHours × 4` (vaste 4-weken-periodes verankerd aan het schooljaar via `getFourWeekPeriodDates()`). Een jaar telt 13 periodes van elk 4 weken.

## MCP Server

Live data lezen tijdens development, debugging en feature-bouw.

**API URL**: `https://uurrooster-app.onrender.com/api/v1`

### Er zijn er TWEE, en ze heten bijna hetzelfde

Dezelfde tools, dezelfde database, maar ze halen hun gegevens ergens anders
vandaan. Dat verschil bepaalt welke het doet.

| server | waar hij vandaan komt | werkt in een cloudsessie? |
|--------|----------------------|---------------------------|
| **`Vlot_Dashboard`** | gehoste connector op het account | **ja, gebruik deze** |
| `uurroosterapp` | `mcp-server/stdio.js`, via de ingecheckte `.mcp.json` | nee |

**Gebruik `Vlot_Dashboard`.** De tools heten `mcp__Vlot_Dashboard__<naam>`.

`uurroosterapp` is onze eigen server uit `mcp-server/`. Hij leest `API_URL`,
`ADMIN_EMAIL`, `ADMIN_PASSWORD` en `DATABASE_URL` uit `mcp-server/.env`, en dat
bestand staat in `.gitignore` — terecht, er zit het wachtwoord van de
productiedatabase in. Op een eigen machine mét dat bestand werkt hij; in een
verse kloon of een cloudsessie start hij wel op maar heeft hij niets, en
antwoordt hij met **`DATABASE_URL niet ingesteld.`**

Zie je die tekst, dan is de server niet stuk en is er niets te repareren: je
hebt de verkeerde te pakken. Ga naar `Vlot_Dashboard` en probeer opnieuw. Zet
dat `.env` er NIET bij om het op te lossen — dan staat het wachtwoord van de
productiedatabase in een wegwerpcontainer.

Dit is een keer misgelopen: op #392 kwam te staan dat de productiedata niet na
te gaan was en dat de MCP stuk was. Allebei onwaar; er was alleen naar de
verkeerde van de twee gekeken. De vraag was in één query te beantwoorden.

### Beschikbare tools

| Tool | Doel |
|------|------|
| `get_api_health` | API bereikbaarheid checken |
| `get_employees` | Medewerkers ophalen (filter op team, actief) |
| `get_shifts` | Shifts ophalen voor een datumbereik |
| `get_availability` | Beschikbaarheid/afwezigheid opvragen |
| `get_staffing_overview` | Bezetting per dag/team bekijken |
| `find_available_employees` | Beschikbare medewerkers voor een shift zoeken |
| `get_swap_requests` | Ruilverzoeken opvragen |
| `get_schedule_drafts` | Roosterconcepten opvragen |
| `get_hours_report` | Uren rapport per medewerker |
| `get_audit_log` | Audit log met filters |
| `query_database` | Directe SQL query op de database |
| `create_shift` | ⚠️ Shift aanmaken (zie veiligheidsregel) |
| `update_shift` | ⚠️ Shift wijzigen (zie veiligheidsregel) |
| `delete_shift` | ⚠️ Shift verwijderen (zie veiligheidsregel) |

### Veiligheidsregel MCP

> ⚠️ **Schrijf-tools** (`create_shift`, `update_shift`, `delete_shift`) raken de **productiedatabase**, langs WELKE van de twee servers dan ook. Deze tools NOOIT gebruiken zonder expliciete bevestiging van Victor — ook niet als de vraag dit impliciet suggereert. Altijd eerst de actie beschrijven en wachten op "ja, doe het".

### Gebruik tijdens development

- Lees live data om edge cases en echte datastructuren te begrijpen
- Valideer API-gedrag na een bugfix rechtstreeks via MCP
- Gebruik `query_database` voor complexe lookups die de standaard tools niet dekken

## Deploy

Twee permanente branches, elk met een eigen Render-omgeving:

| Branch | Omgeving |
|--------|----------|
| `main` | Productie (live data) |
| `staging` | Testomgeving (eigen database) |

Workflow: ontwikkel → `push origin staging` (test op de staging-URL) → merge naar `main` (live). Ontwikkel bij voorkeur niet rechtstreeks op `main`. De frontend kiest automatisch de juiste backend op basis van zijn hostname (`frontend/config/settings.js`: bevat "staging" → staging-backend).

Zie `DEPLOY.md` voor deployment instructies en `STAGING.md` voor de eenmalige setup van de testomgeving.

## Tests

```bash
cd backend
npm test           # Alle tests uitvoeren, in enkele seconden
```

Dertien testbestanden in `backend/tests/`; zie de tabel bij het bestandsoverzicht
voor wat elk bestand dekt. Tests gebruiken Jest + Supertest en de database wordt
volledig gemockt, dus er is geen echte databank nodig.

Een nieuwe test hoort bij elke bugfix die een gedragsverandering oplevert, en
die test moet falen tegen de oude code. Anders meet hij niets.

## GitHub Issues — Workflow

Alle bugs, technische schuld en features worden bijgehouden via **GitHub Issues**:
<https://github.com/Kirbypopdog/Uurroosterapp/issues>

### Wanneer een issue aanmaken?
- Je vindt een bug tijdens het werken → maak een issue aan, werk dan verder
- Je doet een review → log elke bevinding als apart issue
- Je maakt een plan → schrijf de stappen als issues, niet als commentaar
- Je ziet technische schuld maar lost het nu niet op → issue aanmaken en doorgaan

### Hoe?
```bash
# Bug gevonden tijdens werk
gh issue create --repo Kirbypopdog/Uurroosterapp \
  --title "[BUG] Korte beschrijving" \
  --label "type:bug,prioriteit:hoog" \
  --milestone "v1.1 — Stabilisatie" \
  --body "Beschrijving + stappen + acceptatiecriteria"

# Review bevinding
gh issue create --repo Kirbypopdog/Uurroosterapp \
  --title "[REVIEW] Bevinding" \
  --label "type:tech-debt,prioriteit:medium" \
  --milestone "v1.2 — Refactor" \
  --body "..."
```

### Milestones
| Milestone | Focus |
|-----------|-------|
| v1.1 — Stabilisatie | Bugs fixen, UI stabiliseren, geen nieuwe features |
| v1.2 — Refactor | app.js opsplitsen ✓, tech debt, email config |
| v1.3 — Features | Overuren, seizoenen, setup wizard |

### Labels
- **prioriteit:** `prioriteit:kritiek` / `prioriteit:hoog` / `prioriteit:medium` / `prioriteit:laag`
- **type:** `type:bug` / `type:tech-debt` / `type:feature` / `type:security` / `type:ux` / `type:performance`
- **gebied:** `gebied:frontend` / `gebied:backend` / `gebied:database`

## Prioriteitsregel

> ⚠️ Als er open issues zijn met label `prioriteit:kritiek`, worden die **eerst opgelost** voor nieuwe features worden toegevoegd — tenzij Victor dit expliciet anders vraagt.

Check voor je begint:
```bash
gh issue list --repo Kirbypopdog/Uurroosterapp --label "prioriteit:kritiek" --state open
```

## Actieve Bekende Problemen

Controleer de open issues voor context bij het werken aan deze gebieden:

| Issue | Beschrijving |
|-------|--------------|
| #150 | `prioriteit:hoog`. Verwerkersovereenkomsten met Render, Resend en Sentry, plus het interne verwerkingsregister. Geen code: dit staat op Victor. |

Geen `prioriteit:kritiek` open. Dit tabelletje veroudert; de bron is
`gh issue list --repo Kirbypopdog/Uurroosterapp --label "prioriteit:hoog" --state open`.

## Agent Aanbevelingen

Bij elke niet-triviale taak, beveel de best passende agent aan uit `~/.claude/agents/`. De gebruiker kan deze starten via `/agents`. Kies op basis van het type werk:

| Type werk | Aanbevolen agent |
|-----------|-----------------|
| Backend/API werk | `engineering-backend-architect` |
| Frontend/UI werk | `engineering-frontend-developer` of `design-ui-designer` |
| UX verbeteringen | `design-ux-architect` of `design-ux-researcher` |
| Bug investigation | `testing-evidence-collector` |
| Performance issues | `testing-performance-benchmarker` |
| API testen | `testing-api-tester` |
| Feature planning | `product-sprint-prioritizer` |
| Code review/QA | `testing-reality-checker` |
| DevOps/deploy | `engineering-devops-automator` |
| Grote multi-stap projecten | `agents-orchestrator` (coördineert meerdere agents) |

## Environment Variables

```
DATABASE_URL=postgresql://...     # PostgreSQL connection string
JWT_SECRET=...                    # JWT signing secret
ADMIN_EMAIL=admin@hetvlot.be     # Initieel admin account
ADMIN_PASSWORD=...                # Admin wachtwoord
DEFAULT_RESET_PASSWORD=...                # Alleen nog voor bulkimport en de oude migratiescripts (#379)
SENTRY_DSN=https://...            # Foutmonitoring (#156). Leeg = uit.
```

## Foutmonitoring (#156)

Sentry, in de **EU-regio (Duitsland)**. Uit zolang `SENTRY_DSN` leeg is: de
backend start dan geen SDK en de frontend haalt niets van een CDN.

| kant | bestand | hoe |
|------|---------|-----|
| backend | `src/monitoring.js` | `@sentry/node`, geladen vóór express in `server.js` |
| frontend | `config/monitoring.js` | SDK van een CDN, dus geen bouwstap (regel 1) |

**Het belangrijkste aan deze code is wat er NIET vertrekt.** De app houdt
ziekmeldingen bij, en gezondheidsgegevens zijn een bijzondere categorie onder de
AVG (#152). De standaardinstellingen van de SDK zijn ruim: cookies, headers,
verzoekinhoud en queryparameters gaan standaard mee. Die staan allemaal uit, en
`schoonEvent` is het tweede net.

Er wordt op twee manieren gefilterd, en dat onderscheid is belangrijk:

- **Op sleutelnaam**, voor dingen als `reason`, `email`, `authorization`.
- **Op waarde**, voor `ziek`, `verlof`, `zeker_niet` en de andere afwezigheids-
  en verlofwaarden. Dat moet wel: de sleutel heet `type`, en die kan niet blind
  verboden worden omdat Sentry hem zelf gebruikt voor de soort fout ("Error").

Van de gebruiker gaat alleen het **id** mee, nooit naam of e-mail.
`monitoringZetGebruiker()` wordt aangeroepen vanuit `showApp()` en
`handleLogout()` in `app-auth.js`.

De filtering in de frontend is een kopie van die in de backend. **Die twee horen
gelijk te blijven**; `backend/tests/monitoring.test.js` bewaakt de backendkant.

Let op bij het lezen van een melding: Sentry hangt **broncontext** aan de
stacktrace, dus regels uit de eigen bestanden komen mee. Dat is nuttig bij het
opsporen en bevat geen persoonsgegevens, want het is de broncode uit de repo.

**De omgeving komt van `RENDER_GIT_BRANCH`, niet van `NODE_ENV`.** Render zet
`NODE_ENV` op `production` bij élke service, dus ook bij staging. De eerste
echte testfout kwam daardoor binnen met `environment=production` terwijl hij van
de stagingserver kwam. `bepaalOmgeving()` vertaalt de branch: `main` wordt
`production`, elke andere tak houdt zijn eigen naam.

**Controleren of het werkt:** `POST /admin/monitoring-test` stuurt opzettelijk
een fout, met nepgegevens erin die op echte lijken. Komt die aan met de velden
op `[weggelaten]`, dan draait de filtering ook echt op de server. Het endpoint
bestaat alleen als de monitoring aanstaat, en alleen voor een admin.
