// netlify/functions/sale-notify-approved.js
// Scheduled function (see netlify.toml, runs every 5 minutes). Finds sale
// orders approved but not yet emailed (status='approved', client_notified_at
// is null), sends the requestor the Venmo link pre-filled with their total,
// then stamps client_notified_at so it never double-sends. Works whether the
// approval happened via the email Approve button or a future CRM UI.

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';

exports.handler = async () => {
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!KEY || !process.env.RESEND_API_KEY) return { statusCode: 200, body: 'skipped (not configured)' };

  const res = await supaFetch('GET',
    '/rest/v1/nma_sale_orders?status=eq.approved&client_notified_at=is.null&select=*', KEY);
  const rows = await res.json();
  if (!res.ok) {
    console.error('sale-notify-approved query failed:', JSON.stringify(rows));
    return { statusCode: 200, body: 'query error' };
  }
  if (!rows || !rows.length) return { statusCode: 200, body: 'nothing to notify' };

  var sent = 0;
  for (const order of rows) {
    try {
      await sendApprovalEmail(order);
      await supaFetch('PATCH', '/rest/v1/nma_sale_orders?id=eq.' + order.id, KEY, { client_notified_at: new Date().toISOString() });
      sent++;
    } catch (e) {
      console.error('Failed to notify sale approval for order ' + order.id, e);
    }
  }
  return { statusCode: 200, body: 'notified ' + sent + ' of ' + rows.length };
};

async function sendApprovalEmail(order) {
  var total = Number(order.total).toFixed(2);
  var venmoUrl = 'https://account.venmo.com/payment-link?audience=private&amount=' + total
    + '&note=' + encodeURIComponent('NMA Sale Order') + '&recipients=%2CBNobleFamily&txn=pay';
  var zelleEmail = 'noblesmartialarts@gmail.com';
  var itemLines = order.items.map(function(i){
    return '<li>' + i.qty + ' × ' + i.title + ' — $' + (i.qty * i.unit_price).toFixed(2) + '</li>';
  }).join('');

  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: "Noble's Martial Arts <noreply@noblesmartialarts.com>",
      reply_to: 'noblesmartialarts@gmail.com',
      to: order.requestor_email,
      subject: 'Your NMA Sale Item Request is Approved! 🥋',
      html: '<p>Hi ' + order.requestor_name + ',</p>'
        + "<p>Good news — Sensei Brandon has approved your item request:</p>"
        + '<ul>' + itemLines + '</ul>'
        + '<p><strong>Total Due:</strong> $' + total + '</p>'
        + '<p><a href="' + venmoUrl + '" style="display:inline-block;background:#0f00f7;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:bold;margin-right:8px;">Pay via Venmo</a>'
        + 'Or Zelle: ' + zelleEmail + '</p>'
        + '<p>Once payment is received, you can pick up your item(s) at the next class. Thanks!</p>'
        + '<p>Questions? Just reply to this email or reach out at noblesmartialarts@gmail.com.</p>'
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
