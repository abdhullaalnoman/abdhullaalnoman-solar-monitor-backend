// src/solarEngine.js — turns one parsed reading into stored numbers.
//
// For every reading that arrives it does these things:
//   1. power = solar_voltage x solar_current, then a running average of power
//        (1st reading: P1 | 2nd: (P1+P2)/2 | later: (previous avg + new power)/2)
//   2. energy for this reading = avg watts x data_time (s -> hours) / 1000  = kWh
//      ADDED to today's row in solar_energy_daily; then for that day
//        revenue = energy_kwh x unit_rate      carbon = energy_kwh x carbon_factor   (both from solar_list)
//   3. battery: full Wh = battery_voltage x battery_capacity; remain + solar energy (max full), then - battery energy used (min 0);
//      SOC % = remain / full x 100
//   4. rewrites the single row in solar_current_status (latest values + battery + avg)
//   5. saves ONE row in calculated_solar_device_data (same created_at as the raw row) with:
//      data_time, load, full battery capacity, present battery capacity, and the 4 card values
//      as they stand right after this reading: current power, today's energy, carbon, revenue
//   6. updates the CURRENT HOUR's row in hourly_solar_data from calculated_solar_device_data
//      (live: it changes with every reading until the hour ends, then the next hour starts a new row)
//   7. feeds load_w to load_events_apply(), which keeps the battery-load ON / OFF events (load_events table)
//
// All formulas are in calc.js — this file only moves numbers in and out of the DB.

require('dotenv').config();
const { query } = require('./db');
const calc = require('./calc');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';
// A data_time longer than this is cut to this many seconds when counting energy
// (so an outage is not counted as generation). Set MAX_GAP_SECONDS=0 to count the full data_time.
// A blank / non-numeric value in .env falls back to 300 (a NaN here used to make the battery-consumption SQL fail).
const _gap = parseInt(process.env.MAX_GAP_SECONDS, 10);
const MAX_GAP_SECONDS = Number.isFinite(_gap) && _gap >= 0 ? _gap : 300;

// { [solar_code]: Date of the previous reading } — used to measure the gap
const lastSeen = new Map();
// { [solar_code]: running average power (W) after the previous reading }
const lastAvg = new Map();
// { [solar_code]: energy left in the battery (Wh) after the previous reading }
const lastRemain = new Map();

// Postgres returns NUMERIC columns as strings; turn them into numbers (or null).
const num = (v) => (v === null || v === undefined ? null : Number(v));

// ---- hourly_solar_data: rebuilds ONE hour slot from calculated_solar_device_data ----
//   current_power_w  = average of current_power_w of every row in the hour   (sum / count)
//   solar_energy_kwh = energy made in the hour. today_energy_kwh in the table is the day's running
//                      total, so the hour's energy = (last total in the hour) - (total just before the hour).
//   co2_kg = energy x carbon_factor     revenue = energy x unit_rate   (both from solar_list)
// "Just before the hour" = the last row of the same day before the slot. If there is none:
//   - the slot is the day's first hour                -> 0
//   - rows exist earlier that day only in the raw table (readings from before calculated_solar_device_data
//     was filled) -> start counting from this hour's first row, so the earlier energy is not counted in this hour.
// Runs after every reading, so the current hour is always up to date; a finished hour is never touched again.
// ---- daily_solar_data / monthly_solar_data: same style as hourly_solar_data, for a day and for a month ----
//   current_power_w = average of current_power_w of every reading in the day / month   (sum / count)
//   energy_kwh      = the day's energy = last today_energy_kwh of the day (it is the day's running total);
//                     the month's energy = the days of the month added up
//   co2_kg / revenue: the day = energy x the site's carbon_factor / unit_rate (solar_list);
//                     the month = the day rows' co2_kg / revenue added up (so each day keeps the rate it was made with)
// The day is rebuilt from calculated_solar_device_data after every reading; the month is rebuilt from the day rows.
const DAILY_SQL = `
  WITH d AS (
    SELECT ($2::timestamptz AT TIME ZONE $3)::date AS day,
           (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS day_start
  ),
  agg AS (
    SELECT AVG(c.current_power_w)   AS avg_power,
           COUNT(c.current_power_w) AS cnt,
           COALESCE(MAX(c.today_energy_kwh), 0) AS kwh
    FROM calculated_solar_device_data c, d
    WHERE c.solar_code = $1 AND c.created_at >= d.day_start AND c.created_at < d.day_start + INTERVAL '1 day'
  )
  INSERT INTO daily_solar_data (solar_code, day, current_power_w, reading_count, energy_kwh, co2_kg, revenue, updated_at)
  SELECT $1, d.day, ROUND(COALESCE(agg.avg_power, 0), 2), agg.cnt::int, agg.kwh, agg.kwh * $4::numeric, agg.kwh * $5::numeric, NOW()
  FROM d, agg
  ON CONFLICT (solar_code, day) DO UPDATE SET
    current_power_w = EXCLUDED.current_power_w, reading_count = EXCLUDED.reading_count,
    energy_kwh = EXCLUDED.energy_kwh, co2_kg = EXCLUDED.co2_kg, revenue = EXCLUDED.revenue, updated_at = NOW()
  RETURNING current_power_w, reading_count, energy_kwh
`;
const MONTHLY_SQL = `
  WITH m AS (
    SELECT date_trunc('month', $2::timestamptz AT TIME ZONE $3)::date AS month
  ),
  agg AS (
    SELECT COALESCE(SUM(d.energy_kwh), 0) AS kwh,
           COALESCE(SUM(d.co2_kg), 0)     AS co2,
           COALESCE(SUM(d.revenue), 0)    AS rev,
           COALESCE(SUM(d.reading_count), 0) AS cnt,
           SUM(d.current_power_w * d.reading_count) / NULLIF(SUM(d.reading_count), 0) AS avg_power
    FROM daily_solar_data d, m
    WHERE d.solar_code = $1 AND d.day >= m.month AND d.day < (m.month + INTERVAL '1 month')::date
  )
  INSERT INTO monthly_solar_data (solar_code, month, current_power_w, reading_count, energy_kwh, co2_kg, revenue, updated_at)
  SELECT $1, m.month, ROUND(COALESCE(agg.avg_power, 0), 2), agg.cnt::int, agg.kwh, agg.co2, agg.rev, NOW()
  FROM m, agg
  ON CONFLICT (solar_code, month) DO UPDATE SET
    current_power_w = EXCLUDED.current_power_w, reading_count = EXCLUDED.reading_count,
    energy_kwh = EXCLUDED.energy_kwh, co2_kg = EXCLUDED.co2_kg, revenue = EXCLUDED.revenue, updated_at = NOW()
  RETURNING current_power_w, reading_count, energy_kwh
`;

const HOURLY_SQL = `
  WITH h AS (
    SELECT (date_trunc('hour', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS hour_start,
           (date_trunc('day',  $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS day_start
  ),
  hr AS (
    SELECT AVG(c.current_power_w)   AS avg_power,
           COUNT(c.current_power_w) AS cnt,
           MAX(c.today_energy_kwh)  AS last_total,
           MIN(c.created_at) FILTER (WHERE c.today_energy_kwh IS NOT NULL) AS first_at
    FROM calculated_solar_device_data c, h
    WHERE c.solar_code = $1
      AND c.created_at >= h.hour_start AND c.created_at < h.hour_start + INTERVAL '1 hour'
  ),
  base AS (
    SELECT COALESCE(
      (SELECT c.today_energy_kwh FROM calculated_solar_device_data c, h
        WHERE c.solar_code = $1 AND c.today_energy_kwh IS NOT NULL
          AND c.created_at >= h.day_start AND c.created_at < h.hour_start
        ORDER BY c.created_at DESC LIMIT 1),
      CASE WHEN (SELECT hour_start = day_start FROM h) THEN 0
           WHEN EXISTS (SELECT 1 FROM solar_device_data d, h, hr
                         WHERE d.solar_code = $1 AND d.created_at >= h.day_start AND d.created_at < hr.first_at)
             THEN (SELECT c.today_energy_kwh FROM calculated_solar_device_data c, hr
                    WHERE c.solar_code = $1 AND c.created_at = hr.first_at LIMIT 1)
           ELSE 0 END
    ) AS base_total
  )
  INSERT INTO hourly_solar_data
    (solar_code, hour_start, hour_end, current_power_w, reading_count, solar_energy_kwh, co2_kg, revenue, updated_at)
  SELECT $1, h.hour_start, h.hour_start + INTERVAL '1 hour',
         ROUND(hr.avg_power, 2), hr.cnt::int, e.kwh, e.kwh * $4::numeric, e.kwh * $5::numeric, NOW()
  FROM h, hr, base,
       LATERAL (SELECT GREATEST(COALESCE(hr.last_total, base.base_total) - base.base_total, 0) AS kwh) e
  ON CONFLICT (solar_code, hour_start) DO UPDATE SET
    hour_end         = EXCLUDED.hour_end,
    current_power_w  = EXCLUDED.current_power_w,
    reading_count    = EXCLUDED.reading_count,
    solar_energy_kwh = EXCLUDED.solar_energy_kwh,
    co2_kg           = EXCLUDED.co2_kg,
    revenue          = EXCLUDED.revenue,
    updated_at       = NOW()
  RETURNING hour_start, current_power_w, reading_count, solar_energy_kwh, co2_kg, revenue`;

// Reload "last seen" from the DB so a worker restart doesn't lose the gap.
async function preloadEngine() {
  lastSeen.clear();
  lastAvg.clear();
  lastRemain.clear();
  const res = await query('SELECT solar_code, last_seen_at, avg_power_w, battery_remain_wh FROM solar_current_status');
  for (const r of res.rows) {
    lastSeen.set(r.solar_code, new Date(r.last_seen_at));
    if (r.avg_power_w !== null) lastAvg.set(r.solar_code, Number(r.avg_power_w));
    if (r.battery_remain_wh !== null) lastRemain.set(r.solar_code, Number(r.battery_remain_wh));
  }
  console.log(`[SOLAR ENGINE] Preloaded ${res.rowCount} site(s)`);
  await checkCalculatedTable();
  await checkHourlyTable();
  await checkTable('daily_solar_data', ['solar_code', 'day', 'current_power_w', 'reading_count', 'energy_kwh', 'co2_kg', 'revenue', 'updated_at']);
  await checkTable('monthly_solar_data', ['solar_code', 'month', 'current_power_w', 'reading_count', 'energy_kwh', 'co2_kg', 'revenue', 'updated_at']);
}

async function checkTable(name, cols) {
  try {
    const res = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [name]
    );
    const have = new Set(res.rows.map((r) => r.column_name));
    const missing = cols.filter((c) => !have.has(c));
    if (res.rowCount === 0) console.error(`[SOLAR ENGINE] ${name} NOT FOUND — run migration7.sql`);
    else if (missing.length) console.error(`[SOLAR ENGINE] ${name} is MISSING columns: ${missing.join(', ')} — run migration7.sql`);
    else console.log(`[SOLAR ENGINE] ${name} OK`);
  } catch (err) {
    console.error(`[SOLAR ENGINE] could not check ${name}:`, err.message);
  }
}

// Says clearly, once at start-up, whether calculated_solar_device_data is ready for this version of the engine.
const CALC_COLUMNS = [
  'solar_code', 'data_time', 'load_w', 'full_battery_capacity', 'battery_present_capacity',
  'current_power_w', 'today_energy_kwh', 'today_co2_kg', 'today_revenue', 'created_at',
];
const HOURLY_COLUMNS = [
  'solar_code', 'hour_start', 'hour_end', 'current_power_w', 'reading_count',
  'solar_energy_kwh', 'co2_kg', 'revenue', 'updated_at',
];
async function checkHourlyTable() {
  try {
    const res = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'hourly_solar_data'`
    );
    const have = new Set(res.rows.map((r) => r.column_name));
    const missing = HOURLY_COLUMNS.filter((c) => !have.has(c));
    if (res.rowCount === 0) console.error('[SOLAR ENGINE] hourly_solar_data NOT FOUND — run migration5.sql');
    else if (missing.length) console.error(`[SOLAR ENGINE] hourly_solar_data is MISSING columns: ${missing.join(', ')} — run the updated migration5.sql`);
    else console.log('[SOLAR ENGINE] hourly_solar_data OK — the current hour is updated live on every reading');
  } catch (err) {
    console.error('[SOLAR ENGINE] could not check hourly_solar_data:', err.message);
  }
}

async function checkCalculatedTable() {
  try {
    const res = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'calculated_solar_device_data'`
    );
    const have = new Set(res.rows.map((r) => r.column_name));
    const missing = CALC_COLUMNS.filter((c) => !have.has(c));
    if (res.rowCount === 0) {
      console.error('[SOLAR ENGINE] calculated_solar_device_data NOT FOUND — run migration4.sql');
    } else if (missing.length) {
      console.error(`[SOLAR ENGINE] calculated_solar_device_data is MISSING columns: ${missing.join(', ')} — run the updated migration4.sql`);
    } else {
      console.log('[SOLAR ENGINE] calculated_solar_device_data OK — engine v2 saves data_time, load, battery capacities AND the 4 card values');
    }
  } catch (err) {
    console.error('[SOLAR ENGINE] could not check calculated_solar_device_data:', err.message);
  }
}

// Whole SECONDS since this site's previous reading. 0 for the site's very first reading.
// This is the number stored in solar_device_data.data_time.
function secondsSinceLast(code, now) {
  const prev = lastSeen.get(code);
  return prev ? Math.max(0, Math.round((now - prev) / 1000)) : 0;
}

// parsed  = the reading as parsed from the feed (only used for solar_code, and as a fallback)
// site    = that site's row from solar_list (battery_voltage, battery_capacity, ...)
// now     = when the reading arrived (also the created_at of its solar_device_data row)
// gapSec  = secondsSinceLast(code, now), measured BEFORE this reading was saved
//
// Everything that is calculated here is taken from the row the worker just saved in solar_device_data
// (same solar_code + same created_at): solar_voltage, solar_current, battery_voltage, battery_current, data_time.
// So calculated_solar_device_data is always built from solar_device_data, not from the in-memory feed line.
async function processReading(parsed, site, now, gapSecIn) {
  const code = parsed.solar_code;
  let row = parsed;
  let gapSec = gapSecIn;
  try {
    const saved = await query(
      `SELECT solar_voltage, solar_current, battery_voltage, battery_current, sunlight_intensity,
              temperature, humidity, data_time
       FROM solar_device_data WHERE solar_code = $1 AND created_at = $2::timestamptz
       ORDER BY id DESC LIMIT 1`,
      [code, now]
    );
    if (saved.rowCount > 0) {
      const d = saved.rows[0];
      row = { ...parsed, ...d };
      if (d.data_time !== null && d.data_time !== undefined) gapSec = d.data_time;
    } else {
      console.error(`[SOLAR ENGINE] ${code}: no solar_device_data row found for ${now.toISOString()} — using the feed values instead`);
    }
  } catch (err) {
    console.error(`[SOLAR ENGINE] ${code}: could not read solar_device_data — using the feed values instead:`, err.message);
  }
  // carbon factor (kg/kWh) and unit rate (৳/kWh) come from solar_list, read fresh for every reading,
  // so a change made with PATCH /api/solar/:solar_code is used from the very next reading.
  const goodRate = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  let carbonFactor = goodRate(site && site.carbon_factor);
  let unitRate = goodRate(site && site.unit_rate);
  try {
    const rr = await query('SELECT carbon_factor, unit_rate FROM solar_list WHERE solar_code = $1', [code]);
    if (rr.rowCount > 0) {
      carbonFactor = goodRate(rr.rows[0].carbon_factor);
      unitRate = goodRate(rr.rows[0].unit_rate);
    }
  } catch (err) {
    console.error(`[SOLAR ENGINE] ${code}: could not read carbon_factor / unit_rate from solar_list:`, err.message);
  }
  // No hard-coded default: if a site's carbon_factor / unit_rate is empty, its CO2 / revenue are 0 until you set them.
  if (carbonFactor === null || unitRate === null) {
    console.warn(`[SOLAR ENGINE] ${code}: ${carbonFactor === null ? 'carbon_factor ' : ''}${unitRate === null ? 'unit_rate ' : ''}not set in solar_list — treated as 0 (set it with PATCH /api/solar/${code})`);
    if (carbonFactor === null) carbonFactor = 0;
    if (unitRate === null) unitRate = 0;
  }
  const solarA   = row.solar_current;
  const batteryA = row.battery_current;
  const prevSeen = lastSeen.get(code) || null;   // time of the previous reading (before this one updates it)

  try {
    // 1. Power, running average, and the energy of this reading
    const power_w = calc.powerW(row.solar_voltage, solarA);
    const avg_w   = calc.runningAvgPower(lastAvg.get(code) ?? null, power_w);
    const kwh     = calc.energyKwh(avg_w, gapSec, MAX_GAP_SECONDS);   // first reading: data_time 0 -> 0 kWh

    // 2. Add the energy to today's total, then re-derive today's revenue + carbon from the total
    //    (a new row is created at local midnight)
    const daily = await query(
      `INSERT INTO solar_energy_daily (solar_code, day, energy_kwh, revenue, co2_kg, peak_power_w)
       VALUES ($1, (($2::timestamptz) AT TIME ZONE $3)::date,
               $4::numeric, $4::numeric * $5::numeric, $4::numeric * $6::numeric, $7)
       ON CONFLICT (solar_code, day) DO UPDATE SET
         energy_kwh   = solar_energy_daily.energy_kwh + EXCLUDED.energy_kwh,
         revenue      = (solar_energy_daily.energy_kwh + EXCLUDED.energy_kwh) * $5::numeric,
         co2_kg       = (solar_energy_daily.energy_kwh + EXCLUDED.energy_kwh) * $6::numeric,
         peak_power_w = GREATEST(solar_energy_daily.peak_power_w, EXCLUDED.peak_power_w),
         updated_at   = NOW()
       RETURNING energy_kwh, co2_kg, revenue`,
      [code, now, TIMEZONE, kwh, unitRate, carbonFactor, power_w]
    );
    // today's totals right after this reading (these are the numbers the dashboard cards show)
    const today = daily.rows[0];

    // 3. Battery: full Wh = battery_voltage x battery_capacity (solar_list)
    //    remain = remain + solar energy (up to full), then - battery energy used (down to 0)
    //    The same MAX_GAP_SECONDS limit as the energy is applied to data_time.
    const batterySec = MAX_GAP_SECONDS > 0 ? Math.min(gapSec, MAX_GAP_SECONDS) : gapSec;
    const fullWh = calc.batteryFullWh(num(site.battery_voltage), num(site.battery_capacity));
    const remainWh = calc.batteryRemainWh(
      lastRemain.get(code) ?? null, fullWh, power_w, row.battery_voltage, batteryA, batterySec
    );
    const soc = calc.socPercent(remainWh, fullWh);
    const backup = calc.backupHours(soc, num(site.battery_capacity), batteryA);

    // 4. Rewrite the one "current" row for this site
    await query(
      `INSERT INTO solar_current_status
         (solar_code, last_seen_at, solar_voltage, solar_current, sunlight_intensity,
          battery_voltage, battery_current, temperature, humidity,
          power_w, avg_power_w, battery_remain_wh, soc_percent, backup_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (solar_code) DO UPDATE SET
         last_seen_at       = EXCLUDED.last_seen_at,
         solar_voltage      = EXCLUDED.solar_voltage,
         solar_current      = EXCLUDED.solar_current,
         sunlight_intensity = EXCLUDED.sunlight_intensity,
         battery_voltage    = EXCLUDED.battery_voltage,
         battery_current    = EXCLUDED.battery_current,
         temperature        = EXCLUDED.temperature,
         humidity           = EXCLUDED.humidity,
         power_w            = EXCLUDED.power_w,
         avg_power_w        = EXCLUDED.avg_power_w,
         battery_remain_wh  = EXCLUDED.battery_remain_wh,
         soc_percent        = EXCLUDED.soc_percent,
         backup_hours       = EXCLUDED.backup_hours`,
      [code, now, row.solar_voltage, row.solar_current, row.sunlight_intensity,
       row.battery_voltage, row.battery_current, row.temperature, row.humidity,
       power_w, avg_w, remainWh, soc, backup]
    );

    lastSeen.set(code, now);
    lastAvg.set(code, avg_w);
    if (remainWh === null) lastRemain.delete(code); else lastRemain.set(code, remainWh);

    // 5. Save what was calculated for THIS reading, with the same created_at as its raw row.
    //    load = battery_voltage x battery_current (exact, not an average).
    //    The 4 card values are saved as they stand after this reading:
    //      current_power_w  = solar_voltage x solar_current of this reading
    //      today_energy_kwh = today's Solar Energy so far     today_co2_kg = that x carbon_factor
    //      today_revenue    = that x unit_rate
    //    A problem here is logged but does not undo steps 1-4.
    let calcSaved = '';
    let calcOk = false;
    let loadW = null;
    try {
      const load_w = row.battery_voltage == null || batteryA == null
        ? null
        : calc.round(row.battery_voltage * batteryA, 2);
      await query(
        `INSERT INTO calculated_solar_device_data
           (solar_code, data_time, load_w, full_battery_capacity, battery_present_capacity,
            current_power_w, today_energy_kwh, today_co2_kg, today_revenue, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [code, gapSec, load_w, fullWh, remainWh,
         power_w, num(today.energy_kwh), num(today.co2_kg), num(today.revenue), now]
      );
      loadW = load_w;
      calcOk = true;
      calcSaved = ` | calc row saved: power ${power_w} W, today ${num(today.energy_kwh)} kWh, co2 ${num(today.co2_kg)} kg, revenue ${num(today.revenue)}`;
    } catch (err) {
      console.error(`[SOLAR ENGINE] calculated_solar_device_data insert failed for ${code} (did you run migration4.sql?):`, err.message);
    }

    // 6. Update this hour's row in hourly_solar_data (built from calculated_solar_device_data).
    //    A problem here is logged but does not undo the steps before it.
    let hourlySaved = '';
    if (calcOk) {
      try {
        const hres = await query(HOURLY_SQL, [code, now, TIMEZONE, carbonFactor, unitRate]);   // $4 = carbon factor, $5 = unit rate (solar_list)
        const h = hres.rows[0];
        const slot = new Date(h.hour_start).toLocaleTimeString('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
        hourlySaved = ` | hour ${slot}: avg ${h.current_power_w} W of ${h.reading_count} readings, ${h.solar_energy_kwh} kWh`;
      } catch (err) {
        console.error(`[SOLAR ENGINE] hourly_solar_data update failed for ${code} (did you run migration5.sql?):`, err.message);
      }
    }

    // 6b. Rebuild today's row in daily_solar_data (from calculated_solar_device_data) and this month's row in monthly_solar_data (from the day rows).
    let dmSaved = '';
    if (calcOk) {
      try {
        const dres = await query(DAILY_SQL, [code, now, TIMEZONE, carbonFactor, unitRate]);   // $4 = carbon factor, $5 = unit rate (solar_list)
        const mres = await query(MONTHLY_SQL, [code, now, TIMEZONE]);
        dmSaved = ` | day: avg ${num(dres.rows[0].current_power_w)} W, ${num(dres.rows[0].energy_kwh)} kWh | month: avg ${num(mres.rows[0].current_power_w)} W, ${num(mres.rows[0].energy_kwh)} kWh`;
      } catch (err) {
        console.error(`[SOLAR ENGINE] daily/monthly update failed for ${code} (did you run migration7.sql?):`, err.message);
      }
    }

    // 7. Battery-load ON / OFF events (load_events). ALL the event rules live in the SQL function load_events_apply
    //    (see database/schema.sql); this only hands it the reading. load_w is the value saved in step 5.
    let eventSaved = '';
    if (calcOk) {
      try {
        await query('SELECT load_events_apply($1, $2::timestamptz, $3::numeric, $4::int)', [code, now, loadW, MAX_GAP_SECONDS]);
        eventSaved = ' | load event updated';
      } catch (err) {
        console.error(`[SOLAR ENGINE] load_events update failed for ${code} (did you run database/schema.sql?):`, err.message);
      }
    }

    console.log(
      `[SOLAR ENGINE] ${code} | ${power_w} W | load ${row.battery_voltage} V x ${batteryA} A | avg ${avg_w.toFixed(2)} W | data_time ${gapSec}s | +${kwh.toFixed(6)} kWh | battery ${remainWh ?? 'N/A'} Wh | SOC ${soc ?? 'N/A'}% | backup ${backup ?? 'N/A'} h${calcSaved}${hourlySaved}${dmSaved}${eventSaved}`
    );
  } catch (err) {
    console.error(`[SOLAR ENGINE] Failed processing ${code} (did you run the migration / schema.sql?):`, err.message);
  }
}

module.exports = { preloadEngine, processReading, secondsSinceLast };