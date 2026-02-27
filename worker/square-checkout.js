export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
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

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowed = ['https://objectlesson.la', 'https://www.objectlesson.la', 'https://elikagan.github.io'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
  });
}

async function handleCheckout(request, env) {
  try {
    const { title, price, itemId, discountCode } = await request.json();

    // Input validation
    if (typeof price !== 'number' || price <= 0 || price > 100000) {
      return jsonResponse({ error: 'Invalid price' }, 400, request);
    }
    if (typeof itemId !== 'string' || !/^\d{1,8}$/.test(itemId)) {
      return jsonResponse({ error: 'Invalid item ID' }, 400, request);
    }
    if (typeof title !== 'string' || title.length < 1 || title.length > 200) {
      return jsonResponse({ error: 'Invalid title' }, 400, request);
    }

    let amountCents = Math.round(price * 100);
    let discountApplied = null;

    // Validate and apply discount code
    if (discountCode && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        const dcRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/discount_codes?code=eq.${encodeURIComponent(discountCode.toUpperCase())}&is_active=eq.true&select=code,type,value,max_uses,used_count,id`,
          {
            headers: {
              'apikey': env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
            }
          }
        );
        const dcData = await dcRes.json();

        if (dcData.length > 0) {
          const dc = dcData[0];
          if (!dc.max_uses || dc.used_count < dc.max_uses) {
            discountApplied = dc;
          }
        }
      } catch (e) {
        console.error('Discount validation failed:', e.message);
      }
    }

    // Build order
    const orderBody = {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: [{
        name: title,
        quantity: '1',
        base_price_money: { amount: amountCents, currency: 'USD' }
      }],
      taxes: [{
        uid: 'ca-sales-tax',
        name: 'CA Sales Tax',
        percentage: '10.25',
        scope: 'ORDER'
      }]
    };

    // Add discount to order if validated
    if (discountApplied) {
      if (discountApplied.type === 'percent') {
        orderBody.discounts = [{
          uid: 'promo',
          name: `Discount (${discountApplied.code})`,
          percentage: String(discountApplied.value),
          scope: 'ORDER'
        }];
      } else {
        const discountCents = Math.round(Number(discountApplied.value) * 100);
        orderBody.discounts = [{
          uid: 'promo',
          name: `Discount (${discountApplied.code})`,
          amount_money: { amount: discountCents, currency: 'USD' },
          scope: 'ORDER'
        }];
      }
    }

    const res = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Square-Version': '2024-12-18',
        'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: orderBody,
        checkout_options: {
          redirect_url: `https://objectlesson.la/?purchased=1#${itemId}`,
          ask_for_shipping_address: true
        },
        payment_note: `Object Lesson | ${title} (${itemId})`
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Square error:', JSON.stringify(data.errors));
      return jsonResponse({ error: data.errors?.[0]?.detail || 'Checkout failed' }, 500, request);
    }

    // Validate checkout URL
    const checkoutUrl = data.payment_link?.url || '';
    if (!checkoutUrl.startsWith('https://square.link/') && !checkoutUrl.startsWith('https://checkout.square.site/')) {
      console.error('Unexpected checkout URL:', checkoutUrl);
      return jsonResponse({ error: 'Checkout failed' }, 500, request);
    }

    // Increment discount used_count
    if (discountApplied && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/discount_codes?id=eq.${discountApplied.id}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ used_count: discountApplied.used_count + 1 })
          }
        );
      } catch (e) {
        console.error('Discount count update failed:', e.message);
      }
    }

    return jsonResponse({ url: checkoutUrl }, 200, request);
  } catch (err) {
    console.error('Checkout error:', err.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

async function handleWebhook(request, env) {
  try {
    const body = await request.text();

    // Validate webhook signature if key is configured
    const signature = request.headers.get('x-square-hmacsha256-signature');
    if (env.SQUARE_WEBHOOK_SIGNATURE_KEY && signature) {
      try {
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
          console.warn('Webhook signature mismatch — URL:', request.url);
        }
      } catch (e) {
        console.warn('Signature validation error:', e.message);
      }
    }

    const event = JSON.parse(body);
    console.log('Webhook event:', event.type);

    if (event.type === 'payment.updated') {
      const payment = event.data?.object?.payment;
      console.log('Payment status:', payment?.status, 'Note:', payment?.note);
      if (payment?.status === 'COMPLETED') {
        const note = payment.note || '';
        const amount = (payment.amount_money?.amount || 0) / 100;

        // Try to extract item info from our payment note
        let itemId = null;
        let itemInfo = '';
        if (note.startsWith('Object Lesson |')) {
          itemInfo = note.replace('Object Lesson | ', '');
          const idMatch = note.match(/\(([^)]+)\)$/);
          itemId = idMatch ? idMatch[1] : null;
        }

        // Auto-mark as sold if we can identify the item
        if (itemId && env.GITHUB_TOKEN) {
          try {
            await markAsSold(env, itemId);
            console.log('Marked sold:', itemId);
          } catch (e) {
            console.error('markAsSold failed:', e.message);
          }
        }

        // Capture buyer email from Square payment
        const buyerEmail = payment.buyer_email_address;
        if (buyerEmail && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          try {
            await fetch(`${env.SUPABASE_URL}/rest/v1/emails`, {
              method: 'POST',
              headers: {
                'apikey': env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({
                email: buyerEmail,
                source: 'purchase'
              })
            });
            console.log('Captured buyer email:', buyerEmail);
          } catch (e) {
            console.error('Email capture failed:', e.message);
          }
        }

        // Always send SMS for completed payments
        const smsMsg = itemInfo
          ? `Sale: ${itemInfo} — $${amount.toLocaleString()}. Check Square for details.`
          : `New sale: $${amount.toLocaleString()}. Check Square for details.`;
        try {
          await sendSMS(env, smsMsg);
        } catch (e) {
          console.error('sendSMS failed:', e.message);
        }
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
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER || !env.ALERT_PHONE_NUMBER) {
    console.error('SMS: Missing Twilio env vars', {
      hasSid: !!env.TWILIO_ACCOUNT_SID,
      hasToken: !!env.TWILIO_AUTH_TOKEN,
      hasFrom: !!env.TWILIO_FROM_NUMBER,
      hasTo: !!env.ALERT_PHONE_NUMBER
    });
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  const res = await fetch(url, {
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

  const data = await res.json();
  if (!res.ok) {
    console.error('SMS failed:', res.status, JSON.stringify(data));
    throw new Error(`Twilio error ${res.status}: ${data.message || JSON.stringify(data)}`);
  }
  console.log('SMS sent:', data.sid);
}
