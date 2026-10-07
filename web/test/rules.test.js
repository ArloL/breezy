import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../rules.js";

const board = (cards = [], lanes = []) => ({ cards, lanes });
const card = (id, x, y, text = "t") => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id, x, y, w = 480, h = 720) => ({ id, x, y, w, h, title: "Lane" });
const h48 = () => 48;
const ys = (b, ...ids) => ids.map((id) => R.card(b, id).y);

function drag(b, ids) {
  return {
    origins: ids.map((id) => ({ id, x: R.card(b, id).x, y: R.card(b, id).y })),
    room: { base: R.layout(b, new Set(ids)), heightOf: h48 },
  };
}

const stackBoard = (h = 480) => board([card("a", 24, 72), card("b", 24, 144), card("d", 600, 72)], [lane("l", 0, 0, 480, h)]);

test("snap rounds to the nearest grid line, halves away from zero", () => {
  assert.deepEqual([35, 37, -37, 36, -36, -5].map(R.snap), [24, 48, -48, 48, -48, 0]);
});

test("addCard snaps and starts empty", () => {
  const b = board();
  const c = R.card(b, R.addCard(b, 40, 56));
  assert.deepEqual([c.x, c.y, c.w, c.text, c.notes, c.color], [48, 48, 240, "", undefined, 1]);
});

test("moveCards snaps relative to the drag origins", () => {
  const b = board([card("a", 0, 0), card("b", 48, 24)]);
  R.moveCards(b, [{ id: "a", x: 0, y: 0 }, { id: "b", x: 48, y: 24 }], 32, 10);
  assert.deepEqual([R.card(b, "a").x, R.card(b, "a").y, R.card(b, "b").x, R.card(b, "b").y], [24, 0, 72, 24]);
});

test("finishEdit trims trailing whitespace", () => {
  const b = board([card("a", 0, 0, "Idea\nmore\n\n")]);
  R.finishEdit(b, "a");
  assert.equal(R.card(b, "a").text, "Idea\nmore");
});

test("finishEdit trims notes and drops blank ones", () => {
  const b = board([card("a", 0, 0), card("b", 0, 0)]);
  R.setNotes(b, "a", "As a user\n\n");
  R.setNotes(b, "b", " \n");
  R.finishEdit(b, "a");
  R.finishEdit(b, "b");
  assert.equal(R.card(b, "a").notes, "As a user");
  assert.equal("notes" in R.card(b, "b"), false);
});

test("a card with only notes is kept; one blank on both sides is removed", () => {
  const b = board([card("a", 0, 0, ""), card("b", 0, 0, "")]);
  R.setNotes(b, "a", "details");
  R.finishEdit(b, "a");
  R.finishEdit(b, "b");
  assert.deepEqual(b.cards.map((c) => c.id), ["a"]);
});

test("setColor changes cards only", () => {
  const b = board([card("a", 0, 0)], [lane("l", 0, 0)]);
  R.setColor(b, new Set(["a", "l"]), 4);
  assert.equal(R.card(b, "a").color, 4);
  assert.equal("color" in R.lane(b, "l"), false);
});

test("remove deletes a lane but not the cards on it", () => {
  const b = board([card("a", 24, 72)], [lane("l", 0, 0)]);
  R.remove(b, new Set(["l"]));
  assert.deepEqual([b.lanes.length, b.cards.length], [0, 1]);
  R.remove(b, new Set(["a"]));
  assert.equal(b.cards.length, 0);
});

test("cardsInLane counts cards whose centre is inside", () => {
  const b = board([card("in", 360, 0), card("out", 384, 0)], [lane("l", 0, 0, 480, 720)]);
  assert.deepEqual(R.cardsInLane(b, "l", h48).map((c) => c.id), ["in"]);
});

test("moveLane carries its cards by the snapped delta", () => {
  const b = board([card("a", 24, 72)], [lane("l", 0, 0)]);
  R.moveLane(b, { id: "l", x: 0, y: 0 }, [{ id: "a", x: 24, y: 72 }], 61, -14);
  assert.deepEqual([R.lane(b, "l").x, R.lane(b, "l").y, R.card(b, "a").x, R.card(b, "a").y], [72, -24, 96, 48]);
});

test("resizeLane snaps and keeps a minimum size", () => {
  const b = board([], [lane("l", 0, 0)]);
  R.resizeLane(b, "l", 520, 10);
  assert.deepEqual([R.lane(b, "l").w, R.lane(b, "l").h], [528, 96]);
});

test("cardsInRect finds overlapping cards", () => {
  const b = board([card("a", 0, 0), card("b", 480, 480)]);
  assert.deepEqual(R.cardsInRect(b, { x: 228, y: 36, w: 60, h: 60 }, h48).map((c) => c.id), ["a"]);
});

test("a held card keeps a place free by its centre and lands there", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -576, 48, d.room);
  assert.deepEqual(ys(b, "a", "d", "b"), [72, 120, 216]);
  R.land(b, new Set(["d"]), d.room);
  assert.deepEqual(ys(b, "a", "d", "b"), [72, 144, 216]);
});

test("dragging away gives cards back their places", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -576, 0, d.room);
  assert.deepEqual(ys(b, "a", "b"), [144, 216]);
  R.moveCards(b, d.origins, 0, 0, d.room);
  assert.deepEqual(ys(b, "a", "b"), [72, 144]);
});

test("taking a card out of a stack closes the gap", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216)], [lane("l", 0, 0)]);
  const d = drag(b, ["b"]);
  R.moveCards(b, d.origins, 576, 0, d.room);
  assert.deepEqual(ys(b, "a", "c"), [72, 144]);
});

test("held cards are ordered as a block by their top card", () => {
  const b = board([card("a", 24, 72), card("p", 600, 72), card("q", 600, 144)], [lane("l", 0, 0)]);
  const d = drag(b, ["p", "q"]);
  R.moveCards(b, d.origins, -576, 0, d.room);
  R.land(b, new Set(["p", "q"]), d.room);
  assert.deepEqual(ys(b, "p", "q", "a"), [72, 144, 216]);
});

test("gravity floats lane cards up their own column and leaves the canvas alone", () => {
  const b = board(
    [card("a", 24, 72), card("b", 24, 360), card("side", 288, 240), card("free", 720, 360)],
    [lane("l", 0, 0, 576, 480)],
  );
  R.gravity(b, h48);
  assert.deepEqual(ys(b, "a", "b", "side", "free"), [72, 144, 72, 360]);
});

test("a lane grows to fit its stack and shrinks back", () => {
  const b = stackBoard(240);
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -576, 0, d.room);
  assert.equal(R.lane(b, "l").h, 288);
  R.moveCards(b, d.origins, 0, 0, d.room);
  assert.equal(R.lane(b, "l").h, 240);
});

test("pile takes a lane card and those below it in its column", () => {
  const b = board(
    [card("a", 24, 72), card("b", 24, 144), card("side", 288, 144), card("c", 24, 240), card("free", 24, 840)],
    [lane("l", 0, 0, 576, 480)],
  );
  assert.deepEqual(R.pile(b, "b", h48), ["b", "c"]);
  assert.deepEqual(R.pile(b, "free", h48), ["free"]);
  assert.equal(R.laneOf(b, "free", h48), undefined);
  assert.equal(R.laneOf(b, "b", h48).id, "l");
});

test("search finds fronts, backs and lane titles in reading order, ignoring case", () => {
  const b = board(
    [card("a", 24, 72, "Plan doing"), { ...card("b", 24, 144, "x"), notes: "doing more" }, card("c", 600, 0, "Doing it")],
    [{ ...lane("l", 0, 0), title: "Doing" }],
  );
  assert.deepEqual(R.search(b, "DOING"), [
    { id: "l", side: "title" },
    { id: "c", side: "front" },
    { id: "a", side: "front" },
    { id: "b", side: "back" },
  ]);
  assert.deepEqual(R.search(b, "  "), []);
});
