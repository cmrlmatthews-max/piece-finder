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

// Mock the Claude API. The ranking answer picks candidate numbers 3, 1 and 7.
const apiCalls = [];
await page.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  const body = JSON.parse(req.postData() || '{}');
  apiCalls.push({ headers: req.headers(), body });
  const isTest = !body.output_config;
  const text = isTest ? 'OK' : JSON.stringify({
    candidates: [
      { number: 3, confidence: 'high', reason: 'Green stripes match the hill edge.' },
      { number: 1, confidence: 'medium', reason: 'Similar colors, tab on top.' },
      { number: 7, confidence: 'low', reason: 'Possible by shape only.' },
    ],
    notes: 'The spot needs a tab on top and a blank on the right.',
  });
  await route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 12345, output_tokens: 150 } }) });
});

async function shot(name) { await page.screenshot({ path: path.join(OUT, `e2e_${name}.png`) }); }
async function tab(name) { await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first().click(); await page.waitForTimeout(150); }
async function clickWithFile(buttonRegex, file) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.getByRole('button', { name: buttonRegex }).first().click(),
  ]);
  await chooser.setFiles(file);
}

try {
  await page.goto(url + 'index.html');
  await page.waitForTimeout(500);
  check('page loads with title', (await page.title()) === 'Piece Finder', await page.title());
  await shot('01_first_launch');

  // Settings: key + model + test key
  await tab('Settings');
  const keyInput = page.locator('input[type=password], input[type=text][autocomplete=off]').first();
  await keyInput.fill('sk-ant-test-key');
  await page.waitForTimeout(100);
  const selects = page.locator('select');
  if (await selects.count()) await selects.first().selectOption('claude-haiku-5-5');
  await page.getByRole('button', { name: /test key/i }).click();
  await page.waitForTimeout(500);
  check('test key called the API once', apiCalls.length === 1, `calls=${apiCalls.length}`);
  check('settings saved the key', JSON.parse(await page.evaluate(() => localStorage.getItem('pf.settings') || '{}')).apiKey === 'sk-ant-test-key');
  await shot('02_settings');

  // Poster
  await tab('Poster');
  await clickWithFile(/add poster photo/i, path.join(ROOT, 'tests/fixtures/poster_2400.jpg'));
  await page.waitForTimeout(1500);
  const poster = await page.evaluate(async () => { const p = await PF.db.get('meta', 'poster'); return p ? { w: p.w, h: p.h, size: p.blob.size } : null; });
  check('poster stored (<=2400 long edge)', poster && poster.w === 2400 && poster.h === 1600, JSON.stringify(poster));
  await shot('03_poster');

  // Pieces: add a group from a synthetic photo
  await tab('Pieces');
  await clickWithFile(/add group/i, path.join(ROOT, 'tests/fixtures/white_24.jpg'));
  await page.waitForTimeout(2500);
  const bodyText = await page.locator('body').innerText();
  check('review shows 24 pieces found', /24 pieces/i.test(bodyText), (bodyText.match(/\d+ pieces[^\n]*/i) || [''])[0]);
  await shot('04_review');
  const nameInput = page.locator('input[type=text]').last();
  if (await nameInput.count()) await nameInput.fill('Sky');
  await page.getByRole('button', { name: /save group/i }).click();
  await page.waitForTimeout(2500);
  const stored = await page.evaluate(async () => ({ groups: (await PF.db.all('groups')).length, pieces: (await PF.db.all('pieces')).length }));
  check('group + 24 pieces stored', stored.groups === 1 && stored.pieces === 24, JSON.stringify(stored));
  await shot('05_groups');

  // Find: hole photo + poster spot + search
  await tab('Find');
  await clickWithFile(/take photo of the spot/i, path.join(ROOT, 'tests/fixtures/hole_1200.jpg'));
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /pick the spot/i }).click();
  await page.waitForTimeout(600);
  const overlay = page.locator('.pf-poster-overlay');
  check('poster overlay opened', await overlay.count() === 1);
  const pan = overlay.locator('[class*=pan], .pf-poster-pan, div').filter({ has: page.locator('canvas') }).first();
  const box = await pan.boundingBox();
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await page.waitForTimeout(300);
  await shot('06_poster_pick');
  await overlay.getByRole('button', { name: /use this spot/i }).click();
  await page.waitForTimeout(800);
  check('overlay closed after pick', await page.locator('.pf-poster-overlay').count() === 0);
  await shot('07_find_ready');
  const findBtn = page.getByRole('button', { name: /^find pieces$/i });
  check('Find pieces button enabled', await findBtn.isEnabled());
  await findBtn.click();
  await page.waitForTimeout(4000);
  const call = apiCalls[apiCalls.length - 1];
  check('rank request sent with structured output', apiCalls.length === 2 && call.body.output_config && call.body.output_config.format.type === 'json_schema');
  const blocks = call ? call.body.messages[0].content : [];
  const images = blocks.filter((b) => b.type === 'image');
  check('request has hole + poster + 1 sheet images', images.length === 3, `images=${images.length}, blocks=${blocks.length}`);
  check('headers include browser-access and version', call && call.headers['anthropic-dangerous-direct-browser-access'] === 'true' && call.headers['anthropic-version'] === '2023-06-01');
  const resultsText = await page.locator('body').innerText();
  check('results list shows 3 candidates with reasons', /Green stripes/.test(resultsText) && /Possible by shape/.test(resultsText));
  check('results show the notes', /tab on top and a blank/.test(resultsText));
  check('results show usage', /12,?345/.test(resultsText));
  const marks = await page.locator('canvas').count();
  check('group photo with marks rendered', marks >= 1, `canvases=${marks}`);
  await shot('08_results');

  // Placed
  await page.getByRole('button', { name: /placed/i }).first().click();
  await page.waitForTimeout(800);
  const placed = await page.evaluate(async () => (await PF.db.byIndex('pieces', 'status', 'placed')).length);
  check('Placed marks one piece in the db', placed === 1, `placed=${placed}`);
  await shot('09_after_placed');
  await tab('Pieces');
  await page.waitForTimeout(400);
  const piecesText = await page.locator('body').innerText();
  check('Pieces tab shows 23 loose · 1 placed', /23 loose/.test(piecesText) && /1 placed/.test(piecesText), (piecesText.match(/\d+ loose[^\n]*/) || [''])[0]);
  await shot('10_pieces_after');

  // Not it + New search
  await tab('Find');
  await page.waitForTimeout(300);
  await shot('11_find_again');
} catch (e) {
  check('no exception during the flow', false, e.message);
  await shot('99_error');
}
check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
await browser.close();
srv.close();
process.exit(fails ? 1 : 0);
