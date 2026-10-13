// Continuous electronics.
//
// Same contract as every other catalog file — a component owns its symbol, its ports and
// its physics — with two hooks the ladder parts do not have:
//
//   continuous   marks the sheet as needing MNA + Newton instead of the resistive solve
//   extras       how many MNA unknowns this component claims (branch currents, internal
//                nodes); the engine sums them before it sizes the matrix
//   stampMna(inst, st, ctx, v)   stamped once per Newton iteration, `v` is the iterate
//   postElectric(inst, ctx)      commit reactive state at the solved operating point
//   electricDt(inst)             the timestep this component needs; the engine takes the
//                                smallest one asked for and subdivides the fluid tick
//
// These live on the same electric net graph as the relays and gates, so a diode behind a
// relay contact reads it and a lamp on an op-amp output lights. Nothing here is a
// separate world.
//
// Device parameters are the usual small-signal catalogue figures; where a number is
// picked rather than looked up, the comment says what it was picked to reproduce.

import { line, rect, circle, path, poly, text } from './symbols.js';
import { GMIN, diodeCurrent } from './engine.js';

// Saturation currents and emission coefficients chosen to land on the forward voltage
// each part is actually known by, at the current it is known at.
const D_1N4007 = { Is: 1e-9, N: 1.9 };      // ~1.0 V at 1 A
const D_LED = { Is: 1e-20, N: 2.0 };        // ~2.0 V at 20 mA
const zenerModel = (vz) => ({ Is: 1e-9, N: 1.7, Vz: vz, Ibv: 1e-3, Nbv: 1.0 });
const NPN = { Is: 1e-14, Bf: 200, Br: 2, Nf: 1, Nr: 1 };            // BC547-ish
const PNP = { ...NPN, pnp: true };                                   // BC557-ish
const NMOS = { Vth: 2.0, K: 0.5, lambda: 0.02 };                     // small power FET

const R_WIND = 2;        // Ω of primary winding — also what makes a transformer block DC

const p2 = (v, d = 1) => v.toFixed(d).replace('.', ',');

/** Human-readable resistance: 4700 Ω reads as 4,7 k, not as a five-digit number. */
const ohms = (r) => (r >= 1000 ? `${p2(r / 1000)}k` : `${Math.round(r)}`);

const range = (label, value, min, max, step, unit) =>
  ({ label, type: 'range', value, min, max, step, unit });

// ---------------------------------------------------------------------------
// Passive
// ---------------------------------------------------------------------------

// Two-terminal parts keep the ladder's vertical geometry (a on top, b at the bottom) so
// they drop between the same 24 V and 0 V rails as a relay coil, without rotating.
const W2 = 30, H2 = 44;
const leads = (top, bot) => line(15, 0, 15, top) + line(15, bot, 15, H2);

const resistor = {
  id: 'e_resistor', name: 'Resistência', short: 'R', group: 'Eletrônica',
  size: { w: W2, h: H2 },
  ports: [
    { id: 'a', x: 15, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 15, y: H2, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'R1' },
    r: range('Resistência', 1000, 10, 100000, 10, 'Ω'),
  },
  // A plain conductance: no MNA needed, so a sheet of nothing but resistors still gets
  // the cheap resistive solve.
  stampElectric(inst, st, ctx) {
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), 1 / Math.max(inst.params.r.value, 1e-3));
  },
  render(inst) {
    return leads(12, 32) + rect(9, 12, 12, 20)
      + text(24, 20, inst.params.tag.value, 'sym-tag', 'start')
      + text(24, 32, `${ohms(inst.params.r.value)}`, 'sym-tag', 'start');
  },
};

const capacitor = {
  id: 'e_capacitor', name: 'Capacitor', short: 'C', group: 'Eletrônica',
  size: { w: W2, h: H2 },
  ports: [
    { id: 'a', x: 15, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 15, y: H2, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'C1' },
    c: range('Capacitância', 1, 0.01, 100, 0.01, 'µF'),
  },
  continuous: true,
  initSim(inst) { inst.sim.v = 0; inst.sim.i = 0; },
  stampMna(inst, st, ctx) {
    st.capacitor(ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.params.c.value * 1e-6, inst.sim.v);
  },
  postElectric(inst, ctx) {
    const v = ctx.volts(inst, 'a') - ctx.volts(inst, 'b');
    inst.sim.i = (inst.params.c.value * 1e-6 / ctx.dt) * (v - inst.sim.v);
    inst.sim.v = v;
  },
  render(inst) {
    return leads(19, 25) + line(4, 19, 26, 19) + line(4, 25, 26, 25)
      + text(29, 20, inst.params.tag.value, 'sym-tag', 'start')
      + text(29, 32, `${p2(inst.params.c.value, 2)}µ`, 'sym-tag', 'start');
  },
};

const inductor = {
  id: 'e_inductor', name: 'Bobina (indutor)', short: 'L', group: 'Eletrônica',
  size: { w: W2, h: H2 },
  ports: [
    { id: 'a', x: 15, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 15, y: H2, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'L1' },
    l: range('Indutância', 100, 0.1, 1000, 0.1, 'mH'),
  },
  faultTypes: ['coil_open'],
  continuous: true,
  initSim(inst) { inst.sim.i = 0; },
  stampMna(inst, st, ctx) {
    if (ctx.fault(inst, 'coil_open')) { inst.sim.i = 0; return; }
    st.inductor(ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.params.l.value * 1e-3, inst.sim.i);
  },
  postElectric(inst, ctx) {
    if (ctx.fault(inst, 'coil_open')) return;
    // The same backward-Euler relation the stamp used, evaluated at the solution:
    // i_new = i_old + (dt/L)·v. Anything else here would leak energy out of the model.
    inst.sim.i += (ctx.dt / (inst.params.l.value * 1e-3)) * (ctx.volts(inst, 'a') - ctx.volts(inst, 'b'));
  },
  render(inst) {
    let d = 'M 15 12';
    for (let i = 0; i < 4; i++) d += ` A 2.5 2.5 0 0 1 15 ${17 + i * 5}`;
    return leads(12, 32) + path(d) + line(21, 12, 21, 32)
      + text(24, 20, inst.params.tag.value, 'sym-tag', 'start')
      + text(24, 32, `${p2(inst.params.l.value)}m`, 'sym-tag', 'start');
  },
};

/**
 * Potentiometer: the wiper splits R_total, it does not tap an ideal divider. The two
 * halves are stamped as what they are, so loading the wiper bends the characteristic the
 * way a real pot's does.
 */
const potentiometer = {
  id: 'e_pot', name: 'Potenciômetro', short: 'Potenciômetro', group: 'Eletrônica',
  size: { w: 40, h: H2 },
  ports: [
    { id: 'a', x: 15, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 15, y: H2, dir: 'down', kind: 'electric' },
    { id: 'w', x: 40, y: 22, dir: 'right', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'R1' },
    r: range('Resistência total', 10000, 100, 100000, 100, 'Ω'),
    pos: range('Posição', 0.5, 0, 1, 0.01),
  },
  stampElectric(inst, st, ctx) {
    const R = Math.max(inst.params.r.value, 1);
    // A wiper at an end is a dead short, which is a real pot's behaviour and an infinite
    // conductance in the matrix; a milliohm of wiper contact is the honest floor.
    const x = Math.min(Math.max(inst.params.pos.value, 0), 1);
    const na = ctx.net(inst, 'a'), nb = ctx.net(inst, 'b'), nw = ctx.net(inst, 'w');
    st.conduct(na, nw, 1 / Math.max(R * (1 - x), 1e-3));
    st.conduct(nw, nb, 1 / Math.max(R * x, 1e-3));
  },
  render(inst) {
    const y = 12 + (1 - Math.min(Math.max(inst.params.pos.value, 0), 1)) * 20;
    return leads(12, 32) + rect(9, 12, 12, 20)
      + line(40, 22, 30, 22) + line(30, 22, 30, y) + poly([[21, y], [27, y - 3], [27, y + 3]], 'sym fill')
      + line(27, y, 30, y)
      + text(24, 10, inst.params.tag.value, 'sym-tag', 'start');
  },
};

// ---------------------------------------------------------------------------
// Junctions
// ---------------------------------------------------------------------------

/** Body shared by every diode-shaped part: triangle pointing at the cathode bar. */
const diodeBody = () => leads(12, 32) + poly([[15, 12], [7, 28], [23, 28]]) + line(6, 28, 24, 28);

/**
 * @param {(vz:number) => object} model  built per instance, because a Zener's whole
 *        identity is a parameter
 */
function makeDiode({ id, name, short, tag, model, params = {}, decor = () => '', lit }) {
  return {
    id, name, short, group: 'Eletrônica',
    size: { w: W2, h: H2 },
    ports: [
      { id: 'a', x: 15, y: 0, dir: 'up', kind: 'electric' },
      { id: 'k', x: 15, y: H2, dir: 'down', kind: 'electric' },
    ],
    params: { tag: { label: 'Identificação', type: 'text', value: tag }, ...params },
    continuous: true,
    initSim(inst) { inst.sim.vd = 0; inst.sim.i = 0; },
    stampMna(inst, st, ctx, v) {
      inst.sim.vd = st.diode(ctx.net(inst, 'a'), ctx.net(inst, 'k'), model(inst), v, inst.sim.vd);
    },
    postElectric(inst) { inst.sim.i = diodeCurrent(inst.sim.vd, model(inst)); },
    render(inst) {
      const on = lit ? inst.sim?.i > 1e-3 : false;
      return diodeBody() + decor(inst)
        + (on ? circle(15, 20, 3, 'sym lamp-on') : '')
        + text(26, 20, inst.params.tag.value, 'sym-tag', 'start');
    },
  };
}

const diode1N4007 = makeDiode({
  id: 'e_diode', name: 'Diodo 1N4007', short: 'Diodo', tag: 'V1', model: () => D_1N4007,
});

const led = makeDiode({
  id: 'e_led', name: 'Diodo emissor de luz (LED)', short: 'LED', tag: 'H1', model: () => D_LED, lit: true,
  decor: () => line(24, 14, 30, 8) + poly([[30, 8], [26, 9], [29, 12]], 'sym fill')
    + line(24, 20, 30, 14) + poly([[30, 14], [26, 15], [29, 18]], 'sym fill'),
});

const zener = makeDiode({
  id: 'e_zener', name: 'Diodo Zener', short: 'Diodo Zener', tag: 'V1',
  params: { vz: range('Tensão Zener', 5.1, 2.4, 47, 0.1, 'V') },
  model: (inst) => zenerModel(inst.params.vz.value),
  // The bent cathode bar is what tells a Zener from a diode on a sheet.
  decor: (inst) => line(6, 28, 6, 32) + line(24, 24, 24, 28)
    + text(26, 32, `${p2(inst.params.vz.value)}V`, 'sym-tag', 'start'),
});

// ---------------------------------------------------------------------------
// Transistors
// ---------------------------------------------------------------------------

const TW = 44, TH = 48;

function makeBjt(id, name, short, model) {
  const pnp = !!model.pnp;
  return {
    id, name, short, group: 'Eletrônica',
    size: { w: TW, h: TH },
    ports: [
      { id: 'B', x: 0, y: 24, dir: 'left', kind: 'electric' },
      { id: 'C', x: 30, y: 0, dir: 'up', kind: 'electric' },
      { id: 'E', x: 30, y: TH, dir: 'down', kind: 'electric' },
    ],
    params: { tag: { label: 'Identificação', type: 'text', value: 'V1' } },
    continuous: true,
    initSim(inst) { inst.sim.vbe = 0; inst.sim.vbc = 0; },
    stampMna(inst, st, ctx, v) {
      const r = st.bjt(ctx.net(inst, 'B'), ctx.net(inst, 'C'), ctx.net(inst, 'E'), model, v, inst.sim);
      inst.sim.vbe = r.vbe; inst.sim.vbc = r.vbc;
    },
    render(inst) {
      // Emitter arrow points the way conventional current leaves the device: out for
      // NPN, in for PNP. That arrow is the only difference between the two symbols.
      const ax = pnp ? [24, 30] : [30, 24];
      const ay = pnp ? [36, 42] : [42, 36];
      return circle(24, 24, 20) + line(0, 24, 14, 24) + line(14, 10, 14, 38)
        + line(14, 18, 30, 6) + line(30, 6, 30, 0)
        + line(14, 30, 30, 42) + line(30, 42, 30, TH)
        + poly([[ax[0], ay[0]], [ax[1] - 6, ay[1] - 1], [ax[1] - 1, ay[1] - 6]], 'sym fill')
        + text(2, 18, inst.params.tag.value, 'sym-tag', 'start');
    },
  };
}

const npn = makeBjt('e_npn', 'Transistor NPN', 'NPN', NPN);
const pnp = makeBjt('e_pnp', 'Transistor PNP', 'PNP', PNP);

const mosfet = {
  id: 'e_nmos', name: 'MOSFET, canal N', short: 'MOSFET', group: 'Eletrônica',
  size: { w: TW, h: TH },
  ports: [
    { id: 'G', x: 0, y: 24, dir: 'left', kind: 'electric' },
    { id: 'D', x: 30, y: 0, dir: 'up', kind: 'electric' },
    { id: 'S', x: 30, y: TH, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'V1' },
    vth: range('Tensão de limiar', 2, 0.5, 6, 0.1, 'V'),
  },
  continuous: true,
  stampMna(inst, st, ctx, v) {
    st.mosfet(ctx.net(inst, 'G'), ctx.net(inst, 'D'), ctx.net(inst, 'S'),
              { ...NMOS, Vth: inst.params.vth.value }, v);
  },
  render(inst) {
    return circle(24, 24, 20) + line(0, 24, 12, 24) + line(12, 12, 12, 36)
      + line(17, 12, 17, 19) + line(17, 21, 17, 27) + line(17, 29, 17, 36)
      + line(17, 15, 30, 15) + line(30, 15, 30, 0)
      + line(17, 33, 30, 33) + line(30, 33, 30, TH)
      + line(17, 24, 30, 24) + line(30, 24, 30, 33)
      + poly([[22, 24], [17, 21], [17, 27]], 'sym fill')
      + text(2, 18, inst.params.tag.value, 'sym-tag', 'start');
  },
};

// ---------------------------------------------------------------------------
// Active / sources
// ---------------------------------------------------------------------------

const OW = 52, OH = 48;

/**
 * Op-amp: a voltage-controlled voltage source with finite gain and hard rails. Inputs
 * draw nothing at all — no stamp — which is the right idealisation for the input stage
 * and is why the engine puts GMIN on every node.
 *
 * The rails are a hard clamp, not a soft knee. That makes the derivative jump to zero at
 * saturation, which is exactly the shape a comparator has; the price is that a stiff
 * positive-feedback loop can make Newton chatter, and the engine reports that instead of
 * hiding it.
 */
const opamp = {
  id: 'e_opamp', name: 'Amplificador operacional', short: 'Amp. op.', group: 'Eletrônica',
  size: { w: OW, h: OH },
  ports: [
    { id: 'p', x: 0, y: 14, dir: 'left', kind: 'electric' },
    { id: 'n', x: 0, y: 34, dir: 'left', kind: 'electric' },
    { id: 'out', x: OW, y: 24, dir: 'right', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'N1' },
    gain: range('Ganho em malha aberta', 100000, 1000, 1000000, 1000),
    vpos: range('Limite de saída +', 24, 0, 48, 0.5, 'V'),
    vneg: range('Limite de saída −', 0, -48, 24, 0.5, 'V'),
  },
  continuous: true,
  extras: 1,
  initSim(inst) { inst.sim.sat = 0; },
  stampMna(inst, st, ctx, v) {
    const k = st.extra();
    const np = ctx.net(inst, 'p'), nn = ctx.net(inst, 'n'), no = ctx.net(inst, 'out');
    const diff = (np == null ? 0 : v[np]) - (nn == null ? 0 : v[nn]);
    const a = inst.params.gain.value;
    const hi = inst.params.vpos.value, lo = inst.params.vneg.value;
    const open = a * diff;

    let out = open, g = a;
    if (open > hi) { out = hi; g = 0; inst.sim.sat = 1; }
    else if (open < lo) { out = lo; g = 0; inst.sim.sat = -1; }
    else inst.sim.sat = 0;

    st.vcvs(k, no, null, np, nn, g, out - g * diff);
  },
  render(inst) {
    return poly([[10, 2], [10, OH - 2], [OW - 8, OH / 2]], 'sym')
      + line(0, 14, 10, 14) + line(0, 34, 10, 34) + line(OW - 8, 24, OW, 24)
      + text(16, 18, '+', 'sym-port', 'start') + text(16, 38, '−', 'sym-port', 'start')
      + text(OW / 2, -3, inst.params.tag.value, 'sym-tag');
  },
};

const WAVES = {
  sinus: (ph) => Math.sin(ph),
  rechteck: (ph) => (Math.sin(ph) >= 0 ? 1 : -1),
  dreieck: (ph) => (2 / Math.PI) * Math.asin(Math.sin(ph)),
};

/**
 * AC source: an ideal voltage source, so it needs one MNA row of its own.
 *
 * It is also what forces the electrical timestep: at 100 kHz a period is 10 µs, and a
 * solver stepping the fluid tick would sample it once every hundred periods and call the
 * result DC. `electricDt` is the component saying how fine a step it needs, and the
 * engine subdivides the tick accordingly.
 */
const acSource = {
  id: 'e_ac', name: 'Fonte de tensão alternada', short: 'AC', group: 'Eletrônica',
  size: { w: W2, h: H2 },
  ports: [
    { id: 'a', x: 15, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 15, y: H2, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'G1' },
    amplitude: range('Amplitude', 10, 0.5, 48, 0.5, 'V'),
    freq: range('Frequência', 50, 1, 200000, 1, 'Hz'),
    form: {
      label: 'Forma de onda', type: 'select', value: 'sinus',
      options: [
        { value: 'sinus', label: 'Senoidal' },
        { value: 'rechteck', label: 'Quadrada' },
        { value: 'dreieck', label: 'Triangular' },
      ],
    },
  },
  faultTypes: ['off'],
  continuous: true,
  extras: 1,
  initSim(inst) { inst.sim.u = 0; },
  electricDt(inst) { return 1 / (inst.params.freq.value * 40); },
  stampMna(inst, st, ctx) {
    const k = st.extra();
    if (ctx.fault(inst, 'off')) { st.openBranch(k); inst.sim.u = 0; return; }
    const ph = 2 * Math.PI * inst.params.freq.value * ctx.t;
    inst.sim.u = inst.params.amplitude.value * WAVES[inst.params.form.value](ph);
    st.vsource(k, ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.sim.u);
  },
  render(inst) {
    return leads(11, 33) + circle(15, 22, 11)
      + path('M 9 22 A 3 3 0 0 1 15 22 A 3 3 0 0 0 21 22')
      + text(28, 18, inst.params.tag.value, 'sym-tag', 'start')
      + text(28, 30, `${Math.round(inst.params.freq.value)}Hz`, 'sym-tag', 'start');
  },
};

/**
 * Transformer: ideal ratio, plus the two things that make it a transformer rather than a
 * ratio. Winding resistance and a magnetising inductance across the primary are what
 * make it pass AC and refuse DC — an ideal element alone would happily transform a
 * battery, which is the classic way this model lies.
 */
const transformer = {
  id: 'e_transformer', name: 'Transformador', short: 'Transformador', group: 'Eletrônica',
  size: { w: 48, h: 52 },
  ports: [
    { id: 'p1', x: 0, y: 8, dir: 'left', kind: 'electric' },
    { id: 'p2', x: 0, y: 44, dir: 'left', kind: 'electric' },
    { id: 's1', x: 48, y: 8, dir: 'right', kind: 'electric' },
    { id: 's2', x: 48, y: 44, dir: 'right', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'T1' },
    ratio: range('Relação de espiras N1/N2', 2, 0.1, 20, 0.1),
    lm: range('Indutância de magnetização', 1, 0.01, 20, 0.01, 'H'),
  },
  faultTypes: ['coil_open'],
  continuous: true,
  extras: 2,   // the ideal transformer's branch current, and the node behind R_wind
  initSim(inst) { inst.sim.im = 0; inst.sim.nm = null; },
  stampMna(inst, st, ctx) {
    const k = st.extra(), m = st.extra();
    inst.sim.nm = m;
    const p1 = ctx.net(inst, 'p1'), p2n = ctx.net(inst, 'p2');
    if (ctx.fault(inst, 'coil_open')) {
      // Open primary: no current can flow through the ideal element, and with the
      // coupling unstamped the secondary is left floating, which is what it is.
      st.openBranch(k);
      st.toFixed(m, GMIN, 0);
      inst.sim.im = 0;
      return;
    }
    st.conduct(p1, m, 1 / R_WIND);
    st.inductor(m, p2n, inst.params.lm.value, inst.sim.im);
    st.transformer(k, m, p2n, ctx.net(inst, 's1'), ctx.net(inst, 's2'), inst.params.ratio.value);
  },
  postElectric(inst, ctx) {
    if (ctx.fault(inst, 'coil_open') || inst.sim.nm == null) return;
    // The internal node has no port, so its potential is read straight off the solution
    // vector — the only place in the catalog that touches it, and only because an
    // internal node is by definition not something a wire can reach.
    const vm = ctx.sim.x[inst.sim.nm] - ctx.volts(inst, 'p2');
    inst.sim.im += (ctx.dt / inst.params.lm.value) * vm;
  },
  render(inst) {
    let d = '';
    for (let i = 0; i < 4; i++) {
      d += ` M 18 ${10 + i * 8} A 4 4 0 0 0 18 ${18 + i * 8}`;
    }
    let e = '';
    for (let i = 0; i < 4; i++) {
      e += ` M 30 ${10 + i * 8} A 4 4 0 0 1 30 ${18 + i * 8}`;
    }
    return line(0, 8, 18, 8) + line(0, 44, 18, 44) + line(48, 8, 30, 8) + line(48, 44, 30, 44)
      + line(18, 8, 18, 10) + line(18, 42, 18, 44) + line(30, 8, 30, 10) + line(30, 42, 30, 44)
      + path(d) + path(e)
      + line(22, 6, 22, 46) + line(26, 6, 26, 46)
      + text(24, -3, inst.params.tag.value, 'sym-tag')
      + text(24, 52, `n=${p2(inst.params.ratio.value)}`, 'sym-tag');
  },
};

export const ELECTRONICS_CATALOG = [
  resistor, capacitor, inductor, potentiometer,
  diode1N4007, led, zener,
  npn, pnp, mosfet,
  opamp, acSource, transformer,
];
