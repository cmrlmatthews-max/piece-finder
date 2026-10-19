window.PF = window.PF || {};

/*
 * segment.js -> PF.segment
 * Finds loose jigsaw pieces in a top-down photo on a plain background.
 *   PF.segment.detect(canvas, opts) -> { pieces, bg, threshold, scale }
 *   PF.segment.otsu(hist)           -> threshold bin index
 * Plain ES2020, classic script. Typed arrays only; no per-pixel objects.
 */
(function () {
  'use strict';

  var WORK_LONG_EDGE = 800;           // step 1: long edge of the work copy
  var BORDER_FRAC = 0.03;             // step 2: border band thickness, fraction of min(w, h)
  var MAX_DIST = 441.6729559300637;   // step 3: sqrt(3 * 255^2), the largest RGB distance
  var THRESHOLD_FLOOR = 25;           // step 4: Otsu result never goes below this
  var OPEN_STEPS = 2;                 // step 5: erode twice, then dilate twice (3x3 each)
  var MIN_COMPONENT_AREA = 30;        // step 7: components below this are noise
  var KEEP_FRAC_OF_MEDIAN = 0.25;     // step 7: keep area >= 0.25 * median
  var MERGED_FACTOR = 2.5;            // step 7: merged = area > 2.5 * median

  // Returns v when it is a finite number, else the default.
  function num(v, def) {
    return (typeof v === 'number' && isFinite(v)) ? v : def;
  }

  // Median of a plain array of numbers (mean of the two middle values when the count is even).
  function median(arr) {
    var n = arr.length;
    if (n === 0) return 0;
    var a = Float64Array.from(arr).sort();
    return (n & 1) ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  // Step 1. Draws the input into a smaller canvas (long edge <= 800) and returns its pixels.
  // Very large inputs are halved step by step first, so the final resample does not alias.
  function makeWork(src) {
    var W = src.width, H = src.height;
    var s = Math.min(1, WORK_LONG_EDGE / Math.max(W, H));
    var w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    var cur = src, cw = W, ch = H;
    while (cw > 2 * w && ch > 2 * h) {
      var nw = Math.ceil(cw / 2), nh = Math.ceil(ch / 2);
      var half = document.createElement('canvas');
      half.width = nw; half.height = nh;
      var hctx = half.getContext('2d');
      hctx.imageSmoothingEnabled = true;
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = half; cw = nw; ch = nh;
    }
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h).data, w: w, h: h, W: W, H: H, s: s };
  }

  // Adds the RGB values of pixels [from, to) to three 256-bin histograms.
  function tally(data, from, to, hr, hg, hb) {
    for (var i = from, p = from * 4; i < to; i++, p += 4) {
      hr[data[p]]++; hg[data[p + 1]]++; hb[data[p + 2]]++;
    }
  }

  // Smallest value whose cumulative count reaches half of n.
  function histMedian(hist, n) {
    var acc = 0, half = n / 2;
    for (var v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= half) return v;
    }
    return 255;
  }

  // Step 2. Background colour = per-channel median of the outer border band (3% of min(w, h)).
  function borderMedian(data, w, h) {
    var t = Math.max(1, Math.round(BORDER_FRAC * Math.min(w, h)));
    var hr = new Int32Array(256), hg = new Int32Array(256), hb = new Int32Array(256);
    var n = 0;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      if (y < t || y >= h - t) {
        tally(data, row, row + w, hr, hg, hb); n += w;
      } else {
        var left = Math.min(t, w), rightFrom = Math.max(w - t, left);
        tally(data, row, row + left, hr, hg, hb);
        tally(data, row + rightFrom, row + w, hr, hg, hb);
        n += left + (w - rightFrom);
      }
    }
    return { r: histMedian(hr, n), g: histMedian(hg, n), b: histMedian(hb, n) };
  }

  // Step 3. Euclidean RGB distance to the background, scaled to 0..255 and stored as Uint8.
  // Also returns the 256-bin histogram of those distances.
  function distanceMap(data, n, bg) {
    var d = new Uint8Array(n), hist = new Int32Array(256);
    var k = 255 / MAX_DIST, br = bg.r, bgg = bg.g, bb = bg.b;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var dr = data[p] - br, dg = data[p + 1] - bgg, db = data[p + 2] - bb;
      var v = (Math.sqrt(dr * dr + dg * dg + db * db) * k + 0.5) | 0;
      if (v > 255) v = 255;
      d[i] = v; hist[v]++;
    }
    return { d: d, hist: hist };
  }

  // Otsu's method. Returns the bin index t that maximises the between-class variance,
  // with class 0 = bins 0..t. If several bins tie, the middle of the tie is returned.
  function otsu(hist) {
    var n = hist.length, total = 0, sumAll = 0, i;
    for (i = 0; i < n; i++) { total += hist[i]; sumAll += i * hist[i]; }
    if (total === 0) return 0;
    var wB = 0, sumB = 0, best = -1, first = 0, last = 0;
    for (var t = 0; t < n; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      var mB = sumB / wB, mF = (sumAll - sumB) / wF;
      var v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; first = last = t; }
      else if (v === best) { last = t; }
    }
    return (first + last) >> 1;
  }

  // Step 4. Mask = distance > threshold (1 where a pixel differs enough from the background).
  function thresholdMask(d, n, T) {
    var m = new Uint8Array(n);
    for (var i = 0; i < n; i++) m[i] = d[i] > T ? 1 : 0;
    return m;
  }

  // One 3x3 erosion (min) or dilation (max) as two separable passes. Outside the image counts as 0.
  function morph3(src, dst, tmp, w, h, erode) {
    var x, y, i, c, a, b;
    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        i = row + x; c = src[i];
        a = x > 0 ? src[i - 1] : 0;
        b = x < w - 1 ? src[i + 1] : 0;
        tmp[i] = erode ? (c & a & b) : (c | a | b);
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x; c = tmp[i];
        a = y > 0 ? tmp[i - w] : 0;
        b = y < h - 1 ? tmp[i + w] : 0;
        dst[i] = erode ? (c & a & b) : (c | a | b);
      }
    }
  }

  // Step 5. Opening: erode OPEN_STEPS times, then dilate OPEN_STEPS times (3x3, 8-neighbourhood).
  // Removes speckles and splits barely-touching pieces. Returns the opened mask.
  function openMask(mask, w, h) {
    var a = mask, b = new Uint8Array(w * h), tmp = new Uint8Array(w * h), t, k;
    for (k = 0; k < OPEN_STEPS; k++) { morph3(a, b, tmp, w, h, true); t = a; a = b; b = t; }
    for (k = 0; k < OPEN_STEPS; k++) { morph3(a, b, tmp, w, h, false); t = a; a = b; b = t; }
    return a;
  }

  // Step 6. Iterative 8-connected labelling with an explicit stack and an Int32Array of labels.
  // Returns one { area, x0, y0, x1, y1 } per component (inclusive bbox, work-scale pixels).
  function components(mask, w, h) {
    var n = w * h, labels = new Int32Array(n), stack = new Int32Array(n);
    var comps = [], count = 0;
    for (var start = 0; start < n; start++) {
      if (!mask[start] || labels[start] !== 0) continue;
      count++;
      var sp = 0, area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      labels[start] = count; stack[sp++] = start;
      while (sp > 0) {
        var p = stack[--sp];
        var y = (p / w) | 0, x = p - y * w;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        var ys = y > 0 ? y - 1 : y, ye = y < h - 1 ? y + 1 : y;
        var xs = x > 0 ? x - 1 : x, xe = x < w - 1 ? x + 1 : x;
        for (var yy = ys; yy <= ye; yy++) {
          var base = yy * w;
          for (var xx = xs; xx <= xe; xx++) {
            var q = base + xx;
            if (mask[q] && labels[q] === 0) { labels[q] = count; stack[sp++] = q; }
          }
        }
      }
      comps.push({ area: area, x0: x0, y0: y0, x1: x1, y1: y1 });
    }
    return comps;
  }

  // Step 7. Drops tiny components, then keeps those with area >= max(0.25 * median, minAreaFrac * W * H).
  // Returns { kept: components, med: median area of the components that passed the 30 px test }.
  function filterComponents(comps, minAreaFrac, w, h) {
    var big = comps.filter(function (c) { return c.area >= MIN_COMPONENT_AREA; });
    var med = median(big.map(function (c) { return c.area; }));
    var minArea = Math.max(KEEP_FRAC_OF_MEDIAN * med, minAreaFrac * w * h);
    var kept = big.filter(function (c) { return c.area >= minArea; });
    return { kept: kept, med: med };
  }

  // Step 8. Pads a work-scale bbox by pad * max(w, h) on every side, clamps it to the image,
  // and converts it to integer boxes in INPUT canvas pixels.
  function toInputBox(c, pad, g) {
    var bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1, p = pad * Math.max(bw, bh);
    var fx0 = Math.max(0, c.x0 - p), fy0 = Math.max(0, c.y0 - p);
    var fx1 = Math.min(g.w, c.x1 + 1 + p), fy1 = Math.min(g.h, c.y1 + 1 + p);
    var kx = g.W / g.w, ky = g.H / g.h;
    var X0 = Math.max(0, Math.round(fx0 * kx)), Y0 = Math.max(0, Math.round(fy0 * ky));
    var X1 = Math.min(g.W, Math.round(fx1 * kx)), Y1 = Math.min(g.H, Math.round(fy1 * ky));
    if (X1 <= X0) X1 = Math.min(g.W, X0 + 1);
    if (Y1 <= Y0) Y1 = Math.min(g.H, Y0 + 1);
    return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
  }

  // Builds the public piece objects from the kept components.
  function buildPieces(kept, med, pad, g) {
    return kept.map(function (c) {
      var b = toInputBox(c, pad, g);
      return {
        x: b.x, y: b.y, w: b.w, h: b.h,
        cx: b.x + b.w / 2, cy: b.y + b.h / 2,
        area: c.area,
        merged: c.area > MERGED_FACTOR * med
      };
    });
  }

  // Step 9. Sorts in place into reading order: row = round(cy / median piece height), then by cx.
  function sortReadingOrder(pieces) {
    var medH = median(pieces.map(function (p) { return p.h; })) || 1;
    var rows = new Map();
    pieces.forEach(function (p) { rows.set(p, Math.round(p.cy / medH)); });
    pieces.sort(function (a, b) {
      return (rows.get(a) - rows.get(b)) || (a.cx - b.cx) || (a.cy - b.cy);
    });
    return pieces;
  }

  // Finds the loose pieces in `canvas`. See SPEC section 4 for the options and the result shape.
  function detect(canvas, opts) {
    opts = opts || {};
    var scaleOpt = num(opts.thresholdScale, 1.0) || 1.0;
    var minAreaFrac = num(opts.minAreaFrac, 0.0005);
    var pad = num(opts.pad, 0.08);
    if (!canvas || !canvas.width || !canvas.height) {
      return { pieces: [], bg: { r: 0, g: 0, b: 0 }, threshold: THRESHOLD_FLOOR * scaleOpt, scale: 1 };
    }

    var g = makeWork(canvas), w = g.w, h = g.h, n = w * h;           // 1
    var bg = borderMedian(g.data, w, h);                             // 2
    var dm = distanceMap(g.data, n, bg);                             // 3
    var otsuT = otsu(dm.hist);                                       // 4
    var T = Math.max(THRESHOLD_FLOOR, otsuT) * scaleOpt;
    var raw = thresholdMask(dm.d, n, T);
    var mask = openMask(raw, w, h);                                  // 5
    var comps = components(mask, w, h);                              // 6
    var f = filterComponents(comps, minAreaFrac, w, h);              // 7
    var pieces = sortReadingOrder(buildPieces(f.kept, f.med, pad, g)); // 8, 9

    var dbg = PF.segment && PF.segment._debug;                       // opt-in hook used by the tests
    if (dbg && typeof dbg === 'object') {
      dbg.w = w; dbg.h = h; dbg.mask = mask; dbg.otsuT = otsuT; dbg.med = f.med; dbg.components = comps.length;
    }
    return { pieces: pieces, bg: bg, threshold: T, scale: g.s };     // 10
  }

  PF.segment = { detect: detect, otsu: otsu };
})();
