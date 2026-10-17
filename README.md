# solar_monitor

Solar site monitoring backend: a REST API plus a WebSocket ingester, on PostgreSQL (TimescaleDB).

- `src/server.js` — REST API (sites, cards, charts)
- `src/solarWorker.js` — WebSocket ingester (the only thing that writes readings)
- `src/solarEngine.js` — applies the formulas to each reading and saves the totals
- `src/calc.js` — every formula
- `src/charts.js` — chart APIs (power, energy, carbon, revenue, load)
- `src/loadState.js` — keeps battery-load ON/OFF hours up to date
- `database/schema.sql` — the whole database in one file
- `api.md` — every endpoint

## Run it (fresh start)

1. Install: Node.js 18+, PostgreSQL with the TimescaleDB extension.
2. Create the database and all tables with the single schema file (safe to re-run, nothing is dropped):
   ```bash
   createdb -U postgres solar_monitor
   psql -U postgres -d solar_monitor -f database/schema.sql
   ```
3. Install packages: `npm install`
4. Edit `.env`: set `DB_PASSWORD` and `SOLAR_WS_URL` (also `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` if different).
   Optional: `LOAD_MAX_GAP_SECONDS=300` (longest time one load reading counts as ON/OFF; defaults to `MAX_GAP_SECONDS`).
5. Add your sites (the worker skips any `solar_code` that is not listed):
   ```bash
   psql -U postgres -d solar_monitor -c "INSERT INTO solar_list (solar_code, solar_name, solar_panel_voltage, solar_panel_watt, battery_voltage, battery_capacity) VALUES ('CE00001','Site One',24,2000,24,200);"
   ```
   or `POST /api/solar` with `{"solar_code":"CE00001","solar_name":"Site One"}`.
6. Start both processes (two terminals):
   ```bash
   npm start          # API on http://localhost:3200
   npm run socket     # WebSocket ingester
   ```
   Development with auto-restart: `npm run dev`.
   Production with PM2:
   ```bash
   pm2 start src/server.js --name solar_monitor-api
   pm2 start src/solarWorker.js --name solar_monitor-worker
   pm2 save && pm2 startup
   ```
7. Check it: `curl http://localhost:3200/health`

Never drop or recreate the database on a live system. Back up with `pg_dump -U postgres -Fc solar_monitor > backup.dump`.

## How it works

1. A site sends one line every 30 s – 2 min:
   `CE00001:24.6,7.6,24.8,-25.8,10,31.5,78,4.1,0,1,GrameenPhone,22,16-9-2026,1,1,36`
   = `solar_voltage, solar_current, battery_voltage, battery_current, sunlight_intensity, temperature, humidity, internal_battery_volt, psu1, psu2, operator, signal_strength, active, server1, server2, data_sequence`
2. The worker saves the raw line, then the engine calculates power, energy, carbon, revenue, battery charge (SOC), backup time and load, and updates the hourly / daily / monthly tables.
3. The API only reads those tables, so charts stay fast with years of data. Readings are never deleted.

Formulas are all in `src/calc.js`. Today / month follow `TIMEZONE` (Asia/Dhaka).

## Charts and battery load

`GET /api/dashboard/:solar_code/charts/:metric` — `metric` is `power`, `energy`, `carbon-reduction`, `revenue` or `load`.

| Request | Result |
|---|---|
| `?period=day&date=2026-10-17` | 24 hourly points |
| `?period=7d&date=2026-10-17` | 7 daily points ending on the date |
| `?period=month&month=2026-09` | one point per calendar day |
| `?period=year&year=2025` | 12 monthly points |
| `?window=6h` | every stored reading of the last 6 hours (optional `&end=2026-10-17T10:00:00+06:00`) |

- Without a date / month / year the current one (Dhaka time) is used. Empty buckets return `0` with `has_data: false`.
- Energy, carbon and revenue in the 6-hour view are the day's running totals (they reset at Dhaka midnight), marked `value_type: day_running_total`.
- Load: `load_w > 0` = ON, `0` = OFF, missing or negative = unknown. A reading counts until the next reading, at most `LOAD_MAX_GAP_SECONDS`; the rest is unknown. Returned: ON / OFF / unknown seconds, average load while ON, average load over ON + OFF time, min / max, ON and OFF transitions, energy in kWh.
