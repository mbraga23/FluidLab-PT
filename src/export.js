// Sheet export: SVG, PNG and PDF.
//
// The sheet is already SVG, so SVG/PNG export is mostly a matter of making it
// *standalone*: the live document leans on the page's stylesheet and on a viewport
// transform, neither of which survives leaving the browser. So the exported copy gets
// its own inlined styles, a viewBox around the actual content, and none of the editor's
// furniture.
//
// PNG goes through an <img> of the serialised SVG rather than a canvas re-draw, which
// keeps the two outputs guaranteed identical instead of two renderers to keep in sync.
//
// PDF cannot reuse that trick — there is no <canvas>-to-PDF primitive, and the project
// takes no dependency that would hand us one (no pdf-lib, no jsPDF). A schematic only
// ever needs lines, rects, circles, polygons, the M/L/Q/A subset of <path>, and text, so
// a hand-written PDF 1.4 writer plus an SVG-shape-to-PDF-path converter is a bounded
// problem, not an open-ended one. See the "PDF export" section below for the design:
// it is deliberately split into a DOM-free core (shapes-as-data in, PDF bytes out) and a
// thin DOM-walking collector, so the core is unit-testable under plain Node.

import { DOMAIN_LABEL } from './partslist.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Styles the sheet needs to stand on its own, with the CSS variables already resolved. */
const EXPORT_CSS = `
  .sym { fill: none; stroke: #14171a; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .sym.thin { stroke-width: 1.1; }
  .sym.fill { fill: #14171a; stroke: none; }
  .sym.fill-soft { fill: #cfd6dd; stroke: #14171a; stroke-width: 1.4; }
  .sym.barrel { fill: #ffffff; }
  .sym.dash { stroke-dasharray: 4 3; stroke-width: 1.2; }
  .sym.live-fill { fill: rgba(229,72,77,0.25); stroke: #e5484d; }
  .sym.lamp-on { fill: #ffcc33; stroke: #a67c00; }
  .needle { stroke: #e5484d; stroke-width: 1.6; stroke-linecap: round; fill: none; }
  .sym-label, .sym-port, .sym-tag {
    fill: #14171a; stroke: none;
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  }
  .sym-port { font-size: 8px; fill: #6b7883; }
  .sym-tag { font-size: 9px; font-weight: 500; fill: #3d4750; }
  .wire { fill: none; stroke: #99a3ad; stroke-width: 2; stroke-linecap: round; }
  .wire.electric { stroke: #5a646d; }
  .junction { fill: #14171a; stroke: none; }
`;

/**
 * Clones the parts+wires layers, stripped of editor furniture (selection boxes, hit
 * targets; port dots live in their own `#layer-ports` and are never cloned in the first
 * place). Shared by every export path — SVG, PNG and PDF — so they cannot end up drawing
 * different pictures of the same sheet.
 *
 * Returns the group plus its bbox in the sheet's own local coordinate space (the space
 * `#viewport`'s children are laid out in, unaffected by the live pan/zoom transform that
 * sits on `#viewport` itself) — the same space PDF shape matrices are expressed in.
 */
function buildContentLayer(sheetEl) {
  const parts = sheetEl.querySelector('#layer-parts');
  const wires = sheetEl.querySelector('#layer-wires');
  if (!parts || !parts.childNodes.length) return null;

  const g = document.createElementNS(SVG_NS, 'g');
  g.appendChild(wires.cloneNode(true));
  const partsCopy = parts.cloneNode(true);
  partsCopy.querySelectorAll('.sel-box, .hit').forEach((n) => n.remove());
  g.appendChild(partsCopy);

  // Measure in the live document — a detached SVG has no layout, so getBBox() throws.
  const box = sheetEl.querySelector('#viewport').getBBox();
  return { g, bbox: { x: box.x, y: box.y, w: box.width, h: box.height } };
}

/**
 * Serialises the sheet to a standalone SVG string.
 * `title` is written into the drawing as a title block, because an exported schematic
 * with no identification is a schematic nobody can file.
 */
export function sheetToSVG(sheetEl, { title = 'Esquema', margin = 40 } = {}) {
  const content = buildContentLayer(sheetEl);
  if (!content) return null;
  const { g, bbox: b } = content;

  const clone = document.createElementNS(SVG_NS, 'svg');
  clone.setAttribute('xmlns', SVG_NS);

  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = EXPORT_CSS;
  clone.appendChild(style);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('fill', '#ffffff');
  clone.appendChild(bg);

  clone.appendChild(g);

  const w = Math.ceil(b.w + margin * 2);
  const h = Math.ceil(b.h + margin * 2 + 28);
  const x = Math.floor(b.x - margin);
  const y = Math.floor(b.y - margin);

  clone.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  bg.setAttribute('x', x); bg.setAttribute('y', y);
  bg.setAttribute('width', w); bg.setAttribute('height', h);

  const block = document.createElementNS(SVG_NS, 'g');
  const rule = document.createElementNS(SVG_NS, 'line');
  rule.setAttribute('x1', x + margin / 2); rule.setAttribute('y1', y + h - 22);
  rule.setAttribute('x2', x + w - margin / 2); rule.setAttribute('y2', y + h - 22);
  rule.setAttribute('stroke', '#ccd2da');
  block.appendChild(rule);

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', x + margin / 2);
  label.setAttribute('y', y + h - 8);
  label.setAttribute('class', 'sym-tag');
  label.textContent = `${title} · FluidLab · ${new Date().toLocaleDateString('pt-BR')}`;
  block.appendChild(label);
  clone.appendChild(block);

  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function exportSVG(sheetEl, title) {
  const svg = sheetToSVG(sheetEl, { title });
  if (!svg) return false;
  download(new Blob([svg], { type: 'image/svg+xml' }), `${slug(title)}.svg`);
  return true;
}

/** Rasterises the same SVG, so PNG and SVG can never disagree. */
export async function exportPNG(sheetEl, title, scale = 2) {
  const svg = sheetToSVG(sheetEl, { title });
  if (!svg) return false;

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('Não foi possível converter o SVG em imagem'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    download(blob, `${slug(title)}.png`);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const slug = (s) => String(s).toLowerCase()
  .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'esquema';

// =============================================================================
// PDF export
// =============================================================================
//
// Layered so the geometry/PDF-writing code (the part worth testing hard) never touches
// the DOM:
//
//   collectShapes(sheetEl)              DOM: clones the sheet, flattens it into plain
//                                        shape objects + their accumulated transform
//   buildPdfFromShapes(shapes, bbox)    pure: shapes-as-data in, PDF bytes out
//     -> shapesToContentStream          pure: shape -> PDF path/text operators
//     -> buildPDF                       pure: content streams -> a valid PDF file
//
// `exportPDF` just wires the two ends together and triggers the download, same shape as
// exportSVG/exportPNG above.

// --- 2D affine matrices -----------------------------------------------------
//
// Every symbol is drawn in its own local box; the sheet places it with an SVG
// transform="translate(...) rotate(...)" on a wrapping <g>, and directional valves add a
// further translate() on the sliding "spool" group. None of that survives flattening to
// absolute coordinates unless we track it, so collectShapes() walks the cloned tree
// accumulating a matrix per shape. Lines/circles/Beziers are affine-invariant, so once a
// shape's local geometry is expressed as (poly)lines and cubic Beziers, applying the
// accumulated matrix — rotation, translation, and the final SVG-to-PDF flip — is exact
// regardless of how many nested transforms it is built from. That is also why arcs and
// quadratics get converted to cubics in *local* space, before any matrix is applied.

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Composes two matrices so that matMul(A, B) applied to a point equals A(B(point)). */
function matMul(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

function matPoint(M, x, y) {
  return [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f];
}

/**
 * Parses `transform="translate(...) rotate(...)"` attributes into a matrix. Scoped to the
 * two functions main.js actually emits (part placement + the valve spool slide) — no
 * scale()/matrix()/skew(), and no relative shorthands, because nothing in this codebase
 * writes those into the sheet.
 */
function parseTransformAttr(str) {
  let M = IDENTITY;
  const re = /(translate|rotate)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(str || ''))) {
    const nums = m[2].trim().split(/[\s,]+/).map(Number);
    let F;
    if (m[1] === 'translate') {
      const [tx, ty = 0] = nums;
      F = { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
    } else {
      const [deg, cx = 0, cy = 0] = nums;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const R = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      F = (cx || cy) ? matMul(matMul({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, R),
                               { a: 1, b: 0, c: 0, d: 1, e: -cx, f: -cy })
                     : R;
    }
    M = matMul(M, F);
  }
  return M;
}

// --- path geometry: SVG shapes -> local-space (poly)lines and cubic Beziers -----------

/** Quadratic Bezier elevated to cubic — PDF's path operators have no `Q`. */
function quadToCubic(p0, p1, p2) {
  return {
    c1: [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])],
    c2: [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])],
    to: p2,
  };
}

/** One circular/elliptical-arc segment of at most 90°, as a cubic Bezier (standard
 * "kappa" construction — the classic 4-cubic circle approximation generalised to an
 * arbitrary sub-arc). */
function arcSegmentToCubic(cx, cy, rx, ry, phi, t1, t2) {
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const pt = (t) => {
    const x = rx * Math.cos(t), y = ry * Math.sin(t);
    return [cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y];
  };
  const deriv = (t) => {
    const dx = -rx * Math.sin(t), dy = ry * Math.cos(t);
    return [cosPhi * dx - sinPhi * dy, sinPhi * dx + cosPhi * dy];
  };
  const alpha = (Math.sin(t2 - t1) * (Math.sqrt(4 + 3 * Math.tan((t2 - t1) / 2) ** 2) - 1)) / 3;
  const p0 = pt(t1), p3 = pt(t2), d1 = deriv(t1), d2 = deriv(t2);
  return {
    c1: [p0[0] + alpha * d1[0], p0[1] + alpha * d1[1]],
    c2: [p3[0] - alpha * d2[0], p3[1] - alpha * d2[1]],
    to: p3,
  };
}

/** SVG elliptical-arc endpoint parameterisation (`A rx ry rot large-arc sweep x y`)
 * converted to center parameterisation (SVG 1.1 Appendix F.6), then split into
 * <=90° cubic segments. */
function arcToCubics(p0, rx, ry, xAxisRotDeg, largeArc, sweep, p1) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-9 || ry < 1e-9 || (p0[0] === p1[0] && p0[1] === p1[1])) {
    return [{ c1: p0, c2: p1, to: p1 }]; // degenerate arc: draw as a straight segment
  }
  const phi = (xAxisRotDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx2 = (p0[0] - p1[0]) / 2, dy2 = (p0[1] - p1[1]) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rxs = rx * rx, rys = ry * ry;
  const x1ps = x1p * x1p, y1ps = y1p * y1p;
  const lambda = x1ps / rxs + y1ps / rys;
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; rxs = rx * rx; rys = ry * ry; }

  const sign = largeArc !== sweep ? 1 : -1;
  const num0 = Math.max(rxs * rys - rxs * y1ps - rys * x1ps, 0);
  const co = sign * Math.sqrt(num0 / (rxs * y1ps + rys * x1ps || 1e-12));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (p0[0] + p1[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (p0[1] + p1[1]) / 2;

  const angleBetween = (ux, uy, vx, vy) => {
    const sgn = ux * vy - uy * vx < 0 ? -1 : 1;
    const dot = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))));
    return sgn * Math.acos(dot);
  };
  const theta1 = angleBetween(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angleBetween((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segs;
  const cubics = [];
  for (let i = 0, t1 = theta1; i < segs; i++, t1 += delta) {
    cubics.push(arcSegmentToCubic(cx, cy, rx, ry, phi, t1, t1 + delta));
  }
  return cubics;
}

/** Parses the M/L/Q/A/Z subset of `d` that src/symbols.js and src/catalog*.js actually
 * emit (absolute commands only — nothing in this codebase writes relative path data)
 * into subpaths of lines and cubic Beziers, in the path's own local coordinate space. */
function parsePathD(d) {
  const subpaths = [];
  const cmdRe = /([MLQAZ])([^MLQAZ]*)/gi;
  const numRe = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
  let cur = null, cx = 0, cy = 0, startX = 0, startY = 0, m;
  while ((m = cmdRe.exec(d))) {
    const cmd = m[1].toUpperCase();
    const nums = (m[2].match(numRe) || []).map(Number);
    if (cmd === 'M') {
      const [x, y] = nums;
      cur = { start: [x, y], closed: false, segs: [] };
      subpaths.push(cur);
      cx = startX = x; cy = startY = y;
      for (let i = 2; i + 1 < nums.length; i += 2) {
        cur.segs.push({ type: 'line', to: [nums[i], nums[i + 1]] });
        cx = nums[i]; cy = nums[i + 1];
      }
    } else if (cmd === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cur.segs.push({ type: 'line', to: [nums[i], nums[i + 1]] });
        cx = nums[i]; cy = nums[i + 1];
      }
    } else if (cmd === 'Q') {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const c = quadToCubic([cx, cy], [nums[i], nums[i + 1]], [nums[i + 2], nums[i + 3]]);
        cur.segs.push({ type: 'cubic', ...c });
        cx = nums[i + 2]; cy = nums[i + 3];
      }
    } else if (cmd === 'A') {
      for (let i = 0; i + 6 < nums.length; i += 7) {
        const [rx, ry, rot, laf, sf, x, y] = nums.slice(i, i + 7);
        for (const c of arcToCubics([cx, cy], rx, ry, rot, !!laf, !!sf, [x, y])) {
          cur.segs.push({ type: 'cubic', ...c });
        }
        cx = x; cy = y;
      }
    } else if (cmd === 'Z') {
      if (cur) cur.closed = true;
      cx = startX; cy = startY;
    }
  }
  return subpaths;
}

const KAPPA = 0.5522847498307936;

function circleToSubpaths(cx, cy, r) {
  const k = KAPPA * r;
  return [{
    start: [cx + r, cy],
    closed: true,
    segs: [
      { type: 'cubic', c1: [cx + r, cy + k], c2: [cx + k, cy + r], to: [cx, cy + r] },
      { type: 'cubic', c1: [cx - k, cy + r], c2: [cx - r, cy + k], to: [cx - r, cy] },
      { type: 'cubic', c1: [cx - r, cy - k], c2: [cx - k, cy - r], to: [cx, cy - r] },
      { type: 'cubic', c1: [cx + k, cy - r], c2: [cx + r, cy - k], to: [cx + r, cy] },
    ],
  }];
}

/** Normalises any shape symbols.js draws into local-space subpaths ready for
 * transformSubpath(). Text has no path geometry and is handled separately in
 * shapesToContentStream(). */
function shapeToLocalSubpaths(shape) {
  switch (shape.type) {
    case 'line':
      return [{ start: [shape.x1, shape.y1], closed: false, segs: [{ type: 'line', to: [shape.x2, shape.y2] }] }];
    case 'rect': {
      const { x, y, w, h } = shape;
      return [{
        start: [x, y],
        closed: true,
        segs: [{ type: 'line', to: [x + w, y] }, { type: 'line', to: [x + w, y + h] }, { type: 'line', to: [x, y + h] }],
      }];
    }
    case 'circle':
      return circleToSubpaths(shape.cx, shape.cy, shape.r);
    case 'polygon': {
      const [first, ...rest] = shape.points;
      return [{ start: first, closed: true, segs: rest.map((p) => ({ type: 'line', to: p })) }];
    }
    case 'path':
      return parsePathD(shape.d);
    default:
      return [];
  }
}

function transformSubpath(sp, M) {
  const tp = (p) => matPoint(M, p[0], p[1]);
  return {
    closed: sp.closed,
    start: tp(sp.start),
    segs: sp.segs.map((s) => (s.type === 'line'
      ? { type: 'line', to: tp(s.to) }
      : { type: 'cubic', c1: tp(s.c1), c2: tp(s.c2), to: tp(s.to) })),
  };
}

const num = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function subpathsToOps(subpaths) {
  let out = '';
  for (const sp of subpaths) {
    out += `${num(sp.start[0])} ${num(sp.start[1])} m\n`;
    for (const s of sp.segs) {
      out += s.type === 'line'
        ? `${num(s.to[0])} ${num(s.to[1])} l\n`
        : `${num(s.c1[0])} ${num(s.c1[1])} ${num(s.c2[0])} ${num(s.c2[1])} ${num(s.to[0])} ${num(s.to[1])} c\n`;
    }
    if (sp.closed) out += 'h\n';
  }
  return out;
}

// --- style: a hand-maintained mirror of EXPORT_CSS -------------------------
//
// The DOM-free core has no CSS cascade to lean on (and pulling one in just for this would
// be exactly the kind of dependency the project avoids), so shape style is resolved from
// the SVG `class` attribute directly, replicating EXPORT_CSS's rules one-for-one. If
// EXPORT_CSS changes, this needs to change with it — there is no automatic sync.

function styleFor(clsAttr) {
  const t = new Set(String(clsAttr || '').split(/\s+/).filter(Boolean));
  const s = { stroke: null, fill: null, strokeWidth: 1.6, dash: null, fontSize: 16 };

  if (t.has('sym')) {
    s.stroke = '#14171a';
    if (t.has('thin')) s.strokeWidth = 1.1;
    if (t.has('fill')) { s.fill = '#14171a'; s.stroke = null; }
    if (t.has('fill-soft')) { s.fill = '#cfd6dd'; s.stroke = '#14171a'; s.strokeWidth = 1.4; }
    if (t.has('barrel')) s.fill = '#ffffff';
    if (t.has('dash')) { s.dash = [4, 3]; s.strokeWidth = 1.2; }
    if (t.has('live-fill')) { s.fill = 'rgba(229,72,77,0.25)'; s.stroke = '#e5484d'; }
    if (t.has('lamp-on')) { s.fill = '#ffcc33'; s.stroke = '#a67c00'; }
    return s;
  }
  if (t.has('needle')) return { ...s, stroke: '#e5484d' };
  if (t.has('wire')) return { ...s, stroke: t.has('electric') ? '#5a646d' : '#99a3ad', strokeWidth: 2 };
  if (t.has('junction')) return { ...s, fill: '#14171a' };
  if (t.has('sym-label') || t.has('sym-port') || t.has('sym-tag')) {
    const st = { ...s, fill: '#14171a', fontSize: 16 }; // .sym-label sets no font-size in EXPORT_CSS -> UA default
    if (t.has('sym-port')) { st.fontSize = 8; st.fill = '#6b7883'; }
    if (t.has('sym-tag')) { st.fontSize = 9; st.fill = '#3d4750'; }
    return st;
  }
  return s; // e.g. the invisible .wire-hit hit-target: no stroke, no fill, paints nothing
}

function colorRGB(spec) {
  if (spec[0] === '#') {
    const n = parseInt(spec.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const [r, g, b, a = 1] = spec.slice(spec.indexOf('(') + 1, -1).split(',').map(Number);
  // No transparency group in this minimal writer: flatten the rgba() onto the white sheet
  // instead. Correct as long as nothing else is drawn under a translucent fill, which
  // holds here — live-fill only ever sits directly on the white background.
  return [(r * a + 255 * (1 - a)) / 255, (g * a + 255 * (1 - a)) / 255, (b * a + 255 * (1 - a)) / 255];
}

// --- text: WinAnsi encoding, escaping, and Helvetica metrics ----------------

// Typographic characters used by this file's own title-block/table text that fall
// outside Latin-1 and would otherwise dead-end at the '?' fallback below.
// Characters above Latin-1 that WinAnsi *does* have, plus the ones it does not and that
// this project's German strings are full of. The second group has no WinAnsi codepoint at
// all, so it degrades to the nearest ASCII rather than to "?": the minus sign U+2212 is
// not the hyphen U+002D, and a title like "A− B−" printed as "A? B?" until this existed.
const WIN_ANSI_HIGH = {
  0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2026: 0x85, 0x201e: 0x84,
  // No WinAnsi equivalent — nearest ASCII.
  0x2212: 0x2d, 0x2010: 0x2d, 0x2011: 0x2d,   // minus / hyphens
  0x00a0: 0x20, 0x2009: 0x20, 0x202f: 0x20,   // non-breaking and thin spaces
  0x2191: 0x5e, 0x2193: 0x76,                 // GRAFCET edge arrows
  0x0394: 0x44, 0x2264: 0x3c, 0x2265: 0x3e,   // delta, <=, >=
  0x00b7: 0xb7,                               // middot is genuinely in WinAnsi
};

function toWinAnsiByte(codePoint) {
  // WinAnsiEncoding (Windows-1252) matches Latin-1 exactly across 0x20-0xFF, which
  // covers ASCII, Portuguese accents and German umlauts/ß.
  if (codePoint >= 0x20 && codePoint <= 0xff) return codePoint;
  if (WIN_ANSI_HIGH[codePoint] !== undefined) return WIN_ANSI_HIGH[codePoint];
  return 0x3f; // '?' — no glyph for it in a base-14 font anyway
}

/** WinAnsi-encodes and backslash-escapes a string for a PDF `(...)` literal. Handwritten
 * PDFs die exactly here: an un-escaped `)` in a component label truncates the string and
 * desyncs every byte offset after it. */
export function escapePdfText(str) {
  let out = '';
  for (const ch of String(str)) {
    const byte = toWinAnsiByte(ch.codePointAt(0));
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\' + String.fromCharCode(byte);
    else out += String.fromCharCode(byte);
  }
  return out;
}

// Helvetica glyph widths (1/1000 em), the standard AFM metrics for the ASCII range. Used
// only to right/center-align short labels (port letters, tags) and to truncate table
// cells — accented characters fall back to the average width below, which is close
// enough for the German umlauts that appear in the title block.
const HELV_WIDTHS = {
  32: 278, 33: 278, 34: 355, 35: 556, 36: 556, 37: 889, 38: 667, 39: 191, 40: 333, 41: 333,
  42: 389, 43: 584, 44: 278, 45: 333, 46: 278, 47: 278, 48: 556, 49: 556, 50: 556, 51: 556,
  52: 556, 53: 556, 54: 556, 55: 556, 56: 556, 57: 556, 58: 278, 59: 278, 60: 584, 61: 584,
  62: 584, 63: 556, 64: 1015, 65: 667, 66: 667, 67: 722, 68: 722, 69: 667, 70: 611, 71: 778,
  72: 722, 73: 278, 74: 500, 75: 667, 76: 556, 77: 833, 78: 722, 79: 778, 80: 667, 81: 778,
  82: 722, 83: 667, 84: 611, 85: 722, 86: 667, 87: 944, 88: 667, 89: 667, 90: 611, 91: 278,
  92: 278, 93: 278, 94: 469, 95: 556, 96: 333, 97: 556, 98: 556, 99: 500, 100: 556, 101: 556,
  102: 278, 103: 556, 104: 556, 105: 222, 106: 222, 107: 500, 108: 222, 109: 833, 110: 556,
  111: 556, 112: 556, 113: 556, 114: 333, 115: 500, 116: 278, 117: 556, 118: 500, 119: 722,
  120: 500, 121: 500, 122: 500, 123: 334, 124: 260, 125: 334, 126: 584,
};
const HELV_AVG = 556;

function textWidthEm(str) {
  let w = 0;
  for (const ch of String(str)) w += (HELV_WIDTHS[ch.codePointAt(0)] ?? HELV_AVG) / 1000;
  return w;
}

function truncateToWidth(str, sizePt, maxWidth) {
  str = String(str ?? '');
  if (textWidthEm(str) * sizePt <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && textWidthEm(s + '…') * sizePt > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

// --- page geometry -----------------------------------------------------------

// A4/A3 in PDF points (1pt = 1/72in), portrait base size; pageBox() swaps for landscape.
const PAGE_SIZES = { a4: { w: 595.28, h: 841.89 }, a3: { w: 841.89, h: 1190.55 } };

export function pageBox(format = 'a4', orientation = 'landscape') {
  const { w, h } = PAGE_SIZES[format] || PAGE_SIZES.a4;
  return orientation === 'landscape' ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Builds the SVG-content-space -> PDF-page-space transform: uniform scale to fit `bbox`
 * into the page minus margins and a bottom title-block strip, centred in the leftover
 * space, plus the y-flip PDF needs (SVG y grows down, PDF y grows up).
 */
export function makeTransform(bbox, page, { margin = 36, titleH = 46 } = {}) {
  const left = margin, right = page.width - margin;
  const bottom = margin + titleH, top = page.height - margin;
  const availW = Math.max(right - left, 1), availH = Math.max(top - bottom, 1);
  const scale = Math.min(availW / (bbox.w || 1), availH / (bbox.h || 1));
  const drawW = bbox.w * scale, drawH = bbox.h * scale;
  const drawLeft = left + (availW - drawW) / 2;
  const drawTop = top - (availH - drawH) / 2;
  const matrix = { a: scale, b: 0, c: 0, d: -scale, e: drawLeft - bbox.x * scale, f: drawTop + bbox.y * scale };
  return { scale, matrix, bbox };
}

export function toPdfPoint(t, x, y) {
  return matPoint(t.matrix, x, y);
}

// --- shapes -> PDF content stream --------------------------------------------

function paintOp(style) {
  if (style.fill && style.stroke) return 'B';
  if (style.fill) return 'f';
  if (style.stroke) return 'S';
  return 'n';
}

function shapeGraphicsState(style, scale) {
  let out = '';
  if (style.fill) { const [r, g, b] = colorRGB(style.fill); out += `${num(r)} ${num(g)} ${num(b)} rg\n`; }
  if (style.stroke) {
    const [r, g, b] = colorRGB(style.stroke);
    out += `${num(r)} ${num(g)} ${num(b)} RG\n${num(Math.max(style.strokeWidth * scale, 0.1))} w\n`;
    out += style.dash ? `[${style.dash.map((v) => num(v * scale)).join(' ')}] 0 d\n` : '[] 0 d\n';
  }
  return out;
}

/** Positions text via the PDF text matrix `Tm`, with the local anchor (start/middle/end)
 * resolved before the matrix so it rotates correctly with a rotated part.
 *
 * Every other shape can use the accumulated matrix `M` unmodified because reflecting a
 * filled/stroked path draws the same picture either way. Glyphs are not symmetric that
 * way: `M` carries the SVG-to-PDF y-flip (a reflection), so applying it straight to a
 * glyph's outline would draw the text mirrored. The fix is the standard one — negate the
 * matrix's y-input column (c, d) for the text matrix only, which cancels exactly the one
 * reflection the y-flip introduced while preserving every rotation the part itself has. */
function textOps(shape, M, style) {
  const widthLocal = textWidthEm(shape.text) * style.fontSize;
  const offsetFactor = shape.anchor === 'end' ? 1 : shape.anchor === 'middle' ? 0.5 : 0;
  const [ex, ey] = matPoint(M, shape.x - offsetFactor * widthLocal, shape.y);
  const Tm = { a: M.a, b: M.b, c: -M.c, d: -M.d, e: ex, f: ey };
  const [r, g, b] = colorRGB(style.fill || '#14171a');
  return `q\nBT\n/F1 ${num(style.fontSize)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n`
    + `${num(Tm.a)} ${num(Tm.b)} ${num(Tm.c)} ${num(Tm.d)} ${num(Tm.e)} ${num(Tm.f)} Tm\n`
    + `(${escapePdfText(shape.text)}) Tj\nET\nQ\n`;
}

/** shapes -> PDF drawing operators. Pure and DOM-free: every shape already carries its
 * own accumulated local-space matrix (`shape.M`, from collectShapes' DOM walk, or handed
 * in directly by a test) and gets combined here with the page transform `t`. */
export function shapesToContentStream(shapes, t) {
  let out = '';
  for (const shape of shapes) {
    if (shape.cls === 'wire-hit') continue; // hit-test overlay: never meant to be seen
    const style = styleFor(shape.cls);
    const M = matMul(t.matrix, shape.M || IDENTITY);
    if (shape.type === 'text') {
      if (String(shape.text ?? '').length) out += textOps(shape, M, style);
      continue;
    }
    const subpaths = shapeToLocalSubpaths(shape).map((sp) => transformSubpath(sp, M));
    if (!subpaths.length) continue;
    out += `q\n${shapeGraphicsState(style, t.scale)}${subpathsToOps(subpaths)}${paintOp(style)}\nQ\n`;
  }
  return out;
}

function titleBlockContent(page, margin, titleH, title, dateStr, scalePct) {
  const ruleY = margin + titleH;
  const textY = margin + titleH / 2 - 2;
  const rule = `q\n0.8 0.82 0.85 RG\n1 w\n[] 0 d\n${num(margin)} ${num(ruleY)} m ${num(page.width - margin)} ${num(ruleY)} l S\nQ\n`;
  const label = `${title} · FluidLab · ${dateStr} · Escala ${scalePct}%`;
  const text = `q\nBT\n/F2 9 Tf\n0.24 0.28 0.31 rg\n1 0 0 1 ${num(margin)} ${num(textY)} Tm\n(${escapePdfText(label)}) Tj\nET\nQ\n`;
  return rule + text;
}

function textLine(x, y, str, size, bold, colorHex = '#14171a') {
  const [r, g, b] = colorRGB(colorHex);
  return `q\nBT\n/${bold ? 'F2' : 'F1'} ${num(size)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n`
    + `1 0 0 1 ${num(x)} ${num(y)} Tm\n(${escapePdfText(str)}) Tj\nET\nQ\n`;
}

/** Second page: the bill of materials from buildParts()/src/partslist.js, laid out as a
 * plain text table (proportional columns, so it holds up across A4<->A3 and
 * portrait<->landscape). No pagination for very long lists — noted as a limitation. */
function partsPageContent(page, margin, rows, title, dateStr) {
  const availW = page.width - margin * 2;
  const weights = [0.05, 0.07, 0.16, 0.28, 0.20, 0.14, 0.10];
  const headers = ['Item', 'Qtd.', 'Identificação', 'Componente', 'Especificação', 'Grupo', 'Área'];
  let x = margin;
  const cols = weights.map((wt, i) => { const c = { x, w: availW * wt, label: headers[i] }; x += c.w; return c; });

  let y = page.height - margin;
  let out = textLine(margin, y, `Lista de materiais — ${title}`, 14, true);
  y -= 18;
  out += textLine(margin, y, `FluidLab · ${dateStr}`, 9, false, '#5a646d');
  y -= 20;

  const ruleAt = (yy) => `q\n0.6 0.65 0.7 RG\n0.6 w\n${num(margin)} ${num(yy)} m ${num(page.width - margin)} ${num(yy)} l S\nQ\n`;
  out += ruleAt(y + 4);
  for (const c of cols) out += textLine(c.x, y, c.label, 8, true, '#3d4750');
  y -= 6;
  out += ruleAt(y);
  y -= 14;

  const bottom = margin + 20;
  let shown = 0;
  for (const r of rows) {
    if (y < bottom) break;
    const cells = [String(shown + 1), String(r.count), r.tags.join(' '), r.def.name, r.spec, r.def.group, DOMAIN_LABEL[r.domain] || ''];
    cols.forEach((c, i) => { out += textLine(c.x, y, truncateToWidth(cells[i], 8.5, c.w - 6), 8.5, false); });
    y -= 15;
    shown++;
  }
  if (shown < rows.length) {
    out += textLine(margin, y, `… ${rows.length - shown} itens adicionais não exibidos (sem espaço na página)`, 8, false, '#8a6d1a');
  }
  return { width: page.width, height: page.height, content: out };
}

// --- the PDF writer itself ----------------------------------------------------

function toBytes(binStr) {
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Minimal PDF 1.4 object writer: header, a flat object table, xref, trailer. No object
 * streams or compression — a schematic is small enough that none of PDF's size-saving
 * machinery earns its complexity, and a plain-text xref is something you can eyeball.
 *
 * `pages`: [{ width, height, content }], where `content` is an already-built content
 * stream (from shapesToContentStream + titleBlockContent, or partsPageContent). This
 * function only packages pre-rendered content streams into a valid file; it knows nothing
 * about shapes or shapes' geometry.
 *
 * IDs are allocated up front (1=Catalog, 2=Pages, then page/content/font objects) so every
 * object can reference the others by number before any bytes are written — the classic
 * handwritten-PDF failure mode is emitting a reference to an object whose id or offset
 * doesn't match reality, so both are computed from one place here.
 */
export function buildPDF(pages) {
  const fonts = ['Helvetica', 'Helvetica-Bold'];
  let nextId = 3;
  const pageIds = [], contentIds = [];
  for (let i = 0; i < pages.length; i++) { pageIds.push(nextId++); contentIds.push(nextId++); }
  const fontIds = {};
  for (const f of fonts) fontIds[f] = nextId++;

  const objs = [null];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  const fontDict = fonts.map((f, i) => `/F${i + 1} ${fontIds[f]} 0 R`).join(' ');
  pages.forEach((p, i) => {
    objs[pageIds[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}]`
      + ` /Resources << /Font << ${fontDict} >> >> /Contents ${contentIds[i]} 0 R >>`;
    objs[contentIds[i]] = { stream: p.content };
  });
  fonts.forEach((f) => {
    objs[fontIds[f]] = `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`;
  });

  const maxId = objs.length - 1;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; // binary marker comment, conventional practice
  const offsets = new Array(maxId + 1).fill(0);
  for (let id = 1; id <= maxId; id++) {
    offsets[id] = out.length;
    const val = objs[id];
    out += typeof val === 'string'
      ? `${id} 0 obj\n${val}\nendobj\n`
      : `${id} 0 obj\n<< /Length ${val.stream.length} >>\nstream\n${val.stream}\nendstream\nendobj\n`;
  }

  const xrefStart = out.length;
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return toBytes(out);
}

/**
 * DOM-free core: shapes (plain data, each carrying its accumulated local transform matrix
 * `M` from collectShapes' DOM walk — or built by hand, for tests) plus a content bbox go
 * in; complete PDF bytes come out. `partsRows` is buildParts(circuit)'s output
 * (src/partslist.js) — a second, table-only page listing the bill of materials.
 */
export function buildPdfFromShapes(shapes, bbox, opts = {}) {
  const {
    title = 'Esquema', format = 'a4', orientation = 'landscape',
    margin = 36, titleH = 40, date = new Date(), partsRows = null,
  } = opts;

  const page = pageBox(format, orientation);
  const t = makeTransform(bbox, page, { margin, titleH });
  const dateStr = date.toLocaleDateString('pt-BR');
  const scalePct = Math.round(t.scale * 100);

  const content = shapesToContentStream(shapes, t) + titleBlockContent(page, margin, titleH, title, dateStr, scalePct);
  const pages = [{ width: page.width, height: page.height, content }];
  if (partsRows && partsRows.length) pages.push(partsPageContent(page, margin, partsRows, title, dateStr));

  return buildPDF(pages);
}

// --- DOM collector: SVG element -> plain shape descriptor ---------------------

const SHAPE_TAGS = new Set(['line', 'rect', 'circle', 'polygon', 'path', 'text']);

function elementToLocalShape(el) {
  switch (el.tagName) {
    case 'line':
      return { type: 'line', x1: +el.getAttribute('x1'), y1: +el.getAttribute('y1'), x2: +el.getAttribute('x2'), y2: +el.getAttribute('y2') };
    case 'rect':
      return { type: 'rect', x: +el.getAttribute('x'), y: +el.getAttribute('y'), w: +el.getAttribute('width'), h: +el.getAttribute('height') };
    case 'circle':
      return { type: 'circle', cx: +el.getAttribute('cx'), cy: +el.getAttribute('cy'), r: +el.getAttribute('r') };
    case 'polygon':
      return { type: 'polygon', points: el.getAttribute('points').trim().split(/\s+/).map((p) => p.split(',').map(Number)) };
    case 'path':
      return { type: 'path', d: el.getAttribute('d') };
    case 'text':
      return { type: 'text', x: +el.getAttribute('x'), y: +el.getAttribute('y'), text: el.textContent, anchor: el.getAttribute('text-anchor') || 'middle' };
    default:
      return null;
  }
}

function walkShapes(node, M, out) {
  for (const el of node.children) {
    const attr = el.getAttribute('transform');
    const childM = attr ? matMul(M, parseTransformAttr(attr)) : M;
    if (SHAPE_TAGS.has(el.tagName)) {
      const local = elementToLocalShape(el);
      if (local) out.push({ ...local, M: childM, cls: el.getAttribute('class') || '' });
    }
    walkShapes(el, childM, out);
  }
}

/** The only DOM-touching piece of the PDF path: clones the sheet's content layer (via the
 * same buildContentLayer() the SVG/PNG export use) and flattens it into plain shape
 * objects. Everything downstream of this is pure. */
export function collectShapes(sheetEl) {
  const content = buildContentLayer(sheetEl);
  if (!content) return null;
  const shapes = [];
  walkShapes(content.g, IDENTITY, shapes);
  return { shapes, bbox: content.bbox };
}

/**
 * Public entry point, same shape as exportSVG/exportPNG. `opts.partsRows`, if given,
 * should be `buildParts(circuit)`'s output (src/partslist.js) — export.js has no reason
 * to know about circuit.js, so the caller derives the rows exactly as it already does for
 * the CSV export and hands them in.
 */
export function exportPDF(sheetEl, title, opts = {}) {
  const collected = collectShapes(sheetEl);
  if (!collected) return false;
  const bytes = buildPdfFromShapes(collected.shapes, collected.bbox, { title, ...opts });
  download(new Blob([bytes], { type: 'application/pdf' }), `${slug(title)}.pdf`);
  return true;
}
