require('dotenv').config();
const WebSocket = require('ws');
const { query, testConnection } = require('./db');
const { preloadEngine, processReading, secondsSinceLast } = require('./solarEngine');
const calc = require('./calc');

const WS_URL = process.env.SOLAR_WS_URL;
const CACHE_REFRESH_MS = parseInt(process.env.SOLAR_CACHE_REFRESH_MS) || 60000;
const RECONNECT_DELAY_MS = 5000;

// Order MUST match the comma-separated values in the feed, exactly:
//   CE00001:24.6,7.6,24.8,-25.8,10,31.5,78,4.1,0,1,GrameenPhone,22,16-9-2026,1,1,36
const FIELDS = [
  'solar_voltage', 'solar_current', 'battery_voltage', 'battery_current', 'sunlight_intensity',
  'temperature', 'humidity', 'internal_battery_volt', 'psu1', 'psu2',
  'operator', 'signal_strength', 'active', 'server1', 'server2', 'data_sequence',
];
const STRING_FIELDS = new Set(['operator', 'active']);          // stored as text, exactly as sent
const INTEGER_FIELDS = new Set(['server1', 'server2', 'data_sequence']);

// { [solar_code]: row from solar_list } — refreshed every minute so we
// don't hit the DB on every message, and settings changes are picked up.
let knownSites = new Map();

async function refreshSiteCache() {
  try {
    const res = await query('SELECT * FROM solar_list');
    knownSites = new Map(res.rows.map(r => [r.solar_code, r]));
    console.log(`[SOLAR WS] Site cache refreshed — ${knownSites.size} known solar_code(s)`);
  } catch (err) {
    console.error('[SOLAR WS] Failed to refresh solar_list cache:', err.message);
  }
}

// "solar1: 12,10,10,12,10,32,70,4.2,1,1,gra,70,16-9-2026, 1, 0,90" -> { solar_code: 'solar1', solar_voltage: 12, ... }
// An empty value (",,") becomes NULL.
function parseMessage(raw) {
  const sepIdx = raw.indexOf(':');
  if (sepIdx === -1) return null;

  const solar_code = raw.slice(0, sepIdx).trim();
  const parts = raw.slice(sepIdx + 1).split(',').map(v => v.trim());

  if (parts.length !== FIELDS.length) {
    console.warn(`[SOLAR WS] Malformed payload for ${solar_code}: expected ${FIELDS.length} values, got ${parts.length}`);
    return null;
  }

  const row = { solar_code };
  FIELDS.forEach((field, i) => {
    const v = parts[i];
    if (STRING_FIELDS.has(field)) {
      row[field] = v || null;
    } else if (INTEGER_FIELDS.has(field)) {
      const n = v === '' ? NaN : parseInt(v, 10);
      row[field] = Number.isNaN(n) ? null : n;
    } else {
      const n = v === '' ? NaN : parseFloat(v);
      row[field] = Number.isNaN(n) ? null : n;
    }
  });

  // solar_current / battery_current: the minus sign is removed (-25.8 -> 25.8) and that value is used
  // everywhere: it is stored, and the calculations (power, battery, load_w, consumption) use the same number.
  for (const f of ['solar_current', 'battery_current']) {
    if (row[f] !== null) row[f] = Math.abs(row[f]);
  }
  return row;
}

function applyBatteryOffset(row, offset) {
  const o = offset === null || offset === undefined ? null : Number(offset);
  if (o !== null && Number.isFinite(o) && o > 0 && row.battery_current !== null && row.battery_current < o) {
    row.battery_current = 0;
  }
  return row;
}

// Read the site's current offset straight from solar_list so a change is used from the very next reading.
async function currentBatteryOffset(solar_code, fallbackSite) {
  try {
    const r = await query('SELECT battery_current_offset FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (r.rowCount > 0) return r.rows[0].battery_current_offset;
  } catch (err) {
    console.error(`[SOLAR WS] could not read battery_current_offset for ${solar_code}:`, err.message);
  }
  return fallbackSite ? fallbackSite.battery_current_offset : null;
}

async function insertDeviceData(row, now, dataTime) {
  const cols = ['solar_code', ...FIELDS, 'data_time', 'created_at'];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const params = cols.map(c => {
    if (c === 'data_time') return dataTime;
    if (c === 'created_at') return now;
    return row[c];
  });
  try {
    await query(`INSERT INTO solar_device_data (${cols.join(',')}) VALUES (${placeholders.join(',')})`, params);
  } catch (err) {
    console.error(`[SOLAR WS] solar_device_data insert failed for ${row.solar_code}:`, err.message);
  }
}

async function handleMessage(raw) {
  console.log('[SOLAR WS] RAW:', raw);

  const row = parseMessage(raw);
  if (!row) {
    console.log('[SOLAR WS] Could not parse this message (wrong format) — skipped.');
    return;
  }
  const site = knownSites.get(row.solar_code);
  if (!site) {
    console.log(`[SOLAR WS] solar_code "${row.solar_code}" NOT found in solar_list — skipped.`);
    return;
  }

  applyBatteryOffset(row, await currentBatteryOffset(row.solar_code, site));

  const now = new Date();
  // data_time = whole SECONDS since this site's previous reading (0 for its first).
  // Measured here, before the new reading updates "last seen".
  const dataTime = secondsSinceLast(row.solar_code, now);
  await insertDeviceData(row, now, dataTime);
  await processReading(row, site, now, dataTime);
}

let queue = Promise.resolve();

function connect() {
  console.log(`[SOLAR WS] Connecting to ${WS_URL}...`);
  const socket = new WebSocket(WS_URL);

  socket.on('open', () => console.log('[SOLAR WS] Connected.'));

  socket.on('message', (data) => {
    const raw = data.toString();
    queue = queue.then(() => handleMessage(raw)).catch(err =>
      console.error('[SOLAR WS] Handler error:', err.message));
  });

  socket.on('close', () => {
    console.warn(`[SOLAR WS] Connection closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  socket.on('error', (err) => {
    console.error('[SOLAR WS] Socket error:', err.message);
    socket.close();
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', err => console.error('[SOLAR WS] Uncaught:', err));
process.on('unhandledRejection', err => console.error('[SOLAR WS] Unhandled rejection:', err));

async function boot() {
  console.log('═══════════════════════════════════════');
  console.log('  solar_monitor — Solar WS Worker       ');
  console.log('═══════════════════════════════════════');

  if (!WS_URL) {
    console.error('[SOLAR WS] SOLAR_WS_URL is not set in .env. Exiting.');
    process.exit(1);
  }
  if (!(await testConnection())) {
    console.error('[SOLAR WS] Cannot connect to database. Exiting.');
    process.exit(1);
  }

  await refreshSiteCache();
  setInterval(refreshSiteCache, CACHE_REFRESH_MS);
  await preloadEngine();
  connect();
}

if (require.main === module) boot();

module.exports = { parseMessage, applyBatteryOffset };