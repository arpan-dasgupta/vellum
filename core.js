/* Vellum core: document model helpers, text layout, bounds and SVG rendering.
 * Pure functions. The only environment dependency is `ctx.measure(text, cssFont)`,
 * which the editor and the headless exporter both supply from a canvas.
 *
 * Coordinates are absolute page coordinates for every node. Groups have no
 * geometry of their own (their bounds are the union of their children);
 * sections do, and moving either moves all descendants.
 */
(function (root) {
  'use strict';

  const DEFAULT_FONT = "Inter, 'Helvetica Neue', Arial, sans-serif";
  // The & is escaped because this goes inside an SVG <style> element, which must be valid XML.
  const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&amp;display=swap');";
  const CONTAINER = new Set(['GROUP', 'SECTION']);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const r2 = (v) => Math.round(v * 100) / 100;

  /* ---------- tree helpers ---------- */

  function buildIndex(doc) {
    const map = new Map();
    const parent = new Map();
    for (const page of doc.pages) {
      map.set(page.id, page);
      (function walk(list, p) {
        for (const n of list) {
          map.set(n.id, n);
          parent.set(n.id, p);
          if (n.children) walk(n.children, n);
        }
      })(page.children, page);
    }
    return { map, parent };
  }

  function walk(list, fn) {
    for (const n of list) {
      fn(n);
      if (n.children) walk(n.children, fn);
    }
  }

  /* ---------- text ---------- */

  let layoutCache = new WeakMap();
  function clearTextCache() { layoutCache = new WeakMap(); }

  function fontCss(n) {
    return `${n.fontWeight || 400} ${n.fontSize || 16}px ${n.fontFamily || DEFAULT_FONT}`;
  }

  function textRuns(n) {
    return n.runs && n.runs.length ? n.runs : [{ text: n.text || '', color: n.color }];
  }

  function plainText(n) {
    return textRuns(n).map((r) => r.text).join('');
  }

  function layoutText(n, measure) {
    const sig = JSON.stringify([n.text, n.runs, n.fontSize, n.fontWeight, n.fontFamily, n.lineHeight, n.autoWidth, n.w, n.color]);
    const hit = layoutCache.get(n);
    if (hit && hit.sig === sig) return hit.layout;

    const fs = n.fontSize || 16;
    const lh = (n.lineHeight || 1.25) * fs;
    const font = fontCss(n);
    const base = n.color || '#1E1E1E';
    const paras = [[]];
    for (const run of textRuns(n)) {
      for (const ch of run.text) {
        if (ch === '\n') paras.push([]);
        else paras[paras.length - 1].push({ ch, color: run.color || base });
      }
    }
    const wrap = !n.autoWidth && n.w > 0;
    const raw = [];
    for (const p of paras) {
      if (!wrap) { raw.push(p); continue; }
      let line = [];
      let lineText = '';
      let i = 0;
      while (i < p.length) {
        let j = i;
        while (j < p.length && p[j].ch !== ' ') j++;
        while (j < p.length && p[j].ch === ' ') j++;
        const word = p.slice(i, j);
        const wt = word.map((c) => c.ch).join('');
        const trial = (lineText + wt).replace(/\s+$/, '');
        if (line.length && measure(trial, font) > n.w + 0.5) {
          raw.push(line);
          line = word.slice();
          lineText = wt;
        } else {
          line = line.concat(word);
          lineText += wt;
        }
        i = j;
      }
      raw.push(line);
    }
    let maxW = 0;
    const lines = raw.map((l) => {
      const t = l.map((c) => c.ch).join('').replace(/\s+$/, '');
      const width = measure(t, font);
      maxW = Math.max(maxW, width);
      const spans = [];
      for (const c of l) {
        const last = spans[spans.length - 1];
        if (last && last.color === c.color) last.text += c.ch;
        else spans.push({ text: c.ch, color: c.color });
      }
      if (spans.length) spans[spans.length - 1].text = spans[spans.length - 1].text.replace(/\s+$/, '');
      return { spans, width };
    });
    const layout = {
      lines,
      width: wrap ? n.w : Math.max(1, maxW),
      height: Math.max(1, lines.length) * lh,
      lh,
      fs,
      font,
    };
    layoutCache.set(n, { sig, layout });
    return layout;
  }

  /* ---------- geometry ---------- */

  function union(list) {
    const bs = list.filter(Boolean);
    if (!bs.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const b of bs) {
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function bounds(n, ctx) {
    switch (n.type) {
      case 'GROUP': {
        const vis = n.children.filter((c) => c.visible !== false);
        return union((vis.length ? vis : n.children).map((c) => bounds(c, ctx)));
      }
      case 'TEXT': {
        const L = layoutText(n, ctx.measure);
        return { x: n.x, y: n.y, w: L.width, h: L.height };
      }
      case 'CONNECTOR': {
        const g = connectorGeom(n, ctx);
        if (!g) return null;
        const b = union([{ x: g.p1.x, y: g.p1.y, w: 0, h: 0 }, { x: g.p2.x, y: g.p2.y, w: 0, h: 0 }, { x: g.mid.x, y: g.mid.y, w: 0, h: 0 }, g.label]);
        return b;
      }
      case 'INK': {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, r = 0;
        for (const st of inkStrokes(n)) {
          r = Math.max(r, (st.strokeWidth || n.strokeWidth || 4) / 2);
          for (const [x, y] of st.points) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
        }
        if (x1 === Infinity) return null;
        return { x: x1 - r, y: y1 - r, w: x2 - x1 + 2 * r, h: y2 - y1 + 2 * r };
      }
      case 'STICKY':
        return { x: n.x, y: n.y, w: n.w, h: stickyHeight(n, ctx) };
      default:
        return { x: n.x, y: n.y, w: n.w, h: n.h };
    }
  }

  function center(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

  function anchorPoint(b, side, toward, at, ep) {
    const f = at == null ? 0.5 : at;
    if (side === 'POINT' && ep) return { x: b.x + b.w * (ep.fx == null ? 0.5 : ep.fx), y: b.y + b.h * (ep.fy == null ? 0.5 : ep.fy) };
    let s = side || 'AUTO';
    if (s === 'AUTO') {
      const c = center(b);
      const dx = toward.x - c.x, dy = toward.y - c.y;
      s = Math.abs(dx) * b.h >= Math.abs(dy) * b.w ? (dx >= 0 ? 'RIGHT' : 'LEFT') : (dy >= 0 ? 'BOTTOM' : 'TOP');
    }
    switch (s) {
      case 'RIGHT': return { x: b.x + b.w, y: b.y + b.h * f };
      case 'LEFT': return { x: b.x, y: b.y + b.h * f };
      case 'TOP': return { x: b.x + b.w * f, y: b.y };
      case 'BOTTOM': return { x: b.x + b.w * f, y: b.y + b.h };
      default: return center(b);
    }
  }

  function endpointBounds(ep, ctx) {
    if (!ep) return null;
    if (ep.id) {
      const node = ctx.index.map.get(ep.id);
      return node ? bounds(node, ctx) : null;
    }
    if (typeof ep.x === 'number') return { x: ep.x, y: ep.y, w: 0, h: 0 };
    return null;
  }

  function connectorGeom(n, ctx) {
    const ba = endpointBounds(n.from, ctx);
    const bb = endpointBounds(n.to, ctx);
    if (!ba || !bb) return null;
    let p1 = anchorPoint(ba, n.from.side, center(bb), n.from.at, n.from);
    let p2 = anchorPoint(bb, n.to.side, center(ba), n.to.at, n.to);
    // `bend` lifts the middle of the line into a curve (positive bends up for left-to-right lines).
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const c = n.bend ? { x: (p1.x + p2.x) / 2 + uy * n.bend * 2, y: (p1.y + p2.y) / 2 - ux * n.bend * 2 } : null;
    // `gap` leaves space between each end and the layer it attaches to.
    const [g1, g2] = Array.isArray(n.gap) ? n.gap : [n.gap || 0, n.gap || 0];
    const unit = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
    if (g1) { const t = unit(p1, c || p2); p1 = { x: p1.x + t.x * g1, y: p1.y + t.y * g1 }; }
    if (g2) { const t = unit(c || p1, p2); p2 = { x: p2.x - t.x * g2, y: p2.y - t.y * g2 }; }
    const mid = c ? { x: 0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x, y: 0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y } : { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    let label = null;
    if (n.label) {
      const L = layoutText(labelNode(n), ctx.measure);
      const w = L.width + 20, h = L.height + 8;
      label = { x: mid.x - w / 2, y: mid.y - h / 2, w, h, L };
    }
    return { p1, p2, c, mid, label };
  }

  const STICKY_PAD = 14;
  function stickyText(n) {
    const sig = [n.text, n.w, n.fontSize, n.color].join('\u0000');
    if (!n._stickyText || n._stickyText._sig !== sig) {
      Object.defineProperty(n, '_stickyText', {
        value: { type: 'TEXT', text: n.text || '', fontSize: n.fontSize || 16, fontWeight: 500, autoWidth: false,
          w: Math.max(10, n.w - STICKY_PAD * 2), lineHeight: 1.35, color: n.color || '#1E1E1E', _sig: sig },
        enumerable: false, configurable: true, writable: true,
      });
    }
    return n._stickyText;
  }
  function stickyHeight(n, ctx) {
    const L = layoutText(stickyText(n), ctx.measure);
    return Math.max(n.h || 0, L.height + STICKY_PAD * 2);
  }
  // An INK node holds one or more strokes: `strokes: [{points, stroke?, strokeWidth?}]`.
  // Older single-stroke nodes use `points` directly.
  function inkStrokes(n) {
    if (n.strokes) return n.strokes;
    return n.points ? [{ points: n.points }] : [];
  }
  function inkPath(points) {
    if (!points.length) return '';
    const f = (v) => r2(v);
    if (points.length < 3) return `M${f(points[0][0])},${f(points[0][1])} L${points.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}`;
    let d = `M${f(points[0][0])},${f(points[0][1])}`;
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i];
      const [nx, ny] = points[i + 1];
      d += ` Q${f(x)},${f(y)} ${f((x + nx) / 2)},${f((y + ny) / 2)}`;
    }
    const last = points[points.length - 1];
    return d + ` L${f(last[0])},${f(last[1])}`;
  }

  function labelNode(n) {
    if (!n._labelNode || n._labelNode.text !== n.label || n._labelNode.fontSize !== (n.labelSize || 14)) {
      Object.defineProperty(n, '_labelNode', {
        value: { type: 'TEXT', text: n.label, fontSize: n.labelSize || 14, fontWeight: 600, autoWidth: true, lineHeight: 1.25, color: n.labelColor || '#1E1E1E' },
        enumerable: false, configurable: true, writable: true,
      });
    }
    return n._labelNode;
  }

  /* ---------- rendering ---------- */

  function paint(color, opacity) {
    if (!color) return 'none';
    return color;
  }

  function strokeAttrs(n) {
    if (!n.stroke || !n.strokeWidth) return '';
    return ` stroke="${esc(n.stroke)}" stroke-width="${r2(n.strokeWidth)}"`;
  }

  function fillAttrs(n) {
    const f = paint(n.fill);
    let s = ` fill="${esc(f)}"`;
    if (n.fill && n.fillOpacity != null && n.fillOpacity < 1) s += ` fill-opacity="${r2(n.fillOpacity)}"`;
    return s;
  }

  function textSvg(n, ctx, x, y, L, align, width) {
    const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
    const ax = align === 'center' ? x + width / 2 : align === 'right' ? x + width : x;
    const baseColor = n.color || '#1E1E1E';
    let out = `<text font-family="${esc(n.fontFamily || DEFAULT_FONT)}" font-size="${r2(L.fs)}" font-weight="${n.fontWeight || 400}" fill="${esc(baseColor)}" text-anchor="${anchor}" xml:space="preserve">`;
    L.lines.forEach((line, i) => {
      const by = y + i * L.lh + L.lh / 2 + L.fs * 0.35;
      out += `<tspan x="${r2(ax)}" y="${r2(by)}">`;
      if (!line.spans.length) out += ' ';
      for (const sp of line.spans) {
        out += sp.color === baseColor ? esc(sp.text) : `<tspan fill="${esc(sp.color)}">${esc(sp.text)}</tspan>`;
      }
      out += '</tspan>';
    });
    return out + '</text>';
  }

  function renderNode(n, ctx, opts) {
    if (n.visible === false) return '';
    // Resolved annotations are hidden unless the editor asks to show them faded.
    const resolved = n.status === 'resolved';
    if (resolved && opts.resolved !== 'fade') return '';
    const inner = renderInner(n, ctx, opts);
    if (!inner) return '';
    const o = (n.opacity == null ? 1 : n.opacity) * (resolved ? 0.3 : 1);
    const op = o < 1 ? ` opacity="${r2(o)}"` : '';
    if (opts.forExport) {
      if (CONTAINER.has(n.type)) return `<g id="${esc(safeId(n))}"${op}>${inner}</g>`;
      return op ? `<g${op}>${inner}</g>` : inner;
    }
    return `<g data-id="${esc(n.id)}"${op}>${inner}</g>`;
  }

  function safeId(n) {
    return (n.name || n.id).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || n.id;
  }

  function renderInner(n, ctx, opts) {
    switch (n.type) {
      case 'RECT': {
        const rx = n.radius ? ` rx="${r2(n.radius)}"` : '';
        return `<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}"${rx}${fillAttrs(n)}${strokeAttrs(n)}/>`;
      }
      case 'ELLIPSE':
        return `<ellipse cx="${r2(n.x + n.w / 2)}" cy="${r2(n.y + n.h / 2)}" rx="${r2(n.w / 2)}" ry="${r2(n.h / 2)}"${fillAttrs(n)}${strokeAttrs(n)}/>`;
      case 'TEXT': {
        const L = layoutText(n, ctx.measure);
        return textSvg(n, ctx, n.x, n.y, L, n.align || 'left', L.width);
      }
      case 'PATH': {
        const sx = n.w / (n.vw || 100), sy = n.h / (n.vh || 100);
        const sw = n.strokeWidth || 0;
        const detail = n.detail || n.stroke || '#1E1E1E';
        let body = '';
        for (const p of n.paths || []) {
          if (p.role === 'ink') body += `<path d="${esc(p.d)}" fill="none" stroke="${esc(detail)}" stroke-width="${r2(sw)}" stroke-linecap="round"/>`;
          else if (p.role === 'dot') body += `<path d="${esc(p.d)}" fill="${esc(detail)}"/>`;
          else body += `<path d="${esc(p.d)}" fill="${esc(paint(n.fill))}"${n.stroke && sw ? ` stroke="${esc(n.stroke)}" stroke-width="${r2(sw)}"` : ''} stroke-linejoin="round"/>`;
        }
        return `<g transform="translate(${r2(n.x)} ${r2(n.y)}) scale(${r2(sx * 1000) / 1000} ${r2(sy * 1000) / 1000})">${body}</g>`;
      }
      case 'IMAGE':
        if (!n.src) return '';
        return `<image href="${esc(n.src)}" xlink:href="${esc(n.src)}" x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}" preserveAspectRatio="xMidYMid meet"/>`;
      case 'INK':
        return inkStrokes(n).filter((st) => st.points && st.points.length).map((st) =>
          `<path d="${inkPath(st.points)}" fill="none" stroke="${esc(st.stroke || n.stroke || '#E8503A')}" stroke-width="${r2(st.strokeWidth || n.strokeWidth || 4)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
      case 'STICKY': {
        const h = stickyHeight(n, ctx);
        const tn = stickyText(n);
        const L = layoutText(tn, ctx.measure);
        let out = `<rect x="${r2(n.x)}" y="${r2(n.y + 3)}" width="${r2(n.w)}" height="${r2(h)}" rx="6" fill="#000000" fill-opacity="0.08"/>`;
        out += `<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(h)}" rx="6" fill="${esc(n.fill || '#FFECBD')}"/>`;
        if (n.text) out += textSvg(tn, ctx, n.x + STICKY_PAD, n.y + STICKY_PAD, L, 'left', L.width);
        return out;
      }
      case 'GROUP':
        return n.children.map((c) => renderNode(c, ctx, opts)).join('');
      case 'SECTION': {
        const rx = n.radius != null ? n.radius : 12;
        const frame = `<rect x="${r2(n.x)}" y="${r2(n.y)}" width="${r2(n.w)}" height="${r2(n.h)}" rx="${r2(rx)}"${fillAttrs(n)}${strokeAttrs(n)}/>`;
        return frame + n.children.map((c) => renderNode(c, ctx, opts)).join('');
      }
      case 'CONNECTOR': {
        const g = connectorGeom(n, ctx);
        if (!g) return '';
        const { p1, p2, c } = g;
        const sw = n.strokeWidth || 2;
        const col = n.stroke || '#1E1E1E';
        // Arrowhead direction follows the line's tangent at the end.
        const from = c || p1;
        const dx = p2.x - from.x, dy = p2.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const ah = n.arrow === false ? 0 : (n.headSize || Math.max(10, sw * 4));
        const aw = ah * 0.9;
        const end = { x: p2.x - ux * ah * 0.85, y: p2.y - uy * ah * 0.85 };
        const dash = n.dash ? ` stroke-dasharray="${n.dash === true ? `${sw * 3.4} ${sw * 2}` : esc(n.dash)}"` : '';
        let s = c
          ? `<path d="M${r2(p1.x)},${r2(p1.y)} Q${r2(c.x)},${r2(c.y)} ${r2(end.x)},${r2(end.y)}" fill="none" stroke="${esc(col)}" stroke-width="${r2(sw)}" stroke-linecap="round"${dash}/>`
          : `<line x1="${r2(p1.x)}" y1="${r2(p1.y)}" x2="${r2(end.x)}" y2="${r2(end.y)}" stroke="${esc(col)}" stroke-width="${r2(sw)}"${dash}/>`;
        if (ah) {
          const bx = p2.x - ux * ah, by = p2.y - uy * ah;
          const px = -uy * aw / 2, py = ux * aw / 2;
          s += `<polygon points="${r2(p2.x)},${r2(p2.y)} ${r2(bx + px)},${r2(by + py)} ${r2(bx - px)},${r2(by - py)}" fill="${esc(col)}"/>`;
        }
        if (g.label) {
          const lb = g.label;
          s += `<rect x="${r2(lb.x)}" y="${r2(lb.y)}" width="${r2(lb.w)}" height="${r2(lb.h)}" rx="6" fill="${esc(n.labelFill || '#FFFFFF')}"/>`;
          s += textSvg(labelNode(n), ctx, lb.x, lb.y + 4, lb.L, 'center', lb.w);
        }
        // A fat invisible line makes thin connectors easy to click in the editor.
        if (!opts.forExport) {
          s += c
            ? `<path d="M${r2(p1.x)},${r2(p1.y)} Q${r2(c.x)},${r2(c.y)} ${r2(p2.x)},${r2(p2.y)}" fill="none" stroke="transparent" stroke-width="${r2(Math.max(12, sw * 4))}"/>`
            : `<line x1="${r2(p1.x)}" y1="${r2(p1.y)}" x2="${r2(p2.x)}" y2="${r2(p2.y)}" stroke="transparent" stroke-width="${r2(Math.max(12, sw * 4))}"/>`;
        }
        return s;
      }
      default:
        return '';
    }
  }

  function renderList(list, ctx, opts) {
    return list.map((n) => renderNode(n, ctx, opts || {})).join('');
  }

  /* Export a set of nodes as a standalone SVG document cropped to their bounds. */
  function exportSVG(nodes, ctx, opts) {
    opts = opts || {};
    const vis = nodes.filter((n) => n.visible !== false);
    const b = opts.bounds || union(vis.map((n) => bounds(n, ctx))) || { x: 0, y: 0, w: 1, h: 1 };
    const pad = opts.padding || 0;
    const x = b.x - pad, y = b.y - pad, w = b.w + pad * 2, h = b.h + pad * 2;
    let body = '';
    if (opts.background) body += `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${esc(opts.background)}"/>`;
    body += renderList(vis, ctx, { forExport: true });
    const title = opts.title ? `<title>${esc(opts.title)}</title>` : '';
    const fonts = opts.fontCss || FONT_IMPORT;
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r2(w)}" height="${r2(h)}" viewBox="${r2(x)} ${r2(y)} ${r2(w)} ${r2(h)}">${title}<style>${fonts}</style>${body}</svg>`;
  }

  /* Browser only: fetch Inter (latin subset) and return @font-face CSS with the font
   * inlined as a data URI, so an exported SVG renders identically offline and inside
   * <img>/canvas. Resolves null where fonts.gstatic.com can't be fetched. */
  let fontCssPromise = null;
  function embeddedFontCss() {
    if (!fontCssPromise) {
      fontCssPromise = (async () => {
        const css = await (await fetch('https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap')).text();
        const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g;
        const faces = [];
        let m;
        while ((m = re.exec(css))) {
          if (m[1] !== 'latin') continue;
          const src = /url\(([^)]+)\)/.exec(m[2]);
          if (!src) continue;
          const blob = await (await fetch(src[1].replace(/['"]/g, ''))).blob();
          const dataUrl = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(blob);
          });
          faces.push('@font-face{' + m[2].replace(/url\([^)]+\)/, `url(${dataUrl.replace('application/octet-stream', 'font/woff2')})`) + '}');
        }
        return faces.length ? faces.join('') : null;
      })().catch(() => null);
    }
    return fontCssPromise;
  }

  /* Browser only: rasterise an SVG string to a PNG Blob. */
  async function svgToPng(svg, scale) {
    const m = /width="([\d.]+)" height="([\d.]+)"/.exec(svg);
    const w = +m[1], h = +m[2];
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((res) => c.toBlob(res, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- mutation helpers ---------- */

  function moveNode(n, dx, dy) {
    if (n.type === 'INK') {
      const shift = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
      if (n.strokes) n.strokes = n.strokes.map((st) => ({ ...st, points: shift(st.points) }));
      if (n.points) n.points = shift(n.points);
      return;
    }
    if (n.type === 'CONNECTOR') {
      if (n.from && !n.from.id) { n.from.x += dx; n.from.y += dy; }
      if (n.to && !n.to.id) { n.to.x += dx; n.to.y += dy; }
      return;
    }
    if (typeof n.x === 'number' && n.type !== 'GROUP') { n.x += dx; n.y += dy; }
    if (n.children) for (const c of n.children) moveNode(c, dx, dy);
  }

  let idCounter = 0;
  function newId() {
    idCounter = (idCounter + 1) % 1e6;
    return 'v' + Date.now().toString(36) + idCounter.toString(36) + Math.random().toString(36).slice(2, 5);
  }

  /* Deep-clone nodes with fresh ids, rewiring connectors that point inside the clone. */
  function cloneWithNewIds(nodes) {
    const remap = new Map();
    const copy = JSON.parse(JSON.stringify(nodes));
    walk(copy, (n) => { const id = newId(); remap.set(n.id, id); n.id = id; });
    walk(copy, (n) => {
      if (n.type === 'CONNECTOR') {
        if (n.from && n.from.id && remap.has(n.from.id)) n.from.id = remap.get(n.from.id);
        if (n.to && n.to.id && remap.has(n.to.id)) n.to.id = remap.get(n.to.id);
      }
    });
    return copy;
  }

  root.VellumCore = {
    DEFAULT_FONT, FONT_IMPORT, CONTAINER, STICKY_PAD,
    esc, buildIndex, walk, layoutText, clearTextCache, plainText, fontCss, bounds, union, center,
    connectorGeom, stickyText, inkStrokes, renderNode, renderList, exportSVG, embeddedFontCss, svgToPng, moveNode, newId, cloneWithNewIds,
  };
})(typeof window !== 'undefined' ? window : globalThis);
