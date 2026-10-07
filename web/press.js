import { animate } from "./motion.js";

/** How far a finger can stray from a button and still press it, as UIControl allows. */
export const SLOP = 70;

/** Whether a press is still on its button: UIControl's touch tracking, without the DOM. */
export class PressTracker {
  constructor(rect) {
    this.rect = rect;
    this.inside = true;
  }

  within(p) {
    const r = this.rect;
    return p.x >= r.left - SLOP && p.x <= r.right + SLOP && p.y >= r.top - SLOP && p.y <= r.bottom + SLOP;
  }

  /** "in" or "out" when the press crosses the edge of its reach, else null. */
  move(p) {
    const inside = this.within(p);
    if (inside === this.inside) return null;
    this.inside = inside;
    return inside ? "in" : "out";
  }

  up(p) {
    return this.within(p);
  }
}

const GROW = { type: "spring", visualDuration: 0.3, bounce: 0.35 };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Presses `el` as iOS does: highlighted on touch-down and while the finger stays near, acting only when it lifts
 * near. The glass capsule around it grows and brightens for as long as the finger is down, as Liquid Glass does.
 * Taps never take focus, so the editor keeps the keyboard. `down(e)` runs on touch-down; `act()` on a lift in reach.
 */
export function track(el, { act, down = () => {} }) {
  const glass = el.closest(".pill, .selection, .plus");
  let tracker = null;
  el.addEventListener("pointerdown", (e) => {
    if (el.disabled || tracker) return;
    tracker = new PressTracker(el.getBoundingClientRect());
    el.classList.add("hot");
    if (glass) {
      glass.classList.add("pressed");
      if (!reduced()) animate(glass, { scale: 1.08 }, GROW);
    }
    down(e);
  });
  el.addEventListener("pointermove", (e) => {
    const change = tracker?.move({ x: e.clientX, y: e.clientY });
    if (change) el.classList.toggle("hot", change === "in");
  });
  const end = (e, cancelled) => {
    if (!tracker) return;
    const inside = !cancelled && tracker.up({ x: e.clientX, y: e.clientY });
    tracker = null;
    el.classList.remove("hot");
    if (glass) {
      glass.classList.remove("pressed");
      if (!reduced()) animate(glass, { scale: 1 }, GROW);
    }
    if (inside && !el.disabled) act(e);
  };
  el.addEventListener("pointerup", (e) => end(e, false));
  el.addEventListener("pointercancel", (e) => end(e, true));
  // Lets iOS apply :active; the compatibility mouse events would move focus out of the editor.
  el.addEventListener("touchstart", () => {}, { passive: true });
  el.addEventListener("touchend", (e) => e.preventDefault());
  el.addEventListener("mousedown", (e) => e.preventDefault());
}
