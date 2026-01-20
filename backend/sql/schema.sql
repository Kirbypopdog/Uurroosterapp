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
