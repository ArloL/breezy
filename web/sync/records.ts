// Boards as records and back, as BreezyKit's Records. A card's pos and a lane's pos and size are pairs, so that a
// merge never takes x from one move and y from another.
import type { Board, Card, Lane } from "../types.ts";
import { CARD_W, LANE_W, LANE_H } from "../rules.ts";
import { assign, longestIncreasing } from "./order-key.ts";
import type { Orders } from "./order-key.ts";
import { planted } from "./plant.ts";

export const FORMAT = 1;

/** A record as stored and synced: the fields below where it has them, and any others, as a newer Breezy may write. */
export interface SyncRecord {
  format?: number;
  kind?: string;
  board?: string;
  deleted?: boolean;
  [field: string]: unknown;
}

/** Record id → record. */
export type Records = { [id: string]: SyncRecord };

/** A local edit of a record: fields it sets, or its deletion, naming its kind. */
export type Edit = { fields: SyncRecord; deleted?: undefined } | { deleted: string; fields?: undefined };
export type Edits = { [id: string]: Edit };

export const cardRecord = (c: Card, board: string, order: string) => ({
  format: FORMAT, kind: "card", board, text: c.text, notes: c.notes ?? "", color: c.color, pos: [c.x, c.y], w: c.w, order,
});
export const laneRecord = (l: Lane, board: string) => ({ format: FORMAT, kind: "lane", board, title: l.title, pos: [l.x, l.y], size: [l.w, l.h] });
export const boardRecord = (title: string) => ({ format: FORMAT, kind: "board", title });
export const spaceRecord = (name: string) => ({ format: FORMAT, kind: "space", name });
export const deletedRecord = (kind: string) => ({ format: FORMAT, kind, deleted: true });

const pair = (v: unknown, fallback: number[]): number[] => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : fallback);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Board `id` as `records` describe it: cards by order key, then id; lanes by id. */
export function boardFrom(records: Records, id: string): Board {
  const cards: { order: string; card: Card }[] = [], lanes: Lane[] = [];
  for (const [rid, r] of Object.entries(records)) {
    if (r.deleted === true || r.board !== id) continue;
    const [x, y] = pair(r.pos, [0, 0]);
    if (r.kind === "card") {
      const notes = text(r.notes);
      const color = typeof r.color === "number" && Number.isFinite(r.color) ? Math.trunc(Math.min(5, Math.max(1, r.color))) : 1;
      const w = Number.isFinite(r.w) ? (r.w as number) : CARD_W;
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

const diff = (a: SyncRecord, b: SyncRecord): SyncRecord => Object.fromEntries(Object.entries(b).filter(([k, v]) => JSON.stringify(a[k]) !== JSON.stringify(v)));

/** Keys for `now`'s cards, writing only an order changed here: cards that kept their places relative to each other
 * since `old` stay in the order of `orders`, which may hold another device's reorder, and the rest get keys after the
 * card before them in `now`. */
function orderKeys(old: Board, now: Board, orders: Orders): Orders {
  const was = new Map(old.cards.map((c, i) => [c.id, i]));
  const ids = now.cards.map((c) => c.id);
  const kept = longestIncreasing(ids.map((id) => was.get(id) ?? null));
  const after = new Map<string, string[]>();
  let prev = "";
  ids.forEach((id, i) => {
    if (kept.has(i)) prev = id;
    else after.set(prev, [...(after.get(prev) ?? []), id]);
  });
  const stay = ids.filter((_, i) => kept.has(i)).sort((a, b) => cmp(orders[a] ?? "", orders[b] ?? "") || cmp(a, b));
  const sequence = [...(after.get("") ?? []), ...stay.flatMap((id) => [id, ...(after.get(id) ?? [])])];
  return assign(sequence, Object.fromEntries(stay.filter((id) => id in orders).map((id) => [id, orders[id]])));
}

/** What changed from `old` to `now`, both board `id`: whole records for new items, changed fields, deletions. */
export function changes(old: Board, now: Board, board: string, orders: Orders): Edits {
  const out: Edits = {};
  const keys = planted("order-all") ? assign(now.cards.map((c) => c.id), orders) : orderKeys(old, now, orders);
  const put = (id: string, before: SyncRecord | undefined, after: SyncRecord) => {
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
