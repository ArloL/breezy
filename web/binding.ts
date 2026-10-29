import { changes } from "./sync/records.ts";
import type { Model } from "./model.ts";
import type { Edits } from "./sync/records.ts";
import type { Orders } from "./sync/order-key.ts";
import type { Board } from "./types.ts";

/** What `Binding` uses of the store. */
export interface BindingStore {
  orders(board: string): Orders;
  apply(edits: Edits): void;
  board(id: string): Board;
}

/**
 * Keeps the open board's model and the store in step, as BreezyKit's BoardBinding. Local edits go into the store field
 * by field, so they never overwrite a field the other device changed. Changes merged from the server come back once
 * no gesture is under way, stacked as this device shows them; the restacked positions stay local, as devices measure
 * text differently and would push each other's layouts forever.
 */
export class Binding {
  store: BindingStore;
  model: Model;
  id: string;
  restack: (b: Board) => void;
  seen: Board;
  waiting: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  taken: () => ReadonlySet<string>;
  typing: () => boolean;

  constructor(store: BindingStore, model: Model, id: string, restack: (b: Board) => void) {
    this.store = store;
    this.model = model;
    this.id = id;
    this.restack = restack;
    /** The board as last given to or taken from the store, stacked as shown. */
    this.seen = structuredClone(model.board);
    this.waiting = false;
    this.timer = undefined;
    /** Items someone else holds: local changes to them are not written, as the holder's are the ones that count. */
    this.taken = () => new Set();
    /** Whether the gesture under way is typing: its text is flushed every 300 ms however fast the keys come, as Safari
     * on iOS loses what a page left or killed had not written. */
    this.typing = () => false;
  }

  /** After every change to the model: a merge that waited comes in now, else the change is flushed shortly. */
  changed() {
    if (this.waiting && !this.model.inGesture) return this.pull();
    if (this.timer !== undefined && this.model.inGesture && this.typing()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  /** Writes what changed since the store last saw the board; → whether anything did. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const held = this.taken();
    const c = changes(this.seen, this.model.board, this.id, this.store.orders(this.id));
    for (const id of held) delete c[id];
    this.seen = structuredClone(this.model.board);
    if (!Object.keys(c).length) return false;
    this.store.apply(c);
    return true;
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
