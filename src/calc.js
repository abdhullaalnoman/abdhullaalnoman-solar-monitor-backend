// src/calc.js — every formula in one place.

// carbon factor (kg CO2 per kWh) and unit rate (৳ per kWh) are NOT here: they are stored per site in
// solar_list (carbon_factor, unit_rate) and can be changed any time with PATCH /api/solar/:solar_code.

function powerW(solarVoltage, solarCurrent) {
  if (solarVoltage == null || solarCurrent == null) return 0;
  const p = solarVoltage * solarCurrent;
  return p > 0 ? round(p, 2) : 0;
}

// Smoothed power used for energy:
//   1st reading            -> its own power            (P1)
//   2nd reading            -> (P1 + P2) / 2
//   every later reading    -> (previous avg + new power) / 2
function runningAvgPower(prevAvg, power_w) {
  if (prevAvg == null) return power_w;
  return (prevAvg + power_w) / 2;
}

// Energy for one reading: avg watts x data_time (seconds -> hours) = Wh, then / 1000 = kWh.
// maxGapSec stops a long outage from being counted as generation (0 or less = no limit).
function energyKwh(avgPower_w, dataTimeSec, maxGapSec = 0) {
  let sec = Math.max(dataTimeSec, 0);
  if (maxGapSec > 0) sec = Math.min(sec, maxGapSec);
  const wh = avgPower_w * (sec / 3600);
  return wh / 1000;
}

// Today's Revenue = Today's Solar Energy x the site's unit_rate (solar_list)
function revenue(kwh, rate) {
  return kwh * rate;
}

// Carbon Emission Reduction = Today's Solar Energy x the site's carbon_factor (solar_list)
function co2Kg(kwh, factor) {
  return kwh * factor;
}

// Full battery capacity in Wh = battery_voltage x battery_capacity (from solar_list)
function batteryFullWh(batteryVoltage, batteryCapacityAh) {
  if (!(batteryVoltage > 0) || !(batteryCapacityAh > 0)) return null;
  return batteryVoltage * batteryCapacityAh;
}

// Energy left in the battery (Wh) after one reading. Two steps, in this order:
//   increased = (solar_voltage x solar_current) x (data_time / 3600)    -> remain + increased, never above full
//   decreased = (battery_voltage x battery_current) x (data_time / 3600) -> remain - decreased, never below 0
// prevRemain = remain after the previous reading (null = very first reading -> starts full)
function batteryRemainWh(prevRemain, fullWh, solarPower_w, batteryVoltage, batteryCurrent, dataTimeSec) {
  if (fullWh == null) return null;
  const hours = Math.max(dataTimeSec, 0) / 3600;
  let remain = prevRemain == null ? fullWh : Math.min(prevRemain, fullWh);

  const increased = solarPower_w * hours;
  remain = Math.min(fullWh, remain + increased);

  const batteryPower_w = (batteryVoltage ?? 0) * (batteryCurrent ?? 0);
  const decreased = batteryPower_w * hours;
  remain = Math.max(0, remain - decreased);

  return round(remain, 4);
}

// SOC % = remain / full x 100
function socPercent(remainWh, fullWh) {
  if (remainWh == null || !fullWh) return null;
  return round(Math.min(100, Math.max(0, (remainWh / fullWh) * 100)), 2);
}

// Hours the battery can keep supplying the CURRENT discharge rate.
// capacityAh = solar_list.battery_capacity, batteryCurrent = live battery_current (A, positive = using the battery).
// Returns null when the battery is not being used (there is no "backup time" then).
function backupHours(soc, capacityAh, batteryCurrent) {
  if (soc == null || !capacityAh || batteryCurrent == null || batteryCurrent <= 0) return null;
  const ahLeft = capacityAh * (soc / 100);
  return round(ahLeft / batteryCurrent, 2);
}

function round(n, digits) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

module.exports = { powerW, runningAvgPower, energyKwh, revenue, co2Kg, batteryFullWh, batteryRemainWh, socPercent, backupHours, round };