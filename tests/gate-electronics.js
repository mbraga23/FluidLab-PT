// Correctness gate — continuous electronics (Spec Abschnitt 4 und 14).
//
// Same rule as the rest of the gate: these assert behaviour the solver produces, not
// that the code exists. Where a closed form exists (RC, a resistor's current, a source's
// frequency) the test compares against the closed form and not against a recorded
// number, so a wrong model has nowhere to hide.
//
// Run headless:  node tests/run.js

import { Circuit } from '../src/circuit.js';
import { Simulation, diodeCurrent } from '../src/engine.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const run = (sim, secs, dt = 1e-3) => { for (let i = 0; i < Math.round(secs / dt); i++) sim.step(dt); };
const link = (c, a, pa, b, pb) => assert(c.connect({ inst: a.id, port: pa }, { inst: b.id, port: pb }),
  `Testaufbau: ${a.type}.${pa} → ${b.type}.${pb} nicht verbindbar`);

/** Series chain between the 24 V and 0 V rails — the shape of nearly every test here. */
function ladder(...parts) {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0);
  const zero = c.add('rail_0v', 0, 400);
  let prev = { inst: plus, port: 'a' };
  for (const [inst, pIn, pOut] of parts) {
    link(c, prev.inst, prev.port, inst, pIn);
    prev = { inst, port: pOut };
  }
  link(c, prev.inst, prev.port, zero, 'a');
  return c;
}

// ---------------------------------------------------------------------------
// Reactive elements against the closed form
// ---------------------------------------------------------------------------

test('RC-Ladekurve trifft die analytische Lösung auf 1 %', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const r = c.add('e_resistor', 0, 60), cap = c.add('e_capacitor', 0, 200);
  r.params.r.value = 1000;      // Ω
  cap.params.c.value = 1;       // µF  → τ = 1 ms, a thousand electrical steps long
  link(c, plus, 'a', r, 'a');
  link(c, r, 'b', cap, 'a');
  link(c, cap, 'b', zero, 'a');

  const R = r.params.r.value, C = cap.params.c.value * 1e-6;
  const tau = R * C;

  const sim = new Simulation(c);
  // Sampled per electrical step, not per tick: the whole point of the sub-step is that
  // the curve exists between the ticks.
  const trace = [];
  sim.onElectric = (t, s) => trace.push([t, s.volts(cap.id, 'a') - s.volts(cap.id, 'b')]);
  run(sim, 5 * tau);

  let worst = 0, worstAt = 0;
  for (const [t, v] of trace) {
    if (t < 0.2 * tau) continue;   // the first fraction of τ is all quantisation
    const exact = 24 * (1 - Math.exp(-t / tau));
    const rel = Math.abs(v - exact) / exact;
    if (rel > worst) { worst = rel; worstAt = t; }
  }
  assert(worst < 0.01, `RC-Kurve weicht um ${(worst * 100).toFixed(2)} % ab (bei t=${(worstAt * 1e3).toFixed(2)} ms)`);

  const at = (t) => trace.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a))[1];
  return {
    'τ [ms]': tau * 1e3,
    'u(τ) sim/analytisch': `${at(tau).toFixed(4)} / ${(24 * (1 - Math.exp(-1))).toFixed(4)} V`,
    'u(3τ) sim/analytisch': `${at(3 * tau).toFixed(4)} / ${(24 * (1 - Math.exp(-3))).toFixed(4)} V`,
    'größter relativer Fehler': `${(worst * 100).toFixed(3)} %`,
    'elektrischer Zeitschritt': `${(sim.diagnostics.electricDt * 1e6).toFixed(2)} µs`,
  };
});

test('Spule hält ihren Strom: L/R-Kurve trifft die analytische Lösung auf 1 %', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const r = c.add('e_resistor', 0, 60), l = c.add('e_inductor', 0, 200);
  r.params.r.value = 100;       // Ω
  l.params.l.value = 100;       // mH → τ = L/R = 1 ms
  link(c, plus, 'a', r, 'a');
  link(c, r, 'b', l, 'a');
  link(c, l, 'b', zero, 'a');

  const R = r.params.r.value, L = l.params.l.value * 1e-3;
  const tau = L / R;
  const sim = new Simulation(c);
  const trace = [];
  sim.onElectric = (t) => trace.push([t, l.sim.i]);
  run(sim, 5 * tau);

  let worst = 0;
  for (const [t, i] of trace) {
    if (t < 0.2 * tau) continue;
    const exact = (24 / R) * (1 - Math.exp(-t / tau));
    worst = Math.max(worst, Math.abs(i - exact) / exact);
  }
  assert(worst < 0.01, `L/R-Kurve weicht um ${(worst * 100).toFixed(2)} % ab`);

  const iFinal = trace[trace.length - 1][1];
  return {
    'τ [ms]': tau * 1e3,
    'i(5τ) sim/analytisch': `${(iFinal * 1000).toFixed(3)} / ${(1000 * (24 / R) * (1 - Math.exp(-5))).toFixed(3)} mA`,
    'größter relativer Fehler': `${(worst * 100).toFixed(3)} %`,
  };
});

// ---------------------------------------------------------------------------
// Zeitschritt: die Forderung der Spec, den elektrischen vom Fluid-Takt zu entkoppeln
// ---------------------------------------------------------------------------

test('100-kHz-Rechteckquelle wird ohne Aliasing abgebildet', () => {
  const c = new Circuit();
  const src = c.add('e_ac', 0, 0), r = c.add('e_resistor', 0, 120), zero = c.add('rail_0v', 0, 400);
  src.params.freq.value = 100000;
  src.params.form.value = 'rechteck';
  src.params.amplitude.value = 10;
  r.params.r.value = 1000;
  link(c, src, 'a', r, 'a');
  link(c, r, 'b', zero, 'a');
  link(c, src, 'b', zero, 'a');

  const sim = new Simulation(c);
  const fine = [], perTick = [];
  sim.onElectric = (t, s) => fine.push([t, s.volts(src.id, 'a') - s.volts(src.id, 'b')]);

  const T = 2e-3; // two fluid ticks = 200 periods of the source
  for (let i = 0; i < 2; i++) { sim.step(1e-3); perTick.push(sim.volts(src.id, 'a') - sim.volts(src.id, 'b')); }

  // Nyquist, stated as the test's premise rather than assumed: at least two samples per
  // period, and in practice far more, or none of what follows means anything.
  const period = 1 / src.params.freq.value;
  assert(sim.diagnostics.electricDt <= period / 10,
    `Zeitschritt ${sim.diagnostics.electricDt} s ist zu grob für eine Periode von ${period} s`);

  // Frequency read back out of the trace, from the spacing of the rising edges.
  const rising = [];
  for (let i = 1; i < fine.length; i++) if (fine[i - 1][1] < 0 && fine[i][1] > 0) rising.push(fine[i][0]);
  assert(rising.length > 100, `nur ${rising.length} steigende Flanken in 2 ms — die Quelle steht`);
  const fMeasured = (rising.length - 1) / (rising[rising.length - 1] - rising[0]);
  const err = Math.abs(fMeasured - 100000) / 100000;
  assert(err < 0.01, `gemessene Frequenz ${(fMeasured / 1000).toFixed(2)} kHz weicht um ${(err * 100).toFixed(2)} % ab`);

  // A square wave is its two levels and nothing between them: any intermediate level in
  // the trace would be the source being averaged, which is what aliasing looks like.
  for (const [, v] of fine) {
    assert(Math.abs(Math.abs(v) - 10) < 1e-9, `Zwischenpegel ${v.toFixed(4)} V — die Quelle wird verschliffen`);
  }

  // And the counter-proof for why the sub-step has to exist: on the tick boundary the
  // very same signal is a DC level. That is the aliasing the spec forbids.
  assert(perTick.every((v) => Math.abs(v - perTick[0]) < 1e-9),
    'Tick-Abtastung müsste hier konstant sein — sonst prüft dieser Test nicht, was er soll');

  return {
    'elektrischer Zeitschritt': `${(sim.diagnostics.electricDt * 1e9).toFixed(0)} ns`,
    'Schritte je 1-ms-Tick': sim.diagnostics.electricSteps,
    'Abtastungen je Periode': +(period / sim.diagnostics.electricDt).toFixed(1),
    'gemessene Frequenz': `${(fMeasured / 1000).toFixed(3)} kHz`,
    'nur auf Tickgrenze abgetastet': `konstant ${perTick[0].toFixed(1)} V — genau das Aliasing`,
  };
});

// ---------------------------------------------------------------------------
// Nichtlineare Bauteile
// ---------------------------------------------------------------------------

test('Diode leitet vorwärts und sperrt rückwärts', () => {
  const measure = (forward) => {
    const c = new Circuit();
    const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
    const r = c.add('e_resistor', 0, 60), d = c.add('e_diode', 0, 200);
    r.params.r.value = 1000;
    link(c, plus, 'a', r, 'a');
    link(c, r, 'b', d, forward ? 'a' : 'k');
    link(c, d, forward ? 'k' : 'a', zero, 'a');
    const sim = new Simulation(c);
    run(sim, 0.02);
    assert(sim.diagnostics.converged, 'Diodenschaltung konvergiert nicht');
    // Current read off the resistor, independent of what the diode claims about itself.
    const iR = (sim.volts(r.id, 'a') - sim.volts(r.id, 'b')) / r.params.r.value;
    return { vd: d.sim.vd, iDevice: d.sim.i, iR: forward ? iR : -iR };
  };

  const f = measure(true), b = measure(false);

  assert(f.vd > 0.5 && f.vd < 1.2, `Flussspannung ${f.vd.toFixed(3)} V ist für eine Si-Diode unplausibel`);
  // The resistor drops essentially the whole rail: that is what "leitet" means here.
  const expected = (24 - f.vd) / 1000;
  assert(Math.abs(f.iR - expected) / expected < 0.01, `Vorwärtsstrom ${f.iR} passt nicht zu (24−U_F)/R`);
  assert(Math.abs(f.iDevice - f.iR) / f.iR < 0.01,
    `Bauteil meldet ${f.iDevice} A, der Widerstand führt ${f.iR} A — das Modell ist mit sich uneins`);

  assert(Math.abs(b.iR) < 1e-6, `Sperrstrom ${b.iR} A ist kein Sperren`);
  assert(b.vd < -20, `Rückwärts müsste fast die ganze Spannung an der Diode stehen, waren ${b.vd.toFixed(2)} V`);
  // Four orders of magnitude between the directions is the whole point of a diode.
  assert(Math.abs(f.iR / b.iR) > 1e4, `Verhältnis Fluss/Sperr nur ${Math.abs(f.iR / b.iR).toExponential(1)}`);

  return {
    'vorwärts': `U_F=${f.vd.toFixed(3)} V, I=${(f.iR * 1000).toFixed(3)} mA`,
    'rückwärts': `U_R=${b.vd.toFixed(2)} V, I=${b.iR.toExponential(2)} A`,
    'Fluss/Sperr': Math.abs(f.iR / b.iR).toExponential(2),
  };
});

test('Z-Diode begrenzt in Sperrrichtung auf ihre Z-Spannung', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const r = c.add('e_resistor', 0, 60), z = c.add('e_zener', 0, 200);
  r.params.r.value = 1000;
  z.params.vz.value = 5.1;
  link(c, plus, 'a', r, 'a');
  link(c, r, 'b', z, 'k');     // cathode up: the Zener works in reverse
  link(c, z, 'a', zero, 'a');
  const sim = new Simulation(c);
  run(sim, 0.02);

  const u = sim.volts(z.id, 'k') - sim.volts(z.id, 'a');
  assert(Math.abs(u - 5.1) < 0.3, `Z-Diode klemmt bei ${u.toFixed(3)} V statt bei 5,1 V`);

  // Regulation: the whole reason to fit one. Halving the series resistor doubles the
  // current, and the voltage must barely move.
  r.params.r.value = 470;
  run(sim, 0.02);
  const u2 = sim.volts(z.id, 'k') - sim.volts(z.id, 'a');
  assert(Math.abs(u2 - u) < 0.1, `Z-Spannung wandert um ${Math.abs(u2 - u).toFixed(3)} V, wenn sich der Strom verdoppelt`);

  return {
    'U_Z bei 1 kΩ': `${u.toFixed(4)} V`,
    'U_Z bei 470 Ω': `${u2.toFixed(4)} V`,
    'Änderung': `${(1000 * Math.abs(u2 - u)).toFixed(1)} mV bei doppeltem Strom`,
  };
});

test('LED leuchtet erst über ihrer Flussspannung', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const pot = c.add('e_pot', 200, 60), r = c.add('e_resistor', 0, 60), led = c.add('e_led', 0, 200);
  r.params.r.value = 1000;
  pot.params.r.value = 1000;
  link(c, plus, 'a', pot, 'a');
  link(c, pot, 'b', zero, 'a');
  link(c, pot, 'w', r, 'a');
  link(c, r, 'b', led, 'a');
  link(c, led, 'k', zero, 'a');

  const sim = new Simulation(c);
  const at = (x) => { pot.params.pos.value = x; run(sim, 0.02); return { i: led.sim.i, vf: led.sim.vd }; };

  const dark = at(0.05);   // wiper near 0 V → well under the forward voltage
  const lit = at(1.0);     // wiper at the rail

  assert(dark.i < 1e-4, `LED zieht bei ${dark.vf.toFixed(2)} V schon ${dark.i.toExponential(2)} A`);
  assert(lit.i > 5e-3, `LED zieht bei voller Spannung nur ${lit.i.toExponential(2)} A`);
  assert(lit.vf > 1.8 && lit.vf < 2.6, `Flussspannung ${lit.vf.toFixed(3)} V ist für eine LED unplausibel`);
  // The exponential is the model: two decades of current cost a few hundred millivolts.
  assert(lit.i / Math.max(dark.i, 1e-30) > 1e3, 'die Kennlinie ist nicht exponentiell');

  return {
    'Poti 5 %': `U_F=${dark.vf.toFixed(3)} V, I=${dark.i.toExponential(2)} A — dunkel`,
    'Poti 100 %': `U_F=${lit.vf.toFixed(3)} V, I=${(lit.i * 1000).toFixed(2)} mA — hell`,
  };
});

test('Transistor arbeitet als Schalter: gesperrt und übersteuert', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const rc = c.add('e_resistor', 0, 60), rb = c.add('e_resistor', 200, 120), t = c.add('e_npn', 0, 200);
  const btn = c.add('btn_no', 200, 0);
  rc.params.r.value = 1000;
  rb.params.r.value = 10000;
  link(c, plus, 'a', rc, 'a');
  link(c, rc, 'b', t, 'C');
  link(c, t, 'E', zero, 'a');
  // The base is driven through a plain ladder pushbutton — the electronics and the
  // relay world share one net graph, and this is the test that they do.
  link(c, plus, 'a', btn, 'a');
  link(c, btn, 'b', rb, 'a');
  link(c, rb, 'b', t, 'B');

  const sim = new Simulation(c);
  run(sim, 0.02);
  const vceOff = sim.volts(t.id, 'C') - sim.volts(t.id, 'E');
  const icOff = (24 - sim.volts(t.id, 'C')) / rc.params.r.value;

  btn.sim.pressed = true;
  run(sim, 0.02);
  const vceOn = sim.volts(t.id, 'C') - sim.volts(t.id, 'E');
  const icOn = (24 - sim.volts(t.id, 'C')) / rc.params.r.value;
  const ib = (sim.volts(rb.id, 'a') - sim.volts(rb.id, 'b')) / rb.params.r.value;

  assert(sim.diagnostics.converged, 'Transistorschaltung konvergiert nicht');
  assert(vceOff > 23.9, `gesperrt müsste U_CE ≈ 24 V sein, war ${vceOff.toFixed(3)} V`);
  assert(icOff < 1e-5, `Reststrom ${icOff.toExponential(2)} A im gesperrten Zustand`);
  assert(vceOn < 0.3, `durchgeschaltet müsste U_CE < 0,3 V sein (Sättigung), war ${vceOn.toFixed(3)} V`);
  assert(icOn > 0.02, `Kollektorstrom ${(icOn * 1000).toFixed(2)} mA — der Transistor schaltet nicht durch`);
  // Saturation is not "gain × base current": the collector resistor sets the current, and
  // the transistor is driven far past what β would give. That is what a switch is.
  assert(icOn / ib < 30, `β_eff = ${(icOn / ib).toFixed(1)} — der Transistor ist nicht übersteuert, sondern im aktiven Bereich`);
  assert(vceOn < 0.7, 'U_CE unter U_BE ist die Bedingung für Sättigung');

  return {
    'Taster offen': `U_CE=${vceOff.toFixed(3)} V, I_C=${icOff.toExponential(2)} A`,
    'Taster gedrückt': `U_CE=${vceOn.toFixed(4)} V, I_C=${(icOn * 1000).toFixed(2)} mA`,
    'I_B': `${(ib * 1000).toFixed(3)} mA`,
    'Übersteuerung': `β_eff=${(icOn / ib).toFixed(1)} statt β=200`,
  };
});

test('Ebers-Moll: gesättigter Transistor zeigt eine lastunabhängige Offsetspannung', () => {
  // What separates Ebers–Moll from "a current source with gain" is the reverse-injected
  // current, and saturation is where it shows. With the collector load tied to *ground*
  // instead of the supply, a saturated transistor sits at its offset voltage: the base
  // drive forward-biases the base-collector junction and pushes a trickle out of the
  // collector. The offset is a junction ratio, so it barely moves with the load — that
  // load-independence is the assertion, and it needs no knowledge of the model constants.
  const offsetWith = (rc) => {
    const c = new Circuit();
    const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
    const rl = c.add('e_resistor', 0, 300), rb = c.add('e_resistor', 200, 60), t = c.add('e_npn', 0, 160);
    rl.params.r.value = rc;
    rb.params.r.value = 10000;
    link(c, t, 'C', rl, 'a');
    link(c, rl, 'b', zero, 'a');   // no supply on the collector at all
    link(c, t, 'E', zero, 'a');
    link(c, plus, 'a', rb, 'a');
    link(c, rb, 'b', t, 'B');
    const sim = new Simulation(c);
    run(sim, 0.02);
    assert(sim.diagnostics.converged, `konvergiert nicht bei R_C=${rc} Ω`);
    return sim.volts(t.id, 'C') - sim.volts(t.id, 'E');
  };

  const a = offsetWith(1000), b = offsetWith(10000);
  assert(a > 0.002 && a < 0.04, `Offsetspannung ${(a * 1000).toFixed(2)} mV liegt außerhalb des Bereichs eines Si-Transistors`);
  const spread = Math.abs(b - a) / a;
  assert(spread < 0.02, `Offsetspannung wandert um ${(spread * 100).toFixed(1)} %, wenn die Last 10× größer wird — dann ist es keine Offsetspannung, sondern ein Strom`);

  return {
    'U_CE0 bei R_C=1 kΩ': `${(a * 1000).toFixed(3)} mV`,
    'U_CE0 bei R_C=10 kΩ': `${(b * 1000).toFixed(3)} mV`,
    'Lastabhängigkeit': `${(spread * 100).toFixed(2)} % bei 10× Last`,
  };
});

test('PNP schaltet gegen die Versorgung, NPN gegen Masse', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const rc = c.add('e_resistor', 0, 300), rb = c.add('e_resistor', 200, 120), t = c.add('e_pnp', 0, 140);
  const btn = c.add('btn_no', 200, 300);
  rc.params.r.value = 1000;
  rb.params.r.value = 10000;
  link(c, plus, 'a', t, 'E');
  link(c, t, 'C', rc, 'a');
  link(c, rc, 'b', zero, 'a');
  link(c, t, 'B', rb, 'a');
  link(c, rb, 'b', btn, 'a');
  link(c, btn, 'b', zero, 'a');    // pulling the base *down* is what turns a PNP on

  const sim = new Simulation(c);
  run(sim, 0.02);
  const off = sim.volts(t.id, 'C');
  btn.sim.pressed = true;
  run(sim, 0.02);
  const on = sim.volts(t.id, 'C');

  assert(off < 0.01, `PNP mit offener Basis müsste sperren, Last lag auf ${off.toFixed(3)} V`);
  assert(on > 23.5, `PNP mit heruntergezogener Basis müsste durchschalten, Last lag auf ${on.toFixed(3)} V`);
  return { 'Basis offen': `${off.toExponential(2)} V`, 'Basis auf 0 V': `${on.toFixed(3)} V` };
});

test('MOSFET sperrt unter der Schwellspannung und schaltet darüber durch', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const rd = c.add('e_resistor', 0, 60), m = c.add('e_nmos', 0, 200), pot = c.add('e_pot', 200, 60);
  rd.params.r.value = 100;
  pot.params.r.value = 1000;
  m.params.vth.value = 2;
  link(c, plus, 'a', rd, 'a');
  link(c, rd, 'b', m, 'D');
  link(c, m, 'S', zero, 'a');
  link(c, plus, 'a', pot, 'a');
  link(c, pot, 'b', zero, 'a');
  link(c, pot, 'w', m, 'G');

  const sim = new Simulation(c);
  const at = (x) => {
    pot.params.pos.value = x; run(sim, 0.02);
    return { vgs: sim.volts(m.id, 'G'), vds: sim.volts(m.id, 'D') };
  };

  const below = at(0.05);   // ≈ 1,2 V, under Vth
  const above = at(0.5);    // 12 V, well over

  assert(below.vgs < m.params.vth.value, `Testaufbau: U_GS=${below.vgs} liegt nicht unter der Schwelle`);
  assert(below.vds > 23.9, `unter der Schwelle müsste der MOSFET sperren, U_DS war ${below.vds.toFixed(3)} V`);
  assert(above.vds < 0.2, `bei U_GS=${above.vgs} V müsste er durchschalten, U_DS war ${above.vds.toFixed(3)} V`);

  // Durchgeschaltet heißt Trioden-Bereich, und dort ist der MOSFET ein *Widerstand*:
  // R_DS(on) ≈ 1/(K·U_ov). Das Verhältnis zweier Ansteuerungen kürzt K heraus und prüft
  // damit das quadratische Gesetz selbst, ohne eine Modellkonstante zu kennen.
  const rdsAt = (x) => { const s = at(x); return { rds: s.vds / ((24 - s.vds) / rd.params.r.value), vgs: s.vgs }; };
  const lo = rdsAt(0.25), hi = rdsAt(0.5);
  assert(lo.rds > 0 && hi.rds > 0, `R_DS(on) muss positiv sein, waren ${lo.rds.toFixed(2)} / ${hi.rds.toFixed(2)} Ω`);
  const vth = m.params.vth.value;
  const predicted = (hi.vgs - vth) / (lo.vgs - vth);
  const measured = lo.rds / hi.rds;
  assert(Math.abs(measured - predicted) / predicted < 0.05,
    `R_DS(on)-Verhältnis ${measured.toFixed(3)} statt ${predicted.toFixed(3)} — der Trioden-Ast folgt nicht dem quadratischen Gesetz`);

  // Und der Sättigungs-Ast, an genau der Kennlinie gemessen, mit der man einen echten
  // MOSFET vermisst: I_D ∝ U_ov² heißt, √I_D läuft linear über U_GS und trifft die
  // U_GS-Achse bei der Schwellspannung. Die Extrapolation kennt weder K noch λ — sie
  // liest die deklarierte Schwelle aus dem Verhalten zurück.
  const pts = [];
  for (const vg of [2.3, 2.4, 2.5, 2.6, 2.7]) {
    pot.params.pos.value = vg / 24;
    run(sim, 0.02);
    const vds = sim.volts(m.id, 'D');
    const vgs = sim.volts(m.id, 'G');
    assert(vds > vgs - vth, `Testaufbau: bei U_GS=${vgs.toFixed(2)} ist der MOSFET nicht im Sättigungsbereich`);
    pts.push({ vgs, sq: Math.sqrt((24 - vds) / rd.params.r.value) });
  }
  const n = pts.length;
  const sx = pts.reduce((a, p) => a + p.vgs, 0), sy = pts.reduce((a, p) => a + p.sq, 0);
  const sxx = pts.reduce((a, p) => a + p.vgs * p.vgs, 0), sxy = pts.reduce((a, p) => a + p.vgs * p.sq, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const vthFit = -((sy - slope * sx) / n) / slope;
  // λ (Kanallängenmodulation) verbiegt die Wurzelgerade leicht — daher 0,12 V und nicht 0.
  assert(Math.abs(vthFit - vth) < 0.12,
    `√I_D-Extrapolation liefert U_th=${vthFit.toFixed(3)} V statt der deklarierten ${vth} V — der Sättigungsast ist nicht quadratisch`);

  return {
    'U_GS=1,2 V': `U_DS=${below.vds.toFixed(3)} V — gesperrt`,
    'U_GS=12 V': `U_DS=${above.vds.toFixed(4)} V — durchgeschaltet`,
    'R_DS(on) bei U_GS=6/12 V': `${lo.rds.toFixed(4)} / ${hi.rds.toFixed(4)} Ω`,
    'Trioden-Verhältnis gemessen/Gesetz': `${measured.toFixed(3)} / ${predicted.toFixed(3)}`,
    'U_th aus √I_D-Extrapolation': `${vthFit.toFixed(3)} V (deklariert ${vth})`,
  };
});

// ---------------------------------------------------------------------------
// Op-Amp und Trafo
// ---------------------------------------------------------------------------

test('Op-Amp folgt als Spannungsfolger und begrenzt an der Aussteuergrenze', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const pot = c.add('e_pot', 200, 60), oa = c.add('e_opamp', 0, 200);
  pot.params.r.value = 1000;
  link(c, plus, 'a', pot, 'a');
  link(c, pot, 'b', zero, 'a');
  link(c, pot, 'w', oa, 'p');
  link(c, oa, 'out', oa, 'n');   // 100 % negative feedback

  const sim = new Simulation(c);
  const follow = (x) => {
    pot.params.pos.value = x; run(sim, 0.005);
    return { in: sim.volts(oa.id, 'p'), out: sim.volts(oa.id, 'out') };
  };

  let worst = 0;
  for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const m = follow(x);
    worst = Math.max(worst, Math.abs(m.out - m.in));
    assert(sim.diagnostics.converged, `Folger konvergiert bei Poti ${x} nicht`);
  }
  // Follower error is the finite gain and nothing else: v_out = v_in·A/(1+A).
  const bound = 24 / oa.params.gain.value;
  assert(worst < 10 * bound, `Folgefehler ${worst.toExponential(2)} V passt nicht zu A=${oa.params.gain.value}`);

  // Ask for more than the rails allow and the output must stop at the rail, not go past.
  oa.params.vpos.value = 10;
  const sat = follow(0.9);
  assert(Math.abs(sat.out - 10) < 1e-3, `Ausgang müsste an der Grenze 10 V stehen, war ${sat.out.toFixed(4)} V`);
  assert(oa.sim.sat === 1, 'Sättigung wird nicht als solche gemeldet');

  return {
    'größter Folgefehler': `${worst.toExponential(2)} V (Schranke 24/A = ${bound.toExponential(2)} V)`,
    'Begrenzung': `${sat.in.toFixed(2)} V angefordert → ${sat.out.toFixed(4)} V am Ausgang`,
  };
});

test('Trafo überträgt Wechselspannung im Übersetzungsverhältnis und sperrt Gleichspannung', () => {
  const build = (srcType) => {
    const c = new Circuit();
    const zero = c.add('rail_0v', 0, 400);
    const tr = c.add('e_transformer', 100, 0), rl = c.add('e_resistor', 250, 0);
    tr.params.ratio.value = 2;
    tr.params.lm.value = 1;
    rl.params.r.value = 1000;
    const src = srcType === 'ac' ? c.add('e_ac', 0, 0) : c.add('rail_24v', 0, 0);
    if (srcType === 'ac') {
      src.params.freq.value = 50; src.params.amplitude.value = 24;
      link(c, src, 'a', tr, 'p1');
      link(c, src, 'b', tr, 'p2');
    } else {
      link(c, src, 'a', tr, 'p1');
    }
    link(c, tr, 'p2', zero, 'a');
    link(c, tr, 's1', rl, 'a');
    link(c, rl, 'b', tr, 's2');
    link(c, tr, 's2', zero, 'a');
    return { c, tr, rl };
  };

  // AC: measure the secondary peak over a whole late period, after the magnetising
  // transient (L/R ≈ 0,5 s) has died away.
  const a = build('ac');
  const simA = new Simulation(a.c);
  run(simA, 2.0);
  let peak = 0;
  simA.onElectric = (t, s) => { peak = Math.max(peak, Math.abs(s.volts(a.tr.id, 's1') - s.volts(a.tr.id, 's2'))); };
  run(simA, 0.02);   // exactly one 50 Hz period
  assert(simA.diagnostics.converged, 'Trafo konvergiert nicht');
  const expect = 24 / a.tr.params.ratio.value;
  assert(Math.abs(peak - expect) / expect < 0.05,
    `Sekundärspitze ${peak.toFixed(3)} V statt ${expect} V (ü=2)`);

  // DC: an *ideal* transformer would happily pass a battery. The magnetising inductance
  // is what stops it, and this is the assertion that the model has one.
  const d = build('dc');
  const simD = new Simulation(d.c);
  run(simD, 0.01);
  const early = Math.abs(simD.volts(d.tr.id, 's1') - simD.volts(d.tr.id, 's2'));
  run(simD, 3.0);
  const late = Math.abs(simD.volts(d.tr.id, 's1') - simD.volts(d.tr.id, 's2'));
  assert(late < 0.5, `Gleichspannung steht nach 3 s noch mit ${late.toFixed(3)} V auf der Sekundärseite`);
  assert(late < early / 10, 'die Sekundärspannung klingt bei Gleichspannung nicht ab');

  return {
    'AC 50 Hz, ü=2': `24 V primär → ${peak.toFixed(3)} V sekundär (erwartet ${expect})`,
    'DC nach 10 ms': `${early.toFixed(3)} V`,
    'DC nach 3 s': `${late.toFixed(4)} V — durch die Hauptinduktivität kurzgeschlossen`,
  };
});

// ---------------------------------------------------------------------------
// Kopplung und Meldung
// ---------------------------------------------------------------------------

test('Elektronik und Relaislogik teilen einen Netzgraph: Kontakt schaltet einen RC-Kreis', () => {
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const btn = c.add('btn_no', 0, 40), coil = c.add('relay_coil', 0, 120);
  const contact = c.add('contact_no', 200, 40), r = c.add('e_resistor', 200, 120), cap = c.add('e_capacitor', 200, 220);
  contact.params.tag.value = coil.params.tag.value;
  r.params.r.value = 1000;
  cap.params.c.value = 1;
  link(c, plus, 'a', btn, 'a');
  link(c, btn, 'b', coil, 'a');
  link(c, coil, 'b', zero, 'a');
  link(c, plus, 'a', contact, 'a');
  link(c, contact, 'b', r, 'a');
  link(c, r, 'b', cap, 'a');
  link(c, cap, 'b', zero, 'a');

  const sim = new Simulation(c);
  run(sim, 0.02);
  assert(cap.sim.v < 0.1, `Kondensator lädt sich bei offenem Kontakt auf ${cap.sim.v.toFixed(3)} V`);

  btn.sim.pressed = true;
  run(sim, 0.02);   // 20 τ
  assert(coil.sim.on, 'Relais zieht nicht an');
  assert(cap.sim.v > 23, `Kondensator lädt über den geschlossenen Kontakt nur auf ${cap.sim.v.toFixed(3)} V`);

  btn.sim.pressed = false;
  run(sim, 0.02);
  // The contact opens, and the capacitor is left holding its charge — there is no path
  // back except the leak the solver puts on every node.
  assert(cap.sim.v > 23, `Kondensator verliert seine Ladung am offenen Kontakt (${cap.sim.v.toFixed(3)} V)`);

  return {
    'Kontakt offen': `${(0).toFixed(0)} V`,
    'Kontakt zu, nach 20 τ': `${cap.sim.v.toFixed(3)} V`,
    'Relais': coil.sim.on === false ? 'wieder abgefallen' : 'angezogen',
  };
});

test('Nichtkonvergenz wird gemeldet, nicht verschluckt', () => {
  // A diode snapping on from a cold start is the hardest thing this solver does: the
  // first electrical step needs a measured 7 Newton iterations, every later one needs 1.
  // Cutting the budget below that demand makes a genuine failure, and the only thing
  // being asserted is that the engine says so instead of handing back a number.
  const build = () => {
    const c = new Circuit();
    const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
    const r = c.add('e_resistor', 0, 60), d = c.add('e_diode', 0, 200);
    r.params.r.value = 1000;
    link(c, plus, 'a', r, 'a');
    link(c, r, 'b', d, 'a');
    link(c, d, 'k', zero, 'a');
    return c;
  };

  const ok = new Simulation(build());
  ok.step(1e-3);
  const needed = ok.diagnostics.electricIterations;
  assert(ok.diagnostics.converged, 'mit vollem Budget muss diese Schaltung konvergieren');
  assert(ok.diagnostics.failures === 0, 'saubere Schaltung meldet trotzdem Fehler');
  assert(needed > 1, 'wenn die Schaltung in einem Schritt löst, prüft dieser Test nichts');

  const starved = new Simulation(build());
  starved.newtonLimit = needed - 1;
  starved.step(1e-3);
  assert(!starved.diagnostics.converged,
    `Budget ${needed - 1} unter dem gemessenen Bedarf ${needed}, trotzdem meldet die Engine Konvergenz`);
  assert(starved.diagnostics.failures > 0, 'Nichtkonvergenz erhöht den Fehlerzähler nicht');
  assert(starved.diagnostics.electricDelta > 1e-6,
    'gemeldetes Δ passt nicht zur gemeldeten Nichtkonvergenz');
  // The report has to survive to where anyone would look for it.
  assert(starved.snapshot().diagnostics.converged === false, 'der Snapshot verschweigt die Nichtkonvergenz');

  return {
    'benötigte Newton-Iterationen (kalter Start)': needed,
    'mit vollem Budget': `konvergiert, Δ=${ok.diagnostics.electricDelta.toExponential(2)} V`,
    [`mit Budget ${needed - 1}`]:
      `gemeldet: ${starved.diagnostics.failures} Fehlschläge, Δ=${starved.diagnostics.electricDelta.toExponential(2)} V`,
  };
});

test('Kondensator, Diode und Spule sind ohne kontinuierliche Bauteile nicht im Weg', () => {
  // The MNA branch is opt-in. A sheet without continuous parts must take the resistive
  // path — this asserts the switch, because 46 existing tests depend on that path.
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const lamp = c.add('lamp', 0, 200);
  link(c, plus, 'a', lamp, 'a');
  link(c, lamp, 'b', zero, 'a');
  const ladderSim = new Simulation(c);
  ladderSim.step(1e-3);
  assert(ladderSim.continuous.length === 0, 'Ladder-Blatt darf keine kontinuierlichen Bauteile führen');
  assert(ladderSim.diagnostics.electricSteps === 0, 'Ladder-Blatt darf den MNA-Zweig nicht anfassen');
  assert(lamp.sim.on, 'Leuchte an 24 V leuchtet nicht');

  // Add one capacitor and the same sheet switches over.
  const cap = c.add('e_capacitor', 200, 200);
  link(c, plus, 'a', cap, 'a');
  link(c, cap, 'b', zero, 'a');
  const mnaSim = new Simulation(c);
  mnaSim.step(1e-3);
  assert(mnaSim.continuous.length === 1, 'Kondensator schaltet den MNA-Zweig nicht frei');
  assert(mnaSim.diagnostics.electricSteps > 1, 'MNA-Zweig unterteilt den Tick nicht');
  assert(lamp.sim.on, 'Leuchte muss im MNA-Zweig genauso leuchten');

  return {
    'ohne Elektronik': `${ladderSim.diagnostics.electricSteps} elektrische Schritte — resistiver Solver`,
    'mit Kondensator': `${mnaSim.diagnostics.electricSteps} Schritte à ${(mnaSim.diagnostics.electricDt * 1e6).toFixed(0)} µs`,
  };
});

test('Bauteil-Selbstauskunft deckt sich mit dem Strom, den die Schaltung wirklich führt', () => {
  // The Shockley equation exists twice: once in `diodeCurrent` (read-out — it feeds
  // inst.sim.i and thus the inspector) and once in `Stamper.diode` (the solve, which also
  // needs the derivative). Two copies can drift apart silently, and the other diode tests
  // cannot catch it: they assert on the current through the series resistor — the
  // circuit-level observable, which is the right thing to assert — leaving the read-out
  // path unmeasured. Verified by mutation: making `diodeCurrent` conduct symmetrically
  // left every other test green.
  //
  // A diode in series with a resistor carries exactly one current. If the device's own
  // report disagrees with it, the two copies have drifted.
  const c = new Circuit();
  const plus = c.add('rail_24v', 0, 0), zero = c.add('rail_0v', 0, 400);
  const r = c.add('e_resistor', 0, 60), d = c.add('e_diode', 0, 200);
  r.params.r.value = 1000;
  link(c, plus, 'a', r, 'a');
  link(c, r, 'b', d, 'a');
  link(c, d, 'k', zero, 'a');

  const sim = new Simulation(c);
  run(sim, 0.02);
  assert(sim.diagnostics.converged, 'Schaltung konvergiert nicht');

  const iR = (sim.volts(r.id, 'a') - sim.volts(r.id, 'b')) / r.params.r.value;
  assert(iR > 1e-3, `Testaufbau: es muss Strom fließen, waren ${iR} A`);
  const rel = Math.abs(d.sim.i - iR) / iR;
  assert(rel < 0.02,
    `Selbstauskunft ${(d.sim.i * 1000).toFixed(3)} mA weicht vom Schaltungsstrom `
    + `${(iR * 1000).toFixed(3)} mA um ${(rel * 100).toFixed(1)} % ab — die beiden Kopien `
    + 'der Shockley-Gleichung sind auseinandergelaufen');

  // Blocking direction: the read-out must not claim conduction either.
  const c2 = new Circuit();
  const p2 = c2.add('rail_24v', 0, 0), z2 = c2.add('rail_0v', 0, 400);
  const r2 = c2.add('e_resistor', 0, 60), d2 = c2.add('e_diode', 0, 200);
  r2.params.r.value = 1000;
  link(c2, p2, 'a', r2, 'a');
  link(c2, r2, 'b', d2, 'k');
  link(c2, d2, 'a', z2, 'a');
  const sim2 = new Simulation(c2);
  run(sim2, 0.02);
  assert(Math.abs(d2.sim.i) < 1e-5,
    `In Sperrrichtung darf die Selbstauskunft keinen Strom melden, waren ${d2.sim.i} A`);

  return {
    fluss: `Bauteil ${(d.sim.i * 1000).toFixed(3)} mA vs Schaltung ${(iR * 1000).toFixed(3)} mA`,
    abweichung: `${(rel * 100).toFixed(2)} %`,
    sperr: `${d2.sim.i.toExponential(1)} A`,
  };
});
