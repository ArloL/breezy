// Boards as records and back, as BreezyKit's Records. A card's pos and a lane's pos and size are pairs, so that a
// merge never takes x from one move and y from another.
import { CARD_W, LANE_W, LANE_H } from "../rules.js";
import { assign } from "./order-key.js";

export const FORMAT = 1;

export const cardRecord = (c, board, order) => ({
  format: FORMAT, kind: "card", board, text: c.text, notes: c.notes ?? "", color: c.color, pos: [c.x, c.y], w: c.w, order,
});
export const laneRecord = (l, board) => ({ format: FORMAT, kind: "lane", board, title: l.title, pos: [l.x, l.y], size: [l.w, l.h] });
export const boardRecord = (title) => ({ format: FORMAT, kind: "board", title });
export const deletedRecord = (kind) => ({ format: FORMAT, kind, deleted: true });

const pair = (v, fallback) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : fallback);
const text = (v) => (typeof v === "string" ? v : "");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Board `id` as `records` describe it: cards by order key, then id; lanes by id. */
export function boardFrom(records, id) {
  const cards = [], lanes = [];
  for (const [rid, r] of Object.entries(records)) {
    if (r.deleted || r.board !== id) continue;
    const [x, y] = pair(r.pos, [0, 0]);
    if (r.kind === "card") {
      const notes = text(r.notes);
      const color = Math.min(5, Math.max(1, Math.trunc(Number(r.color)) || 1));
      const w = Number.isFinite(r.w) ? r.w : CARD_W;
      cards.push({ order: text(r.order), card: { id: rid, x, y, w, text: text(r.text), color, ...(notes ? { notes } : {}) } });
    } else if (r.kind === "lane") {
      const [w, h] = pair(r.size, [LANE_W, LANE_H]);
      lanes.push({ id: rid, x, y, w, h, title: text(r.title) });
    }
  }
  cards.sort((a, b) => cmp(a.order, b.order) || cmp(a.card.id, b.card.id));
  lanes.sort((a, b) => cmp(a.id, b.id));
  return { cards: cards.map((c) => c.card), lanes };
}

const diff = (a, b) => Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v)));

/** What changed from `old` to `now`, both board `id`: whole records for new items, changed fields, deletions. */
export function changes(old, now, board, orders) {
  const out = {};
  const keys = assign(now.cards.map((c) => c.id), orders);
  const put = (id, before, after) => {
    const d = before ? diff(before, after) : after;
    if (Object.keys(d).length) out[id] = { fields: d };
  };
  const oldCards = new Map(old.cards.map((c) => [c.id, c]));
  for (const c of now.cards) {
    const was = oldCards.get(c.id);
    put(c.id, was && cardRecord(was, board, orders[c.id] ?? ""), cardRecord(c, board, keys[c.id]));
  }
  const oldLanes = new Map(old.lanes.map((l) => [l.id, l]));
  for (const l of now.lanes) {
    const was = oldLanes.get(l.id);
    put(l.id, was && laneRecord(was, board), laneRecord(l, board));
  }
  const cardIDs = new Set(now.cards.map((c) => c.id)), laneIDs = new Set(now.lanes.map((l) => l.id));
  for (const c of old.cards) if (!cardIDs.has(c.id)) out[c.id] = { deleted: "card" };
  for (const l of old.lanes) if (!laneIDs.has(l.id)) out[l.id] = { deleted: "lane" };
  return out;
}
