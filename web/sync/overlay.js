// Others' live edits drawn over a board, and what a gesture sends of them, as BreezyKit's Overlay.
import { cardRecord, laneRecord } from "./records.js";

/** The fields a live message may carry; an item new during the gesture also carries `kind`. */
export const LIVE_FIELDS = ["pos", "size", "w", "text", "notes", "color", "title"];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What the gesture changed of items `ids` between `start` and `now`, as record fields. */
export function liveFields(start, now, ids, board) {
  const out = {};
  const put = (id, before, after) => {
    const names = before ? LIVE_FIELDS : [...LIVE_FIELDS, "kind"];
    const f = Object.fromEntries(names.filter((k) => k in after && !same(before?.[k], after[k])).map((k) => [k, after[k]]));
    if (Object.keys(f).length) out[id] = f;
  };
  for (const c of now.cards) {
    if (!ids.has(c.id)) continue;
    const was = start.cards.find((x) => x.id === c.id);
    put(c.id, was && cardRecord(was, board, ""), cardRecord(c, board, ""));
  }
  for (const l of now.lanes) {
    if (!ids.has(l.id)) continue;
    const was = start.lanes.find((x) => x.id === l.id);
    put(l.id, was && laneRecord(was, board), laneRecord(l, board));
  }
  return out;
}

const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : null);
const colour = (v) => Math.trunc(Math.min(5, Math.max(1, v)));

/** `board` as others' live edits show it, a copy; a new card appears, other unknown ids are left out. */
export function overlaid(board, overlay) {
  if (!overlay.size) return board;
  const b = structuredClone(board);
  for (const c of b.cards) {
    const f = overlay.get(c.id);
    if (!f) continue;
    const p = pair(f.pos);
    if (p) [c.x, c.y] = p;
    if (Number.isFinite(f.w)) c.w = f.w;
    if (typeof f.text === "string") c.text = f.text;
    if (typeof f.notes === "string") {
      if (f.notes) c.notes = f.notes;
      else delete c.notes;
    }
    if (Number.isFinite(f.color)) c.color = colour(f.color);
  }
  for (const l of b.lanes) {
    const f = overlay.get(l.id);
    if (!f) continue;
    const p = pair(f.pos), s = pair(f.size);
    if (p) [l.x, l.y] = p;
    if (s) [l.w, l.h] = s;
    if (typeof f.title === "string") l.title = f.title;
  }
  const known = new Set(b.cards.map((c) => c.id));
  for (const [id, f] of [...overlay].sort(([a], [z]) => (a < z ? -1 : 1))) {
    if (f.kind !== "card" || known.has(id)) continue;
    const [x, y] = pair(f.pos) ?? [0, 0];
    b.cards.push({ id, x, y, w: Number.isFinite(f.w) ? f.w : 240, text: typeof f.text === "string" ? f.text : "",
      color: Number.isFinite(f.color) ? colour(f.color) : 1, ...(f.notes ? { notes: f.notes } : {}) });
  }
  return b;
}
