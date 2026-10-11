// Others' live edits drawn over a board, and what a gesture sends of them, as BreezyKit's Overlay.
import type { Board, Card, Lane } from "../types.ts";
import { cardRecord, laneRecord } from "./records.ts";
import type { SyncRecord } from "./records.ts";

/** An item's fields in a live message, as record fields. */
export type LiveItem = {
  pos?: number[];
  size?: number[];
  w?: number;
  text?: string;
  notes?: string;
  color?: number;
  title?: string;
  kind?: string;
  gone?: true;
};
/** Item id → its live fields. */
export type LiveItems = { [id: string]: LiveItem };
/** Live fields as another device sent them, unchecked. */
export type Fields = { [field: string]: unknown };
/** Item id → where it was when the gesture began. */
export type Starts = { [id: string]: [number, number] };
/** Where a text caret is: in item `id`, at `at` UTF-16 units, counted from the end when `back`. */
export interface Caret {
  id: string;
  back: boolean;
  at: number;
}
/** How far held items float off the grid: a move or a resize. */
export interface Float {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** The fields a live message may carry; an item new during the gesture also carries `kind`, and one deleted `gone`. */
export const LIVE_FIELDS = ["pos", "size", "w", "text", "notes", "color", "title"];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the gesture changed of items `ids` between `start` and `now`, as record fields. */
export function liveFields(start: Board, now: Board, ids: Set<string>, board: string): LiveItems {
  const out: LiveItems = {};
  const put = (id: string, before: SyncRecord | undefined, after: SyncRecord) => {
    const names = before ? LIVE_FIELDS : [...LIVE_FIELDS, "kind"];
    const f = Object.fromEntries(names.filter((k) => k in after && !same(before?.[k], after[k])).map((k) => [k, after[k]]));
    if (Object.keys(f).length) out[id] = f as LiveItem;
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
  const kept = new Set([...now.cards, ...now.lanes].map((x) => x.id));
  for (const x of [...start.cards, ...start.lanes]) if (ids.has(x.id) && !kept.has(x.id)) out[x.id] = { gone: true };
  return out;
}

/** `items`, from liveFields, with the `held` items of `board` where they float under the pointer, off the grid, by
 * `float` (`{x, y}` or `{w, h}`), as this device draws them: others then see the drag as smoothly. */
export function floated(items: LiveItems, board: Board, held: Set<string>, float: Float | null | undefined): LiveItems {
  if (!float) return items;
  const out = { ...items };
  for (const x of [...board.cards, ...board.lanes]) {
    if (!held.has(x.id) || !(x.id in items || float.x || float.y || float.w || float.h)) continue;
    const f = { ...out[x.id] };
    if (Number.isFinite(float.x)) f.pos = [x.x + float.x!, x.y + float.y!];
    if (Number.isFinite(float.w)) f.size = [x.w + float.w!, (x as Lane).h + float.h!];
    out[x.id] = f;
  }
  return out;
}

/** Where items `ids` were when the gesture began, as `{id: [x, y]}`. */
export function startPositions(start: Board | null, ids: Set<string>): Starts {
  const out: Starts = {};
  for (const x of start ? [...start.cards, ...start.lanes] : []) if (ids.has(x.id)) out[x.id] = [x.x, x.y];
  return out;
}

const pair = (v: unknown): number[] | null => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v : null);
const colour = (v: number) => Math.trunc(Math.min(5, Math.max(1, v)));

/** `board` as others' live edits show it, a copy; a new card or lane appears, a deleted one goes, other unknown ids
 * are left out. */
export function overlaid(board: Board, overlay: Map<string, Fields>): Board {
  if (!overlay.size) return board;
  const b = structuredClone(board);
  const gone = (x: Card | Lane) => overlay.get(x.id)?.gone === true;
  b.cards = b.cards.filter((c) => !gone(c));
  b.lanes = b.lanes.filter((l) => !gone(l));
  for (const c of b.cards) {
    const f = overlay.get(c.id);
    if (!f) continue;
    const p = pair(f.pos);
    if (p) [c.x, c.y] = p;
    if (Number.isFinite(f.w)) c.w = f.w as number;
    if (typeof f.text === "string") c.text = f.text;
    if (typeof f.notes === "string") {
      if (f.notes) c.notes = f.notes;
      else delete c.notes;
    }
    if (Number.isFinite(f.color)) c.color = colour(f.color as number);
  }
  for (const l of b.lanes) {
    const f = overlay.get(l.id);
    if (!f) continue;
    const p = pair(f.pos), s = pair(f.size);
    if (p) [l.x, l.y] = p;
    if (s) [l.w, l.h] = s;
    if (typeof f.title === "string") l.title = f.title;
  }
  const known = new Set([...b.cards, ...b.lanes].map((x) => x.id));
  for (const [id, f] of [...overlay].sort(([a], [z]) => (a < z ? -1 : 1))) {
    if (known.has(id) || f.gone) continue;
    const [x, y] = pair(f.pos) ?? [0, 0];
    if (f.kind === "card") {
      b.cards.push({ id, x, y, w: Number.isFinite(f.w) ? (f.w as number) : 240, text: typeof f.text === "string" ? f.text : "",
        color: Number.isFinite(f.color) ? colour(f.color as number) : 1, ...(f.notes ? { notes: f.notes as string } : {}) });
    }
    if (f.kind === "lane") {
      const [w, h] = pair(f.size) ?? [480, 720];
      b.lanes.push({ id, x, y, w, h, title: typeof f.title === "string" ? f.title : "" });
    }
  }
  return b;
}
