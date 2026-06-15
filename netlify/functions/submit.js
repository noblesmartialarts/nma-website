// netlify/functions/submit.js
// Handles all public website form submissions that need Supabase write access.
// Types: 'absence', 'feedback', 'adult', 'lostfound'

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

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
    // Map 'type' to 'formType' to match what the Google Apps Script expects
    const sheetsPayload = { ...submission, formType: submission.type };
    await fetch(SHEETS_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sheetsPayload)
    });
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
