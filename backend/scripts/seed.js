const { pool } = require('../src/db');
const bcrypt = require('bcryptjs');
require('dotenv').config();

async function run() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.error('Missing ADMIN_EMAIL or ADMIN_PASSWORD');
    process.exit(1);
  }

  const teams = [
    { id: 'vlot1', name: 'Vlot 1 (Begeleiding)', color: '#3b82f6' },
    { id: 'vlot2', name: 'Vlot 2 (Begeleiding)', color: '#8b5cf6' },
    { id: 'cargo', name: 'Cargo (Dagbesteding)', color: '#10b981' },
    { id: 'overkoepelend', name: 'Overkoepelend (Kantoor)', color: '#f59e0b' },
    { id: 'jobstudent', name: 'Jobstudenten/Stagiairs', color: '#ec4899' }
  ];

  await pool.query('BEGIN');
  try {
    for (const team of teams) {
      await pool.query(
        `INSERT INTO teams (id, name, color)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, color = EXCLUDED.color`,
        [team.id, team.name, team.color]
      );
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`,
      ['Admin', adminEmail.toLowerCase(), passwordHash, 'admin']
    );

    await pool.query('COMMIT');
    console.log('Seed complete');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
