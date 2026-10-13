# The correctness gate

```bash
npm test          # or: node tests/run.js
```

92 tests in 4 suites, no framework. A test framework would cost more than it saves here, and
this keeps `node tests/run.js` the whole story. Suites are discovered rather than listed: a
new area drops in as `tests/gate-*.js` and runs, with no shared registry file for parallel
work to collide on.

| Suite | Covers |
| --- | --- |
| `gate.js` | Flow, mechanics, nets, sequences, faults, hydraulics, GRAFCET |
| `gate-electronics.js` | MNA, Newton, companion models, sub-tick sampling |
| `gate-plc.js` | Soft PLC, Structured Text, ladder equivalence, I/O ports |
| `gate-pdf.js` | PDF export |

## What the tests assert

They check **behaviour that emerges from the physics**, not that code exists. Each one is
written so that it *can* fail; several fired on their first run and found real bugs.

A test like "a throttle regulates speed" does not inspect a throttle object. It builds a
circuit, sweeps the adjustment range, and asserts that the resulting stroke times are
monotonic and span a useful ratio — 0.25 s to 2.71 s, as it turns out. If the flow model
were replaced by an animation curve tomorrow, that test would still pass only if the
replacement were physically honest.

The same standard applies to the claims in [PHYSICS.md](PHYSICS.md): every number in those
tables is a gate measurement, not a design target.

## Budgeted imperfections

Two are asserted rather than hidden:

- Every net has a tiny leak path to atmosphere (`C_LEAK`) for conditioning. Mass conservation
  drifts by roughly 0.05 % per 2 s, and the gate budgets exactly that — a tighter bound would
  fail, a looser one would stop catching real leaks.
- The backward-Euler discretisation is O(dt/τ) slow: 0.45 % on the RC curve at τ = 1 ms with a
  10 µs step. The gate asserts the bound instead of pretending the error is zero.

## One deliberate deviation from the specification

The specification asks for "assert velocity variance" on meter-in vs. meter-out throttling.
Measured against this model that is the wrong metric — **meter-in produces the *lower*
variance** (0.003 vs. 0.14), because an uncontrolled slam is perfectly uniform while a
controlled motion has structure.

The test instead asserts what actually distinguishes the two: which side determines the
velocity, via back pressure and peak speed. The reasoning is written in the test, next to the
assertion, so the next reader can disagree with it on the evidence.
