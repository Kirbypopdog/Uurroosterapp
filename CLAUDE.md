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
- **Auth**: JWT tokens (7 dagen geldig), bcrypt password hashing

## Bestandsoverzicht

### Frontend (`frontend/`)

De regelaantallen stonden hier vroeger bij, maar die verouderden per week en
zeiden niets nuttigs (#291). De kolom "doel" is wat telt.

| Bestand | Doel |
|---------|------|
| `app-globals.js` | AppState, constanten, UndoManager, DOM object, IconHelper |
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
| `app-admin.js` | Export/import, debug, migratie, sanitize |
| `app-init.js` | initDOM, setupEventListeners, init(), DOMContentLoaded entry |
| `data.js` | DataStore, API fetch wrappers, data loading |
| `validation.js` | Business rules: 11-uur regel, overlap, min bezetting, datumhelpers |
| `drag-handler.js` | Drag & drop shifts tussen medewerkers |
| `styles.css` | Alle CSS inclusief responsive, themas |
| `index.html` | HTML markup: modals, formulieren, planning grid |
| `config/settings.js` | API URL auto-detect, shift templates, team kleuren |

### Backend (`backend/`)
| Bestand | Doel |
|---------|------|
| `src/server.js` | Alle API endpoints + auto-migratie bij startup |
| `src/db.js` | PostgreSQL connection pool |
| `src/email.js` | Resend email service (9 notificatie types) |
| `src/utils.js` | Pure datumhulpfuncties (`getMonday`, `formatDateYYYYMMDD`, `parseLocalDate`, `getEasterDate`, `getBelgianPublicHolidays`) |
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

Aantallen staan hier bewust niet bij; `npm test` noemt ze en ze verouderen
sneller dan dit bestand (#291).

## Database Schema

**Tabellen**: teams, users, shifts, availability, settings, shift_blocks, shift_swap_requests, audit_log, schedule_drafts, shift_activities, leave_rounds, leave_round_blocks, leave_round_entries, leave_round_submissions

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
5. **Permissions** checken in ZOWEL frontend ALS backend
6. **Migraties**: geversioneerd via de `MIGRATIONS`-array + `runMigrations()` in server.js (draait bij elke startup, elke migratie exact één keer). Voeg nieuwe schema changes toe als nieuwe migratie-entry **én werk `sql/schema.sql` bij**, zodat beide wegen dezelfde database opleveren. `backend/tests/schema-drift.test.js` bewaakt dat: een kolom, index, tabel of constraint die alleen in een migratie staat laat die test falen. Migratie `000_base_schema` draait `schema.sql` idempotent, dus een verse database (bv. staging) initialiseert zichzelf; `ensureBootstrapData()` maakt standaardteams + admin-account aan zonder bestaande data te overschrijven
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

### Admin
- `GET /api/v1/audit-log` - Audit log met filters en paginatie
- `POST /api/v1/admin/users/:id/replace` - Medewerker vervangen
- `PUT /api/v1/me/email-preferences` - Email notificatie voorkeur

### Agendakoppeling (iCal)
- `POST /api/v1/me/ical-token` - Persoonlijke feedlink aanmaken of vervangen
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

## Frontend Patronen

- **DataStore** (`data.js`): Centrale data cache, alle API calls gaan hierdoor
- **Settings**: `frontend/config/settings.js` voor defaults, persistent via `PUT /settings/:key`
- **Modals**: `openShiftModal(shift, canEdit)` - view vs edit mode op basis van permissies
- **Scroll preservation**: ScrollY wordt bewaard bij planner re-renders
- **Validation**: `validation.js` draait client-side checks voor shift toewijzingen
- **Verlofplanning**: één ronde = één SCHOOLJAAR, opgebouwd uit blokken (`leave_round_blocks`) die verwijzen naar `settings.holidayPeriods` — dus geen tweede plek waar vakantiedatums staan. Modus staat per BLOK: `binair` (kleine vakanties: werken/verlof) of `voorkeur` (zomer: werken/liever_niet/zeker_niet). De UI groepeert blokken in tabs zoals de Excel: alle binaire blokken samen onder "Kleine vakanties", de voorkeurblokken onder "Zomer". Invulling per DAG (week-snelknoppen in de UI, want de praktijk vult per werkweek + weekend apart in). Een dag moet binnen één van de blokken vallen — de schoolweken ertussen zijn geen geldige invoer. Bij een voorkeurblok legt de beheerder ná het sluiten de definitieve verdeling vast (entries op `verlof` zetten) vóór `apply`. Matrix zichtbaar voor iedereen; invullen enkel voor jezelf en enkel per WEEK — er is geen dag-modus meer, ook niet voor beheerders.
- **Zomerronde afwerken**: `apply` neemt alleen entries met status `verlof` over, terwijl een voorkeurblok enkel `werken`/`liever_niet`/`zeker_niet` bevat. Zonder tussenstap levert een zomerronde dus niets op. De beheerder legt daarom eerst de verdeling vast via het verdeelscherm (`AppState.leaveScreen = 'verdelen'`, knop "Verlof verdelen" bij een gesloten ronde). `leaveVerdeelVoorstel()` zet een voorstel klaar: wie iets anders dan werken vroeg krijgt verlof, wie niets invulde krijgt werken. Bewust géén bezettings- of eerlijkheidsregels — die komen later. Opslaan gebeurt via het blok-scoped entries-endpoint, nooit via `PUT /leave-rounds/:id/entries`: dat vervangt álle entries van een gebruiker in de ronde en zou de kleine vakanties wissen.
- **Gevraagd naast vastgelegd** (#377): `leave_round_entries` heeft twee kolommen. `status` is wat er GELDT, `requested_status` is wat de medewerker VROEG. Bij het invullen zijn ze gelijk; alleen het blok-scoped verdeelendpoint laat ze uiteenlopen, en dat draagt de gevraagde waarde expliciet over de DELETE heen. Het verdeelscherm kleurt de cel naar `status` en zet de letter naar `requestedStatus`, zodat de beheerder ná het vastleggen nog ziet wie "zeker niet" zei en wie alleen "liever niet". `leaveWensenBewaard()` toetst of gevraagd en geldend ergens uiteenlopen — NIET of er een gevraagde waarde bestaat, want migratie 043 heeft die voor bestaande rijen gelijkgezet aan `status`. Bij een ronde die vóór die migratie verdeeld is, valt het scherm daarom terug op de oude tekst "letter = de vastgelegde verdeling".
- **Gesloten dagen in een verlofronde**: welke dagen tijdens een vakantie gesloten zijn, wordt beslist in het roosterconcept (`draft.grid._pattern.weeks[i].closedDays`, JS-daggetallen met 0=zo, 6=za). De ronde neemt dat bij het openen over in `leave_round_blocks.closed_dates` (absolute datums), zodat een medewerker het ziet zonder `GET /schedule-drafts` te mogen lezen én zodat later na te gaan is welke weekends toen werkweekends waren. Drie toestanden: `null` = onbekend (geen concept gekoppeld), `[]` = alles open, `[...]` = deze dagen dicht — die mogen nooit op één hoop. Bijwerken gebeurt expliciet via de knop "Gesloten dagen bijwerken uit concept", nooit automatisch. **WEEKCONVENTIE**: `_pattern.weeks["i"]` betekent "de i-de maandagweek van de vakantieperiode" — dat is wat de bouwer toont (`getBuilderVakantieWeekStart`), NIET het resultaat van `getWeekNumber()`. `closedDatesFromPattern()` in `app-leave.js` en de shiftgeneratie in `server.js` volgen die conventie.
- **Feestdagen**: `DataStore._publicHolidaysCache` — lazy geladen via `fetchPublicHolidays(year)`. Gebruik `getPublicHoliday(date)` voor rendering. Let op: gebruik hier plain `fetch()`, niet `dataApiFetch()` (endpoint vereist geen auth)
- **Gesloten dagen uit een vakantieconcept**: een basisrooster schrijft zijn patroon bij het toepassen naar `settings.schedule_pattern`, waardoor `isDayClosed()` het kent. Een vakantieconcept doet dat bewust NIET — zijn cyclus is vakantie-relatief en zou het jaarpatroon verzieken. Bij het toepassen worden zijn gesloten dagen daarom als absolute datums weggeschreven naar `settings.conceptClosedDates` (`[{date, reason, draftId}]`), per concept vervangen. `isDayClosed()` en `getClosedDateInfo()` lezen die mee, zodat planning, drag-drop en shift aanmaken kloppen. Ze staan apart van `closedDates` en verschijnen dus niet in het lijstje "manueel gesloten datums" in Instellingen.
- **Meldingen** (#119): één component in `styles.css`, met vier soorten plus een neutrale. `.alert` is de canonieke naam (flex, dus met pictogram naast de tekst); `.info-box`, `.warning-banner`, `.validation-warning`, `.builder-11h-warnings` en `.leave-banner` delen dezelfde declaraties in plaats van ze te herhalen. Kleuren komen uit de `--alert-{error,warning,info,ok}-{bg,border,text}` tokens, die per thema omslaan, dus een nieuwe melding werkt automatisch in donkere modus. Voeg nooit een eigen achtergrond of rand toe aan een melding: gebruik `class="alert alert-warning"` en laat de tokens hun werk doen
- **Kleuren** (#180): gebruik de tokens, nooit een hexwaarde. De warme palette staat bovenaan `styles.css`; voor alles wat een betekenis draagt zijn dat de `--alert-*`-tokens (zie Meldingen hierboven). Een hardgecodeerde kleur werkt per definitie maar in één thema, en dat is hoe de oude Tailwind-waarden hier binnenkwamen. Teamkleuren zijn de uitzondering: die horen bij een team en hebben hun eigen `--team-*`-tokens
- **Zijbalk** (#162): de zijbalk is in BEIDE thema's donker, want hij is een eigen vlak en geen stuk pagina. Alles wat erin staat gebruikt daarom de `--sidebar-*`-tokens (`-bg`, `-text`, `-text-active`, `-label`, `-active-bg`, `-hover-bg`, `-line`) en nooit de tekstkleuren van de pagina zoals `--text-primary`. Een `body.dark-mode`-uitzondering op iets in de zijbalk is bijna altijd fout: die zou de zijbalk juist terug naar de paginakleuren trekken. De dekkingen zijn gemeten op contrast, niet gekozen op smaak: navigatietekst `.72` haalt 8,1 en het groepslabel `.55` haalt 5,4
- **Dienstblok in de tijdlijn** (#163): het blok is smal, en dat bepaalt wat erin past. Nagemeten op 1440 pixels in weekweergave houdt een dienst van acht uur 59 pixels over: de tijd past daar op 9px en niet op 10. Grotere tekst knipt de tijd af, en een afgeknipte tijd leest als een ANDERE tijd. Verhoog die maten dus niet zonder opnieuw te meten. Activiteiten staan als chips met de volle afkorting op 9px (`ACTIVITY_TYPE_LABELS_SHORT`, `activiteitenChips()` in `app-planner.js`). Die ruimte komt uit de opmaak eromheen en niet uit de tekst: padding 2 in plaats van 3, linkerrand 1 in plaats van 2, tussenruimte 1 in plaats van 2. Twee chips passen daarmee in de 67 pixels van een dienst van acht uur, en ook in de smalste blok dat chips toont (zes uur). Kortere codes op een grotere letter zijn geprobeerd en afgewezen, want "Overl" lees je meteen en "OL" is een code die je eerst moet leren. De achtergronden van `.activity-type-*` zijn ondoorzichtig, want daaronder ligt de teamkleur en die verschilt per team; met doorzichtige chips hing het leescontrast dus af van wie er in welk team zit. Het verloop van het blok loopt van 78 naar 88 procent teamkleur en niet tot 100: bij de volle kleur zakte de tekst op drie van de vijf teams onder de contrasteis
- **Opstartscherm** (#389): `index.html` zet de klasse `session-restoring` op `<html>` zodra er een token in `sessionStorage` staat. Die verbergt het loginscherm (anders flitst dat voorbij bij wie al ingelogd is) en `#app-container` staat dan nog op `hidden`. In dat gat toont `#opstartscherm` het KADER van de app: dezelfde zijbalk op dezelfde plek, met vlakken waar de inhoud komt. Puur markup en CSS, dus het staat er al bij de eerste paint. **De klasse moet op élk pad weggehaald worden**: in `showApp()` (geslaagd), in de twee foutafhandelingen van `checkSession()` en in `showLogin()`. Vergeet je er één, dan blijft het opstartscherm over de app heen staan
- **Stat-kaarten op home** (#166): twee reeksen, elk met een eigen doelgroep. `renderHomeEigenUren()` toont JOUW uren deze week en deze periode tegen je contract, plus wat op jou wacht; alleen voor wie meedraait in het rooster, want een adminaccount heeft geen diensten. `renderHomeStats()` toont de BEHEERcijfers en is er alleen voor admin en roosterverantwoordelijke. Zonder contracturen verschijnt er geen balk en geen "van": `32/0u` zou onzin zijn. De kleurregel is dezelfde als bij de uren in de planning: rood boven de norm, oranje eronder
- **Manuele sluitingsdagen**: opgeslagen als `settings.closedDates` (array `[{date, reason}]`). `isDayClosed()` checkt dit automatisch → drag-drop, shift aanmaken en beschikbaarheidstabel werken zonder extra aanpassingen
- **Uren bij naam (planning view)**: In timeline- en maandweergave wordt per medewerker week- en periodetotaal getoond onder de naam (`X/Yu` formaat). Berekend via `getEmployeeHoursThisWeek(id, weekStartStr)` en `getEmployeeHoursThisPeriod(id, dateStr)` uit `data.js`. Kleur: rood = boven contractnorm, oranje = onder contractnorm. Periodenorm = `contractHours × 4` (vaste 4-weken-periodes verankerd aan het schooljaar via `getFourWeekPeriodDates()`). Een jaar telt 13 periodes van elk 4 weken.

## MCP Server

De MCP server is actief en verbonden met de productie-API. Dit laat Claude toe om live data te lezen tijdens development, debugging en feature-bouw.

**API URL**: `https://uurrooster-app.onrender.com/api/v1`

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

> ⚠️ **Schrijf-tools** (`create_shift`, `update_shift`, `delete_shift`) raken de **productiedatabase**. Deze tools NOOIT gebruiken zonder expliciete bevestiging van Victor — ook niet als de vraag dit impliciet suggereert. Altijd eerst de actie beschrijven en wachten op "ja, doe het".

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

Negen testbestanden in `backend/tests/`; zie de tabel bij het bestandsoverzicht
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
