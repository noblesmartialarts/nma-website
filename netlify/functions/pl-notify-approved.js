// netlify/functions/pl-notify-approved.js
// Scheduled function (see netlify.toml, runs every 5 minutes). Two jobs, both
// working no matter whether the action happened via the CRM or an email link:
// 1. Newly-approved bookings (status='set') -> email client + owner receipt.
// 2. Owner-canceled bookings (status='canceled', canceled_by='brandon') ->
//    email client + owner receipt. (Client-initiated cancellations already
//    send their own emails synchronously in pl-client-cancel.js.)

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

exports.handler = async () => {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!KEY || !process.env.RESEND_API_KEY) return { statusCode: 200, body: 'skipped (not configured)' };

  const approvedResult = await processApprovals(KEY);
  const canceledResult = await processOwnerCancellations(KEY);
  const summary = 'approvals: ' + approvedResult + ' | owner-cancellations: ' + canceledResult;
  console.log('pl-notify-approved: ' + summary);
  return { statusCode: 200, body: summary };
};

async function processApprovals(KEY) {
  const res = await supaFetch('GET',
    '/rest/v1/private_lesson_bookings?status=eq.set&client_notified_at=is.null&select=*,service:private_lesson_services(*),client:private_lesson_clients(*),participants:private_lesson_participants(*)', KEY);
  const rows = await res.json();
  if (!res.ok) {
    console.error('pl-notify-approved (approvals) query failed:', JSON.stringify(rows));
    return 'query error';
  }
  if (!rows || !rows.length) return 'nothing to notify';

  var sent = 0;
  for (const booking of rows) {
    try {
      await sendApprovalEmail(booking);
      await sendOwnerApprovalReceipt(booking); // best-effort, doesn't block the client email or the notified stamp
      await supaFetch('PATCH', '/rest/v1/private_lesson_bookings?id=eq.' + booking.id, KEY, { client_notified_at: new Date().toISOString() });
      sent++;
    } catch (e) {
      console.error('Failed to notify approval for booking ' + booking.id, e);
    }
  }
  return 'notified ' + sent + ' of ' + rows.length;
}

async function processOwnerCancellations(KEY) {
  const res = await supaFetch('GET',
    '/rest/v1/private_lesson_bookings?status=eq.canceled&canceled_by=eq.brandon&client_cancel_notified_at=is.null&select=*,service:private_lesson_services(*),client:private_lesson_clients(*),participants:private_lesson_participants(*)', KEY);
  const rows = await res.json();
  if (!res.ok) {
    console.error('pl-notify-approved (cancellations) query failed:', JSON.stringify(rows));
    return 'query error';
  }
  if (!rows || !rows.length) return 'nothing to notify';

  var sent = 0;
  for (const booking of rows) {
    try {
      await sendOwnerCancelClientEmail(booking);
      await sendOwnerCancelReceipt(booking); // best-effort, doesn't block the client email or the notified stamp
      await supaFetch('PATCH', '/rest/v1/private_lesson_bookings?id=eq.' + booking.id, KEY, { client_cancel_notified_at: new Date().toISOString() });
      sent++;
    } catch (e) {
      console.error('Failed to notify owner-cancellation for booking ' + booking.id, e);
    }
  }
  return 'notified ' + sent + ' of ' + rows.length;
}

async function sendOwnerCancelClientEmail(booking) {
  var svc = booking.service || {}, c = booking.client || {};
  if (!c.email) return;
  var primary = (booking.participants || []).filter(function(p){ return p.is_primary; })[0] || {};
  var participantLine = (primary.full_name && primary.full_name !== c.full_name) ? '<li><strong>Student:</strong> ' + primary.full_name + '</li>' : '';
  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: "Noble's Martial Arts <noreply@noblesmartialarts.com>",
      reply_to: 'noblesmartialarts@gmail.com',
      to: c.email,
      subject: 'Your Private Lesson Has Been Canceled',
      html: '<p>Hi ' + (c.full_name || '') + ',</p>'
        + '<p>Sensei Brandon has canceled the following session' + (booking.cancel_reason ? ' — ' + booking.cancel_reason : '') + ':</p>'
        + '<ul>'
        + participantLine
        + '<li><strong>Service:</strong> ' + (svc.service_name || '') + '</li>'
        + '<li><strong>Was scheduled:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
        + '</ul>'
        + '<p>Questions, or want to find a new time? Just reply to this email or reach out at noblesmartialarts@gmail.com.</p>'
    })
  });
  if (!res.ok) {
    var errBody = await res.text();
    throw new Error('Resend API error (' + res.status + '): ' + errBody);
  }
}

async function sendOwnerCancelReceipt(booking) {
  var svc = booking.service || {}, c = booking.client || {};
  var primary = (booking.participants || []).filter(function(p){ return p.is_primary; })[0] || {};
  var participantLine = (primary.full_name && primary.full_name !== c.full_name) ? '<li><strong>Student:</strong> ' + primary.full_name + '</li>' : '';
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: "Noble's Martial Arts <noreply@noblesmartialarts.com>",
        to: 'noblesmartialarts@gmail.com',
        subject: '✓ You canceled — ' + (c.full_name || 'a client'),
        html: '<p>This confirms you canceled:</p>'
          + '<ul>'
          + '<li><strong>Client:</strong> ' + (c.full_name || '') + '</li>'
          + participantLine
          + '<li><strong>Service:</strong> ' + (svc.service_name || '') + '</li>'
          + '<li><strong>Was scheduled:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
          + '</ul>'
          + '<p style="color:#888;font-size:13px;">The client has been (or will shortly be) notified separately.</p>'
      })
    });
    if (!res.ok) console.error('Owner cancel receipt rejected (' + res.status + '):', await res.text());
  } catch (e) {
    console.error('Owner cancel receipt failed:', e);
  }
}

async function sendOwnerApprovalReceipt(booking) {
  var svc = booking.service || {}, c = booking.client || {};
  var primary = (booking.participants || []).filter(function(p){ return p.is_primary; })[0] || {};
  var participantLine = (primary.full_name && primary.full_name !== c.full_name) ? '<li><strong>Student:</strong> ' + primary.full_name + '</li>' : '';
  try {
    var res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: "Noble's Martial Arts <noreply@noblesmartialarts.com>",
        to: 'noblesmartialarts@gmail.com',
        subject: '✓ You approved — ' + (c.full_name || 'a client'),
        html: '<p>This confirms you approved:</p>'
          + '<ul>'
          + '<li><strong>Client:</strong> ' + (c.full_name || '') + '</li>'
          + participantLine
          + '<li><strong>Service:</strong> ' + (svc.service_name || '') + '</li>'
          + '<li><strong>Date/Time:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
          + '</ul>'
          + '<p style="color:#888;font-size:13px;">The client has been (or will shortly be) notified separately.</p>'
      })
    });
    if (!res.ok) console.error('Owner approval receipt rejected (' + res.status + '):', await res.text());
  } catch (e) {
    console.error('Owner approval receipt failed:', e);
  }
}

async function sendApprovalEmail(booking) {
  var svc = booking.service || {}, c = booking.client || {};
  var primary = (booking.participants || []).filter(function(p){ return p.is_primary; })[0] || {};
  var participantLine = (primary.full_name && primary.full_name !== c.full_name) ? '<li><strong>Student:</strong> ' + primary.full_name + '</li>' : '';
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
        + participantLine
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
