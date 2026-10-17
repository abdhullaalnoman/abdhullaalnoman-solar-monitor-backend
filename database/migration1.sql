-- migration1.sql — battery-load ON / OFF events (for a database that is ALREADY running).
-- Adds the load_events table + load_events_apply() function, then builds the events from the readings already stored.
-- Safe to run more than once. Nothing is dropped or deleted.
--   psql -U postgres -d solar_monitor -f database/migration1.sql

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
