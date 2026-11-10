// SPIKE, throwaway (docs/superpowers/specs/2026-11-10-breezy-native-panning-design.md): the board in a real scroll
// container, the browser panning, Breezy's zoom on top. `?pan=native`.
import type { View } from "./view.ts";
import type { Input } from "./input.ts";
import type { Cam } from "./types.ts";

export const nativeWanted = () => new URLSearchParams(location.search).get("pan") === "native";

/** The gesture recognizer, made after the board: whether a touch is a double tap's second, the one-finger zoom. */
let gestures: { one?: { double?: boolean } | null } | null = null;
export const nativeGestures = (g: unknown) => void (gestures = g as typeof gestures);

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
    // a hold lifts its card before any drag begins: the first move after it must not start the browser's pan
    const lifted = (input as unknown as { app: { state: { lifted: Set<string> } } }).app.state.lifted.size > 0;
    // so must a double tap's second touch, which drags to zoom
    if (lifted || gestures?.one?.double || (input.drag && input.drag.action !== "pan")) e.preventDefault();
  }, { passive: false });
  // A pinch: the browser pans the first finger before the second lands, and cancels its pointer, so the zoom follows the
  // touches themselves, around their midpoint, while the browser pans, as UIScrollView pans and zooms at once.
  // the one-finger zoom went through pinch, made a no-op here: it zooms around the point first touched itself
  input.zoomDrag = (dy: number) => {
    const base = input.pinchBase;
    if (base) view.zoomAround(base.c, base.cam.zoom * 2 ** (dy / 150));
  };
  input.pinchStart = () => {};
  input.pinch = () => {};
  input.pinchEnd = () => {};
  const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  // A pinch scales the content as drawn, on the compositor, around the board point first under the fingers, and lays
  // it out once at the end: laid out each step, iOS showed the grey past the edge until it had painted the new size.
  let z0 = 1, pinchZoom = 1, last = { x: 0, y: 0 }, still: ReturnType<typeof setTimeout> | undefined, panned = false, fingers = 0;
  // A finger left on the glass after a pinch: iOS starts no new pan for a touch already down, so the board follows it
  // here, and coasts from its speed when it lifts.
  let follow: { id: number; x: number; y: number; t: number; v: { x: number; y: number } } | null = null;
  const followMove = (t: Touch, at: number) => {
    const f = follow!, dt = Math.max(1, at - f.t), dx = t.clientX - f.x, dy = t.clientY - f.y, cam = view.cam;
    f.v = { x: 0.7 * (dx / dt) + 0.3 * f.v.x, y: 0.7 * (dy / dt) + 0.3 * f.v.y };
    Object.assign(f, { x: t.clientX, y: t.clientY, t: at });
    view.setCamera({ ...cam, x: cam.x + dx, y: cam.y + dy });
  };
  // on the document: once the content moves to the overlay, the touches' targets are no longer in the board
  document.addEventListener("touchmove", (e) => {
    if (e.touches.length < 2) {
      if (pinch !== null) {
        endPinch();
        const t = e.touches[0];
        if (t) follow = { id: t.identifier, x: t.clientX, y: t.clientY, t: e.timeStamp, v: { x: 0, y: 0 } };
      } else if (follow) {
        const t = [...e.touches].find((u) => u.identifier === follow!.id);
        if (t) {
          if (e.cancelable) e.preventDefault();
          followMove(t, e.timeStamp);
        }
      }
      return;
    }
    // A second finger on a pan the browser has already begun: iOS goes on panning whatever the page does, overflow
    // hidden included. So the content leaves the scroll container for an overlay that does not scroll, where it shows
    // the same, and the browser's pan has nothing left to move; it comes back when the pinch ends.
    if (pinch === null && (!e.cancelable || panned)) lift();
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
    const sx = overlaid ? 0 : board.scrollLeft, sy = overlaid ? 0 : board.scrollTop;
    content.style.transform = `translate(${mid.x - qx * s + sx}px, ${mid.y - qy * s + sy}px) scale(${s})`;
    clearTimeout(still);
    still = setTimeout(() => pinch !== null && endPinch("still"), 400);
    const cam = { x: mid.x - anchor.x * pinchZoom, y: mid.y - anchor.y * pinchZoom, zoom: pinchZoom };
    view.grid.draw(cam, { x: -1e6, y: -1e6, w: 2e6, h: 2e6 });
  }, { passive: false });
  // the overlay the content takes refuge in from a pan the browser will not let go of
  const overlay = document.createElement("div"), home = document.createComment("native-content");
  overlay.className = "native-overlay";
  document.body.appendChild(overlay);
  let overlaid = false;
  const lift = () => {
    const sx = board.scrollLeft, sy = board.scrollTop;
    content.replaceWith(home);
    overlay.appendChild(content);
    overlaid = true;
    content.style.transform = `translate(${-sx}px, ${-sy}px)`;
    note("native pinch overlay", { scroll: [r(sx), r(sy)] });
  };
  const putBack = () => {
    if (!overlaid) return;
    home.replaceWith(content);
    overlaid = false;
  };
  const endPinch = (how = "touchmove") => {
    clearTimeout(still);
    putBack();
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
  // whether the browser has panned since the first finger came down: from then on it pans on whatever the page does
  board.addEventListener("touchstart", (e) => { if (fingers === 0) panned = false; fingers = e.touches.length; }, { passive: true });
  board.addEventListener("scroll", () => { if (fingers > 0 && pinch === null && Math.abs(board.scrollLeft - put.x) + Math.abs(board.scrollTop - put.y) >= 1) panned = true; }, { passive: true });
  for (const type of ["touchend", "touchcancel"] as const) document.addEventListener(type, (e) => {
    fingers = e.touches.length;
    if (follow && e.touches.length === 0) {
      const v = e.timeStamp - follow.t < 50 ? follow.v : { x: 0, y: 0 };
      follow = null;
      view.camera.coast(v);
    }
    // the second finger lifting first leaves one to follow
    if (pinch !== null && e.touches.length === 1) {
      const t = e.touches[0];
      endPinch(type);
      follow = { id: t.identifier, x: t.clientX, y: t.clientY, t: e.timeStamp, v: { x: 0, y: 0 } };
      return;
    }
    if (e.touches.length < 2 && pinch !== null) endPinch(type);
  });
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
    // the scroller emptied for a pinch clamps to nothing; the pinch has the camera
    if (pinch !== null) return;
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
