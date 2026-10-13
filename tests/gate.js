// Correctness gate.
//
// These assert *behaviour that emerges from the physics*, not that code was written.
// Each one is written to be able to fail: thresholds come from what the model should
// produce if it is right, and several of them did fail on the first run.
//
// Run headless:  node tests/run.js

import { Circuit, EXAMPLES } from '../src/circuit.js';
import {
  Simulation, runHeadless, flowFactor, massFlow, P_ATM, toAbs, barG, RHO_0, B_CRIT,
} from '../src/engine.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- helpers ---------------------------------------------------------------

const run = (sim, secs, dt = 1e-3) => { for (let i = 0; i < Math.round(secs / dt); i++) sim.step(dt); };
const tap = (sim, inst, ms = 80) => { inst.sim.pressed = true; run(sim, ms / 1000); inst.sim.pressed = false; };
const byType = (c, t) => c.instances.filter((i) => i.type === t);
const first = (c, t) => byType(c, t)[0];
const byTag = (c, tag) => c.instances.find((i) => i.params?.tag?.value === tag);

/** Time until a predicate holds, or null if it never does. */
function timeUntil(sim, pred, limit = 15) {
  let t = 0;
  while (t < limit) { sim.step(1e-3); t += 1e-3; if (pred(sim)) return +t.toFixed(3); }
  return null;
}

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const close = (a, b, tol, msg) =>
  assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (Toleranz ${tol})`);

// ---------------------------------------------------------------------------
// Flow model itself
// ---------------------------------------------------------------------------

test('ISO 6358: choked below the critical ratio, elliptic above, zero at equilibrium', () => {
  assert(flowFactor(0.2, 0.4) === 1, 'r < b muss verblockt sein (Faktor 1)');
  assert(flowFactor(0.4, 0.4) === 1, 'r = b ist der Grenzfall der Verblockung');
  assert(flowFactor(1.0, 0.4) === 0, 'kein Gefälle -> kein Durchfluss');
  const mid = flowFactor(0.7, 0.4);
  assert(mid > 0 && mid < 1, `Unterschall-Faktor muss in (0,1) liegen, war ${mid}`);
  // Monotonic decrease across the subsonic branch.
  let prev = 1;
  for (let r = 0.4; r <= 1.0; r += 0.02) {
    const f = flowFactor(r, 0.4);
    assert(f <= prev + 1e-9, `Faktor muss monoton fallen (r=${r.toFixed(2)})`);
    prev = f;
  }
});

test('ISO 6358: choked mass flow matches C·ρ0·p_up and ignores downstream pressure', () => {
  const C = 1.2e-8, pUp = 7e5;
  const expected = C * RHO_0 * pUp;
  close(massFlow(pUp, 1e5, C, 0.4), expected, expected * 1e-9, 'Verblockter Massenstrom');
  // Below the critical ratio, lowering p_down changes nothing — that is what choking means.
  close(massFlow(pUp, 2e5, C, 0.4), massFlow(pUp, 0.5e5, C, 0.4), 1e-12,
        'Verblockter Strom darf nicht vom Gegendruck abhängen');
  assert(massFlow(1e5, 7e5, C, 0.4) < 0, 'Rückströmung muss negatives Vorzeichen haben');
});

// ---------------------------------------------------------------------------
// Gate 1 — SA cylinder + 3/2 pushbutton; throttle monotonicity
// ---------------------------------------------------------------------------

test('Gate 1a: EW-Zylinder fährt auf Tastendruck aus und federt zurück', () => {
  const c = EXAMPLES.direct.build();
  const sim = new Simulation(c);
  const cyl = first(c, 'cyl_single');
  const btn = first(c, 'v32_button');
  run(sim, 0.3);
  assert(cyl.sim.x < 0.02, `Ruhelage muss eingefahren sein, war ${cyl.sim.x}`);
  btn.sim.pressed = true;
  const tOut = timeUntil(sim, () => cyl.sim.x > 0.98);
  assert(tOut !== null, 'Zylinder fährt bei gedrücktem Taster nicht aus');
  btn.sim.pressed = false;
  const tBack = timeUntil(sim, () => cyl.sim.x < 0.02);
  assert(tBack !== null, 'Zylinder fährt beim Loslassen nicht zurück');
  return { ausfahrzeit_s: tOut, einfahrzeit_s: tBack };
});

test('Gate 1b: Ausfahrzeit steigt monoton beim Zudrehen der Drossel', () => {
  const times = [];
  for (const opening of [1.0, 0.6, 0.35, 0.2, 0.1]) {
    const c = EXAMPLES.speed.build();
    byType(c, 'throttle_check').forEach((t) => { t.params.opening.value = opening; });
    const sim = new Simulation(c);
    const cyl = first(c, 'cyl_double');
    run(sim, 0.3);
    tap(sim, byType(c, 'v32_button')[0], 100);
    const t = timeUntil(sim, () => cyl.sim.x > 0.98);
    assert(t !== null, `Zylinder fährt bei Öffnung ${opening} nicht aus`);
    times.push({ opening, t });
  }
  for (let i = 1; i < times.length; i++) {
    assert(times[i].t > times[i - 1].t,
      `Engere Drossel muss langsamer sein: ${times[i - 1].opening}->${times[i - 1].t}s, ${times[i].opening}->${times[i].t}s`);
  }
  return Object.fromEntries(times.map((x) => [`öffnung_${x.opening}`, `${x.t}s`]));
});

// ---------------------------------------------------------------------------
// Gate 2 — impulse valve memory
// ---------------------------------------------------------------------------

test('Gate 2: 5/2-Impulsventil hält Stellung ohne Signal; ein Puls genügt', () => {
  const c = EXAMPLES.indirect.build();
  const sim = new Simulation(c);
  const cyl = first(c, 'cyl_double');
  const main = first(c, 'v52_pilot');
  const [s1, s2] = byType(c, 'v32_button');

  run(sim, 0.3);
  const restState = main.sim.state;

  tap(sim, s1, 60); // a short pulse must be enough
  run(sim, 1.5);
  assert(main.sim.state !== restState, 'Kurzer Puls hat das Impulsventil nicht umgeschaltet');
  assert(cyl.sim.x > 0.98, `Zylinder muss ausgefahren sein, war ${cyl.sim.x}`);

  run(sim, 3.0); // long idle with both pilots vented
  assert(main.sim.state !== restState, 'Ventil hat seine Stellung ohne Signal verloren');
  assert(cyl.sim.x > 0.98, 'Zylinder ist ohne Signal weggedriftet');

  tap(sim, s2, 60);
  run(sim, 1.5);
  assert(cyl.sim.x < 0.02, `Zylinder muss zurückgefahren sein, war ${cyl.sim.x}`);
  return { haeltOhneSignal: true, pulsdauer_ms: 60 };
});

// ---------------------------------------------------------------------------
// Gate 3 — AND / OR at flow level
// ---------------------------------------------------------------------------

/** Two buttons -> logic element -> cylinder, for the AND/OR gates. */
function logicRig(elementType) {
  const c = new Circuit();
  const cyl = c.add('cyl_single', 400, 60);
  const el = c.add(elementType, 400, 220);
  const a = c.add('v32_button', 220, 340);
  const b = c.add('v32_button', 560, 340);
  const src = c.add('supply', 390, 470);
  c.connect({ inst: el.id, port: '2' }, { inst: cyl.id, port: '1' });
  c.connect({ inst: a.id, port: '2' }, { inst: el.id, port: '1a' });
  c.connect({ inst: b.id, port: '2' }, { inst: el.id, port: '1b' });
  c.connect({ inst: src.id, port: '1' }, { inst: a.id, port: '1' });
  c.connect({ inst: src.id, port: '1' }, { inst: b.id, port: '1' });
  return { c, cyl, a, b, el };
}

test('Gate 3a: Zweidruckventil (UND) lässt nur bei beiden Eingängen durch — am Druck gemessen', () => {
  const { c, cyl, a, b, el } = logicRig('two_pressure');
  const sim = new Simulation(c);
  const out = () => sim.gauge(el.id, '2');

  run(sim, 0.4);
  assert(out() < 0.3, `Ohne Signal muss der Ausgang drucklos sein, war ${out()} bar`);

  a.sim.pressed = true; run(sim, 0.6);
  assert(out() < 0.5, `Nur A: Ausgang muss gesperrt bleiben, war ${out()} bar`);
  assert(cyl.sim.x < 0.05, 'Nur A darf den Zylinder nicht bewegen');

  a.sim.pressed = false; b.sim.pressed = true; run(sim, 0.6);
  assert(out() < 0.5, `Nur B: Ausgang muss gesperrt bleiben, war ${out()} bar`);

  a.sim.pressed = true; run(sim, 0.8);
  assert(out() > 5.0, `A und B: Ausgang muss vollen Druck führen, war ${out()} bar`);
  assert(cyl.sim.x > 0.9, `A und B muss den Zylinder ausfahren, war ${cyl.sim.x}`);
  return { nurA_bar: 0, beide_bar: +out().toFixed(2) };
});

test('Gate 3b: Wechselventil (ODER) lässt bei jedem Eingang durch', () => {
  const { c, cyl, a, b, el } = logicRig('shuttle');
  const sim = new Simulation(c);
  const out = () => sim.gauge(el.id, '2');

  run(sim, 0.4);
  assert(out() < 0.3, 'Ohne Signal muss der Ausgang drucklos sein');

  a.sim.pressed = true; run(sim, 0.8);
  assert(out() > 5.0, `Nur A muss durchlassen, war ${out()} bar`);
  assert(cyl.sim.x > 0.9, 'Nur A muss den Zylinder ausfahren');

  a.sim.pressed = false; run(sim, 1.2);
  b.sim.pressed = true; run(sim, 0.8);
  assert(out() > 5.0, `Nur B muss durchlassen, war ${out()} bar`);
  return { nurA_bar: +out().toFixed(2) };
});

// ---------------------------------------------------------------------------
// Gate 4 — quick exhaust
// ---------------------------------------------------------------------------

test('Gate 4: Schnellentlüftung verkürzt die Einfahrzeit messbar', () => {
  // A quick-exhaust valve can only help where the exhaust path is the bottleneck, so the
  // rig has to be flow-limited for the test to mean anything. The stock spring-return
  // cylinder is force-limited (70 N against 350 Ns/m) and would show nothing however good
  // the model is; a big bore with a stiff spring and light damping makes the exhaust
  // path the only thing that matters. Without the QE, that air has to crawl back through
  // the valve's working path and its exhaust port in series.
  const build = (withQE) => {
    const c = new Circuit();
    const cyl = c.add('cyl_single', 400, 60);
    cyl.params.bore.value = 40;
    cyl.params.springForce.value = 250;
    cyl.params.friction.value = 80;
    cyl.params.coulomb.value = 2;
    const valve = c.add('v32_button', 400, 300);
    const src = c.add('supply', 390, 440);

    if (withQE) {
      // Mounted at the cylinder, so its air dumps locally instead of travelling back.
      const qe = c.add('quick_exhaust', 400, 180);
      c.connect({ inst: qe.id, port: '2' }, { inst: cyl.id, port: '1' });
      c.connect({ inst: valve.id, port: '2' }, { inst: qe.id, port: '1' });
    } else {
      c.connect({ inst: valve.id, port: '2' }, { inst: cyl.id, port: '1' });
    }
    c.connect({ inst: src.id, port: '1' }, { inst: valve.id, port: '1' });
    return { c, cyl, valve };
  };
  const retractTime = (withQE) => {
    const { c, cyl, valve } = build(withQE);
    const sim = new Simulation(c);
    run(sim, 0.3);
    valve.sim.pressed = true;
    assert(timeUntil(sim, () => cyl.sim.x > 0.97) !== null, 'Zylinder fährt nicht aus');
    valve.sim.pressed = false;
    return timeUntil(sim, () => cyl.sim.x < 0.03);
  };
  const without = retractTime(false);
  const withQE = retractTime(true);
  assert(withQE !== null && without !== null, 'Zylinder fährt nicht ein');
  assert(withQE < without * 0.8,
    `Schnellentlüftung muss deutlich schneller sein: ohne ${without}s, mit ${withQE}s`);
  return { ohne_s: without, mit_s: withQE, verbesserung: `${Math.round((1 - withQE / without) * 100)} %` };
});

// ---------------------------------------------------------------------------
// Gate 4c — end-position cushioning
// ---------------------------------------------------------------------------

/** Extend once and report what happened at the end stop. */
function cushionRun({ mass = 2, cushion = 0, needle = 12 }) {
  const c = new Circuit();
  const cyl = c.add('cyl_double', 400, 60);
  cyl.params.bore.value = 25;
  cyl.params.stroke.value = 200;
  cyl.params.mass.value = mass;
  cyl.params.friction.value = 300;
  cyl.params.coulomb.value = 4;
  cyl.params.cushion.value = cushion;
  cyl.params.cushionNeedle.value = needle;
  const valve = c.add('v52_sol_spring', 400, 300);
  const src = c.add('supply', 390, 470);
  c.connect({ inst: valve.id, port: '4' }, { inst: cyl.id, port: '1' });
  c.connect({ inst: valve.id, port: '2' }, { inst: cyl.id, port: '2' });
  c.connect({ inst: src.id, port: '1' }, { inst: valve.id, port: '1' });

  const sim = new Simulation(c);
  run(sim, 0.2);

  let impact = 0, pChamberMax = 0, t = 0, tExtend = null;
  for (let i = 0; i < 8000; i++) {
    sim.energized.set('Y1', true);
    sim.step(1e-3); t += 1e-3;
    if (cyl.sim.iB != null) pChamberMax = Math.max(pChamberMax, barG(sim.p[cyl.sim.iB]));
    if (cyl.sim.x >= 1) { tExtend = t; break; }
    impact = cyl.sim.v; // last velocity before the stop is reached
  }
  // Retract again, to see what the cushion costs on the stroke it must not obstruct.
  const t0 = t;
  let tRetract = null;
  for (let i = 0; i < 8000; i++) {
    sim.energized.set('Y1', false);
    sim.step(1e-3); t += 1e-3;
    if (cyl.sim.x <= 0.001) { tRetract = t - t0; break; }
  }
  return { impact, pChamberMax, tExtend, tRetract, converged: sim.diagnostics.converged };
}

test('Gate 4c: Endlagendämpfung bremst den Kolben über den Kammerdruck, nicht über eine Bremskraft', () => {
  const hard = cushionRun({ cushion: 0 });
  const soft = cushionRun({ cushion: 20 });

  assert(hard.tExtend !== null && soft.tExtend !== null, 'Zylinder erreicht die Endlage nicht');

  // 1. The point of the feature.
  assert(soft.impact < hard.impact * 0.3,
    `Dämpfung muss die Anschlaggeschwindigkeit deutlich senken: `
    + `ohne ${hard.impact.toFixed(3)} m/s, mit ${soft.impact.toFixed(3)} m/s`);

  // 2. The mechanism. Nothing applies a braking force anywhere in the model — the piston
  //    can only be decelerated by air it is compressing itself. If the chamber never rose
  //    above the 6 bar supply, whatever slowed the piston was not the cushion.
  assert(soft.pChamberMax > 6,
    `Der Kammerdruck muss über den Versorgungsdruck steigen, war ${soft.pChamberMax.toFixed(1)} bar`);
  assert(hard.pChamberMax < 0.01,
    'Ohne Dämpfung darf es gar keinen Kammerknoten mit Druck geben');

  // 3. The check valve. A cushion that also throttled the filling stroke would be a
  //    modelling error that test 1 cannot see — the cylinder would simply be slow.
  assert(soft.tExtend < hard.tExtend * 1.1 && soft.tRetract < hard.tRetract * 1.15,
    `Dämpfung darf die Hubzeiten kaum kosten: aus ${hard.tExtend?.toFixed(3)}->${soft.tExtend?.toFixed(3)} s, `
    + `ein ${hard.tRetract?.toFixed(3)}->${soft.tRetract?.toFixed(3)} s`);

  assert(soft.converged, 'Der Solver muss auch mit der zufahrenden Drossel konvergieren');

  return {
    anschlag_ohne_ms: +hard.impact.toFixed(3),
    anschlag_mit_ms: +soft.impact.toFixed(3),
    reduktion: `${Math.round((1 - soft.impact / hard.impact) * 100)} %`,
    kammerdruck_bar: +soft.pChamberMax.toFixed(1),
    hubzeit_aufschlag: `${((soft.tExtend / hard.tExtend - 1) * 100).toFixed(1)} %`,
  };
});

test('Gate 4d: Die Dämpfungsdrossel ist einstellbar — ganz zugedreht wird sie zur Luftfeder', () => {
  // A cushion that only ever got better the tighter you close it would not be a cushion,
  // it would be a spring. Air that cannot escape stores the energy and hands it back, so
  // past some setting the piston arrives faster again. This is why a real needle is
  // adjustable, and it is emergent here: nothing in the model knows about an optimum.
  const settings = [2, 6, 12, 25, 50, 100];
  const impacts = settings.map((n) => cushionRun({ mass: 2, cushion: 20, needle: n }).impact);

  const best = Math.min(...impacts);
  const bestAt = settings[impacts.indexOf(best)];
  const wideOpen = impacts[impacts.length - 1];
  const shut = impacts[0];

  assert(bestAt > settings[0] && bestAt < settings[settings.length - 1],
    `Das Optimum muss zwischen den Extremen liegen, lag aber bei ${bestAt} %`);
  assert(best < shut * 0.8,
    `Ganz zugedreht muss schlechter dämpfen als die beste Einstellung: `
    + `${shut.toFixed(3)} vs ${best.toFixed(3)} m/s`);
  assert(best < wideOpen * 0.5,
    `Ganz offen darf kaum dämpfen: ${wideOpen.toFixed(3)} vs ${best.toFixed(3)} m/s`);

  return {
    einstellungen: settings.map((n, i) => `${n}%: ${impacts[i].toFixed(3)}`).join(' · '),
    optimum_prozent: bestAt,
  };
});

// ---------------------------------------------------------------------------
// Gate 5 — meter-out vs meter-in against an opposing load
// ---------------------------------------------------------------------------

test('Gate 5: Abluftdrosselung behält gegen ziehende Last die Kontrolle, Zuluftdrosselung nicht', () => {
  // The spec asks for "velocity variance", but measured against this model that metric
  // is actively misleading: meter-in produces the *lower* variance (~0.003 vs ~0.14)
  // because an uncontrolled slam is perfectly steady while it lasts. What actually
  // distinguishes the two is who sets the speed. Meter-out builds a back-pressure
  // cushion on the exhausting side and the throttle stays in charge; meter-in vents
  // that side freely, so an overrunning load takes over. That is the assertion here.
  const measure = (freeDir) => {
    const c = EXAMPLES.speed.build();
    const cyl = first(c, 'cyl_double');
    cyl.params.load.value = -150;    // overrunning: the load pulls the rod out
    cyl.params.friction.value = 120; // light damping, so the load can actually run away
    cyl.params.mass.value = 4;
    byType(c, 'throttle_check').forEach((t) => {
      t.params.opening.value = 0.3;
      t.params.freeDir.value = freeDir;
    });
    const sim = new Simulation(c);
    run(sim, 0.3);
    tap(sim, byType(c, 'v32_button')[0], 100);

    const vs = [], rod = [];
    let t = 0;
    while (cyl.sim.x < 0.98 && t < 6000) {
      sim.step(1e-3); t++;
      if (cyl.sim.x > 0.02) { vs.push(cyl.sim.v); rod.push(sim.gauge(cyl.id, '2')); }
    }
    assert(vs.length > 0, `${freeDir}: Zylinder bewegt sich nicht`);
    return {
      vMax: Math.max(...vs),
      ms: t,
      backPressure: rod.reduce((a, b) => a + b, 0) / rod.length,
    };
  };
  // freeDir '1->2' = free into the cylinder, throttled on the way out = meter-out.
  const out = measure('1->2');
  const inn = measure('2->1');

  assert(out.backPressure > 3.0,
    `Abluftdrosselung muss Gegendruck aufbauen, waren ${out.backPressure.toFixed(2)} bar`);
  assert(inn.backPressure < 1.0,
    `Zuluftdrosselung darf keinen Gegendruck haben, waren ${inn.backPressure.toFixed(2)} bar`);
  assert(inn.vMax > out.vMax * 2,
    `Zuluftdrosselung muss die Kontrolle verlieren: aus ${out.vMax.toFixed(2)} m/s, ein ${inn.vMax.toFixed(2)} m/s`);
  return {
    abluft: `${out.vMax.toFixed(2)} m/s, ${out.ms} ms, ${out.backPressure.toFixed(1)} bar Gegendruck`,
    zuluft: `${inn.vMax.toFixed(2)} m/s, ${inn.ms} ms, ${inn.backPressure.toFixed(1)} bar Gegendruck`,
    kontrollverlust: `${(inn.vMax / out.vMax).toFixed(1)}× schneller`,
  };
});

// ---------------------------------------------------------------------------
// Gate 6 — A+ B+ A- B- sequence
// ---------------------------------------------------------------------------

test('Gate 6: A+ B+ A− B− läuft durch, wiederholt sich und bleibt nicht hängen', () => {
  const c = EXAMPLES.sequence.build();
  const sim = new Simulation(c);
  const A = byTag(c, '1A1'), B = byTag(c, '2A1');
  const start = byTag(c, '1S1');

  run(sim, 0.3);
  assert(A.sim.x < 0.05 && B.sim.x < 0.05, 'Grundstellung: beide Zylinder eingefahren');

  // Record *transitions*, not states: sampling "is A extended" every tick just reports
  // the same phase thousands of times and says nothing about order.
  const seen = [];
  const edge = (x, prev) => (x > 0.97 ? 'out' : x < 0.03 ? 'in' : prev);
  let aPrev = 'in', bPrev = 'in';

  start.sim.pressed = true; // detent start valve latches on
  for (let i = 0; i < 12000; i++) {
    sim.step(1e-3);
    const aNow = edge(A.sim.x, aPrev);
    const bNow = edge(B.sim.x, bPrev);
    if (aNow !== aPrev) { seen.push(aNow === 'out' ? 'A+' : 'A-'); aPrev = aNow; }
    if (bNow !== bPrev) { seen.push(bNow === 'out' ? 'B+' : 'B-'); bPrev = bNow; }
  }
  const cycle = seen.slice(0, 4).join(' ');
  assert(cycle === 'A+ B+ A- B-', `Falsche Reihenfolge: "${seen.join(' ')}"`);
  assert(seen.length >= 5, `Zyklus wiederholt sich nicht (nur ${seen.length} Phasen): ${seen.join(' ')}`);
  return { reihenfolge: cycle, phasen_beobachtet: seen.length };
});

// ---------------------------------------------------------------------------
// Gate 7 — self-interrupting relay must buzz, not hang
// ---------------------------------------------------------------------------

test('Gate 7: Selbstunterbrechender Relaiskreis schwingt statt den Solver einzufrieren', () => {
  // K1's own break contact feeds K1: it must chatter at the tick rate, not deadlock.
  const c = new Circuit();
  const p24 = c.add('rail_24v', 200, 100);
  const nc = c.add('contact_nc', 206, 160);
  const coil = c.add('relay_coil', 203, 260);
  const p0 = c.add('rail_0v', 200, 380);
  nc.params.tag.value = 'K1';
  coil.params.tag.value = 'K1';
  c.connect({ inst: p24.id, port: 'a' }, { inst: nc.id, port: 'a' });
  c.connect({ inst: nc.id, port: 'b' }, { inst: coil.id, port: 'a' });
  c.connect({ inst: coil.id, port: 'b' }, { inst: p0.id, port: 'a' });

  const sim = new Simulation(c);
  let flips = 0, last = null;
  const t0 = Date.now();
  for (let i = 0; i < 2000; i++) {
    sim.step(1e-3);
    const on = !!sim.energized.get('K1');
    if (last !== null && on !== last) flips++;
    last = on;
  }
  const wall = Date.now() - t0;
  assert(flips > 10, `Kreis muss schwingen, zählte nur ${flips} Wechsel`);
  assert(wall < 4000, `Solver darf nicht festhängen, brauchte ${wall} ms für 2 s`);
  return { wechsel_in_2s: flips, rechenzeit_ms: wall };
});

// ---------------------------------------------------------------------------
// Gate 10 — physical bounds and conservation
// ---------------------------------------------------------------------------

test('Gate 10a: Druck bleibt physikalisch, Kolben bleibt im Hub', () => {
  const report = {};
  for (const [key, ex] of Object.entries(EXAMPLES)) {
    const c = ex.build();
    const sim = new Simulation(c);
    const btns = c.instances.filter((i) => c.defOf(i).interactive);
    run(sim, 0.3);
    if (btns.length) tap(sim, btns[0], 120);
    run(sim, 3.0);

    for (let i = 0; i < sim.p.length; i++) {
      assert(Number.isFinite(sim.p[i]), `${key}: Druck ist NaN`);
      assert(sim.p[i] > 0, `${key}: Absolutdruck darf nie negativ werden, war ${sim.p[i]} Pa`);
      assert(barG(sim.p[i]) < 12, `${key}: Druck über der Quelle: ${barG(sim.p[i])} bar`);
    }
    for (const inst of c.instances) {
      if (inst.sim?.x == null) continue;
      assert(inst.sim.x >= 0 && inst.sim.x <= 1,
        `${key}: Kolbenposition außerhalb [0,1]: ${inst.sim.x}`);
    }
    report[key] = `max ${barG(Math.max(...sim.p)).toFixed(2)} bar`;
  }
  return report;
});

test('Gate 10b: Masse bleibt in einem abgeschlossenen Netz erhalten', () => {
  // Two closed volumes joined by a throttle: total mass must not change as it equalises.
  const c = new Circuit();
  const a = c.add('cyl_double', 200, 100);
  const th = c.add('throttle_check', 400, 200);
  const b = c.add('cyl_double', 600, 100);
  c.connect({ inst: a.id, port: '1' }, { inst: th.id, port: '1' });
  c.connect({ inst: th.id, port: '2' }, { inst: b.id, port: '1' });
  // Seize both pistons so chamber volumes are constant and mass is the only variable.
  a.faults = { seized: true }; b.faults = { seized: true };

  const sim = new Simulation(c);
  sim.p[sim.netIndex(a.id, '1')] = 7e5; // charge one side

  const totalMass = () => {
    let m = 0;
    // Sum over the nets only: sim.p carries component-internal chamber nodes past
    // nets.count, and those have no entry in nets.volumes.
    for (let i = 0; i < sim.nets.count; i++) m += (sim.p[i] * sim.nets.volumes[i]);
    // Chamber volumes are not in nets.volumes; add them explicitly.
    for (const cyl of [a, b]) {
      const A = (Math.PI / 4) * (cyl.params.bore.value / 1000) ** 2;
      const Ab = A - (Math.PI / 4) * (cyl.params.rod.value / 1000) ** 2;
      const L = cyl.params.stroke.value / 1000;
      m += sim.p[sim.netIndex(cyl.id, '1')] * A * L * cyl.sim.x;
      m += sim.p[sim.netIndex(cyl.id, '2')] * Ab * L * (1 - cyl.sim.x);
    }
    return m;
  };
  const before = totalMass();
  run(sim, 2.0);
  const after = totalMass();
  const drift = Math.abs(after - before) / before;
  // The engine deliberately leaks each net to atmosphere through C_LEAK for
  // conditioning, so a little drift is expected and budgeted for.
  assert(drift < 0.02, `Massendrift ${(drift * 100).toFixed(3)} % über 2 s ist zu groß`);
  return { drift_prozent: +(drift * 100).toFixed(4) };
});

// ---------------------------------------------------------------------------
// Gate 13 — fault injection
// ---------------------------------------------------------------------------

test('Gate 13: Steckendes Ventil lässt die Sequenz an der erwarteten Stelle stehen', () => {
  const c = EXAMPLES.sequence.build();
  const sim = new Simulation(c);
  const A = byTag(c, '1A1'), B = byTag(c, '2A1');
  const start = byTag(c, '1S1');
  const valveB = byTag(c, '2V1');

  run(sim, 0.3);
  // Seize B's main valve in its rest position: A may extend, B never can.
  valveB.faults = { stuck: true };
  start.sim.pressed = true;
  run(sim, 4.0);

  assert(A.sim.x > 0.97, `A muss trotz Defekt ausfahren, war ${A.sim.x}`);
  assert(B.sim.x < 0.05, `B darf mit steckendem Ventil nicht ausfahren, war ${B.sim.x}`);
  // The diagnosis the learner is meant to make with a probe: B's supply side is dead.
  const pB = sim.gauge(B.id, '1');
  assert(pB < 0.5, `Prüfstelle 2A1:1 muss drucklos sein, las ${pB} bar`);
  return { A_ausgefahren: +A.sim.x.toFixed(2), B_blockiert: +B.sim.x.toFixed(2), probe_2A1_bar: +pB.toFixed(2) };
});

test('Gate 13b: Verstopfte Drossel bremst, gerissene Versorgung stoppt', () => {
  const c = EXAMPLES.speed.build();
  const sim = new Simulation(c);
  const cyl = first(c, 'cyl_double');
  first(c, 'supply').faults = { off: true };
  run(sim, 0.3);
  tap(sim, byType(c, 'v32_button')[0], 100);
  run(sim, 2.0);
  assert(cyl.sim.x < 0.05, `Ohne Versorgung darf sich nichts bewegen, war ${cyl.sim.x}`);
  assert(sim.gauge(cyl.id, '1') < 0.3, 'Ohne Versorgung darf kein Druck anstehen');
  return { zylinder_x: +cyl.sim.x.toFixed(3) };
});

// ---------------------------------------------------------------------------
// Gate 14/15 — serialization round-trip and determinism
// ---------------------------------------------------------------------------

test('Gate 14: Serialisierung ist verlustfrei über alle Bauteilkategorien', async () => {
  const { CATALOG } = await import('../src/catalog.js');
  const c = new Circuit();
  // One of everything, so no category can silently drop a field.
  let x = 0;
  for (const def of CATALOG) {
    c.add(def.id, (x % 10) * 200, Math.floor(x / 10) * 150);
    x++;
  }
  const json1 = JSON.stringify(c.toJSON());
  const round = Circuit.fromJSON(JSON.parse(json1));
  const json2 = JSON.stringify(round.toJSON());

  // Ids are reassigned on load, so normalise them away before comparing.
  const norm = (j) => {
    const o = JSON.parse(j);
    const map = new Map(o.instances.map((inst, i) => [inst.id, `n${i}`]));
    o.instances.forEach((inst) => { inst.id = map.get(inst.id); });
    o.wires.forEach((w) => { w.from.inst = map.get(w.from.inst); w.to.inst = map.get(w.to.inst); });
    return JSON.stringify(o);
  };
  assert(norm(json1) === norm(json2), 'Round-Trip verändert das Dokument');
  assert(round.instances.length === CATALOG.length,
    `${CATALOG.length} Bauteile rein, ${round.instances.length} raus`);
  return { bauteile: CATALOG.length, verlustfrei: true };
});

test('Gate 15: Determinismus — gleiche Schaltung + gleiche Eingaben = identische Spur', () => {
  const traceOf = () => {
    const c = EXAMPLES.reciprocating.build();
    const start = first(c, 'v32_detent');
    const { trace } = runHeadless(c, {
      seconds: 3,
      script: (sim, t) => { if (t > 0.2) start.sim.pressed = true; },
      probe: (sim) => sim.snapshot().parts[first(c, 'cyl_double').id].x,
    });
    return trace;
  };
  const a = traceOf(), b = traceOf();
  assert(a.length === b.length, 'Spurlängen unterscheiden sich');
  for (let i = 0; i < a.length; i++) {
    assert(a[i] === b[i], `Abweichung bei Schritt ${i}: ${a[i]} vs ${b[i]}`);
  }
  return { schritte: a.length, identisch: true };
});

// ---------------------------------------------------------------------------
// Solver health
// ---------------------------------------------------------------------------

test('Solver: Fixpunkt-Iteration konvergiert in allen Beispielen', () => {
  const report = {};
  for (const [key, ex] of Object.entries(EXAMPLES)) {
    const c = ex.build();
    const sim = new Simulation(c);
    const btns = c.instances.filter((i) => c.defOf(i).interactive);
    let maxIter = 0, worst = 0;
    for (let i = 0; i < 3000; i++) {
      if (i === 500 && btns.length) btns[0].sim.pressed = true;
      if (i === 620 && btns.length) btns[0].sim.pressed = false;
      sim.step(1e-3);
      maxIter = Math.max(maxIter, sim.diagnostics.iterations);
      worst = Math.max(worst, sim.diagnostics.residual);
    }
    assert(sim.diagnostics.failures === 0,
      `${key}: ${sim.diagnostics.failures} Ticks ohne Konvergenz`);
    report[key] = `max ${maxIter} Iterationen, Residuum ${worst.toFixed(1)} Pa`;
  }
  return report;
});

// ---------------------------------------------------------------------------
// Valve groups added after the first gate pass
// ---------------------------------------------------------------------------

test('Zeitventil: schaltet nach der eingestellten Zeit und setzt bei Signalverlust zurück', () => {
  /** Button -> timer pilot; timer output drives the cylinder. */
  const rig = (delay) => {
    const c = new Circuit();
    const cyl = c.add('cyl_single', 420, 60);
    const timer = c.add('timer_nc', 400, 240);
    const btn = c.add('v32_button', 200, 400);
    const src = c.add('supply', 400, 520);
    timer.params.delay.value = delay;
    c.connect({ inst: timer.id, port: '2' }, { inst: cyl.id, port: '1' });
    c.connect({ inst: btn.id, port: '2' }, { inst: timer.id, port: '12' });
    c.connect({ inst: src.id, port: '1' }, { inst: timer.id, port: '1' });
    c.connect({ inst: src.id, port: '1' }, { inst: btn.id, port: '1' });
    return { c, cyl, timer, btn };
  };

  const measured = [];
  for (const delay of [0.5, 1.5, 3.0]) {
    const { c, cyl, timer, btn } = rig(delay);
    const sim = new Simulation(c);
    run(sim, 0.2);
    btn.sim.pressed = true;
    const t0 = sim.time;
    const t = timeUntil(sim, () => timer.sim.state === 1, delay + 2);
    assert(t !== null, `Zeitventil schaltet bei ${delay}s nie`);
    const actual = sim.time - t0;
    close(actual, delay, 0.05, `Verzögerung bei Sollwert ${delay}s`);
    measured.push(`${delay}s → ${actual.toFixed(2)}s`);
  }

  // Reset: dropping the signal before the delay elapses must abort, not accumulate.
  const { c, cyl, timer, btn } = rig(2.0);
  const sim = new Simulation(c);
  run(sim, 0.2);
  btn.sim.pressed = true; run(sim, 1.5);
  assert(timer.sim.state === 0, 'Zeitventil darf vor Ablauf nicht schalten');
  btn.sim.pressed = false; run(sim, 0.3);
  assert(timer.sim.elapsed === 0, 'Zeitventil muss bei Signalverlust zurücksetzen');
  btn.sim.pressed = true; run(sim, 1.5);
  assert(timer.sim.state === 0, 'Nach Reset darf die alte Zeit nicht weiterzählen');
  run(sim, 0.7);
  assert(timer.sim.state === 1, 'Nach voller Zeit muss das Ventil schalten');
  return { gemessen: measured.join(', '), reset_geprueft: true };
});

test('Druckfolgeventil: öffnet erst am Schaltdruck, nicht darunter', () => {
  const c = new Circuit();
  const cyl = c.add('cyl_single', 420, 60);
  const seq = c.add('sequence_valve', 400, 240);
  const reg = c.add('pressure_reg', 200, 400);
  const src = c.add('supply', 200, 540);
  seq.params.setpoint.value = 4;

  c.connect({ inst: seq.id, port: '2' }, { inst: cyl.id, port: '1' });
  c.connect({ inst: reg.id, port: '2' }, { inst: seq.id, port: '12' });
  c.connect({ inst: src.id, port: '1' }, { inst: reg.id, port: '1' });
  c.connect({ inst: src.id, port: '1' }, { inst: seq.id, port: '1' });

  const sim = new Simulation(c);
  // Pilot held below the setpoint: the sequence valve must stay shut.
  reg.params.setpoint.value = 2.5;
  run(sim, 1.5);
  assert(seq.sim.state === 0,
    `Unter Schaltdruck muss gesperrt bleiben (Pilot ${sim.gauge(seq.id, '12').toFixed(2)} bar)`);
  assert(cyl.sim.x < 0.05, 'Zylinder darf unter Schaltdruck nicht fahren');

  // Raise the pilot past the setpoint.
  reg.params.setpoint.value = 5.5;
  run(sim, 1.5);
  assert(seq.sim.state === 1,
    `Über Schaltdruck muss öffnen (Pilot ${sim.gauge(seq.id, '12').toFixed(2)} bar)`);
  assert(cyl.sim.x > 0.9, `Zylinder muss ausfahren, war ${cyl.sim.x}`);
  return { schaltdruck_bar: 4, pilot_final_bar: +sim.gauge(seq.id, '12').toFixed(2) };
});

test('Druckregelventil: hält den Sollwert unter der Quelle und folgt Verstellung', () => {
  const c = new Circuit();
  const reg = c.add('pressure_reg', 300, 200);
  const gauge = c.add('gauge', 460, 120);
  const src = c.add('supply', 300, 360);
  c.connect({ inst: src.id, port: '1' }, { inst: reg.id, port: '1' });
  c.connect({ inst: reg.id, port: '2' }, { inst: gauge.id, port: '1' });

  const sim = new Simulation(c);
  const out = [];
  for (const set of [2, 4, 5.5]) {
    reg.params.setpoint.value = set;
    run(sim, 1.5);
    const p = sim.gauge(reg.id, '2');
    close(p, set, 0.25, `Ausgangsdruck bei Sollwert ${set} bar`);
    out.push(`${set} → ${p.toFixed(2)} bar`);
  }
  // A regulator must never exceed its supply.
  reg.params.setpoint.value = 9;
  run(sim, 2.0);
  assert(sim.gauge(reg.id, '2') <= 6.05,
    `Regler darf die Quelle nicht überschreiten, war ${sim.gauge(reg.id, '2')} bar`);
  return { geregelt: out.join(', ') };
});

test('Druckschalter: schaltet am Sollwert mit Hysterese und speist die Ladder', () => {
  const c = new Circuit();
  const reg = c.add('pressure_reg', 200, 200);
  const src = c.add('supply', 200, 360);
  const ps = c.add('pressure_switch', 400, 200);
  const p24 = c.add('rail_24v', 520, 80);
  const coil = c.add('relay_coil', 517, 320);
  const p0 = c.add('rail_0v', 520, 440);
  ps.params.setpoint.value = 3;
  ps.params.hysteresis.value = 0.5;
  coil.params.tag.value = 'K1';

  c.connect({ inst: src.id, port: '1' }, { inst: reg.id, port: '1' });
  c.connect({ inst: reg.id, port: '2' }, { inst: ps.id, port: '1' });
  c.connect({ inst: p24.id, port: 'a' }, { inst: ps.id, port: 'a' });
  c.connect({ inst: ps.id, port: 'b' }, { inst: coil.id, port: 'a' });
  c.connect({ inst: coil.id, port: 'b' }, { inst: p0.id, port: 'a' });

  const sim = new Simulation(c);
  reg.params.setpoint.value = 1.5;
  run(sim, 1.5);
  assert(!sim.energized.get('K1'), 'Unter Sollwert darf K1 nicht anziehen');

  reg.params.setpoint.value = 4;
  run(sim, 1.5);
  assert(sim.energized.get('K1'), 'Über Sollwert muss K1 anziehen');

  // Inside the hysteresis band the contact must hold.
  reg.params.setpoint.value = 2.7;
  run(sim, 1.5);
  assert(sim.energized.get('K1'),
    `In der Hysterese muss der Kontakt halten (${sim.gauge(ps.id, '1').toFixed(2)} bar)`);

  reg.params.setpoint.value = 2.0;
  run(sim, 1.5);
  assert(!sim.energized.get('K1'),
    `Unter Sollwert minus Hysterese muss abfallen (${sim.gauge(ps.id, '1').toFixed(2)} bar)`);
  return { schaltpunkt_bar: 3, hysterese_bar: 0.5, geprueft: 'ein/halten/aus' };
});

test('Beispiele: alle Schaltungen laufen stabil und konvergieren', () => {
  const report = {};
  for (const [key, ex] of Object.entries(EXAMPLES)) {
    const c = ex.build();
    const sim = new Simulation(c);
    const btns = c.instances.filter((i) => c.defOf(i).interactive);
    run(sim, 0.3);
    if (btns.length) btns[0].sim.pressed = true;
    run(sim, 5.0);
    assert(sim.diagnostics.failures === 0, `${key}: ${sim.diagnostics.failures} Ticks ohne Konvergenz`);
    for (let i = 0; i < sim.p.length; i++) {
      assert(Number.isFinite(sim.p[i]) && sim.p[i] > 0, `${key}: unphysikalischer Druck`);
    }
    for (let i = 0; i < sim.ph.length; i++) {
      assert(Number.isFinite(sim.ph[i]) && sim.ph[i] > 0, `${key}: unphysikalischer Öldruck`);
    }
    // Math.max of an empty array is -Infinity: a hydraulic-only circuit has no pneumatic
    // nets and vice versa, so each domain only reports when it actually has one.
    const peak = (arr) => (arr.length ? `${barG(Math.max(...arr)).toFixed(1)} bar` : null);
    const air = peak(sim.p), oil = peak(sim.ph);
    report[key] = `${c.instances.length} Teile` + (air ? `, Luft ${air}` : '') + (oil ? `, Öl ${oil}` : '');
  }
  return report;
});

// ---------------------------------------------------------------------------
// Virtual probes
// ---------------------------------------------------------------------------

test('Messsonden beeinflussen die Schaltung nachweislich nicht', async () => {
  const { Scope, readProbe } = await import('../src/scope.js');

  /** Same circuit, same inputs; the only difference is whether probes are attached. */
  const traceOf = (withProbes) => {
    const c = EXAMPLES.speed.build();
    const cyl = first(c, 'cyl_double');
    const btn = byType(c, 'v32_button')[0];
    const sim = new Simulation(c);

    let scope = null;
    if (withProbes) {
      scope = new Scope();
      // Probe every pneumatic port in the circuit — the heaviest instrumentation a user
      // could plausibly apply.
      for (const inst of c.instances) {
        for (const p of c.defOf(inst).ports) {
          if ((p.kind || 'pneumatic') !== 'pneumatic') continue;
          scope.addProbe(inst.id, p.id, 'pressure', `${inst.id}:${p.id}`);
          if (scope.probes.length >= 8) break;
        }
        if (scope.probes.length >= 8) break;
      }
      assert(scope.probes.length > 0, 'Testaufbau: keine Sonde gesetzt');
    }

    const out = [];
    for (let i = 0; i < 3000; i++) {
      if (i === 300) btn.sim.pressed = true;
      if (i === 400) btn.sim.pressed = false;
      sim.step(1e-3);
      if (scope) {
        scope.sample(sim);
        for (const probe of scope.probes) readProbe(sim, probe);
      }
      out.push(cyl.sim.x);
    }
    return out;
  };

  const clean = traceOf(false);
  const probed = traceOf(true);
  assert(clean.length === probed.length, 'Spurlängen unterscheiden sich');
  for (let i = 0; i < clean.length; i++) {
    assert(clean[i] === probed[i],
      `Sonde hat das Ergebnis verändert bei Schritt ${i}: ${clean[i]} vs ${probed[i]}`);
  }
  return { schritte: clean.length, sonden: 8, identisch: true };
});

test('Messsonden: Trigger findet die letzte Flanke und hält das Bild', async () => {
  const { Scope } = await import('../src/scope.js');
  const c = EXAMPLES.reciprocating.build();
  const sim = new Simulation(c);
  const cyl = first(c, 'cyl_double');
  const start = first(c, 'v32_detent');

  const scope = new Scope();
  scope.addProbe(cyl.id, '1', 'pressure', '1A1:1');
  scope.timebase = 1;
  scope.trigger = { mode: 'edge', source: 0, level: 3, edge: 'rising' };

  run(sim, 0.2);
  start.sim.pressed = true;
  for (let i = 0; i < 4000; i++) { sim.step(1e-3); scope.sample(sim); }

  const win = scope.window();
  assert(win !== null, 'Kein Fenster');
  assert(win.triggered, 'Trigger hat keine steigende Flanke gefunden');
  // The trigger point must sit at 30% across, which is what holds a repeating trace still.
  const frac = (win.tTrig - win.t0) / (win.t1 - win.t0);
  close(frac, 0.3, 0.01, 'Triggerpunkt im Fenster');

  // Freeze must stop capture dead.
  scope.frozen = true;
  const before = scope.count;
  for (let i = 0; i < 500; i++) { sim.step(1e-3); scope.sample(sim); }
  assert(scope.count === before, 'Freeze hat die Aufzeichnung nicht gestoppt');
  return { triggerposition: `${(frac * 100).toFixed(0)} %`, freeze: 'hält' };
});

test('Messsonden: Abtastung ist tickgenau, nicht framegenau', async () => {
  const { Scope } = await import('../src/scope.js');
  const c = EXAMPLES.direct.build();
  const sim = new Simulation(c);
  const cyl = first(c, 'cyl_single');
  const scope = new Scope();
  scope.addProbe(cyl.id, '1', 'pressure', '1A1:1');

  // 500 ticks in must yield 500 samples: anything less means the capture is aliased.
  for (let i = 0; i < 500; i++) { sim.step(1e-3); scope.sample(sim); }
  assert(scope.count === 500, `500 Ticks müssen 500 Abtastungen ergeben, waren ${scope.count}`);

  // And they must be evenly spaced at the tick rate.
  let maxGap = 0;
  for (let i = 1; i < scope.count; i++) {
    maxGap = Math.max(maxGap, scope.times[scope.idx(i)] - scope.times[scope.idx(i - 1)]);
  }
  close(maxGap, 1e-3, 1e-9, 'Abtastabstand');
  return { abtastungen: scope.count, abstand_ms: 1 };
});

// ---------------------------------------------------------------------------
// Gate 8/9 — hydraulics
// ---------------------------------------------------------------------------

test('Gate 8: Pumpe gegen gesperrte Mittelstellung — Druck steigt aufs DBV und hält', () => {
  const c = new Circuit();
  const pump = c.add('h_pump', 200, 400);
  const tank = c.add('h_tank', 200, 560);
  const relief = c.add('h_relief', 340, 400);
  const tank2 = c.add('h_tank', 340, 560);
  const valve = c.add('h_v43_closed', 520, 240);
  const cyl = c.add('h_cyl', 500, 60);
  const gauge = c.add('h_gauge', 420, 300);
  pump.params.flow.value = 8;
  relief.params.setpoint.value = 60;

  c.connect({ inst: pump.id, port: 'P' }, { inst: relief.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'P' }, { inst: valve.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'P' }, { inst: gauge.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'T' }, { inst: tank.id, port: 'T' });
  c.connect({ inst: relief.id, port: 'T' }, { inst: tank2.id, port: 'T' });
  c.connect({ inst: valve.id, port: 'T' }, { inst: tank2.id, port: 'T' });
  c.connect({ inst: valve.id, port: 'A' }, { inst: cyl.id, port: 'A' });
  c.connect({ inst: valve.id, port: 'B' }, { inst: cyl.id, port: 'B' });

  const sim = new Simulation(c);
  run(sim, 2.0);

  const p = sim.hgauge(pump.id, 'P');
  close(p, 60, 6, 'Systemdruck muss auf dem DBV stehen');
  assert(relief.sim.open > 0.05, `DBV muss offen sein, war ${relief.sim.open}`);
  assert(cyl.sim.x < 0.02, `Zylinder darf bei Sperrmittelstellung nicht fahren, war ${cyl.sim.x}`);

  // No runaway: another two seconds must not move it.
  run(sim, 2.0);
  const p2 = sim.hgauge(pump.id, 'P');
  assert(Math.abs(p2 - p) < 2, `Druck muss stehen, drift ${(p2 - p).toFixed(2)} bar`);
  assert(p2 < 80, `Kein Druckdurchgehen, war ${p2} bar`);
  return { systemdruck_bar: +p2.toFixed(1), dbv_oeffnung: +relief.sim.open.toFixed(2) };
});

test('Gate 8b: Handhebel fährt den Hydrozylinder, Mittelstellung stoppt ihn', () => {
  const c = new Circuit();
  const pump = c.add('h_pump', 200, 400);
  const tank = c.add('h_tank', 200, 560);
  const relief = c.add('h_relief', 340, 400);
  const tank2 = c.add('h_tank', 340, 560);
  const valve = c.add('h_v43_closed', 520, 240);
  const cyl = c.add('h_cyl', 500, 60);
  pump.params.flow.value = 12;

  c.connect({ inst: pump.id, port: 'P' }, { inst: relief.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'P' }, { inst: valve.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'T' }, { inst: tank.id, port: 'T' });
  c.connect({ inst: relief.id, port: 'T' }, { inst: tank2.id, port: 'T' });
  c.connect({ inst: valve.id, port: 'T' }, { inst: tank2.id, port: 'T' });
  c.connect({ inst: valve.id, port: 'A' }, { inst: cyl.id, port: 'A' });
  c.connect({ inst: valve.id, port: 'B' }, { inst: cyl.id, port: 'B' });

  const sim = new Simulation(c);
  run(sim, 0.5);
  assert(cyl.sim.x < 0.02, 'Grundstellung eingefahren');

  valve.sim.lever = 1;  // right box: P->A, extend
  const tOut = timeUntil(sim, () => cyl.sim.x > 0.95, 12);
  assert(tOut !== null, 'Zylinder fährt nicht aus');

  valve.sim.lever = 0;  // centre: blocked, must hold
  const held = cyl.sim.x;
  run(sim, 2.0);
  assert(Math.abs(cyl.sim.x - held) < 0.01,
    `Sperrmittelstellung muss halten, drift ${(cyl.sim.x - held).toFixed(4)}`);

  valve.sim.lever = -1; // left box: P->B, retract
  const tBack = timeUntil(sim, () => cyl.sim.x < 0.05, 12);
  assert(tBack !== null, 'Zylinder fährt nicht ein');
  return { ausfahrzeit_s: tOut, einfahrzeit_s: tBack };
});

test('Gate 9: Senkbremsventil hält die hängende Last, Schwimmstellung ohne sie nicht', () => {
  // The comparison has to be against a *float* centre. Against a closed centre the
  // trapped oil column holds the load all by itself and the counterbalance proves
  // nothing — which is exactly what the first version of this test accidentally measured.
  const build = (withCB) => {
    const c = new Circuit();
    const pump = c.add('h_pump', 200, 480);
    const tank = c.add('h_tank', 200, 620);
    const relief = c.add('h_relief', 340, 480);
    const tank2 = c.add('h_tank', 340, 620);
    const valve = c.add('h_v43_float', 520, 320);
    const cyl = c.add('h_cyl', 500, 60);
    pump.params.flow.value = 10;
    relief.params.setpoint.value = 200;
    // Overrunning load: 12 kN over the 9.42 cm² rod annulus is ~127 bar of holding pressure.
    cyl.params.load.value = -12000;
    cyl.params.coulomb.value = 0; // no friction to hide behind — the valve must do the work

    c.connect({ inst: pump.id, port: 'P' }, { inst: relief.id, port: 'P' });
    c.connect({ inst: pump.id, port: 'P' }, { inst: valve.id, port: 'P' });
    c.connect({ inst: pump.id, port: 'T' }, { inst: tank.id, port: 'T' });
    c.connect({ inst: relief.id, port: 'T' }, { inst: tank2.id, port: 'T' });
    c.connect({ inst: valve.id, port: 'T' }, { inst: tank2.id, port: 'T' });
    c.connect({ inst: valve.id, port: 'A' }, { inst: cyl.id, port: 'A' });

    if (withCB) {
      const cb = c.add('h_counterbalance', 660, 200);
      // Set above the pressure the load itself generates, as these valves are — roughly
      // 1.3x of 127 bar. Set below it the valve is just a relief and the load walks
      // straight through, which is what a first run at 90 bar showed.
      cb.params.setpoint.value = 170;
      c.connect({ inst: cyl.id, port: 'B' }, { inst: cb.id, port: '2' });
      c.connect({ inst: cb.id, port: '1' }, { inst: valve.id, port: 'B' });
      c.connect({ inst: cb.id, port: 'X' }, { inst: valve.id, port: 'A' });
      return { c, cyl, valve, cb };
    }
    c.connect({ inst: cyl.id, port: 'B' }, { inst: valve.id, port: 'B' });
    return { c, cyl, valve, cb: null };
  };

  const measure = (withCB) => {
    const { c, cyl, valve, cb } = build(withCB);
    const sim = new Simulation(c);
    cyl.sim.x = 0.5;
    valve.sim.lever = 0; // float centre: A and B both to tank, nothing commanded
    // Let it settle first. A load on a trapped oil column *does* sink while it compresses
    // that column — ~14 mm here at beta = 1.2e8 — and that is compliance, not creep.
    run(sim, 1.5);
    const settled = cyl.sim.x;
    run(sim, 3.0);
    return { settled, after: cyl.sim.x, drift: cyl.sim.x - settled, cb };
  };

  const withCB = measure(true);
  const without = measure(false);

  assert(withCB.settled > 0.35,
    `Mit Senkbremse darf die Last nicht durchsacken, landete bei ${withCB.settled.toFixed(3)}`);
  assert(Math.abs(withCB.drift) < 0.01,
    `Mit Senkbremse darf nichts kriechen, drift ${withCB.drift.toFixed(4)} Hub in 3 s`);
  assert(without.after > 0.97,
    `Ohne Senkbremse muss die Last in Schwimmstellung durchgehen, blieb bei ${without.after.toFixed(3)}`);
  assert(withCB.cb.sim.open < 0.01,
    `Senkbremse muss geschlossen halten, Öffnung ${withCB.cb.sim.open.toFixed(4)}`);
  return {
    mit_senkbremse: `hält bei ${(withCB.settled * 100).toFixed(0)} %, Drift ${(withCB.drift * 200).toFixed(2)} mm in 3 s`,
    ohne_senkbremse: `sackt auf ${(without.after * 100).toFixed(0)} % durch`,
  };
});

test('Hydraulik: Öl kavitiert statt negativ zu werden; Solver konvergiert', () => {
  const c = new Circuit();
  const pump = c.add('h_pump', 200, 400);
  const tank = c.add('h_tank', 200, 560);
  const relief = c.add('h_relief', 340, 400);
  const tank2 = c.add('h_tank', 340, 560);
  const valve = c.add('h_v43_closed', 520, 240);
  const cyl = c.add('h_cyl', 500, 60);
  cyl.params.load.value = -8000; // pulls hard on a chamber the valve has shut
  c.connect({ inst: pump.id, port: 'P' }, { inst: relief.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'P' }, { inst: valve.id, port: 'P' });
  c.connect({ inst: pump.id, port: 'T' }, { inst: tank.id, port: 'T' });
  c.connect({ inst: relief.id, port: 'T' }, { inst: tank2.id, port: 'T' });
  c.connect({ inst: valve.id, port: 'T' }, { inst: tank2.id, port: 'T' });
  c.connect({ inst: valve.id, port: 'A' }, { inst: cyl.id, port: 'A' });
  c.connect({ inst: valve.id, port: 'B' }, { inst: cyl.id, port: 'B' });

  const sim = new Simulation(c);
  run(sim, 3.0);
  for (let i = 0; i < sim.ph.length; i++) {
    assert(Number.isFinite(sim.ph[i]), 'Hydraulikdruck ist NaN');
    assert(sim.ph[i] > 0, `Absolutdruck darf nie negativ werden, war ${sim.ph[i]} Pa`);
  }
  assert(cyl.sim.x >= 0 && cyl.sim.x <= 1, `Kolben außerhalb des Hubs: ${cyl.sim.x}`);
  assert(sim.diagnostics.failures === 0, `${sim.diagnostics.failures} Ticks ohne Konvergenz`);
  return {
    min_bar: +barG(Math.min(...sim.ph)).toFixed(2),
    max_bar: +barG(Math.max(...sim.ph)).toFixed(1),
    hyd_iterationen: sim.diagnostics.hydIterations,
  };
});

// ---------------------------------------------------------------------------
// Parts list
// ---------------------------------------------------------------------------

test('Stückliste: gruppiert, trennt nach Ausführung, zählt vollständig', async () => {
  const { buildParts, partsToCSV, totalParts } = await import('../src/partslist.js');

  const c = EXAMPLES.sequence.build();
  const rows = buildParts(c);
  assert(totalParts(rows) === c.instances.length,
    `Stückliste muss jedes Bauteil zählen: ${totalParts(rows)} von ${c.instances.length}`);
  assert(rows.length < c.instances.length, 'Gleiche Bauteile müssen zusammengefasst werden');

  // Four identical roller valves must collapse into one row of 4.
  const rollers = rows.find((r) => r.def.id === 'v32_roller');
  assert(rollers && rollers.count === 4, `4 Rollenhebelventile erwartet, war ${rollers?.count}`);
  assert(rollers.tags.join(' ') === '1S2 1S3 2S1 2S2',
    `Kennzeichen müssen natürlich sortiert sein, waren ${rollers.tags.join(' ')}`);

  // Different bore = different line item, even though the type is the same.
  const c2 = new Circuit();
  const a = c2.add('cyl_double', 0, 0);
  const b = c2.add('cyl_double', 200, 0);
  b.params.bore.value = 50;
  const rows2 = buildParts(c2);
  assert(rows2.length === 2,
    `Unterschiedliche Kolben-Ø müssen getrennte Positionen sein, waren ${rows2.length}`);

  // Same bore = one line item of 2.
  b.params.bore.value = a.params.bore.value;
  assert(buildParts(c2).length === 1, 'Gleiche Ausführung muss zusammengefasst werden');

  // Mixed sheet sorts pneumatics before hydraulics before electrics.
  const c3 = EXAMPLES.hydPress.build();
  const rows3 = buildParts(c3);
  const domains = rows3.map((r) => r.domain);
  assert(domains.every((d, i) => i === 0 || d >= domains[i - 1]), 'Bereiche müssen sortiert sein');

  const csv = partsToCSV(rows);
  const lines = csv.trim().split('\n');
  assert(lines.length === rows.length + 1, 'CSV braucht eine Kopfzeile plus je Position eine');
  assert(lines[0] === 'Item,Quantidade,Identificação,Componente,Especificação,Grupo,Área', 'CSV-Kopfzeile fehlt');
  return {
    positionen: rows.length,
    bauteile: totalParts(rows),
    rollenhebel: `${rollers.count}× ${rollers.tags.join(' ')}`,
  };
});

test('Stückliste: scharfe Fehler werden ausgewiesen', async () => {
  const { buildParts } = await import('../src/partslist.js');
  const c = EXAMPLES.sequence.build();
  byTag(c, '2V1').faults = { stuck: true };
  const rows = buildParts(c);
  const flagged = rows.filter((r) => r.faults > 0);
  assert(flagged.length === 1, `Genau eine Position mit Fehler erwartet, waren ${flagged.length}`);
  assert(flagged[0].faults === 1, 'Fehleranzahl stimmt nicht');
  return { markiert: flagged[0].def.short };
});

// ---------------------------------------------------------------------------
// Digital
// ---------------------------------------------------------------------------

/** Two switchable rails feeding a gate, output read on a coil. */
function gateRig(gateType) {
  const c = new Circuit();
  const p24 = c.add('rail_24v', 60, 40);
  const p0 = c.add('rail_0v', 60, 400);
  const a = c.add('btn_no', 66, 100);
  const b = c.add('btn_no', 166, 100);
  const gate = c.add(gateType, 280, 180);
  const lamp = c.add('lamp', 420, 200);
  const p0b = c.add('rail_0v', 423, 320);
  a.params.tag.value = 'S1';
  b.params.tag.value = 'S2';
  lamp.params.tag.value = 'P1';

  c.connect({ inst: p24.id, port: 'a' }, { inst: a.id, port: 'a' });
  c.connect({ inst: p24.id, port: 'a' }, { inst: b.id, port: 'a' });
  const def = c.defOf(gate);
  const ins = def.ports.filter((p) => p.id !== 'Q');
  c.connect({ inst: a.id, port: 'b' }, { inst: gate.id, port: ins[0].id });
  if (ins[1]) c.connect({ inst: b.id, port: 'b' }, { inst: gate.id, port: ins[1].id });
  // No pull-down wire: a wire to 0V is a *short*, not a resistor, and union-find would
  // merge the input straight into the 0V net — which is what a first run of this test
  // did, leaving both inputs shorted together at 8 V. The engine already references
  // every floating node to 0 V, so an open switch reads low on its own.
  c.connect({ inst: gate.id, port: 'Q' }, { inst: lamp.id, port: 'a' });
  c.connect({ inst: lamp.id, port: 'b' }, { inst: p0b.id, port: 'a' });
  return { c, a, b, gate, lamp };
}

test('Digital: Gatter erfüllen ihre Wahrheitstabelle am echten Netz', () => {
  const table = {
    d_and: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 1]],
    d_or: [[0, 0, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]],
    d_nand: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 0]],
    d_nor: [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
    d_xor: [[0, 0, 0], [1, 0, 1], [0, 1, 1], [1, 1, 0]],
  };
  const report = {};
  for (const [type, rows] of Object.entries(table)) {
    const { c, a, b, gate } = gateRig(type);
    const sim = new Simulation(c);
    for (const [A, B, Q] of rows) {
      a.sim.pressed = !!A;
      b.sim.pressed = !!B;
      run(sim, 0.05);
      const got = sim.volts(gate.id, 'Q') > 12 ? 1 : 0;
      assert(got === Q, `${type}(${A},${B}) muss ${Q} sein, war ${got}`);
    }
    report[type] = 'ok';
  }
  return report;
});

test('Digital: NICHT invertiert; Gatterkette schwingt in einem Tick ein', () => {
  const { c, a, gate } = gateRig('d_not');
  const sim = new Simulation(c);
  a.sim.pressed = false; run(sim, 0.05);
  assert(sim.volts(gate.id, 'Q') > 12, 'NOT(0) muss 1 sein');
  a.sim.pressed = true; run(sim, 0.05);
  assert(sim.volts(gate.id, 'Q') < 12, 'NOT(1) muss 0 sein');

  // A chain of gates must resolve inside one tick, not one gate per tick.
  const c2 = new Circuit();
  const p24 = c2.add('rail_24v', 40, 40);
  const p0 = c2.add('rail_0v', 40, 400);
  const sw = c2.add('btn_no', 46, 100);
  const g = [];
  for (let i = 0; i < 5; i++) g.push(c2.add('d_not', 150 + i * 80, 200));
  c2.connect({ inst: p24.id, port: 'a' }, { inst: sw.id, port: 'a' });
  c2.connect({ inst: sw.id, port: 'b' }, { inst: g[0].id, port: 'A' });
  for (let i = 1; i < 5; i++) c2.connect({ inst: g[i - 1].id, port: 'Q' }, { inst: g[i].id, port: 'A' });

  const sim2 = new Simulation(c2);
  sw.sim.pressed = true;
  sim2.step(1e-3); // exactly one tick
  // Five inversions is an *odd* count, so a high input arrives low. (A first version of
  // this test asserted high and was simply wrong about the parity — the model was right.)
  assert(sim2.volts(g[4].id, 'Q') < 12,
    `5× NOT von 1 muss 0 sein, Ausgang war ${sim2.volts(g[4].id, 'Q').toFixed(1)} V`);
  assert(sim2.volts(g[3].id, 'Q') > 12,
    `4× NOT von 1 muss 1 sein, Ausgang war ${sim2.volts(g[3].id, 'Q').toFixed(1)} V`);

  sw.sim.pressed = false;
  sim2.step(1e-3);
  assert(sim2.volts(g[4].id, 'Q') > 12, '5× NOT von 0 muss 1 sein');

  // The whole chain resolving in one tick is the point: one pass per gate would need
  // five ticks, and an 8-bit adder would take 8 ms.
  assert(sim2.diagnostics.digitalPasses > 1 && sim2.diagnostics.digitalPasses <= 24,
    `Settle-Durchläufe unplausibel: ${sim2.diagnostics.digitalPasses}`);
  return { kette: '5× NOT in 1 Tick, Parität stimmt', durchlaeufe: sim2.diagnostics.digitalPasses };
});

test('Digital: RS-Flipflop speichert, D-FF taktet, Zähler zählt bis Vorwahl', () => {
  // RS latch
  const c = new Circuit();
  const p24 = c.add('rail_24v', 40, 40);
  const p0 = c.add('rail_0v', 40, 400);
  const set = c.add('btn_no', 46, 100);
  const rst = c.add('btn_no', 146, 100);
  const ff = c.add('d_rs', 260, 180);
  c.connect({ inst: p24.id, port: 'a' }, { inst: set.id, port: 'a' });
  c.connect({ inst: p24.id, port: 'a' }, { inst: rst.id, port: 'a' });
  c.connect({ inst: set.id, port: 'b' }, { inst: ff.id, port: 'S' });
  c.connect({ inst: rst.id, port: 'b' }, { inst: ff.id, port: 'R' });

  const sim = new Simulation(c);
  run(sim, 0.02);
  assert(sim.volts(ff.id, 'Q') < 12, 'RS-FF muss zurückgesetzt starten');
  tap(sim, set, 20); run(sim, 0.2);
  assert(sim.volts(ff.id, 'Q') > 12, 'Setz-Puls muss speichern');
  assert(sim.volts(ff.id, 'Qn') < 12, 'Q̄ muss invers zu Q sein');
  run(sim, 1.0);
  assert(sim.volts(ff.id, 'Q') > 12, 'RS-FF muss ohne Signal halten');
  tap(sim, rst, 20); run(sim, 0.2);
  assert(sim.volts(ff.id, 'Q') < 12, 'Rücksetz-Puls muss löschen');
  // Set-dominant with both high.
  set.sim.pressed = true; rst.sim.pressed = true; run(sim, 0.1);
  assert(sim.volts(ff.id, 'Q') > 12, 'Bei S und R muss Setzen dominieren');

  // Counter driven by a clock
  const c2 = new Circuit();
  const clk = c2.add('d_clock', 40, 100);
  const cnt = c2.add('d_counter', 200, 100);
  clk.params.period.value = 0.2; // 5 Hz -> a rising edge every 0.2 s
  cnt.params.preset.value = 3;
  c2.connect({ inst: clk.id, port: 'Q' }, { inst: cnt.id, port: 'C' });

  const sim2 = new Simulation(c2);
  run(sim2, 0.75); // ~3 rising edges
  assert(cnt.sim.count >= 3, `Zähler muss zählen, stand bei ${cnt.sim.count}`);
  assert(sim2.volts(cnt.id, 'Q') > 12, 'Zähler muss bei Vorwahl schalten');
  return { rs: 'hält, setz-dominant', zaehler: `${cnt.sim.count} bei Vorwahl 3` };
});

test('Durchgehende Kolbenstange: gleiche Fläche, gleiche Zeit in beide Richtungen', () => {
  /** Same circuit twice, only the cylinder type differs. */
  const strokeTimes = (type) => {
    const c = new Circuit();
    const cyl = c.add(type, 340, 60);
    const main = c.add('v52_pilot', 350, 240);
    const s1 = c.add('v32_button', 190, 400);
    const s2 = c.add('v32_button', 510, 400);
    const src = c.add('supply', 350, 520);
    c.connect({ inst: main.id, port: '4' }, { inst: cyl.id, port: '1' });
    c.connect({ inst: main.id, port: '2' }, { inst: cyl.id, port: '2' });
    for (const v of [main, s1, s2]) c.connect({ inst: src.id, port: '1' }, { inst: v.id, port: '1' });
    c.connect({ inst: s1.id, port: '2' }, { inst: main.id, port: '14' });
    c.connect({ inst: s2.id, port: '2' }, { inst: main.id, port: '12' });

    const sim = new Simulation(c);
    run(sim, 0.3);
    tap(sim, s1, 60);
    const out = timeUntil(sim, () => cyl.sim.x > 0.97);
    tap(sim, s2, 60);
    const back = timeUntil(sim, () => cyl.sim.x < 0.03);
    assert(out !== null && back !== null, `${type} fährt nicht`);
    return { out, back };
  };

  const through = strokeTimes('cyl_through');
  const normal = strokeTimes('cyl_double');

  // Equal areas both sides: the two strokes must take essentially the same time.
  const sym = Math.abs(through.out - through.back) / through.out;
  assert(sym < 0.12,
    `Durchgehende Stange muss symmetrisch sein: aus ${through.out}s, ein ${through.back}s (${(sym * 100).toFixed(0)} % Abweichung)`);

  // And a normal cylinder must NOT be symmetric — otherwise the test proves nothing.
  const asym = Math.abs(normal.out - normal.back) / normal.out;
  assert(asym > sym,
    `Normaler Zylinder muss unsymmetrischer sein als der durchgehende: ${(asym * 100).toFixed(0)} % vs ${(sym * 100).toFixed(0)} %`);
  return {
    durchgehend: `${through.out}s / ${through.back}s — ${(sym * 100).toFixed(0)} % Abweichung`,
    normal: `${normal.out}s / ${normal.back}s — ${(asym * 100).toFixed(0)} % Abweichung`,
  };
});

// ---------------------------------------------------------------------------
// Electro-pneumatics: time relays, counter, e-stop
// ---------------------------------------------------------------------------

/** Button -> relay -> its contact -> lamp. The contact is what proves the delay. */
function relayRig(relayType) {
  const c = new Circuit();
  const p24 = c.add('rail_24v', 60, 40);
  const p0 = c.add('rail_0v', 60, 400);
  const btn = c.add('btn_no', 66, 100);
  const relay = c.add(relayType, 63, 220);
  const p24b = c.add('rail_24v', 260, 40);
  const p0b = c.add('rail_0v', 260, 400);
  const contact = c.add('contact_no', 266, 120);
  const lamp = c.add('lamp', 263, 240);
  btn.params.tag.value = 'S1';
  relay.params.tag.value = 'K1';
  contact.params.tag.value = 'K1';
  lamp.params.tag.value = 'P1';

  c.connect({ inst: p24.id, port: 'a' }, { inst: btn.id, port: 'a' });
  c.connect({ inst: btn.id, port: 'b' }, { inst: relay.id, port: 'a' });
  c.connect({ inst: relay.id, port: 'b' }, { inst: p0.id, port: 'a' });
  c.connect({ inst: p24b.id, port: 'a' }, { inst: contact.id, port: 'a' });
  c.connect({ inst: contact.id, port: 'b' }, { inst: lamp.id, port: 'a' });
  c.connect({ inst: lamp.id, port: 'b' }, { inst: p0b.id, port: 'a' });
  return { c, btn, relay, lamp };
}

test('E-Pneumatik: Anzugsverzögertes Relais schaltet spät und setzt bei Stromverlust zurück', () => {
  const measured = [];
  for (const delay of [0.5, 1.5, 3.0]) {
    const { c, btn, relay } = relayRig('relay_on_delay');
    relay.params.delay.value = delay;
    const sim = new Simulation(c);
    run(sim, 0.1);
    btn.sim.pressed = true;
    const t0 = sim.time;
    const t = timeUntil(sim, () => sim.energized.get('K1') === true, delay + 2);
    assert(t !== null, `Relais zieht bei ${delay}s nie an`);
    const actual = sim.time - t0;
    // A tick or two of relay pickup is expected; anything more is the delay being wrong.
    close(actual, delay, 0.05, `Anzugsverzögerung bei Sollwert ${delay}s`);
    measured.push(`${delay}s → ${actual.toFixed(2)}s`);
  }

  // The coil is live immediately; only the contacts wait. That distinction is the component.
  const { c, btn, relay, lamp } = relayRig('relay_on_delay');
  relay.params.delay.value = 2;
  const sim = new Simulation(c);
  run(sim, 0.1);
  btn.sim.pressed = true;
  run(sim, 0.5);
  assert(relay.sim.on === true, 'Spule muss sofort bestromt sein');
  assert(relay.sim.out === false, 'Kontakte dürfen vor Ablauf nicht schalten');
  assert(lamp.sim.on === false, 'Lampe darf vor Ablauf nicht leuchten');

  // Losing power before the delay elapses must abort, not accumulate.
  btn.sim.pressed = false; run(sim, 0.2);
  assert(relay.sim.elapsed === 0, 'Stromverlust muss die Zeit zurücksetzen');
  btn.sim.pressed = true; run(sim, 1.5);
  assert(relay.sim.out === false, 'Nach Reset darf die alte Zeit nicht weiterzählen');
  run(sim, 0.7);
  assert(relay.sim.out === true && lamp.sim.on === true, 'Nach voller Zeit muss geschaltet werden');
  return { gemessen: measured.join(', '), spule_sofort_kontakt_spaet: true };
});

test('E-Pneumatik: Abfallverzögertes Relais hält nach Stromverlust', () => {
  const { c, btn, relay, lamp } = relayRig('relay_off_delay');
  relay.params.delay.value = 1.5;
  const sim = new Simulation(c);
  run(sim, 0.1);

  btn.sim.pressed = true;
  run(sim, 0.05);
  assert(relay.sim.out === true, 'Abfallverzögert muss sofort anziehen');
  assert(lamp.sim.on === true, 'Lampe muss sofort leuchten');

  btn.sim.pressed = false;
  run(sim, 1.0);
  assert(relay.sim.out === true, `Muss 1,5 s nachhalten, fiel nach 1,0 s ab`);
  assert(lamp.sim.on === true, 'Lampe muss während der Nachlaufzeit leuchten');

  const t = timeUntil(sim, () => relay.sim.out === false, 2);
  assert(t !== null, 'Relais fällt nie ab');
  close(1.0 + t, 1.5, 0.05, 'Abfallverzögerung');
  return { nachlauf_s: +(1.0 + t).toFixed(2) };
});

test('E-Pneumatik: Relaiszähler zählt Flanken und schaltet bei Vorwahl', () => {
  const c = new Circuit();
  const p24 = c.add('rail_24v', 60, 40);
  const p0 = c.add('rail_0v', 60, 400);
  const btn = c.add('btn_no', 66, 100);
  const cnt = c.add('relay_counter', 60, 220);
  cnt.params.tag.value = 'C1';
  cnt.params.preset.value = 3;
  c.connect({ inst: p24.id, port: 'a' }, { inst: btn.id, port: 'a' });
  c.connect({ inst: btn.id, port: 'b' }, { inst: cnt.id, port: 'a' });
  c.connect({ inst: cnt.id, port: 'b' }, { inst: p0.id, port: 'a' });

  const sim = new Simulation(c);
  run(sim, 0.1);
  assert(cnt.sim.count === 0, 'Zähler muss bei 0 starten');

  for (let i = 1; i <= 3; i++) {
    tap(sim, btn, 40); run(sim, 0.05);
    assert(cnt.sim.count === i, `Nach ${i} Tastendrücken muss der Stand ${i} sein, war ${cnt.sim.count}`);
  }
  assert(sim.energized.get('C1') === true, 'Bei Vorwahl muss der Zähler schalten');

  // Holding must count exactly once — it counts edges, not time. (Pressing again is a
  // legitimate 4th edge; a first version of this test wrongly expected the count to stay
  // at 3 across a fresh press.)
  btn.sim.pressed = true; run(sim, 0.05);
  assert(cnt.sim.count === 4, `Neuer Tastendruck ist eine Flanke, Stand ${cnt.sim.count}`);
  run(sim, 1.5);
  assert(cnt.sim.count === 4, `Halten darf nicht weiterzählen, Stand ${cnt.sim.count}`);
  return { stand: cnt.sim.count, schaltet_bei: 3, zaehlt: 'Flanken, nicht Zeit' };
});

test('E-Pneumatik: NOT-HALT rastet und unterbricht die Selbsthaltung', () => {
  const c = EXAMPLES.electro.build();
  const cyl = first(c, 'cyl_double');
  const s1 = byTag(c, 'S1');
  // Splice an e-stop into the holding rung, ahead of the coil.
  const stop = byTag(c, 'S2');
  const es = c.add('estop', 60, 520);
  es.params.tag.value = 'S0';
  // By *type*, not by tag: the coil and its contacts deliberately share the tag 'K1', so
  // byTag would return whichever was added first — which is the contact.
  const coil = first(c, 'relay_coil');
  // Re-route: stop.b -> estop.a -> estop.b -> coil.a
  c.wires = c.wires.filter((w) =>
    !(w.from.inst === stop.id && w.from.port === 'b' && w.to.inst === coil.id));
  c.connect({ inst: stop.id, port: 'b' }, { inst: es.id, port: 'a' });
  c.connect({ inst: es.id, port: 'b' }, { inst: coil.id, port: 'a' });
  c.touch();

  const sim = new Simulation(c);
  run(sim, 0.2);
  tap(sim, s1, 60);
  run(sim, 1.2);
  assert(cyl.sim.x > 0.97, `Zylinder muss ausfahren, war ${cyl.sim.x}`);
  assert(sim.energized.get('K1') === true, 'Selbsthaltung muss greifen');

  es.sim.pressed = true; // latch
  run(sim, 1.5);
  assert(sim.energized.get('K1') === false, 'NOT-HALT muss die Selbsthaltung unterbrechen');
  assert(cyl.sim.x < 0.03, `Zylinder muss zurückfahren, war ${cyl.sim.x}`);

  // Latched: releasing the start button does not restart anything.
  tap(sim, s1, 60); run(sim, 1.0);
  assert(cyl.sim.x < 0.03, 'Bei gerastetem NOT-HALT darf Start nichts bewirken');

  es.sim.pressed = false; // deliberate release
  tap(sim, s1, 60); run(sim, 1.2);
  assert(cyl.sim.x > 0.97, 'Nach Entriegeln muss Start wieder wirken');
  return { rastet: true, start_wirkungslos_bei_notaus: true };
});

// ---------------------------------------------------------------------------
// Gate 12 — GRAFCET (EN 60848)
// ---------------------------------------------------------------------------

test('GRAFCET: Transitionsbedingungen — Operatoren, Vorrang, Klammern, Flanken, Zeit', async () => {
  const { parseReceptivity, receptivityError } = await import('../src/grafcet.js');
  const sig = {};
  const ctx = { signal: (t) => !!sig[t], stepActive: () => false, stepTime: () => 0 };
  const ev = (src) => parseReceptivity(src)(ctx);

  assert(ev('1') === true && ev('0') === false, 'Konstanten');
  sig.a = true; sig.b = false;
  assert(ev('a') === true && ev('b') === false, 'Signale');
  assert(ev('/b') === true && ev('!a') === false, 'Negation, beide Schreibweisen');
  assert(ev('a * b') === false && ev('a + b') === true, 'UND / ODER');

  // Precedence: AND binds tighter than OR. Without that, "b + a * b" reads as
  // "(b + a) * b" = false, and every real receptivity would be wrong.
  sig.c = true;
  assert(ev('b + a * c') === true, 'UND muss stärker binden als ODER');
  assert(ev('(b + a) * b') === false, 'Klammern müssen den Vorrang umkehren');

  // Timing on a step
  const ctx2 = { signal: () => false, stepActive: (n) => n === '2', stepTime: (n) => (n === '2' ? 4.0 : 0) };
  assert(parseReceptivity('X2')(ctx2) === true, 'Schrittaktivität X2');
  assert(parseReceptivity('t/X2/3s')(ctx2) === true, 'Zeit erfüllt');
  assert(parseReceptivity('t/X2/5s')(ctx2) === false, 'Zeit nicht erfüllt');

  // Edges: true only on the transition, not while the level holds.
  const edge = parseReceptivity('↑a');
  sig.a = false; edge(ctx);          // seed
  sig.a = true;
  assert(edge(ctx) === true, 'Steigende Flanke muss auslösen');
  assert(edge(ctx) === false, 'Flanke darf nur einmal auslösen');

  assert(receptivityError('a * * b') !== null, 'Syntaxfehler muss gemeldet werden');
  assert(receptivityError('a * b') === null, 'Gültiger Ausdruck darf nicht meckern');
  return { operatoren: 'ok', vorrang: 'UND vor ODER', flanken: 'einmalig' };
});

test('Gate 12a: Parallelzweig konvergiert erst, wenn ALLE Zweige fertig sind', async () => {
  const { Grafcet } = await import('../src/grafcet.js');
  const g = new Grafcet();
  const s0 = g.addStep({ name: '0', initial: true });
  const a1 = g.addStep({ name: '1' });   // branch A
  const a2 = g.addStep({ name: '2' });   // branch A, final
  const b1 = g.addStep({ name: '3' });   // branch B
  const b2 = g.addStep({ name: '4' });   // branch B, final
  const s9 = g.addStep({ name: '9' });

  const sig = {};
  const io = { signal: (t) => !!sig[t] };

  g.addTransition({ from: [s0.id], to: [a1.id, b1.id], receptivity: 'start' }); // AND divergence
  g.addTransition({ from: [a1.id], to: [a2.id], receptivity: 'a' });
  g.addTransition({ from: [b1.id], to: [b2.id], receptivity: 'b' });
  g.addTransition({ from: [a2.id, b2.id], to: [s9.id], receptivity: '1' });     // AND convergence
  g.reset();

  assert(g.isActive(s0.id), 'Initialschritt muss aktiv starten');
  sig.start = true; g.step(0.001, io); sig.start = false;
  assert(g.isActive(a1.id) && g.isActive(b1.id), 'Divergenz muss beide Zweige aktivieren');
  assert(!g.isActive(s0.id), 'Vorgängerschritt muss deaktiviert werden');

  // Only branch A advances. The convergence must NOT fire.
  sig.a = true; g.step(0.001, io); sig.a = false;
  assert(g.isActive(a2.id), 'Zweig A muss vorrücken');
  assert(g.isActive(b1.id), 'Zweig B darf nicht mitrücken');
  assert(!g.isActive(s9.id), 'Konvergenz darf mit nur einem fertigen Zweig NICHT feuern');

  // Now B finishes too — convergence fires, and the whole chain runs through in one
  // evolution because the convergence receptivity is already true.
  sig.b = true; g.step(0.001, io); sig.b = false;
  assert(g.isActive(s9.id), 'Konvergenz muss feuern, wenn alle Zweige fertig sind');
  assert(!g.isActive(a2.id) && !g.isActive(b2.id), 'Beide Zweige müssen deaktiviert werden');
  return { divergenz: 'ok', konvergenz: 'wartet auf alle Zweige' };
});

test('Gate 12b: Alternativzweig nimmt genau einen Pfad', async () => {
  const { Grafcet } = await import('../src/grafcet.js');
  const build = () => {
    const g = new Grafcet();
    const s0 = g.addStep({ name: '0', initial: true });
    const l = g.addStep({ name: '1' });
    const r = g.addStep({ name: '2' });
    g.addTransition({ from: [s0.id], to: [l.id], receptivity: 'links' });
    g.addTransition({ from: [s0.id], to: [r.id], receptivity: '/links * rechts' });
    g.reset();
    return { g, s0, l, r };
  };

  const a = build();
  a.g.step(0.001, { signal: (t) => t === 'links' });
  assert(a.g.isActive(a.l.id) && !a.g.isActive(a.r.id), 'Nur der linke Pfad darf aktiv werden');

  const b = build();
  b.g.step(0.001, { signal: (t) => t === 'rechts' });
  assert(b.g.isActive(b.r.id) && !b.g.isActive(b.l.id), 'Nur der rechte Pfad darf aktiv werden');
  return { alternative: 'genau ein Pfad' };
});


test('Gate 12c: GRAFCET steuert echte Pneumatik — A+ B+ A− B− ohne Endlagenventile', async () => {
  const { Grafcet } = await import('../src/grafcet.js');

  // The point of a chart: the sequence logic lives in the specification, and the circuit
  // shrinks to actuators, valves and sensors. No AND valve, no signal-overlap gymnastics —
  // the chart structurally cannot fire a transition out of turn.
  const c = new Circuit();
  const A = c.add('cyl_double', 300, 60);
  const B = c.add('cyl_double', 300, 200);
  A.params.tag.value = '1A1'; B.params.tag.value = '2A1';

  const V1 = c.add('v52_sol_spring', 250, 380);
  const V2 = c.add('v52_sol_spring', 620, 380);
  V1.params.tag.value = '1V1'; V1.params.solA.value = 'A_PLUS';
  V2.params.tag.value = '2V1'; V2.params.solA.value = 'B_PLUS';
  const src = c.add('supply', 400, 560);

  const mk = (tag, target, at) => {
    const s = c.add('limit_switch', 200, 540);
    s.params.tag.value = tag;
    s.params.target.value = target.id;
    s.params.at.value = at;
    return s;
  };
  mk('a0', A, 0); mk('a1', A, 1); mk('b0', B, 0); mk('b1', B, 1);
  const start = c.add('btn_no', 100, 540);
  start.params.tag.value = 'S1';

  c.connect({ inst: V1.id, port: '4' }, { inst: A.id, port: '1' });
  c.connect({ inst: V1.id, port: '2' }, { inst: A.id, port: '2' });
  c.connect({ inst: V2.id, port: '4' }, { inst: B.id, port: '1' });
  c.connect({ inst: V2.id, port: '2' }, { inst: B.id, port: '2' });
  c.connect({ inst: src.id, port: '1' }, { inst: V1.id, port: '1' });
  c.connect({ inst: src.id, port: '1' }, { inst: V2.id, port: '1' });

  // Chart: 0 -S1*a0*b0-> 1(A+) -a1-> 2(B+) -b1-> 3(A−) -a0-> 4(B−) -b0-> 0
  const g = new Grafcet();
  const s0 = g.addStep({ name: '0', initial: true });
  const s1 = g.addStep({ name: '1', actions: [{ kind: 'continuous', target: 'A_PLUS' }] });
  const s2 = g.addStep({ name: '2', actions: [
    { kind: 'continuous', target: 'A_PLUS' }, { kind: 'continuous', target: 'B_PLUS' }] });
  const s3 = g.addStep({ name: '3', actions: [{ kind: 'continuous', target: 'B_PLUS' }] });
  const s4 = g.addStep({ name: '4', actions: [] });
  g.addTransition({ from: [s0.id], to: [s1.id], receptivity: 'S1 * a0 * b0' });
  g.addTransition({ from: [s1.id], to: [s2.id], receptivity: 'a1' });
  g.addTransition({ from: [s2.id], to: [s3.id], receptivity: 'b1' });
  g.addTransition({ from: [s3.id], to: [s4.id], receptivity: 'a0' });
  g.addTransition({ from: [s4.id], to: [s0.id], receptivity: 'b0' });

  const sim = new Simulation(c);
  sim.chart = g;
  g.reset();

  run(sim, 0.2);
  assert(g.isActive(s0.id), 'Chart muss im Initialschritt stehen');
  assert(A.sim.x < 0.05 && B.sim.x < 0.05, 'Grundstellung: beide eingefahren');

  // Record transitions, not states — sampling "is A out" says nothing about order.
  const seen = [];
  const edge = (x, prev) => (x > 0.97 ? 'out' : x < 0.03 ? 'in' : prev);
  let aPrev = 'in', bPrev = 'in';

  start.sim.pressed = true;
  for (let i = 0; i < 12000; i++) {
    sim.step(1e-3);
    const aNow = edge(A.sim.x, aPrev);
    const bNow = edge(B.sim.x, bPrev);
    if (aNow !== aPrev) { seen.push(aNow === 'out' ? 'A+' : 'A-'); aPrev = aNow; }
    if (bNow !== bPrev) { seen.push(bNow === 'out' ? 'B+' : 'B-'); bPrev = bNow; }
  }

  const cycle = seen.slice(0, 4).join(' ');
  assert(cycle === 'A+ B+ A- B-', `Falsche Reihenfolge: „${seen.slice(0, 8).join(' ')}“`);
  assert(seen.length >= 5, `Zyklus wiederholt sich nicht (${seen.length} Phasen)`);
  return { reihenfolge: cycle, phasen: seen.length, bauteile: c.instances.length };
});

test('Gate 12d: Gespeicherte Aktion hält über den Schritt hinaus', async () => {
  const { Grafcet } = await import('../src/grafcet.js');
  const g = new Grafcet();
  const s0 = g.addStep({ name: '0', initial: true });
  const s1 = g.addStep({
    name: '1',
    actions: [{ kind: 'stored', target: 'LAMP', value: true },
              { kind: 'continuous', target: 'MOTOR' }],
  });
  const s2 = g.addStep({ name: '2', actions: [{ kind: 'stored', target: 'LAMP', value: false }] });
  g.addTransition({ from: [s0.id], to: [s1.id], receptivity: 'go' });
  g.addTransition({ from: [s1.id], to: [s2.id], receptivity: 'next' });
  g.addTransition({ from: [s2.id], to: [s0.id], receptivity: '0' });
  g.reset();

  const sig = {};
  const io = { signal: (t) => !!sig[t] };
  const advance = () => {
    const before = new Set(g.active);
    g.step(0.001, io);
    g.applyStored([...g.active].filter((s) => !before.has(s)));
  };

  advance();
  assert(g.outputs().get('LAMP') === undefined, 'Vor dem Schritt darf nichts gesetzt sein');
  assert(g.outputs().get('MOTOR') === false,
    'Inaktive kontinuierliche Aktion muss aktiv auf false stehen, nicht bloß fehlen');

  sig.go = true; advance(); sig.go = false;
  assert(g.isActive(s1.id), 'Schritt 1 muss aktiv sein');
  assert(g.outputs().get('MOTOR') === true, 'Kontinuierliche Aktion muss anliegen');
  assert(g.outputs().get('LAMP') === true, 'Gespeicherte Aktion muss gesetzt sein');

  sig.next = true; advance(); sig.next = false;
  assert(!g.isActive(s1.id), 'Schritt 1 muss verlassen sein');
  assert(g.outputs().get('MOTOR') === false, 'Kontinuierliche Aktion muss mit dem Schritt enden');
  assert(g.outputs().get('LAMP') === false,
    'Gespeicherte Aktion muss erst durch die Zuweisung in Schritt 2 gelöscht werden');
  return { kontinuierlich: 'endet mit Schritt', gespeichert: 'hält bis zur Gegenzuweisung' };
});

test('Gate 12e: Strukturprüfung meldet unerreichbare Schritte und fehlenden Initialschritt', async () => {
  const { Grafcet, validate } = await import('../src/grafcet.js');
  const g = new Grafcet();
  const s0 = g.addStep({ name: '0' });          // no initial step
  const s1 = g.addStep({ name: '1' });
  const orphan = g.addStep({ name: '7' });      // nothing activates it
  g.addTransition({ from: [s0.id], to: [s1.id], receptivity: 'a' });
  g.addTransition({ from: [s1.id], to: [s0.id], receptivity: 'a * * b' }); // syntax error

  const issues = validate(g);
  const has = (frag) => issues.some((i) => i.text.includes(frag));
  assert(has('Falta a etapa inicial'), 'Fehlender Initialschritt muss gemeldet werden');
  assert(has('inacessível'), 'Unerreichbarer Schritt muss gemeldet werden');
  assert(has('sem saída'), 'Sackgasse muss gemeldet werden');
  assert(has('condição da transição'), 'Syntaxfehler in der Bedingung muss gemeldet werden');

  // A correct chart must produce no noise — a validator that cries wolf gets ignored.
  const ok = new Grafcet();
  const a = ok.addStep({ name: '0', initial: true });
  const b = ok.addStep({ name: '1' });
  ok.addTransition({ from: [a.id], to: [b.id], receptivity: 'x' });
  ok.addTransition({ from: [b.id], to: [a.id], receptivity: 'y' });
  assert(validate(ok).length === 0,
    `Korrekter GRAFCET darf keine Meldung erzeugen, waren: ${validate(ok).map((i) => i.text).join('; ')}`);
  return { gemeldet: issues.length, sauberer_chart: 'keine Meldung' };
});
