// Four-channel oscilloscope and virtual probes.
//
// Probes are a *view* concept, never circuit components: the spec requires that attaching
// one must not influence the circuit, and the only way to guarantee that is for a probe
// to have no stamp, no port, and no presence in the net graph at all. It reads the solved
// state and nothing else. (A real instrument that loads the circuit is a component you
// place before running — that is what the gauge and the pressure switch are.)
//
// Capture runs at the tick rate into ring buffers. Drawing decimates to one min/max pair
// per pixel column, so a 10 s window costs the same to render as a 50 ms one.

export const MAX_CHANNELS = 4;
export const CH_COLORS = ['#4c9aff', '#ffa41c', '#3ecf8e', '#e5484d'];

const BUFFER_S = 12;
const RATE = 1000; // samples/s — one per 1 ms tick
const CAP = BUFFER_S * RATE;

/** What a probe can read, and how each is scaled and labelled. */
export const QUANTITIES = {
  pressure: { label: 'Pressão', unit: 'bar', span: [0, 8], domain: 'pneumatic' },
  hpressure: { label: 'Pressão do óleo', unit: 'bar', span: [0, 120], domain: 'hydraulic' },
  voltage: { label: 'Tensão', unit: 'V', span: [0, 26], domain: 'electric' },
  current: { label: 'Corrente', unit: 'A', span: [0, 0.6], domain: 'electric' },
  position: { label: 'Posição', unit: '%', span: [0, 100], domain: 'part' },
  flow: { label: 'Vazão', unit: 'g/s', span: [0, 12], domain: 'pneumatic' },
};

let seq = 1;

/**
 * Reads one probe against the solved state. Returns null when the probe no longer has
 * anything to point at (its component was deleted, the port went away).
 */
export function readProbe(sim, probe) {
  const inst = sim.circuit.byId(probe.inst);
  if (!inst) return null;
  const def = sim.circuit.defOf(inst);
  if (!def) return null;

  switch (probe.quantity) {
    case 'pressure':
      return sim.netIndex(inst.id, probe.port) == null ? null : sim.gauge(inst.id, probe.port);
    case 'hpressure':
      return sim.hydIndex(inst.id, probe.port) == null ? null : sim.hgauge(inst.id, probe.port);
    case 'voltage':
      return sim.elecIndex(inst.id, probe.port) == null ? null : sim.volts(inst.id, probe.port);
    case 'current': {
      // Only meaningful across a two-terminal element whose resistance we know.
      if (!def.resistance) return null;
      return (sim.volts(inst.id, 'a') - sim.volts(inst.id, 'b')) / def.resistance;
    }
    case 'position':
      return inst.sim?.x == null ? null : inst.sim.x * 100;
    case 'flow':
      // Net mass flow leaving the port's net, in g/s. Reported by the component during
      // its stamp; components that do not report it have no meaningful single flow.
      return inst.sim?.flow?.[probe.port] == null ? null : inst.sim.flow[probe.port] * 1000;
    default:
      return null;
  }
}

/** Which quantities make sense for a given port. */
export function quantitiesFor(circuit, instId, portId) {
  const inst = circuit.byId(instId);
  const def = inst && circuit.defOf(inst);
  if (!def) return [];
  const port = def.ports.find((p) => p.id === portId);
  if (!port) return [];

  const out = [];
  if ((port.kind || 'pneumatic') === 'pneumatic') out.push('pressure');
  if (port.kind === 'hydraulic') out.push('hpressure');
  if (port.kind === 'electric') {
    out.push('voltage');
    if (def.resistance) out.push('current');
  }
  if (inst.sim?.x != null || inst.type?.startsWith('cyl_')) out.push('position');
  return out;
}

export class Scope {
  constructor() {
    this.probes = [];
    this.channels = [];       // probe ids, index = channel number
    this.buffers = [];        // Float64Array ring per channel
    this.times = new Float64Array(CAP);
    this.head = 0;
    this.count = 0;
    this.frozen = false;

    this.timebase = 2;        // seconds across the full width
    this.trigger = { mode: 'none', source: 0, level: 3, edge: 'rising' };
    this.cursors = { on: false, a: 0.35, b: 0.65 }; // fractions of the window
    for (let i = 0; i < MAX_CHANNELS; i++) this.buffers.push(new Float64Array(CAP));
  }

  addProbe(instId, portId, quantity, label) {
    if (this.probes.length >= 8) return null;
    const probe = {
      id: `p${seq++}`, inst: instId, port: portId, quantity, label,
      color: CH_COLORS[this.probes.length % CH_COLORS.length],
    };
    this.probes.push(probe);
    // Auto-assign to the first free channel, so a probe is useful the moment it is placed.
    const free = this.channels.findIndex((c) => !c);
    const slot = free >= 0 ? free : (this.channels.length < MAX_CHANNELS ? this.channels.length : -1);
    if (slot >= 0) this.channels[slot] = probe.id;
    this.syncColors();
    return probe;
  }

  removeProbe(id) {
    this.probes = this.probes.filter((p) => p.id !== id);
    this.channels = this.channels.map((c) => (c === id ? null : c));
    this.syncColors();
  }

  /** Channel colour is the probe's identity on the sheet; keep them in channel order. */
  syncColors() {
    this.channels.forEach((pid, i) => {
      const p = this.probes.find((x) => x.id === pid);
      if (p) p.color = CH_COLORS[i % CH_COLORS.length];
    });
    let n = this.channels.filter(Boolean).length;
    for (const p of this.probes) {
      if (!this.channels.includes(p.id)) p.color = '#8a929b'; // unassigned: neutral
    }
  }

  probeOf(ch) { return this.probes.find((p) => p.id === this.channels[ch]) || null; }

  clear() { this.head = 0; this.count = 0; }

  /** Drops probes whose component no longer exists. */
  prune(circuit) {
    const gone = this.probes.filter((p) => !circuit.byId(p.inst));
    for (const p of gone) this.removeProbe(p.id);
  }

  sample(sim) {
    if (this.frozen) return;
    this.times[this.head] = sim.time;
    for (let ch = 0; ch < MAX_CHANNELS; ch++) {
      const probe = this.probeOf(ch);
      const v = probe ? readProbe(sim, probe) : null;
      this.buffers[ch][this.head] = v == null ? NaN : v;
    }
    this.head = (this.head + 1) % CAP;
    if (this.count < CAP) this.count++;
  }

  /** Absolute index of the i-th oldest retained sample. */
  idx(i) { return (this.head - this.count + i + CAP * 2) % CAP; }

  /**
   * Finds the display window. With a trigger armed, the most recent qualifying edge is
   * pinned at 30% across, the way a real scope holds a repeating waveform still. Without
   * one, the window simply follows the newest sample.
   */
  window() {
    if (!this.count) return null;
    const newest = this.times[this.idx(this.count - 1)];
    const oldest = this.times[this.idx(0)];

    if (this.trigger.mode === 'none') {
      const t1 = newest;
      return { t0: Math.max(oldest, t1 - this.timebase), t1, triggered: false };
    }

    const buf = this.buffers[this.trigger.source];
    const lvl = this.trigger.level;
    const rising = this.trigger.edge === 'rising';
    const pre = this.timebase * 0.3;

    // Scan back from newest for the latest crossing that has enough post-trigger data.
    for (let i = this.count - 2; i > 0; i--) {
      const a = buf[this.idx(i - 1)], b = buf[this.idx(i)];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const crossed = rising ? (a < lvl && b >= lvl) : (a > lvl && b <= lvl);
      if (!crossed) continue;
      const tTrig = this.times[this.idx(i)];
      if (newest - tTrig < this.timebase - pre) continue; // not enough shown after it yet
      return { t0: tTrig - pre, t1: tTrig - pre + this.timebase, triggered: true, tTrig };
    }
    // Nothing qualifying: free-run rather than showing a blank screen.
    return { t0: Math.max(oldest, newest - this.timebase), t1: newest, triggered: false };
  }

  /** The samples of one channel inside a window, oldest first. NaN marks a gap. */
  trace(ch, t0, t1) {
    const buf = this.buffers[ch];
    const pts = [];
    for (let i = 0; i < this.count; i++) {
      const k = this.idx(i);
      const t = this.times[k];
      if (t < t0 || t > t1) continue;
      pts.push({ t, v: buf[k] });
    }
    return pts;
  }

  /**
   * Decimates to min/max per pixel column. Only worth doing when samples outnumber
   * columns; at a 50 ms timebase there are fewer samples than pixels and decimating
   * would leave most columns empty, which is what the raw polyline path is for.
   */
  columns(ch, t0, t1, width) {
    const cols = new Array(width).fill(null);
    const span = t1 - t0 || 1;
    for (const { t, v } of this.trace(ch, t0, t1)) {
      if (Number.isNaN(v)) continue;
      const x = Math.min(width - 1, Math.max(0, Math.floor(((t - t0) / span) * width)));
      const c = cols[x];
      if (!c) cols[x] = { min: v, max: v, last: v };
      else { c.min = Math.min(c.min, v); c.max = Math.max(c.max, v); c.last = v; }
    }
    return cols;
  }

  /** Value of a channel at a given time, for the cursor readout. */
  valueAt(ch, t) {
    if (!this.count) return null;
    let best = null, bestDt = Infinity;
    for (let i = 0; i < this.count; i++) {
      const k = this.idx(i);
      const dt = Math.abs(this.times[k] - t);
      if (dt < bestDt) { bestDt = dt; best = this.buffers[ch][k]; }
    }
    return best == null || Number.isNaN(best) ? null : best;
  }

  toCSV() {
    const active = this.channels.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
    if (!active.length || !this.count) return '';
    const head = ['t_s', ...active.map((ch) => {
      const p = this.probeOf(ch);
      return `${p.label} [${QUANTITIES[p.quantity].unit}]`;
    })];
    const rows = [head.join(',')];
    for (let i = 0; i < this.count; i++) {
      const k = this.idx(i);
      const cells = active.map((ch) => {
        const v = this.buffers[ch][k];
        return Number.isNaN(v) ? '' : v.toFixed(4);
      });
      rows.push([this.times[k].toFixed(4), ...cells].join(','));
    }
    return rows.join('\n');
  }
}

// ---------------------------------------------------------------------------

const PAD = { l: 44, r: 10, t: 8, b: 18 };

/** Per-channel vertical range: fixed nominal span, widened if the signal exceeds it. */
function rangeFor(scope, ch) {
  const probe = scope.probeOf(ch);
  if (!probe) return [0, 1];
  const [lo, hi] = QUANTITIES[probe.quantity].span;
  const buf = scope.buffers[ch];
  let mn = lo, mx = hi;
  for (let i = 0; i < scope.count; i++) {
    const v = buf[scope.idx(i)];
    if (Number.isNaN(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const pad = (mx - mn) * 0.06 || 1;
  return [mn - pad, mx + pad];
}

export function drawScope(svg, scope, { width, height }) {
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const active = scope.channels.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);

  if (!active.length) {
    svg.innerHTML = `<text class="diag-empty" x="${width / 2}" y="${height / 2}"
      text-anchor="middle" dominant-baseline="middle">Adicionar sonda: selecione “Sonda” e clique em uma conexão</text>`;
    return;
  }
  const win = scope.window();
  if (!win) {
    svg.innerHTML = `<text class="diag-empty" x="${width / 2}" y="${height / 2}"
      text-anchor="middle" dominant-baseline="middle">Simulation starten</text>`;
    return;
  }

  const plotW = Math.max(10, width - PAD.l - PAD.r);
  const plotH = Math.max(10, height - PAD.t - PAD.b);
  const X = (t) => PAD.l + ((t - win.t0) / (win.t1 - win.t0 || 1)) * plotW;

  let out = `<rect class="scope-bg" x="${PAD.l}" y="${PAD.t}" width="${plotW}" height="${plotH}"/>`;

  // Graticule: 10 divisions across, 8 down — the convention every scope user reads by.
  for (let i = 0; i <= 10; i++) {
    const x = PAD.l + (i / 10) * plotW;
    out += `<line class="scope-grid${i === 5 ? ' mid' : ''}" x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + plotH}"/>`;
  }
  for (let i = 0; i <= 8; i++) {
    const y = PAD.t + (i / 8) * plotH;
    out += `<line class="scope-grid${i === 4 ? ' mid' : ''}" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${PAD.l + plotW}" y2="${y.toFixed(1)}"/>`;
  }

  // Time axis
  for (let i = 0; i <= 10; i += 2) {
    const t = win.t0 + (i / 10) * (win.t1 - win.t0);
    const x = PAD.l + (i / 10) * plotW;
    out += `<text class="diag-axis" x="${x.toFixed(1)}" y="${height - 5}" text-anchor="middle">${t.toFixed(2)}s</text>`;
  }

  for (const ch of active) {
    const probe = scope.probeOf(ch);
    const [lo, hi] = rangeFor(scope, ch);
    const Y = (v) => PAD.t + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const cols = Math.round(plotW);
    const pts = scope.trace(ch, win.t0, win.t1);

    let d = '', pen = false;
    if (pts.length > cols * 1.5) {
      // Dense: one min/max stroke per column, so a fast edge stays visible instead of
      // being sampled away.
      const decim = scope.columns(ch, win.t0, win.t1, cols);
      for (let x = 0; x < decim.length; x++) {
        const c = decim[x];
        if (!c) { pen = false; continue; }
        const px = PAD.l + x;
        if (!pen) { d += `M ${px} ${Y(c.last).toFixed(1)}`; pen = true; continue; }
        if (c.max - c.min > 1e-9) d += ` L ${px} ${Y(c.min).toFixed(1)} L ${px} ${Y(c.max).toFixed(1)}`;
        d += ` L ${px} ${Y(c.last).toFixed(1)}`;
      }
    } else {
      // Sparse: draw the samples themselves. Decimating here would scatter them into
      // isolated columns with nothing joining them — which is exactly the bug this
      // branch exists to avoid.
      for (const p of pts) {
        if (Number.isNaN(p.v)) { pen = false; continue; }
        d += `${pen ? ' L' : ' M'} ${X(p.t).toFixed(1)} ${Y(p.v).toFixed(1)}`;
        pen = true;
      }
    }
    out += `<path class="scope-trace" d="${d}" style="stroke:${probe.color}"/>`;

    // Scale readout, one line per channel down the left gutter.
    const q = QUANTITIES[probe.quantity];
    out += `<text class="scope-scale" x="2" y="${PAD.t + 9 + active.indexOf(ch) * 11}"
      style="fill:${probe.color}">${hi.toFixed(1)}${q.unit}</text>`;
  }

  // Trigger level marker
  if (scope.trigger.mode !== 'none' && active.includes(scope.trigger.source)) {
    const [lo, hi] = rangeFor(scope, scope.trigger.source);
    const y = PAD.t + plotH - ((scope.trigger.level - lo) / (hi - lo || 1)) * plotH;
    if (y > PAD.t && y < PAD.t + plotH) {
      out += `<line class="scope-trig" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${PAD.l + plotW}" y2="${y.toFixed(1)}"/>`;
      out += `<text class="scope-trig-t" x="${PAD.l + plotW - 2}" y="${(y - 3).toFixed(1)}" text-anchor="end">T</text>`;
    }
    if (win.triggered) {
      const x = X(win.tTrig);
      out += `<line class="scope-trig" x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + plotH}"/>`;
    }
  }

  // Cursors
  if (scope.cursors.on) {
    for (const which of ['a', 'b']) {
      const x = PAD.l + scope.cursors[which] * plotW;
      out += `<line class="scope-cursor" data-cursor="${which}" x1="${x.toFixed(1)}" y1="${PAD.t}" x2="${x.toFixed(1)}" y2="${PAD.t + plotH}"/>`;
      out += `<rect class="scope-cursor-grab" data-cursor="${which}" x="${(x - 5).toFixed(1)}" y="${PAD.t}" width="10" height="${plotH}"/>`;
      out += `<text class="scope-cursor-t" x="${x.toFixed(1)}" y="${PAD.t - 1}" text-anchor="middle">${which.toUpperCase()}</text>`;
    }
  }
  svg.innerHTML = out;
}

/** Cursor readout for the toolbar: Δt plus each channel's Δ between the two cursors. */
export function cursorReadout(scope) {
  const win = scope.window();
  if (!win || !scope.cursors.on) return null;
  const span = win.t1 - win.t0;
  const ta = win.t0 + scope.cursors.a * span;
  const tb = win.t0 + scope.cursors.b * span;
  const rows = [];
  for (let ch = 0; ch < MAX_CHANNELS; ch++) {
    const probe = scope.probeOf(ch);
    if (!probe) continue;
    const va = scope.valueAt(ch, ta), vb = scope.valueAt(ch, tb);
    if (va == null || vb == null) continue;
    rows.push({ label: probe.label, color: probe.color, d: vb - va, unit: QUANTITIES[probe.quantity].unit });
  }
  return { dt: Math.abs(tb - ta), rows };
}
