import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../rules.ts";
import type { Board, Card, Lane } from "../types.ts";

const board = (cards: Card[] = [], lanes: Lane[] = []): Board => ({ cards, lanes });
const card = (id: string, x: number, y: number, text = "t"): Card => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id: string, x: number, y: number, w = 480, h = 720): Lane => ({ id, x, y, w, h, title: "Lane" });
const h48 = () => 48;
const ys = (b: Board, ...ids: string[]) => ids.map((id) => R.card(b, id)!.y);

function drag(b: Board, ids: string[]) {
  return {
    origins: ids.map((id) => ({ id, x: R.card(b, id)!.x, y: R.card(b, id)!.y })),
    room: { base: R.layout(b, new Set(ids)), heightOf: h48 },
  };
}

const stackBoard = (h = 480) => board([card("a", 24, 72), card("b", 24, 144), card("d", 600, 72)], [lane("l", 0, 0, 480, h)]);

test("snap rounds to the nearest grid line, halves away from zero", () => {
  assert.deepEqual([35, 37, -37, 36, -36, -5].map(R.snap), [24, 48, -48, 48, -48, 0]);
});

test("addCard snaps and starts empty", () => {
  const b = board();
  const c = R.card(b, R.addCard(b, 40, 56))!;
  assert.deepEqual([c.x, c.y, c.w, c.text, c.notes, c.color], [48, 48, 240, "", undefined, 1]);
});

test("moveCards snaps relative to the drag origins", () => {
  const b = board([card("a", 0, 0), card("b", 48, 24)]);
  R.moveCards(b, [{ id: "a", x: 0, y: 0 }, { id: "b", x: 48, y: 24 }], 32, 10);
  assert.deepEqual([R.card(b, "a")!.x, R.card(b, "a")!.y, R.card(b, "b")!.x, R.card(b, "b")!.y], [24, 0, 72, 24]);
});

test("finishEdit trims trailing whitespace", () => {
  const b = board([card("a", 0, 0, "Idea\nmore\n\n")]);
  R.finishEdit(b, "a");
  assert.equal(R.card(b, "a")!.text, "Idea\nmore");
});

test("finishEdit trims notes and drops blank ones", () => {
  const b = board([card("a", 0, 0), card("b", 0, 0)]);
  R.setNotes(b, "a", "As a user\n\n");
  R.setNotes(b, "b", " \n");
  R.finishEdit(b, "a");
  R.finishEdit(b, "b");
  assert.equal(R.card(b, "a")!.notes, "As a user");
  assert.equal("notes" in R.card(b, "b")!, false);
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
  assert.equal(R.card(b, "a")!.color, 4);
  assert.equal("color" in R.lane(b, "l")!, false);
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
  assert.deepEqual([R.lane(b, "l")!.x, R.lane(b, "l")!.y, R.card(b, "a")!.x, R.card(b, "a")!.y], [72, -24, 96, 48]);
});

test("resizeLane snaps and keeps a minimum size", () => {
  const b = board([], [lane("l", 0, 0)]);
  R.resizeLane(b, "l", 520, 10);
  assert.deepEqual([R.lane(b, "l")!.w, R.lane(b, "l")!.h], [528, 96]);
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
  assert.equal(R.lane(b, "l")!.h, 288);
  R.moveCards(b, d.origins, 0, 0, d.room);
  assert.equal(R.lane(b, "l")!.h, 240);
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

test("a pile is the card and the cards below it in its lane's column", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216), card("side", 264, 144)], [lane("l", 0, 0, 480, 720)]);
  assert.deepEqual(R.pile(b, "b", h48), ["b", "c"]);
  assert.deepEqual(R.pile(b, "a", h48), ["a", "b", "c"]);
});

test("outside a lane a card piles alone", () => {
  const b = board([card("a", 1000, 0), card("b", 1000, 72)]);
  assert.deepEqual(R.pile(b, "a", h48), ["a"]);
});

test("a card dropped in a lane lands centred in it", () => {
  const b = stackBoard();
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -528, 0, d.room);
  R.land(b, new Set(["d"]), d.room);
  assert.equal(R.card(b, "d")!.x, 120);
});

test("a card dropped in a wide lane lands centred in the column under it", () => {
  const b = board([card("d", 600, 72)], [lane("l", 0, 0, 576, 480)]);
  const d = drag(b, ["d"]);
  R.moveCards(b, d.origins, -264, 0, d.room);
  R.land(b, new Set(["d"]), d.room);
  assert.equal(R.card(b, "d")!.x, 312);
});

test("openSpot is the nearest place a grid clear of everything", () => {
  const b = board([card("a", 600, 0)], [lane("l", 0, 0, 480, 720)]);
  assert.deepEqual(R.openSpot(b, 288, 720, 120, 0, h48), { x: 504, y: 72 });
  assert.deepEqual(R.openSpot(b, 288, 720, 130, 1000, h48), { x: 120, y: 1008 });
});

const clipOf = (b: Board, ...ids: string[]) => R.clip(b, "B", new Set(ids), h48)!;
const here = (board = "B", x = 0, y = 0) => ({ board, centre: { x, y } });

test("clip takes the selected cards in reading order and leaves lanes out", () => {
  const b = board([card("b", 0, 96), card("a", 0, 0)], [lane("l", 600, 0)]);
  const c = R.clip(b, "B", new Set(["b", "a", "l"]), h48)!;
  assert.deepEqual(c.cards.map((k) => k.id), ["a", "b"]);
  assert.deepEqual(c.cards.map((k) => k.h), [48, 48]);
  assert.equal(R.clip(b, "B", new Set(["l"]), h48), null);
});

test("a copy of a card in a lane pastes right below it, the cards below making room", () => {
  const b = stackBoard();
  const [copy] = R.paste(b, clipOf(b, "a"), here(), h48);
  assert.deepEqual(ys(b, "a", copy, "b"), [72, 144, 216]);
  assert.equal(R.card(b, copy)!.x, 24);
});

test("pasting a lane card twice stacks both copies below it", () => {
  const b = stackBoard();
  const c = clipOf(b, "a");
  const [one] = R.paste(b, c, here(), h48);
  const [two] = R.paste(b, c, here(), h48);
  assert.deepEqual(ys(b, "a", two, one, "b"), [72, 144, 216, 288]);
});

test("after a cut a lane card pastes back where it stood", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216)], [lane("l", 0, 0)]);
  const c = clipOf(b, "b");
  R.remove(b, new Set(["b"]));
  R.gravity(b, h48);
  const [copy] = R.paste(b, c, here(), h48);
  assert.deepEqual(ys(b, "a", copy, "c"), [72, 144, 216]);
});

const clear = (b: Board, ids: string[], others: string[]) => {
  const g = R.GRID;
  for (const id of ids) {
    const c = R.card(b, id)!;
    const r = { x: c.x - g, y: c.y - g, w: c.w + 2 * g, h: 48 + 2 * g };
    for (const o of others) assert.equal(R.intersects(r, R.cardRect(R.card(b, o)!, 48)), false);
  }
};

test("free cards paste as a block to the nearest clear space", () => {
  const b = board([card("a", 600, 0), card("b", 912, 0)]);
  const copies = R.paste(b, clipOf(b, "a", "b"), here(), h48);
  const [p, q] = copies.map((id) => R.card(b, id)!);
  assert.equal(q.x - p.x, 312);
  assert.equal(q.y, p.y);
  clear(b, copies, ["a", "b"]);
});

test("on another board the block pastes nearest the view's centre", () => {
  const b = board();
  const c = clipOf(board([card("a", 0, 0)]), "a");
  const [copy] = R.paste(b, c, here("other", 1000, 1000), h48);
  const k = R.card(b, copy)!;
  assert.ok(Math.abs(k.x + 120 - 1000) <= R.GRID && Math.abs(k.y + 24 - 1000) <= R.GRID);
});

test("a lane original moved to another lane or deleted pastes without throwing", () => {
  const b = board([card("a", 24, 72), card("z", 600, 72)], [lane("l", 0, 0), lane("m", 576, 0)]);
  const c = clipOf(b, "a");
  R.moveCards(b, [{ id: "a", x: 24, y: 72 }], 576, 24);
  R.gravity(b, h48);
  const [one] = R.paste(b, c, here(), h48);
  assert.ok(R.card(b, one)!.x >= 576 && R.card(b, one)!.y > R.card(b, "a")!.y);
  R.remove(b, new Set(["a", "l"]));
  const [two] = R.paste(b, c, here(), h48);
  clear(b, [two], ["z", one]);
});

test("adjacent cut lane cards paste back in order", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216), card("d", 24, 288)], [lane("l", 0, 0)]);
  const c = clipOf(b, "b", "c");
  R.remove(b, new Set(["b", "c"]));
  R.gravity(b, h48);
  const [x, y] = R.paste(b, c, here(), h48);
  assert.deepEqual(ys(b, "a", x, y, "d"), [72, 144, 216, 288]);
});

const cutAndPaste = (b: Board, cut: string[], heightOf: (id: string) => number = h48) => {
  const c = R.clip(b, "B", new Set(cut), heightOf)!;
  R.remove(b, new Set(cut));
  R.gravity(b, heightOf);
  return R.paste(b, c, here(), heightOf);
};

test("a cut run of mixed heights pastes back in order", () => {
  const b = board([card("a", 24, 72), card("b", 24, 144, "tall"), card("c", 24, 264), card("d", 24, 336)], [lane("l", 0, 0)]);
  const [x, y] = cutAndPaste(b, ["b", "c"], (id) => (R.card(b, id)?.text === "tall" ? 96 : 48));
  assert.deepEqual(ys(b, "a", x, y, "d"), [72, 144, 264, 336]);
});

test("cut lane cards with one between paste back either side of it", () => {
  const abcd = () => board([card("a", 24, 72), card("b", 24, 144), card("c", 24, 216), card("d", 24, 288)], [lane("l", 0, 0)]);
  let b = abcd();
  let [x, y] = cutAndPaste(b, ["b", "d"]);
  assert.deepEqual(ys(b, "a", x, "c", y), [72, 144, 216, 288]);
  b = abcd();
  [x, y] = cutAndPaste(b, ["a", "c"]);
  assert.deepEqual(ys(b, x, "b", y, "d"), [72, 144, 216, 288]);
});

test("a copy of an original that grew taller lands below it", () => {
  const b = stackBoard();
  const c = clipOf(b, "a");
  const h = (id: string) => (R.card(b, id)?.text === "tall" ? 96 : 48);
  R.setText(b, "a", "tall");
  R.gravity(b, h);
  const [copy] = R.paste(b, c, here(), h);
  assert.deepEqual(ys(b, "a", copy, "b"), [72, 192, 264]);
});
