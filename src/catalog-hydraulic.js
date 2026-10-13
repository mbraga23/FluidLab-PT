// Hydraulic components.
//
// Same contract as the pneumatic catalog, with `stampHydraulic` instead of `stamp`.
// Ports carry kind:'hydraulic', which keeps them in their own net graph — oil and air
// can never be wired together, and the editor refuses the connection for free.
//
// ISO 1219 draws hydraulic and pneumatic symbols almost identically; the difference is
// the solid arrowhead (hydraulic) versus the open one (pneumatic), and that lines return
// to a tank rather than venting. Both are honoured here.

import {
  BOX, ACT_W, line, rect, circle, path, poly, text, arrow, spring,
  drawValve, valveSize,
} from './symbols.js';
import {
  P_TANK, K_VALVE, K_THROTTLE_MAX, K_RELIEF, kFromRating, toAbs, barG,
} from './engine.js';

const VALVE_Y = 8;
const PI4 = Math.PI / 4;
const area = (mm) => PI4 * (mm / 1000) ** 2;
const num = (v, d = 1) => v.toFixed(d).replace('.', ',');
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/** Solid triangle: the hydraulic flow-direction mark, as opposed to the open pneumatic one. */
const hydTriangle = (x, y, size = 8, dir = 'up') => {
  const s = dir === 'up' ? -1 : 1;
  return poly([[x, y], [x - size / 2, y - s * size], [x + size / 2, y - s * size]], 'sym fill');
};

// ---------------------------------------------------------------------------
// Supply
// ---------------------------------------------------------------------------

const tank = {
  id: 'h_tank', name: 'Reservatório hidráulico', short: 'Reservatório', group: 'Hidráulica — Alimentação',
  size: { w: 40, h: 30 },
  ports: [{ id: 'T', x: 20, y: 0, dir: 'up', kind: 'hydraulic' }],
  params: { tag: { label: 'Identificação', type: 'text', value: '0T1' } },
  stampHydraulic(inst, st, ctx, work) {
    // The tank is the reference: effectively infinite volume at atmospheric pressure.
    st.orificeToFixed(ctx.hnet(inst, 'T'), K_RELIEF * 2, P_TANK, work);
  },
  render() {
    return line(20, 0, 20, 14)
      + line(6, 14, 6, 26) + line(6, 26, 34, 26) + line(34, 26, 34, 14);
  },
};

/**
 * Fixed displacement pump. An ideal flow source with internal leakage that grows with
 * pressure — which is what actually limits it, and why a hydraulic circuit *needs* a
 * relief valve rather than merely benefiting from one.
 */
const pump = {
  id: 'h_pump', name: 'Bomba hidráulica de vazão constante', short: 'Bomba',
  group: 'Hidráulica — Alimentação',
  size: { w: 44, h: 62 },
  ports: [
    { id: 'P', x: 22, y: 0, dir: 'up', kind: 'hydraulic' },
    { id: 'T', x: 22, y: 62, dir: 'down', kind: 'hydraulic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '0P1' },
    flow: { label: 'Vazão da bomba', type: 'range', value: 8, min: 0.5, max: 40, step: 0.5, unit: 'l/min' },
    running: { label: 'Acionamento', type: 'select', value: 'on',
      options: [{ value: 'on', label: 'Ligado' }, { value: 'off', label: 'Desligado' }] },
  },
  faultTypes: ['worn', 'off'],
  initSim(inst) { inst.sim.q = 0; },
  stampHydraulic(inst, st, ctx, work) {
    const nP = ctx.hnet(inst, 'P'), nT = ctx.hnet(inst, 'T');
    const off = inst.params.running.value === 'off' || ctx.fault(inst, 'off');
    // A worn pump still turns; it just loses most of its flow past the vanes.
    const eff = ctx.fault(inst, 'worn') ? 0.35 : 1;
    const q = off ? 0 : (inst.params.flow.value / 60000) * eff;

    st.inject(nP, q);
    st.inject(nT, -q);
    // Internal leakage back to suction. Without it an ideal source into a blocked line
    // would have no bound at all and the solver would chase infinity.
    const K = kFromRating(inst.params.flow.value * (ctx.fault(inst, 'worn') ? 0.25 : 0.03), 100);
    st.orifice(nP, nT, K, work);
    inst.sim.q = q * 60000;
  },
  render(inst) {
    const on = inst.params.running.value === 'on';
    return line(22, 0, 22, 9) + line(22, 53, 22, 62)
      + circle(22, 31, 16)
      + hydTriangle(22, 15, 9, 'up')
      + line(10, 44, 34, 44)
      + text(22, 60, on ? `${num(inst.params.flow.value, 1)} l/min` : 'Desligado', 'sym-tag');
  },
};

/**
 * Pressure relief valve.
 *
 * The poppet is a *state with dynamics*, not an instantaneous function of pressure, and
 * that is not a numerical convenience — it is the physics. A hydraulic node is savagely
 * stiff: 8 l/min into 100 cm³ of oil at β = 1e9 builds 13 bar per millisecond. A
 * massless poppet solved inside the fixed-point loop therefore has to find an
 * equilibrium opening of ~0.06 on a map whose gain is enormous, and it just oscillates
 * (measured: 42 bar of residual, 40 iterations, never settling).
 *
 * A real direct-acting relief responds in 1–3 ms because its poppet has mass and damping.
 * Modelling that makes the opening constant within a tick, which both matches the
 * hardware and turns the iteration back into something that converges.
 */
/** Pressure override of a direct-acting relief: fraction of setting needed for full flow. */
const OVERRIDE_FRAC = 0.2;

const reliefValve = {
  id: 'h_relief', name: 'Válvula de alívio de pressão', short: 'Alívio',
  group: 'Hidráulica — Válvulas de pressão',
  size: { w: 44, h: 62 },
  ports: [
    { id: 'P', x: 22, y: 0, dir: 'up', kind: 'hydraulic' },
    { id: 'T', x: 22, y: 62, dir: 'down', kind: 'hydraulic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '0V1' },
    setpoint: { label: 'Pressão de abertura', type: 'range', value: 60, min: 5, max: 250, step: 5, unit: 'bar' },
  },
  faultTypes: ['stuck_open', 'drift'],
  initSim(inst) { inst.sim.open = 0; },

  stampHydraulic(inst, st, ctx, work) {
    const nP = ctx.hnet(inst, 'P'), nT = ctx.hnet(inst, 'T');
    if (ctx.fault(inst, 'stuck_open')) { inst.sim.open = 1; st.orifice(nP, nT, K_RELIEF, work); return; }

    const set = inst.params.setpoint.value * (ctx.fault(inst, 'drift') ? 0.55 : 1);
    const p = nP != null ? work[nP] : ctx.hpressure(inst, 'P');
    // Pressure override: the extra pressure above cracking needed for full flow. Real
    // direct-acting valves need 15–25% of their setting, not the 4 bar first tried here —
    // and that width is what makes the valve regulable rather than a bang-bang switch.
    const override = Math.max(4e5, toAbs(set) * OVERRIDE_FRAC);
    const open = clamp((p - toAbs(set)) / override, 0, 1);
    inst.sim.open = open;
    if (open > 1e-4) st.orifice(nP, nT, K_RELIEF * open, work);
  },
  render(inst) {
    const B = { x: 4, y: 16, w: 36, h: 30 };
    const open = inst.sim?.open ?? 0;
    return line(22, 0, 22, B.y) + line(22, B.y + B.h, 22, 62)
      + rect(B.x, B.y, B.w, B.h)
      + arrow(22, B.y + B.h - 4, 22, B.y + 4, open > 0.02 ? 'sym' : 'sym thin')
      + path(`M ${B.x + B.w} ${B.y + 6} L ${B.x + B.w + 3} ${B.y + 6}`)
      + spring(B.x + 2, B.y + B.h / 2, 10, 8, 3)
      + line(B.x - 3, B.y + B.h - 6, B.x, B.y + B.h - 6)
      + text(22, 60, `${num(inst.params.setpoint.value, 0)} bar`, 'sym-tag');
  },
};

const hGauge = {
  id: 'h_gauge', name: 'Manômetro hidráulico', short: 'Manômetro hidráulico', group: 'Hidráulica — Instrumentação',
  size: { w: 34, h: 44 },
  ports: [{ id: 'P', x: 17, y: 44, dir: 'down', kind: 'hydraulic' }],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '0Z1' },
    max: { label: 'Faixa de medição', type: 'range', value: 250, min: 25, max: 400, step: 25, unit: 'bar' },
  },
  initSim(inst) { inst.sim.reading = 0; },
  integrate(inst, ctx) { inst.sim.reading = ctx.hgauge(inst, 'P'); },
  render(inst) {
    const p = Math.max(0, inst.sim?.reading ?? 0);
    const frac = Math.min(p / inst.params.max.value, 1);
    const rad = ((-210 + frac * 240) * Math.PI) / 180;
    const cx = 17, cy = 16, r = 13;
    let ticks = '';
    for (let i = 0; i <= 10; i++) {
      const a = ((-210 + (i / 10) * 240) * Math.PI) / 180;
      const r0 = i % 5 === 0 ? r - 4 : r - 2.5;
      ticks += line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0,
                    cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1), 'sym thin');
    }
    return circle(cx, cy, r) + ticks
      + line(cx, cy, cx + Math.cos(rad) * (r - 4), cy + Math.sin(rad) * (r - 4), 'needle')
      + circle(cx, cy, 1.8, 'sym fill')
      + line(cx, cy + r, cx, 44)
      + text(cx, 43, num(p, 0), 'sym-tag');
  },
};

// ---------------------------------------------------------------------------
// Directional valves
// ---------------------------------------------------------------------------

/** 4/3 spool: P, T on the bottom; A, B on top. Three centre types are offered. */
const SPEC_43 = (centre) => ({
  slots: {
    'P': { x: 14, side: 'bottom' }, 'T': { x: 26, side: 'bottom' },
    'A': { x: 12, side: 'top' }, 'B': { x: 28, side: 'top' },
  },
  vents: [],
  boxes: [
    { paths: [['P', 'B'], ['A', 'T']] },   // left: B extends... (crossed)
    centre,
    { paths: [['P', 'A'], ['B', 'T']] },   // right
  ],
});

const CENTRES = {
  closed: { name: 'centro fechado', box: { blocked: ['P', 'T', 'A', 'B'] } },
  float: { name: 'centro flutuante', box: { paths: [['A', 'T'], ['B', 'T']], blocked: ['P'] } },
  bypass: { name: 'centro tandem', box: { paths: [['P', 'T']], blocked: ['A', 'B'] } },
};

function make43(id, centreKey, actuation) {
  const spec = SPEC_43(CENTRES[centreKey].box);
  const geom = { ...spec, actLeft: actuation, actRight: actuation };
  const size = valveSize(geom);
  const left = ACT_W;

  const ports = Object.entries(spec.slots).map(([pid, s]) => ({
    id: pid,
    x: left + s.x,
    y: s.side === 'bottom' ? VALVE_Y + BOX + 6 : VALVE_Y - 6,
    dir: s.side === 'bottom' ? 'down' : 'up',
    kind: 'hydraulic',
  }));

  return {
    id,
    name: `Válvula direcional 4/3, ${CENTRES[centreKey].name}, ${actuation === 'lever' ? 'alavanca manual' : 'acionamento por solenoide'}`,
    short: `4/3 ${centreKey === 'closed' ? 'fechado' : centreKey === 'float' ? 'flutuante' : 'tandem'}`,
    group: 'Hidráulica — Válvulas direcionais',
    size: { w: size.w, h: size.h + 16 },
    ports,
    geom,
    params: actuation === 'lever'
      ? { tag: { label: 'Identificação', type: 'text', value: '1V1' } }
      : {
        tag: { label: 'Identificação', type: 'text', value: '1V1' },
        solA: { label: 'Solenoide esquerdo', type: 'text', value: 'Y1' },
        solB: { label: 'Solenoide direito', type: 'text', value: 'Y2' },
      },
    faultTypes: ['stuck', 'clogged'],
    interactive: actuation === 'lever',
    manual: actuation === 'lever',
    initSim(inst) { inst.sim.state = 1; }, // spring-centred at rest

    updateState(inst, ctx) {
      if (actuation === 'lever') {
        // The lever is driven from the UI: sim.lever is -1 / 0 / +1.
        inst.sim.state = 1 + (inst.sim.lever ?? 0);
        return;
      }
      const a = ctx.sim.energized.get(inst.params.solA.value);
      const b = ctx.sim.energized.get(inst.params.solB.value);
      inst.sim.state = a && !b ? 2 : b && !a ? 0 : 1;
    },

    stampHydraulic(inst, st, ctx, work) {
      const box = geom.boxes[inst.sim.state ?? 1];
      const K = ctx.fault(inst, 'clogged') ? K_VALVE * 0.1 : K_VALVE;
      for (const [x, y] of box.paths || []) {
        st.orifice(ctx.hnet(inst, x), ctx.hnet(inst, y), K, work);
      }
    },

    render(inst) {
      return `<g transform="translate(0,${VALVE_Y})">`
        + drawValve(geom, inst.sim?.state ?? 1, { label: inst.params.tag.value })
        + (actuation === 'solenoid'
          ? text(-2, BOX / 2 + 14, inst.params.solA.value, 'sym-tag', 'end')
            + text(valveSize(geom).w + 2, BOX / 2 + 14, inst.params.solB.value, 'sym-tag', 'start')
          : '')
        + `</g>`;
    },
  };
}

const valve43ClosedLever = make43('h_v43_closed', 'closed', 'lever');
const valve43FloatLever = make43('h_v43_float', 'float', 'lever');
const valve43BypassLever = make43('h_v43_bypass', 'bypass', 'lever');
const valve43ClosedSol = make43('h_v43_closed_sol', 'closed', 'solenoid');

// ---------------------------------------------------------------------------
// Flow and shutoff
// ---------------------------------------------------------------------------

const hCheck = {
  id: 'h_check', name: 'Válvula de retenção hidráulica', short: 'Retenção hidráulica',
  group: 'Hidráulica — Válvulas de bloqueio',
  size: { w: 32, h: 44 },
  ports: [
    { id: '1', x: 16, y: 44, dir: 'down', kind: 'hydraulic' },
    { id: '2', x: 16, y: 0, dir: 'up', kind: 'hydraulic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V2' },
    cracking: { label: 'Pressão de abertura', type: 'range', value: 0.5, min: 0, max: 10, step: 0.5, unit: 'bar' },
  },
  faultTypes: ['stuck_open', 'stuck_closed'],
  stampHydraulic(inst, st, ctx, work) {
    const n1 = ctx.hnet(inst, '1'), n2 = ctx.hnet(inst, '2');
    const p1 = n1 != null ? work[n1] : P_TANK;
    const p2 = n2 != null ? work[n2] : P_TANK;
    let open = p1 > p2 + inst.params.cracking.value * 1e5;
    if (ctx.fault(inst, 'stuck_open')) open = true;
    if (ctx.fault(inst, 'stuck_closed')) open = false;
    st.orifice(n1, n2, open ? K_VALVE : K_VALVE * 1e-4, work);
  },
  render(inst) {
    return line(16, 44, 16, 30) + line(16, 0, 16, 14)
      + circle(16, 20, 6, 'sym fill-soft')
      + line(8, 14, 24, 14) + line(8, 26, 8, 14) + line(24, 26, 24, 14)
      + text(16, 42, inst.params.tag.value, 'sym-tag');
  },
};

const hThrottleCheck = {
  id: 'h_throttle', name: 'Válvula reguladora de fluxo unidirecional hidráulica', short: 'Reguladora hidráulica',
  group: 'Hidráulica — Válvulas de fluxo',
  size: { w: 40, h: 52 },
  ports: [
    { id: '1', x: 20, y: 52, dir: 'down', kind: 'hydraulic' },
    { id: '2', x: 20, y: 0, dir: 'up', kind: 'hydraulic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V3' },
    opening: { label: 'Abertura da restrição', type: 'range', value: 0.35, min: 0.01, max: 1, step: 0.01 },
    freeDir: {
      label: 'Sentido de fluxo livre', type: 'select', value: '1->2',
      options: [{ value: '1->2', label: '1 → 2' }, { value: '2->1', label: '2 → 1' }],
    },
  },
  faultTypes: ['blocked'],
  stampHydraulic(inst, st, ctx, work) {
    const n1 = ctx.hnet(inst, '1'), n2 = ctx.hnet(inst, '2');
    const o = ctx.fault(inst, 'blocked') ? 0.01 : inst.params.opening.value;
    let K = K_THROTTLE_MAX * (0.005 + 0.995 * o * o);
    const p1 = n1 != null ? work[n1] : P_TANK;
    const p2 = n2 != null ? work[n2] : P_TANK;
    const free = inst.params.freeDir.value === '1->2' ? p1 > p2 : p2 > p1;
    if (free) K += K_VALVE;
    st.orifice(n1, n2, K, work);
  },
  render(inst) {
    const o = inst.params.opening.value;
    const up = inst.params.freeDir.value === '1->2';
    const B = { x: 2, y: 8, w: 36, h: 36 };
    const cy = B.y + B.h / 2;
    let s = line(20, 52, 20, B.y + B.h) + line(20, 0, 20, B.y)
      + rect(B.x, B.y, B.w, B.h, 'sym dash');
    s += line(20, B.y + B.h, 11, B.y + B.h) + line(11, B.y + B.h, 11, B.y) + line(11, B.y, 20, B.y);
    s += line(20, B.y + B.h, 29, B.y + B.h) + line(29, B.y + B.h, 29, B.y) + line(29, B.y, 20, B.y);
    s += circle(11, cy, 4, 'sym fill-soft') + line(6, up ? cy - 4 : cy + 4, 16, up ? cy - 4 : cy + 4);
    s += path(`M ${24} ${cy - 7} Q ${29} ${cy - 2} ${34} ${cy - 7}`);
    s += path(`M ${24} ${cy + 7} Q ${29} ${cy + 2} ${34} ${cy + 7}`);
    s += arrow(B.x - 1, B.y + B.h - 2, B.x + B.w + 1, B.y + 2 + (1 - o) * 10, 'sym thin');
    return s + text(20, B.y + B.h + 14, inst.params.tag.value, 'sym-tag');
  },
};

/**
 * Counterbalance valve. Holds a suspended load: it blocks flow out of the load-holding
 * port until either the load pressure alone exceeds the setting, or a pilot from the
 * opposing line opens it. Without the pilot ratio it would just be a relief valve; the
 * ratio is what lets a modest supply pressure release a much larger load pressure.
 */
const counterbalance = {
  id: 'h_counterbalance', name: 'Válvula de contrabalanço (Counterbalance)', short: 'Contrabalanço',
  group: 'Hidráulica — Válvulas de pressão',
  size: { w: 48, h: 58 },
  ports: [
    { id: '1', x: 24, y: 58, dir: 'down', kind: 'hydraulic' },  // valve side
    { id: '2', x: 24, y: 0, dir: 'up', kind: 'hydraulic' },     // load side
    { id: 'X', x: 3, y: 29, dir: 'left', kind: 'hydraulic' },   // pilot
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V4' },
    setpoint: { label: 'Pressão de sustentação', type: 'range', value: 90, min: 10, max: 300, step: 5, unit: 'bar' },
    ratio: { label: 'Relação de pilotagem', type: 'range', value: 4, min: 1, max: 10, step: 0.5 },
  },
  faultTypes: ['stuck_open', 'drift'],
  initSim(inst) { inst.sim.open = 0; inst.sim.free = false; },

  stampHydraulic(inst, st, ctx, work) {
    const n1 = ctx.hnet(inst, '1'), n2 = ctx.hnet(inst, '2'), nX = ctx.hnet(inst, 'X');
    const p1 = n1 != null ? work[n1] : P_TANK;
    const p2 = n2 != null ? work[n2] : P_TANK;

    // Feeding the load: the built-in check bypasses the poppet entirely.
    inst.sim.free = p1 > p2 + 0.5e5;
    if (inst.sim.free || ctx.fault(inst, 'stuck_open')) {
      inst.sim.open = 1;
      st.orifice(n1, n2, K_VALVE, work);
      return;
    }

    const set = toAbs(inst.params.setpoint.value * (ctx.fault(inst, 'drift') ? 0.5 : 1));
    const pilot = nX != null ? work[nX] : P_TANK;
    // Load pressure plus the assisted pilot must together beat the spring. The ratio is
    // the point of the component: a modest supply pressure releases a much larger load.
    const effective = p2 + (pilot - P_TANK) * inst.params.ratio.value;
    const open = clamp((effective - set) / (set * OVERRIDE_FRAC), 0, 1);
    inst.sim.open = open;
    // 1e-5 residual leakage stands in for seat leakage; a mathematically perfect seal
    // would hide any creep the rest of the model actually produces.
    st.orifice(n1, n2, K_VALVE * Math.max(open, 1e-5), work);
  },
  render(inst) {
    const B = { x: 6, y: 12, w: 36, h: 34 };
    const open = inst.sim?.open ?? 0;
    return line(24, 58, 24, B.y + B.h) + line(24, 0, 24, B.y)
      + line(3, 29, B.x, 29)
      + rect(B.x, B.y, B.w, B.h, 'sym dash')
      + arrow(24, B.y + B.h - 4, 24, B.y + 4, open > 0.02 ? 'sym' : 'sym thin')
      + spring(B.x + 2, B.y + B.h - 6, 9, 6, 3)
      + circle(B.x + B.w - 8, B.y + 8, 4, 'sym fill-soft')
      + text(0, 26, 'X', 'sym-port', 'start')
      + text(24, 56, `${num(inst.params.setpoint.value, 0)} bar`, 'sym-tag');
  },
};

// ---------------------------------------------------------------------------
// Actuators
// ---------------------------------------------------------------------------

const HC_W = 92, HC_H = 34;
const HWALL = 2, HPISTON = 6;
const HC_TRAVEL = HC_W - 2 * HWALL - HPISTON - 2;
const HC_BOX_W = HC_W + HC_TRAVEL + 8;

const hCylinder = {
  id: 'h_cyl', name: 'Cilindro hidráulico de dupla ação', short: 'Cilindro hidráulico',
  group: 'Hidráulica — Atuadores',
  size: { w: HC_BOX_W, h: HC_H + 16 },
  ports: [
    { id: 'A', x: 12, y: HC_H + 14, dir: 'down', kind: 'hydraulic' },
    { id: 'B', x: HC_W - 12, y: HC_H + 14, dir: 'down', kind: 'hydraulic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1A1' },
    bore: { label: 'Diâmetro do pistão', type: 'range', value: 40, min: 16, max: 125, step: 1, unit: 'mm' },
    rod: { label: 'Diâmetro da haste', type: 'range', value: 20, min: 8, max: 70, step: 1, unit: 'mm' },
    stroke: { label: 'Curso', type: 'range', value: 200, min: 50, max: 800, step: 10, unit: 'mm' },
    mass: { label: 'Massa em movimento', type: 'range', value: 50, min: 1, max: 500, step: 1, unit: 'kg' },
    load: { label: 'Carga no avanço', type: 'range', value: 0, min: -20000, max: 20000, step: 250, unit: 'N' },
    friction: { label: 'Atrito viscoso', type: 'range', value: 6000, min: 500, max: 40000, step: 500, unit: 'Ns/m' },
    coulomb: { label: 'Atrito estático/dinâmico', type: 'range', value: 120, min: 0, max: 3000, step: 10, unit: 'N' },
  },
  faultTypes: ['seized', 'leak'],
  initSim(inst) { inst.sim.x = 0; inst.sim.v = 0; },

  stampHydraulic(inst, st, ctx, work) {
    const { bore, rod, stroke } = inst.params;
    const Aa = area(bore.value);
    const Ab = Aa - area(rod.value);
    const L = stroke.value / 1000;
    const dead = 2e-5;
    const nA = ctx.hnet(inst, 'A'), nB = ctx.hnet(inst, 'B');

    st.oilCapacitance(nA, dead + Aa * L * inst.sim.x, ctx.hpressure(inst, 'A'), Aa * inst.sim.v);
    st.oilCapacitance(nB, dead + Ab * L * (1 - inst.sim.x), ctx.hpressure(inst, 'B'), -Ab * inst.sim.v);
    if (ctx.fault(inst, 'leak')) st.orifice(nA, nB, kFromRating(1.5, 100), work);
  },

  integrate(inst, ctx) {
    if (ctx.fault(inst, 'seized')) { inst.sim.v = 0; return; }
    const { bore, rod, stroke, mass, load, friction, coulomb } = inst.params;
    const Aa = area(bore.value);
    const Ab = Aa - area(rod.value);
    const L = stroke.value / 1000;
    const dt = ctx.dt;

    const Fp = ctx.hgauge(inst, 'A') * 1e5 * Aa - ctx.hgauge(inst, 'B') * 1e5 * Ab - load.value;

    const stiction = coulomb.value * 1.5;
    let v = inst.sim.v;
    if (Math.abs(v) < 1e-5 && Math.abs(Fp) < stiction) {
      v = 0;
    } else {
      const dir = v !== 0 ? Math.sign(v) : Math.sign(Fp);
      const Fnet = Fp - coulomb.value * dir;
      if (v !== 0 && Math.sign(Fnet) !== dir && Math.abs(Fp) < coulomb.value) v = 0;
      else v = (mass.value * v + dt * Fnet) / (mass.value + dt * friction.value);
    }
    let x = inst.sim.x + (v * dt) / L;
    if (x <= 0) { x = 0; v = Math.max(v, 0); }
    if (x >= 1) { x = 1; v = Math.min(v, 0); }
    inst.sim.v = v; inst.sim.x = x;
  },

  render(inst) {
    const x = inst.sim?.x ?? 0;
    const inner = { x: HWALL, y: HWALL, w: HC_W - 2 * HWALL, h: HC_H - 2 * HWALL };
    const px = inner.x + 1 + x * HC_TRAVEL;
    const rodTip = HC_W + x * HC_TRAVEL;
    const midY = HC_H / 2;
    let s = rect(HWALL, HWALL, inner.w, inner.h, 'sym barrel');
    s += line(HC_W - HWALL, HWALL, HC_W - HWALL, midY - 4);
    s += line(HC_W - HWALL, midY + 4, HC_W - HWALL, HC_H - HWALL);
    s += rect(px, inner.y, HPISTON, inner.h, 'sym fill-soft');
    s += rect(px + HPISTON, midY - 3, rodTip - px - HPISTON, 6, 'sym fill-soft');
    return s
      + line(12, HC_H, 12, HC_H + 14) + line(HC_W - 12, HC_H, HC_W - 12, HC_H + 14)
      + text(6, HC_H + 12, 'A', 'sym-port') + text(HC_W - 18, HC_H + 12, 'B', 'sym-port')
      + text(HC_W / 2, -6, inst.params.tag.value, 'sym-tag');
  },
};

export const HYDRAULIC_CATALOG = [
  hCylinder,
  tank, pump, hGauge,
  valve43ClosedLever, valve43FloatLever, valve43BypassLever, valve43ClosedSol,
  reliefValve, counterbalance,
  hCheck, hThrottleCheck,
];
