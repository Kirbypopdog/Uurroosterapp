const { pool } = require('../src/db');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    // Read and execute schema
    const schemaPath = path.join(__dirname, '../sql/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('Creating database tables...');
    await pool.query(schema);
    console.log('Tables created successfully');

  } catch (err) {
    console.error('Error setting up database:', err.message);
    // Don't exit with error - tables might already exist
  } finally {
    await pool.end();
  }
}

run();
