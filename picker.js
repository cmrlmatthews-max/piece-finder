window.PF = window.PF || {};

// PF.picker: full-screen pan/zoom picker over a photo.
//   mode 'trace' — drag a finger around the open spot; the outline is drawn on the result.
//   mode 'point' — pan the picture under a fixed ring; the ring is drawn on the result.
// PF.picker.open({ canvas, mode, title, zoom, ringFrac, grid, initial })
//   → Promise<{ mode, cx, cy, polygon?, ringFrac?, cropCanvas, fullCanvas } | null>   (null = cancelled)
PF.picker = (function () {
  'use strict';
  const YELLOW = '#ffd400';
  const ZOOMS = [1, 2, 4, 8];
  let active = null;

  const CSS = `
.pk-overlay{position:fixed;inset:0;background:#111;color:#eee;z-index:60;display:flex;flex-direction:column;
  font:16px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
.pk-top{display:flex;align-items:center;gap:8px;padding:8px 10px;flex:none}
.pk-top .pk-title{flex:1;text-align:center;font-weight:700;font-size:16px}
.pk-btn{min-height:48px;min-width:72px;padding:8px 14px;border-radius:12px;border:1px solid #444;background:#2a2a2a;color:#eee;font:inherit;font-weight:600}
.pk-btn.on{background:#ffd400;color:#000;border-color:#ffd400}
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
.pk-bar{flex:none;display:flex;flex-direction:column;gap:8px;padding:8px 10px}
.pk-row{display:flex;gap:8px;align-items:center}
.pk-row .pk-btn{flex:1;min-width:0}
.pk-row label{flex:none;color:#bbb;font-size:14px}
.pk-row input[type=range]{flex:1;height:44px;accent-color:#ffd400}
.pk-row .pk-val{flex:none;width:44px;text-align:right;font-variant-numeric:tabular-nums}`;

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
  function strokePolygon(ctx, pts, lw) {
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.lineWidth = lw * 1.8; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = YELLOW; ctx.stroke();
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
    side = Math.min(side, src.width, src.height);
    let x = Math.round(cx - side / 2), y = Math.round(cy - side / 2);
    x = Math.max(0, Math.min(src.width - side, x)); y = Math.max(0, Math.min(src.height - side, y));
    const s = Math.min(1, 1000 / side);
    const out = Math.round(side * s);
    const c = document.createElement('canvas'); c.width = out; c.height = out;
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x, y, side, side, 0, 0, out, out);
    return { canvas: c, ctx, x, y, s };
  }

  function open(opts) {
    if (active) active.finish(null);
    injectStyle();
    const src = opts.canvas;
    const W = src.width, H = src.height;
    const mode = opts.mode === 'point' ? 'point' : 'trace';
    let zoom = ZOOMS.includes(opts.zoom) ? opts.zoom : (mode === 'point' ? 4 : 1);
    let ringFrac = typeof opts.ringFrac === 'number' ? opts.ringFrac : 0.025;   // ring radius / image width
    let drawing = mode === 'trace';
    let polygon = opts.initial && opts.initial.polygon ? opts.initial.polygon.slice() : null;
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
        ? 'Drag your finger around the open spot. Switch to Move to pan.'
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
      let moveBtn, drawBtn, clearBtn, slider, sliderVal;
      if (mode === 'trace') {
        const row = el('div', 'pk-row');
        moveBtn = el('button', 'pk-btn' + (drawing ? '' : ' on'), 'Move'); moveBtn.type = 'button';
        drawBtn = el('button', 'pk-btn' + (drawing ? ' on' : ''), 'Draw'); drawBtn.type = 'button';
        clearBtn = el('button', 'pk-btn', 'Clear'); clearBtn.type = 'button';
        moveBtn.onclick = () => setDrawing(false);
        drawBtn.onclick = () => setDrawing(true);
        clearBtn.onclick = () => { polygon = null; redrawPolygon(); updateDone(); };
        row.append(moveBtn, drawBtn, clearBtn);
        bar.appendChild(row);
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
      function redrawPolygon() {
        dctx.clearRect(0, 0, W, H);
        if (polygon && polygon.length > 1) strokePolygon(dctx, polygon, Math.max(3, W * 0.004));
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
        hint.textContent = on ? 'Drag your finger around the open spot. Switch to Move to pan.' : 'Drag to pan. Switch to Draw to trace.';
      }

      // --- tracing ---
      let tracing = false;
      function pt(e) {
        const r = drawC.getBoundingClientRect();
        return { x: Math.max(0, Math.min(W, (e.clientX - r.left) * W / r.width)), y: Math.max(0, Math.min(H, (e.clientY - r.top) * H / r.height)) };
      }
      drawC.addEventListener('pointerdown', (e) => {
        if (!drawing) return;
        e.preventDefault();
        tracing = true; polygon = [pt(e)];
        try { drawC.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        redrawPolygon();
      });
      drawC.addEventListener('pointermove', (e) => {
        if (!tracing) return;
        e.preventDefault();
        const p = pt(e), last = polygon[polygon.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= W * 0.002) { polygon.push(p); redrawPolygon(); }
      });
      const endTrace = (e) => {
        if (!tracing) return;
        tracing = false;
        if (polygon.length < 8) { polygon = null; hint.textContent = 'Too short. Draw a loop around the whole open spot.'; }
        redrawPolygon(); updateDone();
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
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          polygon.forEach((p) => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
          const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          const margin = Math.max(0.6 * Math.max(x1 - x0, y1 - y0), 0.08 * W);
          const crop = cropAround(src, cx, cy, Math.max(x1 - x0, y1 - y0) + 2 * margin);
          strokePolygon(crop.ctx, polygon.map((p) => ({ x: (p.x - crop.x) * crop.s, y: (p.y - crop.y) * crop.s })), lw(crop.canvas.width));
          const full = scaled(src, 1600);
          strokePolygon(full.ctx, polygon.map((p) => ({ x: p.x * full.s, y: p.y * full.s })), lw(full.canvas.width) * 0.6);
          finish({ mode, cx, cy, polygon: polygon.slice(), cropCanvas: crop.canvas, fullCanvas: full.canvas });
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
        const init = opts.initial && typeof opts.initial.cx === 'number' ? { x: opts.initial.cx, y: opts.initial.cy } : { x: W / 2, y: H / 2 };
        layout(init);
        redrawPolygon(); updateDone();
      });
    });
  }

  return { open };
})();
