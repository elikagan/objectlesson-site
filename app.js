(function () {
  const PHONE = '3104985138';
  const EMAIL = 'eli@objectlesson.la';
  const CHECKOUT_URL = 'https://ol-checkout.objectlesson.workers.dev/checkout';

  // Detect return from Square checkout
  const urlParams = new URLSearchParams(location.search);
  let justPurchased = urlParams.get('purchased') === '1' ? location.hash.slice(1) : null;
  if (justPurchased) {
    // Clean URL but keep hash
    history.replaceState(null, '', location.pathname + location.hash);
  }

  // --- Analytics (Supabase) ---
  const SUPA_URL = 'https://gjlwoibtdgxlhtfswdkk.supabase.co';
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqbHdvaWJ0ZGd4bGh0ZnN3ZGtrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNTYzODgsImV4cCI6MjA4NzczMjM4OH0.4QSS1BBMBuqbMtLjo_Tr0_WVTS48YYNsNYvtEMTf33U';

  function getSessionId() {
    let sid = sessionStorage.getItem('ol_sid');
    if (!sid) {
      sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('ol_sid', sid);
    }
    return sid;
  }

  function getUtmSource() {
    try {
      const params = new URLSearchParams(location.search);
      return params.get('utm_source') || null;
    } catch { return null; }
  }

  const _utmSource = getUtmSource();

  function trackEvent(event, itemId) {
    if (!SUPA_URL || !SUPA_ANON) return;
    if (/bot|crawl|spider|slurp/i.test(navigator.userAgent)) return;
    const body = {
      event,
      item_id: itemId || null,
      session_id: getSessionId(),
      referrer: document.referrer || null,
      utm_source: _utmSource,
      ua_mobile: /iPhone|iPad|iPod|Android/i.test(navigator.userAgent),
      path: location.hash || '/'
    };
    fetch(`${SUPA_URL}/rest/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_ANON,
        'Authorization': 'Bearer ' + SUPA_ANON,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(body)
    }).catch(() => {});
  }

  let items = [];
  let activeCategory = 'all';
  let detailImages = [];
  let detailIndex = 0;

  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('empty');
  const loadingEl = document.getElementById('loading');
  const gridView = document.getElementById('view-grid');
  const detailView = document.getElementById('view-detail');
  const notfoundView = document.getElementById('view-notfound');
  const aboutView = document.getElementById('view-about');
  const filterBtn = document.getElementById('filter-btn');
  const filterLabel = document.getElementById('filter-label');
  const filterDropdown = document.getElementById('filter-dropdown');

  const categoryLabels = {
    'all': 'All', 'under-400': 'Under $400', 'wall-art': 'Wall Art',
    'object': 'Object', 'ceramic': 'Ceramic', 'furniture': 'Furniture',
    'light': 'Light', 'sculpture': 'Sculpture', 'misc': 'Misc'
  };

  // --- Load inventory ---

  async function load() {
    try {
      // Fetch from GitHub raw (updates instantly) with Pages fallback
      const raw = `https://raw.githubusercontent.com/elikagan/objectlesson-site/main/inventory.json?t=${Date.now()}`;
      let res = await fetch(raw);
      if (!res.ok) res = await fetch('inventory.json?t=' + Date.now());
      items = await res.json();
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
      items = [];
    }
    loadingEl.classList.add('hidden');
    initMosaic();
    renderGrid();
    handleHash();
    trackEvent('page_view');
  }

  // --- Grid render ---

  function renderGrid() {
    loadingEl.classList.add('hidden');

    let filtered;
    if (activeCategory === 'all') {
      // In "All": show everything, sold items pushed to end
      const available = items.filter(i => !i.isSold);
      const sold = items.filter(i => i.isSold);
      filtered = [...available, ...sold];
    } else if (activeCategory === 'under-400') {
      filtered = items.filter(i => !i.isSold && Number(i.price) > 0 && Number(i.price) < 400);
    } else {
      filtered = items.filter(i => !i.isSold && i.category === activeCategory);
    }

    grid.innerHTML = '';

    if (filtered.length === 0) {
      empty.classList.add('show');
      return;
    }

    empty.classList.remove('show');

    filtered.forEach((item, i) => {
      const card = document.createElement('a');
      card.className = 'card';
      card.href = '#' + item.id;
      card.style.animationDelay = (i * 0.04) + 's';

      const isSold = !!item.isSold;
      if (isSold) card.classList.add('card--sold');

      const imgSrc = imgUrl(item.heroImage || (item.images && item.images[0]) || '');
      const imgHtml = imgSrc
        ? `<img src="${imgSrc}" alt="${esc(item.title)}" loading="lazy">`
        : '';

      const newBadge = item.isNew && !isSold ? '<span class="card-new">New</span>' : '';
      const holdBadge = item.isHold && !isSold ? '<span class="card-hold">On Hold</span>' : '';
      const soldBadge = isSold ? '<span class="card-sold">Sold</span>' : '';

      card.innerHTML = `
        <div class="card-image">${imgHtml}${newBadge}${holdBadge}${soldBadge}</div>
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-price">$${Number(item.price).toLocaleString()}</div>
      `;

      grid.appendChild(card);
    });
  }

  // --- Detail view (sliding carousel) ---

  const track = document.getElementById('detail-track');

  function slideTo(index, animate) {
    detailIndex = index;
    if (animate) {
      track.classList.add('animating');
    } else {
      track.classList.remove('animating');
    }
    track.style.transform = `translateX(${-index * 100}%)`;

    // Update thumbnails
    const thumbStrip = document.getElementById('detail-thumbs');
    thumbStrip.querySelector('.active')?.classList.remove('active');
    const thumbs = thumbStrip.querySelectorAll('.detail-thumb');
    if (thumbs[index]) thumbs[index].classList.add('active');
  }

  function showDetail(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;

    trackEvent('item_view', id);

    detailImages = (item.images || []).map(imgUrl);
    const hero = imgUrl(item.heroImage) || detailImages[0] || '';
    detailIndex = detailImages.indexOf(hero);
    if (detailIndex < 0) detailIndex = 0;

    // Build carousel slides
    track.innerHTML = detailImages.map((img, i) =>
      `<div class="detail-slide"><img src="${img}" alt="${i === 0 ? esc(item.title) : ''}" draggable="false"></div>`
    ).join('');
    slideTo(detailIndex, false);

    document.getElementById('detail-title').textContent = item.title;
    document.getElementById('detail-price').textContent = '$' + Number(item.price).toLocaleString();
    const taxEl = document.getElementById('detail-tax');
    const totalEl = document.getElementById('detail-total');
    const sizeEl = document.getElementById('detail-size');
    sizeEl.textContent = item.size || '';
    sizeEl.style.display = item.size ? '' : 'none';
    document.getElementById('detail-desc').textContent = item.description || '';
    document.getElementById('detail-id').textContent = formatId(item.id);

    // Sold / Hold / Buy Now state
    const soldEl = document.getElementById('detail-sold');
    const holdEl = document.getElementById('detail-hold');
    const inquireEl = document.getElementById('detail-inquire');
    const buyEl = document.getElementById('detail-buy');
    const shippingEl = document.getElementById('detail-shipping');
    const purchasedEl = document.getElementById('detail-purchased');
    const hasPrice = Number(item.price) > 0;
    const wasPurchased = justPurchased === id;
    if (wasPurchased) justPurchased = null; // clear so it doesn't persist on hash nav

    if (wasPurchased || item.isSold) {
      soldEl.style.display = '';
      holdEl.style.display = 'none';
      inquireEl.style.display = 'none';
      buyEl.style.display = 'none';
      shippingEl.style.display = 'none';
      taxEl.style.display = 'none';
      totalEl.style.display = 'none';
      if (wasPurchased) {
        purchasedEl.style.display = '';
        const smsBody = encodeURIComponent(`Hi! I just purchased "${item.title}" from Object Lesson. `);
        document.getElementById('purchased-sms').href = `sms:${PHONE}?body=${smsBody}`;
      } else {
        purchasedEl.style.display = 'none';
      }
    } else if (item.isHold) {
      soldEl.style.display = 'none';
      holdEl.style.display = '';
      buyEl.style.display = 'none';
      shippingEl.style.display = 'none';
      purchasedEl.style.display = 'none';
      taxEl.style.display = 'none';
      totalEl.style.display = 'none';
      inquireEl.style.display = '';
      inquireEl.href = buyLink(item);
      inquireEl.onclick = () => trackEvent('inquire', id);
    } else {
      soldEl.style.display = 'none';
      holdEl.style.display = 'none';
      purchasedEl.style.display = 'none';
      inquireEl.style.display = '';
      inquireEl.href = buyLink(item);
      inquireEl.onclick = () => trackEvent('inquire', id);

      if (hasPrice) {
        const tax = Number(item.price) * 0.1025;
        const total = Number(item.price) + tax;
        taxEl.textContent = `Tax (10.25%): $${tax.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        totalEl.textContent = `Total: $${total.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        taxEl.style.display = '';
        totalEl.style.display = '';
        buyEl.style.display = '';
        shippingEl.style.display = '';
        buyEl.textContent = 'Buy Now';
        buyEl.disabled = false;
        buyEl.onclick = async () => {
          buyEl.textContent = 'Processing...';
          buyEl.disabled = true;
          trackEvent('buy_now', id);
          try {
            const res = await fetch(CHECKOUT_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: item.title,
                price: Number(item.price),
                itemId: item.id
              })
            });
            const data = await res.json();
            if (data.url) {
              window.location.href = data.url;
            } else {
              alert('Checkout unavailable. Please inquire directly.');
              buyEl.textContent = 'Buy Now';
              buyEl.disabled = false;
            }
          } catch {
            alert('Checkout unavailable. Please inquire directly.');
            buyEl.textContent = 'Buy Now';
            buyEl.disabled = false;
          }
        };
      } else {
        buyEl.style.display = 'none';
        shippingEl.style.display = 'none';
        taxEl.style.display = 'none';
        totalEl.style.display = 'none';
      }
    }

    // Share button
    document.getElementById('detail-share').onclick = async () => {
      const shareUrl = location.origin + location.pathname + '#' + id;
      const shareData = { title: item.title, text: `${item.title} — $${Number(item.price).toLocaleString()}`, url: shareUrl };
      if (navigator.share) {
        try { await navigator.share(shareData); } catch {}
      } else {
        try {
          await navigator.clipboard.writeText(shareUrl);
          const btn = document.getElementById('detail-share');
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        } catch {}
      }
    };

    // New badge (don't show on sold or hold items)
    const newEl = document.getElementById('detail-new');
    newEl.style.display = item.isNew && !item.isSold && !item.isHold ? '' : 'none';

    // Thumbnails
    const thumbStrip = document.getElementById('detail-thumbs');
    if (detailImages.length > 1) {
      thumbStrip.innerHTML = detailImages.map((img, i) =>
        `<img src="${img}" alt="" class="detail-thumb${i === detailIndex ? ' active' : ''}" data-index="${i}">`
      ).join('');
      thumbStrip.style.display = '';
      thumbStrip.querySelectorAll('.detail-thumb').forEach(th => {
        th.addEventListener('click', () => {
          slideTo(parseInt(th.dataset.index, 10), true);
        });
      });
    } else {
      thumbStrip.innerHTML = '';
      thumbStrip.style.display = 'none';
    }

    stopMosaic();
    gridView.style.display = 'none';
    detailView.style.display = '';
    aboutView.style.display = 'none';
    notfoundView.style.display = 'none';
    window.scrollTo(0, 0);
  }

  function showGrid() {
    detailView.style.display = 'none';
    aboutView.style.display = 'none';
    notfoundView.style.display = 'none';
    gridView.style.display = '';
    if (mosaicCells.length) startMosaic();
  }

  function showAbout() {
    stopMosaic();
    gridView.style.display = 'none';
    detailView.style.display = 'none';
    notfoundView.style.display = 'none';
    aboutView.style.display = '';
    window.scrollTo(0, 0);
  }

  function showNotFound() {
    stopMosaic();
    gridView.style.display = 'none';
    detailView.style.display = 'none';
    aboutView.style.display = 'none';
    notfoundView.style.display = '';
    window.scrollTo(0, 0);
  }

  // --- Buy link (#2: SMS text) ---

  function buyLink(item) {
    const msg = `Hi, I'm interested in ${item.title} for $${Number(item.price).toLocaleString()}. (item ${formatId(item.id)})`;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isMobile) {
      return `sms:${PHONE}&body=${encodeURIComponent(msg)}`;
    }
    return `mailto:${EMAIL}?subject=${encodeURIComponent('Inquiry: ' + item.title)}&body=${encodeURIComponent(msg)}`;
  }

  // --- Filter (#10: single active filter, click to change) ---

  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('open');
  });

  filterDropdown.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-category]');
    if (!opt) return;
    activeCategory = opt.dataset.category;
    filterLabel.textContent = categoryLabels[activeCategory];
    // Update active state
    filterDropdown.querySelector('.active')?.classList.remove('active');
    opt.classList.add('active');
    filterDropdown.classList.remove('open');
    trackEvent('filter');
    renderGrid();
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.filter-wrap')) {
      filterDropdown.classList.remove('open');
    }
  });

  // --- Hash routing ---

  function handleHash() {
    const hash = location.hash.slice(1);
    if (hash === 'about') {
      showAbout();
    } else if (hash && items.length) {
      const item = items.find(i => i.id === hash);
      if (item) {
        showDetail(hash);
      } else {
        showNotFound();
      }
    } else {
      showGrid();
    }
  }

  window.addEventListener('hashchange', handleHash);

  document.getElementById('btn-detail-back').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  document.getElementById('btn-about-back').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  document.getElementById('btn-notfound-back').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  document.getElementById('notfound-browse').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', location.pathname);
    showGrid();
  });

  // --- Swipe carousel with real-time drag ---

  (function () {
    const carousel = document.getElementById('detail-carousel');
    let startX = 0, startY = 0, dragging = false, locked = false;
    let carouselW = 0;

    carousel.addEventListener('touchstart', (e) => {
      if (detailImages.length < 2) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dragging = true;
      locked = false;
      carouselW = carousel.offsetWidth;
      track.classList.remove('animating');
    }, { passive: true });

    carousel.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      // Determine direction lock on first significant move
      if (!locked && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        locked = true;
        if (Math.abs(dy) > Math.abs(dx)) {
          // Vertical scroll — abort drag
          dragging = false;
          return;
        }
      }

      if (locked) {
        e.preventDefault();
        // Add resistance at edges
        let offset = dx;
        if ((detailIndex === 0 && dx > 0) || (detailIndex === detailImages.length - 1 && dx < 0)) {
          offset = dx * 0.3;
        }
        const pct = (-detailIndex * carouselW + offset) / carouselW * 100;
        track.style.transform = `translateX(${pct}%)`;
      }
    }, { passive: false });

    carousel.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      const threshold = carouselW * 0.2; // 20% of width

      let target = detailIndex;
      if (dx < -threshold && detailIndex < detailImages.length - 1) {
        target = detailIndex + 1;
      } else if (dx > threshold && detailIndex > 0) {
        target = detailIndex - 1;
      }
      slideTo(target, true);
    }, { passive: true });
  })();

  // --- Helpers ---

  const RAW = 'https://raw.githubusercontent.com/elikagan/objectlesson-site/main/';
  function imgUrl(path) {
    if (!path || path.startsWith('http')) return path;
    return RAW + path;
  }

  function formatId(id) {
    const n = parseInt(id, 10);
    return !isNaN(n) ? 'A' + String(n).padStart(6, '0') : 'A' + id;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // --- Mosaic ---

  const mosaic = document.getElementById('mosaic');
  const MOSAIC_CELLS = 18;
  const MOSAIC_INTERVAL = 1000;
  const MOSAIC_FLIP_MS = 700;
  const DESKTOP_FLIPS = 4;   // 4-5
  const MOBILE_FLIPS = 2;    // 2-3

  let mosaicCells = [];
  let mosaicTimer = null;
  let mosaicItems = [];       // items with images

  function isMobile() { return window.innerWidth <= 559; }
  function isTablet() { return window.innerWidth > 559 && window.innerWidth <= 959; }
  function visibleCells() { return isMobile() ? 6 : isTablet() ? 12 : 18; }
  function flipBase() { return isMobile() ? MOBILE_FLIPS : DESKTOP_FLIPS; }

  function initMosaic() {
    mosaicItems = items.filter(i => !i.isSold && (i.heroImage || (i.images && i.images.length > 0)));
    if (mosaicItems.length < 4) { mosaic.style.display = 'none'; return; }

    mosaic.style.display = '';
    mosaic.innerHTML = '';
    mosaicCells = [];

    const shuffled = [...mosaicItems].sort(() => Math.random() - 0.5);

    for (let i = 0; i < MOSAIC_CELLS; i++) {
      const item = shuffled[i % shuffled.length];
      const nextItem = shuffled[(i + 1) % shuffled.length];

      const cell = document.createElement('a');
      cell.className = 'mosaic-cell';
      cell.href = '#' + item.id;
      cell.innerHTML = `
        <div class="mosaic-inner">
          <div class="mosaic-face mosaic-front">
            <img src="${imgUrl(item.heroImage || item.images[0])}" alt="" loading="lazy">
          </div>
          <div class="mosaic-face mosaic-back">
            <img src="${imgUrl(nextItem.heroImage || nextItem.images[0])}" alt="" loading="lazy">
          </div>
        </div>
      `;
      mosaic.appendChild(cell);
      mosaicCells.push({ el: cell, flipped: false, currentItem: item, animating: false });
    }

    startMosaic();
  }

  function startMosaic() {
    if (mosaicTimer) clearInterval(mosaicTimer);
    mosaicTimer = setInterval(flipMosaicTiles, MOSAIC_INTERVAL);
  }

  function stopMosaic() {
    if (mosaicTimer) { clearInterval(mosaicTimer); mosaicTimer = null; }
  }

  function flipMosaicTiles() {
    if (mosaicItems.length < 2) return;

    const vis = visibleCells();
    const available = mosaicCells.filter((c, i) => i < vis && !c.animating);
    if (available.length < 2) return;

    const base = flipBase();
    const count = Math.min(
      Math.random() < 0.5 ? base : base + 1,
      available.length
    );

    const shuffled = [...available].sort(() => Math.random() - 0.5);
    shuffled.slice(0, count).forEach(cell => {
      let newItem;
      let attempts = 0;
      do {
        newItem = mosaicItems[Math.floor(Math.random() * mosaicItems.length)];
        attempts++;
      } while (newItem.id === cell.currentItem.id && attempts < 20);

      const inner = cell.el.querySelector('.mosaic-inner');
      const hiddenImg = cell.flipped
        ? inner.querySelector('.mosaic-front img')
        : inner.querySelector('.mosaic-back img');
      hiddenImg.src = imgUrl(newItem.heroImage || newItem.images[0]);

      cell.animating = true;
      cell.flipped = !cell.flipped;
      inner.classList.toggle('flipped');

      setTimeout(() => {
        cell.el.href = '#' + newItem.id;
        cell.currentItem = newItem;
        cell.animating = false;
      }, MOSAIC_FLIP_MS + 50);
    });
  }

  // Pause mosaic when on detail view or tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopMosaic();
    else if (gridView.style.display !== 'none') startMosaic();
  });

  // --- Init ---
  load();
})();
