// Pneumatic + electrical simulation engine.
//
// Units: pressure in Pa absolute, mass flow in kg/s, volume in m^3, time in s.
// (An earlier revision worked in bar with a linearised q = g·Δp. That reproduced the
// qualitative behaviour but not the flow physics; everything here is now ISO 6358.)
//
// FLOW MODEL — ISO 6358
// ---------------------
// A restriction is characterised by its sonic conductance C [m^3/(s·Pa)] and critical
// pressure ratio b [-], which is how pneumatic components are actually catalogued.
// With r = p_down/p_up:
//
//   choked  (r <= b):  q = C · ρ0 · p_up
//   subsonic(r >  b):  q = C · ρ0 · p_up · sqrt(1 - ((r-b)/(1-b))^2)
//
// The elliptic subsonic law has infinite slope as r -> 1, which no fixed-point scheme
// can survive. Real flow turns laminar there anyway, so below R_LAMINAR the factor is
// blended linearly to zero — a standard regularisation, and the reason the solver
// converges at all near equilibrium.
//
// SOLVER
// ------
// Nodal analysis over pressure nodes. Every net is a gas volume; per tick, backward
// Euler on the ideal-gas state:
//
//   V/(R·T·dt) · (p_new - p_old) = Σ q_in - p_old/(R·T) · dV/dt
//
// Flow is nonlinear in p, so each tick runs a *damped fixed-point* iteration: linearise
// every restriction to a secant conductance at the current pressure estimate, solve the
// linear system, relax, repeat until the residual settles. Damped fixed-point is chosen
// over Newton–Raphson because the secant conductance is analytic and cheap while a full
// Jacobian would need the derivative of the choked/subsonic branch switch — more code
// for the same answer at these network sizes. Iteration count and residual are exposed
// on the snapshot; non-convergence is reported, never silently swallowed.

export const P_ATM = 101325;     // Pa absolute
export const T_AMBIENT = 293.15; // K
export const R_AIR = 287.05;     // J/(kg·K)
export const RT = R_AIR * T_AMBIENT;
export const RHO_0 = 1.185;      // kg/m^3 at ANR (20 °C, 1 bar abs)

export const barG = (pAbs) => (pAbs - P_ATM) / 1e5;
export const toAbs = (barGauge) => barGauge * 1e5 + P_ATM;

// Sonic conductance catalogue values. A 1/8" valve at ~500 l/min ANR is the reference:
// C = q_ANR[m^3/s] / p_up[Pa] = 8.3e-3 / 7e5.
export const C_VALVE = 1.2e-8;   // standard directional valve path (~500 l/min)
export const C_SUPPLY = 1.2e-7;  // service unit: stiff relative to any valve
export const C_EXHAUST = 1.4e-8; // exhaust port, slightly larger than a working path
export const C_THROTTLE_MAX = 1.0e-8;
export const B_CRIT = 0.4;       // typical spool valve critical pressure ratio
export const C_LEAK = 1e-13;     // keeps isolated nets well-conditioned; physically ~0

const R_LAMINAR = 0.995; // below this Δp the elliptic law is blended to linear

// ---------------------------------------------------------------------------
// HYDRAULICS
// ---------------------------------------------------------------------------
//
// A second fluid domain, sharing the solver but not the physics. Oil is near
// incompressible, so pressure comes from the *stiffness* of the trapped volume rather
// than from a gas law:
//
//   V/(β·dt) · (p_new - p_old) = Σ q_vol - dV/dt
//
// Flow through a restriction is the orifice equation, turbulent over almost the whole
// working range:
//
//   q = K · sign(Δp) · sqrt(|Δp|)      with K = Cd · A · sqrt(2/ρ)
//
// Its slope is infinite at Δp = 0, so below DP_LAMINAR it becomes linear — which is also
// what real flow does at low Reynolds number, so the regularisation is physical rather
// than a numerical apology.
//
// Consequence worth knowing: hydraulic nodes are far stiffer than pneumatic ones
// (β = 1e9 against a gas). Backward Euler absorbs that; anything explicit would not.

export const RHO_OIL = 870;      // kg/m^3
// Effective bulk modulus, NOT the textbook 1.6e9 for pure oil. Real circuits carry ~1%
// entrained air and flexible hose, which drops the working figure by an order of
// magnitude at low pressure. Using the pure-oil value made a node so stiff that a pump
// built 13 bar per millisecond — three times a relief valve's whole override band per
// tick — and no relief could regulate against it. This is the honest number for a
// system with hose, not the honest number for a steel block full of degassed oil.
export const BULK_OIL = 1.2e8;
export const P_TANK = P_ATM;
const DP_LAMINAR = 1.0e4;        // 0.1 bar

/** K for a component rated `lpm` litres/min at `dpBar` differential. */
export const kFromRating = (lpm, dpBar = 5) =>
  (lpm / 60000) / Math.sqrt(dpBar * 1e5);

export const K_VALVE = kFromRating(20, 5);      // 20 l/min @ 5 bar — a small NG6 spool
export const K_THROTTLE_MAX = kFromRating(12, 5);
export const K_RELIEF = kFromRating(40, 5);     // must swallow full pump flow
export const K_LEAK_H = kFromRating(0.002, 5);  // conditioning only

export const V_HYD_NET = 6.0e-5;   // ~60 cm^3 of hose and fittings per net
export const V_HYD_PER_WIRE = 2.0e-5;

/** Volumetric flow [m^3/s] through a hydraulic restriction, signed from p1 to p2. */
export function orificeFlow(p1, p2, K) {
  if (!(K > 0)) return 0;
  const dp = p1 - p2;
  const a = Math.abs(dp);
  if (a < DP_LAMINAR) return K * Math.sqrt(DP_LAMINAR) * (dp / DP_LAMINAR);
  return Math.sign(dp) * K * Math.sqrt(a);
}

/** Secant conductance of an orifice, finite everywhere thanks to the laminar region. */
export function orificeConductance(p1, p2, K) {
  if (!(K > 0)) return 0;
  const dp = p1 - p2;
  if (Math.abs(dp) < DP_LAMINAR) return K / Math.sqrt(DP_LAMINAR);
  return orificeFlow(p1, p2, K) / dp;
}

/** Base volume attributed to a bare net (fittings), and per unit of line length. */
export const V_NET_BASE = 2.0e-7;
export const V_PER_WIRE = 1.5e-8;

// ---------------------------------------------------------------------------
// CONTINUOUS ELECTRONICS
// ---------------------------------------------------------------------------
//
// A third domain. The ladder solve below is pure nodal analysis over conductances to
// fixed rails, which is square and linear because that is all a relay circuit contains.
// Electronics does not fit that mould, in three separate ways, and each gets the
// textbook answer:
//
//   - an ideal voltage source has no conductance to state, so it brings its own unknown
//     (its branch current) and its own row: v_i - v_j = E. That extra row is the
//     "modified" in Modified Nodal Analysis.
//   - a capacitor's current depends on its own history, so it is replaced by a backward
//     Euler companion — a conductance C/dt beside a current source holding the charge
//     already on the plates. Same implicit step as the gas and the oil, for the same
//     reason: anything explicit rings at a dt near the time constant.
//   - a junction is exponential, so each timestep runs Newton–Raphson (not the damped
//     fixed point the fluid side uses: exp() has an analytic derivative, and no amount
//     of relaxation tames a curve that steep).
//
// Timescale: none of this can run on the 1 ms fluid tick. A 100 kHz square wave is ten
// microseconds long — sampling it per tick would alias it into a DC level. The tick is
// therefore subdivided into a whole number of electrical steps, sized by what the
// components in the circuit actually ask for.

export const V_THERMAL = 0.025852;  // kT/q at 300 K
export const GMIN = 1e-12;          // shunt on every node; keeps a floating one solvable
export const ELECTRIC_DT_MAX = 1e-5; // 10 µs — the coarsest step any continuous part gets

const nodeV = (v, i) => (i == null ? 0 : v[i]);

/** Junction voltage past which the exponential must not be evaluated raw. */
const vcritOf = (Is, vt) => vt * Math.log(vt / (Math.SQRT2 * Is));

/**
 * SPICE's junction limiting. From a cold start Newton asks a diode for exp(24/0.026),
 * which is not a number — but the *step*, not the model, is what misbehaves. Bounding
 * each step logarithmically keeps the iterate in range while still converging on the
 * true solution, because the limit only ever shortens a step, never redirects it.
 */
export function pnjlim(vNew, vOld, vt, vcrit) {
  if (vNew > vcrit && Math.abs(vNew - vOld) > 2 * vt) {
    if (vOld > 0) {
      const arg = 1 + (vNew - vOld) / vt;
      return arg > 0 ? vOld + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vNew / vt);
  }
  return vNew;
}

// Cap on the exponent, not on the junction voltage: a double overflows at exp(709), and
// the only job here is to stay short of that. An earlier revision clamped the *voltage*
// to 40·Vt, which for an LED is 2.07 V — right in the middle of its forward operating
// point, so a lit LED read back a tenth of its actual current.
const EXP_MAX = 500;
const expSafe = (x) => Math.exp(Math.min(x, EXP_MAX));

/**
 * Shockley current through a junction, plus the reverse-breakdown branch when the model
 * has a Zener voltage. Used to read a device out after the solve; the solver itself
 * needs the derivative too and computes both in `Stamper.diode`.
 */
export function diodeCurrent(v, m) {
  const vt = m.N * V_THERMAL;
  let i = m.Is * (expSafe(v / vt) - 1);
  if (m.Vz) i -= m.Ibv * expSafe(-(v + m.Vz) / (m.Nbv * V_THERMAL));
  return i;
}

/**
 * ISO 6358 dimensionless flow factor, 0..1, regularised near equilibrium.
 * `r` is the pressure ratio p_down/p_up; both absolute.
 */
export function flowFactor(r, b) {
  if (r <= b) return 1;
  if (r >= 1) return 0;
  const ellip = (x) => {
    const t = (x - b) / (1 - b);
    return Math.sqrt(Math.max(0, 1 - t * t));
  };
  if (r < R_LAMINAR) return ellip(r);
  // Laminar blend: straight line from the elliptic value at R_LAMINAR down to 0 at r=1.
  const fEnd = ellip(R_LAMINAR);
  return fEnd * ((1 - r) / (1 - R_LAMINAR));
}

/** Mass flow [kg/s] through a restriction, signed from p1 to p2. */
export function massFlow(p1, p2, C, b = B_CRIT) {
  if (!(C > 0)) return 0;
  const fwd = p1 >= p2;
  const pUp = fwd ? p1 : p2;
  const pDn = fwd ? p2 : p1;
  if (pUp <= 0) return 0;
  const q = C * RHO_0 * pUp * flowFactor(pDn / pUp, b);
  return fwd ? q : -q;
}

/**
 * Secant conductance dq/dΔp used to linearise a restriction for the nodal solve.
 * Near equilibrium the secant degenerates, so fall back to a local difference quotient.
 */
export function secantConductance(p1, p2, C, b = B_CRIT) {
  if (!(C > 0)) return 0;
  const dp = p1 - p2;
  if (Math.abs(dp) > 1) return massFlow(p1, p2, C, b) / dp;
  const h = 1; // Pa
  const pm = (p1 + p2) / 2;
  return (massFlow(pm + h / 2, pm - h / 2, C, b)) / h;
}

// ---------------------------------------------------------------------------

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(a) {
    if (!this.parent.has(a)) { this.parent.set(a, a); return a; }
    let root = a;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(a) !== root) { const n = this.parent.get(a); this.parent.set(a, root); a = n; }
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export const portKey = (instId, portId) => `${instId}:${portId}`;

/** Partitions ports of one domain into nets. Topology only. */
export function buildNets(circuit, kind = 'pneumatic') {
  const uf = new UnionFind();
  const relevant = new Set();

  for (const inst of circuit.instances) {
    const def = circuit.defOf(inst);
    if (!def) continue;
    for (const port of def.ports) {
      if ((port.kind || 'pneumatic') !== kind) continue;
      const key = portKey(inst.id, port.id);
      relevant.add(key);
      uf.find(key);
    }
  }
  for (const wire of circuit.wires) {
    const a = portKey(wire.from.inst, wire.from.port);
    const b = portKey(wire.to.inst, wire.to.port);
    if (relevant.has(a) && relevant.has(b)) uf.union(a, b);
  }

  const netOf = new Map();
  const roots = new Map();
  for (const key of relevant) {
    const root = uf.find(key);
    if (!roots.has(root)) roots.set(root, roots.size);
    netOf.set(key, roots.get(root));
  }

  // Hydraulic hose holds orders of magnitude more fluid than a pneumatic line, and with
  // oil that volume is what sets the stiffness — it cannot share the pneumatic figure.
  const hyd = kind === 'hydraulic';
  const base = hyd ? V_HYD_NET : V_NET_BASE;
  const per = hyd ? V_HYD_PER_WIRE : V_PER_WIRE;
  const volumes = new Float64Array(roots.size).fill(base);
  for (const wire of circuit.wires) {
    const a = portKey(wire.from.inst, wire.from.port);
    if (netOf.has(a)) volumes[netOf.get(a)] += per * (wire.length || 1);
  }
  return { netOf, count: roots.size, volumes };
}

/**
 * Collects one iteration's linear system. Components describe themselves through this
 * rather than touching the matrix, which keeps the catalog free of solver math.
 */
export class Stamper {
  /**
   * `extra` reserves unknowns beyond the nets: branch currents and component-internal
   * nodes. Zero for the fluid domains and for the resistive ladder, which is why they
   * see exactly the matrix they always saw.
   */
  constructor(n, dt, domain = 'pneumatic', extra = 0) {
    this.n = n;
    this.dt = dt;
    this.domain = domain;
    this.size = n + extra;
    this._nextExtra = n;
    this.A = Array.from({ length: this.size }, () => new Float64Array(this.size));
    this.b = new Float64Array(this.size);
  }

  /** Linear conductance between two nets (electrical use, or a pre-linearised path). */
  conduct(i, j, g) {
    if (i == null || j == null || i === j || !(g > 0)) return;
    this.A[i][i] += g; this.A[j][j] += g;
    this.A[i][j] -= g; this.A[j][i] -= g;
  }

  /** Conductance to a node held at a fixed potential/pressure. */
  toFixed(i, g, value) {
    if (i == null || !(g > 0)) return;
    this.A[i][i] += g;
    this.b[i] += g * value;
  }

  /**
   * ISO 6358 restriction between two nets, linearised about the current estimate.
   * `pressures` is the working vector for this iteration.
   */
  restrict(i, j, C, b, pressures) {
    if (i == null || j == null || i === j || !(C > 0)) return;
    const pi = pressures[i], pj = pressures[j];
    const g = secantConductance(pi, pj, C, b);
    this.conduct(i, j, Math.max(g, 0));
  }

  /** ISO 6358 restriction from a net to a fixed pressure (supply rail, atmosphere). */
  restrictToFixed(i, C, b, pFixed, pressures) {
    if (i == null || !(C > 0)) return;
    const g = secantConductance(pressures[i], pFixed, C, b);
    this.toFixed(i, Math.max(g, 0), pFixed);
  }

  /**
   * Gas storage on a net. `dVdt` couples a moving piston to its chamber. Volumes are
   * divided by R·T here so the matrix stays well conditioned against the tiny
   * conductances (~1e-8) that sit next to them.
   */
  capacitance(i, volume, pOld, dVdt = 0) {
    if (i == null) return;
    const c = Math.max(volume, 1e-12) / (RT * this.dt);
    this.A[i][i] += c;
    this.b[i] += c * pOld - (pOld * dVdt) / RT;
  }

  // --- hydraulic ---------------------------------------------------------

  /** Orifice between two nets, linearised about the current iterate. */
  orifice(i, j, K, pressures) {
    if (i == null || j == null || i === j || !(K > 0)) return;
    this.conduct(i, j, Math.max(orificeConductance(pressures[i], pressures[j], K), 0));
  }

  /** Orifice from a net to a fixed pressure (tank, an external supply). */
  orificeToFixed(i, K, pFixed, pressures) {
    if (i == null || !(K > 0)) return;
    this.toFixed(i, Math.max(orificeConductance(pressures[i], pFixed, K), 0), pFixed);
  }

  /**
   * Oil stiffness on a net. `dVdt` is the piston sweeping its chamber. Unlike the gas
   * case there is no R·T scaling: volume over bulk modulus already has the right units.
   */
  oilCapacitance(i, volume, pOld, dVdt = 0) {
    if (i == null) return;
    const c = Math.max(volume, 1e-9) / (BULK_OIL * this.dt);
    this.A[i][i] += c;
    this.b[i] += c * pOld - dVdt;
  }

  /** Ideal volumetric flow into a net — a pump. */
  inject(i, q) {
    if (i == null) return;
    this.b[i] += q;
  }

  // --- electric: MNA -----------------------------------------------------

  /**
   * Claims one reserved unknown. A voltage source uses it for its branch current, a
   * component with an internal node uses it as a node — the two are the same thing to
   * the matrix, only the row differs, so they share one pool.
   */
  extra() {
    if (this._nextExtra >= this.size) throw new Error('MNA: mehr Zusatzunbekannte verlangt als reserviert');
    return this._nextExtra++;
  }

  /** Independent current source driving I from node j into node i. */
  current(i, j, I) {
    if (!Number.isFinite(I) || I === 0) return;
    if (i != null) this.b[i] += I;
    if (j != null) this.b[j] -= I;
  }

  /** Capacitor, backward-Euler companion: C/dt beside the charge already on the plates. */
  capacitor(i, j, C, vOld) {
    if (i == null || j == null || i === j || !(C > 0)) return;
    const g = C / this.dt;
    this.conduct(i, j, g);
    this.current(i, j, g * vOld);
  }

  /** Inductor, backward-Euler companion: dt/L beside the current already flowing. */
  inductor(i, j, L, iOld) {
    if (i == null || j == null || i === j || !(L > 0)) return;
    this.conduct(i, j, this.dt / L);
    this.current(j, i, iOld);
  }

  /** Ideal voltage source: v_i − v_j = value, with branch current on unknown `k`. */
  vsource(k, i, j, value) {
    if (k == null) return;
    if (i != null) { this.A[k][i] += 1; this.A[i][k] += 1; }
    if (j != null) { this.A[k][j] -= 1; this.A[j][k] -= 1; }
    this.b[k] += value;
  }

  /**
   * Forces a reserved branch's current to zero — a source or a winding gone open. A
   * reserved unknown always needs a row: leaving one empty is a singular matrix, not an
   * absent component.
   */
  openBranch(k) { if (k != null) this.A[k][k] += 1; }

  /** Voltage-controlled voltage source: v_out − v_ref = gain·(v_ip − v_im) + offset. */
  vcvs(k, out, ref, ip, im, gain, offset = 0) {
    if (k == null) return;
    if (out != null) { this.A[k][out] += 1; this.A[out][k] += 1; }
    if (ref != null) { this.A[k][ref] -= 1; this.A[ref][k] -= 1; }
    if (ip != null) this.A[k][ip] -= gain;
    if (im != null) this.A[k][im] += gain;
    this.b[k] += offset;
  }

  /**
   * Ideal transformer: v_p = ratio·v_s, and the current follows so that power balances.
   * Ideal on its own means DC-coupled and lossless; the component wraps it in winding
   * resistance and a magnetising inductance, which is where the physics comes back.
   */
  transformer(k, p1, p2, s1, s2, ratio) {
    if (k == null || !(ratio > 0)) return;
    if (p1 != null) { this.A[k][p1] += 1; this.A[p1][k] += 1; }
    if (p2 != null) { this.A[k][p2] -= 1; this.A[p2][k] -= 1; }
    if (s1 != null) { this.A[k][s1] -= ratio; this.A[s1][k] -= ratio; }
    if (s2 != null) { this.A[k][s2] += ratio; this.A[s2][k] += ratio; }
  }

  /**
   * The Newton primitive: a nonlinear current `I0` leaving node `k`, linearised about
   * the point the model was evaluated at. Each dep is [i, j, ∂I/∂v_ij, v_ij used] — the
   * evaluation point travels with the derivative because a limited junction is not
   * linearised where the raw iterate sits.
   */
  nonlinear(k, I0, deps) {
    if (k == null) return;
    let ieq = I0;
    for (const [i, j, g, v0] of deps) {
      if (i != null) this.A[k][i] += g;
      if (j != null) this.A[k][j] -= g;
      ieq -= g * v0;
    }
    this.b[k] -= ieq;
  }

  /**
   * Shockley diode from anode `i` to cathode `j`, linearised about the current iterate.
   * Returns the junction voltage it actually used: the limiter needs the previous step
   * to bound this one, so the caller has to hand it back next iteration.
   */
  diode(i, j, m, v, vPrev = 0) {
    const vt = m.N * V_THERMAL;
    const vd = pnjlim(nodeV(v, i) - nodeV(v, j), vPrev, vt, vcritOf(m.Is, vt));
    const e = expSafe(vd / vt);
    let id = m.Is * (e - 1);
    let gd = (m.Is * e) / vt + GMIN;
    if (m.Vz) {
      // Reverse breakdown, mirrored: the same exponential looked at from -Vz.
      const vtb = m.Nbv * V_THERMAL;
      const eb = expSafe(-(vd + m.Vz) / vtb);
      id -= m.Ibv * eb;
      gd += (m.Ibv * eb) / vtb;
    }
    this.nonlinear(i, id, [[i, j, gd, vd]]);
    this.nonlinear(j, -id, [[i, j, -gd, vd]]);
    return vd;
  }

  /**
   * Ebers–Moll (transport form) BJT. `prev` carries the last iterate's junction voltages
   * for the limiter; the returned pair must be fed back in.
   *
   * PNP is the same silicon upside down: flip both junction voltages and all three
   * terminal currents. The conductances are untouched by that flip, because the sign
   * appears once in the derivative and once in the chain rule.
   */
  bjt(nb, nc, ne, m, v, prev = {}) {
    const s = m.pnp ? -1 : 1;
    const vtf = m.Nf * V_THERMAL, vtr = m.Nr * V_THERMAL;
    const vbe = pnjlim(s * (nodeV(v, nb) - nodeV(v, ne)), prev.vbe ?? 0, vtf, vcritOf(m.Is, vtf));
    const vbc = pnjlim(s * (nodeV(v, nb) - nodeV(v, nc)), prev.vbc ?? 0, vtr, vcritOf(m.Is, vtr));

    const ef = expSafe(vbe / vtf), er = expSafe(vbc / vtr);
    const If = m.Is * (ef - 1), Ir = m.Is * (er - 1);
    const gf = (m.Is * ef) / vtf, gr = (m.Is * er) / vtr;

    const ib = If / m.Bf + Ir / m.Br;
    const ic = If - Ir * (1 + 1 / m.Br);
    const ie = -(ib + ic);

    // Evaluation points seen from the terminals, i.e. after the PNP flip.
    const ube = s * vbe, ubc = s * vbc;
    this.nonlinear(nb, s * ib, [[nb, ne, gf / m.Bf, ube], [nb, nc, gr / m.Br, ubc]]);
    this.nonlinear(nc, s * ic, [[nb, ne, gf, ube], [nb, nc, -gr * (1 + 1 / m.Br), ubc]]);
    this.nonlinear(ne, s * ie, [[nb, ne, -(gf / m.Bf + gf), ube], [nb, nc, gr, ubc]]);

    // Both junctions need a floor conductance or a cut-off transistor leaves its base
    // and collector nodes attached to nothing at all.
    this.conduct(nb, ne, GMIN);
    this.conduct(nb, nc, GMIN);
    return { vbe, vbc };
  }

  /**
   * Quadratic (Shichman–Hodges) MOSFET. Drain and source are decided by potential, not
   * by which pin the symbol calls what — a real MOSFET channel is symmetric, and a test
   * that pulls the drain below the source should see that rather than a broken model.
   */
  mosfet(ng, nd, ns, m, v) {
    const lo = nodeV(v, nd) < nodeV(v, ns);
    const d = lo ? ns : nd, s = lo ? nd : ns;
    const p = m.pmos ? -1 : 1;
    const vgs = p * (nodeV(v, ng) - nodeV(v, s));
    const vds = p * (nodeV(v, d) - nodeV(v, s));
    const vov = vgs - m.Vth;

    let id = 0, gm = 0, gds = 0;
    if (vov > 0) {
      if (vds < vov) {              // triode
        id = m.K * (vov * vds - (vds * vds) / 2);
        gm = m.K * vds;
        gds = m.K * (vov - vds);
      } else {                      // saturation
        const l = 1 + m.lambda * vds;
        id = (m.K / 2) * vov * vov * l;
        gm = m.K * vov * l;
        gds = (m.K / 2) * vov * vov * m.lambda;
      }
    }
    gds += GMIN;

    const ugs = p * vgs, uds = p * vds;
    this.nonlinear(d, p * id, [[ng, s, gm, ugs], [d, s, gds, uds]]);
    this.nonlinear(s, -p * id, [[ng, s, -gm, ugs], [d, s, -gds, uds]]);
    // The gate is an insulator: no stamp at all, which is exactly the physics.
  }
}

/** Gaussian elimination with partial pivoting. */
export function solve(A, b, fallback = 0) {
  const n = b.length;
  if (n === 0) return new Float64Array(0);
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    r.set(row); r[n] = b[i];
    return r;
  });
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-30) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const inv = 1 / M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] * inv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = Math.abs(M[r][r]) < 1e-30 ? fallback : s / M[r][r];
  }
  return x;
}

// ---------------------------------------------------------------------------

// A fast transient (a valve snapping open onto an empty chamber) needs noticeably more
// iterations than steady state. 12 left a stray non-converged tick in the `direct`
// example; the budget is generous because the loop exits on the residual, so the extra
// headroom costs nothing when it is not needed.
const MAX_ITER = 40;
const TOL_PA = 20;        // convergence tolerance, Pa (0.0002 bar)
const DAMPING = 0.7;
// Oil needs far heavier relaxation than air: sqrt(Δp) is much steeper than the ISO 6358
// curve, and a hydraulic node is stiffer, so the same 0.7 overshoots and hunts.
const DAMPING_HYD = 0.25;
const MAX_ITER_HYD = 60;
/** Enough passes for any sane gate chain; the loop exits as soon as levels stop moving. */
const DIGITAL_PASSES = 24;
export const LOGIC_THRESHOLD = 12; // V — half rail, the usual TTL-ish convention

// Newton on the electronics side. The tolerance is on the node-voltage update, not on a
// residual current: a nanoamp through a diode and a nanoamp through a 10 MΩ resistor are
// the same number but nothing like the same error.
const NEWTON_LIMIT = 100;
const V_NTOL = 1e-6;      // V
/** Samples a periodic source needs per period before it is a waveform and not a rumour. */
export const SAMPLES_PER_PERIOD = 40;

export class Simulation {
  constructor(circuit) {
    this.circuit = circuit;
    this.running = false;
    this.time = 0;
    this.energized = new Map();
    // A GRAFCET is a specification above the circuit, not a component in it: it reads the
    // plant's signals and commands its actuators. `chart` is optional; a sheet without one
    // behaves exactly as before.
    this.chart = null;
    // Newton budget for the electronics solve. A generous default — the loop leaves on
    // the update norm, so headroom it does not need costs nothing.
    this.newtonLimit = NEWTON_LIMIT;
    // Optional sub-tick observer, (t, sim) after every electrical step. Anything that
    // samples on the tick boundary cannot see a 100 kHz signal; this is where a scope
    // has to listen instead.
    this.onElectric = null;
    this.diagnostics = this.freshDiagnostics();
    this.rebuild();
  }

  freshDiagnostics() {
    return {
      iterations: 0, residual: 0, hydIterations: 0, hydResidual: 0,
      electricIterations: 0, electricDelta: 0, electricSteps: 0, electricDt: 0,
      converged: true, failures: 0,
    };
  }

  rebuild() {
    this.chart?.reset();
    this.nets = buildNets(this.circuit, 'pneumatic');

    // Component-internal pressure nodes, the same facility the MNA branch uses for
    // internal electrical nodes. A cylinder with end-position cushioning needs its
    // chamber to be a node distinct from the port it feeds — otherwise there is no
    // place to put the cushioning restriction, because chamber and port would be the
    // same unknown. Reserved per instance and unconditionally, so an index stays put
    // when a parameter changes mid-run.
    this.fluidExtras = this.circuit.instances
      .reduce((s, i) => s + (this.circuit.defOf(i)?.fluidExtras || 0), 0);
    this.p = new Float64Array(this.nets.count + this.fluidExtras).fill(P_ATM);
    this.elec = buildNets(this.circuit, 'electric');
    this.v = new Float64Array(this.elec.count);
    this.hyd = buildNets(this.circuit, 'hydraulic');
    this.ph = new Float64Array(this.hyd.count).fill(P_TANK);

    // The MNA branch is opt-in per sheet: a circuit with no continuous part is a ladder,
    // and a ladder gets the resistive solve it has always had, unchanged.
    this.continuous = this.circuit.instances.filter((i) => this.circuit.defOf(i)?.continuous);
    this.mnaExtras = this.continuous.reduce((s, i) => s + (this.circuit.defOf(i).extras || 0), 0);
    this.x = new Float64Array(this.elec.count + this.mnaExtras);

    for (const inst of this.circuit.instances) {
      const def = this.circuit.defOf(inst);
      if (!def) continue;
      inst.sim = {};
      if (def.initSim) def.initSim(inst);
    }
  }

  reset() {
    this.time = 0;
    this.running = false;
    this.energized.clear();
    this.chart?.reset();
    this.diagnostics = this.freshDiagnostics();
    this.rebuild();
  }

  netIndex(instId, portId) { return this.nets.netOf.get(portKey(instId, portId)) ?? null; }
  elecIndex(instId, portId) { return this.elec.netOf.get(portKey(instId, portId)) ?? null; }
  hydIndex(instId, portId) { return this.hyd.netOf.get(portKey(instId, portId)) ?? null; }

  /** Hydraulic gauge pressure in bar. */
  hgauge(instId, portId) {
    const i = this.hydIndex(instId, portId);
    return i == null ? 0 : barG(this.ph[i]);
  }
  hpressureAt(instId, portId) {
    const i = this.hydIndex(instId, portId);
    return i == null ? P_TANK : this.ph[i];
  }

  /** Gauge pressure in bar — what a gauge on the sheet reads. */
  gauge(instId, portId) {
    const i = this.netIndex(instId, portId);
    return i == null ? 0 : barG(this.p[i]);
  }
  /** Absolute pressure in Pa. */
  pressureAt(instId, portId) {
    const i = this.netIndex(instId, portId);
    return i == null ? P_ATM : this.p[i];
  }
  volts(instId, portId) {
    const i = this.elecIndex(instId, portId);
    return i == null ? 0 : this.v[i];
  }

  makeCtx(dt) {
    return {
      sim: this,
      dt,
      net: (inst, portId) => this.netIndex(inst.id, portId),
      pressure: (inst, portId) => this.pressureAt(inst.id, portId),
      gauge: (inst, portId) => this.gauge(inst.id, portId),
      hnet: (inst, portId) => this.hydIndex(inst.id, portId),
      hpressure: (inst, portId) => this.hpressureAt(inst.id, portId),
      hgauge: (inst, portId) => this.hgauge(inst.id, portId),
      /**
       * Last tick's pressure at a raw solver index. Only component-internal nodes need
       * this: they have no port to look up, so their own backward-Euler history has to
       * be read by index.
       */
      pAt: (i) => (i == null ? P_ATM : this.p[i] ?? P_ATM),
      gaugeAt: (i) => (i == null ? 0 : barG(this.p[i] ?? P_ATM)),
      /** Faults are consulted by components themselves, so each decides what a defect means. */
      fault: (inst, name) => inst.faults?.[name] === true,
    };
  }

  step(dt) {
    const ctx = this.makeCtx(dt);
    // Every domain may veto convergence for this tick, and the electrics get to vote
    // first — so the flag is cleared here rather than assigned by whoever solves last.
    this.diagnostics.converged = true;

    // 1. Electrics settle far faster than any air column, so they lead within a tick.
    if (this.continuous.length) this.solveElectricContinuous(ctx);
    else this.solveElectric(ctx);

    // 2. GRAFCET, before the components read their commands. Its outputs are published
    //    into `energized` under their tag, which is the same channel relay coils use —
    //    so a solenoid does not know or care whether a ladder or a chart is driving it.
    if (this.chart) this.evolveChart(ctx);

    // 3. Discrete state: spool positions, latches, timers, limit switches.
    //    A "stuck" defect is enforced centrally rather than in each component: whatever
    //    the valve decides, it is put back where it seized.
    for (const inst of this.circuit.instances) {
      const def = this.circuit.defOf(inst);
      if (!def?.updateState) continue;
      const seized = inst.faults?.stuck ? inst.sim.state : null;
      def.updateState(inst, ctx);
      if (seized != null) inst.sim.state = seized;
    }

    // 4. Pneumatics: damped fixed-point over the nonlinear restrictions.
    const pOld = this.p;
    let work = Float64Array.from(this.p);
    let iter = 0, residual = Infinity;

    for (; iter < MAX_ITER; iter++) {
      const st = new Stamper(this.nets.count, dt, 'pneumatic', this.fluidExtras);
      for (let i = 0; i < this.nets.count; i++) {
        st.capacitance(i, this.nets.volumes[i], pOld[i], 0);
        st.restrictToFixed(i, C_LEAK, B_CRIT, P_ATM, work);
      }
      for (const inst of this.circuit.instances) {
        const def = this.circuit.defOf(inst);
        if (def?.stamp) def.stamp(inst, st, ctx, work);
      }

      const next = solve(st.A, st.b, P_ATM);
      residual = 0;
      for (let i = 0; i < next.length; i++) {
        if (!Number.isFinite(next[i])) next[i] = P_ATM;
        next[i] = Math.min(Math.max(next[i], 1000), 3.0e6); // 0.01 .. 30 bar abs
        residual = Math.max(residual, Math.abs(next[i] - work[i]));
        work[i] = work[i] + DAMPING * (next[i] - work[i]);
      }
      if (residual < TOL_PA) { iter++; break; }
    }

    this.p = work;
    this.diagnostics.iterations = iter;
    this.diagnostics.residual = residual;
    if (!(residual < TOL_PA * 50)) {
      this.diagnostics.converged = false;
      this.diagnostics.failures++;
    }

    // 5. Hydraulics. Same fixed-point scheme; oil is far stiffer than air, which the
    //    implicit step absorbs, but it does mean the iteration earns its keep here.
    if (this.hyd.count) this.solveHydraulic(ctx);

    // 6. Mechanics, against the pressures just solved.
    for (const inst of this.circuit.instances) {
      const def = this.circuit.defOf(inst);
      if (def?.integrate) def.integrate(inst, ctx);
    }

    this.time += dt;
  }

  /**
   * Resolves a plant signal for a receptivity. Order matters: an explicit component tag
   * beats a coil tag, because a sensor named 1B1 is what the author meant, not a relay
   * that happens to share the name.
   */
  signal(tag) {
    for (const inst of this.circuit.instances) {
      if (inst.params?.tag?.value !== tag) continue;
      const s = inst.sim || {};
      if (s.closed != null) return !!s.closed;    // switches, contacts, sensors
      if (s.pressed != null) return !!s.pressed;  // buttons, hand levers
      if (s.on != null) return !!s.on;            // coils, lamps
      if (s.state != null) return s.state > 0;    // valve spool
    }
    return !!this.energized.get(tag);
  }

  evolveChart(ctx) {
    const before = new Set(this.chart.active);
    this.chart.step(ctx.dt, { signal: (t) => this.signal(t) });
    const newly = [...this.chart.active].filter((s) => !before.has(s));
    this.chart.applyStored(newly);
    for (const [target, on] of this.chart.outputs()) this.energized.set(target, on);
  }

  solveHydraulic(ctx) {
    const pOld = this.ph;
    let work = Float64Array.from(this.ph);
    let iter = 0, residual = Infinity;

    for (; iter < MAX_ITER_HYD; iter++) {
      const st = new Stamper(this.hyd.count, ctx.dt, 'hydraulic');
      for (let i = 0; i < this.hyd.count; i++) {
        st.oilCapacitance(i, this.hyd.volumes[i], pOld[i], 0);
        st.orificeToFixed(i, K_LEAK_H, P_TANK, work);
      }
      for (const inst of this.circuit.instances) {
        const def = this.circuit.defOf(inst);
        if (def?.stampHydraulic) def.stampHydraulic(inst, st, ctx, work);
      }

      const next = solve(st.A, st.b, P_TANK);
      residual = 0;
      for (let i = 0; i < next.length; i++) {
        if (!Number.isFinite(next[i])) next[i] = P_TANK;
        // Clamped at vapour pressure below and a plausible burst pressure above. The
        // lower clamp is cavitation: oil cannot pull a vacuum, it boils.
        next[i] = Math.min(Math.max(next[i], 2000), 6.0e7);
        residual = Math.max(residual, Math.abs(next[i] - work[i]));
        work[i] = work[i] + DAMPING_HYD * (next[i] - work[i]);
      }
      if (residual < TOL_PA) { iter++; break; }
    }
    this.ph = work;
    this.diagnostics.hydIterations = iter;
    this.diagnostics.hydResidual = residual;
    if (residual >= TOL_PA * 50) {
      this.diagnostics.converged = false;
      this.diagnostics.failures++;
    }
  }

  /**
   * Resistive DC solve. Coils and lamps are pure resistances, rails are stiff sources.
   *
   * Contacts read `energized` from the previous tick — physically the relay pickup delay,
   * and what breaks the algebraic loop in a self-holding latch. Logic gates are the
   * opposite case: a chain of gates that each cost a tick would make an 8-bit adder take
   * 8 ms, which is nonsense. So the solve is repeated until every gate output stops
   * changing, giving combinational logic zero propagation delay within one tick — while
   * sequential parts (flip-flops, relays) still clock on the tick boundary, which is what
   * keeps a feedback loop from being an algebraic one.
   */
  solveElectric(ctx) {
    const n = this.elec.count;
    if (n === 0) { this.v = new Float64Array(0); return; }

    const ectx = {
      ...ctx,
      net: (inst, portId) => this.elecIndex(inst.id, portId),
      volts: (inst, portId) => this.volts(inst.id, portId),
    };

    const gates = this.circuit.instances.filter((i) => this.circuit.defOf(i)?.combinational);
    const passes = gates.length ? DIGITAL_PASSES : 1;

    for (let pass = 0; pass < passes; pass++) {
      // Gate outputs are decided from the voltages of the previous pass, then re-solved.
      for (const inst of gates) this.circuit.defOf(inst).evaluate(inst, ectx);

      const st = new Stamper(n, ctx.dt, 'electric');
      for (let i = 0; i < n; i++) st.toFixed(i, 1e-9, 0); // reference every node
      for (const inst of this.circuit.instances) {
        const def = this.circuit.defOf(inst);
        if (def?.stampElectric) def.stampElectric(inst, st, ectx);
      }

      const next = solve(st.A, st.b, 0);
      for (let i = 0; i < next.length; i++) if (!Number.isFinite(next[i])) next[i] = 0;

      let settled = pass > 0;
      if (settled) {
        for (let i = 0; i < next.length; i++) {
          // A digital net only matters as a level, so settle on the logic threshold
          // rather than on millivolts.
          if ((this.v[i] > LOGIC_THRESHOLD) !== (next[i] > LOGIC_THRESHOLD)) { settled = false; break; }
        }
      }
      this.v = next;
      if (settled) { this.diagnostics.digitalPasses = pass + 1; break; }
      this.diagnostics.digitalPasses = pass + 1;
    }

    this.publishCoils(ectx);
  }

  /**
   * Pickup decision, once the voltages stand. Deliberately on the tick and not inside
   * the settle loop: `energized` is what contacts read *next* tick, and that one-tick lag
   * is the relay's pull-in time — the thing that breaks the algebraic loop in a latch.
   */
  publishCoils(ectx) {
    for (const inst of this.circuit.instances) {
      const def = this.circuit.defOf(inst);
      if (!def?.coilLike) continue;
      const drop = Math.abs(ectx.volts(inst, 'a') - ectx.volts(inst, 'b'));
      inst.sim.on = drop > 12; // half rail: clear of divider noise, below pickup
      this.energized.set(inst.params.tag.value, inst.sim.on);
    }
  }

  /**
   * The electrical timestep, decoupled from the fluid tick as the spec requires. Each
   * continuous component states the step it needs; the tick is then divided into a whole
   * number of them, so a tick boundary is still a step boundary and everything else in
   * the engine keeps its 1 ms world view.
   */
  electricStep(dt) {
    let h = Math.min(dt, ELECTRIC_DT_MAX);
    for (const inst of this.continuous) {
      const want = this.circuit.defOf(inst).electricDt?.(inst);
      if (want > 0) h = Math.min(h, want);
    }
    return dt / Math.max(1, Math.ceil(dt / h - 1e-9));
  }

  /**
   * MNA + Newton, sub-stepped. Runs instead of `solveElectric` when the sheet holds any
   * continuous component; ladder parts keep their `stampElectric` and work unchanged
   * next to it, so a relay contact in series with a capacitor is just a circuit.
   */
  solveElectricContinuous(ctx) {
    const n = this.elec.count;
    if (n === 0) { this.v = new Float64Array(0); return; }

    const h = this.electricStep(ctx.dt);
    const steps = Math.round(ctx.dt / h);
    const gates = this.circuit.instances.filter((i) => this.circuit.defOf(i)?.combinational);

    const ectx = {
      ...ctx,
      dt: h,
      t: this.time,
      net: (inst, portId) => this.elecIndex(inst.id, portId),
      volts: (inst, portId) => this.volts(inst.id, portId),
    };

    this.diagnostics.electricDt = h;
    this.diagnostics.electricSteps = steps;
    this.diagnostics.electricIterations = 0;
    this.diagnostics.electricDelta = 0;

    for (let s = 0; s < steps; s++) {
      // Backward Euler evaluates its sources at the *end* of the step it is solving for.
      ectx.t = this.time + (s + 1) * h;
      this.newtonStep(ectx, h, gates);
      for (const inst of this.continuous) {
        this.circuit.defOf(inst).postElectric?.(inst, ectx);
      }
      if (this.onElectric) this.onElectric(ectx.t, this);
    }

    this.publishCoils(ectx);
  }

  /** One electrical step: gate settle outside, Newton inside. */
  newtonStep(ectx, h, gates) {
    const n = this.elec.count;
    const passes = gates.length ? DIGITAL_PASSES : 1;
    let iters = 0, delta = Infinity, blewUp = false;

    for (let pass = 0; pass < passes; pass++) {
      for (const inst of gates) this.circuit.defOf(inst).evaluate(inst, ectx);

      for (iters = 0; iters < this.newtonLimit; iters++) {
        const st = new Stamper(n, h, 'electric', this.mnaExtras);
        for (let i = 0; i < n; i++) st.toFixed(i, GMIN, 0);
        for (const inst of this.circuit.instances) {
          const def = this.circuit.defOf(inst);
          def?.stampElectric?.(inst, st, ectx);
          def?.stampMna?.(inst, st, ectx, this.x);
        }

        const next = solve(st.A, st.b, 0);
        delta = 0;
        for (let i = 0; i < n; i++) {
          // A blown-up node is a solver failure, not a zero. Recording it is the whole
          // difference between a wrong answer and a reported one.
          if (!Number.isFinite(next[i])) { next[i] = 0; blewUp = true; }
          delta = Math.max(delta, Math.abs(next[i] - this.x[i]));
        }
        this.x = next;
        if (delta < V_NTOL) { iters++; break; }
      }

      this.diagnostics.electricIterations = Math.max(this.diagnostics.electricIterations, iters);
      const prev = this.v;
      this.v = this.x.slice(0, n);
      if (!gates.length) break;
      let settled = pass > 0;
      if (settled) {
        for (let i = 0; i < n; i++) {
          if ((prev[i] > LOGIC_THRESHOLD) !== (this.v[i] > LOGIC_THRESHOLD)) { settled = false; break; }
        }
      }
      this.diagnostics.digitalPasses = pass + 1;
      if (settled) break;
    }

    // The worst step in the tick, not the last one: a tick where the diode snapped on
    // and then coasted must not report the coasting.
    this.diagnostics.electricDelta = Math.max(this.diagnostics.electricDelta, delta);
    if (blewUp || !(delta < V_NTOL)) {
      this.diagnostics.converged = false;
      this.diagnostics.failures++;
    }
  }

  /** Full state for a tick — what the recorder, scope and tests read. */
  snapshot() {
    const parts = {};
    for (const inst of this.circuit.instances) {
      const s = inst.sim || {};
      parts[inst.id] = {
        tag: inst.params?.tag?.value,
        type: inst.type,
        x: s.x, v: s.v, state: s.state, on: s.on, closed: s.closed, count: s.count,
      };
    }
    return {
      t: this.time,
      pressures: Array.from(this.p, barG),
      hydraulic: Array.from(this.ph, barG),
      volts: Array.from(this.v),
      chart: this.chart ? { active: [...this.chart.active], fired: [...this.chart.lastFired] } : null,
      parts,
      diagnostics: { ...this.diagnostics },
    };
  }
}

/**
 * Headless run used by the test suite and the batch mode: no rAF, no DOM.
 * `script` receives (sim, t) each tick and may poke inputs. `probe` is sampled per tick.
 */
export function runHeadless(circuit, { seconds = 2, dt = 1e-3, script, probe } = {}) {
  const sim = new Simulation(circuit);
  const trace = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    if (script) script(sim, sim.time);
    sim.step(dt);
    if (probe) trace.push(probe(sim, sim.time));
  }
  return { sim, trace };
}
