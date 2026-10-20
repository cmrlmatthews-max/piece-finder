window.PF = window.PF || {};

// Find tab: traced spot photo + ringed poster spot + groups → contact sheets (singles + clusters) → Claude → ranked results.
(function () {
  'use strict';
  const A = PF.app;
  const { h, toast, setStatus } = A;
  const state = A.state;
  const MAX_PIECES = 144;          // singles cap: 4 sheets of 36
  const MAX_CLUSTERS = 18;         // clusters cap: 2 sheets of 9

  // Loads the loose pieces of the selected groups, each with its group attached. Returns { singles, clusters, truncated }.
  async function gatherPieces(groups) {
    const sel = state.selectedGroupIds;
    let all = [];
    for (const g of groups) {
      if (sel && !sel.has(g.id)) continue;
      const list = (await PF.db.byIndex('pieces', 'groupId', g.id)).filter((p) => p.status !== 'placed');
      list.sort((a, b) => a.createdAt - b.createdAt);
      all = all.concat(list.map((p) => ({ piece: p, group: g })));
    }
    const singles = all.filter((x) => x.piece.kind !== 'cluster');
    const clusters = all.filter((x) => x.piece.kind === 'cluster');
    const truncated = singles.length > MAX_PIECES || clusters.length > MAX_CLUSTERS;
    return { singles: singles.slice(0, MAX_PIECES), clusters: clusters.slice(0, MAX_CLUSTERS), truncated };
  }

  async function toEntries(list, withCaption) {
    const out = [];
    for (const { piece } of list) {
      const e = { id: piece.id, canvas: await PF.img.blobToCanvas(piece.thumb) };
      if (withCaption) e.caption = `~${piece.count || 2} pieces joined`;
      out.push(e);
    }
    return out;
  }

  // Runs one search. modelOverride lets "Search again with …" reuse the same inputs.
  async function runSearch(modelOverride) {
    if (state.busy) return;
    const s = PF.settings.get();
    const model = modelOverride || s.model;
    state.busy = true;
    try {
      const groups = (await PF.db.all('groups')).sort((a, b) => a.createdAt - b.createdAt);
      const { singles, clusters, truncated } = await gatherPieces(groups);
      const total = singles.length + clusters.length;
      if (!total) throw new Error('No loose pieces in the selected groups.');
      if (truncated) toast(`Searching the first ${MAX_PIECES} pieces — pick fewer groups for better results`);
      setStatus(`Building contact sheets for ${total} items…`, true);
      const singleSheets = singles.length ? PF.sheet.build(await toEntries(singles, false), { cols: 6, rows: 6, cell: 316, startNumber: 1 }) : [];
      const clusterSheets = clusters.length ? PF.sheet.build(await toEntries(clusters, true), { cols: 3, rows: 3, cell: 632, startNumber: singles.length + 1 }) : [];
      const toBlobs = async (sheets) => { const out = []; for (const sh of sheets) out.push(await PF.img.canvasToBlob(sh.canvas, 'image/jpeg', 0.85)); return out; };
      const sheetBlobs = await toBlobs(singleSheets);
      const clusterSheetBlobs = await toBlobs(clusterSheets);
      const n = singleSheets.length + clusterSheets.length;
      setStatus(`Asking Claude (${total} items on ${n} sheet${n > 1 ? 's' : ''})…`, true);
      const res = await PF.api.rankPieces({ apiKey: s.apiKey, model, topN: s.topN || 8,
        holeFullBlob: state.hole ? state.hole.fullBlob : null, holeCropBlob: state.hole ? state.hole.cropBlob : null,
        sides: state.hole ? state.hole.sides : null,
        posterBlob: state.spot ? state.spot.cropBlob : null,
        sheetBlobs, clusterSheetBlobs, candidateCount: total });
      const byNumber = {};
      singleSheets.concat(clusterSheets).forEach((sh) => sh.entries.forEach((e) => { byNumber[e.number] = e.id; }));
      const byId = {};
      singles.concat(clusters).forEach((x) => { byId[x.piece.id] = x; });
      const candidates = res.candidates.map((c) => byId[byNumber[c.number]] ? { ...byId[byNumber[c.number]], confidence: c.confidence, reason: c.reason } : null)
        .filter(Boolean).map((c, i) => ({ ...c, rank: i + 1, hidden: false }));
      state.results = { model, candidates, spot: res.spot || '', notes: res.notes, usage: res.usage, pieceCount: total, sheetCount: n };
      setStatus('');
      A.render();
    } catch (err) {
      toast(err.message, 'error');
      setStatus('');
    } finally {
      state.busy = false;
    }
  }

  // Opens the tracing picker on a spot photo; stores the marked results in state.hole.
  async function traceSpot(canvas, initial) {
    const r = await PF.picker.open({ canvas, mode: 'trace', title: 'Trace the open spot', zoom: 1, initial });
    if (!r) { if (!state.hole) toast('Trace the open spot to use the photo'); return; }
    state.hole = { canvas, polygon: r.polygon, seed: r.seed, tol: r.tol, snapped: r.snapped, sides: r.sides,
      fullBlob: await PF.img.canvasToBlob(r.fullCanvas, 'image/jpeg', 0.85),
      cropBlob: await PF.img.canvasToBlob(r.cropCanvas, 'image/jpeg', 0.9) };
    A.render();
  }
  function sidesSummary(sides) {
    if (!sides) return '';
    const names = (v) => ['top', 'right', 'bottom', 'left'].filter((s) => sides[s] === v).join(', ') || 'none';
    return `Neighbors: ${names('pieces')} · Open: ${names('open')}`;
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

    // 1. spot photo, traced
    const takeHole = async () => {
      const file = await A.pickPhoto();
      if (!file) return;
      try {
        setStatus('Preparing the photo…', true);
        const canvas = await A.loadPhoto(file, A.MAX_PHOTO);
        setStatus('');
        await traceSpot(canvas, null);
      } catch (err) { toast(err.message, 'error'); setStatus(''); }
    };
    const holeCard = h('div', { class: 'card' },
      h('h2', {}, h('span', { class: 'step' + (state.hole ? ' done' : '') }, '1'), 'Open spot photo'),
      state.hole
        ? [h('img', { class: 'preview', src: A.blobUrl(state.hole.cropBlob), alt: 'Marked open spot' }),
           h('p', { class: 'muted small', style: { marginTop: '6px' } }, (state.hole.snapped ? 'Edge snapped. ' : 'Your loop as drawn. ') + sidesSummary(state.hole.sides)),
           h('div', { class: 'row', style: { marginTop: '8px' } },
             h('button', { type: 'button', class: 'btn btn-sm', onclick: () => traceSpot(state.hole.canvas,
               { polygon: state.hole.polygon, seed: state.hole.seed, tol: state.hole.tol, snapped: state.hole.snapped, sides: state.hole.sides }) }, 'Trace again'),
             h('button', { type: 'button', class: 'btn btn-sm', onclick: takeHole }, 'Retake'),
             h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { state.hole = null; A.render(); } }, 'Remove'))]
        : [h('p', { class: 'muted small' }, 'From above, with the neighbors in the frame; the table or mat must show through the hole. Then draw a loose loop around the open spot and the app finds its exact edge.'),
           h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: takeHole }, 'Take photo of the spot')]);

    // 2. spot on the poster, ringed
    const pickSpot = async () => {
      try {
        const posterCanvas = await PF.img.blobToCanvas(poster.blob);
        const grid = s.gridCols > 0 && s.gridRows > 0 ? { cols: s.gridCols, rows: s.gridRows } : null;
        const r = await PF.picker.open({ canvas: posterCanvas, mode: 'point', title: 'Put the ring on the spot', zoom: 4, grid,
          ringFrac: state.spot ? state.spot.ringFrac : 0.025, initial: state.spot ? { cx: state.spot.cx, cy: state.spot.cy } : null });
        if (!r) return;
        state.spot = { cx: r.cx, cy: r.cy, ringFrac: r.ringFrac, cropBlob: await PF.img.canvasToBlob(r.cropCanvas, 'image/jpeg', 0.9) };
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
    if (!state.hole && !state.spot) reasons.push('add a traced spot photo or pick the spot on the poster');
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
        toast('Placed. It is out of the pool now.', 'ok');
        setTimeout(() => A.render(), 260);
      };
      row.append(
        h('span', { class: 'rank' }, String(c.rank)),
        h('img', { class: 'thumb', src: A.blobUrl(c.piece.thumb), alt: '' }),
        h('div', { class: 'grow' },
          h('div', { class: 'row' }, h('span', { class: 'title' }, c.group.name), h('span', { class: 'pill ' + c.confidence }, c.confidence),
            c.piece.kind === 'cluster' ? h('span', { class: 'pill cluster' }, `cluster ~${c.piece.count || 2}`) : null),
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
    const nextModel = r.model === 'claude-haiku-5-5' ? 'claude-sonnet-5-5' : (r.model === 'claude-sonnet-5-5' ? 'claude-opus-5-5' : null);
    const nextLabel = nextModel ? (PF.api.MODELS.find((m) => m.id === nextModel) || {}).label : '';
    return h('div', {},
      h('button', { type: 'button', class: 'link', onclick: () => { state.results = null; A.render(); } }, '← New search'),
      h('h1', {}, 'Top candidates'),
      h('p', { class: 'muted small' }, `${modelLabel} · ${r.pieceCount} items on ${r.sheetCount} sheet${r.sheetCount > 1 ? 's' : ''}`),
      r.spot ? h('div', { class: 'card' }, h('h2', {}, 'What Claude saw at the spot'), h('p', { class: 'small' }, r.spot),
        h('p', { class: 'muted small' }, 'If this is wrong, trace the spot again or retake the photo closer.')) : null,
      rows.length ? rows : h('div', { class: 'card' }, h('p', {}, visible.length === 0 && r.candidates.length ? 'No candidates left.' : 'Claude found no plausible piece in these groups.'),
        h('p', { class: 'muted small' }, 'Try other groups, a clearer spot photo, or a smarter model.')),
      groupSections,
      r.notes ? h('p', { class: 'muted small' }, 'Note: ' + r.notes) : null,
      usage ? h('p', { class: 'muted small' }, usage) : null,
      h('div', { id: 'status', class: 'status' }),
      nextModel ? h('button', { type: 'button', class: 'btn btn-block', disabled: state.busy, onclick: () => runSearch(nextModel) }, 'Search again with ' + nextLabel.split(' — ')[0]) : null);
  }

  A.views.find = function () {
    return state.results ? renderResults() : renderFind();
  };
  A.find = { runSearch };
})();
