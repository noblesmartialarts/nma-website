// Admin panel → database/storage, checked server-side against the admin password.
// The page sends the request it used to make directly to Supabase; this forwards
// it with the service key, but only for the admin panel's tables and buckets.
// POST { path, method, headers:{Prefer,Content-Type,x-upsert,cache-control,Range}, body?, bodyBase64? }
// Header: X-Admin-Password
// → { status, contentRange, body }
const L = require('../lib/server');

const REST = /^\/rest\/v1\/(nma_site_content|nma_sale_items|nma_lost_found|private_lesson_availability)(\?.*)?$/;
const STORAGE = /^\/storage\/v1\/object\/(nma-photos|nma-lost-found)\/[A-Za-z0-9._-]{1,200}$/;
const PASS_HEADERS = ['Prefer', 'Content-Type', 'x-upsert', 'cache-control', 'Range', 'Accept'];
const MAX_UPLOAD = 6 * 1024 * 1024;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return L.json(405, { error: 'method_not_allowed' });
  if (!L.adminOk(event)) return L.json(401, { error: 'Incorrect password' });
  if (!L.serviceKey()) return L.json(500, { error: 'not_configured' });
  let req;
  try { req = JSON.parse(event.body || '{}'); } catch (e) { return L.json(400, { error: 'bad_json' }); }

  const path = String(req.path || '');
  const method = String(req.method || 'GET').toUpperCase();
  const isRest = REST.test(path), isStorage = STORAGE.test(path);
  if (!isRest && !isStorage) return L.json(403, { error: 'Path not allowed' });
  if (isRest && !['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method)) return L.json(405, { error: 'Method not allowed' });
  if (isStorage && !['POST', 'PUT', 'DELETE'].includes(method)) return L.json(405, { error: 'Method not allowed' });
  // Never allow unfiltered bulk updates/deletes on tables.
  if (isRest && (method === 'PATCH' || method === 'DELETE') && !/[?&]id=eq\./.test(path)) return L.json(400, { error: 'Updates and deletes must target one id' });

  const headers = {};
  PASS_HEADERS.forEach(k => { const v = req.headers && (req.headers[k] || req.headers[k.toLowerCase()]); if (v) headers[k] = String(v); });

  let body = null;
  if (req.bodyBase64) {
    body = Buffer.from(req.bodyBase64, 'base64');
    if (body.length > MAX_UPLOAD) return L.json(413, { error: 'File too large' });
    if (isStorage && !/^image\//.test(headers['Content-Type'] || '')) return L.json(400, { error: 'Only images can be uploaded' });
  } else if (req.body != null) {
    body = String(req.body);
  }

  try {
    const res = await L.supa(method, path, body, headers);
    const text = method === 'HEAD' ? '' : await res.text();
    return L.json(200, { status: res.status, contentRange: res.headers.get('content-range') || '', body: text });
  } catch (e) {
    return L.json(502, { error: e.message });
  }
};
