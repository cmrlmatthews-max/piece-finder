window.PF = window.PF || {};

// Pieces tab: list of groups, Add group (camera → detect → review → save), group detail (toggle placed, rename, re-photograph, delete).
(function () {
  'use strict';
  const A = PF.app;
  const { h, toast, setStatus } = A;
  const state = A.state;

  // Counts loose and placed pieces per group id.
  async function countPieces() {
    const counts = {};
    for (const p of await PF.db.all('pieces')) {
      const c = counts[p.groupId] || (counts[p.groupId] = { loose: 0, placed: 0 });
      c[p.status === 'placed' ? 'placed' : 'loose']++;
    }
    return counts;
  }

  // Draws a photo with thin boxes (and labels) on a new canvas. boxes: [{x,y,w,h,color,label}]
  function drawBoxes(photo, boxes) {
    const c = document.createElement('canvas');
    c.width = photo.width; c.height = photo.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(photo, 0, 0);
    const lw = Math.max(2, Math.round(photo.width * 0.003));
    ctx.font = `bold ${Math.round(photo.width * 0.022)}px -apple-system, Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'top';
    for (const b of boxes) {
      ctx.lineWidth = lw; ctx.strokeStyle = b.color; ctx.strokeRect(b.x, b.y, b.w, b.h);
      if (b.label) {
        const tw = ctx.measureText(b.label).width + 8, th = photo.width * 0.028;
        ctx.fillStyle = b.color; ctx.fillRect(b.x, b.y, tw, th);
        ctx.fillStyle = '#000'; ctx.fillText(b.label, b.x + 4, b.y + 2);
      }
    }
    return c;
  }

  // Converts a tap on a displayed canvas into canvas pixel coordinates.
  function tapPoint(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }
  function hit(boxes, pt) {
    let best = -1, bestArea = Infinity;
    boxes.forEach((b, i) => {
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h && b.w * b.h < bestArea) { best = i; bestArea = b.w * b.h; }
    });
    return best;
  }

  // Starts Add group / Re-photograph: take a photo, detect pieces, open the review screen.
  async function startCapture(replaceGroupId, name) {
    const file = await A.pickPhoto();
    if (!file) return;
    try {
      setStatus('Finding pieces…', true);
      const canvas = await A.loadPhoto(file, A.MAX_PHOTO);
      const det = PF.segment.detect(canvas, { thresholdScale: 1 });
      const groups = await PF.db.all('groups');
      state.review = { canvas, det, removed: new Set(), thresholdScale: 1, replaceGroupId: replaceGroupId || null,
        name: name || `Group ${groups.length + 1}` };
      state.tab = 'pieces';
      A.render();
    } catch (err) { toast(err.message, 'error'); setStatus(''); }
  }

  // Saves the reviewed detection as a group with its pieces.
  async function saveReview() {
    const r = state.review;
    const kept = r.det.pieces.filter((p, i) => !r.removed.has(i));
    if (!kept.length) { toast('No pieces to save', 'error'); return; }
    try {
      setStatus('Saving pieces…', true);
      const groupId = r.replaceGroupId || PF.img.uuid();
      const now = Date.now();
      const pieces = [];
      for (const p of kept) {
        const thumb = await PF.img.canvasToBlob(PF.img.crop(r.canvas, p.x, p.y, p.w, p.h, 320), 'image/jpeg', 0.85);
        pieces.push({ id: PF.img.uuid(), groupId, bbox: { x: p.x, y: p.y, w: p.w, h: p.h }, thumb, status: 'loose', createdAt: now, placedAt: null });
      }
      const photo = await PF.img.canvasToBlob(r.canvas, 'image/jpeg', 0.85);
      const thumb = await PF.img.canvasToBlob(PF.img.toCanvas(r.canvas, 300), 'image/jpeg', 0.8);
      if (r.replaceGroupId) await PF.db.deleteGroup(r.replaceGroupId);
      await PF.db.put('groups', { id: groupId, name: (r.name || 'Group').trim() || 'Group', createdAt: now, photo, w: r.canvas.width, h: r.canvas.height, thumb });
      await PF.db.bulkPut('pieces', pieces);
      state.review = null;
      state.groupDetailId = null;
      toast(`Saved ${pieces.length} pieces`, 'ok');
      A.render();
    } catch (err) { toast(err.message, 'error'); setStatus(''); }
  }

  // Review screen: photo with boxes, sensitivity slider, tap to remove a box, name, Retake / Save.
  function renderReview() {
    const r = state.review;
    const canvas = h('canvas', { class: 'fit' });
    const count = h('p', { class: 'status' });
    const boxesOf = () => r.det.pieces.map((p, i) => ({ x: p.x, y: p.y, w: p.w, h: p.h, label: String(i + 1),
      color: r.removed.has(i) ? '#ff5a5a' : (p.merged ? '#ff9f1c' : '#ffd400') }));
    const redraw = () => {
      const drawn = drawBoxes(r.canvas, boxesOf());
      canvas.width = drawn.width; canvas.height = drawn.height;
      canvas.getContext('2d').drawImage(drawn, 0, 0);
      const kept = r.det.pieces.length - r.removed.size;
      const merged = r.det.pieces.filter((p, i) => p.merged && !r.removed.has(i)).length;
      count.textContent = `${kept} pieces found` + (merged ? ` · ${merged} orange box${merged > 1 ? 'es' : ''} may be two pieces touching` : '');
    };
    canvas.addEventListener('click', (e) => {
      const i = hit(r.det.pieces, tapPoint(canvas, e));
      if (i < 0) return;
      if (r.removed.has(i)) r.removed.delete(i); else r.removed.add(i);
      redraw();
    });
    let timer = 0;
    const slider = h('input', { type: 'range', min: '0.5', max: '1.5', step: '0.05', value: String(r.thresholdScale), oninput: (e) => {
      r.thresholdScale = parseFloat(e.target.value);
      clearTimeout(timer);
      timer = setTimeout(() => { r.det = PF.segment.detect(r.canvas, { thresholdScale: r.thresholdScale }); r.removed = new Set(); redraw(); }, 150);
    } });
    const name = h('input', { type: 'text', value: r.name, placeholder: 'Group name', onchange: (e) => { r.name = e.target.value; } });
    redraw();
    return h('div', {},
      h('h1', {}, r.replaceGroupId ? 'Re-photograph group' : 'New group'),
      h('div', { class: 'card' }, canvas, count,
        h('p', { class: 'muted small' }, 'Tap a box to remove it (red = removed). Orange may be two pieces touching: retake if so.'),
        h('label', { class: 'field' }, h('span', {}, 'Sensitivity'), slider),
        h('label', { class: 'field' }, h('span', {}, 'Group name'), name),
        h('div', { id: 'status', class: 'status' }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: () => startCapture(r.replaceGroupId, r.name) }, 'Retake'),
          h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { state.review = null; A.render(); } }, 'Cancel'),
          h('button', { type: 'button', class: 'btn btn-primary', style: { flex: '1' }, onclick: saveReview }, 'Save group'))));
  }

  // Group detail: photo with placed marks, tap a piece to toggle loose/placed, rename, re-photograph, delete.
  async function renderDetail() {
    const group = await PF.db.get('groups', state.groupDetailId);
    if (!group) { state.groupDetailId = null; return renderList(); }
    const pieces = await PF.db.byIndex('pieces', 'groupId', group.id);
    const photo = await PF.img.blobToCanvas(group.photo);
    const marked = PF.sheet.drawMarks(photo, pieces.filter((p) => p.status === 'placed').map((p) => ({ bbox: p.bbox, label: '', kind: 'placed' })));
    const drawn = drawBoxes(marked, pieces.filter((p) => p.status !== 'placed').map((p) => ({ ...p.bbox, color: 'rgba(255,212,0,0.8)' })));
    const canvas = h('canvas', { class: 'fit', width: drawn.width, height: drawn.height });
    canvas.getContext('2d').drawImage(drawn, 0, 0);
    canvas.addEventListener('click', async (e) => {
      const i = hit(pieces.map((p) => p.bbox), tapPoint(canvas, e));
      if (i < 0) return;
      const p = pieces[i];
      p.status = p.status === 'placed' ? 'loose' : 'placed';
      p.placedAt = p.status === 'placed' ? Date.now() : null;
      await PF.db.put('pieces', p);
      toast(p.status === 'placed' ? 'Marked placed' : 'Back to loose', 'ok');
      A.render();
    });
    const loose = pieces.filter((p) => p.status !== 'placed').length;
    return h('div', {},
      h('button', { type: 'button', class: 'link', onclick: () => { state.groupDetailId = null; A.render(); } }, '← All groups'),
      h('label', { class: 'field' }, h('span', {}, 'Group name'),
        h('input', { type: 'text', value: group.name, onchange: async (e) => { group.name = e.target.value.trim() || group.name; await PF.db.put('groups', group); toast('Renamed', 'ok'); } })),
      h('div', { class: 'card' }, canvas,
        h('p', { class: 'status' }, `${loose} loose · ${pieces.length - loose} placed`),
        h('p', { class: 'muted small' }, 'Tap a piece to mark it placed, or tap a placed piece to bring it back.'),
        h('div', { id: 'status', class: 'status' }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: () => {
            if (window.confirm('Replace the photo and all pieces of this group? Placed marks are lost.')) startCapture(group.id, group.name); } }, 'Re-photograph'),
          h('button', { type: 'button', class: 'btn btn-danger', onclick: async () => {
            if (!A.confirm2(`Delete group "${group.name}" and its ${pieces.length} pieces?`)) return;
            await PF.db.deleteGroup(group.id); state.groupDetailId = null; toast('Group deleted', 'ok'); A.render(); } }, 'Delete group'))));
  }

  // Group list with Add group.
  async function renderList() {
    const groups = (await PF.db.all('groups')).sort((a, b) => a.createdAt - b.createdAt);
    const counts = await countPieces();
    const totalLoose = Object.values(counts).reduce((s, c) => s + c.loose, 0);
    return h('div', {},
      h('h1', {}, 'Pieces'),
      h('p', { class: 'muted' }, groups.length ? `${totalLoose} loose pieces in ${groups.length} group${groups.length > 1 ? 's' : ''}` : 'No groups yet. Sort loose pieces into small groups, then photograph each group.'),
      h('div', { class: 'card' },
        h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => startCapture(null, null) }, 'Add group'),
        h('div', { id: 'status', class: 'status' })),
      h('div', { class: 'list' }, groups.map((g) => {
        const c = counts[g.id] || { loose: 0, placed: 0 };
        return h('div', { class: 'item clickable', role: 'button', onclick: () => { state.groupDetailId = g.id; A.render(); } },
          h('img', { class: 'thumb thumb-sm', src: A.blobUrl(g.thumb), alt: '' }),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, g.name), h('div', { class: 'muted small' }, `${c.loose} loose · ${c.placed} placed`)),
          h('span', { class: 'muted' }, '›'));
      })));
  }

  A.views.pieces = function () {
    if (state.review) return renderReview();
    if (state.groupDetailId) return renderDetail();
    return renderList();
  };
  A.pieces = { startCapture, countPieces, drawBoxes };
})();
