// Tests for sheet.js (PF.sheet.build and PF.sheet.drawMarks) in headless Chromium.
// Run:  NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/test_sheet_build.mjs
// Writes pictures to tests/out/ so a person can look at them:
//   test_sheet_sheet1.png, test_sheet_sheet2.png, test_sheet_sheet1_1000.png, test_sheet_marks.png, ...
//   and, for the v0.2 captions: test_sheet_captions.png (full size) and test_sheet_captions_1000.png (shrunk to 1000 px)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

// Loads Playwright from NODE_PATH, or from the known global folder.
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    return require('/home/claude/.npm-global/lib/node_modules/playwright');
  }
}

// Starts a tiny static file server for the repo folder on a free port.
function startServer(dir) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.css': 'text/css; charset=utf-8',
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, path.normalize(rel));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'content-type': types[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let failed = 0;
// Prints PASS or FAIL for one check.
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failed++;
}
// True when a is within tol of b.
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// True when an [r,g,b,a] pixel is within tol of an [r,g,b] color on every channel.
const isColor = (p, rgb, tol) => rgb.every((v, i) => near(p[i], v, tol));
const isDark = (p) => p[0] < 90 && p[1] < 90 && p[2] < 90;

const { chromium } = loadPlaywright();
const { server, port } = await startServer(root);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

try {
  await page.goto(`http://127.0.0.1:${port}/tests/test_sheet_page.html`);
  check('PF.sheet exposes build and drawMarks',
    await page.evaluate(() => typeof PF.sheet.build === 'function' && typeof PF.sheet.drawMarks === 'function'));

  // ---------------------------------------------------------------- 1. 40 pieces -> 2 sheets
  const built = await page.evaluate(() => {
    const rnd = T.rng(20260419);
    const entries = [];
    for (let i = 0; i < 40; i++) {
      const w = 120 + Math.floor(rnd() * 201);   // 120..320
      const h = 120 + Math.floor(rnd() * 201);
      entries.push({ id: 'p' + (i + 1), canvas: T.makePiece(i, w, h, rnd, true) });
    }
    const t0 = performance.now();
    window.__sheets = PF.sheet.build(entries);
    const ms = performance.now() - t0;
    return {
      ms,
      sheets: window.__sheets.map((s) => ({
        w: s.canvas.width, h: s.canvas.height, entries: s.entries,
        isCanvas: s.canvas instanceof HTMLCanvasElement,
      })),
    };
  });
  console.log(`      build(40 pieces) took ${built.ms.toFixed(1)} ms`);
  check('40 pieces make 2 sheets', built.sheets.length === 2, `got ${built.sheets.length}`);
  check('sheet 1 is 1896x1896', built.sheets[0].w === 1896 && built.sheets[0].h === 1896, `${built.sheets[0].w}x${built.sheets[0].h}`);
  check('sheet 2 is 1896x316 (cropped to the rows used)', built.sheets[1].w === 1896 && built.sheets[1].h === 316, `${built.sheets[1].w}x${built.sheets[1].h}`);
  check('sheet canvases are HTMLCanvasElement', built.sheets.every((s) => s.isCanvas));
  const nums = built.sheets.flatMap((s) => s.entries.map((e) => e.number));
  check('sheet 1 has 36 entries, sheet 2 has 4', built.sheets[0].entries.length === 36 && built.sheets[1].entries.length === 4);
  check('numbers run 1..40 without a gap', nums.length === 40 && nums.every((n, i) => n === i + 1));
  const ids = built.sheets.flatMap((s) => s.entries.map((e) => e.id));
  check('ids keep the input order', ids.every((id, i) => id === 'p' + (i + 1)));
  check('build is fast (< 1000 ms for 40 pieces)', built.ms < 1000, `${built.ms.toFixed(0)} ms`);

  // The empty cells of the last sheet must be opaque white (a transparent pixel would turn black in a JPEG).
  const unused = await page.evaluate(() => {
    const c = window.__sheets[1].canvas;
    return [T.px(c, 1300, 50), T.px(c, 1800, 300), T.px(c, 1895, 315), T.px(window.__sheets[0].canvas, 1895, 1895)];
  });
  check('unused area of the last sheet is opaque white', unused.slice(0, 3).every((p) => isColor(p, [255, 255, 255], 0) && p[3] === 255), JSON.stringify(unused));
  check('the border of the last cell is opaque too', unused[3][3] === 255 && isColor(unused[3], [138, 138, 138], 1), JSON.stringify(unused[3]));

  // ---------------------------------------------------------------- 2. pixel checks of the layout
  const cells = await page.evaluate(() => {
    const out = [];
    const cell = 316;
    const dark = (r, g, b) => (r + g + b) / 3 < 110;
    for (let s = 0; s < window.__sheets.length; s++) {
      const c = window.__sheets[s].canvas;
      const n = window.__sheets[s].entries.length;
      for (let i = 0; i < n; i++) {
        const x = (i % 6) * cell, y = Math.floor(i / 6) * cell;
        out.push({
          sheet: s, i,
          bg: T.px(c, x + 4, y + 4),
          borderLeft0: T.px(c, x, y + 150), borderLeft1: T.px(c, x + 1, y + 150),
          borderTop0: T.px(c, x + 150, y), borderBottom1: T.px(c, x + 150, y + cell - 1),
          borderRight0: T.px(c, x + cell - 1, y + 150),
          afterBorder: T.px(c, x + 2, y + 4),
          stripTopCorner: T.px(c, x + 10, y + cell - 44),
          gapAboveStrip: T.px(c, x + 4, y + cell - 46),
          stripCorner: T.px(c, x + 10, y + cell - 10),
          ink: T.inkBox(c, { x: x + 3, y: y + cell - 44, w: cell - 6, h: 41 }, dark),
          x, y,
        });
      }
    }
    return out;
  });
  const bad = (pred) => cells.filter((c) => !pred(c)).length;
  check('cell background is #e6e6e6', bad((c) => isColor(c.bg, [230, 230, 230], 1)) === 0);
  check('border is 2 px #8a8a8a (left, top, right, bottom edges)',
    bad((c) => isColor(c.borderLeft0, [138, 138, 138], 1) && isColor(c.borderLeft1, [138, 138, 138], 1)
      && isColor(c.borderTop0, [138, 138, 138], 1) && isColor(c.borderBottom1, [138, 138, 138], 1)
      && isColor(c.borderRight0, [138, 138, 138], 1)) === 0);
  check('pixel right after the 2 px border is background', bad((c) => isColor(c.afterBorder, [230, 230, 230], 1)) === 0);
  check('number strip is white and 44 px tall',
    bad((c) => isColor(c.stripTopCorner, [255, 255, 255], 1) && isColor(c.stripCorner, [255, 255, 255], 1)
      && isColor(c.gapAboveStrip, [230, 230, 230], 1)) === 0);
  check('every cell has a number drawn', bad((c) => c.ink && c.ink.n > 60) === 0);
  const dx = cells.map((c) => Math.abs((c.ink.x0 + c.ink.x1 + 1) / 2 - (c.x + 158)));
  const dy = cells.map((c) => Math.abs((c.ink.y0 + c.ink.y1 + 1) / 2 - (c.y + 316 - 22)));
  const hgt = cells.map((c) => c.ink.y1 - c.ink.y0 + 1);
  check('numbers are centered in the strip (x within 5 px, y within 2 px)',
    Math.max(...dx) <= 5 && Math.max(...dy) <= 2,
    `max dx ${Math.max(...dx).toFixed(1)}, max dy ${Math.max(...dy).toFixed(1)}`);
  check('numbers are about 24 px tall (bold 34 px)', Math.min(...hgt) >= 21 && Math.max(...hgt) <= 29,
    `${Math.min(...hgt)}..${Math.max(...hgt)} px`);

  // ---------------------------------------------------------------- 3. contain-fit
  const fit = await page.evaluate(() => {
    const entries = [
      { id: 'tall', canvas: T.solid(100, 300, '#ff0000') },
      { id: 'wide', canvas: T.solid(320, 100, '#0000ff') },
      { id: 'tiny', canvas: T.solid(60, 40, '#00aa00') },
      { id: 'square', canvas: T.solid(256, 256, '#ff00ff') },
      { id: 'zero', canvas: T.canvas(0, 0) },
      { id: 'missing' },
    ];
    const sheets = PF.sheet.build(entries, { cols: 3, rows: 2 });
    const c = sheets[0].canvas;
    const preds = [
      (r, g, b) => r > 200 && g < 60 && b < 60,
      (r, g, b) => b > 200 && r < 60 && g < 60,
      (r, g, b) => g > 130 && r < 60 && b < 60,
      (r, g, b) => r > 200 && b > 200 && g < 60,
    ];
    const boxes = preds.map((pred, i) => {
      const x = (i % 3) * 316, y = Math.floor(i / 3) * 316;
      const b = T.inkBox(c, { x, y, w: 316, h: 316 }, pred);
      return b && { x0: b.x0 - x, y0: b.y0 - y, x1: b.x1 - x, y1: b.y1 - y };
    });
    const empties = [4, 5].map((i) => {
      const x = (i % 3) * 316, y = Math.floor(i / 3) * 316;
      return { bg: T.px(c, x + 150, y + 100), ink: T.inkBox(c, { x: x + 3, y: y + 272, w: 310, h: 41 }, (r, g, b) => r < 90) };
    });
    return { size: [c.width, c.height], numbers: sheets[0].entries.map((e) => e.number), boxes, empties };
  });
  check('6 entries on a 3-column sheet: 948x632', fit.size[0] === 948 && fit.size[1] === 632, fit.size.join('x'));
  const expectBox = (name, got, x0, y0, x1, y1) => check(
    `contain-fit: ${name} fills ${x1 - x0 + 1}x${y1 - y0 + 1} at (${x0},${y0})`,
    got && near(got.x0, x0, 2) && near(got.y0, y0, 2) && near(got.x1, x1, 2) && near(got.y1, y1, 2),
    got ? `got (${got.x0},${got.y0})-(${got.x1},${got.y1})` : 'no pixels');
  expectBox('tall 100x300', fit.boxes[0], 116, 8, 200, 263);       // 85 x 256, centered
  expectBox('wide 320x100', fit.boxes[1], 8, 89, 307, 182);        // 300 x 94, centered vertically in the area
  expectBox('tiny 60x40 (scaled up to fit)', fit.boxes[2], 8, 36, 307, 235);   // 300 x 200
  expectBox('square 256x256', fit.boxes[3], 30, 8, 285, 263);
  check('empty / missing canvas: cell is drawn without error and the number is there',
    fit.empties.every((e) => isColor(e.bg, [230, 230, 230], 1) && e.ink && e.ink.n > 60));
  check('numbers 1..6 on the small sheet', fit.numbers.join() === '1,2,3,4,5,6');

  // ---------------------------------------------------------------- 4. options and edge cases
  const edge = await page.evaluate(() => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: 'e' + i, canvas: T.solid(80, 80, '#5577aa') }));
    const dims = (sheets) => sheets.map((s) => [s.canvas.width, s.canvas.height, s.entries.length]);
    const custom = PF.sheet.build(mk(5), { cols: 3, rows: 2, cell: 200, startNumber: 100 });
    const custom7 = PF.sheet.build(mk(7), { cols: 3, rows: 2, cell: 200, startNumber: 100 });
    const t0 = performance.now();
    const big = PF.sheet.build(mk(144));
    return {
      customDims: dims(custom), customNums: custom.map((s) => s.entries.map((e) => e.number)),
      custom7Dims: dims(custom7), custom7Nums: custom7.map((s) => s.entries.map((e) => e.number)),
      empty: PF.sheet.build([]).length, undef: PF.sheet.build(undefined).length,
      n36: dims(PF.sheet.build(mk(36))), n37: dims(PF.sheet.build(mk(37))),
      n72: dims(PF.sheet.build(mk(72))), n73: dims(PF.sheet.build(mk(73))),
      big: dims(big), bigMs: performance.now() - t0,
    };
  });
  check('opts cols 3, rows 2, cell 200: 5 pieces -> one 600x400 sheet', JSON.stringify(edge.customDims) === '[[600,400,5]]', JSON.stringify(edge.customDims));
  check('opts startNumber 100 -> 100..104', edge.customNums[0].join() === '100,101,102,103,104');
  check('7 pieces with 6 per sheet -> 600x400 + 600x200, numbers continue', JSON.stringify(edge.custom7Dims) === '[[600,400,6],[600,200,1]]' && edge.custom7Nums[1].join() === '106', JSON.stringify(edge.custom7Dims));
  check('empty and undefined input give no sheets', edge.empty === 0 && edge.undef === 0);
  check('36 pieces -> 1 full sheet', JSON.stringify(edge.n36) === '[[1896,1896,36]]');
  check('37 pieces -> full sheet + 1896x316', JSON.stringify(edge.n37) === '[[1896,1896,36],[1896,316,1]]');
  check('72 pieces -> 2 full sheets', JSON.stringify(edge.n72) === '[[1896,1896,36],[1896,1896,36]]');
  check('73 pieces -> 3 sheets', edge.n73.length === 3 && edge.n73[2][1] === 316);
  check('144 pieces (the app maximum) -> 4 full sheets in < 2 s', edge.big.length === 4 && edge.bigMs < 2000, `${edge.bigMs.toFixed(0)} ms`);

  // ---------------------------------------------------------------- 5. save sheets + legibility at 1000 px
  const png1 = await page.evaluate(() => T.png(window.__sheets[0].canvas));
  const png2 = await page.evaluate(() => T.png(window.__sheets[1].canvas));
  const png1k = await page.evaluate(() => T.png(T.shrink(window.__sheets[0].canvas, 1000)));
  const png2k = await page.evaluate(() => T.png(T.shrink(window.__sheets[1].canvas, 1000)));
  fs.writeFileSync(path.join(outDir, 'test_sheet_sheet1.png'), Buffer.from(png1, 'base64'));
  fs.writeFileSync(path.join(outDir, 'test_sheet_sheet2.png'), Buffer.from(png2, 'base64'));
  fs.writeFileSync(path.join(outDir, 'test_sheet_sheet1_1000.png'), Buffer.from(png1k, 'base64'));
  fs.writeFileSync(path.join(outDir, 'test_sheet_sheet2_1000.png'), Buffer.from(png2k, 'base64'));
  check('sheet PNGs saved to tests/out/', fs.statSync(path.join(outDir, 'test_sheet_sheet1.png')).size > 10000);

  // Strips of the 1000 px version (shrunk, then enlarged 3x so OCR has something to chew on).
  const stripPng = await page.evaluate(() => T.png(T.stripStack(T.shrink(window.__sheets[0].canvas, 1000), 6, 6, 316, 1000 / 1896, 3)));
  const stripPath = path.join(outDir, 'test_sheet_strips_1000.png');
  fs.writeFileSync(stripPath, Buffer.from(stripPng, 'base64'));
  let ocr = null;
  try {
    const text = execFileSync('tesseract', [stripPath, 'stdout', '--psm', '6', '-c', 'tessedit_char_whitelist=0123456789'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    ocr = text.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    console.log('SKIP  OCR of the numbers (tesseract not available)');
  }
  if (ocr) {
    const want = Array.from({ length: 36 }, (_, i) => String(i + 1));
    const okCount = want.filter((w, i) => ocr[i] === w).length;
    check('OCR reads all 36 numbers from the sheet shrunk to 1000 px', okCount === 36, `${okCount}/36 read correctly`);
  }

  // ---------------------------------------------------------------- 6. drawMarks
  const marks = await page.evaluate(() => {
    const rnd = T.rng(77);
    const W = 1600, H = 1200;
    const photo = T.canvas(W, H);
    const g = photo.getContext('2d');
    g.fillStyle = '#f4f3ee';
    g.fillRect(0, 0, W, H);
    // Marked pieces sit inside their boxes; other pieces are scattered around for a realistic picture.
    const marked = [
      { x: 200, y: 220, w: 110, h: 120 }, { x: 820, y: 520, w: 120, h: 110 }, { x: 1470, y: 24, w: 100, h: 104 },
      { x: 520, y: 760, w: 110, h: 110 }, { x: 1150, y: 880, w: 100, h: 130 },
    ];
    let k = 0;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 7; c++) {
        const x = 90 + c * 220 + rnd() * 40, y = 90 + r * 230 + rnd() * 40;
        const near = marked.some((b) => Math.abs(b.x + b.w / 2 - x) < 150 && Math.abs(b.y + b.h / 2 - y) < 150);
        if (!near) T.stamp(g, T.pieceLayer(82, rnd, (k++ * 47) % 360), x, y, rnd() * 6.28);
      }
    }
    marked.forEach((b, i) => T.stamp(g, T.pieceLayer(Math.min(b.w, b.h) * 0.78, rnd, (i * 71 + 20) % 360), b.x + b.w / 2, b.y + b.h / 2, rnd() * 6.28));
    window.__photo = photo;
    const before = T.px(photo, 181, 280);
    const markList = [
      { bbox: marked[0], label: '1', kind: 'rank' },
      { bbox: marked[1], label: '2', kind: 'rank' },
      { bbox: marked[2], label: '12', kind: 'rank' },
      { bbox: marked[3], label: '', kind: 'placed' },
      { bbox: marked[4], label: '', kind: 'placed' },
    ];
    const t0 = performance.now();
    const out = PF.sheet.drawMarks(photo, markList);
    const ms = performance.now() - t0;
    window.__marked = out;
    const yellowLike = (r, g2, b) => r > 230 && g2 > 190 && g2 < 235 && b < 40;
    // Ring of mark 1: center (255, 280), radius 0.62 * 120 = 74.4, stroke 0.006 * 1600 = 9.6.
    const ringLeft = T.px(out, 181, 280);
    const ringOutline = T.px(out, 174, 280);
    const ringTop = T.px(out, 255, 280 - 74);
    // Badge of mark 1: center (255 + 74.4 * 0.7071, 280 - 74.4 * 0.7071) = (307.6, 227.4).
    const badgeFill = T.px(out, 308, 227 - 25);
    const badgeText = T.count(out, { x: 293, y: 207, w: 30, h: 40 }, (r, g2, b) => r < 60 && g2 < 60 && b < 60);
    // Mark 3 sits at the top-right corner: its badge must be moved inside the picture.
    const topEdgeDark = T.count(out, { x: 1500, y: 0, w: 100, h: 2 }, (r, g2, b) => r < 90 && g2 < 90 && b < 90);
    const rightEdgeDark = T.count(out, { x: 1598, y: 0, w: 2, h: 120 }, (r, g2, b) => r < 90 && g2 < 90 && b < 90);
    // Placed box of mark 4: (520, 760, 110, 110).
    const placedCorner = T.px(out, 524, 764);
    const justOutside = T.px(out, 516, 764);
    const whiteInPlaced = T.count(out, { x: 520, y: 760, w: 110, h: 110 }, (r, g2, b) => r > 235 && g2 > 235 && b > 235);
    const placed2Corner = T.px(out, 1154, 884);
    const whiteInPlaced2 = T.count(out, { x: 1150, y: 880, w: 100, h: 130 }, (r, g2, b) => r > 235 && g2 > 235 && b > 235);
    // Original must not change.
    const after = T.px(photo, 181, 280);
    const origPlaced = T.px(photo, 524, 764);
    // Same call with no marks: pixel copy.
    const plain = PF.sheet.drawMarks(photo, []);
    const same = [[10, 10], [800, 600], [300, 300], [1500, 1100]].every(([x, y]) => T.px(plain, x, y).join() === T.px(photo, x, y).join());
    return {
      ms, size: [out.width, out.height], notSame: out !== photo && out instanceof HTMLCanvasElement,
      before, after, origPlaced, ringLeft, ringOutline, ringTop, badgeFill, badgeText, topEdgeDark, rightEdgeDark,
      placedCorner, justOutside, whiteInPlaced, placed2Corner, whiteInPlaced2, plainSize: [plain.width, plain.height], same,
      png: T.png(out),
    };
  });
  fs.writeFileSync(path.join(outDir, 'test_sheet_marks.png'), Buffer.from(marks.png, 'base64'));
  console.log(`      drawMarks took ${marks.ms.toFixed(1)} ms`);
  check('drawMarks returns a new 1600x1200 canvas', marks.notSame && marks.size.join('x') === '1600x1200', marks.size.join('x'));
  check('drawMarks does not change the original photo', marks.before.join() === marks.after.join() && isColor(marks.origPlaced, [244, 243, 238], 3));
  check('rank ring is #ffd400 on the circle (left point)', isColor(marks.ringLeft, [255, 212, 0], 6), marks.ringLeft.join());
  check('rank ring has a dark outline outside the yellow', isDark(marks.ringOutline), marks.ringOutline.join());
  check('ring top point is yellow too (circle, centered on the box)', isColor(marks.ringTop, [255, 212, 0], 12), marks.ringTop.join());
  check('badge is filled #ffd400', isColor(marks.badgeFill, [255, 212, 0], 6), marks.badgeFill.join());
  check('badge has black text', marks.badgeText > 40, `${marks.badgeText} dark px`);
  check('badge near the corner is moved inside the picture (top and right edge)', marks.topEdgeDark >= 10 && marks.rightEdgeDark >= 10, `top ${marks.topEdgeDark}, right ${marks.rightEdgeDark}`);
  check('placed box is dimmed with alpha 0.55 black', isColor(marks.placedCorner, [110, 109, 107], 4) && isColor(marks.placed2Corner, [110, 109, 107], 4), `${marks.placedCorner.join()} / ${marks.placed2Corner.join()}`);
  check('placed dimming stays inside the box', isColor(marks.justOutside, [244, 243, 238], 3), marks.justOutside.join());
  check('placed box has a white check mark', marks.whiteInPlaced > 250 && marks.whiteInPlaced2 > 250, `${marks.whiteInPlaced} / ${marks.whiteInPlaced2} white px`);
  check('no marks -> plain copy of the photo', marks.same && marks.plainSize.join('x') === '1600x1200');

  // Downscaling and robustness.
  const scale = await page.evaluate(() => {
    const big = T.canvas(3200, 2400);
    const g = big.getContext('2d');
    g.fillStyle = '#f4f3ee';
    g.fillRect(0, 0, 3200, 2400);
    const m = [{ bbox: { x: 800, y: 600, w: 240, h: 240 }, label: '3', kind: 'rank' }];
    const a = PF.sheet.drawMarks(big, m);                           // default 1600
    const b = PF.sheet.drawMarks(big, m, { maxLongEdge: 800 });
    const c = PF.sheet.drawMarks(T.canvas(1600, 1200), m, { maxLongEdge: 2000 });   // never enlarged
    const d = PF.sheet.drawMarks(T.canvas(1200, 1600), []);          // portrait
    let threw = null;
    try {
      PF.sheet.drawMarks(big, [null, {}, { bbox: null, kind: 'rank' }, { bbox: { x: 'a', y: 1, w: 2, h: 3 }, kind: 'rank' },
        { bbox: { x: 1, y: 1, w: 50, h: 50 }, kind: 'weird', label: 'x' }, { bbox: { x: 1, y: 1, w: 50, h: 50 }, kind: 'rank' }]);
      PF.sheet.drawMarks(big, undefined);
    } catch (e) { threw = String(e); }
    return {
      a: [a.width, a.height], b: [b.width, b.height], c: [c.width, c.height], d: [d.width, d.height],
      ringA: T.px(a, 386, 360),             // center (460, 360), radius 74.4
      ringB: T.px(b, 193, 180),             // center (230, 180), radius 37.2, stroke 4.8
      threw,
    };
  });
  check('3200x2400 photo is shrunk to 1600x1200 by default', scale.a.join('x') === '1600x1200', scale.a.join('x'));
  check('marks follow the shrink (ring at scaled position)', isColor(scale.ringA, [255, 212, 0], 8), scale.ringA.join());
  check('maxLongEdge 800 -> 800x600, ring follows', scale.b.join('x') === '800x600' && isColor(scale.ringB, [255, 212, 0], 8), `${scale.b.join('x')} ${scale.ringB.join()}`);
  check('smaller photo is never enlarged (maxLongEdge 2000)', scale.c.join('x') === '1600x1200');
  check('portrait photo keeps its shape', scale.d.join('x') === '1200x1600');
  check('bad marks (null, no bbox, NaN, unknown kind) are ignored without error', scale.threw === null, scale.threw || '');

  // ---------------------------------------------------------------- 7. captions (v0.2)
  // When any entry of a sheet has a caption, EVERY cell of that sheet gets a 72 px strip: the number (bold 34 px) on the
  // first line, the caption (normal 22 px, #333) centered under it. The piece area shrinks so the piece never touches the strip.
  const CAP_CELL = 632;
  const capCaptions = ['~3 pieces joined', '~2 pieces joined', '~12 pieces joined', '', '~5 pieces joined', '~4 pieces joined', 'HEH', 'x'.repeat(70), '~6 pieces joined'];
  const FONT = '-apple-system, Helvetica, Arial, sans-serif';
  const cap = await page.evaluate(({ captions, font }) => {
    const rnd = T.rng(4242);
    const entries = captions.map((c, i) => {
      const e = { id: 'c' + i, canvas: T.makePiece(i, 380 + i * 12, 330 + i * 17, rnd, false) };
      if (c) e.caption = c;
      return e;
    });
    const t0 = performance.now();
    const sheets = PF.sheet.build(entries, { cols: 3, rows: 3, cell: 632, startNumber: 37 });
    const ms = performance.now() - t0;
    window.__capSheet = sheets[0];
    const cell = 632, strip = 72;
    const numberInk = (r, g, b) => (r + g + b) / 3 < 110;
    const anyInk = (r, g, b) => (r + g + b) / 3 < 200;       // includes the antialiased edge of the letters
    const c = sheets[0].canvas;
    const cells = entries.map((e, i) => {
      const x = (i % 3) * cell, y = Math.floor(i / 3) * cell;
      const capRect = { x: x + 4, y: y + cell - strip + 38, w: cell - 8, h: 30 };       // second line: strip top + 38 .. cell - 4
      return {
        i, x, y,
        stripTop: T.px(c, x + 10, y + cell - strip),
        aboveStrip: T.px(c, x + 10, y + cell - strip - 1),
        corner: T.px(c, x + 10, y + cell - 10),
        number: T.inkBox(c, { x: x + 4, y: y + cell - strip, w: cell - 8, h: 38 }, numberInk),   // first line: strip top .. +38
        caption: T.inkBox(c, capRect, anyInk),
        captionCount: T.count(c, capRect, anyInk),
        nearGrey333: T.count(c, capRect, (r, g, b) => Math.abs(r - 51) <= 6 && Math.abs(g - 51) <= 6 && Math.abs(b - 51) <= 6),
        darkerThan333: T.count(c, capRect, (r, g, b) => r < 45 || g < 45 || b < 45),
      };
    });
    return {
      ms, size: [c.width, c.height], numbers: sheets[0].entries.map((e) => e.number), ids: sheets[0].entries.map((e) => e.id),
      entryKeys: sheets[0].entries.map((e) => Object.keys(e).join()), cells,
      refNormal: T.inkCount('HEH', 'normal 22px ' + font, '#333333'),
      refBold: T.inkCount('HEH', 'bold 22px ' + font, '#333333'),
      refSmall: T.inkCount('HEH', 'normal 12px ' + font, '#333333'),
    };
  }, { captions: capCaptions, font: FONT });
  console.log(`      build(9 captioned entries, cell 632) took ${cap.ms.toFixed(1)} ms`);
  check('9 entries on a 3x3 sheet with cell 632 -> one 1896x1896 sheet', cap.size.join('x') === '1896x1896', cap.size.join('x'));
  check('numbers run 37..45 (startNumber 37), ids keep their order', cap.numbers.join() === '37,38,39,40,41,42,43,44,45' && cap.ids.join() === 'c0,c1,c2,c3,c4,c5,c6,c7,c8');
  check('returned entries are still just { number, id }', cap.entryKeys.every((k) => k === 'number,id'), cap.entryKeys[0]);
  check('strip is 72 px tall in EVERY cell of the sheet, also in the cell that has no caption',
    cap.cells.every((c) => isColor(c.stripTop, [255, 255, 255], 1) && isColor(c.aboveStrip, [230, 230, 230], 1) && isColor(c.corner, [255, 255, 255], 1)),
    JSON.stringify(cap.cells.filter((c) => !(isColor(c.stripTop, [255, 255, 255], 1) && isColor(c.aboveStrip, [230, 230, 230], 1))).map((c) => [c.i, c.stripTop, c.aboveStrip])));
  const numTop = cap.cells.map((c) => (c.number.y0 + c.number.y1 + 1) / 2 - (c.y + CAP_CELL - 72));
  const numH = cap.cells.map((c) => c.number.y1 - c.number.y0 + 1);
  const numDx = cap.cells.map((c) => Math.abs((c.number.x0 + c.number.x1 + 1) / 2 - (c.x + CAP_CELL / 2)));
  check('number sits on the first line: its ink is centered 22 px below the top of the strip (all 9 cells, +-2 px)',
    numTop.every((v) => Math.abs(v - 22) <= 2), numTop.map((v) => v.toFixed(1)).join(' '));
  check('number is still bold 34 px (about 24 px tall) and centered across the cell (x within 5 px)',
    Math.min(...numH) >= 21 && Math.max(...numH) <= 29 && Math.max(...numDx) <= 5, `${Math.min(...numH)}..${Math.max(...numH)} px, max dx ${Math.max(...numDx).toFixed(1)}`);
  check('number ink is on the same line in every cell (spread <= 2 px)', Math.max(...numTop) - Math.min(...numTop) <= 2);
  const capped = cap.cells.filter((c) => c.i !== 3);
  check('every captioned cell has caption ink; the cell without a caption has none', capped.every((c) => c.caption && c.caption.n > 40) && cap.cells[3].caption === null && cap.cells[3].captionCount === 0,
    capped.map((c) => c.caption ? c.caption.n : 'none').join(' '));
  const normal = capped.filter((c) => c.i !== 7);        // cell 7 holds the over-long caption, tested separately below
  const capDx = normal.map((c) => Math.abs((c.caption.x0 + c.caption.x1 + 1) / 2 - (c.x + CAP_CELL / 2)));
  check('caption is centered under the number (x within 5 px)', Math.max(...capDx) <= 5, `max dx ${Math.max(...capDx).toFixed(1)}`);
  const capTop = capped.map((c) => c.caption.y0 - (c.y + CAP_CELL - 72));
  const capBottom = capped.map((c) => (c.y + CAP_CELL) - 1 - c.caption.y1);
  const gaps = capped.map((c) => c.caption.y0 - c.number.y1 - 1);
  check('caption is on the second line: starts at least 40 px below the strip top, ends at least 3 px above the cell bottom',
    Math.min(...capTop) >= 40 && Math.min(...capBottom) >= 3, `top >= ${Math.min(...capTop)}, bottom clearance >= ${Math.min(...capBottom)}`);
  check('caption does not touch the number (at least 6 px clear between them)', Math.min(...gaps) >= 6, `min gap ${Math.min(...gaps)} px`);
  check('caption color is #333 (grey pixels present, nothing darker, so not black)', capped.every((c) => c.nearGrey333 >= 20 && c.darkerThan333 === 0),
    capped.map((c) => `${c.nearGrey333}/${c.darkerThan333}`).join(' '));
  const heh = cap.cells[6];
  const hehH = heh.caption.y1 - heh.caption.y0 + 1;
  check('caption "HEH" (capital letters only) is about 16 px tall: normal 22 px type', hehH >= 14 && hehH <= 18, `${hehH} px`);
  check('caption weight: its ink amount matches a normal 22 px reference (+-10%), not bold and not small',
    Math.abs(heh.captionCount - cap.refNormal) <= 0.10 * cap.refNormal && cap.refBold > 1.15 * cap.refNormal && cap.refSmall < 0.5 * cap.refNormal,
    `sheet ${heh.captionCount}, normal ${cap.refNormal}, bold ${cap.refBold}, 12 px ${cap.refSmall}`);
  const longCell = cap.cells[7];
  check('an over-long caption is shrunk to fit the cell: its ink stays at least 8 px away from both cell edges',
    longCell.caption.x0 >= longCell.x + 7 && longCell.caption.x1 <= longCell.x + CAP_CELL - 8 && longCell.caption.x1 - longCell.caption.x0 > 500,
    `x ${longCell.caption.x0 - longCell.x}..${longCell.caption.x1 - longCell.x}`);

  // ---- the piece area shrinks with the tall strip, the piece never touches the strip
  const capFit = await page.evaluate(() => {
    const solids = () => [
      { id: 'tall', canvas: T.solid(100, 300, '#ff0000'), caption: '~2 pieces joined' },
      { id: 'wide', canvas: T.solid(320, 100, '#0000ff'), caption: '~3 pieces joined' },
      { id: 'tiny', canvas: T.solid(60, 40, '#00aa00') },
      { id: 'square', canvas: T.solid(256, 256, '#ff00ff'), caption: '~4 pieces joined' },
    ];
    const preds = [
      (r, g, b) => r > 200 && g < 60 && b < 60,
      (r, g, b) => b > 200 && r < 60 && g < 60,
      (r, g, b) => g > 130 && r < 60 && b < 60,
      (r, g, b) => r > 200 && b > 200 && g < 60,
    ];
    const boxes = (cell) => {
      const sheet = PF.sheet.build(solids(), { cols: 2, rows: 2, cell })[0];
      return {
        size: [sheet.canvas.width, sheet.canvas.height],
        boxes: preds.map((pred, i) => {
          const x = (i % 2) * cell, y = Math.floor(i / 2) * cell;
          const b = T.inkBox(sheet.canvas, { x, y, w: cell, h: cell }, pred);
          return b && { x0: b.x0 - x, y0: b.y0 - y, x1: b.x1 - x, y1: b.y1 - y };
        }),
      };
    };
    return { small: boxes(316), big: boxes(632) };
  });
  check('cell 316 with captions: sheet is 632x632', capFit.small.size.join('x') === '632x632', capFit.small.size.join('x'));
  const expectCapBox = (name, got, x0, y0, x1, y1) => check(
    `captioned contain-fit: ${name} fills ${x1 - x0 + 1}x${y1 - y0 + 1} at (${x0},${y0})`,
    got && near(got.x0, x0, 2) && near(got.y0, y0, 2) && near(got.x1, x1, 2) && near(got.y1, y1, 2),
    got ? `got (${got.x0},${got.y0})-(${got.x1},${got.y1})` : 'no pixels');
  // piece area at cell 316 with the 72 px strip: 300 wide x 228 tall, 8 px from the top
  expectCapBox('cell 316, tall 100x300', capFit.small.boxes[0], 120, 8, 195, 235);
  expectCapBox('cell 316, wide 320x100', capFit.small.boxes[1], 8, 75, 307, 168);
  expectCapBox('cell 316, tiny 60x40 (scaled up, no caption on this entry: still the tall strip)', capFit.small.boxes[2], 8, 22, 307, 221);
  expectCapBox('cell 316, square 256x256', capFit.small.boxes[3], 44, 8, 271, 235);
  // piece area at cell 632: 616 wide x 544 tall
  expectCapBox('cell 632, tall 100x300', capFit.big.boxes[0], 226, 8, 406, 551);
  expectCapBox('cell 632, square 256x256 (scaled up to the 544 px height)', capFit.big.boxes[3], 44, 8, 587, 551);
  check('no piece reaches the strip: every piece ends at least 8 px above it (cell 316 and 632)',
    capFit.small.boxes.every((b) => b.y1 <= 316 - 72 - 8) && capFit.big.boxes.every((b) => b.y1 <= 632 - 72 - 8),
    `${capFit.small.boxes.map((b) => b.y1).join()} / ${capFit.big.boxes.map((b) => b.y1).join()}`);

  // ---- which sheets / entries get the tall strip
  const rules = await page.evaluate(() => {
    const mk = (n, extra) => Array.from({ length: n }, (_, i) => Object.assign({ id: 'r' + i, canvas: T.solid(80, 80, '#5577aa') }, extra ? extra(i) : {}));
    // Probes the strip height of every cell: 72 -> white at cell-72 and background above it; 44 -> white at cell-44 and background above it.
    const stripOf = (c, x, y, cell) => {
      const white = (yy) => { const p = T.px(c, x + 10, yy); return p[0] === 255 && p[1] === 255 && p[2] === 255; };
      const bg = (yy) => { const p = T.px(c, x + 10, yy); return p[0] === 230 && p[1] === 230 && p[2] === 230; };
      if (white(y + cell - 72) && bg(y + cell - 73)) return 72;
      if (white(y + cell - 44) && bg(y + cell - 45)) return 44;
      return 0;
    };
    const strips = (sheet, cell, cols) => sheet.entries.map((e, i) => stripOf(sheet.canvas, (i % cols) * cell, Math.floor(i / cols) * cell, cell));
    const out = {};
    // one caption on entry 1: the first sheet (36 cells) is tall everywhere, the second sheet (4 entries, no caption) is not
    const two = PF.sheet.build(mk(40, (i) => (i === 1 ? { caption: '~2 pieces joined' } : {})));
    out.perSheet = [strips(two[0], 316, 6), strips(two[1], 316, 6)];
    out.perSheetDims = two.map((s) => [s.canvas.width, s.canvas.height]);
    // a caption only on the LAST sheet's entry does not change the first sheet
    const lastOnly = PF.sheet.build(mk(40, (i) => (i === 38 ? { caption: '~9 pieces joined' } : {})));
    out.lastOnly = [strips(lastOnly[0], 316, 6), strips(lastOnly[1], 316, 6)];
    // values that are not a caption: empty, blanks, numbers, null, objects, booleans, an array
    const junk = ['', '   ', '\n\t', 5, null, undefined, {}, true, ['~2 pieces joined']];
    const none = PF.sheet.build(mk(junk.length, (i) => ({ caption: junk[i] })), { cols: 3, rows: 3 });
    out.junk = strips(none[0], 316, 3);
    // 10 clusters on 3x3 sheets of 632: two sheets, numbering continues, the second one has its own tall strip
    const ten = PF.sheet.build(mk(10, () => ({ caption: '~3 pieces joined' })), { cols: 3, rows: 3, cell: 632, startNumber: 50 });
    out.ten = { dims: ten.map((s) => [s.canvas.width, s.canvas.height, s.entries.length]), numbers: ten.map((s) => s.entries.map((e) => e.number)), strips: ten.map((s) => strips(s, 632, 3)) };
    // trimming: a caption with spaces around it is drawn exactly like the trimmed one
    const ink = (caption) => {
      const s = PF.sheet.build([{ id: 't', canvas: T.solid(80, 80, '#5577aa'), caption }], { cols: 1, rows: 1, cell: 316 })[0];
      return T.inkBox(s.canvas, { x: 4, y: 316 - 72 + 38, w: 308, h: 30 }, (r, g, b) => (r + g + b) / 3 < 200);
    };
    out.trim = [ink('~3 pieces joined'), ink('   ~3 pieces joined \n')];
    // an absurdly long caption must still stay inside its cell (squeezed at the smallest size)
    const wide = PF.sheet.build([{ id: 'w', canvas: T.solid(80, 80, '#5577aa'), caption: 'W'.repeat(300) }, { id: 'n', canvas: T.solid(80, 80, '#5577aa'), caption: 'N' }], { cols: 2, rows: 1, cell: 316 })[0];
    out.wide = {
      first: T.inkBox(wide.canvas, { x: 4, y: 316 - 72 + 38, w: 308, h: 30 }, (r, g, b) => (r + g + b) / 3 < 200),
      leakIntoSecond: T.count(wide.canvas, { x: 316 + 4, y: 316 - 72 + 38, w: 8, h: 30 }, (r, g, b) => (r + g + b) / 3 < 200),
      secondCenter: T.inkBox(wide.canvas, { x: 316 + 4, y: 316 - 72 + 38, w: 308, h: 30 }, (r, g, b) => (r + g + b) / 3 < 200),
    };
    return out;
  });
  const all = (arr, v) => arr.every((x) => x === v);
  check('one caption on a sheet makes every cell of THAT sheet 72 px; the next sheet without captions keeps 44 px',
    all(rules.perSheet[0], 72) && rules.perSheet[0].length === 36 && all(rules.perSheet[1], 44) && rules.perSheet[1].length === 4,
    `${rules.perSheet[0].join('')} | ${rules.perSheet[1].join(',')}`);
  check('sheet sizes do not depend on the strip height (1896x1896 and 1896x316)', JSON.stringify(rules.perSheetDims) === '[[1896,1896],[1896,316]]', JSON.stringify(rules.perSheetDims));
  check('a caption on the last sheet does not change the first sheet', all(rules.lastOnly[0], 44) && all(rules.lastOnly[1], 72), `${rules.lastOnly[0][0]} | ${rules.lastOnly[1].join(',')}`);
  check('empty, blank, numeric, null, object, boolean and array captions are not captions: the strip stays 44 px', all(rules.junk, 44), rules.junk.join(','));
  check('10 captioned entries on 3x3 sheets of 632 -> 9 + 1 entries, 1896x1896 and 1896x632',
    JSON.stringify(rules.ten.dims) === '[[1896,1896,9],[1896,632,1]]', JSON.stringify(rules.ten.dims));
  check('numbers continue across the two sheets (50..58, 59) and both sheets have the 72 px strip',
    rules.ten.numbers[0].join() === '50,51,52,53,54,55,56,57,58' && rules.ten.numbers[1].join() === '59' && all(rules.ten.strips[0], 72) && all(rules.ten.strips[1], 72));
  check('a caption with spaces and a newline around it is drawn exactly like the trimmed caption',
    JSON.stringify(rules.trim[0]) === JSON.stringify(rules.trim[1]) && rules.trim[0] && rules.trim[0].n > 40, JSON.stringify(rules.trim));
  check('a 300-letter caption is squeezed into its own cell: nothing leaks into the next cell, ink stays 7 px+ from the edges',
    rules.wide.first.x0 >= 7 && rules.wide.first.x1 <= 316 - 8 && rules.wide.leakIntoSecond === 0, `x ${rules.wide.first.x0}..${rules.wide.first.x1}, leak ${rules.wide.leakIntoSecond}`);
  check('a short caption ("N") in the next cell is still centered', rules.wide.secondCenter && Math.abs((rules.wide.secondCenter.x0 + rules.wide.secondCenter.x1 + 1) / 2 - (316 + 158)) <= 3);

  // ---- save the caption sheet and check that numbers and captions are still readable at 1000 px
  const capPng = await page.evaluate(() => T.png(window.__capSheet.canvas));
  const capPng1k = await page.evaluate(() => T.png(T.shrink(window.__capSheet.canvas, 1000)));
  fs.writeFileSync(path.join(outDir, 'test_sheet_captions.png'), Buffer.from(capPng, 'base64'));
  fs.writeFileSync(path.join(outDir, 'test_sheet_captions_1000.png'), Buffer.from(capPng1k, 'base64'));
  check('caption sheet PNGs saved to tests/out/ (full size and 1000 px)', fs.statSync(path.join(outDir, 'test_sheet_captions.png')).size > 10000 && fs.statSync(path.join(outDir, 'test_sheet_captions_1000.png')).size > 10000);

  // cut the number line / caption line of the cells out of the 1000 px picture, enlarge them 3x, read them with tesseract
  const ocrCells = [0, 1, 2, 4, 5, 8].map((i) => [i % 3, Math.floor(i / 3)]);          // the cells that hold a normal caption
  const ocrNumberCells = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => [i % 3, Math.floor(i / 3)]);
  const capStripPng = await page.evaluate((cells) => T.png(T.cellStack(T.shrink(window.__capSheet.canvas, 1000), cells, 632, 1000 / 1896, 3, { x: 6, y: 632 - 72 + 40, w: 632 - 12, h: 27 })), ocrCells);
  const numStripPng = await page.evaluate((cells) => T.png(T.cellStack(T.shrink(window.__capSheet.canvas, 1000), cells, 632, 1000 / 1896, 3, { x: 6, y: 632 - 72 + 2, w: 632 - 12, h: 38 })), ocrNumberCells);
  const capStripPath = path.join(outDir, 'test_sheet_captions_ocr_1000.png');
  const numStripPath = path.join(outDir, 'test_sheet_captions_numbers_1000.png');
  fs.writeFileSync(capStripPath, Buffer.from(capStripPng, 'base64'));
  fs.writeFileSync(numStripPath, Buffer.from(numStripPng, 'base64'));
  try {
    const run = (file, extra) => execFileSync('tesseract', [file, 'stdout', '--psm', '6', ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((t) => t.trim()).filter(Boolean);
    const capLines = run(capStripPath, []);
    const wantCaps = ['3 pieces joined', '2 pieces joined', '12 pieces joined', '5 pieces joined', '4 pieces joined', '6 pieces joined'];
    // the "~" is ignored when comparing: OCR engines often drop it or turn it into a dash
    const gotCaps = capLines.map((t) => t.replace(/^[^0-9a-z]+/i, '').replace(/\s+/g, ' '));
    const okCaps = wantCaps.filter((w, i) => gotCaps[i] === w).length;
    check('OCR reads all 6 captions from the sheet shrunk to 1000 px (text enlarged 3x)', okCaps === 6, `${okCaps}/6: ${JSON.stringify(capLines)}`);
    const numLines = run(numStripPath, ['-c', 'tessedit_char_whitelist=0123456789']);
    const okNums = Array.from({ length: 9 }, (_, i) => String(37 + i)).filter((w, i) => numLines[i] === w).length;
    check('OCR reads all 9 numbers on the caption sheet shrunk to 1000 px', okNums === 9, `${okNums}/9: ${JSON.stringify(numLines)}`);
  } catch (err) {
    console.log('SKIP  OCR of the captions and numbers (tesseract not available)');
  }

  check('no errors reported by the page', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\nALL SHEET TESTS PASSED' : `\n${failed} SHEET TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
