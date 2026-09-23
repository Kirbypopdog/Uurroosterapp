// #157: de migraties, uit server.js gehaald.
//
// Ze stonden bovenaan server.js en waren met ruim duizend regels het grootste
// blok van dat bestand, terwijl ze met de routes niets te maken hebben: ze
// draaien één keer bij het opstarten.
//
// backend/tests/schema-drift.test.js leest DIT bestand als tekst om te
// bewaken dat sql/schema.sql niet achterloopt op de migraties (#329, #311).
// Verhuist dit blok ooit opnieuw, dan moet die test mee.
const { pool } = require('./db');

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
  },
  {
    // #246: het slepen van het rechterhandvat kon een eindtijd '24:00' opleveren,
    // en isValidTime keek alleen naar het patroon HH:MM, dus die werd bewaard.
    // <input type="time"> weigert die waarde, waardoor het veld Eindtijd leeg
    // bleef en de dienst niet meer via het venster te bewerken was. Middernacht
    // heet in deze app '00:00'. Nieuwe waarden worden nu genormaliseerd; deze
    // migratie haalt de rijen op die er al staan.
    name: '039_normaliseer_eindtijd_24u',
    up: async (client) => {
      await client.query(`UPDATE shifts SET end_time = '00:00' WHERE end_time::text LIKE '24:00%'`);
      await client.query(`UPDATE shifts SET start_time = '00:00' WHERE start_time::text LIKE '24:00%'`);
    }
  },
  {
    // #237: de overlapcontrole en de invoeging stonden los van elkaar, dus twee
    // gelijktijdige verzoeken kregen allebei een dienst. POST /shifts draait nu
    // in een transactie met een advisory lock, maar dat dekt alleen dat ene
    // endpoint. Een unieke index is het vangnet voor elk ander schrijfpad
    // (bulk aanmaken, een concept toepassen) en voor een eventueel tweede
    // serverproces.
    //
    // Twee diensten voor dezelfde medewerker op dezelfde dag met dezelfde
    // starttijd overlappen altijd, dus dit sluit niets geldigs uit.
    //
    // Staan er al dubbels, dan is de index niet aan te maken. Die wegwerken is
    // een inhoudelijke keuze over iemands rooster en hoort niet stil in een
    // migratie thuis. De migratie slaat de index dan over en noemt precies om
    // welke rijen het gaat. Let op: een migratie draait maar een keer, dus de
    // index komt er daarna niet vanzelf; het logbericht geeft het commando mee.
    name: '040_unieke_dienst_per_start',
    up: async (client) => {
      const dubbels = await client.query(`
        SELECT user_id, date::text AS datum, start_time::text AS start, COUNT(*)::int AS aantal
        FROM shifts
        GROUP BY user_id, date, start_time
        HAVING COUNT(*) > 1
        ORDER BY aantal DESC
        LIMIT 20
      `);
      if (dubbels.rows.length > 0) {
        console.warn('Migratie 040: de unieke index is NIET aangemaakt, er staan al dubbele diensten:');
        dubbels.rows.forEach(r => console.warn(
          `  medewerker ${r.user_id}, ${r.datum} om ${r.start}: ${r.aantal} keer`));
        console.warn(
          'Deze migratie draait niet opnieuw. Ruim de dubbels op en voer daarna dit uit:\n' +
          '  CREATE UNIQUE INDEX CONCURRENTLY idx_shifts_uniek_per_start ON shifts (user_id, date, start_time);'
        );
        return;
      }
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_shifts_uniek_per_start ON shifts (user_id, date, start_time)`
      );
    }
  },
  {
    // #236: een CHECK op availability.type, zodat rommel ook niet langs een
    // andere weg dan de API binnenkomt.
    //
    // Zoals bij migratie 040 en 041: staan er al waarden buiten de lijst, dan
    // wordt de constraint niet gezet en zegt het log welke het zijn. Zulke
    // rijen weggooien of omzetten is een inhoudelijke keuze over iemands
    // afwezigheid en hoort niet stil in een migratie thuis.
    name: '042_availability_type_check',
    up: async (client) => {
      const geldig = ['verlof', 'ziek', 'overuren', 'vorming', 'andere', 'vrij'];
      const raar = await client.query(
        `SELECT type, COUNT(*)::int AS aantal FROM availability
         WHERE type IS NULL OR NOT (type = ANY($1::text[]))
         GROUP BY type ORDER BY aantal DESC LIMIT 20`, [geldig]);
      if (raar.rows.length > 0) {
        console.warn('Migratie 042: de CHECK is NIET gezet, er staan onbekende afwezigheidstypes in de database:');
        raar.rows.forEach(r => console.warn(`  "${r.type}": ${r.aantal} rijen`));
        console.warn(
          'Deze migratie draait niet opnieuw. Zet die rijen recht en voer daarna dit uit:\n' +
          "  ALTER TABLE availability ADD CONSTRAINT availability_type_check\n" +
          "    CHECK (type IN ('verlof','ziek','overuren','vorming','andere','vrij'));"
        );
        return;
      }
      const bestaat = await client.query(
        `SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'availability' AND constraint_name = 'availability_type_check'`);
      if (bestaat.rows.length === 0) {
        await client.query(
          `ALTER TABLE availability ADD CONSTRAINT availability_type_check
           CHECK (type IN ('verlof','ziek','overuren','vorming','andere','vrij'))`);
      }
    }
  },
  {
    // #243: hooguit een openstaand overnameverzoek per dienst. De advisory lock
    // in POST /shift-requests/takeover dekt dat endpoint; deze index dekt ook de
    // automatische ziekmelding en alles wat er later bijkomt.
    //
    // Zoals bij migratie 040: staan er al dubbels, dan wordt de index niet
    // aangemaakt en zegt het log welke het zijn.
    name: '041_een_openstaande_overname_per_dienst',
    up: async (client) => {
      const dubbels = await client.query(`
        SELECT requester_shift_id, COUNT(*)::int AS aantal
        FROM shift_swap_requests
        WHERE request_type = 'takeover' AND status = 'pending' AND requester_shift_id IS NOT NULL
        GROUP BY requester_shift_id
        HAVING COUNT(*) > 1
        ORDER BY aantal DESC
        LIMIT 20
      `);
      if (dubbels.rows.length > 0) {
        console.warn('Migratie 041: de unieke index is NIET aangemaakt, er staan al meerdere openstaande overnameverzoeken op dezelfde dienst:');
        dubbels.rows.forEach(r => console.warn(`  dienst ${r.requester_shift_id}: ${r.aantal} verzoeken`));
        console.warn(
          'Deze migratie draait niet opnieuw. Annuleer de overtollige verzoeken en voer daarna dit uit:\n' +
          "  CREATE UNIQUE INDEX CONCURRENTLY idx_een_openstaande_overname ON shift_swap_requests (requester_shift_id)\n" +
          "    WHERE request_type = 'takeover' AND status = 'pending';"
        );
        return;
      }
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_een_openstaande_overname
        ON shift_swap_requests (requester_shift_id)
        WHERE request_type = 'takeover' AND status = 'pending'
      `);
    }
  },
  {
    // #377: bij een voorkeurblok vult de medewerker werken, liever_niet of
    // zeker_niet in. Legde de beheerder daarna de verdeling vast, dan verving
    // dat elke entry door verlof of werken en was de oorspronkelijke voorkeur
    // onherroepelijk weg. Net op het moment dat hij moet bijsturen (iemand
    // wordt nog goedgekeurd, een week blijkt te dun) miste hij het verschil
    // tussen "zeker niet" en "liever niet".
    //
    // requested_status bewaart wat de medewerker vroeg. status blijft wat er
    // geldt. Bestaande rijen krijgen hun huidige status als gevraagde waarde:
    // voor een nog niet verdeeld blok klopt dat exact, en voor een al verdeeld
    // blok is het het enige wat we nog weten.
    name: '043_leave_entries_requested_status',
    up: async (client) => {
      await client.query(
        `ALTER TABLE leave_round_entries ADD COLUMN IF NOT EXISTS requested_status TEXT`);
      await client.query(
        `UPDATE leave_round_entries SET requested_status = status WHERE requested_status IS NULL`);
    }
  },
  {
    // #279: team_id en main_team moeten gelijk zijn (CLAUDE.md regel 2).
    // team_id zit in het JWT en bepaalt welke openstaande overnameverzoeken
    // iemand ziet; main_team bepaalt waar de app hem toont. Lopen ze uiteen,
    // dan ziet die persoon de verzoeken van het verkeerde team en mist hij die
    // van zijn eigen team, terwijl de planning hem ergens anders plaatst.
    //
    // Elke schrijfweg synchroniseert ze intussen: PUT /users/:id deed dat al,
    // POST /import sinds #214. Wat overblijft is oude scheefstand van vóór die
    // fixes. Die is hier niet op te sporen zonder ook recht te zetten, en
    // main_team is de bedoelde waarde, dus team_id volgt.
    //
    // Het log noemt wie er aangepast is, zodat een onverwacht geval opvalt.
    name: '044_team_id_gelijk_aan_main_team',
    up: async (client) => {
      const scheef = await client.query(
        `SELECT id, name, team_id, main_team FROM users
         WHERE main_team IS DISTINCT FROM team_id
         ORDER BY id`);
      if (scheef.rows.length === 0) return;
      console.warn(`Migratie 044: ${scheef.rows.length} account(s) met team_id ongelijk aan main_team:`);
      scheef.rows.forEach(r =>
        console.warn(`  #${r.id} ${r.name}: team_id "${r.team_id}" -> main_team "${r.main_team}"`));
      await client.query(`UPDATE users SET team_id = main_team WHERE main_team IS DISTINCT FROM team_id`);
    }
  },
  {
    // #315: de resten van de leadgoedkeuring, die in #114 verdwenen is. Niets
    // schrijft ze en sinds #315 leest ook niets ze meer, maar zolang ze in het
    // schema staan denkt iedereen die het leest dat die stap nog bestaat.
    //
    // Victor heeft het droppen bevestigd. Wat erin stond wordt eerst geteld en
    // gelogd: het verdwijnt onomkeerbaar, dus er hoort een spoor te zijn van
    // hoeveel het was. De laatste backup bevat de kolommen sowieso nog.
    name: '045_lead_kolommen_droppen',
    up: async (client) => {
      const telling = await client.query(`
        SELECT count(*) FILTER (WHERE lead_approved IS NOT NULL)::int      AS met_goedkeuring,
               count(*) FILTER (WHERE lead_response_notes IS NOT NULL)::int AS met_notitie,
               count(*) FILTER (WHERE lead_responded_at IS NOT NULL)::int   AS met_tijdstip,
               count(*) FILTER (WHERE status = 'pending_lead')::int         AS op_pending_lead
        FROM shift_swap_requests`);
      const t = telling.rows[0];
      const iets = t.met_goedkeuring || t.met_notitie || t.met_tijdstip || t.op_pending_lead;
      if (iets) {
        console.warn('Migratie 045: er stond nog iets in de leadkolommen, dit verdwijnt nu:');
        console.warn(`  lead_approved gevuld: ${t.met_goedkeuring}`);
        console.warn(`  lead_response_notes gevuld: ${t.met_notitie}`);
        console.warn(`  lead_responded_at gevuld: ${t.met_tijdstip}`);
        console.warn(`  status = 'pending_lead': ${t.op_pending_lead}`);
      } else {
        console.log('Migratie 045: de leadkolommen waren leeg.');
      }

      // Een verzoek dat nog op pending_lead staat kan door niemand meer
      // afgehandeld worden, want die route bestaat niet. Het hoort dus op een
      // eindstatus, niet op een waarde die straks niet meer bestaat.
      if (t.op_pending_lead > 0) {
        await client.query(
          `UPDATE shift_swap_requests SET status = 'expired', responded_at = COALESCE(responded_at, NOW())
           WHERE status = 'pending_lead'`);
      }

      await client.query(`ALTER TABLE shift_swap_requests DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check`);
      await client.query(
        `ALTER TABLE shift_swap_requests ADD CONSTRAINT shift_swap_requests_status_check
         CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired'))`);
      await client.query(`ALTER TABLE shift_swap_requests DROP COLUMN IF EXISTS lead_approved`);
      await client.query(`ALTER TABLE shift_swap_requests DROP COLUMN IF EXISTS lead_response_notes`);
      await client.query(`ALTER TABLE shift_swap_requests DROP COLUMN IF EXISTS lead_responded_at`);
    }
  },
  {
    // #154: de agendafeed hangt aan één token dat eeuwig geldig blijft. Deze
    // twee kolommen maken zichtbaar wat er met zo'n link gebeurt: wanneer hij
    // gemaakt is, en wanneer hij voor het laatst opgehaald werd.
    //
    // Bewust géén aparte toegangstabel met tijdstippen en IP-adressen. Een
    // agenda-app haalt de feed elk kwartier op, dus dat zou een tabel zijn die
    // eindeloos groeit, gevuld met verbindingsgegevens van medewerkers. Dat is
    // meer persoonsgegevens aanmaken om persoonsgegevens te beschermen. Twee
    // tijdstempels op de gebruiker geven hetzelfde signaal zonder die prijs.
    name: '046_ical_token_levensloop',
    up: async (client) => {
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ical_token_created TIMESTAMPTZ`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ical_last_access TIMESTAMPTZ`);
      // Bestaande tokens hebben geen aanmaakdatum. Die op NOW() zetten is
      // eerlijker dan NULL laten: de opruiming hieronder mag een link die al
      // maanden in iemands agenda staat niet als "nooit gebruikt" aanzien
      // alleen omdat wij pas vandaag begonnen met meten.
      const r = await client.query(
        `UPDATE users SET ical_token_created = NOW()
          WHERE ical_feed_token IS NOT NULL AND ical_token_created IS NULL`);
      if (r.rowCount > 0) {
        console.log(`Migratie 046: ${r.rowCount} bestaande agendalink(s) gedateerd op vandaag.`);
      }
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

module.exports = { MIGRATIONS, runMigrations };
