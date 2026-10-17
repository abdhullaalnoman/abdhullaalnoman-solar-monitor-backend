// src/routes/solar.js — CRUD for solar_list (the sites you add)
//
// To add a site you only need solar_code (+ a name). Everything else
// has a default and can be set later with PATCH.

const express = require('express');
const router  = express.Router();
const { query } = require('../db');

function serverError(res, err) {
  console.error('[SOLAR]', err.message);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}
function notFound(res, code) {
  return res.status(404).json({ success: false, error: `solar_code '${code}' not found` });
}

// Every editable column besides solar_code (set once at creation).
const EDITABLE_FIELDS = [
  'solar_name',
  'solar_panel_voltage', 'solar_panel_watt',
  'battery_voltage', 'battery_capacity',
  'carbon_factor', 'unit_rate',
  'battery_current_offset',
];
const NUMBER_FIELDS = ['solar_panel_voltage', 'solar_panel_watt', 'battery_voltage', 'battery_capacity', 'carbon_factor', 'unit_rate', 'battery_current_offset'];

// Returns an error message if a number field is not a number (null is allowed = clear it).
function validateNumbers(body) {
  for (const f of NUMBER_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean' || v === '' || !Number.isFinite(Number(v))) return `${f} must be a number`;
    if (Number(v) < 0) return `${f} cannot be negative`;
  }
  return null;
}

// GET /api/solar — list all
router.get('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM solar_list ORDER BY solar_code');
    res.json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) { serverError(res, err); }
});

// GET /api/solar/:solar_code — one
router.get('/:solar_code', async (req, res) => {
  try {
    const result = await query('SELECT * FROM solar_list WHERE solar_code = $1', [req.params.solar_code]);
    if (result.rowCount === 0) return notFound(res, req.params.solar_code);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// POST /api/solar — create. Only solar_code is required.
// Body: { solar_code, solar_name, solar_panel_voltage, solar_panel_watt, battery_voltage, battery_capacity }
router.post('/', async (req, res) => {
  const { solar_code, ...rest } = req.body;
  if (!solar_code || !String(solar_code).trim()) {
    return res.status(400).json({ success: false, error: 'solar_code is required' });
  }

  const bad = validateNumbers(rest);
  if (bad) return res.status(400).json({ success: false, error: bad });

  const cols = ['solar_code'];
  const vals = [String(solar_code).trim()];
  for (const field of EDITABLE_FIELDS) {
    if (rest[field] !== undefined) {
      cols.push(field);
      vals.push(rest[field]);
    }
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`);

  try {
    const result = await query(
      `INSERT INTO solar_list (${cols.join(',')}) VALUES (${placeholders.join(',')})
       ON CONFLICT (solar_code) DO NOTHING RETURNING *`,
      vals
    );
    if (result.rowCount === 0) {
      return res.status(409).json({ success: false, error: `solar_code '${solar_code}' already exists` });
    }
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// PATCH /api/solar/:solar_code — change only the fields you send,
// e.g. { "battery_capacity": 200 } or { "solar_panel_watt": 1000 }.
router.patch('/:solar_code', async (req, res) => {
  const fieldsToUpdate = EDITABLE_FIELDS.filter(f => req.body[f] !== undefined);
  if (fieldsToUpdate.length === 0) {
    return res.status(400).json({
      success: false,
      error: `No editable fields provided. Editable fields: ${EDITABLE_FIELDS.join(', ')}`,
    });
  }

  const bad = validateNumbers(req.body);
  if (bad) return res.status(400).json({ success: false, error: bad });

  const setClauses = fieldsToUpdate.map((field, i) => `${field} = $${i + 2}`);
  const vals = [req.params.solar_code, ...fieldsToUpdate.map(f => req.body[f])];

  try {
    const result = await query(
      `UPDATE solar_list SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE solar_code = $1 RETURNING *`,
      vals
    );
    if (result.rowCount === 0) return notFound(res, req.params.solar_code);
    res.json({ success: true, updated_fields: fieldsToUpdate, data: result.rows[0] });
  } catch (err) { serverError(res, err); }
});

// DELETE /api/solar/:solar_code — removes the site from the list.
// Its stored readings and daily history are kept in the database.
router.delete('/:solar_code', async (req, res) => {
  try {
    const result = await query('DELETE FROM solar_list WHERE solar_code = $1 RETURNING *', [req.params.solar_code]);
    if (result.rowCount === 0) return notFound(res, req.params.solar_code);
    res.json({ success: true, message: `solar_code '${req.params.solar_code}' deleted` });
  } catch (err) { serverError(res, err); }
});

module.exports = router;