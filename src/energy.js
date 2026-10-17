// src/energy.js — rebuilds "Today's Solar Energy" over the day from the raw readings,
// using exactly the same steps as solarEngine.js:
//   power        = solar_voltage x solar_current (power_w)
//   avg          = 1st reading: its power | later: (previous avg + new power) / 2
//   energy (kWh) = avg x data_time (s -> hours) / 1000      (data_time cut at MAX_GAP_SECONDS)
// Then the energy of all readings up to a time are added = the day's energy so far at that time.

const calc = require('./calc');

// rows: [{ created_at, data_time, power_w }] oldest first, all from ONE day
function energySlices(rows, maxGapSec) {
  let avg = null;
  return rows.map((r) => {
    avg = calc.runningAvgPower(avg, Number(r.power_w) || 0);
    return {
      t: new Date(r.created_at).getTime(),
      kwh: calc.energyKwh(avg, Number(r.data_time) || 0, maxGapSec),
    };
  });
}

// For each time in timesMs (ascending): total kWh of all readings at or before that time.
function cumulativeAt(slices, timesMs) {
  let i = 0, total = 0;
  return timesMs.map((ms) => {
    while (i < slices.length && slices[i].t <= ms) total += slices[i++].kwh;
    return total;
  });
}

module.exports = { energySlices, cumulativeAt };
