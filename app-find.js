window.PF = window.PF || {};

// Find tab: spot photo + poster spot + groups → contact sheets → Claude → ranked results with circles on the group photos.
(function () {
  'use strict';
  const A = PF.app;
  const { h, toast, setStatus } = A;
  const state = A.state;
  const MAX_PIECES = 144;          // 4 sheets of 36

  // Loads the loose pieces of the selected groups, each with its group attached. Returns { pieces, truncated }.
  async function gatherPieces(groups) {
    const sel = state.selectedGroupIds;
    let pieces = [];
    for (const g of groups) {
      if (sel && !sel.has(g.id)) continue;
      const list = (await PF.db.byIndex('pieces', 'groupId', g.id)).filter((p) => p.status !== 'placed');
      list.sort((a, b) => a.createdAt - b.createdAt);
      pieces = pieces.concat(list.map((p) => ({ piece: p, group: g })));
    }
    const truncated = pieces.length > MAX_PIECES;
    return { pieces: pieces.slice(0, MAX_PIECES), truncated };
  }

  // Runs one search. modelOverride lets "Search again with Sonnet" reuse the same inputs.
  async function runSearch(modelOverride) {
    if (state.busy) return;
    const s = PF.settings.get();
    const model = modelOverride || s.model;
    state.busy = true;
    try {
      const groups = (await PF.db.all('groups')).sort((a, b) => a.createdAt - b.createdAt);
      const { pieces, truncated } = await gatherPieces(groups);
      if (!pieces.length) throw new Error('No loose pieces in the selected groups.');
      if (truncated) toast(`Searching the first ${MAX_PIECES} pieces — pick fewer groups for better results`);
      setStatus(`Building contact sheets for ${pieces.length} pieces…`, true);
      const entries = [];
      for (const { piece } of pieces) entries.push({ id: piece.id, canvas: await PF.img.blobToCanvas(piece.thumb) });
      const sheets = PF.sheet.build(entries, { cols: 6, rows: 6, cell: 316, startNumber: 1 });
      const sheetBlobs = [];
      for (const sh of sheets) sheetBlobs.push(await PF.img.canvasToBlob(sh.canvas, 'image/jpeg', 0.85));
      setStatus(`Asking Claude (${pieces.length} pieces on ${sheets.length} sheet${sheets.length > 1 ? 's' : ''})…`, true);
      const res = await PF.api.rankPieces({ apiKey: s.apiKey, model, topN: s.topN || 8,
        holeBlob: state.hole ? state.hole.blob : null, posterBlob: state.spot ? state.spot.cropBlob : null,
        sheetBlobs, candidateCount: entries.length });
      const byNumber = {};
      sheets.forEach((sh) => sh.entries.forEach((e) => { byNumber[e.number] = e.id; }));
      const byId = {};
      pieces.forEach((x) => { byId[x.piece.id] = x; });
      const candidates = res.candidates.map((c) => byId[byNumber[c.number]] ? { ...byId[byNumber[c.number]], confidence: c.confidence, reason: c.reason } : null)
        .filter(Boolean).map((c, i) => ({ ...c, rank: i + 1, hidden: false }));
      state.results = { model, candidates, notes: res.notes, usage: res.usage, pieceCount: pieces.length, sheetCount: sheets.length };
      setStatus('');
      A.render();
    } catch (err) {
      toast(err.message, 'error');
      setStatus('');
    } finally {
      state.busy = false;
    }
  }

  // --- Find screen -----------------------------------------------------------
  async function renderFind() {
    const s = PF.settings.get();
    const poster = await PF.db.get('meta', 'poster');
    const groups = (await PF.db.all('groups')).sort((a, b) => a.createdAt - b.createdAt);
    const counts = await A.pieces.countPieces();
    const sel = state.selectedGroupIds;
    const isSel = (g) => !sel || sel.has(g.id);
    const selectedLoose = groups.filter(isSel).reduce((n, g) => n + ((counts[g.id] || {}).loose || 0), 0);

    // 1. spot photo
    const takeHole = async () => {
      const file = await A.pickPhoto();
      if (!file) return;
      try {
        setStatus('Preparing the photo…', true);
        const canvas = await A.loadPhoto(file, A.MAX_PHOTO);
        state.hole = { canvas, blob: await PF.img.canvasToBlob(canvas, 'image/jpeg', 0.85) };
        A.render();
      } catch (err) { toast(err.message, 'error'); setStatus(''); }
    };
    const holeCard = h('div', { class: 'card' },
      h('h2', {}, h('span', { class: 'step' + (state.hole ? ' done' : '') }, '1'), 'Empty spot photo ', h('span', { class: 'muted small' }, '(optional)')),
      state.hole
        ? [h('img', { class: 'preview', src: A.blobUrl(state.hole.blob), alt: 'Empty spot' }),
           h('div', { class: 'row', style: { marginTop: '8px' } },
             h('button', { type: 'button', class: 'btn btn-sm', onclick: takeHole }, 'Retake'),
             h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { state.hole = null; A.render(); } }, 'Remove'))]
        : [h('p', { class: 'muted small' }, 'From above, with the neighbors around the hole in the frame.'),
           h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: takeHole }, 'Take photo of the spot')]);

    // 2. spot on the poster
    const pickSpot = async () => {
      try {
        const posterCanvas = await PF.img.blobToCanvas(poster.blob);
        const r = await PF.poster.pick({ posterCanvas, initial: state.spot ? { cx: state.spot.cx, cy: state.spot.cy, frac: state.spot.frac } : undefined });
        if (!r) return;
        state.spot = { cx: r.cx, cy: r.cy, frac: r.frac, cropCanvas: r.cropCanvas, cropBlob: await PF.img.canvasToBlob(r.cropCanvas, 'image/jpeg', 0.9) };
        A.render();
      } catch (err) { toast(err.message, 'error'); }
    };
    const spotCard = h('div', { class: 'card' },
      h('h2', {}, h('span', { class: 'step' + (state.spot ? ' done' : '') }, '2'), 'Spot on the poster ', h('span', { class: 'muted small' }, '(optional)')),
      !poster ? h('p', { class: 'hint' }, 'Add the poster first (Poster tab).') : null,
      state.spot
        ? [h('img', { class: 'preview', src: A.blobUrl(state.spot.cropBlob), alt: 'Poster crop' }),
           h('div', { class: 'row', style: { marginTop: '8px' } },
             h('button', { type: 'button', class: 'btn btn-sm', onclick: pickSpot }, 'Change'),
             h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { state.spot = null; A.render(); } }, 'Remove'))]
        : h('button', { type: 'button', class: 'btn btn-block', disabled: !poster, onclick: pickSpot }, 'Pick the spot'));

    // 3. groups
    const toggleAll = (on) => { state.selectedGroupIds = on ? null : new Set(); A.render(); };
    const groupsCard = h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('h2', {}, h('span', { class: 'step' + (selectedLoose ? ' done' : '') }, '3'), 'Groups to search'),
        groups.length ? h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => toggleAll(true) }, 'All'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => toggleAll(false) }, 'None')) : null),
      groups.length ? groups.map((g) => {
        const c = counts[g.id] || { loose: 0, placed: 0 };
        return h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: isSel(g), onchange: (e) => {
            const set = new Set(groups.filter(isSel).map((x) => x.id));
            if (e.target.checked) set.add(g.id); else set.delete(g.id);
            state.selectedGroupIds = set.size === groups.length ? null : set;
            A.render();
          } }),
          h('span', { class: 'grow' }, g.name), h('span', { class: 'muted small' }, `${c.loose} loose`));
      }) : h('p', { class: 'hint' }, 'Add piece groups first (Pieces tab).'));

    const canSearch = (state.hole || state.spot) && selectedLoose > 0 && !!s.apiKey && !state.busy;
    const reasons = [];
    if (!s.apiKey) reasons.push('add your API key in Settings');
    if (!state.hole && !state.spot) reasons.push('add a spot photo or pick the spot');
    if (!selectedLoose) reasons.push('select a group with loose pieces');

    return h('div', {},
      h('h1', {}, 'Find a piece'),
      holeCard, spotCard, groupsCard,
      h('div', { class: 'card' },
        h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !canSearch, onclick: () => runSearch(null) }, 'Find pieces'),
        h('div', { id: 'status', class: 'status' }),
        !canSearch && reasons.length ? h('p', { class: 'muted small' }, 'To search: ' + reasons.join(', ') + '.') : null,
        h('p', { class: 'muted small' }, `Model: ${(PF.api.MODELS.find((m) => m.id === s.model) || {}).label || s.model}. Up to ${MAX_PIECES} pieces per search.`)));
  }

  // --- Results screen --------------------------------------------------------
  function openFullscreen(canvas) {
    const img = h('img', { src: canvas.toDataURL('image/jpeg', 0.85), alt: 'Group photo' });
    const overlay = h('div', { class: 'fullscreen' }, img);
    const close = h('button', { type: 'button', class: 'btn close', onclick: () => overlay.remove() }, 'Close');
    overlay.appendChild(close);
    document.body.appendChild(overlay);
  }

  async function renderResults() {
    const r = state.results;
    const visible = r.candidates.filter((c) => !c.hidden);
    const modelLabel = (PF.api.MODELS.find((m) => m.id === r.model) || {}).label || r.model;

    const rows = visible.map((c) => {
      const row = h('div', { class: 'result' });
      const placed = async () => {
        c.piece.status = 'placed'; c.piece.placedAt = Date.now();
        await PF.db.put('pieces', c.piece);
        c.hidden = true; c.placed = true;
        row.classList.add('leaving');
        toast('Piece placed. It is out of the pool now.', 'ok');
        setTimeout(() => A.render(), 260);
      };
      row.append(
        h('span', { class: 'rank' }, String(c.rank)),
        h('img', { class: 'thumb', src: A.blobUrl(c.piece.thumb), alt: '' }),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'title' }, c.group.name), h('span', { class: 'pill ' + c.confidence }, c.confidence)),
          h('div', { class: 'reason' }, c.reason || ''),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: placed }, 'Placed ✓'),
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { c.hidden = true; A.render(); } }, 'Not it'))));
      return row;
    });

    // one marked photo per group that still has a visible candidate
    const groupSections = [];
    const groupIds = [...new Set(visible.map((c) => c.group.id))];
    for (const gid of groupIds) {
      const group = await PF.db.get('groups', gid);
      if (!group) continue;
      const pieces = await PF.db.byIndex('pieces', 'groupId', gid);
      const marks = pieces.filter((p) => p.status === 'placed').map((p) => ({ bbox: p.bbox, label: '', kind: 'placed' }))
        .concat(visible.filter((c) => c.group.id === gid).map((c) => ({ bbox: c.piece.bbox, label: String(c.rank), kind: 'rank' })));
      const photo = await PF.img.blobToCanvas(group.photo);
      const drawn = PF.sheet.drawMarks(photo, marks, { maxLongEdge: 1600 });
      const canvas = h('canvas', { class: 'fit', width: drawn.width, height: drawn.height, onclick: () => openFullscreen(drawn) });
      canvas.getContext('2d').drawImage(drawn, 0, 0);
      groupSections.push(h('div', { class: 'card' }, h('h2', {}, group.name), canvas, h('p', { class: 'muted small' }, 'Tap to enlarge. Numbers are the ranks above.')));
    }

    const usage = r.usage ? `Tokens: ${A.fmtInt(r.usage.input_tokens)} in · ${A.fmtInt(r.usage.output_tokens)} out` : '';
    return h('div', {},
      h('button', { type: 'button', class: 'link', onclick: () => { state.results = null; A.render(); } }, '← New search'),
      h('h1', {}, 'Top candidates'),
      h('p', { class: 'muted small' }, `${modelLabel} · ${r.pieceCount} pieces on ${r.sheetCount} sheet${r.sheetCount > 1 ? 's' : ''}`),
      rows.length ? rows : h('div', { class: 'card' }, h('p', {}, visible.length === 0 && r.candidates.length ? 'No candidates left.' : 'Claude found no plausible piece in these groups.'),
        h('p', { class: 'muted small' }, 'Try other groups, a clearer spot photo, or a smarter model.')),
      groupSections,
      r.notes ? h('p', { class: 'muted small' }, 'Note: ' + r.notes) : null,
      usage ? h('p', { class: 'muted small' }, usage) : null,
      h('div', { id: 'status', class: 'status' }),
      r.model === 'claude-haiku-5-5'
        ? h('button', { type: 'button', class: 'btn btn-block', disabled: state.busy, onclick: () => runSearch('claude-sonnet-5-5') }, 'Search again with Sonnet 5.5')
        : null);
  }

  A.views.find = function () {
    return state.results ? renderResults() : renderFind();
  };
  A.find = { runSearch };
})();
