// I/O ports — the EasyPort / OPC / DDE equivalent.
//
// This is the seam between the simulated plant and anything outside it. A port is a
// *named* digital or analog signal with a direction, and a binding that says what the
// name means on the circuit side.
//
// COUPLING CHANNEL
// ----------------
// There is exactly one channel into and out of the circuit, and it is the one relay coils
// and GRAFCET already use:
//
//   reading   sim.signal(tag)          -> sensor, button, contact, spool position, coil
//   writing   sim.energized.set(tag,v) -> whatever carries that tag (a solenoid valve
//                                         reads `energized` in its updateState)
//
// Nothing here invents a second mechanism. A solenoid cannot tell whether a ladder, a
// chart, a soft-PLC or an external PLC across a socket is driving it — which is the whole
// point, and the reason this file needed no change to engine.js.
//
// TICK ORDER
// ----------
// The simulation's tick is: electrics -> chart -> component state -> pneumatics ->
// hydraulics -> mechanics. `runHeadless` calls its `script` hook *before* sim.step(), so a
// PLC driven from there lands in front of the whole tick:
//
//   scan   read inputs   (sensor states as of the END of the previous tick)
//   exec   run the logic
//   flush  write outputs (seen by updateState later in THIS tick)
//
// The one-tick input delay is not an artefact to apologise for: it is the input scan of a
// real PLC, and it is the same delay that breaks the algebraic loop in a self-holding
// ladder (see Simulation.solveElectric). A PLC that saw its own outputs' consequences in
// the same scan would not be a PLC.
//
// DIRECTIONS ARE FROM THE LOGIC'S POINT OF VIEW
// ---------------------------------------------
// `in` = something the logic reads. `out` = something the logic writes. An external
// process attached through a driver sees the mirror image: it *writes* our inputs and
// *reads* our outputs. That is what lets the same map serve both spec requirements — the
// simulation as a controller for an external process (bind outputs to the driver), or the
// simulation driven by an external one (bind inputs to the driver).

/** Coerces a port value to a level. Analog values compare against zero. */
export const truthy = (v) => (typeof v === 'boolean' ? v : Number(v) !== 0);

const DIGITAL = 'digital';
const ANALOG = 'analog';

/**
 * A named port table over a Simulation.
 *
 * `sim` may be null: a map with no simulation is a perfectly good I/O image for a PLC
 * that only talks to a driver, and the mock-driver tests use exactly that.
 */
export class IOMap {
  constructor(sim = null) {
    this.sim = sim;
    this.ports = new Map();
    this.driver = null;
    this.scans = 0;
  }

  // --- declaration -------------------------------------------------------

  /**
   * @param {object} spec
   * @param {string} spec.name   the name the logic uses
   * @param {'digital'|'analog'} spec.kind
   * @param {'in'|'out'} spec.dir
   * @param {string} [spec.tag]  circuit tag; inputs read sim.signal(tag), outputs write
   *                             sim.energized. Digital only.
   * @param {(sim) => any} [spec.read]   custom circuit-side source for an input
   * @param {(sim, v) => void} [spec.write] custom circuit-side sink for an output
   * @param {boolean} [spec.invert] digital only — an NC-wired sensor reports the level
   *                                inverted, and pretending otherwise costs a NOT in
   *                                every expression that touches it
   * @param {any} [spec.value]    initial value
   */
  add(spec) {
    const { name, kind, dir } = spec;
    if (!name) throw new Error('A porta precisa de um nome');
    if (this.ports.has(name)) throw new Error(`A porta “${name}” já está em uso`);
    if (kind !== DIGITAL && kind !== ANALOG) throw new Error(`Porta “${name}”: tipo desconhecido “${kind}”`);
    if (dir !== 'in' && dir !== 'out') throw new Error(`Porta “${name}”: a direção deve ser in ou out`);
    if (spec.tag && kind !== DIGITAL) {
      // `energized` is a Map of tag -> bool. An analog value has no home there, and
      // silently truncating one to a level would be a lie.
      throw new Error(`Porta “${name}”: associação por identificação disponível apenas para portas digitais`);
    }
    const port = {
      name, kind, dir,
      tag: spec.tag ?? null,
      read: spec.read ?? null,
      write: spec.write ?? null,
      invert: !!spec.invert,
      value: spec.value ?? (kind === DIGITAL ? false : 0),
      bound: !!(spec.tag || spec.read || spec.write),
    };
    this.ports.set(name, port);
    return port;
  }

  digitalIn(name, opts = {}) { return this.add({ ...opts, name, kind: DIGITAL, dir: 'in' }); }
  digitalOut(name, opts = {}) { return this.add({ ...opts, name, kind: DIGITAL, dir: 'out' }); }
  analogIn(name, opts = {}) { return this.add({ ...opts, name, kind: ANALOG, dir: 'in' }); }
  analogOut(name, opts = {}) { return this.add({ ...opts, name, kind: ANALOG, dir: 'out' }); }

  has(name) { return this.ports.has(name); }
  port(name) {
    const p = this.ports.get(name);
    if (!p) throw new Error(`Porta desconhecida “${name}”`);
    return p;
  }
  list(dir = null) {
    return [...this.ports.values()].filter((p) => !dir || p.dir === dir);
  }

  // --- values ------------------------------------------------------------

  /** Current value of any port. Reading back an output is normal (a latched coil). */
  get(name) { return this.port(name).value; }

  /** Writes an output. Writing an input from the logic is an error, as on real hardware. */
  set(name, value) {
    const p = this.port(name);
    if (p.dir !== 'out') throw new Error(`A porta “${name}” é uma entrada e não pode ser escrita`);
    p.value = p.kind === DIGITAL ? truthy(value) : Number(value);
    return p.value;
  }

  /**
   * Writes an *input* from outside the logic — what a driver (or a test standing in for
   * one) does. Deliberately a different method from `set`: the two have opposite
   * legitimacy, and one name for both would let a program silently forge its own inputs.
   */
  force(name, value) {
    const p = this.port(name);
    if (p.dir !== 'in') throw new Error(`A porta “${name}” é uma saída — use set()`);
    p.value = p.kind === DIGITAL ? truthy(value) : Number(value);
    return p.value;
  }

  // --- driver ------------------------------------------------------------

  /**
   * A driver is the external process. Both hooks are optional:
   *
   *   onScan(io, t)   after inputs were sampled from the circuit — the driver may
   *                   `io.force(...)` its own values, which then win for this scan
   *   onFlush(io, t)  after the logic wrote its outputs — the driver may read them
   *
   * Both are called synchronously inside the tick. A driver that needs to wait for a
   * network round trip must not: see WebSocketDriver.
   */
  attach(driver) { this.driver = driver; driver?.onAttach?.(this); return driver; }
  detach() { this.driver?.onDetach?.(this); this.driver = null; }

  // --- the tick ----------------------------------------------------------

  /** Samples every bound input from the circuit, then lets the driver overwrite inputs. */
  scan() {
    for (const p of this.ports.values()) {
      if (p.dir !== 'in' || !this.sim) continue;
      let v;
      if (p.read) v = p.read(this.sim);
      else if (p.tag) v = this.sim.signal(p.tag);
      else continue; // unbound: the driver owns it
      p.value = p.kind === DIGITAL ? truthy(v) !== p.invert : Number(v);
    }
    this.driver?.onScan?.(this, this.sim?.time ?? this.scans);
    this.scans++;
  }

  /** Publishes every bound output into the circuit, then lets the driver read them. */
  flush() {
    for (const p of this.ports.values()) {
      if (p.dir !== 'out' || !this.sim) continue;
      if (p.write) { p.write(this.sim, p.value); continue; }
      if (!p.tag) continue; // unbound: the driver owns it
      this.sim.energized.set(p.tag, truthy(p.value) !== p.invert);
    }
    this.driver?.onFlush?.(this, this.sim?.time ?? this.scans);
  }

  /** Wire-format snapshot: what a driver sends or receives. */
  frame(t = this.sim?.time ?? 0) {
    const inputs = {}, outputs = {};
    for (const p of this.ports.values()) {
      (p.dir === 'in' ? inputs : outputs)[p.name] = p.value;
    }
    return { t: +Number(t).toFixed(6), in: inputs, out: outputs };
  }
}

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

/**
 * The external process, in-process and deterministic.
 *
 * Two uses, matching the two directions of the spec requirement:
 *
 *   inputs   `script(scan, io, t)` is the external process writing our inputs. It gets the
 *            scan counter rather than wall time so a run is reproducible bit for bit.
 *   outputs  every flushed output frame is recorded in `frames`, which is the external
 *            process reading what the simulation commands.
 */
export class MockDriver {
  constructor({ script = null, record = true, limit = Infinity } = {}) {
    this.script = script;
    this.record = record;
    this.limit = limit;
    this.frames = [];
    this.scan = 0;
  }

  onScan(io, t) {
    this.script?.(this.scan, io, t);
    this.scan++;
  }

  onFlush(io, t) {
    if (!this.record || this.frames.length >= this.limit) return;
    const f = io.frame(t);
    this.frames.push(f);
  }

  /** Output values as the external process saw them, per scan. */
  outputs(name) { return this.frames.map((f) => f.out[name]); }

  /** Scan indices where `name` changed to `value` — the edges, not the levels. */
  edges(name, value = true) {
    const out = [];
    let prev;
    this.frames.forEach((f, i) => {
      const v = f.out[name];
      if (i > 0 && v !== prev && v === value) out.push(i);
      prev = v;
    });
    return out;
  }
}

/**
 * WebSocket driver — a stub, and honest about it.
 *
 * What it does: serialises the output image to a JSON frame per tick and applies the most
 * recently received input frame at scan time.
 *
 * What it deliberately does NOT do: wait. A tick is 1 ms of simulated time and runs ~190×
 * real time; a network round trip is several milliseconds of *wall* time. Blocking the
 * loop on a socket would either deadlock the browser's frame loop or silently turn the
 * simulation into a real-time system it is not. So this is a *latest-value* coupling: the
 * newest frame received wins, older ones are dropped, and `stale` counts the scans that
 * reused a frame. A control loop that cannot tolerate that must not be closed over a
 * socket — that is a property of the medium, not of this file.
 *
 * `socket` is injected rather than constructed so this runs under Node and under test with
 * anything that has send()/readyState and accepts an onmessage handler.
 */
export class WebSocketDriver {
  static OPEN = 1;

  constructor({ socket = null, url = null, open = null } = {}) {
    this.url = url;
    this.pending = null;   // newest received input frame, not yet applied
    this.applied = null;
    this.stale = 0;        // scans that ran on an already-used frame
    this.sent = 0;
    this.dropped = 0;      // frames received but superseded before a scan could use them
    this.socket = null;
    if (socket) this.connect(socket);
    else if (url && open) this.connect(open(url));
  }

  connect(socket) {
    this.socket = socket;
    socket.onmessage = (ev) => this.receive(ev?.data ?? ev);
    return this;
  }

  /** Accepts a raw JSON frame. Superseding an unread frame is counted, never queued. */
  receive(data) {
    let frame;
    try { frame = typeof data === 'string' ? JSON.parse(data) : data; }
    catch { return; } // a malformed frame must not take the tick loop down with it
    if (!frame || typeof frame !== 'object') return;
    if (this.pending) this.dropped++;
    this.pending = frame;
  }

  onScan(io) {
    const frame = this.pending ?? this.applied;
    if (!frame) return;
    if (!this.pending) this.stale++;
    for (const [name, value] of Object.entries(frame.in ?? {})) {
      // An unknown name is the remote end's problem, not ours; dropping it beats throwing
      // inside a tick loop that has no one to report to.
      if (io.has(name) && io.port(name).dir === 'in') io.force(name, value);
    }
    this.applied = frame;
    this.pending = null;
  }

  onFlush(io, t) {
    if (!this.socket || this.socket.readyState !== WebSocketDriver.OPEN) return;
    this.socket.send(JSON.stringify(io.frame(t)));
    this.sent++;
  }

  onDetach() { this.socket?.close?.(); }
}
