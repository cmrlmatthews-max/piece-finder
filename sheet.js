window.PF = window.PF || {};

// PF.sheet: numbered contact sheets for Claude (build) and result overlays on a group photo (drawMarks).
(function () {
  'use strict';

  // ---- contact sheet look (numbers come from the spec) ----
  const CELL_BG = '#e6e6e6';
  const CELL_BORDER = '#8a8a8a';
  const BORDER_W = 2;      // border width, drawn just inside the cell edge
  const PAD = 8;           // gap between the cell edge and the piece area
  const STRIP_H = 44;      // white strip at the bottom of a cell, holds the number
  const NUMBER_PX = 34;    // number font size
  const FONT_FAMILY = '-apple-system, Helvetica, Arial, sans-serif';

  // ---- mark look ----
  const YELLOW = '#ffd400';
  const DARK = '#111111';
  const OUTLINE_W = 2;     // dark outline around the yellow shapes

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------

  // Reads a whole number >= 1 from an option; returns the fallback when it is missing or invalid.
  function posInt(value, fallback) {
    if (value == null) return fallback;
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 1 ? n : fallback;
  }

  // Reads any whole number from an option; returns the fallback when it is missing or invalid.
  function wholeNumber(value, fallback) {
    if (value == null) return fallback;
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : fallback;
  }

  // Limits a value to the range lo..hi (if the range is upside down, lo wins).
  function clamp(v, lo, hi) {
    return Math.min(Math.max(v, lo), Math.max(lo, hi));
  }

  // Creates a canvas of the given pixel size.
  function makeCanvas(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  // Gets a 2D context with high-quality image smoothing switched on.
  function getCtx(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }

  // Returns {w, h}: the pixel size of a canvas, image or bitmap (0 when unknown).
  function sizeOf(src) {
    if (!src) return { w: 0, h: 0 };
    return {
      w: src.naturalWidth || src.videoWidth || src.width || 0,
      h: src.naturalHeight || src.videoHeight || src.height || 0,
    };
  }

  // Returns the text baseline y that puts the ink of `sample` (centered on centerY) in the middle.
  // The context font must already be set. Falls back to a cap-height guess if metrics are missing.
  function inkBaseline(ctx, sample, centerY) {
    const m = ctx.measureText(sample);
    const asc = m.actualBoundingBoxAscent;
    const desc = m.actualBoundingBoxDescent;
    if (typeof asc === 'number' && typeof desc === 'number' && asc > 0) {
      return centerY + (asc - desc) / 2;
    }
    const fontPx = parseFloat(ctx.font.match(/([\d.]+)px/)?.[1]) || NUMBER_PX;
    return centerY + fontPx * 0.36;
  }

  // ---------------------------------------------------------------------------
  // contact sheets
  // ---------------------------------------------------------------------------

  // Draws the piece "contain"-fitted and centered in the piece area of the cell at (x, y).
  // The area is (cell - 16) wide and (cell - 60) tall, starting 8 px from the cell top.
  function drawPiece(ctx, src, x, y, cell) {
    const s = sizeOf(src);
    if (!s.w || !s.h) return;
    const areaW = Math.max(1, cell - 2 * PAD);
    const areaH = Math.max(1, cell - 2 * PAD - STRIP_H);
    const k = Math.min(areaW / s.w, areaH / s.h);
    const w = Math.max(1, Math.round(s.w * k));
    const h = Math.max(1, Math.round(s.h * k));
    const dx = x + PAD + Math.round((areaW - w) / 2);
    const dy = y + PAD + Math.round((areaH - h) / 2);
    try {
      ctx.drawImage(src, dx, dy, w, h);
    } catch (err) {
      // A broken source leaves the cell empty; the number is still drawn so numbering stays correct.
    }
  }

  // Draws the number, bold black, centered in the white strip at the bottom of the cell.
  function drawNumber(ctx, number, x, y, cell) {
    ctx.save();
    ctx.font = 'bold ' + NUMBER_PX + 'px ' + FONT_FAMILY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000000';
    const centerY = y + cell - STRIP_H / 2;
    // Measure all digits so every number sits on the same baseline.
    ctx.fillText(String(number), x + cell / 2, inkBaseline(ctx, '0123456789', centerY));
    ctx.restore();
  }

  // Draws the 2 px grey border just inside the cell edge.
  function drawBorder(ctx, x, y, cell) {
    ctx.save();
    ctx.strokeStyle = CELL_BORDER;
    ctx.lineWidth = BORDER_W;
    ctx.strokeRect(x + BORDER_W / 2, y + BORDER_W / 2, cell - BORDER_W, cell - BORDER_W);
    ctx.restore();
  }

  // Draws one complete cell: grey background, white number strip, the piece, the number, the border.
  function drawCell(ctx, src, number, x, y, cell) {
    ctx.fillStyle = CELL_BG;
    ctx.fillRect(x, y, cell, cell);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y + cell - STRIP_H, cell, STRIP_H);
    drawPiece(ctx, src, x, y, cell);
    drawNumber(ctx, number, x, y, cell);
    drawBorder(ctx, x, y, cell);
  }

  // Draws one sheet from up to cols*rows entries. The sheet is cropped to the rows it uses.
  function buildSheet(chunk, firstNumber, cols, cell) {
    const usedRows = Math.ceil(chunk.length / cols);
    const canvas = makeCanvas(cols * cell, usedRows * cell);
    const ctx = getCtx(canvas);
    // Start all white: unused cells in the last row must not be transparent (a JPEG turns those black).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const placed = [];
    chunk.forEach((entry, i) => {
      const number = firstNumber + i;
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      drawCell(ctx, entry && entry.canvas, number, x, y, cell);
      placed.push({ number, id: entry ? entry.id : undefined });
    });
    return { canvas, entries: placed };
  }

  // Builds numbered contact sheets from piece thumbs. Numbers run on across sheets from startNumber.
  // entries: [{ id, canvas }]  opts: { cols: 6, rows: 6, cell: 316, startNumber: 1 }
  // Returns [{ canvas, entries: [{ number, id }] }].
  function build(entries, opts) {
    const o = opts || {};
    const cols = posInt(o.cols, 6);
    const rows = posInt(o.rows, 6);
    const cell = posInt(o.cell, 316);
    const start = wholeNumber(o.startNumber, 1);
    const list = Array.isArray(entries) ? entries : [];
    const perSheet = cols * rows;
    const sheets = [];
    for (let i = 0; i < list.length; i += perSheet) {
      sheets.push(buildSheet(list.slice(i, i + perSheet), start + i, cols, cell));
    }
    return sheets;
  }

  // ---------------------------------------------------------------------------
  // marks on a group photo
  // ---------------------------------------------------------------------------

  // Turns a bbox from photo pixels into output pixels (fx, fy = scale factors). Returns null if unusable.
  function toBox(bbox, fx, fy) {
    if (!bbox) return null;
    const x = Number(bbox.x) * fx;
    const y = Number(bbox.y) * fy;
    const w = Number(bbox.w) * fx;
    const h = Number(bbox.h) * fy;
    if (![x, y, w, h].every(Number.isFinite)) return null;
    return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
  }

  // Returns the radius of a rank circle for a box: 0.62 * the longer box side.
  function ringRadius(box) {
    return Math.max(2, 0.62 * Math.max(box.w, box.h));
  }

  // Draws the yellow ring (with a dark outline on both edges) around one piece.
  function drawRing(ctx, box, longEdge) {
    const stroke = 0.006 * longEdge;
    ctx.save();
    ctx.beginPath();
    ctx.arc(box.cx, box.cy, ringRadius(box), 0, Math.PI * 2);
    ctx.strokeStyle = DARK;
    ctx.lineWidth = stroke + 2 * OUTLINE_W;
    ctx.stroke();
    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = stroke;
    ctx.stroke();
    ctx.restore();
  }

  // Draws the round yellow badge with the label at the top-right of a piece's ring.
  // The badge is kept fully inside the picture (w x h).
  function drawBadge(ctx, box, label, longEdge, w, h) {
    const text = label == null ? '' : String(label);
    if (!text) return;
    const fontPx = 0.035 * longEdge;
    ctx.save();
    ctx.font = 'bold ' + fontPx + 'px ' + FONT_FAMILY;
    const textW = ctx.measureText(text).width;
    // Radius: wide enough for the text corners (half the text width, half the cap height) plus a margin.
    const r = Math.max(0.56 * fontPx, Math.hypot(textW / 2, 0.36 * fontPx) + 0.08 * fontPx);
    const edge = ringRadius(box) * Math.SQRT1_2;       // 45 degrees up and to the right
    const bx = clamp(box.cx + edge, r + 1, w - r - 1);
    const by = clamp(box.cy - edge, r + 1, h - r - 1);
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = YELLOW;
    ctx.fill();
    ctx.lineWidth = OUTLINE_W;
    ctx.strokeStyle = DARK;
    ctx.stroke();
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, bx, inkBaseline(ctx, text, by));
    ctx.restore();
  }

  // Draws a white check mark centered on (cx, cy); `size` is roughly the width of the mark.
  // It is a stroked path, so it looks the same on every device (no font needed).
  function drawCheck(ctx, cx, cy, size) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, 0.16 * size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 0.4 * size, cy + 0.02 * size);
    ctx.lineTo(cx - 0.13 * size, cy + 0.29 * size);
    ctx.lineTo(cx + 0.42 * size, cy - 0.3 * size);
    ctx.stroke();
    ctx.restore();
  }

  // Dims the box of a placed piece (black, alpha 0.55) and puts a white check mark in its center.
  function drawPlaced(ctx, box, longEdge) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
    // Normal size is 0.04 * longEdge; shrink it when the box is small so the mark stays inside.
    const size = Math.min(0.04 * longEdge, 0.7 * Math.min(box.w, box.h));
    if (size >= 6) drawCheck(ctx, box.cx, box.cy, size);
  }

  // Draws result marks on a copy of a group photo and returns the new canvas.
  // marks: [{ bbox:{x,y,w,h}, label, kind:'rank'|'placed' }]  (bbox in photoCanvas pixels)
  // opts: { maxLongEdge: 1600 }  (the copy is shrunk to this long edge if larger, never enlarged)
  function drawMarks(photoCanvas, marks, opts) {
    const o = opts || {};
    const maxEdge = Number(o.maxLongEdge) > 0 ? Number(o.maxLongEdge) : 1600;
    const src = sizeOf(photoCanvas);
    const k = src.w && src.h ? Math.min(1, maxEdge / Math.max(src.w, src.h)) : 1;
    const w = Math.max(1, Math.round(src.w * k));
    const h = Math.max(1, Math.round(src.h * k));
    const out = makeCanvas(w, h);
    const ctx = getCtx(out);
    if (src.w && src.h) ctx.drawImage(photoCanvas, 0, 0, w, h);

    const longEdge = Math.max(w, h);
    const fx = src.w ? w / src.w : 1;
    const fy = src.h ? h / src.h : 1;
    const items = (Array.isArray(marks) ? marks : [])
      .map((m) => ({ box: m && toBox(m.bbox, fx, fy), label: m && m.label, kind: m && m.kind }))
      .filter((m) => m.box);
    const placed = items.filter((m) => m.kind === 'placed');
    const ranks = items.filter((m) => m.kind === 'rank');

    // Order matters: dim boxes first, then rings, then badges on top so no ring covers a number.
    placed.forEach((m) => drawPlaced(ctx, m.box, longEdge));
    ranks.forEach((m) => drawRing(ctx, m.box, longEdge));
    ranks.forEach((m) => drawBadge(ctx, m.box, m.label, longEdge, w, h));
    return out;
  }

  PF.sheet = { build, drawMarks };
})();
