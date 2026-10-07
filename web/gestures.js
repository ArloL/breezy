export const HOLD_MS = 300;
export const SLOP = 8;
export const DOUBLE_MS = 300;
export const DOUBLE_SLOP = 32;
const VELOCITY_MS = 80;

const ZERO = Object.freeze({ x: 0, y: 0 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function velocity(track, t) {
  const recent = track.filter((s) => t - s.t <= VELOCITY_MS);
  if (recent.length < 2) return { ...ZERO };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  return dt > 0 ? { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt } : { ...ZERO };
}

/** Turns pointer events into taps, holds, drags and two-finger pinches for `h`; times in ms. */
export class Gestures {
  constructor(h) {
    this.h = h;
    this.points = new Map();
    this.one = null;
    this.two = null;
    this.lastTap = null;
  }

  down(id, x, y, t) {
    const p = { x, y };
    this.points.set(id, p);
    if (this.points.size === 1) {
      const double = !!this.lastTap && t - this.lastTap.t <= DOUBLE_MS && dist(this.lastTap, p) <= DOUBLE_SLOP;
      this.one = { id, start: p, last: p, t, state: "pending", double, track: [{ ...p, t }] };
    } else if (this.points.size === 2) {
      if (this.one?.state === "drag") this.h.dragEnd(this.one.last, { ...ZERO });
      else if (this.one?.state === "held") this.h.holdCancel();
      this.one = null;
      this.lastTap = null;
      const [a, b] = this.points.values();
      const c = mid(a, b);
      this.two = { d: Math.max(dist(a, b), 1), track: [{ ...c, t }] };
      this.h.pinchStart(c);
    }
  }

  /** Reports a hold once the finger has stayed put for `HOLD_MS`; the page calls it from a timer. */
  tick(t) {
    const o = this.one;
    if (o?.state === "pending" && t - o.t >= HOLD_MS) {
      o.state = "held";
      this.lastTap = null;
      this.h.hold(o.start);
    }
  }

  move(id, x, y, t) {
    if (!this.points.has(id)) return;
    const p = { x, y };
    this.points.set(id, p);
    if (this.two) {
      if (this.points.size < 2) return;
      const [a, b] = this.points.values();
      const c = mid(a, b);
      this.two.track.push({ ...c, t });
      this.h.pinch(c, dist(a, b) / this.two.d);
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    o.last = p;
    o.track.push({ ...p, t });
    if (o.state === "drag") return this.h.dragMove(p);
    if (dist(o.start, p) < SLOP) return;
    this.tick(t);
    const held = o.state === "held";
    o.state = "drag";
    this.lastTap = null;
    this.h.dragStart(o.start, p, held);
  }

  up(id, x, y, t) {
    if (!this.points.has(id)) return;
    this.points.delete(id);
    if (this.two) {
      if (this.points.size < 2) {
        this.h.pinchEnd(velocity(this.two.track, t));
        this.two = null;
      }
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    this.tick(t);
    this.one = null;
    const p = { x, y };
    o.track.push({ ...p, t });
    if (o.state === "drag") return this.h.dragEnd(p, velocity(o.track, t));
    if (o.state === "held") return this.h.holdEnd(o.start);
    if (o.double) {
      this.lastTap = null;
      return this.h.doubleTap(o.start);
    }
    this.lastTap = { ...o.start, t };
    this.h.tap(o.start);
  }

  cancel(id) {
    if (!this.points.has(id)) return;
    this.points.delete(id);
    if (this.two) {
      if (this.points.size < 2) {
        this.h.pinchEnd({ ...ZERO });
        this.two = null;
      }
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    this.one = null;
    if (o.state === "drag") this.h.dragEnd(o.last, { ...ZERO });
    else if (o.state === "held") this.h.holdCancel();
  }
}
