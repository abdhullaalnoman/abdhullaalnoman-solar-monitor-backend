// src/db.js — PostgreSQL connection pool

require('dotenv').config();
const { Pool, types } = require('pg');

// Return NUMERIC columns as JS numbers (pg gives strings by default)
types.setTypeParser(1700, (v) => parseFloat(v));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'solar_monitor',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function testConnection() {
  try {
    await pool.query('SELECT 1');
    console.log('[DB] Connection OK');
    return true;
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    return false;
  }
}

module.exports = { query, pool, testConnection };
