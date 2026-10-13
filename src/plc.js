// Soft-PLC: a ladder or a subset of Structured Text, executed against the mapped I/O in
// the same tick loop as the physics.
//
// SCOPE — an honest subset of IEC 61131-3 ST
// ------------------------------------------
// Present, and meant properly:
//
//   assignment     A := expr;
//   selection      IF / THEN / ELSIF / ELSE / END_IF
//   booleans       AND  OR  XOR  NOT, with real precedence and parentheses
//   comparison     =  <>  <  >  <=  >=
//   arithmetic     +  -  *  /  and unary minus
//   declarations   VAR … END_VAR  (BOOL, INT, REAL, TIME and function-block instances)
//   time literals  T#500ms, T#1.5s, T#2m30s
//   function blocks  TON, TOF, CTU, CTD — called IEC-style with named arguments and read
//                    through their outputs: T1(IN := x, PT := T#1s); done := T1.Q;
//
// Absent, and NOT faked: FOR/WHILE/CASE/REPEAT, arrays, structs, user function blocks,
// STRING, CASE, EXIT, and the other 90 % of the standard library. This is a subset, and a
// subset that pretends to be the language is worse than one that says what it is.
//
// WHY A RECURSIVE-DESCENT PARSER
// ------------------------------
// Same reason as parseReceptivity in grafcet.js: precedence and parentheses are the entire
// point of an expression language, and a regex can express neither. `a OR b AND NOT c` has
// exactly one correct reading and a pattern match cannot find it.
//
// Statements and expressions compile to closures, not to an AST that gets walked. The
// parse happens once; a scan is then just calls.
//
// SCAN SEMANTICS
// --------------
// One tick = scan inputs, run the program top to bottom, flush outputs. Statements execute
// *sequentially* within a scan, so a later statement sees what an earlier one wrote — that
// is ST, not a bug, and it is what makes a step chain written as consecutive IFs behave
// the way a PLC programmer expects. Ladder rungs are the same: top to bottom, once.

import { truthy } from './io.js';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const KEYWORDS = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'VAR', 'END_VAR',
  'AND', 'OR', 'XOR', 'NOT', 'TRUE', 'FALSE', 'MOD',
]);

// Longest first: ':=' must not lex as ':' then '='.
// '&' is IEC's second spelling of AND, not a convenience of ours.
const SYMBOLS = [':=', '<>', '<=', '>=', '(', ')', ';', ',', ':', '.', '=', '<', '>', '+', '-', '*', '/', '&'];

/** T#500ms, T#1.5s, T#2m30s -> seconds. */
export function parseDuration(lit) {
  const body = lit.replace(/^[Tt]#/, '').replace(/_/g, '');
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  let total = 0, consumed = 0, m;
  const unit = { ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400 };
  while ((m = re.exec(body))) {
    total += parseFloat(m[1]) * unit[m[2]];
    consumed += m[0].length;
  }
  if (!consumed || consumed !== body.length) throw new Error(`Literal de tempo inválido “${lit}”`);
  return total;
}

export function tokenize(src) {
  const out = [];
  const s = String(src);
  let i = 0;
  const line = () => s.slice(0, i).split('\n').length;

  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (s.startsWith('(*', i)) {
      const end = s.indexOf('*)', i + 2);
      if (end < 0) throw new Error(`Comentário iniciado na linha ${line()} não foi fechado`);
      i = end + 2; continue;
    }
    if (s.startsWith('//', i)) {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end; continue;
    }
    // Time literal before identifier: T#1s starts like an identifier.
    if (/^[Tt]#/.test(s.slice(i, i + 2))) {
      const m = /^[Tt]#[\d._]+(?:ms|s|m|h|d)(?:[\d._]+(?:ms|s|m|h|d))*/.exec(s.slice(i));
      if (!m) throw new Error(`Literal de tempo inválido na linha ${line()}`);
      out.push({ type: 'time', value: parseDuration(m[0]), text: m[0], line: line() });
      i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(i));
      const word = m[0];
      const up = word.toUpperCase();
      out.push({ type: KEYWORDS.has(up) ? 'kw' : 'id', value: KEYWORDS.has(up) ? up : word, text: word, line: line() });
      i += word.length; continue;
    }
    if (/\d/.test(c)) {
      const m = /^\d+(?:\.\d+)?/.exec(s.slice(i));
      out.push({ type: 'num', value: parseFloat(m[0]), text: m[0], line: line() });
      i += m[0].length; continue;
    }
    const sym = SYMBOLS.find((k) => s.startsWith(k, i));
    if (!sym) throw new Error(`Caractere inesperado “${c}” na linha ${line()}`);
    out.push({ type: 'op', value: sym, text: sym, line: line() });
    i += sym.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Function blocks
// ---------------------------------------------------------------------------

const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));

/** IEC TON: output follows input after PT of continuous input. */
export class TON {
  constructor() { this.Q = false; this.ET = 0; }
  call(a, dt) {
    const PT = num(a.PT ?? 0);
    if (!truthy(a.IN)) { this.ET = 0; this.Q = false; return; }
    // ET stops at PT (IEC): a timer that keeps counting would make ET meaningless as a
    // "how far in" readout on a long-running input.
    this.ET = Math.min(this.ET + dt, PT);
    this.Q = this.ET >= PT;
  }
}

/** IEC TOF: output drops PT after the input drops. */
export class TOF {
  constructor() { this.Q = false; this.ET = 0; }
  call(a, dt) {
    const PT = num(a.PT ?? 0);
    if (truthy(a.IN)) { this.ET = 0; this.Q = true; return; }
    if (!this.Q) return;
    this.ET = Math.min(this.ET + dt, PT);
    if (this.ET >= PT) this.Q = false;
  }
}

/** IEC CTU: counts rising edges of CU. */
export class CTU {
  constructor() { this.CV = 0; this.Q = false; this.last = false; }
  call(a) {
    const CU = truthy(a.CU);
    if (truthy(a.RESET)) this.CV = 0;
    else if (CU && !this.last) this.CV++;
    this.last = CU;
    this.Q = this.CV >= num(a.PV ?? 0);
  }
}

/** IEC CTD: LD loads PV, CD counts down, Q at zero. */
export class CTD {
  constructor() { this.CV = 0; this.Q = false; this.last = false; }
  call(a) {
    const CD = truthy(a.CD);
    if (truthy(a.LD)) this.CV = num(a.PV ?? 0);
    else if (CD && !this.last && this.CV > 0) this.CV--;
    this.last = CD;
    this.Q = this.CV <= 0;
  }
}

export const FB_TYPES = { TON, TOF, CTU, CTD };
const VAR_DEFAULT = { BOOL: false, INT: 0, DINT: 0, REAL: 0, TIME: 0 };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Compiles ST source.
 * @returns {{ run: (ctx) => void, decls: Map<string, {type: string}> }}
 */
export function parseST(src) {
  const toks = tokenize(src);
  let pos = 0;

  const peek = (k = 0) => toks[pos + k];
  const at = (type, value) => {
    const t = peek();
    return !!t && t.type === type && (value === undefined || t.value === value);
  };
  const where = () => {
    const t = peek();
    return t ? `“${t.text}” (linha ${t.line})` : 'fim da entrada';
  };
  const eat = (type, value) => {
    if (!at(type, value)) throw new Error(`Esperado “${value}”, encontrado ${where()}`);
    return toks[pos++];
  };

  // --- declarations ----------------------------------------------------

  const decls = new Map();
  const parseVarBlock = () => {
    eat('kw', 'VAR');
    while (!at('kw', 'END_VAR')) {
      if (!at('id')) throw new Error(`Esperado nome de variável, encontrado ${where()}`);
      const name = toks[pos++].value;
      eat('op', ':');
      if (!at('id')) throw new Error(`Esperado tipo, encontrado ${where()}`);
      const type = toks[pos++].value.toUpperCase();
      if (!FB_TYPES[type] && !(type in VAR_DEFAULT)) throw new Error(`Tipo desconhecido “${type}” para “${name}”`);
      if (decls.has(name)) throw new Error(`Variável “${name}” declarada mais de uma vez`);
      decls.set(name, { type });
      eat('op', ';');
    }
    eat('kw', 'END_VAR');
  };

  // --- expressions -----------------------------------------------------
  //
  // Precedence, loosest to tightest: OR < XOR < AND < comparison < additive <
  // multiplicative < unary < primary. This is the IEC order, and it is the reason the
  // parser exists.

  const parseOr = () => {
    let l = parseXor();
    while (at('kw', 'OR')) { pos++; const r = parseXor(); const p = l; l = (c) => truthy(p(c)) || truthy(r(c)); }
    return l;
  };
  const parseXor = () => {
    let l = parseAnd();
    while (at('kw', 'XOR')) { pos++; const r = parseAnd(); const p = l; l = (c) => truthy(p(c)) !== truthy(r(c)); }
    return l;
  };
  const parseAnd = () => {
    let l = parseCompare();
    while (at('kw', 'AND') || at('op', '&')) { pos++; const r = parseCompare(); const p = l; l = (c) => truthy(p(c)) && truthy(r(c)); }
    return l;
  };
  const CMP = {
    '=': (a, b) => num(a) === num(b),
    '<>': (a, b) => num(a) !== num(b),
    '<': (a, b) => num(a) < num(b),
    '>': (a, b) => num(a) > num(b),
    '<=': (a, b) => num(a) <= num(b),
    '>=': (a, b) => num(a) >= num(b),
  };
  const parseCompare = () => {
    let l = parseAdd();
    while (at('op') && CMP[peek().value]) {
      const op = CMP[toks[pos++].value];
      const r = parseAdd(); const p = l;
      l = (c) => op(p(c), r(c));
    }
    return l;
  };
  const parseAdd = () => {
    let l = parseMul();
    while (at('op', '+') || at('op', '-')) {
      const op = toks[pos++].value;
      const r = parseMul(); const p = l;
      l = op === '+' ? (c) => num(p(c)) + num(r(c)) : (c) => num(p(c)) - num(r(c));
    }
    return l;
  };
  const parseMul = () => {
    let l = parseUnary();
    while (at('op', '*') || at('op', '/') || at('kw', 'MOD')) {
      const op = toks[pos++].value;
      const r = parseUnary(); const p = l;
      if (op === '*') l = (c) => num(p(c)) * num(r(c));
      else if (op === '/') l = (c) => num(p(c)) / num(r(c));
      else l = (c) => num(p(c)) % num(r(c));
    }
    return l;
  };
  const parseUnary = () => {
    if (at('kw', 'NOT')) { pos++; const i = parseUnary(); return (c) => !truthy(i(c)); }
    if (at('op', '-')) { pos++; const i = parseUnary(); return (c) => -num(i(c)); }
    if (at('op', '+')) { pos++; return parseUnary(); }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const t = peek();
    if (!t) throw new Error('A expressão termina inesperadamente');
    if (at('op', '(')) { pos++; const e = parseOr(); eat('op', ')'); return e; }
    if (t.type === 'num') { pos++; return () => t.value; }
    if (t.type === 'time') { pos++; return () => t.value; }
    if (at('kw', 'TRUE')) { pos++; return () => true; }
    if (at('kw', 'FALSE')) { pos++; return () => false; }
    if (t.type === 'id') {
      pos++;
      if (at('op', '.')) {
        pos++;
        if (!at('id')) throw new Error(`Esperado nome de saída após “.”, encontrado ${where()}`);
        const field = toks[pos++].value;
        return (c) => c.member(t.value, field);
      }
      return (c) => c.get(t.value);
    }
    throw new Error(`Token inesperado ${where()} na expressão`);
  };

  // --- statements ------------------------------------------------------

  const parseBlock = (stop) => {
    const body = [];
    while (pos < toks.length && !stop.some((k) => at('kw', k))) body.push(parseStatement());
    if (pos >= toks.length && stop.length) {
      throw new Error(`Esperado “${stop.join('” ou “')}”, encontrado fim da entrada`);
    }
    return (c) => { for (const st of body) st(c); };
  };

  const parseIf = () => {
    eat('kw', 'IF');
    const cond = parseOr();
    eat('kw', 'THEN');
    const then = parseBlock(['ELSIF', 'ELSE', 'END_IF']);
    let otherwise = null;
    if (at('kw', 'ELSIF')) {
      // An ELSIF chain is exactly a nested IF, so parse it as one instead of inventing a
      // third statement shape that would need its own tests.
      toks[pos] = { ...toks[pos], type: 'kw', value: 'IF', text: 'IF' };
      otherwise = parseIf();
      return (c) => { if (truthy(cond(c))) then(c); else otherwise(c); };
    }
    if (at('kw', 'ELSE')) { pos++; otherwise = parseBlock(['END_IF']); }
    eat('kw', 'END_IF');
    if (at('op', ';')) pos++;
    return (c) => { if (truthy(cond(c))) then(c); else otherwise?.(c); };
  };

  const parseCall = (name) => {
    eat('op', '(');
    const args = [];
    if (!at('op', ')')) {
      for (;;) {
        if (!at('id')) throw new Error(`Esperado nome de parâmetro, encontrado ${where()}`);
        const arg = toks[pos++].value.toUpperCase();
        eat('op', ':=');
        args.push([arg, parseOr()]);
        if (at('op', ',')) { pos++; continue; }
        break;
      }
    }
    eat('op', ')');
    eat('op', ';');
    return (c) => {
      const a = {};
      for (const [k, f] of args) a[k] = f(c);
      c.call(name, a);
    };
  };

  const parseStatement = () => {
    if (at('kw', 'IF')) return parseIf();
    if (at('kw', 'VAR')) throw new Error('O bloco VAR deve vir antes da primeira instrução');
    if (!at('id')) throw new Error(`Esperada instrução, encontrado ${where()}`);
    const name = toks[pos++].value;
    if (at('op', '(')) return parseCall(name);
    if (at('op', ':=')) {
      pos++;
      const e = parseOr();
      eat('op', ';');
      return (c) => c.set(name, e(c));
    }
    throw new Error(`Esperado “:=” ou “(” após “${name}”, encontrado ${where()}`);
  };

  while (at('kw', 'VAR')) parseVarBlock();
  const body = [];
  while (pos < toks.length) body.push(parseStatement());

  return { decls, run: (c) => { for (const st of body) st(c); } };
}

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------
//
// A rung is a boolean network over named signals plus one coil. The combinators build the
// same kind of closure the ST parser emits, so both languages hit an identical runtime —
// there is no second evaluator to keep in step.

/** Normally-open contact. */
export const no = (name) => (c) => truthy(c.get(name));
/** Normally-closed contact. */
export const nc = (name) => (c) => !truthy(c.get(name));
export const and = (...fs) => (c) => fs.every((f) => f(c));
export const or = (...fs) => (c) => fs.some((f) => f(c));
export const not = (f) => (c) => !f(c);
/** Constant rail — a rung that is always true. */
export const always = () => true;

/** Edge detection carries its own memory, exactly like edgeOf in grafcet.js. */
const edge = (f, rising) => {
  let last = null;
  return (c) => {
    const now = f(c);
    const fired = last !== null && (rising ? !last && now : last && !now);
    last = now;
    return fired;
  };
};
export const risingEdge = (f) => edge(f, true);
export const fallingEdge = (f) => edge(f, false);

/** `{ coil, logic }` — plain coil. */
export const rung = (coil, logic) => ({ coil, logic, kind: 'coil' });
/** Set/reset (latching) coils. A rung that does not conduct leaves them alone. */
export const setRung = (coil, logic) => ({ coil, logic, kind: 'set' });
export const resetRung = (coil, logic) => ({ coil, logic, kind: 'reset' });

// ---------------------------------------------------------------------------
// The PLC
// ---------------------------------------------------------------------------

export class PLC {
  /**
   * @param {import('./io.js').IOMap} io
   */
  constructor(io) {
    this.io = io;
    this.vars = new Map();
    this.fbs = new Map();
    this.decls = new Map();
    this.program = null;   // ST
    this.rungs = [];       // ladder
    this.scans = 0;
    this.error = null;
  }

  /** Compiles ST. Throws on a syntax error — a PLC that runs a broken program is worse. */
  loadST(src) {
    const { run, decls } = parseST(src);
    this.program = run;
    this.decls = decls;
    this.reset();
    return this;
  }

  loadLadder(rungs) { this.rungs = rungs; return this; }

  /** Back to power-on state: declared variables to their type default, FBs fresh. */
  reset() {
    this.scans = 0;
    this.vars.clear();
    this.fbs.clear();
    for (const [name, { type }] of this.decls ?? []) {
      if (FB_TYPES[type]) this.fbs.set(name, new FB_TYPES[type]());
      else this.vars.set(name, VAR_DEFAULT[type]);
    }
  }

  /**
   * Reading resolves I/O first: a name that is a port IS that port, and a program that
   * shadowed `start` with a local of the same name would be unreadable.
   */
  ctx(dt) {
    return {
      dt,
      get: (name) => {
        if (this.io?.has(name)) return this.io.get(name);
        if (this.vars.has(name)) return this.vars.get(name);
        if (this.fbs.has(name)) throw new Error(`“${name}” é um bloco de função — leia .Q ou .ET`);
        return false; // undeclared: a level that was never written is low
      },
      set: (name, value) => {
        if (this.io?.has(name)) return void this.io.set(name, value); // throws on an input
        this.vars.set(name, value);
      },
      member: (name, field) => {
        const fb = this.fbs.get(name);
        if (!fb) throw new Error(`“${name}” não é um bloco de função`);
        if (!(field in fb)) throw new Error(`“${name}.${field}” não existe`);
        return fb[field];
      },
      call: (name, args) => {
        const fb = this.fbs.get(name);
        if (!fb) throw new Error(`Bloco de função “${name}” não declarado`);
        fb.call(args, dt);
      },
    };
  }

  /** One scan: read inputs, run the logic, write outputs. */
  tick(dt) {
    this.io?.scan();
    const c = this.ctx(dt);
    this.program?.(c);
    for (const r of this.rungs) {
      const on = !!r.logic(c);
      if (r.kind === 'set') { if (on) c.set(r.coil, true); }
      else if (r.kind === 'reset') { if (on) c.set(r.coil, false); }
      else c.set(r.coil, on);
    }
    this.io?.flush();
    this.scans++;
  }
}

/**
 * Adapter for `runHeadless({ script })`. The hook fires before sim.step(), which is
 * exactly where a PLC belongs: its outputs are then read by the components' updateState
 * within the same tick. `dt` is passed explicitly rather than derived from sim.time —
 * the first call happens at t=0, so a difference would be zero and every timer would
 * lose its first scan.
 */
export const plcScript = (plc, dt = 1e-3) => () => plc.tick(dt);
