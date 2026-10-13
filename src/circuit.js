// The document model: instances, wires, and everything that mutates them.
//
// The editor and the solver both read through this object. Any structural change bumps
// `revision`, which is the simulation's cue to rebuild its nets.

import { BY_ID } from './catalog.js';
import { GRID } from './symbols.js';
import { Grafcet } from './grafcet.js';

let seq = 1;
const nextId = () => `i${seq++}`;

/** Deep-ish clone of a def's param block so instances never share value objects. */
function cloneParams(def) {
  const out = {};
  for (const [k, v] of Object.entries(def.params || {})) out[k] = { ...v };
  return out;
}

export class Circuit {
  constructor() {
    this.instances = [];
    this.wires = [];
    this.revision = 0;
    this._wireIndex = null;
    // Optional: a sheet without a chart behaves exactly as it always did.
    this.chart = null;
  }

  defOf(inst) { return BY_ID.get(inst.type); }
  byId(id) { return this.instances.find((i) => i.id === id) || null; }

  touch() { this.revision++; this._wireIndex = null; }

  add(typeId, x, y) {
    const def = BY_ID.get(typeId);
    if (!def) throw new Error(`Tipo de componente desconhecido: ${typeId}`);
    const inst = {
      id: nextId(),
      type: typeId,
      x: Math.round(x / GRID) * GRID,
      y: Math.round(y / GRID) * GRID,
      rot: 0,
      params: cloneParams(def),
      faults: {},
      sim: {},
    };
    // Auto-number tags so a fresh sheet does not end up with six components called 1V1.
    if (inst.params.tag) inst.params.tag.value = this.uniqueTag(inst.params.tag.value);
    if (def.initSim) def.initSim(inst);
    this.instances.push(inst);
    this.touch();
    return inst;
  }

  uniqueTag(base) {
    const taken = new Set(this.instances.map((i) => i.params?.tag?.value).filter(Boolean));
    if (!taken.has(base)) return base;
    const m = base.match(/^(.*?)(\d+)$/);
    const prefix = m ? m[1] : base;
    let n = m ? parseInt(m[2], 10) : 1;
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  remove(instId) {
    this.instances = this.instances.filter((i) => i.id !== instId);
    this.wires = this.wires.filter((w) => w.from.inst !== instId && w.to.inst !== instId);
    // A deleted cylinder must not leave limit switches pointing at a ghost.
    for (const inst of this.instances) {
      if (inst.params?.target?.value === instId) inst.params.target.value = null;
    }
    this.touch();
  }

  connect(from, to) {
    if (from.inst === to.inst && from.port === to.port) return null;
    const kindOf = (ref) => {
      const inst = this.byId(ref.inst);
      const port = this.defOf(inst).ports.find((p) => p.id === ref.port);
      return port?.kind || 'pneumatic';
    };
    // Air and 24V never share a net; silently refusing is friendlier than a modal.
    if (kindOf(from) !== kindOf(to)) return null;
    if (this.wireBetween(from, to)) return null;

    const wire = { id: `w${seq++}`, from, to, kind: kindOf(from) };
    this.wires.push(wire);
    this.touch();
    return wire;
  }

  wireBetween(a, b) {
    return this.wires.find((w) =>
      (w.from.inst === a.inst && w.from.port === a.port && w.to.inst === b.inst && w.to.port === b.port) ||
      (w.from.inst === b.inst && w.from.port === b.port && w.to.inst === a.inst && w.to.port === a.port));
  }

  removeWire(id) {
    this.wires = this.wires.filter((w) => w.id !== id);
    this.touch();
  }

  hasWire(instId, portId) {
    if (!this._wireIndex) {
      this._wireIndex = new Set();
      for (const w of this.wires) {
        this._wireIndex.add(`${w.from.inst}:${w.from.port}`);
        this._wireIndex.add(`${w.to.inst}:${w.to.port}`);
      }
    }
    return this._wireIndex.has(`${instId}:${portId}`);
  }

  /** World position of a port, accounting for the instance's rotation. */
  portPos(inst, port) {
    const def = this.defOf(inst);
    const { w, h } = def.size;
    const cx = w / 2, cy = h / 2;
    const a = (inst.rot * Math.PI) / 180;
    const dx = port.x - cx, dy = port.y - cy;
    return {
      x: inst.x + cx + dx * Math.cos(a) - dy * Math.sin(a),
      y: inst.y + cy + dx * Math.sin(a) + dy * Math.cos(a),
    };
  }

  portRef(ref) {
    const inst = this.byId(ref.inst);
    if (!inst) return null;
    const port = this.defOf(inst).ports.find((p) => p.id === ref.port);
    if (!port) return null;
    return this.portPos(inst, port);
  }

  /** Axis-aligned bounds of an instance after rotation. */
  bounds(inst) {
    const { w, h } = this.defOf(inst).size;
    const swap = inst.rot === 90 || inst.rot === 270;
    const bw = swap ? h : w, bh = swap ? w : h;
    return { x: inst.x + (w - bw) / 2, y: inst.y + (h - bh) / 2, w: bw, h: bh };
  }

  toJSON() {
    return {
      version: 1,
      instances: this.instances.map((i) => ({
        id: i.id, type: i.type, x: i.x, y: i.y, rot: i.rot,
        params: Object.fromEntries(Object.entries(i.params).map(([k, v]) => [k, v.value])),
        ...(Object.keys(i.faults || {}).length ? { faults: { ...i.faults } } : {}),
      })),
      wires: this.wires.map((w) => ({ from: w.from, to: w.to })),
      ...(this.chart ? { chart: this.chart.toJSON() } : {}),
    };
  }

  static fromJSON(data) {
    const c = new Circuit();
    const idMap = new Map();
    for (const raw of data.instances || []) {
      const def = BY_ID.get(raw.type);
      if (!def) continue;
      const inst = {
        id: nextId(), type: raw.type, x: raw.x, y: raw.y, rot: raw.rot || 0,
        params: cloneParams(def), faults: { ...(raw.faults || {}) }, sim: {},
      };
      for (const [k, v] of Object.entries(raw.params || {})) {
        if (inst.params[k]) inst.params[k].value = v;
      }
      if (def.initSim) def.initSim(inst);
      idMap.set(raw.id, inst.id);
      c.instances.push(inst);
    }
    // Cylinder references are stored as old ids; remap them alongside the wires.
    for (const inst of c.instances) {
      if (inst.params?.target && idMap.has(inst.params.target.value)) {
        inst.params.target.value = idMap.get(inst.params.target.value);
      }
    }
    for (const raw of data.wires || []) {
      const from = { inst: idMap.get(raw.from.inst), port: raw.from.port };
      const to = { inst: idMap.get(raw.to.inst), port: raw.to.port };
      if (from.inst && to.inst) c.connect(from, to);
    }
    if (data.chart) c.chart = Grafcet.fromJSON(data.chart);
    c.touch();
    return c;
  }
}

// ---------------------------------------------------------------------------
// Worked examples — the same circuits a Festo course walks through, so the app has
// something meaningful to show on first load.
// ---------------------------------------------------------------------------

export const EXAMPLES = {
  direct: {
    name: 'Comando direto (cilindro de simples ação)',
    description: 'O botão 1S1 comanda diretamente o cilindro de simples ação.',
    build() {
      const c = new Circuit();
      const cyl = c.add('cyl_single', 360, 90);
      const valve = c.add('v32_button', 380, 240);
      const src = c.add('supply', 386, 360);
      c.connect({ inst: valve.id, port: '2' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: valve.id, port: '1' });
      return c;
    },
  },

  indirect: {
    name: 'Comando indireto com válvula de memória',
    description: 'Dois botões acionam uma válvula 5/2 de duplo piloto — a válvula mantém a posição.',
    build() {
      const c = new Circuit();
      const cyl = c.add('cyl_double', 340, 80);
      const main = c.add('v52_pilot', 350, 220);
      const s1 = c.add('v32_button', 200, 360);
      const s2 = c.add('v32_button', 500, 360);
      const src = c.add('supply', 350, 470);

      c.connect({ inst: main.id, port: '4' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: main.id, port: '2' }, { inst: cyl.id, port: '2' });
      c.connect({ inst: s1.id, port: '2' }, { inst: main.id, port: '14' });
      c.connect({ inst: s2.id, port: '2' }, { inst: main.id, port: '12' });
      c.connect({ inst: src.id, port: '1' }, { inst: main.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: s1.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: s2.id, port: '1' });
      return c;
    },
  },

  speed: {
    name: 'Controle de velocidade (restrição na saída)',
    description: 'Duas válvulas reguladoras de fluxo controlam separadamente as velocidades de avanço e retorno.',
    build() {
      const c = new Circuit();
      const cyl = c.add('cyl_double', 340, 60);
      const t1 = c.add('throttle_check', 330, 160);
      const t2 = c.add('throttle_check', 430, 160);
      const main = c.add('v52_pilot', 350, 280);
      const s1 = c.add('v32_button', 190, 410);
      const s2 = c.add('v32_button', 510, 410);
      const src = c.add('supply', 350, 520);
      const g = c.add('gauge', 250, 240);

      c.connect({ inst: t1.id, port: '2' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: t2.id, port: '2' }, { inst: cyl.id, port: '2' });
      c.connect({ inst: main.id, port: '4' }, { inst: t1.id, port: '1' });
      c.connect({ inst: main.id, port: '2' }, { inst: t2.id, port: '1' });
      c.connect({ inst: s1.id, port: '2' }, { inst: main.id, port: '14' });
      c.connect({ inst: s2.id, port: '2' }, { inst: main.id, port: '12' });
      c.connect({ inst: src.id, port: '1' }, { inst: main.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: s1.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: s2.id, port: '1' });
      c.connect({ inst: g.id, port: '1' }, { inst: main.id, port: '1' });
      return c;
    },
  },

  reciprocating: {
    name: 'Movimento automático de avanço e retorno',
    description: 'Duas válvulas com rolete nos fins de curso mantêm o cilindro em movimento contínuo. Inicie por 1S3.',
    build() {
      const c = new Circuit();
      const cyl = c.add('cyl_double', 340, 70);
      const main = c.add('v52_pilot', 350, 230);
      const r0 = c.add('v32_roller', 190, 370);
      const r1 = c.add('v32_roller', 500, 370);
      const start = c.add('v32_detent', 340, 370);
      const src = c.add('supply', 350, 490);

      r0.params.target.value = cyl.id; r0.params.at.value = 0;
      r0.params.tag.value = '1S1';
      r1.params.target.value = cyl.id; r1.params.at.value = 1;
      r1.params.tag.value = '1S2';

      c.connect({ inst: main.id, port: '4' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: main.id, port: '2' }, { inst: cyl.id, port: '2' });
      c.connect({ inst: r0.id, port: '2' }, { inst: main.id, port: '14' });
      c.connect({ inst: r1.id, port: '2' }, { inst: main.id, port: '12' });
      c.connect({ inst: src.id, port: '1' }, { inst: main.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: start.id, port: '1' });
      c.connect({ inst: start.id, port: '2' }, { inst: r0.id, port: '1' });
      c.connect({ inst: start.id, port: '2' }, { inst: r1.id, port: '1' });
      return c;
    },
  },

  sequence: {
    name: 'Sequência A+ B+ A− B−',
    description: 'Sequência clássica de dois cilindros com quatro válvulas de fim de curso. Inicie travando 1S1.',
    build() {
      const c = new Circuit();
      const A = c.add('cyl_double', 300, 60);
      const B = c.add('cyl_double', 300, 200);
      A.params.tag.value = '1A1';
      B.params.tag.value = '2A1';

      const V1 = c.add('v52_pilot', 220, 380);
      const V2 = c.add('v52_pilot', 620, 380);
      V1.params.tag.value = '1V1';
      V2.params.tag.value = '2V1';

      // Start · b0 gates A+, which is what keeps the cycle from self-triggering while B
      // is still out. Everything else is driven straight off one end-position roller.
      const start = c.add('v32_detent', 60, 540);
      const AND = c.add('two_pressure', 90, 450);
      start.params.tag.value = '1S1';
      AND.params.tag.value = '1V2';

      const a0 = c.add('v32_roller', 220, 540);
      const a1 = c.add('v32_roller', 380, 540);
      const b0 = c.add('v32_roller', 540, 540);
      const b1 = c.add('v32_roller', 700, 540);
      a0.params.tag.value = '1S2'; a0.params.target.value = A.id; a0.params.at.value = 0;
      a1.params.tag.value = '1S3'; a1.params.target.value = A.id; a1.params.at.value = 1;
      b0.params.tag.value = '2S1'; b0.params.target.value = B.id; b0.params.at.value = 0;
      b1.params.tag.value = '2S2'; b1.params.target.value = B.id; b1.params.at.value = 1;

      const src = c.add('supply', 400, 660);

      c.connect({ inst: V1.id, port: '4' }, { inst: A.id, port: '1' });
      c.connect({ inst: V1.id, port: '2' }, { inst: A.id, port: '2' });
      c.connect({ inst: V2.id, port: '4' }, { inst: B.id, port: '1' });
      c.connect({ inst: V2.id, port: '2' }, { inst: B.id, port: '2' });

      for (const v of [V1, V2, start, a0, a1, b0, b1]) {
        c.connect({ inst: src.id, port: '1' }, { inst: v.id, port: '1' });
      }

      c.connect({ inst: start.id, port: '2' }, { inst: AND.id, port: '1a' });
      c.connect({ inst: b0.id, port: '2' }, { inst: AND.id, port: '1b' });
      c.connect({ inst: AND.id, port: '2' }, { inst: V1.id, port: '14' }); // A+
      c.connect({ inst: a1.id, port: '2' }, { inst: V2.id, port: '14' });  // B+
      c.connect({ inst: b1.id, port: '2' }, { inst: V1.id, port: '12' });  // A−
      c.connect({ inst: a0.id, port: '2' }, { inst: V2.id, port: '12' });  // B−
      return c;
    },
  },

  timed: {
    name: 'Temporização',
    description: 'O cilindro avança, aguarda o tempo ajustado e retorna automaticamente. Trave 1S1.',
    build() {
      const c = new Circuit();
      const cyl = c.add('cyl_double', 320, 60);
      const main = c.add('v52_pilot', 330, 230);
      const timer = c.add('timer_nc', 620, 380);
      const start = c.add('v32_button', 140, 380);
      const a1 = c.add('v32_roller', 420, 380);
      const src = c.add('supply', 340, 520);
      timer.params.delay.value = 2;
      a1.params.tag.value = '1S2';
      a1.params.target.value = cyl.id;
      a1.params.at.value = 1;

      c.connect({ inst: main.id, port: '4' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: main.id, port: '2' }, { inst: cyl.id, port: '2' });
      for (const v of [main, start, a1, timer]) {
        c.connect({ inst: src.id, port: '1' }, { inst: v.id, port: '1' });
      }
      c.connect({ inst: start.id, port: '2' }, { inst: main.id, port: '14' });
      // The end-position roller starts the timer; the timer commands the return.
      c.connect({ inst: a1.id, port: '2' }, { inst: timer.id, port: '12' });
      c.connect({ inst: timer.id, port: '2' }, { inst: main.id, port: '12' });
      return c;
    },
  },

  pressureSeq: {
    name: 'Comando sequencial por pressão',
    description: 'B só avança quando A atinge a pressão de prensagem — comando por válvula de sequência.',
    build() {
      const c = new Circuit();
      const A = c.add('cyl_double', 300, 60);
      const B = c.add('cyl_double', 300, 200);
      A.params.tag.value = '1A1';
      B.params.tag.value = '2A1';
      A.params.load.value = 180; // press load: A has to build force before it seats

      const V1 = c.add('v52_pilot', 250, 380);
      const V2 = c.add('v52_pilot', 640, 380);
      V1.params.tag.value = '1V1';
      V2.params.tag.value = '2V1';
      const start = c.add('v32_button', 100, 540);
      const seq = c.add('sequence_valve', 420, 540);
      const back = c.add('v32_button', 780, 540);
      seq.params.tag.value = '1V3';
      seq.params.setpoint.value = 4.5;
      const src = c.add('supply', 420, 680);

      c.connect({ inst: V1.id, port: '4' }, { inst: A.id, port: '1' });
      c.connect({ inst: V1.id, port: '2' }, { inst: A.id, port: '2' });
      c.connect({ inst: V2.id, port: '4' }, { inst: B.id, port: '1' });
      c.connect({ inst: V2.id, port: '2' }, { inst: B.id, port: '2' });
      for (const v of [V1, V2, start, seq, back]) {
        c.connect({ inst: src.id, port: '1' }, { inst: v.id, port: '1' });
      }
      c.connect({ inst: start.id, port: '2' }, { inst: V1.id, port: '14' });
      // The sequence valve watches A's working pressure, not A's position.
      c.connect({ inst: A.id, port: '1' }, { inst: seq.id, port: '12' });
      c.connect({ inst: seq.id, port: '2' }, { inst: V2.id, port: '14' });
      c.connect({ inst: back.id, port: '2' }, { inst: V1.id, port: '12' });
      c.connect({ inst: back.id, port: '2' }, { inst: V2.id, port: '12' });
      return c;
    },
  },

  hydPress: {
    name: 'Hidráulica: prensa com válvula de alívio',
    description: 'Bomba, válvula de alívio e válvula 4/3 com alavanca manual. Clique à esquerda/direita da alavanca.',
    build() {
      const c = new Circuit();
      const cyl = c.add('h_cyl', 420, 60);
      const valve = c.add('h_v43_closed', 450, 260);
      const relief = c.add('h_relief', 260, 430);
      const pump = c.add('h_pump', 120, 430);
      const gauge = c.add('h_gauge', 360, 350);
      const tank = c.add('h_tank', 120, 590);
      const tank2 = c.add('h_tank', 260, 590);
      pump.params.flow.value = 10;
      relief.params.setpoint.value = 80;
      cyl.params.load.value = 6000; // press load opposing extension

      c.connect({ inst: pump.id, port: 'P' }, { inst: relief.id, port: 'P' });
      c.connect({ inst: pump.id, port: 'P' }, { inst: valve.id, port: 'P' });
      c.connect({ inst: pump.id, port: 'P' }, { inst: gauge.id, port: 'P' });
      c.connect({ inst: pump.id, port: 'T' }, { inst: tank.id, port: 'T' });
      c.connect({ inst: relief.id, port: 'T' }, { inst: tank2.id, port: 'T' });
      c.connect({ inst: valve.id, port: 'T' }, { inst: tank2.id, port: 'T' });
      c.connect({ inst: valve.id, port: 'A' }, { inst: cyl.id, port: 'A' });
      c.connect({ inst: valve.id, port: 'B' }, { inst: cyl.id, port: 'B' });
      return c;
    },
  },

  hydLoad: {
    name: 'Hidráulica: sustentação de carga com contrabalanço',
    description: 'Carga tracionando o cilindro com centro flutuante — a válvula de contrabalanço sustenta a carga.',
    build() {
      const c = new Circuit();
      const cyl = c.add('h_cyl', 380, 60);
      const cb = c.add('h_counterbalance', 700, 210);
      const valve = c.add('h_v43_float', 420, 340);
      const relief = c.add('h_relief', 240, 500);
      const pump = c.add('h_pump', 100, 500);
      const tank = c.add('h_tank', 100, 650);
      const tank2 = c.add('h_tank', 240, 650);
      pump.params.flow.value = 10;
      relief.params.setpoint.value = 200;
      cyl.params.load.value = -12000; // overrunning: the load pulls the rod out
      cb.params.setpoint.value = 170;

      c.connect({ inst: pump.id, port: 'P' }, { inst: relief.id, port: 'P' });
      c.connect({ inst: pump.id, port: 'P' }, { inst: valve.id, port: 'P' });
      c.connect({ inst: pump.id, port: 'T' }, { inst: tank.id, port: 'T' });
      c.connect({ inst: relief.id, port: 'T' }, { inst: tank2.id, port: 'T' });
      c.connect({ inst: valve.id, port: 'T' }, { inst: tank2.id, port: 'T' });
      c.connect({ inst: valve.id, port: 'A' }, { inst: cyl.id, port: 'A' });
      c.connect({ inst: cyl.id, port: 'B' }, { inst: cb.id, port: '2' });
      c.connect({ inst: cb.id, port: '1' }, { inst: valve.id, port: 'B' });
      c.connect({ inst: cb.id, port: 'X' }, { inst: valve.id, port: 'A' });
      return c;
    },
  },

  grafcet: {
    name: 'GRAFCET: A+ B+ A− B−',
    description: 'A mesma sequência pneumática, comandada pela lógica do GRAFCET. Inicie com S1.',
    build() {
      const c = new Circuit();
      const A = c.add('cyl_double', 320, 60);
      const B = c.add('cyl_double', 320, 190);
      A.params.tag.value = '1A1';
      B.params.tag.value = '2A1';

      const V1 = c.add('v52_sol_spring', 280, 350);
      const V2 = c.add('v52_sol_spring', 620, 350);
      V1.params.tag.value = '1V1'; V1.params.solA.value = 'A_PLUS';
      V2.params.tag.value = '2V1'; V2.params.solA.value = 'B_PLUS';
      const src = c.add('supply', 440, 500);

      c.connect({ inst: V1.id, port: '4' }, { inst: A.id, port: '1' });
      c.connect({ inst: V1.id, port: '2' }, { inst: A.id, port: '2' });
      c.connect({ inst: V2.id, port: '4' }, { inst: B.id, port: '1' });
      c.connect({ inst: V2.id, port: '2' }, { inst: B.id, port: '2' });
      c.connect({ inst: src.id, port: '1' }, { inst: V1.id, port: '1' });
      c.connect({ inst: src.id, port: '1' }, { inst: V2.id, port: '1' });

      const mk = (tag, target, at, x) => {
        const s = c.add('limit_switch', x, 620);
        s.params.tag.value = tag;
        s.params.target.value = target.id;
        s.params.at.value = at;
        return s;
      };
      mk('a0', A, 0, 220); mk('a1', A, 1, 300);
      mk('b0', B, 0, 380); mk('b1', B, 1, 460);
      const start = c.add('btn_no', 140, 620);
      start.params.tag.value = 'S1';

      const g = new Grafcet();
      const s0 = g.addStep({ name: '0', initial: true, x: 60, y: 40 });
      const s1 = g.addStep({ name: '1', x: 60, y: 130, actions: [{ kind: 'continuous', target: 'A_PLUS' }] });
      const s2 = g.addStep({ name: '2', x: 60, y: 220, actions: [
        { kind: 'continuous', target: 'A_PLUS' }, { kind: 'continuous', target: 'B_PLUS' }] });
      const s3 = g.addStep({ name: '3', x: 60, y: 310, actions: [{ kind: 'continuous', target: 'B_PLUS' }] });
      const s4 = g.addStep({ name: '4', x: 60, y: 400, actions: [] });
      g.addTransition({ from: [s0.id], to: [s1.id], receptivity: 'S1 * a0 * b0', y: 90 });
      g.addTransition({ from: [s1.id], to: [s2.id], receptivity: 'a1', y: 180 });
      g.addTransition({ from: [s2.id], to: [s3.id], receptivity: 'b1', y: 270 });
      g.addTransition({ from: [s3.id], to: [s4.id], receptivity: 'a0', y: 360 });
      g.addTransition({ from: [s4.id], to: [s0.id], receptivity: 'b0', y: 450 });
      g.reset();
      c.chart = g;
      return c;
    },
  },

  electro: {
    name: 'Eletropneumática: circuito de selo',
    description: 'O comando Ladder com selo no relé K1 aciona o solenoide Y1.',
    build() {
      const c = new Circuit();
      const cyl = c.add('cyl_double', 330, 60);
      const main = c.add('v52_sol_spring', 350, 210);
      const src = c.add('supply', 356, 330);
      main.params.solA.value = 'Y1';

      c.connect({ inst: main.id, port: '4' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: main.id, port: '2' }, { inst: cyl.id, port: '2' });
      c.connect({ inst: src.id, port: '1' }, { inst: main.id, port: '1' });

      // Ladder: rung 1 latches K1, rung 2 drives Y1.
      const p24a = c.add('rail_24v', 150, 420);
      const p0a = c.add('rail_0v', 150, 630);
      const s1 = c.add('btn_no', 156, 450);
      const k1c = c.add('contact_no', 246, 450);
      const stop = c.add('btn_nc', 156, 520);
      const coil = c.add('relay_coil', 153, 580);
      s1.params.tag.value = 'S1';
      stop.params.tag.value = 'S2';
      coil.params.tag.value = 'K1';
      k1c.params.tag.value = 'K1';

      c.connect({ inst: p24a.id, port: 'a' }, { inst: s1.id, port: 'a' });
      c.connect({ inst: p24a.id, port: 'a' }, { inst: k1c.id, port: 'a' });
      c.connect({ inst: s1.id, port: 'b' }, { inst: stop.id, port: 'a' });
      c.connect({ inst: k1c.id, port: 'b' }, { inst: stop.id, port: 'a' });
      c.connect({ inst: stop.id, port: 'b' }, { inst: coil.id, port: 'a' });
      c.connect({ inst: coil.id, port: 'b' }, { inst: p0a.id, port: 'a' });

      const p24b = c.add('rail_24v', 470, 420);
      const p0b = c.add('rail_0v', 470, 630);
      const k1c2 = c.add('contact_no', 476, 470);
      const y1 = c.add('sol_coil', 473, 560);
      const lampP = c.add('lamp', 593, 470);
      k1c2.params.tag.value = 'K1';
      y1.params.tag.value = 'Y1';
      lampP.params.tag.value = 'P1';

      c.connect({ inst: p24b.id, port: 'a' }, { inst: k1c2.id, port: 'a' });
      c.connect({ inst: k1c2.id, port: 'b' }, { inst: y1.id, port: 'a' });
      c.connect({ inst: y1.id, port: 'b' }, { inst: p0b.id, port: 'a' });
      // Lamp hangs off the same rung, so it reports Y1 rather than just mains power.
      c.connect({ inst: k1c2.id, port: 'b' }, { inst: lampP.id, port: 'a' });
      c.connect({ inst: lampP.id, port: 'b' }, { inst: p0b.id, port: 'a' });
      return c;
    },
  },
};
