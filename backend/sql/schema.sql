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
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'hoofdverantwoordelijke', 'teamverantwoordelijke', 'medewerker')),
  team_id TEXT REFERENCES teams(id),
  -- Employee/schedule fields
  main_team TEXT REFERENCES teams(id),
  extra_teams TEXT[] DEFAULT '{}',
  contract_hours NUMERIC DEFAULT 0,
  active BOOLEAN DEFAULT true,
  week_schedule_week1 JSONB DEFAULT '[]',
  week_schedule_week2 JSONB DEFAULT '[]',
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

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id);
CREATE INDEX IF NOT EXISTS idx_availability_date ON availability(date);
CREATE INDEX IF NOT EXISTS idx_availability_user ON availability(user_id);
CREATE INDEX IF NOT EXISTS idx_users_main_team ON users(main_team);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(active);
