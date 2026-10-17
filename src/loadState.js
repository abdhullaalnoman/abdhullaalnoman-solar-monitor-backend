// src/loadState.js — keeps hourly_load_state up to date (battery load ON / OFF time).
// The rule itself lives in the SQL function solar_load_stats (database/migrations/0001_load_state.sql).
// This file only decides WHEN to run it. Everything here is an upsert, so repeats and retries never double count.

require('dotenv').config();
const { query } = require('./db');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';
// Longest time one reading may stand for. Defaults to MAX_GAP_SECONDS (what the energy and battery code already use).
const _g = parseInt(process.env.LOAD_MAX_GAP_SECONDS || process.env.MAX_GAP_SECONDS, 10);
const LOAD_MAX_GAP_SECONDS = Number.isFinite(_g) && _g > 0 ? _g : 300;

// Rebuilds the hour that contains `at`, looking at the data up to `asOf` (default now).
// An hour that has fully passed is evaluated completely and marked finalized.
const REBUILD_SQL = `
  WITH h AS (SELECT (date_trunc('hour', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS hs),
       e AS (SELECT h.hs, LEAST(h.hs + INTERVAL '1 hour', $4::timestamptz) AS he FROM h)
  INSERT INTO hourly_load_state
    (solar_code, hour_start, on_seconds, off_seconds, load_ws_on, min_load_w, max_load_w,
     on_transitions, off_transitions, reading_count, finalized, updated_at)
  SELECT $1, e.hs, s.on_seconds, s.off_seconds, s.load_ws_on, s.min_load_w, s.max_load_w,
         s.on_transitions, s.off_transitions, s.reading_count, (e.he >= e.hs + INTERVAL '1 hour'), NOW()
  FROM e, solar_load_stats($1, e.hs, e.he, $5::int) s
  ON CONFLICT (solar_code, hour_start) DO UPDATE SET
    on_seconds = EXCLUDED.on_seconds, off_seconds = EXCLUDED.off_seconds, load_ws_on = EXCLUDED.load_ws_on,
    min_load_w = EXCLUDED.min_load_w, max_load_w = EXCLUDED.max_load_w,
    on_transitions = EXCLUDED.on_transitions, off_transitions = EXCLUDED.off_transitions,
    reading_count = EXCLUDED.reading_count, finalized = EXCLUDED.finalized, updated_at = NOW()`;

async function rebuildHour(code, at, asOf = new Date()) {
  await query(REBUILD_SQL, [code, at, TIMEZONE, asOf, LOAD_MAX_GAP_SECONDS]);
}

// Called by the engine after each reading is saved. prevSeen = time of the site's previous reading (or null).
async function onReading(code, now, prevSeen) {
  const hour = (d) => Math.floor(new Date(d).getTime() / 3600000);
  if (prevSeen && hour(prevSeen) !== hour(now)) await rebuildHour(code, prevSeen, now);   // closes the earlier hour
  await rebuildHour(code, now, now);
}

// Hours that ended while a site was silent never get a "next reading" to close them; this closes them. Safe to repeat.
async function finalizeStale(limit = 500) {
  const r = await query(
    `SELECT solar_code, hour_start FROM hourly_load_state
     WHERE NOT finalized AND hour_start + INTERVAL '1 hour' <= NOW() ORDER BY hour_start LIMIT $1`, [limit]);
  for (const row of r.rows) await rebuildHour(row.solar_code, row.hour_start, new Date());
  return r.rowCount;
}

module.exports = { LOAD_MAX_GAP_SECONDS, rebuildHour, onReading, finalizeStale };
