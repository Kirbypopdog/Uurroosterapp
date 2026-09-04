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
const corsOptions = process.env.NODE_ENV === 'production'
  ? { origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)), credentials: true }
  : {};
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

// ===== VERSIONED MIGRATIONS =====
// Each entry runs exactly once, tracked in the `migrations` table.
// All DDL uses IF NOT EXISTS so migrations are safe to re-run on existing DBs.

const MIGRATIONS = [
  {
    // Basistabellen aanmaken op een verse database. schema.sql is volledig idempotent
    // (enkel CREATE ... IF NOT EXISTS), dus op een bestaande database is dit een no-op.
    // Hierdoor initialiseert elke nieuwe omgeving (bv. staging) zichzelf bij de eerste deploy,
    // zonder handmatige `npm run db:setup` of shell-toegang.
    name: '000_base_schema',
    up: async (client) => {
      const fs = require('fs');
      const path = require('path');
      const schema = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
      await client.query(schema);
    }
  },
  {
    name: '001_user_employee_columns',
    up: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS main_team TEXT REFERENCES teams(id)`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_teams TEXT[] DEFAULT '{}'`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contract_hours NUMERIC DEFAULT 0`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS week_schedule_week1 JSONB DEFAULT '[]'`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS week_schedule_week2 JSONB DEFAULT '[]'`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS week_schedules JSONB DEFAULT NULL`);
    }
  },
  {
    name: '002_populate_week_schedules',
    up: async (client) => {
      await client.query(`
        UPDATE users SET week_schedules = jsonb_build_array(
          COALESCE(week_schedule_week1, '[]'::jsonb),
          COALESCE(week_schedule_week2, '[]'::jsonb)
        ) WHERE week_schedules IS NULL
      `);
    }
  },
  {
    name: '003_shifts_source_column',
    up: async (client) => {
      await client.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual' CHECK (source IN ('auto', 'manual'))`);
    }
  },
  {
    name: '004_create_shift_swap_requests',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS shift_swap_requests (
          id SERIAL PRIMARY KEY,
          requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          requester_shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
          target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          target_shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
          request_type TEXT NOT NULL DEFAULT 'swap' CHECK (request_type IN ('swap', 'takeover')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead', 'expired')),
          message TEXT,
          response_notes TEXT,
          target_approved BOOLEAN DEFAULT NULL,
          target_response_notes TEXT,
          target_responded_at TIMESTAMP,
          lead_approved BOOLEAN DEFAULT NULL,
          lead_response_notes TEXT,
          lead_responded_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          responded_at TIMESTAMP,
          responded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON shift_swap_requests(status)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_requester ON shift_swap_requests(requester_user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_target ON shift_swap_requests(target_user_id)`);
    }
  },
  {
    name: '005_swap_request_approval_columns',
    up: async (client) => {
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS target_approved BOOLEAN DEFAULT NULL`);
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS target_response_notes TEXT`);
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS target_responded_at TIMESTAMP`);
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS lead_approved BOOLEAN DEFAULT NULL`);
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS lead_response_notes TEXT`);
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS lead_responded_at TIMESTAMP`);
    }
  },
  {
    name: '006_swap_request_type_and_nullable_targets',
    up: async (client) => {
      await client.query(`ALTER TABLE shift_swap_requests ADD COLUMN IF NOT EXISTS request_type TEXT DEFAULT 'swap' CHECK (request_type IN ('swap', 'takeover'))`);
      await client.query(`ALTER TABLE shift_swap_requests ALTER COLUMN target_user_id DROP NOT NULL`);
      await client.query(`ALTER TABLE shift_swap_requests ALTER COLUMN target_shift_id DROP NOT NULL`);
      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS different_shifts`);
      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS different_users`);
    }
  },
  {
    name: '007_create_shift_blocks',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS shift_blocks (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reason TEXT,
          UNIQUE(user_id, date)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shift_blocks_user_date ON shift_blocks(user_id, date)`);
    }
  },
  {
    name: '008_create_settings',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
  },
  {
    name: '009_create_audit_log',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          actor_name TEXT NOT NULL,
          action TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_id TEXT,
          details JSONB DEFAULT '{}',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC)`);
    }
  },
  {
    name: '010_audit_log_constraints',
    up: async (client) => {
      await client.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check`);
      await client.query(`ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'CANCEL', 'LOGIN', 'REPLACE', 'IMPORT', 'MIGRATE'))`);
      await client.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_resource_type_check`);
      await client.query(`ALTER TABLE audit_log ADD CONSTRAINT audit_log_resource_type_check CHECK (resource_type IN ('shift', 'availability', 'swap_request', 'user', 'settings', 'system', 'shift_activity', 'shift_block'))`);
    }
  },
  {
    name: '011_create_schedule_drafts',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schedule_drafts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          week_number INTEGER NOT NULL DEFAULT 1,
          team_filter TEXT,
          grid JSONB NOT NULL DEFAULT '{}',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_by_name TEXT,
          last_applied_at TIMESTAMP,
          last_applied_by TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_schedule_drafts_created ON schedule_drafts(created_at DESC)`);
    }
  },
  {
    name: '012_migrate_drafts_from_settings',
    up: async (client) => {
      const settingsDrafts = await client.query(`SELECT value FROM settings WHERE key = 'schedule_drafts'`);
      if (settingsDrafts.rows.length > 0) {
        const drafts = settingsDrafts.rows[0].value;
        if (Array.isArray(drafts) && drafts.length > 0) {
          for (const draft of drafts) {
            await client.query(
              `INSERT INTO schedule_drafts (id, name, week_number, team_filter, grid, created_by_name, last_applied_at, last_applied_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (id) DO NOTHING`,
              [
                draft.id || `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                draft.name || 'Naamloos',
                draft.weekNumber || 1,
                draft.teamFilter || null,
                JSON.stringify(draft.grid || {}),
                draft.createdByName || null,
                draft.lastAppliedAt || null,
                draft.lastAppliedBy || null,
                draft.createdAt || new Date().toISOString(),
                draft.updatedAt || draft.createdAt || new Date().toISOString()
              ]
            );
          }
        }
      }
    }
  },
  {
    name: '013_migrate_roles_and_add_constraint',
    up: async (client) => {
      await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
      await client.query(`UPDATE users SET role = 'roosterverantwoordelijke' WHERE role IN ('hoofdverantwoordelijke', 'teamverantwoordelijke')`);
      await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'roosterverantwoordelijke', 'medewerker'))`);
    }
  },
  {
    name: '014_users_email_notifications',
    up: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN DEFAULT true`);
    }
  },
  {
    name: '015_users_onboarding_flags',
    up: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_flags JSONB DEFAULT '{}'`);
    }
  },
  {
    name: '016_swap_expired_status',
    up: async (client) => {
      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check`);
      await client.query(`ALTER TABLE shift_swap_requests ADD CONSTRAINT shift_swap_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead', 'expired'))`);
    }
  },
  {
    name: '017_create_shift_activities',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS shift_activities (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          start_time TIME NOT NULL,
          end_time TIME NOT NULL,
          type TEXT NOT NULL,
          description TEXT DEFAULT '',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);
    }
  },
  {
    name: '018_shift_activity_and_shifts_indexes',
    up: async (client) => {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shift_activities_user_date ON shift_activities(user_id, date)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date)`);
    }
  },
  {
    name: '019_fk_cascade_fixes',
    up: async (client) => {
      await client.query(`ALTER TABLE shift_blocks DROP CONSTRAINT IF EXISTS shift_blocks_created_by_fkey`);
      await client.query(`ALTER TABLE shift_blocks ADD CONSTRAINT shift_blocks_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_responded_by_fkey`);
      await client.query(`ALTER TABLE shift_swap_requests ADD CONSTRAINT shift_swap_requests_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL`);
    }
  },
  {
    name: '020_shift_activities_shift_id',
    up: async (client) => {
      await client.query(`ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE`);
      await client.query(`
        UPDATE shift_activities sa
        SET shift_id = (
          SELECT s.id FROM shifts s
          WHERE s.user_id = sa.user_id AND s.date = sa.date
          ORDER BY ABS(EXTRACT(EPOCH FROM (s.start_time::TIME - sa.start_time)))
          LIMIT 1
        )
        WHERE sa.shift_id IS NULL
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shift_activities_shift_id ON shift_activities(shift_id)`);
    }
  },
  {
    name: '021_performance_indexes',
    up: async (client) => {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_source ON shifts(source)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_availability_type ON availability(type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_type ON shift_swap_requests(request_type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id)`);
    }
  },
  {
    name: '022_schedule_drafts_date_columns',
    up: async (client) => {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS valid_from DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS valid_until DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS last_applied_from DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS last_applied_until DATE`);
    }
  },
  {
    name: '023_schedule_drafts_updated_by',
    up: async (client) => {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS updated_by INTEGER`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS updated_by_name TEXT`);
    }
  },
  {
    name: '024_schedule_drafts_type_and_holiday',
    up: async (client) => {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'basis'`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS holiday_period_id TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_schedule_drafts_type ON schedule_drafts(type)`);
    }
  },
  {
    name: '025_schedule_drafts_lock_columns',
    up: async (client) => {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_by INTEGER`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_by_name TEXT`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`);
    }
  },
  {
    name: '026_users_email_nullable',
    up: async (client) => {
      await client.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
    }
  },
  {
    name: '027_normalize_emails_lowercase',
    up: async (client) => {
      await client.query(`UPDATE users SET email = LOWER(email) WHERE email IS NOT NULL AND email != LOWER(email)`);
    }
  },
  {
    name: '028_school_year_start_setting',
    up: async (client) => {
      const existing = await client.query(`SELECT 1 FROM settings WHERE key = 'school_year_start'`);
      if (existing.rows.length === 0) {
        const now = new Date();
        const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
        await client.query(
          `INSERT INTO settings (key, value) VALUES ('school_year_start', $1)`,
          [JSON.stringify({ date: `${startYear}-09-01` })]
        );
      }
    }
  },
  {
    name: '029_shifts_archived_column',
    up: async (client) => {
      await client.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_archived ON shifts(archived) WHERE archived = false`);
    }
  },
  {
    // Veiligheidsnet: als migratie 020 faalde, stopt de keten bij 020 en missen
    // alle volgende migraties (021-029). Dit voegt alle kritieke kolommen toe
    // met IF NOT EXISTS zodat het veilig is ook als ze al bestaan.
    name: '030_ensure_schema_020_to_029',
    up: async (client) => {
      // --- 020: shift_activities.shift_id ---
      await client.query(`ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shift_activities_shift_id ON shift_activities(shift_id)`);

      // --- 021: performance indexes (idempotent) ---
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_source ON shifts(source)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_availability_type ON availability(type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_type ON shift_swap_requests(request_type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id)`);

      // --- 022: schedule_drafts date columns ---
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS valid_from DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS valid_until DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS last_applied_from DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS last_applied_until DATE`);

      // --- 023: schedule_drafts updated_by ---
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS updated_by INTEGER`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS updated_by_name TEXT`);

      // --- 024: schedule_drafts type & holiday ---
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'basis'`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS holiday_period_id TEXT`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_schedule_drafts_type ON schedule_drafts(type)`);

      // --- 025: schedule_drafts lock columns ---
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_by INTEGER`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_by_name TEXT`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`);

      // --- 026: users.email nullable ---
      await client.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);

      // --- 027: emails lowercase ---
      await client.query(`UPDATE users SET email = LOWER(email) WHERE email IS NOT NULL AND email != LOWER(email)`);

      // --- 028: school_year_start setting ---
      const existing = await client.query(`SELECT 1 FROM settings WHERE key = 'school_year_start'`);
      if (existing.rows.length === 0) {
        const now = new Date();
        const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
        await client.query(
          `INSERT INTO settings (key, value) VALUES ('school_year_start', $1)`,
          [JSON.stringify({ date: `${startYear}-09-01` })]
        );
      }

      // --- 029: shifts.archived ---
      await client.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_archived ON shifts(archived) WHERE archived = false`);
    }
  },
  {
    name: '031_shifts_is_reserve',
    up: async (client) => {
      await client.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_reserve BOOLEAN NOT NULL DEFAULT false`);
    }
  },
  {
    name: '032_users_ical_feed_token',
    up: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ical_feed_token TEXT UNIQUE`);
    }
  },
  {
    // #158 GDPR: ensure all user-referencing FKs have correct ON DELETE behaviour.
    // Fresh DBs created via schema.sql already have the right constraints, but
    // databases created before these constraints were added need them enforced.
    name: '033_gdpr_fk_on_delete',
    up: async (client) => {
      const tables = [
        { table: 'shifts',              col: 'user_id',            ref: 'users(id)',  action: 'CASCADE'  },
        { table: 'availability',        col: 'user_id',            ref: 'users(id)',  action: 'CASCADE'  },
        { table: 'shift_blocks',        col: 'user_id',            ref: 'users(id)',  action: 'CASCADE'  },
        { table: 'shift_activities',    col: 'user_id',            ref: 'users(id)',  action: 'CASCADE'  },
        { table: 'shift_swap_requests', col: 'requester_user_id',  ref: 'users(id)',  action: 'CASCADE'  },
        { table: 'shift_swap_requests', col: 'target_user_id',     ref: 'users(id)',  action: 'CASCADE'  },
        { table: 'shift_swap_requests', col: 'responded_by',       ref: 'users(id)',  action: 'SET NULL' },
        { table: 'audit_log',           col: 'actor_id',           ref: 'users(id)',  action: 'SET NULL' },
        { table: 'schedule_drafts',     col: 'created_by',         ref: 'users(id)',  action: 'SET NULL' },
        { table: 'schedule_drafts',     col: 'updated_by',         ref: 'users(id)',  action: 'SET NULL' },
      ];
      for (const { table, col, ref, action } of tables) {
        // Find the FK constraint name for this column
        const res = await client.query(`
          SELECT tc.constraint_name, rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = $1 AND kcu.column_name = $2
        `, [table, col]);
        for (const row of res.rows) {
          const currentAction = row.delete_rule; // e.g. 'NO ACTION', 'CASCADE', 'SET NULL'
          const expected = action.replace(' ', '_'); // normalize for comparison
          if (currentAction !== expected && currentAction !== action) {
            await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "${row.constraint_name}"`);
            await client.query(`ALTER TABLE ${table} ADD FOREIGN KEY (${col}) REFERENCES ${ref} ON DELETE ${action}`);
          }
        }
        // If no FK existed yet, add it
        if (res.rows.length === 0) {
          await client.query(`ALTER TABLE ${table} ADD FOREIGN KEY (${col}) REFERENCES ${ref} ON DELETE ${action}`);
        }
      }
    }
  },
  {
    // Verlofplanning: vervangt de gedeelde Excel ("Verlofplanning 2025-2026").
    // Twee modi in één model:
    //   'binair'   → kleine vakanties: werken / verlof
    //   'voorkeur' → zomer: werken / liever_niet / zeker_niet (voorkeuren die
    //                de planner daarna verdeelt)
    // Invulling is per DAG; de UI biedt week-snelknoppen omdat de praktijk
    // per werkweek + weekend apart werkt.
    name: '034_create_leave_rounds',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS leave_rounds (
          id                SERIAL PRIMARY KEY,
          name              TEXT NOT NULL,
          mode              TEXT NOT NULL DEFAULT 'binair' CHECK (mode IN ('binair', 'voorkeur')),
          start_date        DATE NOT NULL,
          end_date          DATE NOT NULL,
          deadline          DATE,
          status            TEXT NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'open', 'gesloten', 'toegepast')),
          holiday_period_id TEXT,
          rules             JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at        TIMESTAMP DEFAULT NOW(),
          updated_at        TIMESTAMP DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS leave_round_entries (
          id        SERIAL PRIMARY KEY,
          round_id  INTEGER NOT NULL REFERENCES leave_rounds(id) ON DELETE CASCADE,
          user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          date      DATE NOT NULL,
          status    TEXT NOT NULL CHECK (status IN ('werken', 'verlof', 'liever_niet', 'zeker_niet')),
          note      TEXT DEFAULT '',
          UNIQUE (round_id, user_id, date)
        )
      `);
      // Eén rij per medewerker per ronde: dekt de "niet goedgekeurd verlof"-tab
      // (wie heeft nog niet ingediend / nog niet goedgekeurd gekregen).
      await client.query(`
        CREATE TABLE IF NOT EXISTS leave_round_submissions (
          id            SERIAL PRIMARY KEY,
          round_id      INTEGER NOT NULL REFERENCES leave_rounds(id) ON DELETE CASCADE,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          submitted_at  TIMESTAMP,
          approved      BOOLEAN,
          approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_at   TIMESTAMP,
          response_note TEXT DEFAULT '',
          UNIQUE (round_id, user_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_entries_round ON leave_round_entries(round_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_entries_user  ON leave_round_entries(user_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_subs_round    ON leave_round_submissions(round_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_rounds_status ON leave_rounds(status)`);
    }
  },
  {
    // Een verlofronde dekt een heel SCHOOLJAAR, niet één vakantie: in de
    // Excel stonden herfst/kerst/krokus/paas samen in één tab, met de zomer
    // (andere regels) in een aparte tab. Een ronde bestaat daarom uit
    // blokken die elk naar een vakantieperiode uit de instellingen wijzen
    // en een eigen modus hebben. De modus verhuist dus van ronde naar blok.
    name: '035_leave_round_blocks',
    up: async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS leave_round_blocks (
          id                SERIAL PRIMARY KEY,
          round_id          INTEGER NOT NULL REFERENCES leave_rounds(id) ON DELETE CASCADE,
          name              TEXT NOT NULL,
          mode              TEXT NOT NULL DEFAULT 'binair' CHECK (mode IN ('binair', 'voorkeur')),
          start_date        DATE NOT NULL,
          end_date          DATE NOT NULL,
          holiday_period_id TEXT,
          sort_order        INTEGER NOT NULL DEFAULT 0
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_leave_blocks_round ON leave_round_blocks(round_id)`);

      // Bestaande rondes (staging-testdata) krijgen één blok dat de hele
      // ronde beslaat, zodat ze blijven werken onder het nieuwe model.
      await client.query(`
        INSERT INTO leave_round_blocks (round_id, name, mode, start_date, end_date, holiday_period_id, sort_order)
        SELECT r.id, r.name, r.mode, r.start_date, r.end_date, r.holiday_period_id, 0
        FROM leave_rounds r
        WHERE NOT EXISTS (SELECT 1 FROM leave_round_blocks b WHERE b.round_id = r.id)
      `);
    }
  },
  {
    // Welke weekends van een vakantie open of gesloten zijn, wordt beslist in
    // het roosterconcept. De verlofronde neemt die beslissing bij het openen
    // over als eigen gegeven: wie invult moet weten waar hij aan toe is, en
    // over een jaar moet nog na te gaan zijn welke weekends toen werkweekends
    // waren. Een concept kan intussen gewijzigd of verwijderd zijn.
    //
    // NULL = onbekend (geen concept gekoppeld) · [] = bekend, alles open ·
    // [...] = deze dagen zijn gesloten. Die drie moeten uit elkaar blijven,
    // anders tonen we "weekend open" terwijl we niets weten.
    name: '036_leave_block_closed_dates',
    up: async (client) => {
      await client.query(`ALTER TABLE leave_round_blocks ADD COLUMN IF NOT EXISTS closed_dates JSONB`);
      await client.query(`ALTER TABLE leave_round_blocks ADD COLUMN IF NOT EXISTS closed_source JSONB NOT NULL DEFAULT '{}'::jsonb`);
    }
  },
  {
    // #185 / #187: shifts legden nergens vast uit welk concept ze kwamen.
    // Daardoor konden 'uitplannen' en 'overlap bevestigen' alleen op datum en
    // medewerker begrenzen, en werd stelselmatig te veel gewist.
    // ON DELETE SET NULL: een verwijderd concept mag nooit diensten meeslepen.
    // Bestaande diensten houden NULL — die vallen terug op de oude, maar nu wel
    // begrensde, verwijderlogica.
    name: '037_shifts_draft_id',
    up: async (client) => {
      await client.query(`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS draft_id TEXT`);
      const fk = await client.query(`
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'shifts' AND kcu.column_name = 'draft_id'
      `);
      if (fk.rows.length === 0) {
        await client.query(
          `ALTER TABLE shifts ADD FOREIGN KEY (draft_id) REFERENCES schedule_drafts(id) ON DELETE SET NULL`
        );
      }
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_shifts_draft_id ON shifts(draft_id) WHERE draft_id IS NOT NULL`
      );
    }
  },
  {
    // #376: hetzelfde probleem als bij shifts, nu voor teamvergaderingen. Het
    // toepassen van een concept wiste ALLE activiteiten van het type
    // 'vergadering' in het bereik, ongeacht team en ongeacht of iemand ze met
    // de hand had ingevoerd. Zonder herkomst kan de opruiming dat onderscheid
    // niet maken.
    name: '038_shift_activities_draft_id',
    up: async (client) => {
      await client.query(`ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS draft_id TEXT`);
      const fk = await client.query(`
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'shift_activities' AND kcu.column_name = 'draft_id'
      `);
      if (fk.rows.length === 0) {
        await client.query(
          `ALTER TABLE shift_activities ADD FOREIGN KEY (draft_id) REFERENCES schedule_drafts(id) ON DELETE SET NULL`
        );
      }
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_shift_activities_draft_id ON shift_activities(draft_id) WHERE draft_id IS NOT NULL`
      );
    }
  }
];

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const applied = await client.query('SELECT name FROM migrations');
    const appliedNames = new Set(applied.rows.map(r => r.name));

    for (const migration of MIGRATIONS) {
      if (appliedNames.has(migration.name)) continue;

      console.log(`Migratie: ${migration.name}`);
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`  Migratie mislukt (${migration.name}): ${err.message}`);
        // #193: hier werd de fout ingeslikt en ging de lus gewoon door. Als
        // migratie 020 mislukte, draaiden 021 en verder alsnog tegen een schema
        // dat mist wat 020 had moeten toevoegen, en daarna ging de API luisteren
        // tegen een half gemigreerde database.
        //
        // Nu stopt het hier. De aanroeper laat de server niet starten.
        throw new Error(`Migratie ${migration.name} mislukt: ${err.message}`);
      }
    }
  } finally {
    client.release();
  }
}

// Zorgt dat een verse database bruikbaar is: standaardteams + een admin-account.
// Puur additief (ON CONFLICT DO NOTHING) → op een bestaande productie-DB volledig no-op,
// en een bestaand admin-wachtwoord wordt NOOIT overschreven.
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

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, team_id: user.team_id, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Normalize legacy role names from old JWTs (7-day transition period)
    if (req.user.role === 'hoofdverantwoordelijke' || req.user.role === 'teamverantwoordelijke') {
      req.user.role = 'roosterverantwoordelijke';
    }
    // Check if user is still active in the database
    const activeCheck = await pool.query('SELECT active FROM users WHERE id = $1', [req.user.id]);
    if (!activeCheck.rows.length || activeCheck.rows[0].active === false) {
      return res.status(401).json({ error: 'Account is gedeactiveerd' });
    }
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: 'Geen toegang' });
    }
    next();
  };
}

// ===== AUDIT LOG HELPER =====
async function logAudit(req, action, resourceType, resourceId, details = {}) {
  try {
    const actorId = req.user?.id || null;
    const actorName = req.user?.name || req.body?.email || 'System';
    await pool.query(
      `INSERT INTO audit_log (actor_id, actor_name, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId, actorName, action, resourceType, String(resourceId || ''), JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

// ===== SHIFT VALIDATIE =====

function isValidTime(t) {
  return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t);
}

/**
 * Controleert overlap en 11-uur rust voor een nieuwe/gewijzigde shift.
 * @param {object} db - pool (of mock in tests)
 * @param {number} userId
 * @param {{ date: string, start_time: string, end_time: string }} newShift
 * @param {number|null} excludeId - shift-id uitsluiten bij PUT
 * @returns {Promise<{ valid: boolean, message?: string }>}
 */
// Legt vast dat een medewerkerdag bewust leeg is, zodat een concept hem bij
// een volgende toepassing niet opnieuw vult.
//
// Nodig omdat een dienst die WEGBEWEEGT van iemands dag geen spoor achterliet:
// verslepen, ruilen en overnemen zetten user_id of date om, waardoor de
// oorspronkelijke dag leeg achterbleef zonder blokkade. Het concept vulde die
// dag dan opnieuw en de medewerker stond twee keer ingepland, of er stonden
// twee mensen op één dienst. Verwijderen deed dit al wel.
//
// Alleen blokkeren als de dag daarna écht leeg is. Bij een ruil op dezelfde
// dag houdt de medewerker een dienst over, en dan zou een blokkade een
// misleidende indicator opleveren op een dag waar gewoon gewerkt wordt.
async function blockDayIfEmpty(db, userId, date, createdBy, reason) {
  if (!userId || !date) return false;
  const nog = await db.query(
    'SELECT 1 FROM shifts WHERE user_id = $1 AND date = $2::date LIMIT 1',
    [userId, date]
  );
  if (nog.rows.length > 0) return false;
  await db.query(
    `INSERT INTO shift_blocks (user_id, date, created_by, reason)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (user_id, date) DO NOTHING`,
    [userId, date, createdBy || null, reason]
  );
  return true;
}

async function validateShiftRules(db, userId, newShift, excludeId = null, skipRestCheck = false) {
  const MIN_REST = 11;
  const rangeStart = new Date(newShift.date);
  rangeStart.setDate(rangeStart.getDate() - 2);
  const rangeEnd = new Date(newShift.date);
  rangeEnd.setDate(rangeEnd.getDate() + 2);

  const params = [userId, formatDateYYYYMMDD(rangeStart), formatDateYYYYMMDD(rangeEnd)];
  const excludeClause = excludeId ? `AND id != $4` : '';
  if (excludeId) params.push(excludeId);

  const { rows } = await db.query(
    `SELECT id, date::text as date, start_time, end_time FROM shifts
     WHERE user_id = $1 AND date BETWEEN $2 AND $3 ${excludeClause}`,
    params
  );

  for (const existing of rows) {
    if (shiftsOverlapCheck(existing, newShift)) {
      // rule: 'overlap' is nooit te overrulen. Iemand kan niet op twee plekken
      // tegelijk staan, dus dat is geen beleidskeuze maar een feit. force=true
      // slaat alleen de rusttijd over, hier en bij POST/PUT /shifts.
      return { valid: false, rule: 'overlap', message: 'Overlap: medewerker heeft al een shift op dit tijdstip.' };
    }
    if (!skipRestCheck) {
      const hours = hoursBetweenShifts(existing, newShift);
      if (hours >= 0 && hours < MIN_REST) {
        return {
          valid: false,
          rule: 'rest',
          hours: Number(hours.toFixed(1)),
          message: `11-uur regel: slechts ${hours.toFixed(1)}u rust tussen shifts (minimum ${MIN_REST}u).`
        };
      }
    }
  }
  return { valid: true };
}

// ===== API ROUTER =====
const v1 = express.Router();

v1.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

v1.get('/public-holidays', (req, res) => {
  const year = parseInt(req.query.year, 10);
  if (!year || year < 1900 || year > 2100) {
    return res.status(400).json({ error: 'Geef een geldig jaar op (bijv. ?year=2026)' });
  }
  res.json({ year, holidays: getBelgianPublicHolidays(year) });
});

v1.post('/auth/register', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const insert = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, team_id, main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active, week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [name, email.toLowerCase(), passwordHash, 'medewerker']
    );
    const user = insert.rows[0];
    const token = signToken(user);
    await logAudit(req, 'CREATE', 'user', user.id, { name: user.name, email: user.email, source: 'register' });
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Rate limiting on login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  skip: () => process.env.NODE_ENV === 'test',
  message: { success: false, message: 'Te veel inlogpogingen. Probeer opnieuw over 15 minuten.' },
  standardHeaders: true,
  legacyHeaders: false
});

v1.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    // Try new schema first, fall back to old schema if columns don't exist
    let result;
    try {
      result = await pool.query(
        `SELECT id, name, email, password_hash, role, team_id,
                main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"
         FROM users WHERE LOWER(email) = LOWER($1)`,
        [email.trim()]
      );
    } catch (schemaErr) {
      // Fallback to old schema (before migration)
      console.log('Using old schema for login (migration not yet run)');
      result = await pool.query(
        'SELECT id, name, email, password_hash, role, team_id FROM users WHERE LOWER(email) = LOWER($1)',
        [email.trim()]
      );
    }
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Gedeactiveerde accounts: juist wachtwoord maar geen toegang. Aparte 403
    // zodat de frontend de gebruiker niet ten onrechte "fout wachtwoord" toont.
    if (user.active === false) {
      return res.status(403).json({ error: 'Account is gedeactiveerd' });
    }
    const token = signToken(user);
    delete user.password_hash;
    res.json({ token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== CURRENT USER (ME) API =====

v1.get('/me', requireAuth, async (req, res) => {
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT id, name, email, role, team_id,
                main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules",
                email_notifications_enabled as "emailNotificationsEnabled",
                onboarding_flags as "onboardingFlags",
                ical_feed_token as "icalFeedToken"
         FROM users WHERE id = $1`,
        [req.user.id]
      );
    } catch (schemaErr) {
      // Fallback to old schema
      result = await pool.query(
        'SELECT id, name, email, role, team_id FROM users WHERE id = $1',
        [req.user.id]
      );
    }
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// #196: dit endpoint aanvaardde ook mainTeam, contractHours en het volledige
// basisrooster, zonder enige rolcontrole. Een medewerker kon daarmee zijn eigen
// team en contracturen bepalen, en zijn basisrooster zetten terwijl de
// rollentabel zegt dat hij dat niet mag. Erger nog: main_team werd bijgewerkt
// zonder team_id, en die twee moeten altijd gelijk zijn (CLAUDE.md regel 2),
// anders wijst de app hem in het ene team aan en de autorisatie in het andere.
//
// PUT /users/:id blokkeert diezelfde velden al uitdrukkelijk. Er waren dus twee
// wegen naar hetzelfde veld en maar één ervan was bewaakt.
//
// Dit endpoint gaat nu alleen nog over je eigen profiel: naam, e-mail en
// wachtwoord. Precies wat de profielmodal stuurt. De rest loopt via de
// beheerderspaden, waar team_id en main_team samen worden bijgewerkt.
v1.put('/me', requireAuth, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 12);
    }

    // #154: rotate iCal token when password changes to invalidate leaked feed URLs
    const newIcalToken = password ? crypto.randomUUID() : null;

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           password_hash = COALESCE($3, password_hash),
           ical_feed_token = COALESCE($5, ical_feed_token)
       WHERE id = $4
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [name, email.toLowerCase(), passwordHash, req.user.id, newIcalToken]
    );
    await logAudit(req, 'UPDATE', 'user', req.user.id, { action: 'self_update', name, email });
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== EMAIL PREFERENCES =====

v1.put('/me/email-preferences', requireAuth, async (req, res) => {
  const { emailNotificationsEnabled } = req.body || {};
  if (typeof emailNotificationsEnabled !== 'boolean') {
    return res.status(400).json({ error: 'emailNotificationsEnabled (boolean) is verplicht' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET email_notifications_enabled = $1 WHERE id = $2
       RETURNING email_notifications_enabled as "emailNotificationsEnabled"`,
      [emailNotificationsEnabled, req.user.id]
    );
    await logAudit(req, 'UPDATE', 'user', req.user.id, { action: 'email_preferences', emailNotificationsEnabled });
    res.json({ emailNotificationsEnabled: result.rows[0].emailNotificationsEnabled });
  } catch (err) {
    console.error('PUT /me/email-preferences error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /me/ical-token - Genereer of reset persoonlijke iCal feed token
v1.post('/me/ical-token', requireAuth, async (req, res) => {
  try {
    const token = crypto.randomUUID();
    await pool.query('UPDATE users SET ical_feed_token = $1 WHERE id = $2', [token, req.user.id]);
    await logAudit(req, 'UPDATE', 'user', req.user.id, { action: 'ical_token_reset' });
    res.json({ token });
  } catch (err) {
    console.error('POST /me/ical-token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /calendar/:token.ics - Publieke iCal feed (token = auth)
v1.get('/calendar/:token.ics', async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, name FROM users WHERE ical_feed_token = $1 AND active = true`,
      [req.params.token]
    );
    if (!userResult.rows.length) return res.status(404).send('Not found');
    const user = userResult.rows[0];

    const from = new Date(); from.setDate(from.getDate() - 30);
    const to   = new Date(); to.setDate(to.getDate() + 365);
    const [shiftsResult, teamsSettingResult] = await Promise.all([
      pool.query(
        `SELECT s.id, s.date::text, s.start_time, s.end_time, s.team, s.notes,
                t.name as team_name
         FROM shifts s
         LEFT JOIN teams t ON t.id = s.team
         WHERE s.user_id = $1 AND s.date >= $2 AND s.date <= $3
         ORDER BY s.date, s.start_time`,
        [user.id, formatDateYYYYMMDD(from), formatDateYYYYMMDD(to)]
      ),
      pool.query(`SELECT value FROM settings WHERE key = 'teams'`)
    ]);
    // settings.teams is the primary display name source (may differ from teams table)
    const teamNameMap = teamsSettingResult.rows.length ? teamsSettingResult.rows[0].value : {};

    const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

    const events = shiftsResult.rows.map(s => {
      const dateStr = s.date.slice(0, 10);
      const start = formatICalDateTime(dateStr, s.start_time);
      let endDate = dateStr;
      if (s.end_time <= s.start_time) {
        const d = new Date(dateStr); d.setDate(d.getDate() + 1);
        endDate = formatDateYYYYMMDD(d);
      }
      const end = formatICalDateTime(endDate, s.end_time);
      const summary = icalEscape((teamNameMap[s.team] && teamNameMap[s.team].name) || s.team_name || s.team || 'Shift');
      const lines = [
        'BEGIN:VEVENT',
        `UID:shift-${s.id}@hetvlot`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=Europe/Brussels:${start}`,
        `DTEND;TZID=Europe/Brussels:${end}`,
        `SUMMARY:${summary}`,
      ];
      if (s.notes) lines.push(`DESCRIPTION:${icalEscape(s.notes)}`);
      lines.push('END:VEVENT');
      return lines.join('\r\n');
    }).join('\r\n');

    const ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Het Vlot//Roosterplanning//NL',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Rooster ${icalEscape(user.name)}`,
      'X-WR-TIMEZONE:Europe/Brussels',
      BRUSSELS_VTIMEZONE,
      events,
      'END:VCALENDAR',
    ].join('\r\n');

    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(ical);
  } catch (err) {
    console.error('GET /calendar/:token.ics error:', err);
    res.status(500).send('Server error');
  }
});

function icalEscape(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// VTIMEZONE-component voor Europe/Brussels (CET/CEST). Nodig zodat Outlook de
// wall-clock tijd correct interpreteert i.p.v. de niet-officiële X-WR-TIMEZONE
// te negeren en de kale tijd als UTC te lezen (zie issue #172).
const BRUSSELS_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Brussels',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

// PUT /me/onboarding-flags - Update onboarding flags (merge)
v1.put('/me/onboarding-flags', requireAuth, async (req, res) => {
  const flags = req.body;
  if (!flags || typeof flags !== 'object') {
    return res.status(400).json({ error: 'Body moet een object zijn met flags' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET onboarding_flags = COALESCE(onboarding_flags, '{}'::jsonb) || $1::jsonb WHERE id = $2
       RETURNING onboarding_flags as "onboardingFlags"`,
      [JSON.stringify(flags), req.user.id]
    );
    res.json({ onboardingFlags: result.rows[0].onboardingFlags });
  } catch (err) {
    console.error('PUT /me/onboarding-flags error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== TEAMS API =====

v1.get('/teams', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, color FROM teams ORDER BY name'
    );
    res.json({ teams: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/teams', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id, name, color } = req.body;

  if (!id || !name || !color) {
    return res.status(400).json({ error: 'id, name en color zijn verplicht' });
  }

  if (!/^[a-z0-9_]+$/.test(id)) {
    return res.status(400).json({ error: 'Team ID mag alleen lowercase letters, cijfers en underscores bevatten' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO teams (id, name, color) VALUES ($1, $2, $3) RETURNING *',
      [id, name, color]
    );

    await logAudit(req, 'CREATE', 'settings', id, { action: 'create_team', name, color });
    res.status(201).json({ team: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Een team met dit ID bestaat al' });
    }
    console.error('POST /teams error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.put('/teams/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  const { name, color } = req.body;

  if (!name && !color) {
    return res.status(400).json({ error: 'name of color is verplicht' });
  }

  try {
    const existing = await pool.query('SELECT * FROM teams WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Team niet gevonden' });
    }

    const newName = name || existing.rows[0].name;
    const newColor = color || existing.rows[0].color;

    const result = await pool.query(
      'UPDATE teams SET name = $1, color = $2 WHERE id = $3 RETURNING *',
      [newName, newColor, id]
    );

    await logAudit(req, 'UPDATE', 'settings', id, { action: 'update_team', name: newName, color: newColor });
    res.json({ team: result.rows[0] });
  } catch (err) {
    console.error('PUT /teams/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.delete('/teams/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;

  try {
    // Check if team has users assigned
    const usersWithTeam = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE team_id = $1 OR main_team = $1', [id]
    );
    if (parseInt(usersWithTeam.rows[0].count) > 0) {
      return res.status(409).json({ error: `Team heeft nog ${usersWithTeam.rows[0].count} medewerker(s). Verplaats ze eerst naar een ander team.` });
    }

    const result = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team niet gevonden' });
    }

    await logAudit(req, 'DELETE', 'settings', id, { action: 'delete_team', name: result.rows[0].name });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /teams/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== USERS API (replaces employees) =====

// Get all users (with schedule data) - for planning views
v1.get('/users', requireAuth, async (req, res) => {
  try {
    const { role, team_id } = req.user;

    // Try new schema, fallback to old
    let result;
    try {
      // Everyone can see all users (visibility is universal)
      // Edit permissions differ by role (handled separately in POST/PUT/DELETE endpoints)
      let query = `
        SELECT id, name, email, role, team_id,
               main_team as "mainTeam", extra_teams as "extraTeams",
               contract_hours as "contractHours", active,
               week_schedule_week1 as "weekScheduleWeek1",
               week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules",
               created_at as "createdAt"
        FROM users
        ORDER BY name
      `;
      result = await pool.query(query);
    } catch (schemaErr) {
      // Fallback to old schema
      console.log('Using old schema for /users');
      // Everyone sees all users (no role-based filtering)
      let query = 'SELECT id, name, email, role, team_id, created_at as "createdAt" FROM users ORDER BY name';
      result = await pool.query(query);
    }

    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get single user
v1.get('/users/:id', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, team_id,
              main_team as "mainTeam", extra_teams as "extraTeams",
              contract_hours as "contractHours", active,
              week_schedule_week1 as "weekScheduleWeek1",
              week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules",
              created_at as "createdAt"
       FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ADMIN USER MANAGEMENT =====

v1.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, team_id,
              main_team as "mainTeam", extra_teams as "extraTeams",
              contract_hours as "contractHours", active,
              week_schedule_week1 as "weekScheduleWeek1",
              week_schedule_week2 as "weekScheduleWeek2",
              week_schedules as "weekSchedules",
              email_notifications_enabled as "emailNotificationsEnabled"
       FROM users ORDER BY name`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new user (with optional schedule data)
v1.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role, team_id, mainTeam, contractHours, active, weekScheduleWeek1, weekScheduleWeek2, weekSchedules } = req.body || {};
  if (!name || !role) {
    return res.status(400).json({ error: 'Naam en rol zijn verplicht' });
  }
  try {
    // Check if email already exists (only when email is provided)
    const normalizedEmail = email ? email.trim().toLowerCase() : null;
    if (normalizedEmail) {
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Email bestaat al' });
      }
    }

    // Gebruik opgegeven wachtwoord of val terug op DEFAULT_RESET_PASSWORD
    const userPassword = (password && password.trim()) ? password : DEFAULT_RESET_PASSWORD;
    const passwordHash = await bcrypt.hash(userPassword, 12);
    const week1Json = JSON.stringify(weekScheduleWeek1 || []);
    const week2Json = JSON.stringify(weekScheduleWeek2 || []);
    const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
      ? JSON.stringify(weekSchedules)
      : JSON.stringify([weekScheduleWeek1 || [], weekScheduleWeek2 || []]);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, team_id, main_team, contract_hours, active, week_schedule_week1, week_schedule_week2, week_schedules)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [
        name,
        normalizedEmail,
        passwordHash,
        role,
        team_id || mainTeam || null,
        mainTeam || null,
        contractHours || 0,
        active !== false,
        week1Json,
        week2Json,
        weekSchedulesJson
      ]
    );
    await logAudit(req, 'CREATE', 'user', result.rows[0].id, { user: { name, email: normalizedEmail, role, mainTeam } });

    // Welkomst-email alleen als er een email is (fire-and-forget)
    if (normalizedEmail) {
      emailService.notifyWelcome({ name, email: normalizedEmail });
    }

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (role, team, and schedule data)
v1.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const { role, team_id, name, email, mainTeam, contractHours, active, weekScheduleWeek1, weekScheduleWeek2, weekSchedules, emailNotificationsEnabled } = req.body || {};
  if (!userId || !role) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    const week1Json = weekScheduleWeek1 !== undefined ? JSON.stringify(weekScheduleWeek1) : null;
    const week2Json = weekScheduleWeek2 !== undefined ? JSON.stringify(weekScheduleWeek2) : null;
    const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
      ? JSON.stringify(weekSchedules)
      : null;

    // Get old email before updating (for syncing with employees table)
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

    const result = await pool.query(
      `UPDATE users
       SET role = $1,
           team_id = COALESCE($2, team_id),
           name = COALESCE($3, name),
           email = COALESCE($4, email),
           main_team = COALESCE($5, main_team),
           contract_hours = COALESCE($6, contract_hours),
           active = COALESCE($7, active),
           week_schedule_week1 = COALESCE($8::jsonb, week_schedule_week1),
           week_schedule_week2 = COALESCE($9::jsonb, week_schedule_week2),
           week_schedules = COALESCE($10::jsonb, jsonb_build_array(
             COALESCE($8::jsonb, week_schedule_week1),
             COALESCE($9::jsonb, week_schedule_week2)
           )),
           email_notifications_enabled = COALESCE($12, email_notifications_enabled)
       WHERE id = $11
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                 week_schedules as "weekSchedules",
                 email_notifications_enabled as "emailNotificationsEnabled"`,
      [
        role,
        team_id || mainTeam || null,
        name,
        email ? email.toLowerCase() : null,
        mainTeam,
        contractHours,
        active,
        week1Json,
        week2Json,
        weekSchedulesJson,
        userId,
        typeof emailNotificationsEnabled === 'boolean' ? emailNotificationsEnabled : null
      ]
    );

    await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });

    // Welkomst-email als email voor het eerst wordt ingesteld (fire-and-forget)
    const newEmail = email ? email.toLowerCase() : null;
    if (!oldEmail && newEmail) {
      emailService.notifyWelcome({ name: result.rows[0].name, email: newEmail });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user schedule data (for non-admin users who can edit employee profiles)
v1.put('/users/:id', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const { name, email, mainTeam, contractHours, active, weekScheduleWeek1, weekScheduleWeek2, weekSchedules } = req.body || {};

  // Permission check: admin/roosterverantwoordelijke can edit anyone,
  // medewerker can only edit themselves
  const { role, team_id } = req.user;

  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen profiel bewerken' });
  }

  // Medewerker cannot modify base schedule fields
  if (role === 'medewerker' && (weekScheduleWeek1 !== undefined || weekScheduleWeek2 !== undefined || weekSchedules !== undefined)) {
    return res.status(403).json({ error: 'Medewerkers kunnen hun basisrooster niet aanpassen. Neem contact op met je roosterverantwoordelijke.' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Naam is verplicht' });
  }

  // Medewerker can only update name and email
  if (role === 'medewerker') {
    try {
      const oldMedResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      const oldMedEmail = oldMedResult.rows.length > 0 ? oldMedResult.rows[0].email : null;
      const result = await pool.query(
        `UPDATE users SET name = $1, email = $2 WHERE id = $3
         RETURNING id, name, email, role, team_id,
                   main_team as "mainTeam", extra_teams as "extraTeams",
                   contract_hours as "contractHours", active,
                   week_schedule_week1 as "weekScheduleWeek1",
                   week_schedule_week2 as "weekScheduleWeek2",
                   week_schedules as "weekSchedules"`,
        [name, email ? email.trim().toLowerCase() : null, userId]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Gebruiker niet gevonden' });
      }
      await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });
      const newMedEmail = email ? email.trim().toLowerCase() : null;
      if (!oldMedEmail && newMedEmail) {
        emailService.notifyWelcome({ name: result.rows[0].name, email: newMedEmail });
      }
      return res.json({ user: result.rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }

  try {
    const week1Json = JSON.stringify(weekScheduleWeek1 || []);
    const week2Json = JSON.stringify(weekScheduleWeek2 || []);
    // Use weekSchedules directly if provided (for cycles > 2 weeks), otherwise build from week1/week2
    const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
      ? JSON.stringify(weekSchedules)
      : JSON.stringify([weekScheduleWeek1 || [], weekScheduleWeek2 || []]);

    // Get old email before updating
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

    // Only admins may change email; roosterverantwoordelijke cannot
    const newEmail = role === 'admin' && email ? email.trim().toLowerCase() : oldEmail;

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           main_team = $3,
           team_id = $3,
           contract_hours = $4,
           active = $5,
           week_schedule_week1 = $6::jsonb,
           week_schedule_week2 = $7::jsonb,
           week_schedules = $8::jsonb
       WHERE id = $9
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [name, newEmail, mainTeam || null, contractHours || 0, active !== false, week1Json, week2Json, weekSchedulesJson, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }

    await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });

    // Welkomst-email als email voor het eerst wordt ingesteld (fire-and-forget, admin only)
    if (!oldEmail && newEmail) {
      emailService.notifyWelcome({ name: result.rows[0].name, email: newEmail });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only) — explicit transaction with FOR UPDATE lock
v1.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  // Don't allow deleting the currently logged in admin
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deletedUser = await client.query('SELECT name, email, role FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (deletedUser.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    // Anonymize audit log before deleting — GDPR: actor_name stays queryable but
    // is no longer personal data. Must run before DELETE triggers SET NULL on actor_id.
    await client.query(
      `UPDATE audit_log SET actor_name = 'Verwijderde gebruiker' WHERE actor_id = $1`,
      [userId]
    );
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    await logAudit(req, 'DELETE', 'user', userId, { user: deletedUser.rows[0] });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  if (!userId) {
    return res.status(400).json({ error: 'Missing user id' });
  }
  try {
    const passwordHash = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12);
    await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [passwordHash, userId]
    );
    await logAudit(req, 'UPDATE', 'user', userId, { action: 'password_reset' });
    // Send password reset email (fire-and-forget)
    const userResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [userId]);
    const targetUser = userResult.rows[0];
    const hasEmail = !!(targetUser?.email);
    if (hasEmail) {
      emailService.notifyPasswordReset(targetUser);
    }
    // Only expose the new password when there is no email address — the admin
    // must hand it over manually. When an email exists, the user receives it
    // via email and we never include it in the API response.
    res.json({ ok: true, ...(hasEmail ? {} : { newPassword: DEFAULT_RESET_PASSWORD }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== REPLACE EMPLOYEE =====

// Hernoemt een medewerker-ID in een concept-grid van old → new, zónder de
// dag-van-de-week-indexen (0-6) aan te raken. Vervangt de oude naïeve
// tekstvervanging die elke dagindex met datzelfde nummer corrumpeerde (#141).
// Ondersteunt beide layouts:
//   single-week : { "<empId>": { "0": {...}, "3": {...} }, _pattern: ... }
//   multi-week  : { _multiWeek: true, "1": { "<empId>": {...} }, ... }
function remapDraftGridUser(grid, oldId, newId) {
  if (!grid || typeof grid !== 'object') return { grid, changed: false };
  const oldKey = String(oldId);
  const newKey = String(newId);
  let changed = false;

  // Hernoemt de medewerker-sleutel binnen één employee-laag. Bij een conflict
  // (newKey bestaat al) mergen we per dag, waarbij de overgedragen (oude)
  // toewijzingen winnen.
  const remapEmployeeLayer = (layer) => {
    if (!layer || typeof layer !== 'object' || !(oldKey in layer)) return layer;
    const out = { ...layer };
    const moved = out[oldKey];
    delete out[oldKey];
    out[newKey] = (out[newKey] && typeof out[newKey] === 'object' && moved && typeof moved === 'object')
      ? { ...out[newKey], ...moved }
      : moved;
    changed = true;
    return out;
  };

  if (grid._multiWeek) {
    const out = {};
    for (const [key, val] of Object.entries(grid)) {
      out[key] = key.startsWith('_') ? val : remapEmployeeLayer(val);
    }
    return { grid: out, changed };
  }
  return { grid: remapEmployeeLayer(grid), changed };
}

v1.post('/admin/users/:id/replace', requireAuth, requireAdmin, async (req, res) => {
  const oldUserId = Number(req.params.id);
  const { replacementUserId, transferShiftsFrom } = req.body;
  const newUserId = Number(replacementUserId);

  if (!oldUserId || !newUserId) {
    return res.status(400).json({ error: 'Oud en nieuw gebruiker ID zijn verplicht' });
  }
  if (oldUserId === newUserId) {
    return res.status(400).json({ error: 'Oud en nieuw gebruiker mogen niet dezelfde zijn' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock both users to prevent race conditions
    const oldUserResult = await client.query(
      `SELECT id, name, main_team, team_id, extra_teams, contract_hours,
              week_schedules, week_schedule_week1, week_schedule_week2
       FROM users WHERE id = $1 FOR UPDATE`,
      [oldUserId]
    );
    const newUserResult = await client.query(
      `SELECT id, name, active FROM users WHERE id = $1 FOR UPDATE`,
      [newUserId]
    );

    if (oldUserResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Vertrekkende medewerker niet gevonden' });
    }
    if (newUserResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Nieuwe medewerker niet gevonden' });
    }

    const oldUser = oldUserResult.rows[0];
    const newUser = newUserResult.rows[0];

    // 1. Copy week_schedules from old to new
    await client.query(
      `UPDATE users SET
        week_schedules = $1,
        week_schedule_week1 = $2,
        week_schedule_week2 = $3
       WHERE id = $4`,
      [
        JSON.stringify(oldUser.week_schedules),
        JSON.stringify(oldUser.week_schedule_week1),
        JSON.stringify(oldUser.week_schedule_week2),
        newUserId
      ]
    );

    // 2. Optionally transfer future shifts
    let shiftsTransferred = 0;
    if (transferShiftsFrom) {
      const transferResult = await client.query(
        `UPDATE shifts SET user_id = $1 WHERE user_id = $2 AND date >= $3`,
        [newUserId, oldUserId, transferShiftsFrom]
      );
      shiftsTransferred = transferResult.rowCount;

      // Also transfer shift_blocks for transferred dates
      await client.query(
        `UPDATE shift_blocks sb SET user_id = $1
         WHERE sb.user_id = $2 AND sb.date >= $3
         AND NOT EXISTS (SELECT 1 FROM shift_blocks sb2 WHERE sb2.user_id = $1 AND sb2.date = sb.date)`,
        [newUserId, oldUserId, transferShiftsFrom]
      );

      // Transfer activities for transferred dates
      await client.query(
        `UPDATE shift_activities SET user_id = $1 WHERE user_id = $2 AND date >= $3`,
        [newUserId, oldUserId, transferShiftsFrom]
      );
    }

    // 3. Deactivate old user
    await client.query(
      `UPDATE users SET active = false WHERE id = $1`,
      [oldUserId]
    );

    // 4. Update schedule_drafts: vervang oud medewerker-ID door nieuw in het grid.
    //    We parsen het grid in code en hernoemen enkel de medewerker-sleutels,
    //    zodat dag-van-de-week-indexen niet per ongeluk meeveranderen (#141).
    const draftsResult = await client.query(
      `SELECT id, grid FROM schedule_drafts WHERE grid::text LIKE $1 FOR UPDATE`,
      ['%"' + String(oldUserId) + '"%']
    );
    let draftsUpdated = 0;
    for (const row of draftsResult.rows) {
      const { grid: newGrid, changed } = remapDraftGridUser(row.grid, oldUserId, newUserId);
      if (changed) {
        await client.query(
          `UPDATE schedule_drafts SET grid = $1::jsonb, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(newGrid), row.id]
        );
        draftsUpdated++;
      }
    }

    // 5. No auto-regeneration — user should re-apply active concept via Rooster Bouwen

    await client.query('COMMIT');

    await logAudit(req, 'REPLACE', 'user', oldUserId, {
      oldUser: { id: oldUserId, name: oldUser.name },
      newUser: { id: newUserId, name: newUser.name },
      shiftsTransferred,
      draftsUpdated,
      transferFrom: transferShiftsFrom || null,
      scheduleCopied: true
    });

    res.json({
      ok: true,
      oldUser: { id: oldUserId, name: oldUser.name },
      newUser: { id: newUserId, name: newUser.name },
      shiftsTransferred,
      draftsUpdated,
      shiftsGenerated: 0,
      hint: transferShiftsFrom ? null : 'apply_concept'
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Replace user error:', err);
    res.status(500).json({ error: 'Server error bij vervanging' });
  } finally {
    client.release();
  }
});

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

// ===== SHIFTS API =====

v1.get('/shifts', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  const params = [];
  let where = 'WHERE archived = false';
  if (startDate && endDate) {
    where += ' AND date >= $1 AND date <= $2';
    params.push(startDate, endDate);
  }
  const query = `
    SELECT id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
           end_time as "endTime", notes, source, is_reserve as "isReserve", created_at as "createdAt"
    FROM shifts ${where} ORDER BY date, start_time
  `;

  try {
    const result = await pool.query(query, params);
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error('GET /shifts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/shifts', requireAuth, async (req, res) => {
  const { userId, team, date, startTime, endTime, notes, source, isReserve, force } = req.body || {};
  if (!userId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }
  if (!isValidTime(startTime) || !isValidTime(endTime)) {
    return res.status(400).json({ error: 'Tijdstip moet HH:MM zijn' });
  }

  // Permission check: medewerker can only create shifts for themselves
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker' && Number(userId) !== currentUserId) {
    return res.status(403).json({ error: 'Je kunt alleen diensten voor jezelf aanmaken' });
  }

  // source defaults to 'manual' if not specified
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  try {
    // Check if the date is manually closed
    const closedDatesResult = await pool.query("SELECT value FROM settings WHERE key = 'closedDates'");
    const closedDates = (closedDatesResult.rows[0]?.value || []).map(d => d.date);
    if (closedDates.includes(date)) {
      return res.status(400).json({ error: 'Deze dag is manueel gesloten' });
    }

    // Valideer 11-uur regel en overlap (force=true slaat enkel rusttijd over, niet overlap)
    const validation = await validateShiftRules(pool, userId, { date, start_time: startTime, end_time: endTime }, null, !!force);
    if (!validation.valid) return res.status(422).json({ error: validation.message });

    // Insert the new shift
    const result = await pool.query(`
      INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source, is_reserve)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, is_reserve as "isReserve", created_at as "createdAt"
    `, [userId, team || null, date, startTime, endTime, notes || '', shiftSource, isReserve ? true : false]);

    const newShift = result.rows[0];

    // Remove shift block ONLY if a MANUAL shift is created (manual overrides the block)
    // Auto shifts should NOT remove blocks (they should respect blocks and not be created at all)
    if (shiftSource === 'manual') {
      await pool.query(
        'DELETE FROM shift_blocks WHERE user_id = $1 AND date = $2',
        [userId, date]
      );
    }

    await logAudit(req, 'CREATE', 'shift', newShift.id, { shift: newShift });
    res.status(201).json({ shift: newShift });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.put('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { userId, team, date, startTime, endTime, notes, source, isReserve, force } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }
  if ((startTime !== undefined && !isValidTime(startTime)) || (endTime !== undefined && !isValidTime(endTime))) {
    return res.status(400).json({ error: 'Tijdstip moet HH:MM zijn' });
  }

  const { role, id: currentUserId } = req.user;

  // When editing, automatically set source to 'manual' to protect from auto-regeneration
  // Unless explicitly setting to 'auto' (for reset-to-base functionality)
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  try {
    const oldResult = await pool.query(
      `SELECT id, user_id as "userId", team, date::text as date, start_time as "startTime", end_time as "endTime", notes, source FROM shifts WHERE id = $1`,
      [id]
    );
    const oldShift = oldResult.rows[0] || null;

    // Permission check: medewerker can only edit own shifts.
    //
    // #215: deze controle stond hiervoor VÓÓR de try, met een eigen
    // pool.query. Ging de database onderuit, dan verliet die afwijzing de
    // handler onafgehandeld en nam Node het proces mee. Nu staat hij binnen de
    // try, en gebruikt hij de dienst die hier toch al opgehaald wordt, dus het
    // scheelt ook een query.
    //
    // #262: een medewerker mag zijn eigen dienst bewerken, maar hem niet naar
    // een ander team of naar een andere collega verplaatsen. Het teamveld bleef
    // in de modal bewerkbaar en de UPDATE hieronder liet zowel team als user_id
    // ongecontroleerd door, dus iemand kon zichzelf in een ander team schrijven
    // of zijn dienst aan een collega toewijzen. Daar bestaat 'Dienst afstaan'
    // voor, met een verzoek dat de ander kan aanvaarden.
    if (role === 'medewerker' && oldShift) {
      if (oldShift.userId !== currentUserId) {
        return res.status(403).json({ error: 'Je kunt alleen je eigen diensten bewerken' });
      }
      if (team !== undefined && team !== null && team !== oldShift.team) {
        return res.status(403).json({ error: 'Je kunt het team van een dienst niet wijzigen' });
      }
      if (userId !== undefined && userId !== null && Number(userId) !== Number(oldShift.userId)) {
        return res.status(403).json({ error: 'Je kunt een dienst niet aan iemand anders toewijzen. Gebruik daarvoor Dienst afstaan.' });
      }
    }

    // Blokeer verplaatsing naar manueel gesloten datum
    const effectiveDate = date || oldShift?.date;
    if (date && date !== oldShift?.date) {
      const cdResult = await pool.query("SELECT value FROM settings WHERE key = 'closedDates'");
      const closedDates = (cdResult.rows[0]?.value || []).map(d => d.date);
      if (closedDates.includes(date)) {
        return res.status(400).json({ error: 'Deze dag is manueel gesloten' });
      }
    }

    // Valideer 11-uur regel en overlap (force=true slaat enkel rusttijd over, niet overlap)
    const updatedShift = {
      date:       date       || oldShift?.date,
      start_time: startTime  || oldShift?.startTime,
      end_time:   endTime    || oldShift?.endTime
    };
    if (updatedShift.date && updatedShift.start_time && updatedShift.end_time) {
      const targetUserId = userId || oldShift?.userId;
      const validation = await validateShiftRules(pool, targetUserId, updatedShift, id, !!force);
      if (!validation.valid) return res.status(422).json({ error: validation.message });
    }

    const result = await pool.query(`
      UPDATE shifts
      SET user_id = COALESCE($1, user_id),
          team = COALESCE($2, team),
          date = COALESCE($3, date),
          start_time = COALESCE($4, start_time),
          end_time = COALESCE($5, end_time),
          notes = COALESCE($6, notes),
          source = COALESCE($8, source, 'manual'),
          is_reserve = COALESCE($9, is_reserve)
      WHERE id = $7
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, is_reserve as "isReserve", created_at as "createdAt"
    `, [userId, team, date, startTime, endTime, notes, id, shiftSource, isReserve !== undefined ? Boolean(isReserve) : null]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dienst niet gevonden' });
    }
    // Is de dienst verhuisd naar een andere dag of een andere medewerker, dan
    // blijft de oorspronkelijke plek leeg achter. Zonder blokkade vult het
    // concept die bij een volgende toepassing gewoon weer op en staat er
    // opeens dubbele bezetting. Verslepen in de planning loopt via dit
    // endpoint, dus dit dekt drag en drop mee.
    const nieuw = result.rows[0];
    const verhuisd = oldShift && (
      String(oldShift.date) !== String(nieuw.date) ||
      Number(oldShift.userId) !== Number(nieuw.userId)
    );
    let blockedOrigin = false;
    if (verhuisd) {
      blockedOrigin = await blockDayIfEmpty(pool, oldShift.userId, oldShift.date, req.user.id, 'manual_move');
    }

    await logAudit(req, 'UPDATE', 'shift', id, { before: oldShift, after: nieuw, blockedOrigin });
    res.json({ shift: nieuw, blockedOrigin });
  } catch (err) {
    console.error('PUT /shifts/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.delete('/shifts/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get full shift details for permission check (including date for shift_blocks)
    // Cast date to text to avoid timezone conversion issues
    const shiftResult = await client.query(
      'SELECT id, user_id, team, source, date::text as date FROM shifts WHERE id = $1',
      [id]
    );

    if (shiftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];
    const { role, id: userId, team_id: userTeam } = req.user;

    // #184: hier stond `if (shift.source !== 'auto')` om deze hele controle
    // heen. Elke medewerker kon daardoor de auto-dienst van eender welke
    // collega verwijderen, ook uit een ander team. De redenering was dat
    // auto-diensten toch opnieuw worden aangemaakt, maar diezelfde handler
    // maakt hieronder een shift_block aan dat precies dat verhindert. De dag
    // bleef dus permanent leeg. De rolcontrole geldt nu voor elke dienst,
    // ongeacht de bron.
    if (role === 'admin' || role === 'roosterverantwoordelijke') {
      // Admin en roosterverantwoordelijke mogen elke dienst verwijderen
    } else if (role === 'medewerker') {
      // Een medewerker mag alleen zijn eigen dienst verwijderen
      if (shift.user_id !== userId) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(403).json({ error: 'Je kunt alleen je eigen diensten verwijderen' });
      }
    } else {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Je hebt geen rechten om diensten te verwijderen' });
    }

    // Delete the shift (CASCADE handles shift_activities with shift_id set)
    await client.query('DELETE FROM shifts WHERE id = $1', [id]);
    await logAudit(req, 'DELETE', 'shift', id, { shift: { id: shift.id, user_id: shift.user_id, team: shift.team, date: shift.date, source: shift.source } });

    // Een manuele verwijdering is een bewuste keuze om die cel leeg te laten.
    // We leggen dat vast als shift_block zodat het concept de dag bij een
    // volgende toepassing NIET opnieuw vult (#146, lek 2 — de stille killer).
    // Systeemopkuis (bv. auto-shifts wissen vóór her-toepassen) geeft
    // skipBlock=true mee en slaat dit over.
    const skipBlock = req.query.skipBlock === 'true';
    if (!skipBlock) {
      await client.query(
        `INSERT INTO shift_blocks (user_id, date, created_by, reason)
         VALUES ($1, $2::date, $3, 'manual_delete')
         ON CONFLICT (user_id, date) DO NOTHING`,
        [shift.user_id, shift.date, userId]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR in DELETE /shifts/:id:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Bulk delete shifts in date range
// Only supervisors can do bulk delete
v1.delete('/shifts', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate en endDate zijn verplicht' });
  }
  try {
    const result = await pool.query(
      'DELETE FROM shifts WHERE date >= $1 AND date <= $2',
      [startDate, endDate]
    );
    await logAudit(req, 'DELETE', 'shift', '', { action: 'bulk_delete', startDate, endDate, deletedCount: result.rowCount });
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk create shifts (for schedule builder)
v1.post('/shifts/bulk', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { shifts: shiftsToCreate, overwriteExisting } = req.body || {};

  if (!Array.isArray(shiftsToCreate) || shiftsToCreate.length === 0) {
    return res.status(400).json({ error: 'shifts array is verplicht' });
  }

  if (shiftsToCreate.length > 200) {
    return res.status(400).json({ error: 'Maximum 200 shifts per keer' });
  }

  const { role, team_id: userTeam } = req.user;

  // Role check already handled by requireRole middleware

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load closed dates once for the whole bulk operation
    const cdResult = await client.query("SELECT value FROM settings WHERE key = 'closedDates'");
    const closedDates = new Set((cdResult.rows[0]?.value || []).map(d => d.date));

    const createdShifts = [];
    const skipped = [];

    if (overwriteExisting) {
      // Delete existing shifts for each unique user_id + date pair
      const pairSet = new Set(shiftsToCreate.map(s => `${s.userId}|${s.date}`));
      for (const pair of pairSet) {
        const [userId, date] = pair.split('|');
        await client.query('DELETE FROM shifts WHERE user_id = $1 AND date = $2', [userId, date]);
      }
    }

    for (const shift of shiftsToCreate) {
      if (!shift.userId || !shift.date || !shift.startTime || !shift.endTime) continue;

      // Skip manually closed dates
      if (closedDates.has(shift.date)) {
        skipped.push({ date: shift.date, reason: 'closed' });
        continue;
      }

      // Validate 11-hour rule and overlap
      const validation = await validateShiftRules(client, shift.userId, {
        date: shift.date, start_time: shift.startTime, end_time: shift.endTime
      });
      if (!validation.valid) {
        skipped.push({ date: shift.date, userId: shift.userId, reason: validation.message });
        continue;
      }

      const result = await client.query(`
        INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source)
        VALUES ($1, $2, $3, $4, $5, $6, 'manual')
        RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as date,
                  start_time as "startTime", end_time as "endTime", notes, source, created_at as "createdAt"
      `, [shift.userId, shift.team || null, shift.date, shift.startTime, shift.endTime, shift.notes || '']);

      createdShifts.push(result.rows[0]);

      // Remove shift block (manual shift overrides blocks)
      await client.query('DELETE FROM shift_blocks WHERE user_id = $1 AND date = $2', [shift.userId, shift.date]);
    }

    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'shift', '', { action: 'bulk_create', count: createdShifts.length, skipped: skipped.length, overwriteExisting: !!overwriteExisting });
    res.status(201).json({ shifts: createdShifts, count: createdShifts.length, skipped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /shifts/bulk error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== SHIFT ACTIVITIES API =====

v1.get('/shift-activities', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  const buildActivitiesQuery = (withShiftId) => {
    const shiftIdCol = withShiftId ? 'shift_id as "shiftId"' : 'NULL as "shiftId"';
    const params = [];
    let q = `SELECT id, user_id as "userId", ${shiftIdCol}, date::text as "date", start_time as "startTime",
             end_time as "endTime", type, description, created_at as "createdAt"
             FROM shift_activities`;
    if (startDate && endDate) {
      q += ' WHERE date >= $1 AND date <= $2';
      params.push(startDate, endDate);
    }
    q += ' ORDER BY date, start_time';
    return { query: q, params };
  };

  try {
    const { query, params } = buildActivitiesQuery(true);
    const result = await pool.query(query, params);
    res.json({ activities: result.rows });
  } catch (err) {
    if (err.code === '42703') {
      // shift_id kolom bestaat nog niet — fallback zonder shift_id
      try {
        const { query, params } = buildActivitiesQuery(false);
        const result = await pool.query(query, params);
        return res.json({ activities: result.rows });
      } catch (err2) {
        console.error('GET /shift-activities error (fallback):', err2);
        return res.status(500).json({ error: 'Server error' });
      }
    }
    console.error('GET /shift-activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/shift-activities', requireAuth, async (req, res) => {
  const { userId, shiftId, date, startTime, endTime, type, description } = req.body || {};
  if (!userId || !date || !startTime || !endTime || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken (userId, date, startTime, endTime, type)' });
  }

  // Permission check: medewerker can only create for themselves
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker' && Number(userId) !== currentUserId) {
    return res.status(403).json({ error: 'Je kunt alleen activiteiten voor jezelf aanmaken' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO shift_activities (user_id, shift_id, date, start_time, end_time, type, description)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id as "userId", shift_id as "shiftId", date::text as "date", start_time as "startTime",
                end_time as "endTime", type, description, created_at as "createdAt"
    `, [userId, shiftId || null, date, startTime, endTime, type, description || '']);

    await logAudit(req, 'CREATE', 'shift_activity', result.rows[0].id, { activity: result.rows[0] });
    res.status(201).json({ activity: result.rows[0] });
  } catch (err) {
    console.error('POST /shift-activities error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

v1.put('/shift-activities/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { startTime, endTime, type, description } = req.body || {};

  const { role, id: currentUserId } = req.user;

  try {
    // Permission check: medewerker can only edit own activities.
    // #215: stond hiervoor buiten de try, waardoor een databasestoring hier
    // een onafgehandelde afwijzing opleverde en het proces meenam.
    if (role === 'medewerker') {
      const existing = await pool.query('SELECT user_id FROM shift_activities WHERE id = $1', [id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
        return res.status(403).json({ error: 'Je kunt alleen je eigen activiteiten bewerken' });
      }
    }

    const result = await pool.query(`
      UPDATE shift_activities
      SET start_time = COALESCE($1, start_time),
          end_time = COALESCE($2, end_time),
          type = COALESCE($3, type),
          description = COALESCE($4, description)
      WHERE id = $5
      RETURNING id, user_id as "userId", date::text as "date", start_time as "startTime",
                end_time as "endTime", type, description, created_at as "createdAt"
    `, [startTime, endTime, type, description, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activiteit niet gevonden' });
    }
    await logAudit(req, 'UPDATE', 'shift_activity', id, { activity: result.rows[0] });
    res.json({ activity: result.rows[0] });
  } catch (err) {
    console.error('PUT /shift-activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.delete('/shift-activities/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);

  const { role, id: currentUserId } = req.user;

  try {
    // Permission check: medewerker can only delete own activities.
    // #215: zie de PUT hierboven, zelfde reden.
    if (role === 'medewerker') {
      const existing = await pool.query('SELECT user_id FROM shift_activities WHERE id = $1', [id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
        return res.status(403).json({ error: 'Je kunt alleen je eigen activiteiten verwijderen' });
      }
    }

    const result = await pool.query('DELETE FROM shift_activities WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Activiteit niet gevonden' });
    }
    await logAudit(req, 'DELETE', 'shift_activity', id, {});
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /shift-activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== AVAILABILITY API =====

v1.get('/availability', requireAuth, async (req, res) => {
  const { startDate, endDate, userId } = req.query;
  try {
    let query = `
      SELECT id, user_id as "userId", date::text as date, type, reason, updated_at as "updatedAt"
      FROM availability
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (startDate && endDate) {
      query += ` AND date >= $${paramIndex} AND date <= $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }
    if (userId) {
      query += ` AND user_id = $${paramIndex}`;
      params.push(userId);
    }
    query += ' ORDER BY date';

    const result = await pool.query(query, params);
    res.json({ availability: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/availability', requireAuth, async (req, res) => {
  const { userId, date, type, reason } = req.body || {};
  if (!userId || !date || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
  }

  // Permission check for availability (skip team check if main_team column doesn't exist)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid registreren' });
  }


  try {
    // #203: dit is een upsert op (gebruiker, datum), dus een bestaande
    // registratie werd stilzwijgend vervangen. Wie ergens 'vrij' stond met
    // reden 'Vaste vrije dag' werd zonder melding 'ziek', het antwoord was
    // 201 Created voor wat in feite een overschrijving was, en de audit log
    // hield alleen de nieuwe waarde bij. Achteraf was dus niet meer na te gaan
    // wat er stond. Eén afwezigheid per persoon per dag blijft de regel, maar
    // de vervanging moet zichtbaar zijn en een spoor nalaten.
    //
    // De CTE leest de oude rij op de snapshot van vóór de insert, dus dit
    // blijft één atomaire opdracht.
    const result = await pool.query(`
      WITH vorige AS (
        SELECT type, reason FROM availability WHERE user_id = $1 AND date = $2::date
      )
      INSERT INTO availability (user_id, date, type, reason, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, date)
      DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
      RETURNING id, user_id as "userId", date::text as date, type, reason, updated_at as "updatedAt",
                (SELECT type FROM vorige) as "previousType",
                (SELECT reason FROM vorige) as "previousReason"
    `, [userId, date, type, reason || '']);

    const row = result.rows[0];
    const previousType = row.previousType;
    const wasOverwrite = previousType !== null && previousType !== undefined;
    const previous = wasOverwrite ? { type: previousType, reason: row.previousReason || '' } : null;

    const availability = {
      id: row.id, userId: row.userId, date: row.date,
      type: row.type, reason: row.reason, updatedAt: row.updatedAt
    };

    await logAudit(req, wasOverwrite ? 'UPDATE' : 'CREATE', 'availability', availability.id,
      wasOverwrite ? { availability, previous } : { availability });
    res.status(wasOverwrite ? 200 : 201).json({ availability, previous });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.delete('/availability', requireAuth, async (req, res) => {
  const { userId, date } = req.query;
  if (!userId || !date) {
    return res.status(400).json({ error: 'userId en date zijn verplicht' });
  }

  // Permission check (skip team check if main_team column doesn't exist)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid verwijderen' });
  }

  try {
    await pool.query(
      'DELETE FROM availability WHERE user_id = $1 AND date = $2',
      [userId, date]
    );
    await logAudit(req, 'DELETE', 'availability', '', { userId, date });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== AVAILABILITY BULK WITH TAKEOVER (atomic transaction) =====

v1.post('/availability/sick-with-takeover', requireAuth, async (req, res) => {
  const { userId, startDate, endDate, type, reason, createTakeoverRequests } = req.body || {};

  if (!userId || !startDate || !endDate || !type) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken (userId, startDate, endDate, type)' });
  }

  // Permission check (same logic as POST /availability)
  const { role, team_id } = req.user;
  if (role === 'medewerker' && Number(userId) !== req.user.id) {
    return res.status(403).json({ error: 'Je kunt alleen je eigen beschikbaarheid registreren' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Generate all dates in range
    const dates = [];
    const startParts = startDate.split('-').map(Number);
    const endParts = endDate.split('-').map(Number);
    let current = new Date(startParts[0], startParts[1] - 1, startParts[2]);
    const endObj = new Date(endParts[0], endParts[1] - 1, endParts[2]);

    while (current <= endObj) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(current.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${d}`);
      current.setDate(current.getDate() + 1);
    }

    if (dates.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Geen geldige datums in bereik' });
    }

    // #203: lees eerst wat er al staat, zodat een overschrijving niet
    // spoorloos is. Zie de toelichting bij POST /availability. Dit gebeurt in
    // dezelfde transactie, dus de waarden kloppen met wat er zo meteen
    // vervangen wordt.
    const vorigeResult = await client.query(
      `SELECT date::text as date, type, reason FROM availability
       WHERE user_id = $1 AND date = ANY($2::date[])`,
      [userId, dates]
    );
    const overwritten = vorigeResult.rows.filter(
      r => r.type !== type || (r.reason || '') !== (reason || '')
    );

    // 2. Upsert availability for each date
    const availability = [];
    for (const dateStr of dates) {
      const result = await client.query(`
        INSERT INTO availability (user_id, date, type, reason, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id, date)
        DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
        RETURNING id, user_id as "userId", date::text as date, type, reason
      `, [userId, dateStr, type, reason || '']);
      availability.push(result.rows[0]);
    }

    // 3. Optionally create takeover requests for conflicting shifts
    let takeoverCount = 0;
    let conflictingShiftCount = 0;

    if (createTakeoverRequests) {
      // Find shifts for this user on the affected dates
      const shiftsResult = await client.query(`
        SELECT id, user_id, date::text as date, start_time, end_time, team
        FROM shifts
        WHERE user_id = $1 AND date = ANY($2::date[])
        ORDER BY date, start_time
      `, [userId, dates]);

      conflictingShiftCount = shiftsResult.rows.length;

      // Filter: only create takeover for future shifts
      const now = new Date();
      now.setHours(0, 0, 0, 0);

      for (const shift of shiftsResult.rows) {
        const shiftDate = new Date(shift.date);
        if (shiftDate < now) continue;

        // Check if a pending takeover request already exists for this shift
        const existing = await client.query(
          `SELECT id FROM shift_swap_requests
           WHERE requester_shift_id = $1 AND request_type = 'takeover' AND status = 'pending'`,
          [shift.id]
        );
        if (existing.rows.length > 0) continue;

        const message = type === 'ziek'
          ? 'Ik ben ziek, wie kan mijn shift overnemen?'
          : 'Ik heb verlof, wie kan mijn shift overnemen?';

        await client.query(
          `INSERT INTO shift_swap_requests
           (requester_user_id, requester_shift_id, target_user_id, target_shift_id, request_type, message, status)
           VALUES ($1, $2, NULL, NULL, 'takeover', $3, 'pending')`,
          [userId, shift.id, message]
        );
        takeoverCount++;
      }
    }

    await client.query('COMMIT');

    // Audit log (outside transaction)
    await logAudit(req, overwritten.length > 0 ? 'UPDATE' : 'CREATE', 'availability', '', {
      type: 'bulk_sick_with_takeover',
      userId, startDate, endDate, absenceType: type,
      daysCreated: dates.length,
      takeoverRequestsCreated: takeoverCount,
      conflictingShifts: conflictingShiftCount,
      overwritten
    });

    // Email notification to managers (fire-and-forget)
    if (type === 'ziek') {
      (async () => {
        try {
          const mgrs = await pool.query(
            `SELECT id, name, email, email_notifications_enabled FROM users
             WHERE role IN ('admin', 'roosterverantwoordelijke') AND active = true`
          );
          const emp = await pool.query(
            'SELECT id, name, email FROM users WHERE id = $1', [userId]
          );
          if (emp.rows[0] && mgrs.rows.length > 0) {
            emailService.notifySickLeave(mgrs.rows, emp.rows[0], startDate, endDate, conflictingShiftCount);
          }
        } catch (e) { console.error('Email notification error:', e.message); }
      })();
    }

    res.status(201).json({
      availability,
      takeoverRequests: takeoverCount,
      conflictingShifts: conflictingShiftCount,
      overwritten
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /availability/sick-with-takeover error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== SHIFT BLOCKS API =====

v1.get('/shift-blocks', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sb.id, sb.user_id, sb.date::text as date, sb.created_at, sb.created_by, sb.reason, u.name as created_by_name
      FROM shift_blocks sb
      LEFT JOIN users u ON sb.created_by = u.id
      ORDER BY sb.date DESC, sb.user_id
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching shift blocks:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/shift-blocks', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const { user_id, date, reason } = req.body;

    if (!user_id || !date) {
      return res.status(400).json({ error: 'user_id en date zijn verplicht' });
    }

    // Create shift block (ON CONFLICT DO NOTHING to make it idempotent)
    const result = await pool.query(`
      INSERT INTO shift_blocks (user_id, date, created_by, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, date) DO NOTHING
      RETURNING *
    `, [user_id, date, req.user.id, reason || 'Created via drag & drop']);

    if (result.rows[0]) {
      await logAudit(req, 'CREATE', 'shift_block', result.rows[0].id, { user_id, date, reason });
    }
    res.json(result.rows[0] || { message: 'Block already exists' });
  } catch (err) {
    console.error('Error creating shift block:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk delete shift blocks by date range (for schedule regeneration)
v1.delete('/shift-blocks/range', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const { startDate, endDate, userId } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate en endDate zijn verplicht' });
    }

    let query = 'DELETE FROM shift_blocks WHERE date >= $1::date AND date <= $2::date';
    const params = [startDate, endDate];

    if (userId) {
      query += ' AND user_id = $3';
      params.push(Number(userId));
    }

    const result = await pool.query(query, params);
    await logAudit(req, 'DELETE', 'shift_block', '', { action: 'bulk_delete', startDate, endDate, userId: userId || 'all', count: result.rowCount });
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('Error bulk deleting shift blocks:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.delete('/shift-blocks/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const blockId = parseInt(req.params.id, 10);
    if (!blockId) {
      return res.status(400).json({ error: 'ID is verplicht' });
    }

    await pool.query('DELETE FROM shift_blocks WHERE id = $1', [blockId]);
    await logAudit(req, 'DELETE', 'shift_block', blockId, {});
    res.json({ message: 'Shift block removed successfully' });
  } catch (err) {
    console.error('Error deleting shift block:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SWAP REQUESTS API =====

v1.get('/swap-requests', requireAuth, async (req, res) => {
  const { role, team_id, id: currentUserId } = req.user;

  try {
    // Lazy expiry: auto-expire pending requests where the shift date has passed
    await pool.query(`
      UPDATE shift_swap_requests sr
      SET status = 'expired', responded_at = NOW()
      FROM shifts s
      WHERE sr.requester_shift_id = s.id
        AND sr.status IN ('pending')
        AND s.date < CURRENT_DATE
    `);

    let query;
    let params = [];

    // Role-based filtering
    if (['admin', 'roosterverantwoordelijke'].includes(role)) {
      // Admin/roosterverantwoordelijke: alle requests
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date::text as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date::text as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        ORDER BY sr.created_at DESC
      `;
    } else {
      // Medewerker: own requests + open takeover requests from own team only
      query = `
        SELECT
          sr.*,
          u1.name as requester_name,
          u2.name as target_name,
          s1.date::text as requester_shift_date,
          s1.start_time as requester_shift_start,
          s1.end_time as requester_shift_end,
          s1.team as requester_shift_team,
          s1.notes as requester_shift_notes,
          s2.date::text as target_shift_date,
          s2.start_time as target_shift_start,
          s2.end_time as target_shift_end,
          s2.team as target_shift_team,
          resp.name as responded_by_name
        FROM shift_swap_requests sr
        JOIN users u1 ON sr.requester_user_id = u1.id
        LEFT JOIN users u2 ON sr.target_user_id = u2.id
        JOIN shifts s1 ON sr.requester_shift_id = s1.id
        LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
        LEFT JOIN users resp ON sr.responded_by = resp.id
        WHERE sr.requester_user_id = $1 OR sr.target_user_id = $1
              OR (sr.request_type = 'takeover' AND sr.status = 'pending' AND s1.team = $2)
        ORDER BY sr.created_at DESC
      `;
      params = [currentUserId, team_id];
    }

    const result = await pool.query(query, params);
    console.log(`[GET /swap-requests] User ${req.user.name} (ID: ${req.user.id}, role: ${role}): Found ${result.rows.length} requests`);
    if (result.rows.length > 0) {
      console.log(`[GET /swap-requests] First request:`, {
        id: result.rows[0].id,
        request_type: result.rows[0].request_type,
        status: result.rows[0].status,
        requester: result.rows[0].requester_name
      });
    }
    res.json({ swapRequests: result.rows });
  } catch (err) {
    console.error('GET /swap-requests error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/swap-requests', requireAuth, async (req, res) => {
  const { requesterShiftId, targetShiftId, message } = req.body;
  const currentUserId = req.user.id;

  if (!requesterShiftId || !targetShiftId) {
    return res.status(400).json({ error: 'requesterShiftId en targetShiftId zijn verplicht' });
  }

  try {
    // Verify beide shifts bestaan
    const shiftsResult = await pool.query(
      'SELECT id, user_id, date FROM shifts WHERE id = $1 OR id = $2',
      [requesterShiftId, targetShiftId]
    );

    if (shiftsResult.rows.length !== 2) {
      return res.status(404).json({ error: 'Een of beide shifts niet gevonden' });
    }

    const requesterShift = shiftsResult.rows.find(s => s.id === parseInt(requesterShiftId));
    const targetShift = shiftsResult.rows.find(s => s.id === parseInt(targetShiftId));

    // Verify requester owns requester shift
    if (requesterShift.user_id !== currentUserId) {
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts ruilen' });
    }

    // Verify different users
    if (requesterShift.user_id === targetShift.user_id) {
      return res.status(400).json({ error: 'Je kunt niet met jezelf ruilen' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(requesterShift.date);
    const targetDate = new Date(targetShift.date);

    if (requesterDate < now || targetDate < now) {
      return res.status(400).json({ error: 'Kan geen shifts in het verleden ruilen' });
    }

    // Create swap request
    const insertResult = await pool.query(
      `INSERT INTO shift_swap_requests
       (requester_user_id, requester_shift_id, target_user_id, target_shift_id, message, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [currentUserId, requesterShiftId, targetShift.user_id, targetShiftId, message || null]
    );

    await logAudit(req, 'CREATE', 'swap_request', insertResult.rows[0].id, { requester: currentUserId, target: targetShift.user_id, type: 'swap' });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[currentUserId, targetShift.user_id]]
        );
        const fullShifts = await pool.query(
          'SELECT id, user_id, date::text as date, start_time, end_time, team FROM shifts WHERE id = ANY($1)',
          [[requesterShiftId, targetShiftId]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === currentUserId);
        const targetUser = usersResult.rows.find(u => u.id === targetShift.user_id);
        const rShift = fullShifts.rows.find(s => s.id === parseInt(requesterShiftId));
        const tShift = fullShifts.rows.find(s => s.id === parseInt(targetShiftId));
        if (requesterUser && targetUser && rShift && tShift) {
          emailService.notifySwapRequest(targetUser, requesterUser, rShift, tShift);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.status(201).json({ swapRequest: insertResult.rows[0] });
  } catch (err) {
    console.error('POST /swap-requests error:', err);
    if (err.code === '23514') { // CHECK constraint violation
      return res.status(400).json({ error: 'Ongeldige swap request data' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Target approval endpoints
v1.put('/swap-requests/:id/target-approve', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes, force } = req.body;
  const { id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info (FOR UPDATE locks rows to prevent concurrent modification)
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.user_id as requester_current_user, s1.team as requester_team, s1.date::text as requester_date,
              s1.start_time as requester_start, s1.end_time as requester_end,
              s2.user_id as target_current_user, s2.team as target_team, s2.date::text as target_date,
              s2.start_time as target_start, s2.end_time as target_end
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s1, s2`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can approve
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek accepteren' });
    }

    // Verify shift ownership hasn't changed since swap was created
    if (swap.requester_current_user !== swap.requester_user_id || swap.target_current_user !== swap.target_user_id) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Een van de diensten is inmiddels hertoegewezen. Dit ruilverzoek is niet meer geldig.' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = parseLocalDate(swap.requester_date);
    const targetDate = parseLocalDate(swap.target_date);

    if (requesterDate < now || targetDate < now) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Shifts zijn al voorbij' });
    }

    // #202: een ruil ging tot nu toe volledig langs de roosterregels heen. De
    // shifts wisselden van eigenaar zonder te controleren of de nieuwe eigenaar
    // die dag al werkt of te weinig rust overhoudt. Dezelfde dienst via
    // POST /shifts aanmaken wordt wel geweigerd, dus de ruil was een sluipweg
    // om de overlapcontrole en de 11-uur regel te omzeilen.
    //
    // Elke medewerker staat zijn eigen dienst af, dus die telt niet mee als
    // conflict: hij wordt uitgesloten via excludeId.
    //
    // force=true slaat, net als bij POST /shifts en PUT /shifts/:id, ALLEEN de
    // 11-uur rust over en nooit de overlap. De frontend zet die vlag pas nadat
    // de gebruiker de melding heeft gezien en bevestigd heeft.
    const requesterShift = { date: swap.requester_date, start_time: swap.requester_start, end_time: swap.requester_end };
    const targetShift = { date: swap.target_date, start_time: swap.target_start, end_time: swap.target_end };

    const targetCheck = await validateShiftRules(client, swap.target_user_id, requesterShift, swap.target_shift_id, !!force);
    if (!targetCheck.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: `Deze ruil kan niet doorgaan. ${targetCheck.message}`,
        rule: targetCheck.rule,
        wie: 'jij',
        canOverride: targetCheck.rule === 'rest'
      });
    }

    const requesterCheck = await validateShiftRules(client, swap.requester_user_id, targetShift, swap.requester_shift_id, !!force);
    if (!requesterCheck.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: `Deze ruil kan niet doorgaan voor de aanvrager. ${requesterCheck.message}`,
        rule: requesterCheck.rule,
        wie: 'aanvrager',
        canOverride: requesterCheck.rule === 'rest'
      });
    }

    // Execute swap: swap user_ids atomically
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.target_current_user, swap.requester_shift_id]
    );

    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [swap.requester_current_user, swap.target_shift_id]
    );

    // Na de ruil is de dag van de aanvrager leeg, en die van de doelpersoon
    // ook. Zonder blokkade vult het concept beide bij een volgende toepassing
    // weer op, en dan werkt iedereen zijn oude én zijn geruilde dienst.
    // blockDayIfEmpty raakt niets aan als de medewerker die dag toch nog een
    // dienst heeft, bijvoorbeeld bij een ruil binnen dezelfde dag.
    await blockDayIfEmpty(client, swap.requester_current_user, swap.requester_date, req.user.id, 'manual_swap');
    await blockDayIfEmpty(client, swap.target_current_user, swap.target_date, req.user.id, 'manual_swap');

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved',
           target_approved = true,
           target_response_notes = $1,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $2
       WHERE id = $3`,
      [responseNotes || null, currentUserId, swapId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'APPROVE', 'swap_request', swapId, {
      swap: { requester: swap.requester_user_id, target: swap.target_user_id, type: 'swap' },
      ...(force ? { rusttijdOverruled: true } : {})
    });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[swap.requester_user_id, swap.target_user_id]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === swap.requester_user_id);
        const targetUser = usersResult.rows.find(u => u.id === swap.target_user_id);
        const approverName = targetUser ? targetUser.name : 'Collega';
        const rShift = { date: swap.requester_date, start_time: swap.requester_start, end_time: swap.requester_end, team: swap.requester_team };
        const tShift = { date: swap.target_date, start_time: swap.target_start, end_time: swap.target_end, team: swap.target_team };
        emailService.notifySwapApproved([requesterUser, targetUser].filter(Boolean), approverName, rShift, tShift, requesterUser, targetUser);
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap geaccepteerd en uitgevoerd' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /swap-requests/:id/target-approve error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.put('/swap-requests/:id/target-reject', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { id: currentUserId } = req.user;

  if (!responseNotes || responseNotes.trim() === '') {
    return res.status(400).json({ error: 'Reden voor afwijzing is verplicht' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request
    const swapResult = await client.query(
      `SELECT * FROM shift_swap_requests WHERE id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can reject
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek afwijzen' });
    }

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'rejected',
           target_approved = false,
           target_response_notes = $1,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $2
       WHERE id = $3`,
      [responseNotes, currentUserId, swapId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'REJECT', 'swap_request', swapId, { swap: { requester: swap.requester_user_id, target: swap.target_user_id, reason: responseNotes } });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[swap.requester_user_id, swap.target_user_id]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === swap.requester_user_id);
        const targetUser = usersResult.rows.find(u => u.id === swap.target_user_id);
        const rejectorName = targetUser ? targetUser.name : 'Collega';
        if (requesterUser) {
          emailService.notifySwapRejected([requesterUser], rejectorName, responseNotes);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap afgewezen' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /swap-requests/:id/target-reject error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Takeover (open shift request) endpoints
v1.post('/shift-requests/takeover', requireAuth, async (req, res) => {
  const { shiftId, message } = req.body;
  const currentUserId = req.user.id;
  const { role, team_id } = req.user;

  if (!shiftId) {
    return res.status(400).json({ error: 'shiftId is verplicht' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Verify shift exists
    const shiftResult = await client.query(
      `SELECT * FROM shifts WHERE id = $1`,
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];

    // Permission check: Allow admin, roosterverantwoordelijke, or own shifts
    const isOwnShift = shift.user_id === currentUserId;
    const isAdmin = role === 'admin';
    const isRoosterverantwoordelijke = role === 'roosterverantwoordelijke';

    if (!isOwnShift && !isAdmin && !isRoosterverantwoordelijke) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts aanbieden, tenzij je admin of verantwoordelijke bent' });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = new Date(shift.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // Create takeover request
    // Use shift owner (shift.user_id) as requester, not currentUserId
    // This ensures auto-cancel can find requests by employee ID when absence is removed
    await client.query(
      `INSERT INTO shift_swap_requests
       (requester_user_id, requester_shift_id, target_user_id, target_shift_id, request_type, message, status)
       VALUES ($1, $2, NULL, NULL, 'takeover', $3, 'pending')`,
      [shift.user_id, shiftId, message || null]
    );

    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'swap_request', '', { type: 'takeover', shiftId, shiftOwner: shift.user_id, createdBy: currentUserId });

    // Email notification to team members (fire-and-forget)
    (async () => {
      try {
        const shiftTeam = shift.team;
        const teamMembers = await pool.query(
          `SELECT id, name, email, email_notifications_enabled FROM users
           WHERE active = true AND main_team = $1`,
          [shiftTeam]
        );
        const requester = await pool.query(
          'SELECT id, name, email FROM users WHERE id = $1', [shift.user_id]
        );
        if (requester.rows[0]) {
          const fullShift = { date: shift.date, start_time: shift.start_time, end_time: shift.end_time, team: shift.team };
          emailService.notifyTakeoverAvailable(teamMembers.rows, requester.rows[0], fullShift);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Open verzoek aangemaakt' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /shift-requests/takeover error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.put('/shift-requests/:id/takeover-accept', requireAuth, async (req, res) => {
  const requestId = req.params.id;
  const { responseNotes, force } = req.body;
  const { id: currentUserId, team_id: acceptorTeam } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch takeover request with shift info (FOR UPDATE locks rows to prevent concurrent modification)
    const requestResult = await client.query(
      `SELECT sr.*, s.user_id as current_shift_owner, s.date::text as date, s.start_time, s.end_time, s.team
       FROM shift_swap_requests sr
       JOIN shifts s ON sr.requester_shift_id = s.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Verzoek niet gevonden' });
    }

    const request = requestResult.rows[0];

    // Verify it's a takeover request
    if (request.request_type !== 'takeover') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Dit is geen open verzoek' });
    }

    // Verify status is pending
    if (request.status !== 'pending') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Verzoek is al verwerkt' });
    }

    // Verify user is not the requester
    if (request.requester_user_id === currentUserId) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(403).json({ error: 'Je kunt je eigen verzoek niet accepteren' });
    }

    // #188: de dienst mag intussen niet aan iemand anders zijn toegewezen.
    // current_shift_owner werd hierboven wel geselecteerd maar nergens gebruikt.
    // Daardoor kon een oud, nog openstaand overnameverzoek de dienst afpakken
    // van de collega die hem intussen had gekregen, bijvoorbeeld doordat de
    // roosterverantwoordelijke het gat zelf had opgevuld. Die collega werd
    // niets gevraagd en kreeg geen bericht, want de melding gaat naar de
    // oorspronkelijke aanvrager.
    //
    // Het zusterendpoint voor gewone ruilverzoeken doet deze controle al
    // (zie 'Verify shift ownership hasn't changed' hierboven).
    if (request.current_shift_owner !== request.requester_user_id) {
      // Het verzoek kan nooit meer slagen, dus zetten we het meteen op een
      // eindstatus. Anders blijft de kaart onder 'Actie vereist' staan en
      // geeft elke klik dezelfde fout, wat precies de val uit #316 is.
      await client.query(
        `UPDATE shift_swap_requests SET status = 'expired', responded_at = NOW() WHERE id = $1`,
        [requestId]
      );
      await client.query('COMMIT');
      return res.status(400).json({
        error: 'Deze dienst is inmiddels aan iemand anders toegewezen. Dit overnameverzoek is niet meer geldig.'
      });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = parseLocalDate(request.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // #202: ook een overname sloeg de roosterregels over. Wie de dienst
    // overneemt kon er een krijgen die overlapt met zijn eigen dienst, of die
    // te kort op zijn vorige of volgende dienst volgt. De 11-uur rust is geen
    // huisregel maar arbeidswetgeving, en dit is juist het scenario waar de
    // planner het minst naar kijkt: een overname voelt als iets dat de
    // collega's onderling geregeld hebben.
    //
    // force=true slaat, net als bij POST /shifts en PUT /shifts/:id, ALLEEN de
    // 11-uur rust over en nooit de overlap. De frontend zet die vlag pas nadat
    // de gebruiker de melding heeft gezien en bevestigd heeft.
    const takeoverShift = { date: request.date, start_time: request.start_time, end_time: request.end_time };
    const acceptorCheck = await validateShiftRules(client, currentUserId, takeoverShift, null, !!force);
    if (!acceptorCheck.valid) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(422).json({
        error: `Je kunt deze dienst niet overnemen. ${acceptorCheck.message}`,
        rule: acceptorCheck.rule,
        canOverride: acceptorCheck.rule === 'rest'
      });
    }

    // Assign shift to acceptor, keep original team (don't change team on takeover)
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [currentUserId, request.requester_shift_id]
    );

    // De dag van wie de dienst afstond is nu leeg. Zonder blokkade vult het
    // concept die opnieuw op en werkt hij alsnog de dienst die hij net had
    // weggegeven, terwijl de collega hem ook heeft.
    await blockDayIfEmpty(client, request.requester_user_id, request.date, req.user.id, 'manual_takeover');

    // Update request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved',
           target_user_id = $1,
           target_approved = true,
           target_response_notes = $2,
           target_responded_at = NOW(),
           responded_at = NOW(),
           responded_by = $1
       WHERE id = $3`,
      [currentUserId, responseNotes || null, requestId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'APPROVE', 'swap_request', requestId, {
      type: 'takeover', requester: request.requester_user_id, acceptedBy: currentUserId,
      ...(force ? { rusttijdOverruled: true } : {})
    });

    // Email notification to original owner (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[request.requester_user_id, currentUserId]]
        );
        const originalOwner = usersResult.rows.find(u => u.id === request.requester_user_id);
        const acceptor = usersResult.rows.find(u => u.id === currentUserId);
        if (originalOwner && acceptor) {
          const shiftInfo = { date: request.date, start_time: request.start_time, end_time: request.end_time, team: request.team };
          emailService.notifyTakeoverAccepted(originalOwner, acceptor, shiftInfo);
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Shift overgenomen' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT /shift-requests/:id/takeover-accept error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.delete('/swap-requests/:id', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const currentUserId = req.user.id;
  const { role, team_id } = req.user;

  try {
    // Fetch swap request with team info
    const swapResult = await pool.query(
      `SELECT sr.*,
              s1.team as requester_team,
              s2.team as target_team
       FROM shift_swap_requests sr
       LEFT JOIN shifts s1 ON sr.requester_shift_id = s1.id
       LEFT JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Permission check: Allow requester, admin, or roosterverantwoordelijke
    const isRequester = swap.requester_user_id === currentUserId;
    const isAdmin = role === 'admin';
    const isRoosterverantwoordelijke = role === 'roosterverantwoordelijke';

    if (!isRequester && !isAdmin && !isRoosterverantwoordelijke) {
      return res.status(403).json({ error: 'Alleen de aanvrager of een verantwoordelijke kan dit verzoek annuleren' });
    }

    // Only pending requests can be cancelled
    if (swap.status !== 'pending') {
      return res.status(400).json({ error: 'Alleen pending requests kunnen geannuleerd worden' });
    }

    // Update status to cancelled
    await pool.query(
      `UPDATE shift_swap_requests SET status = 'cancelled' WHERE id = $1`,
      [swapId]
    );

    await logAudit(req, 'CANCEL', 'swap_request', swapId, { type: swap.request_type, requester: swap.requester_user_id, cancelledBy: currentUserId });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const affectedIds = [swap.requester_user_id, swap.target_user_id].filter(Boolean);
        if (affectedIds.length > 0) {
          const usersResult = await pool.query(
            'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
            [affectedIds]
          );
          const canceller = usersResult.rows.find(u => u.id === currentUserId);
          const cancellerName = canceller ? canceller.name : 'Iemand';
          const recipients = usersResult.rows.filter(u => u.id !== currentUserId);
          if (recipients.length > 0) {
            const shiftResult = await pool.query(
              'SELECT date::text as date, start_time, end_time, team FROM shifts WHERE id = $1',
              [swap.requester_shift_id]
            );
            emailService.notifyRequestCancelled(recipients, cancellerName, shiftResult.rows[0] || null);
          }
        }
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap request geannuleerd' });
  } catch (err) {
    console.error('DELETE /swap-requests/:id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SETTINGS API =====

v1.get('/settings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    res.json({ settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.put('/settings/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'Key en value zijn verplicht' });
  }

  const { role } = req.user;
  if (!['admin', 'roosterverantwoordelijke', 'hoofdverantwoordelijke', 'teamverantwoordelijke'].includes(role)) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }
  try {
    await pool.query(`
      INSERT INTO settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = $2, updated_at = NOW()
    `, [key, JSON.stringify(value)]);

    // When teams settings are saved, sync names/colors to the teams table
    if (key === 'teams' && value && typeof value === 'object') {
      for (const [teamId, teamData] of Object.entries(value)) {
        if (!teamData || !teamData.name) continue;
        await pool.query(
          `UPDATE teams SET name = $1, color = $2 WHERE id = $3`,
          [teamData.name, teamData.color || null, teamId]
        );
      }
    }

    await logAudit(req, 'UPDATE', 'settings', key, { key });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== SCHEDULE DRAFTS API =====

v1.get('/schedule-drafts', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, week_number as "weekNumber", team_filter as "teamFilter",
             grid, created_by as "createdBy", created_by_name as "createdByName",
             last_applied_at as "lastAppliedAt", last_applied_by as "lastAppliedBy",
             last_applied_from::text as "lastAppliedFrom", last_applied_until::text as "lastAppliedUntil",
             valid_from::text as "validFrom", valid_until::text as "validUntil",
             updated_by_name as "updatedByName",
             type, holiday_period_id as "holidayPeriodId",
             locked_by as "lockedBy", locked_by_name as "lockedByName", locked_at as "lockedAt",
             created_at as "createdAt", updated_at as "updatedAt"
      FROM schedule_drafts
      ORDER BY updated_at DESC
    `);
    res.json({ drafts: result.rows });
  } catch (err) {
    console.error('Error fetching schedule drafts:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/schedule-drafts', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id, name, weekNumber, teamFilter, grid, validFrom, validUntil, type, holidayPeriodId } = req.body;
  const draftId = id || `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const draftType = type || 'basis';

  // Validatie: vakantieconcept vereist holidayPeriodId
  if (draftType === 'vakantie' && !holidayPeriodId) {
    return res.status(400).json({ error: 'Vakantieconcept vereist een gekoppelde vakantieperiode' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO schedule_drafts (id, name, week_number, team_filter, grid, created_by, created_by_name, valid_from, valid_until, type, holiday_period_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
       RETURNING id, name, week_number as "weekNumber", team_filter as "teamFilter",
                 grid, created_by_name as "createdByName",
                 last_applied_at as "lastAppliedAt", last_applied_by as "lastAppliedBy",
                 valid_from::text as "validFrom", valid_until::text as "validUntil",
                 type, holiday_period_id as "holidayPeriodId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      [draftId, name || 'Naamloos', weekNumber || 1, teamFilter || null, JSON.stringify(grid || {}), req.user.id, req.user.name, validFrom || null, validUntil || null, draftType, holidayPeriodId || null]
    );
    await logAudit(req, 'CREATE', 'settings', draftId, { type: 'schedule_draft', draftType, name });
    res.json({ draft: result.rows[0] });
  } catch (err) {
    console.error('Error creating schedule draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.put('/schedule-drafts/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  const { name, weekNumber, teamFilter, grid, lastAppliedAt, lastAppliedBy, validFrom, validUntil, type, holidayPeriodId } = req.body;

  try {
    // Check if concept is locked by someone else
    const lockCheck = await pool.query(
      'SELECT locked_by, locked_by_name, locked_at FROM schedule_drafts WHERE id = $1',
      [id]
    );
    if (lockCheck.rows.length > 0) {
      const { locked_by, locked_by_name, locked_at } = lockCheck.rows[0];
      const lockExpired = !locked_at || (Date.now() - new Date(locked_at).getTime()) > 30 * 60 * 1000;
      if (locked_by && locked_by !== req.user.id && !lockExpired) {
        return res.status(423).json({ error: `Concept is vergrendeld door ${locked_by_name}` });
      }
    }

    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let paramIndex = 1;

    // Always track who updated
    setClauses.push(`updated_by = $${paramIndex++}`); params.push(req.user.id);
    setClauses.push(`updated_by_name = $${paramIndex++}`); params.push(req.user.name);

    if (name !== undefined) { setClauses.push(`name = $${paramIndex++}`); params.push(name); }
    if (weekNumber !== undefined) { setClauses.push(`week_number = $${paramIndex++}`); params.push(weekNumber); }
    if (teamFilter !== undefined) { setClauses.push(`team_filter = $${paramIndex++}`); params.push(teamFilter); }
    if (grid !== undefined) { setClauses.push(`grid = $${paramIndex++}`); params.push(JSON.stringify(grid)); }
    if (lastAppliedAt !== undefined) { setClauses.push(`last_applied_at = $${paramIndex++}`); params.push(lastAppliedAt); }
    if (lastAppliedBy !== undefined) { setClauses.push(`last_applied_by = $${paramIndex++}`); params.push(lastAppliedBy); }
    if (validFrom !== undefined) { setClauses.push(`valid_from = $${paramIndex++}`); params.push(validFrom || null); }
    if (validUntil !== undefined) { setClauses.push(`valid_until = $${paramIndex++}`); params.push(validUntil || null); }
    if (type !== undefined) { setClauses.push(`type = $${paramIndex++}`); params.push(type); }
    if (holidayPeriodId !== undefined) { setClauses.push(`holiday_period_id = $${paramIndex++}`); params.push(holidayPeriodId || null); }

    params.push(id);

    const result = await pool.query(
      `UPDATE schedule_drafts SET ${setClauses.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, name, week_number as "weekNumber", team_filter as "teamFilter",
                 grid, created_by_name as "createdByName", updated_by_name as "updatedByName",
                 last_applied_at as "lastAppliedAt", last_applied_by as "lastAppliedBy",
                 valid_from::text as "validFrom", valid_until::text as "validUntil",
                 type, holiday_period_id as "holidayPeriodId",
                 created_at as "createdAt", updated_at as "updatedAt"`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }
    await logAudit(req, 'UPDATE', 'settings', id, { type: 'schedule_draft', name: result.rows[0].name });
    res.json({ draft: result.rows[0] });
  } catch (err) {
    console.error('Error updating schedule draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.delete('/schedule-drafts/:id', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM schedule_drafts WHERE id = $1 RETURNING name', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }
    await logAudit(req, 'DELETE', 'settings', id, { type: 'schedule_draft', name: result.rows[0].name });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting schedule draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== LOCK / UNLOCK SCHEDULE DRAFT =====
const DRAFT_LOCK_TTL_MS = 30 * 60 * 1000; // 30 minuten

v1.post('/schedule-drafts/:id/lock', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  const { force = false } = req.body || {};
  try {
    const result = await pool.query(
      'SELECT locked_by, locked_by_name, locked_at FROM schedule_drafts WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Concept niet gevonden' });

    const { locked_by, locked_by_name, locked_at } = result.rows[0];
    const expired = !locked_at || (Date.now() - new Date(locked_at).getTime()) > DRAFT_LOCK_TTL_MS;
    const byOther = locked_by && locked_by !== req.user.id && !expired;

    if (byOther && !force) {
      return res.status(423).json({ error: 'locked', lockedByName: locked_by_name, lockedAt: locked_at });
    }

    await pool.query(
      'UPDATE schedule_drafts SET locked_by = $1, locked_by_name = $2, locked_at = NOW() WHERE id = $3',
      [req.user.id, req.user.name, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error locking draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/schedule-drafts/:id/unlock', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE schedule_drafts SET locked_by = NULL, locked_by_name = NULL, locked_at = NULL
       WHERE id = $1 AND (locked_by = $2 OR $3)`,
      [id, req.user.id, req.user.role === 'admin']
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Error unlocking draft:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== DEACTIVATE SCHEDULE DRAFT =====

v1.post('/schedule-drafts/:id/deactivate', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { endDate, deleteManual = false } = req.body || {};
  if (!endDate) return res.status(400).json({ error: 'endDate is vereist' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load draft
    // last_applied_until wordt hieronder overschreven met endDate, dus we lezen
    // de oorspronkelijke waarde hier uit: die is de bovengrens voor diensten
    // van vóór migratie 037, die nog geen draft_id dragen.
    const draftResult = await client.query(
      `SELECT id, name, grid, team_filter,
              last_applied_from::text  as "lastAppliedFrom",
              last_applied_until::text as "lastAppliedUntil"
       FROM schedule_drafts WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (draftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }

    const draft = draftResult.rows[0];
    const grid = draft.grid || {};

    // 2. Update draft: set last_applied_until = endDate
    await client.query(
      'UPDATE schedule_drafts SET last_applied_until = $1, updated_at = NOW() WHERE id = $2',
      [endDate, req.params.id]
    );

    // 3. Collect user IDs from grid
    //
    // #213: er bestaan twee vormen van een conceptraster, en de sleutels staan
    // er precies omgekeerd in:
    //   single-week : { "<empId>": { "0": {...} }, _pattern: ... }
    //   multi-week  : { _multiWeek: true, "1": { "<empId>": {...} } }
    //
    // Deze lus nam blind het TWEEDE niveau als medewerker-id. Bij een
    // single-week raster leverde dat de dagnummers 0 tot 6 op, die daarna als
    // gebruikers-id's de verwijdering in gingen. apply doet die controle wel
    // (isMultiWeek), deactivate niet. Nu allebei.
    const isMultiWeek = !!grid._multiWeek;
    const userIds = new Set();
    const onthoud = (id) => { const n = parseInt(id); if (!isNaN(n)) userIds.add(n); };

    if (isMultiWeek) {
      // Bovenste niveau is het weeknummer, daaronder staan de medewerkers.
      for (const [key, weekGrid] of Object.entries(grid)) {
        if (key.startsWith('_')) continue;
        if (typeof weekGrid === 'object' && weekGrid !== null) {
          Object.keys(weekGrid).forEach(onthoud);
        }
      }
    } else {
      // Bovenste niveau is de medewerker zelf.
      for (const key of Object.keys(grid)) {
        if (key.startsWith('_')) continue;
        onthoud(key);
      }
    }

    // 4. Verwijder de diensten van DIT concept na endDate.
    //
    // #185: hier stond `user_id = ANY($1) AND date > $2`, zonder bovengrens en
    // zonder koppeling met het concept. Het uitplannen van een paasconcept van
    // twee weken wiste daardoor het volledige toekomstige rooster van iedereen
    // die erin stond, inclusief diensten die een heel ander concept had gemaakt.
    // Sinds migratie 037 draagt elke gegenereerde dienst een draft_id, dus we
    // kunnen precies zijn.
    let shiftsDeleted = 0;
    const byDraft = await client.query(
      `DELETE FROM shifts WHERE draft_id = $1 AND date > $2::date`,
      [req.params.id, endDate]
    );
    shiftsDeleted += byDraft.rowCount;

    // Diensten van vóór migratie 037 hebben geen draft_id. Die kunnen we niet
    // exact toewijzen, dus blijven we binnen wat dit concept aantoonbaar
    // besloeg: zijn eigen toepassingsbereik, zijn eigen medewerkers en zijn
    // eigen teamfilter. Nooit verder.
    //
    // Beide grenzen zijn nodig. Alleen bovenaan begrenzen is niet genoeg: een
    // paasconcept dat enkel 5 t/m 18 april 2027 besloeg wiste bij een endDate
    // van 31 augustus 2026 anders alsnog alle diensten uit september 2026, die
    // onmogelijk van dat concept konden komen.
    //
    // Is het concept nog nooit toegepast, dan heeft het ook niets gegenereerd
    // en gebeurt hier niets.
    const legacyFrom = draft.lastAppliedFrom;
    const legacyUntil = draft.lastAppliedUntil;
    if (userIds.size > 0 && legacyFrom && legacyUntil && legacyUntil > endDate) {
      const params = [Array.from(userIds), endDate, legacyFrom, legacyUntil];
      let legacyQuery = `DELETE FROM shifts
        WHERE draft_id IS NULL
          AND user_id = ANY($1::int[])
          AND date > $2::date
          AND date >= $3::date AND date <= $4::date`;
      if (!deleteManual) legacyQuery += ` AND source = 'auto'`;
      if (draft.team_filter) {
        params.push(draft.team_filter);
        legacyQuery += ` AND team = $${params.length}`;
      }
      const legacy = await client.query(legacyQuery, params);
      shiftsDeleted += legacy.rowCount;
    }

    await client.query('COMMIT');
    await logAudit(req, 'UPDATE', 'settings', req.params.id, {
      action: 'deactivate', endDate, shiftsDeleted, draftName: draft.name,
      scopedFrom: legacyFrom || null, scopedUntil: legacyUntil || null
    });
    res.json({ ok: true, shiftsDeleted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /schedule-drafts/:id/deactivate error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== APPLY SCHEDULE DRAFT (atomic transaction for all employees) =====

v1.post('/schedule-drafts/:id/apply', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const draftId = req.params.id;
  const { clearBlocks = true, applyStartDate = null, applyEndDate = null } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load draft with FOR UPDATE lock
    const draftResult = await client.query(
      `SELECT id, name, week_number, team_filter, grid, created_by, valid_from, valid_until, type, holiday_period_id,
              last_applied_from::text AS last_applied_from
       FROM schedule_drafts WHERE id = $1 FOR UPDATE`,
      [draftId]
    );

    if (draftResult.rows.length === 0) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Concept niet gevonden' });
    }

    const draft = draftResult.rows[0];
    const rawGrid = draft.grid || {};
    const isMultiWeek = !!rawGrid._multiWeek;

    // Build list of weeks to apply
    const weeksToApply = [];
    if (isMultiWeek) {
      for (const [key, weekGrid] of Object.entries(rawGrid)) {
        if (key.startsWith('_')) continue; // skip _multiWeek, _pattern, _rotation metadata
        weeksToApply.push({ weekNumber: Number(key), grid: weekGrid });
      }
    } else {
      weeksToApply.push({ weekNumber: draft.week_number || 1, grid: rawGrid });
    }

    // Check if this is a future-scheduled draft
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (draft.valid_from) {
      const validFromDate = parseLocalDate(draft.valid_from);
      if (validFromDate && validFromDate > today) {
        // Future draft: save as "ingepland" without applying
        await client.query(
          `UPDATE schedule_drafts SET updated_at = NOW() WHERE id = $1`,
          [draftId]
        );
        await client.query('COMMIT');
        await logAudit(req, 'UPDATE', 'settings', draftId, {
          type: 'draft_schedule',
          draftName: draft.name,
          validFrom: draft.valid_from,
          validUntil: draft.valid_until
        });
        return res.json({
          scheduled: true,
          validFrom: draft.valid_from,
          validUntil: draft.valid_until,
          draftName: draft.name
        });
      }
    }

    // Determine effective date range for shift generation
    let effectiveStartDate = applyStartDate || null;
    let effectiveEndDate = applyEndDate || null;
    const isVakantie = draft.type === 'vakantie';

    // Vakantieconcept: force date-range mode from holiday period dates
    if (isVakantie) {
      if (!draft.holiday_period_id) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({ error: 'Vakantieconcept heeft geen gekoppelde vakantieperiode' });
      }
      const hpResult = await client.query(`SELECT value FROM settings WHERE key = 'holidayPeriods'`);
      const holidayPeriods = hpResult.rows.length > 0 ? (hpResult.rows[0].value || []) : [];
      const linkedPeriod = holidayPeriods.find(p => String(p.id) === String(draft.holiday_period_id));
      if (!linkedPeriod) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({ error: 'Gekoppelde vakantieperiode niet gevonden' });
      }
      effectiveStartDate = linkedPeriod.startDate;
      effectiveEndDate = linkedPeriod.endDate;
    }

    // Date range is verplicht — concepten hebben altijd een van/tot datum
    if (!effectiveStartDate || !effectiveEndDate) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Start- en einddatum zijn verplicht bij concept toepassen' });
    }

    // Validate date range
    if (effectiveStartDate >= effectiveEndDate) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ error: 'Startdatum moet voor einddatum liggen' });
    }

    const { confirmOverlap = false, confirmOverwrite = null } = req.body || {};

    // Vakantieconcepten overschrijven altijd alle shifts (auto + manual):
    // vakantie is een expliciete beslissing — niets uit het basisrooster mag blijven staan.
    const effectiveConfirmOverwrite = isVakantie ? true : confirmOverwrite;

    // 2a. Overlap detectie — zoek actieve niet-vakantie concepten die overlappen
    if (!isVakantie && !confirmOverlap) {
      const overlapping = await client.query(
        `SELECT id, name, last_applied_from, last_applied_until
         FROM schedule_drafts
         WHERE id != $1 AND last_applied_at IS NOT NULL
         AND type IS DISTINCT FROM 'vakantie'
         AND last_applied_from IS NOT NULL AND last_applied_until IS NOT NULL
         AND last_applied_from < $3 AND last_applied_until > $2`,
        [draftId, effectiveStartDate, effectiveEndDate]
      );
      if (overlapping.rows.length > 0) {
        await client.query('ROLLBACK').catch(() => {});
        return res.json({
          needsOverlapConfirmation: true,
          overlappingDrafts: overlapping.rows.map(d => ({
            id: d.id,
            name: d.name,
            from: d.last_applied_from,
            until: d.last_applied_until
          })),
          newStartDate: effectiveStartDate
        });
      }
    }

    // 2b. Tel manuele shifts in het bereik voor het succesrapport.
    //     Manuele shifts worden standaard NIET verwijderd (enkel source='auto'),
    //     dus er is geen bevestigingsvraag meer nodig — de teller gaat mee
    //     in het eindresultaat zodat de gebruiker ziet wat bewaard is (#146).
    let preservedManualCount = 0;
    if (!isVakantie) {
      const manualResult = await client.query(
        `SELECT COUNT(*)::int as count FROM shifts WHERE source = 'manual'
         AND date >= $1::date AND date <= $2::date`,
        [effectiveStartDate, effectiveEndDate]
      );
      preservedManualCount = manualResult.rows[0].count;
    }

    // 2c. Bij bevestiging overlap: inkorten overlappende concepten
    if (confirmOverlap && !isVakantie) {
      const overlapping = await client.query(
        `SELECT id, name, last_applied_from, last_applied_until
         FROM schedule_drafts
         WHERE id != $1 AND last_applied_at IS NOT NULL
         AND type IS DISTINCT FROM 'vakantie'
         AND last_applied_from IS NOT NULL AND last_applied_until IS NOT NULL
         AND last_applied_from < $3 AND last_applied_until > $2`,
        [draftId, effectiveStartDate, effectiveEndDate]
      );
      for (const overlap of overlapping.rows) {
        // Kort het overlappende concept in tot de dag vóór de nieuwe startdatum
        const newEndDate = new Date(parseLocalDate(effectiveStartDate));
        newEndDate.setDate(newEndDate.getDate() - 1);
        const newEndStr = formatDateYYYYMMDD(newEndDate);

        if (newEndStr >= overlap.last_applied_from) {
          // Concept A nog geldig voor periode vóór B → inkorten
          await client.query(
            `UPDATE schedule_drafts SET last_applied_until = $1, updated_at = NOW() WHERE id = $2`,
            [newEndStr, overlap.id]
          );
        } else {
          // Concept A volledig overschreven → markeer als verlopen
          await client.query(
            `UPDATE schedule_drafts SET last_applied_until = last_applied_from, updated_at = NOW() WHERE id = $1`,
            [overlap.id]
          );
        }

        // Verwijder de diensten van het oude concept in de overlappende periode.
        //
        // #187: deze DELETE liep van de startdatum van het NIEUWE concept tot de
        // einddatum van het OUDE, zonder filter op concept of team. Alles voorbij
        // het bereik van het nieuwe concept werd dus gewist en nooit opnieuw
        // gevuld, en teams waar het nieuwe concept niets mee te maken heeft
        // gingen mee. De gebruiker bevestigde het inkorten van een concept, niet
        // het leegmaken van maanden rooster voor de hele organisatie.
        //
        // Nu: alleen de diensten van dít oude concept, en alleen binnen het
        // bereik dat het nieuwe concept daadwerkelijk gaat vullen. Wat daarbuiten
        // valt blijft staan en blijft via draft_id beheerbaar met 'uitplannen'.
        // Oude diensten zonder draft_id raken we hier bewust niet aan: de gewone
        // bulk-delete verderop dekt het bereik van het nieuwe concept al af, voor
        // precies de medewerkers en teams die het betreft.
        await client.query(
          `DELETE FROM shifts
           WHERE draft_id = $1
             AND date >= $2::date AND date <= $3::date`,
          [overlap.id, effectiveStartDate, effectiveEndDate]
        );
      }
    }

    // 3. Read cycle settings — prefer draft's embedded pattern over global settings
    let cycleLength = 2;
    let referenceDate = '2025-01-06';
    if (rawGrid._pattern && rawGrid._pattern.cycleLength) {
      cycleLength = rawGrid._pattern.cycleLength;
      referenceDate = rawGrid._pattern.referenceDate || referenceDate;
    } else {
      const patternResult = await client.query(`SELECT value FROM settings WHERE key = 'schedule_pattern'`);
      if (patternResult.rows.length > 0 && patternResult.rows[0].value) {
        if (patternResult.rows[0].value.cycleLength) cycleLength = patternResult.rows[0].value.cycleLength;
        if (patternResult.rows[0].value.referenceDate) referenceDate = patternResult.rows[0].value.referenceDate;
      }
    }

    // #211: de backend genereerde vanaf het anker in het concept, en de
    // frontend zette daarna het globale anker op de maandag van de startdatum.
    // Die twee liepen uiteen, en of het misging hing zuiver aan de pariteit van
    // het aantal weken ertussen. Bij een tweewekelijkse cyclus was dat de helft
    // van de gevallen, en dan stond het hele rooster een cycluspositie
    // verschoven ten opzichte van wat de bouwer en de planning toonden.
    //
    // Eén anker dus. Bij de EERSTE toepassing wordt dat de maandag van de
    // startdatum, want dat is wat de bouwer belooft: de week waar je begint is
    // week 1. Bij een volgende toepassing blijft het staande anker gelden, ook
    // als je maar een deel van de periode opnieuw toepast, zodat de fase niet
    // verspringt ten opzichte van wat er al gepland staat.
    //
    // Vakantieconcepten hebben hier niets mee te maken: die nummeren
    // vakantie-relatief en schrijven bewust geen schedulePattern weg.
    if (!isVakantie) {
      const eerdersToegepast = !!draft.last_applied_from;
      if (!eerdersToegepast) {
        referenceDate = formatDateYYYYMMDD(getMonday(parseLocalDate(effectiveStartDate)));
      }
      // Vastleggen in het concept, zodat het anker niet meer kan wegdrijven en
      // de frontend precies dit kan publiceren in plaats van zelf te rekenen.
      if (rawGrid._pattern && rawGrid._pattern.referenceDate !== referenceDate) {
        await client.query(
          `UPDATE schedule_drafts
              SET grid = jsonb_set(grid, '{_pattern,referenceDate}', to_jsonb($1::text), true),
                  updated_at = NOW()
            WHERE id = $2`,
          [referenceDate, draftId]
        );
        rawGrid._pattern.referenceDate = referenceDate;
      }
    }

    // Gesloten dagen per week uit het patroon van het concept (0=zo … 6=za)
    const patternClosedDays = {};
    Object.entries(rawGrid._pattern?.weeks || {}).forEach(([w, cfg]) => {
      if (Array.isArray(cfg?.closedDays)) patternClosedDays[w] = cfg.closedDays;
    });
    let closedDaySkips = 0;
    let conceptClosedCount = 0;

    let appliedCount = 0;
    let totalCreated = 0;
    let totalDeleted = 0;

    // Load all active employees, optionally filtered by team
    let employeeQuery = `SELECT id, name, email, main_team as "mainTeam", extra_teams as "extraTeams",
                contract_hours as "contractHours", active,
                week_schedules as "weekSchedules",
                week_schedule_week1 as "weekScheduleWeek1",
                week_schedule_week2 as "weekScheduleWeek2"
         FROM users WHERE active = true`;
    const employeeParams = [];
    if (draft.team_filter) {
      employeeQuery += ` AND main_team = $1`;
      employeeParams.push(draft.team_filter);
    }
    const allEmployeesResult = await client.query(employeeQuery, employeeParams);

    // Build a grid lookup by week number (indexed by weekNumber -> employeeId -> dayIndex -> assignment)
    const gridByWeek = {};
    for (const { weekNumber, grid } of weeksToApply) {
      gridByWeek[weekNumber] = grid;
    }

    // Wie er echt in het conceptraster staat. Wordt in het blok hieronder gevuld
    // en daarna hergebruikt door de week_schedules-sync (#186).
    let empsInDraftForSync = [];

    // ===== GENERATE SHIFTS FROM DRAFT GRID =====
    {
      const rangeStart = parseLocalDate(effectiveStartDate);
      const rangeEnd = parseLocalDate(effectiveEndDate);
      const refDate = parseLocalDate(referenceDate);
      const refMonday = getMonday(refDate);

      // Load manually closed dates to skip
      let closedDatesSet = new Set();
      try {
        const cdResult = await client.query(`SELECT value FROM settings WHERE key = 'closedDates'`);
        closedDatesSet = new Set((cdResult.rows[0]?.value || []).map(d => d.date));
      } catch (e) {
        console.log('Warning: could not load closedDates for draft apply:', e.message);
      }

      // For non-vakantie drafts: load active vakantieperiode date ranges to skip
      // (vakantieconcepten mogen wel in vakantieperiodes schrijven, normale niet)
      const vakantieSkipRanges = [];
      if (!isVakantie) {
        try {
          const vakDrafts = await client.query(
            `SELECT holiday_period_id FROM schedule_drafts
             WHERE type = 'vakantie' AND last_applied_at IS NOT NULL
             AND (last_applied_until IS NULL OR last_applied_until >= $1::date)`,
            [effectiveStartDate]
          );
          if (vakDrafts.rows.length > 0) {
            const hpResult = await client.query(`SELECT value FROM settings WHERE key = 'holidayPeriods'`);
            const holidayPeriods = hpResult.rows.length > 0 ? (hpResult.rows[0].value || []) : [];
            for (const row of vakDrafts.rows) {
              const hp = holidayPeriods.find(p => String(p.id) === String(row.holiday_period_id));
              if (hp && hp.startDate && hp.endDate) {
                if (hp.endDate >= effectiveStartDate && hp.startDate <= effectiveEndDate) {
                  vakantieSkipRanges.push({ start: hp.startDate, end: hp.endDate });
                }
              }
            }
          }
        } catch (e) {
          console.log('Warning: could not load vakantie ranges for draft apply:', e.message);
        }
      }

      const startStr = formatDateYYYYMMDD(rangeStart);
      const endStr = formatDateYYYYMMDD(rangeEnd);

      // Split employees: in draft vs not in draft
      const empsInDraft = allEmployeesResult.rows.filter(emp =>
        Object.values(gridByWeek).some(weekGrid =>
          weekGrid && (weekGrid[String(emp.id)] || weekGrid[emp.id])
        )
      );
      const empsNotInDraft = allEmployeesResult.rows.filter(emp =>
        !Object.values(gridByWeek).some(weekGrid =>
          weekGrid && (weekGrid[String(emp.id)] || weekGrid[emp.id])
        )
      );
      empsInDraftForSync = empsInDraft;

      // ===== BULK DELETE: employees IN draft =====
      if (empsInDraft.length > 0) {
        const empIds = empsInDraft.map(e => e.id);
        const sourceFilter = effectiveConfirmOverwrite === true ? '' : ` AND source = 'auto'`;
        let bulkDeleteQuery = `DELETE FROM shifts WHERE user_id = ANY($1::int[])${sourceFilter} AND date >= $2::date AND date <= $3::date`;
        const bulkDeleteParams = [empIds, startStr, endStr];
        if (vakantieSkipRanges.length > 0) {
          vakantieSkipRanges.forEach((r) => {
            bulkDeleteQuery += ` AND NOT (date >= $${bulkDeleteParams.length + 1}::date AND date <= $${bulkDeleteParams.length + 2}::date)`;
            bulkDeleteParams.push(r.start, r.end);
          });
        }
        const bulkDeleteResult = await client.query(bulkDeleteQuery, bulkDeleteParams);
        totalDeleted += bulkDeleteResult.rowCount;

        // Bij een expliciete "overschrijf alles" (incl. vakantie) wist de
        // gebruiker bewust het hele venster terug naar het concept — dan
        // vervallen ook de manuele leegmakingen (#146). In de veilige
        // standaardmodus blijven blocks staan zodat manuele intentie wint.
        if (effectiveConfirmOverwrite === true) {
          let blockDelQuery = `DELETE FROM shift_blocks WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date`;
          const blockDelParams = [empIds, startStr, endStr];
          if (vakantieSkipRanges.length > 0) {
            vakantieSkipRanges.forEach((r) => {
              blockDelQuery += ` AND NOT (date >= $${blockDelParams.length + 1}::date AND date <= $${blockDelParams.length + 2}::date)`;
              blockDelParams.push(r.start, r.end);
            });
          }
          await client.query(blockDelQuery, blockDelParams);
        }
      }

      // ===== BULK SELECT: occupied dates, absences and blocks for employees IN draft =====
      const occupiedByEmp = {};
      const absencesByEmp = {};
      const blockedByEmp = {};
      if (empsInDraft.length > 0) {
        const empIds = empsInDraft.map(e => e.id);
        const occupiedResult = await client.query(
          `SELECT user_id, date::text as date FROM shifts WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date`,
          [empIds, startStr, endStr]
        );
        for (const row of occupiedResult.rows) {
          if (!occupiedByEmp[row.user_id]) occupiedByEmp[row.user_id] = new Set();
          occupiedByEmp[row.user_id].add(row.date);
        }
        const absencesResult = await client.query(
          `SELECT user_id, date::text as date FROM availability WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date AND type IS NOT NULL AND type != ''`,
          [empIds, startStr, endStr]
        );
        for (const row of absencesResult.rows) {
          if (!absencesByEmp[row.user_id]) absencesByEmp[row.user_id] = new Set();
          absencesByEmp[row.user_id].add(row.date);
        }
        // Manueel leeggemaakte cellen (#146): een block betekent "mens koos
        // bewust om deze dag leeg te laten" → concept vult hem niet opnieuw.
        const blocksResult = await client.query(
          `SELECT user_id, date::text as date FROM shift_blocks WHERE user_id = ANY($1::int[]) AND date >= $2::date AND date <= $3::date`,
          [empIds, startStr, endStr]
        );
        for (const row of blocksResult.rows) {
          if (!blockedByEmp[row.user_id]) blockedByEmp[row.user_id] = new Set();
          blockedByEmp[row.user_id].add(row.date);
        }
      }

      // ===== COMPUTE SHIFTS TO INSERT (pure JS, no DB calls) =====
      const insertRows = [];
      for (const emp of empsInDraft) {
        const occupiedDates = occupiedByEmp[emp.id] || new Set();
        const absenceDates = absencesByEmp[emp.id] || new Set();
        const blockedDates = blockedByEmp[emp.id] || new Set();
        let createdCount = 0;

        for (let d = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
             d <= rangeEnd;
             d.setDate(d.getDate() + 1)) {
          const dateStr = formatDateYYYYMMDD(d);

          if (occupiedDates.has(dateStr)) continue;
          if (absenceDates.has(dateStr)) continue;
          if (blockedDates.has(dateStr)) continue;
          if (closedDatesSet.has(dateStr)) continue;
          if (vakantieSkipRanges.some(r => dateStr >= r.start && dateStr <= r.end)) continue;

          // Calculate cycle week number for this date.
          //
          // Een vakantieconcept telt zijn weken vanaf de eerste maandag van de
          // vakantie — dat is wat de bouwer toont en wat de mens aanklikt
          // (getBuilderVakantieWeekStart). De modulo-berekening hieronder gaat
          // uit van een doorlopende cyclus vanaf een globale referentiedatum,
          // en die erft een vakantieconcept bij aanmaak. Daardoor kreeg week 1
          // van bv. de paasvakantie het rooster van week 2, en bij de zomer
          // schoof het hele rooster op. Basisroosters houden de cyclus.
          const currMonday = getMonday(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
          const ankerMonday = isVakantie ? getMonday(rangeStart) : refMonday;
          const diffMs = currMonday.getTime() - ankerMonday.getTime();
          const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
          const weekNumber = isVakantie
            ? diffWeeks + 1
            : ((diffWeeks % cycleLength) < 0 ? (diffWeeks % cycleLength) + cycleLength : (diffWeeks % cycleLength)) + 1;

          const weekGrid = gridByWeek[weekNumber];
          if (!weekGrid) continue;

          const empGrid = weekGrid[String(emp.id)] || weekGrid[emp.id];
          if (!empGrid) continue;

          // Map JS dayOfWeek (0=Sun) to grid dayIndex (0=Mon..6=Sun)
          const jsDow = d.getDay();
          const dayIndex = jsDow === 0 ? 6 : jsDow - 1;
          const assignment = empGrid[String(dayIndex)] || empGrid[dayIndex];
          if (!assignment) continue;

          // Een dag die in de bouwer gesloten is levert geen shift op. Je kan
          // zo'n dag daar niet invullen, dus een resterende gridcel komt van
          // vóór het sluiten en is onzichtbaar geworden — die mag niet alsnog
          // een dienst opleveren. Pas hier tellen, na de cel: anders telt de
          // teller gesloten dagen in plaats van onderdrukte diensten.
          if ((patternClosedDays[String(weekNumber)] || []).includes(jsDow)) {
            closedDaySkips++;
            continue;
          }

          insertRows.push({
            userId: emp.id,
            date: dateStr,
            startTime: assignment.startTime,
            endTime: assignment.endTime,
            team: assignment.team || emp.mainTeam,
            isReserve: !!assignment.isReserve
          });
          createdCount++;
        }

        if (createdCount > 0) {
          appliedCount++;
          totalCreated += createdCount;
        }
      }

      // ===== BULK INSERT =====
      // draft_id legt vast uit welk concept elke dienst komt, zodat uitplannen
      // en overlap-inkorting precies weten wat ze mogen verwijderen (#185, #187).
      // Postgres bindt maximaal 65.535 parameters per query, dus in blokken:
      // een volledig schooljaar met veertig medewerkers zit daar dicht tegenaan.
      if (insertRows.length > 0) {
        const COLS = 7;
        const CHUNK = Math.floor(60000 / COLS);
        for (let offset = 0; offset < insertRows.length; offset += CHUNK) {
          const chunk = insertRows.slice(offset, offset + CHUNK);
          const values = chunk.map((_, i) =>
            `($${i * COLS + 1}, $${i * COLS + 2}, $${i * COLS + 3}, $${i * COLS + 4}, $${i * COLS + 5}, 'auto', $${i * COLS + 6}, $${i * COLS + 7})`
          ).join(', ');
          const params = chunk.flatMap(r => [
            r.userId, r.date, r.startTime, r.endTime, r.team, r.isReserve, draftId
          ]);
          await client.query(
            `INSERT INTO shifts (user_id, date, start_time, end_time, team, source, is_reserve, draft_id) VALUES ${values}`,
            params
          );
        }
      }

      // ===== BULK DELETE: employees NOT in draft (auto-shifts only) =====
      // If an employee has no entry in the concept, clear their auto-shifts for this period.
      if (empsNotInDraft.length > 0) {
        const empIdsNotInDraft = empsNotInDraft.map(e => e.id);
        let delNotInDraftQuery = `DELETE FROM shifts WHERE user_id = ANY($1::int[]) AND source = 'auto' AND date >= $2::date AND date <= $3::date`;
        const delNotInDraftParams = [empIdsNotInDraft, startStr, endStr];
        if (vakantieSkipRanges.length > 0) {
          vakantieSkipRanges.forEach((r) => {
            delNotInDraftQuery += ` AND NOT (date >= $${delNotInDraftParams.length + 1}::date AND date <= $${delNotInDraftParams.length + 2}::date)`;
            delNotInDraftParams.push(r.start, r.end);
          });
        }
        const delNotInDraftResult = await client.query(delNotInDraftQuery, delNotInDraftParams);
        totalDeleted += delNotInDraftResult.rowCount;
        if (delNotInDraftResult.rowCount > 0) appliedCount++;
      }

    }

    // 3. Sync week_schedules op users vanuit het concept grid (read-only weergave voor medewerkers)
    //
    // #186: dit liep over ALLE actieve medewerkers en keek niet naar het soort
    // concept. Een vakantieconcept toepassen verving daardoor het vaste
    // jaarpatroon van iedereen door het vakantiepatroon, en wie niet in dat
    // vakantieraster stond raakte zijn basisrooster helemaal kwijt. De oude
    // waarde stond daarna nergens meer.
    //
    // Een vakantieconcept beschrijft een uitzondering van enkele weken, geen
    // weekpatroon, dus het hoort het basisrooster niet aan te raken. En ook een
    // basisconcept raakt alleen nog de medewerkers die er echt in staan: wie er
    // niet in voorkomt houdt wat hij had.
    const employeesToSync = isVakantie ? [] : empsInDraftForSync;
    for (const emp of employeesToSync) {
      const allWeeks = [];
      for (let weekNumber = 1; weekNumber <= cycleLength; weekNumber++) {
        const weekGrid = gridByWeek[weekNumber];
        const empGrid = weekGrid ? (weekGrid[String(emp.id)] || weekGrid[emp.id]) : null;
        const entries = [];
        if (empGrid) {
          for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
            const assignment = empGrid[String(dayIndex)] || empGrid[dayIndex];
            if (assignment) {
              const jsDayOfWeek = dayIndex === 6 ? 0 : dayIndex + 1;
              entries.push({
                dayOfWeek: jsDayOfWeek,
                enabled: true,
                startTime: assignment.startTime,
                endTime: assignment.endTime,
                team: assignment.team || emp.mainTeam
              });
            }
          }
        }
        allWeeks.push(entries);
      }
      await client.query(
        `UPDATE users SET week_schedules = $1::jsonb,
         week_schedule_week1 = $2::jsonb, week_schedule_week2 = $3::jsonb WHERE id = $4`,
        [JSON.stringify(allWeeks), JSON.stringify(allWeeks[0] || []),
         JSON.stringify(allWeeks[1] || []), emp.id]
      );
    }

    // 4. Auto-create vergadering activities from _teamMeetings
    const teamMeetings = rawGrid._teamMeetings || {};

    // Altijd de eigen vergaderingen van dit concept opruimen in dit bereik, ook
    // als het nieuwe concept er geen meer heeft (zomerconcept).
    //
    // #376: hier stond `DELETE ... WHERE type = 'vergadering' AND date BETWEEN`,
    // zonder filter op concept, team of medewerker. Dat wiste ook vergaderingen
    // die iemand met de hand had ingevoerd (dat type staat gewoon in de
    // keuzelijst van de activiteitenmodal) en die van teams waar het concept
    // niets mee te maken heeft. Vaak kwam er niets voor terug, want de
    // regeneratie draait alleen als het concept _teamMeetings heeft.
    //
    // Sinds migratie 038 draagt elke gegenereerde vergadering een draft_id, en
    // daar begrenzen we op. Niets anders wordt aangeraakt.
    //
    // Vergaderingen van vóór die migratie hebben geen draft_id, en er is geen
    // betrouwbare manier om te zien of zo'n rij door een concept is gemaakt of
    // door iemand met de hand: beide krijgen een shift_id en een vrije
    // omschrijving. Gokken op de omschrijving zou handmatig werk kunnen wissen,
    // en dat is precies het probleem dat hier wordt opgelost.
    //
    // Gevolg: vergaderingen die vóór deze migratie door een concept zijn
    // aangemaakt blijven staan, en bij een concept met teamvergaderingen kan er
    // daardoor één keer een dubbele verschijnen. Die is zichtbaar en met de
    // hand te verwijderen. Vanaf de eerstvolgende toepassing klopt het vanzelf.
    await client.query(
      `DELETE FROM shift_activities
        WHERE type = 'vergadering'
          AND draft_id = $3
          AND date >= $1::date AND date <= $2::date`,
      [effectiveStartDate, effectiveEndDate, draftId]
    );

    if (Object.keys(teamMeetings).length > 0) {

      // Check once if shift_id column exists (migration 020 might not have run yet)
      const shiftIdCheck = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'shift_activities' AND column_name = 'shift_id'`
      );
      const shiftIdExists = shiftIdCheck.rows.length > 0;

      // Find all auto-shifts just created in this range
      const newShiftsResult = await client.query(
        `SELECT s.id, s.user_id, s.date::text as date, s.start_time, s.end_time, u.main_team
         FROM shifts s JOIN users u ON s.user_id = u.id
         WHERE s.source = 'auto' AND s.date >= $1::date AND s.date <= $2::date`,
        [effectiveStartDate, effectiveEndDate]
      );

      for (const shift of newShiftsResult.rows) {
        const meetings = teamMeetings[shift.main_team] || [];
        if (meetings.length === 0) continue;

        const shiftDate = parseLocalDate(shift.date);
        if (!shiftDate) continue;
        const jsDow = shiftDate.getDay();
        const dayIndex = jsDow === 0 ? 6 : jsDow - 1; // Convert to builder dayIndex (0=ma..6=zo)

        // Parse shift times to decimal
        const [ssh, ssm] = shift.start_time.split(':').map(Number);
        const [seh, sem] = shift.end_time.split(':').map(Number);
        const shiftStartDec = ssh + ssm / 60;
        const shiftEndDec = seh + sem / 60;

        for (const m of meetings) {
          if (m.day !== dayIndex) continue;

          // Check overlap (meeting time vs shift time)
          const mFrom = m.from, mTo = m.to;
          let overlaps = false;
          if (shiftEndDec <= shiftStartDec) {
            // Night shift — meetings are always during day so check start portion
            overlaps = mFrom < 24 && mTo > shiftStartDec;
          } else {
            overlaps = mFrom < shiftEndDec && mTo > shiftStartDec;
          }

          if (overlaps) {
            const fromH = Math.floor(mFrom);
            const fromM = Math.round((mFrom - fromH) * 60);
            const toH = Math.floor(mTo);
            const toM = Math.round((mTo - toH) * 60);
            const fromTime = `${String(fromH).padStart(2, '0')}:${String(fromM).padStart(2, '0')}`;
            const toTime = `${String(toH).padStart(2, '0')}:${String(toM).padStart(2, '0')}`;

            // draft_id legt vast dat deze vergadering uit dit concept komt,
            // zodat de opruiming hierboven hem later kan onderscheiden van een
            // handmatig ingevoerde (#376).
            if (shiftIdExists) {
              await client.query(
                `INSERT INTO shift_activities (user_id, shift_id, date, start_time, end_time, type, description, draft_id)
                 VALUES ($1, $2, $3, $4, $5, 'vergadering', 'Teamvergadering', $6)`,
                [shift.user_id, shift.id, shift.date, fromTime, toTime, draftId]
              );
            } else {
              await client.query(
                `INSERT INTO shift_activities (user_id, date, start_time, end_time, type, description, draft_id)
                 VALUES ($1, $2, $3, $4, 'vergadering', 'Teamvergadering', $5)`,
                [shift.user_id, shift.date, fromTime, toTime, draftId]
              );
            }
          }
        }
      }
    }

    // 3b. Gesloten dagen van een VAKANTIEconcept vastleggen als absolute datums.
    //
    // Een basisrooster schrijft zijn patroon naar settings.schedule_pattern en
    // dan weet isDayClosed() ervan. Een vakantieconcept doet dat bewust niet —
    // zijn cyclus is vakantie-relatief en zou het jaarpatroon verzieken. Zonder
    // deze stap wist de planning dus niets van een gesloten vakantiedag: hij
    // werd niet gearceerd en je kon er gewoon shifts in zetten.
    //
    // Ze staan apart van settings.closedDates (dat blijft van de gebruiker):
    // deze horen bij hun concept en worden bij elke toepassing vervangen.
    if (isVakantie) {
      const uitConcept = [];
      const vakStart = parseLocalDate(effectiveStartDate);
      const vakEind = parseLocalDate(effectiveEndDate);
      const vakMonday = getMonday(vakStart);
      for (let d = new Date(vakStart.getFullYear(), vakStart.getMonth(), vakStart.getDate());
           d <= vakEind; d.setDate(d.getDate() + 1)) {
        const currMonday = getMonday(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
        const diffWeeks = Math.round((currMonday.getTime() - vakMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
        if ((patternClosedDays[String(diffWeeks + 1)] || []).includes(d.getDay())) {
          uitConcept.push({ date: formatDateYYYYMMDD(d), reason: draft.name, draftId });
        }
      }
      const huidigRes = await client.query(`SELECT value FROM settings WHERE key = 'conceptClosedDates'`);
      const behouden = (huidigRes.rows[0]?.value || []).filter(c => String(c.draftId) !== String(draftId));
      const nieuweLijst = [...behouden, ...uitConcept].sort((a, b) => a.date.localeCompare(b.date));
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('conceptClosedDates', $1::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
        [JSON.stringify(nieuweLijst)]
      );
      conceptClosedCount = uitConcept.length;
    }

    // 4. Mark draft as applied (including the date range that was applied)
    await client.query(
      `UPDATE schedule_drafts SET last_applied_at = NOW(), last_applied_by = $1,
       last_applied_from = $2, last_applied_until = $3, updated_at = NOW() WHERE id = $4`,
      [req.user.name, effectiveStartDate || null, effectiveEndDate || null, draftId]
    );

    await client.query('COMMIT');

    // Audit log (outside transaction)
    const appliedWeekNumbers = weeksToApply.map(w => w.weekNumber);
    await logAudit(req, 'UPDATE', 'settings', draftId, {
      type: 'draft_apply',
      draftName: draft.name,
      weekNumbers: appliedWeekNumbers,
      employeesApplied: appliedCount,
      shiftsCreated: totalCreated,
      shiftsDeleted: totalDeleted,
      closedDaySkips,
      clearBlocks
    });

    res.json({
      applied: appliedCount,
      shifts: { created: totalCreated, deleted: totalDeleted },
      draftName: draft.name,
      weekNumbers: appliedWeekNumbers,
      manualShiftsPreserved: preservedManualCount,
      // Aantal keer dat een gridcel niet is uitgevoerd omdat die dag in het
      // concept gesloten staat. Zichtbaar maken, niet stil overslaan.
      closedDaySkips,
      conceptClosedCount,
      // #211: het anker waarmee de diensten daadwerkelijk gegenereerd zijn.
      // De frontend publiceert dit in schedule_pattern in plaats van er zelf
      // een te berekenen, zodat rooster en weergave dezelfde fase aanhouden.
      referenceDate,
      cycleLength
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /schedule-drafts/:id/apply error:', err);
    res.status(500).json({ error: 'Server error bij concept toepassen', detail: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// ===== AUDIT LOG API =====

v1.get('/shifts/archived', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { userId, startDate, endDate } = req.query;
  try {
    const params = [];
    let where = 'WHERE archived = true';
    if (userId) { params.push(userId); where += ` AND user_id = $${params.length}`; }
    if (startDate) { params.push(startDate); where += ` AND date >= $${params.length}`; }
    if (endDate) { params.push(endDate); where += ` AND date <= $${params.length}`; }
    const result = await pool.query(
      `SELECT id, user_id as "userId", team, date::text, start_time as "startTime", end_time as "endTime", notes, source
       FROM shifts ${where} ORDER BY date DESC LIMIT 500`,
      params
    );
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.get('/audit-log', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { page = 1, limit = 50, actorId, action, resourceType, startDate, endDate } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  let whereClause = 'WHERE 1=1';
  const params = [];
  let paramIndex = 1;

  if (actorId) { whereClause += ` AND actor_id = $${paramIndex++}`; params.push(Number(actorId)); }
  if (action) { whereClause += ` AND action = $${paramIndex++}`; params.push(action); }
  if (resourceType) { whereClause += ` AND resource_type = $${paramIndex++}`; params.push(resourceType); }
  if (startDate) { whereClause += ` AND created_at >= $${paramIndex++}`; params.push(startDate); }
  if (endDate) { whereClause += ` AND created_at <= $${paramIndex++}::date + interval '1 day'`; params.push(endDate); }

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM audit_log ${whereClause}`, params);
    const total = parseInt(countResult.rows[0].count);

    params.push(Number(limit), offset);
    const result = await pool.query(
      `SELECT * FROM audit_log ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    res.json({ logs: result.rows, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('GET /audit-log error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== DATA IMPORT API =====

// Backup terugzetten.
//
// Draait in één transactie, met een SAVEPOINT per item (#214). Zonder
// transactie bleef bij een halverwege afgebroken import de helft staan.
// De savepoints houden het bestaande gedrag intact: een rij die niet
// deugt wordt overgeslagen en gemeld, de rest gaat gewoon door. Zonder
// savepoint zou de eerste fout de hele transactie in aborted-toestand
// zetten en zou alles erna alsnog falen.
v1.post('/import', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { users, shifts, availability, settings } = req.body || {};
  const results = { imported: 0, skipped: 0, errors: [] };
  const isAdmin = req.user.role === 'admin';

  const client = await pool.connect();
  // Voert één item uit binnen een savepoint. Faalt het, dan rolt alleen dat
  // item terug en blijft de transactie bruikbaar voor de volgende.
  async function perItem(label, fn) {
    await client.query('SAVEPOINT item');
    try {
      await fn();
      await client.query('RELEASE SAVEPOINT item');
      results.imported++;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT item').catch(() => {});
      results.errors.push({ ...label, error: err.message });
      results.skipped++;
    }
  }

  try {
    await client.query('BEGIN');

    // Import users (with schedule data)
    if (Array.isArray(users)) {
      // Eén keer hashen voor nieuwe users — voorkomt timeout bij bulk-import
      // op beperkte CPU (bv. gratis Render plan). Bestaande users worden
      // geüpdatet zonder nieuw wachtwoord; nieuwe krijgen dit hash (#staging).
      const defaultPasswordHash = users.some(u => u.email) ? await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12) : null;

      for (const user of users) {
        await perItem({ name: user.name }, async () => {
          // Validate team exists if specified
          let mainTeam = user.mainTeam || null;
          if (mainTeam) {
            const teamCheck = await client.query('SELECT id FROM teams WHERE id = $1', [mainTeam]);
            if (teamCheck.rows.length === 0) mainTeam = null;
          }

          const week1Json = JSON.stringify(user.weekScheduleWeek1 || []);
          const week2Json = JSON.stringify(user.weekScheduleWeek2 || []);
          const wsJson = Array.isArray(user.weekSchedules) && user.weekSchedules.length > 0
            ? JSON.stringify(user.weekSchedules)
            : JSON.stringify([user.weekScheduleWeek1 || [], user.weekScheduleWeek2 || []]);

          const existing = await client.query(
            'SELECT id, role, active FROM users WHERE email = $1',
            [user.email?.toLowerCase()]
          );

          if (existing.rows.length > 0) {
            const huidig = existing.rows[0];

            // #200: de import werkte ook `active` bij, en stond open voor een
            // roosterverantwoordelijke. Die kon daarmee het adminaccount
            // deactiveren en zichzelf de hoogste autoriteit maken, terwijl de
            // rollentabel zegt: geen accountbeheer. Alleen een admin mag de
            // actief-vlag nog zetten; voor de rest blijft die ongemoeid.
            const nieuwActief = isAdmin ? (user.active !== false) : huidig.active;

            // Het laatste actieve adminaccount mag door niemand worden
            // uitgeschakeld, ook niet door een andere admin. Anders sluit de
            // organisatie zichzelf buiten en is er geen weg terug via de app.
            if (huidig.role === 'admin' && huidig.active && nieuwActief === false) {
              const anderen = await client.query(
                `SELECT COUNT(*)::int AS n FROM users
                 WHERE role = 'admin' AND active = true AND id != $1`,
                [huidig.id]
              );
              if (anderen.rows[0].n === 0) {
                throw new Error('Het laatste actieve beheerdersaccount kan niet gedeactiveerd worden');
              }
            }

            // #214: team_id ontbrak hier, terwijl main_team wel werd
            // bijgewerkt. Een backup die iemand van team verandert liet die
            // twee scheef achter, en dan wijst de app hem in het ene team aan
            // terwijl de autorisatie hem nog in het andere plaatst
            // (CLAUDE.md regel 2). De import is juist het herstelpad, dus dat
            // is de slechtst denkbare plek om rechten stuk te maken.
            await client.query(`
              UPDATE users SET
                name = $1,
                main_team = $2,
                team_id = $2,
                contract_hours = $3,
                active = $4,
                week_schedule_week1 = $5::jsonb,
                week_schedule_week2 = $6::jsonb,
                week_schedules = $7::jsonb
              WHERE email = $8
            `, [
              user.name, mainTeam, user.contractHours || 0, nieuwActief,
              week1Json, week2Json, wsJson, user.email.toLowerCase()
            ]);
          } else if (user.email) {
            // Create new user with default password (hash berekend vóór de loop).
            // De rol staat vast op 'medewerker': een import mag geen beheerders
            // aanmaken, ook niet als het bestand dat beweert (#200).
            await client.query(`
              INSERT INTO users (name, email, password_hash, role, team_id, main_team, contract_hours, active, week_schedule_week1, week_schedule_week2, week_schedules)
              VALUES ($1, $2, $3, 'medewerker', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
            `, [
              user.name, user.email.toLowerCase(), defaultPasswordHash,
              mainTeam, mainTeam, user.contractHours || 0,
              isAdmin ? (user.active !== false) : true,
              week1Json, week2Json, wsJson
            ]);
          } else {
            throw new Error('Email is required');
          }
        });
      }
    }

    // Import shifts
    if (Array.isArray(shifts)) {
      for (const shift of shifts) {
        await perItem({ shift: shift.date }, async () => {
          await client.query(`
            INSERT INTO shifts (user_id, team, date, start_time, end_time, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [shift.userId, shift.team || null, shift.date, shift.startTime, shift.endTime, shift.notes || '']);
        });
      }
    }

    // Import availability
    if (Array.isArray(availability)) {
      for (const avail of availability) {
        await perItem({ availability: avail.date }, async () => {
          await client.query(`
            INSERT INTO availability (user_id, date, type, reason, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (user_id, date) DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
          `, [avail.userId, avail.date, avail.type, avail.reason || '']);
        });
      }
    }

    // #217: settings werden wel uitgelezen uit de body maar nergens gebruikt.
    // Wie na een reset een backup terugzette, kreeg zijn vakantieperiodes,
    // gesloten dagen, roosterregels en dienstsjablonen niet terug, terwijl de
    // knop wel "backup" heet.
    //
    // Een object per sleutel, want zo staat het ook in de settings-tabel.
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const [key, value] of Object.entries(settings)) {
        if (value === undefined) continue;
        await perItem({ setting: key }, async () => {
          await client.query(`
            INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()
          `, [key, JSON.stringify(value)]);
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /import error:', err);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }

  await logAudit(req, 'IMPORT', 'system', '', { imported: results.imported, skipped: results.skipped, errorCount: results.errors.length });
  res.json({ ok: true, results });
});

// ===== VERLOFPLANNING (verlofrondes) =====
// Vervangt de gedeelde Excel. Twee modi:
//   'binair'   → kleine vakanties: werken / verlof
//   'voorkeur' → zomer: werken / liever_niet / zeker_niet
// De matrix is voor iedereen zichtbaar (zoals de gedeelde Excel), maar
// invullen mag je enkel voor jezelf — tenzij je de ronde beheert.

const LEAVE_MANAGER_ROLES = ['admin', 'roosterverantwoordelijke'];

// Gesloten dagen van een verlofblok. De frontend leidt ze af uit het
// vakantieconcept en stuurt ze mee; hier controleren we enkel dat het
// geldige datums binnen het blok zijn. `undefined`/`null` blijft "onbekend".
function normalizeClosedDates(waarde, startDate, endDate, blokNaam) {
  if (waarde === undefined || waarde === null) return { ok: true, value: null };
  if (!Array.isArray(waarde)) {
    return { ok: false, error: `Gesloten dagen bij "${blokNaam}" moeten een lijst zijn` };
  }
  const uniek = new Set();
  for (const d of waarde) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { ok: false, error: `Ongeldige gesloten dag bij "${blokNaam}"` };
    }
    if (d < startDate || d > endDate) {
      return { ok: false, error: `Gesloten dag ${d} valt buiten "${blokNaam}"` };
    }
    uniek.add(d);
  }
  return { ok: true, value: [...uniek].sort() };
}
const isLeaveManager = (user) => LEAVE_MANAGER_ROLES.includes(user?.role);

// Kolommen van een ronde. De alias is nodig zodra er gejoind wordt: zowel
// leave_rounds als leave_round_submissions hebben een kolom `id`.
const roundSelect = (a = '') => {
  const p = a ? `${a}.` : '';
  return `
  ${p}id, ${p}name, ${p}mode, ${p}start_date::text AS "startDate", ${p}end_date::text AS "endDate",
  ${p}deadline::text AS deadline, ${p}status, ${p}holiday_period_id AS "holidayPeriodId",
  ${p}rules, ${p}created_by AS "createdBy", ${p}created_at AS "createdAt", ${p}updated_at AS "updatedAt"`;
};
const ROUND_SELECT = roundSelect();

// Alle rondes (iedereen mag ze zien; concepten enkel voor beheerders).
// Bevat meteen wat de overzichtskaarten nodig hebben, zodat die niet elke
// ronde apart hoeven op te halen.
v1.get('/leave-rounds', requireAuth, async (req, res) => {
  try {
    const showConcepts = isLeaveManager(req.user);
    const result = await pool.query(
      `SELECT ${roundSelect('r')},
              (SELECT COUNT(*) FROM leave_round_blocks b WHERE b.round_id = r.id)::int AS "blockCount",
              (SELECT COUNT(*) FROM leave_round_submissions s
                WHERE s.round_id = r.id AND s.submitted_at IS NOT NULL)::int AS "submittedCount",
              ms.submitted_at AS "mySubmittedAt",
              ms.approved     AS "myApproved"
       FROM leave_rounds r
       LEFT JOIN leave_round_submissions ms ON ms.round_id = r.id AND ms.user_id = $1
       ${showConcepts ? '' : `WHERE r.status <> 'concept'`}
       ORDER BY r.start_date DESC`,
      [req.user.id]
    );
    res.json({ rounds: result.rows });
  } catch (err) {
    console.error('Error fetching leave rounds:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Eén ronde met de volledige matrix (alle medewerkers) + indienstatus
v1.get('/leave-rounds/:id', requireAuth, async (req, res) => {
  try {
    const roundRes = await pool.query(`SELECT ${ROUND_SELECT} FROM leave_rounds WHERE id = $1`, [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    const round = roundRes.rows[0];
    if (round.status === 'concept' && !isLeaveManager(req.user)) {
      return res.status(403).json({ error: 'Deze ronde is nog niet geopend' });
    }

    const [entries, subs, blocks] = await Promise.all([
      pool.query(
        `SELECT user_id AS "userId", date::text AS date, status, note
         FROM leave_round_entries WHERE round_id = $1`, [req.params.id]),
      pool.query(
        `SELECT s.user_id AS "userId", s.submitted_at AS "submittedAt", s.approved,
                s.approved_by AS "approvedBy", s.approved_at AS "approvedAt",
                s.response_note AS "responseNote", u.name AS "userName"
         FROM leave_round_submissions s JOIN users u ON u.id = s.user_id
         WHERE s.round_id = $1`, [req.params.id]),
      pool.query(
        `SELECT id, name, mode, start_date::text AS "startDate", end_date::text AS "endDate",
                holiday_period_id AS "holidayPeriodId", sort_order AS "sortOrder",
                closed_dates AS "closedDates", closed_source AS "closedSource"
         FROM leave_round_blocks WHERE round_id = $1 ORDER BY sort_order, start_date`, [req.params.id]),
    ]);
    res.json({ round, blocks: blocks.rows, entries: entries.rows, submissions: subs.rows });
  } catch (err) {
    console.error('Error fetching leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Een ronde wordt aangemaakt mét zijn blokken (de vakanties van het
// schooljaar). De ronde-datums zijn de omhullende van die blokken.
v1.post('/leave-rounds', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { name, deadline, rules, status, blocks } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: 'Kies minstens één vakantieperiode' });
  }
  for (const b of blocks) {
    if (!b || !b.name || !b.startDate || !b.endDate) {
      return res.status(400).json({ error: 'Elk blok heeft een naam, start- en einddatum nodig' });
    }
    if (b.mode && !['binair', 'voorkeur'].includes(b.mode)) {
      return res.status(400).json({ error: 'Ongeldige modus' });
    }
    if (new Date(b.endDate) < new Date(b.startDate)) {
      return res.status(400).json({ error: `Einddatum ligt voor de startdatum bij "${b.name}"` });
    }
    const cd = normalizeClosedDates(b.closedDates, b.startDate, b.endDate, b.name);
    if (!cd.ok) return res.status(400).json({ error: cd.error });
    b._closedDates = cd.value;
  }

  const startDate = blocks.reduce((m, b) => (b.startDate < m ? b.startDate : m), blocks[0].startDate);
  const endDate   = blocks.reduce((m, b) => (b.endDate   > m ? b.endDate   : m), blocks[0].endDate);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO leave_rounds (name, mode, start_date, end_date, deadline, status, rules, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING ${ROUND_SELECT}`,
      [name, blocks[0].mode || 'binair', startDate, endDate, deadline || null,
       status === 'concept' ? 'concept' : 'open', JSON.stringify(rules || {}), req.user.id]
    );
    const round = result.rows[0];
    let i = 0;
    for (const b of blocks) {
      await client.query(
        `INSERT INTO leave_round_blocks (round_id, name, mode, start_date, end_date, holiday_period_id, sort_order, closed_dates, closed_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
        [round.id, b.name, b.mode || 'binair', b.startDate, b.endDate, b.holidayPeriodId || null, i++,
         b._closedDates === null ? null : JSON.stringify(b._closedDates),
         JSON.stringify(b._closedDates === null ? {} : (b.closedSource || {}))]
      );
    }
    await client.query('COMMIT');
    await logAudit(req, 'CREATE', 'settings', String(round.id), { type: 'leave_round', name, blocks: blocks.length });
    res.json({ round });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error creating leave round:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.put('/leave-rounds/:id', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { name, mode, startDate, endDate, deadline, status, holidayPeriodId, rules } = req.body || {};
  if (status && !['concept', 'open', 'gesloten', 'toegepast'].includes(status)) {
    return res.status(400).json({ error: 'Ongeldige status' });
  }
  try {
    const result = await pool.query(
      `UPDATE leave_rounds SET
         name = COALESCE($2, name), mode = COALESCE($3, mode),
         start_date = COALESCE($4, start_date), end_date = COALESCE($5, end_date),
         deadline = $6, status = COALESCE($7, status),
         holiday_period_id = COALESCE($8, holiday_period_id),
         rules = COALESCE($9::jsonb, rules), updated_at = NOW()
       WHERE id = $1 RETURNING ${ROUND_SELECT}`,
      [req.params.id, name || null, mode || null, startDate || null, endDate || null,
       deadline === undefined ? null : deadline, status || null, holidayPeriodId || null,
       rules ? JSON.stringify(rules) : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    await logAudit(req, 'UPDATE', 'settings', req.params.id, { type: 'leave_round', status });
    res.json({ round: result.rows[0] });
  } catch (err) {
    console.error('Error updating leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Weekends van één blok opnieuw overnemen uit het roosterconcept. Bewust een
// aparte, expliciete actie: een concept dat na het openen van de ronde wijzigt
// mag de grondslag waarop mensen invulden niet stilzwijgend verschuiven.
v1.put('/leave-rounds/:id/blocks/:blockId', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { closedDates, closedSource } = req.body || {};
  const client = await pool.connect();
  try {
    const blokRes = await client.query(
      `SELECT b.id, b.name, b.start_date::text AS "startDate", b.end_date::text AS "endDate",
              b.closed_dates AS "closedDates", r.status
       FROM leave_round_blocks b JOIN leave_rounds r ON r.id = b.round_id
       WHERE b.id = $1 AND b.round_id = $2`,
      [req.params.blockId, req.params.id]
    );
    if (blokRes.rows.length === 0) return res.status(404).json({ error: 'Blok niet gevonden in deze ronde' });
    const blok = blokRes.rows[0];

    // Een gesloten of toegepaste ronde herschrijven raakt afspraken die al
    // goedgekeurd zijn — dat mag alleen bewust.
    if (['gesloten', 'toegepast'].includes(blok.status) && req.query.force !== '1') {
      return res.status(409).json({
        error: 'Deze ronde is al gesloten. Bevestig dat je de weekendindeling toch wil aanpassen.',
        status: blok.status
      });
    }

    const cd = normalizeClosedDates(closedDates, blok.startDate, blok.endDate, blok.name);
    if (!cd.ok) return res.status(400).json({ error: cd.error });

    await client.query('BEGIN');
    await client.query(
      `UPDATE leave_round_blocks SET closed_dates = $1::jsonb, closed_source = $2::jsonb WHERE id = $3`,
      [cd.value === null ? null : JSON.stringify(cd.value),
       JSON.stringify(cd.value === null ? {} : (closedSource || {})), blok.id]
    );

    // Invulling op een dag die nu gesloten is moet weg: anders zet `apply`
    // daar alsnog verlof op, en telt die dag mee in latere weekendtellingen.
    let entriesRemoved = 0;
    if (cd.value && cd.value.length > 0) {
      const del = await client.query(
        `DELETE FROM leave_round_entries WHERE round_id = $1 AND date = ANY($2::date[])`,
        [req.params.id, cd.value]
      );
      entriesRemoved = del.rowCount || 0;
    }
    await client.query('COMMIT');

    await logAudit(req, 'UPDATE', 'settings', String(req.params.id), {
      type: 'leave_block_closed_dates', blockId: blok.id,
      closed: cd.value ? cd.value.length : null, entriesRemoved
    });
    res.json({ block: { id: blok.id, closedDates: cd.value, closedSource: closedSource || {} }, entriesRemoved });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating leave block:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// De definitieve verdeling van een voorkeurblok (de zomer) vastleggen.
//
// Bewust NIET via PUT /leave-rounds/:id/entries: dat vervangt alle entries van
// een gebruiker in de héle ronde, en een ronde beslaat het volledige schooljaar.
// Dit endpoint blijft binnen één blok en raakt de kleine vakanties dus nooit.
v1.put('/leave-rounds/:id/blocks/:blockId/entries', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { entries } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries moet een array zijn' });

  const client = await pool.connect();
  try {
    const blokRes = await client.query(
      `SELECT b.id, b.name, b.start_date::text AS "startDate", b.end_date::text AS "endDate", r.status
       FROM leave_round_blocks b JOIN leave_rounds r ON r.id = b.round_id
       WHERE b.id = $1 AND b.round_id = $2`,
      [req.params.blockId, req.params.id]
    );
    if (blokRes.rows.length === 0) return res.status(404).json({ error: 'Blok niet gevonden in deze ronde' });
    const blok = blokRes.rows[0];

    // Bij een open ronde kunnen medewerkers hun invulling nog wijzigen; een
    // verdeling zou dan stil overschreven worden.
    //
    // #201: 'toegepast' hoort hier ook bij. Die reden geldt daar namelijk net
    // zo min als bij 'gesloten', want de ronde staat voor medewerkers dicht.
    // Wie per ongeluk toepaste vóór het verdelen, liep anders vast: de
    // verdeling werd geweigerd met een 409 en er was geen weg vooruit. Nu kan
    // hij alsnog verdelen en daarna opnieuw toepassen.
    if (blok.status !== 'gesloten' && blok.status !== 'toegepast') {
      return res.status(409).json({
        error: 'De verdeling kan pas vastgelegd worden als de ronde gesloten is',
        status: blok.status
      });
    }

    const valid = ['werken', 'verlof', 'liever_niet', 'zeker_niet'];
    const userIds = new Set();
    for (const e of entries) {
      if (!e || !Number.isInteger(Number(e.userId))) {
        return res.status(400).json({ error: 'Elke regel heeft een geldige userId nodig' });
      }
      if (typeof e.date !== 'string' || e.date < blok.startDate || e.date > blok.endDate) {
        return res.status(400).json({ error: `Datum ${e.date} valt buiten "${blok.name}"` });
      }
      if (!valid.includes(e.status)) {
        return res.status(400).json({ error: `Ongeldige status ${e.status}` });
      }
      userIds.add(Number(e.userId));
    }

    await client.query('BEGIN');
    if (userIds.size > 0) {
      await client.query(
        `DELETE FROM leave_round_entries
         WHERE round_id = $1 AND user_id = ANY($2::int[]) AND date BETWEEN $3 AND $4`,
        [req.params.id, [...userIds], blok.startDate, blok.endDate]
      );
      for (const e of entries) {
        await client.query(
          `INSERT INTO leave_round_entries (round_id, user_id, date, status)
           VALUES ($1, $2, $3, $4)`,
          [req.params.id, Number(e.userId), e.date, e.status]
        );
      }
    }
    await client.query('COMMIT');

    await logAudit(req, 'UPDATE', 'settings', String(req.params.id), {
      type: 'leave_block_verdeling', blockId: blok.id,
      medewerkers: userIds.size, dagen: entries.length
    });
    res.json({ ok: true, saved: entries.length, medewerkers: userIds.size });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error saving leave distribution:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.delete('/leave-rounds/:id', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM leave_rounds WHERE id = $1 RETURNING name', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    await logAudit(req, 'DELETE', 'settings', req.params.id, { type: 'leave_round', name: result.rows[0].name });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Invulling opslaan. Medewerkers enkel voor zichzelf; beheerders ook voor
// anderen (nodig om na een voorkeurronde de definitieve verdeling vast te leggen).
v1.put('/leave-rounds/:id/entries', requireAuth, async (req, res) => {
  const { entries, userId } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries moet een array zijn' });

  const targetUserId = userId && isLeaveManager(req.user) ? Number(userId) : req.user.id;
  if (userId && Number(userId) !== req.user.id && !isLeaveManager(req.user)) {
    return res.status(403).json({ error: 'Je kan enkel je eigen verlof invullen' });
  }

  const client = await pool.connect();
  try {
    const roundRes = await client.query('SELECT status, start_date, end_date FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    const round = roundRes.rows[0];
    // Een gesloten ronde is enkel nog door beheerders aan te passen
    if (round.status !== 'open' && !isLeaveManager(req.user)) {
      return res.status(403).json({ error: 'Deze ronde is gesloten' });
    }

    const valid = ['werken', 'verlof', 'liever_niet', 'zeker_niet'];
    // Een ronde beslaat een heel schooljaar met gaten ertussen (schoolweken).
    // Een dag moet dus binnen een van de vakantieblokken vallen, niet enkel
    // tussen de omhullende rondedatums.
    const blockRes = await client.query(
      'SELECT start_date, end_date FROM leave_round_blocks WHERE round_id = $1', [req.params.id]);
    const blokken = blockRes.rows.length
      ? blockRes.rows.map(b => [new Date(b.start_date), new Date(b.end_date)])
      : [[new Date(round.start_date), new Date(round.end_date)]];

    for (const e of entries) {
      if (!e || !e.date || !valid.includes(e.status)) {
        return res.status(400).json({ error: `Ongeldige invulling voor ${e && e.date}` });
      }
      const d = new Date(e.date);
      if (!blokken.some(([s, t]) => d >= s && d <= t)) {
        return res.status(400).json({ error: `Datum ${e.date} valt buiten de ronde` });
      }
    }

    await client.query('BEGIN');

    // #194: dit verving ALLE invulling van deze medewerker in de hele ronde,
    // ook die van vakanties waar de aanvraag niet over ging. De app stuurt
    // altijd de volledige ronde mee, dus via de knoppen ging er niets verloren,
    // maar elke andere aanroep kon iemands zomervoorkeuren wissen door één
    // kerstweek op te slaan. Het blok-scoped endpoint begrenst wel al netjes.
    //
    // De vervanging blijft nu binnen het bereik dat in de aanvraag zit. Een
    // lege lijst raakt dus niets aan, wat ook de eerdere fix bewaart dat leeg
    // indienen de invulling niet mag wissen.
    const datums = entries.map(e => e.date).sort();
    if (datums.length > 0) {
      await client.query(
        `DELETE FROM leave_round_entries
         WHERE round_id = $1 AND user_id = $2 AND date BETWEEN $3 AND $4`,
        [req.params.id, targetUserId, datums[0], datums[datums.length - 1]]
      );
    }

    for (const e of entries) {
      await client.query(
        `INSERT INTO leave_round_entries (round_id, user_id, date, status, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.params.id, targetUserId, e.date, e.status, e.note || '']
      );
    }

    // #194: een wijziging ná de goedkeuring liet die goedkeuring gewoon staan,
    // met de oorspronkelijke datum. De beheerder zag in het overzicht nog
    // altijd "goedgekeurd" zonder enig signaal dat er daarna iets veranderd
    // was, en apply nam over wat er op dat moment stond.
    //
    // Elke wijziging trekt de goedkeuring nu in, precies zoals submit dat al
    // deed. De medewerker moet dus opnieuw indienen en de beheerder opnieuw
    // beslissen. Een beheerder die voor iemand anders invult raakt zijn eigen
    // goedkeuring niet kwijt, want targetUserId bepaalt wiens rij het is.
    await client.query(
      `INSERT INTO leave_round_submissions (round_id, user_id) VALUES ($1, $2)
       ON CONFLICT (round_id, user_id)
       DO UPDATE SET approved = NULL, approved_by = NULL, approved_at = NULL`,
      [req.params.id, targetUserId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, saved: entries.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error saving leave entries:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Indienen (medewerker bevestigt zijn invulling)
v1.post('/leave-rounds/:id/submit', requireAuth, async (req, res) => {
  try {
    const roundRes = await pool.query('SELECT status FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    if (roundRes.rows[0].status !== 'open') return res.status(403).json({ error: 'Deze ronde is gesloten' });

    await pool.query(
      `INSERT INTO leave_round_submissions (round_id, user_id, submitted_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (round_id, user_id)
       DO UPDATE SET submitted_at = NOW(), approved = NULL, approved_by = NULL, approved_at = NULL`,
      [req.params.id, req.user.id]
    );
    await logAudit(req, 'UPDATE', 'settings', req.params.id, { type: 'leave_round_submit' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error submitting leave round:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Goedkeuren of afwijzen van één medewerker binnen een ronde
v1.put('/leave-rounds/:id/submissions/:userId', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const { approved, responseNote } = req.body || {};
  if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved moet true of false zijn' });
  try {
    const result = await pool.query(
      `INSERT INTO leave_round_submissions (round_id, user_id, approved, approved_by, approved_at, response_note)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (round_id, user_id)
       DO UPDATE SET approved = $3, approved_by = $4, approved_at = NOW(), response_note = $5
       RETURNING user_id AS "userId", approved`,
      [req.params.id, req.params.userId, approved, req.user.id, responseNote || '']
    );
    await logAudit(req, approved ? 'APPROVE' : 'REJECT', 'settings', req.params.id,
      { type: 'leave_round', targetUser: req.params.userId });
    res.json({ submission: result.rows[0] });
  } catch (err) {
    console.error('Error updating leave submission:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toepassen: goedgekeurd verlof wordt echte afwezigheid, zodat het in de
// planning en het afwezigheidsoverzicht verschijnt.
v1.post('/leave-rounds/:id/apply', requireAuth, requireRole(...LEAVE_MANAGER_ROLES), async (req, res) => {
  const client = await pool.connect();
  try {
    const roundRes = await client.query('SELECT name FROM leave_rounds WHERE id = $1', [req.params.id]);
    if (roundRes.rows.length === 0) return res.status(404).json({ error: 'Ronde niet gevonden' });
    const roundName = roundRes.rows[0].name;

    // #201: apply neemt alleen dagen met status 'verlof' over, maar in een
    // voorkeurblok staat op dat moment uitsluitend werken, liever_niet of
    // zeker_niet. Wie op 'Verlof toepassen' drukte vóór 'Verlof verdelen',
    // kreeg dus nul zomerdagen terwijl de melding als succes las, en beide
    // knoppen verdwenen omdat die alleen bij status 'gesloten' verschijnen.
    //
    // We weigeren nu zolang een voorkeurblok nog niets op 'verlof' heeft
    // staan. Een blok waarin niemand verlof kreeg is ononderscheidbaar van
    // een onverdeeld blok, maar dat is een randgeval dat in de praktijk niet
    // voorkomt: er wordt altijd iemand ingewilligd.
    const onverdeeld = await client.query(
      `SELECT b.id, b.name
         FROM leave_round_blocks b
        WHERE b.round_id = $1
          AND b.mode = 'voorkeur'
          AND NOT EXISTS (
            SELECT 1 FROM leave_round_entries e
             WHERE e.round_id = b.round_id
               AND e.status = 'verlof'
               AND e.date BETWEEN b.start_date AND b.end_date
          )`,
      [req.params.id]
    );
    if (onverdeeld.rows.length > 0) {
      const namen = onverdeeld.rows.map(b => b.name).join(', ');
      return res.status(409).json({
        error: `Leg eerst de verdeling vast voor: ${namen}. Zonder verdeling levert het toepassen voor die vakantie geen enkele verlofdag op.`,
        undistributedBlocks: onverdeeld.rows.map(b => ({ id: b.id, name: b.name }))
      });
    }

    // Enkel dagen met status 'verlof' van goedgekeurde medewerkers
    const rows = await client.query(
      `SELECT e.user_id, e.date::text AS date
       FROM leave_round_entries e
       JOIN leave_round_submissions s
         ON s.round_id = e.round_id AND s.user_id = e.user_id
       WHERE e.round_id = $1 AND e.status = 'verlof' AND s.approved IS TRUE`,
      [req.params.id]
    );

    await client.query('BEGIN');
    let applied = 0;
    for (const r of rows.rows) {
      await client.query(
        `INSERT INTO availability (user_id, date, type, reason, updated_at)
         VALUES ($1, $2, 'verlof', $3, NOW())
         ON CONFLICT (user_id, date)
         DO UPDATE SET type = 'verlof', reason = $3, updated_at = NOW()`,
        [r.user_id, r.date, `Verlofplanning: ${roundName}`]
      );
      applied++;
    }
    await client.query(`UPDATE leave_rounds SET status = 'toegepast', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    await logAudit(req, 'UPDATE', 'settings', req.params.id, { type: 'leave_round_apply', applied });
    res.json({ ok: true, applied });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error applying leave round:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Reset all data (admin only)
v1.delete('/reset-data', requireAuth, requireAdmin, async (req, res) => {
  const scope = req.query.scope || 'data';
  if (!['data', 'data_users', 'all'].includes(scope)) {
    return res.status(400).json({ error: 'Invalid scope. Use: data, data_users, or all' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deletedTables = [];

    // Always delete planning data (correct order for foreign keys)
    await client.query('DELETE FROM shift_swap_requests');
    deletedTables.push('shift_swap_requests');
    await client.query('DELETE FROM shift_blocks');
    deletedTables.push('shift_blocks');
    await client.query('DELETE FROM shift_activities');
    deletedTables.push('shift_activities');
    await client.query('DELETE FROM availability');
    deletedTables.push('availability');
    await client.query('DELETE FROM shifts');
    deletedTables.push('shifts');
    await client.query('DELETE FROM settings');
    deletedTables.push('settings');
    await client.query('DELETE FROM schedule_drafts');
    deletedTables.push('schedule_drafts');

    // Delete users if requested
    if (scope === 'data_users') {
      // Delete non-admin users
      await client.query('DELETE FROM users WHERE role != $1', ['admin']);
      deletedTables.push('users (non-admin)');
    } else if (scope === 'all') {
      // Delete all users except the requesting admin
      await client.query('DELETE FROM users WHERE id != $1', [req.user.id]);
      deletedTables.push('users (all except self)');
    }

    await client.query('COMMIT');
    await logAudit(req, 'DELETE', 'system', '', { action: 'reset_data', scope, tables: deletedTables });

    const messages = {
      data: 'Planning data gewist (gebruikers behouden)',
      data_users: 'Planning data en medewerker-accounts gewist',
      all: 'Alle data en accounts gewist (behalve eigen account)'
    };
    res.json({ ok: true, message: messages[scope] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== MIGRATION ENDPOINTS =====

// Run the merge-employees migration
v1.post('/admin/migrate', requireAuth, requireAdmin, async (req, res) => {
  const results = { migrations: [], fixes: [] };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Step 1: Add employee columns to users if not exist
    const columnsToAdd = [
      { name: 'main_team', def: 'TEXT REFERENCES teams(id)' },
      { name: 'extra_teams', def: "TEXT[] DEFAULT '{}'" },
      { name: 'contract_hours', def: 'NUMERIC DEFAULT 0' },
      { name: 'active', def: 'BOOLEAN DEFAULT true' },
      { name: 'week_schedule_week1', def: "JSONB DEFAULT '[]'" },
      { name: 'week_schedule_week2', def: "JSONB DEFAULT '[]'" }
    ];

    for (const col of columnsToAdd) {
      try {
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
        results.migrations.push(`Added column ${col.name} to users`);
      } catch (e) {
        if (!e.message.includes('already exists')) throw e;
      }
    }

    // Step 2: Check if employees table exists and migrate data
    const tableCheck = await client.query(`
      SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'employees')
    `);

    if (tableCheck.rows[0].exists) {
      // Copy employee data to users
      const updateResult = await client.query(`
        UPDATE users u
        SET main_team = e.main_team,
            extra_teams = e.extra_teams,
            contract_hours = e.contract_hours,
            active = e.active,
            week_schedule_week1 = e.week_schedule_week1,
            week_schedule_week2 = e.week_schedule_week2
        FROM employees e
        WHERE LOWER(u.email) = LOWER(e.email)
        RETURNING u.id
      `);
      results.migrations.push(`Updated ${updateResult.rowCount} users with employee data`);

      // Create users for employees without accounts
      const passwordHash = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12);
      const createResult = await client.query(`
        INSERT INTO users (name, email, password_hash, role, team_id, main_team, extra_teams, contract_hours, active, week_schedule_week1, week_schedule_week2)
        SELECT e.name, LOWER(e.email), $1, 'medewerker', e.main_team, e.main_team, e.extra_teams, e.contract_hours, e.active, e.week_schedule_week1, e.week_schedule_week2
        FROM employees e
        WHERE e.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE LOWER(u.email) = LOWER(e.email))
        RETURNING id
      `, [passwordHash]);
      results.migrations.push(`Created ${createResult.rowCount} new user accounts from employees`);

      // Build employee_id to user_id mapping
      const mappings = await client.query(`
        SELECT e.id as employee_id, u.id as user_id
        FROM employees e
        JOIN users u ON LOWER(u.email) = LOWER(e.email)
      `);
      const empToUserMap = new Map(mappings.rows.map(r => [r.employee_id, r.user_id]));
      results.migrations.push(`Mapped ${empToUserMap.size} employees to users`);

      // Step 3: Migrate shifts table
      const shiftsColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'employee_id'
      `);

      if (shiftsColCheck.rows.length > 0) {
        // Add user_id column
        await client.query('ALTER TABLE shifts ADD COLUMN IF NOT EXISTS user_id INTEGER');

        // Update user_id based on employee_id mapping
        for (const [empId, userId] of empToUserMap) {
          await client.query('UPDATE shifts SET user_id = $1 WHERE employee_id = $2', [userId, empId]);
        }

        // Drop old constraint and column
        await client.query('ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_employee_id_fkey');
        await client.query('ALTER TABLE shifts DROP COLUMN IF EXISTS employee_id');

        // Add new constraint
        await client.query('ALTER TABLE shifts ADD CONSTRAINT shifts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');

        results.migrations.push('Migrated shifts table to use user_id');
      }

      // Step 4: Migrate availability table
      const availColCheck = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'availability' AND column_name = 'employee_id'
      `);

      if (availColCheck.rows.length > 0) {
        // Add user_id column
        await client.query('ALTER TABLE availability ADD COLUMN IF NOT EXISTS user_id INTEGER');

        // Update user_id based on employee_id mapping
        for (const [empId, userId] of empToUserMap) {
          await client.query('UPDATE availability SET user_id = $1 WHERE employee_id = $2', [userId, empId]);
        }

        // Drop old constraints and column
        await client.query('ALTER TABLE availability DROP CONSTRAINT IF EXISTS availability_employee_id_fkey');
        await client.query('ALTER TABLE availability DROP CONSTRAINT IF EXISTS availability_employee_id_date_key');
        await client.query('ALTER TABLE availability DROP COLUMN IF EXISTS employee_id');

        // Add new constraints
        await client.query('ALTER TABLE availability ADD CONSTRAINT availability_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
        await client.query('ALTER TABLE availability ADD CONSTRAINT availability_user_id_date_key UNIQUE(user_id, date)');

        results.migrations.push('Migrated availability table to use user_id');
      }

      // Step 5: Drop employees table
      await client.query('DROP TABLE IF EXISTS employees CASCADE');
      results.migrations.push('Dropped employees table');
    } else {
      results.migrations.push('Employees table does not exist, may have been migrated already');
    }

    // Step 6: Fix double-serialized JSONB data
    const usersToFix = await client.query('SELECT id, week_schedule_week1, week_schedule_week2 FROM users');
    let fixedCount = 0;

    for (const user of usersToFix.rows) {
      let week1 = user.week_schedule_week1;
      let week2 = user.week_schedule_week2;
      let needsUpdate = false;

      if (typeof week1 === 'string') {
        try { week1 = JSON.parse(week1); needsUpdate = true; } catch (e) { week1 = []; }
      }
      if (typeof week2 === 'string') {
        try { week2 = JSON.parse(week2); needsUpdate = true; } catch (e) { week2 = []; }
      }

      if (needsUpdate) {
        await client.query(
          'UPDATE users SET week_schedule_week1 = $1, week_schedule_week2 = $2 WHERE id = $3',
          [week1, week2, user.id]
        );
        fixedCount++;
      }
    }

    if (fixedCount > 0) {
      results.fixes.push(`Fixed weekSchedule data for ${fixedCount} users`);
    }

    // Step 7: Sync team_id with main_team for all users
    const teamSyncResult = await client.query(`
      UPDATE users
      SET team_id = main_team
      WHERE team_id IS NULL OR team_id != main_team OR (team_id IS NOT NULL AND main_team IS NULL)
      RETURNING id
    `);
    if (teamSyncResult.rowCount > 0) {
      results.fixes.push(`Synced team_id with main_team for ${teamSyncResult.rowCount} users`);
    }

    await client.query('COMMIT');
    results.migrations.push('✅ Migration completed successfully!');
    await logAudit(req, 'MIGRATE', 'system', '', { migrations: results.migrations, fixes: results.fixes });

    res.json({ ok: true, results });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed' });
  } finally {
    client.release();
  }
});

// Seed teams endpoint (admin only)
v1.post('/admin/seed-teams', requireAuth, requireAdmin, async (req, res) => {
  const teams = [
    { id: 'vlot1', name: 'Vlot 1 (Begeleiding)', color: '#4a7c6f' },
    { id: 'vlot2', name: 'Vlot 2 (Begeleiding)', color: '#c08a4a' },
    { id: 'cargo', name: 'Cargo (Dagbesteding)', color: '#5b7fa6' },
    { id: 'overkoepelend', name: 'Overkoepelend (Kantoor)', color: '#9a6a9e' },
    { id: 'jobstudent', name: 'Jobstudenten/Stagiairs', color: '#b9656a' }
  ];

  try {
    let created = 0;
    let updated = 0;
    for (const team of teams) {
      const result = await pool.query(
        `INSERT INTO teams (id, name, color)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color
         RETURNING (xmax = 0) as inserted`,
        [team.id, team.name, team.color]
      );
      if (result.rows[0].inserted) created++;
      else updated++;
    }
    await logAudit(req, 'CREATE', 'system', '', { action: 'seed_teams', created, updated, total: teams.length });
    res.json({ ok: true, created, updated, total: teams.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


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
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

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
