// Drawing primitives for ISO 1219 fluid-power symbols.
//
// Everything renders to SVG markup strings in the component's own local coordinate
// space; the editor is responsible for placing and rotating the result. Symbols are
// drawn on a 2px stroke grid at a nominal 32px valve box, which keeps line weights
// legible at 100% zoom without hinting tricks.

export const BOX = 40;      // side of one valve position box
export const GRID = 10;     // sheet snap grid

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

export const line = (x1, y1, x2, y2, cls = 'sym') =>
  `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

export const rect = (x, y, w, h, cls = 'sym', extra = '') =>
  `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" ${extra}/>`;

export const circle = (cx, cy, r, cls = 'sym') =>
  `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`;

export const path = (d, cls = 'sym') => `<path class="${cls}" d="${d}"/>`;

export const poly = (pts, cls = 'sym') =>
  `<polygon class="${cls}" points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}"/>`;

export const text = (x, y, str, cls = 'sym-label', anchor = 'middle') =>
  `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(str)}</text>`;

/** Line ending in a solid arrowhead — the flow-direction mark inside valve boxes. */
export function arrow(x1, y1, x2, y2, cls = 'sym', head = 4.2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  const bx = x2 - ux * head, by = y2 - uy * head;
  return line(x1, y1, x2, y2, cls) + poly([
    [x2, y2],
    [bx + px * head * 0.5, by + py * head * 0.5],
    [bx - px * head * 0.5, by - py * head * 0.5],
  ], `${cls} fill`);
}

/** Double-headed arrow, used for the two-way paths of a shuttle/quick-exhaust body. */
export function arrow2(x1, y1, x2, y2, cls = 'sym') {
  return arrow(x1, y1, x2, y2, cls) + arrow(x2, y2, x1, y1, cls);
}

/** The "blocked port" tee: a stub into the box capped by a perpendicular bar. */
export function blocked(x, y, dir = 'up', len = 9, bar = 7) {
  const s = dir === 'up' ? -1 : 1;
  const ex = x, ey = y + s * len;
  return line(x, y, ex, ey) + line(ex - bar / 2, ey, ex + bar / 2, ey);
}

/** Exhaust triangle (silencer-less vent to atmosphere) hanging off a port. */
export function ventTriangle(x, y, size = 7, dir = 'down') {
  const s = dir === 'down' ? 1 : -1;
  return poly([
    [x, y],
    [x - size / 2, y + s * size],
    [x + size / 2, y + s * size],
  ]);
}

/** Filled triangle: the compressed-air source mark. */
export function sourceTriangle(x, y, size = 9, dir = 'up') {
  const s = dir === 'up' ? -1 : 1;
  return poly([
    [x, y],
    [x - size / 2, y - s * size],
    [x + size / 2, y - s * size],
  ], 'sym fill');
}

/** Helical spring drawn as a zigzag along +x, height h. */
export function spring(x, y, w, h = 14, coils = 4) {
  const step = w / (coils * 2);
  let d = `M ${x} ${y}`;
  for (let i = 0; i < coils * 2; i++) {
    const nx = x + step * (i + 1);
    const ny = y + (i % 2 === 0 ? -h / 2 : h / 2);
    d += ` L ${nx} ${ny}`;
  }
  d += ` L ${x + w} ${y}`;
  return path(d);
}

// ---------------------------------------------------------------------------
// Valve actuators. Each draws into a `w` wide slot on the given side of the box
// group, vertically centred on the spool axis (y = BOX/2).
// ---------------------------------------------------------------------------

export const ACT_W = 16;

export const actuators = {
  spring: (x, w) => spring(x + 2, BOX / 2, w - 4, 13, 4),

  /** Pneumatic pilot: a plain rectangle whose long side faces the box. */
  pilot: (x, w) => rect(x + 2, BOX / 2 - 7, w - 4, 14),

  /** Solenoid: rectangle with the characteristic diagonal. */
  solenoid: (x, w) => rect(x + 2, BOX / 2 - 7, w - 4, 14)
    + line(x + 2, BOX / 2 + 7, x + w - 2, BOX / 2 - 7),

  /** Push button: plunger on a stem. */
  button: (x, w) => line(x + w, BOX / 2, x + 5, BOX / 2)
    + rect(x + 1, BOX / 2 - 6, 4, 12)
    + line(x + 1, BOX / 2, x - 3, BOX / 2),

  /** Roller lever (limit switch). */
  roller: (x, w) => line(x + w, BOX / 2, x + 8, BOX / 2)
    + circle(x + 5, BOX / 2, 3.2)
    + line(x + 8, BOX / 2 - 5, x + 8, BOX / 2 + 5),

  /** Hand lever. */
  lever: (x, w) => line(x + w, BOX / 2, x + 6, BOX / 2)
    + line(x + 6, BOX / 2, x + 1, BOX / 2 - 7)
    + circle(x + 1, BOX / 2 - 7, 2.4, 'sym fill'),

  /** Manual detent (rastend). */
  detent: (x, w) => line(x + w, BOX / 2, x + 6, BOX / 2)
    + path(`M ${x + 6} ${BOX / 2 - 5} L ${x + 2} ${BOX / 2} L ${x + 6} ${BOX / 2 + 5}`),

  /** Air-piloted, pressure-relieved (small triangle feed). */
  pilotAir: (x, w) => rect(x + 4, BOX / 2 - 6, w - 6, 12)
    + line(x, BOX / 2, x + 4, BOX / 2),

  none: () => '',
};

/**
 * Renders a directional control valve.
 *
 * The port stubs are fixed in space over box 0's column and the whole spool group
 * translates by -state*BOX, so switching slides the boxes under the ports exactly the
 * way the ISO animation (and FluidSIM) shows it. `slots` is shared by every box, which
 * is what makes that slide meaningful: box N's internal paths land on the same stubs.
 */
export function drawValve(def, state, opts = {}) {
  const { boxes, slots, actLeft, actRight, vents = [] } = def;
  const n = boxes.length;
  const left = actLeft ? ACT_W : 0;
  const shift = -state * BOX;

  let out = '';

  // Port stubs + labels sit on the static frame.
  for (const [id, s] of Object.entries(slots)) {
    const x = left + s.x;
    if (s.side === 'bottom') {
      out += line(x, BOX, x, BOX + 6);
      if (vents.includes(id)) out += ventTriangle(x, BOX + 6, 7, 'down');
      out += text(x - 3, BOX + 6, id, 'sym-port', 'end');
    } else {
      out += line(x, 0, x, -6);
      out += text(x - 3, -1, id, 'sym-port', 'end');
    }
  }

  // Sliding spool group: boxes and their actuators move together, because they are
  // one rigid body in the real valve.
  let g = '';
  for (let i = 0; i < n; i++) {
    const ox = left + i * BOX;
    g += rect(ox, 0, BOX, BOX);
    const box = boxes[i];

    for (const [a, b] of box.paths || []) {
      const sa = slots[a], sb = slots[b];
      g += arrow(ox + sa.x, sa.side === 'bottom' ? BOX : 0,
                 ox + sb.x, sb.side === 'bottom' ? BOX : 0);
    }
    for (const id of box.blocked || []) {
      const s = slots[id];
      g += blocked(ox + s.x, s.side === 'bottom' ? BOX : 0, s.side === 'bottom' ? 'up' : 'down');
    }
  }

  if (actLeft) g += actuators[actLeft](0, ACT_W);
  if (actRight) g += actuators[actRight](left + n * BOX, ACT_W);

  out += `<g class="spool" transform="translate(${shift},0)">${g}</g>`;

  if (opts.label) out += text(left + (n * BOX) / 2, -16, opts.label, 'sym-tag');
  return out;
}

/** Static bounding box of a valve symbol (ignores the transient spool slide). */
export function valveSize(def) {
  const n = def.boxes.length;
  return {
    w: (def.actLeft ? ACT_W : 0) + n * BOX + (def.actRight ? ACT_W : 0),
    h: BOX,
  };
}
