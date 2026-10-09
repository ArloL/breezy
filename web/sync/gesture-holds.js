// When what a space's gestures hold is let go, as BreezyKit's GestureHolds. A gesture's finish writes its changes to the
// store and pushes them, then lets go, so that others have the push before the release; only the space's latest finish
// lets go, and only when none of the space's boards is in a gesture by then. Once a second, `sweep` lets go of holds that
// neither a gesture nor a finish explains, as when a finish never ran.

export class GestureHolds {
  constructor() {
    this.latest = new Map();
    this.running = new Map();
    this.idle = new Set();
  }

  /** A gesture of `space` ended or was cancelled: `flush` now, then `sync`, then `release` unless a later finish of the
   * space came meanwhile or `busy` says one of its boards is in a gesture. */
  async finish(space, { flush, sync, busy, release }) {
    flush();
    const n = (this.latest.get(space) ?? 0) + 1;
    this.latest.set(space, n);
    this.running.set(space, (this.running.get(space) ?? 0) + 1);
    try {
      await sync();
    } finally {
      this.running.set(space, this.running.get(space) - 1);
    }
    if (this.latest.get(space) === n && !busy()) release();
  }

  /** About once a second for each space: lets go when it is `holding` but, on two ticks running, was not `busy` with a
   * gesture and had no finish under way. The second tick leaves room for a gesture that ended just now. */
  sweep(space, { holding, busy, release }) {
    if (!holding || busy || this.running.get(space)) return this.idle.delete(space);
    if (!this.idle.has(space)) return this.idle.add(space);
    this.idle.delete(space);
    release();
  }
}
