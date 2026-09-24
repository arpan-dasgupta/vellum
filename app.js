/* Vellum editor. Depends on core.js (window.VellumCore). */
(() => {
  'use strict';
  const C = window.VellumCore;
  const $ = (s) => document.querySelector(s);
  const esc = C.esc;
  const STORE_KEY = 'vellum:doc:v1';
  const THEME_KEY = 'vellum:theme';
  const SAMPLE_URL = 'samples/fog-of-war.json';
  const RESIZABLE = new Set(['RECT', 'ELLIPSE', 'PATH', 'SECTION', 'TEXT']);
  const TYPE_LABEL = { RECT: 'Rectangle', ELLIPSE: 'Ellipse', TEXT: 'Text', PATH: 'Vector', GROUP: 'Group', SECTION: 'Section', CONNECTOR: 'Connector' };

  /* ---------------- state ---------------- */
  const S = {
    doc: null, pageId: null, index: null,
    sel: [], ctxId: null, tool: 'move',
    view: { x: 0, y: 0, z: 1 }, views: {},
    hover: null, expanded: new Set(), editing: null,
    past: [], future: [], clipboard: null, pasteCount: 0,
    spaceDown: false, drag: null,
  };

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
    content.innerHTML = C.renderList(page().children, ctx(), {});
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
      if (chain[i].type === 'SECTION') continue;
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
    const chain = chainTo(id).slice(0, -1).filter((n) => n.type === 'GROUP');
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
        if (n.visible === false || n.locked) continue;
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
    if (target.type === 'TEXT') { startEdit(target, false); return true; }
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

  /* ---------------- text editing ---------------- */
  function startEdit(n, selectAll) {
    S.editing = n.id;
    S.sel = [n.id];
    editor.hidden = false;
    editor.value = C.plainText(n);
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
    } else if (v !== C.plainText(n)) {
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
    setSel(list.filter((n) => n.visible !== false && !n.locked).map((n) => n.id), { reveal: false });
  }
  function escape() {
    if (S.drag) return;
    if (S.sel.length) {
      const p = parentOf(S.sel[0]);
      if (p && !isPage(p) && p.type === 'GROUP') {
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
  };
  function setTool(t) {
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
        const hidden = n.visible === false;
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
      h += exportSection(`Export “${pg.name}”`);
      h += section('Shortcuts', `<dl class="keys">
        <dt>Move · Hand</dt><dd>V · H</dd><dt>Rectangle · Ellipse</dt><dd>R · O</dd><dt>Text · Connector</dt><dd>T · C</dd>
        <dt>Group · Ungroup</dt><dd>⌘G · ⇧⌘G</dd><dt>Duplicate</dt><dd>⌘D</dd><dt>Copy · Paste</dt><dd>⌘C · ⌘V</dd>
        <dt>Bring forward · back</dt><dd>⌘] · ⌘[</dd><dt>Hide · Lock</dt><dd>⇧⌘H · ⇧⌘L</dd>
        <dt>Zoom to fit · selection</dt><dd>⇧1 · ⇧2</dd><dt>Zoom 100%</dt><dd>⇧0</dd><dt>Undo · Redo</dt><dd>⌘Z · ⇧⌘Z</dd></dl>`);
      el.innerHTML = h;
      return;
    }
    if (sel.length > 1) {
      const u = unionOf(sel);
      h += section(`${sel.length} layers`, `<div class="grid2">${num('X', 'x', u && u.x)}${num('Y', 'y', u && u.y)}</div>
        <div class="grid3">${[['left', '⇤'], ['hcenter', '↔'], ['right', '⇥'], ['top', '⤒'], ['vcenter', '↕'], ['bottom', '⤓']].map(([k, g]) => `<button class="btn" data-align="${k}" title="Align ${k}" aria-label="Align ${k}">${g}</button>`).join('')}</div>
        <button class="btn wide" data-cmd="group">Group selection  <span class="kbd">⌘G</span></button>`);
      h += exportSection('Export selection');
      el.innerHTML = h;
      return;
    }
    const n = sel[0];
    const b = bnds(n) || { x: 0, y: 0, w: 0, h: 0 };
    h += `<section class="ps"><div class="title"><span class="tag">${TYPE_LABEL[n.type]}</span></div><label class="f"><span>Name</span><input type="text" data-k="name" value="${esc(n.name || '')}" aria-label="Layer name"></label></section>`;
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
    if (n.type === 'PATH') {
      look += `<div class="grid2">${color('Fill', 'fill', n.fill)}${color('Outline', 'stroke', n.stroke)}${color('Detail', 'detail', n.detail)}${num('Wt', 'strokeWidth', n.strokeWidth || 0, 0.2, 'min="0" title="Outline weight in artboard units"')}</div>`;
    }
    h += section('Appearance', look);
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
        <div class="grid2">${color('Line', 'stroke', n.stroke)}${num('Wt', 'strokeWidth', n.strokeWidth || 2, 0.5, 'min="0.5"')}${num('Label', 'labelSize', n.labelSize || 14, 1, 'min="6" title="Label size"')}</div>
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
          }
          break;
        }
        case 'strokeWidth': case 'radius': case 'fontSize': case 'lineHeight': case 'labelSize':
          if (Number.isFinite(numVal) && numVal >= 0) n[key] = numVal;
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
    if (!t.dataset.k) return;
    applyProp(t.dataset.k, t.type === 'checkbox' ? t.checked : t.value, t);
  });
  $('#props').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
    e.stopPropagation();
  });
  $('#props').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.align) align(b.dataset.align);
    if (b.dataset.set === 'align') mutate(() => { selNodes()[0].align = b.dataset.v; });
    if (b.dataset.cmd) command(b.dataset.cmd);
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

  async function loadSample(history) {
    try {
      const doc = await (await fetch(SAMPLE_URL)).json();
      loadDoc(doc, { history });
      toast('Loaded the Fog of War sample');
    } catch (e) {
      toast('Couldn’t load the sample file.');
    }
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
      case 'ungroup': ungroupSel(); break;
      case 'theme': toggleTheme(); break;
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
        if (n && S.sel.length === 1 && n.type === 'TEXT') { e.preventDefault(); startEdit(n, false); }
        else if (n && S.sel.length === 1 && n.children && n.children.length) { e.preventDefault(); if (n.type === 'GROUP') setCtx(n.id); setSel(n.children.map((c) => c.id)); }
        return;
      }
      case '+': case '=': zoomBy(1.25); return;
      case '-': zoomBy(0.8); return;
    }
    const tools = { v: 'move', h: 'hand', r: 'rect', o: 'ellipse', t: 'text', c: 'connector' };
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
    let sample = null;
    try { sample = await (await fetch(SAMPLE_URL)).json(); } catch (e) { sample = null; }
    if (!validDoc(sample)) sample = null;
    if (validDoc(stored)) {
      // An autosaved copy of an older sample gets the new sample; the old copy stays one undo away.
      const tag = stored.sample || (stored.name === 'Fog of War' ? 'fog-of-war' : null);
      if (sample && tag === sample.sample && (stored.sampleVersion || 1) < (sample.sampleVersion || 1)) {
        S.doc = stored;
        reindex();
        S.pageId = stored.pages[0].id;
        loadDoc(sample, { history: true });
        toast('Loaded the updated Fog of War boards · ⌘Z brings back your previous copy', 6000);
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

  boot();
})();
