import { test } from "node:test";
import assert from "node:assert/strict";
import { rebase } from "../rebase.js";

const card = (id, extra = {}) => ({ id, x: 0, y: 0, w: 240, text: "t", color: 1, ...extra });
const board = (cards, lanes = []) => ({ cards, lanes });

test("rebase takes my changes onto theirs", () => {
  const r = rebase(board([card("a")]), board([card("a", { color: 3 })]), board([card("a", { text: "y" })]));
  assert.deepEqual(r.cards, [card("a", { color: 3, text: "y" })]);
});

test("rebase lets theirs win a field both changed", () => {
  assert.equal(rebase(board([card("a")]), board([card("a", { color: 3 })]), board([card("a", { color: 4 })])).cards[0].color, 4);
});

test("rebase removes what I removed unless they changed it", () => {
  const base = board([card("a"), card("b")], [{ id: "l", x: 0, y: 0, w: 480, h: 720, title: "L" }]);
  const theirs = board([card("a"), card("b", { text: "kept" })], base.lanes);
  const r = rebase(base, board([]), theirs);
  assert.deepEqual(r.cards.map((c) => c.id), ["b"]);
  assert.deepEqual(r.lanes, []);
});

test("rebase keeps what they added and the order I chose", () => {
  const r = rebase(board([card("a"), card("b")]), board([card("b"), card("a")]), board([card("a"), card("b"), card("c")]));
  assert.deepEqual(r.cards.map((c) => c.id), ["b", "a", "c"]);
});

test("rebase brings back notes I took off", () => {
  const r = rebase(board([card("a", { notes: "n" })]), board([card("a")]), board([card("a", { notes: "n" })]));
  assert.equal("notes" in r.cards[0], false);
});
