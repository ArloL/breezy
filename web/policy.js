import { LANE_HEADER, card, contains } from "./rules.js";

export const TOUCH = 44;

/** What is under world point `p`, top first; touch areas are `TOUCH` screen points at `zoom`. */
export function hitTest(b, p, { rectOf, zoom, turned }) {
  const reach = TOUCH / 2 / zoom;
  const near = (x, y) => Math.abs(p.x - x) <= reach && Math.abs(p.y - y) <= reach;
  const order = [...b.cards].reverse();
  const t = turned && card(b, turned);
  if (t) order.unshift(...order.splice(order.indexOf(t), 1));
  for (const c of order) {
    const r = rectOf(c);
    const ear = c.id === turned ? 24 : c.notes ? 16 : 0;
    if (ear && near(r.x + r.w - ear / 2, r.y + r.h - ear / 2)) return { kind: "fold", id: c.id };
    if (contains(r, p.x, p.y)) return { kind: "card", id: c.id };
  }
  for (const l of [...b.lanes].reverse()) {
    if (near(l.x + l.w - 10, l.y + l.h - 10)) return { kind: "corner", id: l.id };
    const header = { x: l.x, y: l.y, w: l.w, h: Math.max(LANE_HEADER, TOUCH / zoom) };
    if (contains(header, p.x, p.y)) return { kind: "header", id: l.id };
  }
  return { kind: "empty" };
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
