import { decay, coastOffset, rubber, unrubber } from "./physics.ts";
import { planted } from "./sync/plant.ts";
import type { Cam, Point, Rect } from "./types.ts";
import type { Area } from "./view.ts";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// A critically damped spring with a 0.4 s response, per millisecond.
const STIFFNESS = (2 * Math.PI / 400) ** 2;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
/** The same spring for Motion, in seconds, for what moves with the camera: a card turning as the board pans to show it. */
export const CAMERA_SPRING = { type: "spring", stiffness: STIFFNESS * 1e6, damping: DAMPING * 1e3, mass: 1 };
const STEP = 4;
const STOP_V = 0.02; // pt/ms, where UIKit lets a coast end
// A stretch rebounds as Chromium's Mac rubber band does, after AppKit's: (x0 + 0.31·v·t)·e^(−12.5·t), t in seconds
// (content/renderer/input/input_scroll_elasticity_controller.cc, BSD). It sets off at once, where a spring eases in.
const REBOUND_AMPLITUDE = 0.31;
const REBOUND_RATE = 20 / 1.6;
// AppKit's scroll view springs back critically damped, easing out of the stretch: (x0 + (v + ω·x0)·t)·e^(−ω·t) at 19/s
// fits the owner's held pushes lifted with no momentum within 1.9 pt, Chromium's curve above within 3.8
export const APPKIT_REBOUND = 19;
// How far past a zoom limit the rubber band can reach, in natural-log units: at most about 1.5×.
const ZOOM_STRETCH = 0.4;

/** How far the board reaches past its outermost card or lane, in board points whatever the zoom, as Freeform's does. */
export const MARGIN = 1194;
// Freeform's pan stretches a little softer than UIKit's 0.55: past an edge, 0.5 fits its stretch on either axis.
const PAN_BAND = 0.5;
// AppKit's scroll view stretches by the same formula, far stiffer: 0.07 fits 4,238 frames of the owner's trackpad
// pushes within 3 pt (web/test/appkit-edge.json), 1,200 pt pushed stretching 78 on a 1,158 pt board.
export const TRACKPAD_BAND = 0.07;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The camera positions a pan may reach, on each axis. */
export interface Limits {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** What `rects` span; an empty board spans its origin. */
export function extent(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The board: `content` and the margin, and what last showed at rest, `seen`, so that its edge shows only when pulled. */
export function boardOf(content: Rect, seen: Rect | null): Rect {
  const b = { x: content.x - MARGIN, y: content.y - MARGIN, w: content.w + 2 * MARGIN, h: content.h + 2 * MARGIN };
  return seen ? union(b, seen) : b;
}

/** The world `s` shows through camera `c`. */
export const seenFrom = (c: Cam, s: Area): Rect =>
  ({ x: (s.left - c.x) / c.zoom, y: (s.top - c.y) / c.zoom, w: (s.right - s.left) / c.zoom, h: (s.bottom - s.top) / c.zoom });

export const takeIn = (a: Rect | null, b: Rect): Rect => (a ? union(a, b) : b);

/** Keeps `board` over all of screen `s`; when it is smaller, within it. */
export function panLimits(board: Rect, zoom: number, s: Area): Limits {
  const axis = (at: number, size: number, lo: number, hi: number) => {
    const gap = Math.max(0, hi - lo - size * zoom);
    return [hi - gap - (at + size) * zoom, lo + gap - at * zoom];
  };
  const [x0, x1] = axis(board.x, board.w, s.left, s.right);
  const [y0, y1] = axis(board.y, board.h, s.top, s.bottom);
  return { x0, x1, y0, y1 };
}

export const inside = (c: Cam, l: Limits): Cam => ({ ...c, x: clamp(c.x, l.x0, l.x1), y: clamp(c.y, l.y0, l.y1) });

/** `l` stretched to take in `c`, so that a gesture begun outside the limits does not jump. */
export const widened = (l: Limits, c: Cam): Limits => ({ x0: Math.min(l.x0, c.x), x1: Math.max(l.x1, c.x), y0: Math.min(l.y0, c.y), y1: Math.max(l.y1, c.y) });

/** Camera `c`, rubber-banded where it is past `l`, over the size of screen `s`, as stiff as `k`. */
export function banded(c: Cam, l: Limits, s: Area, k = PAN_BAND): Cam {
  const band = (v: number, lo: number, hi: number, d: number) => clamp(v, lo, hi) + rubber(v - clamp(v, lo, hi), d, k);
  return { ...c, x: band(c.x, l.x0, l.x1, s.right - s.left), y: band(c.y, l.y0, l.y1, s.bottom - s.top) };
}

/** The camera that `banded` would draw as `c`: a stretch picked up again does not jump. */
export function unbanded(c: Cam, l: Limits, s: Area, k = PAN_BAND): Cam {
  const band = (v: number, lo: number, hi: number, d: number) => clamp(v, lo, hi) + unrubber(v - clamp(v, lo, hi), d, k);
  return { ...c, x: band(c.x, l.x0, l.x1, s.right - s.left), y: band(c.y, l.y0, l.y1, s.bottom - s.top) };
}

type AxisKey = "x" | "y" | "z";

interface Axis {
  coast?: { from: number; v: number; t0: number };
  spring?: { value: number; v: number; to: number };
  /** `w`: AppKit's critically damped spring at that rate, 1/s; Chromium's curve without. */
  rebound?: { from: number; v: number; to: number; t0: number; w?: number };
}

type Axes = Partial<Record<AxisKey, Axis>>;

export interface Clock {
  now?: () => number;
  raf?: (f: (t: number) => void) => number;
  caf?: (id: number) => void;
}

/**
 * Moves the camera as UIScrollView does: coasting after a flick, rubber-banding past the zoom limits and
 * springing to where the app sends it. Zoom moves in log space, so zooming in and out feel alike.
 * `apply(cam)` draws a camera.
 */
export class Camera {
  apply: (cam: Cam) => void;
  now: () => number;
  raf: (f: (t: number) => void) => number;
  caf: (id: number) => void;
  cam: Cam;
  axes: Axes | null;
  frame: number;
  last: number;
  /** Where a coast must stop at a given zoom; none, by default, leaves the camera free. */
  limits: ((zoom: number) => Limits) | null;
  /** Called when a coast or spring ends. */
  onRest: () => void;

  constructor(
    apply: (cam: Cam) => void,
    { now = () => performance.now(), raf = (f) => requestAnimationFrame(f), caf = (id) => cancelAnimationFrame(id) }: Clock = {},
  ) {
    this.apply = apply;
    this.now = now;
    this.raf = raf;
    this.caf = caf;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.axes = null;
    this.frame = 0;
    this.last = 0;
    this.limits = null;
    this.onRest = () => {};
  }

  get moving() {
    return this.axes !== null;
  }

  /** Where the camera is going: a spring's end on each axis it springs, else where it is. */
  goal(): Cam {
    const a = this.axes;
    if (!a || planted("reveal-current")) return { ...this.cam };
    const to = (k: AxisKey, now: number) => a[k]?.spring?.to ?? a[k]?.rebound?.to ?? now;
    return { x: to("x", this.cam.x), y: to("y", this.cam.y), zoom: a.z?.spring ? Math.exp(a.z.spring.to) : this.cam.zoom };
  }

  set(cam: Cam) {
    this.stop();
    this.cam = { x: cam.x, y: cam.y, zoom: cam.zoom };
    this.apply(this.cam);
  }

  stop() {
    if (this.frame) this.caf(this.frame);
    this.frame = 0;
    this.axes = null;
  }

  /** Coasts the pan from velocity `v` in pt/ms. */
  coast(v: Point) {
    const l = this.limits?.(this.cam.zoom);
    const to = l ? inside(this.cam, l) : this.cam;
    if (Math.hypot(v.x, v.y) < STOP_V && to.x === this.cam.x && to.y === this.cam.y) {
      this.stop();
      return this.onRest();
    }
    const t0 = this.now();
    this.run({
      x: { coast: { from: this.cam.x, v: v.x, t0 } },
      y: { coast: { from: this.cam.y, v: v.y, t0 } },
    });
  }

  /** Springs to `target`, starting from velocity `v` (pt/ms, and zoom as a fraction per ms). */
  springTo(target: Cam, v: Cam = { x: 0, y: 0, zoom: 0 }) {
    this.run({
      x: { spring: { value: this.cam.x, v: v.x, to: target.x } },
      y: { spring: { value: this.cam.y, v: v.y, to: target.y } },
      z: { spring: { value: Math.log(this.cam.zoom), v: v.zoom, to: Math.log(target.zoom) } },
    });
  }

  /** Back from past the board's edge to `target`, from velocity `v` in pt/ms; with `w`, as AppKit's spring at that rate. */
  rebound(target: Cam, v: Point = { x: 0, y: 0 }, w?: number) {
    const t0 = this.now();
    this.run({
      x: { rebound: { from: this.cam.x, v: v.x, to: target.x, t0, w } },
      y: { rebound: { from: this.cam.y, v: v.y, to: target.y, t0, w } },
    });
  }

  /** The zoom to show when a gesture asks for `zoom`: past a limit, it stretches with UIKit's rubber band. */
  stretchZoom(zoom: number) {
    const limit = zoom > MAX_ZOOM ? MAX_ZOOM : zoom < MIN_ZOOM ? MIN_ZOOM : 0;
    if (!limit) return zoom;
    return limit * Math.exp(rubber(Math.log(zoom / limit), ZOOM_STRETCH));
  }

  /**
   * Ends a gesture: a zoom past a limit springs back to it around screen point `focus`; otherwise the pan
   * coasts on from `v`.
   */
  settle(focus: Point, v: Point = { x: 0, y: 0 }) {
    const { x, y, zoom } = this.cam;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (z === zoom) return this.coast(v);
    const wx = (focus.x - x) / zoom;
    const wy = (focus.y - y) / zoom;
    const target = { x: focus.x - wx * z, y: focus.y - wy * z, zoom: z }, l = this.limits?.(z);
    this.springTo(l ? inside(target, l) : target, { x: v.x, y: v.y, zoom: 0 });
  }

  run(axes: Axes) {
    this.stop();
    this.axes = axes;
    this.last = this.now();
    this.frame = this.raf((t) => this.step(t));
  }

  step(t: number) {
    this.frame = 0;
    const axes = this.axes;
    if (!axes) return;
    const dt = Math.min(64, Math.max(0, t - this.last));
    this.last = t;
    let busy = false;
    for (const [k, a] of Object.entries(axes) as [AxisKey, Axis][]) {
      if (a.coast) {
        const c = a.coast;
        const elapsed = t - c.t0;
        this.put(k, c.from + coastOffset(c.v, elapsed));
        const l = this.limits?.(this.cam.zoom);
        const to = l ? inside(this.cam, l)[k as "x" | "y"] : this.cam[k as "x" | "y"];
        if (to !== this.cam[k as "x" | "y"]) {
          // past the edge: what is left of the coast carries into the rebound, which is the bounce
          a.coast = undefined;
          a.rebound = { from: this.cam[k as "x" | "y"], v: decay(c.v, elapsed), to, t0: t };
          busy = true;
        } else if (Math.abs(decay(c.v, elapsed)) >= STOP_V) busy = true;
      } else if (a.rebound) {
        const r = a.rebound, sec = Math.max(0, t - r.t0) / 1000;
        const x0 = r.from - r.to, v = r.v * 1000;
        const at = (s: number) => (r.w ? (x0 + (v + r.w * x0) * s) * Math.exp(-r.w * s) : (x0 + REBOUND_AMPLITUDE * v * s) * Math.exp(-REBOUND_RATE * s));
        const off = at(sec);
        // done within a point of the edge, unless its speed is still carrying it out, as from right at the edge
        if (Math.abs(off) < 1 && Math.abs(at(sec + 0.008)) <= Math.abs(off)) this.put(k, r.to);
        else {
          this.put(k, r.to + off);
          busy = true;
        }
      } else if (a.spring) {
        const s = a.spring;
        for (let left = dt; left > 0; left -= STEP) {
          const h = Math.min(STEP, left);
          s.v += (-STIFFNESS * (s.value - s.to) - DAMPING * s.v) * h;
          s.value += s.v * h;
        }
        const settled = k === "z" ? Math.abs(s.value - s.to) < 1e-5 && Math.abs(s.v) < 1e-7 : Math.abs(s.value - s.to) < 0.01 && Math.abs(s.v) < 1e-4;
        if (settled) s.value = s.to;
        else busy = true;
        this.put(k, s.value);
      }
    }
    this.apply(this.cam);
    if (busy) this.frame = this.raf((t2) => this.step(t2));
    else {
      this.axes = null;
      this.onRest();
    }
  }

  put(k: AxisKey, value: number) {
    if (k === "z") this.cam.zoom = Math.exp(value);
    else this.cam[k] = value;
  }
}

/** The camera that pans the least from `cam` to show world rect `r` in screen area `a`, `pad` in from its edges, less
 * where `a` is too small for that, 16 at least; or null when it shows. A rect too big to fit shows its left edge and its
 * `prefer` one. As BreezyKit's Rect.revealShift, held to BreezyKit/Tests/Fixtures/reveal.json. */
export function revealing(cam: Cam, r: Rect, a: Area, prefer: "top" | "bottom" = "top", pad = 16): Cam | null {
  const { zoom } = cam;
  let { x, y } = cam;
  const s = { x: r.x * zoom + cam.x, y: r.y * zoom + cam.y };
  const w = r.w * zoom;
  const h = r.h * zoom;
  const px = Math.min(pad, Math.max(16, (a.right - a.left - w) / 2)), py = Math.min(pad, Math.max(16, (a.bottom - a.top - h) / 2));
  if (w + 2 * px > a.right - a.left || s.x < a.left + px) x += a.left + px - s.x;
  else if (s.x + w > a.right - px) x += a.right - px - (s.x + w);
  if (h + 2 * py > a.bottom - a.top) y += prefer === "bottom" ? a.bottom - py - (s.y + h) : a.top + py - s.y;
  else if (s.y < a.top + py) y += a.top + py - s.y;
  else if (s.y + h > a.bottom - py) y += a.bottom - py - (s.y + h);
  return x === cam.x && y === cam.y ? null : { x, y, zoom };
}
