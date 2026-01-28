-- Core tables
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'hoofdverantwoordelijke', 'teamverantwoordelijke', 'medewerker')),
  team_id TEXT REFERENCES teams(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Employees (medewerkers met roosters)
CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  main_team TEXT REFERENCES teams(id),
  extra_teams TEXT[] DEFAULT '{}',
  contract_hours NUMERIC DEFAULT 0,
  active BOOLEAN DEFAULT true,
  week_schedule_week1 JSONB DEFAULT '[]',
  week_schedule_week2 JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Shifts (diensten)
CREATE TABLE IF NOT EXISTS shifts (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  team TEXT REFERENCES teams(id),
  date DATE NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Availability (afwezigheid/verlof)
CREATE TABLE IF NOT EXISTS availability (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  type TEXT NOT NULL,
  reason TEXT DEFAULT '',
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(employee_id, date)
);

-- Settings (app instellingen)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id);
CREATE INDEX IF NOT EXISTS idx_availability_date ON availability(date);
CREATE INDEX IF NOT EXISTS idx_availability_employee ON availability(employee_id);
