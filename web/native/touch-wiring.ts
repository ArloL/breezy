import { clampZoom } from "../camera.ts";
import { isEcho } from "./geometry.ts";
import { coastFromLift, followVelocity, pinchKind, stopsBrowserPan } from "./touch.ts";
import type { App } from "../app.ts";
import type { Gestures } from "../gestures.ts";
import type { NativeSurface } from "./surface.ts";
import type { Point } from "../types.ts";

/** A pinch held this long without a move ends: one on a pan the browser took may never hear its fingers lift. */
const STILL_MS = 400;

const editorOf = (t: EventTarget | null) => (t as Element | null)?.closest?.('[contenteditable="plaintext-only"]') ?? null;
const spread = (t: TouchList) => Math.max(1, Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY));
const middle = (t: TouchList) => ({ x: (t[0]!.clientX + t[1]!.clientX) / 2, y: (t[0]!.clientY + t[1]!.clientY) / 2 });

/**
 * Touch on a native board, which the browser pans with one finger: what Breezy does with a touch, a lifted card, a quick
 * drag, the one-finger zoom, keeps the browser from panning too; two fingers pinch from the touches themselves, as the
 * browser cancels a panning finger's pointer; the finger left after a pinch pans the board, as iOS starts no pan for a
 * touch already down; and while a card is edited the board scrolls only for a touch begun outside the editor. Undone by
 * the returned function.
 */
export function wireTouch(app: App, board: HTMLElement, surface: NativeSurface, gestures: Gestures) {
  const off = new AbortController(), signal = off.signal;
  const { input, state, view } = app;
  /** A touch sequence begun on the board, and whether the browser has panned since its first finger. */
  let ours = false, panned = false;
  /** Whether a touch of the sequence kept the browser from panning, which the flight recording notes once. */
  let stopped = false;
  let pinch: { d: number; zoom: number; mid: Point; still?: ReturnType<typeof setTimeout> } | null = null;
  /** The fingers' spread as the second came down, which the pinch scales from: its first move is already some way on. */
  let spreadAtDown = 0;
  let follow: { id: number; x: number; y: number; t: number; v: Point } | null = null;

  board.addEventListener("touchstart", (e) => {
    if (!ours) panned = stopped = false;
    ours = true;
    if (!editorOf(e.target)) board.classList.add("pan-anyway");
    if (e.target) heard(e.target);
  }, { passive: true, signal });
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) spreadAtDown = spread(e.touches);
  }, { passive: true, signal });
  board.addEventListener("scroll", () => {
    if (ours && !pinch && !isEcho({ x: board.scrollLeft, y: board.scrollTop }, surface.written)) panned = true;
  }, { passive: true, signal });

  /** Each handler hears an event once, from the document or from its touch's target. */
  const once = () => {
    const seen = new WeakSet<Event>();
    return (e: Event) => !seen.has(e) && !!seen.add(e);
  };
  const stopOnce = once(), moveOnce = once(), endOnce = once();

  // before any scroll has begun: once it has, iOS pans whatever the page does
  const stopPan = (e: TouchEvent) => {
    if (!stopOnce(e) || e.touches.length > 1) return;
    const stop = stopsBrowserPan({
      lifted: state.lifted.size > 0,
      dragAction: input.drag?.action ?? null,
      doubleTapSecond: !!gestures.one?.double,
      editing: !!state.editing,
      inEditor: !!editorOf(e.target),
    });
    if (!stop) return;
    if (e.cancelable) e.preventDefault();
    if (!stopped) app.flight.note("input", "native pan stopped", { cancelable: e.cancelable, lifted: state.lifted.size, drag: input.drag?.action ?? null });
    stopped = true;
  };
  board.addEventListener("touchmove", stopPan, { passive: false, signal });

  const end = (how: string) => {
    if (!pinch) return;
    clearTimeout(pinch.still);
    const { zoom, mid } = pinch;
    pinch = null;
    surface.pinchEnd(zoom, mid, how);
  };
  const followFrom = (t: Touch | undefined, at: number) => {
    follow = t ? { id: t.identifier, x: t.clientX, y: t.clientY, t: at, v: { x: 0, y: 0 } } : null;
  };

  // on the document: in the overlay, the touches' targets are no longer in the board
  const moved = (e: TouchEvent) => {
    if (!moveOnce(e) || !ours) return;
    if (e.touches.length < 2) {
      if (pinch) {
        end("fingers");
        return followFrom(e.touches[0], e.timeStamp);
      }
      const f = follow, t = f && [...e.touches].find((u) => u.identifier === f.id);
      if (!f || !t) return;
      if (e.cancelable) e.preventDefault();
      const dx = t.clientX - f.x, dy = t.clientY - f.y, c = view.cam;
      f.v = followVelocity(f.v, dx, dy, e.timeStamp - f.t);
      Object.assign(f, { x: t.clientX, y: t.clientY, t: e.timeStamp });
      view.setCamera({ ...c, x: c.x + dx, y: c.y + dy });
      return;
    }
    if (e.cancelable) e.preventDefault();
    const d = spread(e.touches), mid = middle(e.touches);
    if (!pinch) {
      follow = null;
      // a first finger the browser panned had its pointer cancelled, and the second would be taken for a touch of its own
      if (!gestures.two) gestures.cancelAll();
      view.camera.stop();
      surface.pinchStart(mid, pinchKind({ cancelable: e.cancelable, pannedThisTouch: panned }));
      pinch = { d: spreadAtDown || d, zoom: view.cam.zoom, mid };
      spreadAtDown = 0;
    }
    pinch.zoom = clampZoom(pinch.zoom * (d / pinch.d));
    pinch.d = d;
    pinch.mid = mid;
    surface.pinchTo(pinch.zoom, mid);
    clearTimeout(pinch.still);
    pinch.still = setTimeout(() => end("still"), STILL_MS);
  };
  document.addEventListener("touchmove", moved, { passive: false, signal });

  // a pinch on a pan the browser had taken may end in touchcancel
  const lifted = (e: TouchEvent) => {
    if (!endOnce(e)) return;
    if (follow && e.touches.length === 0) {
      const v = coastFromLift(follow.v, e.timeStamp - follow.t);
      follow = null;
      view.camera.coast(v);
    }
    if (pinch && e.touches.length === 1) {
      end(e.type);
      followFrom(e.touches[0], e.timeStamp);
    } else if (pinch && e.touches.length < 2) end(e.type);
    if (e.touches.length === 0) {
      ours = false;
      board.classList.remove("pan-anyway");
    }
  };
  for (const type of ["touchend", "touchcancel"] as const) document.addEventListener(type, lifted, { signal });
  /** A touch is told at its target alone once that has left the page, as a card's text does when it lifts or its
   * editor opens: a held card's moves went unheard, and the browser panned under it; the double tap that began an edit
   * left the board free to scroll under it. */
  const heard = (t: EventTarget) => {
    const done = new AbortController(), on = { signal: AbortSignal.any([done.signal, signal]), passive: false };
    const f = (e: Event) => {
      done.abort();
      lifted(e as TouchEvent);
    };
    t.addEventListener("touchmove", (e) => {
      stopPan(e as TouchEvent);
      moved(e as TouchEvent);
    }, on);
    t.addEventListener("touchend", f, on);
    t.addEventListener("touchcancel", f, on);
  };

  // iOS scrolled the board to keep a dragged or spacebar-moved caret in view, taking the card out of sight
  document.addEventListener("focusin", (e) => editorOf(e.target) && board.classList.add("editing"), { signal });
  document.addEventListener("focusout", (e) => editorOf(e.target) && board.classList.remove("editing"), { signal });

  return () => {
    end("dispose");
    off.abort();
    board.classList.remove("editing", "pan-anyway");
  };
}
