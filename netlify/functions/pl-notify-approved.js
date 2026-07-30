// netlify/functions/pl-notify-approved.js
// Scheduled function (see netlify.toml, runs every 5 minutes). Finds bookings
// that just became "set" (approved) but haven't gotten their client
// confirmation email yet, sends it, and stamps client_notified_at so it
// never sends twice. Works no matter how the booking got approved — CRM
// click or email link — since it's just watching the status column.

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

exports.handler = async () => {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!KEY || !process.env.RESEND_API_KEY) return { statusCode: 200, body: 'skipped (not configured)' };

  const res = await supaFetch('GET',
    '/rest/v1/private_lesson_bookings?status=eq.set&client_notified_at=is.null&select=*,service:private_lesson_services(*),client:private_lesson_clients(*)', KEY);
  const rows = await res.json();
  if (!res.ok) {
    console.error('pl-notify-approved query failed:', JSON.stringify(rows));
    return { statusCode: 200, body: 'query error: ' + JSON.stringify(rows) };
  }
  if (!rows || !rows.length) {
    console.log('pl-notify-approved: nothing to notify');
    return { statusCode: 200, body: 'nothing to notify' };
  }
  console.log('pl-notify-approved: found ' + rows.length + ' booking(s) to notify');

  var sent = 0;
  for (const booking of rows) {
    try {
      await sendApprovalEmail(booking);
      await supaFetch('PATCH', '/rest/v1/private_lesson_bookings?id=eq.' + booking.id, KEY, { client_notified_at: new Date().toISOString() });
      sent++;
      console.log('pl-notify-approved: sent for booking ' + booking.id);
    } catch (e) {
      console.error('Failed to notify booking ' + booking.id, e);
    }
  }
  console.log('pl-notify-approved: notified ' + sent + ' of ' + rows.length);
  return { statusCode: 200, body: 'notified ' + sent + ' of ' + rows.length };
};

async function sendApprovalEmail(booking) {
  var svc = booking.service || {}, c = booking.client || {};
  var cancelUrl = 'https://noblesmartialarts.com/.netlify/functions/pl-client-cancel?id=' + booking.id + '&token=' + booking.magic_link_token;
  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: "Noble's Martial Arts <noreply@noblesmartialarts.com>",
      reply_to: 'noblesmartialarts@gmail.com',
      to: c.email,
      subject: 'Your Private Lesson is Confirmed! 🥋',
      html: '<p>Hi ' + (c.full_name || '') + ',</p>'
        + "<p>You're all set — Sensei Brandon has confirmed your private lesson:</p>"
        + '<ul>'
        + '<li><strong>Service:</strong> ' + (svc.service_name || '') + '</li>'
        + '<li><strong>Date/Time:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
        + '<li><strong>Location:</strong> ' + (booking.location_address || '') + '</li>'
        + '</ul>'
        + '<p>Please arrive ready or be prepared with water and appropriate athletic clothing.</p>'
        + '<p>Need to cancel? <a href="' + cancelUrl + '" style="color:#0f00f7;">Cancel this session</a> — no penalty up to 60 minutes before your start time. Need to reschedule instead? Just reply to this email.</p>'
        + '<p>See you soon!</p>'
    })
  });
  if (!res.ok) {
    var errBody = await res.text();
    throw new Error('Resend API error (' + res.status + '): ' + errBody);
  }
}

function supaFetch(method, path, KEY, body) {
  const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (body) headers['Prefer'] = 'return=representation';
  return fetch(SUPA_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
