window.PF = window.PF || {};

// PF.api: talks to the Claude Messages API straight from the browser (rank pieces, test an API key).
// The API key is only ever put in the request header. It is never logged and never put in an error message.
(function () {
  'use strict';

  const ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2023-06-01';
  const DEFAULT_MODEL = 'claude-sonnet-5-5';
  const DEFAULT_TOP_N = 8;
  const MAX_TOKENS = 2048;
  const TIMEOUT_MS = 120000;   // give up after 2 minutes

  // The model list shown in Settings; the first one is the recommended one (it is also DEFAULT_MODEL).
  // Note: \u2014 is the em dash used in the labels (kept as an escape so file encoding never matters).
  const MODELS = [
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 \u2014 recommended' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5 \u2014 fastest, cheapest' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5 \u2014 smartest, costs most' },
  ];

  const SYSTEM = 'You help people solve a 1500-piece jigsaw puzzle. You look at photos of loose pieces ' +
    'and a marked open spot and say which pieces might fit. Be concrete and brief.';

  const HOLE_FULL_TEXT = 'IMAGE: photo of the puzzle around the open spot to fill, taken from above. ' +
    'The yellow outline marks the open spot. Pieces that touch the outline from outside are placed neighbors. ' +
    'Some sides of the outline may have no neighbor because the puzzle is unfinished there; those sides are free.';

  const HOLE_CROP_TEXT = 'IMAGE: zoomed view of the same marked spot.';

  const POSTER_TEXT = 'IMAGE: crop of the finished-puzzle picture (the poster) around the spot. ' +
    'The yellow ring marks where the missing piece goes.';

  // Property order matters: Claude writes the keys in this order, so it describes the spot (spot) before it
  // ranks anything (candidates), and gives its general remark last (notes).
  const SCHEMA = {
    type: 'object',
    properties: {
      spot: {
        type: 'string',
        description: 'Description of the marked spot: bounded sides, open sides, tab/blank per bounded side, colors.',
      },
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
    required: ['spot', 'candidates', 'notes'],
    additionalProperties: false,
  };

  // The messages shown to the person. Keep them short and plain.
  const MSG = {
    key: 'API key rejected. Check Settings.',
    rate: 'Rate limit hit. Wait a minute and try again.',
    busy: 'Claude is busy. Try again.',
    offline: 'No connection.',
    cutoff: 'Answer was cut off. Try again.',
    unreadable: 'Could not read the answer from Claude. Try again.',
    rejected: 'Request rejected: ',
    noSpot: 'Add a photo of the spot or pick it on the poster.',
    noPieces: 'No pieces to search.',
  };

  // ---------------------------------------------------------------------------
  // prompt texts
  // ---------------------------------------------------------------------------

  // Text that comes before single-piece sheet i (0-based) of n.
  function sheetText(i, n) {
    return 'CANDIDATE SHEET ' + (i + 1) + ' of ' + n + ': loose single pieces. The number under each piece is its ID.';
  }

  // Text that comes before cluster sheet j (0-based) of m (items made of several joined pieces).
  function clusterSheetText(j, m) {
    return 'CLUSTER SHEET ' + (j + 1) + ' of ' + m + ': each item is several pieces already joined together ' +
      '(the caption gives the count). A cluster fits only an open area of the same shape and size. ' +
      'The number under each item is its ID.';
  }

  // The final instruction text: four lines (the line breaks are part of the text).
  function taskText(topN, candidateCount) {
    return [
      'Task: find which candidates could fit the marked open spot. Rank the best ' + topN + ', best first.',
      'Work in this order. First describe the spot: which sides touch placed neighbors and which sides are open; ' +
        'for each side with a neighbor, whether the spot needs a tab (knob) or a blank (socket) there; ' +
        "the colors and patterns the picture shows at the spot (use the poster crop) and along each neighbor's edge.",
      'Then judge every candidate against that description: colors and patterns must continue the neighbors; ' +
        'each bounded side must have the matching tab or blank; the candidate may be rotated any way; ' +
        "a cluster must match the open area's size and shape.",
      'Candidate IDs run 1 to ' + candidateCount + '. Return only plausible candidates (fewer than ' + topN +
        ' is fine). Give each a one-sentence reason a person can check by eye.',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------------

  // Returns v as an integer when it is a whole number (or a string of digits); otherwise null.
  function toInt(v) {
    if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) v = Number(v);
    return typeof v === 'number' && Number.isInteger(v) ? v : null;
  }

  // Wraps a single value in an array and drops empty entries.
  function asArray(v) {
    if (Array.isArray(v)) return v.filter(Boolean);
    return v ? [v] : [];
  }

  // Makes a text content block.
  function textBlock(text) {
    return { type: 'text', text };
  }

  // Trims the API key and checks it can go into a header. Throws the "key rejected" message if not.
  function cleanKey(apiKey) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error(MSG.key);
    return key;
  }

  // ---------------------------------------------------------------------------
  // images
  // ---------------------------------------------------------------------------

  // Fallback for PF.img.blobToBase64: reads a Blob with FileReader. Resolves { media_type, data }.
  function readBlobAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        resolve({ media_type: blob.type || 'image/jpeg', data: url.slice(url.indexOf(',') + 1) });
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read the photo.'));
      reader.readAsDataURL(blob);
    });
  }

  // Converts a Blob to { media_type, data }. Uses PF.img.blobToBase64 when it exists, else the fallback.
  function blobToBase64(blob) {
    const img = window.PF && window.PF.img;
    if (img && typeof img.blobToBase64 === 'function') return img.blobToBase64(blob);
    return readBlobAsBase64(blob);
  }

  // Makes an image content block from a Blob. Unknown picture types are sent as JPEG.
  async function imageBlock(blob) {
    const b64 = await blobToBase64(blob);
    const ok = /^image\/(jpeg|png|gif|webp)$/.test(b64.media_type);
    return {
      type: 'image',
      source: { type: 'base64', media_type: ok ? b64.media_type : 'image/jpeg', data: b64.data },
    };
  }

  // Builds the content blocks in the required order, each image preceded by its own text:
  // full spot photo, zoomed spot photo, poster crop, single-piece sheets, cluster sheets, final task text.
  // Pictures that are missing are left out.
  async function buildContent(p, singles, clusters, topN, count) {
    const blocks = [];
    if (p.holeFullBlob) blocks.push(textBlock(HOLE_FULL_TEXT), await imageBlock(p.holeFullBlob));
    if (p.holeCropBlob) blocks.push(textBlock(HOLE_CROP_TEXT), await imageBlock(p.holeCropBlob));
    if (p.posterBlob) blocks.push(textBlock(POSTER_TEXT), await imageBlock(p.posterBlob));
    for (let i = 0; i < singles.length; i++) {
      blocks.push(textBlock(sheetText(i, singles.length)), await imageBlock(singles[i]));
    }
    for (let j = 0; j < clusters.length; j++) {
      blocks.push(textBlock(clusterSheetText(j, clusters.length)), await imageBlock(clusters[j]));
    }
    blocks.push(textBlock(taskText(topN, count)));
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  // Returns the request headers (plain object, lower-case names).
  function makeHeaders(key) {
    return {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  // Reads a response body as JSON. Returns null when there is no body or it is not JSON.
  async function readJson(res) {
    try {
      if (typeof res.json === 'function') return await res.json();
      if (typeof res.text === 'function') return JSON.parse(await res.text());
    } catch (err) {
      // not JSON, or the read was cut off
    }
    return null;
  }

  // Turns an HTTP error status (and the API's own message) into a plain message.
  function httpError(status, data) {
    if (status === 401 || status === 403) return MSG.key;
    if (status === 429) return MSG.rate;
    if (status >= 500) return MSG.busy;        // includes 529 (overloaded)
    const detail = data && data.error && typeof data.error.message === 'string' ? data.error.message : '';
    return MSG.rejected + (detail || 'HTTP ' + status + '.');
  }

  // Sends one request to the Messages API. Resolves with the parsed JSON body (null if unreadable).
  // Throws an Error with a plain message for every failure.
  async function post(key, body) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : 0;
    try {
      let res;
      try {
        res = await window.fetch(ENDPOINT, {
          method: 'POST',
          headers: makeHeaders(key),
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (err) {
        throw new Error(MSG.offline);          // never pass the original error on: keep the key out of it
      }
      const data = await readJson(res);
      if (ctrl && ctrl.signal.aborted) throw new Error(MSG.offline);
      const ok = typeof res.ok === 'boolean' ? res.ok : res.status >= 200 && res.status < 300;
      if (!ok) throw new Error(httpError(res.status, data));
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // answer
  // ---------------------------------------------------------------------------

  // Parses text as JSON. If that fails, tries the part between the first "{" and the last "}".
  function parseJsonText(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      const a = text.indexOf('{');
      const b = text.lastIndexOf('}');
      if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
      throw err;
    }
  }

  // Gets the JSON answer from the first text block of the reply. Throws a plain Error on any problem.
  function parseAnswer(data) {
    if (!data || typeof data !== 'object') throw new Error(MSG.unreadable);
    if (data.stop_reason === 'max_tokens') throw new Error(MSG.cutoff);
    const block = Array.isArray(data.content) ? data.content.find((b) => b && b.type === 'text') : null;
    if (!block || typeof block.text !== 'string') throw new Error(MSG.unreadable);
    let answer;
    try {
      answer = parseJsonText(block.text);
    } catch (err) {
      throw new Error(MSG.unreadable);
    }
    if (!answer || typeof answer !== 'object') throw new Error(MSG.unreadable);
    return answer;
  }

  // Returns the confidence if it is one of the three allowed words, else "low".
  function cleanConfidence(c) {
    return c === 'high' || c === 'medium' || c === 'low' ? c : 'low';
  }

  // Keeps valid candidates: whole numbers 1..count, no repeats, Claude's order, at most topN.
  function cleanCandidates(list, count, topN) {
    const seen = new Set();
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
      const n = toInt(c && c.number);
      if (n === null || n < 1 || n > count || seen.has(n)) continue;
      seen.add(n);
      out.push({
        number: n,
        confidence: cleanConfidence(c.confidence),
        reason: typeof c.reason === 'string' ? c.reason : '',
      });
      if (out.length >= topN) break;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // public functions
  // ---------------------------------------------------------------------------

  // Asks Claude which loose pieces (and joined clusters) could fit the marked open spot.
  // params: { apiKey, model, topN, holeFullBlob, holeCropBlob, posterBlob, sheetBlobs, clusterSheetBlobs, candidateCount }
  //   All pictures are optional, but at least one of holeFullBlob / holeCropBlob / posterBlob is needed,
  //   and sheetBlobs + clusterSheetBlobs together need at least one sheet.
  // Resolves to { spot, candidates: [{number, confidence, reason}], notes, usage }.
  async function rankPieces(params) {
    const p = params || {};
    const key = cleanKey(p.apiKey);
    const singles = asArray(p.sheetBlobs);
    const clusters = asArray(p.clusterSheetBlobs);
    const count = toInt(p.candidateCount);
    const topN = toInt(p.topN) >= 1 ? toInt(p.topN) : DEFAULT_TOP_N;
    if (!p.holeFullBlob && !p.holeCropBlob && !p.posterBlob) throw new Error(MSG.noSpot);
    if (!(singles.length + clusters.length) || !(count >= 1)) throw new Error(MSG.noPieces);

    const body = {
      model: p.model || DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages: [{ role: 'user', content: await buildContent(p, singles, clusters, topN, count) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    };
    const data = await post(key, body);
    const answer = parseAnswer(data);
    return {
      spot: typeof answer.spot === 'string' ? answer.spot : '',
      candidates: cleanCandidates(answer.candidates, count, topN),
      notes: typeof answer.notes === 'string' ? answer.notes : '',
      usage: data.usage || null,
    };
  }

  // Checks that an API key and model work with a tiny request. Resolves true, or throws a plain Error.
  async function testKey(params) {
    const p = params || {};
    const key = cleanKey(p.apiKey);
    await post(key, {
      model: p.model || DEFAULT_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: [textBlock('Reply with the word OK.')] }],
    });
    return true;
  }

  PF.api = { rankPieces, testKey, MODELS, DEFAULT_MODEL };
})();
