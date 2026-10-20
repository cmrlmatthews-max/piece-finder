window.PF = window.PF || {};

// PF.picker: full-screen pan/zoom picker over a photo.
//   mode 'trace' — drag a rough loop around the open spot; the app then snaps to the real edge of the hole
//                  (it grows a region over the table/mat color inside the loop) and works out which sides are open.
//   mode 'point' — pan the picture under a fixed ring; the ring is drawn on the result.
// PF.picker.open({ canvas, mode, title, zoom, ringFrac, grid, initial })
//   → Promise<result | null>   (null = cancelled)
//   trace result: { mode, cx, cy, polygon, seed, tol, snapped, sides:{top,right,bottom,left: 'pieces'|'open'}, cropCanvas, fullCanvas }
//   point result: { mode, cx, cy, ringFrac, cropCanvas, fullCanvas }
PF.picker = (function () {
  'use strict';
  const YELLOW = '#ffd400';
  const ZOOMS = [1, 2, 4, 8];
  const SIDES = ['top', 'right', 'bottom', 'left'];
  let active = null;

  const CSS = `
.pk-overlay{position:fixed;inset:0;background:#111;color:#eee;z-index:60;display:flex;flex-direction:column;
  font:16px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.pk-top{display:flex;align-items:center;gap:8px;padding:8px 10px;flex:none}
.pk-top .pk-title{flex:1;text-align:center;font-weight:700;font-size:16px}
.pk-btn{min-height:46px;min-width:64px;padding:6px 10px;border-radius:12px;border:1px solid #444;background:#2a2a2a;color:#eee;font:inherit;font-weight:600;line-height:1.15}
.pk-btn.on{background:#ffd400;color:#000;border-color:#ffd400}
.pk-btn.side{font-size:13px;font-weight:600}
.pk-btn.side small{display:block;font-size:11px;font-weight:400;opacity:.8}
.pk-btn:disabled{opacity:.4}
.pk-hint{flex:none;text-align:center;font-size:13px;color:#bbb;padding:0 10px 6px;min-height:18px}
.pk-wrap{flex:1;position:relative;min-height:0;background:#000}
.pk-pan{position:absolute;inset:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.pk-stage{position:relative}
.pk-stage canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.pk-draw{touch-action:none}
.pk-draw.off{pointer-events:none}
.pk-cross{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none}
.pk-cross .pk-ring{position:absolute;left:0;top:0;transform:translate(-50%,-50%);border:3px solid #ffd400;border-radius:50%;box-shadow:0 0 0 2px rgba(0,0,0,.6)}
.pk-cross .pk-h,.pk-cross .pk-v{position:absolute;background:#ffd400;box-shadow:0 0 0 1px rgba(0,0,0,.6)}
.pk-cross .pk-h{left:-14px;top:-1px;width:28px;height:2px}
.pk-cross .pk-v{left:-1px;top:-14px;width:2px;height:28px}
.pk-bar{flex:none;display:flex;flex-direction:column;gap:6px;padding:6px 10px}
.pk-row{display:flex;gap:6px;align-items:center}
.pk-row .pk-btn{flex:1;min-width:0}
.pk-row label{flex:none;color:#bbb;font-size:14px}
.pk-row input[type=range]{flex:1;height:40px;accent-color:#ffd400;min-width:0}
.pk-row .pk-val{flex:none;width:36px;text-align:right;font-variant-numeric:tabular-nums;font-size:14px}`;

  function injectStyle() {
    if (document.getElementById('pf-picker-style')) return;
    const s = document.createElement('style');
    s.id = 'pf-picker-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Draws a closed polygon with a dark halo so it stays visible on any photo.
  function strokePolygon(ctx, pts, lw, dashed) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([lw * 3, lw * 3]);
    ctx.lineWidth = lw * 1.8; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = dashed ? 'rgba(255,212,0,0.7)' : YELLOW; ctx.stroke();
    ctx.restore();
  }
  function strokeRing(ctx, cx, cy, r, lw) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = lw * 1.8; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = YELLOW; ctx.stroke();
  }

  // Copies src into a new canvas with max long edge `max`.
  function scaled(src, max) {
    const s = Math.min(1, max / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, ctx, s };
  }

  // Square crop of `side` image pixels centered on (cx, cy), kept inside the image, max long edge 1000.
  function cropAround(src, cx, cy, side) {
    side = Math.max(8, Math.min(side, src.width, src.height));
    let x = Math.round(cx - side / 2), y = Math.round(cy - side / 2);
    x = Math.max(0, Math.min(src.width - side, x)); y = Math.max(0, Math.min(src.height - side, y));
    const s = Math.min(1, 1000 / side);
    const out = Math.round(side * s);
    const c = document.createElement('canvas'); c.width = out; c.height = out;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x, y, side, side, 0, 0, out, out);
    return { canvas: c, ctx, x, y, side, s };
  }

  function bboxOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  // Crop geometry for a traced loop: the loop's box plus a margin, so neighbors are visible.
  function cropForLoop(src, polygon) {
    const b = bboxOf(polygon);
    const margin = Math.max(0.6 * Math.max(b.w, b.h), 0.08 * src.width);
    return cropAround(src, b.cx, b.cy, Math.max(b.w, b.h) + 2 * margin);
  }

  // Rasterizes a polygon (crop coords) into a Uint8Array mask; `grow` px widens it.
  function polygonMask(W, H, pts, grow) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill();
    if (grow > 0) { ctx.lineWidth = grow * 2; ctx.stroke(); }
    const a = ctx.getImageData(0, 0, W, H).data;
    const m = new Uint8Array(W * H);
    for (let i = 0, n = W * H; i < n; i++) m[i] = a[i * 4 + 3] > 127 ? 1 : 0;
    return m;
  }

  // Finds the hole inside the loop: grows a region from the seed over pixels close to the seed color (the table/mat),
  // limited to the loop plus a small margin. Returns null when it fails.
  // Result: { crop, overlay (canvas, crop size, yellow edge), sides, area, edgeCount }
  function snapToHole(src, polygon, seed, tol) {
    const crop = cropForLoop(src, polygon);
    const W = crop.canvas.width, H = crop.canvas.height;
    const px = crop.ctx.getImageData(0, 0, W, H).data;
    const toCrop = (p) => ({ x: (p.x - crop.x) * crop.s, y: (p.y - crop.y) * crop.s });
    const loop = polygon.map(toCrop);
    const b = bboxOf(loop);
    const grow = Math.max(4, 0.04 * Math.max(b.w, b.h));
    const inLoop = polygonMask(W, H, loop, 0);
    const inDil = polygonMask(W, H, loop, grow);
    let loopArea = 0;
    for (let i = 0; i < inLoop.length; i++) loopArea += inLoop[i];
    if (loopArea < 50) return null;

    // seed color: median of a 7x7 window
    const sp = toCrop(seed);
    const sx = Math.max(0, Math.min(W - 1, Math.round(sp.x))), sy = Math.max(0, Math.min(H - 1, Math.round(sp.y)));
    const rs = [], gs = [], bs = [];
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4; rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
    }
    const med = (a) => { a.sort((u, v) => u - v); return a[a.length >> 1]; };
    const sr = med(rs), sg = med(gs), sb = med(bs);
    const tol2 = tol * tol;

    // region growing (4-neighbors), limited to the widened loop
    const region = new Uint8Array(W * H);
    const stack = new Int32Array(W * H);
    let top = 0, area = 0;
    const start = sy * W + sx;
    if (!inDil[start]) return null;
    region[start] = 1; stack[top++] = start;
    while (top) {
      const i = stack[--top]; area++;
      const x = i % W, y = (i - x) / W;
      const nb = [i - 1, i + 1, i - W, i + W];
      for (let k = 0; k < 4; k++) {
        const j = nb[k];
        if (j < 0 || j >= W * H) continue;
        if (k === 0 && x === 0) continue;
        if (k === 1 && x === W - 1) continue;
        if (region[j] || !inDil[j]) continue;
        const o = j * 4, dr = px[o] - sr, dg = px[o + 1] - sg, db = px[o + 2] - sb;
        if (dr * dr + dg * dg + db * db > tol2) continue;
        region[j] = 1; stack[top++] = j;
      }
    }
    if (area < 0.02 * loopArea || area > 0.98 * inDil.reduce((s, v) => s + v, 0)) return null;

    // fill enclosed gaps: flood the complement from the image border; unreached complement pixels become region
    const reach = new Uint8Array(W * H);
    top = 0;
    const pushIf = (j) => { if (!reach[j] && !region[j]) { reach[j] = 1; stack[top++] = j; } };
    for (let x = 0; x < W; x++) { pushIf(x); pushIf((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { pushIf(y * W); pushIf(y * W + W - 1); }
    while (top) {
      const i = stack[--top];
      const x = i % W;
      if (x > 0) pushIf(i - 1);
      if (x < W - 1) pushIf(i + 1);
      if (i >= W) pushIf(i - W);
      if (i + W < W * H) pushIf(i + W);
    }
    for (let i = 0; i < W * H; i++) if (!region[i] && !reach[i]) { region[i] = 1; area++; }

    // edge pixels, and per-direction counts of region pixels stopped by the loop limit (not by pieces):
    // the direction is the side on which the neighbor lies outside the limit
    const edge = [];
    const open = { top: 0, right: 0, bottom: 0, left: 0 };
    const DIRS = [[-1, 0, 'left'], [1, 0, 'right'], [0, -1, 'top'], [0, 1, 'bottom']];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!region[i]) continue;
      let isEdge = false;
      for (const [dx, dy, dir] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) { isEdge = true; open[dir]++; continue; }
        const j = ny * W + nx;
        if (!region[j]) { isEdge = true; if (!inDil[j]) open[dir]++; }
      }
      if (isEdge) edge.push(i);
    }
    // a side is open when the growth ran into the loop limit along a good share of that side
    const maxOpen = Math.max(open.top, open.right, open.bottom, open.left);
    const need = Math.max(0.25 * Math.sqrt(area), 0.35 * maxOpen);
    const sides = {};
    SIDES.forEach((s) => { sides[s] = open[s] >= need ? 'open' : 'pieces'; });

    // overlay: dark halo then yellow line, drawn as small squares around each edge pixel
    const ov = document.createElement('canvas'); ov.width = W; ov.height = H;
    const octx = ov.getContext('2d');
    const r1 = Math.max(2, Math.round(W / 320)), r0 = r1 + 1;
    octx.fillStyle = 'rgba(0,0,0,0.75)';
    for (const i of edge) octx.fillRect((i % W) - r0, ((i / W) | 0) - r0, 2 * r0 + 1, 2 * r0 + 1);
    octx.fillStyle = YELLOW;
    for (const i of edge) octx.fillRect((i % W) - r1 + 1, ((i / W) | 0) - r1 + 1, 2 * r1 - 1, 2 * r1 - 1);
    return { crop, overlay: ov, sides, area, edgeCount: edge.length, seedColor: [sr, sg, sb] };
  }

  function open(opts) {
    if (active) active.finish(null);
    injectStyle();
    const src = opts.canvas;
    const W = src.width, H = src.height;
    const mode = opts.mode === 'point' ? 'point' : 'trace';
    const init = opts.initial || {};
    let zoom = ZOOMS.includes(opts.zoom) ? opts.zoom : (mode === 'point' ? 4 : 1);
    let ringFrac = typeof opts.ringFrac === 'number' ? opts.ringFrac : 0.025;   // ring radius / image width
    let drawing = mode === 'trace';
    let polygon = init.polygon ? init.polygon.slice() : null;
    let seed = init.seed || null;
    let tol = typeof init.tol === 'number' ? init.tol : 45;
    let snapOn = init.snapped !== false;
    let sides = init.sides ? Object.assign({}, init.sides) : null;
    let snap = null;          // last snapToHole result
    let scale = 1;

    return new Promise((resolve) => {
      // --- DOM ---
      const overlay = el('div', 'pk-overlay');
      const top = el('div', 'pk-top');
      const cancelBtn = el('button', 'pk-btn', 'Cancel'); cancelBtn.type = 'button';
      const title = el('span', 'pk-title', opts.title || (mode === 'trace' ? 'Trace the open spot' : 'Put the ring on the spot'));
      const doneBtn = el('button', 'pk-btn on', 'Done'); doneBtn.type = 'button';
      top.append(cancelBtn, title, doneBtn);
      const hint = el('div', 'pk-hint', mode === 'trace'
        ? 'Drag a loose loop around the open spot. The app finds the exact edge inside it.'
        : 'Pan until the ring sits on the spot. Zoom in for precision.');
      const wrap = el('div', 'pk-wrap');
      const pan = el('div', 'pk-pan');
      const stage = el('div', 'pk-stage');
      const imgC = el('canvas'); imgC.width = W; imgC.height = H;
      const drawC = el('canvas', 'pk-draw' + (drawing ? '' : ' off')); drawC.width = W; drawC.height = H;
      stage.append(imgC, drawC);
      pan.appendChild(stage);
      wrap.appendChild(pan);
      let cross = null, ring = null;
      if (mode === 'point') {
        cross = el('div', 'pk-cross');
        ring = el('div', 'pk-ring');
        cross.append(ring, el('div', 'pk-h'), el('div', 'pk-v'));
        wrap.appendChild(cross);
      }
      const bar = el('div', 'pk-bar');
      const zoomRow = el('div', 'pk-row');
      const zoomBtns = ZOOMS.map((z) => { const b = el('button', 'pk-btn' + (z === zoom ? ' on' : ''), z + '×'); b.type = 'button'; b.onclick = () => setZoom(z); zoomRow.appendChild(b); return b; });
      bar.appendChild(zoomRow);
      let moveBtn, drawBtn, clearBtn, snapBtn, tolSlider, tolVal, sideBtns = {}, slider, sliderVal;
      if (mode === 'trace') {
        const row = el('div', 'pk-row');
        moveBtn = el('button', 'pk-btn' + (drawing ? '' : ' on'), 'Move'); moveBtn.type = 'button';
        drawBtn = el('button', 'pk-btn' + (drawing ? ' on' : ''), 'Draw'); drawBtn.type = 'button';
        clearBtn = el('button', 'pk-btn', 'Clear'); clearBtn.type = 'button';
        moveBtn.onclick = () => setDrawing(false);
        drawBtn.onclick = () => setDrawing(true);
        clearBtn.onclick = () => { polygon = null; seed = null; snap = null; sides = null; refresh(); };
        row.append(moveBtn, drawBtn, clearBtn);
        bar.appendChild(row);
        const row2 = el('div', 'pk-row');
        snapBtn = el('button', 'pk-btn' + (snapOn ? ' on' : ''), 'Snap'); snapBtn.type = 'button';
        snapBtn.style.flex = '0 0 auto';
        snapBtn.onclick = () => { snapOn = !snapOn; snapBtn.classList.toggle('on', snapOn); refresh(); };
        row2.appendChild(snapBtn);
        row2.appendChild(el('label', '', 'Tolerance'));
        tolSlider = el('input'); tolSlider.type = 'range'; tolSlider.min = '15'; tolSlider.max = '120'; tolSlider.step = '5'; tolSlider.value = String(tol);
        tolVal = el('span', 'pk-val', String(tol));
        let t = 0;
        tolSlider.oninput = () => { tol = parseInt(tolSlider.value, 10); tolVal.textContent = String(tol); clearTimeout(t); t = setTimeout(refresh, 120); };
        row2.append(tolSlider, tolVal);
        bar.appendChild(row2);
        const row3 = el('div', 'pk-row');
        SIDES.forEach((s) => {
          const b = el('button', 'pk-btn side'); b.type = 'button';
          b.onclick = () => { if (!sides) return; sides[s] = sides[s] === 'open' ? 'pieces' : 'open'; renderSides(); };
          sideBtns[s] = b; row3.appendChild(b);
        });
        bar.appendChild(row3);
      } else {
        const row = el('div', 'pk-row');
        row.appendChild(el('label', '', 'Spot size'));
        slider = el('input'); slider.type = 'range'; slider.min = '1'; slider.max = '15'; slider.step = '0.5'; slider.value = String(ringFrac * 100);
        sliderVal = el('span', 'pk-val', Math.round(ringFrac * 200) + '%');
        slider.oninput = () => { ringFrac = parseFloat(slider.value) / 100; sliderVal.textContent = Math.round(ringFrac * 200) + '%'; layoutRing(); };
        row.append(slider, sliderVal);
        bar.appendChild(row);
      }
      overlay.append(top, hint, wrap, bar);
      document.body.appendChild(overlay);
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      // --- drawing the photo (+ optional grid) once ---
      const ictx = imgC.getContext('2d');
      ictx.drawImage(src, 0, 0);
      const grid = opts.grid;
      if (grid && grid.cols > 0 && grid.rows > 0) {
        ictx.strokeStyle = 'rgba(255,212,0,0.45)'; ictx.lineWidth = Math.max(1, W / 1200);
        for (let i = 1; i < grid.cols; i++) { const x = (W * i) / grid.cols; ictx.beginPath(); ictx.moveTo(x, 0); ictx.lineTo(x, H); ictx.stroke(); }
        for (let j = 1; j < grid.rows; j++) { const y = (H * j) / grid.rows; ictx.beginPath(); ictx.moveTo(0, y); ictx.lineTo(W, y); ictx.stroke(); }
      }
      const dctx = drawC.getContext('2d');

      // Re-runs the snap (if on) and redraws the loop, the snapped edge, the seed and the side buttons.
      function refresh() {
        snap = null;
        if (polygon && polygon.length >= 8 && snapOn) {
          const b = bboxOf(polygon);
          const sd = seed || { x: b.cx, y: b.cy };
          try { snap = snapToHole(src, polygon, sd, tol); } catch (err) { snap = null; }
          if (snap) { if (!sides) sides = Object.assign({}, snap.sides); }
        }
        if (polygon && !sides) sides = { top: 'pieces', right: 'pieces', bottom: 'pieces', left: 'pieces' };
        redraw();
        renderSides();
        updateDone();
        if (mode === 'trace' && polygon) {
          hint.textContent = snap ? 'Edge found. Tap a side below to mark it open or with pieces. Tap inside the hole to move the seed.'
            : (snapOn ? 'No clear edge found: your loop is used as is. Try another Tolerance, or tap inside the hole.' : 'Snap is off: your loop is used as drawn.');
        }
      }
      function redraw() {
        dctx.clearRect(0, 0, W, H);
        if (!polygon || polygon.length < 2) return;
        const lw = Math.max(3, W * 0.004);
        if (snap) {
          strokePolygon(dctx, polygon, lw * 0.6, true);
          dctx.drawImage(snap.overlay, snap.crop.x, snap.crop.y, snap.crop.side, snap.crop.side);
        } else {
          strokePolygon(dctx, polygon, lw, false);
        }
        if (seed) { dctx.beginPath(); dctx.arc(seed.x, seed.y, lw * 1.6, 0, Math.PI * 2); dctx.fillStyle = '#ff5a5a'; dctx.fill(); dctx.lineWidth = 1.5; dctx.strokeStyle = '#000'; dctx.stroke(); }
      }
      function renderSides() {
        if (mode !== 'trace') return;
        SIDES.forEach((s) => {
          const b = sideBtns[s];
          const v = sides ? sides[s] : null;
          b.disabled = !sides;
          b.classList.toggle('on', v === 'pieces');
          b.textContent = s[0].toUpperCase() + s.slice(1);
          const small = el('small', '', v === 'open' ? 'open' : (v === 'pieces' ? 'pieces' : '—'));
          b.appendChild(small);
        });
      }
      function updateDone() { if (mode === 'trace') doneBtn.disabled = !(polygon && polygon.length >= 8); }

      // --- layout / zoom ---
      function viewCenter() {
        return { x: (pan.scrollLeft + pan.clientWidth / 2) / scale, y: (pan.scrollTop + pan.clientHeight / 2) / scale };
      }
      function layout(centerOn) {
        const base = pan.clientWidth || window.innerWidth;
        scale = (base * zoom) / W;
        stage.style.width = Math.round(W * scale) + 'px';
        stage.style.height = Math.round(H * scale) + 'px';
        if (centerOn) {
          pan.scrollLeft = Math.max(0, centerOn.x * scale - pan.clientWidth / 2);
          pan.scrollTop = Math.max(0, centerOn.y * scale - pan.clientHeight / 2);
        }
        layoutRing();
      }
      function layoutRing() {
        if (!ring) return;
        const d = Math.max(10, ringFrac * W * scale * 2);
        ring.style.width = d + 'px'; ring.style.height = d + 'px';
      }
      function setZoom(z) {
        const c = viewCenter();
        zoom = z;
        zoomBtns.forEach((b, i) => b.classList.toggle('on', ZOOMS[i] === z));
        layout(c);
      }
      function setDrawing(on) {
        drawing = on;
        drawC.classList.toggle('off', !on);
        moveBtn.classList.toggle('on', !on); drawBtn.classList.toggle('on', on);
        if (!polygon) hint.textContent = on ? 'Drag a loose loop around the open spot.' : 'Drag to pan. Switch to Draw to trace.';
      }

      // --- tracing ---
      let tracing = false, stroke = null, prevPolygon = null;
      function pt(e) {
        const r = drawC.getBoundingClientRect();
        return { x: Math.max(0, Math.min(W, (e.clientX - r.left) * W / r.width)), y: Math.max(0, Math.min(H, (e.clientY - r.top) * H / r.height)) };
      }
      drawC.addEventListener('pointerdown', (e) => {
        if (!drawing) return;
        e.preventDefault();
        tracing = true; prevPolygon = polygon; stroke = [pt(e)];
        try { drawC.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      });
      drawC.addEventListener('pointermove', (e) => {
        if (!tracing) return;
        e.preventDefault();
        const p = pt(e), last = stroke[stroke.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= W * 0.002) {
          stroke.push(p);
          if (stroke.length >= 3) { polygon = stroke; snap = null; dctx.clearRect(0, 0, W, H); strokePolygon(dctx, polygon, Math.max(3, W * 0.004), false); }
        }
      });
      const endTrace = () => {
        if (!tracing) return;
        tracing = false;
        if (stroke.length < 4 && prevPolygon) {
          polygon = prevPolygon; seed = stroke[0];            // a tap inside the hole sets the seed
        } else if (stroke.length < 8) {
          polygon = prevPolygon; hint.textContent = 'Too short. Draw a loop around the whole open spot.';
        } else {
          polygon = stroke; seed = null; sides = null;        // a new loop resets the seed and the sides
        }
        refresh();
      };
      drawC.addEventListener('pointerup', endTrace);
      drawC.addEventListener('pointercancel', endTrace);

      // --- finish ---
      const state = { finish };
      function teardown() {
        document.body.style.overflow = prevOverflow;
        window.removeEventListener('resize', onResize);
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        if (active === state) active = null;
      }
      function finish(result) { teardown(); resolve(result); }
      function onKey(e) { if (e.key === 'Escape') finish(null); }
      function onResize() { layout(viewCenter()); }
      cancelBtn.onclick = () => finish(null);
      doneBtn.onclick = () => {
        const lw = (w) => Math.max(3, w * 0.008);
        if (mode === 'trace') {
          if (!polygon || polygon.length < 8) return;
          const b = bboxOf(polygon);
          const full = scaled(src, 1600);
          let crop;
          if (snap) {
            crop = snap.crop;
            crop.ctx.drawImage(snap.overlay, 0, 0);
            full.ctx.drawImage(snap.overlay, crop.x * full.s, crop.y * full.s, crop.side * full.s, crop.side * full.s);
          } else {
            crop = cropForLoop(src, polygon);
            strokePolygon(crop.ctx, polygon.map((p) => ({ x: (p.x - crop.x) * crop.s, y: (p.y - crop.y) * crop.s })), lw(crop.canvas.width));
            strokePolygon(full.ctx, polygon.map((p) => ({ x: p.x * full.s, y: p.y * full.s })), lw(full.canvas.width) * 0.6);
          }
          finish({ mode, cx: b.cx, cy: b.cy, polygon: polygon.slice(), seed, tol, snapped: !!snap, sides: Object.assign({}, sides),
            cropCanvas: crop.canvas, fullCanvas: full.canvas });
        } else {
          const c = viewCenter();
          const cx = Math.max(0, Math.min(W, c.x)), cy = Math.max(0, Math.min(H, c.y));
          const r = ringFrac * W;
          const crop = cropAround(src, cx, cy, Math.max(0.08 * W, Math.min(0.5 * W, r * 6)));
          strokeRing(crop.ctx, (cx - crop.x) * crop.s, (cy - crop.y) * crop.s, r * crop.s, lw(crop.canvas.width));
          const full = scaled(src, 1600);
          strokeRing(full.ctx, cx * full.s, cy * full.s, r * full.s, lw(full.canvas.width) * 0.6);
          finish({ mode, cx, cy, ringFrac, cropCanvas: crop.canvas, fullCanvas: full.canvas });
        }
      };
      window.addEventListener('resize', onResize);
      document.addEventListener('keydown', onKey);
      active = state;

      // first layout, after the overlay has a size
      requestAnimationFrame(() => {
        const at = typeof init.cx === 'number' ? { x: init.cx, y: init.cy } : { x: W / 2, y: H / 2 };
        layout(at);
        refresh();
      });
    });
  }

  return { open, snapToHole };
})();
