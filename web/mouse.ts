import * as R from "./rules.ts";
import { pressAction } from "./policy.ts";
import type { DragAction, Hit } from "./policy.ts";
import type { Flight } from "./flight.ts";
import { planted } from "./sync/plant.ts";
import type { Board, HeightOf, Point } from "./types.ts";

export const SLOP = 3;
export const DOUBLE_MS = 500;
const DOUBLE_SLOP = 4;

/** What `Mouse` uses of the app. */
export interface MouseApp {
  state: { selection: ReadonlySet<string>; turned: string | null };
  model: { board: Board };
  heightOf: HeightOf;
  flight: Pick<Flight, "note">;
  input: {
    hit(p: Point, touch?: boolean): Hit;
    doubleClick(p: Point, h: Hit): void;
    beginDrag(action: DragAction, h: Hit, p0: Point, p: Point): void;
    dragMove(p: Point): void;
    endDrag(p: Point, v: Point): void;
    dragCancel(): void;
    stopCoast(): void;
  };
  ui: { closeMenu(): void };
  endEditing(): void;
  turn(id: string | null): void;
  select(ids: string[]): void;
  toggle(id: string): void;
}

interface Press {
  p0: Point;
  h: Hit;
  action: Exclude<DragAction, "pan">;
  collapse?: boolean;
  dragging: boolean;
}

const isCard = (h: Hit): h is Hit & { id: string } => h.kind === "card" || h.kind === "fold";

/** A mouse or trackpad pointer, with the Mac's rules: a press selects, a drag past 3 pt acts, a double-click edits or creates. Times in ms. */
export class Mouse {
  app: MouseApp;
  press: Press | null;
  last: (Point & { t: number }) | null;
  pointer: Point | null;

  constructor(app: MouseApp) {
    this.app = app;
    this.press = null;
    this.last = null;
    this.pointer = null;
  }

  down({ x, y, shiftKey, altKey }: Point & { shiftKey: boolean; altKey: boolean }, t: number) {
    const app = this.app;
    const s = app.state;
    const p = { x, y };
    const double = !!this.last && t - this.last.t <= DOUBLE_MS && Math.hypot(x - this.last.x, y - this.last.y) <= DOUBLE_SLOP;
    this.last = double ? null : { ...p, t };
    this.pointer = p;
    app.flight.note("input", "press", { x: Math.round(x), y: Math.round(y), clicks: double ? 2 : 1 });
    // a release lost to the system leaves its drag open
    if (this.press?.dragging && !planted("lost-release")) app.input.endDrag(p, { x: 0, y: 0 });
    this.press = null;
    app.input.stopCoast();
    app.ui.closeMenu();
    app.endEditing();
    const h = app.input.hit(p, false);
    if (s.turned && h.id !== s.turned) app.turn(null);
    if (double) return app.input.doubleClick(p, h);
    const a = pressAction(h, { shift: shiftKey, alt: altKey }, s.selection);
    // only an empty hit, which has no id, leaves the selection or turns nothing
    if (a.select === "only") app.select([h.id!]);
    if (a.select === "toggle") app.toggle(h.id!);
    if (a.select === "pile") app.select(R.pile(app.model.board, h.id!, app.heightOf));
    if (a.select === "none") app.select([]);
    this.press = a.drag && { p0: p, h, action: a.drag, collapse: a.collapse, dragging: false };
  }

  /** `buttons` as the event has them: a press whose button is up lost its release, as to a right-click or a window switch. */
  move({ x, y, buttons }: Point & { buttons?: number }) {
    const p = { x, y };
    this.pointer = p;
    const d = this.press;
    if (!d) return;
    if (buttons !== undefined && !(buttons & 1)) return this.up(p);
    if (d.dragging) return this.app.input.dragMove(p);
    const slop = d.action === "marquee" ? 0 : SLOP;
    if (Math.hypot(x - d.p0.x, y - d.p0.y) <= slop) return;
    d.dragging = true;
    this.app.input.beginDrag(d.action, d.h, d.p0, p);
  }

  up({ x, y }: Point) {
    const d = this.press;
    this.press = null;
    if (!d) return;
    const p = { x, y };
    // where it was let go, as a busy page may get the moves before it late or not at all: a lane's resize on a busy
    // runner ended as a click, and the lane kept its size
    if (!d.dragging && Math.hypot(x - d.p0.x, y - d.p0.y) > (d.action === "marquee" ? 0 : SLOP)) {
      d.dragging = true;
      this.app.input.beginDrag(d.action, d.h, d.p0, p);
    }
    this.app.flight.note("input", "release");
    if (d.dragging) {
      if (this.pointer?.x !== x || this.pointer?.y !== y) this.app.input.dragMove(p);
      return this.app.input.endDrag(p, { x: 0, y: 0 });
    }
    if (d.collapse) this.app.select([d.h.id!]);
  }

  cancel() {
    const d = this.press;
    this.press = null;
    if (d?.dragging) this.app.input.dragCancel();
  }

  leave() {
    this.pointer = null;
  }

  /** The card under the pointer, for Space; found afresh, as the board may have scrolled under a still pointer. */
  hoveredCard() {
    if (!this.pointer) return null;
    const h = this.app.input.hit(this.pointer, false);
    return isCard(h) ? h.id : null;
  }
}
