(function () {
  'use strict';

  // --- Config ---
  const REPO = 'objectlesson-site';
  const OWNER = 'elikagan';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const PIN_HASH = '7f6257b880b51353e620ab9224907e72348e8d2c3c1f6e0ba9866661acbc05e9';

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
  let supaUrl = '';
  let supaKey = '';
  let currentPin = null;
  let items = [];
  let inventorySha = '';
  let editingId = null;
  let photos = []; // { file, dataUrl, processed, remotePath? }
  let sortable = null;
  let photoSortable = null;
  let analyticsRange = 30;

  // --- Encrypted config (keys stored in repo, decrypted with PIN) ---

  function xorCipher(key, text) {
    return text.split('').map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('');
  }

  async function encryptConfig(pin, data) {
    const json = JSON.stringify(data);
    if (!crypto.subtle) return 'X' + btoa(xorCipher(pin, json));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json));
    const buf = new Uint8Array(28 + ct.byteLength);
    buf.set(salt, 0);
    buf.set(iv, 16);
    buf.set(new Uint8Array(ct), 28);
    return 'A' + btoa(String.fromCharCode(...buf));
  }

  async function decryptConfig(pin, encoded) {
    if (encoded[0] === 'X') return JSON.parse(xorCipher(pin, atob(encoded.slice(1))));
    const buf = Uint8Array.from(atob(encoded.slice(1)), c => c.charCodeAt(0));
    const salt = buf.slice(0, 16);
    const iv = buf.slice(16, 28);
    const ct = buf.slice(28);
    const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(dec));
  }

  async function backupConfig(pin) {
    if (!ghToken || !geminiKey) return;
    const encrypted = await encryptConfig(pin, { g: ghToken, m: geminiKey, s: supaUrl, k: supaKey });
    const path = 'admin/config.enc';
    let sha;
    try {
      const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
        headers: { 'Authorization': `Bearer ${ghToken}` }
      });
      if (r.ok) sha = (await r.json()).sha;
    } catch {}
    await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Update config',
        content: btoa(encrypted),
        branch: BRANCH,
        ...(sha ? { sha } : {})
      })
    });
  }

  // --- DOM refs ---
  const viewLock = document.getElementById('view-lock');
  const viewSetup = document.getElementById('view-setup');
  const viewList = document.getElementById('view-list');
  const viewEditor = document.getElementById('view-editor');
  const viewAnalytics = document.getElementById('view-analytics');
  const viewMarketing = document.getElementById('view-marketing');
  const itemList = document.getElementById('item-list');
  const photoGrid = document.getElementById('photo-grid');
  const photoInput = document.getElementById('photo-input');
  const status = document.getElementById('processing-status');
  const toastEl = document.getElementById('toast');

  // --- PIN Lock ---

  async function hashPin(pin) {
    const data = new TextEncoder().encode(pin);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Rate limiting for PIN attempts
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes
  let pinAttempts = 0;
  let lockoutUntil = 0;

  document.getElementById('form-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();

    // Check lockout
    if (Date.now() < lockoutUntil) {
      const mins = Math.ceil((lockoutUntil - Date.now()) / 60000);
      toast(`Locked out. Try again in ${mins}m`);
      return;
    }

    const pin = document.getElementById('input-pin').value;
    const hash = await hashPin(pin);
    if (hash === PIN_HASH) {
      pinAttempts = 0;
      currentPin = pin;
      await store('ol_unlocked', '1');
      await boot(pin);
    } else {
      pinAttempts++;
      if (pinAttempts >= MAX_ATTEMPTS) {
        lockoutUntil = Date.now() + LOCKOUT_MS;
        pinAttempts = 0;
        toast('Too many attempts. Locked for 5 minutes');
      } else {
        toast(`Wrong PIN (${MAX_ATTEMPTS - pinAttempts} left)`);
      }
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

  // Boot: load stored state, fall back to encrypted config in repo
  async function boot(pin) {
    if (pin) currentPin = pin;

    ghToken = await load('ol_gh_token');
    geminiKey = await load('ol_gemini_key');
    supaUrl = await load('ol_supa_url');
    supaKey = await load('ol_supa_key');
    const unlocked = await load('ol_unlocked');

    // Not unlocked and no PIN entered — show lock screen
    if (!unlocked && !currentPin) {
      showView('lock');
      return;
    }

    // Keys in IndexedDB — go straight to inventory
    if (ghToken && geminiKey) {
      if (currentPin) backupConfig(currentPin).catch(() => {});
      loadInventory();
      // Restore view from hash (e.g. #analytics)
      const hash = location.hash.slice(1);
      if (hash === 'analytics') {
        showView('analytics');
        loadAnalytics();
      } else if (hash === 'marketing') {
        showView('marketing');
        loadMarketing();
      } else {
        showView('list');
      }
      return;
    }

    // Keys missing — try to restore from encrypted config in repo
    if (currentPin) {
      try {
        const resp = await fetch('config.enc?t=' + Date.now());
        if (resp.ok) {
          const blob = await resp.text();
          const config = await decryptConfig(currentPin, blob.trim());
          ghToken = config.g;
          geminiKey = config.m;
          supaUrl = config.s || '';
          supaKey = config.k || '';
          await store('ol_gh_token', ghToken);
          await store('ol_gemini_key', geminiKey);
          if (supaUrl) await store('ol_supa_url', supaUrl);
          if (supaKey) await store('ol_supa_key', supaKey);
          showView('list');
          loadInventory();
          return;
        }
      } catch (e) { /* config.enc missing or decrypt failed */ }
    }

    // No PIN available — re-show lock to get it
    if (!currentPin) {
      await store('ol_unlocked', '');
      showView('lock');
      return;
    }

    // Have PIN but no config.enc — first time setup
    document.getElementById('setup-topbar').style.display = 'none';
    document.getElementById('setup-logo').style.display = '';
    document.getElementById('setup-text').style.display = '';
    showView('setup');
  }

  boot();

  // --- Setup ---

  document.getElementById('btn-save-setup').addEventListener('click', async () => {
    ghToken = document.getElementById('input-gh-token').value.trim();
    geminiKey = document.getElementById('input-gemini-key').value.trim();
    supaUrl = document.getElementById('input-supa-url').value.trim().replace(/\/+$/, '');
    supaKey = document.getElementById('input-supa-key').value.trim();
    if (!ghToken || !geminiKey) { toast('GitHub + Gemini keys are required'); return; }
    await store('ol_gh_token', ghToken);
    await store('ol_gemini_key', geminiKey);
    if (supaUrl) await store('ol_supa_url', supaUrl);
    if (supaKey) await store('ol_supa_key', supaKey);
    // Backup encrypted config to repo so phone never needs key entry
    if (currentPin) backupConfig(currentPin).catch(() => {});
    showView('list');
    loadInventory();
  });

  // --- Hamburger menu ---
  const menuDropdown = document.getElementById('menu-dropdown');

  document.getElementById('btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) menuDropdown.classList.add('hidden');
  });

  document.getElementById('menu-settings').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    document.getElementById('input-gh-token').value = ghToken;
    document.getElementById('input-gemini-key').value = geminiKey;
    document.getElementById('input-supa-url').value = supaUrl;
    document.getElementById('input-supa-key').value = supaKey;
    document.getElementById('setup-topbar').style.display = '';
    document.getElementById('setup-logo').style.display = 'none';
    document.getElementById('setup-text').style.display = 'none';
    showView('setup');
  });

  document.getElementById('menu-analytics').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    location.hash = 'analytics';
    showView('analytics');
    loadAnalytics();
  });

  document.getElementById('menu-marketing').addEventListener('click', () => {
    menuDropdown.classList.add('hidden');
    location.hash = 'marketing';
    showView('marketing');
    loadMarketing();
  });

  document.getElementById('btn-analytics-back').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showView('list');
  });

  // Date range toggle
  document.getElementById('range-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    analyticsRange = parseInt(btn.dataset.range, 10);
    document.getElementById('range-toggle').querySelector('.active')?.classList.remove('active');
    btn.classList.add('active');
    loadAnalytics();
  });

  // Pull-to-refresh on analytics view
  (function () {
    const av = document.getElementById('view-analytics');
    let ptrY = 0, ptrOn = false;
    av.addEventListener('touchstart', (e) => {
      if (window.scrollY === 0) { ptrY = e.touches[0].clientY; ptrOn = true; }
    }, { passive: true });
    av.addEventListener('touchmove', (e) => {
      if (!ptrOn) return;
      if (e.touches[0].clientY - ptrY > 80 && window.scrollY === 0) { ptrOn = false; loadAnalytics(); }
    }, { passive: true });
    av.addEventListener('touchend', () => { ptrOn = false; }, { passive: true });
  })();

  document.getElementById('btn-cancel-setup').addEventListener('click', () => {
    showView('list');
  });

  // --- Navigation ---

  function showView(name) {
    [viewLock, viewSetup, viewList, viewEditor, viewAnalytics, viewMarketing].forEach(v => v.classList.add('hidden'));
    const v = { lock: viewLock, setup: viewSetup, list: viewList, editor: viewEditor, analytics: viewAnalytics, marketing: viewMarketing }[name];
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

    const active = items.filter(i => !i.isSold);
    const sold = items.filter(i => i.isSold);

    function itemRowHtml(item) {
      const thumb = item.heroImage || (item.images && item.images[0]) || '';
      const imgHtml = thumb ? `<img src="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${thumb}" alt="">` : '';
      let badge = '';
      if (item.isSold) badge = '<span class="item-sold">Sold</span>';
      else if (item.isHold) badge = '<span class="item-hold">Hold</span>';
      else if (item.isNew) badge = '<span class="item-new">New</span>';
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
            ${badge}
            <span class="item-category">${esc(item.category || '')}</span>
          </div>
        </div>
      `;
    }

    let html = active.map(itemRowHtml).join('');
    if (sold.length) {
      html += `<div class="archive-header" id="archive-header">
        <span>Archive</span>
        <span class="archive-count">${sold.length}</span>
        <svg class="archive-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>`;
      html += `<div class="archive-items" id="archive-items">${sold.map(itemRowHtml).join('')}</div>`;
    }
    itemList.innerHTML = html;

    // Archive toggle
    const archiveHeader = document.getElementById('archive-header');
    if (archiveHeader) {
      archiveHeader.addEventListener('click', () => {
        archiveHeader.classList.toggle('collapsed');
        document.getElementById('archive-items').classList.toggle('collapsed');
      });
    }

    // Sortable
    if (sortable) sortable.destroy();
    sortable = new Sortable(itemList, {
      handle: '.item-drag',
      ghostClass: 'sortable-ghost',
      animation: 200,
      filter: '.archive-header, .archive-items',
      onMove(evt) { return !evt.related.classList.contains('archive-header') && !evt.related.classList.contains('archive-items'); },
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
    // Only reorder active (non-sold) items — exclude archive section
    const rows = itemList.querySelectorAll(':scope > .swipe-wrap > .item-row');
    const newOrder = Array.from(rows).map(r => r.dataset.id);
    const activeItems = newOrder.map((id, i) => {
      const item = items.find(it => it.id === id);
      return { ...item, order: i };
    });
    const soldItems = items.filter(i => i.isSold);
    items = [...activeItems, ...soldItems];
    await saveInventory('Reorder items');
  }

  // --- Save inventory ---

  async function saveInventory(message, _retried) {
    try {
      const json = JSON.stringify(items, null, 2);
      const result = await putFile('inventory.json', json, inventorySha, message || 'Update inventory');
      inventorySha = result.content.sha;
    } catch (e) {
      // SHA conflict (409) — re-fetch current SHA and retry once
      if (!_retried && e.message && (e.message.includes('does not match') || e.message.includes('409'))) {
        try {
          const file = await getFile('inventory.json');
          inventorySha = file.sha;
          return saveInventory(message, true);
        } catch (retryErr) {
          toast('Save failed: ' + retryErr.message);
          throw retryErr;
        }
      }
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
      document.getElementById('field-price').value = item.price != null ? item.price : '';
      document.getElementById('field-size').value = item.size || '';
      document.getElementById('field-category').value = item.category || '';
      document.getElementById('field-maker').value = item.maker || '';
      document.getElementById('field-condition').value = item.condition || '';
      document.getElementById('field-dealer').value = item.dealerCode || '';
      document.getElementById('field-new').checked = !!item.isNew;
      document.getElementById('field-hold').checked = !!item.isHold;
      document.getElementById('field-sold').checked = !!item.isSold;

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
      document.getElementById('field-size').value = '';
      document.getElementById('field-category').value = '';
      document.getElementById('field-maker').value = '';
      document.getElementById('field-condition').value = '';
      document.getElementById('field-dealer').value = '';
      document.getElementById('field-new').checked = true;
      document.getElementById('field-hold').checked = false;
      document.getElementById('field-sold').checked = false;
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
        const dataUrl = ev.target.result;
        photos.push({
          file,
          dataUrl,
          blobUrl: toBlobUrl(dataUrl),
          processed: false,
          aiProcess: true
        });
        renderPhotos();
      };
      reader.readAsDataURL(file);
    }
    photoInput.value = '';
  });

  let photoSortableGen = 0;

  function renderPhotos() {
    const gen = ++photoSortableGen;

    if (photoSortable) { photoSortable.destroy(); photoSortable = null; }

    if (photos.length === 0) {
      photoGrid.innerHTML = '';
      return;
    }

    // Use blob URLs for display (avoids embedding MB of base64 in DOM)
    photoGrid.innerHTML = photos.map((p, i) => `
      <div class="photo-cell" data-index="${i}">
        <img src="${p.blobUrl || p.dataUrl}" draggable="false">
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
        const idx = +b.dataset.index;
        // Revoke blob URL to free memory
        if (photos[idx] && photos[idx].blobUrl) URL.revokeObjectURL(photos[idx].blobUrl);
        photos.splice(idx, 1);
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

    // Defer Sortable init until images have rendered
    requestAnimationFrame(() => {
      if (gen !== photoSortableGen) return; // stale call
      if (!photoGrid.children.length) return;
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
            // Revoke old blob URL before replacing
            if (unprocessed[i].blobUrl) URL.revokeObjectURL(unprocessed[i].blobUrl);
            unprocessed[i].dataUrl = cleaned;
            unprocessed[i].blobUrl = toBlobUrl(cleaned);
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
        if (suggestions.maker && !document.getElementById('field-maker').value) {
          document.getElementById('field-maker').value = suggestions.maker;
        }
        if (suggestions.condition && !document.getElementById('field-condition').value) {
          document.getElementById('field-condition').value = suggestions.condition;
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
        { text: 'Prepare this photo for an art gallery product listing. Remove the background and replace it with pure white (#FFFFFF). Do NOT move, resize, reposition, or re-center the object — keep the exact same composition, crop, angle, and scale as the original photo. Improve the lighting and color balance on the object so it looks clean and professional. Add a very subtle, barely noticeable shadow appropriate to the object: for objects that rest on a surface (like a vase or sculpture), a faint contact shadow beneath; for wall-hanging items (like a painting or wall art), a faint shadow behind as if mounted on a wall — never a floor shadow for wall art. Return only the edited image.' },
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
      { text: 'You are cataloging items for an antique gallery. Based on these photos, provide: a short title (2-5 words, title case, just what the object is), a description that flows naturally from the title as a continuation (1 simple descriptive sentence — materials, era, origin if obvious. Do NOT repeat the title. Do NOT start with "This" or "A" or "An". No flowery language, no marketing speak), a category (exactly one of: wall-art, object, ceramic, furniture, light, sculpture, misc), a maker or brand if identifiable (empty string if unknown), and condition (exactly one of: excellent, good, fair, as-is — judge from visible wear, patina, damage in photos). Return ONLY valid JSON: {"title": "string", "description": "string", "category": "string", "maker": "string", "condition": "string"}' }
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
    const size = document.getElementById('field-size').value.trim();
    const category = document.getElementById('field-category').value;
    const maker = document.getElementById('field-maker').value.trim();
    const condition = document.getElementById('field-condition').value;
    const dc = document.getElementById('field-dealer').value.trim();
    const isNew = document.getElementById('field-new').checked;
    const isHold = document.getElementById('field-hold').checked;
    const isSold = document.getElementById('field-sold').checked;

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
        size,
        category,
        maker,
        condition,
        dealerCode: dc,
        isNew: isSold ? false : isNew,
        isHold: isSold ? false : isHold,
        isSold,
        images: uploadedImages,
        heroImage: uploadedImages[0] || '',
        order: editingId ? (items.find(i => i.id === editingId)?.order ?? 0) : 0,
        createdAt: editingId ? (items.find(i => i.id === editingId)?.createdAt) : new Date().toISOString()
      };

      if (editingId) {
        items = items.map(i => i.id === editingId ? itemData : i);
      } else {
        // Push existing items down so the new one appears first
        items.forEach(i => { i.order = (i.order ?? 0) + 1; });
        items.push(itemData);
      }

      // Sort so new item (order 0) appears at top immediately
      items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

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

  // --- Analytics ---

  const catLabels = {
    'wall-art': 'Wall Art', 'object': 'Object', 'ceramic': 'Ceramic',
    'furniture': 'Furniture', 'light': 'Light', 'sculpture': 'Sculpture', 'misc': 'Misc'
  };

  async function supaSelect(params) {
    if (!supaUrl || !supaKey) return [];
    const url = `${supaUrl}/rest/v1/events?${params}`;
    const res = await fetch(url, {
      headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
    });
    if (!res.ok) return [];
    return res.json();
  }

  function daysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10) + 'T00:00:00Z';
  }

  function pctChange(cur, prev) {
    if (prev === 0 && cur === 0) return { t: '—', c: 'flat' };
    if (prev === 0) return { t: '\u2191 new', c: 'up' };
    const p = Math.round((cur - prev) / prev * 100);
    if (p === 0) return { t: '—', c: 'flat' };
    if (p > 0) return { t: '\u2191 ' + p + '%', c: 'up' };
    return { t: '\u2193 ' + Math.abs(p) + '%', c: 'down' };
  }

  async function loadAnalytics() {
    const body = document.getElementById('analytics-body');

    if (!supaUrl || !supaKey) {
      body.innerHTML = '<div class="analytics-empty">Add your Supabase URL and Service Key in Settings to enable analytics.</div>';
      return;
    }

    body.innerHTML = '<div class="analytics-loading"><span class="spinner"></span> Loading...</div>';

    try {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const yest = new Date(now); yest.setDate(now.getDate() - 1);
      const yesterdayStr = yest.toISOString().slice(0, 10);
      const dow = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
      const weekStr = mon.toISOString().slice(0, 10);
      const lastMon = new Date(mon); lastMon.setDate(mon.getDate() - 7);
      const lastWeekStr = lastMon.toISOString().slice(0, 10);

      const range = analyticsRange;
      const pvDays = Math.max(14, range);

      // 3 efficient parallel queries
      const [pageViews, itemEvents] = await Promise.all([
        supaSelect(`select=session_id,created_at,referrer,utm_source,ua_mobile&event=eq.page_view&created_at=gte.${daysAgoStr(pvDays)}&order=created_at.asc&limit=50000`),
        supaSelect(`select=item_id,event&event=in.(item_view,inquire)&created_at=gte.${daysAgoStr(range)}&item_id=not.is.null&limit=50000`)
      ]);

      // Pre-process timestamps
      pageViews.forEach(r => { r._ts = new Date(r.created_at).getTime(); });

      const msOf = s => new Date(s + 'T00:00:00Z').getTime();
      const todayMs = msOf(todayStr), yesterdayMs = msOf(yesterdayStr);
      const weekMs = msOf(weekStr), lastWeekMs = msOf(lastWeekStr);
      const rangeMs = new Date(daysAgoStr(range)).getTime();

      const pvBetween = (s, e) => pageViews.filter(r => r._ts >= s && (!e || r._ts < e));

      const todayPV = pvBetween(todayMs);
      const yesterdayPV = pvBetween(yesterdayMs, todayMs);
      const weekPV = pvBetween(weekMs);
      const lastWeekPV = pvBetween(lastWeekMs, weekMs);
      const rangePV = pvBetween(rangeMs);

      // Summary cards
      const todayViews = todayPV.length;
      const todayUniques = new Set(todayPV.map(r => r.session_id)).size;
      const weekViews = weekPV.length;
      const weekUniques = new Set(weekPV.map(r => r.session_id)).size;
      const todayDelta = pctChange(todayViews, yesterdayPV.length);
      const weekDelta = pctChange(weekViews, lastWeekPV.length);

      // 14-day sparkline
      const sparkDays = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now); d.setDate(now.getDate() - i);
        const ds = d.toISOString().slice(0, 10);
        const s = msOf(ds), e = s + 86400000;
        sparkDays.push({
          day: d.toLocaleDateString('en', { weekday: 'narrow' }),
          count: pageViews.filter(r => r._ts >= s && r._ts < e).length,
          isToday: i === 0
        });
      }
      const sparkMax = Math.max(1, ...sparkDays.map(d => d.count));

      // Conversion funnel
      const funnelVisitors = new Set(rangePV.map(r => r.session_id)).size;
      const funnelViews = itemEvents.filter(r => r.event === 'item_view').length;
      const funnelInquiries = itemEvents.filter(r => r.event === 'inquire').length;
      const fvMax = Math.max(1, funnelVisitors);

      // Top items
      const ivCounts = {}, iqCounts = {};
      itemEvents.forEach(r => {
        if (r.event === 'item_view') ivCounts[r.item_id] = (ivCounts[r.item_id] || 0) + 1;
        if (r.event === 'inquire') iqCounts[r.item_id] = (iqCounts[r.item_id] || 0) + 1;
      });
      const topList = Object.entries(ivCounts)
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([id, v]) => ({ id, views: v, inq: iqCounts[id] || 0, item: items.find(i => i.id === id) }));

      // Category popularity
      const catCounts = {};
      itemEvents.filter(r => r.event === 'item_view').forEach(r => {
        const it = items.find(i => i.id === r.item_id);
        if (it && it.category) {
          const lbl = catLabels[it.category] || it.category;
          catCounts[lbl] = (catCounts[lbl] || 0) + 1;
        }
      });
      const totalCat = Object.values(catCounts).reduce((a, b) => a + b, 0) || 1;
      const sortedCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);

      // Traffic sources
      const sources = {};
      rangePV.forEach(r => {
        let src = 'Direct';
        if (r.utm_source) {
          src = r.utm_source.charAt(0).toUpperCase() + r.utm_source.slice(1);
        } else if (r.referrer) {
          try {
            const h = new URL(r.referrer).hostname.replace('www.', '');
            src = h.split('.')[0].charAt(0).toUpperCase() + h.split('.')[0].slice(1);
          } catch { src = 'Other'; }
        }
        sources[src] = (sources[src] || 0) + 1;
      });
      const totalSrc = rangePV.length || 1;
      const sortedSrc = Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 5);

      // Devices
      const mob = rangePV.filter(r => r.ua_mobile).length;
      const desk = rangePV.length - mob;
      const totalDev = rangePV.length || 1;

      const rl = range + 'd';

      // --- Render ---
      body.innerHTML = `
        <div class="analytics-cards">
          <div class="analytics-card">
            <div class="analytics-card-label">Today</div>
            <div class="analytics-card-value">${todayViews}</div>
            <div class="analytics-card-sub">${todayUniques} unique${todayUniques !== 1 ? 's' : ''}</div>
            <div class="analytics-card-change change-${todayDelta.c}">${todayDelta.t}</div>
          </div>
          <div class="analytics-card">
            <div class="analytics-card-label">This Week</div>
            <div class="analytics-card-value">${weekViews}</div>
            <div class="analytics-card-sub">${weekUniques} unique${weekUniques !== 1 ? 's' : ''}</div>
            <div class="analytics-card-change change-${weekDelta.c}">${weekDelta.t}</div>
          </div>
        </div>

        <div class="analytics-section">
          <div class="analytics-section-title">Daily Views <span class="analytics-dim">14 days</span></div>
          <div class="sparkline">
            ${sparkDays.map(d => `
              <div class="sparkline-col">
                <div class="sparkline-bar${d.isToday ? ' today' : ''}" style="height:${Math.max(4, Math.round(d.count / sparkMax * 100))}%"></div>
                <span class="sparkline-day">${d.day}</span>
              </div>
            `).join('')}
          </div>
        </div>

        ${funnelVisitors > 0 ? `
        <div class="analytics-section">
          <div class="analytics-section-title">Conversion Funnel <span class="analytics-dim">${rl}</span></div>
          <div class="funnel">
            <div class="funnel-row">
              <div class="funnel-bar" style="width:100%"></div>
              <span class="funnel-label"><span class="funnel-count">${funnelVisitors}</span> visitors</span>
            </div>
            <div class="funnel-row">
              <div class="funnel-bar" style="width:${Math.max(3, Math.round(funnelViews / fvMax * 100))}%"></div>
              <span class="funnel-label"><span class="funnel-count">${funnelViews}</span> item views <span class="funnel-pct">${Math.round(funnelViews / fvMax * 100)}%</span></span>
            </div>
            <div class="funnel-row">
              <div class="funnel-bar funnel-accent" style="width:${Math.max(3, Math.round(funnelInquiries / fvMax * 100))}%"></div>
              <span class="funnel-label"><span class="funnel-count">${funnelInquiries}</span> inquiries <span class="funnel-pct">${funnelVisitors > 0 ? Math.round(funnelInquiries / funnelVisitors * 100) : 0}%</span></span>
            </div>
          </div>
        </div>
        ` : ''}

        <div class="analytics-card analytics-card-full">
          <div class="analytics-card-label">Inquiries</div>
          <div class="analytics-card-value">${funnelInquiries}</div>
          <div class="analytics-card-sub">last ${rl}</div>
        </div>

        ${topList.length > 0 ? `
        <div class="analytics-section">
          <div class="analytics-section-title">Most Viewed <span class="analytics-dim">${rl}</span></div>
          ${topList.map(t => {
            const thumb = t.item ? (t.item.heroImage || (t.item.images && t.item.images[0]) || '') : '';
            const imgHtml = thumb ? `<img src="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${thumb}" alt="">` : '';
            const title = t.item ? esc(t.item.title || 'Untitled') : formatId(t.id);
            return `
              <div class="analytics-item">
                <div class="item-thumb">${imgHtml}</div>
                <div class="analytics-item-info">
                  <div class="analytics-item-title">${title}</div>
                  <div class="analytics-item-stats">${t.views} view${t.views !== 1 ? 's' : ''}${t.inq > 0 ? ` \u00b7 ${t.inq} inq` : ''}</div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
        ` : ''}

        ${sortedCats.length > 0 ? `
        <div class="analytics-section">
          <div class="analytics-section-title">Popular Categories <span class="analytics-dim">${rl}</span></div>
          ${sortedCats.map(([cat, count]) => `
            <div class="analytics-bar-row">
              <span class="analytics-bar-label">${esc(cat)}</span>
              <div class="analytics-bar-track">
                <div class="analytics-bar-fill" style="width:${Math.round(count / totalCat * 100)}%"></div>
              </div>
              <span class="analytics-bar-pct">${Math.round(count / totalCat * 100)}%</span>
            </div>
          `).join('')}
        </div>
        ` : ''}

        <div class="analytics-section">
          <div class="analytics-section-title">Traffic Sources <span class="analytics-dim">${rl}</span></div>
          ${sortedSrc.length > 0 ? sortedSrc.map(([src, count]) => `
            <div class="analytics-bar-row">
              <span class="analytics-bar-label">${esc(src)}</span>
              <div class="analytics-bar-track">
                <div class="analytics-bar-fill" style="width:${Math.round(count / totalSrc * 100)}%"></div>
              </div>
              <span class="analytics-bar-pct">${Math.round(count / totalSrc * 100)}%</span>
            </div>
          `).join('') : '<div class="analytics-empty-small">No data yet</div>'}
        </div>

        <div class="analytics-section">
          <div class="analytics-section-title">Devices <span class="analytics-dim">${rl}</span></div>
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">Mobile</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round(mob / totalDev * 100)}%"></div>
            </div>
            <span class="analytics-bar-pct">${Math.round(mob / totalDev * 100)}%</span>
          </div>
          <div class="analytics-bar-row">
            <span class="analytics-bar-label">Desktop</span>
            <div class="analytics-bar-track">
              <div class="analytics-bar-fill" style="width:${Math.round(desk / totalDev * 100)}%"></div>
            </div>
            <span class="analytics-bar-pct">${Math.round(desk / totalDev * 100)}%</span>
          </div>
        </div>

      `;
    } catch (e) {
      body.innerHTML = `<div class="analytics-empty">Error loading analytics: ${esc(e.message)}</div>`;
    }
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
    return !isNaN(n) ? 'A' + String(n).padStart(6, '0') : 'A' + id;
  }

  function toTitleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  // Convert data URL to lightweight blob URL for display (avoids MB of base64 in DOM)
  function toBlobUrl(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    try {
      const parts = dataUrl.split(',');
      const mime = parts[0].match(/:(.*?);/)[1];
      const binary = atob(parts[1]);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([array], { type: mime }));
    } catch {
      return null;
    }
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

  // --- Marketing ---

  document.getElementById('btn-marketing-back').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname);
    showView('list');
  });

  async function loadMarketing() {
    if (!supaUrl || !supaKey) {
      document.getElementById('email-empty').style.display = '';
      document.getElementById('dc-empty').style.display = '';
      return;
    }
    loadEmails();
    loadDiscountCodes();
  }

  async function loadEmails() {
    try {
      const res = await fetch(`${supaUrl}/rest/v1/emails?select=email,source,discount_code,created_at&order=created_at.desc&limit=500`, {
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
      });
      const emails = await res.json();
      const tbody = document.getElementById('email-tbody');
      const countEl = document.getElementById('email-count');
      const emptyEl = document.getElementById('email-empty');
      const tableWrap = document.getElementById('email-table-wrap');

      if (!emails.length) {
        emptyEl.style.display = '';
        tableWrap.style.display = 'none';
        countEl.textContent = '';
        return;
      }

      emptyEl.style.display = 'none';
      tableWrap.style.display = '';
      countEl.textContent = `${emails.length} subscriber${emails.length !== 1 ? 's' : ''}`;

      tbody.innerHTML = emails.map(e => {
        const date = new Date(e.created_at).toLocaleDateString();
        return `<tr><td>${esc(e.email)}</td><td>${esc(e.source)}</td><td>${date}</td></tr>`;
      }).join('');

      // CSV export
      document.getElementById('btn-export-csv').onclick = () => {
        const rows = [['Email', 'Source', 'Discount Code', 'Date']];
        emails.forEach(e => {
          rows.push([e.email, e.source, e.discount_code || '', new Date(e.created_at).toLocaleDateString()]);
        });
        const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ol-emails-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
      };
    } catch (e) {
      document.getElementById('email-empty').style.display = '';
      document.getElementById('email-empty').textContent = 'Failed to load emails.';
    }
  }

  async function loadDiscountCodes() {
    try {
      const res = await fetch(`${supaUrl}/rest/v1/discount_codes?select=id,code,type,value,is_active,max_uses,used_count,created_at&order=created_at.desc`, {
        headers: { 'apikey': supaKey, 'Authorization': 'Bearer ' + supaKey }
      });
      const codes = await res.json();
      const listEl = document.getElementById('dc-list');
      const emptyEl = document.getElementById('dc-empty');

      if (!codes.length) {
        emptyEl.style.display = '';
        listEl.innerHTML = '';
        return;
      }

      emptyEl.style.display = 'none';
      listEl.innerHTML = codes.map(dc => {
        const discountLabel = dc.type === 'percent' ? `${dc.value}% off` : `$${dc.value} off`;
        const usesLabel = dc.max_uses ? `${dc.used_count}/${dc.max_uses} uses` : `${dc.used_count} uses`;
        return `
          <div class="dc-row">
            <span class="dc-code">${esc(dc.code)}</span>
            <span class="dc-info">${discountLabel} &middot; ${usesLabel}</span>
            <button class="dc-toggle ${dc.is_active ? 'active' : ''}" data-id="${dc.id}" data-active="${dc.is_active}"></button>
          </div>`;
      }).join('');

      // Toggle active/inactive
      listEl.querySelectorAll('.dc-toggle').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const newActive = btn.dataset.active !== 'true';
          btn.disabled = true;
          try {
            await fetch(`${supaUrl}/rest/v1/discount_codes?id=eq.${id}`, {
              method: 'PATCH',
              headers: {
                'apikey': supaKey,
                'Authorization': 'Bearer ' + supaKey,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({ is_active: newActive })
            });
            btn.dataset.active = String(newActive);
            btn.classList.toggle('active', newActive);
          } catch {
            toast('Failed to update');
          }
          btn.disabled = false;
        });
      });
    } catch {
      document.getElementById('dc-empty').style.display = '';
      document.getElementById('dc-empty').textContent = 'Failed to load codes.';
    }
  }

  // Create discount code
  document.getElementById('dc-random').addEventListener('click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById('dc-code').value = code;
  });

  document.getElementById('dc-create').addEventListener('click', async () => {
    const code = document.getElementById('dc-code').value.trim().toUpperCase();
    const type = document.getElementById('dc-type').value;
    const value = parseFloat(document.getElementById('dc-value').value);
    const maxUses = document.getElementById('dc-max').value ? parseInt(document.getElementById('dc-max').value) : null;

    if (!code || !value || value <= 0) { toast('Code and value required'); return; }
    if (!supaUrl || !supaKey) { toast('Supabase not configured'); return; }

    const btn = document.getElementById('dc-create');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const res = await fetch(`${supaUrl}/rest/v1/discount_codes`, {
        method: 'POST',
        headers: {
          'apikey': supaKey,
          'Authorization': 'Bearer ' + supaKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ code, type, value, max_uses: maxUses })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Create failed');
      }

      toast('Code created');
      document.getElementById('dc-code').value = '';
      document.getElementById('dc-value').value = '';
      document.getElementById('dc-max').value = '';
      loadDiscountCodes();
    } catch (e) {
      toast(e.message || 'Failed to create code');
    }

    btn.disabled = false;
    btn.textContent = 'Create Code';
  });

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
