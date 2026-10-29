// Admin panel → parent absence requests, handled server-side.
// The admin password is checked here (ADMIN_PASSWORD env var in Netlify,
// falling back to the original password until that is set) instead of in the
// page source, and only the fields the panel needs leave the server.
// Header: X-Admin-Password
// POST { op:'check' }                → { ok:true }
// POST { op:'list' }                 → { pendingAbsences, students:[{id,first,last,group,status}], attendance:{date:{id:status}} }
// POST { op:'confirm', id }          → marks the student absent, logs history, sets status confirmed
// POST { op:'dismiss', id }          → status dismissed
// POST { op:'cleanup' }              → removes resolved requests older than 30 days
const crypto = require('crypto');
const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';
const FALLBACK_PW = 'Noble2026'; // used only until ADMIN_PASSWORD is set in Netlify

function json(code, obj) { return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) }; }
function pwOk(given) {
  const want = process.env.ADMIN_PASSWORD || FALLBACK_PW;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(want)).digest();
  return crypto.timingSafeEqual(a, b);
}
async function supa(method, path, body, prefer) {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  return fetch(SUPA_URL + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
}
const normName = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
function findStudentMatch(students, name) {
  if (!name) return null;
  const target = normName(name);
  const active = (students || []).filter(s => s.status === 'Active');
  const full = active.find(s => normName(s.first + s.last) === target);
  if (full) return full;
  const last = String(name).trim().split(' ').pop();
  return active.find(s => normName(s.last) === normName(last)) || null;
}
function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}

// Read → change → write with an optimistic lock, so CRM saves in between aren't overwritten.
async function mutate(fn) {
  for (let i = 0; i < 4; i++) {
    const r = await supa('GET', '/rest/v1/crm_data?id=eq.main&select=data,updated_at');
    const rows = await r.json();
    if (!rows || !rows[0]) throw new Error('CRM data not found');
    const DB = rows[0].data;
    const result = fn(DB);
    if (result && (result.error || result.skipWrite)) return result;
    DB._writer = 'admin-panel';
    const w = await supa('PATCH', '/rest/v1/crm_data?id=eq.main&updated_at=eq.' + encodeURIComponent(rows[0].updated_at), { data: DB }, 'return=representation');
    if (!w.ok) throw new Error('Write failed: ' + w.status);
    const out = await w.json();
    if (out && out.length) return result || { ok: true };
  }
  throw new Error('The CRM was saving at the same time — try again');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const h = event.headers || {};
  if (!pwOk(h['x-admin-password'] || h['X-Admin-Password'])) return json(401, { error: 'Incorrect password' });
  if (!process.env.SUPABASE_SERVICE_KEY) return json(500, { error: 'not_configured' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }

  try {
    if (body.op === 'check') return json(200, { ok: true });

    if (body.op === 'list') {
      const r = await supa('GET', '/rest/v1/crm_data?id=eq.main&select=abs:data->pendingAbsences,students:data->students,attendance:data->attendance');
      const rows = await r.json();
      const row = rows[0] || {};
      const pending = row.abs || [];
      const dates = new Set(pending.map(p => p.date));
      const attendance = {};
      Object.keys(row.attendance || {}).forEach(d => { if (dates.has(d)) attendance[d] = row.attendance[d]; });
      const students = (row.students || []).map(s => ({ id: s.id, first: s.first, last: s.last, group: s.group, status: s.status }));
      return json(200, { pendingAbsences: pending, students, attendance });
    }

    if (body.op === 'confirm' || body.op === 'dismiss') {
      const res = await mutate(DB => {
        const req = (DB.pendingAbsences || []).find(r => r.id === body.id);
        if (!req) return { error: 'Request not found' };
        if (body.op === 'dismiss') { req.status = 'dismissed'; return { ok: true }; }
        const student = findStudentMatch(DB.students, req.studentName);
        if (!student) return { error: 'No roster match — cannot confirm' };
        if (!DB.attendance) DB.attendance = {};
        if (!DB.attendance[req.date]) DB.attendance[req.date] = {};
        DB.attendance[req.date][student.id] = 'absent';
        if (!student.history) student.history = [];
        student.history.push({ type: 'note', date: localToday(), note: 'Parent-reported absence for ' + req.date + (req.reason ? ': "' + req.reason + '"' : '') + '. Confirmed via admin panel.' });
        req.status = 'confirmed';
        return { ok: true, student: { first: student.first, last: student.last } };
      });
      return json(res.error ? 400 : 200, res);
    }

    if (body.op === 'cleanup') {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      let removed = 0;
      const res = await mutate(DB => {
        const before = (DB.pendingAbsences || []).length;
        DB.pendingAbsences = (DB.pendingAbsences || []).filter(r => r.status === 'pending' || (r.submittedAt || '') > cutoff);
        removed = before - DB.pendingAbsences.length;
        if (!removed) return { ok: true, removed: 0, skipWrite: true };
        return { ok: true, removed };
      });
      return json(200, res);
    }
    return json(400, { error: 'Unknown op' });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
