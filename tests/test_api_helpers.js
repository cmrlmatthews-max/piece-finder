// Browser-side helpers for the api.js tests: fake fetch, small JPEG blobs, error capture.
window.A = (function () {
  const A = { calls: [], onCall: null };

  // The reply text used by the fake response: a spot description, then candidate 3 twice (the second one is a
  // repeat) and 99 (out of range), then a note. The keys come in the same order as in the real schema.
  A.GOOD_TEXT = '{"spot":"sp","candidates":[{"number":3,"confidence":"high","reason":"x"},' +
    '{"number":3,"confidence":"low","reason":"dup"},{"number":99,"confidence":"low","reason":"out of range"}],"notes":"n"}';

  // Reads a Blob as base64 (no "data:" prefix) the plain way, so a test can tell which picture went into which block.
  A.b64 = function (blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.readAsDataURL(blob);
    });
  };

  // Makes a small solid-color JPEG Blob.
  A.jpeg = function (color, w, h) {
    const c = document.createElement('canvas');
    c.width = w || 24;
    c.height = h || 24;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
  };

  // Makes a JSON Response with the given status.
  A.json = function (obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
  };

  // A good answer from the API with the given text.
  A.answer = function (text, stop) {
    return A.json({
      content: [{ type: 'text', text }],
      stop_reason: stop || 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  };

  // The fake 200 response from the task description.
  A.goodReply = function () {
    return A.answer(A.GOOD_TEXT);
  };

  // Replaces window.fetch. reply(url, init, callNumber) returns a Response (or a promise of one), or throws.
  // Every call is recorded in A.calls with the headers and body already copied to plain data.
  A.install = function (reply) {
    A.calls = [];
    window.fetch = async function (url, init) {
      const i = init || {};
      A.calls.push({
        url: String(url),
        method: i.method,
        headers: i.headers ? JSON.parse(JSON.stringify(i.headers)) : null,
        headerType: i.headers ? Object.prototype.toString.call(i.headers) : null,
        rawBody: typeof i.body === 'string' ? i.body : null,
        body: typeof i.body === 'string' ? JSON.parse(i.body) : null,
        hasSignal: !!i.signal,
      });
      if (A.onCall) A.onCall();
      return reply(url, i, A.calls.length);
    };
  };

  // Runs fn. Returns { ok: value } or { err: message, isError: true if it was an Error object }.
  A.attempt = async function (fn) {
    try {
      return { ok: await fn() };
    } catch (e) {
      return { err: e && e.message !== undefined ? e.message : String(e), isError: e instanceof Error };
    }
  };

  return A;
})();
