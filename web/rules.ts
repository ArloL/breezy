import { encode } from "./sync/base64.ts";
import type { Board, Card, Clip, ClipCard, HeightOf, Lane, Point, Rect } from "./types.ts";

export const GRID = 24;
export const CARD_W = 240;
export const BACK_W = 480;
export const BACK_MIN_H = 12 * GRID;
/** A card with a grid either side. */
export const LANE_W = CARD_W + 2 * GRID;
export const LANE_H = 720;
export const LANE_MIN = 4 * GRID;
export const LANE_HEADER = 2 * GRID;
/** Stacked cards sit on the first grid line at least this far below the card above. */
export const ROOM = GRID / 2;
/** Lane cards float up to this far below the lane top. */
export const STACK_TOP = 3 * GRID;

/** Rounds half away from zero, as Swift's `rounded()` does. */
export function snap(v: number) {
  const r = Math.round(Math.abs(v) / GRID) * GRID;
  return v < 0 && r ? -r : r;
}

export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const containsCentre = (r: Rect, b: Rect) => contains(r, b.x + b.w / 2, b.y + b.h / 2);
/** Whether the two overlap horizontally, as cards in one column of a lane do. */
export const sharesColumn = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w;
/** The first grid line at least `ROOM` below `r`. */
export const lineBelow = (r: Rect) => Math.ceil((r.y + r.h + ROOM) / GRID) * GRID;
export const cardRect = (c: Card, h: number): Rect => ({ x: c.x, y: c.y, w: c.w, h });
export const laneRect = (l: Lane): Rect => ({ x: l.x, y: l.y, w: l.w, h: l.h });

/** 16 random bytes: ids are made on every device and must not collide. */
export function newID(): string {
  return encode(crypto.getRandomValues(new Uint8Array(16)));
}

export const card = (b: Board, id: string) => b.cards.find((c) => c.id === id);
export const lane = (b: Board, id: string) => b.lanes.find((l) => l.id === id);

export function addCard(b: Board, x: number, y: number) {
  const c: Card = { id: newID(), x: snap(x), y: snap(y), w: CARD_W, text: "", color: 1 };
  b.cards.push(c);
  return c.id;
}

export function addLane(b: Board, x: number, y: number) {
  const l: Lane = { id: newID(), x: snap(x), y: snap(y), w: LANE_W, h: LANE_H, title: "Lane" };
  b.lanes.push(l);
  return l.id;
}

export function setText(b: Board, id: string, text: string) {
  const c = card(b, id);
  if (c) c.text = text;
}

export function setNotes(b: Board, id: string, notes: string) {
  const c = card(b, id);
  if (c) c.notes = notes;
}

export function setLaneTitle(b: Board, id: string, title: string) {
  const l = lane(b, id);
  if (l) l.title = title;
}

/** Ends editing card `id`: trailing whitespace goes, and a card blank on both sides is removed. */
export function finishEdit(b: Board, id: string) {
  const i = b.cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = b.cards[i];
  c.text = c.text.trimEnd();
  const notes = (c.notes ?? "").trimEnd();
  if (notes) c.notes = notes;
  else delete c.notes;
  if (!c.text && !notes) b.cards.splice(i, 1);
}

/** A card or lane where a drag found it. */
export interface Origin {
  id: string;
  x: number;
  y: number;
}

/** Where everything not held stood when a drag began. */
export interface Layout {
  cardY: Map<string, number>;
  laneH: Map<string, number>;
}

export interface Room {
  heightOf: HeightOf;
  base: Layout;
}

/** With `room` the cards are held in a drag and the others make room for them; see `settle`. */
export function moveCards(b: Board, origins: Origin[], dx: number, dy: number, room?: Room | null) {
  for (const o of origins) {
    const c = card(b, o.id);
    if (!c) continue;
    c.x = snap(o.x + dx);
    c.y = snap(o.y + dy);
  }
  if (room) settle(b, room.heightOf, { held: new Set(origins.map((o) => o.id)), base: room.base });
}

export function setColor(b: Board, ids: ReadonlySet<string>, color: number) {
  for (const c of b.cards) if (ids.has(c.id)) c.color = color;
}

export function remove(b: Board, ids: ReadonlySet<string>) {
  b.cards = b.cards.filter((c) => !ids.has(c.id));
  b.lanes = b.lanes.filter((l) => !ids.has(l.id));
}

/** The selected cards, lanes left out, in reading order; null when none is a card. */
export function clip(b: Board, board: string, ids: ReadonlySet<string>, heightOf: HeightOf): Clip | null {
  const cards = b.cards
    .filter((c) => ids.has(c.id))
    .sort((p, q) => p.y - q.y || p.x - q.x)
    .map((c): ClipCard => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: heightOf(c.id), text: c.text, color: c.color, ...(c.notes ? { notes: c.notes } : {}) }));
  return cards.length ? { v: 1, board, cards } : null;
}

/**
 * Adds copies of the clip's cards and returns their ids, in clip order. On the clip's board a copy
 * of a card in a lane goes right below its original, or, the original gone, before the first card
 * of that lane's column at or below where it stood; the rest move as a block to the clear space
 * nearest their originals, or on another board nearest `here.centre`.
 */
export function paste(b: Board, clip: Clip, here: { board: string; centre: Point }, heightOf: HeightOf): string[] {
  const same = clip.board === here.board;
  const ids = clip.cards.map(newID);
  const free: [ClipCard, Card][] = [];
  let prev: { k: ClipCard; copy: Card; l: Lane } | null = null;
  clip.cards.forEach((k, i) => {
    const before = prev;
    prev = null;
    const copy: Card = { id: ids[i], x: k.x, y: k.y, w: k.w, text: k.text, color: k.color, ...(k.notes ? { notes: k.notes } : {}) };
    const o = same ? card(b, k.id) : undefined;
    const kr = { x: k.x, y: k.y, w: k.w, h: k.h };
    const home = (r: Rect) => b.lanes.find((l) => containsCentre(laneRect(l), r));
    const l = same && !o ? home(kr) : undefined;
    if (o && home(cardRect(o, heightOf(o.id)))) {
      b.cards.push({ ...copy, x: o.x, y: o.y + 1 });
    } else if (l) {
      // A run of cut cards goes back in order: each just below the last, by less than a grid so that no centre ties.
      if (before?.l === l && sharesColumn(before.k, kr)) copy.y = before.copy.y + 1 / 64;
      else {
        const n = b.cards
          .filter((c) => c.y >= k.y && containsCentre(laneRect(l), cardRect(c, heightOf(c.id))) && sharesColumn(kr, cardRect(c, heightOf(c.id))))
          .sort((p, q) => p.y - q.y)[0];
        if (n) copy.y = n.y + heightOf(n.id) / 2 - k.h / 2 - 1;
      }
      b.cards.push(copy);
      prev = { k, copy, l };
    } else {
      free.push([k, copy]);
    }
  });
  if (free.length) {
    const x0 = Math.min(...free.map(([k]) => k.x));
    const y0 = Math.min(...free.map(([k]) => k.y));
    const w = Math.max(...free.map(([k]) => k.x + k.w)) - x0;
    const h = Math.max(...free.map(([k]) => k.y + k.h)) - y0;
    const at = same ? { x: x0, y: y0 } : { x: here.centre.x - w / 2, y: here.centre.y - h / 2 };
    const s = openSpot(b, w, h, at.x, at.y, heightOf);
    for (const [k, copy] of free) b.cards.push({ ...copy, x: k.x + s.x - x0, y: k.y + s.y - y0 });
  }
  gravity(b, heightOf);
  return ids;
}

/** The grid point nearest (`x`, `y`) where a `w` × `h` rect stays a grid clear of every card and lane. */
export function openSpot(b: Board, w: number, h: number, x: number, y: number, heightOf: HeightOf) {
  const g = GRID;
  const taken = [...b.cards.map((c) => cardRect(c, heightOf(c.id))), ...b.lanes.map(laneRect)];
  const down = (v: number) => Math.floor(v / g) * g;
  const up = (v: number) => Math.ceil(v / g) * g;
  // The nearest spot lies at (x, y) or against an item on each axis.
  const xs = new Set([snap(x), ...taken.flatMap((r) => [down(r.x - g - w), up(r.x + r.w + g)])]);
  const ys = new Set([snap(y), ...taken.flatMap((r) => [down(r.y - g - h), up(r.y + r.h + g)])]);
  const spots = [...xs].flatMap((px) => [...ys].map((py) => ({ x: px, y: py, d: Math.hypot(px - x, py - y) })));
  spots.sort((p, q) => p.d - q.d || p.x - q.x || p.y - q.y);
  const s = spots.find((s) => !taken.some((r) => intersects(r, { x: s.x - g, y: s.y - g, w: w + 2 * g, h: h + 2 * g })));
  return { x: s!.x, y: s!.y };
}

/** Moves lane `origin.id` by the snapped delta and carries `carried` with it. */
export function moveLane(b: Board, origin: Origin, carried: Origin[], dx: number, dy: number) {
  const l = lane(b, origin.id);
  if (!l) return;
  l.x = snap(origin.x + dx);
  l.y = snap(origin.y + dy);
  const ddx = l.x - origin.x;
  const ddy = l.y - origin.y;
  for (const o of carried) {
    const c = card(b, o.id);
    if (!c) continue;
    c.x = o.x + ddx;
    c.y = o.y + ddy;
  }
}

export function resizeLane(b: Board, id: string, w: number, h: number) {
  const l = lane(b, id);
  if (!l) return;
  l.w = Math.max(LANE_MIN, snap(w));
  l.h = Math.max(LANE_MIN, snap(h));
}

export function cardsInLane(b: Board, id: string, heightOf: HeightOf) {
  const l = lane(b, id);
  return l ? b.cards.filter((c) => containsCentre(l, cardRect(c, heightOf(c.id)))) : [];
}

export const cardsInRect = (b: Board, r: Rect, heightOf: HeightOf) => b.cards.filter((c) => intersects(r, cardRect(c, heightOf(c.id))));

/** Card `id` and the cards below it in its lane's column; outside a lane, the card alone. */
export function pile(b: Board, id: string, heightOf: HeightOf): string[] {
  const c = card(b, id);
  if (!c) return [];
  const cr = cardRect(c, heightOf(id));
  const l = b.lanes.find((x) => containsCentre(laneRect(x), cr));
  if (!l) return [id];
  return b.cards
    .filter((x) => {
      const xr = cardRect(x, heightOf(x.id));
      return x.id === id || (x.y > c.y && sharesColumn(cr, xr) && containsCentre(laneRect(l), xr));
    })
    .map((x) => x.id);
}

/** Where everything but cards `excluding` stands, for a drag's room. */
export function layout(b: Board, excluding: ReadonlySet<string>): Layout {
  return {
    cardY: new Map(b.cards.filter((c) => !excluding.has(c.id)).map((c) => [c.id, c.y])),
    laneH: new Map(b.lanes.map((l) => [l.id, l.h])),
  };
}

/** Ends a drag: the held cards drop into the places kept for them. */
export const land = (b: Board, ids: ReadonlySet<string>, room: Room) => settle(b, room.heightOf, { held: ids, base: room.base, land: true });

export const gravity = (b: Board, heightOf: HeightOf) => settle(b, heightOf);

interface Box {
  index: number;
  rect: Rect;
  held: boolean;
}

function compare(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Where across lane `l` a card `r` goes: centred in the column under its centre, or in the lane
 * when wider than a column. Columns share the width, as many as fit a card and a grid.
 */
function column(l: Lane, r: Rect) {
  const n = Math.max(1, Math.floor((l.w - GRID) / (CARD_W + GRID)));
  const cw = l.w / n;
  if (r.w > cw) return l.x + (l.w - r.w) / 2;
  const i = Math.min(Math.max(Math.floor((r.x + r.w / 2 - l.x) / cw), 0), n - 1);
  return l.x + i * cw + (cw - r.w) / 2;
}

/**
 * Floats the cards in each lane up their columns in order of their centres; lanes grow to fit.
 * Cards `held` in a drag stay where they are but are ordered as a block by their top card and
 * keep their places free, centred in the column under them; `land` moves them in. With `base` the others start from where they
 * stood when the drag began, so dragging away gives cards back their places.
 */
export function settle(
  b: Board,
  heightOf: HeightOf,
  { held = new Set(), base = null, land = false }: { held?: ReadonlySet<string>; base?: Layout | null; land?: boolean } = {},
) {
  if (base) {
    for (const c of b.cards) if (base.cardY.has(c.id)) c.y = base.cardY.get(c.id)!;
    for (const l of b.lanes) if (base.laneH.has(l.id)) l.h = base.laneH.get(l.id)!;
  }
  const boxes = b.cards.map((c, index) => ({ index, rect: cardRect(c, heightOf(c.id)), held: held.has(c.id) }));
  const done = new Set<number>();
  for (const l of b.lanes) {
    const members = boxes.filter((x) => !done.has(x.index) && containsCentre(l, x.rect));
    for (const x of members) done.add(x.index);
    const top = members.filter((x) => x.held).reduce<Box | null>((t, x) => (!t || x.rect.y < t.rect.y ? x : t), null);
    const key = (x: Box) =>
      x.held ? [top!.rect.y + top!.rect.h / 2, 0, x.rect.y, x.index] : [x.rect.y + x.rect.h / 2, 1, x.rect.y, x.index];
    members.sort((p, q) => compare(key(p), key(q)));
    const placed: Rect[] = [];
    for (const x of members) {
      const r = { ...x.rect, x: x.held ? column(l, x.rect) : x.rect.x, y: l.y + STACK_TOP };
      for (const p of placed) if (sharesColumn(p, r)) r.y = Math.max(r.y, lineBelow(p));
      placed.push(r);
      if (!x.held || land) Object.assign(b.cards[x.index], { x: r.x, y: r.y });
      l.h = Math.max(l.h, lineBelow(r) - l.y);
    }
  }
}

export interface Match {
  id: string;
  side: "title" | "front" | "back";
}

/** Lane titles, card fronts and card backs containing `query`, in reading order. */
export function search(b: Board, query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  type Item = { x: number; y: number; parts: (Match & { text: string })[] };
  const items = [
    ...b.lanes.map((l): Item => ({ x: l.x, y: l.y, parts: [{ id: l.id, side: "title", text: l.title }] })),
    ...b.cards.map((c): Item => ({
      x: c.x,
      y: c.y,
      parts: [{ id: c.id, side: "front", text: c.text }, ...(c.notes ? [{ id: c.id, side: "back" as const, text: c.notes }] : [])],
    })),
  ];
  items.sort((p, q2) => p.y - q2.y || p.x - q2.x);
  return items
    .flatMap((i) => i.parts)
    .filter((p) => p.text.toLowerCase().includes(q))
    .map(({ id, side }) => ({ id, side }));
}
