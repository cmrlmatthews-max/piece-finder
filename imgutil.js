window.PF = window.PF || {};

// imgutil.js - image helpers for Piece Finder (PF.img).
// Load photos with EXIF orientation applied, resize and crop canvases, encode JPEG blobs,
// and convert blobs to data URLs / base64 for the Claude API.
// Written for iOS Safari 17 first (limited canvas memory, quirky createImageBitmap and toBlob).
PF.img = (function () {
  'use strict';

  const BAD_IMAGE = 'Could not open that image. Try a JPEG or PNG photo.';

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  // Returns a usable size limit: the number if it is > 0, otherwise Infinity (no limit).
  function cleanLimit(n) {
    const v = Number(n);
    return v > 0 ? v : Infinity;
  }

  // Returns {w, h} in pixels for an <img>, ImageBitmap, video or canvas (0 when unknown).
  function sizeOf(src) {
    return {
      w: src.naturalWidth || src.videoWidth || src.width || 0,
      h: src.naturalHeight || src.videoHeight || src.height || 0
    };
  }

  // Output size that keeps the aspect ratio, fits the long edge into `limit`, and never upscales.
  function fitSize(w, h, limit) {
    const lim = Math.max(1, Math.floor(limit));
    const long = Math.max(w, h);
    if (long <= lim) return { w: w, h: h };
    const k = lim / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  // Creates a canvas of the given pixel size.
  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Gets a 2D context, or throws a plain-language error (iOS returns null when memory is short).
  function ctx2d(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Not enough memory for that photo. Try a smaller one.');
    return ctx;
  }

  // Draws the source rectangle (sx, sy, sw, sh) of `src` over the whole of `dst`, with smoothing.
  // When the rectangle is the whole source, the short drawImage form is used: it has no source-rect
  // maths, so an EXIF-rotated <img> cannot be mis-read by any browser.
  function paint(dst, src, sx, sy, sw, sh) {
    const ctx = ctx2d(dst);
    const size = sizeOf(src);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (sx === 0 && sy === 0 && sw === size.w && sh === size.h) ctx.drawImage(src, 0, 0, dst.width, dst.height);
    else ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dst.width, dst.height);
  }

  // Frees a scratch canvas's pixel memory right away (helps iOS Safari stay under its limit).
  function release(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  // Copies a region of `src` into a NEW dw x dh canvas.
  // When shrinking by more than 2x it halves in steps first, which looks much better than one big jump.
  function scaleRegion(src, sx, sy, sw, sh, dw, dh) {
    const scratch = [];
    let cur = src;
    let x = sx;
    let y = sy;
    let w = sw;
    let h = sh;
    try {
      while (w > dw * 2 && h > dh * 2) {
        const step = newCanvas(Math.max(dw, Math.ceil(w / 2)), Math.max(dh, Math.ceil(h / 2)));
        scratch.push(step);
        paint(step, cur, x, y, w, h);
        cur = step;
        x = 0;
        y = 0;
        w = step.width;
        h = step.height;
      }
      const out = newCanvas(dw, dh);
      paint(out, cur, x, y, w, h);
      return out;
    } finally {
      scratch.forEach(release);
    }
  }

  // Clamps v into [lo, hi]; NaN becomes lo.
  function clampInt(v, lo, hi) {
    if (Number.isNaN(v)) v = lo;
    return Math.min(Math.max(v, lo), hi);
  }

  // Clamps a requested rectangle to a cw x ch surface. The result is whole pixels and at least 1x1.
  function clampRect(cw, ch, x, y, w, h) {
    const x0 = clampInt(Math.floor(Number(x)), 0, cw - 1);
    const y0 = clampInt(Math.floor(Number(y)), 0, ch - 1);
    const x1 = clampInt(Math.ceil(Number(x) + Number(w)), x0 + 1, cw);
    const y1 = clampInt(Math.ceil(Number(y) + Number(h)), y0 + 1, ch);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Fallback loader: decodes a Blob through an <img> element.
  // Current browsers apply EXIF orientation to <img> (and to drawImage of it) on their own.
  function loadViaImage(blob) {
    return new Promise(function (resolve, reject) {
      let url;
      try {
        url = URL.createObjectURL(blob);
      } catch (e) {
        reject(new Error(BAD_IMAGE));
        return;
      }
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url); // safe: the decoded image stays with the element
        if (img.naturalWidth && img.naturalHeight) resolve(img);
        else reject(new Error(BAD_IMAGE));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(BAD_IMAGE));
      };
      img.src = url;
    });
  }

  // Looks at the first bytes of a Blob and names its image type; returns '' when unknown.
  async function sniffType(blob) {
    try {
      const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
      if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return 'image/webp';
    } catch (e) {
      /* unreadable: the caller picks a default */
    }
    return '';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  // File|Blob -> Promise<ImageBitmap|HTMLImageElement>, EXIF orientation applied.
  // Tries createImageBitmap first; if it is missing, throws, or rejects (older Safari), uses an <img>.
  function loadFile(file) {
    if (!file) return Promise.reject(new Error('No photo was selected.'));
    let attempt;
    try {
      attempt = typeof createImageBitmap === 'function'
        ? createImageBitmap(file, { imageOrientation: 'from-image' })
        : Promise.reject(new Error('createImageBitmap is not available'));
    } catch (e) {
      attempt = Promise.reject(e); // some Safari builds throw instead of rejecting
    }
    return attempt.catch(function () {
      return loadViaImage(file);
    });
  }

  // image / bitmap / canvas -> NEW canvas whose long edge is <= maxLongEdge (aspect kept, never upscaled).
  function toCanvas(src, maxLongEdge) {
    if (!src) throw new Error('No image to resize.');
    const size = sizeOf(src);
    if (!size.w || !size.h) throw new Error('The image has no size.');
    const out = fitSize(size.w, size.h, cleanLimit(maxLongEdge));
    return scaleRegion(src, 0, 0, size.w, size.h, out.w, out.h);
  }

  // Blob -> Promise<canvas> (EXIF applied), downscaled to maxLongEdge. Frees the decoded bitmap afterwards.
  async function blobToCanvas(blob, maxLongEdge = Infinity) {
    const img = await loadFile(blob);
    try {
      return toCanvas(img, maxLongEdge);
    } finally {
      if (typeof img.close === 'function') img.close();
    }
  }

  // canvas -> Promise<Blob>. Rejects with a clear Error when the browser cannot encode it
  // (Safari returns null from toBlob for canvases that are too big).
  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
    return new Promise(function (resolve, reject) {
      if (!canvas || !canvas.width || !canvas.height) {
        reject(new Error('Cannot save an empty image.'));
        return;
      }
      try {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Could not save the image. It may be too large for this phone.'));
        }, type, quality);
      } catch (e) {
        reject(new Error('Could not save the image: ' + ((e && e.message) || e)));
      }
    });
  }

  // Blob -> Promise<string> ("data:<type>;base64,<data>").
  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Could not read the image data.'));
      };
      reader.readAsDataURL(blob);
    });
  }

  // Blob -> Promise<{ media_type, data }> where data is plain base64 (no "data:" prefix), as the Claude API wants.
  // media_type comes from the Blob; if the Blob has no image type, the first bytes decide (default image/jpeg).
  async function blobToBase64(blob) {
    const url = await blobToDataURL(blob);
    const comma = url.indexOf(',');
    if (comma < 0) throw new Error('Could not read the image data.');
    const type = /^image\//.test(blob.type) ? blob.type : await sniffType(blob);
    return { media_type: type || 'image/jpeg', data: url.slice(comma + 1) };
  }

  // canvas region -> NEW canvas. The region is clamped to the canvas (whole pixels, at least 1x1),
  // then downscaled so its long side is <= maxLongEdge (never upscaled).
  function crop(canvas, x, y, w, h, maxLongEdge = Infinity) {
    if (!canvas || !canvas.width || !canvas.height) throw new Error('Cannot crop an empty image.');
    const r = clampRect(canvas.width, canvas.height, x, y, w, h);
    const out = fitSize(r.w, r.h, cleanLimit(maxLongEdge));
    return scaleRegion(canvas, r.x, r.y, r.w, r.h, out.w, out.h);
  }

  // Random id (RFC 4122 v4). Uses crypto.randomUUID when it exists; otherwise builds one from random bytes.
  function uuid() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === 'function') {
      try {
        return c.randomUUID();
      } catch (e) {
        /* not a secure context: use the fallback below */
      }
    }
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(b, function (n) {
      return n.toString(16).padStart(2, '0');
    }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  return {
    loadFile: loadFile,
    toCanvas: toCanvas,
    blobToCanvas: blobToCanvas,
    canvasToBlob: canvasToBlob,
    blobToDataURL: blobToDataURL,
    blobToBase64: blobToBase64,
    crop: crop,
    uuid: uuid
  };
})();
