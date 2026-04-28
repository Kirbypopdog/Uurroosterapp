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

// CORS: restrict to frontend origin in production, open in development
const corsOptions = process.env.NODE_ENV === 'production'
  ? { origin: process.env.FRONTEND_URL || 'https://uurrooster-frontend.onrender.com', credentials: true }
  : {};
app.use(cors(corsOptions));
app.use(express.json());

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Te veel verzoeken. Probeer later opnieuw.' }
});
app.use(globalLimiter);

// ===== DATE HELPER FUNCTIONS =====
// Used by apply-schedule endpoint (replicates frontend data.js logic)
const { getMonday, formatDateYYYYMMDD, parseLocalDate, getBelgianPublicHolidays, shiftsOverlapCheck, hoursBetweenShifts } = require('./utils');

// ===== AUTO-MIGRATION ON STARTUP =====
// Ensures the database schema is up-to-date
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Check if new columns exist in users table
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'main_team'
    `);

    if (colCheck.rows.length === 0) {
      console.log('Running auto-migration: adding employee columns to users table...');

      // Add new columns
      const columnsToAdd = [
        { name: 'main_team', def: 'TEXT REFERENCES teams(id)' },
        { name: 'extra_teams', def: "TEXT[] DEFAULT '{}'" },
        { name: 'contract_hours', def: 'NUMERIC DEFAULT 0' },
        { name: 'active', def: 'BOOLEAN DEFAULT true' },
        { name: 'week_schedule_week1', def: "JSONB DEFAULT '[]'" },
        { name: 'week_schedule_week2', def: "JSONB DEFAULT '[]'" },
        { name: 'week_schedules', def: "JSONB DEFAULT NULL" }
      ];

      for (const col of columnsToAdd) {
        try {
          await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.def}`);
          console.log(`  Added column: ${col.name}`);
        } catch (e) {
          // Column might already exist with different constraints
          console.log(`  Column ${col.name}: ${e.message}`);
        }
      }

      console.log('Auto-migration complete. Run /admin/migrate for full data migration.');
    }

    // Ensure week_schedules column exists (separate migration for existing installations)
    try {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS week_schedules JSONB DEFAULT NULL`);
    } catch (e) { /* already exists */ }

    // Populate week_schedules from old columns where NULL
    await client.query(`
      UPDATE users SET week_schedules = jsonb_build_array(
        COALESCE(week_schedule_week1, '[]'::jsonb),
        COALESCE(week_schedule_week2, '[]'::jsonb)
      ) WHERE week_schedules IS NULL
    `);

    // Check if source column exists in shifts table
    const sourceColCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shifts' AND column_name = 'source'
    `);

    if (sourceColCheck.rows.length === 0) {
      console.log('Adding source column to shifts table...');
      try {
        await client.query(`
          ALTER TABLE shifts
          ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'
          CHECK (source IN ('auto', 'manual'))
        `);
        console.log('  Added column: source');
      } catch (e) {
        console.log(`  Column source: ${e.message}`);
      }
    }

    // Check if shift_swap_requests table exists
    const swapTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'shift_swap_requests'
    `);

    if (swapTableCheck.rows.length === 0) {
      console.log('Creating shift_swap_requests table...');
      try {
        await client.query(`
          CREATE TABLE shift_swap_requests (
            id SERIAL PRIMARY KEY,
            requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            requester_shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
            target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            target_shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
            request_type TEXT NOT NULL DEFAULT 'swap' CHECK (request_type IN ('swap', 'takeover')),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead')),
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
            responded_by INTEGER REFERENCES users(id)
          );
        `);
        console.log('  Created table: shift_swap_requests');

        // Create indexes for better query performance
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON shift_swap_requests(status);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_swap_requests_requester ON shift_swap_requests(requester_user_id);
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_swap_requests_target ON shift_swap_requests(target_user_id);
        `);
        console.log('  Created indexes for shift_swap_requests');
      } catch (e) {
        console.log(`  Error creating shift_swap_requests table: ${e.message}`);
      }
    } else {
      // Migration: Add target and lead approval columns if they don't exist
      console.log('Checking for target/lead approval columns...');
      try {
        // Check if target_approved column exists
        const targetApprovedCheck = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'shift_swap_requests' AND column_name = 'target_approved'
        `);

        if (targetApprovedCheck.rows.length === 0) {
          console.log('  Adding target/lead approval columns...');
          await client.query(`
            ALTER TABLE shift_swap_requests
            ADD COLUMN target_approved BOOLEAN DEFAULT NULL,
            ADD COLUMN target_response_notes TEXT,
            ADD COLUMN target_responded_at TIMESTAMP,
            ADD COLUMN lead_approved BOOLEAN DEFAULT NULL,
            ADD COLUMN lead_response_notes TEXT,
            ADD COLUMN lead_responded_at TIMESTAMP;
          `);
          console.log('  Added target/lead approval columns');

          // Update CHECK constraint to include new status
          await client.query(`
            ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check;
          `);
          await client.query(`
            ALTER TABLE shift_swap_requests
            ADD CONSTRAINT shift_swap_requests_status_check
            CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead'));
          `);
          console.log('  Updated status constraint');
        }

        // Check if request_type column exists
        const requestTypeCheck = await client.query(`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'shift_swap_requests' AND column_name = 'request_type'
        `);

        if (requestTypeCheck.rows.length === 0) {
          console.log('  Adding request_type column...');
          await client.query(`
            ALTER TABLE shift_swap_requests
            ADD COLUMN request_type TEXT DEFAULT 'swap' CHECK (request_type IN ('swap', 'takeover'));
          `);

          // Make target columns nullable for takeover requests
          await client.query(`
            ALTER TABLE shift_swap_requests
            ALTER COLUMN target_user_id DROP NOT NULL,
            ALTER COLUMN target_shift_id DROP NOT NULL;
          `);

          // Drop constraints that don't apply to takeover requests
          await client.query(`
            ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS different_shifts;
          `);
          await client.query(`
            ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS different_users;
          `);

          // Add conditional constraints (only for swap requests)
          // Note: PostgreSQL doesn't support conditional CHECK constraints easily,
          // so we'll validate in the application layer

          console.log('  Added request_type column and updated constraints');
        }
      } catch (e) {
        console.log(`  Error adding columns: ${e.message}`);
      }
    }

    // Check if shift_blocks table exists
    const blocksTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'shift_blocks'
    `);

    if (blocksTableCheck.rows.length === 0) {
      console.log('Creating shift_blocks table...');
      try {
        await client.query(`
          CREATE TABLE shift_blocks (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            date DATE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_by INTEGER REFERENCES users(id),
            reason TEXT,
            UNIQUE(user_id, date)
          );
        `);
        console.log('  Created table: shift_blocks');

        // Create index for better query performance
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_shift_blocks_user_date ON shift_blocks(user_id, date);
        `);
        console.log('  Created index: idx_shift_blocks_user_date');
      } catch (e) {
        console.log(`  Error creating shift_blocks table: ${e.message}`);
      }
    }

    // Check if settings table exists
    const settingsTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'settings'
    `);

    if (settingsTableCheck.rows.length === 0) {
      console.log('Creating settings table...');
      try {
        await client.query(`
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);
        console.log('  Created table: settings');
      } catch (e) {
        console.log(`  Error creating settings table: ${e.message}`);
      }
    }
    // Check if audit_log table exists
    const auditTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'audit_log'
    `);

    if (auditTableCheck.rows.length === 0) {
      console.log('Creating audit_log table...');
      try {
        await client.query(`
          CREATE TABLE audit_log (
            id SERIAL PRIMARY KEY,
            actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            actor_name TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'CANCEL', 'LOGIN')),
            resource_type TEXT NOT NULL CHECK (resource_type IN ('shift', 'availability', 'swap_request', 'user', 'settings')),
            resource_id TEXT,
            details JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
          CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type);
          CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
        `);
        console.log('  Created table: audit_log');
      } catch (e) {
        console.log(`  Error creating audit_log table: ${e.message}`);
      }
    }

    // Update audit_log CHECK constraints to include REPLACE/IMPORT/MIGRATE and system/shift_activity/shift_block
    try {
      await client.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check`);
      await client.query(`ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'CANCEL', 'LOGIN', 'REPLACE', 'IMPORT', 'MIGRATE'))`);
      await client.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_resource_type_check`);
      await client.query(`ALTER TABLE audit_log ADD CONSTRAINT audit_log_resource_type_check CHECK (resource_type IN ('shift', 'availability', 'swap_request', 'user', 'settings', 'system', 'shift_activity', 'shift_block'))`);
    } catch (e) {
      console.log(`  Audit log constraint update: ${e.message}`);
    }

    // Check if schedule_drafts table exists
    const draftsTableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'schedule_drafts'
    `);

    if (draftsTableCheck.rows.length === 0) {
      console.log('Creating schedule_drafts table...');
      try {
        await client.query(`
          CREATE TABLE schedule_drafts (
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
          );
          CREATE INDEX IF NOT EXISTS idx_schedule_drafts_created ON schedule_drafts(created_at DESC);
        `);
        console.log('  Created table: schedule_drafts');

        // Migrate existing drafts from settings table
        const settingsDrafts = await client.query(
          `SELECT value FROM settings WHERE key = 'schedule_drafts'`
        );
        if (settingsDrafts.rows.length > 0) {
          const drafts = settingsDrafts.rows[0].value;
          if (Array.isArray(drafts) && drafts.length > 0) {
            console.log(`  Migrating ${drafts.length} drafts from settings...`);
            for (const draft of drafts) {
              try {
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
              } catch (migErr) {
                console.log(`  Error migrating draft: ${migErr.message}`);
              }
            }
            console.log('  Draft migration complete');
          }
        }
      } catch (e) {
        console.log(`  Error creating schedule_drafts table: ${e.message}`);
      }
    }

    // Migrate old roles to new 3-role system
    // Must drop constraint FIRST, then update, then re-add
    try {
      await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    } catch (e) { /* constraint may not exist */ }

    const oldRolesCheck = await client.query(
      `SELECT COUNT(*) FROM users WHERE role IN ('hoofdverantwoordelijke', 'teamverantwoordelijke')`
    );
    if (parseInt(oldRolesCheck.rows[0].count) > 0) {
      console.log('Migrating old roles to roosterverantwoordelijke...');
      const result = await client.query(
        `UPDATE users SET role = 'roosterverantwoordelijke' WHERE role IN ('hoofdverantwoordelijke', 'teamverantwoordelijke')`
      );
      console.log(`  Migrated ${result.rowCount} users to roosterverantwoordelijke`);
    }

    try {
      await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'roosterverantwoordelijke', 'medewerker'))`);
    } catch (e) {
      // Constraint may already exist with correct values
    }

    // Email notifications preference column
    try {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications_enabled BOOLEAN DEFAULT true`);
    } catch (e) { /* already exists */ }

    // Onboarding flags (per-user JSON flags for checklist state)
    try {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_flags JSONB DEFAULT '{}'`);
    } catch (e) { /* already exists */ }

    // Add 'expired' to swap request status constraint
    try {
      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check`);
      await client.query(`ALTER TABLE shift_swap_requests ADD CONSTRAINT shift_swap_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'pending_lead', 'expired'))`);
    } catch (e) {
      console.log(`  Status constraint update: ${e.message}`);
    }

    // Create shift_activities table for activities within shifts (e.g. meetings, training)
    try {
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
    } catch (e) {
      console.log(`  shift_activities table: ${e.message}`);
    }

    // Indexes for shift_activities and schedule_drafts
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shift_activities_user_date ON shift_activities(user_id, date)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date)`);
    } catch (e) {
      console.log(`  extra indexes: ${e.message}`);
    }

    // Fix FK constraints: ON DELETE SET NULL for nullable user references
    try {
      await client.query(`ALTER TABLE shift_blocks DROP CONSTRAINT IF EXISTS shift_blocks_created_by_fkey`);
      await client.query(`ALTER TABLE shift_blocks ADD CONSTRAINT shift_blocks_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL`);
    } catch (e) {
      console.log(`  shift_blocks FK fix: ${e.message}`);
    }
    try {
      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_responded_by_fkey`);
      await client.query(`ALTER TABLE shift_swap_requests ADD CONSTRAINT shift_swap_requests_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES users(id) ON DELETE SET NULL`);
    } catch (e) {
      console.log(`  shift_swap_requests FK fix: ${e.message}`);
    }

    // Add shift_id FK to shift_activities for correct cascade deletion
    try {
      await client.query(`ALTER TABLE shift_activities ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE`);
      // Backfill: match existing activities to shifts via user_id + date + closest start_time
      await client.query(`
        UPDATE shift_activities sa
        SET shift_id = (
          SELECT s.id FROM shifts s
          WHERE s.user_id = sa.user_id AND s.date = sa.date
          ORDER BY ABS(EXTRACT(EPOCH FROM (s.start_time - sa.start_time)))
          LIMIT 1
        )
        WHERE sa.shift_id IS NULL
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shift_activities_shift_id ON shift_activities(shift_id)`);
    } catch (e) {
      console.log(`  shift_activities shift_id migration: ${e.message}`);
    }

    // Missing indexes for frequently filtered columns
    try {
      await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_source ON shifts(source)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_availability_type ON availability(type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_swap_requests_type ON shift_swap_requests(request_type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_schedule_drafts_type ON schedule_drafts(type)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id)`);
    } catch (e) {
      console.log(`  missing indexes: ${e.message}`);
    }

    // Phase 4: Add valid_from/valid_until to schedule_drafts for school year scheduling
    try {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS valid_from DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS valid_until DATE`);
    } catch (e) {
      console.log(`  schedule_drafts date columns: ${e.message}`);
    }

    // Phase 4b: Add last_applied_from/until to schedule_drafts for tracking applied periods
    try {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS last_applied_from DATE`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS last_applied_until DATE`);
    } catch (e) {
      console.log(`  schedule_drafts applied date columns: ${e.message}`);
    }

    // Phase 5: Add updated_by tracking to schedule_drafts
    try {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS updated_by INTEGER`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS updated_by_name TEXT`);
    } catch (e) {
      console.log(`  schedule_drafts updated_by columns: ${e.message}`);
    }

    // Phase 5b: Vakantieconcepten — type + holiday_period_id op schedule_drafts
    try {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'basis'`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS holiday_period_id TEXT`);
    } catch (e) {
      console.log(`  schedule_drafts vakantie columns: ${e.message}`);
    }

    // Phase 6: Conceptvergrendeling — voorkomt gelijktijdige bewerking
    try {
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_by INTEGER`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_by_name TEXT`);
      await client.query(`ALTER TABLE schedule_drafts ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ`);
    } catch (e) {
      console.log(`  schedule_drafts lock columns: ${e.message}`);
    }

    // Make users.email nullable (allow accounts without email address)
    try {
      await client.query(`ALTER TABLE users ALTER COLUMN email DROP NOT NULL`);
    } catch (e) {
      // Already nullable or constraint doesn't exist
    }

    // Normalize existing emails to lowercase (idempotent one-time migration)
    try {
      await client.query(`UPDATE users SET email = LOWER(email) WHERE email IS NOT NULL AND email != LOWER(email)`);
    } catch (e) {
      console.log(`  email lowercase migration: ${e.message}`);
    }

    // Phase 4: school_year_start setting (default: 1 sept current school year)
    try {
      const syResult = await client.query(`SELECT 1 FROM settings WHERE key = 'school_year_start'`);
      if (syResult.rows.length === 0) {
        const now = new Date();
        const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
        await client.query(
          `INSERT INTO settings (key, value) VALUES ('school_year_start', $1)`,
          [JSON.stringify({ date: `${startYear}-09-01` })]
        );
        console.log(`  Created school_year_start setting: ${startYear}-09-01`);
      }
    } catch (e) {
      console.log(`  school_year_start setting: ${e.message}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Schema check error:', err.message);
  } finally {
    client.release();
  }
}

// Run schema check on startup
ensureSchema().catch(console.error);

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

/**
 * Controleert overlap en 11-uur rust voor een nieuwe/gewijzigde shift.
 * @param {object} db - pool (of mock in tests)
 * @param {number} userId
 * @param {{ date: string, start_time: string, end_time: string }} newShift
 * @param {number|null} excludeId - shift-id uitsluiten bij PUT
 * @returns {Promise<{ valid: boolean, message?: string }>}
 */
async function validateShiftRules(db, userId, newShift, excludeId = null) {
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
      return { valid: false, message: 'Overlap: medewerker heeft al een shift op dit tijdstip.' };
    }
    const hours = hoursBetweenShifts(existing, newShift);
    if (hours >= 0 && hours < MIN_REST) {
      return {
        valid: false,
        message: `11-uur regel: slechts ${hours.toFixed(1)}u rust tussen shifts (minimum ${MIN_REST}u).`
      };
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
                onboarding_flags as "onboardingFlags"
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

v1.put('/me', requireAuth, async (req, res) => {
  const { name, email, password, mainTeam, contractHours, weekScheduleWeek1, weekScheduleWeek2, weekSchedules } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  try {
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 12);
    }

    // Serialize JSONB data
    const week1Json = weekScheduleWeek1 ? JSON.stringify(weekScheduleWeek1) : null;
    const week2Json = weekScheduleWeek2 ? JSON.stringify(weekScheduleWeek2) : null;
    const weekSchedulesJson = Array.isArray(weekSchedules) && weekSchedules.length > 0
      ? JSON.stringify(weekSchedules)
      : null;

    const result = await pool.query(
      `UPDATE users
       SET name = $1,
           email = $2,
           password_hash = COALESCE($3, password_hash),
           main_team = COALESCE($4, main_team),
           contract_hours = COALESCE($5, contract_hours),
           week_schedule_week1 = COALESCE($6::jsonb, week_schedule_week1),
           week_schedule_week2 = COALESCE($7::jsonb, week_schedule_week2),
           week_schedules = COALESCE($8::jsonb, jsonb_build_array(
             COALESCE($6::jsonb, week_schedule_week1),
             COALESCE($7::jsonb, week_schedule_week2)
           ))
       WHERE id = $9
       RETURNING id, name, email, role, team_id,
                 main_team as "mainTeam", extra_teams as "extraTeams",
                 contract_hours as "contractHours", active,
                 week_schedule_week1 as "weekScheduleWeek1",
                 week_schedule_week2 as "weekScheduleWeek2",
                week_schedules as "weekSchedules"`,
      [name, email.toLowerCase(), passwordHash, mainTeam, contractHours, week1Json, week2Json, weekSchedulesJson, req.user.id]
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
           team_id = $2,
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

    // Get old email before updating (for syncing with employees table)
    const oldUserResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const oldEmail = oldUserResult.rows.length > 0 ? oldUserResult.rows[0].email : null;

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
      [name, email ? email.trim().toLowerCase() : null, mainTeam || null, contractHours || 0, active !== false, week1Json, week2Json, weekSchedulesJson, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }

    await logAudit(req, 'UPDATE', 'user', userId, { user: result.rows[0] });

    // Welkomst-email als email voor het eerst wordt ingesteld (fire-and-forget)
    const newEmail = email ? email.trim().toLowerCase() : null;
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
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    }
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    await logAudit(req, 'DELETE', 'user', userId, { user: deletedUser.rows[0] });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
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
    if (userResult.rows[0]) {
      emailService.notifyPasswordReset(userResult.rows[0]);
    }
    res.json({ ok: true, newPassword: DEFAULT_RESET_PASSWORD });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== REPLACE EMPLOYEE =====

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
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vertrekkende medewerker niet gevonden' });
    }
    if (newUserResult.rows.length === 0) {
      await client.query('ROLLBACK');
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

    // 4. Update schedule_drafts: replace old user ID with new in grid
    const oldIdStr = String(oldUserId);
    const newIdStr = String(newUserId);
    const draftsUpdateResult = await client.query(
      `UPDATE schedule_drafts
       SET grid = replace(grid::text, $1, $2)::jsonb, updated_at = NOW()
       WHERE grid::text LIKE $3`,
      ['"' + oldIdStr + '"', '"' + newIdStr + '"', '%"' + oldIdStr + '"%']
    );
    const draftsUpdated = draftsUpdateResult.rowCount;

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
    await client.query('ROLLBACK');
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

v1.get('/admin/email-status', requireAuth, requireAdmin, async (req, res) => {
  const configured = !!process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Het Vlot Rooster <onboarding@resend.dev>';
  res.json({ configured, from });
});

v1.post('/admin/test-email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (!user || !user.email) {
      return res.status(400).json({ error: 'Je account heeft geen e-mailadres. Voeg er eerst een toe via je profiel.' });
    }
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'RESEND_API_KEY is niet geconfigureerd op de server.' });
    }
    await emailService.notifyTestEmail(user);
    res.json({ success: true, sentTo: user.email });
  } catch (err) {
    res.status(500).json({ error: 'Testmail versturen mislukt: ' + (err.message || 'Onbekende fout') });
  }
});

// ===== SHIFTS API =====

v1.get('/shifts', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    let query = `
      SELECT id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
             end_time as "endTime", notes, source, created_at as "createdAt"
      FROM shifts
    `;
    const params = [];
    if (startDate && endDate) {
      query += ' WHERE date >= $1 AND date <= $2';
      params.push(startDate, endDate);
    }
    query += ' ORDER BY date, start_time';

    const result = await pool.query(query, params);
    res.json({ shifts: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

v1.post('/shifts', requireAuth, async (req, res) => {
  const { userId, team, date, startTime, endTime, notes, source } = req.body || {};
  if (!userId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Verplichte velden ontbreken' });
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

    // Valideer 11-uur regel en overlap
    const validation = await validateShiftRules(pool, userId, { date, start_time: startTime, end_time: endTime });
    if (!validation.valid) return res.status(422).json({ error: validation.message });

    // Insert the new shift
    const result = await pool.query(`
      INSERT INTO shifts (user_id, team, date, start_time, end_time, notes, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, created_at as "createdAt"
    `, [userId, team || null, date, startTime, endTime, notes || '', shiftSource]);

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
  const { userId, team, date, startTime, endTime, notes, source } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'ID is verplicht' });
  }

  // Permission check: medewerker can only edit own shifts
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker') {
    const existing = await pool.query('SELECT user_id FROM shifts WHERE id = $1', [id]);
    if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
      return res.status(403).json({ error: 'Je kunt alleen je eigen diensten bewerken' });
    }
  }

  // When editing, automatically set source to 'manual' to protect from auto-regeneration
  // Unless explicitly setting to 'auto' (for reset-to-base functionality)
  const shiftSource = source === 'auto' ? 'auto' : 'manual';

  try {
    const oldResult = await pool.query(
      `SELECT id, user_id as "userId", team, date::text as date, start_time as "startTime", end_time as "endTime", notes, source FROM shifts WHERE id = $1`,
      [id]
    );
    const oldShift = oldResult.rows[0] || null;

    // Valideer 11-uur regel en overlap (gebruik bestaande waarden als veld niet meegegeven)
    const updatedShift = {
      date:       date       || oldShift?.date,
      start_time: startTime  || oldShift?.startTime,
      end_time:   endTime    || oldShift?.endTime
    };
    if (updatedShift.date && updatedShift.start_time && updatedShift.end_time) {
      const targetUserId = userId || oldShift?.userId;
      const validation = await validateShiftRules(pool, targetUserId, updatedShift, id);
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
          source = COALESCE($8, source, 'manual')
      WHERE id = $7
      RETURNING id, user_id as "userId", user_id as "employeeId", team, date::text as "date", start_time as "startTime",
                end_time as "endTime", notes, source, created_at as "createdAt"
    `, [userId, team, date, startTime, endTime, notes, id, shiftSource]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dienst niet gevonden' });
    }
    await logAudit(req, 'UPDATE', 'shift', id, { before: oldShift, after: result.rows[0] });
    res.json({ shift: result.rows[0] });
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
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];
    const { role, id: userId, team_id: userTeam } = req.user;

    // AUTO shifts can be deleted by anyone (they're temporary/regenerated)
    if (shift.source !== 'auto') {
      // Permission checks for MANUAL shifts based on role
      if (role === 'admin' || role === 'roosterverantwoordelijke') {
        // Admin/roosterverantwoordelijke can delete anything
      } else if (role === 'medewerker') {
        // Medewerker can only delete own shifts
        if (shift.user_id !== userId) {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Je kunt alleen je eigen diensten verwijderen' });
        }
      } else {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Je hebt geen rechten om diensten te verwijderen' });
      }
    }

    // Delete the shift (CASCADE handles shift_activities with shift_id set)
    await client.query('DELETE FROM shifts WHERE id = $1', [id]);
    await logAudit(req, 'DELETE', 'shift', id, { shift: { id: shift.id, user_id: shift.user_id, team: shift.team, date: shift.date, source: shift.source } });

    // Create shift block to prevent auto-regeneration
    // Check if caller wants to skip block creation (for system cleanup operations)
    const skipBlock = req.query.skipBlock === 'true';

    // shift_blocks niet meer nodig — geen achtergrondregeneratie meer
    // Shift verwijdering is definitief tenzij concept opnieuw wordt toegepast

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
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

    const createdShifts = [];

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
    await logAudit(req, 'CREATE', 'shift', '', { action: 'bulk_create', count: createdShifts.length, overwriteExisting: !!overwriteExisting });
    res.status(201).json({ shifts: createdShifts, count: createdShifts.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /shifts/bulk error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== SHIFT ACTIVITIES API =====

v1.get('/shift-activities', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    let query = `
      SELECT id, user_id as "userId", shift_id as "shiftId", date::text as "date", start_time as "startTime",
             end_time as "endTime", type, description, created_at as "createdAt"
      FROM shift_activities
    `;
    const params = [];
    if (startDate && endDate) {
      query += ' WHERE date >= $1 AND date <= $2';
      params.push(startDate, endDate);
    }
    query += ' ORDER BY date, start_time';
    const result = await pool.query(query, params);
    res.json({ activities: result.rows });
  } catch (err) {
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
    res.status(500).json({ error: 'Server error' });
  }
});

v1.put('/shift-activities/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { startTime, endTime, type, description } = req.body || {};

  // Permission check: medewerker can only edit own activities
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker') {
    const existing = await pool.query('SELECT user_id FROM shift_activities WHERE id = $1', [id]);
    if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
      return res.status(403).json({ error: 'Je kunt alleen je eigen activiteiten bewerken' });
    }
  }

  try {
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

  // Permission check: medewerker can only delete own activities
  const { role, id: currentUserId } = req.user;
  if (role === 'medewerker') {
    const existing = await pool.query('SELECT user_id FROM shift_activities WHERE id = $1', [id]);
    if (existing.rows.length > 0 && existing.rows[0].user_id !== currentUserId) {
      return res.status(403).json({ error: 'Je kunt alleen je eigen activiteiten verwijderen' });
    }
  }

  try {
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
    const result = await pool.query(`
      INSERT INTO availability (user_id, date, type, reason, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, date)
      DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
      RETURNING id, user_id as "userId", date::text as date, type, reason, updated_at as "updatedAt"
    `, [userId, date, type, reason || '']);

    await logAudit(req, 'CREATE', 'availability', result.rows[0].id, { availability: result.rows[0] });
    res.status(201).json({ availability: result.rows[0] });
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
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Geen geldige datums in bereik' });
    }

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
    await logAudit(req, 'CREATE', 'availability', '', {
      type: 'bulk_sick_with_takeover',
      userId, startDate, endDate, absenceType: type,
      daysCreated: dates.length,
      takeoverRequestsCreated: takeoverCount,
      conflictingShifts: conflictingShiftCount
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
      conflictingShifts: conflictingShiftCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
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
        AND sr.status IN ('pending', 'pending_lead')
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
  const { responseNotes } = req.body;
  const { id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info (FOR UPDATE locks rows to prevent concurrent modification)
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.user_id as requester_current_user, s1.team as requester_team, s1.date as requester_date,
              s1.start_time as requester_start, s1.end_time as requester_end,
              s2.user_id as target_current_user, s2.team as target_team, s2.date as target_date,
              s2.start_time as target_start, s2.end_time as target_end
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s1, s2`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can approve
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Alleen de doelpersoon kan dit ruilverzoek accepteren' });
    }

    // Verify shift ownership hasn't changed since swap was created
    if (swap.requester_current_user !== swap.requester_user_id || swap.target_current_user !== swap.target_user_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Een van de diensten is inmiddels hertoegewezen. Dit ruilverzoek is niet meer geldig.' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(swap.requester_date);
    const targetDate = new Date(swap.target_date);

    if (requesterDate < now || targetDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shifts zijn al voorbij' });
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
    await logAudit(req, 'APPROVE', 'swap_request', swapId, { swap: { requester: swap.requester_user_id, target: swap.target_user_id, type: 'swap' } });

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
    await client.query('ROLLBACK');
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
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check: only target user can reject
    if (swap.target_user_id !== currentUserId) {
      await client.query('ROLLBACK');
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
    await client.query('ROLLBACK');
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
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift niet gevonden' });
    }

    const shift = shiftResult.rows[0];

    // Permission check: Allow admin, roosterverantwoordelijke, or own shifts
    const isOwnShift = shift.user_id === currentUserId;
    const isAdmin = role === 'admin';
    const isRoosterverantwoordelijke = role === 'roosterverantwoordelijke';

    if (!isOwnShift && !isAdmin && !isRoosterverantwoordelijke) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Je kunt alleen je eigen shifts aanbieden, tenzij je admin of verantwoordelijke bent' });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = new Date(shift.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK');
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
    await client.query('ROLLBACK');
    console.error('POST /shift-requests/takeover error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.put('/shift-requests/:id/takeover-accept', requireAuth, async (req, res) => {
  const requestId = req.params.id;
  const { responseNotes } = req.body;
  const { id: currentUserId, team_id: acceptorTeam } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch takeover request with shift info (FOR UPDATE locks rows to prevent concurrent modification)
    const requestResult = await client.query(
      `SELECT sr.*, s.user_id as current_shift_owner, s.date, s.start_time, s.end_time, s.team
       FROM shift_swap_requests sr
       JOIN shifts s ON sr.requester_shift_id = s.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s`,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Verzoek niet gevonden' });
    }

    const request = requestResult.rows[0];

    // Verify it's a takeover request
    if (request.request_type !== 'takeover') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Dit is geen open verzoek' });
    }

    // Verify status is pending
    if (request.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Verzoek is al verwerkt' });
    }

    // Verify user is not the requester
    if (request.requester_user_id === currentUserId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Je kunt je eigen verzoek niet accepteren' });
    }

    // Verify shift is not in the past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const shiftDate = new Date(request.date);

    if (shiftDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shift ligt in het verleden' });
    }

    // Assign shift to acceptor, keep original team (don't change team on takeover)
    await client.query(
      `UPDATE shifts SET user_id = $1, source = 'manual' WHERE id = $2`,
      [currentUserId, request.requester_shift_id]
    );

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
    await logAudit(req, 'APPROVE', 'swap_request', requestId, { type: 'takeover', requester: request.requester_user_id, acceptedBy: currentUserId });

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
    await client.query('ROLLBACK');
    console.error('PUT /shift-requests/:id/takeover-accept error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Lead approval endpoints (for future use)
v1.put('/swap-requests/:id/approve', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { role, team_id, id: currentUserId } = req.user;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info (FOR UPDATE locks rows to prevent concurrent modification)
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.user_id as requester_current_user, s1.team as requester_team, s1.date as requester_date,
              s2.user_id as target_current_user, s2.team as target_team, s2.date as target_date
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1
       FOR UPDATE OF sr, s1, s2`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check
    if (!['admin', 'roosterverantwoordelijke'].includes(role)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Geen toestemming om swaps goed te keuren' });
    }

    // Verify shifts not in past
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const requesterDate = new Date(swap.requester_date);
    const targetDate = new Date(swap.target_date);

    if (requesterDate < now || targetDate < now) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Shifts zijn al voorbij' });
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

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'approved', response_notes = $1, responded_at = NOW(), responded_by = $2
       WHERE id = $3`,
      [responseNotes || null, currentUserId, swapId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'APPROVE', 'swap_request', swapId, { type: 'lead_approval', requester: swap.requester_user_id, target: swap.target_user_id, approvedBy: currentUserId });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[swap.requester_user_id, swap.target_user_id, currentUserId]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === swap.requester_user_id);
        const targetUser = usersResult.rows.find(u => u.id === swap.target_user_id);
        const approver = usersResult.rows.find(u => u.id === currentUserId);
        const approverName = approver ? approver.name : 'Verantwoordelijke';
        const rShift = { date: swap.requester_date, start_time: null, end_time: null, team: swap.requester_team };
        const tShift = { date: swap.target_date, start_time: null, end_time: null, team: swap.target_team };
        emailService.notifySwapApproved([requesterUser, targetUser].filter(Boolean), approverName, rShift, tShift, requesterUser, targetUser);
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap goedgekeurd en uitgevoerd' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /swap-requests/:id/approve error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

v1.put('/swap-requests/:id/reject', requireAuth, async (req, res) => {
  const swapId = req.params.id;
  const { responseNotes } = req.body;
  const { role, team_id, id: currentUserId } = req.user;

  if (!responseNotes || responseNotes.trim() === '') {
    return res.status(400).json({ error: 'Reden voor afwijzing is verplicht' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch swap request met shifts info (FOR UPDATE prevents concurrent approve+reject)
    const swapResult = await client.query(
      `SELECT sr.*,
              s1.team as requester_team,
              s2.team as target_team
       FROM shift_swap_requests sr
       JOIN shifts s1 ON sr.requester_shift_id = s1.id
       JOIN shifts s2 ON sr.target_shift_id = s2.id
       WHERE sr.id = $1
       FOR UPDATE OF sr`,
      [swapId]
    );

    if (swapResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request niet gevonden' });
    }

    const swap = swapResult.rows[0];

    // Verify status is pending
    if (swap.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Swap request is al verwerkt' });
    }

    // Permission check (same as approve)
    if (!['admin', 'roosterverantwoordelijke'].includes(role)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Geen toestemming om swaps af te wijzen' });
    }

    // Update swap request status
    await client.query(
      `UPDATE shift_swap_requests
       SET status = 'rejected', response_notes = $1, responded_at = NOW(), responded_by = $2
       WHERE id = $3`,
      [responseNotes, currentUserId, swapId]
    );

    await client.query('COMMIT');
    await logAudit(req, 'REJECT', 'swap_request', swapId, { type: 'lead_rejection', requester: swap.requester_user_id, target: swap.target_user_id, reason: responseNotes, rejectedBy: currentUserId });

    // Email notification (fire-and-forget)
    (async () => {
      try {
        const usersResult = await pool.query(
          'SELECT id, name, email, email_notifications_enabled FROM users WHERE id = ANY($1)',
          [[swap.requester_user_id, swap.target_user_id, currentUserId]]
        );
        const requesterUser = usersResult.rows.find(u => u.id === swap.requester_user_id);
        const targetUser = usersResult.rows.find(u => u.id === swap.target_user_id);
        const rejector = usersResult.rows.find(u => u.id === currentUserId);
        const rejectorName = rejector ? rejector.name : 'Verantwoordelijke';
        emailService.notifySwapRejected([requesterUser, targetUser].filter(Boolean), rejectorName, responseNotes);
      } catch (e) { console.error('Email notification error:', e.message); }
    })();

    res.json({ ok: true, message: 'Swap afgewezen' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /swap-requests/:id/reject error:', err);
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
    const draftResult = await client.query(
      'SELECT id, name, grid, team_filter FROM schedule_drafts WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    if (draftResult.rows.length === 0) {
      await client.query('ROLLBACK');
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
    const userIds = new Set();
    for (const [key, weekGrid] of Object.entries(grid)) {
      if (key.startsWith('_')) continue;
      if (typeof weekGrid === 'object' && weekGrid !== null) {
        Object.keys(weekGrid).forEach(id => { const n = parseInt(id); if (!isNaN(n)) userIds.add(n); });
      }
    }

    let shiftsDeleted = 0;
    if (userIds.size > 0) {
      const userIdArray = Array.from(userIds);
      // Delete auto-generated shifts after endDate for these users
      // source='auto' marks auto-generated shifts
      let deleteQuery;
      if (deleteManual) {
        deleteQuery = 'DELETE FROM shifts WHERE user_id = ANY($1) AND date > $2';
      } else {
        deleteQuery = "DELETE FROM shifts WHERE user_id = ANY($1) AND date > $2 AND source = 'auto'";
      }
      const result = await client.query(deleteQuery, [userIdArray, endDate]);
      shiftsDeleted = result.rowCount;
    }

    await client.query('COMMIT');
    await logAudit(req, 'UPDATE', 'settings', req.params.id, {
      action: 'deactivate', endDate, shiftsDeleted, draftName: draft.name
    });
    res.json({ ok: true, shiftsDeleted });
  } catch (err) {
    await client.query('ROLLBACK');
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
      `SELECT id, name, week_number, team_filter, grid, created_by, valid_from, valid_until, type, holiday_period_id
       FROM schedule_drafts WHERE id = $1 FOR UPDATE`,
      [draftId]
    );

    if (draftResult.rows.length === 0) {
      await client.query('ROLLBACK');
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
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Vakantieconcept heeft geen gekoppelde vakantieperiode' });
      }
      const hpResult = await client.query(`SELECT value FROM settings WHERE key = 'holidayPeriods'`);
      const holidayPeriods = hpResult.rows.length > 0 ? (hpResult.rows[0].value || []) : [];
      const linkedPeriod = holidayPeriods.find(p => String(p.id) === String(draft.holiday_period_id));
      if (!linkedPeriod) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Gekoppelde vakantieperiode niet gevonden' });
      }
      effectiveStartDate = linkedPeriod.startDate;
      effectiveEndDate = linkedPeriod.endDate;
    }

    // Date range is verplicht — concepten hebben altijd een van/tot datum
    if (!effectiveStartDate || !effectiveEndDate) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Start- en einddatum zijn verplicht bij concept toepassen' });
    }

    // Validate date range
    if (effectiveStartDate >= effectiveEndDate) {
      await client.query('ROLLBACK');
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
        await client.query('ROLLBACK');
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

    // 2b. Handmatige wijzigingen detectie (niet voor vakantieconcepten)
    if (effectiveConfirmOverwrite === null) {
      const manualResult = await client.query(
        `SELECT COUNT(*)::int as count FROM shifts WHERE source = 'manual'
         AND date >= $1::date AND date <= $2::date`,
        [effectiveStartDate, effectiveEndDate]
      );
      const manualCount = manualResult.rows[0].count;
      if (manualCount > 0) {
        await client.query('ROLLBACK');
        return res.json({
          needsManualConfirmation: true,
          manualShiftCount: manualCount
        });
      }
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

        // Verwijder shifts van het oude concept in de overlappende periode
        await client.query(
          `DELETE FROM shifts WHERE source = 'auto'
           AND date >= $1::date AND date <= $2::date`,
          [effectiveStartDate, overlap.last_applied_until]
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
      }

      // ===== BULK SELECT: occupied dates and absences for employees IN draft =====
      const occupiedByEmp = {};
      const absencesByEmp = {};
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
      }

      // ===== COMPUTE SHIFTS TO INSERT (pure JS, no DB calls) =====
      const insertRows = [];
      for (const emp of empsInDraft) {
        const occupiedDates = occupiedByEmp[emp.id] || new Set();
        const absenceDates = absencesByEmp[emp.id] || new Set();
        let createdCount = 0;

        for (let d = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
             d <= rangeEnd;
             d.setDate(d.getDate() + 1)) {
          const dateStr = formatDateYYYYMMDD(d);

          if (occupiedDates.has(dateStr)) continue;
          if (absenceDates.has(dateStr)) continue;
          if (closedDatesSet.has(dateStr)) continue;
          if (vakantieSkipRanges.some(r => dateStr >= r.start && dateStr <= r.end)) continue;

          // Calculate cycle week number for this date
          const currMonday = getMonday(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
          const diffMs = currMonday.getTime() - refMonday.getTime();
          const diffWeeks = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000));
          const mod = diffWeeks % cycleLength;
          const weekNumber = (mod < 0 ? mod + cycleLength : mod) + 1;

          const weekGrid = gridByWeek[weekNumber];
          if (!weekGrid) continue;

          const empGrid = weekGrid[String(emp.id)] || weekGrid[emp.id];
          if (!empGrid) continue;

          // Map JS dayOfWeek (0=Sun) to grid dayIndex (0=Mon..6=Sun)
          const jsDow = d.getDay();
          const dayIndex = jsDow === 0 ? 6 : jsDow - 1;
          const assignment = empGrid[String(dayIndex)] || empGrid[dayIndex];
          if (!assignment) continue;

          insertRows.push({
            userId: emp.id,
            date: dateStr,
            startTime: assignment.startTime,
            endTime: assignment.endTime,
            team: assignment.team || emp.mainTeam
          });
          createdCount++;
        }

        if (createdCount > 0) {
          appliedCount++;
          totalCreated += createdCount;
        }
      }

      // ===== BULK INSERT: alle shifts in één query =====
      if (insertRows.length > 0) {
        const values = insertRows.map((_, i) =>
          `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5}, 'auto')`
        ).join(', ');
        const params = insertRows.flatMap(r => [r.userId, r.date, r.startTime, r.endTime, r.team]);
        await client.query(
          `INSERT INTO shifts (user_id, date, start_time, end_time, team, source) VALUES ${values}`,
          params
        );
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
    for (const emp of allEmployeesResult.rows) {
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
    if (Object.keys(teamMeetings).length > 0) {
      // Remove existing auto-generated vergadering activities in range
      await client.query(
        `DELETE FROM shift_activities WHERE type = 'vergadering' AND date >= $1::date AND date <= $2::date`,
        [effectiveStartDate, effectiveEndDate]
      );

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

            await client.query(
              `INSERT INTO shift_activities (user_id, shift_id, date, start_time, end_time, type, description)
               VALUES ($1, $2, $3, $4, $5, 'vergadering', 'Teamvergadering')`,
              [shift.user_id, shift.id, shift.date, fromTime, toTime]
            );
          }
        }
      }
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
      clearBlocks
    });

    res.json({
      applied: appliedCount,
      shifts: { created: totalCreated, deleted: totalDeleted },
      draftName: draft.name,
      weekNumbers: appliedWeekNumbers
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /schedule-drafts/:id/apply error:', err);
    res.status(500).json({ error: 'Server error bij concept toepassen' });
  } finally {
    client.release();
  }
});

// ===== AUDIT LOG API =====

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

v1.post('/import', requireAuth, requireRole('admin', 'roosterverantwoordelijke'), async (req, res) => {
  const { users, shifts, availability, settings } = req.body || {};
  const results = { imported: 0, skipped: 0, errors: [] };

  // Import users (with schedule data)
  if (Array.isArray(users)) {
    for (const user of users) {
      try {
        // Validate team exists if specified
        let mainTeam = user.mainTeam || null;
        if (mainTeam) {
          const teamCheck = await pool.query('SELECT id FROM teams WHERE id = $1', [mainTeam]);
          if (teamCheck.rows.length === 0) {
            mainTeam = null;
          }
        }

        // Check if user already exists (by email)
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [user.email?.toLowerCase()]);
        if (existing.rows.length > 0) {
          // Update existing user's schedule data
          const week1Json = JSON.stringify(user.weekScheduleWeek1 || []);
          const week2Json = JSON.stringify(user.weekScheduleWeek2 || []);
          const wsJson = Array.isArray(user.weekSchedules) && user.weekSchedules.length > 0
            ? JSON.stringify(user.weekSchedules)
            : JSON.stringify([user.weekScheduleWeek1 || [], user.weekScheduleWeek2 || []]);

          await pool.query(`
            UPDATE users SET
              name = $1,
              main_team = $2,
              contract_hours = $3,
              active = $4,
              week_schedule_week1 = $5::jsonb,
              week_schedule_week2 = $6::jsonb,
              week_schedules = $7::jsonb
            WHERE email = $8
          `, [
            user.name,
            mainTeam,
            user.contractHours || 0,
            user.active !== false,
            week1Json,
            week2Json,
            wsJson,
            user.email.toLowerCase()
          ]);
          results.imported++;
        } else if (user.email) {
          // Create new user with default password
          const passwordHash = await bcrypt.hash(DEFAULT_RESET_PASSWORD, 12);
          const week1Json = JSON.stringify(user.weekScheduleWeek1 || []);
          const week2Json = JSON.stringify(user.weekScheduleWeek2 || []);
          const wsJson = Array.isArray(user.weekSchedules) && user.weekSchedules.length > 0
            ? JSON.stringify(user.weekSchedules)
            : JSON.stringify([user.weekScheduleWeek1 || [], user.weekScheduleWeek2 || []]);

          await pool.query(`
            INSERT INTO users (name, email, password_hash, role, team_id, main_team, contract_hours, active, week_schedule_week1, week_schedule_week2, week_schedules)
            VALUES ($1, $2, $3, 'medewerker', $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
          `, [
            user.name,
            user.email.toLowerCase(),
            passwordHash,
            mainTeam,
            mainTeam,
            user.contractHours || 0,
            user.active !== false,
            week1Json,
            week2Json,
            wsJson
          ]);
          results.imported++;
        } else {
          results.skipped++;
          results.errors.push({ name: user.name, error: 'Email is required' });
        }
      } catch (err) {
        console.error(`Error importing ${user.name}:`, err.message);
        results.errors.push({ name: user.name, error: err.message });
        results.skipped++;
      }
    }
  }

  // Import shifts
  if (Array.isArray(shifts)) {
    for (const shift of shifts) {
      try {
        await pool.query(`
          INSERT INTO shifts (user_id, team, date, start_time, end_time, notes)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [shift.userId, shift.team || null, shift.date, shift.startTime, shift.endTime, shift.notes || '']);
        results.imported++;
      } catch (err) {
        results.errors.push({ shift: shift.date, error: err.message });
        results.skipped++;
      }
    }
  }

  // Import availability
  if (Array.isArray(availability)) {
    for (const avail of availability) {
      try {
        await pool.query(`
          INSERT INTO availability (user_id, date, type, reason, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (user_id, date) DO UPDATE SET type = $3, reason = $4, updated_at = NOW()
        `, [avail.userId, avail.date, avail.type, avail.reason || '']);
        results.imported++;
      } catch (err) {
        results.errors.push({ availability: avail.date, error: err.message });
        results.skipped++;
      }
    }
  }

  await logAudit(req, 'IMPORT', 'system', '', { imported: results.imported, skipped: results.skipped, errorCount: results.errors.length });
  res.json({ ok: true, results });
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
    await client.query('ROLLBACK');
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
    await client.query('ROLLBACK');
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed' });
  } finally {
    client.release();
  }
});

// Seed teams endpoint (admin only)
v1.post('/admin/seed-teams', requireAuth, requireAdmin, async (req, res) => {
  const teams = [
    { id: 'vlot1', name: 'Vlot 1 (Begeleiding)', color: '#3b82f6' },
    { id: 'vlot2', name: 'Vlot 2 (Begeleiding)', color: '#8b5cf6' },
    { id: 'cargo', name: 'Cargo (Dagbesteding)', color: '#10b981' },
    { id: 'overkoepelend', name: 'Overkoepelend (Kantoor)', color: '#f59e0b' },
    { id: 'jobstudent', name: 'Jobstudenten/Stagiairs', color: '#ec4899' }
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

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`API running on :${PORT}`);
  });
}

module.exports = app;
