import { decay, coastOffset, rubber } from "./physics.js";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// A critically damped spring with a 0.4 s response, per millisecond.
const STIFFNESS = (2 * Math.PI / 400) ** 2;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
const STEP = 4;
const STOP_V = 0.02; // pt/ms, where UIKit lets a coast end
// How far past a zoom limit the rubber band can reach, in natural-log units: at most about 1.5×.
const ZOOM_STRETCH = 0.4;

/**
 * Moves the camera as UIScrollView does: coasting after a flick, rubber-banding past the zoom limits and
 * springing to where the app sends it. Zoom moves in log space, so zooming in and out feel alike.
 * `apply(cam)` draws a camera.
 */
export class Camera {
  constructor(apply, { now = () => performance.now(), raf = (f) => requestAnimationFrame(f), caf = (id) => cancelAnimationFrame(id) } = {}) {
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

  set(cam) {
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
  coast(v) {
    if (Math.hypot(v.x, v.y) < STOP_V) return this.stop();
    const t0 = this.now();
    this.run({
      x: { coast: { from: this.cam.x, v: v.x, t0 } },
      y: { coast: { from: this.cam.y, v: v.y, t0 } },
    });
  }

  /** Springs to `target`, starting from velocity `v` (pt/ms, and zoom as a fraction per ms). */
  springTo(target, v = { x: 0, y: 0, zoom: 0 }) {
    this.run({
      x: { spring: { value: this.cam.x, v: v.x, to: target.x } },
      y: { spring: { value: this.cam.y, v: v.y, to: target.y } },
      z: { spring: { value: Math.log(this.cam.zoom), v: v.zoom, to: Math.log(target.zoom) } },
    });
  }

  /** The zoom to show when a gesture asks for `zoom`: past a limit, it stretches with UIKit's rubber band. */
  stretchZoom(zoom) {
    const limit = zoom > MAX_ZOOM ? MAX_ZOOM : zoom < MIN_ZOOM ? MIN_ZOOM : 0;
    if (!limit) return zoom;
    return limit * Math.exp(rubber(Math.log(zoom / limit), ZOOM_STRETCH));
  }

  /**
   * Ends a gesture: a zoom past a limit springs back to it around screen point `focus`; otherwise the pan
   * coasts on from `v`.
   */
  settle(focus, v = { x: 0, y: 0 }) {
    const { x, y, zoom } = this.cam;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    if (z === zoom) return this.coast(v);
    const wx = (focus.x - x) / zoom;
    const wy = (focus.y - y) / zoom;
    this.springTo({ x: focus.x - wx * z, y: focus.y - wy * z, zoom: z }, { x: v.x, y: v.y, zoom: 0 });
  }

  run(axes) {
    this.stop();
    this.axes = axes;
    this.last = this.now();
    this.frame = this.raf((t) => this.step(t));
  }

  step(t) {
    this.frame = 0;
    const axes = this.axes;
    if (!axes) return;
    const dt = Math.min(64, Math.max(0, t - this.last));
    this.last = t;
    let busy = false;
    for (const [k, a] of Object.entries(axes)) {
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

  put(k, value) {
    if (k === "z") this.cam.zoom = Math.exp(value);
    else this.cam[k] = value;
  }
}
