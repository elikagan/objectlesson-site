(function () {
  'use strict';

  // --- Config ---
  const REPO = 'objectlesson-site';
  const OWNER = 'elikagan';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const PIN_HASH = '7f6257b880b51353e620ab9224907e72348e8d2c3c1f6e0ba9866661acbc05e9';
  const SIMPLE_HASH = '2a1bf354';

  // --- IndexedDB persistent storage ---
  const DB_NAME = 'ol_admin';
  const DB_STORE = 'kv';
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function store(key, val) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function load(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? '');
      req.onerror = () => reject(req.error);
    });
  }

  // --- State ---
  let ghToken = '';
  let geminiKey = '';
  let items = [];
  let inventorySha = '';
  let editingId = null;
  let photos = []; // { file, dataUrl, processed, remotePath? }
  let sortable = null;
  let photoSortable = null;

  // --- DOM refs ---
  const viewLock = document.getElementById('view-lock');
  const viewSetup = document.getElementById('view-setup');
  const viewList = document.getElementById('view-list');
  const viewEditor = document.getElementById('view-editor');
  const itemList = document.getElementById('item-list');
  const photoGrid = document.getElementById('photo-grid');
  const photoInput = document.getElementById('photo-input');
  const status = document.getElementById('processing-status');
  const toastEl = document.getElementById('toast');

  // --- PIN Lock ---

  // Simple hash that works without crypto.subtle (which requires HTTPS)
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h.toString(16);
  }

  async function hashPin(pin) {
    if (crypto.subtle) {
      try {
        const data = new TextEncoder().encode(pin);
        const buf = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) { /* fall through */ }
    }
    return simpleHash(pin);
  }

  document.getElementById('form-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = document.getElementById('input-pin').value;
    const hash = await hashPin(pin);
    if (hash === PIN_HASH || simpleHash(pin) === SIMPLE_HASH) {
      await store('ol_unlocked', '1');
      await boot();
    } else {
      toast('Wrong PIN');
      document.getElementById('input-pin').value = '';
    }
  });

  // --- Init ---

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }

  // One-time: clear old cookies and localStorage from previous versions
  ['ol_unlocked', 'ol_gh_token', 'ol_gemini_key', 'ol_dealer_code'].forEach(k => {
    try { localStorage.removeItem(k); } catch {}
    document.cookie = k + '=;path=/admin;max-age=0';
  });

  // Boot: load stored state from IndexedDB, then route to the right view
  async function boot() {
    ghToken = await load('ol_gh_token');
    geminiKey = await load('ol_gemini_key');
    const unlocked = await load('ol_unlocked');

    if (!unlocked) {
      showView('lock');
      return;
    }

    if (!ghToken || !geminiKey) {
      // First time only — need keys. Show logo/text, hide topbar
      document.getElementById('setup-topbar').style.display = 'none';
      document.getElementById('setup-logo').style.display = '';
      document.getElementById('setup-text').style.display = '';
      showView('setup');
      return;
    }

    // Normal path: straight to inventory
    showView('list');
    loadInventory();
  }

  boot();

  // --- Setup ---

  document.getElementById('btn-save-setup').addEventListener('click', async () => {
    ghToken = document.getElementById('input-gh-token').value.trim();
    geminiKey = document.getElementById('input-gemini-key').value.trim();
    if (!ghToken || !geminiKey) { toast('Both keys are required'); return; }
    await store('ol_gh_token', ghToken);
    await store('ol_gemini_key', geminiKey);
    showView('list');
    loadInventory();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('input-gh-token').value = ghToken;
    document.getElementById('input-gemini-key').value = geminiKey;
    // Show back nav, hide logo/intro text (settings mode, not first-time setup)
    document.getElementById('setup-topbar').style.display = '';
    document.getElementById('setup-logo').style.display = 'none';
    document.getElementById('setup-text').style.display = 'none';
    showView('setup');
  });

  document.getElementById('btn-cancel-setup').addEventListener('click', () => {
    showView('list');
  });

  // --- Navigation ---

  function showView(name) {
    [viewLock, viewSetup, viewList, viewEditor].forEach(v => v.classList.add('hidden'));
    const v = { lock: viewLock, setup: viewSetup, list: viewList, editor: viewEditor }[name];
    if (v) v.classList.remove('hidden');
  }

  // --- GitHub API helpers ---

  async function ghFetch(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + ghToken,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      const msg = (await res.json().catch(() => ({}))).message || res.statusText;
      throw new Error(msg);
    }
    return res.json();
  }

  async function getFile(path) {
    return ghFetch(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`);
  }

  async function putFile(path, content, sha, message) {
    const body = { message, content: btoa(unescape(encodeURIComponent(content))), branch: BRANCH };
    if (sha) body.sha = sha;
    return ghFetch(`/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async function putFileBinary(path, base64, sha, message) {
    const body = { message, content: base64, branch: BRANCH };
    if (sha) body.sha = sha;
    return ghFetch(`/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async function deleteFile(path, sha, message) {
    return ghFetch(`/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'DELETE',
      body: JSON.stringify({ message, sha, branch: BRANCH })
    });
  }

  // --- Load inventory ---

  async function loadInventory() {
    try {
      const file = await getFile('inventory.json');
      inventorySha = file.sha;
      items = JSON.parse(atob(file.content.replace(/\n/g, '')));
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    } catch (e) {
      items = [];
      inventorySha = '';
    }
    renderList();
  }

  // --- Render list ---

  function renderList() {
    if (items.length === 0) {
      itemList.innerHTML = '<div class="list-empty">No items yet. Tap + to add one.</div>';
      return;
    }

    itemList.innerHTML = items.map(item => {
      const thumb = item.heroImage || (item.images && item.images[0]) || '';
      const imgHtml = thumb ? `<img src="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${thumb}" alt="">` : '';
      return `
        <div class="swipe-wrap" data-id="${item.id}">
          <div class="swipe-behind">
            <button class="swipe-delete" data-id="${item.id}">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
            </button>
          </div>
          <div class="item-row" data-id="${item.id}">
            <div class="item-drag">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
            </div>
            <div class="item-thumb">${imgHtml}</div>
            <div class="item-info">
              <div class="item-name">${esc(item.title || 'Untitled')}</div>
              <div class="item-meta"><span class="item-id">${formatId(item.id)}</span> · $${Number(item.price || 0).toLocaleString()}</div>
            </div>
            ${item.isNew ? '<span class="item-new">New</span>' : ''}
            <span class="item-category">${esc(item.category || '')}</span>
          </div>
        </div>
      `;
    }).join('');

    // Sortable
    if (sortable) sortable.destroy();
    sortable = new Sortable(itemList, {
      handle: '.item-drag',
      ghostClass: 'sortable-ghost',
      animation: 200,
      onEnd: handleReorder
    });

    // Swipe-to-reveal delete
    initSwipeRows();

    // Click to edit
    itemList.querySelectorAll('.item-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.item-drag')) return;
        openEditor(row.dataset.id);
      });
    });

    // Delete from list (swipe-revealed button)
    itemList.querySelectorAll('.swipe-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = items.find(i => i.id === id);
        if (!item) return;
        confirm('Delete ' + (item.title || 'this item') + '?', async () => {
          for (const img of (item.images || [])) {
            try {
              const f = await getFile(img);
              await deleteFile(img, f.sha, 'Delete image');
            } catch (e) { /* ignore */ }
          }
          items = items.filter(i => i.id !== id);
          await saveInventory('Delete ' + (item.title || 'item'));
          toast('Deleted');
          renderList();
        });
      });
    });
  }

  // --- Swipe-to-reveal ---
  const SWIPE_THRESHOLD = 70;
  let openSwipeWrap = null;

  function closeOpenSwipe() {
    if (openSwipeWrap) {
      openSwipeWrap.querySelector('.item-row').style.transform = '';
      openSwipeWrap = null;
    }
  }

  function initSwipeRows() {
    itemList.querySelectorAll('.swipe-wrap').forEach(wrap => {
      const row = wrap.querySelector('.item-row');
      let startX = 0, startY = 0, dx = 0, swiping = false;

      row.addEventListener('touchstart', e => {
        if (e.target.closest('.item-drag')) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        dx = 0;
        swiping = false;
        row.style.transition = 'none';
      }, { passive: true });

      row.addEventListener('touchmove', e => {
        const mx = e.touches[0].clientX - startX;
        const my = e.touches[0].clientY - startY;
        // Only swipe if horizontal movement > vertical
        if (!swiping && Math.abs(mx) > 10 && Math.abs(mx) > Math.abs(my)) {
          swiping = true;
          if (openSwipeWrap && openSwipeWrap !== wrap) closeOpenSwipe();
        }
        if (!swiping) return;
        e.preventDefault();
        dx = Math.min(0, Math.max(-SWIPE_THRESHOLD, mx));
        row.style.transform = `translateX(${dx}px)`;
      }, { passive: false });

      row.addEventListener('touchend', () => {
        row.style.transition = 'transform 0.2s ease';
        if (dx < -SWIPE_THRESHOLD / 2) {
          row.style.transform = `translateX(-${SWIPE_THRESHOLD}px)`;
          openSwipeWrap = wrap;
        } else {
          row.style.transform = '';
          if (openSwipeWrap === wrap) openSwipeWrap = null;
        }
      }, { passive: true });
    });
  }

  // Close swipe when tapping elsewhere
  document.addEventListener('touchstart', e => {
    if (openSwipeWrap && !openSwipeWrap.contains(e.target)) {
      closeOpenSwipe();
    }
  }, { passive: true });

  async function handleReorder() {
    const rows = itemList.querySelectorAll('.item-row');
    const newOrder = Array.from(rows).map(r => r.dataset.id);
    items = newOrder.map((id, i) => {
      const item = items.find(it => it.id === id);
      return { ...item, order: i };
    });
    await saveInventory('Reorder items');
  }

  // --- Save inventory ---

  async function saveInventory(message) {
    try {
      const json = JSON.stringify(items, null, 2);
      const result = await putFile('inventory.json', json, inventorySha, message || 'Update inventory');
      inventorySha = result.content.sha;
    } catch (e) {
      toast('Save failed: ' + e.message);
      throw e;
    }
  }

  // --- Editor ---

  document.getElementById('btn-add').addEventListener('click', () => openEditor(null));
  document.getElementById('btn-back').addEventListener('click', () => {
    showView('list');
    loadInventory();
  });

  function openEditor(id) {
    editingId = id;
    photos = [];

    const deleteBtn = document.getElementById('btn-delete-item');
    const titleEl = document.getElementById('editor-title');

    if (id) {
      const item = items.find(i => i.id === id);
      if (!item) return;
      titleEl.textContent = 'Edit Item';
      deleteBtn.style.display = '';
      document.getElementById('field-title').value = item.title || '';
      document.getElementById('field-desc').value = item.description || '';
      document.getElementById('field-price').value = item.price || '';
      document.getElementById('field-category').value = item.category || '';
      document.getElementById('field-dealer').value = item.dealerCode || '';
      document.getElementById('field-new').checked = !!item.isNew;

      // Load existing images — hero is first, so put it first
      if (item.images) {
        const sorted = [...item.images].sort((a, b) => (a === item.heroImage ? -1 : b === item.heroImage ? 1 : 0));
        photos = sorted.map(img => ({
          file: null,
          dataUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${img}`,
          processed: true,
          remotePath: img
        }));
      }
    } else {
      titleEl.textContent = 'New Item';
      deleteBtn.style.display = 'none';
      document.getElementById('field-title').value = '';
      document.getElementById('field-desc').value = '';
      document.getElementById('field-price').value = '';
      document.getElementById('field-category').value = '';
      document.getElementById('field-dealer').value = '';
      document.getElementById('field-new').checked = true;
    }

    renderPhotos();
    status.textContent = '';
    showView('editor');
  }

  // --- Delete item ---

  document.getElementById('btn-delete-item').addEventListener('click', () => {
    confirm('Delete this item?', async () => {
      const item = items.find(i => i.id === editingId);
      if (!item) return;

      // Delete images from repo
      for (const img of (item.images || [])) {
        try {
          const f = await getFile(img);
          await deleteFile(img, f.sha, 'Delete image');
        } catch (e) { /* ignore */ }
      }

      items = items.filter(i => i.id !== editingId);
      await saveInventory('Delete ' + (item.title || 'item'));
      toast('Deleted');
      showView('list');
      renderList();
    });
  });

  // --- Photos ---

  photoInput.addEventListener('change', e => {
    for (const file of e.target.files) {
      const reader = new FileReader();
      reader.onload = ev => {
        photos.push({
          file,
          dataUrl: ev.target.result,
          processed: false,
          aiProcess: true
        });
        renderPhotos();
      };
      reader.readAsDataURL(file);
    }
    photoInput.value = '';
  });

  function renderPhotos() {
    if (photos.length === 0) {
      photoGrid.innerHTML = '';
      if (photoSortable) { photoSortable.destroy(); photoSortable = null; }
      return;
    }
    photoGrid.innerHTML = photos.map((p, i) => `
      <div class="photo-cell" data-index="${i}">
        <img src="${p.dataUrl}" draggable="false">
        ${i === 0 ? '<span class="photo-hero-dot"></span>' : ''}
        <button class="photo-remove" data-index="${i}">&times;</button>
        ${!p.processed ? `<button class="photo-ai ${p.aiProcess !== false ? 'active' : ''}" data-index="${i}" title="AI processing">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>
        </button>` : ''}
      </div>
    `).join('');

    photoGrid.querySelectorAll('.photo-remove').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        photos.splice(+b.dataset.index, 1);
        renderPhotos();
      });
    });

    photoGrid.querySelectorAll('.photo-ai').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const idx = +b.dataset.index;
        photos[idx].aiProcess = !photos[idx].aiProcess;
        b.classList.toggle('active');
      });
    });

    // Drag-and-drop reorder
    if (photoSortable) photoSortable.destroy();
    photoSortable = new Sortable(photoGrid, {
      animation: 200,
      ghostClass: 'photo-ghost',
      delay: 150,
      delayOnTouchOnly: true,
      filter: '.photo-remove',
      onEnd: (evt) => {
        const moved = photos.splice(evt.oldIndex, 1)[0];
        photos.splice(evt.newIndex, 0, moved);
        renderPhotos();
      }
    });
  }

  // --- AI Processing ---

  document.getElementById('btn-process').addEventListener('click', processWithAI);

  async function processWithAI() {
    if (photos.length === 0) { toast('Add photos first'); return; }
    if (!geminiKey) { toast('Gemini API key required'); return; }

    const btn = document.getElementById('btn-process');
    btn.disabled = true;

    try {
      // 1. Auto-detect price tag, OCR it, remove it from photos
      if (photos.some(p => !p.processed)) {
        setStatus('Scanning for price tag...');
        const tagIndex = await geminiDetectTag(photos.map(p => p.dataUrl));
        if (tagIndex >= 0 && tagIndex < photos.length) {
          setStatus('Reading price tag...');
          const ocrResult = await geminiOCR(photos[tagIndex].dataUrl);
          if (ocrResult.price) document.getElementById('field-price').value = ocrResult.price;
          if (ocrResult.dealerCode) document.getElementById('field-dealer').value = ocrResult.dealerCode;
          if (ocrResult.itemName) document.getElementById('field-title').value = toTitleCase(ocrResult.itemName);
          // Remove tag photo from product photos
          photos.splice(tagIndex, 1);
          renderPhotos();
        }
      }

      // 2. Background removal on unprocessed product photos (skip ai-exempt)
      const unprocessed = photos.filter(p => !p.processed && p.aiProcess !== false);
      if (unprocessed.length > 0) {
        for (let i = 0; i < unprocessed.length; i++) {
          setStatus(`Processing image ${i + 1} of ${unprocessed.length}...`);
          const cleaned = await geminiRemoveBackground(unprocessed[i].dataUrl);
          if (cleaned) {
            unprocessed[i].dataUrl = cleaned;
            unprocessed[i].processed = true;
          }
        }
        renderPhotos();
      }

      // 3. Suggest title, description, category
      if (photos.length > 0) {
        setStatus('Analyzing item...');
        const suggestions = await geminiSuggest(photos.map(p => p.dataUrl));
        if (suggestions.title && !document.getElementById('field-title').value) {
          document.getElementById('field-title').value = suggestions.title;
        }
        if (suggestions.description && !document.getElementById('field-desc').value) {
          document.getElementById('field-desc').value = suggestions.description;
        }
        if (suggestions.category && !document.getElementById('field-category').value) {
          document.getElementById('field-category').value = suggestions.category;
        }
      }

      setStatus('Done.');
      setTimeout(() => setStatus(''), 2000);
    } catch (e) {
      setStatus('Error: ' + e.message);
    }

    btn.disabled = false;
  }

  function setStatus(msg) {
    status.innerHTML = msg
      ? '<span class="spinner"></span>' + esc(msg)
      : '';
  }

  // --- Gemini API ---

  async function geminiCall(model, contents, config = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: config })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || res.statusText);
    }
    return res.json();
  }

  function dataUrlToBase64(dataUrl) {
    return dataUrl.split(',')[1];
  }

  function dataUrlMimeType(dataUrl) {
    return dataUrl.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  }

  // Resize image to max dimension for lighter API calls
  function resizeImage(dataUrl, maxDim) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.src = dataUrl;
    });
  }

  async function geminiOCR(dataUrl) {
    const resized = await resizeImage(dataUrl, 1024);
    const result = await geminiCall('gemini-2.5-flash', [{
      parts: [
        { text: 'Read all text on this price tag or label from an antique store. Extract: the price (number without $ symbol), the dealer code (alphanumeric, usually 2-5 characters like "14EK"), and the item name or description (e.g. "Lauterback Encaustic" or "Studio Vase"). Return ONLY valid JSON: {"price": number_or_null, "dealerCode": "string_or_null", "itemName": "string_or_null", "text": "all visible text"}' },
        { inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(resized) } }
      ]
    }], { responseMimeType: 'application/json' });

    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function geminiDetectTag(dataUrls) {
    // Resize to small thumbnails — only need to identify which is a price tag
    const thumbs = await Promise.all(dataUrls.map(url => resizeImage(url, 512)));
    const parts = [
      { text: `I have ${thumbs.length} photos of an antique/vintage item for sale. One of them might be a photo of a price tag or label (handwritten or printed text on a small card/sticker). Which image index (0-based) is the price tag? If none is a price tag, return -1. Return ONLY valid JSON: {"tagIndex": number}` }
    ];
    for (const url of thumbs) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(url) } });
    }
    const result = await geminiCall('gemini-2.5-flash', [{ parts }], {
      responseMimeType: 'application/json'
    });
    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text).tagIndex ?? -1;
    } catch {
      return -1;
    }
  }

  async function geminiRemoveBackground(dataUrl) {
    const resized = await resizeImage(dataUrl, 1536);
    const result = await geminiCall('gemini-2.5-flash-image', [{
      parts: [
        { text: 'Clean this image for an art gallery listing. Remove all background clutter and distractions. If the object is cropped or cut off at the edges, shrink it so the entire object is visible with generous white space around it. Place the object centered, floating on a pure white (#FFFFFF) background with a soft, subtle drop shadow beneath it. Return only the edited image.' },
        { inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(resized) } }
      ]
    }], { responseModalities: ['IMAGE', 'TEXT'] });

    try {
      const parts = result.candidates[0].content.parts;
      const imgPart = parts.find(p => p.inlineData);
      if (imgPart) {
        return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
      }
    } catch { /* ignore */ }
    return null;
  }

  async function geminiSuggest(dataUrls) {
    const thumbs = await Promise.all(dataUrls.slice(0, 4).map(url => resizeImage(url, 768)));
    const parts = [
      { text: 'You are cataloging items for an antique gallery. Based on these photos, provide: a short title (2-5 words, title case, just what the object is), a description that flows naturally from the title as a continuation (1 simple descriptive sentence — materials, era, origin if obvious. Do NOT repeat the title. Do NOT start with "This" or "A" or "An". No flowery language, no marketing speak), and a category (exactly one of: wall-art, object, ceramic, furniture, light, sculpture, misc). Return ONLY valid JSON: {"title": "string", "description": "string", "category": "string"}' }
    ];
    for (const url of thumbs) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: dataUrlToBase64(url) } });
    }

    const result = await geminiCall('gemini-2.5-flash', [{ parts }], {
      responseMimeType: 'application/json'
    });

    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  // --- Save item ---

  document.getElementById('btn-save').addEventListener('click', saveItem);

  async function saveItem() {
    const title = document.getElementById('field-title').value.trim();
    const description = document.getElementById('field-desc').value.trim();
    const price = parseFloat(document.getElementById('field-price').value) || 0;
    const category = document.getElementById('field-category').value;
    const dc = document.getElementById('field-dealer').value.trim();
    const isNew = document.getElementById('field-new').checked;

    if (!title) { toast('Title is required'); return; }
    if (!category) { toast('Category is required'); return; }

    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const id = editingId || nextId();
      const imgDir = `images/products/${id}`;
      const uploadedImages = [];

      // Upload photos (first = hero)
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];

        if (p.remotePath) {
          uploadedImages.push(p.remotePath);
          continue;
        }

        const path = `${imgDir}/${i}.jpg`;
        const base64 = dataUrlToBase64(p.dataUrl);
        await putFileBinary(path, base64, null, 'Add product image');
        uploadedImages.push(path);
      }

      // Build item — first image is always the hero
      const itemData = {
        id,
        title,
        description,
        price,
        category,
        dealerCode: dc,
        isNew,
        images: uploadedImages,
        heroImage: uploadedImages[0] || '',
        order: editingId ? (items.find(i => i.id === editingId)?.order ?? items.length) : items.length,
        createdAt: editingId ? (items.find(i => i.id === editingId)?.createdAt) : new Date().toISOString()
      };

      if (editingId) {
        items = items.map(i => i.id === editingId ? itemData : i);
      } else {
        items.push(itemData);
      }

      await saveInventory((editingId ? 'Update ' : 'Add ') + title);

      toast('Saved');
      showView('list');
      renderList();
    } catch (e) {
      toast('Error: ' + e.message);
    }

    btn.disabled = false;
    btn.textContent = 'Save';
  }

  // --- Utils ---

  function nextId() {
    let max = 0;
    for (const item of items) {
      const n = parseInt(item.id, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return String(max + 1).padStart(6, '0');
  }

  function formatId(id) {
    const n = parseInt(id, 10);
    return !isNaN(n) ? '#' + String(n).padStart(6, '0') : id;
  }

  function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    toastEl.classList.add('show');
    setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2200);
  }

  function confirm(msg, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="dialog">
        <p>${esc(msg)}</p>
        <div class="dialog-actions">
          <button class="dialog-cancel">Cancel</button>
          <button class="dialog-confirm">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.dialog-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.dialog-confirm').addEventListener('click', () => {
      overlay.remove();
      onConfirm();
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }
})();
