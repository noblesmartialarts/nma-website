// netlify/functions/pl-client-cancel.js
// Self-service cancellation link sent to clients in their confirmation emails.
// Same GET-shows-confirmation / POST-performs-action pattern as pl-action.js,
// so email link-scanners can't accidentally trigger a cancellation.
// Enforces the 60-minutes-before-session cutoff from the stated policy —
// past that point, the client is told to contact Brandon directly instead.

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

exports.handler = async (event) => {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!KEY) return html(500, errorPage('Server configuration error.'));

  const params = event.httpMethod === 'GET' ? (event.queryStringParameters || {}) : parseFormBody(event.body);
  const { id, token } = params;
  if (!id || !token) return html(400, errorPage('This link is missing required information.'));

  const bookRes = await supaFetch('GET',
    '/rest/v1/private_lesson_bookings?id=eq.' + encodeURIComponent(id) +
    '&select=*,service:private_lesson_services(*),client:private_lesson_clients(*)', KEY);
  const bookRows = await bookRes.json();
  const booking = bookRows && bookRows[0];
  if (!booking) return html(404, errorPage('This session could not be found.'));
  if (booking.magic_link_token !== token) return html(403, errorPage('This link is invalid.'));

  if (booking.status === 'canceled') return html(200, statusPage('This session has already been canceled.'));
  if (booking.status === 'completed') return html(200, statusPage('This session has already taken place.'));

  const minutesUntil = (zonedTimeToUtc(booking.session_date, booking.start_time, 'America/New_York').getTime() - Date.now()) / 60000;
  const tooLate = minutesUntil < 60;

  if (tooLate) {
    return html(200, tooLateePage(booking));
  }

  if (event.httpMethod === 'GET') {
    return html(200, confirmPage(booking, id, token));
  }

  // POST — perform the cancellation (re-checking the cutoff, in case time passed since the GET)
  const recheckMinutes = (zonedTimeToUtc(booking.session_date, booking.start_time, 'America/New_York').getTime() - Date.now()) / 60000;
  if (recheckMinutes < 60) return html(200, tooLateePage(booking));

  const updRes = await supaFetch('PATCH', '/rest/v1/private_lesson_bookings?id=eq.' + encodeURIComponent(id), KEY,
    { status: 'canceled', canceled_by: 'client', cancel_reason: 'Canceled by client via email link' });
  if (!updRes.ok) return html(500, errorPage('Something went wrong — please email noblesmartialarts@gmail.com to cancel.'));

  await notifyOwnerOfCancellation(booking);
  return html(200, successPage());
};

async function notifyOwnerOfCancellation(booking) {
  if (!process.env.RESEND_API_KEY) return;
  var svc = booking.service || {}, c = booking.client || {};
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Noble\'s Martial Arts <noreply@noblesmartialarts.com>',
        to: 'noblesmartialarts@gmail.com',
        subject: 'Session Canceled — ' + (c.full_name || 'a client'),
        html: '<p><strong>' + (c.full_name || 'A client') + '</strong> just canceled their session:</p>'
          + '<ul>'
          + '<li><strong>Service:</strong> ' + (svc.service_name || '') + '</li>'
          + '<li><strong>Was scheduled:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
          + '</ul>'
      })
    });
    if (!res.ok) console.error('Cancellation notification rejected (' + res.status + '):', await res.text());
  } catch (e) { console.error('Cancellation notification failed:', e); }
}

// See tz_test.js verification: correctly handles EST/EDT.
function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const dt = new Date(dateStr + 'T' + timeStr + ':00');
  const tzDate = new Date(dt.toLocaleString('en-US', { timeZone }));
  const offset = dt.getTime() - tzDate.getTime();
  return new Date(dt.getTime() + offset);
}

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
    + '<title>Cancel Private Lesson</title><style>'
    + 'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#08080f;color:#f4f4fa;margin:0;padding:40px 20px;}'
    + '.card{max-width:460px;margin:0 auto;background:#13131f;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:28px;}'
    + 'h1{font-size:1.3rem;margin:0 0 14px;}'
    + '.row{font-size:.9rem;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08);}'
    + '.row b{color:#9a9ab4;font-weight:600;}'
    + '.btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;font-size:.9rem;border:none;cursor:pointer;text-decoration:none;font-family:inherit;background:#ff5a5a;color:#fff;}'
    + '</style></head><body><div class="card">' + inner + '</div></body></html>';
}

function confirmPage(booking, id, token) {
  var svc = booking.service || {};
  return pageWrap(
    '<h1>Cancel this session?</h1>'
    + '<div class="row"><b>Service:</b> ' + esc(svc.service_name) + '</div>'
    + '<div class="row"><b>Date/Time:</b> ' + esc(booking.session_date) + ' at ' + esc(booking.start_time) + '</div>'
    + '<p style="font-size:.85rem;color:#9a9ab4;margin-top:14px;">This is more than 60 minutes before your session, so no penalty applies.</p>'
    + '<form method="POST" action="/.netlify/functions/pl-client-cancel" style="margin-top:18px;">'
    + '<input type="hidden" name="id" value="' + esc(id) + '">'
    + '<input type="hidden" name="token" value="' + esc(token) + '">'
    + '<button class="btn" type="submit">Yes, Cancel My Session</button>'
    + '</form>'
  );
}

function tooLateePage(booking) {
  return pageWrap(
    '<h1>Too close to cancel online</h1>'
    + '<p style="color:#9a9ab4;">Sessions can only be canceled online up to 60 minutes before the start time. Please email <a href="mailto:noblesmartialarts@gmail.com" style="color:#f4f4fa;">noblesmartialarts@gmail.com</a> directly to cancel this session.</p>'
  );
}

function successPage() {
  return pageWrap('<h1>✅ Canceled</h1><p style="color:#9a9ab4;">Your session has been canceled. Sensei Brandon has been notified.</p>');
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
