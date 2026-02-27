export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/checkout' && request.method === 'POST') {
      return handleCheckout(request, env);
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    return new Response('Not found', { status: 404 });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

async function handleCheckout(request, env) {
  try {
    const { title, price, itemId } = await request.json();
    const amountCents = Math.round(price * 100);

    const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-12-18',
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        quick_pay: {
          name: title,
          price_money: { amount: amountCents, currency: 'USD' },
          location_id: env.SQUARE_LOCATION_ID
        },
        checkout_options: {
          redirect_url: `https://objectlesson.la/#${itemId}`,
          ask_for_shipping_address: true
        },
        payment_note: `Object Lesson | ${title} (${itemId})`
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return jsonResponse({ error: data.errors?.[0]?.detail || 'Checkout failed' }, 500);
    }

    return jsonResponse({ url: data.payment_link.url });
  } catch (err) {
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleWebhook(request, env) {
  try {
    const body = await request.text();

    // Validate Square webhook signature
    if (env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
      const signature = request.headers.get('x-square-hmacsha256-signature');
      if (!signature) return new Response('Missing signature', { status: 401 });

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );

      const signPayload = request.url + body;
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signPayload));
      const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

      if (expected !== signature) {
        return new Response('Invalid signature', { status: 401 });
      }
    }

    const event = JSON.parse(body);

    if (event.type === 'payment.updated') {
      const payment = event.data?.object?.payment;
      if (payment?.status === 'COMPLETED' && payment.note?.startsWith('Object Lesson |')) {
        const amount = (payment.amount_money?.amount || 0) / 100;
        const itemInfo = payment.note.replace('Object Lesson | ', '');

        // Extract item ID from note format: "Object Lesson | Title (itemId)"
        const idMatch = payment.note.match(/\(([^)]+)\)$/);
        const itemId = idMatch ? idMatch[1] : null;

        // Auto-mark as sold in inventory
        if (itemId && env.GITHUB_TOKEN) {
          await markAsSold(env, itemId);
        }

        await sendSMS(env, `Sale: ${itemInfo} — $${amount.toLocaleString()}. Check Square for details.`);
      }
    }

    return new Response('OK', { status: 200 });
  } catch {
    return new Response('Error', { status: 500 });
  }
}

async function markAsSold(env, itemId) {
  const owner = 'elikagan';
  const repo = 'objectlesson-site';
  const path = 'inventory.json';
  const ghApi = 'https://api.github.com';

  try {
    // Fetch current inventory
    const fileRes = await fetch(`${ghApi}/repos/${owner}/${repo}/contents/${path}?ref=main`, {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ol-checkout-worker'
      }
    });
    if (!fileRes.ok) return;

    const fileData = await fileRes.json();
    const content = atob(fileData.content.replace(/\n/g, ''));
    const items = JSON.parse(content);

    // Find and mark item as sold
    const item = items.find(i => i.id === itemId);
    if (!item || item.isSold) return;

    item.isSold = true;
    item.isNew = false;
    item.isHold = false;

    // Commit updated inventory
    const updated = JSON.stringify(items, null, 2);
    const encoded = btoa(unescape(encodeURIComponent(updated)));

    await fetch(`${ghApi}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'ol-checkout-worker'
      },
      body: JSON.stringify({
        message: `Mark ${item.title || itemId} as sold`,
        content: encoded,
        sha: fileData.sha,
        branch: 'main'
      })
    });
  } catch {
    // Don't fail the webhook if GitHub update fails
  }
}

async function sendSMS(env, message) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      To: env.ALERT_PHONE_NUMBER,
      From: env.TWILIO_FROM_NUMBER,
      Body: message
    }).toString()
  });
}
