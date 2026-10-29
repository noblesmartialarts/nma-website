// Public website actions that used to hit the database directly.
// GET  ?op=lf-list                        → open lost & found items (no contact details)
// POST { op:'lf-flag', id }               → parent marks an open item as resolved (Sensei confirms)
// POST { op:'lf-upload', filename, contentType, data } → upload a lost & found photo (image only, ≤5 MB)
const L = require('../lib/server');

const MAX = 5 * 1024 * 1024;

exports.handler = async (event) => {
  if (!L.serviceKey()) return L.json(500, { error: 'not_configured' });
  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST') { try { body = JSON.parse(event.body || '{}'); } catch (e) { return L.json(400, { error: 'bad_json' }); } }
  const op = body.op || qs.op;

  try {
    if (op === 'lf-list') {
      const r = await L.supa('GET', '/rest/v1/nma_lost_found?select=id,type,item,notes,photo_url,parent_name,status,created_at&status=neq.resolved&order=created_at.desc');
      if (!r.ok) return L.json(502, { error: 'Database error ' + r.status });
      return L.json(200, await r.json(), { 'Cache-Control': 'public, max-age=30' });
    }

    if (op === 'lf-flag' && event.httpMethod === 'POST') {
      const id = String(body.id || '');
      if (!/^[\w-]{1,64}$/.test(id)) return L.json(400, { error: 'bad_id' });
      const now = new Date().toISOString();
      // Only items that are still open can be flagged.
      const r = await L.supa('PATCH', '/rest/v1/nma_lost_found?id=eq.' + encodeURIComponent(id) + '&status=eq.open',
        JSON.stringify({ status: 'pending_resolution', resolution_requested_at: now, updated_at: now }), { Prefer: 'return=minimal' });
      if (!r.ok) return L.json(502, { error: 'Database error ' + r.status });
      return L.json(200, { success: true });
    }

    if (op === 'lf-upload' && event.httpMethod === 'POST') {
      const type = String(body.contentType || '');
      if (!/^image\/(jpeg|png|webp|gif|heic|heif)$/.test(type)) return L.json(400, { error: 'Please upload a photo (JPG or PNG).' });
      const buf = Buffer.from(String(body.data || ''), 'base64');
      if (!buf.length) return L.json(400, { error: 'Empty file' });
      if (buf.length > MAX) return L.json(413, { error: 'Photo is too large (5 MB max).' });
      const name = Date.now() + '-' + String(body.filename || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const r = await L.supa('POST', '/storage/v1/object/nma-lost-found/' + name, buf, { 'Content-Type': type, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' });
      if (!r.ok) return L.json(502, { error: 'Upload failed (' + r.status + ')' });
      return L.json(200, { url: L.SUPA_URL + '/storage/v1/object/public/nma-lost-found/' + name });
    }

    return L.json(400, { error: 'Unknown op' });
  } catch (e) {
    return L.json(500, { error: e.message });
  }
};
