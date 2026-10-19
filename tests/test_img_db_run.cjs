'use strict';
// Runs the PF.img and PF.db / PF.settings tests in headless Chromium.
//   NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/test_img_db_run.cjs
// It serves the repo root over http://127.0.0.1:<port> (IndexedDB and crypto.randomUUID need a secure context;
// 127.0.0.1 counts), opens each test page in a fresh browser context, and prints PASS / FAIL per test.
const http = require('http');
const fs = require('fs');
const path = require('path');

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  playwright = require('/home/claude/.npm-global/lib/node_modules/playwright');
}

const ROOT = path.resolve(__dirname, '..');
const PAGES = [
  { file: 'test_img_page.html', label: 'img' },
  { file: 'test_db_page.html', label: 'db ' }
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml'
};

// Starts a minimal static file server rooted at the repo and resolves with { server, port }.
function startServer() {
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(ROOT, path.normalize(urlPath));
      if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(file, function (err, buf) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port }); });
  });
}

const TEST_TIMEOUT_MS = 20000;

// Resolves with `fallback` if `promise` has not settled after `ms` milliseconds.
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve(fallback); }, ms); });
  return Promise.race([promise, timeout]).finally(function () { clearTimeout(timer); });
}

// Runs every test of one page; returns { pass, fail, skip }.
async function runPage(browser, port, spec) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = 'http://127.0.0.1:' + port;
  const problems = [];
  page.on('pageerror', function (e) { problems.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });

  // Lets a test wipe IndexedDB the way "clear site data" would.
  const cdp = await context.newCDPSession(page);
  await page.exposeFunction('__clearIndexedDB', async function () {
    await cdp.send('Storage.clearDataForOrigin', { origin: origin, storageTypes: 'indexeddb' });
  });

  await page.goto(origin + '/tests/' + spec.file);
  const names = await page.evaluate(function () { return window.__names(); });
  const tally = { pass: 0, fail: 0, skip: 0 };
  for (let i = 0; i < names.length; i++) {
    const r = await withTimeout(page.evaluate(function (n) { return window.__run(n); }, i), TEST_TIMEOUT_MS,
      { name: names[i], ok: false, error: 'timed out after ' + TEST_TIMEOUT_MS + ' ms' });
    if (r.ok && r.note === 'skipped') { tally.skip++; console.log('SKIP  ' + spec.label + ': ' + r.name); }
    else if (r.ok) { tally.pass++; console.log('PASS  ' + spec.label + ': ' + r.name); }
    else { tally.fail++; console.log('FAIL  ' + spec.label + ': ' + r.name + '\n        ' + String(r.error).split('\n').slice(0, 4).join('\n        ')); }
  }
  problems.forEach(function (p) { console.log('NOTE  ' + spec.label + ': ' + p); });
  await context.close();
  return tally;
}

(async function main() {
  const started = await startServer();
  const browser = await playwright.chromium.launch();
  const total = { pass: 0, fail: 0, skip: 0 };
  try {
    for (const spec of PAGES) {
      const t = await runPage(browser, started.port, spec);
      total.pass += t.pass; total.fail += t.fail; total.skip += t.skip;
    }
  } finally {
    await browser.close();
    started.server.close();
  }
  console.log('\n' + total.pass + ' passed, ' + total.fail + ' failed, ' + total.skip + ' skipped');
  process.exit(total.fail ? 1 : 0);
})().catch(function (e) { console.error('runner crashed:', e); process.exit(2); });
