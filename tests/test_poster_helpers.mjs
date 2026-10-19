// Helpers for test_poster_run.mjs: Playwright loader, static server, PASS/FAIL checker, PNG color finder.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..');
export const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });

// Loads Playwright from NODE_PATH, or from the known global folder.
export function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    return require('/home/claude/.npm-global/lib/node_modules/playwright');
  }
}

// Starts a tiny static file server for the repo folder on a free port. Resolves { server, port }.
export function startServer(dir) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, path.normalize(rel));
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// Creates a checker that prints PASS/FAIL lines and counts them.
export function makeChecker() {
  const state = { pass: 0, fail: 0, failed: [] };
  function check(name, ok, detail = '') {
    if (ok) state.pass++; else { state.fail++; state.failed.push(name); }
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
    return ok;
  }
  return { check, state };
}

// Finds pixels of one color family in a PNG buffer (decoded in a helper page).
// mode 'red' = the poster target (#ff0000), mode 'yellow' = the marker (#ffd400). Returns image-pixel stats.
export async function findColor(helperPage, buf, mode) {
  return helperPage.evaluate(async ({ b64, mode }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0, sx = 0, sy = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const r = d[i], gr = d[i + 1], b = d[i + 2];
        const hit = mode === 'red' ? (r >= 235 && gr <= 25 && b <= 25) : (r >= 235 && gr >= 195 && gr <= 228 && b <= 40);
        if (!hit) continue;
        n++; sx += x + 0.5; sy += y + 0.5;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!n) return { n: 0 };
    return { n, minX, maxX, minY, maxY, cx: sx / n, cy: sy / n, bx: (minX + maxX + 1) / 2, by: (minY + maxY + 1) / 2,
             w: maxX - minX + 1, h: maxY - minY + 1, imgW: c.width, imgH: c.height };
  }, { b64: buf.toString('base64'), mode });
}
