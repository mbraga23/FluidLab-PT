// Component catalog.
//
// Each definition owns its symbol, its ports and its physics together, so adding a
// component never means touching the solver or the editor. The contract:
//
//   size        static bbox {w,h} used for hit-testing and selection
//   ports       [{id,x,y,dir,kind,vent?}] in local coords; (x,y) is the wire endpoint
//   params      user-editable values, surfaced automatically by the inspector
//   initSim     seed per-run state on inst.sim
//   updateState discrete state: spool positions, latches, switches
//   stamp       pneumatic conductances / sources / gas volumes
//   stampElectric  same for the 24V side
//   integrate   mechanics, run after pressures are solved
//   render      SVG string in local coords
//
// Coordinate convention for valves: the symbol body is drawn at y=8 so the top port
// stubs land on y=2 and the bottom ones on y=46, giving a 48px-tall static frame.

import {
  BOX, ACT_W, line, rect, circle, path, text, arrow, spring,
  ventTriangle, sourceTriangle, drawValve, valveSize,
} from './symbols.js';
import {
  P_ATM, toAbs, C_VALVE, C_SUPPLY, C_EXHAUST, C_THROTTLE_MAX, B_CRIT,
} from './engine.js';

const VALVE_Y = 8;
const PI4 = Math.PI / 4;

const area = (mm) => PI4 * (mm / 1000) ** 2;

/** Decimal comma for anything the user reads off a symbol. */
const num = (v, d = 1) => v.toFixed(d).replace('.', ',');

/**
 * Defect catalogue. Components declare `faultTypes: ['stuck', ...]`; the inspector
 * renders whatever they declare, so adding a defect to a component needs no UI change.
 */
export const FAULT_LABELS = {
  stuck: 'Válvula travada na posição atual',
  clogged: 'Obstrução (vazão muito reduzida)',
  leak: 'Vazamento',
  off: 'Falha na alimentação',
  weak: 'Alimentação insuficiente',
  blocked: 'Restrição obstruída',
  check_stuck: 'Válvula de retenção travada fechada',
  stuck_open: 'Travado aberto',
  stuck_closed: 'Travado fechado',
  seized: 'Pistão travado',
  drift: 'Desvio do valor de ajuste',
  coil_open: 'Bobina interrompida',
  contact_welded: 'Contato soldado',
};

/** Builds a full component definition from a compact valve description. */
function makeValve({
  id, name, short, group, spec, actLeft, actRight, defaultState = 0,
  restState = 0, memory = false, tag = '1V1',
}) {
  const geom = { ...spec, actLeft, actRight };
  const size = valveSize(geom);
  const left = actLeft ? ACT_W : 0;

  const ports = Object.entries(spec.slots).map(([pid, s]) => ({
    id: pid,
    x: left + s.x,
    y: s.side === 'bottom' ? VALVE_Y + BOX + 6 : VALVE_Y - 6,
    dir: s.side === 'bottom' ? 'down' : 'up',
    kind: 'pneumatic',
    vent: (spec.vents || []).includes(pid),
  }));

  return {
    id, name, short, group,
    size: { w: size.w, h: size.h + 16 },
    ports,
    geom,
    memory,
    restState,
    params: { tag: { label: 'Identificação', type: 'text', value: tag } },

    initSim(inst) { inst.sim.state = defaultState; },

    faultTypes: ['stuck', 'clogged', 'leak'],

    stamp(inst, st, ctx, work) {
      const box = geom.boxes[inst.sim.state ?? defaultState];
      const netOf = (pid) => ctx.net(inst, pid);
      // A clogged valve still switches — it just cannot pass its rated flow.
      const C = ctx.fault(inst, 'clogged') ? C_VALVE * 0.08 : C_VALVE;

      for (const [a, b] of box.paths || []) {
        st.restrict(netOf(a), netOf(b), C, B_CRIT, work);
      }
      // An exhaust port with nothing plugged into it simply breathes.
      for (const p of ports) {
        if (!p.vent) continue;
        if (!ctx.sim.circuit.hasWire(inst.id, p.id)) {
          st.restrictToFixed(netOf(p.id), C_EXHAUST, B_CRIT, P_ATM, work);
        }
      }
      if (ctx.fault(inst, 'leak')) {
        for (const p of ports) st.restrictToFixed(netOf(p.id), C_VALVE * 0.06, B_CRIT, P_ATM, work);
      }
    },

    render(inst) {
      const label = inst.params?.tag?.value ?? tag;
      return `<g transform="translate(0,${VALVE_Y})">${drawValve(geom, inst.sim?.state ?? defaultState, { label })}</g>`;
    },
  };
}

// --- Shared spool geometries -------------------------------------------------

const SPEC_52 = {
  slots: {
    '5': { x: 8, side: 'bottom' }, '1': { x: 20, side: 'bottom' }, '3': { x: 32, side: 'bottom' },
    '4': { x: 12, side: 'top' }, '2': { x: 28, side: 'top' },
  },
  vents: ['3', '5'],
  // box 0 = "a": 1->2 and 4->5   |   box 1 = "b": 1->4 and 2->3
  boxes: [
    { paths: [['1', '2'], ['4', '5']] },
    { paths: [['1', '4'], ['2', '3']] },
  ],
};

const SPEC_32_NC = {
  slots: {
    '1': { x: 13, side: 'bottom' }, '3': { x: 27, side: 'bottom' },
    '2': { x: 20, side: 'top' },
  },
  vents: ['3'],
  boxes: [
    { paths: [['2', '3']], blocked: ['1'] }, // rest: output vented
    { paths: [['1', '2']], blocked: ['3'] }, // actuated: supply through
  ],
};

const SPEC_32_NO = {
  slots: SPEC_32_NC.slots,
  vents: ['3'],
  boxes: [
    { paths: [['1', '2']], blocked: ['3'] },
    { paths: [['2', '3']], blocked: ['1'] },
  ],
};

const SPEC_53_CLOSED = {
  slots: SPEC_52.slots,
  vents: ['3', '5'],
  boxes: [
    { paths: [['1', '4'], ['2', '3']] },
    { blocked: ['1', '2', '3', '4', '5'] }, // mid position, all ports shut
    { paths: [['1', '2'], ['4', '5']] },
  ],
};

// ---------------------------------------------------------------------------
// Valves
// ---------------------------------------------------------------------------

const valve32Button = {
  ...makeValve({
    id: 'v32_button', name: 'Válvula direcional 3/2, botão, retorno por mola', short: '3/2 NF botão',
    group: 'Válvulas direcionais', spec: SPEC_32_NC, actLeft: 'button', actRight: 'spring', tag: '1S1',
  }),
  interactive: true,
  initSim(inst) { inst.sim.state = 0; inst.sim.pressed = false; },
  updateState(inst) { inst.sim.state = inst.sim.pressed ? 1 : 0; },
};

const valve32ButtonNO = {
  ...makeValve({
    id: 'v32_button_no', name: 'Válvula direcional 3/2, botão, normalmente aberta', short: '3/2 NA botão',
    group: 'Válvulas direcionais', spec: SPEC_32_NO, actLeft: 'button', actRight: 'spring', tag: '1S2',
  }),
  interactive: true,
  initSim(inst) { inst.sim.state = 0; inst.sim.pressed = false; },
  updateState(inst) { inst.sim.state = inst.sim.pressed ? 1 : 0; },
};

const valve32Detent = {
  ...makeValve({
    id: 'v32_detent', name: 'Válvula direcional 3/2, alavanca com trava', short: '3/2 com trava',
    group: 'Válvulas direcionais', spec: SPEC_32_NC, actLeft: 'lever', actRight: 'detent', tag: '1S3',
  }),
  interactive: true,
  toggle: true,
  initSim(inst) { inst.sim.state = 0; inst.sim.pressed = false; },
  updateState(inst) { inst.sim.state = inst.sim.pressed ? 1 : 0; },
};

/** Roller lever valve: a 3/2 driven by a cylinder reaching a set position. */
const valve32Roller = (() => {
  const base = makeValve({
    id: 'v32_roller', name: 'Válvula direcional 3/2, alavanca com rolete (fim de curso)', short: '3/2 rolete',
    group: 'Válvulas direcionais', spec: SPEC_32_NC, actLeft: 'roller', actRight: 'spring', tag: '1S1',
  });
  return {
    ...base,
    params: {
      tag: { label: 'Identificação', type: 'text', value: '1S1' },
      target: { label: 'Cilindro', type: 'cylinder', value: null },
      at: { label: 'Posição', type: 'range', value: 1, min: 0, max: 1, step: 0.01, unit: '' },
      width: { label: 'Faixa de acionamento', type: 'range', value: 0.04, min: 0.01, max: 0.2, step: 0.01 },
    },
    initSim(inst) { inst.sim.state = 0; inst.sim.pressed = false; },
    updateState(inst, ctx) {
      const target = ctx.sim.circuit.byId(inst.params.target.value);
      const at = inst.params.at.value;
      const w = inst.params.width.value;
      const x = target?.sim?.x;
      inst.sim.pressed = x != null && x >= at - w && x <= at + w;
      inst.sim.state = inst.sim.pressed ? 1 : 0;
    },
  };
})();

const valve52Pilot = {
  ...makeValve({
    id: 'v52_pilot', name: 'Válvula direcional 5/2, duplo piloto pneumático (memória)', short: '5/2 duplo piloto',
    group: 'Válvulas direcionais', spec: SPEC_52, actLeft: 'pilot', actRight: 'pilot',
    memory: true, tag: '1V1',
  }),
  ports: [
    ...makeValve({ id: 'x', name: 'x', short: 'x', group: 'x', spec: SPEC_52, actLeft: 'pilot', actRight: 'pilot' }).ports,
    { id: '14', x: 4, y: 8 + BOX / 2, dir: 'left', kind: 'pneumatic' },
    { id: '12', x: ACT_W + 2 * BOX + ACT_W - 4, y: 8 + BOX / 2, dir: 'right', kind: 'pneumatic' },
  ],
  initSim(inst) { inst.sim.state = 0; },
  updateState(inst, ctx) {
    // Double-pilot valve is a memory element: it holds its last commanded position.
    const p14 = ctx.gauge(inst, '14');
    const p12 = ctx.gauge(inst, '12');
    if (p14 > 2.5 && p14 > p12) inst.sim.state = 1;
    else if (p12 > 2.5 && p12 > p14) inst.sim.state = 0;
  },
  render(inst) {
    const label = inst.params?.tag?.value ?? '1V1';
    const g = { ...SPEC_52, actLeft: 'pilot', actRight: 'pilot' };
    const w = valveSize(g).w;
    return `<g transform="translate(0,${VALVE_Y})">`
      + drawValve(g, inst.sim?.state ?? 0, { label })
      + text(-2, BOX / 2 - 6, '14', 'sym-port', 'end')
      + text(w + 2, BOX / 2 - 6, '12', 'sym-port', 'start')
      + `</g>`;
  },
};

const valve52Solenoid = {
  ...makeValve({
    id: 'v52_sol', name: 'Válvula direcional 5/2, duplo solenoide', short: '5/2 duplo solenoide',
    group: 'Válvulas direcionais', spec: SPEC_52, actLeft: 'solenoid', actRight: 'solenoid', tag: '1V1',
  }),
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V1' },
    solA: { label: 'Solenoide esquerdo', type: 'text', value: 'Y1' },
    solB: { label: 'Solenoide direito', type: 'text', value: 'Y2' },
  },
  initSim(inst) { inst.sim.state = 0; },
  updateState(inst, ctx) {
    const a = ctx.sim.energized.get(inst.params.solA.value);
    const b = ctx.sim.energized.get(inst.params.solB.value);
    if (a && !b) inst.sim.state = 1;
    else if (b && !a) inst.sim.state = 0;
  },
  render(inst) {
    const g = { ...SPEC_52, actLeft: 'solenoid', actRight: 'solenoid' };
    const w = valveSize(g).w;
    return `<g transform="translate(0,${VALVE_Y})">`
      + drawValve(g, inst.sim?.state ?? 0, { label: inst.params.tag.value })
      + text(-2, BOX / 2 + 14, inst.params.solA.value, 'sym-tag', 'end')
      + text(w + 2, BOX / 2 + 14, inst.params.solB.value, 'sym-tag', 'start')
      + `</g>`;
  },
};

const valve52SolenoidSpring = {
  ...makeValve({
    id: 'v52_sol_spring', name: 'Válvula direcional 5/2, solenoide, retorno por mola', short: '5/2 solenoide/mola',
    group: 'Válvulas direcionais', spec: SPEC_52, actLeft: 'solenoid', actRight: 'spring', tag: '1V1',
  }),
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V1' },
    solA: { label: 'Solenoide', type: 'text', value: 'Y1' },
  },
  initSim(inst) { inst.sim.state = 0; },
  updateState(inst, ctx) {
    inst.sim.state = ctx.sim.energized.get(inst.params.solA.value) ? 1 : 0;
  },
  render(inst) {
    const g = { ...SPEC_52, actLeft: 'solenoid', actRight: 'spring' };
    return `<g transform="translate(0,${VALVE_Y})">`
      + drawValve(g, inst.sim?.state ?? 0, { label: inst.params.tag.value })
      + text(-2, BOX / 2 + 14, inst.params.solA.value, 'sym-tag', 'end')
      + `</g>`;
  },
};

const valve32Solenoid = {
  ...makeValve({
    id: 'v32_sol', name: 'Válvula direcional 3/2, solenoide, retorno por mola', short: '3/2 solenoide',
    group: 'Válvulas direcionais', spec: SPEC_32_NC, actLeft: 'solenoid', actRight: 'spring', tag: '1V1',
  }),
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V1' },
    solA: { label: 'Solenoide', type: 'text', value: 'Y1' },
  },
  initSim(inst) { inst.sim.state = 0; },
  updateState(inst, ctx) {
    inst.sim.state = ctx.sim.energized.get(inst.params.solA.value) ? 1 : 0;
  },
  render(inst) {
    const g = { ...SPEC_32_NC, actLeft: 'solenoid', actRight: 'spring' };
    return `<g transform="translate(0,${VALVE_Y})">`
      + drawValve(g, inst.sim?.state ?? 0, { label: inst.params.tag.value })
      + text(-2, BOX / 2 + 14, inst.params.solA.value, 'sym-tag', 'end')
      + `</g>`;
  },
};

const valve53Closed = {
  ...makeValve({
    id: 'v53_closed', name: 'Válvula direcional 5/3, centro fechado', short: '5/3 centro fechado',
    group: 'Válvulas direcionais', spec: SPEC_53_CLOSED, actLeft: 'pilot', actRight: 'pilot',
    defaultState: 1, tag: '1V1',
  }),
  ports: (() => {
    const base = makeValve({ id: 'x', name: 'x', short: 'x', group: 'x', spec: SPEC_53_CLOSED, actLeft: 'pilot', actRight: 'pilot' }).ports;
    return [
      ...base,
      { id: '14', x: 4, y: 8 + BOX / 2, dir: 'left', kind: 'pneumatic' },
      { id: '12', x: ACT_W + 3 * BOX + ACT_W - 4, y: 8 + BOX / 2, dir: 'right', kind: 'pneumatic' },
    ];
  })(),
  initSim(inst) { inst.sim.state = 1; },
  updateState(inst, ctx) {
    const p14 = ctx.gauge(inst, '14');
    const p12 = ctx.gauge(inst, '12');
    if (p14 > 2.5 && p12 <= 2.5) inst.sim.state = 2;
    else if (p12 > 2.5 && p14 <= 2.5) inst.sim.state = 0;
    else inst.sim.state = 1; // both or neither piloted -> spring-centred
  },
};

// ---------------------------------------------------------------------------
// Supply and conditioning
// ---------------------------------------------------------------------------

const airSupply = {
  id: 'supply', name: 'Fonte de ar comprimido', short: 'Fonte', group: 'Alimentação',
  size: { w: 44, h: 38 },
  ports: [{ id: '1', x: 22, y: 0, dir: 'up', kind: 'pneumatic' }],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '0Z1' },
    pressure: { label: 'Pressão de trabalho', type: 'range', value: 6, min: 0, max: 10, step: 0.1, unit: 'bar' },
  },
  faultTypes: ['off', 'weak'],
  stamp(inst, st, ctx, work) {
    if (ctx.fault(inst, 'off')) return; // supply failure: the source is simply gone
    const C = ctx.fault(inst, 'weak') ? C_SUPPLY * 0.08 : C_SUPPLY;
    st.restrictToFixed(ctx.net(inst, '1'), C, B_CRIT, toAbs(inst.params.pressure.value), work);
  },
  render(inst) {
    return line(22, 0, 22, 13)
      + sourceTriangle(22, 13, 12, 'up')
      + text(22, 36, `${num(inst.params.pressure.value, 1)} bar`, 'sym-tag');
  },
};

const silencer = {
  id: 'silencer', name: 'Silenciador', short: 'Silenciador', group: 'Alimentação',
  size: { w: 20, h: 22 },
  ports: [{ id: '1', x: 10, y: 0, dir: 'up', kind: 'pneumatic' }],
  params: {},
  faultTypes: ['clogged'],
  stamp(inst, st, ctx, work) {
    const C = ctx.fault(inst, 'clogged') ? C_EXHAUST * 0.04 : C_EXHAUST;
    st.restrictToFixed(ctx.net(inst, '1'), C, B_CRIT, P_ATM, work);
  },
  render() {
    return line(10, 0, 10, 6)
      + ventTriangle(10, 6, 9, 'down')
      + line(3, 18, 17, 18) + line(5, 21, 15, 21);
  },
};

const gauge = {
  id: 'gauge', name: 'Manômetro', short: 'Manômetro', group: 'Instrumentação',
  size: { w: 32, h: 40 },
  ports: [{ id: '1', x: 16, y: 40, dir: 'down', kind: 'pneumatic' }],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '0Z2' },
    max: { label: 'Faixa de medição', type: 'range', value: 10, min: 1, max: 16, step: 1, unit: 'bar' },
  },
  render(inst) {
    const p = Math.max(0, inst.sim?.reading ?? 0);
    const frac = Math.min(p / inst.params.max.value, 1);
    const ang = -210 + frac * 240; // sweep from lower-left round to lower-right
    const rad = (ang * Math.PI) / 180;
    const cx = 16, cy = 16, r = 13;
    let ticks = '';
    for (let i = 0; i <= 10; i++) {
      const a = ((-210 + (i / 10) * 240) * Math.PI) / 180;
      const r0 = i % 5 === 0 ? r - 4 : r - 2.5;
      ticks += line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0,
                    cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1), 'sym thin');
    }
    return circle(cx, cy, r)
      + ticks
      + line(cx, cy, cx + Math.cos(rad) * (r - 4), cy + Math.sin(rad) * (r - 4), 'needle')
      + circle(cx, cy, 1.8, 'sym fill')
      + line(cx, cy + r, cx, 40)
      + text(cx, 39, num(p, 1), 'sym-tag');
  },
  integrate(inst, ctx) { inst.sim.reading = ctx.gauge(inst, '1'); },
};

// ---------------------------------------------------------------------------
// Flow control
// ---------------------------------------------------------------------------

const throttleCheck = {
  id: 'throttle_check', name: 'Válvula reguladora de fluxo unidirecional', short: 'Reguladora de fluxo', group: 'Válvulas de fluxo',
  size: { w: 40, h: 52 },
  ports: [
    { id: '1', x: 20, y: 52, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: 20, y: 0, dir: 'up', kind: 'pneumatic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V2' },
    opening: { label: 'Abertura da restrição', type: 'range', value: 0.35, min: 0.01, max: 1, step: 0.01 },
    freeDir: {
      label: 'Sentido de fluxo livre', type: 'select', value: '1->2',
      options: [{ value: '1->2', label: '1 → 2 (restrição na saída)' }, { value: '2->1', label: '2 → 1 (restrição na entrada)' }],
    },
  },
  faultTypes: ['blocked', 'check_stuck'],
  stamp(inst, st, ctx, work) {
    const n1 = ctx.net(inst, '1'), n2 = ctx.net(inst, '2');
    const o = ctx.fault(inst, 'blocked') ? 0.004 : inst.params.opening.value;
    // Quadratic in the setting: a needle valve's area grows far slower than its turns,
    // so a linear map would make the top of the range useless.
    let C = C_THROTTLE_MAX * (0.004 + 0.996 * o * o);

    const p1 = ctx.pressure(inst, '1'), p2 = ctx.pressure(inst, '2');
    const free = inst.params.freeDir.value === '1->2' ? p1 > p2 : p2 > p1;
    // Check valve lifts off its seat and bypasses the throttle entirely.
    if (free && !ctx.fault(inst, 'check_stuck')) C += C_VALVE;
    st.restrict(n1, n2, C, B_CRIT, work);
  },
  render(inst) {
    const o = inst.params.opening.value;
    const up = inst.params.freeDir.value === '1->2';
    const B = { x: 2, y: 8, w: 36, h: 36 };
    let s = line(20, 52, 20, B.y + B.h) + line(20, 0, 20, B.y)
      + rect(B.x, B.y, B.w, B.h, 'sym dash')
      + text(14, 51, '1', 'sym-port') + text(14, 7, '2', 'sym-port');

    // Split into the two parallel internal branches.
    s += line(20, B.y + B.h, 11, B.y + B.h) + line(11, B.y + B.h, 11, B.y) + line(11, B.y, 20, B.y);
    s += line(20, B.y + B.h, 29, B.y + B.h) + line(29, B.y + B.h, 29, B.y) + line(29, B.y, 20, B.y);

    // Check valve: ball resting on a seat, orientation follows the free direction.
    const cy = B.y + B.h / 2;
    s += circle(11, cy, 4);
    const seatY = up ? cy - 4 : cy + 4;
    s += line(11 - 5, seatY, 11 + 5, seatY);

    // Throttle: opposed wedges plus the adjustment arrow, which tilts with the setting.
    s += path(`M ${29 - 5} ${cy - 7} Q ${29} ${cy - 2} ${29 + 5} ${cy - 7}`);
    s += path(`M ${29 - 5} ${cy + 7} Q ${29} ${cy + 2} ${29 + 5} ${cy + 7}`);
    const t = 1 - o;
    s += arrow(B.x - 1, B.y + B.h - 2, B.x + B.w + 1, B.y + 2 + t * 10, 'sym thin');
    return s + text(20, B.y + B.h + 14, inst.params.tag.value, 'sym-tag');
  },
};

const shuttleValve = {
  id: 'shuttle', name: 'Válvula alternadora (OU)', short: 'OU', group: 'Válvulas de bloqueio',
  size: { w: 40, h: 44 },
  ports: [
    { id: '1a', x: 10, y: 44, dir: 'down', kind: 'pneumatic' },
    { id: '1b', x: 30, y: 44, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: 20, y: 0, dir: 'up', kind: 'pneumatic' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: '1V3' } },
  initSim(inst) { inst.sim.side = 'a'; },
  updateState(inst, ctx) {
    const pa = ctx.pressure(inst, '1a'), pb = ctx.pressure(inst, '1b');
    // Hysteresis: without it the ball chatters between seats at equal pressure.
    if (pa > pb + 5000) inst.sim.side = 'a';
    else if (pb > pa + 5000) inst.sim.side = 'b';
  },
  stamp(inst, st, ctx, work) {
    const src = inst.sim.side === 'a' ? '1a' : '1b';
    st.restrict(ctx.net(inst, src), ctx.net(inst, '2'), C_VALVE, B_CRIT, work);
  },
  render(inst) {
    const B = { x: 2, y: 10, w: 36, h: 24 };
    const ballX = inst.sim?.side === 'a' ? 26 : 14; // ball seals the idle inlet
    return rect(B.x, B.y, B.w, B.h)
      + line(10, 44, 10, B.y + B.h) + line(30, 44, 30, B.y + B.h) + line(20, 0, 20, B.y)
      + line(B.x, B.y + B.h, B.x + B.w, B.y + B.h)
      + circle(ballX, B.y + B.h / 2 + 2, 5)
      + line(B.x + 4, B.y + 4, 20, B.y + B.h - 4)
      + line(B.x + B.w - 4, B.y + 4, 20, B.y + B.h - 4)
      + text(4, 43, '1', 'sym-port') + text(36, 43, '1', 'sym-port') + text(14, 9, '2', 'sym-port')
      + text(20, B.y + B.h + 16, inst.params.tag.value, 'sym-tag');
  },
};

const twoPressureValve = {
  id: 'two_pressure', name: 'Válvula de simultaneidade (E)', short: 'E', group: 'Válvulas de bloqueio',
  size: { w: 40, h: 44 },
  ports: [
    { id: '1a', x: 10, y: 44, dir: 'down', kind: 'pneumatic' },
    { id: '1b', x: 30, y: 44, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: 20, y: 0, dir: 'up', kind: 'pneumatic' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: '1V4' } },
  initSim(inst) { inst.sim.side = 'a'; },
  updateState(inst, ctx) {
    const pa = ctx.pressure(inst, '1a'), pb = ctx.pressure(inst, '1b');
    // The *lower* signal wins: the higher one shoves the ball across and seals itself off.
    if (pa < pb - 5000) inst.sim.side = 'a';
    else if (pb < pa - 5000) inst.sim.side = 'b';
  },
  stamp(inst, st, ctx, work) {
    const src = inst.sim.side === 'a' ? '1a' : '1b';
    st.restrict(ctx.net(inst, src), ctx.net(inst, '2'), C_VALVE, B_CRIT, work);
  },
  render(inst) {
    const B = { x: 2, y: 10, w: 36, h: 24 };
    const ballX = inst.sim?.side === 'a' ? 26 : 14;
    return rect(B.x, B.y, B.w, B.h)
      + line(10, 44, 10, B.y + B.h) + line(30, 44, 30, B.y + B.h) + line(20, 0, 20, B.y)
      + line(B.x, B.y, B.x + B.w, B.y)
      + circle(ballX, B.y + B.h / 2 - 2, 5)
      + line(B.x + 4, B.y + B.h - 4, 20, B.y + 4)
      + line(B.x + B.w - 4, B.y + B.h - 4, 20, B.y + 4)
      + text(4, 43, '1', 'sym-port') + text(36, 43, '1', 'sym-port') + text(14, 9, '2', 'sym-port')
      + text(20, B.y + B.h + 16, inst.params.tag.value, 'sym-tag');
  },
};

const quickExhaust = {
  id: 'quick_exhaust', name: 'Válvula de escape rápido', short: 'Escape rápido', group: 'Válvulas de bloqueio',
  size: { w: 44, h: 44 },
  ports: [
    { id: '1', x: 22, y: 44, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: 22, y: 0, dir: 'up', kind: 'pneumatic' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: '1V5' } },
  faultTypes: ['stuck_open'],
  stamp(inst, st, ctx, work) {
    const n1 = ctx.net(inst, '1'), n2 = ctx.net(inst, '2');
    const p1 = ctx.pressure(inst, '1'), p2 = ctx.pressure(inst, '2');
    if (p1 > p2 + 2000 && !ctx.fault(inst, 'stuck_open')) {
      st.restrict(n1, n2, C_VALVE, B_CRIT, work); // feeding: supply straight through
    } else {
      // Exhausting: dump straight to atmosphere through a big local port rather than
      // back down the line — that shortcut is the whole point of the component.
      st.restrictToFixed(n2, C_EXHAUST * 3, B_CRIT, P_ATM, work);
    }
  },
  render(inst) {
    const B = { x: 4, y: 10, w: 36, h: 24 };
    const feeding = (inst.sim?.feeding ?? false);
    return rect(B.x, B.y, B.w, B.h)
      + line(22, 44, 22, B.y + B.h) + line(22, 0, 22, B.y)
      + circle(22, B.y + B.h / 2, 5)
      + line(B.x + 8, B.y + 2, B.x + 8, B.y + B.h - 2)
      + ventTriangle(B.x + B.w - 4, B.y + B.h, 7, 'down')
      + line(B.x + B.w - 4, B.y + B.h / 2, B.x + B.w - 4, B.y + B.h)
      + text(16, 43, '1', 'sym-port') + text(16, 9, '2', 'sym-port')
      + text(22, B.y + B.h + 18, inst.params.tag.value, 'sym-tag');
  },
  integrate(inst, ctx) {
    inst.sim.feeding = ctx.gauge(inst, '1') > ctx.gauge(inst, '2');
  },
};

const checkValve = {
  id: 'check', name: 'Válvula de retenção', short: 'Retenção', group: 'Válvulas de bloqueio',
  size: { w: 32, h: 44 },
  ports: [
    { id: '1', x: 16, y: 44, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: 16, y: 0, dir: 'up', kind: 'pneumatic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1V6' },
    cracking: { label: 'Pressão de abertura', type: 'range', value: 0.2, min: 0, max: 5, step: 0.1, unit: 'bar' },
  },
  faultTypes: ['stuck_open', 'stuck_closed'],
  stamp(inst, st, ctx, work) {
    const p1 = ctx.pressure(inst, '1'), p2 = ctx.pressure(inst, '2');
    let open = p1 > p2 + inst.params.cracking.value * 1e5;
    if (ctx.fault(inst, 'stuck_open')) open = true;
    if (ctx.fault(inst, 'stuck_closed')) open = false;
    st.restrict(ctx.net(inst, '1'), ctx.net(inst, '2'), open ? C_VALVE : C_VALVE * 1e-5, B_CRIT, work);
  },
  render(inst) {
    return line(16, 44, 16, 30) + line(16, 0, 16, 14)
      + circle(16, 20, 6)
      + line(8, 14, 24, 14)
      + line(8, 26, 8, 14) + line(24, 26, 24, 14)
      + text(16, 42, inst.params.tag.value, 'sym-tag');
  },
};

// ---------------------------------------------------------------------------
// Actuators
// ---------------------------------------------------------------------------

/**
 * Shared piston integrator: force balance -> velocity -> normalised position.
 *
 * Friction has three parts, and the split matters. Viscous drag is folded into the
 * implicit velocity update (m/c is ~1 ms here, which explicit Euler at a 1 ms step would
 * ring on; this form is unconditionally stable). Coulomb friction opposes motion at
 * constant magnitude. Stiction is what makes a real cylinder *hold* against a small
 * pressure difference instead of creeping — without it, a load-holding circuit slowly
 * drifts and the counterbalance test can never pass.
 */
function integrateSlide(sim, Fp, { m, viscous, coulomb, L, dt }) {
  const stiction = coulomb * 1.6; // breakaway runs ~60% above sliding friction on a seal
  let v = sim.v;

  if (Math.abs(v) < 1e-4 && Math.abs(Fp) < stiction) {
    v = 0; // not enough force to break away: the piston stays put
  } else {
    const dir = v !== 0 ? Math.sign(v) : Math.sign(Fp);
    const Fnet = Fp - coulomb * dir;
    // Coulomb friction must never drive the piston backwards; if it would reverse the
    // sign of the net force at low speed, the piston simply stops.
    if (v !== 0 && Math.sign(Fnet) !== dir && Math.abs(Fp) < coulomb) v = 0;
    else v = (m * v + dt * Fnet) / (m + dt * viscous);
  }

  let x = sim.x + (v * dt) / L;
  if (x <= 0) { x = 0; v = Math.max(v, 0); } // hard end stops, no overshoot
  if (x >= 1) { x = 1; v = Math.min(v, 0); }
  return { x, v };
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** The cylinder port itself, stiff next to any valve — so it is not what limits flow. */
const C_CYL_PORT = C_SUPPLY;

/**
 * Cushioning needle, wide open. Deliberately an absolute conductance and not a fraction
 * of the port: the port is ten times stiffer than a valve path, so a needle expressed as
 * a percentage of it would still be wider than the route the air already takes, and the
 * cushion would do nothing. This is an eighth of a fully open speed-control throttle,
 * which is the order a cushioning needle actually sits at.
 */
const C_CUSHION_MAX = C_THROTTLE_MAX / 8;

/**
 * End-position cushioning: the flow path from a chamber to its port as the cushioning
 * boss enters.
 *
 * A real cushion is not a brake. The boss progressively covers the main port over the
 * last few millimetres, so the escaping air has to leave through an adjustable needle
 * instead; the trapped air builds pressure, and *that* pressure decelerates the piston
 * through the ordinary force balance. Nothing here applies a force — the deceleration is
 * a consequence, which is the only way it can also produce the right side effects (a
 * heavier load cushions harder, a wide-open needle barely cushions at all).
 *
 * `depth` is how far the boss has entered, 0 at the start of the cushion and 1 at the end
 * stop. The port does not fade out across the whole cushion — the boss is a close fit and
 * seals within the first quarter of it, after which the needle is the only way out. An
 * earlier revision blended the two conductances linearly over the full length and cushioned
 * nothing: at half depth the path was still five times a valve port, because a linear blend
 * from 1.2e-7 to 1.5e-10 is dominated by the open term almost the whole way. The squared
 * closing law keeps it continuous — a discontinuity is something the damped fixed point
 * would oscillate across — while still shutting the port where a real one shuts.
 *
 * The check valve that every cushioned cylinder carries is the `exhausting` test. On the
 * return stroke the chamber is filling, the valve lifts, and the needle is bypassed —
 * otherwise the piston would start its stroke against its own cushion. Direction is taken
 * from the piston, not from the pressure difference across the path: while the path is
 * still open those two pressures are equal to within solver noise, so a sign test on them
 * flickers and switches the cushion off exactly when it should be engaging.
 */
const CUSHION_SEAL = 0.25; // fraction of the cushion length over which the boss seals

function cushionPath(depth, needle, exhausting) {
  if (!(depth > 0) || !exhausting) return C_CYL_PORT;
  const open = clamp01((CUSHION_SEAL - depth) / CUSHION_SEAL);
  return C_CYL_PORT * open * open + C_CUSHION_MAX * needle;
}

const CYL_W = 92, CYL_H = 34;
const WALL = 2, PISTON_W = 6;
const CYL_TRAVEL = CYL_W - 2 * WALL - PISTON_W - 2;
// The rod sweeps a full stroke to the right of the barrel, and the symbol has to own
// that space: a bbox that only covered the barrel would make selection and zoom-fit
// lie about where the part actually is when extended.
const CYL_BOX_W = CYL_W + CYL_TRAVEL + 8;

/** Shared piston/rod geometry so both cylinder types animate identically. */
function cylinderBody(inst, { spring: withSpring }) {
  const x = inst.sim?.x ?? 0;
  const inner = { x: WALL, y: WALL, w: CYL_W - 2 * WALL, h: CYL_H - 2 * WALL };
  const px = inner.x + 1 + x * CYL_TRAVEL;
  const rodTip = CYL_W + x * CYL_TRAVEL;
  const midY = CYL_H / 2;

  let s = rect(WALL, WALL, inner.w, inner.h, 'sym barrel');
  // Rod exits through the right-hand cap, so that wall is drawn in two pieces.
  s += line(CYL_W - WALL, WALL, CYL_W - WALL, midY - 4);
  s += line(CYL_W - WALL, midY + 4, CYL_W - WALL, CYL_H - WALL);

  if (withSpring) {
    const room = CYL_W - WALL - px - PISTON_W - 2;
    if (room > 8) {
      s += `<g transform="translate(${px + PISTON_W}, 0)">`
        + spring(2, midY, room, 16, 5)
        + `</g>`;
    }
  }

  s += rect(px, inner.y, PISTON_W, inner.h, 'sym fill-soft');
  s += rect(px + PISTON_W, midY - 3, rodTip - px - PISTON_W, 6, 'sym fill-soft');
  return s;
}

const cylinderDouble = {
  id: 'cyl_double', name: 'Cilindro de dupla ação', short: 'Cilindro DA', group: 'Atuadores',
  size: { w: CYL_BOX_W, h: CYL_H + 16 },
  ports: [
    { id: '1', x: 12, y: CYL_H + 14, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: CYL_W - 12, y: CYL_H + 14, dir: 'down', kind: 'pneumatic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1A1' },
    bore: { label: 'Diâmetro do pistão', type: 'range', value: 25, min: 8, max: 63, step: 1, unit: 'mm' },
    rod: { label: 'Diâmetro da haste', type: 'range', value: 10, min: 4, max: 25, step: 1, unit: 'mm' },
    stroke: { label: 'Curso', type: 'range', value: 100, min: 20, max: 500, step: 10, unit: 'mm' },
    mass: { label: 'Massa em movimento', type: 'range', value: 1, min: 0.1, max: 20, step: 0.1, unit: 'kg' },
    load: { label: 'Carga no avanço', type: 'range', value: 0, min: -200, max: 200, step: 5, unit: 'N' },
    friction: { label: 'Atrito viscoso', type: 'range', value: 900, min: 100, max: 4000, step: 50, unit: 'Ns/m' },
    coulomb: { label: 'Atrito estático/dinâmico', type: 'range', value: 8, min: 0, max: 120, step: 1, unit: 'N' },
    cushion: { label: 'Amortecimento (comprimento)', type: 'range', value: 0, min: 0, max: 40, step: 1, unit: 'mm' },
    cushionNeedle: { label: 'Restrição do amortecimento', type: 'range', value: 12, min: 2, max: 100, step: 1, unit: '%' },
  },
  initSim(inst) { inst.sim.x = 0; inst.sim.v = 0; },

  faultTypes: ['seized', 'leak'],

  // Two chamber nodes. Claimed whether or not cushioning is switched on, so that turning
  // the parameter up mid-run cannot shift anyone else's index.
  fluidExtras: 2,

  stamp(inst, st, ctx, work) {
    const { bore, rod, stroke, cushion, cushionNeedle } = inst.params;
    const Aa = area(bore.value);
    const Ab = Aa - area(rod.value);
    const L = stroke.value / 1000;
    const x = inst.sim.x, v = inst.sim.v;
    const dead = 3e-7;

    const cA = st.extra(), cB = st.extra();
    inst.sim.iA = cA; inst.sim.iB = cB;
    const nA = ctx.net(inst, '1'), nB = ctx.net(inst, '2');
    const volA = dead + Aa * L * x, volB = dead + Ab * L * (1 - x);

    let chamberA = nA, chamberB = nB;

    if (!(cushion.value > 0)) {
      // Undamped: the chamber *is* its port net, exactly as it always was — no series
      // restriction, so none of the calibrated stroke times move. The two reserved rows
      // are parked on atmosphere to keep the matrix non-singular.
      st.capacitance(nA, volA, ctx.pressure(inst, '1'), Aa * v);
      st.capacitance(nB, volB, ctx.pressure(inst, '2'), -Ab * v);
      st.toFixed(cA, 1e-9, P_ATM);
      st.toFixed(cB, 1e-9, P_ATM);
    } else {
      // Damped: the chamber becomes its own node behind the port restriction, which is
      // what the cushioning boss actually throttles.
      chamberA = cA; chamberB = cB;
      const xc = Math.min(cushion.value / 1000 / L, 0.45);
      const needle = cushionNeedle.value / 100;

      st.capacitance(cA, volA, ctx.pAt(cA), Aa * v);
      st.capacitance(cB, volB, ctx.pAt(cB), -Ab * v);

      // Chamber A cushions into the retracted end, chamber B into the extended one.
      const depthA = clamp01((xc - x) / xc);
      const depthB = clamp01((x - (1 - xc)) / xc);
      const outA = v < 0; // retracting: chamber A is the one being emptied
      const outB = v > 0; // extending
      st.restrict(cA, nA, cushionPath(depthA, needle, outA), B_CRIT, work);
      st.restrict(cB, nB, cushionPath(depthB, needle, outB), B_CRIT, work);
    }

    // A blown piston seal short-circuits the two chambers past the piston — past the
    // cushioning restriction too, which is why it is stamped chamber-to-chamber.
    if (ctx.fault(inst, 'leak')) {
      st.restrict(chamberA, chamberB, C_VALVE * 0.15, B_CRIT, work);
    }
  },

  integrate(inst, ctx) {
    if (ctx.fault(inst, 'seized')) { inst.sim.v = 0; return; }
    const { bore, rod, stroke, mass, load, friction, coulomb, cushion } = inst.params;
    const Aa = area(bore.value);
    const Ab = Aa - area(rod.value);
    const L = stroke.value / 1000;

    // The force comes off the piston face, so it must read the chamber — which is not the
    // port net once a cushion sits between them.
    const damped = cushion.value > 0 && inst.sim.iA != null;
    const gA = damped ? ctx.gaugeAt(inst.sim.iA) : ctx.gauge(inst, '1');
    const gB = damped ? ctx.gaugeAt(inst.sim.iB) : ctx.gauge(inst, '2');

    const Fp = gA * 1e5 * Aa - gB * 1e5 * Ab - load.value;
    const next = integrateSlide(inst.sim, Fp, {
      m: mass.value, viscous: friction.value, coulomb: coulomb.value, L, dt: ctx.dt,
    });
    inst.sim.v = next.v;
    inst.sim.x = next.x;
  },

  render(inst) {
    return cylinderBody(inst, { spring: false })
      + line(12, CYL_H, 12, CYL_H + 14) + line(CYL_W - 12, CYL_H, CYL_W - 12, CYL_H + 14)
      + text(6, CYL_H + 12, '1', 'sym-port') + text(CYL_W - 18, CYL_H + 12, '2', 'sym-port')
      + text(CYL_W / 2, -6, inst.params.tag.value, 'sym-tag');
  },
};

const cylinderSingle = {
  id: 'cyl_single', name: 'Cilindro de simples ação', short: 'Cilindro SA', group: 'Atuadores',
  size: { w: CYL_BOX_W, h: CYL_H + 16 },
  ports: [{ id: '1', x: 12, y: CYL_H + 14, dir: 'down', kind: 'pneumatic' }],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1A1' },
    bore: { label: 'Diâmetro do pistão', type: 'range', value: 20, min: 8, max: 63, step: 1, unit: 'mm' },
    stroke: { label: 'Curso', type: 'range', value: 60, min: 20, max: 300, step: 10, unit: 'mm' },
    // Defaults sized so the spring actually beats friction: at 30 N against 700 Ns/m the
    // return stroke crawled and never reached the end stop within a usable time.
    springForce: { label: 'Força da mola', type: 'range', value: 70, min: 5, max: 200, step: 5, unit: 'N' },
    mass: { label: 'Massa em movimento', type: 'range', value: 0.5, min: 0.1, max: 10, step: 0.1, unit: 'kg' },
    friction: { label: 'Atrito viscoso', type: 'range', value: 350, min: 100, max: 4000, step: 50, unit: 'Ns/m' },
    coulomb: { label: 'Atrito estático/dinâmico', type: 'range', value: 5, min: 0, max: 120, step: 1, unit: 'N' },
  },
  initSim(inst) { inst.sim.x = 0; inst.sim.v = 0; },

  faultTypes: ['seized', 'leak'],

  stamp(inst, st, ctx, work) {
    const Aa = area(inst.params.bore.value);
    const L = inst.params.stroke.value / 1000;
    st.capacitance(ctx.net(inst, '1'), 3e-7 + Aa * L * inst.sim.x,
                   ctx.pressure(inst, '1'), Aa * inst.sim.v);
    if (ctx.fault(inst, 'leak')) {
      st.restrictToFixed(ctx.net(inst, '1'), C_VALVE * 0.12, B_CRIT, P_ATM, work);
    }
  },

  integrate(inst, ctx) {
    if (ctx.fault(inst, 'seized')) { inst.sim.v = 0; return; }
    const Aa = area(inst.params.bore.value);
    const L = inst.params.stroke.value / 1000;
    // Return spring is preloaded and stiffens across the stroke.
    const Fspring = inst.params.springForce.value * (0.4 + 0.6 * inst.sim.x);
    const Fp = ctx.gauge(inst, '1') * 1e5 * Aa - Fspring;

    const next = integrateSlide(inst.sim, Fp, {
      m: inst.params.mass.value, viscous: inst.params.friction.value,
      coulomb: inst.params.coulomb.value, L, dt: ctx.dt,
    });
    inst.sim.v = next.v; inst.sim.x = next.x;
  },

  render(inst) {
    return cylinderBody(inst, { spring: true })
      + line(12, CYL_H, 12, CYL_H + 14)
      + text(6, CYL_H + 12, '1', 'sym-port')
      + text(CYL_W / 2, -6, inst.params.tag.value, 'sym-tag');
  },
};

/**
 * Double-acting cylinder with a through rod. The rod passes out both ends, so both
 * chambers are annular and *equal* — which is the entire point: extend and retract get
 * the same force and the same speed. On a normal cylinder the rod steals area from one
 * side only, and that asymmetry is what makes retraction the faster stroke.
 */
const cylinderThroughRod = {
  ...cylinderDouble,
  id: 'cyl_through', name: 'Cilindro de dupla ação com haste passante',
  short: 'DA haste passante',
  size: { w: CYL_BOX_W + CYL_TRAVEL, h: CYL_H + 16 },
  ports: [
    { id: '1', x: 12 + CYL_TRAVEL, y: CYL_H + 14, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: CYL_W - 12 + CYL_TRAVEL, y: CYL_H + 14, dir: 'down', kind: 'pneumatic' },
  ],
  params: {
    ...Object.fromEntries(Object.entries(cylinderDouble.params).map(([k, v]) => [k, { ...v }])),
    tag: { label: 'Identificação', type: 'text', value: '1A1' },
  },

  stamp(inst, st, ctx, work) {
    const Aa = area(inst.params.bore.value) - area(inst.params.rod.value);
    const L = inst.params.stroke.value / 1000;
    const dead = 3e-7;
    // Both chambers annular, both the same area.
    st.capacitance(ctx.net(inst, '1'), dead + Aa * L * inst.sim.x, ctx.pressure(inst, '1'), Aa * inst.sim.v);
    st.capacitance(ctx.net(inst, '2'), dead + Aa * L * (1 - inst.sim.x), ctx.pressure(inst, '2'), -Aa * inst.sim.v);
    if (ctx.fault(inst, 'leak')) {
      st.restrict(ctx.net(inst, '1'), ctx.net(inst, '2'), C_VALVE * 0.15, B_CRIT, work);
    }
  },

  integrate(inst, ctx) {
    if (ctx.fault(inst, 'seized')) { inst.sim.v = 0; return; }
    const A = area(inst.params.bore.value) - area(inst.params.rod.value);
    const L = inst.params.stroke.value / 1000;
    const Fp = (ctx.gauge(inst, '1') - ctx.gauge(inst, '2')) * 1e5 * A - inst.params.load.value;
    const next = integrateSlide(inst.sim, Fp, {
      m: inst.params.mass.value, viscous: inst.params.friction.value,
      coulomb: inst.params.coulomb.value, L, dt: ctx.dt,
    });
    inst.sim.v = next.v; inst.sim.x = next.x;
  },

  render(inst) {
    const x = inst.sim?.x ?? 0;
    const O = CYL_TRAVEL; // barrel sits inset, so the rod has room to protrude left too
    const inner = { x: WALL, y: WALL, w: CYL_W - 2 * WALL, h: CYL_H - 2 * WALL };
    const px = O + inner.x + 1 + x * CYL_TRAVEL;
    const midY = CYL_H / 2;

    let s = `<g transform="translate(${O},0)">`
      + rect(WALL, WALL, inner.w, inner.h, 'sym barrel')
      + line(CYL_W - WALL, WALL, CYL_W - WALL, midY - 4)
      + line(CYL_W - WALL, midY + 4, CYL_W - WALL, CYL_H - WALL)
      + line(WALL, WALL, WALL, midY - 4)
      + line(WALL, midY + 4, WALL, CYL_H - WALL)
      + `</g>`;
    // One continuous rod through the piston and out both caps.
    s += rect(px - O + 0, midY - 3, 0, 6, 'sym');
    s += rect(x * CYL_TRAVEL, midY - 3, CYL_W + O - 2, 6, 'sym fill-soft');
    s += rect(px, inner.y, PISTON_W, inner.h, 'sym fill-soft');
    s += line(12 + O, CYL_H, 12 + O, CYL_H + 14) + line(CYL_W - 12 + O, CYL_H, CYL_W - 12 + O, CYL_H + 14);
    return s
      + text(6 + O, CYL_H + 12, '1', 'sym-port') + text(CYL_W - 18 + O, CYL_H + 12, '2', 'sym-port')
      + text(CYL_W / 2 + O, -6, inst.params.tag.value, 'sym-tag');
  },
};

// ---------------------------------------------------------------------------
// Electrical
// ---------------------------------------------------------------------------

const G_WIRE = 1e3;
const R_COIL = 60;   // ohms — a typical 24V pneumatic solenoid draws ~0.4A
const R_LAMP = 240;

const railPlus = {
  id: 'rail_24v', name: 'Conexão elétrica +24 V', short: '+24V', group: 'Elétrica',
  size: { w: 28, h: 20 },
  ports: [{ id: 'a', x: 14, y: 20, dir: 'down', kind: 'electric' }],
  params: {},
  stampElectric(inst, st, ctx) { st.toFixed(ctx.net(inst, 'a'), G_WIRE, 24); },
  render() { return circle(14, 9, 9) + text(14, 12, '24V', 'sym-tag') + line(14, 18, 14, 20); },
};

const railZero = {
  id: 'rail_0v', name: 'Conexão elétrica 0 V', short: '0V', group: 'Elétrica',
  size: { w: 28, h: 20 },
  ports: [{ id: 'a', x: 14, y: 0, dir: 'up', kind: 'electric' }],
  params: {},
  stampElectric(inst, st, ctx) { st.toFixed(ctx.net(inst, 'a'), G_WIRE, 0); },
  render() { return line(14, 0, 14, 2) + circle(14, 11, 9) + text(14, 14, '0V', 'sym-tag'); },
};

/** NO / NC pushbutton — the operator-facing electric input. */
function makeButton(id, name, no) {
  return {
    id, name, short: no ? 'Botão NA' : 'Botão NF', group: 'Elétrica',
    size: { w: 28, h: 44 },
    ports: [
      { id: 'a', x: 14, y: 0, dir: 'up', kind: 'electric' },
      { id: 'b', x: 14, y: 44, dir: 'down', kind: 'electric' },
    ],
    params: { tag: { label: 'Identificação', type: 'text', value: no ? 'S1' : 'S2' } },
    interactive: true,
    initSim(inst) { inst.sim.pressed = false; },
    stampElectric(inst, st, ctx) {
      const closed = no ? inst.sim.pressed : !inst.sim.pressed;
      st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), closed ? G_WIRE : 1e-12);
    },
    render(inst) {
      const closed = no ? inst.sim?.pressed : !inst.sim?.pressed;
      let s = line(14, 0, 14, 13) + line(14, 31, 14, 44)
        + circle(14, 13, 1.6, 'sym fill') + circle(14, 31, 1.6, 'sym fill');
      s += closed ? line(14, 13, 14, 31) : line(14, 13, 24, 30);
      if (!no) s += line(9, 31, 19, 31); // NC bar
      s += line(14, 22, 26, 22, 'sym thin') + rect(26, 18, 3, 8);
      return s + text(2, 24, inst.params.tag.value, 'sym-tag', 'end');
    },
  };
}

const relayCoil = {
  id: 'relay_coil', coilLike: true, resistance: R_COIL, name: 'Bobina de relé', short: 'Relé', group: 'Elétrica',
  size: { w: 34, h: 44 },
  ports: [
    { id: 'a', x: 17, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 17, y: 44, dir: 'down', kind: 'electric' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: 'K1' } },
  faultTypes: ['coil_open'],
  initSim(inst) { inst.sim.on = false; },
  stampElectric(inst, st, ctx) {
    // A burnt-out coil is an open circuit: current stops, so the relay never picks up.
    if (ctx.fault(inst, 'coil_open')) return;
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), 1 / R_COIL);
  },
  render(inst) {
    return line(17, 0, 17, 12) + line(17, 32, 17, 44)
      + rect(5, 12, 24, 20, inst.sim?.on ? 'sym live-fill' : 'sym')
      + text(33, 26, inst.params.tag.value, 'sym-tag', 'start');
  },
};

/** Contact driven by a relay coil of the same tag. */
function makeContact(id, name, no) {
  return {
    id, name, short: no ? 'Contato NA' : 'Contato NF', group: 'Elétrica',
    size: { w: 28, h: 44 },
    ports: [
      { id: 'a', x: 14, y: 0, dir: 'up', kind: 'electric' },
      { id: 'b', x: 14, y: 44, dir: 'down', kind: 'electric' },
    ],
    params: { tag: { label: 'Bobina associada', type: 'text', value: 'K1' } },
    faultTypes: ['contact_welded'],
    stampElectric(inst, st, ctx) {
      const on = !!ctx.sim.energized.get(inst.params.tag.value);
      // A welded contact stays made whatever the coil does.
      const closed = ctx.fault(inst, 'contact_welded') ? true : (no ? on : !on);
      inst.sim.closed = closed;
      st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), closed ? G_WIRE : 1e-12);
    },
    render(inst) {
      const closed = inst.sim?.closed ?? !no;
      let s = line(14, 0, 14, 13) + line(14, 31, 14, 44)
        + circle(14, 13, 1.6, 'sym fill') + circle(14, 31, 1.6, 'sym fill');
      s += closed ? line(14, 13, 14, 31) : line(14, 13, 24, 30);
      if (!no) s += line(9, 31, 19, 31);
      return s + text(2, 24, inst.params.tag.value, 'sym-tag', 'end');
    },
  };
}

const valveSolenoid = {
  id: 'sol_coil', coilLike: true, resistance: R_COIL, name: 'Bobina de solenoide da válvula', short: 'Bobina solenoide', group: 'Elétrica',
  size: { w: 34, h: 44 },
  ports: [
    { id: 'a', x: 17, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 17, y: 44, dir: 'down', kind: 'electric' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: 'Y1' } },
  initSim(inst) { inst.sim.on = false; },
  stampElectric(inst, st, ctx) {
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), 1 / R_COIL);
  },
  render(inst) {
    return line(17, 0, 17, 12) + line(17, 32, 17, 44)
      + rect(5, 12, 24, 20, inst.sim?.on ? 'sym live-fill' : 'sym')
      + line(5, 32, 29, 12)
      + text(33, 26, inst.params.tag.value, 'sym-tag', 'start');
  },
};

const lamp = {
  id: 'lamp', coilLike: true, resistance: R_LAMP, name: 'Lâmpada de sinalização', short: 'Sinalizador', group: 'Elétrica',
  size: { w: 34, h: 44 },
  ports: [
    { id: 'a', x: 17, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 17, y: 44, dir: 'down', kind: 'electric' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: 'P1' } },
  initSim(inst) { inst.sim.on = false; },
  stampElectric(inst, st, ctx) {
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), 1 / R_LAMP);
  },
  render(inst) {
    const on = inst.sim?.on;
    return line(17, 0, 17, 11) + line(17, 33, 17, 44)
      + circle(17, 22, 11, on ? 'sym lamp-on' : 'sym')
      + line(9, 14, 25, 30) + line(25, 14, 9, 30)
      + text(31, 26, inst.params.tag.value, 'sym-tag', 'start');
  },
};

/**
 * Time relay. The coil is a real load on the rung (so it draws current and a probe reads
 * it), but its *contacts* switch late or drop out late — which is the whole component.
 *
 * On-delay: the coil must stay energised for the whole delay before the contacts move,
 * and losing power resets the timer instantly.
 * Off-delay: contacts pull in at once and hold for the delay after power is gone.
 */
function makeTimeRelay(id, name, onDelay) {
  return {
    id, coilLike: true, resistance: R_COIL,
    name, short: onDelay ? 'Relé retardo ao ligar' : 'Relé retardo ao desligar',
    group: 'Elétrica',
    size: { w: 34, h: 44 },
    ports: [
      { id: 'a', x: 17, y: 0, dir: 'up', kind: 'electric' },
      { id: 'b', x: 17, y: 44, dir: 'down', kind: 'electric' },
    ],
    params: {
      tag: { label: 'Identificação', type: 'text', value: 'K1' },
      delay: { label: onDelay ? 'Retardo na energização' : 'Retardo na desenergização',
        type: 'range', value: 2, min: 0.1, max: 30, step: 0.1, unit: 's' },
    },
    faultTypes: ['coil_open', 'drift'],
    initSim(inst) { inst.sim.on = false; inst.sim.out = false; inst.sim.elapsed = 0; },

    stampElectric(inst, st, ctx) {
      if (ctx.fault(inst, 'coil_open')) return;
      st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), 1 / R_COIL);
    },

    updateState(inst, ctx) {
      // inst.sim.on is the coil, written by the engine after the electric solve.
      // inst.sim.out is what the *contacts* follow, and it is what the tag publishes.
      const powered = inst.sim.on;
      const delay = inst.params.delay.value * (ctx.fault(inst, 'drift') ? 2.5 : 1);

      if (onDelay) {
        inst.sim.elapsed = powered ? inst.sim.elapsed + ctx.dt : 0;
        inst.sim.out = powered && inst.sim.elapsed >= delay;
      } else {
        if (powered) { inst.sim.elapsed = 0; inst.sim.out = true; }
        else if (inst.sim.out) {
          inst.sim.elapsed += ctx.dt;
          if (inst.sim.elapsed >= delay) inst.sim.out = false;
        }
      }
      // Contacts read `energized` by tag, so the timed state must be what is published —
      // not the raw coil, or the delay would do nothing at all.
      ctx.sim.energized.set(inst.params.tag.value, inst.sim.out);
    },

    render(inst) {
      const d = inst.params.delay.value;
      const frac = Math.min((inst.sim?.elapsed ?? 0) / d, 1);
      const running = frac > 0 && frac < 1;
      // Half-circle on the box is the IEC mark: filled left = on-delay, right = off-delay.
      const arc = onDelay
        ? `M 11 12 A 8 10 0 0 0 11 32 Z`
        : `M 23 12 A 8 10 0 0 1 23 32 Z`;
      return line(17, 0, 17, 12) + line(17, 32, 17, 44)
        + rect(5, 12, 24, 20, inst.sim?.out ? 'sym live-fill' : 'sym')
        + path(arc, 'sym')
        + (running ? rect(5, 33, 24 * frac, 2, 'sym fill') : '')
        + text(33, 22, inst.params.tag.value, 'sym-tag', 'start')
        + text(33, 32, `${num(d, 1)} s`, 'sym-tag', 'start');
    },
  };
}

const timeRelayOn = makeTimeRelay('relay_on_delay', 'Relé temporizado na energização', true);
const timeRelayOff = makeTimeRelay('relay_off_delay', 'Relé temporizado na desenergização', false);

/**
 * Relay counter. Counts rising edges on its coil and closes its contacts once the preset
 * is reached; a separate reset input clears it.
 */
const relayCounter = {
  id: 'relay_counter', coilLike: true, resistance: R_COIL,
  name: 'Relé contador com pré-seleção', short: 'Contador', group: 'Elétrica',
  size: { w: 40, h: 60 },
  ports: [
    { id: 'a', x: 17, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 17, y: 60, dir: 'down', kind: 'electric' },
    { id: 'r', x: 40, y: 12, dir: 'right', kind: 'electric' },
    { id: 'r2', x: 40, y: 48, dir: 'right', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: 'C1' },
    preset: { label: 'Pré-seleção', type: 'range', value: 3, min: 1, max: 99, step: 1 },
  },
  faultTypes: ['coil_open'],
  initSim(inst) { inst.sim.on = false; inst.sim.count = 0; inst.sim.out = false; inst.sim.last = false; },
  stampElectric(inst, st, ctx) {
    if (ctx.fault(inst, 'coil_open')) return;
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), 1 / R_COIL);
    st.conduct(ctx.net(inst, 'r'), ctx.net(inst, 'r2'), 1e-9); // reset coil: sensing only
  },
  updateState(inst, ctx) {
    const reset = Math.abs(ctx.sim.volts(inst.id, 'r') - ctx.sim.volts(inst.id, 'r2')) > 12;
    if (reset) inst.sim.count = 0;
    else if (inst.sim.on && !inst.sim.last) inst.sim.count++; // rising edge on the coil
    inst.sim.last = inst.sim.on;
    inst.sim.out = inst.sim.count >= inst.params.preset.value;
    ctx.sim.energized.set(inst.params.tag.value, inst.sim.out);
  },
  render(inst) {
    return line(17, 0, 17, 12) + line(17, 44, 17, 60)
      + line(29, 12, 40, 12) + line(29, 48, 40, 48)
      + rect(5, 12, 24, 32, inst.sim?.out ? 'sym live-fill' : 'sym')
      + text(17, 30, `${inst.sim?.count ?? 0}`, 'sym-label')
      + text(17, 40, `/${inst.params.preset.value}`, 'sym-port')
      + text(42, 15, 'R', 'sym-port', 'start')
      + text(0, 22, inst.params.tag.value, 'sym-tag', 'end');
  },
};

/**
 * Emergency stop. A latching mushroom button: pressing latches it open and it stays that
 * way until released by a deliberate second click — which is the safety behaviour, and
 * the reason it cannot be a momentary contact.
 */
const eStop = {
  id: 'estop', name: 'Parada de emergência (botão cogumelo com trava)', short: 'Emergência', group: 'Elétrica',
  size: { w: 32, h: 44 },
  ports: [
    { id: 'a', x: 14, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 14, y: 44, dir: 'down', kind: 'electric' },
  ],
  params: { tag: { label: 'Identificação', type: 'text', value: 'S0' } },
  interactive: true,
  toggle: true,
  initSim(inst) { inst.sim.pressed = false; },
  stampElectric(inst, st, ctx) {
    // Normally closed: latched = circuit broken.
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.sim.pressed ? 1e-12 : G_WIRE);
  },
  render(inst) {
    const latched = inst.sim?.pressed;
    let s = line(14, 0, 14, 13) + line(14, 31, 14, 44)
      + circle(14, 13, 1.6, 'sym fill') + circle(14, 31, 1.6, 'sym fill');
    s += latched ? line(14, 13, 24, 30) : line(14, 13, 14, 31);
    s += line(9, 31, 19, 31); // NC bar
    s += line(14, 22, 24, 22, 'sym thin')
      + path('M 24 17 A 6 6 0 0 1 24 27 Z', latched ? 'sym fill' : 'sym');
    return s + text(2, 24, inst.params.tag.value, 'sym-tag', 'end');
  },
};

/** Proximity sensors: same cylinder linkage, different physics on the label. */
function makeProximity(id, name, short, mark) {
  return {
    id, name, short, group: 'Elétrica',
    size: { w: 32, h: 44 },
    ports: [
      { id: 'a', x: 14, y: 0, dir: 'up', kind: 'electric' },
      { id: 'b', x: 14, y: 44, dir: 'down', kind: 'electric' },
    ],
    params: {
      tag: { label: 'Identificação', type: 'text', value: '1B1' },
      target: { label: 'Cilindro', type: 'cylinder', value: null },
      at: { label: 'Posição', type: 'range', value: 1, min: 0, max: 1, step: 0.01 },
      width: { label: 'Faixa de acionamento', type: 'range', value: 0.05, min: 0.01, max: 0.2, step: 0.01 },
    },
    faultTypes: ['stuck_open', 'stuck_closed'],
    initSim(inst) { inst.sim.closed = false; },
    updateState(inst, ctx) {
      const t = ctx.sim.circuit.byId(inst.params.target.value);
      const at = inst.params.at.value, w = inst.params.width.value;
      const x = t?.sim?.x;
      inst.sim.closed = x != null && x >= at - w && x <= at + w;
      if (ctx.fault(inst, 'stuck_open')) inst.sim.closed = false;
      if (ctx.fault(inst, 'stuck_closed')) inst.sim.closed = true;
    },
    stampElectric(inst, st, ctx) {
      st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.sim.closed ? G_WIRE : 1e-12);
    },
    render(inst) {
      const closed = inst.sim?.closed;
      let s = line(14, 0, 14, 13) + line(14, 31, 14, 44)
        + circle(14, 13, 1.6, 'sym fill') + circle(14, 31, 1.6, 'sym fill');
      s += closed ? line(14, 13, 14, 31) : line(14, 13, 24, 30);
      s += rect(20, 16, 10, 12, closed ? 'sym live-fill' : 'sym')
        + line(14, 22, 20, 22, 'sym thin')
        + text(25, 26, mark, 'sym-port');
      return s + text(2, 24, inst.params.tag.value, 'sym-tag', 'end');
    },
  };
}

const reedSwitch = makeProximity('reed', 'Contato reed (magnético)', 'Reed', 'N');
const inductive = makeProximity('prox_ind', 'Sensor de proximidade indutivo', 'Indutivo', 'I');
const capacitive = makeProximity('prox_cap', 'Sensor de proximidade capacitivo', 'Capacitivo', 'C');
const optical = makeProximity('prox_opt', 'Sensor de proximidade óptico', 'Óptico', 'O');

/** Electric limit switch: same cylinder linkage as the roller valve, on the 24V side. */
const limitSwitch = {
  id: 'limit_switch', name: 'Chave fim de curso (elétrica)', short: 'Fim de curso', group: 'Elétrica',
  size: { w: 30, h: 44 },
  ports: [
    { id: 'a', x: 14, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 14, y: 44, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1B1' },
    target: { label: 'Cilindro', type: 'cylinder', value: null },
    at: { label: 'Posição', type: 'range', value: 1, min: 0, max: 1, step: 0.01 },
    width: { label: 'Faixa de acionamento', type: 'range', value: 0.04, min: 0.01, max: 0.2, step: 0.01 },
  },
  initSim(inst) { inst.sim.closed = false; },
  updateState(inst, ctx) {
    const t = ctx.sim.circuit.byId(inst.params.target.value);
    const at = inst.params.at.value, w = inst.params.width.value;
    const x = t?.sim?.x;
    inst.sim.closed = x != null && x >= at - w && x <= at + w;
  },
  stampElectric(inst, st, ctx) {
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.sim.closed ? G_WIRE : 1e-12);
  },
  render(inst) {
    const closed = inst.sim?.closed;
    let s = line(14, 0, 14, 13) + line(14, 31, 14, 44)
      + circle(14, 13, 1.6, 'sym fill') + circle(14, 31, 1.6, 'sym fill');
    s += closed ? line(14, 13, 14, 31) : line(14, 13, 24, 30);
    s += line(14, 22, 24, 22, 'sym thin') + circle(27, 22, 3);
    return s + text(2, 24, inst.params.tag.value, 'sym-tag', 'end');
  },
};


// ---------------------------------------------------------------------------
// Valve groups: timers, sequence and regulating valves
// ---------------------------------------------------------------------------

const TIMER_SPEC_NC = SPEC_32_NC;
const TIMER_SPEC_NO = SPEC_32_NO;

/**
 * Time delay valve. Physically a throttle charging a small reservoir that pilots a 3/2;
 * modelled as an explicit accumulating timer rather than by simulating the reservoir,
 * because the delay is what the user sets and reads, and deriving it from a throttle
 * setting would make a labelled "5 s" mean something else on every circuit.
 *
 * On-delay: the pilot must stay present for the whole delay. It resets the instant the
 * signal drops — that snap-back is the behaviour these circuits are built around.
 */
function makeTimer(id, name, no) {
  const spec = no ? TIMER_SPEC_NO : TIMER_SPEC_NC;
  const base = makeValve({
    id, name, short: no ? 'Temporizadora NA' : 'Temporizadora NF',
    group: 'Conjuntos de válvulas', spec, actLeft: 'pilotAir', actRight: 'spring', tag: '1V3',
  });
  const w = valveSize({ ...spec, actLeft: 'pilotAir', actRight: 'spring' }).w;
  return {
    ...base,
    ports: [
      ...base.ports,
      { id: '12', x: 3, y: VALVE_Y + BOX / 2, dir: 'left', kind: 'pneumatic' },
    ],
    params: {
      tag: { label: 'Identificação', type: 'text', value: '1V3' },
      delay: { label: 'Atraso', type: 'range', value: 2, min: 0.1, max: 30, step: 0.1, unit: 's' },
    },
    faultTypes: ['stuck', 'clogged', 'drift'],
    initSim(inst) { inst.sim.state = 0; inst.sim.elapsed = 0; },
    updateState(inst, ctx) {
      const signal = ctx.gauge(inst, '12') > 2.5;
      // A drifted timer runs long — the classic "machine got slower" complaint.
      const delay = inst.params.delay.value * (ctx.fault(inst, 'drift') ? 2.5 : 1);
      inst.sim.elapsed = signal ? inst.sim.elapsed + ctx.dt : 0;
      inst.sim.state = inst.sim.elapsed >= delay ? 1 : 0;
    },
    render(inst) {
      const geom = { ...spec, actLeft: 'pilotAir', actRight: 'spring' };
      const frac = Math.min(inst.sim?.elapsed / inst.params.delay.value || 0, 1);
      return `<g transform="translate(0,${VALVE_Y})">`
        + drawValve(geom, inst.sim?.state ?? 0, { label: inst.params.tag.value })
        + text(-2, BOX / 2 - 6, '12', 'sym-port', 'end')
        // Charge bar: the reservoir filling, so a running delay is visible on the sheet.
        + rect(0, BOX + 16, w, 3, 'sym thin')
        + (frac > 0 ? rect(0, BOX + 16, w * frac, 3, 'sym fill') : '')
        + text(w / 2, BOX + 30, `${num(inst.params.delay.value, 1)} s`, 'sym-tag')
        + `</g>`;
    },
  };
}

const timerNC = makeTimer('timer_nc', 'Válvula temporizadora, normalmente fechada', false);
const timerNO = makeTimer('timer_no', 'Válvula temporizadora, normalmente aberta', true);

/**
 * Pressure sequence valve: a 3/2 that opens once its pilot line reaches a set pressure.
 * Used to start the next step only after the previous actuator has actually built force,
 * rather than after a guessed delay.
 */
const sequenceValve = (() => {
  const geom = { ...SPEC_32_NC, actLeft: 'pilotAir', actRight: 'spring' };
  const base = makeValve({
    id: 'sequence_valve', name: 'Válvula de sequência por pressão', short: 'Sequência por pressão',
    group: 'Conjuntos de válvulas', spec: SPEC_32_NC, actLeft: 'pilotAir', actRight: 'spring', tag: '1V4',
  });
  const w = valveSize(geom).w;
  return {
    ...base,
    ports: [
      ...base.ports,
      { id: '12', x: 3, y: VALVE_Y + BOX / 2, dir: 'left', kind: 'pneumatic' },
    ],
    params: {
      tag: { label: 'Identificação', type: 'text', value: '1V4' },
      setpoint: { label: 'Pressão de acionamento', type: 'range', value: 3, min: 0.5, max: 9, step: 0.1, unit: 'bar' },
    },
    faultTypes: ['stuck', 'clogged'],
    initSim(inst) { inst.sim.state = 0; },
    updateState(inst, ctx) {
      const p = ctx.gauge(inst, '12');
      const set = inst.params.setpoint.value;
      // Hysteresis: a real poppet does not chatter on the setpoint, and without this the
      // valve would rattle every tick while the pilot sits exactly on it.
      if (p >= set) inst.sim.state = 1;
      else if (p < set - 0.4) inst.sim.state = 0;
    },
    render(inst) {
      return `<g transform="translate(0,${VALVE_Y})">`
        + drawValve(geom, inst.sim?.state ?? 0, { label: inst.params.tag.value })
        + text(-2, BOX / 2 - 6, '12', 'sym-port', 'end')
        + text(w / 2, BOX + 26, `${num(inst.params.setpoint.value, 1)} bar`, 'sym-tag')
        + `</g>`;
    },
  };
})();

/**
 * Pressure reducing valve (relieving type). Modelled as a poppet whose opening closes
 * proportionally as the outlet approaches setpoint, plus a relief path that bleeds an
 * over-pressured outlet back to atmosphere. A hard clamp on the outlet pressure would be
 * simpler and wrong: it would hide the droop under flow that is the whole reason these
 * are specified by their regulation curve.
 */
/** Diaphragm chamber volume of a small regulator, ~20 cm^3. */
const REG_CHAMBER_V = 2.0e-5;

const pressureRegulator = {
  id: 'pressure_reg', name: 'Válvula reguladora de pressão com manômetro', short: 'Reguladora de pressão',
  group: 'Válvulas de pressão',
  size: { w: 44, h: 62 },
  ports: [
    { id: '1', x: 22, y: 62, dir: 'down', kind: 'pneumatic' },
    { id: '2', x: 22, y: 0, dir: 'up', kind: 'pneumatic' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '0Z3' },
    setpoint: { label: 'Valor de ajuste', type: 'range', value: 4, min: 0.5, max: 9, step: 0.1, unit: 'bar' },
  },
  faultTypes: ['stuck_open', 'drift'],
  initSim(inst) { inst.sim.out = 0; },
  stamp(inst, st, ctx, work) {
    const n1 = ctx.net(inst, '1'), n2 = ctx.net(inst, '2');
    if (ctx.fault(inst, 'stuck_open')) { st.restrict(n1, n2, C_VALVE, B_CRIT, work); return; }

    const set = inst.params.setpoint.value * (ctx.fault(inst, 'drift') ? 0.5 : 1);
    const target = toAbs(set);

    // The regulator's own diaphragm chamber. This is not a numerical fudge — a real
    // regulator has one, and leaving it out is what made this component unstable: a bare
    // net is conductance-dominated (g runs a few times its own V/RT·dt), so the outlet
    // slammed from 1 to 6 bar inside a single tick and the poppet spent every tick
    // reacting to a setpoint it had already blown past. With the real ~20 cm³ behind it,
    // the outlet moves at a rate the poppet can actually regulate.
    st.capacitance(n2, REG_CHAMBER_V, ctx.pressure(inst, '2'), 0);

    // Read the *iterate*, not last tick's pressure: poppet position and the pressure it
    // regulates are one coupled equilibrium, so they have to be solved together.
    const p2 = n2 != null ? work[n2] : ctx.pressure(inst, '2');

    // 0.3 bar proportional band: outside it the poppet is fully open or fully shut.
    const opening = Math.min(Math.max((target - p2) / 0.3e5, 0), 1);
    st.restrict(n1, n2, C_VALVE * opening, B_CRIT, work);

    // Relieving path, likewise proportional: a hard on/off switch here would chatter
    // between iterations and stop the loop from ever converging.
    const relief = Math.min(Math.max((p2 - target - 0.05e5) / 0.2e5, 0), 1);
    if (relief > 0) st.restrictToFixed(n2, C_VALVE * 0.3 * relief, B_CRIT, P_ATM, work);
  },
  integrate(inst, ctx) { inst.sim.out = ctx.gauge(inst, '2'); },
  render(inst) {
    const B = { x: 3, y: 16, w: 38, h: 30 };
    return line(22, 62, 22, B.y + B.h) + line(22, 0, 22, B.y)
      + rect(B.x, B.y, B.w, B.h)
      + arrow(B.x + 4, B.y + B.h - 5, B.x + B.w - 4, B.y + 5, 'sym thin')
      + line(B.x + B.w, B.y + B.h / 2, B.x + B.w + 2, B.y + B.h / 2)
      + spring(B.x + 2, B.y + B.h - 3, 12, 7, 3)
      + ventTriangle(B.x + 6, B.y + B.h, 6, 'down')
      + text(22, 60, `${num(inst.params.setpoint.value, 1)} bar`, 'sym-tag')
      + text(22, 12, `${num(inst.sim?.out ?? 0, 1)}`, 'sym-tag');
  },
};

/**
 * Pressure switch: the pneumatic-to-electric bridge. Reads a line and closes a contact
 * above its setpoint, so a pressure condition can drive the ladder.
 */
const pressureSwitch = {
  id: 'pressure_switch', name: 'Pressostato (pneumático/elétrico)', short: 'Pressostato',
  group: 'Instrumentação',
  size: { w: 40, h: 62 },
  ports: [
    { id: '1', x: 8, y: 62, dir: 'down', kind: 'pneumatic' },
    { id: 'a', x: 30, y: 0, dir: 'up', kind: 'electric' },
    { id: 'b', x: 30, y: 62, dir: 'down', kind: 'electric' },
  ],
  params: {
    tag: { label: 'Identificação', type: 'text', value: '1B1' },
    setpoint: { label: 'Pressão de acionamento', type: 'range', value: 3, min: 0.2, max: 9, step: 0.1, unit: 'bar' },
    hysteresis: { label: 'Histerese', type: 'range', value: 0.4, min: 0.1, max: 2, step: 0.1, unit: 'bar' },
  },
  faultTypes: ['stuck_open', 'stuck_closed'],
  initSim(inst) { inst.sim.closed = false; },
  updateState(inst, ctx) {
    const p = ctx.gauge(inst, '1');
    const set = inst.params.setpoint.value;
    const hys = inst.params.hysteresis.value;
    if (p >= set) inst.sim.closed = true;
    else if (p < set - hys) inst.sim.closed = false;
    if (ctx.fault(inst, 'stuck_open')) inst.sim.closed = false;
    if (ctx.fault(inst, 'stuck_closed')) inst.sim.closed = true;
  },
  stampElectric(inst, st, ctx) {
    st.conduct(ctx.net(inst, 'a'), ctx.net(inst, 'b'), inst.sim.closed ? G_WIRE : 1e-12);
  },
  render(inst) {
    const closed = inst.sim?.closed;
    let s = line(8, 62, 8, 46) + circle(8, 40, 6) + line(8, 34, 8, 28)
      + line(8, 28, 30, 28)
      + line(30, 0, 30, 16) + line(30, 40, 30, 62)
      + circle(30, 16, 1.6, 'sym fill') + circle(30, 40, 1.6, 'sym fill');
    s += closed ? line(30, 16, 30, 40) : line(30, 16, 39, 38);
    return s + text(2, 24, inst.params.tag.value, 'sym-tag', 'end')
      + text(8, 60, `${num(inst.params.setpoint.value, 1)}`, 'sym-tag');
  },
};

// ---------------------------------------------------------------------------

import { HYDRAULIC_CATALOG } from './catalog-hydraulic.js';
import { DIGITAL_CATALOG } from './catalog-digital.js';
import { ELECTRONICS_CATALOG } from './catalog-electronics.js';

export const CATALOG = [
  cylinderDouble, cylinderSingle, cylinderThroughRod,
  airSupply, silencer, gauge,
  valve32Button, valve32ButtonNO, valve32Detent, valve32Roller,
  valve52Pilot, valve53Closed,
  valve32Solenoid, valve52Solenoid, valve52SolenoidSpring,
  throttleCheck, checkValve, shuttleValve, twoPressureValve, quickExhaust,
  timerNC, timerNO, sequenceValve, pressureRegulator, pressureSwitch,
  railPlus, railZero,
  makeButton('btn_no', 'Botão, contato normalmente aberto', true),
  makeButton('btn_nc', 'Botão, contato normalmente fechado', false),
  makeContact('contact_no', 'Contato de relé, normalmente aberto', true),
  makeContact('contact_nc', 'Contato de relé, normalmente fechado', false),
  relayCoil, valveSolenoid, lamp, limitSwitch,
  timeRelayOn, timeRelayOff, relayCounter, eStop,
  reedSwitch, inductive, capacitive, optical,
  ...HYDRAULIC_CATALOG,
  ...DIGITAL_CATALOG,
  ...ELECTRONICS_CATALOG,
];

export const BY_ID = new Map(CATALOG.map((d) => [d.id, d]));

export const GROUPS = (() => {
  const order = ['Atuadores', 'Alimentação', 'Válvulas direcionais', 'Válvulas de bloqueio', 'Válvulas de fluxo',
                 'Válvulas de pressão', 'Conjuntos de válvulas', 'Instrumentação', 'Elétrica',
                 'Hidráulica — Atuadores', 'Hidráulica — Alimentação', 'Hidráulica — Válvulas direcionais',
                 'Hidráulica — Válvulas de pressão', 'Hidráulica — Válvulas de bloqueio', 'Hidráulica — Válvulas de fluxo',
                 'Hidráulica — Instrumentação', 'Lógica digital'];
  const map = new Map(order.map((g) => [g, []]));
  for (const d of CATALOG) {
    if (!map.has(d.group)) map.set(d.group, []);
    map.get(d.group).push(d);
  }
  return [...map].filter(([, v]) => v.length);
})();
