// Displacement-step diagram (Weg-Schritt-Diagramm) and signal traces.
//
// This is the reading FluidSIM users actually work from: cylinder strokes stacked over a
// shared time axis, so signal order and overlap are visible at a glance rather than
// inferred from watching the sheet.
//
// Recording is decoupled from the render loop: the engine ticks at 1 ms, the recorder
// samples at SAMPLE_MS, and the chart redraws at most once a frame. Storing every tick
// would be 1000 points/second/channel for a reading nobody can resolve past ~5 ms.

const SAMPLE_MS = 5;
const WINDOW_S = 12; // rolling window; older samples fall off the left

/** Colours are assigned per channel and must stay stable as channels come and go. */
const CHANNEL_COLORS = ['#4c9aff', '#ffa41c', '#3ecf8e', '#e5484d', '#b78aff', '#f2d675'];

export class Recorder {
  constructor() {
    this.channels = new Map(); // key -> {label, kind, color, samples: [{t, v}]}
    this.lastSample = -1;
  }

  clear() {
    for (const ch of this.channels.values()) ch.samples.length = 0;
    this.lastSample = -1;
  }

  /** Rebuilds the channel list from the circuit: one per cylinder, plus every coil. */
  sync(circuit) {
    const wanted = new Map();
    let i = 0;
    for (const inst of circuit.instances) {
      const def = circuit.defOf(inst);
      if (!def) continue;
      const tag = inst.params?.tag?.value ?? inst.id;
      // Hydraulic cylinders are 'h_cyl', not 'cyl_*' — matching on the prefix alone
      // silently dropped every hydraulic trace.
      if (inst.sim && 'x' in inst.sim) {
        wanted.set(inst.id, { label: tag, kind: 'stroke' });
      } else if (def.coilLike) {
        wanted.set(inst.id, { label: tag, kind: 'binary' });
      }
    }
    // Drop channels whose component is gone; keep the samples of ones that survive.
    for (const key of [...this.channels.keys()]) {
      if (!wanted.has(key)) this.channels.delete(key);
    }
    for (const [key, meta] of wanted) {
      const existing = this.channels.get(key);
      if (existing) { existing.label = meta.label; continue; }
      this.channels.set(key, {
        ...meta,
        color: CHANNEL_COLORS[i % CHANNEL_COLORS.length],
        samples: [],
      });
      i++;
    }
    // Reassign colours in list order so they read top-to-bottom.
    [...this.channels.values()].forEach((ch, n) => { ch.color = CHANNEL_COLORS[n % CHANNEL_COLORS.length]; });
  }

  sample(sim) {
    const t = sim.time;
    if (this.lastSample >= 0 && t - this.lastSample < SAMPLE_MS / 1000) return;
    this.lastSample = t;

    for (const [id, ch] of this.channels) {
      const inst = sim.circuit.byId(id);
      if (!inst) continue;
      const v = ch.kind === 'stroke' ? (inst.sim.x ?? 0) : (inst.sim.on ? 1 : 0);
      ch.samples.push({ t, v });
      while (ch.samples.length && t - ch.samples[0].t > WINDOW_S) ch.samples.shift();
    }
  }

  get span() {
    let t0 = Infinity, t1 = 0;
    for (const ch of this.channels.values()) {
      if (!ch.samples.length) continue;
      t0 = Math.min(t0, ch.samples[0].t);
      t1 = Math.max(t1, ch.samples[ch.samples.length - 1].t);
    }
    return Number.isFinite(t0) ? { t0, t1: Math.max(t1, t0 + 0.5) } : null;
  }

  /** CSV of every channel on a shared time column. */
  toCSV() {
    const chs = [...this.channels.values()];
    if (!chs.length) return '';
    const times = [...new Set(chs.flatMap((c) => c.samples.map((s) => s.t)))].sort((a, b) => a - b);
    const rows = [['t_s', ...chs.map((c) => c.label)].join(',')];
    const cursors = chs.map(() => 0);
    for (const t of times) {
      const cells = chs.map((c, i) => {
        while (cursors[i] < c.samples.length - 1 && c.samples[cursors[i] + 1].t <= t) cursors[i]++;
        return (c.samples[cursors[i]]?.v ?? 0).toFixed(4);
      });
      rows.push([t.toFixed(4), ...cells].join(','));
    }
    return rows.join('\n');
  }
}

const LANE_H = 34;
const LANE_GAP = 6;
const LABEL_W = 46;
const PAD_R = 10;

/**
 * Draws the recorder into an SVG element. Plain SVG rather than canvas: the channel
 * count is small, and it keeps the chart selectable, themable from the same CSS
 * variables as the rest of the app, and exportable with the sheet.
 */
export function drawDiagram(svg, rec, { width, height }) {
  const chs = [...rec.channels.values()];
  const span = rec.span;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  if (!chs.length || !span) {
    svg.innerHTML = `<text class="diag-empty" x="${width / 2}" y="${height / 2}"
      text-anchor="middle" dominant-baseline="middle">Inicie a simulação para gravar os traços</text>`;
    return;
  }

  const plotW = width - LABEL_W - PAD_R;
  const dur = span.t1 - span.t0;
  const X = (t) => LABEL_W + ((t - span.t0) / dur) * plotW;

  let out = '';

  // Time gridlines on a round interval that keeps the labels from colliding.
  const step = dur > 8 ? 2 : dur > 4 ? 1 : dur > 1.5 ? 0.5 : 0.2;
  for (let t = Math.ceil(span.t0 / step) * step; t <= span.t1; t += step) {
    out += `<line class="diag-grid" x1="${X(t).toFixed(1)}" y1="0" x2="${X(t).toFixed(1)}" y2="${chs.length * (LANE_H + LANE_GAP)}"/>`;
    out += `<text class="diag-axis" x="${X(t).toFixed(1)}" y="${height - 3}" text-anchor="middle">${t.toFixed(step < 1 ? 1 : 0)}s</text>`;
  }

  chs.forEach((ch, i) => {
    const top = i * (LANE_H + LANE_GAP);
    const bottom = top + LANE_H;
    out += `<rect class="diag-lane" x="${LABEL_W}" y="${top}" width="${plotW}" height="${LANE_H}" rx="3"/>`;
    out += `<text class="diag-label" x="${LABEL_W - 6}" y="${top + LANE_H / 2}" text-anchor="end" dominant-baseline="middle">${ch.label}</text>`;

    if (ch.samples.length < 2) return;
    const Y = (v) => bottom - v * (LANE_H - 6) - 3;

    let d = '';
    if (ch.kind === 'binary') {
      // Square wave: a coil that switches at t must be drawn switching at t, not ramping
      // into it, or the diagram lies about signal order.
      let prev = ch.samples[0];
      d = `M ${X(prev.t).toFixed(1)} ${Y(prev.v).toFixed(1)}`;
      for (const s of ch.samples.slice(1)) {
        if (s.v !== prev.v) d += ` L ${X(s.t).toFixed(1)} ${Y(prev.v).toFixed(1)}`;
        d += ` L ${X(s.t).toFixed(1)} ${Y(s.v).toFixed(1)}`;
        prev = s;
      }
    } else {
      d = 'M ' + ch.samples.map((s) => `${X(s.t).toFixed(1)} ${Y(s.v).toFixed(1)}`).join(' L ');
    }
    out += `<path class="diag-trace" d="${d}" style="stroke:${ch.color}"/>`;

    // Current value, pinned at the right edge.
    const last = ch.samples[ch.samples.length - 1];
    const txt = ch.kind === 'binary' ? (last.v ? '1' : '0') : `${Math.round(last.v * 100)}%`;
    out += `<text class="diag-now" x="${width - 2}" y="${top + LANE_H / 2}" text-anchor="end"
      dominant-baseline="middle" style="fill:${ch.color}">${txt}</text>`;
  });

  svg.innerHTML = out;
}
