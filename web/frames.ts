// Keeps a frame in the recording on every animation frame while what shows or the input changes, and one once still, as
// the Mac's FrameRecorder does from its display link: the web moves its camera once per event, and a native pinch
// only by a CSS transform until it ends, so no loop of the app's own runs every frame
// (docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md).
import { Flight, recordingOff } from "./flight.ts";
import type { Cam, Rect } from "./types.ts";

/** What the page shows, as drawn: the camera with a native pinch's transform composed in, the view's size, the board's
 * reach in board points, whether the board paints over the top bar, and how far the dot grid falls short of the view. */
export interface FrameSource {
  cam(): Cam;
  stage(): { w: number; h: number };
  board(): Rect;
  coverTop(): boolean;
  gridShort(): number;
}

export interface FrameClock {
  raf?: (f: (t: number) => void) => number;
  caf?: (id: number) => void;
  /** Whether the page is hidden, where animation frames stop coming. */
  hidden?: () => boolean;
}

/** NSEvent's phases, which the rules read: began, changed, ended, cancelled. */
const ENDED = 8, CANCELLED = 16;
/** Still frames kept going before the loop stops: half a second at 60 Hz. */
const STILL = 30;

export class FrameRecorder {
  private readonly flight: Flight;
  private readonly source: FrameSource;
  private readonly raf: (f: (t: number) => void) => number;
  private readonly caf: (id: number) => void;
  private readonly hidden: () => boolean;
  private loop: number | null = null;
  private still = 0;
  private lastShown: string | null = null;
  private lastInput: string | null = null;
  private wheelAt = { dx: 0, dy: 0, phase: 0, momentum: 0 };
  private magnified = 0;
  /** began 1, changed 2, ended 3, as the Mac's; a begin is held until a row keeps it, and an end with it after it. */
  private gesture = 0;
  private endPending = false;
  private readonly touches = new Map<number, [number, number]>();
  private pointerAt: [number, number] | null = null;

  constructor(flight: Flight, source: FrameSource,
    { raf = (f) => requestAnimationFrame(f), caf = (id) => cancelAnimationFrame(id), hidden = () => typeof document !== "undefined" && document.hidden }: FrameClock = {}) {
    this.flight = flight;
    this.source = source;
    this.raf = raf;
    this.caf = caf;
    this.hidden = hidden;
  }

  /** Keeps frames again: as the camera moves or input comes. */
  wake() {
    this.still = 0;
    if (this.loop !== null || recordingOff() || this.hidden()) return;
    this.loop = this.raf(() => this.tick());
  }

  /** A pointer at `x`, `y` in view pt, or lifted with nulls; a touch is a finger, a mouse only the pointer. */
  pointer(id: number, x: number | null, y: number | null, touch: boolean) {
    if (touch) {
      if (x === null || y === null) this.touches.delete(id);
      else this.touches.set(id, [x, y]);
    }
    if (x !== null && y !== null) this.pointerAt = [x, y];
    this.wake();
  }

  /** A wheel event's deltas as the browser gives them, and its phases as WheelPan guesses them, in NSEvent's codes. */
  wheel(deltaX: number, deltaY: number, phase: number, momentum: number) {
    // AppKit's scrollingDelta is the browser's delta the other way round
    this.wheelAt = { dx: this.wheelAt.dx - deltaX, dy: this.wheelAt.dy - deltaY, phase, momentum };
    this.wake();
  }

  /** A pinch's scale changed by `by` (scale / last − 1), as AppKit's magnification. */
  magnify(by: number, phase: "began" | "changed" | "ended") {
    this.magnified += by;
    if (phase === "began") this.gesture = 1;
    else if (phase === "ended") {
      if (this.gesture === 1) this.endPending = true;
      else this.gesture = 3;
    } else if (this.gesture !== 1) this.gesture = 2;
    this.wake();
  }

  private stop() {
    if (this.loop !== null) this.caf(this.loop);
    this.loop = null;
  }

  private tick() {
    this.loop = null;
    if (this.hidden()) return;
    const c = this.source.cam(), s = this.source.stage(), b = this.source.board();
    const fingers = [...this.touches.entries()].sort(([a], [b]) => a - b).slice(0, 2).map(([, p]) => p);
    const [f1, f2] = [fingers[0] ?? null, fingers[1] ?? null];
    const at = f1 && f2 ? [(f1[0] + f2[0]) / 2, (f1[1] + f2[1]) / 2] : f1 ?? this.pointerAt;
    const shown = [c.zoom, -c.x / c.zoom, -c.y / c.zoom, s.w, s.h, b.x, b.y, b.w, b.h, at?.[0] ?? null, at?.[1] ?? null,
      f1?.[0] ?? null, f1?.[1] ?? null, f2?.[0] ?? null, f2?.[1] ?? null];
    const w = this.wheelAt;
    const input = [w.dx, w.dy, w.phase, w.momentum, this.magnified, this.gesture];
    const platform = [this.source.coverTop() ? 1 : 0, this.source.gridShort()];
    const shownKey = JSON.stringify([shown, platform]), inputKey = JSON.stringify(input);
    // a phase held is not input: a wheel that may begin and never does would keep the loop writing for good
    const moving = shownKey !== this.lastShown || w.dx !== 0 || w.dy !== 0 || this.magnified !== 0 || inputKey !== this.lastInput;
    if (moving || this.still === 0) {
      this.flight.frame([...shown, ...input, ...platform]);
      if (!moving) this.still = 1;
    } else if (++this.still > STILL) return this.stop();
    if (moving) this.still = 0;
    this.lastShown = shownKey;
    this.lastInput = inputKey;
    this.wheelAt = { dx: 0, dy: 0, phase: w.phase === ENDED || w.phase === CANCELLED ? 0 : w.phase, momentum: w.momentum === ENDED ? 0 : w.momentum };
    this.magnified = 0;
    if (this.gesture === 3) this.gesture = 0;
    else if (this.gesture === 1) this.gesture = this.endPending ? 3 : 2;
    this.endPending = false;
    this.loop = this.raf(() => this.tick());
  }
}
