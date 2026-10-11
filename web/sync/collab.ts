// The glue between a space group's engine, live layer and gesture holds and the boards open on it, as BreezyKit's
// Collab; the apps keep visibility, drawing and windows. While a gesture holds items, what it changes goes live; at its
// end the board is pushed at once, then let go. Any other edit, an edit ending a gesture that held nothing included, is
// pushed at once and, when its push goes now, shown on others' screens ahead of it.
import type { Board } from "../types.ts";
import { liveFields, startPositions } from "./overlay.ts";
import type { Caret, LiveItems } from "./overlay.ts";
import type { GestureHolds } from "./gesture-holds.ts";
import type { Group } from "./spaces.ts";

/** A board's model as a session sees it: `start` is the board when the gesture under way began. */
export interface SessionModel {
  readonly inGesture: boolean;
  start: Board | null;
  board: Board;
}

/** A board's binding to its store as a session sees it. */
export interface SessionBinding {
  seen: Board;
  flush(): boolean;
  taken: () => ReadonlySet<string>;
}

/** What a gesture sends live of `board`, begun as `start`, for the items `mine` holds on board `id`. */
export type LiveItemsOf = (start: Board, board: Board, mine: Set<string>, id: string) => LiveItems;

export class Collab {
  group: Group;
  holds: GestureHolds;
  sessions: Set<Session>;

  /** `group`: a Spaces group; `holds`: the GestureHolds shared by the device's groups. */
  constructor(group: Group, holds: GestureHolds) {
    this.group = group;
    this.holds = holds;
    this.sessions = new Set();
    // others follow a held gesture live, and see its intermediate states pushed as changes they restack around
    group.engine.holdBack = () => this.busy && !!group.live?.connected && group.live.mine.size > 0;
  }

  /** Whether a board open on the group is in a gesture. */
  get busy(): boolean {
    return [...this.sessions].some((s) => s.model.inGesture);
  }

  /** Board `id` open in `model` and `binding`; `items(start, board, mine, id)` is what a gesture sends live, and
   * `caret()` where its text caret is. */
  open(id: string, model: SessionModel, binding: SessionBinding, { caret = () => null, items = liveFields }: { caret?: () => Caret | null; items?: LiveItemsOf } = {}): Session {
    const s = new Session(this, id, model, binding, caret, items);
    this.sessions.add(s);
    binding.taken = () => this.group.live?.taken() ?? new Set();
    return s;
  }

  /** About once a second: the live layer's tick, and holds let go that no gesture or finish explains. */
  tick(): void {
    const { live, space } = this.group;
    if (!live || !space) return;
    live.tick();
    this.holds.sweep(space, { holding: live.mine.size > 0, busy: this.busy, release: () => live.release() });
  }
}

class Session {
  declare collab: Collab;
  declare id: string;
  declare model: SessionModel;
  declare binding: SessionBinding;
  declare caret: () => Caret | null;
  declare items: LiveItemsOf;
  /** The model was in a gesture at the last edit. */
  gesturing: boolean;
  /** A gesture asked for holds and has not finished yet. */
  unfinished: boolean;

  constructor(collab: Collab, id: string, model: SessionModel, binding: SessionBinding, caret: () => Caret | null, items: LiveItemsOf) {
    Object.assign(this, { collab, id, model, binding, caret, items });
    this.gesturing = false;
    this.unfinished = false;
  }

  /** Asks the relay to hold `ids` for the gesture starting. */
  hold(ids: Iterable<string>): void {
    const live = this.collab.group.live;
    if (!live) return;
    this.unfinished = true;
    live.hold(ids);
    // what the gesture did before it held, such as making the card it edits, shows now rather than at its next change
    this.edited();
  }

  /** After every change to the model, after the binding's own handling. */
  edited(): void {
    const { model, binding, id } = this;
    const { group, holds } = this.collab;
    const live = group.live;
    if (model.inGesture) {
      this.gesturing = true;
      if (!live?.mine.size) return;
      live.sendLive(id, this.items(model.start!, model.board, live.mine, id), this.caret(), startPositions(model.start, live.mine));
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
  close(): void {
    this.collab.sessions.delete(this);
  }
}
