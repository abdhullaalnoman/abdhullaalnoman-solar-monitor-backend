-- ============================================================
-- solar_monitor — FRESH-START schema (includes everything: all earlier migrations + load ON/OFF tracking)
--
-- For a new, empty database:   psql -U postgres -d solar_monitor -f database/schema.sql
-- Every CREATE is IF NOT EXISTS and nothing is dropped, so re-running it never touches data.
-- Needs TimescaleDB installed on the PostgreSQL server.
--
-- Feed (one line per reading):
--   CE00001:24.6,7.6,24.8,-25.8,10,31.5,78,4.1,0,1,GrameenPhone,22,16-9-2026,1,1,36
--   = solar_voltage, solar_current, battery_voltage, battery_current, sunlight_intensity, temperature, humidity,
--     internal_battery_volt, psu1, psu2, operator, signal_strength, active, server1, server2, data_sequence
--
-- Tables
--   1. solar_list                     the sites + their settings
--   2. solar_device_data              every raw reading, forever (hypertable)
--   3. solar_current_status           ONE row per site: latest values, battery, SOC, backup time
--   4. solar_energy_daily             running energy / revenue / CO2 per site per day (the engine adds to it)
--   5. calculated_solar_device_data   ONE calculated row per reading (hypertable)
--   6. hourly_solar_data              per site per hour: power, energy, CO2, revenue
--   7. hourly_battery_consumption     per site per hour: battery load + seconds of consumption
--   8. daily_solar_data               per site per day  (daily chart)
--   9. monthly_solar_data             per site per month (monthly chart)
--  10. hourly_load_state              per site per hour: battery load ON / OFF / unknown time (load chart)
--      + function solar_load_stats()  the one definition of load ON / OFF time
-- ============================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ── 1. solar_list — the sites (only solar_code is required) ──
-- carbon_factor and unit_rate are per site and can be changed any time; the engine uses the current value for every new reading.
CREATE TABLE IF NOT EXISTS solar_list (
    id                  SERIAL PRIMARY KEY,
    solar_code          VARCHAR(50)   NOT NULL UNIQUE,   -- e.g. 'CE00001' — must match the feed prefix
    solar_name          VARCHAR(100),

    solar_panel_voltage NUMERIC(10,2),                   -- panel rated voltage (V)
    solar_panel_watt    NUMERIC(10,2),                   -- panel rated power (W)
    battery_voltage     NUMERIC(10,2),                   -- battery bank rated voltage (V)
    battery_capacity    NUMERIC(10,2),                   -- battery bank capacity (Ah)

    carbon_factor       NUMERIC(10,4) DEFAULT 0.62,      -- kg CO2 saved per kWh   (editable: PATCH /api/solar/:solar_code)
    unit_rate           NUMERIC(10,4) DEFAULT 15.36,     -- ৳ per kWh              (editable: PATCH /api/solar/:solar_code)
    battery_current_offset NUMERIC(10,2) DEFAULT 2,          -- a battery_current below this (minus sign removed) is stored as 0

    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── 2. solar_device_data — raw readings, columns in the same order as the feed ──
-- solar_current and battery_current are stored with any minus sign removed.
-- An empty value between two commas is stored as NULL.
CREATE TABLE IF NOT EXISTS solar_device_data (
    id                      BIGSERIAL,
    solar_code              VARCHAR(50)  NOT NULL,

    solar_voltage           NUMERIC(10,2),   -- solar panel voltage (V)
    solar_current           NUMERIC(10,2),   -- solar panel current (A)
    battery_voltage         NUMERIC(10,2),   -- battery bank voltage (V)
    battery_current         NUMERIC(10,2),   -- battery bank current (A)
    sunlight_intensity      NUMERIC(10,2),
    temperature             NUMERIC(10,2),   -- °C
    humidity                NUMERIC(10,2),   -- %
    internal_battery_volt   NUMERIC(10,2),   -- the logger's own small battery (V)
    psu1                    NUMERIC(10,2),
    psu2                    NUMERIC(10,2),
    operator                VARCHAR(50),     -- SIM operator, e.g. 'GrameenPhone'
    signal_strength         NUMERIC(10,2),
    active                  VARCHAR(50),     -- as sent, e.g. '16-9-2026'
    server1                 INTEGER,
    server2                 INTEGER,
    data_sequence           INTEGER,

    data_time               INTEGER,         -- SECONDS since this site's previous reading (0 for its very first)
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

SELECT create_hypertable('solar_device_data', 'created_at', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_solar_device_data_code ON solar_device_data (solar_code, created_at DESC);

-- ── 3. solar_current_status — one row per site, rewritten on every reading ──
CREATE TABLE IF NOT EXISTS solar_current_status (
    solar_code          VARCHAR(50)  PRIMARY KEY,
    last_seen_at        TIMESTAMPTZ  NOT NULL,

    solar_voltage       NUMERIC(10,2),
    solar_current       NUMERIC(10,2),
    battery_voltage     NUMERIC(10,2),
    battery_current     NUMERIC(10,2),
    sunlight_intensity  NUMERIC(10,2),
    temperature         NUMERIC(10,2),
    humidity            NUMERIC(10,2),

    power_w             NUMERIC(12,2) NOT NULL DEFAULT 0,   -- solar_voltage x solar_current
    avg_power_w         NUMERIC(12,2),                      -- running average used for energy: (previous avg + new power) / 2

    battery_remain_wh   NUMERIC(14,4),                      -- energy left in the battery (Wh); NULL = starts full on the next reading
    soc_percent         NUMERIC(6,2),                       -- 0-100, NULL if it cannot be calculated
    backup_hours        NUMERIC(10,2)                       -- NULL if capacity is not set or the battery is not discharging
);

-- ── 4. solar_energy_daily — one row per site per day (every reading ADDS its energy slice) ──
CREATE TABLE IF NOT EXISTS solar_energy_daily (
    solar_code      VARCHAR(50)   NOT NULL,
    day             DATE          NOT NULL,                 -- follows TIMEZONE in .env (Asia/Dhaka)
    energy_kwh      NUMERIC(16,6) NOT NULL DEFAULT 0,       -- 6 decimals on purpose: each slice is tiny
    revenue         NUMERIC(16,6) NOT NULL DEFAULT 0,       -- energy_kwh x unit_rate (solar_list)
    co2_kg          NUMERIC(16,6) NOT NULL DEFAULT 0,       -- energy_kwh x carbon_factor (solar_list)
    peak_power_w    NUMERIC(12,2) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (solar_code, day)
);

-- ── 5. calculated_solar_device_data — one calculated row per reading (same created_at as its raw row) ──
CREATE TABLE IF NOT EXISTS calculated_solar_device_data (
    id                          BIGSERIAL,
    solar_code                  VARCHAR(50)   NOT NULL,
    data_time                   INTEGER,         -- seconds since the site's previous reading
    load_w                      NUMERIC(12,2),   -- battery_voltage x battery_current (W); NULL if either is missing
    full_battery_capacity       NUMERIC(14,4),   -- battery_voltage x battery_capacity from solar_list (Wh)
    battery_present_capacity    NUMERIC(14,4),   -- energy left in the battery (Wh) after this reading
    current_power_w             NUMERIC(12,2),   -- Current Power Generation = solar_voltage x solar_current (W)
    today_energy_kwh            NUMERIC(16,6),   -- Today's Solar Energy (kWh), the day's total right after this reading
    today_co2_kg                NUMERIC(16,6),   -- x carbon_factor (solar_list)
    today_revenue               NUMERIC(16,6),   -- x unit_rate (solar_list)
    created_at                  TIMESTAMPTZ   NOT NULL
);

SELECT create_hypertable('calculated_solar_device_data', 'created_at', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_calculated_solar_device_data_code ON calculated_solar_device_data (solar_code, created_at DESC);

-- ── 6. hourly_solar_data — one row per site per hour, updated live by every reading ──
CREATE TABLE IF NOT EXISTS hourly_solar_data (
    solar_code        VARCHAR(50)    NOT NULL,
    hour_start        TIMESTAMPTZ    NOT NULL,
    hour_end          TIMESTAMPTZ    NOT NULL,
    current_power_w   NUMERIC(12,2)  NOT NULL DEFAULT 0,       -- average power of the hour
    reading_count     INTEGER        NOT NULL DEFAULT 0,
    solar_energy_kwh  NUMERIC(16,6)  NOT NULL DEFAULT 0,
    co2_kg            NUMERIC(16,6)  NOT NULL DEFAULT 0,
    revenue           NUMERIC(16,6)  NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (solar_code, hour_start)
);

-- ── 7. hourly_battery_consumption — one row per site per hour ──
-- A reading with load_w > 0 starts consumption; it lasts until the next reading (the first with load_w NULL/0 ends it).
CREATE TABLE IF NOT EXISTS hourly_battery_consumption (
    solar_code          VARCHAR(50)   NOT NULL,
    hour_start          TIMESTAMPTZ   NOT NULL,
    hour_end            TIMESTAMPTZ   NOT NULL,
    load_w              NUMERIC(14,2) NOT NULL DEFAULT 0,   -- load of the latest consumption interval in the hour
    consumption_seconds INTEGER       NOT NULL DEFAULT 0,   -- seconds of consumption in the hour (max 3600)
    reading_count       INTEGER       NOT NULL DEFAULT 0,   -- number of consumption intervals
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (solar_code, hour_start)
);

-- ── 8. daily_solar_data / 9. monthly_solar_data ──
CREATE TABLE IF NOT EXISTS daily_solar_data (
    solar_code      VARCHAR(50)   NOT NULL,
    day             DATE          NOT NULL,                 -- Dhaka date
    current_power_w NUMERIC(12,2) NOT NULL DEFAULT 0,       -- average of the day
    reading_count   INTEGER       NOT NULL DEFAULT 0,
    energy_kwh      NUMERIC(16,6) NOT NULL DEFAULT 0,
    co2_kg          NUMERIC(16,6) NOT NULL DEFAULT 0,
    revenue         NUMERIC(16,6) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (solar_code, day)
);

CREATE TABLE IF NOT EXISTS monthly_solar_data (
    solar_code      VARCHAR(50)   NOT NULL,
    month           DATE          NOT NULL,                 -- first day of the month (Dhaka)
    current_power_w NUMERIC(12,2) NOT NULL DEFAULT 0,       -- average of the month
    reading_count   INTEGER       NOT NULL DEFAULT 0,
    energy_kwh      NUMERIC(16,6) NOT NULL DEFAULT 0,
    co2_kg          NUMERIC(16,6) NOT NULL DEFAULT 0,
    revenue         NUMERIC(16,6) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (solar_code, month)
);

-- ── 10. hourly_load_state — one row per site per hour of battery-load state time. Rebuildable at any time from calculated_solar_device_data.
-- No foreign key to solar_list on purpose: DELETE /api/solar/:code is documented to KEEP a site's history,
-- and every other history table follows the same rule.
CREATE TABLE IF NOT EXISTS hourly_load_state (
    solar_code        VARCHAR(50)   NOT NULL,
    hour_start        TIMESTAMPTZ   NOT NULL,
    on_seconds        NUMERIC(10,3) NOT NULL DEFAULT 0,   -- load_w > 0 for this long
    off_seconds       NUMERIC(10,3) NOT NULL DEFAULT 0,   -- load_w = 0 for this long
    load_ws_on        NUMERIC(18,3) NOT NULL DEFAULT 0,   -- sum(load_w x seconds) while ON, in watt-seconds
    min_load_w        NUMERIC(12,2),                      -- smallest / largest load_w of the ON readings (NULL if none)
    max_load_w        NUMERIC(12,2),
    on_transitions    INTEGER       NOT NULL DEFAULT 0,   -- OFF -> ON changes seen at a reading in this hour
    off_transitions   INTEGER       NOT NULL DEFAULT 0,   -- ON -> OFF changes
    reading_count     INTEGER       NOT NULL DEFAULT 0,   -- readings (any state) in this hour
    finalized         BOOLEAN       NOT NULL DEFAULT FALSE, -- TRUE once the whole hour has been evaluated
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (solar_code, hour_start),
    CONSTRAINT hourly_load_state_secs CHECK (on_seconds >= 0 AND off_seconds >= 0 AND on_seconds + off_seconds <= 3600.001)
);
CREATE INDEX IF NOT EXISTS idx_hourly_load_state_open ON hourly_load_state (hour_start) WHERE NOT finalized;

-- ── solar_load_stats — the single definition of "how long was the load ON / OFF" for any window [p_start, p_end).
--   * A reading's state holds from its created_at until the NEXT reading, but never longer than p_max_gap seconds
--     (same rule as hourly_battery_consumption). Time beyond that is UNKNOWN (not counted ON or OFF).
--   * state: load_w > 0 ON | load_w = 0 OFF | NULL or negative = unknown (never counted as ON or OFF).
--   * the last reading before p_start (within p_max_gap) is carried in, so a state spanning the boundary is split, not lost.
--   * a transition is counted at the reading where the state differs from the previous reading's known state,
--     only if that previous reading was within p_max_gap. Repeated readings of the same state are not transitions.
--   * duplicate rows with the same created_at count once.
--   * min/max load are taken over ON readings.
CREATE OR REPLACE FUNCTION solar_load_stats(p_code TEXT, p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_max_gap INT)
RETURNS TABLE (on_seconds NUMERIC, off_seconds NUMERIC, load_ws_on NUMERIC,
               min_load_w NUMERIC, max_load_w NUMERIC,
               on_transitions INT, off_transitions INT, reading_count INT)
LANGUAGE sql STABLE AS $$
  WITH r AS (
    SELECT DISTINCT ON (created_at) created_at, load_w
    FROM calculated_solar_device_data
    WHERE solar_code = p_code
      AND created_at >= p_start - make_interval(secs => p_max_gap)
      AND created_at <  p_end
    ORDER BY created_at, id DESC
  ),
  s AS (
    SELECT created_at, load_w,
           CASE WHEN load_w IS NULL OR load_w < 0 THEN NULL
                WHEN load_w = 0 THEN 'off' ELSE 'on' END AS st
    FROM r
  ),
  w AS (
    SELECT created_at, load_w, st,
           LEAD(created_at) OVER o AS nxt,
           LAG(created_at)  OVER o AS prv,
           LAG(st)          OVER o AS prv_st
    FROM s WINDOW o AS (ORDER BY created_at)
  ),
  iv AS (
    SELECT st, load_w,
           EXTRACT(EPOCH FROM (
             LEAST(COALESCE(nxt, 'infinity'::timestamptz), created_at + make_interval(secs => p_max_gap), p_end)
             - GREATEST(created_at, p_start))) AS sec
    FROM w WHERE st IS NOT NULL
  ),
  tr AS (
    SELECT COUNT(*) FILTER (WHERE st = 'on'  AND prv_st = 'off' AND created_at - prv <= make_interval(secs => p_max_gap)) AS on_t,
           COUNT(*) FILTER (WHERE st = 'off' AND prv_st = 'on'  AND created_at - prv <= make_interval(secs => p_max_gap)) AS off_t,
           COUNT(*) AS cnt,
           MIN(load_w) FILTER (WHERE st = 'on') AS mn,
           MAX(load_w) FILTER (WHERE st = 'on') AS mx
    FROM w WHERE created_at >= p_start AND created_at < p_end
  )
  SELECT a.on_s, a.off_s, a.ws, tr.mn, tr.mx, tr.on_t::int, tr.off_t::int, tr.cnt::int
  FROM (SELECT COALESCE(SUM(sec) FILTER (WHERE st = 'on'),  0) AS on_s,
               COALESCE(SUM(sec) FILTER (WHERE st = 'off'), 0) AS off_s,
               COALESCE(SUM(sec * load_w) FILTER (WHERE st = 'on'), 0) AS ws
        FROM iv WHERE sec > 0) a, tr
$$;

-- ============================================================
--  First site (the worker skips lines whose solar_code is not in solar_list):
--  INSERT INTO solar_list (solar_code, solar_name, solar_panel_voltage, solar_panel_watt, battery_voltage, battery_capacity)
--  VALUES ('CE00001', 'Site One', 24, 2000, 24, 200);
-- ============================================================

-- ============================================================
--  11. load_events + load_events_apply()  (was migration1.sql, now merged here)
--      battery-load ON / OFF events used by the engine and the load-events API
-- ============================================================
-- the column the worker reads (older installs of schema.sql did not have it)
ALTER TABLE solar_list ADD COLUMN IF NOT EXISTS battery_current_offset NUMERIC(10,2) DEFAULT 2;

-- ── load_events — every battery-load ON and OFF event, one row each, in time order ──
-- Built from calculated_solar_device_data.load_w by the function load_events_apply() below (the ONLY place the rules live).
--   load_w > 0 = ON    load_w = 0 = OFF    NULL / negative = missing reading (no state)
-- An event = consecutive readings with the same status. A change ON<->OFF closes the event AT the first reading of the new
-- status, which is also where the next event starts. Between two readings the state of the earlier reading holds, so
--   duration_seconds = end_time - start_time
--   energy_wh (ON)   = sum( load_w x interval_seconds / 3600 ), interval = next reading time - this reading time; OFF = 0
-- The newest reading of a site is the END of monitoring so far: it adds no interval until another reading arrives.
CREATE TABLE IF NOT EXISTS load_events (
    id               BIGSERIAL     PRIMARY KEY,
    solar_code       VARCHAR(50)   NOT NULL,
    status           VARCHAR(3)    NOT NULL CHECK (status IN ('ON', 'OFF')),
    start_time       TIMESTAMPTZ   NOT NULL,               -- time of the first reading of the event
    end_time         TIMESTAMPTZ   NOT NULL,               -- closing reading time, or the newest reading while still open
    duration_seconds NUMERIC(12,3) NOT NULL DEFAULT 0,     -- end_time - start_time
    energy_wh        NUMERIC(14,4) NOT NULL DEFAULT 0,     -- ON: sum of load x interval / 3600   OFF: always 0
    last_load_w      NUMERIC(12,2),                        -- load of the newest reading (used for the next interval)
    reading_count    INTEGER       NOT NULL DEFAULT 1,
    is_open          BOOLEAN       NOT NULL DEFAULT TRUE,    -- the site's current event (at most one per site)
    end_reason       VARCHAR(20),                          -- status_change | gap | missing_reading   (NULL while open)
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT load_events_time   CHECK (end_time >= start_time),
    CONSTRAINT load_events_off_wh CHECK (status = 'ON' OR energy_wh = 0),
    CONSTRAINT load_events_unique UNIQUE (solar_code, start_time)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_load_events_open ON load_events (solar_code) WHERE is_open;
CREATE INDEX IF NOT EXISTS idx_load_events_code_time ON load_events (solar_code, start_time);

-- Feed ONE reading into the events. Called by the engine for every new reading, and by the backfill below.
--   p_max_gap : longest time (seconds) between two readings that still counts as continuous (MAX_GAP_SECONDS; 0 = no limit).
-- Rules
--   * same status as the open event        -> event grows (duration, energy of the interval just ended)
--   * ON <-> OFF                           -> the open event gets its last interval and closes at p_time; a new event starts at p_time
--   * gap longer than p_max_gap            -> the open event closes at ITS LAST reading (the gap is not counted as ON or OFF,
--                                             no energy is invented); a new event starts at p_time
--   * NULL / negative load (missing)       -> the open event closes at its last reading; no event is started from it
--   * p_time not newer than the site's latest event end -> ignored, so a retried or duplicate reading changes nothing
CREATE OR REPLACE FUNCTION load_events_apply(p_code TEXT, p_time TIMESTAMPTZ, p_load NUMERIC, p_max_gap INT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  o   load_events%ROWTYPE;
  st  TEXT := CASE WHEN p_load IS NULL OR p_load < 0 THEN NULL WHEN p_load = 0 THEN 'OFF' ELSE 'ON' END;
  gap NUMERIC;
  wh  NUMERIC;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('load_events:' || p_code));
  SELECT * INTO o FROM load_events WHERE solar_code = p_code ORDER BY start_time DESC LIMIT 1;

  IF FOUND THEN
    IF p_time <= o.end_time THEN RETURN; END IF;                       -- duplicate / older reading
    IF o.is_open THEN
      gap := EXTRACT(EPOCH FROM (p_time - o.end_time));
      IF st IS NULL THEN                                               -- missing reading
        UPDATE load_events SET is_open = FALSE, end_reason = 'missing_reading' WHERE id = o.id;
        RETURN;
      ELSIF p_max_gap > 0 AND gap > p_max_gap THEN                     -- long gap: close at the last reading we really had
        UPDATE load_events SET is_open = FALSE, end_reason = 'gap' WHERE id = o.id;
      ELSE
        wh := CASE WHEN o.status = 'ON' THEN COALESCE(o.last_load_w, 0) * gap / 3600 ELSE 0 END;
        IF st = o.status THEN                                          -- same status: the event continues
          UPDATE load_events
             SET end_time = p_time, duration_seconds = EXTRACT(EPOCH FROM (p_time - start_time)),
                 energy_wh = energy_wh + wh, last_load_w = p_load, reading_count = reading_count + 1
           WHERE id = o.id;
          RETURN;
        END IF;
        UPDATE load_events                                             -- status changed: close here, new event below
           SET end_time = p_time, duration_seconds = EXTRACT(EPOCH FROM (p_time - start_time)),
               energy_wh = energy_wh + wh, is_open = FALSE, end_reason = 'status_change'
         WHERE id = o.id;
      END IF;
    END IF;
  END IF;

  IF st IS NULL THEN RETURN; END IF;
  INSERT INTO load_events (solar_code, status, start_time, end_time, last_load_w)
  VALUES (p_code, st, p_time, p_time, p_load)
  ON CONFLICT (solar_code, start_time) DO NOTHING;
END $$;

-- One-time backfill from the readings already stored (does nothing on an empty database, or once events exist).
-- Uses the same function, so history and live data follow exactly the same rules. 300 = MAX_GAP_SECONDS default.
DO $$
DECLARE r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM load_events) THEN
    FOR r IN SELECT DISTINCT ON (solar_code, created_at) solar_code, created_at, load_w
             FROM calculated_solar_device_data ORDER BY solar_code, created_at, id DESC
    LOOP
      PERFORM load_events_apply(r.solar_code, r.created_at, r.load_w, 300);
    END LOOP;
  END IF;
END $$;

-- Optional clean-up (only if you do not want the old derived tables any more; the raw data is not touched). Remove the leading "--" to run:
-- DROP TABLE IF EXISTS hourly_battery_consumption, hourly_load_state;
-- DROP FUNCTION IF EXISTS solar_load_stats(text, timestamptz, timestamptz, int);
