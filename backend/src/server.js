// #156: dit moet bovenaan staan, vóór express. De monitoring haakt zich in de
// http-laag, en dat kan alleen als ze eerder geladen is dan wat ze moet
// observeren. dotenv staat er daarom ook vóór, anders is SENTRY_DSN nog niet
// bekend; config() overschrijft niets wat al in de omgeving staat, dus de
// tweede aanroep in db.js blijft onschadelijk.
require('dotenv').config();
const { initMonitoring, meldMonitoringStatus, Sentry } = require('./monitoring');
const MONITORING_AAN = initMonitoring();
meldMonitoringStatus(MONITORING_AAN);

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');
const emailService = require('./email');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
// Validate critical env vars (all environments)
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET env var is required (stel in via .env voor lokale ontwikkeling)');
  process.exit(1);
}
if (!process.env.DEFAULT_RESET_PASSWORD) {
  console.error('FATAL: DEFAULT_RESET_PASSWORD env var is required (stel in via .env voor lokale ontwikkeling)');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is required (stel in via .env voor lokale ontwikkeling)');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_RESET_PASSWORD = process.env.DEFAULT_RESET_PASSWORD;

// Security headers
app.use(helmet());
app.set('trust proxy', 1);

// CORS: restrict to frontend origin(s) in production, open in development
const defaultOrigins = [
  'https://uurrooster-frontend.onrender.com',
  'https://vlot-dashboard.site',
  'https://www.vlot-dashboard.site',
];
const allowedOrigins = process.env.FRONTEND_URL
  ? [...new Set([...process.env.FRONTEND_URL.split(',').map(o => o.trim()), ...defaultOrigins])]
  : defaultOrigins;
// #159: X-Vernieuwd-Token moet de frontend kunnen LEZEN. Een browser geeft van
// een antwoord van een andere oorsprong maar een handvol headers vrij; wat daar
// niet bij staat bestaat voor JavaScript gewoon niet, zonder foutmelding.
const exposedHeaders = ['X-Vernieuwd-Token'];
const corsOptions = process.env.NODE_ENV === 'production'
  ? { origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)), credentials: true, exposedHeaders }
  : { exposedHeaders };
app.use(cors(corsOptions));
app.use(express.json());

// Global rate limiter (disabled in test environment to avoid interference with the test suite)
// Eén page-load doet ~10 API-calls; 600/min/IP geeft ruimte voor normaal gebruik
// (navigatie, drag-drop, herladen) terwijl runaway loops/misbruik nog steeds geblokkeerd worden.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel verzoeken. Probeer later opnieuw.' }
});
app.use(globalLimiter);

// ===== DATE HELPER FUNCTIONS =====
// Used by apply-schedule endpoint (replicates frontend data.js logic)
const crypto = require('crypto');
const { getMonday, formatDateYYYYMMDD, parseLocalDate, getBelgianPublicHolidays, shiftsOverlapCheck, hoursBetweenShifts, formatICalDateTime } = require('./utils');

// #379: elk gereset of nieuw aangemaakt account kreeg DEFAULT_RESET_PASSWORD,
// één vaste waarde uit de omgeving. Die is voor iedereen dezelfde en blijft
// dezelfde tot iemand haar in het Render-dashboard wijzigt, dus elke collega
// die ooit een reset of een nieuw account kreeg, kent het wachtwoord waarmee
// élk volgend account begint. Er is bovendien niets dat iemand ooit van die
// waarde af duwt: een account waarvan de eigenaar zijn wachtwoord nooit
// veranderde, staat er permanent op.
//
// ===== VERSIONED MIGRATIONS =====  (verhuisd naar migraties.js, #157)
const { MIGRATIONS, runMigrations } = require('./migraties');

async function ensureBootstrapData() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) return; // geen gegevens → niets te doen
  const client = await pool.connect();
  try {
    const defaultTeams = [
      ['vlot1', 'Vlot 1 (Begeleiding)', '#4a7c6f'],
      ['vlot2', 'Vlot 2 (Begeleiding)', '#c08a4a'],
      ['cargo', 'Cargo (Dagbesteding)', '#5b7fa6'],
      ['overkoepelend', 'Overkoepelend (Kantoor)', '#9a6a9e'],
      ['jobstudent', 'Jobstudenten/Stagiairs', '#b9656a']
    ];
    for (const [id, name, color] of defaultTeams) {
      await client.query(
        `INSERT INTO teams (id, name, color) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [id, name, color]
      );
    }
    const existing = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [adminEmail]);
    if (existing.rows.length === 0) {
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      await client.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')
         ON CONFLICT (email) DO NOTHING`,
        ['Admin', adminEmail.toLowerCase(), passwordHash]
      );
      console.log('[bootstrap] Admin-account aangemaakt');
    }
  } catch (err) {
    console.error('[bootstrap] Fout:', err.message);
  } finally {
    client.release();
  }
}

// #151 GDPR bewaartermijnen — loopt bij elke startup (idempotent)
// Termijnen: shifts 5j, availability 5j, audit_log 2j, swap_requests 2j
async function enforceRetentionPolicies() {
  const steps = [
    {
      label: 'archive shifts (>12 maanden)',
      sql: `UPDATE shifts SET archived = true WHERE archived = false AND date < CURRENT_DATE - INTERVAL '12 months'`,
    },
    {
      label: 'verwijder gearchiveerde shifts (>5 jaar)',
      sql: `DELETE FROM shifts WHERE archived = true AND date < CURRENT_DATE - INTERVAL '5 years'`,
    },
    {
      label: 'verwijder beschikbaarheidsdata (>5 jaar)',
      sql: `DELETE FROM availability WHERE date < CURRENT_DATE - INTERVAL '5 years'`,
    },
    {
      label: 'verwijder audit_log (>2 jaar)',
      sql: `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '2 years'`,
    },
    {
      label: 'verwijder afgeronde ruilverzoeken (>2 jaar)',
      sql: `DELETE FROM shift_swap_requests
            WHERE status IN ('approved','rejected','cancelled','expired')
              AND created_at < NOW() - INTERVAL '2 years'`,
    },
    {
      // #154 vroeg om automatische rotatie na X maanden. Dat doe ik bewust
      // niet: een agendalink die iemand werkelijk gebruikt zomaar ongeldig
      // maken breekt zijn agenda zonder dat hij begrijpt waarom, en hij hoort
      // het pas als hij een dienst mist. De winst weegt daar niet tegenop,
      // want het token is een willekeurige UUID die nergens gepubliceerd staat.
      //
      // Wat wél weg mag zonder iets te breken: een link die aangemaakt is en
      // daarna nooit opgehaald. Iemand heeft toen op de knop gedrukt en is er
      // niet mee verder gegaan. Die URL staat misschien nog in een
      // browsergeschiedenis of een plakbord, geeft dertien maanden rooster, en
      // niemand mist hem. Per definitie breekt dit geen enkele werkende
      // koppeling: er is nooit een opvraging geweest.
      label: 'trek nooit gebruikte agendalinks in (>60 dagen)',
      sql: `UPDATE users
               SET ical_feed_token = NULL, ical_token_created = NULL
             WHERE ical_feed_token IS NOT NULL
               AND ical_last_access IS NULL
               AND ical_token_created < NOW() - INTERVAL '60 days'`,
    },
  ];
  for (const step of steps) {
    try {
      const r = await pool.query(step.sql);
      if (r.rowCount > 0) console.log(`[retention] ${step.label}: ${r.rowCount} rijen`);
    } catch (err) {
      console.error(`[retention] Fout bij "${step.label}": ${err.message}`);
    }
  }
}

// Legacy alias — kept so any future direct calls still work
const archiveOldShifts = enforceRetentionPolicies;

// #157: signToken, requireAuth, requireAdmin, requireRole en logAudit stonden
// hier. Ze zijn verhuisd naar middleware/auth.js en helpers/audit.js, want elke
// route-module heeft ze nodig en ze horen niet in het bestand waar toevallig de
// eerste route stond die ze gebruikte.
const { signToken, requireAuth, requireAdmin, requireRole } = require('./middleware/auth');
const { logAudit } = require('./helpers/audit');

// ===== SHIFT VALIDATIE =====  (verhuisd naar helpers/dienstregels.js, #157)
const {
  AFWEZIGHEIDSTYPES, GELIJKE_TIJDEN_MELDING, MAX_AFWEZIGHEIDSDAGEN, STANDAARD_MIN_RUST,
  blockDayIfEmpty, getMinRustUren, isGeldigAfwezigheidstype, isGeldigeDatumString,
  isValidTime, normaliseerTijd, validateShiftRules,
} = require('./helpers/dienstregels');

// ===== API ROUTER =====
// #157: de omwikkeling die async fouten opvangt (#380) stond hier inline en
// gold voor deze ene router. Nu maakt maakRouter() er een die het al kan, dus
// elke route-module krijgt dezelfde opvang zonder eraan te hoeven denken.
const { maakRouter } = require('./veilige-router');
const v1 = maakRouter();

// De routes van dit blok staan in routes/auth.js (#157).
v1.use(require('./routes/auth'));

// ===== CURRENT USER (ME) API =====  (verhuisd naar routes/me.js, #157)
v1.use(require('./routes/me'));

// ===== EMAIL PREFERENCES =====  (verhuisd naar routes/me-voorkeuren-en-agenda.js, #157)
v1.use(require('./routes/me-voorkeuren-en-agenda'));

// ===== TEAMS API =====  (verhuisd naar routes/teams.js, #157)
v1.use(require('./routes/teams'));

// ===== USERS API (replaces employees) =====  (verhuisd naar routes/users.js, #157)
v1.use(require('./routes/users'));

// ===== ADMIN USER MANAGEMENT =====  (verhuisd naar routes/admin-users.js, #157)
v1.use(require('./routes/admin-users'));

// ===== REPLACE EMPLOYEE =====  (verhuisd naar routes/replace-employee.js, #157)
v1.use(require('./routes/replace-employee'));

// ===== APPLY SCHEDULE =====
// NOTE: regenerateShiftsForUser() is VERWIJDERD.
// Shifts worden nu ALLEEN aangemaakt via concept toepassen (POST /schedule-drafts/:id/apply).
// Het concept is de enige bron van waarheid — geen achtergrondregeneratie meer.

// ===== EMAIL BEHEER =====

v1.get('/admin/email-status', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const configured = !!process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Het Vlot Rooster <onboarding@resend.dev>';
  res.json({ configured, from });
});

// #156: een opzettelijke fout, om na te gaan of de foutmonitoring echt werkt.
//
// Alleen geregistreerd als de monitoring aanstaat, en alleen voor een admin.
// Zonder zo'n knop is de enige manier om het te controleren wachten tot er
// vanzelf iets misgaat, en dan weet je nog steeds niet of het aan de monitoring
// lag of dat er gewoon niets kapot was.
//
// De fout draagt bewust NEP-gegevens mee die op echte lijken: een e-mailadres,
// een naam, en een afwezigheid met type 'ziek' en een reden. Komt de melding
// aan in Sentry met die velden op [weggelaten], dan is bewezen dat de filtering
// ook in productie draait en niet alleen in de tests.
if (MONITORING_AAN) {
  v1.post('/admin/monitoring-test', requireAuth, requireRole('admin'), async (req, res) => {
    const fout = new Error('Testfout voor de foutmonitoring (#156), opzettelijk veroorzaakt');
    Sentry.captureException(fout, {
      extra: {
        toelichting: 'Dit is een test. Alle gegevens hieronder zijn verzonnen.',
        nepPayload: {
          userId: 999,
          date: '2099-01-01',
          type: 'ziek',
          reason: 'VERZONNEN REDEN, hoort niet in Sentry te staan'
        },
        nepEmail: 'verzonnen@voorbeeld.be',
        nepNaam: 'Verzonnen Persoon'
      },
      tags: { testfout: 'ja' }
    });
    await Sentry.flush(3000);
    res.json({
      ok: true,
      melding: 'Testfout verstuurd. Kijk in Sentry of hij aankomt, en of de verzonnen gegevens er als [weggelaten] in staan.'
    });
  });
}

v1.post('/admin/test-email', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (!user || !user.email) {
      return res.status(400).json({ error: 'Je account heeft geen e-mailadres. Voeg er eerst een toe via je profiel.' });
    }
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'RESEND_API_KEY is niet geconfigureerd op de server.' });
    }
    // #209: hiervoor stond hier alleen `await notifyTestEmail(user)` gevolgd door
    // een vast success-antwoord. Deze knop is het enige instrument om te
    // controleren of e-mail werkt, en hij zei altijd ja, ook wanneer Resend de
    // mail weigerde. Nu antwoorden we op wat er echt gebeurd is.
    const result = await emailService.notifyTestEmail(user);
    if (!result || !result.ok) {
      const reden = (result && result.error) || 'Onbekende fout bij de mailprovider.';
      return res.status(502).json({ error: 'Testmail versturen mislukt: ' + reden });
    }
    res.json({ success: true, sentTo: user.email, messageId: result.id || null });
  } catch (err) {
    res.status(500).json({ error: 'Testmail versturen mislukt: ' + (err.message || 'Onbekende fout') });
  }
});

// ===== SHIFTS API =====  (verhuisd naar routes/shifts.js, #157)
v1.use(require('./routes/shifts'));

// ===== SHIFT ACTIVITIES API =====  (verhuisd naar routes/shift-activities.js, #157)
v1.use(require('./routes/shift-activities'));

// ===== AVAILABILITY API =====  (verhuisd naar routes/availability.js, #157)
v1.use(require('./routes/availability'));

// ===== SHIFT BLOCKS API =====  (verhuisd naar routes/shift-blocks.js, #157)
v1.use(require('./routes/shift-blocks'));

// ===== SWAP REQUESTS API =====  (verhuisd naar routes/swaps.js, #157)
v1.use(require('./routes/swaps'));

// ===== SETTINGS API =====  (verhuisd naar routes/settings.js, #157)
v1.use(require('./routes/settings'));

// ===== SCHEDULE DRAFTS API =====  (verhuisd naar routes/drafts.js, #157)
v1.use(require('./routes/drafts'));

// ===== DEACTIVATE SCHEDULE DRAFT =====  (verhuisd naar routes/draft-deactivate.js, #157)
v1.use(require('./routes/draft-deactivate'));

// ===== APPLY SCHEDULE DRAFT (atomic transaction for all employees) =====  (verhuisd naar routes/draft-apply.js, #157)
v1.use(require('./routes/draft-apply'));

// ===== AUDIT LOG API =====  (verhuisd naar routes/audit-log.js, #157)
v1.use(require('./routes/audit-log'));

// ===== DATA IMPORT API =====  (verhuisd naar routes/import.js, #157)
v1.use(require('./routes/import'));

// ===== VERLOFPLANNING (verlofrondes) =====  (verhuisd naar routes/leave.js, #157)
v1.use(require('./routes/leave'));

// ===== MIGRATION ENDPOINTS =====  (verhuisd naar routes/migratie.js, #157)
v1.use(require('./routes/migratie'));

// ===== ROUTER MOUNTS =====
app.use('/api/v1', v1);
// Backward-compat: oude routes zonder prefix blijven werken — verwijderen na v1.3
app.use('/', v1);

// #215: laatste vangnet. Elke route zou zijn eigen fouten moeten afhandelen,
// maar één vergeten plek mag niet de hele dienst kosten. Express 4 vangt een
// afgewezen promise uit een async handler niet op, en zonder deze handler
// beëindigt Node 22 het proces. Loggen en doordraaien is hier veiliger: een
// enkel verzoek faalt dan, in plaats van iedereen tegelijk.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
  // #156: ook melden. Dit zijn juist de fouten die anders alleen in een
  // weggerolde Render-log staan.
  if (MONITORING_AAN) Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  if (MONITORING_AAN) Sentry.captureException(err);
});

// #156: Sentry ziet de fout eerst, en geeft hem daarna door aan de middleware
// hieronder die het antwoord stuurt. Deze volgorde is verplicht: staat de
// eigen afhandelaar eerst, dan is de fout al opgeslokt en meldt Sentry niets.
// Zonder SENTRY_DSN gebeurt hier niets.
if (MONITORING_AAN) Sentry.setupExpressErrorHandler(app);

// Express-foutmiddleware. Moet ná alle routes staan en vier parameters hebben,
// anders herkent Express hem niet als foutafhandelaar.
app.use((err, req, res, _next) => {
  console.error(`[express] ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Server error' });
});

if (process.env.NODE_ENV !== 'test') {
  runMigrations()
    .then(() => ensureBootstrapData())
    .then(() => archiveOldShifts())
    .then(() => {
      app.listen(PORT, () => console.log(`API running on :${PORT}`));
    })
    .catch(err => {
      // #193: hier stond een .catch die alleen logde, gevolgd door een
      // .finally die tóch ging luisteren. Een mislukte migratie leverde dus
      // een API op die tegen een half gemigreerd schema draait, met als enig
      // spoor een regel in het Render-log.
      //
      // Een server die niet opkomt is luidruchtig en veilig. Eentje die op een
      // half schema draait is stil en gevaarlijk.
      console.error('[startup] Opstarten afgebroken:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}

module.exports = app;
