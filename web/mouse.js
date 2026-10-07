import * as R from "./rules.js";
import { pressAction } from "./policy.js";

export const SLOP = 3;
export const DOUBLE_MS = 500;
const DOUBLE_SLOP = 4;

const isCard = (h) => h.kind === "card" || h.kind === "fold";

/** A mouse or trackpad pointer, with the Mac's rules: a press selects, a drag past 3 pt acts, a double-click edits or creates. Times in ms. */
export class Mouse {
  constructor(app) {
    this.app = app;
    this.press = null;
    this.last = null;
    this.pointer = null;
  }

  down({ x, y, shiftKey, altKey }, t) {
    const app = this.app;
    const s = app.state;
    const p = { x, y };
    const double = !!this.last && t - this.last.t <= DOUBLE_MS && Math.hypot(x - this.last.x, y - this.last.y) <= DOUBLE_SLOP;
    this.last = double ? null : { ...p, t };
    this.pointer = p;
    this.press = null;
    app.input.stopCoast();
    app.ui.closeMenu();
    app.endEditing();
    const h = app.input.hit(p, false);
    if (s.turned && h.id !== s.turned && h.kind !== "fold") app.turn(null);
    if (double) return app.input.doubleClick(p, h);
    const a = pressAction(h, { shift: shiftKey, alt: altKey }, s.selection);
    if (a.select === "only") app.select([h.id]);
    if (a.select === "toggle") app.toggle(h.id);
    if (a.select === "pile") app.select(R.pile(app.model.board, h.id, app.heightOf));
    if (a.select === "none") app.select([]);
    if (a.turn) app.turn(s.turned === h.id ? null : h.id);
    this.press = a.drag && { p0: p, h, action: a.drag, collapse: a.collapse, dragging: false };
  }

  move({ x, y }) {
    const p = { x, y };
    this.pointer = p;
    const d = this.press;
    if (!d) return;
    if (d.dragging) return this.app.input.dragMove(p);
    const slop = d.action === "marquee" ? 0 : SLOP;
    if (Math.hypot(x - d.p0.x, y - d.p0.y) <= slop) return;
    d.dragging = true;
    this.app.input.beginDrag(d.action, d.h, d.p0, p);
  }

  up({ x, y }) {
    const d = this.press;
    this.press = null;
    if (!d) return;
    if (d.dragging) return this.app.input.dragEnd({ x, y }, { x: 0, y: 0 });
    if (d.collapse) this.app.select([d.h.id]);
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
