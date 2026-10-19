// Headless-Chromium test for PF.segment (segment.js).
//   NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/test_segment.mjs [name-filter] [--sweep] [--plain]
// Serves the project folder from a tiny local http server (no file://), loads tests/segment.html,
// runs PF.segment.detect on every tests/fixtures/*.jpg and checks it against the sidecar JSON.
// Writes a debug PNG per fixture to tests/out/. Exit code 1 when any check fails.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIX_DIR = path.join(HERE, 'fixtures');
const OUT_DIR = path.join(HERE, 'out');
const MAX_BOX_FRAC = 0.40;   // no box may cover more than 40 % of the image
const BUDGET_MS = 1500;      // spec: < 1.5 s on a phone
const WARN_MS = 400;         // spec note: optimise if a headless desktop run is slower than this
const REPS = 5;              // warm repetitions after the timed cold call

const args = process.argv.slice(2);
const sweep = args.includes('--sweep');                     // also print counts for thresholdScale 0.5 .. 1.5
const plain = args.includes('--plain');                     // force the plain <img> loader (ignore imgutil.js)
const filter = args.find((a) => !a.startsWith('--')) || '';
const PAGE = '/tests/segment.html' + (plain ? '?loader=plain' : '');

// Loads Playwright from NODE_PATH, or from the global install path used on this machine.
function loadPlaywright() {
  for (const id of ['playwright', '/home/claude/.npm-global/lib/node_modules/playwright']) {
    try { return require(id); } catch (e) { /* try next */ }
  }
  console.error('Cannot load playwright. Run with NODE_PATH=/home/claude/.npm-global/lib/node_modules');
  process.exit(2);
}

// Starts a static file server for the project root on a free port; returns { server, port }.
async function startServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(ROOT, path.normalize(rel));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

// Launches headless Chromium (default install first, then the /opt/pw-browsers symlink).
async function launch(chromium) {
  try { return await chromium.launch(); }
  catch (e) { return await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
}

// Median of a list of numbers (mean of the two middle values when even).
function median(a) {
  const s = [...a].sort((x, y) => x - y), n = s.length;
  return n === 0 ? 0 : (n & 1 ? s[(n - 1) >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2);
}

const inside = (p, c) => c[0] >= p.x && c[0] <= p.x + p.w && c[1] >= p.y && c[1] <= p.y + p.h;

// Builds the list of { name, ok, detail } checks for one fixture.
function checkFixture(truth, r) {
  const pieces = r.res.pieces, [W, H] = r.size, checks = [];
  const n = pieces.length;
  checks.push({ name: 'count within +-1 of truth', ok: Math.abs(n - truth.count) <= 1, detail: `${n} vs ${truth.count}` });

  const missed = truth.centers.map((c, i) => [c, i]).filter(([c]) => !pieces.some((p) => inside(p, c))).map(([, i]) => i);
  checks.push({ name: 'every true centre inside a box', ok: missed.length === 0, detail: missed.length ? 'missed centres #' + missed.join(',') : '' });

  const big = pieces.filter((p) => p.w * p.h > MAX_BOX_FRAC * W * H);
  checks.push({ name: 'no box above 40% of the image', ok: big.length === 0, detail: big.map((p) => `${p.w}x${p.h}`).join(' ') });

  const pairs = truth.touching_pairs || [];
  if (pairs.length) {
    const bad = pairs.filter(([i, j]) => !pieces.some((p) => p.merged && inside(p, truth.centers[i]) && inside(p, truth.centers[j])));
    checks.push({ name: 'touching pair is one box with merged=true', ok: bad.length === 0, detail: bad.length ? 'pairs ' + JSON.stringify(bad) : '' });
  } else {
    const flagged = pieces.filter((p) => p.merged);
    checks.push({ name: 'no box flagged merged', ok: flagged.length === 0, detail: flagged.length + ' flagged' });
  }

  const medH = median(pieces.map((p) => p.h)) || 1;
  const rows = pieces.map((p) => Math.round(p.cy / medH));
  const sortedOk = pieces.every((p, i) => i === 0 || rows[i - 1] < rows[i] || (rows[i - 1] === rows[i] && pieces[i - 1].cx <= p.cx));
  checks.push({ name: 'reading-order sort holds', ok: sortedOk, detail: '' });

  const shapeOk = pieces.every((p) => [p.x, p.y, p.w, p.h, p.cx, p.cy].every(Number.isInteger)
    && p.w > 0 && p.h > 0 && p.x >= 0 && p.y >= 0 && p.x + p.w <= W && p.y + p.h <= H
    && Math.abs(p.cx - (p.x + p.w / 2)) <= 0.5 && Math.abs(p.cy - (p.y + p.h / 2)) <= 0.5 && p.area > 0
    && typeof p.merged === 'boolean');
  checks.push({ name: 'integer boxes inside the image, cx/cy = centre', ok: shapeOk, detail: '' });

  const r0 = r.res;
  const metaOk = r0.scale === Math.min(1, 800 / Math.max(W, H)) && r0.threshold >= 25
    && [r0.bg.r, r0.bg.g, r0.bg.b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
  checks.push({ name: 'scale / threshold / bg fields valid', ok: metaOk, detail: `scale ${r0.scale}, T ${r0.threshold}` });

  checks.push({ name: `cold run under ${BUDGET_MS} ms`, ok: r.cold < BUDGET_MS, detail: r.cold.toFixed(0) + ' ms' });
  return checks;
}

// Runs one fixture in a fresh page and prints its PASS/FAIL line. Returns true on pass.
async function runOne(browser, base, name) {
  const truth = JSON.parse(fs.readFileSync(path.join(FIX_DIR, name + '.json'), 'utf8'));
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('  [page ' + m.type() + '] ' + m.text()); });
  await page.goto(base + PAGE);
  await page.waitForFunction(() => window.pfTest);
  const r = await page.evaluate(([url, t, reps, nm]) => window.pfTest.runFixture(url, {}, t, reps, nm),
    [`/tests/fixtures/${name}.jpg`, truth, REPS, name]);
  fs.writeFileSync(path.join(OUT_DIR, name + '.png'), Buffer.from(r.png.split(',')[1], 'base64'));

  let sweepRows = [];
  if (sweep) {
    for (const s of [0.5, 0.7, 1.0, 1.3, 1.5]) {
      const q = await page.evaluate(([url, t, sc]) => window.pfTest.runFixture(url, { thresholdScale: sc }, t, 0, 'sweep'), [`/tests/fixtures/${name}.jpg`, truth, s]);
      sweepRows.push(`x${s}: ${q.res.pieces.length} (T=${q.res.threshold.toFixed(0)})`);
    }
  }
  await page.close();

  const checks = checkFixture(truth, r);
  if (pageErrors.length) checks.push({ name: 'no page errors', ok: false, detail: pageErrors.join(' | ') });
  const ok = checks.every((c) => c.ok);
  const bg = r.res.bg;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(20)} count ${String(r.res.pieces.length).padStart(2)}/${truth.count}  ` +
    `threshold ${r.res.threshold.toFixed(1)} (otsu ${r.otsuT})  bg (${bg.r},${bg.g},${bg.b})  ` +
    `${r.cold.toFixed(0)} ms cold, ${r.warm.toFixed(0)} ms warm  [${r.loader}]`);
  if (r.warm > WARN_MS) console.log(`  WARN: warm run is over ${WARN_MS} ms, consider optimising`);
  for (const c of checks.filter((x) => !x.ok)) console.log(`  - FAILED: ${c.name} ${c.detail ? '(' + c.detail + ')' : ''}`);
  if (sweepRows.length) console.log('  sweep ' + sweepRows.join('  '));
  return ok;
}

// Runs the small in-page checks: PF.segment.otsu on hand-made histograms, and detect() on drawn
// scenes that exercise the opening (step 5) and the median filter (step 7). Returns true on pass.
async function runUnit(browser, base) {
  const page = await browser.newPage();
  await page.goto(base + PAGE);
  await page.waitForFunction(() => window.pfTest);
  const groups = [['otsu', await page.evaluate(() => window.pfTest.otsuChecks())],
    ['scene', await page.evaluate(() => window.pfTest.synthChecks())]];
  await page.close();
  let ok = true;
  for (const [label, checks] of groups) {
    for (const c of checks) { ok = ok && c.ok; console.log(`${c.ok ? 'PASS' : 'FAIL'} ${label}: ${c.name} (got ${c.got})`); }
  }
  return ok;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const names = fs.readdirSync(FIX_DIR).filter((f) => f.endsWith('.jpg')).map((f) => f.slice(0, -4)).sort()
    .filter((n) => n.includes(filter));
  if (!names.length) { console.error('No fixtures found. Run: python3 tests/gen_synthetic.py'); process.exit(2); }
  const { chromium } = loadPlaywright();
  const { server, port } = await startServer();
  const browser = await launch(chromium);
  const base = `http://127.0.0.1:${port}`;
  let allOk = await runUnit(browser, base);
  for (const name of names) allOk = (await runOne(browser, base, name)) && allOk;
  await browser.close();
  server.close();
  console.log(allOk ? '\nALL PASS' : '\nSOME CHECKS FAILED');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
