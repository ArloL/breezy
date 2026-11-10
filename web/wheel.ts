import { banded, inside, unbanded } from "./camera.ts";
import type { Camera, Limits } from "./camera.ts";
import type { Area } from "./view.ts";
import type { Cam, Point } from "./types.ts";
import type { Value } from "./flight.ts";

export const LINE = 16;
const PAGE = 800;
// A pinch's deltas are a few points each; a mouse wheel's notch can be 100. One notch zooms about 1.25×, as ⌘+ does.
const ZOOM_PER_PT = 0.01;
const MAX_ZOOM_DELTA = 25;

/** What a wheel event does: a pinch (⌃, as browsers send it) or ⌘-scroll zooms about the pointer; any other scroll pans. */
export function wheelAction({ deltaX, deltaY, deltaMode, ctrlKey, metaKey }: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey">) {
  const unit = [1, LINE, PAGE][deltaMode] ?? 1;
  if (ctrlKey || metaKey) {
    const d = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, deltaY * unit));
    return { zoom: Math.exp(-d * ZOOM_PER_PT) };
  }
  return { pan: { x: -deltaX * unit, y: -deltaY * unit } };
}

// A trackpad's momentum, which browsers do not mark, is a run of deltas that never grow: this many, about 50 ms, from
// 10 pt or more. A slow drag moves 1 to 8 pt an event, slowing in runs as long; taken for momentum, it sprang back
// under the finger.
const MOMENTUM_RUN = 6;
const MOMENTUM_FROM = 10;
// A finger stopping leaves deltas of a point or two, ever further apart; one 15 ms after another is the finger at rest.
// Mid-drag a finger's deltas come every 8 ms.
const STOPPED_GAP = 15;
const STOPPED_BELOW = 2;
// a drag's first events start as slowly, 15 ms apart
const STOPPED_AFTER = 100;
// what a stream keeps for the flight recorder: about 12 s of a trackpad's events
const KEEP = 1500;

/** A wheel stream as the flight recorder keeps it: times from its first event, in ms; deltas and cameras in points. */
export interface Stream {
  [k: string]: Value;
  from: number[];
  limits: number[];
  stage: number[];
  /** Each event: [t, dx, dy, camera x, camera y]. */
  events: number[][];
  /** When momentum went to the spring. */
  bounced: number[];
}

const tenth = (n: number) => Math.round(n * 10) / 10;

/**
 * A wheel's pan, which has no end to wait for: past the board's edge it stretches. Momentum that carries the board
 * there bounces back at once, as a coast does, and so does a stretch once the finger stops; what is left is ignored; a push, a delta larger than the
 * momentum's or the other way, takes the stretch up again where the spring has it. `idle()` ends the stream.
 */
export class WheelPan {
  camera: Camera;
  limitsAt: (zoom: number) => Limits;
  stage: () => Area;
  /** Where the deltas ask the camera to be, before the band; null between streams. */
  raw: Cam | null = null;
  limits: Limits | null = null;
  prev: Point = { x: 0, y: 0 };
  run = 0;
  runFrom = 0;
  last = 0;
  /** The least delta since momentum went to the spring; 0 while the deltas move the camera. */
  bounced = 0;
  stream: Stream | null = null;
  t0 = 0;
  /** Given each stream as it ends, for the flight recorder. */
  onStream: (s: Stream) => void = () => {};

  constructor(camera: Camera, limitsAt: (zoom: number) => Limits, stage: () => Area) {
    this.camera = camera;
    this.limitsAt = limitsAt;
    this.stage = stage;
  }

  get active() {
    return this.raw !== null;
  }

  scroll(by: Point, t: number) {
    this.scrolled(by, t);
    const st = this.stream, c = this.camera.cam;
    if (st && st.events.length < KEEP) st.events.push([Math.round(t - this.t0), tenth(by.x), tenth(by.y), tenth(c.x), tenth(c.y)]);
  }

  scrolled(by: Point, t: number) {
    const mag = Math.hypot(by.x, by.y), prev = Math.hypot(this.prev.x, this.prev.y);
    const same = by.x * this.prev.x + by.y * this.prev.y > 0;
    if (same && mag <= prev) this.run++;
    else [this.run, this.runFrom] = [1, mag];
    this.prev = by;
    if (this.bounced) {
      // momentum only dies away, by whole points that wobble by one: a rise of two over its lowest, or a turn, is a
      // finger, however much slower than the momentum was
      this.bounced = Math.min(this.bounced, mag);
      if (same && mag < this.bounced + 2) return;
      this.bounced = 0;
      this.raw = null;
    }
    const s = this.stage(), cam = this.camera.cam;
    if (!this.raw) {
      this.limits = this.limitsAt(cam.zoom);
      this.raw = unbanded(cam, this.limits, s);
      this.last = t;
    }
    if (!this.stream) {
      const l = this.limits!;
      this.t0 = t;
      this.stream = { from: [tenth(cam.x), tenth(cam.y), cam.zoom], limits: [l.x0, l.x1, l.y0, l.y1].map(tenth), stage: [s.right - s.left, s.bottom - s.top], events: [], bounced: [] };
    }
    // no cap past the edge: one stopped a slow drag dead at a third of the window, and momentum, which would wind the
    // band up, goes to the spring instead
    const l = this.limits!;
    this.raw = { ...this.raw, x: this.raw.x + by.x, y: this.raw.y + by.y };
    const gap = t - this.last;
    const to = banded(this.raw, l, s), dt = Math.max(8, gap);
    const v = { x: (to.x - cam.x) / dt, y: (to.y - cam.y) / dt, zoom: 0 };
    this.last = t;
    this.camera.set(to);
    const back = inside(to, l);
    const momentum = this.run >= MOMENTUM_RUN && this.runFrom >= MOMENTUM_FROM && mag < this.runFrom;
    const stopped = gap >= STOPPED_GAP && mag <= STOPPED_BELOW && prev <= STOPPED_BELOW && t - this.t0 >= STOPPED_AFTER;
    if ((back.x !== to.x || back.y !== to.y) && (momentum || stopped)) {
      this.bounced = mag;
      this.stream?.bounced.push(Math.round(t - this.t0));
      this.camera.rebound(back, stopped ? { x: 0, y: 0 } : v);
    }
  }

  /** The stream has rested: a stretch springs back. */
  idle() {
    this.end();
    if (!this.camera.moving) this.camera.coast({ x: 0, y: 0 });
  }

  /** Forgets the stream, as a zoom does. */
  end() {
    if (this.stream) this.onStream(this.stream);
    this.stream = null;
    this.raw = null;
    this.bounced = 0;
    this.run = 0;
    this.prev = { x: 0, y: 0 };
  }
}
