// Tests for poster.js (PF.poster.pick) in headless Chromium, 390x844 phone viewport.
// Run:  NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/test_poster_run.mjs
// Runs the main flow twice: mouse at DPR 1, and touch at DPR 3 (like an iPhone). Pictures go to tests/out/test_poster_*.png
import path from 'node:path';
import { loadPlaywright, startServer, makeChecker, findColor, root, outDir } from './test_poster_helpers.mjs';
import { runExtras } from './test_poster_extras.mjs';

const { chromium } = loadPlaywright();
const { check, state } = makeChecker();
const { server, port } = await startServer(root);
const URL = `http://127.0.0.1:${port}/tests/test_poster_page.html`;
const browser = await chromium.launch();
const helper = await (await browser.newContext()).newPage();
await helper.goto('about:blank');

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f1 = (v) => (typeof v === 'number' ? v.toFixed(2) : String(v));
const TX = 1540, TY = 640;            // center of the red target on the 2400x1600 test poster
const errorsAll = [];

// Builds a helper bundle (page, tap, screenshots, observers) for one browser context.
async function makeEnv(cfg, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: cfg.dpr, hasTouch: cfg.touch, isMobile: cfg.touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL);
  const L = (s) => `[${cfg.label}] ${s}`;
  const rect = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height };
  }, sel);
  const env = {
    cfg, ctx, page, errors, L, rect, check, near, f1, helper, browser, TX, TY, outDir, path,
    tap: (x, y) => (cfg.touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y)),
    shot: (name) => page.screenshot({ path: path.join(outDir, `test_poster_${cfg.label}_${name}.png`) }),
    start: async (o) => { await page.evaluate((a) => window.startPick(a), o || {}); await page.waitForSelector('.pf-poster-overlay'); },
    done: () => page.waitForFunction(() => window.__done === true),
    res: () => page.evaluate(() => window.__res),
    useDisabled: () => page.evaluate(() => document.querySelector('.pf-poster-use').disabled),
    stageW: () => page.evaluate(() => parseFloat(document.querySelector('.pf-poster-stage').style.width)),
    setSlider: (v) => page.$eval('.pf-poster-slider', (el, val) => {
      el.value = val; el.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(v)),
  };
  // Screen point of a poster pixel, from the base canvas rectangle (assumes a 2400x1600 poster).
  env.screenOf = async (px, py) => {
    const r = await rect('.pf-poster-base');
    return { x: r.x + (px / 2400) * r.w, y: r.y + (py / 1600) * r.h };
  };
  // Screenshots the pan area and finds the red target and the yellow marker (page CSS coordinates).
  env.observe = async () => {
    const pr = await rect('.pf-poster-pan');
    const cl = await page.evaluate(() => { const p = document.querySelector('.pf-poster-pan'); return { cw: p.clientWidth, ch: p.clientHeight }; });
    const clip = { x: Math.floor(pr.x), y: Math.floor(pr.y), width: cl.cw, height: cl.ch };   // client area: no scrollbar gutter
    const buf = await page.screenshot({ clip });
    const red = await findColor(helper, buf, 'red');
    const yel = await findColor(helper, buf, 'yellow');
    const d = cfg.dpr;
    return {
      pan: { x: clip.x, y: clip.y, w: clip.width, h: clip.height },
      red: red.n ? { n: red.n, x: clip.x + red.cx / d, y: clip.y + red.cy / d } : { n: 0 },
      yel: yel.n ? { n: yel.n, x: clip.x + yel.bx / d, y: clip.y + yel.by / d, w: yel.w / d, h: yel.h / d } : { n: 0 },
    };
  };
  // Asserts the marker is centered on the red target, has the right size, is visible, and that the marker canvas agrees.
  env.markerOnTarget = async (tag, pct, tol = 1.5) => {
    const o = await env.observe();
    const w = await env.stageW();
    const expectW = Math.max((pct / 100) * w + 3, 36);   // square outer size, or the crosshair when the square is tiny
    const okPos = o.red.n > 0 && o.yel.n > 0 && near(o.yel.x, o.red.x, tol) && near(o.yel.y, o.red.y, tol);
    check(L(`${tag}: marker center is on the red target (screen)`), okPos,
      `marker ${f1(o.yel.x)},${f1(o.yel.y)} red ${f1(o.red.x)},${f1(o.red.y)}`);
    check(L(`${tag}: marker size matches ${pct}%, no stale pixels`),
      o.yel.n > 0 && near(o.yel.w, expectW, 3.5) && near(o.yel.h, expectW, 3.5), `w=${f1(o.yel.w)} h=${f1(o.yel.h)} want ${f1(expectW)}`);
    const inside = o.yel.n > 0 && o.yel.x > o.pan.x && o.yel.x < o.pan.x + o.pan.w && o.yel.y > o.pan.y && o.yel.y < o.pan.y + o.pan.h;
    check(L(`${tag}: marker is inside the visible pan area`), inside);
    const ms = await page.evaluate(() => window.markerStats());
    const tolP = (tol * 2400) / w;
    const pcx = ((ms.minX + ms.maxX + 1) / 2 / ms.cw) * 2400;
    const pcy = ((ms.minY + ms.maxY + 1) / 2 / ms.ch) * 1600;
    check(L(`${tag}: marker canvas center is poster (${TX},${TY})`), near(pcx, TX, tolP) && near(pcy, TY, tolP),
      `got ${f1(pcx)},${f1(pcy)} tol ${f1(tolP)}`);
    return o;
  };
  return env;
}

// Opening state: DOM, text, sizes, theme.
async function testOpening(env) {
  const { page, L } = env;
  await env.start({});
  const s = await page.evaluate(() => {
    const q = (x) => document.querySelector(x);
    const ov = q('.pf-poster-overlay'); const cs = getComputedStyle(ov); const pan = q('.pf-poster-pan');
    const rr = (el) => el.getBoundingClientRect();
    const zb = [...document.querySelectorAll('.pf-poster-zoom button')];
    return {
      n: document.querySelectorAll('.pf-poster-overlay').length, parentBody: ov.parentNode === document.body,
      title: q('.pf-poster-title').textContent, cancel: q('.pf-poster-cancel').textContent, use: q('.pf-poster-use').textContent,
      useDisabled: q('.pf-poster-use').disabled, zoomTexts: zb.map((b) => b.textContent), pressed: zb.map((b) => b.getAttribute('aria-pressed')),
      smin: q('.pf-poster-slider').min, smax: q('.pf-poster-slider').max, sval: q('.pf-poster-slider').value,
      label: q('.pf-poster-size-text').textContent, out: q('.pf-poster-size-out').textContent,
      bg: cs.backgroundColor, fg: cs.color, pos: cs.position,
      ox: getComputedStyle(pan).overflowX, oy: getComputedStyle(pan).overflowY,
      styles: document.querySelectorAll('#pf-poster-style').length, css: document.getElementById('pf-poster-style').textContent,
      ovRect: rr(ov).toJSON(), heights: [q('.pf-poster-cancel'), q('.pf-poster-use'), ...zb, q('.pf-poster-slider')].map((e) => rr(e).height),
      widths: zb.map((e) => rr(e).width), sw: parseFloat(q('.pf-poster-stage').style.width), sh: parseFloat(q('.pf-poster-stage').style.height),
      cw: pan.clientWidth, baseW: q('.pf-poster-base').width, baseH: q('.pf-poster-base').height,
      markerW: q('.pf-poster-marker').width, scrollLeft: pan.scrollLeft, bodyOverflow: document.body.style.overflow,
      titleH: rr(q('.pf-poster-title')).height, titleLH: parseFloat(getComputedStyle(q('.pf-poster-title')).lineHeight),
      titleClipped: q('.pf-poster-title').scrollWidth > q('.pf-poster-title').clientWidth + 1,
      canvasInPan: q('.pf-poster-base').parentNode.parentNode === pan && q('.pf-poster-marker').parentNode === q('.pf-poster-base').parentNode,
      markerPos: getComputedStyle(q('.pf-poster-marker')).position, markerEvents: getComputedStyle(q('.pf-poster-marker')).pointerEvents,
    };
  });
  const dpr = env.cfg.dpr;
  check(L('one overlay.pf-poster-overlay appended to body'), s.n === 1 && s.parentBody && s.pos === 'fixed');
  check(L('title text'), s.title === 'Tap the empty spot', s.title);
  check(L('button texts'), s.cancel === 'Cancel' && s.use === 'Use this spot');
  check(L('title fits on one line at 390 px (not cut off)'), s.titleH <= s.titleLH * 1.5 && !s.titleClipped, `height ${f1(s.titleH)} line ${f1(s.titleLH)}`);
  check(L('Use this spot starts disabled'), s.useDisabled === true);
  check(L('zoom buttons 1x 2x 4x, default 2x pressed'), s.zoomTexts.join() === ['1×', '2×', '4×'].join() && s.pressed.join() === 'false,true,false', s.zoomTexts.join(' '));
  check(L('slider 4..25, default 10, label "Spot size", readout 10%'),
    s.smin === '4' && s.smax === '25' && s.sval === '10' && s.label === 'Spot size' && s.out === '10%');
  check(L('dark theme #111 / #eee'), s.bg === 'rgb(17, 17, 17)' && s.fg === 'rgb(238, 238, 238)', `${s.bg} ${s.fg}`);
  check(L('pan area overflow auto + -webkit-overflow-scrolling touch'), s.ox === 'auto' && s.oy === 'auto' && s.css.includes('-webkit-overflow-scrolling:touch'));
  check(L('style injected once (#pf-poster-style)'), s.styles === 1);
  check(L('overlay fills the viewport'), s.ovRect.x === 0 && s.ovRect.y === 0 && s.ovRect.width === 390 && s.ovRect.height === 844);
  check(L('buttons and slider are at least 48 px tall'), s.heights.every((h) => h >= 48), s.heights.map(f1).join(' '));
  check(L('slider thumb css is 40 px'), /::-webkit-slider-thumb\{[^}]*width:40px;height:40px/.test(s.css));
  check(L('stage is containerWidth x 2'), near(s.sw, s.cw * 2, 0.5) && near(s.sh, (s.cw * 2 * 1600) / 2400, 0.5), `${s.sw}x${s.sh} container ${s.cw}`);
  check(L('canvas pixel width = min(css*dpr, poster)'), s.baseW === Math.min(Math.round(s.sw * dpr), 2400) && s.markerW === s.baseW, `${s.baseW}`);
  check(L('two canvases layered, marker on top and click-through'), s.canvasInPan && s.markerPos === 'absolute' && s.markerEvents === 'none');
  check(L('view starts centered on the poster'), near(s.scrollLeft, (s.sw - s.cw) / 2, 1), `scrollLeft ${s.scrollLeft}`);
  check(L('body scroll locked while open'), s.bodyOverflow === 'hidden');
  await env.shot('01_open');
}

// Gestures that must NOT set a spot: drag, pointercancel, two fingers, touch swipe, disabled button.
async function testRejectedGestures(env) {
  const { page, L } = env;
  const pr = await env.rect('.pf-poster-pan');
  const sx = pr.x + 60, sy = pr.y + 80;
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 9, sy, { steps: 3 }); await page.mouse.up();
  check(L('drag of 9 px is not a tap'), await env.useDisabled());
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 40, sy + 10, { steps: 5 }); await page.mouse.up();
  check(L('drag of 40 px is not a tap'), await env.useDisabled());
  await page.evaluate(() => {
    const st = document.querySelector('.pf-poster-stage'); const r = st.getBoundingClientRect();
    const ev = (type, id) => st.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', isPrimary: true, clientX: r.left + 50, clientY: r.top + 50 }));
    ev('pointerdown', 21); ev('pointercancel', 21); ev('pointerup', 21);          // browser took over for scrolling
    ev('pointerdown', 31); ev('pointerdown', 32); ev('pointerup', 31); ev('pointerup', 32);   // two fingers (pinch)
  });
  check(L('pointercancel and two-finger gestures are not taps'), await env.useDisabled());
  await page.evaluate(() => document.querySelector('.pf-poster-use').click());
  check(L('overlay stays open when the disabled Use button is clicked'), (await page.evaluate(() => document.querySelectorAll('.pf-poster-overlay').length)) === 1);
  if (env.cfg.touch) {
    const cdp = await env.ctx.newCDPSession(page);
    const before = await page.evaluate(() => document.querySelector('.pf-poster-pan').scrollLeft);
    const x0 = pr.x + 300, y0 = pr.y + 200;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - i * 12, y: y0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelector('.pf-poster-pan').scrollLeft);
    check(L('touch swipe pans the view and does not set a spot'), (await env.useDisabled()) && after !== before, `scrollLeft ${f1(before)} -> ${f1(after)}`);
  }
}

// First real tap on the red target, then a 5 px wiggle tap elsewhere, then back to the target.
async function testTapAccuracy(env) {
  const { page, L } = env;
  let o = await env.observe();
  const exact = await env.screenOf(TX, TY);
  check(L('rendered red target is where the canvas rectangle says (screen vs layout)'),
    o.red.n > 0 && near(o.red.x, exact.x, 1) && near(o.red.y, exact.y, 1), `red ${f1(o.red.x)},${f1(o.red.y)} exact ${f1(exact.x)},${f1(exact.y)}`);
  await env.tap(o.red.x, o.red.y);
  check(L('Use this spot enabled after the first tap'), !(await env.useDisabled()));
  await env.markerOnTarget('first tap on red (screenshot centroid)', 10);
  await env.shot('02_tapped');
  const st = await env.rect('.pf-poster-stage');            // the poster can be letterboxed inside the pan area
  const wx = o.pan.x + 60, wy = Math.max(o.pan.y, st.y) + 60;
  await page.mouse.move(wx, wy); await page.mouse.down(); await page.mouse.move(wx + 3, wy + 4); await page.mouse.up();
  const w = await env.observe();
  check(L('tap with a 5 px wiggle still counts and moves the marker'), w.yel.n > 0 && near(w.yel.x, wx + 3, 1.6) && near(w.yel.y, wy + 4, 1.6),
    `marker ${f1(w.yel.x)},${f1(w.yel.y)} want ${f1(wx + 3)},${f1(wy + 4)}`);
  // Threshold: 5 px right + 5 px down = 7.07 px is still a tap, 6 + 6 = 8.49 px is not.
  const bx = wx + 20, by = wy + 20;
  await page.mouse.move(bx, by); await page.mouse.down(); await page.mouse.move(bx + 5, by + 5); await page.mouse.up();
  const t1 = await env.observe();
  check(L('7.07 px of movement is still a tap'), t1.yel.n > 0 && near(t1.yel.x, bx + 5, 1.6) && near(t1.yel.y, by + 5, 1.6), `marker ${f1(t1.yel.x)},${f1(t1.yel.y)} want ${bx + 5},${by + 5}`);
  await page.mouse.move(bx + 60, by + 60); await page.mouse.down(); await page.mouse.move(bx + 66, by + 66); await page.mouse.up();
  const t2 = await env.observe();
  check(L('8.49 px of movement is not a tap (marker stays)'), t2.yel.n > 0 && near(t2.yel.x, bx + 5, 1.6) && near(t2.yel.y, by + 5, 1.6), `marker ${f1(t2.yel.x)},${f1(t2.yel.y)}`);
  await env.tap(exact.x, exact.y);
  await env.markerOnTarget('back on the target (old marker erased)', 10);
}

// Mouse moves, taps and slider moves must not redraw the poster; a zoom change must.
async function testNoRedraw(env) {
  const { page, L } = env;
  const pr = await env.rect('.pf-poster-pan');
  await page.evaluate(() => { window.__draw.drawImage = 0; });
  for (let i = 0; i < 40; i++) await page.mouse.move(pr.x + 20 + i * 7, pr.y + 100 + (i % 5) * 9);
  await env.setSlider(14); await env.setSlider(9); await env.setSlider(10);
  const exact = await env.screenOf(TX, TY);
  await env.tap(exact.x, exact.y);
  const n0 = await page.evaluate(() => window.__draw.drawImage);
  check(L('no poster redraw on 40 pointer moves, a tap and 3 slider moves'), n0 === 0, `drawImage calls: ${n0}`);
}

// Zoom 1x, 4x, 2x: size, pressed state, canvas size, marker still on the same poster point, view centered.
async function testZoom(env) {
  const { page, L } = env;
  for (const z of [1, 4, 2]) {
    const t0 = await page.evaluate((zz) => {
      const t = performance.now(); document.querySelector(`.pf-poster-zoom [data-zoom="${zz}"]`).click(); return performance.now() - t;
    }, z);
    const i = await page.evaluate(() => {
      const pan = document.querySelector('.pf-poster-pan'); const st = document.querySelector('.pf-poster-stage');
      return { sw: parseFloat(st.style.width), sh: parseFloat(st.style.height), cw: pan.clientWidth, bw: document.querySelector('.pf-poster-base').width,
               pressed: [...document.querySelectorAll('.pf-poster-zoom button')].map((b) => b.getAttribute('aria-pressed')).join() };
    });
    check(L(`zoom ${z}x: stage = containerWidth x ${z}`), near(i.sw, i.cw * z, 0.5) && near(i.sh, (i.sw * 1600) / 2400, 0.5), `${i.sw} vs ${i.cw * z}`);
    check(L(`zoom ${z}x: pressed state`), i.pressed === [1, 2, 4].map((k) => String(k === z)).join(), i.pressed);
    check(L(`zoom ${z}x: canvas pixel width = min(css*dpr, 2400)`), i.bw === Math.min(Math.round(i.sw * env.cfg.dpr), 2400), String(i.bw));
    const o = await env.markerOnTarget(`zoom ${z}x`, 10, z === 1 ? 2.2 : 1.5);
    if (z >= 2) check(L(`zoom ${z}x: spot centered horizontally`), near(o.yel.x, o.pan.x + o.pan.w / 2, 3), `${f1(o.yel.x)} vs ${f1(o.pan.x + o.pan.w / 2)}`);
    if (z === 4) check(L('zoom 4x: spot centered vertically'), near(o.yel.y, o.pan.y + o.pan.h / 2, 3), `${f1(o.yel.y)} vs ${f1(o.pan.y + o.pan.h / 2)}`);
    await env.shot(`03_zoom${z}x`);
    const ex = await env.screenOf(TX, TY);
    await env.tap(ex.x, ex.y);
    await env.markerOnTarget(`tap at zoom ${z}x`, 10, z === 1 ? 2.2 : 1.5);
    console.log(`INFO  [${env.cfg.label}] zoom ${z}x relayout+redraw took ${t0.toFixed(1)} ms`);
    check(L(`zoom ${z}x: redraw under 400 ms`), t0 < 400);
  }
  const n1 = await page.evaluate(() => window.__draw.drawImage);
  check(L('zoom change redraws the poster'), n1 > 0, `drawImage calls: ${n1}`);
}

// Slider values: readout, marker size, centered square, real drag on the slider thumb.
async function testSlider(env) {
  const { page, L } = env;
  for (const v of [20, 6, 25, 4]) {
    await env.setSlider(v);
    const out = await page.$eval('.pf-poster-size-out', (e) => e.textContent);
    check(L(`slider ${v}: readout "${v}%"`), out === `${v}%`);
    await env.markerOnTarget(`slider ${v}%`, v);
    if (v === 25 || v === 4) await env.shot(`04_size${v}`);
  }
  const sr = await env.rect('.pf-poster-slider');
  const y = sr.y + sr.h / 2;
  await page.mouse.move(sr.x + 20, y); await page.mouse.down();
  await page.mouse.move(sr.x + 20 + 0.5 * (sr.w - 40), y, { steps: 6 }); await page.mouse.up();
  const v = Number(await page.$eval('.pf-poster-slider', (e) => e.value));
  check(L('dragging the slider thumb changes the size'), v >= 12 && v <= 17, `value ${v}`);
  await env.markerOnTarget(`after dragging the slider to ${v}%`, v);
  if (env.cfg.touch) {                       // a real finger drag (touch events) on the slider thumb
    const cdp = await env.ctx.newCDPSession(page);
    const v0 = Number(await page.$eval('.pf-poster-slider', (e) => e.value));
    const x0 = sr.x + 20 + ((v0 - 4) / 21) * (sr.w - 40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + i * 12, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const v1 = Number(await page.$eval('.pf-poster-slider', (e) => e.value));
    check(L('finger drag on the slider thumb changes the size'), v1 > v0, `value ${v0} -> ${v1}`);
    await env.markerOnTarget(`after finger-dragging the slider to ${v1}%`, v1);
  }
  await env.setSlider(12);
}

// Use this spot: result values, crop size and pixels, overlay and listeners removed.
async function testUse(env) {
  const { page, L } = env;
  const ex = await env.screenOf(TX, TY);
  await env.tap(ex.x, ex.y);
  await page.click('.pf-poster-use');
  await env.done();
  const r = await env.res();
  check(L('result cx, cy within 2 px of the target center'), near(r.cx, TX, 2) && near(r.cy, TY, 2), `${r.cx},${r.cy}`);
  check(L('result frac = 0.12'), r.frac === 0.12, String(r.frac));
  check(L('cropCanvas is 288 x 288 (0.12 * 2400)'), r.cw === 288 && r.ch === 288, `${r.cw}x${r.ch}`);
  const x0 = Math.min(Math.max(Math.round(r.cx - 144), 0), 2400 - 288), y0 = Math.min(Math.max(Math.round(r.cy - 144), 0), 1600 - 288);
  const diff = await page.evaluate(([a, b]) => window.cropDiff(a, b, 288), [x0, y0]);
  check(L('crop pixels equal the poster region around the spot'), diff === 0, `mean abs diff ${diff}`);
  const after = await page.evaluate(() => ({ n: document.querySelectorAll('.pf-poster-overlay').length, ov: document.body.style.overflow,
    before: window.__bodyOverflowBefore, net: window.listenerNet(), adds: window.__log.adds.length, left: window.listenerLeft().join(' ') }));
  check(L('overlay removed after Use this spot'), after.n === 0);
  check(L('body scroll restored'), after.ov === after.before);
  check(L('every listener added was removed'), after.net === 0 && after.adds > 5, `net ${after.net} of ${after.adds}: ${after.left}`);
}

// ---- main
for (const cfg of [{ label: 'mouse-dpr1', dpr: 1, touch: false }, { label: 'touch-dpr3', dpr: 3, touch: true }]) {
  console.log(`\n=== suite ${cfg.label} ===`);
  const env = await makeEnv(cfg);
  await testOpening(env);
  await testRejectedGestures(env);
  await testTapAccuracy(env);
  await testNoRedraw(env);
  await testZoom(env);
  await testSlider(env);
  await testUse(env);
  await runExtras(env, makeEnv);
  check(env.L('no page errors'), env.errors.length === 0, env.errors.join(' | '));
  await env.ctx.close();
}

await browser.close();
server.close();
console.log(`\n${state.fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${state.pass} passed, ${state.fail} failed`);
if (state.fail) { console.log('Failed:\n - ' + state.failed.join('\n - ')); process.exit(1); }
