// Shared helpers for the website's server functions (service key stays in Netlify env).
const crypto = require('crypto');
const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

function serviceKey() { return process.env.SUPABASE_SERVICE_KEY || ''; }
function json(code, obj, extra) {
  return { statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}), body: JSON.stringify(obj) };
}
function header(event, name) {
  const h = event.headers || {};
  const k = Object.keys(h).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : '';
}
// Constant-time secret comparison.
function same(given, want) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(want || '')).digest();
  return crypto.timingSafeEqual(a, b);
}
// Admin panel password: ADMIN_PASSWORD in Netlify, falling back to the original until it's set.
function adminOk(event) { return same(header(event, 'x-admin-password'), process.env.ADMIN_PASSWORD || 'Noble2026'); }
// Luther's workshop-leads PIN: WORKSHOP_PIN in Netlify, falling back to the original until it's set.
function pinOk(event) { return same(header(event, 'x-leads-pin'), process.env.WORKSHOP_PIN || 'Workshops2026'); }

async function supa(method, path, body, headers) {
  const h = Object.assign({ apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey() }, headers || {});
  if (body != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
  return fetch(SUPA_URL + path, { method, headers: h, body: body == null ? undefined : body });
}

module.exports = { SUPA_URL, serviceKey, json, header, same, adminOk, pinOk, supa };
