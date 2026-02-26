(function () {
  const PHONE = '3104985138';
  const EMAIL = 'eli@objectlesson.la';

  let items = [];
  let activeCategory = 'all';

  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('empty');
  const gridView = document.getElementById('view-grid');
  const detailView = document.getElementById('view-detail');
  const filterBtn = document.getElementById('filter-btn');
  const filterDropdown = document.getElementById('filter-dropdown');

  const categoryLabels = {
    'all': 'All', 'wall-art': 'Wall Art', 'object': 'Object',
    'ceramic': 'Ceramic', 'furniture': 'Furniture', 'light': 'Light',
    'sculpture': 'Sculpture', 'misc': 'Misc'
  };

  // --- Load inventory ---

  async function load() {
    try {
      const res = await fetch('inventory.json?t=' + Date.now());
      items = await res.json();
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
      items = [];
    }
    renderGrid();
    handleHash();
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

      const imgSrc = item.heroImage || (item.images && item.images[0]) || '';
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

  // --- Detail view ---

  function showDetail(id) {
    const item = items.find(i => i.id === id);
    if (!item) return;

    const allImages = item.images || [];
    const hero = item.heroImage || allImages[0] || '';

    const heroEl = document.getElementById('detail-hero');
    heroEl.src = hero;
    heroEl.alt = item.title;

    document.getElementById('detail-title').textContent = item.title;
    document.getElementById('detail-price').textContent = '$' + Number(item.price).toLocaleString();
    document.getElementById('detail-desc').textContent = item.description || '';
    document.getElementById('detail-id').textContent = 'ID: ' + item.id;
    document.getElementById('detail-inquire').href = buyLink(item);

    // New badge
    const newEl = document.getElementById('detail-new');
    newEl.style.display = item.isNew ? '' : 'none';

    // Thumbnails
    const thumbStrip = document.getElementById('detail-thumbs');
    if (allImages.length > 1) {
      thumbStrip.innerHTML = allImages.map(img =>
        `<img src="${img}" alt="" class="detail-thumb${img === hero ? ' active' : ''}" data-src="${img}">`
      ).join('');
      thumbStrip.style.display = '';
      thumbStrip.querySelectorAll('.detail-thumb').forEach(th => {
        th.addEventListener('click', () => {
          heroEl.src = th.dataset.src;
          thumbStrip.querySelector('.active')?.classList.remove('active');
          th.classList.add('active');
        });
      });
    } else {
      thumbStrip.innerHTML = '';
      thumbStrip.style.display = 'none';
    }

    gridView.style.display = 'none';
    detailView.style.display = '';
    window.scrollTo(0, 0);
  }

  function showGrid() {
    detailView.style.display = 'none';
    gridView.style.display = '';
  }

  // --- Buy link (#2: SMS text) ---

  function buyLink(item) {
    const msg = `Hi I'm interested in ${item.title}, ${item.id} for $${Number(item.price).toLocaleString()}.`;
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
    filterBtn.textContent = categoryLabels[activeCategory];
    // Update active state
    filterDropdown.querySelector('.active')?.classList.remove('active');
    opt.classList.add('active');
    filterDropdown.classList.remove('open');
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

  // --- Helpers ---

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // --- Init ---
  load();
})();
