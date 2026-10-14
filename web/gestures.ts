import type { Point } from "./types.ts";

export const HOLD_MS = 300;
export const SLOP = 8;
export const DOUBLE_MS = 300;
export const DOUBLE_SLOP = 32;
const VELOCITY_MS = 80;

const ZERO = Object.freeze({ x: 0, y: 0 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

interface Sample extends Point {
  t: number;
}

function velocity(track: Sample[], t: number): Point {
  const recent = track.filter((s) => t - s.t <= VELOCITY_MS);
  if (recent.length < 2) return { ...ZERO };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  return dt > 0 ? { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt } : { ...ZERO };
}

/**
 * Turns pointer events into taps, holds, drags and two-finger pinches for `h`; times in ms. A tap
 * followed by a touch that moves zooms with one finger, as in Maps.
 */
export interface GestureHandler {
  tap(p: Point): void;
  doubleTap(p: Point): void;
  hold(p: Point): void;
  holdEnd(p: Point): void;
  holdCancel(): void;
  dragStart(p0: Point, p: Point, held: boolean): void;
  dragMove(p: Point): void;
  dragEnd(p: Point, v: Point): void;
  dragCancel(): void;
  pinchStart(c: Point): void;
  pinch(c: Point, scale: number): void;
  pinchEnd(v: Point): void;
  pinchCancel(): void;
  zoomDragStart(p: Point): void;
  zoomDrag(dy: number): void;
  zoomDragEnd(): void;
  zoomDragCancel(): void;
}

interface One {
  id: number;
  start: Point;
  last: Point;
  t: number;
  state: "pending" | "held" | "drag" | "zoom";
  double: boolean;
  track: Sample[];
}

export class Gestures {
  h: GestureHandler;
  points: Map<number, Point>;
  one: One | null;
  two: { d: number; track: Sample[] } | null;
  lastTap: Sample | null;

  constructor(h: GestureHandler) {
    this.h = h;
    this.points = new Map<number, Point>();
    this.one = null;
    this.two = null;
    this.lastTap = null;
  }

  down(id: number, x: number, y: number, t: number) {
    const p = { x, y };
    this.points.set(id, p);
    if (this.points.size === 1) {
      const double = !!this.lastTap && t - this.lastTap.t <= DOUBLE_MS && dist(this.lastTap, p) <= DOUBLE_SLOP;
      this.one = { id, start: p, last: p, t, state: "pending", double, track: [{ ...p, t }] };
    } else if (this.points.size === 2) {
      if (this.one?.state === "drag") this.h.dragEnd(this.one.last, { ...ZERO });
      else if (this.one?.state === "held") this.h.holdCancel();
      else if (this.one?.state === "zoom") this.h.zoomDragEnd();
      this.one = null;
      this.lastTap = null;
      const [a, b] = this.points.values();
      const c = mid(a, b);
      this.two = { d: Math.max(dist(a, b), 1), track: [{ ...c, t }] };
      this.h.pinchStart(c);
    }
  }

  /**
   * Reports a hold once the finger has stayed put for `HOLD_MS`; the page calls it from a timer. The
   * second touch of a double tap waits instead to zoom.
   */
  tick(t: number) {
    const o = this.one;
    if (o?.state === "pending" && !o.double && t - o.t >= HOLD_MS) {
      o.state = "held";
      this.lastTap = null;
      this.h.hold(o.start);
    }
  }

  /** A hold reported before a move or lift from before its time, as a busy page hands them over late: it was not one. */
  unhold(o: One, t: number) {
    if (o.state !== "held" || t - o.t >= HOLD_MS) return;
    o.state = "pending";
    this.h.holdCancel();
  }

  move(id: number, x: number, y: number, t: number) {
    if (!this.points.has(id)) return;
    const p = { x, y };
    this.points.set(id, p);
    if (this.two) {
      if (this.points.size < 2) return;
      const [a, b] = this.points.values();
      const c = mid(a, b);
      // a frame's moves come one finger at a time, with the frame's time: its last has every finger where it went
      if (this.two.track.at(-1)?.t === t) this.two.track.pop();
      this.two.track.push({ ...c, t });
      this.h.pinch(c, dist(a, b) / this.two.d);
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    o.last = p;
    o.track.push({ ...p, t });
    if (o.state === "drag") return this.h.dragMove(p);
    if (o.state === "zoom") return this.h.zoomDrag(p.y - o.start.y);
    if (dist(o.start, p) < SLOP) return;
    this.unhold(o, t);
    if (o.double) {
      o.state = "zoom";
      this.lastTap = null;
      this.h.zoomDragStart(o.start);
      return this.h.zoomDrag(p.y - o.start.y);
    }
    this.tick(t);
    const held = o.state === "held";
    o.state = "drag";
    this.lastTap = null;
    this.h.dragStart(o.start, p, held);
  }

  up(id: number, x: number, y: number, t: number) {
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
    this.unhold(o, t);
    this.tick(t);
    this.one = null;
    const p = { x, y };
    o.track.push({ ...p, t });
    if (o.state === "drag") return this.h.dragEnd(p, velocity(o.track, t));
    if (o.state === "held") return this.h.holdEnd(o.start);
    if (o.state === "zoom") return this.h.zoomDragEnd();
    if (o.double) {
      this.lastTap = null;
      // held, it was waiting to zoom
      return t - o.t < HOLD_MS ? this.h.doubleTap(o.start) : undefined;
    }
    this.lastTap = { ...o.start, t };
    this.h.tap(o.start);
  }

  /** The system took the touch, as when swiping home: what it was doing is undone. */
  cancel(id: number) {
    if (!this.points.has(id)) return;
    this.points.delete(id);
    if (this.two) {
      if (this.points.size < 2) {
        this.h.pinchCancel();
        this.two = null;
      }
      return;
    }
    const o = this.one;
    if (o?.id !== id) return;
    this.one = null;
    if (o.state === "drag") this.h.dragCancel();
    else if (o.state === "held") this.h.holdCancel();
    else if (o.state === "zoom") this.h.zoomDragCancel();
  }

  cancelAll() {
    for (const id of [...this.points.keys()]) this.cancel(id);
  }
}
