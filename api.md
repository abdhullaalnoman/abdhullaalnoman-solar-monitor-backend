## System
GET /health                                   # Service status and server time.

## Solar sites
GET    /api/solar                             # Lists all solar sites.
GET    /api/solar/:solar_code                 # Returns one site with its settings.
POST   /api/solar                             # Adds a site.
PATCH  /api/solar/:solar_code                 # Updates site settings (panel, battery, unit_rate, carbon_factor, battery_current_offset).
DELETE /api/solar/:solar_code                 # Removes a site from the list; its readings are kept.

## Dashboard cards
GET /api/dashboard/summary                    # Cards for every site plus overall totals.
GET /api/dashboard/CE00001/summary            # Full summary for one device.
GET /api/dashboard/CE00001/cards              # Only the four card values from the latest reading.

## Older chart routes
GET /api/dashboard/CE00001/power-24h                                  # Average power per 15-minute slot, last 24 hours.
GET /api/dashboard/CE00001/power-generation-24h?date=2026-10-17       # 24 hourly average-power points for a day.
GET /api/dashboard/CE00001/solar-energy-24h?date=2026-10-17           # 24 hourly energy (kWh) points for a day.
GET /api/dashboard/CE00001/carbon-reduction-24h?date=2026-10-17       # 24 hourly carbon (kg) points for a day.
GET /api/dashboard/CE00001/power-consumption-24h?date=2026-10-17      # 24 hourly battery-consumption points for a day.
GET /api/dashboard/CE00001/daily?month=2026-10                        # Energy, revenue and carbon per day of a month.
GET /api/dashboard/CE00001/monthly?year=2026                          # Energy, revenue and carbon for each month of a year.

## Raw data
GET /api/dashboard/CE00001/raw?start_date=2026-10-01&end_date=2026-10-02   # Raw device readings in time order, cursor-paginated.

## Charts: current power generation
GET /api/dashboard/CE00001/charts/power?period=day&date=2026-10-17            # 24 hourly average-power points for the selected day.
GET /api/dashboard/CE00001/charts/power?period=7d&date=2026-10-17             # 7 daily average-power points ending on the date (default today).
GET /api/dashboard/CE00001/charts/power?period=month&month=2026-09            # One average-power point per calendar day of the month.
GET /api/dashboard/CE00001/charts/power?period=year&year=2025                 # 12 monthly average-power points for the year.
GET /api/dashboard/CE00001/charts/power?window=6h                             # Every power reading of the latest rolling six hours.

## Charts: solar energy
GET /api/dashboard/CE00001/charts/energy?period=day&date=2026-10-17            # 24 hourly energy (kWh) points for the selected day.
GET /api/dashboard/CE00001/charts/energy?period=7d&date=2026-10-17             # 7 daily energy (kWh) points ending on the date (default today).
GET /api/dashboard/CE00001/charts/energy?period=month&month=2026-09            # One energy (kWh) point per calendar day of the month.
GET /api/dashboard/CE00001/charts/energy?period=year&year=2025                 # 12 monthly energy (kWh) points for the year.
GET /api/dashboard/CE00001/charts/energy?window=6h                             # Every reading's day-running energy total, latest six hours.

## Charts: carbon emission reduction
GET /api/dashboard/CE00001/charts/carbon-reduction?period=day&date=2026-10-17            # 24 hourly carbon-reduction (kg) points for the selected day.
GET /api/dashboard/CE00001/charts/carbon-reduction?period=7d&date=2026-10-17             # 7 daily carbon-reduction (kg) points ending on the date (default today).
GET /api/dashboard/CE00001/charts/carbon-reduction?period=month&month=2026-09            # One carbon-reduction (kg) point per calendar day of the month.
GET /api/dashboard/CE00001/charts/carbon-reduction?period=year&year=2025                 # 12 monthly carbon-reduction (kg) points for the year.
GET /api/dashboard/CE00001/charts/carbon-reduction?window=6h                             # Every reading's day-running carbon total, latest six hours.

## Charts: revenue
GET /api/dashboard/CE00001/charts/revenue?period=day&date=2026-10-17            # 24 hourly revenue points for the selected day.
GET /api/dashboard/CE00001/charts/revenue?period=7d&date=2026-10-17             # 7 daily revenue points ending on the date (default today).
GET /api/dashboard/CE00001/charts/revenue?period=month&month=2026-09            # One revenue point per calendar day of the month.
GET /api/dashboard/CE00001/charts/revenue?period=year&year=2025                 # 12 monthly revenue points for the year.
GET /api/dashboard/CE00001/charts/revenue?window=6h                             # Every reading's day-running revenue total, latest six hours.

## Charts: battery load ON/OFF
GET /api/dashboard/CE00001/charts/load?period=day&date=2026-10-17            # 24 hourly ON/OFF/unknown durations and load statistics.
GET /api/dashboard/CE00001/charts/load?period=7d&date=2026-10-17             # 7 daily ON/OFF/unknown statistics ending on the date.
GET /api/dashboard/CE00001/charts/load?period=month&month=2026-09            # One ON/OFF/unknown bucket per calendar day of the month.
GET /api/dashboard/CE00001/charts/load?period=year&year=2025                 # 12 monthly ON/OFF/unknown buckets for the year.
GET /api/dashboard/CE00001/charts/load?window=6h                             # Every load reading with its state, plus statistics, latest six hours.