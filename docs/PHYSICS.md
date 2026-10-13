# Physics

The core is a network solver, not a script. Nothing in this document is an animation curve
fitted to look right — every behaviour listed in [the results table](#what-falls-out-by-itself)
is a measurement taken from the finished system by the [correctness gate](TESTING.md).

- [Pneumatics — ISO 6358 flow](#pneumatics--iso-6358-flow)
- [The pressure network](#the-pressure-network)
- [Mechanics](#mechanics)
- [What falls out by itself](#what-falls-out-by-itself)
- [Hydraulics](#hydraulics)
- [Electronics — modified nodal analysis](#electronics--modified-nodal-analysis)
- [Digital logic timing](#digital-logic-timing)

## Pneumatics — ISO 6358 flow

Every restriction is described by its sonic conductance `C` and its critical pressure ratio
`b` — the way real pneumatic components are actually catalogued, so a datasheet value can be
typed in directly. With `r = p_downstream / p_upstream`:

    choked      (r ≤ b):  q = C · ρ₀ · p_up
    subsonic    (r > b):  q = C · ρ₀ · p_up · √(1 − ((r−b)/(1−b))²)

Near equilibrium the elliptic law has infinite slope. The model crosses over to a laminar
branch there — which is not a numerical hack: at low Reynolds number the real flow is
laminar too.

## The pressure network

All ports are merged into pressure nets by union-find, and every net is a gas reservoir.
Per 1 ms tick, backward Euler on the gas state:

    V/(R·T·dt) · (p_new − p_old) = Σ q_in − p_old/(R·T) · dV/dt

The `p·dV/dt` term is the piston↔chamber coupling: a moving piston draws and pushes its own
gas. A **damped fixed-point iteration** resolves the nonlinearity — each restriction is
linearised to a secant conductance once per iteration. Iteration count and residual are
published on the snapshot, and **non-convergence is reported, never swallowed**.

Backward Euler rather than an explicit step is a deliberate choice: a small chamber behind a
large orifice is stiff, and an explicit integrator would need a timestep set by the stiffest
node in the circuit rather than by the physics anyone wants to watch.

## Mechanics

Force balance `p_A·A_A − p_B·A_B − load − friction`, with friction in three parts:

- **viscous** — integrated implicitly, because m/c ≈ 1 ms at a 1 ms step and the explicit
  form rings,
- **Coulomb**,
- **stiction** — which is what lets a cylinder *hold* against a small pressure difference
  instead of creeping. Without it, every circuit drifts.

End stops are hard, without overshoot.

## End-position cushioning

A cushion is not a brake, and it is not modelled as one — there is no deceleration term
anywhere in the force balance. The cushioning boss covers the main port over the last few
millimetres, the escaping air has to leave through an adjustable needle instead, and the
pressure that builds in the trapped chamber decelerates the piston through the ordinary force
balance.

Modelling it needs the chamber to stop *being* its port. Everywhere else a chamber is gas
storage stamped directly on its port's net, which leaves no place to put a restriction between
them. So the cylinder claims two **component-internal pressure nodes** — the same facility the
MNA branch uses for internal electrical nodes, extended to the fluid solver — and the cushion
sits on the path from chamber node to port net:

    open port      C = 1.2e-7          (stiff next to any valve)
    boss sealing   C = C_port·(1−d/0.25)²  + C_needle    for d < 0.25
    sealed         C = C_needle = needle · 1.25e-9

`d` is how far the boss has entered, 0 at the start of the cushion and 1 at the end stop. Two
details are load-bearing, and both were found by measurement rather than by reasoning:

- **The needle is an absolute conductance, not a fraction of the port.** The port is ten times
  stiffer than a valve path, so a needle expressed as a percentage of it is still wider than
  the route the air already takes — the first version cushioned nothing at all for exactly
  this reason.
- **The port closes over the first quarter of the cushion, squared.** A linear blend across
  the full length leaves the path at five times a valve port when the boss is halfway in, and
  the piston is through the cushion before anything happens.

The check valve every cushioned cylinder carries is a direction test on the *piston*, not on
the pressure difference: while the path is still open those two pressures are equal to within
solver noise, so a sign test on them flickers and switches the cushion off exactly as it
should be engaging.

### What falls out of it

| Observation | Measurement |
| --- | --- |
| Impact velocity, 2 kg on a 25 mm bore | 0.913 m/s → 0.060 m/s, a 93 % reduction |
| Chamber pressure while cushioning | 16.5 bar, well above the 6 bar supply — which is the proof it is pressure doing the work |
| Cost in cycle time | +2.2 % extend, +4.1 % retract; the check valve keeps the filling stroke clear |
| Needle sweep, 2 kg | 2 %: 0.125 · 6 %: 0.098 · **12 %: 0.060** · 25 %: 0.400 · 50 %: 0.579 · 100 %: 0.724 m/s |
| Mass sweep at a fixed needle | 0.5 kg: 57 % · 1 kg: 69 % · **2 kg: 93 %** · 4 kg: 36 % · 8 kg: 17 % |

The last two rows are the interesting ones, and neither is programmed. **Closing the needle
further eventually makes the cushion worse**: air that cannot escape is a spring, and a spring
returns the energy it stored instead of dissipating it. And a fixed needle has a **mass window**
— too light and the piston never compresses enough air to generate force, too heavy and the
cushion is simply overwhelmed. That is why a real cushioning needle is adjustable at all, and
why manufacturers publish cushioning capacity as an envelope rather than a number.

## What falls out by itself

None of this is coded as a special case. These are gate measurements on the assembled
system:

| Observation | Measurement |
| --- | --- |
| A throttle regulates speed | 0.25 s → 0.29 → 0.47 → 1.00 → 2.71 s across the adjustment range |
| Quick-exhaust valve | 62 % shorter retract time (0.125 s → 0.047 s) |
| Meter-out holds an overrunning load | 9.8 bar back pressure, controlled at 0.30 m/s |
| Meter-in loses it | 0.2 bar, 1.28 m/s — a 4.2× loss of control |
| An impulse valve stores its state | holds position for 3 s with no signal at all |
| Latching circuit | relay contacts read coils one tick late — physically the pull-in time, and exactly what breaks the algebraic loop |

Timestep 1 ms, roughly 190× real time.

## Hydraulics

A second domain with its own physics, sharing the same solver. Oil is nearly
incompressible, so pressure comes from the **stiffness** of the trapped volume:

    V/(β·dt) · (p_new − p_old) = Σ q_vol − dV/dt

Flow is the orifice equation `q = K·sign(Δp)·√|Δp|`, laminar below 0.1 bar. Oil cavitates
instead of going negative: pressure clamps at vapour pressure, not at zero.

Oil and air ports live in separate network graphs, so the editor refuses to connect them
automatically — no special case needed.

**β = 1.2e8, not the textbook 1.6e9.** That is the honest number for a circuit with hose
and roughly 1 % entrained air. With the pure-oil value one node was so stiff that a pump
built 13 bar per millisecond — three times the entire overlap of a relief valve per tick —
and no pressure relief valve could regulate against it.

## Electronics — modified nodal analysis

The ladder is a purely resistive DC solver: conductances against fixed rails, square and
linear, because a relay circuit contains nothing else. Continuous electronics does not fit
that in three places, and each gets the textbook answer:

- An **ideal voltage source** has no conductance. It brings its own unknown (its branch
  current) and its own row — that is the *Modified* in MNA. Component-internal nodes draw
  from the same pool; to the matrix the two are the same thing.
- A **capacitor** depends on its own history and is replaced by its backward-Euler
  companion: a conductance `C/dt` beside a current source carrying the charge already on
  the plates. The same implicit step as gas and oil.
- A **pn junction** is exponential, so **Newton–Raphson** runs per timestep — not the
  damped fixed point of the fluid side. `exp()` has an analytic derivative, and no amount
  of relaxation tames a curve that steep. Step limiting is SPICE's `pnjlim`: it shortens a
  step, never redirects it, and therefore converges on the true solution rather than on a
  damped one.

**The electrical timestep is decoupled from the fluid tick.** A 100 kHz square wave shows
why: one period is 10 µs, and sampled on the 1 ms tick boundary it becomes a DC level. Each
continuous component declares the step it needs via `electricDt`, and the tick is divided
into a whole number of them. At 100 kHz that is 4000 steps of 250 ns per tick.

| Observation | Measurement |
| --- | --- |
| RC charging curve vs. the analytic solution | largest relative error 0.45 % over 5 τ |
| 100 kHz square wave, sub-tick sampled | 100.000 kHz measured back, 40 samples per period |
| same source sampled on the tick boundary | constant −10 V — exactly the aliasing |
| Diode | 0.83 V forward / −24 V reverse, ratio 2.3·10⁷ |
| Transistor as a switch | U_CE 24 V → 50 mV, β_eff 10 instead of 200 (saturated) |
| Saturation offset voltage (Ebers–Moll) | 10.4 mV, 0.34 % load dependence at 10× load |
| MOSFET, √I_D extrapolation | reads back U_th = 1.94 V (declared 2.0) |
| Newton, diode from a cold start | 7 iterations; 1 thereafter |

The MNA branch is **enabled per sheet**: with no continuous component present, the resistive
solver runs unchanged — including the digital settle loop and the one-tick relay delay that
latching depends on. Both branches share the same network graph and the same `stampElectric`
components, so a relay contact switches an RC circuit without either branch knowing.

## Digital logic timing

Gates and flip-flops sit on the same electrical network graph as the ladder, not in a
separate boolean world: a gate output is a real node, so a lamp on it lights up, and a gate
behind a relay contact reads it.

The timing deliberately splits:

- **Combinational gates settle within one tick** — the engine re-solves until levels hold. A
  chain of five needs seven passes, but one tick.
- **Flip-flops clock on the tick boundary.**

One gate per tick would make an 8-bit adder take 8 ms. Without the tick boundary at the
flip-flops, every feedback path would be an algebraic loop.
