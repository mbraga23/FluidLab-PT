# Architecture

One idea runs through the whole codebase: **a controller is not a circuit.** A ladder
diagram, a GRAFCET chart and a PLC program are three notations for a specification *above*
the circuit. They read its sensors and command its actuators through one narrow channel —
`sim.signal(tag)` in, `sim.energized` out — and nothing below them knows which one is
talking.

That is why adding the soft PLC cost **no change to `engine.js`**.

- [Module map](#module-map)
- [The component contract](#the-component-contract)
- [Solver branches](#solver-branches)
- [Controllers above the circuit](#controllers-above-the-circuit)
- [Probes and the oscilloscope](#probes-and-the-oscilloscope)
- [Derived, never stored](#derived-never-stored)

## Module map

| File | Contents |
| --- | --- |
| `src/engine.js` | ISO 6358 + hydraulic orifices, nets, stamping, fixed-point iteration, headless API |
| `src/symbols.js` | ISO 1219 primitives, valve renderer with a sliding spool |
| `src/catalog.js` | Pneumatics/electrics — symbol, ports, physics and faults per component |
| `src/catalog-hydraulic.js` | Hydraulic components, same contract |
| `src/catalog-electronics.js` | Electronic components, same contract plus the MNA hook |
| `src/catalog-digital.js` | Gates, flip-flops, counters, clock generator |
| `src/circuit.js` | Document model, serialisation, worked examples |
| `src/grafcet.js` | EN 60848 evolution rules, condition parser, structure check |
| `src/grafcet-view.js` | Graphical chart editor — rendering, hit testing, live token display |
| `src/plc.js` | Soft PLC: ST parser, ladder, TON/TOF/CTU/CTD |
| `src/io.js` | I/O ports, mock and WebSocket drivers |
| `src/history.js` | Undo/redo |
| `src/diagram.js` | Displacement-step diagram, CSV |
| `src/scope.js` | Oscilloscope, virtual probes |
| `src/partslist.js` | Bill of materials derived from the drawing |
| `src/export.js` | JSON / SVG / PNG / PDF / CSV output |
| `src/panels.js` | Resizable panels |
| `src/main.js` | Canvas, direct manipulation, inspector, run loop |
| `tests/gate.js` | Correctness gate — fluids, mechanics, sequences |
| `tests/gate-plc.js` | Gate for the soft PLC and I/O |
| `tests/gate-electronics.js` | Gate for continuous electronics |
| `tests/gate-pdf.js` | Gate for PDF export |

## The component contract

A new component needs **one entry in a catalog file** — symbol, ports, physics, faults.
No change to the engine, no change to the inspector, no change to the UI. The interface is
documented at the top of `catalog.js`.

Two consequences fall out of that:

**Faults are declared, not built.** Each component declares the defects it can plausibly
have (`stuck`, `clogged`, `leak`, `off`, `seized`, `coil_open`, `contact_welded`, `drift` …)
and the inspector renders whatever the component offers. A new fault type needs no UI work.
Armed faults are marked on the sheet and are undoable.

**Labels couple, not wires.** Coils and contacts couple through their designation (K1, Y1 …)
rather than through drawn wiring — the way FluidSIM does it, and the way a real schematic is
read. Limit switches are assigned to a cylinder and a stroke position in the inspector.

## Solver branches

Two electrical solvers share one network graph:

    resistive DC ladder  ──┐
                           ├── same network graph, same stampElectric components
    MNA + Newton         ──┘

The MNA branch is enabled per sheet, and only when a continuous component is present. Without
one, the resistive solver runs unchanged — including the digital settle loop and the one-tick
relay delay that latching depends on. A relay contact can therefore switch an RC circuit
without either branch knowing the other exists.

The fluid side is separate again: air and oil live in distinct network graphs, which is why
the editor can refuse an air-to-oil connection without a special case.

**Component-internal nodes** are shared machinery rather than an electrical trick. A component
declares how many unknowns it needs beyond the nets — `extras` on the MNA side, `fluidExtras`
on the pneumatic one — and claims them with `st.extra()` during stamping. An ideal voltage
source uses one for its branch current; a cylinder with end-position cushioning uses two, one
per chamber, because a cushion needs the chamber to be a node distinct from the port it feeds.
They are claimed unconditionally so that changing a parameter mid-run cannot shift anyone
else's index.

See [PHYSICS.md](PHYSICS.md) for what each solver actually computes.

## Controllers above the circuit

**GRAFCET** (EN 60848) is deliberately **not** made of components. A chart is a
specification over the circuit with its own evolution rules, which have nothing to do with
nets and conductances. Forced into the electrical graph it would need wires the standard
does not define.

Rules R1–R5 are implemented: initial steps active at start; a transition is *enabled* when
all upstream steps are active and *fireable* when its condition is additionally true; firing
deactivates all predecessors and activates all successors; **all fireable transitions fire
simultaneously** against a frozen state snapshot — otherwise the second transition would
already see the first one's result; a step both activated and deactivated in the same
evolution stays active.

Transition conditions are a real boolean language with a recursive-descent parser (precedence
and parentheses do not work with regular expressions):

    S1              plant signal by designation
    X2              step activity
    /S1  !S1        negation
    S1 * S2         AND        S1 + S2   OR
    ↑S1  ↓S1        rising / falling edge
    t/X2/5s         X2 has been active for 5 s
    ( )             grouping

Charts are drawn in a **graphical editor** — place and move steps, link transitions, edit
actions in a side panel — with live token display during simulation. Structure checking
reports a missing initial step, unreachable steps, dead ends, duplicate step names and syntax
errors, and stays silent on a correct chart.

**Structured Text** (`src/plc.js`) is a subset, and says so: assignment, IF/ELSIF/ELSE,
`AND OR XOR NOT` with real precedence, comparisons, arithmetic, a `VAR` block, time literals
`T#500ms`, and the function blocks TON, TOF, CTU, CTD in IEC call syntax
`T1(IN := x, PT := T#1s); done := T1.Q;`. Recursive descent again, for the same reason:
`a OR b AND NOT c` has exactly one correct reading, and a pattern match does not find it.

Ladder rungs compile into the same closures, so there is one runtime for both languages —
and the gate checks that latching behaves identically in ladder and ST, scan for scan.

A scan is `scan → program → flush`, before `sim.step()`. Inputs are therefore one tick old.
That is not sloppiness; it is the input scan of a real PLC, and the same delay that breaks
the algebraic loop in the ladder.

**I/O ports** (`src/io.js`) are named digital and analogue points bound to the circuit.
Directions are stated from the logic's point of view: `in` is read, `out` is written — an
external process sees the mirror image. That is why one card serves both roles: the
simulation controlling an external process, or being driven by one. `set()` on an input
throws, exactly as real hardware would refuse it; a program must not forge its own sensors.

## Probes and the oscilloscope

**Probes are deliberately not components.** They have no stamp, no port and no place in the
network graph — which is the only way to *guarantee* the requirement that measurement must
not affect the circuit, rather than merely intending it. The gate proves it over 3000 ticks
with 8 probes attached: identical to the last bit.

Sampling happens in the tick loop (1000/s), not the frame loop. At 60 fps every 17th tick
would be captured, which is precisely the aliasing the design forbids.

## Derived, never stored

The bill of materials is computed from the drawing and never persisted. A parts list that can
disagree with the schematic is worse than no parts list. It groups by type *and
configuration* — a 25 mm and a 50 mm cylinder are two line items, eight identical valves are
one line reading "8×" — sorts designations naturally (1A1 before 1A10 before 2A1), and flags
armed faults.

Export follows the same rule. PNG is produced by rasterising the same SVG that the SVG export
writes, so the two outputs cannot drift apart. The exported SVG stands alone: inline styles,
a viewBox around the content, a title block with the date, and none of the editor's furniture
(port dots, selection frames, grid).
