// netlify/functions/submit.js
// Handles all public website form submissions that need Supabase write access.
// Types: 'absence', 'feedback', 'adult', 'lostfound'

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';
const crypto = require('crypto');

exports.handler = async (event) => {
if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders() };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method not allowed' };
  }

  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!KEY) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Server config error' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const type = body.type;

  try {
    if (type === 'absence') {
      return await handleAbsence(body, KEY);
    } else if (type === 'feedback' || type === 'adult') {
      return await handleFormSubmission(body, KEY);
    } else if (type === 'lostfound') {
      return await handleLostFound(body, KEY);
    } else if (type === 'privateLesson') {
      return await handlePrivateLessonBooking(body, KEY);
    } else {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Unknown form type: ' + type }) };
    }
  } catch (e) {
    console.error('submit.js error:', e.message);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: e.message }) };
  }
};

// ── Absence: read crm_data, push pendingAbsence, write back ──
async function handleAbsence(body, KEY) {
  const { studentName, studentId, parentName, parentEmail, dates, reason } = body;
  if (!studentName || !dates || !dates.length) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const fetchRes = await supaFetch('GET', '/rest/v1/crm_data?id=eq.main&select=data', null, KEY);
  const rows = await fetchRes.json();
  if (!rows || !rows[0]) throw new Error('CRM data not found');

  const DB = rows[0].data;
  if (!DB.pendingAbsences) DB.pendingAbsences = [];

  const now = new Date().toISOString();
  const newRequests = dates.map(function(d) {
    return {
      id: 'abs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      studentName, studentId: studentId || null,
      parentName, parentEmail, date: d,
      reason: reason || '', submittedAt: now, status: 'pending'
    };
  });
  DB.pendingAbsences = DB.pendingAbsences.concat(newRequests);

  const writeRes = await supaFetch('PATCH', '/rest/v1/crm_data?id=eq.main', { data: DB }, KEY, 'return=minimal');
  if (!writeRes.ok) throw new Error('Write failed: ' + writeRes.status);

  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ success: true }) };
}

// ── Feedback & Adult Interest: save to Supabase AND forward to Google Sheets ──
const SHEETS_URL = 'https://script.google.com/macros/s/AKfycbycNqK_uHUfqfZclcdkM1GjltM1mMd7Y_TwW1VCiTy48mJP0holMnPT1aRM8H1cdZmZ4g/exec';

async function handleFormSubmission(body, KEY) {
  const submission = { ...body, submittedAt: new Date().toISOString() };

  // 1. Save to Supabase
  const fetchRes = await supaFetch('GET', '/rest/v1/nma_site_content?id=eq.main&select=data', null, KEY);
  const rows = await fetchRes.json();
  if (!rows || !rows[0]) throw new Error('Site content not found');

  const data = rows[0].data || {};
  if (!data.submissions) data.submissions = [];
  data.submissions.push(submission);
  if (data.submissions.length > 200) data.submissions = data.submissions.slice(-200);

  const writeRes = await supaFetch('PATCH', '/rest/v1/nma_site_content?id=eq.main',
    { data, updated_at: new Date().toISOString() }, KEY, 'return=minimal');
  if (!writeRes.ok) throw new Error('Write failed: ' + writeRes.status);

  // 2. Forward to Google Sheets (fire-and-forget — don't fail if Sheets is down)
  try {
    const sheetsPayload = { ...submission, formType: submission.type };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sheetsPayload),
      signal: controller.signal
    });
    clearTimeout(timeout);
  } catch (e) {
    console.warn('Sheets forward failed (non-fatal):', e.message);
  }

  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ success: true }) };
}

// ── Lost & Found: insert into nma_lost_found table ──
async function handleLostFound(body, KEY) {
  const { item, itemType, notes, parentName, contact, photoUrl } = body;
  if (!item || !parentName || !contact) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const payload = {
    type: itemType || 'lost',
    item, notes: notes || '',
    parent_name: parentName,
    contact,
    photo_url: photoUrl || null,
    status: 'open'
  };

  const writeRes = await supaFetch('POST', '/rest/v1/nma_lost_found', payload, KEY, 'return=minimal');
  if (!writeRes.ok) {
    const err = await writeRes.text();
    throw new Error('Insert failed: ' + err);
  }

  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ success: true }) };
}

// ── Private Lesson Booking: create/find client, optional package, booking, participants ──
async function handlePrivateLessonBooking(body, KEY) {
  const {
    relationship, serviceCode, packageChoice, date, startTime,
    clientName, email, phone, linkedStudentId,
    primaryName, primaryAge, additionalParticipants,
    locationType, locationAddress, goals, injuries, comments
  } = body;

  if (!serviceCode || !date || !startTime || !clientName || !email || !phone || !locationAddress) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  // 1. Authoritative service lookup — never trust price/duration from the client
  const svcRes = await supaFetch('GET', '/rest/v1/private_lesson_services?service_code=eq.'+encodeURIComponent(serviceCode)+'&select=*', null, KEY);
  const svcRows = await svcRes.json();
  if (!svcRows || !svcRows[0]) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Unknown service' }) };
  }
  const svc = svcRows[0];

  const additional = Array.isArray(additionalParticipants) ? additionalParticipants.filter(function(p){ return p && p.name; }) : [];
  const participantCount = 1 + additional.length;
  if (participantCount > svc.max_participants) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Too many participants for this service' }) };
  }
  if (packageChoice === 'package' && !svc.package_available) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Packages are not available for this service' }) };
  }

  // 2. Compute end time server-side from the service duration
  const parts = startTime.split(':').map(Number);
  const endMin = parts[0]*60 + parts[1] + svc.duration_minutes;
  const endTime = String(Math.floor(endMin/60)).padStart(2,'0') + ':' + String(endMin%60).padStart(2,'0');

  // 3. Find or create the client by email
  let clientId;
  const findRes = await supaFetch('GET', '/rest/v1/private_lesson_clients?email=eq.'+encodeURIComponent(email)+'&select=id', null, KEY);
  const findRows = await findRes.json();
  if (findRows && findRows[0]) {
    clientId = findRows[0].id;
  } else {
    const relMap = { student:'student', outside_child:'outside', parent:'parent', outside_adult:'outside' };
    const clientPayload = {
      full_name: clientName, email, phone,
      relationship_type: relMap[relationship] || 'outside',
      linked_student_id: linkedStudentId || null
    };
    const createRes = await supaFetch('POST', '/rest/v1/private_lesson_clients', clientPayload, KEY, 'return=representation');
    const createRows = await createRes.json();
    if (!createRes.ok || !createRows[0]) throw new Error('Could not create client record');
    clientId = createRows[0].id;
  }

  // 4. Create a package if requested
  let packageId = null;
  if (packageChoice === 'package') {
    const purchaseDate = new Date();
    const expires = new Date(purchaseDate.getTime() + svc.package_expiration_weeks*7*24*60*60*1000);
    const pkgPayload = {
      client_id: clientId, service_id: svc.id, source: 'purchased',
      sessions_total: svc.package_session_count, sessions_used: 0,
      price_paid: svc.package_price, payment_method: null,
      purchase_date: purchaseDate.toISOString().slice(0,10),
      expires_at: expires.toISOString().slice(0,10),
      status: 'active'
    };
    const pkgRes = await supaFetch('POST', '/rest/v1/private_lesson_packages', pkgPayload, KEY, 'return=representation');
    const pkgRows = await pkgRes.json();
    if (!pkgRes.ok || !pkgRows[0]) throw new Error('Could not create package');
    packageId = pkgRows[0].id;
  }

  // 5. Reference which admin-entered window this falls within (informational only)
  const availRes = await supaFetch('GET',
    '/rest/v1/private_lesson_availability?date=eq.'+date+'&status=eq.open&start_time=lte.'+startTime+'&end_time=gte.'+endTime+'&select=id&limit=1',
    null, KEY);
  const availRows = await availRes.json();
  const availabilitySlotId = (availRows && availRows[0]) ? availRows[0].id : null;

  // 6. Pricing — package covers the base session; extra participants are always billed separately
  const additionalCharge = additional.length * Number(svc.additional_participant_price || 0);
  const baseCharged = packageChoice === 'package' ? 0 : Number(svc.base_price);
  const finalTotal = baseCharged + additionalCharge;
  const magicToken = crypto.randomBytes(24).toString('base64url');

  const bookingPayload = {
    package_id: packageId, service_id: svc.id, primary_client_id: clientId,
    availability_slot_id: availabilitySlotId,
    session_date: date, start_time: startTime, end_time: endTime,
    location_type: locationType || null, location_address: locationAddress,
    training_focus: goals || null, client_goals: goals || null,
    injuries_limitations: injuries || null,
    required_equipment_available: true,
    participant_count: participantCount,
    base_price_charged: baseCharged, additional_participant_charge: additionalCharge,
    package_credit_used: packageChoice === 'package',
    final_total: finalTotal,
    payment_status: 'unpaid', waiver_status: 'pending',
    status: 'pending', created_by: 'client',
    magic_link_token: magicToken,
    instructor_notes: comments || null
  };
  const bookRes = await supaFetch('POST', '/rest/v1/private_lesson_bookings', bookingPayload, KEY, 'return=representation');
  const bookRows = await bookRes.json();
  if (!bookRes.ok || !bookRows[0]) throw new Error('Could not create booking');
  const booking = bookRows[0];

  // 7. Participants — primary attendee plus any additional
  const participantRows = [{
    booking_id: booking.id, full_name: primaryName || clientName,
    age: primaryAge || null, is_primary: true, relationship_to_primary: null
  }].concat(additional.map(function(p){
    return { booking_id: booking.id, full_name: p.name, age: p.age || null, is_primary: false, relationship_to_primary: 'additional' };
  }));
  await supaFetch('POST', '/rest/v1/private_lesson_participants', participantRows, KEY, 'return=minimal');

  // 8. Notify Brandon by email that a new request came in.
  // Silently skipped if RESEND_API_KEY isn't set yet — never blocks the booking itself.
  await notifyOwnerOfNewRequest(booking, svc, clientName, email, phone);
  await sendClientRequestReceivedEmail(booking, svc, clientName, email);

  return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ success: true, magicToken }) };
}

async function sendClientRequestReceivedEmail(booking, svc, clientName, clientEmail) {
  if (!process.env.RESEND_API_KEY) return;
  var venmoUrl = 'https://account.venmo.com/u/BNobleFamily';
  var zelleEmail = 'noblesmartialarts@gmail.com';
  var cancelUrl = 'https://noblesmartialarts.com/.netlify/functions/pl-client-cancel?id=' + booking.id + '&token=' + booking.magic_link_token;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: "Noble's Martial Arts <onboarding@resend.dev>",
        to: clientEmail,
        subject: 'Your Private Lesson Request — Noble\'s Martial Arts',
        html: '<p>Hi ' + clientName + ',</p>'
          + '<p>Thanks for requesting a private lesson! Here\'s what you submitted:</p>'
          + '<ul>'
          + '<li><strong>Service:</strong> ' + svc.service_name + ' (' + svc.duration_minutes + ' min)</li>'
          + '<li><strong>Date/Time:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
          + '<li><strong>Location:</strong> ' + (booking.location_address || '') + '</li>'
          + '<li><strong>Total Due:</strong> $' + booking.final_total + ' via Venmo or Zelle</li>'
          + '</ul>'
          + '<p>Sensei Brandon will confirm your payment and approve the session — you\'ll get a follow-up email once that happens. If you haven\'t sent payment yet, you can do that now:</p>'
          + '<p><a href="' + venmoUrl + '" style="display:inline-block;background:#0f00f7;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:bold;margin-right:8px;">Pay via Venmo</a>'
          + 'Zelle: ' + zelleEmail + '</p>'
          + '<p style="color:#888;font-size:13px;">Need to cancel this request? <a href="' + cancelUrl + '">Click here</a> — no penalty up to 60 minutes before your session.</p>'
          + '<p>Questions? Just reply to this email or reach out at noblesmartialarts@gmail.com.</p>'
      })
    });
  } catch (e) {
    console.error('Client request-received email failed:', e);
  }
}

async function notifyOwnerOfNewRequest(booking, svc, clientName, clientEmail, clientPhone) {
  if (!process.env.RESEND_API_KEY) return; // not configured yet
  var approveUrl = 'https://noblesmartialarts.com/.netlify/functions/pl-action?id=' + booking.id + '&token=' + booking.magic_link_token + '&action=approve';
  var declineUrl = 'https://noblesmartialarts.com/.netlify/functions/pl-action?id=' + booking.id + '&token=' + booking.magic_link_token + '&action=decline';
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'NMA Private Lessons <onboarding@resend.dev>',
        to: 'noblesmartialarts@gmail.com',
        subject: 'New Private Lesson Request — ' + clientName,
        html: '<p><strong>New private lesson request:</strong></p>'
          + '<ul>'
          + '<li><strong>Client:</strong> ' + clientName + ' (' + clientEmail + ', ' + clientPhone + ')</li>'
          + '<li><strong>Service:</strong> ' + svc.service_name + '</li>'
          + '<li><strong>Date/Time:</strong> ' + booking.session_date + ' at ' + booking.start_time + '</li>'
          + '<li><strong>Location:</strong> ' + (booking.location_address || '') + '</li>'
          + '<li><strong>Due:</strong> $' + booking.final_total + '</li>'
          + '</ul>'
          + '<p style="margin-top:16px;">'
          + '<a href="' + approveUrl + '" style="display:inline-block;background:#22c55e;color:#08080f;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;margin-right:10px;">Approve</a>'
          + '<a href="' + declineUrl + '" style="display:inline-block;background:#ff5a5a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Decline</a>'
          + '</p>'
          + '<p style="color:#888;font-size:13px;">Clicking either button opens a confirmation page — nothing is finalized until you confirm there. You can also review it in the CRM\'s Private Lessons tab.</p>'
      })
    });
  } catch (e) {
    console.error('Owner notification email failed:', e);
  }
}

// ── Helpers ──
function supaFetch(method, path, body, KEY, prefer) {
  const headers = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json'
  };
  if (prefer) headers['Prefer'] = prefer;
  return fetch(SUPA_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
