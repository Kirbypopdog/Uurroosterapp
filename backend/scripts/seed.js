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
    { id: 'vlot1', name: 'Vlot 1 (Begeleiding)', color: '#4a7c6f' },
    { id: 'vlot2', name: 'Vlot 2 (Begeleiding)', color: '#c08a4a' },
    { id: 'cargo', name: 'Cargo (Dagbesteding)', color: '#5b7fa6' },
    { id: 'overkoepelend', name: 'Overkoepelend (Kantoor)', color: '#9a6a9e' },
    { id: 'jobstudent', name: 'Jobstudenten/Stagiairs', color: '#b9656a' }
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
