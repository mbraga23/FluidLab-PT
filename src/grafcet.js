// GRAFCET (EN 60848).
//
// Deliberately NOT modelled as circuit components. A GRAFCET is a *specification* that
// sits above the circuit: it reads the plant's sensors and commands its actuators, and it
// has its own evolution rules that have nothing to do with nets and conductances. Forcing
// it into the electric net graph would mean inventing wires that the standard does not
// have, and would make the firing rules impossible to state correctly.
//
// EVOLUTION RULES (EN 60848 §4)
// ----------------------------
//  R1  Initial steps are active at start-up.
//  R2  A transition is *enabled* when every upstream step is active. It is *fireable*
//      when it is enabled AND its receptivity is true.
//  R3  Firing deactivates ALL upstream steps and activates ALL downstream steps.
//  R4  All simultaneously fireable transitions fire simultaneously. This is the rule that
//      makes parallel branches work and the one a naive sequential loop gets wrong: it
//      must be evaluated against a *frozen snapshot* of step activity, or the first
//      transition's firing changes what the second one sees.
//  R5  A step that is both activated and deactivated in the same evolution stays active.
//
// Firing is iterated to a stable situation within one tick (a chain of transitions whose
// receptivities are all true fires through in one go), which is what the standard means
// by "the evolution is instantaneous".

let seq = 1;
const nid = (p) => `${p}${seq++}`;

export const ACTION_KINDS = {
  continuous: 'Contínua (enquanto a etapa estiver ativa)',
  stored: 'Memorizada (atribuição ao ativar a etapa)',
};

/** A GRAFCET chart. Owns its steps and transitions; one per document. */
export class Grafcet {
  constructor() {
    this.steps = new Map();        // id -> {id, name, initial, x, y, actions:[]}
    this.transitions = new Map();  // id -> {id, from:[stepId], to:[stepId], receptivity, x, y}
    this.active = new Set();
    this.stepTimers = new Map();   // stepId -> seconds active, for t/Xn/5s receptivities
    this.lastFired = new Set();
  }

  addStep({ name, initial = false, x = 0, y = 0, actions = [] } = {}) {
    const id = nid('S');
    const step = { id, name: name ?? id, initial, x, y, actions };
    this.steps.set(id, step);
    return step;
  }

  addTransition({ from = [], to = [], receptivity = '1', x = 0, y = 0 } = {}) {
    const id = nid('T');
    const t = { id, from: [...from], to: [...to], receptivity, x, y };
    this.transitions.set(id, t);
    return t;
  }

  remove(id) {
    this.steps.delete(id);
    this.transitions.delete(id);
    for (const t of this.transitions.values()) {
      t.from = t.from.filter((s) => s !== id);
      t.to = t.to.filter((s) => s !== id);
    }
    this.active.delete(id);
    this.stepTimers.delete(id);
  }

  reset() {
    this.active = new Set([...this.steps.values()].filter((s) => s.initial).map((s) => s.id)); // R1
    this.stepTimers.clear();
    for (const id of this.active) this.stepTimers.set(id, 0);
    this.lastFired.clear();
  }

  isActive(stepId) { return this.active.has(stepId); }

  /** Seconds the step has been continuously active, for t/Xn/… receptivities. */
  stepTime(stepId) { return this.stepTimers.get(stepId) ?? 0; }

  /**
   * One evolution. `io` resolves named plant signals to booleans.
   * Returns the transitions that fired, for the UI to flash.
   */
  step(dt, io) {
    for (const id of this.active) this.stepTimers.set(id, (this.stepTimers.get(id) ?? 0) + dt);

    const fired = new Set();
    // Iterate to a stable situation: a chain of true receptivities is one instantaneous
    // evolution, not one transition per tick.
    for (let pass = 0; pass < 32; pass++) {
      const snapshot = new Set(this.active); // R4: everyone judges the same situation
      const fireable = [];

      for (const t of this.transitions.values()) {
        if (!t.from.length) continue;
        const enabled = t.from.every((s) => snapshot.has(s));  // R2
        if (!enabled) continue;
        if (!evalReceptivity(t.receptivity, this, io)) continue;
        fireable.push(t);
      }
      if (!fireable.length) break;

      // R3 + R5: collect all deactivations and activations, then apply together, so a
      // step that is both re-activated and deactivated survives.
      const off = new Set(), on = new Set();
      for (const t of fireable) {
        fired.add(t.id);
        t.from.forEach((s) => off.add(s));
        t.to.forEach((s) => on.add(s));
      }
      for (const s of off) if (!on.has(s)) { this.active.delete(s); this.stepTimers.delete(s); }
      for (const s of on) {
        if (!this.active.has(s)) this.stepTimers.set(s, 0);
        this.active.add(s);
      }
    }

    this.lastFired = fired;
    return fired;
  }

  /**
   * Commands the chart currently issues: action name -> true.
   * Continuous actions hold while their step is active; stored actions are latched here
   * and cleared only by another stored action writing 0.
   */
  outputs() {
    const out = new Map();
    // Every continuous target the chart knows about starts at false. Omitting the
    // inactive ones instead — which an earlier version did — leaves the consumer holding
    // the last command it was given: A+ stayed asserted after its step was long gone, and
    // the sequence stalled with both cylinders out. A continuous action must be *driven*
    // off, not merely not driven on.
    for (const s of this.steps.values()) {
      for (const a of s.actions) if (a.kind === 'continuous') out.set(a.target, false);
    }
    for (const id of this.active) {
      for (const a of this.steps.get(id).actions) {
        if (a.kind === 'continuous') out.set(a.target, true);
      }
    }
    // Stored actions win: they are explicit assignments and outlive their step by design.
    for (const [k, v] of this.stored) out.set(k, v);
    return out;
  }

  stored = new Map();

  /** Applies stored actions of every step that has just become active. */
  applyStored(newlyActive) {
    for (const id of newlyActive) {
      for (const a of this.steps.get(id)?.actions ?? []) {
        if (a.kind === 'stored') this.stored.set(a.target, a.value !== false && a.value !== 0);
      }
    }
  }

  toJSON() {
    return {
      steps: [...this.steps.values()].map((s) => ({ ...s })),
      transitions: [...this.transitions.values()].map((t) => ({ ...t })),
    };
  }

  static fromJSON(data) {
    const g = new Grafcet();
    if (!data) return g;
    const map = new Map();
    for (const raw of data.steps || []) {
      const s = g.addStep(raw);
      map.set(raw.id, s.id);
    }
    for (const raw of data.transitions || []) {
      g.addTransition({
        ...raw,
        from: (raw.from || []).map((x) => map.get(x)).filter(Boolean),
        to: (raw.to || []).map((x) => map.get(x)).filter(Boolean),
      });
    }
    // Step names are what receptivities refer to (X1, X2 …), so they must survive the
    // id remap or every expression breaks on load.
    for (const [oldId, newId] of map) {
      const raw = (data.steps || []).find((s) => s.id === oldId);
      if (raw) g.steps.get(newId).name = raw.name;
    }
    g.reset();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Receptivities
// ---------------------------------------------------------------------------
//
// A small boolean expression language, because EN 60848 receptivities are boolean
// expressions and nothing less will do:
//
//   S1              a plant signal (sensor, button) by tag
//   X2              step activity
//   /S1  or  !S1    negation
//   S1 * S2         AND     (also &, and)
//   S1 + S2         OR      (also |, or)
//   ↑S1  /  ↓S1     rising / falling edge
//   t/X2/5s         X2 has been active for 5 s
//   1  /  0         constants
//   ( )             grouping
//
// A recursive-descent parser rather than a regex: precedence and parentheses are the
// whole point, and a regex cannot express either.

export function tokenize(src) {
  const out = [];
  const re = /\s*(t\/X?\w+\/[\d.]+s|[↑↓]|[A-Za-z_][\w.]*|\d+(?:\.\d+)?|[()*+/!&|])/gy;
  let m, i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m) {
      if (/^\s+$/.test(src.slice(i))) break;
      throw new Error(`Caractere inesperado em „${src.slice(i, i + 8)}“`);
    }
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

/**
 * @param {string} src
 * @returns {(ctx) => boolean}  compiled predicate
 */
export function parseReceptivity(src) {
  const toks = tokenize(String(src ?? '1'));
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (t) => { if (toks[pos] !== t) throw new Error(`Esperado “${t}”, encontrado “${toks[pos] ?? 'fim'}”`); pos++; };

  // or := and ('+' and)*
  const parseOr = () => {
    let l = parseAnd();
    while (peek() === '+' || peek() === '|' || peek() === 'or') {
      pos++;
      const r = parseAnd();
      const prev = l;
      l = (c) => prev(c) || r(c);
    }
    return l;
  };
  // and := unary ('*' unary)*
  const parseAnd = () => {
    let l = parseUnary();
    while (peek() === '*' || peek() === '&' || peek() === 'and') {
      pos++;
      const r = parseUnary();
      const prev = l;
      l = (c) => prev(c) && r(c);
    }
    return l;
  };
  const parseUnary = () => {
    const t = peek();
    // '/' is negation in GRAFCET notation, but only in prefix position — after an operand
    // it would be division, which this language does not have.
    if (t === '!' || t === '/') { pos++; const inner = parseUnary(); return (c) => !inner(c); }
    if (t === '↑') { pos++; const inner = parseUnary(); return edgeOf(inner, true); }
    if (t === '↓') { pos++; const inner = parseUnary(); return edgeOf(inner, false); }
    return parseAtom();
  };
  const parseAtom = () => {
    const t = peek();
    if (t === undefined) throw new Error('A expressão termina inesperadamente');
    if (t === '(') { pos++; const e = parseOr(); eat(')'); return e; }
    pos++;

    if (t === '1') return () => true;
    if (t === '0') return () => false;

    // t/X2/5s — X2 active for at least 5 s
    const tm = /^t\/(X?\w+)\/([\d.]+)s$/.exec(t);
    if (tm) {
      const target = tm[1].replace(/^X/, '');
      const secs = parseFloat(tm[2]);
      return (c) => c.stepTime(target) >= secs;
    }
    // X2 — step activity
    const xm = /^X(\w+)$/.exec(t);
    if (xm) { const n = xm[1]; return (c) => c.stepActive(n); }
    // anything else: a plant signal by tag
    return (c) => c.signal(t);
  };

  const fn = parseOr();
  if (pos < toks.length) throw new Error(`Token inesperado “${toks[pos]}” no final da expressão`);
  return fn;
}

/** Edge detection needs memory, so each compiled edge term carries its own. */
function edgeOf(inner, rising) {
  let last = null;
  return (c) => {
    const now = inner(c);
    // The very first evaluation has no previous value; treating that as an edge would
    // fire every chart on its first tick.
    const fired = last !== null && (rising ? (!last && now) : (last && !now));
    last = now;
    return fired;
  };
}

const cache = new Map();
function compiled(src) {
  if (!cache.has(src)) {
    try { cache.set(src, { fn: parseReceptivity(src), error: null }); }
    catch (e) { cache.set(src, { fn: () => false, error: e.message }); }
  }
  return cache.get(src);
}

/** Compile error for a receptivity, or null. Used by the editor to show it inline. */
export const receptivityError = (src) => compiled(String(src ?? '1')).error;

function evalReceptivity(src, chart, io) {
  const { fn } = compiled(String(src ?? '1'));
  return !!fn({
    signal: (tag) => io.signal(tag),
    stepActive: (name) => {
      const s = [...chart.steps.values()].find((x) => x.name === name || x.id === name);
      return s ? chart.active.has(s.id) : false;
    },
    stepTime: (name) => {
      const s = [...chart.steps.values()].find((x) => x.name === name || x.id === name);
      return s ? chart.stepTime(s.id) : 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Validation (EN 60848 structural rules)
// ---------------------------------------------------------------------------

export function validate(chart) {
  const issues = [];
  const steps = [...chart.steps.values()];
  const trans = [...chart.transitions.values()];

  if (!steps.length) return issues;
  if (!steps.some((s) => s.initial)) {
    issues.push({ level: 'err', text: 'Falta a etapa inicial — o GRAFCET não pode iniciar' });
  }

  for (const t of trans) {
    if (!t.from.length) issues.push({ level: 'err', text: `${t.id}: nenhuma etapa anterior`, id: t.id });
    if (!t.to.length) issues.push({ level: 'err', text: `${t.id}: nenhuma etapa seguinte`, id: t.id });
    const err = receptivityError(t.receptivity);
    if (err) issues.push({ level: 'err', text: `${t.id}: condição da transição — ${err}`, id: t.id });
  }

  // Unreachable steps: nothing activates them and they are not initial.
  const activated = new Set(trans.flatMap((t) => t.to));
  for (const s of steps) {
    if (!s.initial && !activated.has(s.id)) {
      issues.push({ level: 'warn', text: `${s.name}: inacessível — nenhuma transição ativa esta etapa`, id: s.id });
    }
    // Dead ends: a step nothing leads out of stalls the chart forever.
    const leaves = trans.some((t) => t.from.includes(s.id));
    if (!leaves) {
      issues.push({ level: 'warn', text: `${s.name}: sem saída — nenhuma transição dá continuidade`, id: s.id });
    }
  }

  // A duplicate step name silently breaks every X-reference to it.
  const names = new Map();
  for (const s of steps) {
    if (names.has(s.name)) issues.push({ level: 'warn', text: `Nome de etapa ${s.name} duplicado`, id: s.id });
    names.set(s.name, s.id);
  }
  return issues;
}
