-- Core tables

-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);

-- Users (merged with employees - contains both account and schedule data)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  -- Account fields
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'roosterverantwoordelijke', 'medewerker')),
  team_id TEXT REFERENCES teams(id),
  -- Employee/schedule fields
  main_team TEXT REFERENCES teams(id),
  extra_teams TEXT[] DEFAULT '{}',
  contract_hours NUMERIC DEFAULT 0,
  active BOOLEAN DEFAULT true,
  week_schedule_week1 JSONB DEFAULT '[]',
  week_schedule_week2 JSONB DEFAULT '[]',
  week_schedules JSONB DEFAULT NULL,
  email_notifications_enabled BOOLEAN DEFAULT true,
  onboarding_flags JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Shifts (diensten) - references users directly
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team TEXT REFERENCES teams(id),
  date DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  notes TEXT DEFAULT '',
  source TEXT DEFAULT 'manual' CHECK (source IN ('auto', 'manual')),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Availability (afwezigheid/verlof) - references users directly
CREATE TABLE IF NOT EXISTS availability (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  type TEXT NOT NULL,
  reason TEXT DEFAULT '',
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- Settings (app instellingen)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Shift blocks (prevent auto-regeneration of deleted shifts)
-- CONCEPT-DRIVEN NOTE: In het concept-driven systeem worden shift_blocks nog gebruikt als
-- veiligheidsnet bij:
--   1. DELETE /shifts/:id → maakt block aan (voorkomt dat apply-schedule ze terugzet)
--   2. POST /shifts (manual create) → verwijdert block voor die user/date
--   3. generateAutoShifts() checked blocks vóór generatie
--   4. schedule-drafts/:id/apply respecteert blocks tenzij clearBlocks=true
-- Kandidaat voor toekomstige vereenvoudiging wanneer alle regeneratie via concepten loopt.
CREATE TABLE IF NOT EXISTS shift_blocks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  UNIQUE(user_id, date)
);

-- Shift swap/takeover requests
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
);

-- Schedule drafts (roster builder concepts)
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
  valid_from DATE,
  valid_until DATE,
  last_applied_from DATE,
  last_applied_until DATE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name TEXT,
  type TEXT DEFAULT 'basis',
  holiday_period_id TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Shift activities (activiteiten binnen shifts)
CREATE TABLE IF NOT EXISTS shift_activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  type TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit log (tracks all changes)
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'REJECT', 'CANCEL', 'LOGIN', 'REPLACE', 'IMPORT', 'MIGRATE')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('shift', 'availability', 'swap_request', 'user', 'settings', 'system', 'shift_activity', 'shift_block')),
  resource_id TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_shifts_team ON shifts(team);
CREATE INDEX IF NOT EXISTS idx_availability_date ON availability(date);
CREATE INDEX IF NOT EXISTS idx_availability_user ON availability(user_id);
CREATE INDEX IF NOT EXISTS idx_users_main_team ON users(main_team);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
CREATE INDEX IF NOT EXISTS idx_shift_blocks_user_date ON shift_blocks(user_id, date);
CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON shift_swap_requests(status);
CREATE INDEX IF NOT EXISTS idx_swap_requests_requester ON shift_swap_requests(requester_user_id);
CREATE INDEX IF NOT EXISTS idx_swap_requests_target ON shift_swap_requests(target_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_drafts_created ON schedule_drafts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);
CREATE INDEX IF NOT EXISTS idx_shift_activities_user_date ON shift_activities(user_id, date);
CREATE INDEX IF NOT EXISTS idx_shifts_source ON shifts(source);
CREATE INDEX IF NOT EXISTS idx_availability_type ON availability(type);
CREATE INDEX IF NOT EXISTS idx_swap_requests_type ON shift_swap_requests(request_type);
CREATE INDEX IF NOT EXISTS idx_schedule_drafts_type ON schedule_drafts(type);
CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);
