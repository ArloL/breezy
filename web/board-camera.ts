// The board's camera, as View shows it but without a page: the camera and its springs, a wheel's pan with its stretch
// past the edge, and the board's reach, its cards and lanes, the margin and what the camera showed when it last rested.
// View draws it; Node replays the owner's strokes through it (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md).
import { Camera, boardOf, clampZoom, extent, panLimits, seenFrom, takeIn } from "./camera.ts";
import { WheelPan } from "./wheel.ts";
import type { Limits } from "./camera.ts";
import type { Area } from "./view.ts";
import type { Board, Cam, Card, Point, Rect } from "./types.ts";

/** How long a wheel's stream waits for its next event before it rests, as no browser marks a stream's end. */
export const WHEEL_REST = 120;

export interface BoardCameraPorts {
  /** The board as drawn. */
  board(): Board;
  /** A card as drawn, which only the view can measure. */
  rectOf(c: Card): Rect;
  /** The view's area on screen, which the board's edge stops at. */
  stage(): Area;
  /** Shows the camera. */
  apply(cam: Cam): void;
  /** The board has taken in what shows. */
  rested(): void;
  /** Whether springs are off, as the reader asked for less motion. */
  reducedMotion?: () => boolean;
  clock?: {
    now?: () => number;
    raf?: (f: (t: number) => void) => number;
    caf?: (id: number) => void;
    setTimer?: (f: () => void, ms: number) => unknown;
    clearTimer?: (id: unknown) => void;
  };
}

export class BoardCamera {
  readonly camera: Camera;
  readonly wheel: WheelPan;
  /** What the camera showed when it last rested, and while zooming since. */
  seen: Rect | null = null;
  private readonly ports: BoardCameraPorts;
  private readonly now: () => number;
  private readonly setTimer: (f: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private wheelRest: unknown;

  constructor(ports: BoardCameraPorts) {
    this.ports = ports;
    const k = ports.clock ?? {};
    this.now = k.now ?? (() => performance.now());
    this.setTimer = k.setTimer ?? ((f, ms) => setTimeout(f, ms));
    this.clearTimer = k.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.camera = new Camera((c) => ports.apply(c), { now: this.now, raf: k.raf, caf: k.caf });
    this.camera.limits = (z) => this.limits(z);
    this.wheel = new WheelPan(this.camera, (z) => this.limits(z), () => ports.stage());
    this.camera.onRest = () => {
      if (!this.wheel.active) this.rest();
    };
  }

  get cam(): Cam {
    return this.camera.cam;
  }

  toWorld(p: Point): Point {
    const { x, y, zoom } = this.cam;
    return { x: (p.x - x) / zoom, y: (p.y - y) / zoom };
  }

  toScreen(p: Point): Point {
    const { x, y, zoom } = this.cam;
    return { x: p.x * zoom + x, y: p.y * zoom + y };
  }

  /** Moves the camera at once, or with a spring that a touch can catch. Gestures pass zooms past the limits on purpose. */
  setCamera(cam: Cam, animate = false) {
    if (animate && !this.ports.reducedMotion?.()) this.camera.springTo({ ...cam, zoom: clampZoom(cam.zoom) });
    else this.camera.set(animate ? { ...cam, zoom: clampZoom(cam.zoom) } : cam);
    // what the app moves to is where the camera rests; a gesture's moves are not
    if (animate && !this.camera.moving) this.rest();
  }

  /** As far as the cards and lanes, the margin, and what showed when the camera last rested. */
  board(): Rect {
    const b = this.ports.board();
    return boardOf(extent([...b.cards.map((c) => this.ports.rectOf(c)), ...b.lanes]), this.seen);
  }

  /** The board takes in what shows now, and only that, as Freeform's canvas does when a scroll ends. */
  rest() {
    this.seen = seenFrom(this.cam, this.ports.stage());
    this.ports.rested();
  }

  /** Where a pan begun now may reach. A bounce it catches is not taken in: the pan picks the stretch up. */
  hold(): Limits {
    return this.limits(this.cam.zoom);
  }

  /** A zoom grows the board to what it shows, so zooming out never shows its edge. */
  takeIn(cam: Cam = this.cam) {
    this.seen = takeIn(this.seen, seenFrom(cam, this.ports.stage()));
  }

  /** Where a pan may reach at `zoom`: the board over the whole screen. */
  limits(zoom: number): Limits {
    return panLimits(this.board(), zoom, this.ports.stage());
  }

  /** Zooms keeping the world point under screen point `c` in place. */
  zoomAround(c: Point, zoom: number, animate = false) {
    const z = clampZoom(zoom);
    const w = this.toWorld(c);
    this.wheel.end();
    const to = { x: c.x - w.x * z, y: c.y - w.y * z, zoom: z };
    this.takeIn(to);
    this.setCamera(to, animate);
  }

  /** A wheel's pan: past the board's edge it stretches, and rebounds when momentum reaches it or the finger stops. */
  wheelPan(by: Point) {
    this.wheel.scroll(by, this.now());
    this.clearTimer(this.wheelRest);
    this.wheelRest = this.setTimer(() => this.wheel.idle(), WHEEL_REST);
  }
}
