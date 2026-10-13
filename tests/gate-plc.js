// Correctness gate — Soft-PLC and I/O ports (spec section 12).
//
// Same rule as tests/gate.js: these assert *behaviour*, not that code exists. The PLC
// tests measure what the parser computes and what the timers time; the plant test measures
// a real cylinder sequence through the pneumatics, and it measures the ORDER OF EDGES,
// because "both cylinders are out" is a state that the right and the wrong sequence both
// reach. Only the edges distinguish A+ B+ A− B− from A+ B+ B− A−.
//
// Run headless:  node tests/run.js

import { EXAMPLES } from '../src/circuit.js';
import { runHeadless } from '../src/engine.js';
import { IOMap, MockDriver, WebSocketDriver } from '../src/io.js';
import { PLC, parseST, parseDuration, tokenize, plcScript, rung, no, nc, and, or } from '../src/plc.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const close = (a, b, tol, msg) =>
  assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (Toleranz ${tol})`);

const byTag = (c, tag) => c.instances.find((i) => i.params?.tag?.value === tag);

/** Compiles a one-expression program and evaluates it against a plain variable bag. */
function evalST(expr, vars = {}) {
  const plc = new PLC(null);
  plc.loadST(`R := ${expr};`);
  for (const [k, v] of Object.entries(vars)) plc.vars.set(k, v);
  plc.tick(1e-3);
  return plc.vars.get('R');
}

const throwsWith = (fn, fragment) => {
  try { fn(); } catch (e) { return e.message.includes(fragment) ? null : `falsche Meldung: „${e.message}“`; }
  return 'kein Fehler geworfen';
};

// ---------------------------------------------------------------------------
// ST parser
// ---------------------------------------------------------------------------

test('ST-Parser: Vorrang NOT > AND > XOR > OR, gegen die Wahrheitstabelle geprüft', () => {
  // The whole reason for a recursive-descent parser. Each of these has exactly one correct
  // reading and a left-to-right evaluation gets it wrong.
  const cases = [
    // a OR b AND c  ==  a OR (b AND c)  — left-to-right would give (a OR b) AND c = false
    ['a OR b AND c', { a: true, b: true, c: false }, true],
    ['a AND b OR c', { a: false, b: true, c: true }, true],
    ['NOT a AND b', { a: false, b: true }, true],   // (NOT a) AND b, not NOT (a AND b)
    ['NOT a AND b', { a: true, b: true }, false],
    ['NOT a OR b', { a: true, b: false }, false],
    ['a XOR b OR c', { a: true, b: true, c: true }, true],   // (a XOR b) OR c = false OR true
    ['a OR b XOR c', { a: false, b: true, c: true }, false], // a OR (b XOR c) = false OR false
    ['a AND b XOR c', { a: true, b: true, c: true }, false], // (a AND b) XOR c
  ];
  for (const [src, vars, want] of cases) {
    const got = evalST(src, vars);
    assert(got === want, `„${src}“ mit ${JSON.stringify(vars)}: erwartet ${want}, war ${got}`);
  }

  // Comparison binds tighter than AND — otherwise `n = 1 AND m = 2` is unwritable.
  assert(evalST('n = 1 AND m = 2', { n: 1, m: 2 }) === true, 'Vergleich muss enger binden als AND');
  assert(evalST('n = 1 AND m = 2', { n: 1, m: 3 }) === false, 'Vergleich muss enger binden als AND');
  // Arithmetic binds tighter than comparison.
  assert(evalST('n + 1 > 2 * m', { n: 4, m: 2 }) === true, '„+“ und „*“ müssen enger binden als „>“');
  assert(evalST('n + 1 > 2 * m', { n: 2, m: 2 }) === false, '„+“ und „*“ müssen enger binden als „>“');
  return { faelle: cases.length + 4 };
});

test('ST-Parser: Klammern kehren den Vorrang um, Negation und Verschachtelung', () => {
  // Same terms, different grouping, different answer — if these agree the parser ignores
  // the parentheses.
  assert(evalST('a OR b AND c', { a: true, b: true, c: false }) === true, 'ohne Klammern: a OR (b AND c)');
  assert(evalST('(a OR b) AND c', { a: true, b: true, c: false }) === false, 'mit Klammern: (a OR b) AND c');

  assert(evalST('NOT (a AND b)', { a: true, b: true }) === false, 'NOT über der Klammer');
  assert(evalST('NOT a AND b', { a: true, b: true }) === false, 'NOT nur auf a');
  assert(evalST('NOT (a OR b)', { a: false, b: false }) === true, 'De Morgan: NOT(a OR b)');
  assert(evalST('NOT a AND NOT b', { a: false, b: false }) === true, 'De Morgan: NOT a AND NOT b');
  assert(evalST('NOT NOT a', { a: true }) === true, 'doppelte Negation');

  assert(evalST('((a AND (b OR c)) OR NOT d)', { a: true, b: false, c: true, d: true }) === true,
    'verschachtelte Klammern');
  assert(evalST('(a AND (b OR c)) OR NOT d', { a: false, b: false, c: true, d: true }) === false,
    'verschachtelte Klammern');
  // IEC's '&' is AND, at AND's precedence.
  assert(evalST('a OR b & c', { a: false, b: true, c: false }) === false, '„&“ muss wie AND binden');
  return { klammerung: 'kehrt das Ergebnis um' };
});

test('ST-Parser: Syntaxfehler werden gemeldet, nicht verschluckt', () => {
  const cases = [
    ['A := (b AND c;', 'Esperado “)”'],
    ['A := b AND;', 'Token inesperado “;”'],          // operand missing, but the input goes on
    ['A := b AND', 'A expressão termina inesperadamente'],  // operand missing at the very end
    ['A := b # c;', 'Caractere inesperado'],
    ['A := b', 'Esperado “;”'],
    ['IF a THEN b := 1;', '“END_IF”, encontrado fim da entrada'],
    ['A b := 1;', 'Esperado “:=” ou “(” após “A”'],
    ['VAR x : NONSENSE; END_VAR', 'Tipo desconhecido'],
    ['VAR x : BOOL; x : INT; END_VAR', 'declarada mais de uma vez'],
    ['(* nie zu', 'não foi fechado'],
    ['A := T#5x;', 'Literal de tempo inválido'],
    ['A := ;', 'Token inesperado “;”'],
  ];
  for (const [src, want] of cases) {
    const bad = throwsWith(() => parseST(src), want);
    assert(!bad, `„${src}“ → ${bad}`);
  }

  // Runtime errors that a parser cannot see must still surface rather than read as false.
  const plc = new PLC(null);
  plc.loadST('VAR T1 : TON; END_VAR\nA := T1.NOPE;');
  assert(!throwsWith(() => plc.tick(1e-3), '“T1.NOPE” não existe'), 'unbekannter FB-Ausgang muss auffallen');

  const plc2 = new PLC(null);
  plc2.loadST('T9(IN := TRUE, PT := T#1s);');
  assert(!throwsWith(() => plc2.tick(1e-3), 'não declarado'), 'undeklarierter FB muss auffallen');

  // An input is not writable — on real hardware it is not, and pretending otherwise would
  // let a program forge its own sensors.
  const io = new IOMap(null);
  io.digitalIn('sensor');
  const plc3 = new PLC(io);
  plc3.loadST('sensor := TRUE;');
  assert(!throwsWith(() => plc3.tick(1e-3), 'é uma entrada e não pode ser escrita'),
    'Schreiben auf einen Eingang muss fehlschlagen');

  // And a valid program must not raise a single one of these — a parser that cries wolf is
  // as useless as one that never does.
  parseST(`VAR n : INT; T1 : TON; END_VAR
    IF n < 3 AND NOT (a OR b) THEN n := n + 1; ELSIF a THEN n := 0; ELSE n := n - 1; END_IF;
    T1(IN := n > 1, PT := T#250ms);
    done := T1.Q;`);
  return { fehlerfaelle: cases.length + 3, gueltiges_programm: 'ohne Meldung' };
});

test('ST: Zeitliterale, IF/ELSIF/ELSE und sequentielle Scan-Semantik', () => {
  close(parseDuration('T#500ms'), 0.5, 0, 'T#500ms');
  close(parseDuration('T#1.5s'), 1.5, 1e-12, 'T#1.5s');
  close(parseDuration('T#2m30s'), 150, 1e-12, 'T#2m30s');
  close(parseDuration('T#1h'), 3600, 0, 'T#1h');
  assert(!throwsWith(() => parseDuration('T#5x'), 'Literal de tempo inválido'), 'kaputte Einheit muss auffallen');
  assert(tokenize('a := 1; // Kommentar\n(* auch *) b := 2;').length === 8,
    'Kommentare dürfen keine Token erzeugen');

  // ELSIF picks exactly one branch.
  const plc = new PLC(null);
  plc.loadST(`VAR n : INT; out : INT; END_VAR
    IF n = 1 THEN out := 10; ELSIF n = 2 THEN out := 20; ELSIF n = 3 THEN out := 30; ELSE out := 99; END_IF;`);
  const branch = (n) => { plc.vars.set('n', n); plc.tick(1e-3); return plc.vars.get('out'); };
  for (const [n, want] of [[1, 10], [2, 20], [3, 30], [7, 99]]) {
    assert(branch(n) === want, `n=${n} muss ${want} liefern, war ${branch(n)}`);
  }

  // ST runs top to bottom within one scan: the second statement must see the first's
  // write. This is what makes a step chain of consecutive IFs behave like a PLC.
  const seq = new PLC(null);
  seq.loadST('VAR n : INT; END_VAR\nn := 1;\nIF n = 1 THEN n := 2; END_IF;');
  seq.tick(1e-3);
  assert(seq.vars.get('n') === 2, `Statements müssen sequentiell wirken, n war ${seq.vars.get('n')}`);
  return { 'T#2m30s': '150 s', ELSIF: '1/2/3/sonst → 10/20/30/99' };
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

test('TON/TOF messen ihre Zeit — Einschalt- und Ausschaltverzögerung gemessen, nicht behauptet', () => {
  const dt = 1e-3;
  const plc = new PLC(null);
  plc.loadST(`VAR T1 : TON; T2 : TOF; END_VAR
    T1(IN := start, PT := T#500ms);
    T2(IN := start, PT := T#300ms);
    onDelayed := T1.Q;
    offDelayed := T2.Q;`);

  // Drive `start` high at t=0, low at t=1.0 s, and watch when each output moves.
  let tOn = null, tOff = null, tOffDrop = null;
  let prevOn = false, prevOff = false;
  for (let k = 0; k < 2000; k++) {
    const t = k * dt;
    plc.vars.set('start', t < 1.0);
    plc.tick(dt);
    const q1 = plc.vars.get('onDelayed'), q2 = plc.vars.get('offDelayed');
    if (q1 && !prevOn && tOn === null) tOn = t;
    if (q2 && !prevOff && tOff === null) tOff = t;
    if (!q2 && prevOff && tOffDrop === null) tOffDrop = t;
    prevOn = q1; prevOff = q2;
  }

  // TON: rises PT after the input rose. TOF: rises with the input, drops PT after it fell.
  close(tOn, 0.5, 2 * dt, 'TON-Anzugsverzögerung ab Signalbeginn');
  close(tOff, 0.0, 2 * dt, 'TOF muss sofort anziehen');
  close(tOffDrop, 1.3, 2 * dt, 'TOF-Abfallverzögerung ab Signalende');

  // ET must be the elapsed time, clamped at PT — it is a readout, not an internal counter.
  const et = new PLC(null);
  et.loadST('VAR T : TON; END_VAR\nT(IN := TRUE, PT := T#100ms);\ne := T.ET;');
  for (let k = 0; k < 50; k++) et.tick(dt);
  close(et.vars.get('e'), 0.05, 2 * dt, 'ET nach 50 ms');
  for (let k = 0; k < 200; k++) et.tick(dt);
  close(et.vars.get('e'), 0.1, 1e-9, 'ET muss bei PT stehen bleiben');

  // A TON whose input drops before PT must never fire and must forget its progress.
  const abort = new PLC(null);
  abort.loadST('VAR T : TON; END_VAR\nT(IN := go, PT := T#100ms);\nq := T.Q;\ne := T.ET;');
  let everFired = false;
  for (let k = 0; k < 300; k++) {
    abort.vars.set('go', (k % 100) < 80); // 80 ms high, 20 ms low — never reaches 100 ms
    abort.tick(dt);
    if (abort.vars.get('q')) everFired = true;
  }
  assert(!everFired, 'TON darf bei unterbrochenem Eingang nie anziehen');

  // PT is read every scan, so a shortened preset takes effect at once.
  const dyn = new PLC(null);
  dyn.loadST('VAR T : TON; END_VAR\nT(IN := TRUE, PT := pt);\nq := T.Q;');
  dyn.vars.set('pt', 1.0);
  for (let k = 0; k < 100; k++) dyn.tick(dt);
  assert(dyn.vars.get('q') === false, 'TON darf bei PT=1s nach 100 ms nicht anziehen');
  dyn.vars.set('pt', 0.05);
  dyn.tick(dt);
  assert(dyn.vars.get('q') === true, 'verkürztes PT muss sofort greifen (ET war bereits 100 ms)');

  return { TON_an: `${(tOn * 1000).toFixed(0)} ms (PT 500)`, TOF_an: `${(tOff * 1000).toFixed(0)} ms`,
           TOF_ab: `${((tOffDrop - 1.0) * 1000).toFixed(0)} ms nach Signalende (PT 300)` };
});

test('CTU/CTD zählen Flanken, nicht Scans', () => {
  const dt = 1e-3;
  const plc = new PLC(null);
  plc.loadST(`VAR C : CTU; END_VAR
    C(CU := pulse, RESET := clear, PV := 3);
    cv := C.CV;
    q := C.Q;`);

  // A level held for 50 scans is ONE edge. A counter that counted scans would read 50.
  plc.vars.set('clear', false);
  plc.vars.set('pulse', true);
  for (let k = 0; k < 50; k++) plc.tick(dt);
  assert(plc.vars.get('cv') === 1, `gehaltener Pegel = 1 Flanke, CV war ${plc.vars.get('cv')}`);

  const pulse = () => { plc.vars.set('pulse', false); plc.tick(dt); plc.vars.set('pulse', true); plc.tick(dt); };
  pulse();
  assert(plc.vars.get('cv') === 2 && plc.vars.get('q') === false, `CV=2, Q noch aus (PV=3), war ${plc.vars.get('cv')}/${plc.vars.get('q')}`);
  pulse();
  assert(plc.vars.get('cv') === 3 && plc.vars.get('q') === true, 'Q muss bei CV = PV kommen');
  pulse();
  assert(plc.vars.get('cv') === 4 && plc.vars.get('q') === true, 'CV zählt über PV hinaus, Q bleibt');

  plc.vars.set('clear', true); plc.tick(dt);
  assert(plc.vars.get('cv') === 0 && plc.vars.get('q') === false, 'RESET muss auf 0 setzen');

  const down = new PLC(null);
  down.loadST('VAR C : CTD; END_VAR\nC(CD := p, LD := ld, PV := 2);\ncv := C.CV;\nq := C.Q;');
  down.vars.set('ld', true); down.tick(dt);
  assert(down.vars.get('cv') === 2, 'LD muss PV laden');
  down.vars.set('ld', false);
  const tick = (p) => { down.vars.set('p', p); down.tick(dt); };
  tick(true); assert(down.vars.get('cv') === 1, 'CD-Flanke muss herunterzählen');
  tick(false); tick(true); assert(down.vars.get('cv') === 0 && down.vars.get('q') === true, 'Q bei CV=0');
  tick(false); tick(true); assert(down.vars.get('cv') === 0, 'CTD darf nicht unter 0 laufen');
  return { gehaltener_pegel: '1 Flanke statt 50 Scans', CTU: 'Q bei CV=PV', CTD: 'stoppt bei 0' };
});

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

test('Ladder: Selbsthaltung mit Öffner-Stopp, gleiche Laufzeit wie ST', () => {
  const io = new IOMap(null);
  io.digitalIn('S1');
  io.digitalIn('S2_nc', { value: true }); // NC stop button: closed when not pressed
  io.digitalOut('K1');

  const plc = new PLC(io);
  // Rung: (S1 OR K1) AND S2 -> K1. The classic latch, and it needs OR-before-AND to work.
  plc.loadLadder([rung('K1', and(or(no('S1'), no('K1')), no('S2_nc')))]);

  plc.tick(1e-3);
  assert(io.get('K1') === false, 'ohne Start darf K1 nicht anziehen');
  io.force('S1', true); plc.tick(1e-3);
  assert(io.get('K1') === true, 'Start muss K1 anziehen');
  io.force('S1', false); plc.tick(1e-3);
  assert(io.get('K1') === true, 'K1 muss sich selbst halten');
  io.force('S2_nc', false); plc.tick(1e-3);
  assert(io.get('K1') === false, 'Stopp muss die Selbsthaltung brechen');
  io.force('S2_nc', true); plc.tick(1e-3);
  assert(io.get('K1') === false, 'nach Stopp darf K1 nicht von selbst wiederkommen');

  // The same circuit in ST must produce the identical sequence — one runtime, two syntaxes.
  const io2 = new IOMap(null);
  io2.digitalIn('S1'); io2.digitalIn('S2_nc', { value: true }); io2.digitalOut('K1');
  const st = new PLC(io2).loadST('K1 := (S1 OR K1) AND S2_nc;');
  const trace = (p, i) => {
    const out = [];
    for (const [s1, s2] of [[false, true], [true, true], [false, true], [false, false], [false, true]]) {
      i.force('S1', s1); i.force('S2_nc', s2); p.tick(1e-3); out.push(i.get('K1'));
    }
    return out.join(',');
  };
  const a = trace(plc, io), b = trace(st, io2);
  assert(a === b, `Ladder und ST müssen identisch laufen: ${a} vs ${b}`);
  return { ladder: a, st: b };
});

// ---------------------------------------------------------------------------
// I/O ports
// ---------------------------------------------------------------------------

test('I/O-Ports: Bindung an sim.signal/sim.energized, Invertierung, Fehlgebrauch', () => {
  const c = EXAMPLES.grafcet.build();
  c.chart = null; // the PLC is the controller here, not the chart
  const io = new IOMap(null);
  const seen = [];

  // Analog ports cannot ride the tag channel: `energized` is a Map of tag -> bool.
  assert(!throwsWith(() => io.analogIn('p', { tag: 'X' }), 'disponível apenas para portas digitais'),
    'analoge Kennzeichen-Bindung muss abgelehnt werden');
  io.digitalIn('a0', { tag: 'a0' });
  assert(!throwsWith(() => io.digitalOut('a0', { tag: 'x' }), 'já está em uso'), 'doppelter Portname muss auffallen');
  assert(!throwsWith(() => io.get('nope'), 'Porta desconhecida'), 'unbekannter Port muss auffallen');
  assert(!throwsWith(() => io.add({ name: 'z', kind: 'blau', dir: 'in' }), 'tipo desconhecido'), 'Art muss geprüft werden');
  assert(!throwsWith(() => io.force('nope', 1), 'Porta desconhecida'), 'force auf unbekannten Port muss auffallen');

  // Now against a live simulation: an input must track the sensor, an output must land in
  // `energized` under its tag and actually move the valve spool.
  let map;
  const { sim } = runHeadless(c, {
    seconds: 0.02,
    script: (s) => {
      if (!map) {
        map = new IOMap(s);
        map.digitalIn('a0', { tag: 'a0' });
        map.digitalIn('a0_nc', { tag: 'a0', invert: true });
        map.analogIn('pA', { read: (x) => x.gauge(byTag(c, '1A1').id, '1') });
        map.digitalOut('A_PLUS', { tag: 'A_PLUS' });
        // Inversion has to work in both directions, not just on inputs: a solenoid wired
        // to drop out on a true output is a real wiring case, and an output invert that
        // silently did nothing would look exactly like a working one from the input side.
        map.digitalOut('B_PLUS_inv', { tag: 'B_PLUS', invert: true });
      }
      map.scan();
      seen.push([map.get('a0'), map.get('a0_nc')]);
      map.set('A_PLUS', true);
      map.flush();
    },
  });

  // The cylinder starts retracted, so a0 must read high — but only from the SECOND scan:
  // at t=0 sim.step() has not run yet and every sensor still holds its initSim default.
  // That is the real power-on scan of a PLC, measured here rather than hidden.
  assert(seen[0][0] === false, 'Einschalt-Scan liest den Sensor-Startwert — vor dem ersten Tick gibt es keine Physik');
  assert(seen[1][0] === true, 'ab dem zweiten Scan muss a0 den eingefahrenen Zylinder melden');
  assert(seen[1][1] === false, 'invertierter Port muss den Pegel umdrehen');
  assert(sim.energized.get('A_PLUS') === true, 'Ausgang muss in sim.energized landen');
  assert(byTag(c, '1V1').sim.state === 1, 'das Magnetventil muss dem Ausgang gefolgt sein');
  // B_PLUS_inv was never written, so it is false — inverted, that must energise B_PLUS and
  // move the second valve. An output invert that did nothing would leave the spool at 0.
  assert(map.get('B_PLUS_inv') === false, 'ungeschriebener Ausgang ist false');
  assert(sim.energized.get('B_PLUS') === true, 'invertierter Ausgang muss den Pegel umdrehen');
  assert(byTag(c, '2V1').sim.state === 1, 'das zweite Ventil muss dem invertierten Ausgang gefolgt sein');
  assert(map.get('pA') > 0.5, `analoger Eingang muss echten Druck lesen, war ${map.get('pA')}`);
  // 20 ms of A_PLUS moved the piston out of a0's ±0.04 window — the input tracks the
  // plant, it does not repeat what it was told once.
  assert(map.get('a0') === false, 'a0 muss abfallen, sobald der Kolben sein Fenster verlässt');
  assert(byTag(c, '1A1').sim.x > 0.04, 'der Kolben muss das a0-Fenster wirklich verlassen haben');

  const frame = map.frame(0.02);
  assert('a0' in frame.in && 'A_PLUS' in frame.out, 'frame() muss nach Richtung trennen');
  return {
    einschaltscan: `a0=${seen[0][0]} (Sensor noch nicht gerechnet)`,
    zweiter_scan: `a0=${seen[1][0]}, invertiert=${seen[1][1]}`,
    nach_20ms_A_PLUS: `x=${byTag(c, '1A1').sim.x.toFixed(3)} → a0=${map.get('a0')}`,
    pA_bar: +map.get('pA').toFixed(2),
    ventil_stellung: byTag(c, '1V1').sim.state,
  };
});

test('Mock-Treiber: ein externer Prozess schreibt Eingänge und liest Ausgänge, deterministisch', () => {
  // No simulation at all: this is the I/O image talking to nothing but the driver, which
  // is exactly the case where the coupling has to stand on its own.
  const build = () => {
    const io = new IOMap(null);
    io.digitalIn('sensor');
    io.digitalIn('inhibit');
    io.analogIn('level');
    io.digitalOut('lamp');
    io.digitalOut('pump');
    io.analogOut('setpoint');

    // The external process: a scripted plant that raises `sensor` for scans 10..29 and
    // fills a tank while the pump runs. Driven off the scan counter, so it cannot drift.
    let tank = 0;
    const driver = new MockDriver({
      script: (scan, port) => {
        port.force('sensor', scan >= 10 && scan < 30);
        port.force('inhibit', scan >= 20 && scan < 25);
        if (port.get('pump')) tank += 1;
        port.force('level', tank);
      },
    });
    io.attach(driver);
    const plc = new PLC(io).loadST(`
      lamp := sensor AND NOT inhibit;
      pump := lamp AND level < 8;
      setpoint := level * 2;`);
    return { io, plc, driver };
  };

  const runIt = () => {
    const { plc, driver } = build();
    for (let k = 0; k < 40; k++) plc.tick(1e-3);
    return driver;
  };

  const d = runIt();
  assert(d.frames.length === 40, `Treiber muss jeden Scan sehen, waren ${d.frames.length}`);

  // The lamp must follow the driver's input with the inhibit window punched out. Scan 10 is
  // the first scan in which the driver forced sensor high, and the logic in that same scan
  // already sees it — force() happens inside scan(), before the program runs.
  const onEdges = d.edges('lamp', true);
  const offEdges = d.edges('lamp', false);
  assert(JSON.stringify(onEdges) === '[10,25]', `Lampe muss bei Scan 10 und 25 kommen, war ${JSON.stringify(onEdges)}`);
  assert(JSON.stringify(offEdges) === '[20,30]', `Lampe muss bei Scan 20 und 30 gehen, war ${JSON.stringify(offEdges)}`);

  // The external process read our output and fed the consequence back in: the pump ran
  // until the tank it filled reached 8. That is a closed loop through the driver.
  const pumpOn = d.outputs('pump').filter(Boolean).length;
  assert(pumpOn === 8, `Pumpe muss genau 8 Scans laufen (Tank 0→8), waren ${pumpOn}`);
  const last = d.frames.at(-1);
  assert(last.out.setpoint === 16, `analoger Ausgang muss 2×Füllstand sein, war ${last.out.setpoint}`);

  // Deterministic: same script, same frames, bit for bit.
  const d2 = runIt();
  assert(JSON.stringify(d.frames) === JSON.stringify(d2.frames), 'zwei Läufe müssen identische Frames liefern');
  return { frames: d.frames.length, lampe_an: onEdges, lampe_aus: offEdges, pumpe_scans: pumpOn };
});

test('WebSocket-Treiber: Frames rein und raus, neuester Wert gewinnt, kaputte Frames kippen den Tick nicht', () => {
  const sent = [];
  // A fake socket rather than a real one: the stub's contract is send()/onmessage/
  // readyState, and testing it against that contract is testing the driver, not the OS.
  const socket = { readyState: 1, send: (s) => sent.push(JSON.parse(s)), close() { this.readyState = 3; } };

  const io = new IOMap(null);
  io.digitalIn('remote_start');
  io.analogIn('remote_level');
  io.digitalOut('motor');
  const drv = io.attach(new WebSocketDriver({ socket }));
  const plc = new PLC(io).loadST('motor := remote_start AND remote_level > 5;');

  plc.tick(1e-3);
  assert(sent.length === 1 && sent[0].out.motor === false, 'jeder Tick muss einen Frame senden');

  socket.onmessage({ data: JSON.stringify({ in: { remote_start: true, remote_level: 9 } }) });
  plc.tick(1e-3);
  assert(io.get('remote_start') === true && sent[1].out.motor === true, 'empfangener Frame muss die Eingänge setzen');

  // No new frame: the driver holds the last one and says so, rather than pretending the
  // inputs went quiet.
  plc.tick(1e-3);
  assert(io.get('remote_start') === true, 'ohne neuen Frame muss der letzte Wert stehen bleiben');
  assert(drv.stale === 1, `veralteter Scan muss gezählt werden, war ${drv.stale}`);

  // Two frames between scans: the newer wins, the older is counted as dropped. A queue
  // would run the control loop on data that is already history.
  socket.onmessage({ data: JSON.stringify({ in: { remote_level: 1 } }) });
  socket.onmessage({ data: JSON.stringify({ in: { remote_level: 7 } }) });
  plc.tick(1e-3);
  assert(io.get('remote_level') === 7, `neuester Frame muss gewinnen, war ${io.get('remote_level')}`);
  assert(drv.dropped === 1, `überholter Frame muss gezählt werden, waren ${drv.dropped}`);

  // Garbage, an unknown name, and an attempt to drive an output from outside must all be
  // survivable: there is nobody to report to inside a tick loop.
  socket.onmessage({ data: 'das ist kein JSON' });
  socket.onmessage({ data: JSON.stringify({ in: { gibtsnicht: true, motor: true, remote_start: false } }) });
  plc.tick(1e-3);
  assert(io.get('remote_start') === false, 'gültige Namen im Frame müssen trotzdem greifen');
  assert(sent.length === 5, 'der Tick muss weitergelaufen sein');

  io.detach();
  assert(socket.readyState === 3, 'detach muss den Socket schließen');
  const before = sent.length;
  new PLC(io).loadST('motor := TRUE;').tick(1e-3);
  assert(sent.length === before, 'ohne Treiber darf nichts gesendet werden');
  return { gesendet: sent.length, veraltet: drv.stale, verworfen: drv.dropped };
});

// ---------------------------------------------------------------------------
// The real thing: a PLC driving pneumatics
// ---------------------------------------------------------------------------

/**
 * Builds the A+ B+ A− B− plant (the GRAFCET example's circuit, chart removed) and puts a
 * PLC in front of it: two 5/2 solenoid/spring valves 'v52_sol_spring' tagged A_PLUS and
 * B_PLUS, four electric limit switches a0/a1/b0/b1, and start button S1. Same plant, a
 * different controller — which is the point of routing everything through `energized`.
 */
function plantWithPLC(program, { press = true } = {}) {
  const c = EXAMPLES.grafcet.build();
  c.chart = null;

  const A = byTag(c, '1A1'), B = byTag(c, '2A1');
  let io = null;
  const plc = new PLC(null);
  plc.loadST(program);

  const events = [];
  let prev = null;
  let scan = 0;
  const { sim, trace } = runHeadless(c, {
    seconds: 6,
    script: (s) => {
      if (!io) {
        io = new IOMap(s);
        for (const tag of ['a0', 'a1', 'b0', 'b1', 'S1']) io.digitalIn(tag, { tag });
        io.digitalOut('A_PLUS', { tag: 'A_PLUS' });
        io.digitalOut('B_PLUS', { tag: 'B_PLUS' });
        plc.io = io;
        if (press) byTag(c, 'S1').sim.pressed = true;
      }
      plc.tick(1e-3);
      // Edges of the plant's own sensors — the physical record of what moved when. A
      // level ("both cylinders out") is reached by the right and the wrong sequence alike;
      // only the order of edges tells them apart.
      //
      // Recording starts at scan 1. At scan 0 sim.step() has not run, so every sensor is
      // still at its initSim default and a0/b0 would appear to "rise" on the first tick —
      // that is the power-on scan settling, not the plant moving. Measured, not assumed:
      // sim.signal('a0') is false at t=0 and true from t=0.001 onward with the cylinder
      // never having left its seat.
      const now = Object.fromEntries(['a0', 'a1', 'b0', 'b1'].map((k) => [k, io.get(k)]));
      if (scan >= 1) {
        if (prev) for (const k of Object.keys(now)) {
          if (now[k] !== prev[k]) events.push(`${k}${now[k] ? '↑' : '↓'}`);
        }
        prev = now;
      }
      scan++;
    },
    probe: (s) => ({ t: +s.time.toFixed(3), xa: A.sim.x, xb: B.sim.x }),
  });
  return { c, sim, trace, events, plc, io: () => io };
}

test('SPS steuert echte Pneumatik: A+ B+ A− B− als Flankenfolge gemessen', () => {
  // A step chain in ST. Sequential IFs are the idiomatic form and they are correct here
  // precisely because ST executes top to bottom in one scan.
  const { events, trace } = plantWithPLC(`VAR S : INT; END_VAR
    IF S = 0 AND S1 AND a0 AND b0 THEN S := 1; END_IF;
    IF S = 1 AND a1 THEN S := 2; END_IF;
    IF S = 2 AND b1 THEN S := 3; END_IF;
    IF S = 3 AND a0 THEN S := 4; END_IF;
    IF S = 4 AND b0 THEN S := 0; END_IF;
    A_PLUS := (S = 1) OR (S = 2);
    B_PLUS := (S = 2) OR (S = 3);`);

  // The full signature of A+ B+ A− B−, in sensor edges. A+ B+ B− A− would read
  // a0↓ a1↑ b0↓ b1↑ b1↓ b0↑ a1↓ a0↑ — a different string, so this test can fail.
  const want = ['a0↓', 'a1↑', 'b0↓', 'b1↑', 'a1↓', 'a0↑', 'b1↓', 'b0↑'];
  const got = events.slice(0, want.length);
  assert(got.join(' ') === want.join(' '),
    `Flankenfolge muss A+ B+ A− B− sein:\n  erwartet ${want.join(' ')}\n  war      ${got.join(' ')}`);

  // Not just the order — the moves must not overlap. A must be fully out before B starts,
  // which is what "sequence" means and what a state-only assert would miss.
  const at = (label) => {
    let i = 0;
    for (const [k, e] of events.entries()) { if (e === label) { i = k; break; } }
    return i;
  };
  assert(at('a1↑') < at('b0↓'), 'B darf erst losfahren, wenn A ausgefahren ist');

  // And the cycle repeats while S1 is held — the chain closed back to step 0.
  assert(events.length >= 16, `Zyklus muss weiterlaufen, waren nur ${events.length} Flanken`);
  assert(events.slice(8, 16).join(' ') === want.join(' '), 'der zweite Zyklus muss derselbe sein');

  // Timing, for the record: when each cylinder reached its end.
  const firstAt = (pred) => trace.find(pred)?.t ?? null;
  return {
    flanken: got.join(' '),
    A_aus_bei: `${firstAt((r) => r.xa > 0.99)} s`,
    B_aus_bei: `${firstAt((r) => r.xb > 0.99)} s`,
    zyklen: Math.floor(events.length / 8),
  };
});

test('SPS-Pneumatik: ohne Startsignal steht die Anlage still', () => {
  // The counterpart the sequence test needs to mean anything: if the plant cycles with the
  // start button unpressed, the test above proves nothing about the PLC.
  const { events, trace } = plantWithPLC(`VAR S : INT; END_VAR
    IF S = 0 AND S1 AND a0 AND b0 THEN S := 1; END_IF;
    IF S = 1 AND a1 THEN S := 2; END_IF;
    A_PLUS := S = 1;
    B_PLUS := S = 2;`, { press: false });
  assert(events.length === 0, `ohne Start darf sich nichts bewegen, waren ${events.join(' ')}`);
  const maxX = Math.max(...trace.map((r) => r.xa));
  assert(maxX < 0.02, `Zylinder A darf nicht anlaufen, Weg war ${maxX}`);
  return { flanken: 0, weg_A: maxX.toExponential(1) };
});

test('SPS-Pneumatik: TON im Ablauf verzögert den Rückzug messbar', () => {
  // The timer against real physics rather than against a bare loop: A extends, waits, and
  // only then returns. The measured dwell must be the preset, not roughly the preset.
  const { trace } = plantWithPLC(`VAR S : INT; T1 : TON; END_VAR
    IF S = 0 AND S1 AND a0 THEN S := 1; END_IF;
    IF S = 1 AND a1 THEN S := 2; END_IF;
    T1(IN := S = 2, PT := T#800ms);
    IF S = 2 AND T1.Q THEN S := 3; END_IF;
    A_PLUS := (S = 1) OR (S = 2);
    B_PLUS := FALSE;`);

  const tOut = trace.find((r) => r.xa > 0.999)?.t;
  const tBack = trace.find((r) => r.t > tOut && r.xa < 0.999)?.t;
  assert(tOut != null && tBack != null, 'A muss aus- und wieder einfahren');
  const dwell = tBack - tOut;
  // The dwell is PT plus the scan the valve needs to drop and the air to start moving the
  // piston; the budget is one scan of I/O delay plus a few ms of exhaust.
  assert(dwell >= 0.8 && dwell <= 0.86, `Haltezeit muss ≈800 ms sein, war ${(dwell * 1000).toFixed(0)} ms`);
  return { A_aus_bei: `${tOut} s`, rueckzug_bei: `${tBack} s`, haltezeit: `${(dwell * 1000).toFixed(0)} ms` };
});
