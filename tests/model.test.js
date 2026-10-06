const test = require("node:test");
const assert = require("node:assert/strict");
const { GRID, CARD_W, snap, zoomAt, Board } = require("../app/model.js");

const board = (cards = [], lanes = []) => new Board({ rev: 0, view: { x: 0, y: 0, zoom: 1 }, cards, lanes });
const card = (id, x, y, text = "t") => ({ id, x, y, w: CARD_W, text, color: 1 });
const lane = (id, x, y, w = 480, h = 720) => ({ id, x, y, w, h, title: "Lane" });
const h48 = () => 48;

test("snap rounds to the nearest grid line", () => {
  assert.equal(GRID, 24);
  assert.equal(snap(35), 24);
  assert.equal(snap(37), 48);
  assert.equal(snap(-37), -48);
});

test("addCard snaps and starts empty", () => {
  const b = board();
  const c = b.addCard(40, 56);
  assert.deepEqual({ x: c.x, y: c.y, w: c.w, text: c.text, color: c.color }, { x: 48, y: 48, w: 240, text: "", color: 1 });
  assert.equal(b.data.cards.length, 1);
});

test("a new card left blank disappears without an undo step", () => {
  const b = board();
  const c = b.addCard(0, 0);
  b.setText(c.id, "  \n ");
  b.finishEdit(c.id);
  assert.equal(b.data.cards.length, 0);
  assert.equal(b.undoStack.length, 0);
});

test("finishEdit trims trailing whitespace and the new card undoes in one step", () => {
  const b = board();
  const c = b.addCard(0, 0);
  b.setText(c.id, "Idea\nmore\n\n");
  b.finishEdit(c.id);
  assert.equal(b.card(c.id).text, "Idea\nmore");
  b.undo();
  assert.equal(b.data.cards.length, 0);
});

test("editing an existing card without changes leaves no undo step", () => {
  const b = board([card("a", 0, 0, "x")]);
  b.checkpoint();
  b.finishEdit("a");
  assert.equal(b.undoStack.length, 0);
});

test("a no-op gesture keeps redo available", () => {
  const b = board([card("a", 0, 0)]);
  b.setColor(["a"], 3);
  b.undo();
  b.checkpoint();
  b.dropNoopCheckpoint();
  b.redo();
  assert.equal(b.card("a").color, 3);
});

test("finishEdit trims notes and drops blank ones", () => {
  const b = board([card("a", 0, 0), card("b", 0, 0)]);
  b.setNotes("a", "As a user\n\n");
  b.setNotes("b", " \n");
  b.finishEdit("a");
  b.finishEdit("b");
  assert.equal(b.card("a").notes, "As a user");
  assert.equal("notes" in b.card("b"), false);
});

test("a card with only notes is kept, one blank on both sides is removed", () => {
  const b = board([card("a", 0, 0, ""), card("b", 0, 0, "")]);
  b.setNotes("a", "details");
  b.finishEdit("a");
  b.finishEdit("b");
  assert.deepEqual(b.data.cards.map((c) => c.id), ["a"]);
});

test("editing notes undoes in one step", () => {
  const b = board([card("a", 0, 0)]);
  b.checkpoint();
  b.setNotes("a", "x");
  b.setNotes("a", "xy");
  b.finishEdit("a");
  b.undo();
  assert.equal("notes" in b.card("a"), false);
});

test("moveCards snaps relative to the drag origins", () => {
  const b = board([card("a", 0, 0), card("b", 48, 24)]);
  b.moveCards([{ id: "a", x: 0, y: 0 }, { id: "b", x: 48, y: 24 }], 32, 10);
  assert.deepEqual([b.card("a").x, b.card("a").y, b.card("b").x, b.card("b").y], [24, 0, 72, 24]);
});

const drag = (b, ids) => {
  const origins = ids.map((id) => ({ id, x: b.card(id).x, y: b.card(id).y }));
  const room = { base: b.layout(ids), heightOf: h48 };
  return { to: (dx, dy) => b.moveCards(origins, dx, dy, room), land: () => b.land(ids, room) };
};
const ys = (b, ...ids) => ids.map((id) => b.card(id).y);
const stackBoard = (h = 480) => board([card("a", 24, 72), card("b", 24, 144), card("d", 600, 72)], [lane("l", 0, 0, 480, h)]);

test("a card held over a stack keeps a place free by its centre, and lands there", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  d.to(-576, 48);
  assert.deepEqual(ys(b, "a", "d", "b"), [72, 120, 216]);
  d.land();
  assert.deepEqual(ys(b, "a", "d", "b"), [72, 144, 216]);
});

test("dragging away gives cards back their places", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  d.to(-576, 0);
  assert.deepEqual(ys(b, "a", "b"), [144, 216]);
  d.to(0, 0);
  assert.deepEqual(ys(b, "a", "b"), [72, 144]);
});

test("taking a card out of a stack closes the gap", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216)], [lane("l", 0, 0)]);
  drag(b, ["b"]).to(576, 0);
  assert.deepEqual(ys(b, "a", "c"), [72, 144]);
});

test("held cards are ordered as a block by their top card", () => {
  const b = board([card("a", 24, 72), card("p", 600, 72), card("q", 600, 144)], [lane("l", 0, 0)]);
  const d = drag(b, ["p", "q"]);
  d.to(-576, 0);
  d.land();
  assert.deepEqual(ys(b, "p", "q", "a"), [72, 144, 216]);
});

test("gravity floats lane cards up their own column and leaves the canvas alone", () => {
  const b = board(
    [card("a", 24, 72), card("b", 24, 360), card("side", 288, 240), card("free", 720, 360)],
    [lane("l", 0, 0, 576, 480)],
  );
  b.gravity(h48);
  assert.deepEqual(ys(b, "a", "b", "side", "free"), [72, 144, 72, 360]);
});

test("a lane grows to fit its stack and shrinks back", () => {
  const b = stackBoard(240);
  const d = drag(b, ["d"]);
  d.to(-576, 0);
  assert.equal(b.lane("l").h, 288);
  d.to(0, 0);
  assert.equal(b.lane("l").h, 240);
});

test("pile takes a lane card and those below it in its column", () => {
  const b = board(
    [card("a", 24, 72), card("b", 24, 144), card("side", 288, 144), card("c", 24, 240), card("free", 24, 840)],
    [lane("l", 0, 0, 576, 480)],
  );
  assert.deepEqual(b.pile("b", h48), ["b", "c"]);
  assert.deepEqual(b.pile("free", h48), ["free"]);
});

test("setColor changes cards only and skips empty selections", () => {
  const b = board([card("a", 0, 0)], [lane("l", 0, 0)]);
  b.setColor(["l"], 2);
  assert.equal(b.undoStack.length, 0);
  b.setColor(["a", "l"], 4);
  assert.equal(b.card("a").color, 4);
  assert.equal(b.lane("l").color, undefined);
});

test("remove deletes a lane but not the cards on it", () => {
  const b = board([card("a", 24, 72)], [lane("l", 0, 0)]);
  b.remove(["l"]);
  assert.deepEqual(b.data.lanes, []);
  assert.equal(b.data.cards.length, 1);
  b.remove(["a"]);
  assert.deepEqual(b.data.cards, []);
});

test("cardsInLane counts cards whose centre is inside", () => {
  const b = board([card("in", 360, 0), card("out", 384, 0)], [lane("l", 0, 0, 480, 720)]);
  assert.deepEqual(b.cardsInLane("l", h48).map((c) => c.id), ["in"]);
});

test("moveLane carries its cards by the snapped delta", () => {
  const b = board([card("a", 24, 72)], [lane("l", 0, 0)]);
  b.moveLane({ id: "l", x: 0, y: 0 }, [{ id: "a", x: 24, y: 72 }], 61, -14);
  assert.deepEqual([b.lane("l").x, b.lane("l").y], [72, -24]);
  assert.deepEqual([b.card("a").x, b.card("a").y], [96, 48]);
});

test("resizeLane snaps and keeps a minimum size", () => {
  const b = board([], [lane("l", 0, 0)]);
  b.resizeLane("l", 520, 10);
  assert.deepEqual([b.lane("l").w, b.lane("l").h], [528, 96]);
});

test("cardsInRect finds overlapping cards", () => {
  const b = board([card("a", 0, 0), card("b", 480, 480)]);
  assert.deepEqual(b.cardsInRect({ x: 228, y: 36, w: 60, h: 60 }, h48).map((c) => c.id), ["a"]);
});

test("undo and redo restore cards and lanes", () => {
  const b = board();
  b.addLane(0, 0);
  const c = b.addCard(0, 0);
  b.undo();
  assert.equal(b.card(c.id), undefined);
  b.undo();
  assert.deepEqual(b.data.lanes, []);
  b.redo();
  b.redo();
  assert.equal(b.data.lanes.length, 1);
  assert.ok(b.card(c.id));
});

test("undo history is capped at 100 steps", () => {
  const b = board([card("a", 0, 0)]);
  for (let i = 0; i < 120; i++) b.setColor(["a"], (i % 5) + 1);
  assert.equal(b.undoStack.length, 100);
});

test("zoomAt keeps the point under the cursor fixed and clamps", () => {
  const v = zoomAt({ x: 10, y: 20, zoom: 1 }, 110, 220, 2);
  assert.deepEqual(v, { x: -90, y: -180, zoom: 2 });
  assert.equal(zoomAt(v, 0, 0, 10).zoom, 2);
  assert.equal(zoomAt(v, 0, 0, 0.01).zoom, 0.25);
});

test("changes notify the listener", () => {
  let calls = 0;
  const b = new Board({ rev: 0, view: { x: 0, y: 0, zoom: 1 }, cards: [], lanes: [] }, () => calls++);
  b.addCard(0, 0);
  assert.equal(calls, 1);
});
