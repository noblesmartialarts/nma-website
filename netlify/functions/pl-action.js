// netlify/functions/pl-action.js
// Approve/decline links used in the private-lesson owner-notification email.
// GET renders a confirmation page (safe for email link-scanners to pre-fetch —
// it doesn't change anything). The confirmation page's own form POSTs back
// here to actually perform the update, which only ever happens from a real
// button click, never from a bare GET.

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

exports.handler = async (event) => {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!KEY) return html(500, errorPage('Server configuration error.'));

  const params = event.httpMethod === 'GET' ? (event.queryStringParameters || {}) : parseFormBody(event.body);
  const { id, token, action } = params;
  if (!id || !token || (action !== 'approve' && action !== 'decline')) {
    return html(400, errorPage('This link is missing required information.'));
  }

  const bookRes = await supaFetch('GET',
    '/rest/v1/private_lesson_bookings?id=eq.' + encodeURIComponent(id) +
    '&select=*,service:private_lesson_services(*),client:private_lesson_clients(*),participants:private_lesson_participants(*)', KEY);
  const bookRows = await bookRes.json();
  const booking = bookRows && bookRows[0];
  if (!booking) return html(404, errorPage('This request could not be found — it may have been deleted.'));
  if (booking.magic_link_token !== token) return html(403, errorPage('This link is invalid.'));

  if (booking.status !== 'pending') {
    return html(200, statusPage('This request has already been ' + (booking.status === 'set' ? 'approved' : booking.status) + '.'));
  }

  if (event.httpMethod === 'GET') {
    return html(200, confirmPage(booking, action, id, token));
  }

  // POST — actually perform the action
  const updatePayload = { status: action === 'approve' ? 'set' : 'canceled' };
  if (action === 'decline') { updatePayload.canceled_by = 'brandon'; updatePayload.cancel_reason = 'Declined via email'; }

  const updRes = await supaFetch('PATCH', '/rest/v1/private_lesson_bookings?id=eq.' + encodeURIComponent(id), KEY, updatePayload);
  if (!updRes.ok) return html(500, errorPage("Something went wrong updating this request — please use the CRM instead."));

  return html(200, successPage(action));
};

function supaFetch(method, path, KEY, body) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (body) headers['Prefer'] = 'return=representation';
  return fetch(SUPA_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function parseFormBody(body) {
  const out = {};
  (body || '').split('&').forEach(function(pair){
    var parts = pair.split('=');
    if (parts[0]) out[decodeURIComponent(parts[0])] = decodeURIComponent((parts[1]||'').replace(/\+/g,' '));
  });
  return out;
}

function html(statusCode, body) {
  return { statusCode: statusCode, headers: { 'Content-Type': 'text/html' }, body: body };
}

function pageWrap(inner) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Private Lesson Request</title><style>'
    + 'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#08080f;color:#f4f4fa;margin:0;padding:40px 20px;}'
    + '.card{max-width:460px;margin:0 auto;background:#13131f;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:28px;}'
    + 'h1{font-size:1.3rem;margin:0 0 14px;}'
    + '.row{font-size:.9rem;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08);}'
    + '.row b{color:#9a9ab4;font-weight:600;}'
    + '.btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;font-size:.9rem;border:none;cursor:pointer;text-decoration:none;font-family:inherit;}'
    + '.btn-approve{background:#22c55e;color:#08080f;} .btn-decline{background:#ff5a5a;color:#fff;}'
    + '</style></head><body><div class="card">' + inner + '</div></body></html>';
}

function confirmPage(booking, action, id, token) {
  var svc = booking.service || {}, c = booking.client || {};
  var primary = (booking.participants || []).filter(function(p){ return p.is_primary; })[0] || {};
  var studentRow = (primary.full_name && primary.full_name !== c.full_name) ? '<div class="row"><b>Student:</b> ' + esc(primary.full_name) + '</div>' : '';
  var label = action === 'approve' ? 'Approve' : 'Decline';
  var color = action === 'approve' ? 'btn-approve' : 'btn-decline';
  return pageWrap(
    '<h1>' + label + ' this request?</h1>'
    + '<div class="row"><b>Client:</b> ' + esc(c.full_name) + '</div>'
    + studentRow
    + '<div class="row"><b>Service:</b> ' + esc(svc.service_name) + '</div>'
    + '<div class="row"><b>Date/Time:</b> ' + esc(booking.session_date) + ' at ' + esc(booking.start_time) + '</div>'
    + '<div class="row"><b>Location:</b> ' + esc(booking.location_address || '') + '</div>'
    + '<div class="row"><b>Due:</b> $' + booking.final_total + '</div>'
    + (action === 'approve' ? '<p style="font-size:.85rem;color:#9a9ab4;margin-top:14px;">Make sure you\'ve confirmed payment via Venmo/Zelle before approving.</p>' : '')
    + '<form method="POST" action="/.netlify/functions/pl-action" style="margin-top:18px;">'
    + '<input type="hidden" name="id" value="' + esc(id) + '">'
    + '<input type="hidden" name="token" value="' + esc(token) + '">'
    + '<input type="hidden" name="action" value="' + esc(action) + '">'
    + '<button class="btn ' + color + '" type="submit">Yes, ' + label + ' This Request</button>'
    + '</form>'
  );
}

function successPage(action) {
  var msg = action === 'approve' ? '✅ Approved!' : '❌ Declined';
  return pageWrap('<h1>' + msg + '</h1><p style="color:#9a9ab4;">This request has been updated. Full details are always in the CRM\'s Private Lessons tab.</p>');
}

function statusPage(msg) {
  return pageWrap('<h1>Already handled</h1><p style="color:#9a9ab4;">' + esc(msg) + '</p>');
}

function errorPage(msg) {
  return pageWrap('<h1>Something\'s not right</h1><p style="color:#9a9ab4;">' + esc(msg) + '</p>');
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
