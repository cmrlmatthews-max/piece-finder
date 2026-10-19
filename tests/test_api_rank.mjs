// Tests for api.js (PF.api.rankPieces, PF.api.testKey, PF.api.MODELS) in headless Chromium.
// The real network is never used: window.fetch is replaced by a stub inside the page.
// Run:  NODE_PATH=/home/claude/.npm-global/lib/node_modules node tests/test_api_rank.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

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
const eq = (a, b) => isDeepStrictEqual(a, b);
// Collects every "err" string found anywhere inside a result object.
function errorTexts(x, out = []) {
  if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (k === 'err' && typeof v === 'string') out.push(v);
      else errorTexts(v, out);
    }
  }
  return out;
}

// ------------------------------------------------------------------ what the spec says (typed out here on purpose)
const KEY = 'sk-ant-api03-TESTKEY-abcdef_123456';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const EM = '—';
const LIT = {
  system: 'You help people solve a 1500-piece jigsaw puzzle. You look at photos of loose pieces and an empty spot ' +
    'and say which pieces might fit. Be concrete and brief.',
  hole: 'IMAGE: photo of the empty spot in the puzzle, taken from above, with the placed neighboring pieces around it.',
  poster: 'IMAGE: crop of the finished-puzzle picture (the poster), centered on the empty spot. ' +
    'The missing piece is at the center of this crop.',
  sheet: (i, n) => `CANDIDATE SHEET ${i} of ${n}: loose pieces. The number under each piece is its ID.`,
  final: (topN, count) => [
    `Task: find which candidate pieces could fit the empty spot. Rank the best ${topN} candidates, best first.`,
    "Judge by: (1) colors and patterns that match the picture at the spot and continue the neighbors' patterns,",
    "(2) the shape of the hole: which sides need a tab (knob) and which need a blank (socket), (3) the candidate's",
    `tab/blank layout ${EM} a candidate may be rotated any way. Candidate IDs run 1 to ${count}.`,
    `Return only plausible candidates (fewer than ${topN} is fine). Give each a one-sentence reason a person can check`,
    'by eye. Put any general observation in notes (one sentence).',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'integer' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason: { type: 'string' },
          },
          required: ['number', 'confidence', 'reason'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
    },
    required: ['candidates', 'notes'],
    additionalProperties: false,
  },
  models: [
    { id: 'claude-haiku-5-5', label: `Haiku 5.5 ${EM} fast, cheapest` },
    { id: 'claude-sonnet-5-5', label: `Sonnet 5.5 ${EM} smarter` },
    { id: 'claude-opus-5-5', label: `Opus 5.5 ${EM} smartest, costs most` },
  ],
  msg: {
    key: 'API key rejected. Check Settings.',
    rate: 'Rate limit hit. Wait a minute and try again.',
    rejected: 'Request rejected: ',
    busy: 'Claude is busy. Try again.',
    offline: 'No connection.',
    cutoff: 'Answer was cut off. Try again.',
  },
  headers: {
    'content-type': 'application/json',
    'x-api-key': KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  },
};

// Reads the texts out of SPEC.md (when it exists) so the literals above are checked against the source of truth.
function parseSpec() {
  const specPath = path.join(root, 'SPEC.md');
  if (!fs.existsSync(specPath)) return null;
  const s = fs.readFileSync(specPath, 'utf8');
  const grab = (re, what) => {
    const m = s.match(re);
    if (!m) throw new Error('SPEC.md: cannot find ' + what);
    return m[1];
  };
  return {
    hole: grab(/^1\. If holeBlob: text `([^`]+)` then the image\./m, 'hole text'),
    poster: grab(/^2\. If posterBlob: text `([^`]+)` then the image\./m, 'poster text'),
    sheet: grab(/^3\. For each sheet i: text `([^`]+)` then the image\./m, 'sheet text'),
    final: grab(/^4\. Final text:\n```\n([\s\S]*?)\n```/m, 'final text'),
    system: grab(/^SYSTEM: `([^`]+)`/m, 'system text'),
    schema: JSON.parse(grab(/^SCHEMA:\n```json\n([\s\S]*?)\n```/m, 'schema')),
    models: [...s.matchAll(/\{ id:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)].map((m) => ({ id: m[1], label: m[2] })),
    msgKey: grab(/401\/403 → `([^`]+)`/, '401/403 message'),
    msgRate: grab(/429 → `([^`]+)`/, '429 message'),
    msgRejected: grab(/400 → `([^`]+)`/, '400 message'),
    msgBusy: grab(/5xx\/529 → `([^`]+)`/, '5xx message'),
    msgOffline: grab(/network failure →\s*`([^`]+)`/, 'network message'),
    msgCutoff: grab(/throw `Error\('([^']+)'\)`/, 'cut-off message'),
    maxTokens: Number(grab(/"max_tokens": (\d+)/, 'max_tokens')),
    version: grab(/^anthropic-version: (\S+)/m, 'anthropic-version'),
    endpoint: grab(/`POST (https:\/\/\S+)`/, 'endpoint'),
  };
}

const types = (blocks) => blocks.map((b) => b.type).join(',');
const isJpegB64 = (b) => b.type === 'image' && eq(Object.keys(b.source).sort(), ['data', 'media_type', 'type'])
  && b.source.type === 'base64' && b.source.media_type === 'image/jpeg' && /^\/9j\//.test(b.source.data);

const { chromium } = loadPlaywright();
const { server, port } = await startServer(root);
const browser = await chromium.launch();
const consoleTexts = [];
const pageErrors = [];
// Opens a test page and records everything it prints.
async function openPage(name, withClock = false) {
  const page = await browser.newPage();
  page.on('console', (m) => consoleTexts.push(m.text()));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  if (withClock) await page.clock.install();
  await page.goto(`http://127.0.0.1:${port}/tests/${name}`);
  return page;
}

try {
  // ------------------------------------------------------------------ static checks of the source file
  const apiSrc = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  check('api.js: first line is window.PF = window.PF || {};', apiSrc.split('\n')[0] === 'window.PF = window.PF || {};');
  check('api.js: classic script (no import/export)', !/^\s*(import|export)\s/m.test(apiSrc));
  check('api.js: never logs (no console.*)', !/console\./.test(apiSrc));
  check('api.js: output_config is used; no output_format / tool_use / tool_choice', /output_config/.test(apiSrc) && !/output_format|tool_use|tool_choice/.test(apiSrc));
  check('api.js: ES2020 only (no ??=, ||=, &&=, .at(), replaceAll, structuredClone, Object.hasOwn)', !/\?\?=|\|\|=|&&=|\.at\(|replaceAll|structuredClone|Object\.hasOwn/.test(apiSrc));
  check('api.js: pure ASCII source (the em dashes are written as escapes)', /^[\x00-\x7f]*$/.test(apiSrc));
  const sheetSrc = fs.readFileSync(path.join(root, 'sheet.js'), 'utf8');
  check('sheet.js: first line, no import/export, no console, ES2020 only',
    sheetSrc.split('\n')[0] === 'window.PF = window.PF || {};' && !/^\s*(import|export)\s/m.test(sheetSrc)
    && !/console\./.test(sheetSrc) && !/\?\?=|\|\|=|&&=|\.at\(|replaceAll|structuredClone|Object\.hasOwn/.test(sheetSrc));

  // ------------------------------------------------------------------ my literals vs SPEC.md
  let spec = null;
  try {
    spec = parseSpec();
  } catch (err) {
    check('SPEC.md can be read for the text comparison', false, err.message);
  }
  if (spec) {
    check('SPEC.md: hole / poster / system texts equal the test literals', spec.hole === LIT.hole && spec.poster === LIT.poster && spec.system === LIT.system);
    check('SPEC.md: sheet text template equals the test literal',
      spec.sheet.replace('${i+1}', '2').replace('${n}', '5') === LIT.sheet(2, 5), spec.sheet);
    check('SPEC.md: final task text equals the test literal',
      spec.final.replace(/\$\{topN\}/g, '8').replace(/\$\{candidateCount\}/g, '40') === LIT.final(8, 40));
    check('SPEC.md: schema equals the test literal', eq(spec.schema, LIT.schema));
    check('SPEC.md: models equal the test literal', eq(spec.models, LIT.models), JSON.stringify(spec.models));
    check('SPEC.md: error messages equal the test literals',
      spec.msgKey === LIT.msg.key && spec.msgRate === LIT.msg.rate && spec.msgRejected === LIT.msg.rejected
      && spec.msgBusy === LIT.msg.busy && spec.msgOffline === LIT.msg.offline && spec.msgCutoff === LIT.msg.cutoff);
    check('SPEC.md: endpoint, anthropic-version and max_tokens equal the test literals',
      spec.endpoint === ENDPOINT && spec.version === LIT.headers['anthropic-version'] && spec.maxTokens === 2048);
  } else {
    console.log('SKIP  comparison with SPEC.md (file not found)');
  }

  // ------------------------------------------------------------------ page WITHOUT PF.img (built-in base64 fallback)
  const page = await openPage('test_api_page.html');
  check('no PF.img on this page (fallback path is used)', await page.evaluate(() => typeof PF.img === 'undefined'));
  check('PF.api exposes rankPieces, testKey, MODELS', await page.evaluate(() => typeof PF.api.rankPieces === 'function' && typeof PF.api.testKey === 'function' && Array.isArray(PF.api.MODELS)));
  check('MODELS has the three models with the exact labels', eq(await page.evaluate(() => JSON.parse(JSON.stringify(PF.api.MODELS))), LIT.models));

  // ---- the request for hole + poster + 1 sheet
  const full = await page.evaluate(async (key) => {
    const [hole, poster, sheet] = await Promise.all([A.jpeg('#c44'), A.jpeg('#4c4'), A.jpeg('#44c')]);
    A.install(() => A.goodReply());
    const res = await A.attempt(() => PF.api.rankPieces({
      apiKey: key, model: 'claude-sonnet-5-5', topN: 8, holeBlob: hole, posterBlob: poster, sheetBlobs: [sheet], candidateCount: 40,
    }));
    return { res, calls: A.calls };
  }, KEY);
  const call = full.calls[0];
  const body = call && call.body;
  check('rankPieces resolves without error', !!full.res.ok, full.res.err || '');
  check('exactly one fetch call', full.calls.length === 1, String(full.calls.length));
  check('POST https://api.anthropic.com/v1/messages', call.method === 'POST' && call.url === ENDPOINT, `${call.method} ${call.url}`);
  check('headers: exactly the four from the spec', eq(call.headers, LIT.headers), JSON.stringify(Object.keys(call.headers || {})));
  check('headers are a plain object (readable by any fetch stub)', call.headerType === '[object Object]', call.headerType);
  check('a timeout signal is passed to fetch', call.hasSignal === true);
  check('body keys: model, max_tokens, system, messages, output_config', eq(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']), Object.keys(body).join());
  check('model passes through', body.model === 'claude-sonnet-5-5');
  check('max_tokens is 2048', body.max_tokens === 2048);
  check('system text is the spec text', body.system === LIT.system);
  check('output_config.format.type is "json_schema"', body.output_config && body.output_config.format && body.output_config.format.type === 'json_schema');
  check('output_config has only "format"; format has only "type" and "schema"', eq(Object.keys(body.output_config), ['format']) && eq(Object.keys(body.output_config.format).sort(), ['schema', 'type']));
  check('schema equals the spec schema', eq(body.output_config.format.schema, LIT.schema));
  check('no output_format, tools, tool_choice or tool_use anywhere', !/output_format|tool_use|tool_choice|"tools"/.test(call.rawBody));
  check('one user message with a content array', body.messages.length === 1 && body.messages[0].role === 'user' && Array.isArray(body.messages[0].content));
  const content = body.messages[0].content;
  check('content order: text, image, text, image, text, image, text', types(content) === 'text,image,text,image,text,image,text', types(content));
  check('hole text is the spec text', content[0].text === LIT.hole);
  check('poster text is the spec text', content[2].text === LIT.poster);
  check('sheet text is the spec text ("SHEET 1 of 1")', content[4].text === LIT.sheet(1, 1), content[4].text);
  check('final text is the spec text (topN 8, IDs 1 to 40), line breaks kept', content[6].text === LIT.final(8, 40));
  check('image blocks are { type, source: { type: base64, media_type: image/jpeg, data } } with JPEG data', [1, 3, 5].every((i) => isJpegB64(content[i])));
  check('text blocks have only type and text', [0, 2, 4, 6].every((i) => eq(Object.keys(content[i]).sort(), ['text', 'type'])));
  check('the API key appears only in the x-api-key header', call.rawBody.indexOf(KEY) === -1 && call.url.indexOf(KEY) === -1);
  check('result: exactly one candidate (3, high, "x") - repeat and 99 are dropped', eq(full.res.ok && full.res.ok.candidates, [{ number: 3, confidence: 'high', reason: 'x' }]), JSON.stringify(full.res.ok && full.res.ok.candidates));
  check('result: notes pass through', full.res.ok && full.res.ok.notes === 'n');
  check('result: usage passes through', full.res.ok && eq(full.res.ok.usage, { input_tokens: 10, output_tokens: 5 }));

  // ---- other block layouts
  const lay = await page.evaluate(async (key) => {
    const [a, b, c] = await Promise.all([A.jpeg('#c44'), A.jpeg('#4c4'), A.jpeg('#44c')]);
    A.install(() => A.goodReply());
    await PF.api.rankPieces({ apiKey: key, topN: 5, holeBlob: a, posterBlob: null, sheetBlobs: [b, c], candidateCount: 72 });
    await PF.api.rankPieces({ apiKey: key, model: 'claude-opus-5-5', topN: 12, holeBlob: undefined, posterBlob: a, sheetBlobs: [b], candidateCount: 3 });
    await PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [b], candidateCount: 36 });   // no model, no topN: defaults
    return A.calls.map((x) => x.body);
  }, KEY);
  const c0 = lay[0].messages[0].content;
  check('hole only + 2 sheets: text,image,text,image,text,image,text', types(c0) === 'text,image,text,image,text,image,text', types(c0));
  check('texts: hole, "SHEET 1 of 2", "SHEET 2 of 2", final with topN 5 and IDs 1 to 72',
    c0[0].text === LIT.hole && c0[2].text === LIT.sheet(1, 2) && c0[4].text === LIT.sheet(2, 2) && c0[6].text === LIT.final(5, 72));
  const c1 = lay[1].messages[0].content;
  check('poster only + 1 sheet: text,image,text,image,text', types(c1) === 'text,image,text,image,text', types(c1));
  check('texts: poster, "SHEET 1 of 1", final with topN 12 and IDs 1 to 3', c1[0].text === LIT.poster && c1[2].text === LIT.sheet(1, 1) && c1[4].text === LIT.final(12, 3));
  check('model "claude-opus-5-5" passes through', lay[1].model === 'claude-opus-5-5');
  check('defaults: model claude-haiku-5-5 and topN 8', lay[2].model === 'claude-haiku-5-5' && lay[2].messages[0].content.at(-1).text === LIT.final(8, 36));

  // ---- candidate cleaning
  const cleaned = await page.evaluate(async (key) => {
    const [a, b] = await Promise.all([A.jpeg('#c44'), A.jpeg('#44c')]);
    const mk = (n, conf, why) => ({ number: n, confidence: conf, reason: why });
    const list = [mk(5, 'high', 'r5'), mk(5, 'low', 'again'), mk(0, 'low', 'zero'), mk(-3, 'low', 'neg'), mk(2.5, 'low', 'frac'),
      mk(41, 'low', 'too big'), mk('7', 'medium', 'r7'), mk(null, 'low', 'null'), mk(12, 'weird', 'r12'), mk(40, 'low', 'r40'),
      mk(1, 'high', 'r1'), mk(2, 'high', 'r2')];
    A.install(() => A.answer(JSON.stringify({ candidates: list, notes: 'nn' })));
    const base = { apiKey: key, holeBlob: a, sheetBlobs: [b], candidateCount: 40 };
    const four = await PF.api.rankPieces({ ...base, topN: 4 });
    const eight = await PF.api.rankPieces({ ...base, topN: 8 });
    A.install(() => A.answer(JSON.stringify({ candidates: [], notes: '' })));
    const none = await PF.api.rankPieces({ ...base, topN: 8 });
    A.install(() => A.answer(JSON.stringify({ candidates: [mk(3, 'high', 'ok')], notes: 'z' }), 'end_turn'));
    return { four: four.candidates, eight: eight.candidates, none, notes: four.notes };
  }, KEY);
  check('topN 4 keeps the first 4 valid, unique numbers in Claude order (5, 7, 12, 40)', eq(cleaned.four.map((c) => c.number), [5, 7, 12, 40]), cleaned.four.map((c) => c.number).join());
  check('topN 8 keeps all 6 valid ones in order (5, 7, 12, 40, 1, 2)', eq(cleaned.eight.map((c) => c.number), [5, 7, 12, 40, 1, 2]), cleaned.eight.map((c) => c.number).join());
  check('unknown confidence becomes "low"; reasons pass through', cleaned.four[2].confidence === 'low' && cleaned.four[0].reason === 'r5' && cleaned.four[1].confidence === 'medium');
  check('empty answer gives no candidates and empty notes', eq(cleaned.none.candidates, []) && cleaned.none.notes === '' && cleaned.none.usage !== undefined);

  // ---- reply shapes
  const shapes = await page.evaluate(async (key) => {
    const [a, b] = await Promise.all([A.jpeg('#c44'), A.jpeg('#44c')]);
    const rank = () => A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [b], candidateCount: 40, topN: 8 }));
    const out = {};
    A.install(() => A.answer('{"candidates":[{"num', 'max_tokens'));
    out.cutoff = await rank();
    A.install(() => A.answer('Sorry, I cannot help.'));
    out.notJson = await rank();
    A.install(() => A.json({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }));
    out.noText = await rank();
    A.install(() => A.json({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '{"candidates":[{"number":2,"confidence":"medium","reason":"second block"}],"notes":""}' }], stop_reason: 'end_turn' }));
    out.firstTextBlock = await rank();
    A.install(() => A.answer('```json\n{"candidates":[{"number":9,"confidence":"low","reason":"fenced"}],"notes":"f"}\n```'));
    out.fenced = await rank();
    A.install(() => new Response('not json', { status: 200 }));
    out.badBody = await rank();
    A.install(() => A.json({ content: [{ type: 'text', text: '{"candidates":[],"notes":"x"}' }], stop_reason: 'end_turn' }));
    out.noUsage = await rank();
    return out;
  }, KEY);
  check('stop_reason max_tokens -> "Answer was cut off. Try again."', shapes.cutoff.err === LIT.msg.cutoff && shapes.cutoff.isError, JSON.stringify(shapes.cutoff));
  check('text that is not JSON -> a plain Error', shapes.notJson.isError && /^Could not read/.test(shapes.notJson.err), shapes.notJson.err);
  check('reply without a text block -> a plain Error', shapes.noText.isError && /^Could not read/.test(shapes.noText.err), shapes.noText.err);
  check('the first TEXT block is used (a thinking block before it is skipped)', shapes.firstTextBlock.ok && shapes.firstTextBlock.ok.candidates[0].number === 2);
  check('JSON inside a code fence is still read', shapes.fenced.ok && shapes.fenced.ok.candidates[0].number === 9 && shapes.fenced.ok.notes === 'f');
  check('a 200 reply that is not JSON -> a plain Error', shapes.badBody.isError && /^Could not read/.test(shapes.badBody.err), shapes.badBody.err);
  check('missing usage gives usage: null', shapes.noUsage.ok && shapes.noUsage.ok.usage === null);

  // ---- HTTP errors
  const httpErrs = await page.evaluate(async (key) => {
    const [a, b] = await Promise.all([A.jpeg('#c44'), A.jpeg('#44c')]);
    const rank = () => A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [b], candidateCount: 40, topN: 8 }));
    const out = {};
    for (const status of [401, 403, 429, 400, 404, 413, 500, 502, 503, 529]) {
      A.install(() => A.json({ type: 'error', error: { type: 'some_error', message: 'Detail from API' } }, status));
      out[status] = await rank();
    }
    A.install(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    out.html502 = await rank();
    A.install(() => new Response('oops', { status: 400 }));
    out.plain400 = await rank();
    A.install(() => { throw new TypeError('Failed to fetch'); });
    out.network = await rank();
    A.install(() => Promise.reject(new TypeError('Load failed')));
    out.networkRejected = await rank();
    A.install(() => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')));
    out.aborted = await rank();
    A.install(() => { throw new TypeError('Failed to execute fetch with x-api-key ' + key); });
    out.leaky = await rank();
    return out;
  }, KEY);
  check('401 -> "API key rejected. Check Settings."', httpErrs[401].err === LIT.msg.key && httpErrs[401].isError, httpErrs[401].err);
  check('403 -> "API key rejected. Check Settings."', httpErrs[403].err === LIT.msg.key, httpErrs[403].err);
  check('429 -> "Rate limit hit. Wait a minute and try again."', httpErrs[429].err === LIT.msg.rate, httpErrs[429].err);
  check('400 -> "Request rejected: " + the API message', httpErrs[400].err === LIT.msg.rejected + 'Detail from API', httpErrs[400].err);
  check('400 without a JSON body -> "Request rejected: HTTP 400."', httpErrs.plain400.err === LIT.msg.rejected + 'HTTP 400.', httpErrs.plain400.err);
  check('404 and 413 -> "Request rejected: ..." too', httpErrs[404].err === LIT.msg.rejected + 'Detail from API' && httpErrs[413].err === LIT.msg.rejected + 'Detail from API');
  check('500, 502, 503, 529 -> "Claude is busy. Try again."', [500, 502, 503, 529].every((s) => httpErrs[s].err === LIT.msg.busy), [500, 502, 503, 529].map((s) => httpErrs[s].err).join(' | '));
  check('502 with an HTML body -> "Claude is busy. Try again."', httpErrs.html502.err === LIT.msg.busy);
  check('network failure (fetch throws) -> "No connection."', httpErrs.network.err === LIT.msg.offline && httpErrs.network.isError, httpErrs.network.err);
  check('network failure (fetch rejects) -> "No connection."', httpErrs.networkRejected.err === LIT.msg.offline);
  check('an aborted request -> "No connection."', httpErrs.aborted.err === LIT.msg.offline);
  const leaky = httpErrs.leaky;
  check('a fetch error that contains the key is replaced by "No connection."', leaky.err === LIT.msg.offline, leaky.err);

  // ---- input checks
  const bad = await page.evaluate(async (key) => {
    const [a, b] = await Promise.all([A.jpeg('#c44'), A.jpeg('#44c')]);
    A.install(() => A.goodReply());
    const out = {};
    out.noSpot = await A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: null, posterBlob: null, sheetBlobs: [b], candidateCount: 40, topN: 8 }));
    out.noSheets = await A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [], candidateCount: 40, topN: 8 }));
    out.noCount = await A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [b], topN: 8 }));
    out.noParams = await A.attempt(() => PF.api.rankPieces());
    out.callsAfterBad = A.calls.length;
    const keys = {};
    for (const [name, k] of Object.entries({ empty: '', spaces: '   ', undef: undefined, nul: null, num: 12345, inner: 'sk-ant bad key', newline: 'sk-ant-abc\ndef', accent: 'sk-ant-café' })) {
      keys[name] = await A.attempt(() => PF.api.rankPieces({ apiKey: k, holeBlob: a, sheetBlobs: [b], candidateCount: 40, topN: 8 }));
    }
    out.keys = keys;
    out.testKeyEmpty = await A.attempt(() => PF.api.testKey({ apiKey: '', model: 'claude-haiku-5-5' }));
    out.callsAfterAll = A.calls.length;
    A.install(() => A.goodReply());
    await PF.api.rankPieces({ apiKey: '  ' + key + '\n', holeBlob: a, sheetBlobs: [b], candidateCount: 40, topN: 8 });
    out.trimmedHeader = A.calls[0].headers['x-api-key'];
    return out;
  }, KEY);
  check('no spot photo and no poster crop -> plain Error, no request', bad.noSpot.isError && /spot/.test(bad.noSpot.err), bad.noSpot.err);
  check('no sheets -> plain Error', bad.noSheets.isError && bad.noSheets.err === 'No pieces to search.', bad.noSheets.err);
  check('missing candidateCount -> plain Error', bad.noCount.isError && bad.noCount.err === 'No pieces to search.', bad.noCount.err);
  check('missing params object -> API key message (no crash)', bad.noParams.err === LIT.msg.key, bad.noParams.err);
  check('bad input never reaches fetch', bad.callsAfterBad === 0 && bad.callsAfterAll === 0, `${bad.callsAfterBad}/${bad.callsAfterAll} calls`);
  check('empty / blank / non-string / spaced / newline / non-ASCII keys -> "API key rejected. Check Settings."',
    Object.values(bad.keys).every((r) => r.err === LIT.msg.key) && bad.testKeyEmpty.err === LIT.msg.key, JSON.stringify(Object.entries(bad.keys).filter(([, r]) => r.err !== LIT.msg.key)));
  check('a key with spaces / a newline around it is trimmed before it is sent', bad.trimmedHeader === KEY, JSON.stringify(bad.trimmedHeader));

  // ---- testKey
  const tk = await page.evaluate(async (key) => {
    const out = {};
    A.install(() => A.answer('OK'));
    out.ok = await A.attempt(() => PF.api.testKey({ apiKey: key, model: 'claude-sonnet-5-5' }));
    out.call = A.calls[0];
    A.install(() => A.answer('OK'));
    await PF.api.testKey({ apiKey: key });
    out.defaultModel = A.calls[0].body.model;
    A.install(() => new Response('', { status: 200 }));
    out.emptyBody200 = await A.attempt(() => PF.api.testKey({ apiKey: key, model: 'claude-haiku-5-5' }));
    for (const [name, status] of [['k401', 401], ['k403', 403], ['k429', 429], ['k400', 400], ['k529', 529], ['k500', 500]]) {
      A.install(() => A.json({ type: 'error', error: { type: 'x', message: 'model: claude-nope not found' } }, status));
      out[name] = await A.attempt(() => PF.api.testKey({ apiKey: key, model: 'claude-nope' }));
    }
    A.install(() => { throw new TypeError('Failed to fetch'); });
    out.network = await A.attempt(() => PF.api.testKey({ apiKey: key, model: 'claude-haiku-5-5' }));
    return out;
  }, KEY);
  check('testKey resolves true on HTTP 200', tk.ok.ok === true, JSON.stringify(tk.ok));
  check('testKey: POST to the same URL with the same four headers', tk.call.method === 'POST' && tk.call.url === ENDPOINT && eq(tk.call.headers, LIT.headers));
  check('testKey body: model, max_tokens 16, one user text "Reply with the word OK."',
    eq(tk.call.body, { model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the word OK.' }] }] }), JSON.stringify(tk.call.body));
  check('testKey sends no output_config', !('output_config' in tk.call.body) && !/output_config/.test(tk.call.rawBody));
  check('testKey without a model uses claude-haiku-5-5', tk.defaultModel === 'claude-haiku-5-5');
  check('testKey: HTTP 200 with an empty body still resolves true', tk.emptyBody200.ok === true);
  check('testKey 401 / 403 -> key message', tk.k401.err === LIT.msg.key && tk.k403.err === LIT.msg.key);
  check('testKey 429 -> rate limit message', tk.k429.err === LIT.msg.rate);
  check('testKey 400 -> "Request rejected: " + API message', tk.k400.err === LIT.msg.rejected + 'model: claude-nope not found', tk.k400.err);
  check('testKey 500 / 529 -> busy message', tk.k500.err === LIT.msg.busy && tk.k529.err === LIT.msg.busy);
  check('testKey network failure -> "No connection."', tk.network.err === LIT.msg.offline && tk.network.isError);

  // ---- PF.img used when it exists (stub defined after api.js was loaded), media types cleaned
  const imgStub = await page.evaluate(async (key) => {
    const [a, b, c] = await Promise.all([A.jpeg('#c44'), A.jpeg('#4c4'), A.jpeg('#44c')]);
    let used = 0;
    PF.img = {
      blobToBase64: async (blob) => {
        used++;
        return used === 3 ? { media_type: 'application/octet-stream', data: 'ODD' } : { media_type: 'image/png', data: 'STUBDATA' + used };
      },
    };
    A.install(() => A.goodReply());
    await PF.api.rankPieces({ apiKey: key, holeBlob: a, posterBlob: b, sheetBlobs: [c], candidateCount: 40, topN: 8 });
    const blocks = A.calls[0].body.messages[0].content.filter((x) => x.type === 'image').map((x) => x.source);
    delete PF.img;
    return { used, blocks };
  }, KEY);
  check('PF.img.blobToBase64 is used when present (3 images -> 3 calls)', imgStub.used === 3, String(imgStub.used));
  check('its data goes into the request; an unknown media type falls back to image/jpeg',
    imgStub.blocks[0].data === 'STUBDATA1' && imgStub.blocks[0].media_type === 'image/png' && imgStub.blocks[2].data === 'ODD' && imgStub.blocks[2].media_type === 'image/jpeg', JSON.stringify(imgStub.blocks.map((s) => s.media_type)));
  await page.close();

  // ------------------------------------------------------------------ page WITH the real imgutil.js
  const page2 = await openPage('test_api_page_img.html');
  const real = await page2.evaluate(async (key) => {
    const [a, b] = await Promise.all([A.jpeg('#c44'), A.jpeg('#44c')]);
    let used = 0;
    const orig = PF.img.blobToBase64;
    PF.img.blobToBase64 = (blob) => { used++; return orig(blob); };
    A.install(() => A.goodReply());
    const res = await A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [b], candidateCount: 40, topN: 8 }));
    const fromReader = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(a); });
    const imgBlocks = A.calls[0].body.messages[0].content.filter((x) => x.type === 'image');
    return { res, used, first: imgBlocks[0].source, same: imgBlocks[0].source.data === fromReader, types: A.calls[0].body.messages[0].content.map((x) => x.type).join() };
  }, KEY);
  check('with the real imgutil.js: PF.img.blobToBase64 is called for each image', real.used === 2 && !!real.res.ok, `${real.used} calls, ${JSON.stringify(real.res.err || '')}`);
  check('with the real imgutil.js: request is valid (JPEG base64, same bytes as FileReader)', real.first.type === 'base64' && real.first.media_type === 'image/jpeg' && real.same && real.types === 'text,image,text,image,text');
  await page2.close();

  // ------------------------------------------------------------------ the 2 minute timeout (fake clock)
  const page3 = await openPage('test_api_page.html', true);
  await page3.evaluate(async (key) => {
    const [a, b] = await Promise.all([A.jpeg('#c44'), A.jpeg('#44c')]);
    const called = new Promise((resolve) => { A.onCall = resolve; });
    A.install((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    window.__hang = A.attempt(() => PF.api.rankPieces({ apiKey: key, holeBlob: a, sheetBlobs: [b], candidateCount: 40, topN: 8 }));
    await called;
  }, KEY);
  await page3.clock.runFor(60000);
  const stillWaiting = await page3.evaluate(() => Promise.race([window.__hang.then(() => 'done'), new Promise((r) => r('waiting'))]));
  await page3.clock.runFor(70000);
  const hung = await page3.evaluate(() => window.__hang);
  check('a request that hangs is still waiting after 60 s', stillWaiting === 'waiting');
  check('a request that hangs is stopped after 2 minutes -> "No connection."', hung.err === LIT.msg.offline, JSON.stringify(hung));
  await page3.close();

  // ------------------------------------------------------------------ the key is never printed or put in an error
  const errs = errorTexts([httpErrs, bad, tk, shapes, leaky]);
  check('no error message contains the API key (even when the fetch error itself contains it)', errs.length > 30 && errs.every((e) => e.indexOf(KEY) === -1), `${errs.length} messages checked`);
  check('the page console never printed the API key (or anything at all from api.js)', consoleTexts.every((t) => t.indexOf(KEY) === -1) && consoleTexts.length === 0, consoleTexts.join(' | '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser.close();
  server.close();
}

console.log(failed === 0 ? '\nALL API TESTS PASSED' : `\n${failed} API TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
