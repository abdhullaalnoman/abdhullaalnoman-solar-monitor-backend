// src/consumption.js — small time-label helpers shared by the dashboard routes.

// "1 AM", "12 PM" ... for an hour number 0-23
function hourLabel(h) { return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`; }

// 2026-10-06T00:00:00+06:00 — the time as it reads on the wall clock in the given time zone,
// with its offset, so 12 AM on 6 Oct never shows up as 5 Oct (which a UTC "...Z" time would).
function toLocalISO(date, timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  }).formatToParts(new Date(date));
  const g = (t) => p.find((x) => x.type === t).value;
  const off = g('timeZoneName').replace('GMT', '') || 'Z';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}${off === '' ? 'Z' : off}`;
}

module.exports = { hourLabel, toLocalISO };