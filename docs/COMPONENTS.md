# Component library — 80 components

Each entry is one record in a catalog file: symbol, ports, physics and plausible faults. See
[the component contract](ARCHITECTURE.md#the-component-contract) for how to add one.

## Pneumatics

**Actuators** — double-acting cylinder (with adjustable end-position cushioning: length and
needle setting), single-acting cylinder, cylinder with a through piston rod (bore, rod
diameter, stroke, mass, load, viscous and static/sliding friction)

**Supply** — compressed air source, silencer

**Directional valves** — 3/2 (pushbutton NC/NO, detented hand lever, roller lever), 5/2
impulse, 5/3 with closed centre, 3/2 and 5/2 solenoid-operated

**Check valves** — check, OR (shuttle), AND (two-pressure), quick exhaust

**Flow valves** — one-way flow control valve, switchable meter-in / meter-out

**Pressure valves** — pressure regulator with its own diaphragm chamber

**Valve groups** — time delay valve NC/NO, sequence valve

**Instrumentation** — pressure gauge, pressure switch (pneumatic → electric)

## Electrics

24 V / 0 V rails, pushbutton, relay coil + contacts, relay with pull-in and drop-out delay,
counting relay, solenoid coil, indicator lamp, emergency stop, limit switch, and reed,
inductive, capacitive and optical proximity switches.

Limit switches are assigned to a cylinder and a stroke position in the inspector. Coils and
contacts couple through their designation (K1, Y1 …) rather than through drawn wiring.

## Hydraulics

Hydraulic cylinder, tank, fixed-displacement pump, pressure gauge, 4/3 directional valves
(closed, float and open centre; hand lever and solenoid), pressure relief valve, counterbalance
valve, check valve, one-way flow control valve.

## Digital logic

AND/OR/NOT/NAND/NOR/XOR (2 and 3 inputs), RS flip-flop (set-dominant), D flip-flop
(edge-triggered), preset counter, clock generator.

## Electronics

Resistor, capacitor, inductor, potentiometer, 1N4007 diode, LED, Zener diode, NPN and PNP
transistor (Ebers–Moll), n-channel MOSFET (square law), operational amplifier, AC source
(sine / square / triangle up to 200 kHz), transformer.

## Worked examples

Loadable from the toolbar:

Direct control · Indirect control with an impulse valve · Speed control (meter-out) ·
Automatic reciprocation · **A+ B+ A− B−** with four limit valves · Time delay ·
Pressure-dependent sequence · Electropneumatic latching · **Hydraulic press with relief
valve** · **Holding a load with a counterbalance valve** · **GRAFCET: A+ B+ A− B−**

The GRAFCET example runs the same sequence as the pneumatic one with **10 components instead
of 11 and without a single limit valve**: the logic lives in the chart, not in the plumbing.
