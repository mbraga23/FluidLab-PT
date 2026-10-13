// Undo/redo.
//
// Snapshot-based rather than command-based: the document serialises to compact JSON
// already, and a circuit of a few hundred parts is a few tens of kB. Inverse commands
// would be faster in principle and a great deal more code to get wrong — every new
// component type would owe the history an inverse. Snapshots cannot drift out of sync
// with the model, which for an editor where a lost edit is unrecoverable is the trade
// worth making.
//
// Edits that arrive in a burst (dragging a slider, nudging a part) are coalesced by
// `tag`: consecutive pushes with the same tag inside COALESCE_MS replace rather than
// stack, so one drag is one undo step.

import { Circuit } from './circuit.js';

const LIMIT = 100;
const COALESCE_MS = 600;

export class History {
  constructor(circuit) {
    this.stack = [this.capture(circuit)];
    this.index = 0;
    this.lastTag = null;
    this.lastAt = 0;
  }

  capture(circuit) {
    return JSON.stringify(circuit.toJSON());
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }

  /**
   * Records the state *after* an edit. `tag` groups a burst of related edits into one
   * undo step; pass a distinct tag (or none) to force a separate step.
   */
  push(circuit, tag = null) {
    const snap = this.capture(circuit);
    if (snap === this.stack[this.index]) return; // nothing actually changed

    const now = Date.now();
    const coalesce = tag !== null && tag === this.lastTag && now - this.lastAt < COALESCE_MS;
    this.lastTag = tag;
    this.lastAt = now;

    if (coalesce && this.index > 0) {
      this.stack[this.index] = snap;
      return;
    }

    this.stack.length = this.index + 1; // drop any redo branch
    this.stack.push(snap);
    if (this.stack.length > LIMIT) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  undo() {
    if (!this.canUndo) return null;
    this.index--;
    this.lastTag = null;
    return this.restore();
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    this.lastTag = null;
    return this.restore();
  }

  restore() {
    return Circuit.fromJSON(JSON.parse(this.stack[this.index]));
  }

  /** Called when a whole new document replaces the current one. */
  reset(circuit) {
    this.stack = [this.capture(circuit)];
    this.index = 0;
    this.lastTag = null;
  }
}
