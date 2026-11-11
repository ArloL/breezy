import { camOf, isEcho, layoutOf, px, scrollOf } from "./geometry.ts";
import type { Flight } from "../flight.ts";
import type { Surface } from "../surface.ts";
import type { Area, View } from "../view.ts";
import type { Cam, Point, Rect } from "../types.ts";

const r = Math.round;
const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** What the content was laid out for: the scroll position counts from its board. */
interface Shown {
  board: Rect;
  zoom: number;
  w: number;
  h: number;
}

/**
 * The board as a real scroll container: the browser pans, coasts and rubber-bands it, and the camera is read from the
 * scroll position. The content is the board at the zoom, the grid a pattern in it; the app's own moves, a zoom, find's
 * glide, write the scroll position.
 */
export class NativeSurface implements Surface {
  board: HTMLElement;
  view: View;
  flight: Flight;
  content: HTMLElement;
  world: HTMLElement;
  shown: Shown | null = null;
  /** Where the app last put the scroll position: a scroll event there is its own echo, not a pan. */
  written: Point = { x: NaN, y: NaN };
  /** A pinch has the camera: the scroll position is not a pan. */
  pinching = false;
  /** Set while the camera follows the scroll position, which it must not write back. */
  private following = false;
  private userScrolled = false;
  private scrolling = false;
  private readonly resize: ResizeObserver;
  private readonly off = new AbortController();

  constructor(board: HTMLElement, view: View, flight: Flight) {
    this.board = board;
    this.view = view;
    this.flight = flight;
    this.world = board.querySelector<HTMLElement>(".world")!;
    this.content = document.createElement("div");
    this.content.className = "native-content";
    board.insertBefore(this.content, this.world);
    this.content.append(this.world);
    board.classList.add("native");
    const signal = this.off.signal;
    board.addEventListener("scroll", () => this.scrolled(), { passive: true, signal });
    board.addEventListener("scrollend", () => this.scrollEnded(), { signal });
    this.resize = new ResizeObserver(() => this.resized());
    this.resize.observe(board);
  }

  apply(cam: Cam) {
    if (!this.following) this.lay(cam);
  }

  stage(): Area {
    return { top: 0, left: 0, right: this.board.clientWidth, bottom: this.board.clientHeight };
  }

  /** The grid is a pattern in the content, and scrolls with it. */
  drawGrid() {}

  rested() {
    this.lay(this.view.cam);
  }

  dispose() {
    this.off.abort();
    this.resize.disconnect();
    this.board.classList.remove("native");
    this.content.replaceWith(this.world);
    this.world.style.transform = "";
  }

  /** The board takes in what shows once a pan of the user's has ended, and the content is laid out for it. */
  settle() {
    this.view.rest();
  }

  private at(): Point {
    return { x: this.board.scrollLeft, y: this.board.scrollTop };
  }

  private scrolled() {
    const at = this.at();
    if (!this.scrolling) {
      this.scrolling = true;
      this.flight.note("input", "native scroll start", { at: [r(at.x), r(at.y)] });
    }
    if (this.pinching || !this.shown) return;
    // the browser held the scroll position inside content that a larger window outgrew, before the observer heard of
    // it: as when the pointer over the page made it lay out early
    if (this.board.clientWidth !== this.shown.w || this.board.clientHeight !== this.shown.h) return this.resized();
    // the app's own move, as a spring's: setting the camera from it would stop the spring
    if (isEcho(at, this.written)) return;
    this.userScrolled = true;
    this.written = { x: NaN, y: NaN };
    this.following = true;
    try {
      this.view.camera.set(camOf(at, this.shown.board, this.shown.zoom));
    } finally {
      this.following = false;
    }
  }

  // not after the app's own moves, which end on every frame of a spring
  private scrollEnded() {
    const at = this.at();
    this.scrolling = false;
    this.flight.note("input", "native scroll end", { at: [r(at.x), r(at.y)] });
    if (!this.userScrolled || this.pinching) return;
    this.userScrolled = false;
    this.settle();
  }

  /** A larger window, or one turned, shows more: the board takes it in, so that the content stays larger than the
   * window and the scroll position the camera stands for is there to write. */
  private resized() {
    this.view.takeIn();
    this.lay(this.view.cam);
  }

  private lay(cam: Cam) {
    this.write(scrollOf(cam, this.layout(cam.zoom).board));
  }

  private layout(zoom: number): Shown {
    const board = this.view.board(), w = this.board.clientWidth, h = this.board.clientHeight, s = this.shown;
    if (s && s.zoom === zoom && s.w === w && s.h === h && same(s.board, board)) return s;
    const l = layoutOf(board, zoom, { w, h });
    Object.assign(this.content.style, {
      width: px(l.width),
      height: px(l.height),
      backgroundSize: `${px(l.gridSize)} ${px(l.gridSize)}`,
      backgroundPosition: `${px(l.gridOffset[0])} ${px(l.gridOffset[1])}`,
    });
    this.world.style.transform = l.world;
    return (this.shown = { board, zoom, w, h });
  }

  private write(to: Point) {
    this.board.scrollTo({ left: to.x, top: to.y, behavior: "instant" });
    const got = (this.written = this.at());
    // a position the browser did not take, as past the content's end
    if (Math.abs(got.x - to.x) > 2 || Math.abs(got.y - to.y) > 2) this.flight.note("input", "native scroll refused", { asked: [r(to.x), r(to.y)], got: [r(got.x), r(got.y)] });
  }
}
