require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { testConnection } = require('./db');

const solarRoutes = require('./routes/solar');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 3200;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'solar_monitor', status: 'ok', time: new Date().toISOString() });
});

app.use('/api/solar', solarRoutes);          // site list + settings (CRUD)
app.use('/api/dashboard', dashboardRoutes);  // cards + charts + raw data

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error('[SERVER]', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

async function boot() {
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[SERVER] Cannot connect to database. Exiting.');
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`[SERVER] solar_monitor API listening on http://localhost:${PORT}`);
  });
}

boot();
