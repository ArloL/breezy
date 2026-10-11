import { LANE_HEADER, card, contains } from "./rules.js";

export const TOUCH = 44;

/**
 * What is under world point `p`, top first. Touch areas are `TOUCH` screen points at `zoom`; a pointer gets the Mac's:
 * the fold's own square, a 20 pt lane corner and the 48 pt header.
 */
export function hitTest(b, p, { rectOf, zoom, turned, touch = true }) {
  const reach = TOUCH / 2 / zoom;
  const near = (x, y, r) => Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r;
  const order = [...b.cards].reverse();
  const t = turned && card(b, turned);
  if (t) order.unshift(...order.splice(order.indexOf(t), 1));
  for (const c of order) {
    const r = rectOf(c);
    const ear = c.id === turned ? 24 : c.notes ? 16 : 0;
    if (ear && near(r.x + r.w - ear / 2, r.y + r.h - ear / 2, touch ? reach : ear / 2)) return { kind: "fold", id: c.id };
    if (contains(r, p.x, p.y)) return { kind: "card", id: c.id };
  }
  for (const l of [...b.lanes].reverse()) {
    if (near(l.x + l.w - 10, l.y + l.h - 10, touch ? reach : 10)) return { kind: "corner", id: l.id };
    const header = { x: l.x, y: l.y, w: l.w, h: touch ? Math.max(LANE_HEADER, TOUCH / zoom) : LANE_HEADER };
    if (contains(header, p.x, p.y)) return { kind: "header", id: l.id };
  }
  return { kind: "empty" };
}

/** What a mouse press does, as on the Mac: how the selection changes, and what a drag from it does. */
export function pressAction(hit, { shift, alt }, selection) {
  switch (hit.kind) {
    case "fold":
      return { select: "only", drag: null, turn: true };
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
export function dragAction(hit, selection, held) {
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
