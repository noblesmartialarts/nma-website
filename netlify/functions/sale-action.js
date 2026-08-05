// netlify/functions/sale-action.js
// Approve/decline links used in the sale-item owner-notification email.
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

  const orderRes = await supaFetch('GET', '/rest/v1/nma_sale_orders?id=eq.' + encodeURIComponent(id) + '&select=*', KEY);
  const orderRows = await orderRes.json();
  const order = orderRows && orderRows[0];
  if (!order) return html(404, errorPage('This request could not be found — it may have been deleted.'));
  if (order.magic_link_token !== token) return html(403, errorPage('This link is invalid.'));

  if (order.status !== 'pending') {
    return html(200, statusPage('This request has already been ' + order.status + '.'));
  }

  if (event.httpMethod === 'GET') {
    return html(200, confirmPage(order, action, id, token));
  }

  // POST — actually perform the action
  if (action === 'approve') {
    // Decrement stock, release the reservation, mark approved
    for (var i = 0; i < order.items.length; i++) {
      var oi = order.items[i];
      var itemRes = await supaFetch('GET', '/rest/v1/nma_sale_items?id=eq.' + oi.item_id + '&select=quantity,reserved', KEY);
      var itemRows = await itemRes.json();
      var dbItem = itemRows && itemRows[0];
      if (dbItem) {
        await supaFetch('PATCH', '/rest/v1/nma_sale_items?id=eq.' + oi.item_id,
          KEY, { quantity: Math.max(0, dbItem.quantity - oi.qty), reserved: Math.max(0, dbItem.reserved - oi.qty) });
      }
    }
    const updRes = await supaFetch('PATCH', '/rest/v1/nma_sale_orders?id=eq.' + encodeURIComponent(id),
      KEY, { status: 'approved', approved_at: new Date().toISOString() });
    if (!updRes.ok) return html(500, errorPage('Something went wrong updating this request — please use the CRM instead.'));
  } else {
    // Decline: just release the reservation, no stock change
    for (var j = 0; j < order.items.length; j++) {
      var oj = order.items[j];
      var itemRes2 = await supaFetch('GET', '/rest/v1/nma_sale_items?id=eq.' + oj.item_id + '&select=reserved', KEY);
      var itemRows2 = await itemRes2.json();
      var dbItem2 = itemRows2 && itemRows2[0];
      if (dbItem2) {
        await supaFetch('PATCH', '/rest/v1/nma_sale_items?id=eq.' + oj.item_id, KEY, { reserved: Math.max(0, dbItem2.reserved - oj.qty) });
      }
    }
    const updRes2 = await supaFetch('PATCH', '/rest/v1/nma_sale_orders?id=eq.' + encodeURIComponent(id),
      KEY, { status: 'declined', declined_at: new Date().toISOString() });
    if (!updRes2.ok) return html(500, errorPage('Something went wrong updating this request — please use the CRM instead.'));
  }

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
    + '<title>Sale Item Request</title><style>'
    + 'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#08080f;color:#f4f4fa;margin:0;padding:40px 20px;}'
    + '.card{max-width:460px;margin:0 auto;background:#13131f;border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:28px;}'
    + 'h1{font-size:1.3rem;margin:0 0 14px;}'
    + '.row{font-size:.9rem;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.08);}'
    + '.row b{color:#9a9ab4;font-weight:600;}'
    + 'ul{margin:6px 0;padding-left:18px;font-size:.9rem;}'
    + '.btn{display:inline-block;padding:11px 20px;border-radius:10px;font-weight:700;font-size:.9rem;border:none;cursor:pointer;text-decoration:none;font-family:inherit;}'
    + '.btn-approve{background:#22c55e;color:#08080f;} .btn-decline{background:#ff5a5a;color:#fff;}'
    + '</style></head><body><div class="card">' + inner + '</div></body></html>';
}

function confirmPage(order, action, id, token) {
  var itemLines = order.items.map(function(i){
    return '<li>' + i.qty + ' × ' + esc(i.title) + ' — $' + (i.qty * i.unit_price).toFixed(2) + '</li>';
  }).join('');
  var label = action === 'approve' ? 'Approve' : 'Decline';
  var color = action === 'approve' ? 'btn-approve' : 'btn-decline';
  return pageWrap(
    '<h1>' + label + ' this request?</h1>'
    + '<div class="row"><b>From:</b> ' + esc(order.requestor_name) + ' (' + esc(order.requestor_email) + ')</div>'
    + (order.student_name ? '<div class="row"><b>Student:</b> ' + esc(order.student_name) + '</div>' : '')
    + '<div class="row"><b>Items:</b><ul>' + itemLines + '</ul></div>'
    + '<div class="row"><b>Total:</b> $' + Number(order.total).toFixed(2) + '</div>'
    + (action === 'approve' ? '<p style="font-size:.85rem;color:#9a9ab4;margin-top:14px;">Approving will send the requestor an email with the Venmo link for this total.</p>' : '')
    + '<form method="POST" action="/.netlify/functions/sale-action" style="margin-top:18px;">'
    + '<input type="hidden" name="id" value="' + esc(id) + '">'
    + '<input type="hidden" name="token" value="' + esc(token) + '">'
    + '<input type="hidden" name="action" value="' + esc(action) + '">'
    + '<button class="btn ' + color + '" type="submit">Yes, ' + label + ' This Request</button>'
    + '</form>'
  );
}

function successPage(action) {
  var msg = action === 'approve' ? '✅ Approved!' : '❌ Declined';
  var sub = action === 'approve' ? 'The requestor will get an email shortly with the Venmo link and amount owed.' : 'The requestor has not been notified — the item is available again.';
  return pageWrap('<h1>' + msg + '</h1><p style="color:#9a9ab4;">' + sub + '</p>');
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
