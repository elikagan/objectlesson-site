export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === '/checkout' && request.method === 'POST') {
      return handleCheckout(request, env);
    }

    if (url.pathname === '/gift-checkout' && request.method === 'POST') {
      return handleGiftCheckout(request, env);
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      return handleWebhook(request, env);
    }

    if (url.pathname === '/removebg' && request.method === 'POST') {
      return handleRemoveBg(request, env);
    }

    if (url.pathname === '/send-gift-email' && request.method === 'POST') {
      return handleSendGiftEmail(request, env);
    }

    if (url.pathname === '/lazyposter-sync' && request.method === 'POST') {
      return handleLazyposterSync(request, env);
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

async function handleGiftCheckout(request, env) {
  try {
    const { amount, email, purchaserName, recipientName } = await request.json();

    if (typeof amount !== 'number' || amount <= 0 || amount > 10000) {
      return jsonResponse({ error: 'Invalid amount' }, 400, request);
    }
    if (!email || typeof email !== 'string') {
      return jsonResponse({ error: 'Email required' }, 400, request);
    }

    // Generate GIFT-XXXX-XXXX code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'GIFT-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    code += '-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];

    const amountCents = Math.round(amount * 100);

    const orderBody = {
      location_id: env.SQUARE_LOCATION_ID,
      line_items: [{
        name: `Gift Certificate - $${amount}`,
        quantity: '1',
        base_price_money: { amount: amountCents, currency: 'USD' }
      }]
      // No taxes — gift certificates are not taxable
    };

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
          redirect_url: `https://objectlesson.la/gift/?purchased=1&code=${encodeURIComponent(code)}`,
          ask_for_shipping_address: false
        },
        pre_populated_data: {
          buyer_email: email
        },
        payment_note: `Object Lesson | Gift Certificate (${code})`
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Square error:', JSON.stringify(data.errors));
      return jsonResponse({ error: data.errors?.[0]?.detail || 'Checkout failed' }, 500, request);
    }

    const checkoutUrl = data.payment_link?.url || '';
    if (!checkoutUrl.startsWith('https://square.link/') && !checkoutUrl.startsWith('https://checkout.square.site/')) {
      console.error('Unexpected checkout URL:', checkoutUrl);
      return jsonResponse({ error: 'Checkout failed' }, 500, request);
    }

    // Create the gift certificate in Supabase
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      try {
        const gcBody = {
          code,
          type: 'fixed',
          value: amount,
          max_uses: 1,
          is_gift_certificate: true,
          is_active: true
        };
        gcBody.purchaser_email = email;
        if (purchaserName) gcBody.purchaser_name = purchaserName;
        if (recipientName) gcBody.recipient_name = recipientName;

        await fetch(`${env.SUPABASE_URL}/rest/v1/discount_codes`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(gcBody)
        });

        // Capture purchaser email (ignore if already exists)
        await fetch(`${env.SUPABASE_URL}/rest/v1/emails`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal,resolution=ignore-duplicates'
          },
          body: JSON.stringify({ email, source: 'gift_certificate' })
        });
      } catch (e) {
        console.error('Gift cert Supabase insert failed:', e.message);
      }
    }

    // Send confirmation email with gift certificate code
    if (env.RESEND_API_KEY) {
      try {
        const toName = recipientName || 'someone special';
        const fromName = purchaserName || '';
        const fromLine = fromName ? `<p style="color:#888;font-size:14px;">From: ${fromName}</p>` : '';
        const toLine = recipientName ? `<p style="color:#888;font-size:14px;">To: ${toName}</p>` : '';

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Object Lesson <gift@objectlesson.la>',
            to: [email],
            subject: `Your Object Lesson Gift Certificate - $${amount}`,
            html: `
              <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
                <h1 style="font-size:20px;font-weight:500;margin-bottom:24px;">Gift Certificate</h1>
                ${toLine}${fromLine}
                <p style="font-size:15px;color:#555;line-height:1.6;margin-bottom:24px;">
                  Here's your Object Lesson gift certificate. Give this code to the recipient to use at checkout.
                </p>
                <div style="text-align:center;padding:24px;border:2px solid #1a1a1a;border-radius:12px;margin-bottom:24px;">
                  <div style="font-size:14px;color:#888;margin-bottom:8px;">GIFT CERTIFICATE CODE</div>
                  <div style="font-size:28px;font-weight:600;letter-spacing:0.06em;">${code}</div>
                  <div style="font-size:16px;color:#888;margin-top:8px;">$${amount}</div>
                </div>
                <p style="font-size:14px;color:#888;line-height:1.6;">
                  This code can be used at checkout on <a href="https://objectlesson.la" style="color:#1a1a1a;">objectlesson.la</a> or in-store at Object Lesson in Pasadena. It does not expire.
                </p>
                <hr style="border:none;border-top:1px solid #ddd;margin:32px 0;">
                <p style="font-size:12px;color:#aaa;">Object Lesson — Uncommon Objects, Art and Design<br>Pasadena, CA</p>
              </div>
            `
          })
        });
      } catch (e) {
        console.error('Gift cert email failed:', e.message);
      }
    }

    return jsonResponse({ url: checkoutUrl, code }, 200, request);
  } catch (err) {
    console.error('Gift checkout error:', err.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

async function handleSendGiftEmail(request, env) {
  try {
    const { code, amount, email, purchaserName, recipientName } = await request.json();

    if (!code || !amount || !email) {
      return jsonResponse({ error: 'code, amount, and email required' }, 400, request);
    }

    if (!env.RESEND_API_KEY) {
      return jsonResponse({ error: 'Email not configured' }, 500, request);
    }

    const toName = recipientName || 'someone special';
    const fromName = purchaserName || '';
    const fromLine = fromName ? `<p style="color:#888;font-size:14px;">From: ${fromName}</p>` : '';
    const toLine = recipientName ? `<p style="color:#888;font-size:14px;">To: ${toName}</p>` : '';

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Object Lesson <gift@objectlesson.la>',
        to: [email],
        subject: `Your Object Lesson Gift Certificate - $${amount}`,
        html: `
          <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
            <h1 style="font-size:20px;font-weight:500;margin-bottom:24px;">Gift Certificate</h1>
            ${toLine}${fromLine}
            <p style="font-size:15px;color:#555;line-height:1.6;margin-bottom:24px;">
              Here's your Object Lesson gift certificate. Give this code to the recipient to use at checkout.
            </p>
            <div style="text-align:center;padding:24px;border:2px solid #1a1a1a;border-radius:12px;margin-bottom:24px;">
              <div style="font-size:14px;color:#888;margin-bottom:8px;">GIFT CERTIFICATE CODE</div>
              <div style="font-size:28px;font-weight:600;letter-spacing:0.06em;">${code}</div>
              <div style="font-size:16px;color:#888;margin-top:8px;">$${amount}</div>
            </div>
            <p style="font-size:14px;color:#888;line-height:1.6;">
              This code can be used at checkout on <a href="https://objectlesson.la" style="color:#1a1a1a;">objectlesson.la</a> or in-store at Object Lesson in Pasadena. It does not expire.
            </p>
            <hr style="border:none;border-top:1px solid #ddd;margin:32px 0;">
            <p style="font-size:12px;color:#aaa;">Object Lesson — Uncommon Objects, Art and Design<br>Pasadena, CA</p>
          </div>
        `
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error:', err);
      return jsonResponse({ error: 'Failed to send email' }, 500, request);
    }

    return jsonResponse({ success: true }, 200, request);
  } catch (err) {
    console.error('Send gift email error:', err.message);
    return jsonResponse({ error: 'Server error' }, 500, request);
  }
}

async function handleWebhook(request, env) {
  try {
    const body = await request.text();
    console.log('🚨 STEP 1: WEBHOOK HIT — received POST to /webhook');
    console.log('🚨 STEP 1: Request URL:', request.url);
    console.log('🚨 STEP 1: Body length:', body.length);

    // Validate webhook signature if key is configured
    const signature = request.headers.get('x-square-hmacsha256-signature');
    if (env.SQUARE_WEBHOOK_SIGNATURE_KEY && signature) {
      console.log('🚨 STEP 1b: Validating webhook signature...');
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
          console.error('🚨🚨🚨 STEP 1b FAILED: Webhook signature MISMATCH — URL:', request.url);
          console.error('🚨🚨🚨 Expected:', expected);
          console.error('🚨🚨🚨 Got:', signature);
        } else {
          console.log('🚨 STEP 1b: Signature valid ✓');
        }
      } catch (e) {
        console.error('🚨🚨🚨 STEP 1b FAILED: Signature validation error:', e.message);
      }
    } else {
      console.log('🚨 STEP 1b: No signature key configured or no signature header — skipping validation');
    }

    const event = JSON.parse(body);
    console.log('🚨 STEP 2: PARSED EVENT — type:', event.type);

    if (event.type === 'payment.updated') {
      console.log('🚨 STEP 3: EVENT IS payment.updated ✓');
      const payment = event.data?.object?.payment;
      console.log('🚨 STEP 3: Payment status:', payment?.status);
      console.log('🚨 STEP 3: Payment note:', payment?.note);
      console.log('🚨 STEP 3: Payment amount:', payment?.amount_money);

      if (payment?.status === 'COMPLETED') {
        console.log('🚨 STEP 4: PAYMENT IS COMPLETED ✓');
        const note = payment.note || '';
        const amount = (payment.amount_money?.amount || 0) / 100;

        // Try to extract item info from our payment note
        let itemId = null;
        let itemInfo = '';
        if (note.startsWith('Object Lesson |')) {
          itemInfo = note.replace('Object Lesson | ', '');
          const idMatch = note.match(/\(([^)]+)\)$/);
          itemId = idMatch ? idMatch[1] : null;
          console.log('🚨 STEP 4: Extracted itemId:', itemId, 'itemInfo:', itemInfo);
        } else {
          console.log('🚨 STEP 4: Note does not start with "Object Lesson |" — note was:', JSON.stringify(note));
        }

        // Auto-mark as sold if we can identify the item (skip for gift certificates)
        const isGiftCert = note.includes('Gift Certificate');
        if (itemId && env.GITHUB_TOKEN && !isGiftCert) {
          console.log('🚨 STEP 5: MARKING AS SOLD — itemId:', itemId);
          try {
            await markAsSold(env, itemId);
            console.log('🚨 STEP 5: Marked sold ✓');
          } catch (e) {
            console.error('🚨🚨🚨 STEP 5 FAILED: markAsSold error:', e.message);
          }
        } else {
          console.log('🚨 STEP 5: SKIPPING mark-as-sold —', !itemId ? 'no itemId' : 'no GITHUB_TOKEN');
        }

        // Capture buyer email from Square payment
        const buyerEmail = payment.buyer_email_address;
        if (buyerEmail && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          console.log('🚨 STEP 6: CAPTURING BUYER EMAIL:', buyerEmail);
          try {
            await fetch(`${env.SUPABASE_URL}/rest/v1/emails`, {
              method: 'POST',
              headers: {
                'apikey': env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal,resolution=ignore-duplicates'
              },
              body: JSON.stringify({
                email: buyerEmail,
                source: 'purchase',
                item_id: itemId || null
              })
            });
            console.log('🚨 STEP 6: Email captured ✓');
          } catch (e) {
            console.error('🚨🚨🚨 STEP 6 FAILED: Email capture error:', e.message);
          }
        } else {
          console.log('🚨 STEP 6: SKIPPING email capture —', !buyerEmail ? 'no buyer email on payment' : 'missing Supabase env vars');
        }

        // Sale notifications handled by Square app directly
      } else {
        console.log('🚨🚨🚨 STEP 4 STOPPED: Payment status is NOT COMPLETED — it is:', payment?.status);
      }
    } else {
      console.log('🚨🚨🚨 STEP 2 STOPPED: Event type is NOT payment.updated — it is:', event.type);
    }

    console.log('🚨 DONE: Webhook handler complete, returning 200');
    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error('🚨🚨🚨 WEBHOOK CRASHED:', e.message, e.stack);
    return new Response('Error', { status: 500 });
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function handleRemoveBg(request, env) {
  try {
    const { imageBase64, apiKey } = await request.json();
    if (!imageBase64 || !apiKey) {
      return jsonResponse({ error: 'Missing imageBase64 or apiKey' }, 400, request);
    }

    // Convert base64 to binary
    const raw = atob(imageBase64);
    const binary = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
    const blob = new Blob([binary], { type: 'image/jpeg' });

    const form = new FormData();
    form.append('image_file', blob, 'image.jpg');
    form.append('size', 'auto');
    form.append('format', 'png');

    const res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form
    });

    if (!res.ok) {
      const err = await res.text();
      return jsonResponse({ error: `remove.bg ${res.status}: ${err}` }, res.status, request);
    }

    const resultBuf = await res.arrayBuffer();
    const resultBase64 = arrayBufferToBase64(resultBuf);

    return new Response(JSON.stringify({ imageBase64: resultBase64 }), {
      status: 200,
      headers: { ...corsHeaders(request), 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
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

// --- Lazy Poster Marketplace Sync ---

const LP_API = 'https://us-central1-lazyposter.cloudfunctions.net';

async function handleLazyposterSync(request, env) {
  try {
    if (!env.LAZYPOSTER_TOKEN) {
      return jsonResponse({ error: 'Lazy Poster not configured' }, 500, request);
    }

    const { items } = await request.json();
    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: 'items array required' }, 400, request);
    }

    const results = [];

    for (const item of items) {
      try {
        // Upload images first
        const imageUrls = [];
        if (item.imageUrls && item.imageUrls.length > 0) {
          for (const imgUrl of item.imageUrls.slice(0, 10)) {
            try {
              // Fetch the image and convert to base64
              const imgResp = await fetch(imgUrl);
              if (!imgResp.ok) continue;
              const imgBuf = await imgResp.arrayBuffer();
              const base64 = btoa(String.fromCharCode(...new Uint8Array(imgBuf)));
              const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';

              const uploadResp = await fetch(`${LP_API}/uploadImage`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-access-token': env.LAZYPOSTER_TOKEN
                },
                body: JSON.stringify({ image: `data:${mimeType};base64,${base64}` })
              });

              if (uploadResp.ok) {
                const uploadData = await uploadResp.json();
                imageUrls.push(uploadData.url);
              }
            } catch {
              // Skip failed image uploads
            }
          }
        }

        // Create the listing
        const listing = {
          type: 'item',
          platform: ['facebook'],
          title: item.title || item.name || 'Untitled',
          price: Math.round(item.price) || 1,
          description: item.description || '',
          category: item.category || 'Home & Garden',
          condition: typeof item.condition === 'number' ? item.condition : 2,
          location: 'Pasadena, CA',
          deliveryMethod: 'Local pickup only',
          campaign: 'object-lesson',
          images: imageUrls
        };

        const addResp = await fetch(`${LP_API}/addListing`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': env.LAZYPOSTER_TOKEN
          },
          body: JSON.stringify({ listing })
        });

        const addData = await addResp.text();
        results.push({
          itemId: item.id,
          status: addResp.ok ? 'ok' : 'error',
          lpId: addResp.ok ? JSON.parse(addData).id : null,
          error: addResp.ok ? null : addData,
          images: imageUrls.length
        });
      } catch (e) {
        results.push({ itemId: item.id, status: 'error', error: e.message });
      }
    }

    return jsonResponse({ results }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}
