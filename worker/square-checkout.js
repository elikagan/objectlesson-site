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

    if (url.pathname === '/marketplace-test' && request.method === 'POST') {
      return handleMarketplaceTest(request, env);
    }

    if (url.pathname === '/marketplace-health' && request.method === 'POST') {
      return handleMarketplaceHealth(request, env);
    }

    if (url.pathname === '/marketplace-delete' && request.method === 'POST') {
      return handleMarketplaceDelete(request, env);
    }

    if (url.pathname === '/marketplace-edit' && request.method === 'POST') {
      return handleMarketplaceEdit(request, env);
    }

    if (url.pathname === '/marketplace-listings' && request.method === 'POST') {
      return handleMarketplaceListings(request, env);
    }

    if (url.pathname === '/sales' && request.method === 'POST') {
      return handleSales(request, env);
    }

    if (url.pathname === '/sales-backfill' && request.method === 'POST') {
      return handleSalesBackfill(request, env);
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

        // Record sale in Supabase sales table
        if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
          try {
            const saleRecord = {
              type: isGiftCert ? 'gift_certificate' : 'item',
              amount,
              customer_email: buyerEmail || null,
              item_id: itemId || null,
              item_title: isGiftCert ? `Gift Certificate - $${amount}` : (itemInfo || null),
              gift_code: isGiftCert ? itemId : null,
              square_payment_id: payment.id || null,
              note: note || null
            };
            await fetch(`${env.SUPABASE_URL}/rest/v1/sales`, {
              method: 'POST',
              headers: {
                'apikey': env.SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal,resolution=ignore-duplicates'
              },
              body: JSON.stringify(saleRecord)
            });
            console.log('🚨 STEP 7: Sale recorded ✓', saleRecord.type, '$' + amount);
          } catch (e) {
            console.error('🚨🚨🚨 STEP 7 FAILED: Sale record error:', e.message);
          }
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

    // Delete LP listing if one exists (remove from Marketplace)
    if (item.lpListingId && env.LAZYPOSTER_TOKEN) {
      try {
        await lpFetch(env, 'POST', `/deleteListing/${item.lpListingId}`);
        console.log(`[Marketplace] Deleted LP listing ${item.lpListingId} for sold item ${itemId}`);
      } catch (e) {
        console.warn(`[Marketplace] Failed to delete LP listing for ${itemId}:`, e.message);
      }
    }

    item.isSold = true;
    item.isNew = false;
    item.isHold = false;
    item.lpListingId = null; // Clear LP reference

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

// ═══════════════════════════════════════════════════════════════════════
// LAZY POSTER API — FB MARKETPLACE INTEGRATION
//
// Base URL: https://us-central1-lazyposter.cloudfunctions.net
// Auth: x-access-token header (JWT from env.LAZYPOSTER_TOKEN)
//
// CONFIRMED ENDPOINTS (probed 2026-03-20):
//   POST /addListing           body: {listing:{...}}      → {listing + id}
//   GET  /getListings          no params                  → [{listing}, ...]
//   GET  /getListing/{id}      path param                 → {listing}
//   POST /editListing/{id}     body: {listing:{...all}}   → {listing}
//   POST /deleteListing/{id}   path param                 → {message, id}
//   POST /uploadImage          body: {image:"data:..."}   → {url}
//   GET  /getUser              no params                  → {user profile}
//
// IMPORTANT: editListing requires ALL listing fields, not just changed ones
// IMPORTANT: ID is a URL path parameter, not in query string or body
// IMPORTANT: getListings returns gzip — use Accept-Encoding or --compressed
//
// LISTING FIELDS (all required for add/edit):
//   type: 'item'
//   platform: ['facebook']
//   title: string (max 150 chars for FB)
//   price: number (integer, > 0)
//   description: string
//   category: string ('Home & Garden', 'Furniture', 'Miscellaneous', etc.)
//   condition: number (0=New, 1=Used Like New, 2=Used Good, 3=Used Fair)
//   location: string ('Pasadena, CA')
//   deliveryMethod: string ('Local pickup only')
//   images: string[] (URLs from uploadImage, at least 1 required)
//
// WORKER ROUTES:
//   POST /lazyposter-sync       Create or update LP listing for items
//   POST /marketplace-delete    Delete LP listing by ID
//   POST /marketplace-edit      Edit LP listing (requires all fields)
//   POST /marketplace-listings  Get all LP listings for comparison
//   POST /marketplace-health    Quick health check (auth + subscription)
//   POST /marketplace-test      Full integration test (CRUD cycle)
//
// STATE MACHINE:
//   ┌─────────┐  save (eligible)   ┌──────────┐  desktop app   ┌────────┐
//   │ No LP   │ ────────────────→  │ Queued   │ ────────────→  │ Live   │
//   │ listing │                    │ in LP    │                │ on FB  │
//   └─────────┘                    └──────────┘                └────────┘
//        ↑                              │                          │
//        │    sold/hold/delete/         │   sold/hold/delete/     │
//        │    marketplace off           │   marketplace off       │
//        │         ┌────────────────────┘         │               │
//        │         ↓                              ↓               │
//        │    deleteListing/{id}            deleteListing/{id}    │
//        │         │                              │               │
//        └─────────┘                              └───────────────┘
//
//   Off hold (re-eligible): creates new listing → new lpListingId
// ═══════════════════════════════════════════════════════════════════════

const LP_API = 'https://us-central1-lazyposter.cloudfunctions.net';

// Helper: LP API call with auth + error context
async function lpFetch(env, method, path, body = null) {
  const opts = {
    method,
    headers: { 'x-access-token': env.LAZYPOSTER_TOKEN }
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`${LP_API}${path}`, opts);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: resp.ok, status: resp.status, data };
}

// Helper: Upload images from GitHub URLs to LP, returns LP-hosted URLs
async function uploadImagesToLP(env, imageUrls) {
  const uploaded = [];
  for (const imgUrl of imageUrls.slice(0, 10)) {
    try {
      const imgResp = await fetch(imgUrl);
      if (!imgResp.ok) continue;
      const imgBuf = await imgResp.arrayBuffer();
      const bytes = new Uint8Array(imgBuf);
      // Process in chunks to avoid stack overflow on large images
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      const mimeType = imgResp.headers.get('content-type') || 'image/jpeg';
      const result = await lpFetch(env, 'POST', '/uploadImage', {
        image: `data:${mimeType};base64,${base64}`
      });
      if (result.ok && result.data?.url) {
        uploaded.push(result.data.url);
      }
    } catch {
      // Skip failed image uploads — continue with remaining
    }
  }
  return uploaded;
}

// Helper: Build LP listing object from item data
function buildLPListing(item) {
  return {
    type: 'item',
    platform: ['facebook'],
    title: (item.title || 'Untitled').slice(0, 150),
    price: Math.round(item.price) || 1,
    description: item.description || '',
    category: item.category || 'Home & Garden',
    condition: typeof item.condition === 'number' ? item.condition : 2,
    location: 'Pasadena, CA',
    deliveryMethod: 'Local pickup only',
    images: item.images || []
  };
}

// ── POST /lazyposter-sync ──
// Creates or updates LP listings. If item has lpListingId, edits existing.
// Returns: { results: [{ itemId, status, lpId, error, images }] }
async function handleLazyposterSync(request, env) {
  try {
    if (!env.LAZYPOSTER_TOKEN) {
      return jsonResponse({ error: 'Lazy Poster not configured — LAZYPOSTER_TOKEN secret not set' }, 500, request);
    }

    const { items } = await request.json();
    if (!items || !Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: 'items array required' }, 400, request);
    }

    const results = [];

    for (const item of items) {
      try {
        // Validate required fields
        if (!item.title || item.title.trim() === '') {
          results.push({ itemId: item.id, status: 'error', error: 'Title is required' });
          continue;
        }
        if (!item.price || item.price <= 0) {
          results.push({ itemId: item.id, status: 'error', error: 'Price must be > 0' });
          continue;
        }

        // Upload images from GitHub URLs to LP
        const imageUrls = await uploadImagesToLP(env, item.imageUrls || []);

        if (imageUrls.length === 0) {
          results.push({ itemId: item.id, status: 'error', error: 'No images uploaded — at least 1 image required' });
          continue;
        }

        const listing = buildLPListing({ ...item, images: imageUrls });

        // If item already has an LP listing, try to edit it
        if (item.lpListingId) {
          const editResult = await lpFetch(env, 'POST', `/editListing/${item.lpListingId}`, { listing });

          if (editResult.ok) {
            results.push({
              itemId: item.id,
              status: 'ok',
              action: 'edited',
              lpId: item.lpListingId,
              images: imageUrls.length
            });
            continue;
          }

          // Edit failed — listing may have been deleted from LP
          // If 404 or similar, fall through to create new listing
          if (editResult.status !== 400 && editResult.status !== 404) {
            results.push({
              itemId: item.id,
              status: 'error',
              action: 'edit_failed',
              error: `LP edit failed (${editResult.status}): ${JSON.stringify(editResult.data)}`
            });
            continue;
          }
          // Fall through: stale lpListingId, create new listing below
        }

        // Create new listing
        const addResult = await lpFetch(env, 'POST', '/addListing', { listing });

        if (addResult.ok && addResult.data?.id) {
          results.push({
            itemId: item.id,
            status: 'ok',
            action: item.lpListingId ? 'recreated' : 'created',
            lpId: addResult.data.id,
            images: imageUrls.length
          });
        } else {
          results.push({
            itemId: item.id,
            status: 'error',
            action: 'create_failed',
            error: `LP add failed (${addResult.status}): ${JSON.stringify(addResult.data)}`
          });
        }
      } catch (e) {
        results.push({ itemId: item.id, status: 'error', error: e.message });
      }
    }

    return jsonResponse({ results }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ── POST /marketplace-delete ──
// Deletes one or more LP listings by ID.
// Body: { lpListingIds: ['abc123', ...] }
// Returns: { results: [{ lpId, status, error }] }
async function handleMarketplaceDelete(request, env) {
  try {
    if (!env.LAZYPOSTER_TOKEN) {
      return jsonResponse({ error: 'Lazy Poster not configured' }, 500, request);
    }

    const { lpListingIds } = await request.json();
    if (!lpListingIds || !Array.isArray(lpListingIds) || lpListingIds.length === 0) {
      return jsonResponse({ error: 'lpListingIds array required' }, 400, request);
    }

    const results = [];
    for (const lpId of lpListingIds) {
      try {
        const result = await lpFetch(env, 'POST', `/deleteListing/${lpId}`);
        // 404 = already deleted = success from our perspective
        const ok = result.ok || result.status === 404;
        results.push({
          lpId,
          status: ok ? 'ok' : 'error',
          error: ok ? null : `LP delete failed (${result.status}): ${JSON.stringify(result.data)}`
        });
      } catch (e) {
        results.push({ lpId, status: 'error', error: e.message });
      }
    }

    return jsonResponse({ results }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ── POST /marketplace-edit ──
// Edits an existing LP listing. Requires ALL listing fields.
// Body: { lpListingId: 'abc123', listing: {...all fields} }
// Returns: { status, lpId, error }
async function handleMarketplaceEdit(request, env) {
  try {
    if (!env.LAZYPOSTER_TOKEN) {
      return jsonResponse({ error: 'Lazy Poster not configured' }, 500, request);
    }

    const { lpListingId, listing } = await request.json();
    if (!lpListingId || !listing) {
      return jsonResponse({ error: 'lpListingId and listing required' }, 400, request);
    }

    const result = await lpFetch(env, 'POST', `/editListing/${lpListingId}`, { listing });
    return jsonResponse({
      status: result.ok ? 'ok' : 'error',
      lpId: lpListingId,
      error: result.ok ? null : `LP edit failed (${result.status}): ${JSON.stringify(result.data)}`
    }, result.ok ? 200 : 502, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ── POST /marketplace-listings ──
// Returns all LP listings for comparison with inventory.
// Body: {} (empty or omit)
// Returns: { listings: [...], count: N }
async function handleMarketplaceListings(request, env) {
  try {
    if (!env.LAZYPOSTER_TOKEN) {
      return jsonResponse({ error: 'Lazy Poster not configured' }, 500, request);
    }

    const result = await lpFetch(env, 'GET', '/getListings');
    if (!result.ok) {
      return jsonResponse({
        error: `LP getListings failed (${result.status}): ${JSON.stringify(result.data)}`
      }, 502, request);
    }

    const listings = Array.isArray(result.data) ? result.data : [];
    return jsonResponse({ listings, count: listings.length }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

// ── POST /marketplace-health ──
// Quick health check: auth valid? subscription active? queue status?
// Returns: { status, auth, subscription, queueCount, staleCount, errors }
async function handleMarketplaceHealth(request, env) {
  try {
    if (!env.LAZYPOSTER_TOKEN) {
      return jsonResponse({
        status: 'error',
        errors: ['LAZYPOSTER_TOKEN not configured'],
        auth: false, subscription: null, queueCount: 0, staleCount: 0
      }, 200, request);
    }

    const errors = [];
    let auth = false;
    let subscription = null;
    let queueCount = 0;
    let staleCount = 0;

    // Check auth + subscription
    const userResult = await lpFetch(env, 'GET', '/getUser');
    if (userResult.ok) {
      auth = true;
      const u = userResult.data;
      subscription = {
        active: !!u.subscription_active,
        expires: u.expire_time || null,
        type: u.subscription_type || null
      };
      if (!u.subscription_active) {
        errors.push('Lazy Poster subscription is inactive — renew at thelazyposter.com');
      }
      // Check if subscription expires within 7 days
      if (u.expire_time) {
        const exp = new Date(u.expire_time);
        const daysLeft = (exp - Date.now()) / (1000 * 60 * 60 * 24);
        if (daysLeft < 7 && daysLeft > 0) {
          errors.push(`Lazy Poster subscription expires in ${Math.ceil(daysLeft)} days`);
        } else if (daysLeft <= 0) {
          errors.push('Lazy Poster subscription has expired');
        }
      }
    } else if (userResult.status === 401) {
      errors.push('Lazy Poster auth token expired — run /Applications/login-facebook to re-authenticate');
    } else {
      errors.push(`Lazy Poster API unreachable (${userResult.status})`);
    }

    // Check queue for stale listings
    if (auth) {
      const listResult = await lpFetch(env, 'GET', '/getListings');
      if (listResult.ok && Array.isArray(listResult.data)) {
        queueCount = listResult.data.length;
        // LP doesn't provide timestamps, so we can't detect staleness here
        // The admin tracks this via its own sync log
      }
    }

    return jsonResponse({
      status: errors.length === 0 ? 'ok' : 'warning',
      auth,
      subscription,
      queueCount,
      staleCount,
      errors
    }, 200, request);
  } catch (e) {
    return jsonResponse({
      status: 'error',
      errors: [e.message],
      auth: false, subscription: null, queueCount: 0, staleCount: 0
    }, 200, request);
  }
}

// ── POST /marketplace-test ──
// Full integration test: creates a test listing, verifies CRUD, cleans up.
// Returns: { passed, failed, results: [{ test, status, ms, detail }] }
async function handleMarketplaceTest(request, env) {
  const results = [];
  let testLpId = null;

  async function runTest(name, fn) {
    const start = Date.now();
    try {
      const detail = await fn();
      results.push({ test: name, status: 'pass', ms: Date.now() - start, detail: detail || null });
      return true;
    } catch (e) {
      results.push({ test: name, status: 'fail', ms: Date.now() - start, detail: e.message });
      return false;
    }
  }

  // 1. Auth check
  await runTest('auth', async () => {
    if (!env.LAZYPOSTER_TOKEN) throw new Error('LAZYPOSTER_TOKEN not configured');
    const r = await lpFetch(env, 'GET', '/getUser');
    if (!r.ok) throw new Error(`Auth failed (${r.status})`);
    return `Authenticated as ${r.data.email}, subscription ${r.data.subscription_active ? 'active' : 'INACTIVE'}`;
  });

  // 2. Image upload
  let testImageUrl = null;
  await runTest('uploadImage', async () => {
    // 1x1 transparent PNG
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const r = await lpFetch(env, 'POST', '/uploadImage', { image: pixel });
    if (!r.ok) throw new Error(`Upload failed (${r.status}): ${JSON.stringify(r.data)}`);
    if (!r.data?.url) throw new Error('No URL returned');
    testImageUrl = r.data.url;
    return `Uploaded → ${testImageUrl}`;
  });

  // 3. Create listing
  await runTest('addListing', async () => {
    if (!testImageUrl) throw new Error('Skipped — image upload failed');
    const listing = buildLPListing({
      title: 'OL_SYSTEM_TEST_' + Date.now(),
      price: 1,
      description: 'Automated test listing — will be deleted immediately',
      category: 'Home & Garden',
      condition: 2,
      images: [testImageUrl]
    });
    const r = await lpFetch(env, 'POST', '/addListing', { listing });
    if (!r.ok) throw new Error(`Add failed (${r.status}): ${JSON.stringify(r.data)}`);
    if (!r.data?.id) throw new Error('No listing ID returned');
    testLpId = r.data.id;
    return `Created listing ${testLpId}`;
  });

  // 4. Get all listings
  await runTest('getListings', async () => {
    const r = await lpFetch(env, 'GET', '/getListings');
    if (!r.ok) throw new Error(`Failed (${r.status})`);
    if (!Array.isArray(r.data)) throw new Error('Response is not an array');
    const found = testLpId ? r.data.some(l => l.id === testLpId) : true;
    if (!found) throw new Error('Test listing not found in results');
    return `${r.data.length} listings total, test listing found`;
  });

  // 5. Get single listing
  await runTest('getListing', async () => {
    if (!testLpId) throw new Error('Skipped — no test listing');
    const r = await lpFetch(env, 'GET', `/getListing/${testLpId}`);
    if (!r.ok) throw new Error(`Failed (${r.status}): ${JSON.stringify(r.data)}`);
    return `Retrieved listing ${testLpId}`;
  });

  // 6. Edit listing
  await runTest('editListing', async () => {
    if (!testLpId || !testImageUrl) throw new Error('Skipped — no test listing');
    const listing = buildLPListing({
      title: 'OL_SYSTEM_TEST_EDITED',
      price: 2,
      description: 'Edited by test',
      category: 'Home & Garden',
      condition: 2,
      images: [testImageUrl]
    });
    const r = await lpFetch(env, 'POST', `/editListing/${testLpId}`, { listing });
    if (!r.ok) throw new Error(`Edit failed (${r.status}): ${JSON.stringify(r.data)}`);
    return `Edited listing ${testLpId}`;
  });

  // 7. Verify edit
  await runTest('verifyEdit', async () => {
    if (!testLpId) throw new Error('Skipped — no test listing');
    const r = await lpFetch(env, 'GET', `/getListing/${testLpId}`);
    if (!r.ok) throw new Error(`Failed (${r.status})`);
    if (r.data?.title !== 'OL_SYSTEM_TEST_EDITED') {
      throw new Error(`Title not updated: got "${r.data?.title}"`);
    }
    return 'Edit verified — title updated correctly';
  });

  // 8. Delete listing
  await runTest('deleteListing', async () => {
    if (!testLpId) throw new Error('Skipped — no test listing');
    const r = await lpFetch(env, 'POST', `/deleteListing/${testLpId}`);
    if (!r.ok) throw new Error(`Delete failed (${r.status}): ${JSON.stringify(r.data)}`);
    return `Deleted listing ${testLpId}`;
  });

  // 9. Verify delete
  await runTest('verifyDelete', async () => {
    if (!testLpId) throw new Error('Skipped — no test listing');
    const r = await lpFetch(env, 'GET', '/getListings');
    if (!r.ok) throw new Error(`Failed (${r.status})`);
    const found = Array.isArray(r.data) && r.data.some(l => l.id === testLpId);
    if (found) throw new Error('Test listing still exists after delete');
    return 'Delete verified — listing gone';
  });

  // Cleanup: if test listing wasn't deleted (e.g. delete test was skipped), try cleanup
  if (testLpId && !results.find(r => r.test === 'deleteListing' && r.status === 'pass')) {
    try { await lpFetch(env, 'POST', `/deleteListing/${testLpId}`); } catch {}
  }

  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;

  return jsonResponse({ passed, failed, total: results.length, results }, 200, request);
}

// ─── Sales ─────────────────────────────────────────────────────────

async function handleSales(request, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase not configured' }, 500, request);
  }
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sales?select=*&order=created_at.desc&limit=500`,
      {
        headers: {
          'apikey': env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
        }
      }
    );
    const sales = await res.json();
    return jsonResponse({ sales, count: sales.length }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}

async function handleSalesBackfill(request, env) {
  // Query Square Payments API for all completed payments and insert into Supabase sales table
  if (!env.SQUARE_ACCESS_TOKEN) {
    return jsonResponse({ error: 'Square not configured' }, 500, request);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return jsonResponse({ error: 'Supabase not configured' }, 500, request);
  }

  try {
    const payments = [];
    let cursor = null;

    // Fetch Square payments (up to 3 pages to stay under Worker subrequest limit)
    let pages = 0;
    do {
      const params = new URLSearchParams({
        sort_order: 'DESC',
        limit: '100'
      });
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(
        `https://connect.squareup.com/v2/payments?${params}`,
        {
          headers: {
            'Square-Version': '2024-12-18',
            'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`
          }
        }
      );
      const data = await res.json();
      if (!res.ok) {
        return jsonResponse({ error: data.errors?.[0]?.detail || 'Square API error' }, 500, request);
      }
      if (data.payments) payments.push(...data.payments);
      cursor = data.cursor || null;
      pages++;
    } while (cursor && pages < 3);

    // Filter to completed payments only
    const completed = payments.filter(p => p.status === 'COMPLETED');

    // Build sale records
    const records = completed.map(p => {
      const note = p.note || '';
      const amount = (p.amount_money?.amount || 0) / 100;
      const isGiftCert = note.includes('Gift Certificate');

      let itemId = null;
      let itemInfo = '';
      if (note.startsWith('Object Lesson |')) {
        itemInfo = note.replace('Object Lesson | ', '');
        const idMatch = note.match(/\(([^)]+)\)$/);
        itemId = idMatch ? idMatch[1] : null;
      }

      return {
        type: isGiftCert ? 'gift_certificate' : 'item',
        amount,
        customer_email: p.buyer_email_address || null,
        item_id: itemId || null,
        item_title: isGiftCert ? `Gift Certificate - $${amount}` : (itemInfo || note || null),
        gift_code: isGiftCert ? itemId : null,
        square_payment_id: p.id,
        note: note || null,
        created_at: p.created_at
      };
    });

    // Batch upsert into Supabase in chunks of 20
    let inserted = 0;
    const chunkSize = 20;
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      try {
        const res = await fetch(`${env.SUPABASE_URL}/rest/v1/sales`, {
          method: 'POST',
          headers: {
            'apikey': env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal,resolution=ignore-duplicates'
          },
          body: JSON.stringify(chunk)
        });
        if (res.ok) inserted += chunk.length;
        else {
          const err = await res.text();
          console.error(`Batch ${i}-${i+chunkSize} failed:`, res.status, err);
        }
      } catch (e) {
        console.error(`Batch ${i}-${i+chunkSize} error:`, e.message);
      }
    }

    return jsonResponse({
      total_payments: payments.length,
      completed: completed.length,
      inserted,
      records: records.length
    }, 200, request);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500, request);
  }
}
