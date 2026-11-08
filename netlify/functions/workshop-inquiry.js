// Group-workshop inquiries from /group-workshops → CRM workshop pipeline (workshop_leads).
// The page still submits the Netlify form too (for the email notification); this
// just makes sure every inquiry also lands in the CRM with how they found NMA.
const L = require('../lib/server');

const SOURCES = {
  google_search: 'Google Search',
  google_maps: 'Google Maps / Business Profile',
  ai: 'ChatGPT / AI Assistant',
  instagram: 'Instagram',
  facebook: 'Facebook',
  referral: 'Referral',
  nma_family: 'Previous NMA Family',
  event: 'Flyer / Community Event',
  other: 'Other',
};
const TYPES = {
  parent_teen: 'Parent Group',
  women: "Mother-Daughter / Women's",
  school: 'School',
  church: 'Church',
  corporate: 'Corporate',
  community: 'Community/Neighborhood',
  friends: 'Friend Group/Celebration',
  other: 'Other',
};
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);
const validEmail = e => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return L.json(405, { error: 'method_not_allowed' });
  if (!L.serviceKey()) return L.json(503, { error: 'not_configured' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return L.json(400, { error: 'bad_json' }); }
  if (b['bot-field']) return L.json(200, { ok: true }); // honeypot

  const name = clip(b.name, 120), email = clip(b.email, 160).toLowerCase(), phone = clip(b.phone, 40);
  const group = clip(b.group_size_organization, 160), timeframe = clip(b.timeframe, 160), message = clip(b.message, 2000);
  const sourceKey = clip(b.heard_about, 40), sourceDetail = clip(b.heard_about_detail, 200);
  const typeKey = clip(b.group_type, 40);
  if (!name || !validEmail(email)) return L.json(422, { error: 'invalid', message: 'Name and a valid email are required.' });

  // Light abuse guard: at most 5 inquiries per email address per day.
  try {
    const since = new Date(Date.now() - 864e5).toISOString();
    const r = await L.supa('GET', '/rest/v1/workshop_leads?select=id&contact_email=eq.' + encodeURIComponent(email) + '&created_at=gte.' + encodeURIComponent(since) + '&limit=6');
    const rows = r.ok ? await r.json() : [];
    if (rows.length >= 5) return L.json(429, { error: 'rate_limited' });
  } catch (e) { /* don't block the inquiry on the check */ }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const source = SOURCES[sourceKey] || 'Website Inquiry';
  const track = b.tracking && typeof b.tracking === 'object' ? b.tracking : {};
  const trackLine = ['utm_source', 'utm_medium', 'utm_campaign'].map(k => track[k] ? k.replace('utm_', '') + '=' + clip(track[k], 60) : '').filter(Boolean).join(', ');
  const notes = [
    'Website inquiry (' + today + ')',
    timeframe ? 'Timeframe: ' + timeframe : '',
    'How they found NMA: ' + (SOURCES[sourceKey] || 'not given') + (sourceDetail ? ' — ' + sourceDetail : ''),
    trackLine ? 'Link tracking: ' + trackLine : '',
    track.referrer ? 'Arrived from: ' + clip(track.referrer, 200) : '',
    message ? '\nMessage:\n' + message : '',
  ].filter(Boolean).join('\n');

  const row = {
    organization: group || null,
    contact_name: name,
    contact_email: email,
    contact_phone: phone || null,
    type: TYPES[typeKey] || 'Other',
    status: 'Not Contacted',
    source,
    date_contacted: today,
    notes,
  };
  const res = await L.supa('POST', '/rest/v1/workshop_leads', JSON.stringify(row), { Prefer: 'return=minimal' });
  if (!res.ok) {
    console.error('workshop-inquiry insert failed', res.status, (await res.text()).slice(0, 300));
    return L.json(502, { error: 'save_failed' });
  }
  return L.json(200, { ok: true });
};
