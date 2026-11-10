// SPIKE, throwaway (docs/superpowers/specs/2026-11-10-breezy-native-panning-design.md): the board in a real scroll
// container, the browser panning, Breezy's zoom on top. `?pan=native`.
import type { View } from "./view.ts";
import type { Input } from "./input.ts";
import type { Cam } from "./types.ts";

export const nativeWanted = () => new URLSearchParams(location.search).get("pan") === "native";

export function nativePan(view: View, board: HTMLElement, input: Input) {
  const note = (what: string, data: Record<string, number | number[] | string>) => (input as unknown as { app: { flight: { note: (k: "input", w: string, d: object) => void } } }).app.flight.note("input", what, data);
  const r = (n: number) => Math.round(n);
  let pinch: number | null = null, anchor = { x: 0, y: 0 };
  // a drag on the empty board is the browser's pan now; Breezy's own moves nothing and coasts nothing
  const move = input.dragMove.bind(input), end = input.dragEnd.bind(input);
  input.dragMove = (p) => (input.drag?.action === "pan" ? void (input.drag.last = p) : move(p));
  input.dragEnd = (...a) => (input.drag?.action === "pan" ? void (input.drag = null) : end(...a));
  // what Breezy does with a touch, a lifted card, a selected card dragged, the one-finger zoom, the browser must not pan
  // as well
  board.addEventListener("touchmove", (e) => {
    if (input.drag && input.drag.action !== "pan") e.preventDefault();
  }, { passive: false });
  // A pinch: the browser pans the first finger before the second lands, and cancels its pointer, so the zoom follows the
  // touches themselves, around their midpoint, while the browser pans, as UIScrollView pans and zooms at once.
  input.pinchStart = () => {};
  input.pinch = () => {};
  input.pinchEnd = () => {};
  const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  // A pinch scales the content as drawn, on the compositor, around the board point first under the fingers, and lays
  // it out once at the end: laid out each step, iOS showed the grey past the edge until it had painted the new size.
  let z0 = 1, pinchZoom = 1, last = { x: 0, y: 0 }, still: ReturnType<typeof setTimeout> | undefined;
  board.addEventListener("touchmove", (e) => {
    if (e.touches.length < 2) {
      if (pinch !== null) endPinch();
      return;
    }
    if (e.cancelable) e.preventDefault();
    const d = spread(e.touches), mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    if (pinch === null) {
      anchor = view.toWorld(mid);
      z0 = pinchZoom = view.cam.zoom;
      pinch = d;
      // iOS paints the content only near the window: scaled, the rest showed grey; the grid's canvas, drawn for the
      // window each move, and the paper colour stand in until the pinch ends, the board's edge never showing in one.
      // The browser's own scrolling stops for the pinch: going on under it, at a position script reads late, it threw
      // the scaled board about; the pinch pans by its midpoint.
      board.classList.add("pinching");
      note("native pinch start", { scroll: [r(board.scrollLeft), r(board.scrollTop)], zoom: z0, cancelable: String(e.cancelable) });
      return;
    }
    pinchZoom = Math.min(2, Math.max(0.25, pinchZoom * (d / pinch)));
    pinch = d;
    last = mid;
    // where the anchor is in the content, as drawn at z0; scaled by z / z0 and moved to sit under the fingers
    const s = pinchZoom / z0, qx = (anchor.x - shown.x) * z0, qy = (anchor.y - shown.y) * z0;
    content.style.transform = `translate(${mid.x - qx * s + board.scrollLeft}px, ${mid.y - qy * s + board.scrollTop}px) scale(${s})`;
    clearTimeout(still);
    still = setTimeout(() => pinch !== null && endPinch("still"), 400);
    const cam = { x: mid.x - anchor.x * pinchZoom, y: mid.y - anchor.y * pinchZoom, zoom: pinchZoom };
    view.grid.draw(cam, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 });
  }, { passive: false });
  const endPinch = (how = "touchmove") => {
    clearTimeout(still);
    pinch = null;
    board.classList.remove("pinching");
    content.style.transform = "";
    const to = { x: last.x - anchor.x * pinchZoom, y: last.y - anchor.y * pinchZoom, zoom: pinchZoom };
    view.takeIn(to);
    view.setCamera(to);
    settle();
    note("native pinch end", { how, zoom: pinchZoom, scroll: [r(board.scrollLeft), r(board.scrollTop)] });
  };
  // a pinch begun on a pan the browser had taken ends in touchcancel, not touchend: left on, its scaling froze the board
  for (const type of ["touchend", "touchcancel"] as const) board.addEventListener(type, (e) => { if (e.touches.length < 2 && pinch !== null) endPinch(type); });
  let scrolling = false;
  board.addEventListener("scroll", () => { if (!scrolling) { scrolling = true; note("native scroll start", { at: [r(board.scrollLeft), r(board.scrollTop)] }); } }, { passive: true });
  board.addEventListener("scrollend", () => { scrolling = false; note("native scroll end", { at: [r(board.scrollLeft), r(board.scrollTop)] }); });
  board.classList.add("native");
  const content = document.createElement("div");
  content.className = "native-content";
  content.style.transformOrigin = "0 0";
  const world = board.querySelector<HTMLElement>(".world")!;
  board.insertBefore(content, world);
  content.appendChild(world);
  let fromScroll = false, userScrolled = false, shown = { x: 0, y: 0, w: 0, h: 0, zoom: 0 };
  /** Where the app last put the scroll position: a scroll event there is its own echo, not a pan. */
  let put = { x: NaN, y: NaN };
  const scrollTo = (x: number, y: number) => {
    board.scrollLeft = x;
    board.scrollTop = y;
    put = { x: board.scrollLeft, y: board.scrollTop };
    // a position the browser did not take, as during its own pan
    if (Math.abs(put.x - x) > 2 || Math.abs(put.y - y) > 2) note("native scroll refused", { asked: [r(x), r(y)], got: [r(put.x), r(put.y)] });
  };

  /** The content sized to the board at `zoom`, the world placed in it, the grid with it. */
  const layout = (zoom: number) => {
    const b = view.board();
    if (b.x === shown.x && b.y === shown.y && b.w === shown.w && b.h === shown.h && zoom === shown.zoom && content.style.width) return;
    shown = { ...b, zoom };
    // a point more than the window: Firefox rubber-bands only what it can scroll, and a board that fits the window,
    // as at 25 %, could not
    content.style.width = `${Math.max(b.w * zoom, board.clientWidth + 1)}px`;
    content.style.height = `${Math.max(b.h * zoom, board.clientHeight + 1)}px`;
    world.style.transform = `translate(${-b.x * zoom}px, ${-b.y * zoom}px) scale(${zoom})`;
    const step = 25 * zoom, ox = (-b.x * zoom) % step, oy = (-b.y * zoom) % step;
    content.style.backgroundSize = `${step}px ${step}px`;
    content.style.backgroundPosition = `${ox - step / 2}px ${oy - step / 2}px`;
  };

  /** The camera the scroll position stands for. */
  const camOf = (zoom: number): Cam => ({ x: -shown.x * zoom - board.scrollLeft, y: -shown.y * zoom - board.scrollTop, zoom });

  // the app moves the camera: zoom, reveal, springs; the scroll position follows
  view.apply = (cam: Cam) => {
    if (fromScroll) return view.onCamera();
    layout(cam.zoom);
    scrollTo(-cam.x - shown.x * cam.zoom, -cam.y - shown.y * cam.zoom);
    view.onCamera();
  };
  view.drawGrid = () => {};
  // the grid's canvas, which measured the screen, is hidden here
  view.stage = () => ({ top: 0, left: 0, right: board.clientWidth, bottom: board.clientHeight });

  board.addEventListener("scroll", () => {
    // the app's own move, as a spring's: setting the camera from it would stop the spring
    if (Math.abs(board.scrollLeft - put.x) < 1 && Math.abs(board.scrollTop - put.y) < 1) return;
    userScrolled = true;
    fromScroll = true;
    view.camera.set(camOf(shown.zoom || view.cam.zoom));
    fromScroll = false;
  }, { passive: true });
  // the board takes in what shows once a pan of the user's has ended, the scroll position moving with its origin; not
  // after the app's own moves, which end every frame of a pinch, nor during a pinch
  board.addEventListener("scrollend", () => {
    if (!userScrolled || pinch !== null) return;
    userScrolled = false;
    settle();
  });
  const settle = () => {
    const cam = view.cam;
    view.rest();
    layout(cam.zoom);
    scrollTo(-cam.x - shown.x * cam.zoom, -cam.y - shown.y * cam.zoom);
  };
  layout(view.cam.zoom);
  view.apply(view.cam);
}
