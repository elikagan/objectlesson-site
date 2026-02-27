(function () {
  const PHONE = '3104985138';
  const EMAIL = 'eli@objectlesson.la';

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
  const gridView = document.getElementById('view-grid');
  const detailView = document.getElementById('view-detail');
  const filterBtn = document.getElementById('filter-btn');
  const filterLabel = document.getElementById('filter-label');
  const filterDropdown = document.getElementById('filter-dropdown');

  const categoryLabels = {
    'all': 'All', 'wall-art': 'Wall Art', 'object': 'Object',
    'ceramic': 'Ceramic', 'furniture': 'Furniture', 'light': 'Light',
    'sculpture': 'Sculpture', 'misc': 'Misc'
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
    initMosaic();
    renderGrid();
    handleHash();
    trackEvent('page_view');
  }

  // --- Grid render ---

  function renderGrid() {
    const filtered = activeCategory === 'all'
      ? items
      : items.filter(i => i.category === activeCategory);

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

      const imgSrc = imgUrl(item.heroImage || (item.images && item.images[0]) || '');
      const imgHtml = imgSrc
        ? `<img src="${imgSrc}" alt="${esc(item.title)}" loading="lazy">`
        : '';

      const newBadge = item.isNew ? '<span class="card-new">New</span>' : '';

      card.innerHTML = `
        <div class="card-image">${imgHtml}${newBadge}</div>
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
    const sizeEl = document.getElementById('detail-size');
    sizeEl.textContent = item.size || '';
    sizeEl.style.display = item.size ? '' : 'none';
    document.getElementById('detail-desc').textContent = item.description || '';
    document.getElementById('detail-id').textContent = formatId(item.id);
    const inquireEl = document.getElementById('detail-inquire');
    inquireEl.href = buyLink(item);
    inquireEl.onclick = () => trackEvent('inquire', id);

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

    // New badge
    const newEl = document.getElementById('detail-new');
    newEl.style.display = item.isNew ? '' : 'none';

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
    window.scrollTo(0, 0);
  }

  function showGrid() {
    detailView.style.display = 'none';
    gridView.style.display = '';
    if (mosaicCells.length) startMosaic();
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
    if (hash && items.length) {
      showDetail(hash);
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
    mosaicItems = items.filter(i => i.heroImage || (i.images && i.images.length > 0));
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
