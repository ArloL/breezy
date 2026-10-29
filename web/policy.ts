import { LANE_HEADER, card, contains } from "./rules.ts";
import type { Board, Card, Point, Rect } from "./types.ts";

export const TOUCH = 44;
/** Every card's corner, which a double tap or double-click turns. */
export const FOLD = 32;
/** A finger's corner on screen at 100 % and above; below 100 % it shrinks with the card. */
export const FOLD_TOUCH = 64;
/** Below this zoom a finger's corner would be under `TOUCH`, so a finger has none. */
export const FOLD_MIN_ZOOM = TOUCH / FOLD_TOUCH;

export type Hit = { kind: "fold" | "card" | "corner" | "header"; id: string } | { kind: "empty"; id?: undefined };

export type DragAction = "move" | "resize" | "lane" | "marquee" | "pan";

export interface PressAction {
  select: "only" | "toggle" | "pile" | "keep" | "none";
  drag: Exclude<DragAction, "pan"> | null;
  collapse?: boolean;
}

/**
 * What is under world point `p`, top first. Touch areas are `TOUCH` screen points at `zoom`, a card's corner
 * `FOLD_TOUCH` inside the card down to `FOLD_MIN_ZOOM`; a pointer gets the Mac's: the corner's own `FOLD` square, a 20 pt
 * lane corner and the 48 pt header.
 */
export function hitTest(
  b: Board,
  p: Point,
  { rectOf, zoom, turned, touch = true }: { rectOf: (c: Card) => Rect; zoom: number; turned: string | null; touch?: boolean },
): Hit {
  const reach = TOUCH / 2 / zoom;
  const near = (x: number, y: number, r: number) => Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r;
  const order = [...b.cards].reverse();
  const t = turned && card(b, turned);
  if (t) order.unshift(...order.splice(order.indexOf(t), 1));
  const fold = !touch ? FOLD : zoom < FOLD_MIN_ZOOM ? 0 : (FOLD_TOUCH * Math.min(zoom, 1)) / zoom;
  for (const c of order) {
    const r = rectOf(c);
    if (!contains(r, p.x, p.y)) continue;
    if (p.x > r.x + r.w - fold && p.y > r.y + r.h - fold) return { kind: "fold", id: c.id };
    return { kind: "card", id: c.id };
  }
  for (const l of [...b.lanes].reverse()) {
    if (near(l.x + l.w - 10, l.y + l.h - 10, touch ? reach : 10)) return { kind: "corner", id: l.id };
    const header = { x: l.x, y: l.y, w: l.w, h: touch ? Math.max(LANE_HEADER, TOUCH / zoom) : LANE_HEADER };
    if (contains(header, p.x, p.y)) return { kind: "header", id: l.id };
  }
  return { kind: "empty" };
}

/** What a mouse press does, as on the Mac: how the selection changes, and what a drag from it does. */
export function pressAction(hit: Hit, { shift, alt }: { shift: boolean; alt: boolean }, selection: ReadonlySet<string>): PressAction {
  switch (hit.kind) {
    case "fold":
    case "card":
      if (shift) return { select: "toggle", drag: null };
      if (alt) return { select: "pile", drag: "move", collapse: true };
      return { select: selection.has(hit.id) ? "keep" : "only", drag: "move", collapse: true };
    case "corner":
      return { select: "only", drag: "resize" };
    case "header":
      return shift ? { select: "toggle", drag: null } : { select: "only", drag: "lane" };
    default:
      return { select: shift ? "keep" : "none", drag: "marquee" };
  }
}

/** What a one-finger drag does: see the spec's table. */
export function dragAction(hit: Hit, selection: ReadonlySet<string>, held: boolean): DragAction {
  switch (hit.kind) {
    case "corner":
      return held ? "resize" : "pan";
    case "card":
    case "fold":
      return held || selection.has(hit.id) ? "move" : "pan";
    case "header":
      return held ? "lane" : "pan";
    default:
      return held ? "marquee" : "pan";
  }
}
