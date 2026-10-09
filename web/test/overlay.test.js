import { test } from "node:test";
import assert from "node:assert/strict";
import { liveFields, overlaid, startPositions } from "../sync/overlay.js";

const card = (id, x, y, text = "t") => ({ id, x, y, w: 240, text, color: 1 });
const lane = (id, x, y) => ({ id, x, y, w: 480, h: 720, title: "Lane" });

test("live fields are what a gesture changed of its items", () => {
  const start = { cards: [card("a", 0, 0, "x"), card("b", 0, 96)], lanes: [lane("l", 0, 0)] };
  const now = structuredClone(start);
  Object.assign(now.cards[0], { x: 48, text: "typed" });
  now.cards[1].x = 480;
  now.lanes[0].w = 720;
  now.cards.push(card("n", 24, 24, "new"));
  const f = liveFields(start, now, new Set(["a", "l", "n"]), "B");
  assert.deepEqual(f.a, { pos: [48, 0], text: "typed" });
  assert.equal(f.b, undefined);
  assert.deepEqual(f.l, { size: [720, 720] });
  assert.equal(f.n.kind, "card");
  assert.equal(f.n.text, "new");
  assert.equal(f.n.order, undefined);
});

test("start positions are where the held cards and lanes were when the gesture began", () => {
  const start = { cards: [card("a", 1, 2), card("b", 3, 4)], lanes: [lane("l", 5, 6)] };
  assert.deepEqual(startPositions(start, new Set(["a", "l", "new"])), { a: [1, 2], l: [5, 6] });
  assert.deepEqual(startPositions(null, new Set(["a"])), {});
});

test("an overlay is drawn over the board", () => {
  const b = { cards: [card("a", 0, 0, "x")], lanes: [lane("l", 0, 0)] };
  const shown = overlaid(b, new Map([
    ["a", { pos: [48, 24], text: "typed", notes: "", color: 3 }],
    ["l", { pos: [10, 20], size: [500, 600], title: "Now" }],
    ["n", { kind: "card", pos: [1, 2], w: 240, text: "new", notes: "", color: 1 }],
    ["gone", { pos: [1, 2] }],
  ]));
  assert.deepEqual(shown.cards[0], { id: "a", x: 48, y: 24, w: 240, text: "typed", color: 3 });
  assert.deepEqual(shown.lanes[0], { id: "l", x: 10, y: 20, w: 500, h: 600, title: "Now" });
  assert.equal(shown.cards[1].text, "new");
  assert.equal(shown.cards.length, 2);
  assert.equal(overlaid(b, new Map()), b);
  assert.equal(b.cards[0].x, 0);
});
