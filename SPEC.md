# Piece Finder — build spec

A phone web app (iPhone Home Screen, GitHub Pages, no build step) that helps two people finish a 1500-piece jigsaw puzzle.
The user photographs small sorted groups of loose pieces from above. The app cuts each photo into pieces on the phone.
To fill one empty spot, the user photographs the spot and/or taps the spot on the poster (full picture). The app sends the
spot photo, a poster crop, and numbered "contact sheets" of candidate pieces to the Claude API. Claude returns the top
candidates. The app circles them on the group photo. The user marks a piece "placed" and it leaves the pool.

All files live in the repo root. No bundler, no framework, no external libraries. Plain ES2020 JavaScript in classic
`<script>` tags (NOT modules), loaded in this order by `index.html`:

```
imgutil.js  db.js  segment.js  sheet.js  api.js  poster.js  app.js
```

Every file starts with `window.PF = window.PF || {};` and adds its namespace (`PF.img`, `PF.db`, `PF.settings`,
`PF.segment`, `PF.sheet`, `PF.api`, `PF.poster`, `PF.app`). Do not change any signature below. If something is
impossible, implement the closest thing and write the deviation in `NOTES-<file>.md`.

Target browser: iOS Safari 17+ in standalone (Home Screen) mode. Also must work in desktop Chrome for testing.
Keep code readable: short functions, comments at the top of each function saying what it does.

---

## 1. Data model

IndexedDB database `piecefinder`, version 1. Three object stores:

```
groups  (keyPath 'id')
  { id: string (crypto.randomUUID()), name: string, createdAt: number (Date.now()),
    photo: Blob (JPEG, long edge <= 1600 px), w: number, h: number  (photo pixel size),
    thumb: Blob (JPEG, long edge 300 px) }

pieces  (keyPath 'id', indexes: 'groupId' on groupId, 'status' on status)
  { id: string, groupId: string,
    bbox: { x: number, y: number, w: number, h: number }   // pixels in the group photo
    thumb: Blob (JPEG crop of bbox, long edge <= 320 px),
    status: 'loose' | 'placed', createdAt: number, placedAt: number | null }

meta    (keyPath 'key')
  { key: 'poster', blob: Blob (JPEG, long edge <= 2400 px), w: number, h: number }
```

Settings live in `localStorage` under key `pf.settings` as JSON:
`{ apiKey: '', model: 'claude-haiku-5-5', topN: 8 }`.

---

## 2. `imgutil.js` → `PF.img`

```js
PF.img.loadFile(file)            // File|Blob → Promise<HTMLImageElement|ImageBitmap>, EXIF orientation applied
                                 // (use createImageBitmap(file, {imageOrientation:'from-image'}) when available,
                                 //  else an <img> from URL.createObjectURL; revoke the URL after load)
PF.img.toCanvas(src, maxLongEdge) // image/bitmap/canvas → new canvas, downscaled so max(w,h) <= maxLongEdge,
                                 // aspect kept, never upscaled; uses high-quality smoothing
PF.img.blobToCanvas(blob, maxLongEdge=Infinity) // Promise<canvas>
PF.img.canvasToBlob(canvas, type='image/jpeg', quality=0.85) // Promise<Blob>
PF.img.blobToDataURL(blob)       // Promise<string>
PF.img.blobToBase64(blob)        // Promise<{ media_type: string, data: string }>  (data has no "data:" prefix)
PF.img.crop(canvas, x, y, w, h, maxLongEdge=Infinity) // → new canvas with that region (clamped to the canvas),
                                 // downscaled so max side <= maxLongEdge
PF.img.uuid()                    // crypto.randomUUID() with a fallback
```

---

## 3. `db.js` → `PF.db` and `PF.settings`

```js
PF.db.open()                        // Promise<IDBDatabase>; creates stores + indexes on upgrade; cached after first call
PF.db.get(store, key)               // Promise<object|undefined>
PF.db.put(store, obj)               // Promise<void>
PF.db.bulkPut(store, objs)          // Promise<void> — one transaction
PF.db.del(store, key)               // Promise<void>
PF.db.all(store)                    // Promise<object[]>
PF.db.byIndex(store, indexName, value) // Promise<object[]>
PF.db.deleteGroup(groupId)          // Promise<void> — deletes the group and all its pieces
PF.db.clearAll()                    // Promise<void> — empties all three stores
PF.db.requestPersist()              // calls navigator.storage.persist() if available; never throws

PF.settings.get()                   // → settings object merged over defaults
PF.settings.set(partial)            // merges and saves; returns the new settings
```

---

## 4. `segment.js` → `PF.segment`

Finds the loose pieces in a top-down photo of pieces lying on a plain background (white paper or dark cloth).

```js
PF.segment.detect(canvas, opts = {})
// canvas: the group photo (long edge <= 1600)
// opts: { thresholdScale: 1.0, minAreaFrac: 0.0005, pad: 0.08 }
// → { pieces: [{ x, y, w, h, cx, cy, area, merged }], bg: {r,g,b}, threshold: number, scale: number }
//   bbox values are integers in the INPUT canvas coordinates; cx, cy = box center; area = mask pixels at work scale.
```

Algorithm (do exactly this; it is tested with synthetic images):

1. Work copy: downscale to long edge 800 (scale `s`; `s = 1` if already smaller). Get ImageData.
2. Background color: take all pixels in the outer border band (thickness = 3% of min(w,h)); background = per-channel
   median of those pixels.
3. Distance per pixel: `d = sqrt((r-br)^2 + (g-bg)^2 + (b-bb)^2)`, scaled to 0..255 (divide by 441.67).
4. Threshold: Otsu's method on the histogram of `d`. Then `T = max(25, otsuT) * thresholdScale`. Mask = `d > T`.
5. Morphology on the mask: opening with radius 2 (erode twice, dilate twice, 3×3 structuring element, 8-neighborhood).
   This removes speckles and splits barely-touching pieces.
6. Connected components, 8-connectivity, iterative (explicit stack, Int32Array labels — no recursion).
   Per component: area, bbox.
7. Filter: ignore components with area < 30. Let `med` = median area of the rest. Keep components with
   `area >= max(0.25 * med, minAreaFrac * W * H)`. Set `merged = area > 2.5 * med`.
8. Pad each bbox by `pad * max(w,h)` on every side; clamp to the image. Scale back by `1/s`; round to integers.
9. Sort in reading order: row = `Math.round(cy / (median piece height))`, then by cx.
10. Return as above. Must run in < 1.5 s for a 1600 px photo on a phone (use typed arrays, no per-pixel objects).

Also export `PF.segment.otsu(hist)` → threshold index, for tests.

Tests (also your job, in `tests/`): `tests/gen_synthetic.py` (PIL + numpy) writes 4 JPEGs to `tests/fixtures/`:
white background with 24 colored irregular blobs (puzzle-piece-like, random rotation, soft shadow), dark-gray cloth with
20 light pieces, a noisy/vignetted version, and one where two pieces touch (expect `merged` on that one).
Each fixture gets a sidecar JSON with the true piece count and centers. `tests/test_segment.mjs` runs headless
Chromium via Playwright (`require('playwright')` — it is installed globally; `executablePath: '/opt/pw-browsers/chromium'`
if needed, or `chromium.launch()`), loads `tests/segment.html` (which includes `../imgutil.js` and `../segment.js` via
a local static server you start in the test — do not rely on file:// for the image), runs `detect`, and asserts: count
within ±1 of truth, each true center inside some bbox, runtime printed. Print PASS/FAIL per fixture. If imgutil.js is
not present yet, the test may load the image with a plain `<img>` and draw it to a canvas itself.

---

## 5. `sheet.js` → `PF.sheet`

Builds numbered contact sheets for Claude, and draws result circles on a group photo.

```js
PF.sheet.build(entries, opts = {})
// entries: [{ id: string, canvas: HTMLCanvasElement }]  (piece thumbs)
// opts: { cols: 6, rows: 6, cell: 316, startNumber: 1 }
// → [{ canvas: HTMLCanvasElement, entries: [{ number: int, id: string }] }]
```
Layout per sheet: `cols*cell` wide, `usedRows*cell` tall (the last sheet is cropped to the rows it uses).
Cell: background `#e6e6e6`, 2 px `#8a8a8a` border. Piece drawn "contain"-fit into the area
(cell−16) wide × (cell−60) tall, 8 px from the top, centered. Bottom strip 44 px: white, with the number centered,
`bold 34px -apple-system, Helvetica, Arial, sans-serif`, black. Numbers run continuously across sheets starting
at `startNumber`.

```js
PF.sheet.drawMarks(photoCanvas, marks, opts = {})
// marks: [{ bbox: {x,y,w,h}, label: string, kind: 'rank' | 'placed' }]
// opts: { maxLongEdge: 1600 }
// → new canvas (photo copy, downscaled to maxLongEdge if larger) with overlays:
//   'rank'   : circle centered on the bbox, radius 0.62*max(w,h), stroke 0.006*longEdge px, color #ffd400 with a
//              2 px dark outline; label in a filled #ffd400 round badge at the top-right of the circle, bold text ~
//              0.035*longEdge px, black.
//   'placed' : semi-transparent black (alpha 0.55) rectangle over the bbox and a white "✓" centered, ~0.04*longEdge px.
```

---

## 6. `api.js` → `PF.api`

Calls the Claude Messages API directly from the browser.

```js
PF.api.rankPieces({ apiKey, model, topN, holeBlob, posterBlob, sheetBlobs, candidateCount })
// holeBlob: Blob|null, posterBlob: Blob|null, sheetBlobs: Blob[] (>= 1)
// → Promise<{ candidates: [{ number: int, confidence: 'high'|'medium'|'low', reason: string }],
//             notes: string, usage: object|null }>
// candidates: valid numbers only (1..candidateCount), de-duplicated, in Claude's order, max topN.
PF.api.testKey({ apiKey, model })   // Promise<true>; throws a friendly Error otherwise
PF.api.MODELS                        // [{ id:'claude-haiku-5-5', label:'Haiku 5.5 — fast, cheapest' },
                                     //  { id:'claude-sonnet-5-5', label:'Sonnet 5.5 — smarter' },
                                     //  { id:'claude-opus-5-5',   label:'Opus 5.5 — smartest, costs most' }]
```

Request: `POST https://api.anthropic.com/v1/messages` with headers
```
content-type: application/json
x-api-key: <apiKey>
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
```
Body:
```json
{ "model": "<model>", "max_tokens": 2048,
  "system": "<SYSTEM>",
  "messages": [{ "role": "user", "content": [ ...blocks ] }],
  "output_config": { "format": { "type": "json_schema", "schema": <SCHEMA> } } }
```
Content blocks, in order (image blocks are `{type:'image', source:{type:'base64', media_type, data}}`):
1. If holeBlob: text `IMAGE: photo of the empty spot in the puzzle, taken from above, with the placed neighboring pieces around it.` then the image.
2. If posterBlob: text `IMAGE: crop of the finished-puzzle picture (the poster), centered on the empty spot. The missing piece is at the center of this crop.` then the image.
3. For each sheet i: text `CANDIDATE SHEET ${i+1} of ${n}: loose pieces. The number under each piece is its ID.` then the image.
4. Final text:
```
Task: find which candidate pieces could fit the empty spot. Rank the best ${topN} candidates, best first.
Judge by: (1) colors and patterns that match the picture at the spot and continue the neighbors' patterns,
(2) the shape of the hole: which sides need a tab (knob) and which need a blank (socket), (3) the candidate's
tab/blank layout — a candidate may be rotated any way. Candidate IDs run 1 to ${candidateCount}.
Return only plausible candidates (fewer than ${topN} is fine). Give each a one-sentence reason a person can check
by eye. Put any general observation in notes (one sentence).
```
SYSTEM: `You help people solve a 1500-piece jigsaw puzzle. You look at photos of loose pieces and an empty spot and say which pieces might fit. Be concrete and brief.`

SCHEMA:
```json
{ "type": "object",
  "properties": {
    "candidates": { "type": "array", "items": { "type": "object",
        "properties": { "number": { "type": "integer" },
                        "confidence": { "type": "string", "enum": ["high", "medium", "low"] },
                        "reason": { "type": "string" } },
        "required": ["number", "confidence", "reason"], "additionalProperties": false } },
    "notes": { "type": "string" } },
  "required": ["candidates", "notes"], "additionalProperties": false }
```
Response: find the first content block with `type === 'text'`, `JSON.parse` its text. If `stop_reason === 'max_tokens'`
throw `Error('Answer was cut off. Try again.')`. Errors → throw `Error` with a plain message:
401/403 → `API key rejected. Check Settings.`; 429 → `Rate limit hit. Wait a minute and try again.`;
400 → `Request rejected: ` + the API error message; 5xx/529 → `Claude is busy. Try again.`; network failure →
`No connection.` Never log the API key. `testKey` sends `max_tokens: 16`, user text `Reply with the word OK.`, no
output_config, and resolves true on HTTP 200.

---

## 7. `poster.js` → `PF.poster` (spot picker overlay)

```js
PF.poster.pick({ posterCanvas, initial })
// posterCanvas: canvas of the poster (long edge <= 2400)
// initial: { cx, cy, frac } | undefined   (poster pixel coords; frac = crop side as a fraction of poster width)
// → Promise<{ cx, cy, frac, cropCanvas } | null>   (null = cancelled)
```
Creates a full-screen overlay `<div class="pf-poster-overlay">` appended to `document.body` and removed on close.
Layout: top bar with title "Tap the empty spot" and buttons Cancel / Use this spot; a scrollable pan area
(`overflow: auto; -webkit-overflow-scrolling: touch`) holding the poster drawn on a canvas at
`containerWidth * zoom` wide; zoom buttons `1× 2× 4×` (default 2×); a slider "Spot size" 4–25 (% of poster width,
default 10). A tap (pointerup with little movement) sets `(cx, cy)` in poster coords. Draw on the canvas: a crosshair at
the center and a square of side `frac * posterW` (yellow `#ffd400`, 3 px). Re-draw on zoom/slider change; keep the
center in view when zooming. "Use this spot" is disabled until a tap happened. `cropCanvas` = square crop centered on
(cx, cy), side `frac * posterW`, clamped inside the poster, downscaled to long edge <= 1000. Include the overlay's CSS
inside `poster.js` (inject a `<style>` once). Dark theme: background `#111`, text `#eee`.

---

## 8. `index.html` + `app.css` + `app.js` → `PF.app`

> As built: the UI is split into `app.js` (helpers, state, Settings, Poster), `app-pieces.js` (Pieces tab) and
> `app-find.js` (Find tab + results), loaded in that order after `poster.js`. Everything else below still applies.

Single-page app, dark theme (`#0f1115` background, `#e8eaf0` text, accent `#ffd400`, cards `#1a1d24`, danger `#ff5a5a`),
system font, big touch targets (min 48 px), iOS safe-area padding (`env(safe-area-inset-*)`), no zoom on inputs
(font-size >= 16 px). `<head>`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`,
`<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
`<link rel="manifest" href="manifest.webmanifest">`, `<link rel="apple-touch-icon" href="icons/icon-180.png">`,
`<title>Piece Finder</title>`. Bottom tab bar with 4 tabs: **Find**, **Pieces**, **Poster**, **Settings**.
On first launch with no API key, open Settings and show a hint. Show a small version string `v0.1` in Settings.
Camera input: `<input type="file" accept="image/*" capture="environment">` (hidden; triggered by big buttons).
Every long operation shows a status line (e.g. "Finding pieces… 12 found", "Asking Claude…"). All errors show in a
toast at the top, never `alert()`.

### Find tab (the main flow)
Three cards, then a button:
1. **Empty spot photo** — big button "Take photo of the spot" → preview thumbnail + "Retake" / "Remove". Optional.
   Process: `PF.img.loadFile` → `toCanvas(1600)` → `canvasToBlob`. Keep in memory (not stored).
2. **Spot on the poster** — button "Pick the spot" (disabled with hint "Add the poster first" if no poster) →
   `PF.poster.pick` → show the crop thumbnail + "Change" / "Remove". Optional. Remember the last pick in memory.
3. **Groups to search** — checkbox list of groups with loose counts, "All / None" toggle. Default all checked.
   Hint if no groups: "Add piece groups first".
Button **Find pieces** (disabled unless (1 or 2) and at least one checked group with loose pieces and an API key).
On tap: gather loose pieces of the checked groups (max 144; if more, take the first 144 and show a toast
"Searching the first 144 pieces — pick fewer groups for better results"), load each piece thumb to a canvas,
`PF.sheet.build`, `canvasToBlob` each sheet (JPEG 0.85), call `PF.api.rankPieces`, then render **Results**.

### Results (replaces the Find cards, with a "← New search" button)
- Ranked list: rank number, piece thumb (96 px), group name, confidence pill (high=green, medium=yellow, low=gray),
  reason text, and two buttons: **Placed ✓** (sets piece status 'placed', placedAt=now, removes the row with a
  short animation, updates counts) and **Not it** (hides the row).
- Under the list, one section per group that has a ranked piece: group name and `PF.sheet.drawMarks` of that
  group's photo with 'rank' marks for its ranked pieces (label = rank) and 'placed' marks for its placed pieces.
  Canvas displayed at full width; tap to open it full-screen (simple overlay, pinch-zoom allowed via a scrollable
  container at 2×).
- Show `notes` at the bottom in small text, and the token usage (input/output) in a muted line.
- A "Search again with Sonnet" link if the model used was Haiku (re-runs the same query with `claude-sonnet-5-5`).

### Pieces tab
- Header with the total loose count. List of groups (thumb, name, "N loose · M placed"). Tap → group detail.
- Button **Add group** → camera → `toCanvas(1600)` → `PF.segment.detect` → **Review screen**: the photo with the
  detected boxes drawn (`drawMarks` with kind 'rank' and labels 1..N is fine, or simple yellow rectangles; merged
  boxes in orange), a count line "24 pieces found", a slider **Sensitivity** (0.5–1.5, default 1.0, re-runs detect
  with `thresholdScale`), tap on a box to delete it, a text field **Group name** (default "Group N"), buttons
  **Retake** and **Save group**. Save: build thumbs with `PF.img.crop(canvas, bbox…, 320)` → blobs; group thumb 300;
  store group + pieces with `bulkPut`.
- Group detail: name (editable), photo with marks (placed → 'placed' mark; loose → thin boxes), tap a piece to toggle
  loose/placed, buttons **Re-photograph** (replaces photo and pieces; confirm first) and **Delete group** (confirm).

### Poster tab
- If no poster: big button "Add poster photo" with the tip "Photograph the whole poster straight on, in good light."
- Else: the poster shown (fit width), buttons "Replace poster". Storing: `toCanvas(2400)` → JPEG 0.9 → meta 'poster'.

### Settings tab
- API key (type=password with a Show toggle), Model select from `PF.api.MODELS`, "Candidates to show" number 5–12,
  button **Test key** (uses `PF.api.testKey`, toasts "Key works" or the error), link text "Keys are stored only on this
  phone." Button **Clear all data** (confirm twice) → `PF.db.clearAll()`.
- Short help block "How to take photos": plain background that contrasts with the pieces, from straight above, even
  light, pieces not touching, up to ~36 pieces per photo.

### Startup
`PF.app.init()` on `DOMContentLoaded`: `PF.db.open()`, `PF.db.requestPersist()`, render the Find tab.
Expose `PF.app` state helpers for tests: `PF.app.state` (current in-memory state object), `PF.app.render()`.

---

## 9. `manifest.webmanifest`, `icons/`, `README.md`

- `manifest.webmanifest`: name "Piece Finder", short_name "Pieces", start_url "./", scope "./", display "standalone",
  background_color "#0f1115", theme_color "#0f1115", icons 192 and 512 PNG (`icons/icon-192.png`, `icons/icon-512.png`).
- Icons: generated with Python PIL: rounded square `#0f1115` background with a simple yellow `#ffd400` jigsaw-piece
  silhouette (a square with one round tab on the top and one on the right, one round blank on the bottom). Sizes
  180, 192, 512. No text.
- `README.md`: written in plain, short sentences (ASD-STE100 style: command form, <= 20 words per sentence, one
  instruction per sentence, no contractions). Sections: What it does; Files; Set up GitHub Pages (step by step:
  create a public repo named `piece-finder`, upload the files, Settings → Pages → Deploy from branch `main` / root,
  open `https://cmrlmatthews-max.github.io/piece-finder/`); Get a Claude API key (console.anthropic.com → API Keys →
  Create Key → copy it once); Add to iPhone Home Screen (Safari → Share → Add to Home Screen); First use (Settings →
  paste key → Test key; Poster → add poster; Pieces → add groups; Find); Photo tips; What it costs (Haiku 5.5: well
  under one cent per search; Sonnet 5.5: a few cents per search); Known limits (API key stored on the phone only —
  do not share the phone's browser data; pieces that match the background color are missed — use a contrasting
  background; results are suggestions, not certainties).
