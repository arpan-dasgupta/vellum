/* Vellum editor. Depends on core.js (window.VellumCore). */
(() => {
  'use strict';
  const C = window.VellumCore;
  const $ = (s) => document.querySelector(s);
  const esc = C.esc;
  const STORE_KEY = 'vellum:doc:v1';
  const THEME_KEY = 'vellum:theme';
  const CONFIG_URL = 'vellum.config.json';  // names the document to open first (startDocument)
  const RESIZABLE = new Set(['RECT', 'ELLIPSE', 'PATH', 'SECTION', 'TEXT', 'STICKY', 'IMAGE']);
  const TYPE_LABEL = { RECT: 'Rectangle', ELLIPSE: 'Ellipse', TEXT: 'Text', PATH: 'Vector', GROUP: 'Group', SECTION: 'Section', CONNECTOR: 'Connector', INK: 'Drawing', STICKY: 'Note', IMAGE: 'Image' };
  const ANN_COLORS = [
    { name: 'Red', v: '#E8503A', note: '#FFCDC2' },
    { name: 'Orange', v: '#F59E0B', note: '#FFE0C2' },
    { name: 'Yellow', v: '#EAB308', note: '#FFECBD' },
    { name: 'Green', v: '#2EA043', note: '#CDF4D3' },
    { name: 'Blue', v: '#2F6FEB', note: '#C2E5FF' },
  ];
  const COLOR_KEY = 'vellum:ann-color';
  const RESOLVED_KEY = 'vellum:show-resolved';

  /* ---------------- state ---------------- */
  const S = {
    doc: null, pageId: null, index: null,
    sel: [], ctxId: null, tool: 'move',
    view: { x: 0, y: 0, z: 1 }, views: {},
    hover: null, expanded: new Set(), editing: null,
    past: [], future: [], clipboard: null, pasteCount: 0,
    spaceDown: false, drag: null, annColor: ANN_COLORS[0].v,
  };
  try { const c = localStorage.getItem(COLOR_KEY); if (c && ANN_COLORS.some((x) => x.v === c)) S.annColor = c; } catch (e) { /* convenience only */ }
  S.showResolved = false;
  try { S.showResolved = localStorage.getItem(RESOLVED_KEY) === '1'; } catch (e) { /* convenience only */ }
  const isResolved = (n) => n && n.status === 'resolved';
  const hiddenResolved = (n) => isResolved(n) && !S.showResolved;
  const isAnnGroup = (n) => !!(n && n.type === 'GROUP' && n.annotation);

  const svg = $('#canvas');
  const content = $('#content');
  const overlay = $('#overlay');
  const world = $('#world');
  const editor = $('#textEditor');

  /* ---------------- measuring ---------------- */
  const mctx = document.createElement('canvas').getContext('2d');
  const mcache = new Map();
  function measure(t, font) {
    const k = font + '\u0000' + t;
    let v = mcache.get(k);
    if (v === undefined) {
      mctx.font = font;
      v = mctx.measureText(t).width;
      if (mcache.size > 30000) mcache.clear();
      mcache.set(k, v);
    }
    return v;
  }
  const ctx = () => ({ index: S.index, measure });

  /* ---------------- document helpers ---------------- */
  const page = () => S.doc.pages.find((p) => p.id === S.pageId) || S.doc.pages[0];
  const node = (id) => S.index.map.get(id);
  const parentOf = (id) => S.index.parent.get(id);
  const isPage = (n) => n && !n.type;
  const bnds = (n) => C.bounds(n, ctx());
  const reindex = () => { S.index = C.buildIndex(S.doc); };

  function chainTo(id) {
    const chain = [];
    let n = node(id);
    while (n && !isPage(n)) { chain.unshift(n); n = parentOf(n.id); }
    return chain;
  }
  function pageIdOf(id) {
    let n = node(id);
    while (n && !isPage(n)) n = parentOf(n.id);
    return n ? n.id : null;
  }
  const selNodes = () => S.sel.map(node).filter(Boolean);
  function topLevelSel() {
    const set = new Set(S.sel);
    return selNodes().filter((n) => !chainTo(n.id).slice(0, -1).some((a) => set.has(a.id)));
  }
  function unionOf(nodes) { return C.union(nodes.map(bnds)); }
  function nextName(base) {
    let max = 0;
    const re = new RegExp('^' + base + ' (\\d+)$');
    C.walk(page().children, (n) => { const m = re.exec(n.name || ''); if (m) max = Math.max(max, +m[1]); });
    return `${base} ${max + 1}`;
  }
  function blankDoc() {
    return { version: 1, name: 'Untitled', pages: [{ id: C.newId(), name: 'Page 1', children: [] }] };
  }
  function validDoc(d) {
    return d && Array.isArray(d.pages) && d.pages.length && d.pages.every((p) => p.id && Array.isArray(p.children));
  }

  /* ---------------- history + persistence ---------------- */
  const snapshot = () => JSON.stringify({ doc: S.doc, pageId: S.pageId, sel: S.sel });
  function pushHistory() {
    S.past.push(snapshot());
    if (S.past.length > 80) S.past.shift();
    S.future = [];
  }
  function mutate(fn) {
    pushHistory();
    fn();
    afterChange();
  }
  function restore(snap) {
    const s = JSON.parse(snap);
    S.doc = s.doc;
    S.pageId = s.pageId;
    S.sel = s.sel || [];
    afterChange();
  }
  function undo() {
    if (!S.past.length) return;
    S.future.push(snapshot());
    restore(S.past.pop());
  }
  function redo() {
    if (!S.future.length) return;
    S.past.push(snapshot());
    restore(S.future.pop());
  }
  function afterChange() {
    reindex();
    if (!S.doc.pages.some((p) => p.id === S.pageId)) S.pageId = S.doc.pages[0].id;
    S.sel = S.sel.filter((id) => node(id) && pageIdOf(id) === S.pageId);
    if (S.ctxId && !node(S.ctxId)) S.ctxId = null;
    renderAll();
    scheduleSave();
    schedulePush();
  }
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(S.doc)); } catch (e) { /* storage unavailable: autosave is a convenience */ }
    }, 500);
  }

  /* ---------------- rendering ---------------- */
  function renderContent() {
    content.innerHTML = C.renderList(page().children, ctx(), { resolved: S.showResolved ? 'fade' : 'hide' });
    if (S.editing) {
      const el = content.querySelector(`[data-id="${CSS.escape(S.editing)}"]`);
      if (el) el.style.visibility = 'hidden';
    }
  }

  function applyView() {
    const v = S.view;
    world.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.z})`);
    $('#zoomLabel').textContent = Math.round(v.z * 100) + '%';
    S.views[S.pageId] = { ...v };
    renderOverlay();
    positionEditor();
  }

  function renderAll() {
    renderContent();
    renderOverlay();
    renderLayers();
    renderPages();
    renderProps();
    renderChrome();
  }

  function walkSections(list, fn) {
    for (const n of list) {
      if (n.visible === false) continue;
      if (n.type === 'SECTION') fn(n);
      if (n.children) walkSections(n.children, fn);
    }
  }

  function renderOverlay() {
    const z = S.view.z;
    const px = 1 / z;
    const d = S.drag;
    let s = '';
    const box = (b, cls, extra = '') => `<rect class="${cls}" x="${b.x}" y="${b.y}" width="${Math.max(b.w, 0)}" height="${Math.max(b.h, 0)}" vector-effect="non-scaling-stroke"${extra}/>`;

    walkSections(page().children, (sec) => {
      const on = S.sel.includes(sec.id) || S.hover === sec.id;
      let label = sec.name || 'Section';
      const room = Math.floor((sec.w * z) / 6.8);
      if (room < 4) return;
      if (label.length > room) label = label.slice(0, Math.max(1, room - 1)) + '…';
      s += `<text class="sec-label${on ? ' on' : ''}" data-sec="${esc(sec.id)}" x="${sec.x}" y="${sec.y - 7 * px}" font-size="${12 * px}">${esc(label)}</text>`;
    });

    // Reply counts and resolved ticks on annotations.
    for (const n of annNodes()) {
      if (hiddenResolved(n) || n.visible === false) continue;
      const replies = (n.replies || []).length;
      if (!replies && !isResolved(n)) continue;
      const b = bnds(n);
      if (!b) continue;
      const r = 9 * px, cx = b.x + b.w, cy = b.y;
      s += `<circle class="badge-dot${isResolved(n) ? ' ok' : ''}" cx="${cx}" cy="${cy}" r="${r}" stroke-width="${2 * px}"/>`;
      s += isResolved(n)
        ? `<path d="M${cx - 4 * px},${cy} l${3 * px},${3 * px} l${5 * px},${-6 * px}" fill="none" stroke="#FFFFFF" stroke-width="${2 * px}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<text class="badge-num" x="${cx}" y="${cy + 3.8 * px}" font-size="${11 * px}" text-anchor="middle">${replies}</text>`;
    }

    if (S.hover && !S.sel.includes(S.hover) && node(S.hover) && !(d && d.kind === 'move')) {
      const b = bnds(node(S.hover));
      if (b) s += box(b, 'hover-box', ' stroke-width="1.5"');
    }

    const sel = selNodes();
    if (sel.length && !S.editing) {
      const off = d && d.kind === 'move' && d.moved ? { x: d.dx, y: d.dy } : { x: 0, y: 0 };
      const shift = (b) => ({ x: b.x + off.x, y: b.y + off.y, w: b.w, h: b.h });
      for (const n of sel) {
        const b = bnds(n);
        if (b) s += box(shift(b), 'sel-box', ' stroke-width="1"');
      }
      const u = unionOf(sel);
      if (u) {
        const ub = shift(u);
        if (sel.length > 1) s += box(ub, 'sel-box', ' stroke-width="1"');
        if (sel.length === 1 && RESIZABLE.has(sel[0].type) && !sel[0].locked) {
          const hs = 8 * px;
          const hx = { w: ub.x, c: ub.x + ub.w / 2, e: ub.x + ub.w };
          const hy = { n: ub.y, m: ub.y + ub.h / 2, s: ub.y + ub.h };
          const handles = sel[0].type === 'TEXT'
            ? [['w', hx.w, hy.m], ['e', hx.e, hy.m]]
            : [['nw', hx.w, hy.n], ['n', hx.c, hy.n], ['ne', hx.e, hy.n], ['e', hx.e, hy.m], ['se', hx.e, hy.s], ['s', hx.c, hy.s], ['sw', hx.w, hy.s], ['w', hx.w, hy.m]];
          for (const [k, x, y] of handles) {
            s += `<rect class="handle" data-handle="${k}" x="${x - hs / 2}" y="${y - hs / 2}" width="${hs}" height="${hs}" rx="${1.5 * px}" vector-effect="non-scaling-stroke" stroke-width="1"/>`;
          }
        }
        const label = `${round(ub.w)} × ${round(ub.h)}`;
        const fs = 11 * px;
        const lw = (label.length * 6.7 + 12) * px;
        const bx = ub.x + ub.w / 2 - lw / 2;
        const by = ub.y + ub.h + 8 * px;
        s += `<rect class="badge-bg" x="${bx}" y="${by}" width="${lw}" height="${18 * px}" rx="${4 * px}"/>`;
        s += `<text class="badge" x="${ub.x + ub.w / 2}" y="${by + 12.5 * px}" font-size="${fs}" text-anchor="middle">${label}</text>`;
      }
    }

    if (d && (d.kind === 'marquee' || d.kind === 'create')) {
      const b = rectFrom(d.p0, d.p1);
      if (d.kind === 'marquee') s += box(b, 'marquee', ' stroke-width="1"');
      else if (d.type === 'ELLIPSE') s += `<ellipse class="preview" cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" vector-effect="non-scaling-stroke" stroke-width="1"/>`;
      else s += box(b, 'preview', ' stroke-width="1"');
    }
    if (d && d.kind === 'ink' && d.pts.length) {
      const tmp = { type: 'INK', points: d.pts, stroke: d.color, strokeWidth: 5 };
      s += C.renderNode(tmp, ctx(), { forExport: true });
    }
    if (d && d.kind === 'hl' && d.moved) {
      const hb = rectFrom(d.p0, d.p1);
      s += C.renderNode({ type: 'RECT', ...hb, fill: S.annColor, fillOpacity: 0.3, radius: 4 }, ctx(), { forExport: true });
    }
    if (d && d.kind === 'annArrow' && d.moved) {
      const tmp = { type: 'CONNECTOR', from: { x: d.p0.x, y: d.p0.y }, to: { x: d.p1.x, y: d.p1.y }, stroke: S.annColor, strokeWidth: 9, headSize: 26, opacity: 0.85, arrow: true };
      s += C.renderNode(tmp, ctx(), { forExport: true });
    }
    if (d && d.kind === 'connect') {
      const from = node(d.from);
      const fb = from && bnds(from);
      if (fb) {
        const c = C.center(fb);
        s += box(fb, 'hover-box', ' stroke-width="1.5"');
        if (d.over && node(d.over)) s += box(bnds(node(d.over)), 'hover-box', ' stroke-width="1.5"');
        s += `<line class="link" x1="${c.x}" y1="${c.y}" x2="${d.p1.x}" y2="${d.p1.y}" vector-effect="non-scaling-stroke" stroke-width="2" stroke-dasharray="6 4"/>`;
      }
    }
    overlay.innerHTML = s;
  }

  const round = (v) => Math.round(v * 100) / 100;
  function rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

  /* ---------------- selection ---------------- */
  function setSel(ids, opts = {}) {
    S.sel = [...new Set(ids)];
    if (opts.reveal !== false) {
      for (const id of S.sel) for (const a of chainTo(id).slice(0, -1)) S.expanded.add(a.id);
    }
    renderOverlay();
    renderLayers();
    renderProps();
    if (opts.reveal !== false && S.sel.length) {
      const row = document.querySelector(`#layers .row[data-id="${CSS.escape(S.sel[0])}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function resolve(leafId, deep) {
    const chain = chainTo(leafId);
    if (!chain.length || chain.some((n) => n.locked)) return null;
    if (deep) {
      const leaf = chain[chain.length - 1];
      return leaf.type === 'SECTION' ? null : leaf;
    }
    let start = 0;
    if (S.ctxId) {
      const i = chain.findIndex((n) => n.id === S.ctxId);
      if (i >= 0) start = i + 1;
    }
    for (let i = start; i < chain.length; i++) {
      if (chain[i].type === 'SECTION' || isAnnGroup(chain[i])) continue;
      return chain[i];
    }
    return null;
  }
  function innermostSection(leafId) {
    const chain = chainTo(leafId);
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i].type === 'SECTION') return chain[i];
    return null;
  }
  function hitLeaf(e) {
    const el = e.target && e.target.closest ? e.target.closest('#content [data-id]') : null;
    return el ? el.getAttribute('data-id') : null;
  }
  // Pointer capture retargets later events to the <svg>, so look up what is under the pointer.
  function leafAt(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const el = hit && hit.closest ? hit.closest('#content [data-id]') : null;
    return el ? el.getAttribute('data-id') : null;
  }
  function setCtx(id) {
    S.ctxId = id;
    renderChrome();
  }
  function ctxForNode(id) {
    const chain = chainTo(id).slice(0, -1).filter((n) => n.type === 'GROUP' && !n.annotation);
    return chain.length ? chain[chain.length - 1].id : null;
  }

  /* ---------------- pointer interaction ---------------- */
  function toWorld(e) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - S.view.x) / S.view.z, y: (e.clientY - r.top - S.view.y) / S.view.z };
  }

  // Two-finger pinch zooms and pans on touch screens.
  const pointers = new Map();
  function pinchState() {
    const [a, b] = [...pointers.values()];
    const r = svg.getBoundingClientRect();
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top } };
  }
  svg.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const st = pinchState();
      S.drag = { kind: 'pinch', d0: st.dist, m0: st.mid, z0: S.view.z, vx: S.view.x, vy: S.view.y };
      renderOverlay();
      return;
    }
    if (pointers.size > 2) return;
    closeMenus();
    if (e.button === 1 || (e.button === 0 && (S.spaceDown || S.tool === 'hand'))) {
      S.drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, vx: S.view.x, vy: S.view.y };
      svg.classList.add('grabbing');
      svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      if (S.editing) commitEdit();
      svg.setPointerCapture(e.pointerId);
      startAnnArrow(toWorld(e), true, e.altKey);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (S.editing) commitEdit();
    // Detect double-clicks from two quick presses: re-rendering between clicks stops the browser's dblclick.
    const now = performance.now();
    const last = S.lastDown;
    const isDouble = last && now - last.t < 450 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 6;
    S.lastDown = isDouble ? null : { t: now, x: e.clientX, y: e.clientY };
    if (isDouble && S.tool === 'move' && !e.target.getAttribute('data-handle')) {
      const dl = hitLeaf(e);
      if (dl && onDouble(dl)) { e.preventDefault(); return; }
    }
    svg.setPointerCapture(e.pointerId);
    const p = toWorld(e);
    const handle = e.target.getAttribute && e.target.getAttribute('data-handle');
    if (handle) { startResize(handle, p); return; }
    const secId = e.target.getAttribute && e.target.getAttribute('data-sec');
    if (secId && S.tool === 'move') {
      setCtx(null);
      if (e.shiftKey) toggleSel(secId); else if (!S.sel.includes(secId)) setSel([secId]);
      S.drag = { kind: 'move', p0: p, moved: false, ids: topLevelSel().map((n) => n.id) };
      return;
    }
    if (S.tool === 'rect' || S.tool === 'ellipse') {
      S.drag = { kind: 'create', type: S.tool === 'rect' ? 'RECT' : 'ELLIPSE', p0: p, p1: p, shift: false };
      return;
    }
    if (S.tool === 'text') { e.preventDefault(); createText(p); return; }
    if (S.tool === 'pen') { S.drag = { kind: 'ink', pts: [[p.x, p.y]], color: S.annColor }; return; }
    if (S.tool === 'arrow') { startAnnArrow(p, false, e.altKey); return; }
    if (S.tool === 'mark') { S.drag = { kind: 'hl', p0: p, p1: p, moved: false }; return; }
    if (S.tool === 'note') { e.preventDefault(); createNote(p); return; }
    const leaf = hitLeaf(e);
    if (S.tool === 'connector') {
      const t = leaf && resolve(leaf, e.metaKey || e.ctrlKey);
      if (t && t.type !== 'CONNECTOR') S.drag = { kind: 'connect', from: t.id, p0: p, p1: p, over: null };
      else toast('Start the connector on a layer, then drag to another one.');
      return;
    }
    if (S.ctxId && (!leaf || !chainTo(leaf).some((n) => n.id === S.ctxId))) setCtx(null);
    const target = leaf ? resolve(leaf, e.metaKey || e.ctrlKey) : null;
    if (target) {
      let clickSelect = null;
      if (e.shiftKey) {
        toggleSel(target.id);
        if (!S.sel.includes(target.id)) return;
      } else if (!S.sel.includes(target.id)) {
        setSel([target.id]);
      } else if (S.sel.length > 1) {
        clickSelect = target.id;
      }
      S.drag = { kind: 'move', p0: p, moved: false, ids: topLevelSel().map((n) => n.id), clickSelect };
    } else {
      if (!e.shiftKey && S.sel.length) setSel([]);
      S.drag = { kind: 'marquee', p0: p, p1: p, scope: leaf ? innermostSection(leaf) : null, base: e.shiftKey ? S.sel.slice() : [] };
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (S.drag) return;
    const leaf = hitLeaf(e);
    const secId = e.target.getAttribute && e.target.getAttribute('data-sec');
    const t = secId || (leaf && S.tool !== 'hand' ? (resolve(leaf, e.metaKey || e.ctrlKey) || {}).id : null) || null;
    if (t !== S.hover) { S.hover = t; renderOverlay(); }
  });
  svg.addEventListener('pointerleave', () => { if (!S.drag && S.hover) { S.hover = null; renderOverlay(); } });
  svg.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = S.drag;
    if (!d) return;
    const p = toWorld(e);
    switch (d.kind) {
      case 'pinch': {
        if (pointers.size < 2) break;
        const st = pinchState();
        const z = Math.min(64, Math.max(0.02, d.z0 * (st.dist / d.d0)));
        const wx = (d.m0.x - d.vx) / d.z0, wy = (d.m0.y - d.vy) / d.z0;
        S.view = { z, x: st.mid.x - wx * z, y: st.mid.y - wy * z };
        applyView();
        break;
      }
      case 'pan':
        S.view.x = d.vx + (e.clientX - d.cx);
        S.view.y = d.vy + (e.clientY - d.cy);
        applyView();
        break;
      case 'move': {
        let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
        if (!d.moved && Math.hypot(dx, dy) * S.view.z < 3) return;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        if (!d.moved) {
          d.moved = true;
          d.els = d.ids.map((id) => content.querySelector(`[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
        }
        d.dx = dx; d.dy = dy;
        for (const el of d.els) el.setAttribute('transform', `translate(${dx} ${dy})`);
        renderOverlay();
        break;
      }
      case 'resize':
        doResize(d, p, e.shiftKey);
        break;
      case 'marquee': {
        d.p1 = p;
        const r = rectFrom(d.p0, d.p1);
        S.sel = [...new Set([...d.base, ...marqueeHits(r, d.scope).map((n) => n.id)])];
        renderOverlay();
        break;
      }
      case 'create':
        d.p1 = e.shiftKey ? squareFrom(d.p0, p) : p;
        renderOverlay();
        break;
      case 'ink': {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(p.x - last[0], p.y - last[1]) * S.view.z >= 2) { d.pts.push([p.x, p.y]); renderOverlay(); }
        break;
      }
      case 'annArrow': {
        if (Math.hypot(p.x - d.raw.x, p.y - d.raw.y) * S.view.z > 5) d.moved = true;
        const e1 = arrowEnd(p, d.free || e.altKey);
        d.to = e1.ep;
        d.p1 = e1.p;
        d.toId = e1.snapped;
        renderOverlay();
        break;
      }
      case 'hl':
        d.p1 = p;
        if (Math.hypot(p.x - d.p0.x, p.y - d.p0.y) * S.view.z > 4) d.moved = true;
        renderOverlay();
        break;
      case 'connect': {
        d.p1 = p;
        const leaf = leafAt(e);
        const t = leaf && resolve(leaf, e.metaKey || e.ctrlKey);
        d.over = t && t.id !== d.from && t.type !== 'CONNECTOR' ? t.id : null;
        renderOverlay();
        break;
      }
    }
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (S.drag && S.drag.kind === 'pinch') { if (!pointers.size) S.drag = null; return; }
  };
  window.addEventListener('pointercancel', endPointer);
  window.addEventListener('pointerup', (e) => {
    const wasPinch = S.drag && S.drag.kind === 'pinch';
    endPointer(e);
    if (wasPinch) return;
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    svg.classList.remove('grabbing');
    switch (d.kind) {
      case 'move':
        if (d.moved && (d.dx || d.dy)) {
          mutate(() => { for (const id of d.ids) C.moveNode(node(id), d.dx, d.dy); });
        } else {
          if (d.clickSelect) setSel([d.clickSelect]);
          renderOverlay();
        }
        break;
      case 'resize':
        if (!d.changed) S.past.pop();
        afterChange();
        break;
      case 'marquee':
        setSel(S.sel);
        break;
      case 'create': {
        let b = rectFrom(d.p0, d.p1);
        if (b.w * S.view.z < 3 && b.h * S.view.z < 3) b = { x: d.p0.x, y: d.p0.y, w: 100, h: 100 };
        const n = d.type === 'RECT'
          ? { id: C.newId(), type: 'RECT', name: nextName('Rectangle'), ...b, fill: '#D9D9D9', stroke: null, strokeWidth: 0, radius: 0 }
          : { id: C.newId(), type: 'ELLIPSE', name: nextName('Ellipse'), ...b, fill: '#D9D9D9', stroke: null, strokeWidth: 0 };
        insertNew(n, d.p0);
        setTool('move');
        break;
      }
      case 'ink': {
        const pts = (d.pts.length > 1 ? d.pts : [d.pts[0], [d.pts[0][0] + 0.1, d.pts[0][1] + 0.1]]).map(([x, y]) => [round(x), round(y)]);
        const st = { points: pts, stroke: d.color, strokeWidth: 5 };
        const cur = sketchInfo();
        if (cur && !isResolved(cur)) {
          mutate(() => { cur.strokes = C.inkStrokes(cur).concat([st]); delete cur.points; S.sel = [cur.id]; });
        } else {
          const n = { id: C.newId(), type: 'INK', name: nextName('Sketch'), stroke: d.color, strokeWidth: 5, strokes: [st] };
          addAnnotation(n);
          S.sketchId = n.id;
        }
        renderChrome();
        break;
      }
      case 'hl':
        if (d.moved) {
          const b = rectFrom(d.p0, d.p1);
          addAnnotation({ id: C.newId(), type: 'RECT', name: nextName('Highlight'), ...b, fill: S.annColor, fillOpacity: 0.3, radius: 4 });
        } else {
          toggleMark(d.p0);
        }
        break;
      case 'annArrow':
        if (d.moved && !(d.fromId && d.fromId === d.toId)) {
          addAnnotation({ id: C.newId(), type: 'CONNECTOR', name: nextName('Arrow'), from: d.from, to: d.to, stroke: S.annColor, strokeWidth: 9, headSize: 26, opacity: 0.85, arrow: true });
        } else if (d.right) {
          toggleMark(d.raw);
        } else {
          renderOverlay();
        }
        break;
      case 'connect':
        if (d.over) {
          const c = { id: C.newId(), type: 'CONNECTOR', name: nextName('Connector'), from: { id: d.from, side: 'AUTO' }, to: { id: d.over, side: 'AUTO' }, stroke: '#1E1E1E', strokeWidth: 2, arrow: true, label: '', labelSize: 14 };
          mutate(() => { page().children.push(c); S.sel = [c.id]; });
          setTool('move');
        } else {
          renderOverlay();
        }
        break;
    }
  });

  function squareFrom(a, b) {
    const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
  }

  function marqueeHits(r, scope) {
    const out = [];
    const list = S.ctxId && node(S.ctxId) ? node(S.ctxId).children : scope ? scope.children : page().children;
    const visit = (lst) => {
      for (const n of lst) {
        if (n.visible === false || n.locked || hiddenResolved(n)) continue;
        if (isAnnGroup(n)) { visit(n.children); continue; }
        const b = bnds(n);
        if (!b) continue;
        if (n.type === 'SECTION') {
          if (contains(r, b)) out.push(n);
          else if (intersects(r, b)) visit(n.children);
        } else if (intersects(r, b)) out.push(n);
      }
    };
    visit(list);
    return out;
  }

  function toggleSel(id) {
    setSel(S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id]);
  }

  // Double-click: step into a group, or edit a text layer. Returns true when handled.
  function onDouble(leaf) {
    const target = resolve(leaf, false);
    if (!target) return false;
    if (target.type === 'GROUP') {
      setCtx(target.id);
      const inner = resolve(leaf, false);
      if (inner) setSel([inner.id]);
      return true;
    }
    if (target.type === 'TEXT' || target.type === 'STICKY') { startEdit(target, false); return true; }
    return false;
  }

  /* ---------------- resize ---------------- */
  function startResize(handle, p) {
    const n = selNodes()[0];
    if (!n) return;
    const b = bnds(n);
    pushHistory();
    S.drag = { kind: 'resize', handle, p0: p, id: n.id, orig: { x: b.x, y: b.y, w: b.w, h: b.h }, changed: false };
  }
  function doResize(d, p, keepRatio) {
    const n = node(d.id);
    const o = d.orig;
    const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (d.handle.includes('w')) x1 += dx;
    if (d.handle.includes('e')) x2 += dx;
    if (d.handle.includes('n')) y1 += dy;
    if (d.handle.includes('s')) y2 += dy;
    if (keepRatio && d.handle.length === 2 && o.w && o.h) {
      const sx = (x2 - x1) / o.w, sy = (y2 - y1) / o.h;
      const k = Math.abs(sx) > Math.abs(sy) ? sx : sy;
      const w = o.w * k, h = o.h * k;
      if (d.handle.includes('w')) x1 = x2 - w; else x2 = x1 + w;
      if (d.handle.includes('n')) y1 = y2 - h; else y2 = y1 + h;
    }
    const b = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(1, Math.abs(x2 - x1)), h: Math.max(1, Math.abs(y2 - y1)) };
    if (n.type === 'TEXT') {
      n.x = b.x;
      n.w = b.w;
      n.autoWidth = false;
    } else {
      Object.assign(n, b);
    }
    d.changed = true;
    renderContent();
    renderOverlay();
  }

  /* ---------------- creation ---------------- */
  function containerAt(p) {
    if (S.ctxId && node(S.ctxId)) return node(S.ctxId);
    let found = page();
    const visit = (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        if (n.type === 'SECTION' && n.visible !== false && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h) {
          found = n;
          visit(n.children);
          return;
        }
      }
    };
    visit(page().children);
    return found;
  }
  function insertNew(n, p) {
    mutate(() => {
      containerAt(p).children.push(n);
      S.sel = [n.id];
    });
  }
  function createText(p) {
    const n = { id: C.newId(), type: 'TEXT', name: nextName('Text'), x: p.x, y: p.y, text: 'Text', fontSize: 24, fontWeight: 500, color: '#1E1E1E', autoWidth: true, lineHeight: 1.25 };
    insertNew(n, p);
    setTool('move');
    startEdit(node(n.id), true);
  }

  /* ---------------- annotations ---------------- */
  // Annotations live in one "Annotations" group at the top of each page. The group is
  // transparent to selection, and its contents sync to the artifact's shared database.
  function annGroup(pg = page(), create = true) {
    let g = pg.children.find(isAnnGroup);
    if (!g && create) {
      g = { id: 'ann-' + pg.id, type: 'GROUP', name: 'Annotations', annotation: true, children: [] };
      pg.children.push(g);
    }
    return g;
  }
  const annNodes = (pg = page()) => { const g = annGroup(pg, false); return g ? g.children : []; };
  const editText = (n) => (n.type === 'STICKY' ? n.text || '' : C.plainText(n));

  function addAnnotation(n) {
    mutate(() => {
      const g = annGroup(page(), true);
      // Keep the group on top of everything else on the page.
      const list = page().children;
      list.splice(list.indexOf(g), 1);
      list.push(g);
      if (g.visible === false) g.visible = true;
      g.children.push(n);
      S.sel = [n.id];
    });
  }

  // Every visible, non-annotation leaf under a world point, with its ancestor chain.
  function hitsAt(pt, pg = page()) {
    const hits = [];
    const visit = (list, chain) => {
      for (const n of list) {
        if (n.visible === false || isAnnGroup(n)) continue;
        if (n.children) { visit(n.children, chain.concat(n)); continue; }
        if (n.type === 'CONNECTOR') continue;
        const b = bnds(n);
        if (b && pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) hits.push({ n, chain });
      }
    };
    visit(pg.children, []);
    return hits;
  }
  // The most specific layer under a point: the smallest one there, and among equal sizes the
  // one underneath, which is usually the shape a mark is about rather than whatever sits on it.
  function targetAt(pt, pg = page()) {
    const hits = hitsAt(pt, pg);
    let best = null;
    for (const h of hits) {
      const b = bnds(h.n);
      const a = Math.max(1, b.w * b.h);
      if (!best || a < best.a * 0.98) best = { h, a, b };
    }
    if (!best) return null;
    return { n: best.h.n, chain: best.h.chain, b: best.b, above: hits.slice(hits.indexOf(best.h) + 1).reverse() };
  }

  function toggleMark(pt) {
    const t = targetAt(pt);
    if (!t) { toast('Nothing here to highlight. Drag with the highlight tool to mark an area.'); return; }
    const existing = annNodes().find((n) => n.markOf === t.n.id);
    if (existing) {
      mutate(() => { const g = annGroup(); g.children = g.children.filter((n) => n !== existing); S.sel = []; });
      return;
    }
    addAnnotation({ id: C.newId(), type: 'RECT', name: `Highlight “${t.n.name}”`, markOf: t.n.id, x: t.b.x, y: t.b.y, w: t.b.w, h: t.b.h, fill: S.annColor, fillOpacity: 0.5 });
  }

  // Where an annotation arrow's end attaches. Small layers snap to their centre; on a big
  // layer the end stays where you let go but still moves with the layer. Alt gives a free end.
  const frac = (v) => Math.round(v * 10000) / 10000;
  function arrowEnd(pt, free) {
    const t = free ? null : targetAt(pt);
    if (!t) return { ep: { x: pt.x, y: pt.y }, p: pt, snapped: null };
    if (Math.max(t.b.w, t.b.h) * S.view.z <= 96) return { ep: { id: t.n.id, side: 'CENTER' }, p: C.center(t.b), snapped: t.n.id };
    return { ep: { id: t.n.id, side: 'POINT', fx: frac((pt.x - t.b.x) / t.b.w), fy: frac((pt.y - t.b.y) / t.b.h) }, p: pt, snapped: null };
  }
  function startAnnArrow(p, right, free) {
    const e0 = arrowEnd(p, free);
    S.drag = { kind: 'annArrow', right, free, raw: p, moved: false, p0: e0.p, p1: e0.p, from: e0.ep, fromId: e0.snapped, to: null, toId: null };
  }

  /* Sketch sessions: while the pen stays active, each stroke joins the same sketch. */
  function sketchInfo() {
    const n = S.sketchId && node(S.sketchId);
    return n && n.type === 'INK' ? n : null;
  }
  function finishSketch() {
    const n = sketchInfo();
    setTool('move');
    if (n) { setSel([n.id]); toast('Sketch saved. Add a follow-up if it needs words.'); }
  }
  function combineAnnotations() {
    const items = topLevelSel().filter((n) => isAnnGroup(parentOf(n.id)));
    if (items.length < 2) { toast('Select two or more annotations to combine them.'); return; }
    const replies = items.flatMap((n) => n.replies || []).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    mutate(() => {
      const list = annGroup().children;
      const idx = items.map((n) => list.indexOf(n)).sort((a, b) => a - b);
      let merged;
      if (items.every((n) => n.type === 'INK')) {
        merged = {
          id: C.newId(), type: 'INK', name: nextName('Sketch'), stroke: items[0].stroke, strokeWidth: items[0].strokeWidth || 5,
          strokes: items.flatMap((n) => C.inkStrokes(n).map((st) => ({ stroke: n.stroke, strokeWidth: n.strokeWidth, ...st }))),
        };
        if (items.every((n) => n.intent === 'mark')) merged.intent = 'mark';
      } else {
        merged = {
          id: C.newId(), type: 'GROUP', name: nextName('Annotation set'),
          children: items.map((n) => { delete n.replies; delete n.status; delete n.resolvedAt; delete n.resolvedBy; return n; }),
        };
        // A set that includes a "what I want" sketch keeps that meaning.
        if (items.some((n) => n.type === 'INK' && intentOf(n) === 'mockup')) merged.intent = 'mockup';
      }
      if (replies.length) merged.replies = replies;
      for (let i = idx.length - 1; i >= 0; i--) list.splice(idx[i], 1);
      list.splice(idx[0], 0, merged);
      S.sel = [merged.id];
    });
    toast('Combined into one annotation');
  }

  function createNote(p) {
    const col = ANN_COLORS.find((c) => c.v === S.annColor) || ANN_COLORS[2];
    const n = { id: C.newId(), type: 'STICKY', name: nextName('Note'), x: p.x, y: p.y, w: 220, h: 0, text: '', fill: col.note, fontSize: 16 };
    addAnnotation(n);
    setTool('move');
    startEdit(node(n.id), true);
  }

  // Plain-language descriptions, so whoever reads the shared data knows what each mark points at.
  function layerPath(n) {
    const chain = chainTo(n.id).slice(0, -1).filter((a) => a.type !== 'SECTION' && !a.annotation).map((a) => a.name);
    return chain.slice(-3).join(' › ');
  }
  function describePoint(pt, pg) {
    const t = targetAt(pt, pg);
    if (!t) return null;
    const path = layerPath(t.n);
    const above = t.above.slice(0, 2).map((h) => `“${h.n.name}”`);
    return `“${t.n.name}”${path ? ` in ${path}` : ''}${above.length ? `, under ${above.join(' and ')}` : ''}`;
  }
  // Named groups an area overlaps, so a sketch or area highlight can be tied to what it sits on.
  function regionOf(b, pg) {
    const names = [];
    const visit = (list) => {
      for (const n of list) {
        if (n.visible === false || isAnnGroup(n) || n.type === 'CONNECTOR') continue;
        if (n.type === 'SECTION') { visit(n.children); continue; }
        if (n.type !== 'GROUP') continue;
        const nb = bnds(n);
        if (nb && intersects(nb, b)) names.push(`“${n.name}”`);
      }
    };
    visit(pg.children);
    if (!names.length) return `empty canvas near ${nearestPanel(C.center(b), pg)}`;
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  }
  const intentOf = (n) => n.intent || (n.type === 'INK' ? 'mockup' : 'mark');
  function nearestPanel(pt, pg) {
    let best = null, bestD = Infinity;
    const visit = (list) => {
      for (const n of list) {
        if (n.visible === false || isAnnGroup(n) || n.type === 'CONNECTOR') continue;
        if (n.type === 'SECTION') { visit(n.children); continue; }
        if (n.type !== 'GROUP') continue;
        const b = bnds(n);
        if (!b) continue;
        const dx = Math.max(b.x - pt.x, 0, pt.x - (b.x + b.w)), dy = Math.max(b.y - pt.y, 0, pt.y - (b.y + b.h));
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = n; }
      }
    };
    visit(pg.children);
    return best ? `“${best.name}”` : 'the page';
  }
  function colourName(c) {
    const hit = ANN_COLORS.find((x) => x.v.toLowerCase() === String(c || '').toLowerCase() || x.note.toLowerCase() === String(c || '').toLowerCase());
    return hit ? hit.name.toLowerCase() : (c || 'uncoloured');
  }
  function describeNode(n, pg = page()) {
    const b = bnds(n);
    const size = b ? `${Math.round(b.w)} × ${Math.round(b.h)}` : '';
    switch (n.type) {
      case 'CONNECTOR': {
        const g = C.connectorGeom(n, ctx());
        if (!g) return `${colourName(n.stroke)} arrow`;
        const a = describePoint(g.p1, pg) || `a point near ${nearestPanel(g.p1, pg)}`;
        const z = describePoint(g.p2, pg) || `a point near ${nearestPanel(g.p2, pg)}`;
        return `${colourName(n.stroke)} arrow from ${a} to ${z}`;
      }
      case 'RECT': {
        const t = n.markOf && node(n.markOf);
        if (t) return `${colourName(n.fill)} highlight on “${t.name}”${layerPath(t) ? ` in ${layerPath(t)}` : ''}`;
        return `${colourName(n.fill)} highlighted area (${size}) over ${regionOf(b, pg)}`;
      }
      case 'STICKY':
        return `note near ${nearestPanel({ x: b.x, y: b.y }, pg)}: “${(n.text || '').trim()}”`;
      case 'INK': {
        const k = C.inkStrokes(n).length;
        const kind = intentOf(n) === 'mark' ? 'freehand mark' : 'sketch of what the user wants';
        return `${colourName(n.stroke)} ${kind} (${k} stroke${k === 1 ? '' : 's'}, ${size}) over ${regionOf(b, pg)}`;
      }
      case 'GROUP':
        return `set of ${n.children.length} annotations${intentOf(n) === 'mockup' ? ' showing what the user wants' : ''}: ${n.children.map((c) => describeNode(c, pg)).join('; ')}`;
    }
    return `${TYPE_LABEL[n.type] || n.type} “${n.name}” near ${b ? nearestPanel(C.center(b), pg) : 'the page'}`;
  }

  function ago(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const who = (r) => (r.author === 'claude' ? 'Claude' : 'You');

  function setShowResolved(on) {
    S.showResolved = on;
    try { localStorage.setItem(RESOLVED_KEY, on ? '1' : '0'); } catch (e) { /* convenience only */ }
    if (!on) S.sel = S.sel.filter((id) => !isResolved(node(id)));
    renderContent(); renderOverlay(); renderLayers(); renderProps();
  }

  function resolveAnn(id, on) {
    const n = node(id);
    if (!n) return;
    mutate(() => {
      if (on) {
        n.status = 'resolved';
        n.resolvedAt = new Date().toISOString();
        n.resolvedBy = 'user';
        if (!S.showResolved) S.sel = S.sel.filter((x) => x !== id);
      } else {
        delete n.status; delete n.resolvedAt; delete n.resolvedBy;
      }
    });
    toast(on ? (S.showResolved ? 'Resolved' : 'Resolved · find it under Resolved in the side panel') : 'Reopened');
  }

  function threadSection(n) {
    const resolved = isResolved(n);
    const msgs = [];
    if (n.type === 'STICKY' && n.text) msgs.push(`<li class="msg"><b>Note</b><span>${esc(n.text)}</span></li>`);
    for (const r of n.replies || []) {
      msgs.push(`<li class="msg${r.author === 'claude' ? ' claude' : ''}"><b>${who(r)}<time>${esc(ago(r.at))}</time></b><span>${esc(r.text)}</span></li>`);
    }
    const status = resolved
      ? `<span class="pill ok">Resolved${n.resolvedBy === 'claude' ? ' by Claude' : ''}</span>`
      : '<span class="pill">Open</span>';
    const intent = n.type === 'INK' || n.type === 'GROUP'
      ? `<div class="seg" role="group" aria-label="What this shows"><button data-intent="mockup" aria-pressed="${intentOf(n) === 'mockup'}">What I want</button><button data-intent="mark" aria-pressed="${intentOf(n) === 'mark'}">Points at something</button></div>`
      : '';
    return section(`Annotation ${status}`, `${intent}<p class="help">${esc(describeNode(n))}</p>
      ${msgs.length ? `<ul class="thread">${msgs.join('')}</ul>` : ''}
      <textarea class="f" id="replyText" rows="2" placeholder="${resolved ? 'Add a follow-up to reopen it…' : 'Add a follow-up…'}" aria-label="Follow-up"></textarea>
      <div class="grid2"><button class="btn" data-cmd="reply">Reply <span class="kbd">⌘↵</span></button>
      <button class="btn${resolved ? '' : ' primary'}" data-cmd="${resolved ? 'reopen' : 'resolve'}">${resolved ? 'Reopen' : 'Resolve'}</button></div>`);
  }

  function annRow(n, pg) {
    const resolved = isResolved(n);
    const replies = n.replies || [];
    const last = replies[replies.length - 1];
    const meta = last ? `${who(last)}: ${last.text}` : '';
    const count = replies.length ? ` · ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : '';
    return `<li><div class="ann-row"><button class="ann-main" data-ann="${esc(n.id)}"><span class="dot" style="background:${esc(n.stroke || n.fill || '#999')}"></span><span><span class="ann-desc">${esc(describeNode(n, pg))}</span>${meta || count ? `<span class="ann-meta">${esc(meta)}${count}</span>` : ''}</span></button>
      <button class="ann-act" data-${resolved ? 'reopen' : 'resolve'}="${esc(n.id)}" title="${resolved ? 'Reopen' : 'Resolve'}" aria-label="${resolved ? 'Reopen' : 'Resolve'}">${resolved ? '↺' : '✓'}</button></div></li>`;
  }

  function annotationsSection(pg) {
    const all = annNodes(pg);
    const open = all.filter((n) => !isResolved(n)).reverse();
    const done = all.filter(isResolved).reverse();
    let body = `<p class="sync" id="syncStatus" data-state="${Sync.status}">${esc(syncText())}</p>`;
    body += open.length
      ? `<ul class="ann-list">${open.map((n) => annRow(n, pg)).join('')}</ul>`
      : `<p class="help">${all.length ? 'Nothing open. Everything here is resolved.' : 'Sketch with the pen, or use arrows, highlights and notes. Right-drag draws an arrow and right-click highlights whatever is under the pointer, from any tool.'}</p>`;
    if (done.length) {
      body += `<div class="ann-sub">Resolved · ${done.length}<label class="chk"><input type="checkbox" id="showResolved"${S.showResolved ? ' checked' : ''}> Show on canvas</label></div>`;
      body += `<ul class="ann-list">${done.map((n) => annRow(n, pg)).join('')}</ul>`;
      body += '<button class="btn wide" data-cmd="delete-resolved">Delete resolved annotations</button>';
    }
    if (all.length) body += '<button class="btn wide" data-cmd="clear-ann">Clear all annotations on this page</button>';
    return section(`Annotations${open.length ? ` · ${open.length} open` : ''}`, body);
  }

  /* ---------------- sharing annotations with Claude ---------------- */
  const Sync = { db: null, status: 'local', last: {}, ready: false };
  function syncText() {
    return {
      local: 'Saved in this browser. Open the published Vellum to share annotations with Claude.',
      connecting: 'Connecting…',
      shared: 'Shared with Claude. Claude can read these annotations.',
      readonly: 'You can see the shared annotations but can’t change them.',
      error: 'Couldn’t share the latest annotations. They’re saved in this browser for now.',
    }[Sync.status];
  }
  function updateSyncStatus() {
    const el = document.getElementById('syncStatus');
    if (el) { el.dataset.state = Sync.status; el.textContent = syncText(); }
  }
  const stripAbout = (n) => { const c = { ...n }; delete c.about; if (c.children) c.children = c.children.map(stripAbout); return c; };

  async function initSync() {
    if (!(window.claude && typeof window.claude.use === 'function')) return;
    let db = null;
    try { db = await window.claude.use('db'); } catch (e) { db = null; }
    if (!db) return;
    Sync.db = db;
    Sync.status = 'connecting';
    updateSyncStatus();
    db.collection('annotations').onSnapshot((snap) => {
      let changed = false;
      for (const d of snap.docs) {
        if (d.metadata.hasPendingWrites) continue;
        const body = d.data();
        if (!body || !Array.isArray(body.items)) continue;
        const pg = S.doc.pages.find((x) => x.id === body.pageId);
        if (!pg) continue;
        const items = body.items.map(stripAbout);
        const json = JSON.stringify(items);
        Sync.last[pg.id] = json;
        if (json !== JSON.stringify(annNodes(pg))) {
          annGroup(pg, true).children = items;
          changed = true;
        }
      }
      if (Sync.status !== 'readonly') Sync.status = 'shared';
      if (changed) {
        reindex();
        S.sel = S.sel.filter((id) => node(id));
        renderContent(); renderOverlay(); renderLayers(); renderProps();
        scheduleSave();
      } else updateSyncStatus();
      if (!Sync.ready) { Sync.ready = true; schedulePush(); }
    }, () => { Sync.status = 'error'; Sync.db = null; updateSyncStatus(); });
  }

  let pushTimer = 0;
  let pushing = false;
  function schedulePush() {
    if (!Sync.db || !Sync.ready) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushAnnotations, 700);
  }
  async function pushAnnotations() {
    if (!Sync.db) return;
    if (pushing) { schedulePush(); return; }
    pushing = true;
    try {
      for (const pg of S.doc.pages) {
        const items = annNodes(pg);
        const json = JSON.stringify(items);
        if (Sync.last[pg.id] === json || (!items.length && Sync.last[pg.id] === undefined)) continue;
        const described = items.map((n) => ({ ...JSON.parse(JSON.stringify(n)), about: describeNode(n, pg) }));
        const line = (n) => {
          const thread = (n.replies || []).map((r) => `${r.author === 'claude' ? 'Claude' : 'User'}: ${r.text}`).join(' | ');
          return `${isResolved(n) ? 'RESOLVED' : 'OPEN'} · ${n.about}${thread ? ` · follow-ups: ${thread}` : ''}`;
        };
        await Sync.db.doc('annotations/' + pg.id).set({
          pageId: pg.id, pageName: pg.name, updatedAt: new Date().toISOString(),
          count: items.length, open: items.filter((n) => !isResolved(n)).length,
          summary: described.map(line), items: described,
        });
        Sync.last[pg.id] = json;
      }
      if (Sync.status !== 'readonly') Sync.status = 'shared';
    } catch (e) {
      Sync.status = e && e.code === 'invalid_argument' ? 'readonly' : 'error';
    } finally {
      pushing = false;
      updateSyncStatus();
    }
  }

  /* ---------------- annotation colour ---------------- */
  function renderColorMenu() {
    $('#colorSwatch').style.background = S.annColor;
    $('#colorMenu').innerHTML = ANN_COLORS.map((c) => `<button data-color="${c.v}" aria-pressed="${c.v === S.annColor}" title="${c.name}" aria-label="${c.name}"><span class="swatch" style="background:${c.v}"></span></button>`).join('');
  }
  $('#colorBtn').addEventListener('click', (e) => {
    const m = $('#colorMenu');
    const open = m.hidden;
    closeMenus();
    if (open) {
      const r = e.currentTarget.getBoundingClientRect();
      m.style.left = `${Math.min(r.left, window.innerWidth - 190)}px`;
      m.style.top = r.top > window.innerHeight / 2 ? `${r.top - 48}px` : `${r.bottom + 6}px`;
      m.hidden = false;
      e.currentTarget.setAttribute('aria-expanded', 'true');
    }
    e.stopPropagation();
  });
  $('#colorMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    S.annColor = b.dataset.color;
    try { localStorage.setItem(COLOR_KEY, S.annColor); } catch (err) { /* convenience only */ }
    renderColorMenu();
    closeMenus();
    // Recolour selected annotations too.
    const inAnn = selNodes().filter((n) => chainTo(n.id).some(isAnnGroup));
    if (inAnn.length) {
      const col = ANN_COLORS.find((c) => c.v === S.annColor);
      const paint = (n) => {
        if (n.type === 'STICKY') n.fill = col.note;
        else if (n.type === 'RECT') n.fill = col.v;
        else if (n.type === 'GROUP') n.children.forEach(paint);
        else {
          n.stroke = col.v;
          if (n.strokes) n.strokes = n.strokes.map((st) => ({ ...st, stroke: col.v }));
        }
      };
      mutate(() => inAnn.forEach(paint));
    }
  });
  renderColorMenu();

  /* ---------------- images ---------------- */
  // Images are stored in the document as data URIs, so files stay self-contained.
  function readAsDataUrl(file) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  }
  async function placeImages(files, at) {
    const imgs = [...files].filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return;
    const big = imgs.find((f) => f.size > 3 * 1024 * 1024);
    if (big) toast(`${big.name} is large; it's stored inside the file, so saving may be slow.`);
    const s = stageSize();
    let p = at || { x: (s.w / 2 - S.view.x) / S.view.z, y: (s.h / 2 - S.view.y) / S.view.z };
    const nodes = [];
    for (const f of imgs) {
      const src = await readAsDataUrl(f);
      const im = new Image();
      im.src = src;
      try { await im.decode(); } catch (e) { toast(`Couldn't read ${f.name} as an image.`); continue; }
      const scale = Math.min(1, 480 / Math.max(im.naturalWidth, im.naturalHeight));
      const w = Math.round(im.naturalWidth * scale), h = Math.round(im.naturalHeight * scale);
      nodes.push({ id: C.newId(), type: 'IMAGE', name: f.name.replace(/\.[^.]+$/, '') || 'Image', x: p.x - w / 2, y: p.y - h / 2, w, h, src });
      p = { x: p.x + 24, y: p.y + 24 };
    }
    if (!nodes.length) return;
    mutate(() => {
      const target = containerAt(nodes[0]);
      for (const n of nodes) target.children.push(n);
      S.sel = nodes.map((n) => n.id);
    });
  }
  $('#imageInput').addEventListener('change', (e) => { placeImages(e.target.files); e.target.value = ''; });
  svg.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); });
  svg.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    placeImages(e.dataTransfer.files, toWorld(e));
  });
  window.addEventListener('paste', (e) => {
    if (typing(e)) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); placeImages(files); }
  });

  /* ---------------- text editing ---------------- */
  function startEdit(n, selectAll) {
    S.editing = n.id;
    S.sel = [n.id];
    editor.hidden = false;
    editor.value = editText(n);
    renderContent();
    renderOverlay();
    positionEditor();
    // Focus after the pointer press finishes, so the press doesn't pull focus back off the editor.
    setTimeout(() => {
      if (S.editing !== n.id) return;
      editor.focus();
      if (selectAll) editor.select();
      else editor.setSelectionRange(editor.value.length, editor.value.length);
    }, 0);
  }
  function positionEditor() {
    if (!S.editing) return;
    const n = node(S.editing);
    if (!n) { S.editing = null; editor.hidden = true; return; }
    const b = bnds(n);
    const z = S.view.z;
    if (n.type === 'STICKY') {
      Object.assign(editor.style, {
        left: `${n.x * z + S.view.x}px`, top: `${n.y * z + S.view.y}px`, width: `${n.w * z}px`,
        padding: `${C.STICKY_PAD * z}px`, boxSizing: 'border-box', background: n.fill || '#FFECBD', borderRadius: `${6 * z}px`,
        fontFamily: C.DEFAULT_FONT, fontSize: `${(n.fontSize || 16) * z}px`, fontWeight: 500, lineHeight: '1.35',
        color: n.color || '#1E1E1E', textAlign: 'left',
      });
      editor.style.height = 'auto';
      editor.style.height = `${Math.max(editor.scrollHeight, b.h * z)}px`;
      return;
    }
    Object.assign(editor.style, { padding: '0', background: 'transparent', borderRadius: '0', boxSizing: 'content-box' });
    Object.assign(editor.style, {
      left: `${b.x * z + S.view.x}px`,
      top: `${b.y * z + S.view.y}px`,
      fontFamily: n.fontFamily || C.DEFAULT_FONT,
      fontSize: `${(n.fontSize || 16) * z}px`,
      fontWeight: n.fontWeight || 400,
      lineHeight: String(n.lineHeight || 1.25),
      color: n.color || '#1E1E1E',
      textAlign: n.align || 'left',
      width: `${n.autoWidth ? Math.max(b.w * z + 30, 60) : n.w * z}px`,
    });
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
  }
  function commitEdit() {
    const id = S.editing;
    if (!id) return;
    S.editing = null;
    editor.hidden = true;
    const n = node(id);
    if (!n) return;
    const v = editor.value;
    if (!v.trim()) {
      mutate(() => removeNodes([n]));
    } else if (v !== editText(n)) {
      mutate(() => { n.text = v; delete n.runs; });
    } else {
      renderContent();
      renderOverlay();
    }
  }
  editor.addEventListener('input', positionEditor);
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); commitEdit(); }
  });
  editor.addEventListener('blur', () => commitEdit());

  /* ---------------- commands ---------------- */
  function removeNodes(nodes) {
    const gone = new Set();
    for (const n of nodes) {
      const p = parentOf(n.id);
      if (!p) continue;
      const i = p.children.indexOf(n);
      if (i >= 0) p.children.splice(i, 1);
      C.walk([n], (x) => gone.add(x.id));
    }
    // Connectors attached to removed layers are removed too.
    for (const pg of S.doc.pages) {
      const prune = (list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const x = list[i];
          if (x.type === 'CONNECTOR' && ((x.from && gone.has(x.from.id)) || (x.to && gone.has(x.to.id)))) list.splice(i, 1);
          else if (x.children) prune(x.children);
        }
      };
      prune(pg.children);
    }
    S.sel = [];
  }
  function deleteSel() {
    const nodes = topLevelSel().filter((n) => !n.locked);
    if (nodes.length) mutate(() => removeNodes(nodes));
  }
  function duplicateSel() {
    const nodes = topLevelSel();
    if (!nodes.length) return;
    mutate(() => {
      const ids = [];
      for (const n of nodes) {
        const [copy] = C.cloneWithNewIds([n]);
        C.moveNode(copy, 20, 20);
        copy.name = n.name;
        const p = parentOf(n.id);
        p.children.splice(p.children.indexOf(n) + 1, 0, copy);
        ids.push(copy.id);
      }
      S.sel = ids;
    });
  }
  function copySel() {
    const nodes = topLevelSel();
    if (!nodes.length) return;
    S.clipboard = JSON.stringify(nodes);
    S.pasteCount = 0;
    toast(`Copied ${nodes.length} layer${nodes.length > 1 ? 's' : ''}`);
  }
  function paste() {
    if (!S.clipboard) return;
    S.pasteCount++;
    const copies = C.cloneWithNewIds(JSON.parse(S.clipboard));
    const target = S.ctxId && node(S.ctxId) ? node(S.ctxId) : page();
    mutate(() => {
      for (const c of copies) { C.moveNode(c, 20 * S.pasteCount, 20 * S.pasteCount); target.children.push(c); }
      S.sel = copies.map((c) => c.id);
    });
  }
  function groupSel() {
    const nodes = topLevelSel();
    if (!nodes.length) return;
    if (nodes.every((n) => isAnnGroup(parentOf(n.id)))) { combineAnnotations(); return; }
    const parent = parentOf(nodes[0].id);
    if (!nodes.every((n) => parentOf(n.id) === parent)) { toast('Select layers that share a parent to group them.'); return; }
    mutate(() => {
      const list = parent.children;
      const idx = nodes.map((n) => list.indexOf(n)).sort((a, b) => a - b);
      const g = { id: C.newId(), type: 'GROUP', name: nextName('Group'), children: idx.map((i) => list[i]) };
      for (let i = idx.length - 1; i >= 0; i--) list.splice(idx[i], 1);
      list.splice(idx[idx.length - 1] - (idx.length - 1), 0, g);
      S.sel = [g.id];
    });
  }
  function ungroupSel() {
    const groups = topLevelSel().filter((n) => n.type === 'GROUP');
    if (!groups.length) return;
    mutate(() => {
      const ids = [];
      for (const g of groups) {
        const p = parentOf(g.id);
        const i = p.children.indexOf(g);
        // Splitting a combined annotation keeps its thread on the first part.
        if (isAnnGroup(p) && g.replies && g.replies.length && g.children[0]) g.children[0].replies = (g.children[0].replies || []).concat(g.replies);
        p.children.splice(i, 1, ...g.children);
        ids.push(...g.children.map((c) => c.id));
        if (S.ctxId === g.id) S.ctxId = null;
      }
      S.sel = ids;
    });
  }
  function reorder(dir) {
    const nodes = topLevelSel();
    if (!nodes.length) return;
    mutate(() => {
      const ordered = dir > 0 ? nodes.slice().reverse() : nodes.slice();
      for (const n of ordered) {
        const list = parentOf(n.id).children;
        const i = list.indexOf(n);
        list.splice(i, 1);
        const j = dir === 2 ? list.length : dir === -2 ? 0 : Math.max(0, Math.min(list.length, i + dir));
        list.splice(j, 0, n);
      }
    });
  }
  function toggleProp(prop) {
    const nodes = topLevelSel();
    if (!nodes.length) return;
    mutate(() => {
      const on = prop === 'visible' ? nodes.some((n) => n.visible !== false) : !nodes.every((n) => n.locked);
      for (const n of nodes) n[prop] = prop === 'visible' ? !on : on;
    });
  }
  function nudge(dx, dy) {
    const nodes = topLevelSel().filter((n) => !n.locked);
    if (nodes.length) mutate(() => nodes.forEach((n) => C.moveNode(n, dx, dy)));
  }
  function selectAll() {
    const list = S.ctxId && node(S.ctxId) ? node(S.ctxId).children : page().children;
    setSel(list.filter((n) => n.visible !== false && !n.locked && !hiddenResolved(n)).map((n) => n.id), { reveal: false });
  }
  function escape() {
    if (S.drag) return;
    if (S.tool === 'pen' && sketchInfo()) { finishSketch(); return; }
    if (S.sel.length) {
      const p = parentOf(S.sel[0]);
      if (p && !isPage(p) && p.type === 'GROUP' && !p.annotation) {
        setSel([p.id]);
        setCtx(ctxForNode(p.id));
        return;
      }
      setCtx(null);
      setSel([]);
      return;
    }
    setCtx(null);
    if (S.tool !== 'move') setTool('move');
  }
  function align(how) {
    const nodes = topLevelSel();
    const u = unionOf(nodes);
    if (!u || nodes.length < 2) return;
    mutate(() => {
      for (const n of nodes) {
        const b = bnds(n);
        let dx = 0, dy = 0;
        if (how === 'left') dx = u.x - b.x;
        if (how === 'hcenter') dx = u.x + u.w / 2 - (b.x + b.w / 2);
        if (how === 'right') dx = u.x + u.w - (b.x + b.w);
        if (how === 'top') dy = u.y - b.y;
        if (how === 'vcenter') dy = u.y + u.h / 2 - (b.y + b.h / 2);
        if (how === 'bottom') dy = u.y + u.h - (b.y + b.h);
        C.moveNode(n, dx, dy);
      }
    });
  }

  /* ---------------- view ---------------- */
  function stageSize() {
    const r = svg.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  function zoomAt(mx, my, z) {
    z = Math.min(64, Math.max(0.02, z));
    const wx = (mx - S.view.x) / S.view.z, wy = (my - S.view.y) / S.view.z;
    S.view.z = z;
    S.view.x = mx - wx * z;
    S.view.y = my - wy * z;
    applyView();
  }
  function zoomBy(k) {
    const s = stageSize();
    zoomAt(s.w / 2, s.h / 2, S.view.z * k);
  }
  function zoomToFit(nodes) {
    const b = unionOf((nodes || page().children).filter((n) => n.visible !== false));
    const s = stageSize();
    if (!b || !s.w) { S.view = { x: s.w / 2 || 0, y: s.h / 2 || 0, z: 1 }; applyView(); return; }
    const pad = 60;
    const z = Math.min((s.w - pad * 2) / Math.max(b.w, 1), (s.h - pad * 2) / Math.max(b.h, 1), 2);
    S.view = { z, x: s.w / 2 - (b.x + b.w / 2) * z, y: s.h / 2 - (b.y + b.h / 2) * z };
    applyView();
  }
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, S.view.z * Math.exp(-e.deltaY * 0.01));
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      S.view.x -= dx;
      S.view.y -= dy;
      applyView();
    }
  }, { passive: false });
  window.addEventListener('resize', () => { renderOverlay(); positionEditor(); });

  /* ---------------- tools + chrome ---------------- */
  const HINTS = {
    move: 'Click to select · double-click a group to go inside it · ⌘-click selects deep · drag empty canvas to marquee',
    hand: 'Drag to pan · hold Space from any tool to pan · ⌘-scroll or pinch to zoom',
    rect: 'Drag to draw a rectangle · hold Shift for a square · click for 100 × 100',
    ellipse: 'Drag to draw an ellipse · hold Shift for a circle',
    text: 'Click to place text, then type · ⌘Enter or Esc to finish',
    connector: 'Drag from one layer to another to connect them with an arrow',
    pen: 'Sketch what you want · every stroke joins the same sketch until you press Done or Esc',
    arrow: 'Drag to draw an arrow · ends stick to the layers under them · hold Alt for a free end · right-drag works from any tool',
    mark: 'Click a layer to highlight it, click again to clear · drag to highlight an area · right-click works from any tool',
    note: 'Click to drop a note, then type · ⌘Enter or Esc to finish',
  };
  function setTool(t) {
    if (t !== 'pen') S.sketchId = null;
    S.tool = t;
    svg.setAttribute('class', `tool-${t}`);
    renderChrome();
  }
  function renderChrome() {
    for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === S.tool));
    $('#undoBtn').disabled = !S.past.length;
    $('#redoBtn').disabled = !S.future.length;
    $('#hint').textContent = HINTS[S.tool] || '';
    const chip = $('#ctxChip');
    const g = S.ctxId && node(S.ctxId);
    chip.hidden = !g;
    if (g) $('#ctxName').textContent = `Inside “${g.name}”`;
    $('#exportBtn').textContent = S.sel.length ? 'Export selection' : 'Export page';
    const sk = S.tool === 'pen' ? sketchInfo() : null;
    $('#sketchChip').hidden = !sk;
    if (sk) { const k = C.inkStrokes(sk).length; $('#sketchInfo').textContent = `${sk.name} · ${k} stroke${k === 1 ? '' : 's'}`; }
  }

  /* ---------------- pages ---------------- */
  function renderPages() {
    $('#pages').innerHTML = S.doc.pages.map((p) => `<li class="${p.id === S.pageId ? 'on' : ''}" data-page="${esc(p.id)}"><span class="nm">${esc(p.name)}</span>${S.doc.pages.length > 1 ? `<button class="x" data-act="del-page" title="Delete page" aria-label="Delete page ${esc(p.name)}">×</button>` : ''}</li>`).join('');
  }
  function switchPage(id, fit) {
    if (id === S.pageId && !fit) return;
    commitEdit();
    S.views[S.pageId] = { ...S.view };
    S.pageId = id;
    S.sel = [];
    S.ctxId = null;
    S.hover = null;
    renderAll();
    if (S.views[id] && !fit) { S.view = { ...S.views[id] }; applyView(); } else zoomToFit();
  }
  $('#pages').addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.closest('[data-act="del-page"]')) {
      const id = li.dataset.page;
      mutate(() => {
        S.doc.pages = S.doc.pages.filter((p) => p.id !== id);
        if (S.pageId === id) S.pageId = S.doc.pages[0].id;
      });
      toast('Page deleted · ⌘Z to undo');
      zoomToFit();
      return;
    }
    switchPage(li.dataset.page);
  });
  $('#pages').addEventListener('dblclick', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const pg = S.doc.pages.find((p) => p.id === li.dataset.page);
    inlineRename(li.querySelector('.nm'), pg.name, (v) => mutate(() => { pg.name = v; }));
  });
  $('#addPage').addEventListener('click', () => {
    const id = C.newId();
    mutate(() => { S.doc.pages.push({ id, name: `Page ${S.doc.pages.length + 1}`, children: [] }); });
    switchPage(id, true);
  });

  /* ---------------- layers ---------------- */
  const ICON = {
    RECT: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    ELLIPSE: '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    TEXT: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4 4h8M8 4v8.5" stroke="currentColor" stroke-width="1.4" fill="none"/></svg>',
    PATH: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 12c2-7 5-9 10-8" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="3" cy="12" r="1.5" fill="currentColor"/><circle cx="13" cy="4" r="1.5" fill="currentColor"/></svg>',
    GROUP: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"/></svg>',
    SECTION: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M5 2v12M11 2v12M2 5h12M2 11h12" stroke="currentColor" stroke-width="1.2"/></svg>',
    CONNECTOR: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 13 12 4" stroke="currentColor" stroke-width="1.3"/><path d="M8.5 3.5H12.5V7.5" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    IMAGE: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.5" y="3" width="11" height="10" rx="1"/><circle cx="6" cy="6.5" r="1.2"/><path d="m3 12 3.5-3.5 2.5 2.5 2-2 2.5 2.5"/></svg>',
    INK: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 11c2-4 4-6 5-4s2 3 6-3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    STICKY: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3 3h10v6.5L9.5 13H3z"/><path d="M13 9.5H9.5V13"/></svg>',
  };
  const EYE = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 2l12 12M6.5 4Q7.2 3.5 8 3.5c4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-2 2.4M4 5.3A12 12 0 0 0 1.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7"/></svg>';
  const LOCK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  const UNLOCK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>';

  function renderLayers() {
    const rows = [];
    const walk = (list, depth, dimmed) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = list[i];
        const hidden = n.visible === false || isResolved(n);
        const hasKids = !!(n.children && n.children.length);
        const open = S.expanded.has(n.id);
        rows.push(`<div class="row${S.sel.includes(n.id) ? ' sel' : ''}${hidden || dimmed ? ' dim' : ''}" data-id="${esc(n.id)}" style="--d:${depth}" role="treeitem" aria-selected="${S.sel.includes(n.id)}"${hasKids ? ` aria-expanded="${open}"` : ''}>`
          + (hasKids ? `<button class="caret${open ? ' open' : ''}" data-act="caret" aria-label="${open ? 'Collapse' : 'Expand'}">▶</button>` : '<span class="caret-sp"></span>')
          + `<span class="ico">${ICON[n.type] || ''}</span><span class="nm">${esc(n.name || TYPE_LABEL[n.type])}</span>`
          + `<button class="rb${n.locked ? ' on' : ''}" data-act="lock" title="${n.locked ? 'Unlock' : 'Lock'}" aria-label="${n.locked ? 'Unlock' : 'Lock'}">${n.locked ? LOCK : UNLOCK}</button>`
          + `<button class="rb${hidden ? ' on' : ''}" data-act="eye" title="${hidden ? 'Show' : 'Hide'}" aria-label="${hidden ? 'Show' : 'Hide'}">${hidden ? EYE_OFF : EYE}</button></div>`);
        if (hasKids && open) walk(n.children, depth + 1, hidden || dimmed);
      }
    };
    walk(page().children, 0, false);
    $('#layers').innerHTML = rows.join('') || '<p class="empty">No layers yet. Pick a tool and draw on the canvas.</p>';
  }
  $('#layers').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    const n = node(id);
    const act = e.target.closest('[data-act]');
    if (act) {
      const a = act.dataset.act;
      if (a === 'caret') { if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id); renderLayers(); }
      if (a === 'eye') mutate(() => { n.visible = n.visible === false; });
      if (a === 'lock') mutate(() => { n.locked = !n.locked; });
      return;
    }
    setCtx(ctxForNode(id));
    if (e.shiftKey || e.metaKey || e.ctrlKey) toggleSel(id); else setSel([id], { reveal: false });
  });
  $('#layers').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('[data-act]')) return;
    const n = node(row.dataset.id);
    if (n.children) { S.expanded.add(n.id); }
    inlineRename(row.querySelector('.nm'), n.name || '', (v) => mutate(() => { n.name = v; }));
  });
  $('#layers').addEventListener('mouseover', (e) => {
    const row = e.target.closest('.row');
    const id = row ? row.dataset.id : null;
    if (id !== S.hover) { S.hover = id; renderOverlay(); }
  });
  $('#layers').addEventListener('mouseleave', () => { S.hover = null; renderOverlay(); });

  function inlineRename(span, value, done) {
    const input = document.createElement('input');
    input.value = value;
    input.setAttribute('aria-label', 'Name');
    span.textContent = '';
    span.appendChild(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (save && v && v !== value) done(v); else { renderLayers(); renderPages(); }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  /* ---------------- properties ---------------- */
  const fmt = (v) => (v == null || Number.isNaN(v) ? '' : String(round(v)));
  const hex6 = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : /^#[0-9a-f]{3}$/i.test(c || '') ? '#' + c.slice(1).split('').map((x) => x + x).join('') : '#000000');
  const num = (label, key, val, step = 1, attrs = '') => `<label class="f"><span>${label}</span><input type="number" data-k="${key}" value="${fmt(val)}" step="${step}" ${attrs} aria-label="${label}"></label>`;
  const color = (label, key, val) => `<div class="f"><input type="color" data-k="${key}" value="${hex6(val)}" aria-label="${label} colour"><input type="text" data-k="${key}" value="${esc(val || '')}" placeholder="None" spellcheck="false" aria-label="${label}"></div>`;
  const section = (title, body) => `<section class="ps"><h3>${title}</h3>${body}</section>`;

  function renderProps() {
    const el = $('#props');
    const sel = selNodes();
    let h = '';
    if (!sel.length) {
      const pg = page();
      const count = (() => { let c = 0; C.walk(pg.children, () => c++); return c; })();
      h += section('Page', `<label class="f"><span>Name</span><input type="text" data-k="pageName" value="${esc(pg.name)}" aria-label="Page name"></label><p class="help">${count} layer${count === 1 ? '' : 's'} on this page.</p>`);
      h += annotationsSection(pg);
      h += exportSection(`Export “${pg.name}”`);
      h += section('Shortcuts', `<dl class="keys">
        <dt>Move · Hand</dt><dd>V · H</dd><dt>Rectangle · Ellipse</dt><dd>R · O</dd><dt>Text · Connector</dt><dd>T · C</dd>
        <dt>Group · Ungroup</dt><dd>⌘G · ⇧⌘G</dd><dt>Duplicate</dt><dd>⌘D</dd><dt>Copy · Paste</dt><dd>⌘C · ⌘V</dd>
        <dt>Bring forward · back</dt><dd>⌘] · ⌘[</dd><dt>Hide · Lock</dt><dd>⇧⌘H · ⇧⌘L</dd>
        <dt>Pen · Arrow</dt><dd>P · A</dd><dt>Highlight · Note</dt><dd>M · N</dd>
        <dt>Arrow · highlight, any tool</dt><dd>Right-drag · right-click</dd>
        <dt>Zoom to fit · selection</dt><dd>⇧1 · ⇧2</dd><dt>Zoom 100%</dt><dd>⇧0</dd><dt>Undo · Redo</dt><dd>⌘Z · ⇧⌘Z</dd></dl>`);
      el.innerHTML = h;
      return;
    }
    if (sel.length > 1) {
      const u = unionOf(sel);
      h += section(`${sel.length} layers`, `<div class="grid2">${num('X', 'x', u && u.x)}${num('Y', 'y', u && u.y)}</div>
        <div class="grid3">${[['left', '⇤'], ['hcenter', '↔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '↕'], ['bottom', '⤓']].map(([k, g]) => `<button class="btn" data-align="${k}" title="Align ${k}" aria-label="Align ${k}">${g}</button>`).join('')}</div>
        ${sel.every((x) => isAnnGroup(parentOf(x.id)))
          ? '<button class="btn primary wide" data-cmd="combine">Combine into one annotation <span class="kbd">⌘G</span></button>'
          : '<button class="btn wide" data-cmd="group">Group selection  <span class="kbd">⌘G</span></button>'}`);
      h += exportSection('Export selection');
      el.innerHTML = h;
      return;
    }
    const n = sel[0];
    const b = bnds(n) || { x: 0, y: 0, w: 0, h: 0 };
    h += `<section class="ps"><div class="title"><span class="tag">${TYPE_LABEL[n.type]}</span></div><label class="f"><span>Name</span><input type="text" data-k="name" value="${esc(n.name || '')}" aria-label="Layer name"></label></section>`;
    if (chainTo(n.id).some(isAnnGroup)) h += threadSection(n);
    const sized = RESIZABLE.has(n.type);
    if (n.type !== 'CONNECTOR') {
      h += section('Layout', `<div class="grid2">${num('X', 'x', b.x)}${num('Y', 'y', b.y)}${num('W', 'w', b.w, 1, sized ? '' : 'disabled')}${num('H', 'h', b.h, 1, sized && n.type !== 'TEXT' ? '' : 'disabled')}</div>`);
    }
    let look = `<div class="grid2">${num('%', 'opacity', (n.opacity == null ? 1 : n.opacity) * 100, 1, 'min="0" max="100" title="Layer opacity"')}</div>`;
    if (n.type === 'RECT' || n.type === 'ELLIPSE' || n.type === 'SECTION') {
      look += `<div class="grid2 full">${color('Fill', 'fill', n.fill)}${num('%', 'fillOpacity', (n.fillOpacity == null ? 1 : n.fillOpacity) * 100, 1, 'min="0" max="100" title="Fill opacity"')}</div>`;
      look += `<div class="grid2">${color('Stroke', 'stroke', n.stroke)}${num('Wt', 'strokeWidth', n.strokeWidth || 0, 0.5, 'min="0"')}</div>`;
      if (n.type !== 'ELLIPSE') look += `<div class="grid2">${num('Radius', 'radius', n.radius || 0, 1, 'min="0"')}</div>`;
    }
    if (n.type === 'INK') {
      look += `<div class="grid2">${color('Stroke', 'stroke', n.stroke)}${num('Wt', 'strokeWidth', n.strokeWidth || 5, 0.5, 'min="0.5"')}</div>`;
    }
    if (n.type === 'STICKY') {
      look += `<div class="grid2">${color('Note', 'fill', n.fill)}${num('Size', 'fontSize', n.fontSize || 16, 1, 'min="8"')}</div>`;
    }
    if (n.type === 'PATH') {
      look += `<div class="grid2">${color('Fill', 'fill', n.fill)}${color('Outline', 'stroke', n.stroke)}${color('Detail', 'detail', n.detail)}${num('Wt', 'strokeWidth', n.strokeWidth || 0, 0.2, 'min="0" title="Outline weight in artboard units"')}</div>`;
    }
    h += section('Appearance', look);
    if (n.type === 'STICKY') {
      h += section('Note text', `<textarea class="f" data-k="text" rows="4" aria-label="Note text">${esc(n.text || '')}</textarea>`);
    }
    if (n.type === 'TEXT') {
      const runsNote = n.runs && n.runs.length > 1 ? '<p class="help">This text has more than one colour. Editing the words here makes it one colour.</p>' : '';
      h += section('Text', `<textarea class="f" data-k="text" rows="3" aria-label="Text content">${esc(C.plainText(n))}</textarea>${runsNote}
        <div class="grid2">${num('Size', 'fontSize', n.fontSize || 16, 1, 'min="1"')}
        <label class="f"><select data-k="fontWeight" aria-label="Weight">${[400, 500, 600, 700].map((w) => `<option value="${w}"${(n.fontWeight || 400) == w ? ' selected' : ''}>${{ 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold' }[w]}</option>`).join('')}</select></label>
        ${num('Line', 'lineHeight', n.lineHeight || 1.25, 0.05, 'min="0.5" title="Line height"')}${color('Colour', 'color', n.color)}</div>
        <div class="seg" role="group" aria-label="Alignment">${['left', 'center', 'right'].map((a) => `<button data-set="align" data-v="${a}" aria-pressed="${(n.align || 'left') === a}">${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}</div>
        <label class="chk"><input type="checkbox" data-k="autoWidth"${n.autoWidth ? ' checked' : ''}> Auto width (no wrapping)</label>`);
    }
    if (n.type === 'CONNECTOR') {
      const nm = (ep) => (ep && ep.id && node(ep.id) ? node(ep.id).name : 'a point');
      h += section('Connector', `<p class="help">From “${esc(nm(n.from))}” to “${esc(nm(n.to))}”.</p>
        <label class="f"><span>Label</span><input type="text" data-k="label" value="${esc(n.label || '')}" aria-label="Label"></label>
        <div class="grid2">${color('Line', 'stroke', n.stroke)}${num('Wt', 'strokeWidth', n.strokeWidth || 2, 0.5, 'min="0.5"')}${num('Label', 'labelSize', n.labelSize || 14, 1, 'min="6" title="Label size"')}
        ${num('Curve', 'bend', n.bend || 0, 5, 'title="Curve: positive bends up, negative bends down"')}${num('Gap', 'gap', Array.isArray(n.gap) ? n.gap[0] : n.gap || 0, 1, 'min="0" title="Space left at each end"')}</div>
        <label class="chk"><input type="checkbox" data-k="dash"${n.dash ? ' checked' : ''}> Dashed line</label>
        <label class="chk"><input type="checkbox" data-k="arrow"${n.arrow !== false ? ' checked' : ''}> Arrowhead</label>`);
    }
    if (n.type === 'GROUP') h += section('Group', `<p class="help">${n.children.length} layers. Double-click on the canvas to work inside it.</p><button class="btn wide" data-cmd="ungroup">Ungroup <span class="kbd">⇧⌘G</span></button>`);
    h += exportSection(`Export “${n.name || TYPE_LABEL[n.type]}”`);
    el.innerHTML = h;
  }

  function exportSection(label) {
    return section('Export', `<div class="grid2"><label class="f"><select id="exFormat" aria-label="Format"><option value="svg">SVG</option><option value="png">PNG</option></select></label>
      <label class="f"><select id="exScale" aria-label="PNG scale"><option value="1">1x</option><option value="2" selected>2x</option><option value="3">3x</option></select></label></div>
      <label class="chk"><input type="checkbox" id="exEmbed" checked> Embed fonts, so text looks the same anywhere</label>
      <button class="btn primary wide" data-cmd="export">${esc(label)}</button>
      <button class="btn wide" data-cmd="copy-svg">Copy SVG code</button>`);
  }

  function applyProp(key, raw, target) {
    const sel = selNodes();
    if (key === 'pageName') { const v = String(raw).trim(); if (v) mutate(() => { page().name = v; }); return; }
    if (!sel.length) return;
    const val = typeof raw === 'string' ? raw.trim() : raw;
    const numVal = parseFloat(val);
    if (sel.length > 1) {
      if ((key === 'x' || key === 'y') && Number.isFinite(numVal)) {
        const u = unionOf(sel);
        const d = numVal - u[key];
        mutate(() => topLevelSel().forEach((n) => C.moveNode(n, key === 'x' ? d : 0, key === 'y' ? d : 0)));
      }
      return;
    }
    const n = sel[0];
    const colorVal = (v) => (v === '' || /^none$/i.test(v) ? null : /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? (v[0] === '#' ? v : '#' + v).toUpperCase() : undefined);
    mutate(() => {
      switch (key) {
        case 'name': if (val) n.name = val; break;
        case 'x': case 'y': {
          if (!Number.isFinite(numVal)) break;
          const b = bnds(n);
          C.moveNode(n, key === 'x' ? numVal - b.x : 0, key === 'y' ? numVal - b.y : 0);
          break;
        }
        case 'w': case 'h':
          if (Number.isFinite(numVal) && numVal > 0) { n[key] = numVal; if (n.type === 'TEXT') n.autoWidth = false; }
          break;
        case 'opacity': case 'fillOpacity':
          if (Number.isFinite(numVal)) n[key] = Math.max(0, Math.min(1, numVal / 100));
          break;
        case 'fill': case 'stroke': case 'detail': case 'color': {
          const c = colorVal(val);
          if (c !== undefined) {
            n[key] = c;
            if (key === 'stroke' && c && !n.strokeWidth && n.type !== 'PATH') n.strokeWidth = 1;
            if (key === 'color' && n.runs) delete n.runs;
            if (key === 'stroke' && n.strokes) n.strokes = n.strokes.map((st) => ({ ...st, stroke: c }));
          }
          break;
        }
        case 'bend':
          if (Number.isFinite(numVal)) n.bend = numVal;
          break;
        case 'strokeWidth': case 'radius': case 'fontSize': case 'lineHeight': case 'labelSize': case 'gap':
          if (Number.isFinite(numVal) && numVal >= 0) {
            n[key] = numVal;
            if (key === 'strokeWidth' && n.strokes) n.strokes = n.strokes.map((st) => ({ ...st, strokeWidth: numVal }));
          }
          break;
        case 'fontWeight': n.fontWeight = +val; break;
        case 'text': n.text = String(raw); delete n.runs; break;
        case 'label': n.label = String(raw); break;
        case 'autoWidth': n.autoWidth = !!target.checked; if (!n.autoWidth && !n.w) n.w = bnds(n).w; break;
        case 'dash': n.dash = target.checked ? '8 5' : null; break;
        case 'arrow': n.arrow = !!target.checked; break;
      }
    });
  }

  $('#props').addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'showResolved') { setShowResolved(t.checked); return; }
    if (!t.dataset.k) return;
    applyProp(t.dataset.k, t.type === 'checkbox' ? t.checked : t.value, t);
  });
  $('#props').addEventListener('keydown', (e) => {
    if (e.target.id === 'replyText' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); command('reply'); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
    e.stopPropagation();
  });
  $('#props').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.align) align(b.dataset.align);
    if (b.dataset.set === 'align') mutate(() => { selNodes()[0].align = b.dataset.v; });
    if (b.dataset.cmd) command(b.dataset.cmd);
    if (b.dataset.intent) { const n = selNodes()[0]; if (n) mutate(() => { n.intent = b.dataset.intent; }); return; }
    if (b.dataset.resolve) { resolveAnn(b.dataset.resolve, true); return; }
    if (b.dataset.reopen) { resolveAnn(b.dataset.reopen, false); return; }
    if (b.dataset.ann) {
      const n = node(b.dataset.ann);
      if (!n) return;
      if (hiddenResolved(n)) setShowResolved(true);
      setSel([n.id]);
      zoomToFit([n]);
    }
  });

  /* ---------------- files + export ---------------- */
  const slug = (s) => (s || 'export').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').toLowerCase() || 'export';

  async function saveFile(filename, data) {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) {
        try {
          await dl.save({ filename, data });
          toast(`Saved ${filename}`);
        } catch (err) {
          const code = err && err.code;
          if (code === 'declined') toast('Save cancelled');
          else if (code === 'rate_limited') toast('A save is already waiting for your answer.');
          else toast(`Couldn’t save ${filename} here.`);
        }
        return;
      }
      toast('Saving files isn’t available in this view. Use “Copy SVG code” instead.');
      return;
    }
    const blob = data instanceof Blob ? data : new Blob([data], { type: filename.endsWith('.svg') ? 'image/svg+xml' : 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`Downloaded ${filename}`);
  }

  function exportTargets() {
    const nodes = S.sel.length ? topLevelSel() : page().children;
    const name = S.sel.length === 1 ? (nodes[0].name || TYPE_LABEL[nodes[0].type]) : S.sel.length ? `${page().name} selection` : page().name;
    return { nodes, name };
  }

  async function doExport(format, scale, embed) {
    const { nodes, name } = exportTargets();
    if (!nodes.filter((n) => n.visible !== false).length) { toast('Nothing visible to export.'); return; }
    let fontCss = null;
    if (embed) {
      toast('Preparing export…');
      fontCss = await C.embeddedFontCss();
    }
    const svgText = C.exportSVG(nodes, ctx(), { fontCss, title: name });
    if (format === 'png') {
      const blob = await C.svgToPng(svgText, scale);
      await saveFile(`${slug(name)}@${scale}x.png`, blob);
    } else {
      await saveFile(`${slug(name)}.svg`, svgText);
    }
    if (embed && !fontCss) toast('Fonts couldn’t be embedded here, so the file links to Google Fonts instead.');
  }

  async function copySvg() {
    const { nodes, name } = exportTargets();
    const text = C.exportSVG(nodes, ctx(), { title: name });
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied SVG code (${Math.round(text.length / 1024)} KB)`);
    } catch (e) {
      toast('Your browser blocked clipboard access.');
    }
  }

  function loadDoc(doc, opts = {}) {
    if (opts.history) pushHistory();
    S.doc = doc;
    reindex();
    S.pageId = doc.pages[0].id;
    S.sel = [];
    S.ctxId = null;
    S.views = {};
    S.expanded = new Set();
    walkSections(doc.pages[0].children, (s) => S.expanded.add(s.id));
    for (const p of doc.pages) for (const n of p.children) if (n.type === 'SECTION') S.expanded.add(n.id);
    renderAll();
    zoomToFit();
    scheduleSave();
  }

  // The starting document is named in vellum.config.json, so the editor itself knows no document.
  async function fetchStartDoc() {
    try {
      const cfg = await (await fetch(CONFIG_URL)).json();
      if (!cfg || !cfg.startDocument) return null;
      const doc = await (await fetch(cfg.startDocument)).json();
      return validDoc(doc) ? doc : null;
    } catch (e) {
      return null;
    }
  }

  function labelStartDocCommand(doc) {
    const b = document.querySelector('[data-cmd="sample"]');
    if (b && doc) b.textContent = `Load “${doc.name || 'Untitled'}”`;
  }

  async function loadSample(history) {
    const doc = await fetchStartDoc();
    if (!doc) { toast('Couldn’t load the starting document.'); return; }
    loadDoc(doc, { history });
    toast(`Loaded “${doc.name || 'Untitled'}”`);
  }

  function command(cmd) {
    closeMenus();
    switch (cmd) {
      case 'new': loadDoc(blankDoc(), { history: true }); toast('New file · ⌘Z brings the old one back'); break;
      case 'open': $('#fileInput').click(); break;
      case 'save': saveFile(`${slug(S.doc.name || 'untitled')}.vellum.json`, JSON.stringify(S.doc)); break;
      case 'sample': loadSample(true); break;
      case 'export-page': setSel([]); doExport('svg', 1, true); break;
      case 'export': {
        const f = $('#exFormat'), sc = $('#exScale'), em = $('#exEmbed');
        doExport(f ? f.value : 'svg', sc ? +sc.value : 2, em ? em.checked : true);
        break;
      }
      case 'copy-svg': copySvg(); break;
      case 'group': groupSel(); break;
      case 'combine': combineAnnotations(); break;
      case 'ungroup': ungroupSel(); break;
      case 'theme': toggleTheme(); break;
      case 'place-image': $('#imageInput').click(); break;
      case 'reply': {
        const n = selNodes()[0];
        const ta = $('#replyText');
        const v = ta ? ta.value.trim() : '';
        if (!n || !v) { if (ta) ta.focus(); break; }
        mutate(() => {
          n.replies = [...(n.replies || []), { id: C.newId(), author: 'user', text: v, at: new Date().toISOString() }];
          // A follow-up on a resolved annotation means there is more to do.
          if (isResolved(n)) { delete n.status; delete n.resolvedAt; delete n.resolvedBy; }
        });
        toast('Follow-up added');
        break;
      }
      case 'resolve': { const n = selNodes()[0]; if (n) resolveAnn(n.id, true); break; }
      case 'reopen': { const n = selNodes()[0]; if (n) resolveAnn(n.id, false); break; }
      case 'delete-resolved': {
        const g = annGroup(page(), false);
        if (g && g.children.some(isResolved)) { mutate(() => { g.children = g.children.filter((x) => !isResolved(x)); }); toast('Resolved annotations deleted · ⌘Z to undo'); }
        break;
      }
      case 'clear-ann': {
        const g = annGroup(page(), false);
        if (g && g.children.length) { mutate(() => { g.children = []; S.sel = []; }); toast('Annotations cleared · ⌘Z to undo'); }
        break;
      }
    }
  }

  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (!validDoc(doc)) throw new Error('shape');
      doc.name = doc.name || f.name.replace(/\.(vellum\.)?json$/i, '');
      loadDoc(doc, { history: true });
      toast(`Opened ${f.name}`);
    } catch (err) {
      toast(`${f.name} isn’t a Vellum file. Save one from File › Save file.`);
    }
  });

  /* ---------------- menus, theme, toast ---------------- */
  function closeMenus() {
    $('#fileMenu').hidden = true;
    $('#fileBtn').setAttribute('aria-expanded', 'false');
    $('#colorMenu').hidden = true;
    $('#colorBtn').setAttribute('aria-expanded', 'false');
  }
  $('#fileBtn').addEventListener('click', (e) => {
    const m = $('#fileMenu');
    const open = m.hidden;
    closeMenus();
    if (open) {
      const r = e.currentTarget.getBoundingClientRect();
      m.style.left = `${r.left}px`;
      m.style.top = `${r.bottom + 6}px`;
      m.hidden = false;
      e.currentTarget.setAttribute('aria-expanded', 'true');
    }
    e.stopPropagation();
  });
  $('#fileMenu').addEventListener('click', (e) => { const b = e.target.closest('[data-cmd]'); if (b) command(b.dataset.cmd); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

  function toggleTheme() {
    const rootEl = document.documentElement;
    const dark = rootEl.dataset.theme ? rootEl.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    rootEl.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, rootEl.dataset.theme); } catch (e) { /* convenience only */ }
  }
  try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* ignore */ }

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ---------------- toolbar wiring ---------------- */
  for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('#zoomOut').addEventListener('click', () => zoomBy(0.8));
  $('#zoomLabel').addEventListener('click', () => zoomToFit());
  $('#exportBtn').addEventListener('click', () => doExport('svg', 1, true));
  $('#ctxExit').addEventListener('click', () => { setCtx(null); setSel([]); });
  $('#sketchDone').addEventListener('click', finishSketch);
  $('#sketchNew').addEventListener('click', () => { S.sketchId = null; renderChrome(); toast('Your next stroke starts a new sketch'); });
  $('#toggleLeft').addEventListener('click', () => { $('#left').classList.toggle('open'); $('#right').classList.remove('open'); });
  $('#toggleRight').addEventListener('click', () => { $('#right').classList.toggle('open'); $('#left').classList.remove('open'); });

  /* ---------------- keyboard ---------------- */
  const typing = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === ' ') { if (!S.spaceDown) { S.spaceDown = true; svg.classList.add('panning'); } e.preventDefault(); return; }
    if (mod) {
      const map = {
        z: () => (e.shiftKey ? redo() : undo()), y: redo, d: duplicateSel, a: selectAll, c: copySel, v: paste,
        x: () => { copySel(); deleteSel(); }, g: () => (e.shiftKey ? ungroupSel() : groupSel()),
        ']': () => reorder(e.altKey || e.shiftKey ? 2 : 1), '[': () => reorder(e.altKey || e.shiftKey ? -2 : -1),
        '}': () => reorder(2), '{': () => reorder(-2),
        h: () => (e.shiftKey ? toggleProp('visible') : null), l: () => (e.shiftKey ? toggleProp('locked') : null),
        s: () => command('save'), o: () => command('open'), e: () => (e.shiftKey ? command('export-page') : null),
      };
      if (map[k]) { e.preventDefault(); map[k](); }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.25); }
      else if (e.key === '-') { e.preventDefault(); zoomBy(0.8); }
      return;
    }
    if (e.shiftKey && e.code === 'Digit1') { zoomToFit(); return; }
    if (e.shiftKey && e.code === 'Digit2') { zoomToFit(S.sel.length ? topLevelSel() : null); return; }
    if (e.shiftKey && e.code === 'Digit0') { const s = stageSize(); zoomAt(s.w / 2, s.h / 2, 1); return; }
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSel(); return;
      case 'Escape': escape(); return;
      case 'ArrowLeft': e.preventDefault(); nudge(-step, 0); return;
      case 'ArrowRight': e.preventDefault(); nudge(step, 0); return;
      case 'ArrowUp': e.preventDefault(); nudge(0, -step); return;
      case 'ArrowDown': e.preventDefault(); nudge(0, step); return;
      case 'Enter': {
        const n = selNodes()[0];
        if (n && S.sel.length === 1 && (n.type === 'TEXT' || n.type === 'STICKY')) { e.preventDefault(); startEdit(n, false); }
        else if (n && S.sel.length === 1 && n.children && n.children.length) { e.preventDefault(); if (n.type === 'GROUP') setCtx(n.id); setSel(n.children.map((c) => c.id)); }
        return;
      }
      case '+': case '=': zoomBy(1.25); return;
      case '-': zoomBy(0.8); return;
    }
    const tools = { v: 'move', h: 'hand', r: 'rect', o: 'ellipse', t: 'text', c: 'connector', p: 'pen', a: 'arrow', m: 'mark', n: 'note' };
    if (tools[k] && !e.altKey) setTool(tools[k]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { S.spaceDown = false; svg.classList.remove('panning'); }
  });

  /* ---------------- boot ---------------- */
  async function fontsReady() {
    const want = ['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 16px Inter`));
    await Promise.race([Promise.all(want), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
  }
  document.fonts.addEventListener('loadingdone', () => {
    mcache.clear();
    C.clearTextCache();
    if (S.doc) { renderContent(); renderOverlay(); }
  });

  async function boot() {
    setTool('move');
    let stored = null;
    try { const raw = localStorage.getItem(STORE_KEY); if (raw) stored = JSON.parse(raw); } catch (e) { stored = null; }
    await fontsReady();
    mcache.clear();
    C.clearTextCache();
    const sample = await fetchStartDoc();
    labelStartDocCommand(sample);
    if (validDoc(stored)) {
      // An autosaved copy of an older version of the starting document (same `sample` tag, lower
      // `sampleVersion`) gets the new version; the old copy stays one undo away.
      if (sample && sample.sample && stored.sample === sample.sample && (stored.sampleVersion || 1) < (sample.sampleVersion || 1)) {
        S.doc = stored;
        reindex();
        S.pageId = stored.pages[0].id;
        for (const pg of sample.pages) {
          const old = stored.pages.find((x) => x.id === pg.id);
          const g = old && old.children.find(isAnnGroup);
          if (g) { pg.children = pg.children.filter((n) => !isAnnGroup(n)); pg.children.push(JSON.parse(JSON.stringify(g))); }
        }
        loadDoc(sample, { history: true });
        toast(`Loaded the updated “${sample.name || 'Untitled'}” · ⌘Z brings back your previous copy`, 6000);
        return;
      }
      loadDoc(stored);
      return;
    }
    loadDoc(sample || blankDoc());
  }

  // Small scripting surface for the browser console.
  window.vellum = {
    get doc() { return S.doc; },
    get selection() { return selNodes(); },
    select: (ids) => setSel(ids),
    mutate: (fn) => mutate(() => fn(S.doc)),
    exportSVG: (ids, opts) => C.exportSVG((ids || S.sel).map(node), ctx(), opts),
  };

  boot().then(initSync);
})();
