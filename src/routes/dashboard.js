// src/routes/dashboard.js — numbers and charts for the solar dashboard
//
// Cards (all sites):   GET /api/dashboard/summary                          (4 card values = last row of calculated_solar_device_data)
// Cards (one site):    GET /api/dashboard/:solar_code/summary
// 4 cards only:        GET /api/dashboard/:solar_code/cards
// Charts (24 points):  GET /api/dashboard/:solar_code/power-generation-24h?date=   <- hourly_solar_data
//                      GET /api/dashboard/:solar_code/solar-energy-24h?date=       <- hourly_solar_data
//                      GET /api/dashboard/:solar_code/carbon-reduction-24h?date=   <- hourly_solar_data
// Month chart:         GET /api/dashboard/:solar_code/daily?month=YYYY-MM          <- daily_solar_data
// Year chart:          GET /api/dashboard/:solar_code/monthly?year=YYYY            <- monthly_solar_data
// Old chart:           GET /api/dashboard/:solar_code/power-24h
// Raw readings:        GET /api/dashboard/:solar_code/raw?start_date=&end_date=
// Charts (4 metrics):  GET /api/dashboard/:solar_code/charts/:metric   metric = power | energy | carbon-reduction | revenue
//                        ?period=day|7d|month|year [&date= | &month= | &year=]   or   ?window=6h [&end=]   (see src/charts.js)
// Load events:        GET /api/dashboard/:solar_code/load-events?period=day|7d|month|year   <- load_events (see src/loadEvents.js)

const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const consumption = require('../consumption');
const loadEvents = require('../loadEvents');
const charts = require('../charts');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';

// Accepts 2026-10-06 or 06-10-2026 or 06/10/2026 (day-month-year). Returns 'YYYY-MM-DD', or null if invalid.
function parseDay(input) {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  let y, m, d, x;
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/.exec(t))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const BAD_DATE = { success: false, error: 'date must look like 2026-10-06 or 06/10/2026 (day/month/year)' };

function serverError(res, err) {
  console.error('[DASHBOARD]', err.message);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}
function notFound(res, code) {
  return res.status(404).json({ success: false, error: `solar_code '${code}' not found` });
}

// One SELECT used for both the single-site and all-sites cards.
// The 4 card values (current power, today's energy / carbon / revenue) come from the LAST row of
// calculated_solar_device_data. Today's three values are 0 if that last row is not from today (Dhaka date).
// status: solar_voltage x solar_current = 0 -> offline, otherwise online (unchanged).
const SUMMARY_SQL = `
  SELECT
    l.solar_code,
    l.solar_name,
    l.solar_panel_voltage,
    l.solar_panel_watt,
    l.battery_voltage                                         AS battery_rated_voltage,
    l.battery_capacity,
    c.last_seen_at,
    -- Card: Current Power Generation (last calculated row)
    COALESCE(k.current_power_w, 0)                            AS current_power_w,
    -- Load: load_w of the LAST row of calculated_solar_device_data, exactly as saved (null if the site has no rows)
    k.load_w                                                  AS load_w,
    -- solar_voltage x solar_current = 0 -> offline, otherwise online
    CASE WHEN COALESCE(c.power_w, 0) = 0 THEN 'offline' ELSE 'online' END AS status,
    -- Cards: Today's Solar Energy / Carbon Reduction / Today's Revenue (last calculated row, if it is from today)
    CASE WHEN (k.created_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date
         THEN ROUND(COALESCE(k.today_energy_kwh, 0), 3) ELSE 0 END  AS today_energy_kwh,
    CASE WHEN (k.created_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date
         THEN ROUND(COALESCE(k.today_co2_kg, 0), 3) ELSE 0 END      AS today_co2_kg,
    CASE WHEN (k.created_at AT TIME ZONE $1)::date = (NOW() AT TIME ZONE $1)::date
         THEN ROUND(COALESCE(k.today_revenue, 0), 2) ELSE 0 END     AS today_revenue,
    COALESCE(d.peak_power_w, 0)                               AS today_peak_power_w,
    -- Battery
    c.battery_voltage,
    c.battery_current,
    c.soc_percent,
    c.backup_hours,
    -- Weather at the site
    c.sunlight_intensity,
    c.temperature,
    c.humidity,
    -- Device info from the site's latest reading
    r.internal_battery_volt,
    r.psu1,
    r.psu2,
    r.operator,
    r.signal_strength,
    r.active,
    r.server1,
    r.server2,
    r.data_sequence
  FROM solar_list l
  LEFT JOIN solar_current_status c ON c.solar_code = l.solar_code
  LEFT JOIN LATERAL (
    SELECT current_power_w, today_energy_kwh, today_co2_kg, today_revenue, load_w, created_at
    FROM calculated_solar_device_data
    WHERE solar_code = l.solar_code
    ORDER BY created_at DESC
    LIMIT 1
  ) k ON true
  LEFT JOIN LATERAL (
    SELECT internal_battery_volt, psu1, psu2, operator, signal_strength,
           active, server1, server2, data_sequence
    FROM solar_device_data
    WHERE solar_code = l.solar_code
    ORDER BY created_at DESC
    LIMIT 1
  ) r ON true
  LEFT JOIN solar_energy_daily d
         ON d.solar_code = l.solar_code
        AND d.day = (NOW() AT TIME ZONE $1)::date
`;

// GET /api/dashboard/summary — every site + overall totals
router.get('/summary', async (req, res) => {
  try {
    const result = await query(`${SUMMARY_SQL} ORDER BY l.solar_code`, [TIMEZONE]);
    const rows = result.rows;
    const sum = (key) => Math.round(rows.reduce((t, r) => t + Number(r[key] || 0), 0) * 1000) / 1000;
    res.json({
      success: true,
      count: rows.length,
      total_online: rows.filter((r) => r.status === 'online').length,
      total_offline: rows.filter((r) => r.status === 'offline').length,
      totals: {
        current_power_w: sum('current_power_w'),
        today_energy_kwh: sum('today_energy_kwh'),
        today_co2_kg: sum('today_co2_kg'),
        today_revenue: sum('today_revenue'),
        total_solar_panel_watt: sum('solar_panel_watt'),       // all sites' solar_panel_watt added together (W)
        total_battery_capacity_ah: sum('battery_capacity'),    // all sites' battery_capacity added together (Ah)
      },
      data: rows,
    });
  } catch (err) { serverError(res, err); }
});

// GET /api/dashboard/:solar_code/summary — the dashboard cards for one site
router.get('/:solar_code/summary', async (req, res) => {
  const { solar_code } = req.params;
  try {
    const result = await query(`${SUMMARY_SQL} WHERE l.solar_code = $2`, [TIMEZONE, solar_code]);
    if (result.rowCount === 0) return notFound(res, solar_code);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// GET /api/dashboard/solar1/cards
// The 4 dashboard cards, taken from the LAST row of calculated_solar_device_data.
router.get('/:solar_code/cards', async (req, res) => {
  const { solar_code } = req.params;
  try {
    const site = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (site.rowCount === 0) return notFound(res, solar_code);
    const r = await query(
      `SELECT current_power_w, today_energy_kwh, today_co2_kg, today_revenue, created_at,
              (created_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date AS is_today
       FROM calculated_solar_device_data WHERE solar_code = $1 ORDER BY created_at DESC LIMIT 1`,
      [solar_code, TIMEZONE]
    );
    const k = r.rows[0];
    res.json({
      success: true, solar_code,
      data: {
        current_power_w: k ? Number(k.current_power_w) || 0 : 0,
        today_energy_kwh: k && k.is_today ? Math.round(k.today_energy_kwh * 1000) / 1000 : 0,
        carbon_reduction_kg: k && k.is_today ? Math.round(k.today_co2_kg * 1000) / 1000 : 0,
        today_revenue: k && k.is_today ? Math.round(k.today_revenue * 100) / 100 : 0,
        last_reading_at: k ? consumption.toLocalISO(k.created_at, TIMEZONE) : null,
      },
    });
  } catch (err) { serverError(res, err); }
});

// GET /api/dashboard/:solar_code/power-24h
// Chart: Power Generation (Last 24 Hours) — average watts in each 15-minute slot.
router.get('/:solar_code/power-24h', async (req, res) => {
  const { solar_code } = req.params;
  try {
    const siteCheck = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (siteCheck.rowCount === 0) return notFound(res, solar_code);

    const result = await query(
      `SELECT time_bucket('15 minutes', created_at) AS time,
              ROUND(AVG(current_power_w), 2)        AS power_w
       FROM calculated_solar_device_data
       WHERE solar_code = $1 AND created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY 1
       ORDER BY 1`,
      [solar_code]
    );
    res.json({ success: true, solar_code, interval: '15 minutes', count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// ---------------------------------------------------------------------------------------------
// 24-hour charts. ONE date at a time (?date=2026-10-06 or 06/10/2026, default today, Dhaka time).
// Always 24 points, one per hour: 12 AM - 1 AM ... 11 PM - 12 AM. An hour with no row (or one that has
// not happened yet) gives 0. "label" is the hour's END time: the 14:00-15:00 hour is "3 PM".
// ---------------------------------------------------------------------------------------------

// The 24 hour slots of the chosen date, joined with a table that has hour_start (+ the columns asked for).
async function hourlySlots(table, columns, solar_code, day) {
  const r = await query(
    `WITH d AS (
       SELECT COALESCE($3::date, (NOW() AT TIME ZONE $2)::date)::text AS day,
              (COALESCE($3::date, (NOW() AT TIME ZONE $2)::date)::timestamp AT TIME ZONE $2) AS day_start
     )
     SELECT d.day, s.i, d.day_start + (s.i * INTERVAL '1 hour') AS hour_start, ${columns.map((c) => `h.${c}`).join(', ')}
     FROM d CROSS JOIN generate_series(0, 23) AS s(i)
     LEFT JOIN ${table} h ON h.solar_code = $1 AND h.hour_start = d.day_start + (s.i * INTERVAL '1 hour')
     ORDER BY s.i`,
    [solar_code, TIMEZONE, day]
  );
  return r.rows;
}
const slotTimes = (row) => {
  const start = new Date(row.hour_start);
  const end = new Date(start.getTime() + 3600 * 1000);
  return {
    label: consumption.hourLabel((row.i + 1) % 24),            // hour END: 14:00 - 15:00 -> "3 PM"
    hour_start: consumption.toLocalISO(start, TIMEZONE),
    hour_end: consumption.toLocalISO(end, TIMEZONE),
  };
};
const n = (v) => (v === null || v === undefined ? 0 : Number(v));

// Power Generation / Solar Energy / Carbon charts: same shape, only the column differs.
async function hourlyChart(req, res, column, key, decimals) {
  const { solar_code } = req.params;
  const day = req.query.date ? parseDay(req.query.date) : null;
  if (req.query.date && !day) return res.status(400).json(BAD_DATE);
  try {
    const site = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (site.rowCount === 0) return notFound(res, solar_code);
    const rows = await hourlySlots('hourly_solar_data', [column], solar_code, day);
    const f = 10 ** decimals;
    const data = rows.map((r) => ({ ...slotTimes(r), [key]: Math.round(n(r[column]) * f) / f }));
    res.json({ success: true, solar_code, date: rows[0].day, timezone: TIMEZONE, data });
  } catch (err) { serverError(res, err); }
}

// GET /api/dashboard/solar1/power-generation-24h?date=06/10/2026   (average watts of each hour)
router.get('/:solar_code/power-generation-24h', (req, res) => hourlyChart(req, res, 'current_power_w', 'current_power_w', 2));
// GET /api/dashboard/solar1/solar-energy-24h?date=06/10/2026       (kWh made in each hour)
router.get('/:solar_code/solar-energy-24h', (req, res) => hourlyChart(req, res, 'solar_energy_kwh', 'energy_kwh', 3));
// GET /api/dashboard/solar1/carbon-reduction-24h?date=06/10/2026   (kg of each hour = energy x the site's carbon_factor)
router.get('/:solar_code/carbon-reduction-24h', (req, res) => hourlyChart(req, res, 'co2_kg', 'co2_kg', 3));

// GET /api/dashboard/solar1/daily?month=2026-10
// Chart: Daily Energy Generation (Current Month), from daily_solar_data. Every day of the month
// is returned, 0 for days with no row. Month defaults to this month.
router.get('/:solar_code/daily', async (req, res) => {
  const { solar_code } = req.params;
  const { month } = req.query;
  if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({ success: false, error: 'month must look like 2026-10' });
  }
  try {
    const siteCheck = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (siteCheck.rowCount === 0) return notFound(res, solar_code);
    const result = await query(
      `WITH m AS (
         SELECT COALESCE($2::date, date_trunc('month', NOW() AT TIME ZONE $3)::date) AS first_day
       )
       SELECT to_char(g.day, 'YYYY-MM-DD')        AS day,
              ROUND(COALESCE(d.energy_kwh, 0), 3) AS energy_kwh,
              ROUND(COALESCE(d.revenue, 0), 2)    AS revenue,
              ROUND(COALESCE(d.co2_kg, 0), 3)     AS co2_kg
       FROM m,
            generate_series(m.first_day, (m.first_day + INTERVAL '1 month - 1 day')::date, INTERVAL '1 day') AS g(day)
       LEFT JOIN daily_solar_data d ON d.solar_code = $1 AND d.day = g.day::date
       ORDER BY g.day`,
      [solar_code, month ? `${month}-01` : null, TIMEZONE]
    );
    res.json({ success: true, solar_code, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// GET /api/dashboard/solar1/monthly?year=2026
// Charts: Monthly Energy (kWh), Revenue (৳), Carbon Reduction (kg), from monthly_solar_data.
// One call returns all three numbers for each of the 12 months (0 for months with no row).
router.get('/:solar_code/monthly', async (req, res) => {
  const { solar_code } = req.params;
  const { year } = req.query;
  if (year && !/^\d{4}$/.test(year)) {
    return res.status(400).json({ success: false, error: 'year must look like 2026' });
  }
  try {
    const siteCheck = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (siteCheck.rowCount === 0) return notFound(res, solar_code);
    const result = await query(
      `WITH y AS (
         SELECT COALESCE($2::int, EXTRACT(YEAR FROM (NOW() AT TIME ZONE $3))::int) AS yr
       )
       SELECT to_char(m.month, 'YYYY-MM')         AS month,
              ROUND(COALESCE(d.energy_kwh, 0), 3) AS energy_kwh,
              ROUND(COALESCE(d.revenue, 0), 2)    AS revenue,
              ROUND(COALESCE(d.co2_kg, 0), 3)     AS co2_kg
       FROM y,
            generate_series(make_date(y.yr, 1, 1), make_date(y.yr, 12, 1), INTERVAL '1 month') AS m(month)
       LEFT JOIN monthly_solar_data d ON d.solar_code = $1 AND d.month = m.month::date
       ORDER BY m.month`,
      [solar_code, year || null, TIMEZONE]
    );
    res.json({ success: true, solar_code, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// GET /api/dashboard/:solar_code/charts/:metric — see src/charts.js
router.get('/:solar_code/charts/:metric', async (req, res) => {
  const { solar_code, metric } = req.params;
  try {
    if (!charts.METRICS[metric]) {
      return res.status(400).json({ success: false, error: 'metric must be one of: power, energy, carbon-reduction, revenue' });
    }
    const site = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (site.rowCount === 0) return notFound(res, solar_code);
    res.json({ success: true, ...(await charts.buildChart(solar_code, metric, req.query)) });
  } catch (err) {
    if (err instanceof charts.BadRequest) return res.status(400).json({ success: false, error: err.message });
    serverError(res, err);
  }
});

// GET /api/dashboard/:solar_code/load-events?period=day|7d|month|year[&date=|&month=|&year=][&limit=][&after_id=]
// Every battery-load ON / OFF event of the period, one by one, oldest first. See src/loadEvents.js.
router.get('/:solar_code/load-events', async (req, res) => {
  const { solar_code } = req.params;
  try {
    const site = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (site.rowCount === 0) return notFound(res, solar_code);
    res.json({ success: true, ...(await loadEvents.listEvents(solar_code, req.query)) });
  } catch (err) {
    if (err instanceof loadEvents.BadRequest) return res.status(400).json({ success: false, error: err.message });
    serverError(res, err);
  }
});

// GET /api/dashboard/:solar_code/raw?start_date=&end_date=&start_time=&end_time=&limit=&after_created_at=&after_id=
// Raw readings in time order, cursor-paginated (fast on millions of rows).
router.get('/:solar_code/raw', async (req, res) => {
  const { solar_code } = req.params;
  const { start_date, end_date, start_time, end_time, after_created_at, after_id } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

  if (!start_date || !end_date) {
    return res.status(400).json({ success: false, error: 'start_date and end_date are required (YYYY-MM-DD)' });
  }
  const rangeStart = `${start_date} ${start_time || '00:00:00'}`;
  const rangeEnd   = `${end_date} ${end_time || '23:59:59'}`;
  if (Number.isNaN(Date.parse(rangeStart)) || Number.isNaN(Date.parse(rangeEnd))) {
    return res.status(400).json({ success: false, error: 'Invalid start/end date or time' });
  }

  try {
    const siteCheck = await query('SELECT 1 FROM solar_list WHERE solar_code = $1', [solar_code]);
    if (siteCheck.rowCount === 0) return notFound(res, solar_code);

    // Interpret the dates in the site timezone (Asia/Dhaka), not the server's.
    const params = [solar_code, rangeStart, rangeEnd, TIMEZONE];
    let cursorClause = '';
    if (after_created_at && after_id) {
      params.push(after_created_at, after_id);
      cursorClause = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
    }
    params.push(limit);

    const result = await query(
      `SELECT * FROM solar_device_data
       WHERE solar_code = $1
         AND created_at BETWEEN ($2::timestamp AT TIME ZONE $4) AND ($3::timestamp AT TIME ZONE $4)
         ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT $${params.length}`,
      params
    );

    const last = result.rows[result.rows.length - 1];
    const next_cursor = result.rowCount === limit && last ? { created_at: last.created_at, id: last.id } : null;
    res.json({ success: true, solar_code, count: result.rowCount, limit, next_cursor, data: result.rows });
  } catch (err) { serverError(res, err); }
});

module.exports = router;