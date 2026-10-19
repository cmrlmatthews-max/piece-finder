window.PF = window.PF || {};

/*
 * PF.poster - full-screen "tap the empty spot" picker (SPEC section 7).
 *   PF.poster.pick({ posterCanvas, initial }) -> Promise<{ cx, cy, frac, cropCanvas } | null>
 *
 * The poster is drawn on a base canvas once per zoom level. The marker (crosshair + square) is drawn
 * on a second canvas layered on top, so a tap or a slider move only repaints a small marker area.
 * This file is ASCII only on purpose (the multiplication sign comes from String.fromCharCode).
 */
(function () {
  'use strict';

  var STYLE_ID = 'pf-poster-style';
  var ZOOMS = [1, 2, 4];
  var TIMES = String.fromCharCode(0xd7);   // the multiplication sign used in "2x" labels
  var DEFAULT_ZOOM = 2;
  var FRAC_MIN = 0.04;         // spot size range, as a fraction of the poster width
  var FRAC_MAX = 0.25;
  var FRAC_DEFAULT = 0.1;
  var TAP_SLOP = 8;            // a tap may move less than this many CSS px
  var STALE_MS = 1500;         // a pointer that went down this long ago and never came up is treated as lost
  var MAX_CANVAS_SIDE = 4096;  // iOS Safari canvas safety limit
  var CROP_MAX_EDGE = 1000;    // long edge of the returned crop
  var MARK_COLOR = '#ffd400';
  var MARK_WIDTH = 3;          // CSS px
  var HALO_COLOR = 'rgba(0,0,0,0.7)';
  var HALO_EXTRA = 3;          // the dark halo is this much wider than the yellow line
  var CROSS_GAP = 5;           // CSS px left empty around the exact center
  var CROSS_ARM = 18;          // CSS px from the center to the end of each crosshair arm
  var active = null;           // the picker that is open right now, if any

  var CSS = `
.pf-poster-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:10000;display:flex;flex-direction:column;
  background:#111;color:#eee;font:16px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;
  overscroll-behavior:none;color-scheme:dark}
.pf-poster-overlay,.pf-poster-overlay *{box-sizing:border-box}
.pf-poster-overlay .pf-poster-bar{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px;
  padding-top:calc(8px + env(safe-area-inset-top));padding-left:calc(10px + env(safe-area-inset-left));
  padding-right:calc(10px + env(safe-area-inset-right));background:#1b1b1b;border-bottom:1px solid #333;touch-action:none}
.pf-poster-overlay .pf-poster-title{flex:1 1 auto;min-width:0;margin:0;padding:0;font-size:15px;font-weight:600;
  line-height:1.15;text-align:center;color:#eee;text-wrap:balance}
.pf-poster-overlay .pf-poster-bar .pf-poster-btn{padding:0 12px;font-size:15px}
.pf-poster-overlay .pf-poster-btn{flex:none;width:auto;max-width:none;height:auto;min-height:48px;min-width:48px;margin:0;
  padding:0 16px;border:1px solid #444;border-radius:10px;background:#2a2a2a;color:#eee;font:inherit;font-weight:600;
  line-height:1.1;letter-spacing:normal;text-transform:none;text-align:center;box-shadow:none;
  -webkit-appearance:none;appearance:none;cursor:pointer;touch-action:manipulation}
.pf-poster-overlay .pf-poster-btn:active{background:#3b3b3b}
.pf-poster-overlay .pf-poster-btn:focus-visible{outline:3px solid #ffd400;outline-offset:2px}
.pf-poster-overlay .pf-poster-use{background:#ffd400;border-color:#ffd400;color:#111}
.pf-poster-overlay .pf-poster-use:active{background:#e6bf00}
.pf-poster-overlay .pf-poster-btn:disabled{background:#242424;border-color:#333;color:#777;cursor:default}
.pf-poster-overlay .pf-poster-pan{flex:1 1 auto;min-height:0;display:flex;overflow:auto;-webkit-overflow-scrolling:touch;
  overscroll-behavior:contain;touch-action:pan-x pan-y;background:#0a0a0a;scrollbar-gutter:stable;scrollbar-color:#666 #1a1a1a}
.pf-poster-overlay .pf-poster-stage{position:relative;flex:none;margin:auto;cursor:crosshair}
.pf-poster-overlay .pf-poster-stage canvas{position:absolute;top:0;left:0;display:block;width:100%;height:100%;
  max-width:none;max-height:none;margin:0;padding:0;border:0;pointer-events:none}
.pf-poster-overlay .pf-poster-controls{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;
  padding:8px 12px calc(8px + env(safe-area-inset-bottom));padding-left:calc(12px + env(safe-area-inset-left));
  padding-right:calc(12px + env(safe-area-inset-right));background:#1b1b1b;border-top:1px solid #333;touch-action:none}
.pf-poster-overlay .pf-poster-zoom{flex:1 1 180px;display:flex;gap:6px}
.pf-poster-overlay .pf-poster-zoom .pf-poster-btn{flex:1 1 0;min-width:56px;padding:0 10px}
.pf-poster-overlay .pf-poster-zoom .pf-poster-btn[aria-pressed="true"]{background:#2f2a10;border:2px solid #ffd400;color:#ffd400}
.pf-poster-overlay .pf-poster-size{flex:1 1 220px;min-width:0;display:flex;align-items:center;gap:10px;margin:0}
.pf-poster-overlay .pf-poster-size-text{flex:none;font-weight:600}
.pf-poster-overlay .pf-poster-size-out{flex:none;min-width:3em;text-align:right;font-variant-numeric:tabular-nums}
.pf-poster-overlay .pf-poster-slider{-webkit-appearance:none;appearance:none;flex:1 1 auto;min-width:0;width:100%;height:48px;
  margin:0;padding:0;border:0;background:transparent;cursor:pointer}
.pf-poster-overlay .pf-poster-slider::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:#555}
.pf-poster-overlay .pf-poster-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;box-sizing:border-box;
  width:40px;height:40px;margin-top:-17px;border-radius:50%;border:3px solid #111;background:#ffd400;box-shadow:0 0 0 1px #ffd400}
.pf-poster-overlay .pf-poster-slider::-moz-range-track{height:6px;border-radius:3px;background:#555}
.pf-poster-overlay .pf-poster-slider::-moz-range-thumb{box-sizing:border-box;width:40px;height:40px;border-radius:50%;
  border:3px solid #111;background:#ffd400}
@media (max-width:379px){
  .pf-poster-overlay .pf-poster-bar{flex-wrap:wrap}
  .pf-poster-overlay .pf-poster-title{order:-1;flex:1 1 100%}
  .pf-poster-overlay .pf-poster-bar .pf-poster-btn{flex:1 1 0}
}`;

  // ---------------------------------------------------------------- small helpers

  /* Adds the overlay CSS to <head> once. */
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* Returns v limited to the range lo..hi. */
  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  /* Creates an element with an optional class name and text. */
  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* Adds an event listener and remembers it, so teardown() can remove every one. */
  function listen(s, target, type, fn) {
    target.addEventListener(type, fn);
    s.listeners.push({ target: target, type: type, fn: fn });
  }

  // ---------------------------------------------------------------- DOM and state

  /* Builds the overlay DOM and returns references to the parts we need later. */
  function buildDom() {
    var root = make('div', 'pf-poster-overlay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Pick the empty spot on the poster');

    var cancel = make('button', 'pf-poster-btn pf-poster-cancel', 'Cancel');
    var title = make('h2', 'pf-poster-title', 'Tap the empty spot');
    var use = make('button', 'pf-poster-btn pf-poster-use', 'Use this spot');
    cancel.type = 'button';
    use.type = 'button';
    use.disabled = true;
    var bar = make('div', 'pf-poster-bar');
    bar.append(cancel, title, use);

    var base = make('canvas', 'pf-poster-base');
    var marker = make('canvas', 'pf-poster-marker');
    var stage = make('div', 'pf-poster-stage');
    stage.append(base, marker);
    var pan = make('div', 'pf-poster-pan');
    pan.append(stage);

    var zoomBox = make('div', 'pf-poster-zoom');
    zoomBox.setAttribute('role', 'group');
    zoomBox.setAttribute('aria-label', 'Zoom');
    var zoomBtns = ZOOMS.map(function (z) {
      var b = make('button', 'pf-poster-btn', z + TIMES);
      b.type = 'button';
      b.setAttribute('data-zoom', String(z));
      zoomBox.append(b);
      return b;
    });

    var slider = make('input', 'pf-poster-slider');
    slider.type = 'range';
    slider.min = String(FRAC_MIN * 100);
    slider.max = String(FRAC_MAX * 100);
    slider.step = '1';
    slider.value = String(FRAC_DEFAULT * 100);
    var out = make('output', 'pf-poster-size-out', '');
    var size = make('label', 'pf-poster-size');
    size.append(make('span', 'pf-poster-size-text', 'Spot size'), slider, out);
    var controls = make('div', 'pf-poster-controls');
    controls.append(zoomBox, size);

    root.append(bar, pan, controls);
    return { root: root, cancel: cancel, use: use, pan: pan, stage: stage, base: base, marker: marker,
             zoomBtns: zoomBtns, slider: slider, out: out };
  }

  /* Creates the picker state from the pick() options (poster size, start zoom, start spot). */
  function newState(opts, els, resolve, reject) {
    var poster = opts.posterCanvas;
    var s = {
      poster: poster, W: poster.width, H: poster.height, els: els, resolve: resolve, reject: reject,
      zoom: DEFAULT_ZOOM, frac: FRAC_DEFAULT, cx: 0, cy: 0, has: false,
      containerW: 0, L: null, dirty: null, tap: null,
      listeners: [], resizeTimer: 0, done: false, prevOverflow: ''
    };
    var init = opts.initial;
    if (init && Number.isFinite(init.frac)) s.frac = clamp(init.frac, FRAC_MIN, FRAC_MAX);
    if (init && Number.isFinite(init.cx) && Number.isFinite(init.cy)) {
      s.cx = clamp(Math.round(init.cx), 0, s.W);
      s.cy = clamp(Math.round(init.cy), 0, s.H);
      s.has = true;
    }
    return s;
  }

  /* Shows the current zoom, size and button state in the controls. */
  function syncControls(s) {
    syncZoomButtons(s);
    var pct = Math.round(s.frac * 100);
    s.els.slider.value = String(pct);
    s.els.out.textContent = pct + '%';
    s.els.use.disabled = !s.has;
  }

  /* Marks the active zoom button. */
  function syncZoomButtons(s) {
    s.els.zoomBtns.forEach(function (b) {
      b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-zoom')) === s.zoom));
    });
  }

  // ---------------------------------------------------------------- layout and drawing

  /* Returns the usable width of the pan area in CSS px. */
  function measureWidth(s) {
    return Math.max(160, s.els.pan.clientWidth || window.innerWidth || 320);
  }

  /* Works out the CSS size (containerWidth * zoom) and the canvas pixel size (never above the poster or 4096). */
  function computeLayout(s) {
    var cssW = s.containerW * s.zoom;
    var cssH = cssW * s.H / s.W;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var bw = Math.min(cssW * dpr, s.W);
    var bh = bw * s.H / s.W;
    var shrink = Math.min(1, MAX_CANVAS_SIDE / Math.max(bw, bh));
    return { cssW: cssW, cssH: cssH,
             bw: Math.max(1, Math.round(bw * shrink)), bh: Math.max(1, Math.round(bh * shrink)) };
  }

  /* Draws src into ctx at 0,0 sized dw x dh. Big reductions go in halving steps for a cleaner picture. */
  function drawScaled(ctx, src, dw, dh) {
    var cur = src;
    var temps = [];
    while (cur.width / 2 >= dw && cur.height / 2 >= dh) {
      var t = document.createElement('canvas');
      t.width = Math.ceil(cur.width / 2);
      t.height = Math.ceil(cur.height / 2);
      var tg = t.getContext('2d');
      tg.imageSmoothingQuality = 'high';
      tg.drawImage(cur, 0, 0, t.width, t.height);
      temps.push(t);
      cur = t;
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, dw, dh);
    temps.forEach(function (t) { t.width = 0; t.height = 0; });  // free canvas memory early (iOS)
  }

  /* Sizes the stage and both canvases for the current zoom, then redraws the poster and the marker. */
  function applyLayout(s) {
    var L = computeLayout(s);
    s.L = L;
    s.els.stage.style.width = L.cssW + 'px';
    s.els.stage.style.height = L.cssH + 'px';
    s.els.base.width = L.bw;            // setting the size also clears the canvas
    s.els.base.height = L.bh;
    drawScaled(s.els.base.getContext('2d'), s.poster, L.bw, L.bh);
    s.els.marker.width = L.bw;
    s.els.marker.height = L.bh;
    s.dirty = null;
    drawMarker(s);
  }

  /* Strokes the dark halo and then the yellow square + crosshair, in CSS px (x, y = center, half = half side). */
  function strokeMarks(ctx, x, y, half) {
    var passes = [[HALO_COLOR, MARK_WIDTH + HALO_EXTRA], [MARK_COLOR, MARK_WIDTH]];
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    passes.forEach(function (p) {
      ctx.strokeStyle = p[0];
      ctx.lineWidth = p[1];
      ctx.strokeRect(x - half, y - half, half * 2, half * 2);
      ctx.beginPath();
      ctx.moveTo(x - CROSS_ARM, y); ctx.lineTo(x - CROSS_GAP, y);
      ctx.moveTo(x + CROSS_GAP, y); ctx.lineTo(x + CROSS_ARM, y);
      ctx.moveTo(x, y - CROSS_ARM); ctx.lineTo(x, y - CROSS_GAP);
      ctx.moveTo(x, y + CROSS_GAP); ctx.lineTo(x, y + CROSS_ARM);
      ctx.stroke();
    });
  }

  /* Repaints only the marker canvas: clears the old marker area, then draws the new marker. */
  function drawMarker(s) {
    var c = s.els.marker;
    var ctx = c.getContext('2d');
    ctx.setTransform(c.width / s.L.cssW, 0, 0, c.height / s.L.cssH, 0, 0);   // draw in CSS px
    var d = s.dirty;
    if (d) ctx.clearRect(d.x, d.y, d.w, d.h); else ctx.clearRect(0, 0, s.L.cssW, s.L.cssH);
    s.dirty = null;
    if (!s.has) return;
    var k = s.L.cssW / s.W;                       // CSS px per poster px
    var x = s.cx * k;
    var y = s.cy * k;
    var half = s.frac * s.W * k / 2;
    strokeMarks(ctx, x, y, half);
    var ext = Math.max(half, CROSS_ARM) + MARK_WIDTH + HALO_EXTRA + 4;
    s.dirty = { x: x - ext, y: y - ext, w: ext * 2, h: ext * 2 };
  }

  // ---------------------------------------------------------------- view position

  /* Scrolls the pan area so poster point (px, py) is in the middle of the view (the browser clamps at the edges). */
  function centerOn(s, px, py) {
    var pan = s.els.pan;
    pan.scrollLeft = px / s.W * s.L.cssW - pan.clientWidth / 2;
    pan.scrollTop = py / s.H * s.L.cssH - pan.clientHeight / 2;
  }

  /* Converts a screen point to poster pixel coordinates, using the stage's real on-screen rectangle. */
  function clientToPoster(s, x, y) {
    var r = s.els.stage.getBoundingClientRect();
    return { x: clamp((x - r.left) / r.width * s.W, 0, s.W),
             y: clamp((y - r.top) / r.height * s.H, 0, s.H) };
  }

  /* Returns the poster point that is at the center of the visible pan area. */
  function viewCenter(s) {
    var pan = s.els.pan;
    var r = pan.getBoundingClientRect();
    return clientToPoster(s, r.left + pan.clientWidth / 2, r.top + pan.clientHeight / 2);
  }

  // ---------------------------------------------------------------- user actions

  /* Stores the chosen spot, enables "Use this spot" and repaints the marker. */
  function setSpot(s, x, y) {
    s.cx = clamp(Math.round(x), 0, s.W);
    s.cy = clamp(Math.round(y), 0, s.H);
    s.has = true;
    s.els.use.disabled = false;
    drawMarker(s);
  }

  /* Zoom button: re-lays out the canvases and keeps the chosen spot (or the view center) in view. */
  function setZoom(s, z) {
    if (z === s.zoom) return;
    var anchor = s.has ? { x: s.cx, y: s.cy } : viewCenter(s);
    s.zoom = z;
    s.containerW = measureWidth(s);
    syncZoomButtons(s);
    applyLayout(s);
    centerOn(s, anchor.x, anchor.y);
  }

  /* Slider: changes the spot size and repaints only the marker. */
  function setFrac(s, frac) {
    s.frac = clamp(frac, FRAC_MIN, FRAC_MAX);
    s.els.out.textContent = Math.round(s.frac * 100) + '%';
    drawMarker(s);
  }

  /* Pointer down on the poster: starts tracking a possible tap (a second finger cancels it). */
  function onDown(s, e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var t = s.tap;
    if (t && t.id !== e.pointerId && e.timeStamp - t.t < STALE_MS) { t.moved = true; return; }   // second finger
    var pan = s.els.pan;
    s.tap = { id: e.pointerId, t: e.timeStamp, x: e.clientX, y: e.clientY, sl: pan.scrollLeft, st: pan.scrollTop, moved: false };
  }

  /* Pointer move: only measures the distance. Nothing is drawn here. */
  function onMove(s, e) {
    var t = s.tap;
    if (t && e.pointerId === t.id && Math.hypot(e.clientX - t.x, e.clientY - t.y) >= TAP_SLOP) t.moved = true;
  }

  /* Pointer up: if the pointer barely moved and the view did not scroll, it is a tap, so set the spot. */
  function onUp(s, e) {
    var t = s.tap;
    if (!t || e.pointerId !== t.id) return;
    s.tap = null;
    var pan = s.els.pan;
    var scrolled = Math.abs(pan.scrollLeft - t.sl) + Math.abs(pan.scrollTop - t.st) > 1;
    var far = Math.hypot(e.clientX - t.x, e.clientY - t.y) >= TAP_SLOP;
    if (t.moved || scrolled || far) return;
    var p = clientToPoster(s, e.clientX, e.clientY);
    setSpot(s, p.x, p.y);
  }

  /* Window resize / rotation: after a short pause, re-lays out for the new width and keeps the spot in view. */
  function onResize(s) {
    clearTimeout(s.resizeTimer);
    s.resizeTimer = setTimeout(function () {
      s.resizeTimer = 0;
      if (s.done) return;
      var w = measureWidth(s);
      if (Math.abs(w - s.containerW) < 1) return;
      var anchor = s.has ? { x: s.cx, y: s.cy } : viewCenter(s);
      s.containerW = w;
      applyLayout(s);
      centerOn(s, anchor.x, anchor.y);
    }, 120);
  }

  // ---------------------------------------------------------------- result and closing

  /* Cuts a square (side = frac * poster width) centered on cx, cy, kept inside the poster, long edge <= 1000. */
  function cropSquare(src, cx, cy, frac) {
    var W = src.width;
    var H = src.height;
    var side = Math.max(1, Math.round(Math.min(frac * W, W, H)));
    var x0 = clamp(Math.round(cx - side / 2), 0, W - side);
    var y0 = clamp(Math.round(cy - side / 2), 0, H - side);
    var out = Math.min(side, CROP_MAX_EDGE);
    var c = document.createElement('canvas');
    c.width = out;
    c.height = out;
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, x0, y0, side, side, 0, 0, out, out);
    return c;
  }

  /* Removes all listeners, the overlay and the canvas memory, and restores page scrolling. */
  function teardown(s) {
    clearTimeout(s.resizeTimer);
    s.listeners.forEach(function (l) { l.target.removeEventListener(l.type, l.fn); });
    s.listeners = [];
    s.els.base.width = 0;
    s.els.base.height = 0;
    s.els.marker.width = 0;
    s.els.marker.height = 0;
    if (s.els.root.parentNode) s.els.root.parentNode.removeChild(s.els.root);
    document.body.style.overflow = s.prevOverflow;
    if (active === s) active = null;
  }

  /* Closes the picker once and resolves the promise (null = cancelled). */
  function finish(s, result) {
    if (s.done) return;
    s.done = true;
    teardown(s);
    s.resolve(result);
  }

  /* Closes the picker after an unexpected error and rejects the promise. */
  function fail(s, err) {
    if (s.done) return;
    s.done = true;
    teardown(s);
    s.reject(err);
  }

  /* Builds the { cx, cy, frac, cropCanvas } result for "Use this spot". */
  function makeResult(s) {
    return { cx: s.cx, cy: s.cy, frac: s.frac, cropCanvas: cropSquare(s.poster, s.cx, s.cy, s.frac) };
  }

  /* "Use this spot" button: builds the result and closes. If the crop fails, closes and rejects instead. */
  function onUse(s) {
    if (!s.has || s.done) return;
    var result;
    try { result = makeResult(s); } catch (err) { fail(s, err); return; }
    finish(s, result);
  }

  /* Connects all buttons, the slider, the poster pointer events, Escape and window resize. */
  function wire(s) {
    var e = s.els;
    listen(s, e.cancel, 'click', function () { finish(s, null); });
    listen(s, e.use, 'click', function () { onUse(s); });
    e.zoomBtns.forEach(function (b) {
      listen(s, b, 'click', function () { setZoom(s, Number(b.getAttribute('data-zoom'))); });
    });
    listen(s, e.slider, 'input', function () { setFrac(s, Number(e.slider.value) / 100); });
    listen(s, e.stage, 'pointerdown', function (ev) { onDown(s, ev); });
    listen(s, e.stage, 'pointermove', function (ev) { onMove(s, ev); });
    listen(s, e.stage, 'pointerup', function (ev) { onUp(s, ev); });
    listen(s, e.stage, 'pointercancel', function () { s.tap = null; });
    listen(s, document, 'keydown', function (ev) { if (ev.key === 'Escape' || ev.key === 'Esc') finish(s, null); });
    listen(s, window, 'resize', function () { onResize(s); });
  }

  /* Shows the overlay, lays out the poster at the default zoom and starts listening. */
  function open(s) {
    active = s;
    s.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(s.els.root);
    s.containerW = measureWidth(s);
    syncControls(s);
    applyLayout(s);
    if (s.has) centerOn(s, s.cx, s.cy); else centerOn(s, s.W / 2, s.H / 2);
    wire(s);
  }

  /* Public entry point: opens the picker and resolves with the chosen spot, or null on Cancel. */
  function pick(opts) {
    opts = opts || {};
    var poster = opts.posterCanvas;
    if (!poster || !poster.width || !poster.height) {
      return Promise.reject(new Error('No poster to pick from.'));
    }
    if (active) finish(active, null);
    return new Promise(function (resolve, reject) {
      var s = null;
      try {
        injectStyle();
        s = newState(opts, buildDom(), resolve, reject);
        open(s);
      } catch (err) {
        if (s) teardown(s);
        reject(err);
      }
    });
  }

  window.PF.poster = { pick: pick };
})();
