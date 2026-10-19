// Tests for sheet.js (PF.sheet.build and PF.sheet.drawMarks) in headless Chromium.
// Run:  NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/test_sheet_build.mjs
// Writes pictures to tests/out/ so a person can look at them:
//   test_sheet_sheet1.png, test_sheet_sheet2.png, test_sheet_sheet1_1000.png, test_sheet_marks.png, ...
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

  check('no errors reported by the page', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\nALL SHEET TESTS PASSED' : `\n${failed} SHEET TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
