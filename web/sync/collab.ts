// The glue between a space group's engine, live layer and gesture holds and the boards open on it, as BreezyKit's
// Collab; the apps keep visibility, drawing and windows. While a gesture holds items, what it changes goes live; at its
// end the board is pushed at once, then let go. Any other edit, an edit ending a gesture that held nothing included, is
// pushed at once and, when its push goes now, shown on others' screens ahead of it.
import { liveFields, startPositions } from "./overlay.js";

export class Collab {
  /** `group`: a Spaces group; `holds`: the GestureHolds shared by the device's groups. */
  constructor(group, holds) {
    this.group = group;
    this.holds = holds;
    this.sessions = new Set();
    // others follow a held gesture live, and see its intermediate states pushed as changes they restack around
    group.engine.holdBack = () => this.busy && !!group.live?.connected && group.live.mine.size > 0;
  }

  /** Whether a board open on the group is in a gesture. */
  get busy() {
    return [...this.sessions].some((s) => s.model.inGesture);
  }

  /** Board `id` open in `model` and `binding`; `items(start, board, mine, id)` is what a gesture sends live, and
   * `caret()` where its text caret is. */
  open(id, model, binding, { caret = () => null, items = liveFields } = {}) {
    const s = new Session(this, id, model, binding, caret, items);
    this.sessions.add(s);
    binding.taken = () => this.group.live?.taken() ?? new Set();
    return s;
  }

  /** About once a second: the live layer's tick, and holds let go that no gesture or finish explains. */
  tick() {
    const { live, space } = this.group;
    if (!live || !space) return;
    live.tick();
    this.holds.sweep(space, { holding: live.mine.size > 0, busy: this.busy, release: () => live.release() });
  }
}

class Session {
  constructor(collab, id, model, binding, caret, items) {
    Object.assign(this, { collab, id, model, binding, caret, items });
    /** The model was in a gesture at the last edit. */
    this.gesturing = false;
    /** A gesture asked for holds and has not finished yet. */
    this.unfinished = false;
  }

  /** Asks the relay to hold `ids` for the gesture starting. */
  hold(ids) {
    const live = this.collab.group.live;
    if (!live) return;
    this.unfinished = true;
    live.hold(ids);
    // what the gesture did before it held, such as making the card it edits, shows now rather than at its next change
    this.edited();
  }

  /** After every change to the model, after the binding's own handling. */
  edited() {
    const { model, binding, id } = this;
    const { group, holds } = this.collab;
    const live = group.live;
    if (model.inGesture) {
      this.gesturing = true;
      if (!live?.mine.size) return;
      live.sendLive(id, this.items(model.start, model.board, live.mine, id), this.caret(), startPositions(model.start, live.mine));
      return;
    }
    const ended = this.gesturing;
    this.gesturing = false;
    if (!ended || !this.unfinished) {
      const before = binding.seen;
      if (!binding.flush() || !group.space) return;
      // shown only when its push goes now, as others would see it undone when the preview lapses
      const now = group.engine.pushesNow();
      group.engine.sync();
      const ids = new Set([...before.cards, ...before.lanes, ...model.board.cards, ...model.board.lanes].map((x) => x.id));
      if (live && now) live.sendEdit(id, liveFields(before, model.board, ids, id));
      return;
    }
    this.unfinished = false;
    if (!group.space) return;
    holds.finish(group.space, {
      flush: () => binding.flush(),
      sync: () => group.engine.sync(),
      busy: () => this.collab.busy,
      release: () => group.live?.release(),
    });
  }

  /** The board is no longer open: its model no longer counts as busy. */
  close() {
    this.collab.sessions.delete(this);
  }
}
