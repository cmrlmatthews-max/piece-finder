// End-to-end smoke test of the whole app in headless Chromium with the real modules.
// The Claude API is mocked with page.route, so no key and no network are needed.
// Run: NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/e2e_app.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

let fails = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!ok) fails++;
}

const { srv, url } = await serve();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Mock the Claude API. The ranking answer picks candidates 3, 1 and 43 (43 = the cluster).
const apiCalls = [];
await page.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const body = JSON.parse(req.postData() || '{}');
  apiCalls.push({ headers: req.headers(), body });
  const isTest = !body.output_config;
  const text = isTest ? 'OK' : JSON.stringify({
    spot: 'Bounded on the top and left by red barn pieces; open on the right and bottom. Needs a blank on top and a tab on the left.',
    candidates: [
      { number: 3, confidence: 'high', reason: 'Green stripes match the hill edge.' },
      { number: 1, confidence: 'medium', reason: 'Similar colors, tab on top.' },
      { number: 43, confidence: 'low', reason: 'Cluster shape could fill the open area.' },
    ],
    notes: 'The spot needs a tab on top and a blank on the right.',
  });
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12345, output_tokens: 150 } }) });
});

async function shot(name) { await page.screenshot({ path: path.join(OUT, `e2e_${name}.png`) }); }
async function tab(name) { await page.locator(`.tab[data-tab=${name}]`).click(); await page.waitForTimeout(200); }
async function clickWithFile(buttonRegex, file) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.getByRole('button', { name: buttonRegex }).first().click(),
  ]);
  await chooser.setFiles(file);
}
// Drags a loop (fractions of the draw canvas) with the mouse.
async function drawLoop(fracPoints) {
  const draw = page.locator('.pk-draw');
  const b = await draw.boundingBox();
  const pts = fracPoints.map(([fx, fy]) => [b.x + b.width * fx, b.y + b.height * fy]);
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}
async function addGroup(file, name) {
  await tab('pieces');
  await clickWithFile(/add group/i, file);
  await page.waitForTimeout(2500);
  const text = await page.locator('body').innerText();
  const nameInput = page.locator('input[type=text]').last();
  await nameInput.fill(name);
  await page.getByRole('button', { name: /save group/i }).click();
  await page.waitForTimeout(3000);
  return text;
}

try {
  await page.goto(url + 'index.html');
  await page.waitForTimeout(500);
  check('page loads with title', (await page.title()) === 'Piece Finder', await page.title());
  await shot('01_first_launch');

  // Settings
  await tab('settings');
  const keyInput = page.locator('input[type=password]').first();
  await keyInput.fill('sk-ant-test-key');
  await page.waitForTimeout(100);
  const modelSel = page.locator('select').first();
  check('default model is Sonnet 5.5', (await modelSel.inputValue()) === 'claude-sonnet-5-5', await modelSel.inputValue());
  await page.getByRole('button', { name: /test key/i }).click();
  await page.waitForTimeout(500);
  check('test key called the API once', apiCalls.length === 1, `calls=${apiCalls.length}`);
  check('settings saved the key', JSON.parse(await page.evaluate(() => localStorage.getItem('pf.settings') || '{}')).apiKey === 'sk-ant-test-key');
  await shot('02_settings');

  // Poster
  await tab('poster');
  await clickWithFile(/add poster photo/i, path.join(ROOT, 'tests/e2e-fixtures/poster_2400.jpg'));
  await page.waitForTimeout(1500);
  const poster = await page.evaluate(async () => { const p = await PF.db.get('meta', 'poster'); return p ? { w: p.w, h: p.h } : null; });
  check('poster stored', poster && poster.w === 2400 && poster.h === 1600, JSON.stringify(poster));

  // Pieces: a normal group and a group with one cluster (touching pair)
  const reviewText = await addGroup(path.join(ROOT, 'tests/fixtures/white_24.jpg'), 'Sky');
  check('review shows 24 pieces found', /24 pieces found/.test(reviewText), (reviewText.match(/\d+ pieces found[^\n]*/) || [''])[0]);
  const reviewText2 = await addGroup(path.join(ROOT, 'tests/fixtures/touching_20.jpg'), 'Barn');
  check('second review shows a cluster', /19 pieces found · 1 cluster/.test(reviewText2), (reviewText2.match(/\d+ pieces found[^\n]*/) || [''])[0]);
  const stored = await page.evaluate(async () => { const ps = await PF.db.all('pieces'); return { groups: (await PF.db.all('groups')).length, pieces: ps.length, clusters: ps.filter((p) => p.kind === 'cluster').length }; });
  check('2 groups, 43 pieces, 1 cluster stored', stored.groups === 2 && stored.pieces === 43 && stored.clusters === 1, JSON.stringify(stored));
  await shot('05_groups');

  // Find: traced spot photo
  await tab('find');
  await clickWithFile(/take photo of the spot/i, path.join(ROOT, 'tests/e2e-fixtures/hole_1200.jpg'));
  await page.waitForTimeout(1200);
  check('trace picker opened', await page.locator('.pk-overlay').count() === 1);
  await shot('06_trace_open');
  await drawLoop([[0.34, 0.30], [0.66, 0.30], [0.68, 0.50], [0.66, 0.66], [0.50, 0.68], [0.34, 0.66], [0.32, 0.50], [0.34, 0.32]]);
  await page.waitForTimeout(200);
  await shot('07_trace_drawn');
  const doneBtn = page.locator('.pk-overlay').getByRole('button', { name: /^done$/i });
  check('Done enabled after tracing', await doneBtn.isEnabled());
  await doneBtn.click();
  await page.waitForTimeout(1200);
  check('trace picker closed', await page.locator('.pk-overlay').count() === 0);
  const hole = await page.evaluate(() => PF.app.state.hole && { pts: PF.app.state.hole.polygon.length, full: PF.app.state.hole.fullBlob.size, crop: PF.app.state.hole.cropBlob.size, snapped: PF.app.state.hole.snapped, sides: PF.app.state.hole.sides });
  check('hole stored with polygon, full and crop blobs', hole && hole.pts >= 8 && hole.full > 1000 && hole.crop > 1000, JSON.stringify(hole));
  check('edge snapped to the hole', hole && hole.snapped === true);
  check('sides: top+left pieces, right+bottom open', hole && hole.sides && hole.sides.top === 'pieces' && hole.sides.left === 'pieces' && hole.sides.right === 'open' && hole.sides.bottom === 'open', JSON.stringify(hole && hole.sides));

  // Find: poster ring
  await page.getByRole('button', { name: /pick the spot/i }).click();
  await page.waitForTimeout(800);
  check('point picker opened', await page.locator('.pk-overlay .pk-ring').count() === 1);
  await shot('08_point_open');
  await page.locator('.pk-overlay').getByRole('button', { name: /^done$/i }).click();
  await page.waitForTimeout(800);
  const spot = await page.evaluate(() => PF.app.state.spot && { cx: Math.round(PF.app.state.spot.cx), cy: Math.round(PF.app.state.spot.cy), crop: PF.app.state.spot.cropBlob.size });
  check('poster spot at the center by default', spot && Math.abs(spot.cx - 1200) < 30 && Math.abs(spot.cy - 800) < 30, JSON.stringify(spot));
  await shot('09_find_ready');

  // Search
  const findBtn = page.getByRole('button', { name: /^find pieces$/i });
  check('Find pieces button enabled', await findBtn.isEnabled());
  await findBtn.click();
  await page.waitForTimeout(6000);
  const call = apiCalls[apiCalls.length - 1];
  check('rank request sent with structured output', apiCalls.length === 2 && call.body.output_config && call.body.output_config.format.type === 'json_schema');
  const blocks = call ? call.body.messages[0].content : [];
  const images = blocks.filter((b) => b.type === 'image');
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
  check('request has full + crop + poster + 2 single sheets + 1 cluster sheet', images.length === 6, `images=${images.length}, blocks=${blocks.length}`);
  check('cluster sheet text present', texts.some((t) => /CLUSTER SHEET 1 of 1/.test(t)));
  check('hole text names the bounded and open sides', texts.some((t) => /placed neighbors: top, left\./.test(t) && /Open sides \(no neighbor yet, no constraint\): right, bottom\./.test(t)), (texts[0] || '').slice(-140));
  check('schema puts spot before candidates', JSON.stringify(Object.keys(call.body.output_config.format.schema.properties)) === '["spot","candidates","notes"]');
  check('headers include browser-access and version', call && call.headers['anthropic-dangerous-direct-browser-access'] === 'true' && call.headers['anthropic-version'] === '2023-06-01');
  const resultsText = await page.locator('body').innerText();
  check('results list shows 3 candidates with reasons', /Green stripes/.test(resultsText) && /Cluster shape/.test(resultsText));
  check('results show the spot description', /What Claude saw/.test(resultsText) && /Bounded on the top/.test(resultsText));
  check('cluster candidate has a cluster pill', (await page.locator('.pill.cluster').count()) === 1);
  check('results show usage', /12,?345/.test(resultsText));
  check('group photos with marks rendered', (await page.locator('canvas.fit').count()) === 2);
  await shot('10_results');

  // Placed
  await page.getByRole('button', { name: /placed/i }).first().click();
  await page.waitForTimeout(800);
  const placed = await page.evaluate(async () => (await PF.db.byIndex('pieces', 'status', 'placed')).length);
  check('Placed marks one piece in the db', placed === 1, `placed=${placed}`);
  await tab('pieces');
  await page.waitForTimeout(400);
  const piecesText = await page.locator('body').innerText();
  check('Pieces tab shows 42 loose', /42 loose pieces/.test(piecesText), (piecesText.match(/\d+ loose pieces[^\n]*/) || [''])[0]);
  await shot('11_pieces_after');
} catch (e) {
  check('no exception during the flow', false, e.message);
  await shot('99_error');
}
check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
await browser.close();
srv.close();
process.exit(fails ? 1 : 0);
