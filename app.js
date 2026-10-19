window.PF = window.PF || {};

// PF.app: shared UI helpers, app state, tab routing, the Settings tab and the Poster tab.
// The Pieces tab lives in app-pieces.js and the Find tab in app-find.js; they register views here.
PF.app = (function () {
  'use strict';

  const VERSION = 'v0.1';
  const MAX_PHOTO = 1600;     // long edge for group photos and spot photos
  const MAX_POSTER = 2400;    // long edge for the stored poster

  const state = {
    tab: 'find',
    hole: null,            // { blob, canvas } — photo of the empty spot (in memory only)
    spot: null,            // { cx, cy, frac, cropCanvas, cropBlob } — spot picked on the poster
    selectedGroupIds: null, // Set of group ids, or null = all groups
    results: null,         // last search results (see app-find.js)
    review: null,          // detection review in progress (see app-pieces.js)
    groupDetailId: null,   // open group in the Pieces tab
    busy: false,
  };
  const views = {};        // tab name → function returning an Element (or a Promise of one)
  let urls = [];           // object URLs made for the current render; revoked on the next render
  let renderId = 0;

  // Builds an element: h('div', {class:'x', onclick: fn}, child, ...). Children may be strings, nodes, arrays or null.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    };
    children.forEach(add);
    return el;
  }

  // Shows a short message at the top. kind: 'info' | 'error' | 'ok'.
  let toastTimer = 0;
  function toast(msg, kind = 'info') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast ' + kind;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3500);
  }

  // Updates the status line of the current view (an element with id="status"), if there is one.
  function setStatus(text, spinning) {
    const el = document.getElementById('status');
    if (!el) return;
    el.replaceChildren(spinning ? h('span', { class: 'spinner' }) : null, text || '');
  }

  // Opens the camera (default) or the photo library picker. Resolves with the chosen File, or null when the person cancels.
  function pickPhoto(opts) {
    const input = document.getElementById(opts && opts.library ? 'file-lib' : 'file');
    return new Promise((resolve) => {
      const done = (file) => { input.onchange = null; input.oncancel = null; resolve(file || null); };
      input.value = '';
      input.onchange = () => done(input.files && input.files[0]);
      input.oncancel = () => done(null);
      input.click();
    });
  }

  // Loads a photo file into a canvas no larger than maxLongEdge.
  async function loadPhoto(file, maxLongEdge) {
    const img = await PF.img.loadFile(file);
    const canvas = PF.img.toCanvas(img, maxLongEdge || MAX_PHOTO);
    if (img.close) img.close();
    return canvas;
  }

  // Makes an object URL for a blob; it is revoked at the next render.
  function blobUrl(blob) {
    const u = URL.createObjectURL(blob);
    urls.push(u);
    return u;
  }

  // Two-step confirmation for destructive actions.
  function confirm2(first, second) {
    return window.confirm(first) && (!second || window.confirm(second));
  }

  function fmtInt(n) { return Number(n || 0).toLocaleString('en-US'); }

  // Redraws the active tab from state.
  async function render() {
    const id = ++renderId;
    const view = document.getElementById('view');
    const fn = views[state.tab];
    let el;
    try {
      el = await fn();
    } catch (err) {
      el = h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, err.message || String(err)));
    }
    if (id !== renderId) return;            // a newer render already replaced this one
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    view.replaceChildren(el);
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    window.scrollTo(0, 0);
  }

  function setTab(tab) {
    state.tab = tab;
    render();
  }

  // ---------------------------------------------------------------------------
  // Settings tab
  // ---------------------------------------------------------------------------
  function renderSettings() {
    const s = PF.settings.get();
    const key = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: 'sk-ant-…', value: s.apiKey || '',
      onchange: (e) => { PF.settings.set({ apiKey: e.target.value }); } });
    const show = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => {
      key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const model = h('select', { onchange: (e) => PF.settings.set({ model: e.target.value }) },
      PF.api.MODELS.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.label)));
    const topN = h('input', { type: 'number', min: '5', max: '12', step: '1', value: String(s.topN || 8),
      onchange: (e) => { const v = Math.min(12, Math.max(5, parseInt(e.target.value, 10) || 8)); e.target.value = v; PF.settings.set({ topN: v }); } });
    const testBtn = h('button', { type: 'button', class: 'btn', onclick: async () => {
      PF.settings.set({ apiKey: key.value });
      testBtn.disabled = true; setStatus('Testing the key…', true);
      try { await PF.api.testKey({ apiKey: key.value, model: model.value }); toast('Key works', 'ok'); setStatus(''); }
      catch (err) { toast(err.message, 'error'); setStatus(''); }
      testBtn.disabled = false;
    } }, 'Test key');
    const clearBtn = h('button', { type: 'button', class: 'btn btn-danger', onclick: async () => {
      if (!confirm2('Delete the poster, all groups and all pieces on this phone?', 'Really delete everything? This cannot be undone.')) return;
      await PF.db.clearAll();
      state.hole = null; state.spot = null; state.results = null; state.review = null; state.groupDetailId = null; state.selectedGroupIds = null;
      toast('All data deleted', 'ok'); render();
    } }, 'Clear all data');

    return h('div', {},
      h('h1', {}, 'Settings'),
      !s.apiKey ? h('div', { class: 'hint', style: { marginBottom: '12px' } }, 'Paste your Claude API key to start. The README explains how to get one.') : null,
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', {}, 'Claude API key'), h('div', { class: 'row' }, h('div', { style: { flex: '1' } }, key), show)),
        h('label', { class: 'field' }, h('span', {}, 'Model'), model),
        h('label', { class: 'field' }, h('span', {}, 'Candidates to show (5–12)'), topN),
        h('div', { class: 'row' }, testBtn),
        h('div', { id: 'status', class: 'status' }),
        h('p', { class: 'muted small' }, 'Keys are stored only on this phone.')),
      h('div', { class: 'card help' },
        h('h2', {}, 'How to take photos'),
        h('ul', {},
          h('li', {}, 'Use a plain background that contrasts with the pieces: white paper for dark pieces, a dark cloth for light pieces.'),
          h('li', {}, 'Shoot from straight above, in even light, without harsh shadows.'),
          h('li', {}, 'Pieces must not touch each other. Picture side up.'),
          h('li', {}, 'Up to about 36 pieces per photo.'),
          h('li', {}, 'For the spot: fill the frame with the hole and its neighbors.'))),
      h('div', { class: 'card' }, clearBtn, h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'Piece Finder ' + VERSION)));
  }

  // ---------------------------------------------------------------------------
  // Poster tab
  // ---------------------------------------------------------------------------
  async function renderPoster() {
    const poster = await PF.db.get('meta', 'poster');
    const addBtn = h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: async () => {
      const file = await pickPhoto({ library: true });   // lets the person pick an existing photo of the poster
      if (!file) return;
      try {
        setStatus('Saving the poster…', true);
        const canvas = await loadPhoto(file, MAX_POSTER);
        const blob = await PF.img.canvasToBlob(canvas, 'image/jpeg', 0.9);
        await PF.db.put('meta', { key: 'poster', blob, w: canvas.width, h: canvas.height });
        state.spot = null;
        toast('Poster saved', 'ok');
        render();
      } catch (err) { toast(err.message, 'error'); setStatus(''); }
    } }, poster ? 'Replace poster' : 'Add poster photo');

    return h('div', {},
      h('h1', {}, 'Poster'),
      poster
        ? h('div', { class: 'card' }, h('img', { class: 'preview', src: blobUrl(poster.blob), alt: 'Poster' }),
            h('p', { class: 'muted small', style: { marginTop: '8px' } }, `${poster.w} × ${poster.h} px`))
        : h('div', { class: 'card' }, h('p', {}, 'The poster is the picture of the finished puzzle.'),
            h('p', { class: 'muted' }, 'Photograph the whole poster straight on, in good light.')),
      h('div', { class: 'card' }, addBtn, h('div', { id: 'status', class: 'status' })));
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------
  async function init() {
    views.settings = renderSettings;
    views.poster = renderPoster;
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    try { await PF.db.open(); await PF.db.requestPersist(); }
    catch (err) { toast('Storage is not available: ' + err.message, 'error'); }
    if (!PF.settings.get().apiKey) state.tab = 'settings';
    render();
  }

  return { state, views, h, toast, setStatus, pickPhoto, loadPhoto, blobUrl, confirm2, fmtInt, render, setTab, init, VERSION, MAX_PHOTO };
})();
