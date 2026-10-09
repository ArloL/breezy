import { changes } from "./sync/records.js";

/**
 * Keeps the open board's model and the store in step, as BreezyKit's BoardBinding. Local edits go into the store field
 * by field, so they never overwrite a field the other device changed. Changes merged from the server come back once
 * no gesture is under way, stacked as this device shows them; the restacked positions stay local, as devices measure
 * text differently and would push each other's layouts forever.
 */
export class Binding {
  constructor(store, model, id, restack) {
    this.store = store;
    this.model = model;
    this.id = id;
    this.restack = restack;
    /** The board as last given to or taken from the store, stacked as shown. */
    this.seen = structuredClone(model.board);
    this.waiting = false;
    this.timer = null;
    /** Items someone else holds: local changes to them are not written, as the holder's are the ones that count. */
    this.taken = () => new Set();
  }

  /** After every change to the model: a merge that waited comes in now, else the change is flushed shortly. */
  changed() {
    if (this.waiting && !this.model.inGesture) return this.pull();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    const held = this.taken();
    const c = changes(this.seen, this.model.board, this.id, this.store.orders(this.id));
    for (const id of held) delete c[id];
    this.seen = structuredClone(this.model.board);
    if (Object.keys(c).length) this.store.apply(c);
  }

  /** After the store merged changes for this board. */
  pull() {
    this.flush();
    if (this.model.inGesture) {
      this.waiting = true;
      return;
    }
    this.waiting = false;
    const b = this.store.board(this.id);
    this.restack(b);
    this.seen = structuredClone(b);
    this.model.applyRemote(b);
  }
}
