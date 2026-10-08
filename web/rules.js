import { encode } from "./sync/base64.js";
export const GRID = 24;
export const CARD_W = 240;
export const BACK_W = 480;
export const BACK_MIN_H = 12 * GRID;
export const LANE_W = 480;
export const LANE_H = 720;
export const LANE_MIN = 4 * GRID;
export const LANE_HEADER = 2 * GRID;
/** Stacked cards sit on the first grid line at least this far below the card above. */
export const ROOM = GRID / 2;
/** Lane cards float up to this far below the lane top. */
export const STACK_TOP = 3 * GRID;

/** Rounds half away from zero, as Swift's `rounded()` does. */
export function snap(v) {
  const r = Math.round(Math.abs(v) / GRID) * GRID;
  return v < 0 && r ? -r : r;
}

export const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const contains = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
export const containsCentre = (r, b) => contains(r, b.x + b.w / 2, b.y + b.h / 2);
/** Whether the two overlap horizontally, as cards in one column of a lane do. */
export const sharesColumn = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
/** The first grid line at least `ROOM` below `r`. */
export const lineBelow = (r) => Math.ceil((r.y + r.h + ROOM) / GRID) * GRID;
export const cardRect = (c, h) => ({ x: c.x, y: c.y, w: c.w, h });
export const laneRect = (l) => ({ x: l.x, y: l.y, w: l.w, h: l.h });

/** 16 random bytes: ids are made on every device and must not collide. */
export function newID() {
  return encode(crypto.getRandomValues(new Uint8Array(16)));
}

export const card = (b, id) => b.cards.find((c) => c.id === id);
export const lane = (b, id) => b.lanes.find((l) => l.id === id);

export function addCard(b, x, y) {
  const c = { id: newID(), x: snap(x), y: snap(y), w: CARD_W, text: "", color: 1 };
  b.cards.push(c);
  return c.id;
}

export function addLane(b, x, y) {
  const l = { id: newID(), x: snap(x), y: snap(y), w: LANE_W, h: LANE_H, title: "Lane" };
  b.lanes.push(l);
  return l.id;
}

export function setText(b, id, text) {
  const c = card(b, id);
  if (c) c.text = text;
}

export function setNotes(b, id, notes) {
  const c = card(b, id);
  if (c) c.notes = notes;
}

export function setLaneTitle(b, id, title) {
  const l = lane(b, id);
  if (l) l.title = title;
}

/** Ends editing card `id`: trailing whitespace goes, and a card blank on both sides is removed. */
export function finishEdit(b, id) {
  const i = b.cards.findIndex((c) => c.id === id);
  if (i < 0) return;
  const c = b.cards[i];
  c.text = c.text.trimEnd();
  const notes = (c.notes ?? "").trimEnd();
  if (notes) c.notes = notes;
  else delete c.notes;
  if (!c.text && !notes) b.cards.splice(i, 1);
}

/** With `room` the cards are held in a drag and the others make room for them; see `settle`. */
export function moveCards(b, origins, dx, dy, room) {
  for (const o of origins) {
    const c = card(b, o.id);
    if (!c) continue;
    c.x = snap(o.x + dx);
    c.y = snap(o.y + dy);
  }
  if (room) settle(b, room.heightOf, { held: new Set(origins.map((o) => o.id)), base: room.base });
}

export function setColor(b, ids, color) {
  for (const c of b.cards) if (ids.has(c.id)) c.color = color;
}

export function remove(b, ids) {
  b.cards = b.cards.filter((c) => !ids.has(c.id));
  b.lanes = b.lanes.filter((l) => !ids.has(l.id));
}

/** Moves lane `origin.id` by the snapped delta and carries `carried` with it. */
export function moveLane(b, origin, carried, dx, dy) {
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

export function resizeLane(b, id, w, h) {
  const l = lane(b, id);
  if (!l) return;
  l.w = Math.max(LANE_MIN, snap(w));
  l.h = Math.max(LANE_MIN, snap(h));
}

export function cardsInLane(b, id, heightOf) {
  const l = lane(b, id);
  return l ? b.cards.filter((c) => containsCentre(l, cardRect(c, heightOf(c.id)))) : [];
}

export const cardsInRect = (b, r, heightOf) => b.cards.filter((c) => intersects(r, cardRect(c, heightOf(c.id))));

/** Card `id` and the cards below it in its lane's column; outside a lane, the card alone. */
export function pile(b, id, heightOf) {
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
export function layout(b, excluding) {
  return {
    cardY: new Map(b.cards.filter((c) => !excluding.has(c.id)).map((c) => [c.id, c.y])),
    laneH: new Map(b.lanes.map((l) => [l.id, l.h])),
  };
}

/** Ends a drag: the held cards drop into the places kept for them. */
export const land = (b, ids, room) => settle(b, room.heightOf, { held: ids, base: room.base, land: true });

export const gravity = (b, heightOf) => settle(b, heightOf);

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Floats the cards in each lane up their columns in order of their centres; lanes grow to fit.
 * Cards `held` in a drag stay where they are but are ordered as a block by their top card and
 * keep their places free; `land` moves them in. With `base` the others start from where they
 * stood when the drag began, so dragging away gives cards back their places.
 */
export function settle(b, heightOf, { held = new Set(), base = null, land = false } = {}) {
  if (base) {
    for (const c of b.cards) if (base.cardY.has(c.id)) c.y = base.cardY.get(c.id);
    for (const l of b.lanes) if (base.laneH.has(l.id)) l.h = base.laneH.get(l.id);
  }
  const boxes = b.cards.map((c, index) => ({ index, rect: cardRect(c, heightOf(c.id)), held: held.has(c.id) }));
  const done = new Set();
  for (const l of b.lanes) {
    const members = boxes.filter((x) => !done.has(x.index) && containsCentre(l, x.rect));
    for (const x of members) done.add(x.index);
    const top = members.filter((x) => x.held).reduce((t, x) => (!t || x.rect.y < t.rect.y ? x : t), null);
    const key = (x) =>
      x.held ? [top.rect.y + top.rect.h / 2, 0, x.rect.y, x.index] : [x.rect.y + x.rect.h / 2, 1, x.rect.y, x.index];
    members.sort((p, q) => compare(key(p), key(q)));
    const placed = [];
    for (const x of members) {
      let y = l.y + STACK_TOP;
      for (const p of placed) if (sharesColumn(p, x.rect)) y = Math.max(y, lineBelow(p));
      const r = { ...x.rect, y };
      placed.push(r);
      if (!x.held || land) b.cards[x.index].y = y;
      l.h = Math.max(l.h, lineBelow(r) - l.y);
    }
  }
}

/** Lane titles, card fronts and card backs containing `query`, in reading order. */
export function search(b, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const items = [
    ...b.lanes.map((l) => ({ x: l.x, y: l.y, parts: [{ id: l.id, side: "title", text: l.title }] })),
    ...b.cards.map((c) => ({
      x: c.x,
      y: c.y,
      parts: [{ id: c.id, side: "front", text: c.text }, ...(c.notes ? [{ id: c.id, side: "back", text: c.notes }] : [])],
    })),
  ];
  items.sort((p, q2) => p.y - q2.y || p.x - q2.x);
  return items
    .flatMap((i) => i.parts)
    .filter((p) => p.text.toLowerCase().includes(q))
    .map(({ id, side }) => ({ id, side }));
}
