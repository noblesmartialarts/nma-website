// Public, minimal roster for the website's name autocomplete (absence notice,
// sale form, private-training booking). Returns ONLY active students' id, first
// and last name, and class group — never DOBs, parent contacts, notes, etc.
// Response keeps the old crm_data row shape so page code barely changes:
//   [{ data: { students: [{ id, first, last, group, status:'Active' }] } }]
const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

exports.handler = async () => {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' };
  if (!KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'not_configured' }) };
  try {
    const res = await fetch(SUPA_URL + '/rest/v1/crm_data?id=eq.main&select=students:data->students', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY },
    });
    if (!res.ok) throw new Error('Database error ' + res.status);
    const rows = await res.json();
    const students = ((rows[0] && rows[0].students) || [])
      .filter(s => s && s.status === 'Active')
      .map(s => ({ id: s.id, first: s.first || '', last: s.last || '', group: s.group || '', status: 'Active' }));
    return { statusCode: 200, headers, body: JSON.stringify([{ data: { students } }]) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
