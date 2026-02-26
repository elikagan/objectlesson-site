(function () {
  'use strict';

  // --- Config ---
  const REPO = 'objectlesson-site';
  const OWNER = 'elikagan';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const PIN_HASH = '7f6257b880b51353e620ab9224907e72348e8d2c3c1f6e0ba9866661acbc05e9';
  const SIMPLE_HASH = '2a1bf354';

  // --- Persistent storage (cookies, since Safari HTTP drops localStorage) ---
  function store(key, val) {
    try { localStorage.setItem(key, val); } catch {}
    document.cookie = key + '=' + encodeURIComponent(val) + ';path=/admin;max-age=31536000;SameSite=Strict';
  }
  function load(key) {
    const ls = localStorage.getItem(key);
    if (ls) return ls;
    const m = document.cookie.match('(?:^|; )' + key + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : '';
  }

  // --- State ---
  let unlocked = !!load('ol_unlocked');
  let ghToken = load('ol_gh_token');
  let geminiKey = load('ol_gemini_key');
  let dealerCode = load('ol_dealer_code') || '14EK';
  let items = [];
  let inventorySha = '';
  let editingId = null;
  let photos = []; // { file, dataUrl, processed, isTag, isHero }
  let sortable = null;

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
      unlocked = true;
      store('ol_unlocked', '1');
      initApp();
    } else {
      toast('Wrong PIN');
      document.getElementById('input-pin').value = '';
    }
  });

  // --- Init ---

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js');
  }

  if (unlocked) {
    initApp();
  } else {
    showView('lock');
  }

  function initApp() {
    if (ghToken && geminiKey) {
      showView('list');
      loadInventory();
    } else {
      showView('setup');
    }
  }

  // --- Setup ---

  document.getElementById('btn-save-setup').addEventListener('click', () => {
    ghToken = document.getElementById('input-gh-token').value.trim();
    geminiKey = document.getElementById('input-gemini-key').value.trim();
    dealerCode = document.getElementById('input-dealer-code').value.trim() || '14EK';
    if (!ghToken || !geminiKey) { toast('Both keys are required'); return; }
    store('ol_gh_token', ghToken);
    store('ol_gemini_key', geminiKey);
    store('ol_dealer_code', dealerCode);
    showView('list');
    loadInventory();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('input-gh-token').value = ghToken;
    document.getElementById('input-gemini-key').value = geminiKey;
    document.getElementById('input-dealer-code').value = dealerCode;
    document.getElementById('btn-cancel-setup').style.display = '';
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
        <div class="item-row" data-id="${item.id}">
          <div class="item-drag">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>
          </div>
          <div class="item-thumb">${imgHtml}</div>
          <div class="item-info">
            <div class="item-name">${esc(item.title || 'Untitled')}</div>
            <div class="item-meta">$${Number(item.price || 0).toLocaleString()}</div>
          </div>
          <span class="item-category">${esc(item.category || '')}</span>
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

    // Click to edit
    itemList.querySelectorAll('.item-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.item-drag')) return;
        openEditor(row.dataset.id);
      });
    });
  }

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
      document.getElementById('field-dealer').value = item.dealerCode || dealerCode;

      // Load existing images
      if (item.images) {
        photos = item.images.map((img, i) => ({
          file: null,
          dataUrl: `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${img}`,
          processed: true,
          isTag: false,
          isHero: (img === item.heroImage),
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
      document.getElementById('field-dealer').value = dealerCode;
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
      if (item.tagImage) {
        try {
          const f = await getFile(item.tagImage);
          await deleteFile(item.tagImage, f.sha, 'Delete tag image');
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
          isTag: false,
          isHero: photos.length === 0
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
      return;
    }
    photoGrid.innerHTML = photos.map((p, i) => `
      <div class="photo-cell">
        <img src="${p.dataUrl}">
        <div class="photo-badges">
          <span class="photo-badge ${p.isHero ? 'active' : ''}" data-action="hero" data-index="${i}">Hero</span>
          <span class="photo-badge ${p.isTag ? 'active' : ''}" data-action="tag" data-index="${i}">Tag</span>
        </div>
        <button class="photo-remove" data-index="${i}">&times;</button>
      </div>
    `).join('');

    photoGrid.querySelectorAll('.photo-badge').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const idx = +b.dataset.index;
        if (b.dataset.action === 'hero') {
          photos.forEach((p, i) => p.isHero = (i === idx));
        } else {
          photos[idx].isTag = !photos[idx].isTag;
        }
        renderPhotos();
      });
    });

    photoGrid.querySelectorAll('.photo-remove').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        photos.splice(+b.dataset.index, 1);
        if (photos.length && !photos.some(p => p.isHero)) photos[0].isHero = true;
        renderPhotos();
      });
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
      // 1. OCR on tag photos
      const tagPhotos = photos.filter(p => p.isTag && !p.processed);
      if (tagPhotos.length > 0) {
        setStatus('Reading price tag...');
        for (const p of tagPhotos) {
          const ocrResult = await geminiOCR(p.dataUrl);
          if (ocrResult.price) document.getElementById('field-price').value = ocrResult.price;
          if (ocrResult.dealerCode) document.getElementById('field-dealer').value = ocrResult.dealerCode;
        }
      }

      // 2. Background removal on product photos
      const productPhotos = photos.filter(p => !p.isTag && !p.processed);
      if (productPhotos.length > 0) {
        for (let i = 0; i < productPhotos.length; i++) {
          setStatus(`Processing image ${i + 1} of ${productPhotos.length}...`);
          const cleaned = await geminiRemoveBackground(productPhotos[i].dataUrl);
          if (cleaned) {
            productPhotos[i].dataUrl = cleaned;
            productPhotos[i].processed = true;
          }
        }
        renderPhotos();
      }

      // 3. Suggest title, description, category
      setStatus('Analyzing item...');
      const nonTagPhotos = photos.filter(p => !p.isTag);
      if (nonTagPhotos.length > 0) {
        const suggestions = await geminiSuggest(nonTagPhotos.map(p => p.dataUrl));
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

  async function geminiOCR(dataUrl) {
    const result = await geminiCall('gemini-2.5-flash', [{
      parts: [
        { text: 'Read all text on this price tag or label. Extract the price (as a number without currency symbol) and the dealer code (alphanumeric, usually 3-5 characters). Return ONLY valid JSON: {"price": number_or_null, "dealerCode": "string_or_null", "text": "all visible text"}' },
        { inlineData: { mimeType: dataUrlMimeType(dataUrl), data: dataUrlToBase64(dataUrl) } }
      ]
    }], { responseMimeType: 'application/json' });

    try {
      const text = result.candidates[0].content.parts[0].text;
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  async function geminiRemoveBackground(dataUrl) {
    const result = await geminiCall('gemini-2.5-flash-preview-native-audio-dialog', [{
      parts: [
        { text: 'Remove the background from this product photo. Place the object on a clean pure white background with soft, even studio lighting and a very subtle drop shadow beneath the object. Keep the object exactly as it is — do not change its appearance, color, or proportions. Return only the edited image.' },
        { inlineData: { mimeType: dataUrlMimeType(dataUrl), data: dataUrlToBase64(dataUrl) } }
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
    const parts = [
      { text: 'You are cataloging items for Object Lesson, an antique and vintage gallery in Pasadena. Based on these product photos, suggest a short title (under 8 words), a description (2-3 sentences about the item including era/period, materials, style, and condition), and a category (exactly one of: wall-art, object, ceramic, furniture, light, sculpture, misc). Return ONLY valid JSON: {"title": "string", "description": "string", "category": "string"}' }
    ];
    for (const url of dataUrls.slice(0, 4)) {
      parts.push({ inlineData: { mimeType: dataUrlMimeType(url), data: dataUrlToBase64(url) } });
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
    const dc = document.getElementById('field-dealer').value.trim() || dealerCode;

    if (!title) { toast('Title is required'); return; }
    if (!category) { toast('Category is required'); return; }

    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const id = editingId || Date.now().toString(36);
      const imgDir = `images/products/${id}`;
      const uploadedImages = [];
      let heroImage = '';
      let tagImage = '';

      // Upload new photos
      for (let i = 0; i < photos.length; i++) {
        const p = photos[i];

        if (p.remotePath) {
          // Already on GitHub
          uploadedImages.push(p.remotePath);
          if (p.isHero) heroImage = p.remotePath;
          continue;
        }

        if (p.isTag) {
          // Upload tag image (not in public images array)
          const path = `${imgDir}/tag_${i}.jpg`;
          const base64 = dataUrlToBase64(p.dataUrl);
          await putFileBinary(path, base64, null, 'Add tag image');
          tagImage = path;
          continue;
        }

        // Upload product image
        const path = `${imgDir}/${i}.jpg`;
        const base64 = dataUrlToBase64(p.dataUrl);
        await putFileBinary(path, base64, null, 'Add product image');
        uploadedImages.push(path);
        if (p.isHero) heroImage = path;
      }

      if (!heroImage && uploadedImages.length > 0) heroImage = uploadedImages[0];

      // Build item
      const itemData = {
        id,
        title,
        description,
        price,
        category,
        dealerCode: dc,
        images: uploadedImages,
        heroImage,
        tagImage: tagImage || undefined,
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
