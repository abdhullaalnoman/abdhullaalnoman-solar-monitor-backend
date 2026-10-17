// src/loadEvents.js — reads the battery-load ON / OFF events (table load_events) for today / 7 days / a month / a year.
// The events themselves are written by the SQL function load_events_apply() (database/schema.sql); nothing is calculated here.
//
//   GET /api/dashboard/:solar_code/load-events
//     ?period=day   [&date=2026-10-17]    that day (default: today, Dhaka time)
//     ?period=7d    [&date=2026-10-17]    the 7 days ending on that date
//     ?period=month [&month=2026-09]      that month
//     ?period=year  [&year=2025]          that year
//     [&limit=1000][&after_id=123]        page through long lists (max 5000 per call)
// An event belongs to the period in which it STARTS, so no event is counted twice and none is cut in two.

const { query } = require('./db');
const { toLocalISO } = require('./consumption');

const TIMEZONE = process.env.TIMEZONE || 'Asia/Dhaka';

class BadRequest extends Error {}
const bad = (m) => { throw new BadRequest(m); };
const pad = (n) => String(n).padStart(2, '0');
const ymd = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

// 2026-10-06 or 06/10/2026 or 06-10-2026 -> {y,m,d}; null if it is not a real date
function parseDay(input) {
  const t = String(input).trim();
  let y, m, d, x;
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/.exec(t))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? { y, m, d } : null;
}
const addDays = ({ y, m, d }, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
function localToday(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const g = (t) => +p.find((x) => x.type === t).value;
  return { y: g('year'), m: g('month'), d: g('day') };
}

// -> { period, label, from, to } where from / to are LOCAL wall-clock times ("to" is exclusive), turned into exact
// instants by the database with the site time zone.
function resolveRange(q, now = new Date()) {
  const period = String(q.period || 'day').toLowerCase();
  if (q.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q.month))) bad('month must look like 2026-09');
  if (q.year !== undefined && !/^\d{4}$/.test(String(q.year))) bad('year must look like 2026');
  let date = null;
  if (q.date !== undefined) { date = parseDay(q.date); if (!date) bad('date must look like 2026-10-17 or 17/10/2026 (day/month/year)'); }
  const today = localToday(now);

  if (period === 'day') {
    const d = date || today;
    return { period, label: ymd(d), from: `${ymd(d)} 00:00:00`, to: `${ymd(addDays(d, 1))} 00:00:00` };
  }
  if (period === '7d' || period === 'week') {
    const end = date || today, s = addDays(end, -6);
    return { period: '7d', label: `${ymd(s)}..${ymd(end)}`, from: `${ymd(s)} 00:00:00`, to: `${ymd(addDays(end, 1))} 00:00:00` };
  }
  if (period === 'month') {
    let y, m;
    if (q.month !== undefined) [y, m] = String(q.month).split('-').map(Number);
    else if (date) ({ y, m } = date);
    else ({ y, m } = today);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    return { period, label: `${y}-${pad(m)}`, from: `${y}-${pad(m)}-01 00:00:00`, to: `${ny}-${pad(nm)}-01 00:00:00` };
  }
  if (period === 'year') {
    const y = q.year !== undefined ? +q.year : q.month !== undefined ? +String(q.month).slice(0, 4) : date ? date.y : today.y;
    if (y < 1970 || y > 2200) bad('year is out of range');
    return { period, label: String(y), from: `${y}-01-01 00:00:00`, to: `${y + 1}-01-01 00:00:00` };
  }
  return bad('period must be one of: day, 7d, month, year');
}

const r3 = (v) => Math.round(Number(v) * 1000) / 1000;
function durationText(sec) {
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${pad(m)}m ${pad(s % 60)}s`;
}

async function listEvents(code, q, now = new Date()) {
  const range = resolveRange(q, now);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 1000, 1), 5000);
  let after = null;
  if (q.after_id !== undefined) { if (!/^\d+$/.test(String(q.after_id))) bad('after_id must be a number'); after = String(q.after_id); }

  const bounds = 'WITH r AS (SELECT ($2::timestamp AT TIME ZONE $3) AS a, ($4::timestamp AT TIME ZONE $3) AS b)';
  const [list, sum] = await Promise.all([
    query(
      `${bounds}
       SELECT e.id, e.status, e.start_time, e.end_time, e.duration_seconds, e.energy_wh, e.reading_count, e.is_open, e.end_reason
       FROM load_events e, r
       WHERE e.solar_code = $1 AND e.start_time >= r.a AND e.start_time < r.b
         AND ($5::bigint IS NULL OR (e.start_time, e.id) > (SELECT start_time, id FROM load_events WHERE id = $5::bigint))
       ORDER BY e.start_time, e.id
       LIMIT $6`,
      [code, range.from, TIMEZONE, range.to, after, limit + 1]),
    query(
      `${bounds}
       SELECT COUNT(*)::int AS events,
              COUNT(*) FILTER (WHERE status = 'ON')::int  AS on_events,
              COUNT(*) FILTER (WHERE status = 'OFF')::int AS off_events,
              COALESCE(SUM(energy_wh), 0) AS energy_wh
       FROM load_events e, r
       WHERE e.solar_code = $1 AND e.start_time >= r.a AND e.start_time < r.b`,
      [code, range.from, TIMEZONE, range.to]),
  ]);
  const more = list.rowCount > limit;
  const rows = more ? list.rows.slice(0, limit) : list.rows;
  const s = sum.rows[0];
  return {
    solar_code: code,
    period: range.period,
    selected: range.label,
    timezone: TIMEZONE,
    summary: { events: s.events, on_events: s.on_events, off_events: s.off_events, energy_wh: r3(s.energy_wh) },
    count: rows.length,
    next_cursor: more ? { after_id: rows[rows.length - 1].id } : null,
    events: rows.map((e) => ({
      id: Number(e.id),
      status: e.status,
      start_time: toLocalISO(e.start_time, TIMEZONE),
      end_time: toLocalISO(e.end_time, TIMEZONE),     // an open event ends at its newest reading so far
      duration_seconds: r3(e.duration_seconds),
      duration: durationText(e.duration_seconds),
      energy_wh: r3(e.energy_wh),
      readings: e.reading_count,
      is_open: e.is_open,
      end_reason: e.end_reason,                       // status_change | gap | missing_reading | null (still open)
    })),
  };
}

module.exports = { listEvents, resolveRange, BadRequest };
