import { decay, coastOffset, rubber } from "./physics.ts";
import { planted } from "./sync/plant.ts";
import type { Cam, Point, Rect } from "./types.ts";
import type { Area } from "./view.ts";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// A critically damped spring with a 0.4 s response, per millisecond.
const STIFFNESS = (2 * Math.PI / 400) ** 2;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
const STEP = 4;
const STOP_V = 0.02; // pt/ms, where UIKit lets a coast end
// How far past a zoom limit the rubber band can reach, in natural-log units: at most about 1.5×.
const ZOOM_STRETCH = 0.4;

type AxisKey = "x" | "y" | "z";

interface Axis {
  coast?: { from: number; v: number; t0: number };
  spring?: { value: number; v: number; to: number };
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
  }

  get moving() {
    return this.axes !== null;
  }

  /** Where the camera is going: a spring's end on each axis it springs, else where it is. */
  goal(): Cam {
    const a = this.axes;
    if (!a || planted("reveal-current")) return { ...this.cam };
    const to = (k: AxisKey, now: number) => a[k]?.spring?.to ?? now;
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
    if (Math.hypot(v.x, v.y) < STOP_V) return this.stop();
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
    this.springTo({ x: focus.x - wx * z, y: focus.y - wy * z, zoom: z }, { x: v.x, y: v.y, zoom: 0 });
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
        if (Math.abs(decay(c.v, elapsed)) >= STOP_V) busy = true;
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
    else this.axes = null;
  }

  put(k: AxisKey, value: number) {
    if (k === "z") this.cam.zoom = Math.exp(value);
    else this.cam[k] = value;
  }
}

/** The camera that pans the least from `cam` to show world rect `r` in screen area `a`, or null when it shows; a rect too
 * tall to fit shows its `prefer` edge. */
export function revealing(cam: Cam, r: Rect, a: Area, prefer: "top" | "bottom" = "top"): Cam | null {
  const pad = 16;
  const { zoom } = cam;
  let { x, y } = cam;
  const s = { x: r.x * zoom + cam.x, y: r.y * zoom + cam.y };
  const w = r.w * zoom;
  const h = r.h * zoom;
  if (w + 2 * pad > a.right - a.left || s.x < a.left + pad) x += a.left + pad - s.x;
  else if (s.x + w > a.right - pad) x += a.right - pad - (s.x + w);
  if (h + 2 * pad > a.bottom - a.top) y += prefer === "bottom" ? a.bottom - pad - (s.y + h) : a.top + pad - s.y;
  else if (s.y < a.top + pad) y += a.top + pad - s.y;
  else if (s.y + h > a.bottom - pad) y += a.bottom - pad - (s.y + h);
  return x === cam.x && y === cam.y ? null : { x, y, zoom };
}
