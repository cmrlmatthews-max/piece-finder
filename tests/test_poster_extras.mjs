// Extra scenarios for poster.js, called from test_poster_run.mjs with the same browser context.
// Covers: Cancel, Escape, initial values, edge crops, big / small / portrait posters, resize, a second pick(), bad input.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Returns overlay count, body overflow state and the number of listeners that were added but never removed.
function closedState(page) {
  return page.evaluate(() => ({ n: document.querySelectorAll('.pf-poster-overlay').length, ovOk: document.body.style.overflow === window.__bodyOverflowBefore,
    net: window.listenerNet(), styles: document.querySelectorAll('#pf-poster-style').length }));
}

// Cancel and Escape both resolve null and clean up.
async function testCancel(env) {
  const { page, L, check } = env;
  await env.start({});
  await page.click('.pf-poster-cancel');
  await env.done();
  let c = await closedState(page);
  check(L('Cancel resolves null'), (await env.res()) === null);
  check(L('Cancel removes overlay, restores body scroll, removes all listeners'), c.n === 0 && c.ovOk && c.net === 0, JSON.stringify(c));
  await env.start({ initial: { cx: 500, cy: 500, frac: 0.1 } });
  await page.keyboard.press('Escape');
  await env.done();
  c = await closedState(page);
  check(L('Escape resolves null and cleans up'), (await env.res()) === null && c.n === 0 && c.net === 0, JSON.stringify(c));
}

// Starting spots, clamping of out-of-range values, and the crop at the corners and at the size limits.
async function testInitialAndCrops(env) {
  const { page, L, check, near, f1 } = env;
  const cases = [
    { name: 'initial (600,400) 20%', initial: { cx: 600, cy: 400, frac: 0.2 }, side: 480, cx: 600, cy: 400, frac: 0.2, marker: true },
    { name: 'top-left corner (10,10) 10%', initial: { cx: 10, cy: 10, frac: 0.1 }, side: 240, cx: 10, cy: 10, frac: 0.1 },
    { name: 'bottom-right corner (2395,1595) 10%', initial: { cx: 2395, cy: 1595, frac: 0.1 }, side: 240, cx: 2395, cy: 1595, frac: 0.1 },
    { name: 'right edge (2399,800) 25%', initial: { cx: 2399, cy: 800, frac: 0.25 }, side: 600, cx: 2399, cy: 800, frac: 0.25 },
    { name: 'minimum size 4%', initial: { cx: 1200, cy: 800, frac: 0.04 }, side: 96, cx: 1200, cy: 800, frac: 0.04, marker: true },
    { name: 'frac 0.9 is clamped to 25%', initial: { cx: 1200, cy: 800, frac: 0.9 }, side: 600, cx: 1200, cy: 800, frac: 0.25 },
    { name: 'frac 0.01 is clamped to 4%', initial: { cx: 1200, cy: 800, frac: 0.01 }, side: 96, cx: 1200, cy: 800, frac: 0.04 },
    { name: 'cx,cy outside are clamped', initial: { cx: -50, cy: 99999, frac: 0.1 }, side: 240, cx: 0, cy: 1600, frac: 0.1 },
  ];
  for (const c of cases) {
    await env.start({ initial: c.initial });
    const st = await page.evaluate(() => ({ dis: document.querySelector('.pf-poster-use').disabled, sv: document.querySelector('.pf-poster-slider').value }));
    check(L(`${c.name}: Use enabled, slider ${Math.round(c.frac * 100)}`), !st.dis && st.sv === String(Math.round(c.frac * 100)), `slider ${st.sv}`);
    if (c.marker) {
      const ms = await page.evaluate(() => window.markerStats());
      const w = await env.stageW();
      const tol = (1.5 * 2400) / w;
      const pcx = ((ms.minX + ms.maxX + 1) / 2 / ms.cw) * 2400, pcy = ((ms.minY + ms.maxY + 1) / 2 / ms.ch) * 1600;
      check(L(`${c.name}: marker drawn at the starting spot`), near(pcx, c.cx, tol) && near(pcy, c.cy, tol), `${f1(pcx)},${f1(pcy)}`);
      const sc = await page.evaluate(() => { const p = document.querySelector('.pf-poster-pan'); return { l: p.scrollLeft, w: p.clientWidth }; });
      const wantL = clamp((c.cx / 2400) * w - sc.w / 2, 0, w - sc.w);
      check(L(`${c.name}: view centered on the starting spot`), near(sc.l, wantL, 1.5), `scrollLeft ${f1(sc.l)} want ${f1(wantL)}`);
    }
    await page.click('.pf-poster-use');
    await env.done();
    const r = await env.res();
    check(L(`${c.name}: result values`), r.cx === c.cx && r.cy === c.cy && near(r.frac, c.frac, 1e-9) && r.cw === c.side && r.ch === c.side,
      `${r.cx},${r.cy} frac ${r.frac} crop ${r.cw}x${r.ch}`);
    const x0 = clamp(Math.round(r.cx - c.side / 2), 0, 2400 - c.side), y0 = clamp(Math.round(r.cy - c.side / 2), 0, 1600 - c.side);
    const diff = await page.evaluate(([a, b, s]) => window.cropDiff(a, b, s), [x0, y0, c.side]);
    check(L(`${c.name}: crop stays inside the poster and matches its pixels`), diff === 0, `diff ${diff} from ${x0},${y0}`);
  }
}

// 5000x3000 poster: crop long edge is limited to 1000 and canvases stay <= 4096. 600x400 poster: no upscaled canvas.
async function testPosterSizes(env) {
  const { page, L, check, f1 } = env;
  const dpr = env.cfg.dpr;
  await env.start({ W: 5000, H: 3000, initial: { cx: 2500, cy: 1500, frac: 0.25 } });
  await page.click('.pf-poster-zoom [data-zoom="4"]');
  const cv = await page.evaluate(() => ({ w: document.querySelector('.pf-poster-base').width, h: document.querySelector('.pf-poster-base').height,
    mw: document.querySelector('.pf-poster-marker').width, sw: parseFloat(document.querySelector('.pf-poster-stage').style.width) }));
  let bw = Math.min(cv.sw * dpr, 5000), bh = bw * 0.6; const k = Math.min(1, 4096 / Math.max(bw, bh)); bw = Math.round(bw * k);
  check(L('5000x3000 poster at 4x: canvas pixels capped at 4096 per side'), cv.w <= 4096 && cv.h <= 4096 && cv.w === bw && cv.mw === cv.w, `${cv.w}x${cv.h} want width ${bw}`);
  await page.click('.pf-poster-use');
  await env.done();
  const r = await env.res();
  check(L('5000x3000 poster, 25%: crop (1250 px) is downscaled to 1000 x 1000'), r.cw === 1000 && r.ch === 1000, `${r.cw}x${r.ch}`);
  const diff = await page.evaluate(() => window.cropDiff(1875, 875, 1250));   // center 2500,1500 minus half of 1250
  check(L('downscaled crop matches the poster region'), diff < 1, `diff ${f1(diff)}`);

  await env.start({ W: 600, H: 400, initial: { cx: 300, cy: 200, frac: 0.1 } });
  await page.click('.pf-poster-zoom [data-zoom="4"]');
  const sm = await page.evaluate(() => document.querySelector('.pf-poster-base').width);
  check(L('600x400 poster at 4x: canvas is not larger than the poster'), sm === 600, String(sm));
  await page.click('.pf-poster-use');
  await env.done();
  const r2 = await env.res();
  check(L('600x400 poster, 10%: crop 60 x 60'), r2.cw === 60 && r2.ch === 60, `${r2.cw}x${r2.ch}`);
}

// Portrait poster (1600x2400): taps and crop work with scrolling in both directions.
async function testPortrait(env) {
  const { page, L, check, near, f1 } = env;
  await env.start({ W: 1600, H: 2400 });
  const geo = await page.evaluate(() => ({ t: window.TARGET, sw: parseFloat(document.querySelector('.pf-poster-stage').style.width),
    sh: parseFloat(document.querySelector('.pf-poster-stage').style.height), pw: document.querySelector('.pf-poster-pan').clientHeight }));
  check(L('portrait poster: stage is taller than wide, pan area scrolls'), near(geo.sh, geo.sw * 1.5, 0.5) && geo.sh > geo.pw, `${geo.sw}x${geo.sh}`);
  await env.shot('07_portrait');
  const r0 = await env.rect('.pf-poster-base');
  await env.tap(r0.x + (geo.t.cx / 1600) * r0.w, r0.y + (geo.t.cy / 2400) * r0.h);
  await page.click('.pf-poster-use');
  await env.done();
  const r = await env.res();
  check(L('portrait poster: result within 2 px of the target'), near(r.cx, geo.t.cx, 2) && near(r.cy, geo.t.cy, 2), `${r.cx},${r.cy} want ${geo.t.cx},${geo.t.cy}`);
  check(L('portrait poster: crop is 160 x 160'), r.cw === 160 && r.ch === 160, `${r.cw}x${r.ch}`);
  await page.evaluate(() => window.makePoster(2400, 1600));
}

// Rotation and narrow phones: the layout follows the window, the marker stays on the same poster point.
async function testResize(env) {
  const { page, L, check, near } = env;
  await env.start({ initial: { cx: env.TX, cy: env.TY, frac: 0.1 } });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(450);
  const lw = await page.evaluate(() => ({ sw: parseFloat(document.querySelector('.pf-poster-stage').style.width), cw: document.querySelector('.pf-poster-pan').clientWidth }));
  check(L('landscape 844x390: stage follows the new width'), lw.cw > 800 && near(lw.sw, lw.cw * 2, 0.5), `${lw.sw} vs ${lw.cw * 2}`);
  await env.markerOnTarget('landscape 844x390', 10);
  await env.shot('05_landscape');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(450);
  const nr = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { c: r('.pf-poster-cancel').toJSON(), u: r('.pf-poster-use').toJSON(), t: r('.pf-poster-title').toJSON(), pan: r('.pf-poster-pan').toJSON(),
      ctl: r('.pf-poster-controls').toJSON(), sl: r('.pf-poster-slider').toJSON(), sh: document.documentElement.scrollWidth };
  });
  check(L('320 px wide: Cancel, title and Use all fit and do not overlap'),
    nr.c.left >= 0 && nr.u.right <= 320 && nr.c.right <= nr.u.left && nr.t.bottom <= nr.c.top + 1 && nr.t.right <= 320 && nr.t.left >= 0,
    `cancel ${nr.c.left}-${nr.c.right}, use ${nr.u.left}-${nr.u.right}, title bottom ${nr.t.bottom} cancel top ${nr.c.top}`);
  check(L('320 px wide: slider fits inside the screen and the page does not scroll sideways'), nr.sl.left >= 0 && nr.sl.right <= 320 && nr.sh <= 320, `slider ${nr.sl.left}-${nr.sl.right}`);
  await env.markerOnTarget('narrow 320x568', 10);
  await env.shot('06_narrow320');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  await env.markerOnTarget('back to 390x844', 10);
  await page.click('.pf-poster-cancel');
  await env.done();
}

// A second pick() while one is open closes the first with null; bad input rejects with a plain message.
async function testReplaceAndBadInput(env) {
  const { page, L, check } = env;
  const rep = await page.evaluate(async () => {
    window.startPick({});
    const first = window.__p.then((x) => (x === null ? 'null' : 'value'));
    window.startPick({});
    const out = await first;
    return { out, n: document.querySelectorAll('.pf-poster-overlay').length };
  });
  check(L('second pick() closes the first one with null and leaves one overlay'), rep.out === 'null' && rep.n === 1, JSON.stringify(rep));
  await page.evaluate(() => { window.__done = false; });
  await page.click('.pf-poster-cancel');
  await env.done();
  const msg = await page.evaluate(() => PF.poster.pick({}).then(() => 'resolved', (e) => e.message));
  check(L('pick() without a poster rejects with a plain message'), msg === 'No poster to pick from.', msg);
  const c = await page.evaluate(() => ({ n: document.querySelectorAll('.pf-poster-overlay').length, styles: document.querySelectorAll('#pf-poster-style').length }));
  check(L('no overlay left over, style tag still injected once'), c.n === 0 && c.styles === 1, JSON.stringify(c));
}

// A pointer that never comes up must not block later taps; a failing crop closes the overlay and rejects.
async function testRobustness(env) {
  const { page, L, check } = env;
  await env.start({});
  await page.evaluate(() => {
    const st = document.querySelector('.pf-poster-stage'); const r = st.getBoundingClientRect();
    st.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, pointerType: 'touch', isPrimary: true, clientX: r.left + 40, clientY: r.top + 40 }));
  });                                         // finger 41 goes down and is never released
  await page.waitForTimeout(1700);
  const ex = await env.screenOf(env.TX, env.TY);
  await env.tap(ex.x, ex.y);
  check(L('a lost pointer-up does not block later taps'), !(await env.useDisabled()));
  await page.evaluate(() => { window.__throwNext = true; });
  await page.click('.pf-poster-use');
  await env.done();
  const r = await env.res();
  const c = await closedState(page);
  check(L('a failing crop rejects the promise and closes the overlay'), r && r.error === 'boom' && c.n === 0 && c.ovOk && c.net === 0, JSON.stringify({ r, c }));
}

export async function runExtras(env) {
  await testCancel(env);
  await testRobustness(env);
  await testInitialAndCrops(env);
  await testPosterSizes(env);
  await testPortrait(env);
  await testResize(env);
  await testReplaceAndBadInput(env);
}
