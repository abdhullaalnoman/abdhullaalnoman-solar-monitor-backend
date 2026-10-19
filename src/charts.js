// src/charts.js — chart APIs for the 4 solar metrics: power, energy, carbon-reduction, revenue.
//   GET /api/dashboard/:solar_code/charts/:metric        metric = power | energy | carbon-reduction | revenue | load
//   period=day&date=2026-10-17        24 hourly points            (hourly_solar_data)
//   period=7d&date=2026-10-17         7 daily points ending on date (default today)  (daily_solar_data)
//   period=month&month=2026-09        one point per calendar day  (daily_solar_data)
//   period=year&year=2025             12 monthly points           (monthly_solar_data)
//   window=6h[&end=ISO time]          every calculated reading in (end - 6h, end]   (calculated_solar_device_data)
//   metric load = battery load_w (W) of every calculated reading; only window=6h (day / 7d / month / year: use /load-events)
// No formula lives here: values are read from the tables the engine already fills (see solarEngine.js, calc.js).
// The period / date parsing is shared with the load-events API (loadEvents.resolveRange).

const { query } = require('./db');
const { toLocalISO, hourLabel } = require('./consumption');
const { resolveRange, BadRequest } = require('./loadEvents');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';
const MAX_6H_POINTS = 20000;   // safety ceiling only; 6 h at one reading / 30 s is 720 rows

// Which column of which table holds each metric. `raw` = column of calculated_solar_device_data
// (for energy / carbon / revenue it is the day running total, which resets at local midnight).
const METRICS = {
  power:              { unit: 'W',   decimals: 2, hourly: 'current_power_w',  daily: 'current_power_w', raw: 'current_power_w',  additive: false, rawType: 'instantaneous' },
  energy:             { unit: 'kWh', decimals: 3, hourly: 'solar_energy_kwh', daily: 'energy_kwh',      raw: 'today_energy_kwh', additive: true,  rawType: 'day_running_total' },
  'carbon-reduction': { unit: 'kg',  decimals: 3, hourly: 'co2_kg',           daily: 'co2_kg',          raw: 'today_co2_kg',     additive: true,  rawType: 'day_running_total' },
  revenue:            { unit: 'BDT', decimals: 2, hourly: 'revenue',          daily: 'revenue',         raw: 'today_revenue',    additive: true,  rawType: 'day_running_total' },
};
// Battery load: load_w of calculated_solar_device_data, exactly as stored (NULL stays null, it is never turned into 0).
METRICS.load = { unit: 'W', decimals: 2, raw: 'load_w', additive: false, rawType: 'instantaneous', windowOnly: true };
METRICS.carbon = METRICS['carbon-reduction'];

const bad = (m) => { throw new BadRequest(m); };
const roundTo = (v, d) => { if (v === null || v === undefined) return null; const f = 10 ** d; return Math.round(Number(v) * f) / f; };
const STEP = { hour: "INTERVAL '1 hour'", day: "INTERVAL '1 day'", month: "INTERVAL '1 month'" };   // whitelist, never user text

// period -> how many buckets of which size, from the shared range (from = local start, to = local end, exclusive)
function bucketsFor(q, now) {
  const r = resolveRange(q, now);
  const days = Math.round((Date.UTC(...r.to.slice(0, 10).split('-').map((v, i) => (i === 1 ? v - 1 : +v))) -
                           Date.UTC(...r.from.slice(0, 10).split('-').map((v, i) => (i === 1 ? v - 1 : +v)))) / 86400000);
  if (r.period === 'day')   return { ...r, unit: 'hour',  n: 24,   startLocal: r.from };
  if (r.period === 'year')  return { ...r, unit: 'month', n: 12,   startLocal: r.from };
  return { ...r, unit: 'day', n: days, startLocal: r.from };            // 7d and month
}

function resolveWindow(q, now = new Date()) {
  if (String(q.window).toLowerCase() !== '6h') bad("window must be '6h'");
  let end = now;
  if (q.end !== undefined) {
    // ISO time WITH an offset (or Z) so the boundary is never guessed
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(String(q.end))) bad('end must be an ISO time with offset, e.g. 2026-10-17T10:00:00+06:00');
    end = new Date(q.end);
    if (Number.isNaN(end.getTime())) bad('end is not a valid time');
  }
  return { start: new Date(end.getTime() - 6 * 3600 * 1000), end };
}

function bucketLabel(unit, startLocalIso, i) {
  if (unit === 'hour') return hourLabel((i + 1) % 24);       // hour END, like the existing 24h charts: 14:00-15:00 -> "3 PM"
  if (unit === 'day') return startLocalIso.slice(0, 10);
  return startLocalIso.slice(0, 7);
}

// ---- aggregated periods ---------------------------------------------------------------------------
async function solarBuckets(code, metric, range) {
  const m = METRICS[metric];
  const table = range.unit === 'hour' ? 'hourly_solar_data' : range.unit === 'day' ? 'daily_solar_data' : 'monthly_solar_data';
  const col = range.unit === 'hour' ? m.hourly : m.daily;
  const keyOn = range.unit === 'hour' ? 't.hour_start = g.bs AT TIME ZONE $3'
              : range.unit === 'day'  ? 't.day = g.bs::date' : 't.month = g.bs::date';
  const r = await query(
    `SELECT g.i, (g.bs AT TIME ZONE $3) AS bucket_start, (g.be AT TIME ZONE $3) AS bucket_end,
            t.${col} AS v, COALESCE(t.reading_count, 0) > 0 AS has_data
     FROM (SELECT i, $2::timestamp + i * ${STEP[range.unit]} AS bs, $2::timestamp + (i + 1) * ${STEP[range.unit]} AS be
           FROM generate_series(0, $4::int - 1) AS i) g
     LEFT JOIN ${table} t ON t.solar_code = $1 AND ${keyOn}
     ORDER BY g.i`,
    [code, range.startLocal, TIMEZONE, range.n]
  );
  let total = 0;
  const data = r.rows.map((row) => {
    const raw = row.v === null ? 0 : Number(row.v);      // no row = 0, as in the existing 24h / daily / monthly charts; has_data says which
    total += raw;
    const start = toLocalISO(row.bucket_start, TIMEZONE);
    return {
      label: bucketLabel(range.unit, start, row.i),
      bucket_start: start,
      bucket_end: toLocalISO(row.bucket_end, TIMEZONE),
      value: roundTo(raw, m.decimals),
      has_data: row.has_data,
    };
  });
  return { data, total: m.additive ? roundTo(total, m.decimals) : undefined };
}

// ---- rolling 6 hours ------------------------------------------------------------------------------
async function solarSeries(code, metric, win) {
  const m = METRICS[metric];
  const r = await query(
    `SELECT created_at, ${m.raw} AS v FROM calculated_solar_device_data
     WHERE solar_code = $1 AND created_at > $2 AND created_at <= $3
     ORDER BY created_at ASC LIMIT $4`,
    [code, win.start, win.end, MAX_6H_POINTS + 1]
  );
  const truncated = r.rowCount > MAX_6H_POINTS;
  const rows = truncated ? r.rows.slice(0, MAX_6H_POINTS) : r.rows;
  return {
    truncated,
    points: rows.map((row) => ({ timestamp: toLocalISO(row.created_at, TIMEZONE), value: roundTo(row.v, m.decimals) })),
  };
}

// ---- entry point used by the router ---------------------------------------------------------------
async function buildChart(code, metric, q, now = new Date()) {
  if (!METRICS[metric]) bad('metric must be one of: power, energy, carbon-reduction, revenue, load');
  if (METRICS[metric].windowOnly && q.window === undefined) bad(`${metric} is available as window=6h only; for a day, 7 days, month or year use /load-events`);
  const head = { solar_code: code, metric: metric === 'carbon' ? 'carbon-reduction' : metric, timezone: TIMEZONE, unit: METRICS[metric].unit };

  if (q.window !== undefined) {
    const win = resolveWindow(q, now);
    const s = await solarSeries(code, metric, win);
    return { ...head, window: '6h', range: '(start_time, end_time]',
      start_time: toLocalISO(win.start, TIMEZONE), end_time: toLocalISO(win.end, TIMEZONE),
      value_type: METRICS[metric].rawType, count: s.points.length, truncated: s.truncated, points: s.points };
  }

  const range = bucketsFor(q, now);
  const out = { ...head, period: range.period, selected: range.label, bucket: range.unit, count: range.n };
  const s = await solarBuckets(code, metric, range);
  return { ...out, ...(s.total !== undefined ? { total: s.total } : {}), data: s.data };
}

module.exports = { buildChart, resolveWindow, METRICS, BadRequest };