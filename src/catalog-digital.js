// Digital technology.
//
// Gates and flip-flops built on the same electric net graph as the ladder, not a separate
// boolean world: a gate output is a real node driven towards 24 V or 0 V through a low
// impedance, so a lamp on a gate output lights, and a gate fed from a relay contact reads
// it. That is also why two outputs wired together fight rather than silently disagreeing.
//
// Timing splits deliberately:
//   - combinational gates settle *within* a tick (the engine re-solves until levels stop
//     moving), so a gate chain has no artificial delay;
//   - flip-flops clock *on* the tick, which is what stops a feedback loop from becoming
//     an algebraic one.

import { line, rect, circle, path, text } from './symbols.js';
import { LOGIC_THRESHOLD } from './engine.js';

const V_HIGH = 24;
const G_DRIVE = 1e2;   // output impedance: stiff, but two fighting outputs land mid-rail
const G_INPUT = 1e-9;  // gate inputs are essentially open

const W = 46, H = 40;

/** Input pin ys for a gate with n inputs. */
const pinYs = (n) => (n === 1 ? [H / 2] : Array.from({ length: n }, (_, i) => 10 + i * ((H - 20) / (n - 1))));

/**
 * Shared body: rectangular IEC-style block with the function label inside.
 * `bubble` draws the inversion circle on the output.
 */
function gateBody(label, inputs, bubble) {
  let s = rect(8, 4, W - 16, H - 8);
  for (const y of pinYs(inputs)) s += line(0, y, 8, y);
  s += bubble
    ? circle(W - 5, H / 2, 3) + line(W - 2, H / 2, W, H / 2)
    : line(W - 8, H / 2, W, H / 2);
  s += text(W / 2 - 4, H / 2 + 3, label, 'sym-label');
  return s;
}

/**
 * @param {(ins:boolean[]) => boolean} fn  truth function
 */
function makeGate(id, name, short, label, inputs, fn, bubble = false) {
  const ports = [
    ...pinYs(inputs).map((y, i) => ({
      id: String.fromCharCode(65 + i), x: 0, y, dir: 'left', kind: 'electric',
    })),
    { id: 'Q', x: W, y: H / 2, dir: 'right', kind: 'electric' },
  ];
  const inputIds = ports.slice(0, inputs).map((p) => p.id);

  return {
    id, name, short, group: 'Lógica digital',
    size: { w: W, h: H },
    ports,
    params: { tag: { label: 'Identificação', type: 'text', value: 'D1' } },
    combinational: true,
    initSim(inst) { inst.sim.q = false; },

    /** Called repeatedly inside a tick until the whole gate network settles. */
    evaluate(inst, ctx) {
      inst.sim.q = fn(inputIds.map((p) => ctx.volts(inst, p) > LOGIC_THRESHOLD));
    },

    stampElectric(inst, st, ctx) {
      for (const p of inputIds) st.toFixed(ctx.net(inst, p), G_INPUT, 0);
      st.toFixed(ctx.net(inst, 'Q'), G_DRIVE, inst.sim.q ? V_HIGH : 0);
    },

    render(inst) {
      return gateBody(label, inputs, bubble)
        + (inst.sim?.q ? circle(W - (bubble ? 5 : 8), H / 2, 2, 'sym fill') : '')
        + text(W / 2, -3, inst.params.tag.value, 'sym-tag');
    },
  };
}

const and2 = makeGate('d_and', 'Porta lógica E (AND)', 'AND', '&', 2, (i) => i[0] && i[1]);
const and3 = makeGate('d_and3', 'Porta lógica E (AND), 3 entradas', 'AND3', '&', 3, (i) => i.every(Boolean));
const or2 = makeGate('d_or', 'Porta lógica OU (OR)', 'OR', '≥1', 2, (i) => i[0] || i[1]);
const or3 = makeGate('d_or3', 'Porta lógica OU (OR), 3 entradas', 'OR3', '≥1', 3, (i) => i.some(Boolean));
const notG = makeGate('d_not', 'Inversor (NOT)', 'NOT', '1', 1, (i) => !i[0], true);
const nand2 = makeGate('d_nand', 'Porta lógica NAND', 'NAND', '&', 2, (i) => !(i[0] && i[1]), true);
const nor2 = makeGate('d_nor', 'Porta lógica NOR', 'NOR', '≥1', 2, (i) => !(i[0] || i[1]), true);
const xor2 = makeGate('d_xor', 'Porta lógica XOR', 'XOR', '=1', 2, (i) => i[0] !== i[1]);

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

const FF_W = 52, FF_H = 52;

/**
 * RS flip-flop, set-dominant. The dominance is not arbitrary: with both inputs high a
 * plain cross-coupled latch is undefined, and every real teaching circuit specifies which
 * one wins. Set-dominant matches the pneumatic memory valve this sits next to.
 */
const rsFF = {
  id: 'd_rs', name: 'Flip-flop RS (prioridade de SET)', short: 'RS-FF', group: 'Lógica digital',
  size: { w: FF_W, h: FF_H },
  ports: [
    { id: 'S', x: 0, y: 14, dir: 'left', kind: 'electric' },
    { id: 'R', x: 0, y: 38, dir: 'left', kind: 'electric' },
    { id: 'Q', x: FF_W, y: 14, dir: 'right', kind: 'electric' },
    { id: 'Qn', x: FF_W, y: 38, dir: 'right', kind: 'electric' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: 'FF1' } },
  initSim(inst) { inst.sim.q = false; },

  // Sequential: clocks on the tick, so a latch fed from its own output is a real
  // feedback loop rather than an algebraic one the settle pass would have to resolve.
  updateState(inst, ctx) {
    const S = ctx.sim.volts(inst.id, 'S') > LOGIC_THRESHOLD;
    const R = ctx.sim.volts(inst.id, 'R') > LOGIC_THRESHOLD;
    if (S) inst.sim.q = true;
    else if (R) inst.sim.q = false;
  },
  stampElectric(inst, st, ctx) {
    st.toFixed(ctx.net(inst, 'S'), G_INPUT, 0);
    st.toFixed(ctx.net(inst, 'R'), G_INPUT, 0);
    st.toFixed(ctx.net(inst, 'Q'), G_DRIVE, inst.sim.q ? V_HIGH : 0);
    st.toFixed(ctx.net(inst, 'Qn'), G_DRIVE, inst.sim.q ? 0 : V_HIGH);
  },
  render(inst) {
    return rect(8, 2, FF_W - 16, FF_H - 4)
      + line(0, 14, 8, 14) + line(0, 38, 8, 38)
      + line(FF_W - 8, 14, FF_W, 14) + line(FF_W - 8, 38, FF_W, 38)
      + text(14, 17, 'S', 'sym-port') + text(14, 41, 'R', 'sym-port')
      + text(FF_W - 12, 17, 'Q', 'sym-port') + text(FF_W - 12, 41, 'Q̄', 'sym-port')
      + (inst.sim?.q ? circle(FF_W - 8, 14, 2, 'sym fill') : circle(FF_W - 8, 38, 2, 'sym fill'))
      + text(FF_W / 2, -3, inst.params.tag.value, 'sym-tag');
  },
};

/** D flip-flop, rising-edge triggered. */
const dFF = {
  id: 'd_dff', name: 'Flip-flop D, acionado por borda', short: 'D-FF', group: 'Lógica digital',
  size: { w: FF_W, h: FF_H },
  ports: [
    { id: 'D', x: 0, y: 14, dir: 'left', kind: 'electric' },
    { id: 'C', x: 0, y: 38, dir: 'left', kind: 'electric' },
    { id: 'Q', x: FF_W, y: 14, dir: 'right', kind: 'electric' },
    { id: 'Qn', x: FF_W, y: 38, dir: 'right', kind: 'electric' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: 'FF1' } },
  initSim(inst) { inst.sim.q = false; inst.sim.lastClk = false; },
  updateState(inst, ctx) {
    const clk = ctx.sim.volts(inst.id, 'C') > LOGIC_THRESHOLD;
    if (clk && !inst.sim.lastClk) inst.sim.q = ctx.sim.volts(inst.id, 'D') > LOGIC_THRESHOLD;
    inst.sim.lastClk = clk;
  },
  stampElectric(inst, st, ctx) {
    st.toFixed(ctx.net(inst, 'D'), G_INPUT, 0);
    st.toFixed(ctx.net(inst, 'C'), G_INPUT, 0);
    st.toFixed(ctx.net(inst, 'Q'), G_DRIVE, inst.sim.q ? V_HIGH : 0);
    st.toFixed(ctx.net(inst, 'Qn'), G_DRIVE, inst.sim.q ? 0 : V_HIGH);
  },
  render(inst) {
    return rect(8, 2, FF_W - 16, FF_H - 4)
      + line(0, 14, 8, 14) + line(0, 38, 8, 38)
      + line(FF_W - 8, 14, FF_W, 14) + line(FF_W - 8, 38, FF_W, 38)
      + path(`M 8 34 L 13 38 L 8 42`) // clock wedge: the edge-trigger mark
      + text(15, 17, 'D', 'sym-port')
      + text(FF_W - 12, 17, 'Q', 'sym-port') + text(FF_W - 12, 41, 'Q̄', 'sym-port')
      + (inst.sim?.q ? circle(FF_W - 8, 14, 2, 'sym fill') : circle(FF_W - 8, 38, 2, 'sym fill'))
      + text(FF_W / 2, -3, inst.params.tag.value, 'sym-tag');
  },
};

/** Up counter with preset and reset — the digital sibling of the pneumatic counter. */
const counter = {
  id: 'd_counter', name: 'Contador crescente com pré-seleção', short: 'Contador', group: 'Lógica digital',
  size: { w: 58, h: 52 },
  ports: [
    { id: 'C', x: 0, y: 14, dir: 'left', kind: 'electric' },
    { id: 'R', x: 0, y: 38, dir: 'left', kind: 'electric' },
    { id: 'Q', x: 58, y: 26, dir: 'right', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'C1' },
    preset: { label: 'Pré-seleção', type: 'range', value: 3, min: 1, max: 50, step: 1 },
  },
  initSim(inst) { inst.sim.count = 0; inst.sim.q = false; inst.sim.lastClk = false; },
  updateState(inst, ctx) {
    const clk = ctx.sim.volts(inst.id, 'C') > LOGIC_THRESHOLD;
    const rst = ctx.sim.volts(inst.id, 'R') > LOGIC_THRESHOLD;
    if (rst) { inst.sim.count = 0; }
    else if (clk && !inst.sim.lastClk) inst.sim.count++;
    inst.sim.lastClk = clk;
    inst.sim.q = inst.sim.count >= inst.params.preset.value;
  },
  stampElectric(inst, st, ctx) {
    st.toFixed(ctx.net(inst, 'C'), G_INPUT, 0);
    st.toFixed(ctx.net(inst, 'R'), G_INPUT, 0);
    st.toFixed(ctx.net(inst, 'Q'), G_DRIVE, inst.sim.q ? V_HIGH : 0);
  },
  render(inst) {
    return rect(8, 2, 42, 48)
      + line(0, 14, 8, 14) + line(0, 38, 8, 38) + line(50, 26, 58, 26)
      + path(`M 8 10 L 13 14 L 8 18`)
      + text(16, 41, 'R', 'sym-port') + text(46, 29, 'Q', 'sym-port')
      + text(29, 30, `${inst.sim?.count ?? 0}/${inst.params.preset.value}`, 'sym-label')
      + text(29, -3, inst.params.tag.value, 'sym-tag');
  },
};

/** Free-running clock — the stimulus every counter demo needs. */
const clock = {
  id: 'd_clock', name: 'Gerador de pulsos', short: 'Pulsos', group: 'Lógica digital',
  size: { w: 44, h: 34 },
  ports: [{ id: 'Q', x: 44, y: 17, dir: 'right', kind: 'electric' }],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'G1' },
    period: { label: 'Período', type: 'range', value: 1, min: 0.05, max: 10, step: 0.05, unit: 's' },
  },
  initSim(inst) { inst.sim.q = false; inst.sim.t = 0; },
  updateState(inst, ctx) {
    inst.sim.t += ctx.dt;
    const half = inst.params.period.value / 2;
    if (inst.sim.t >= half) { inst.sim.t = 0; inst.sim.q = !inst.sim.q; }
  },
  stampElectric(inst, st, ctx) {
    st.toFixed(ctx.net(inst, 'Q'), G_DRIVE, inst.sim.q ? V_HIGH : 0);
  },
  render(inst) {
    return rect(4, 4, 34, 26)
      + line(38, 17, 44, 17)
      + path('M 10 24 L 10 12 L 17 12 L 17 24 L 24 24 L 24 12 L 31 12 L 31 24')
      + (inst.sim?.q ? circle(38, 17, 2, 'sym fill') : '')
      + text(21, -3, inst.params.tag.value, 'sym-tag');
  },
};

export const DIGITAL_CATALOG = [
  and2, and3, or2, or3, notG, nand2, nor2, xor2,
  rsFF, dFF, counter, clock,
];
