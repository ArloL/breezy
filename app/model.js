const GRID = 20;
const CARD_W = 200;
const LANE_W = 400;
const LANE_H = 600;
const LANE_MIN = 100;
const UNDO_LIMIT = 100;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;

function snap(v) {
  return Math.round(v / GRID) * GRID;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Zooms so that the screen point (sx, sy) stays over the same world point.
function zoomAt(view, sx, sy, factor) {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
  const wx = (sx - view.x) / view.zoom;
  const wy = (sy - view.y) / view.zoom;
  return { x: sx - wx * zoom, y: sy - wy * zoom, zoom };
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

class Board {
  constructor(data, onChange = () => {}) {
    this.data = data;
    this.onChange = onChange;
    this.undoStack = [];
    this.redoStack = [];
    this.redoBeforeGesture = [];
  }

  changed() {
    this.onChange();
  }

  card(id) {
    return this.data.cards.find((c) => c.id === id);
  }

  lane(id) {
    return this.data.lanes.find((l) => l.id === id);
  }

  snapshot() {
    return JSON.stringify([this.data.cards, this.data.lanes]);
  }

  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoBeforeGesture = this.redoStack;
    this.redoStack = [];
  }

  dropNoopCheckpoint() {
    if (this.undoStack.at(-1) !== this.snapshot()) return;
    this.undoStack.pop();
    this.redoStack = this.redoBeforeGesture;
  }

  undo() {
    this.step(this.undoStack, this.redoStack);
  }

  redo() {
    this.step(this.redoStack, this.undoStack);
  }

  step(from, to) {
    if (!from.length) return;
    to.push(this.snapshot());
    [this.data.cards, this.data.lanes] = JSON.parse(from.pop());
    this.changed();
  }

  addCard(x, y) {
    this.checkpoint();
    const card = { id: newId("c"), x: snap(x), y: snap(y), w: CARD_W, text: "", color: 1 };
    this.data.cards.push(card);
    this.changed();
    return card;
  }

  setText(id, text) {
    this.card(id).text = text;
    this.changed();
  }

  setLaneTitle(id, title) {
    this.lane(id).title = title;
    this.changed();
  }

  // Ends editing a card or lane title. A blank card is removed.
  finishEdit(id) {
    const card = this.card(id);
    if (card) {
      card.text = card.text.trimEnd();
      if (!card.text) this.data.cards = this.data.cards.filter((c) => c !== card);
    }
    this.dropNoopCheckpoint();
    this.changed();
  }

  moveCards(origins, dx, dy) {
    for (const o of origins) {
      const c = this.card(o.id);
      if (!c) continue;
      c.x = snap(o.x + dx);
      c.y = snap(o.y + dy);
    }
    this.changed();
  }

  setColor(ids, color) {
    const cards = this.data.cards.filter((c) => ids.includes(c.id));
    if (!cards.length) return;
    this.checkpoint();
    for (const c of cards) c.color = color;
    this.changed();
  }

  remove(ids) {
    const keep = (x) => !ids.includes(x.id);
    if (this.data.cards.every(keep) && this.data.lanes.every(keep)) return;
    this.checkpoint();
    this.data.cards = this.data.cards.filter(keep);
    this.data.lanes = this.data.lanes.filter(keep);
    this.changed();
  }

  addLane(x, y) {
    this.checkpoint();
    const lane = { id: newId("l"), x: snap(x), y: snap(y), w: LANE_W, h: LANE_H, title: "Lane" };
    this.data.lanes.push(lane);
    this.changed();
    return lane;
  }

  moveLane(origin, cardOrigins, dx, dy) {
    const lane = this.lane(origin.id);
    lane.x = snap(origin.x + dx);
    lane.y = snap(origin.y + dy);
    const ddx = lane.x - origin.x;
    const ddy = lane.y - origin.y;
    for (const o of cardOrigins) {
      const c = this.card(o.id);
      if (!c) continue;
      c.x = o.x + ddx;
      c.y = o.y + ddy;
    }
    this.changed();
  }

  resizeLane(id, w, h) {
    const lane = this.lane(id);
    lane.w = Math.max(LANE_MIN, snap(w));
    lane.h = Math.max(LANE_MIN, snap(h));
    this.changed();
  }

  cardsInLane(id, heightOf) {
    const l = this.lane(id);
    return this.data.cards.filter((c) => {
      const cx = c.x + c.w / 2;
      const cy = c.y + heightOf(c.id) / 2;
      return cx >= l.x && cx <= l.x + l.w && cy >= l.y && cy <= l.y + l.h;
    });
  }

  cardsInRect(rect, heightOf) {
    return this.data.cards.filter((c) => intersects(rect, { x: c.x, y: c.y, w: c.w, h: heightOf(c.id) }));
  }
}

if (typeof module !== "undefined") module.exports = { GRID, CARD_W, LANE_W, LANE_H, snap, zoomAt, Board };
