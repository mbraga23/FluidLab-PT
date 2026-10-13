# Changelog

Notable changes to FluidLab. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **End-position cushioning** on the double-acting cylinder, adjustable in length and needle
  setting. The deceleration is not a force term: the cushioning boss throttles the chamber's
  path to its port, and the pressure that builds does the work. Impact velocity drops from
  0.913 to 0.060 m/s for a 2 kg load at 16.5 bar chamber pressure, costing 2.2 % of cycle time.
- **Component-internal nodes in the fluid solver** (`fluidExtras`), mirroring the facility the
  MNA branch already had. A cushion needs the chamber to be a node distinct from the port it
  feeds; there was previously nowhere to put the restriction.
- Two gate tests: that the cushion works through chamber pressure rather than a braking term,
  and that closing the needle too far turns it into an air spring and makes it worse again.

## [1.0.0] — 2026-07-27

First tagged release. The simulator is feature-complete against its own scope; the
boundaries it does *not* cross are listed in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

### Simulation core

- Pneumatic network solver: ISO 6358 flow (sonic conductance `C`, critical ratio `b`) with a
  laminar crossover near equilibrium, union-find pressure nets, backward-Euler gas state, and
  a damped fixed-point iteration that reports non-convergence rather than hiding it.
- Cylinder mechanics with viscous, Coulomb and static friction; hard end stops without
  overshoot.
- Hydraulic domain sharing the solver: stiffness-driven pressure, orifice equation with a
  laminar branch, cavitation clamped at vapour pressure, air and oil in separate graphs.
- Continuous electronics via modified nodal analysis: companion models for reactive parts,
  Newton–Raphson with SPICE `pnjlim` step limiting on pn junctions, and an electrical timestep
  decoupled from the 1 ms fluid tick.
- Digital logic on the same electrical graph — combinational gates settle within a tick,
  flip-flops clock on the tick boundary.

### Control layer

- GRAFCET to EN 60848: evolution rules R1–R5, simultaneous firing against a frozen snapshot,
  a recursive-descent condition parser (`*`, `+`, `/`, `↑`, `↓`, `t/X2/5s`, parentheses),
  continuous and stored actions, structure checking, and a graphical chart editor with live
  token display.
- Soft PLC: Structured Text subset (assignment, IF/ELSIF/ELSE, boolean expressions with real
  precedence, `VAR`, time literals, TON/TOF/CTU/CTD) and ladder rungs compiling to the same
  runtime.
- Named digital and analogue I/O ports with mock and (stub) WebSocket drivers.

### Editor and instrumentation

- 80 components across pneumatics, electrics, hydraulics, digital logic and electronics, each
  declaring its own plausible faults.
- Four-channel oscilloscope with edge trigger, cursors, freeze and CSV; virtual probes proven
  non-invasive by the gate.
- Displacement-step diagram, bill of materials derived from the drawing, undo/redo, resizable
  panels.
- Export to JSON, SVG, PNG, PDF and CSV — PNG rasterised from the same SVG the exporter
  writes, so the two cannot drift apart.

### Quality

- Correctness gate: 92 behavioural tests in 4 auto-discovered suites, no framework.
- CI on Node 18, 20 and 22, including a check that the zero-dependency claim still holds.

### Licensing

Released under [PolyForm Noncommercial 1.0.0](LICENSE). Noncommercial use — including by
schools, universities, public research bodies and charities — is free. Commercial use requires
a separate written licence.

[1.0.0]: https://github.com/alex-hahn/fluidlab/releases/tag/v1.0.0
