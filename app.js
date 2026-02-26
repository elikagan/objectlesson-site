(function () {
  const PHONE = '3104985138';
  const EMAIL = 'eli@objectlesson.la';

  let items = [];
  let activeCategory = 'all';

  const grid = document.getElementById('product-grid');
  const empty = document.getElementById('empty');
  const filters = document.getElementById('filters');

  // --- Load inventory ---

  async function load() {
    try {
      const res = await fetch('inventory.json?t=' + Date.now());
      items = await res.json();
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
      items = [];
    }
    render();
  }

  // --- Render ---

  function render() {
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
      const card = document.createElement('div');
      card.className = 'card';
      card.style.animationDelay = (i * 0.06) + 's';

      const imgSrc = item.heroImage || (item.images && item.images[0]) || '';
      const imgHtml = imgSrc
        ? `<img src="${imgSrc}" alt="${esc(item.title)}" loading="lazy">`
        : '';

      card.innerHTML = `
        <div class="card-image">${imgHtml}</div>
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-price">$${Number(item.price).toLocaleString()}</div>
        <div class="card-desc">${esc(item.description)}</div>
        <a class="card-buy" href="${buyLink(item)}">Inquire</a>
      `;

      grid.appendChild(card);
    });
  }

  // --- Buy link ---

  function buyLink(item) {
    const msg = `Hi, I'm interested in "${item.title}" ($${item.price}) from Object Lesson.`;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    if (isMobile) {
      return `sms:${PHONE}&body=${encodeURIComponent(msg)}`;
    }
    return `mailto:${EMAIL}?subject=${encodeURIComponent('Inquiry: ' + item.title)}&body=${encodeURIComponent(msg)}`;
  }

  // --- Filters ---

  filters.addEventListener('click', function (e) {
    if (!e.target.classList.contains('filter')) return;
    filters.querySelector('.active').classList.remove('active');
    e.target.classList.add('active');
    activeCategory = e.target.dataset.category;
    render();
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
