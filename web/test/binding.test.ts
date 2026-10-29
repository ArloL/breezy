import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../sync/store.ts";
import { Model } from "../model.ts";
import { Binding } from "../binding.ts";
import { cardRecord } from "../sync/records.ts";
import { settle } from "./helpers/store.ts";
import type { Board, Card } from "../types.ts";

const card = (id: string, y: number, text = "x"): Card => ({ id, x: 0, y, w: 240, text, color: 1 });

function opened(cards: Card[]) {
  const store = new Store();
  const id = store.createBoard("B", { cards, lanes: [] });
  settle(store);
  const model = new Model(store.board(id));
  const binding = new Binding(store, model, id, () => {});
  model.onChange = () => binding.changed();
  return { store, id, model, binding };
}

test("a merge during a gesture waits and keeps the typed text", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  model.begin();
  model.update((b) => (b.cards[0].text = "typed"));
  store.merge([{ id: "n", version: 2, record: cardRecord(card("n", 96, "new"), id, "z") }]);
  binding.pull();
  assert.equal(model.board.cards.length, 1);
  model.end("Edit Card");
  assert.deepEqual(model.board.cards.map((c) => c.text), ["typed", "new"]);
  assert.equal(store.board(id).cards[0].text, "typed");
  model.undo();
  assert.deepEqual(model.board.cards.map((c) => c.text), ["x", "new"]);
});

test("restacking a merge is shown but not written", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  binding.restack = (b: Board) => b.cards.forEach((c) => (c.y += 24));
  store.merge([{ id: "a", version: 2, record: { ...store.state.records.a.current, color: 3 } }]);
  binding.pull();
  assert.equal(model.board.cards[0].y, 24);
  assert.equal(model.board.cards[0].color, 3);
  binding.flush();
  assert.equal(store.board(id).cards[0].y, 0);
  assert.deepEqual(store.pending(), []);
});

test("local edits reach the store field by field", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  store.merge([{ id: "a", version: 2, record: { ...store.state.records.a.current, text: "theirs" } }]);
  model.perform("Colour", (b) => (b.cards[0].color = 3));
  binding.flush();
  assert.equal(store.board(id).cards[0].text, "theirs");
  assert.equal(store.board(id).cards[0].color, 3);
});

test("changes to items others hold are not written", () => {
  const { store, id, model, binding } = opened([card("a", 0), card("b", 96)]);
  binding.taken = () => new Set(["b"]);
  model.perform("Move", (b) => {
    b.cards[0].x = 48;
    b.cards[1].x = 480;
  });
  binding.flush();
  assert.equal(store.board(id).cards.find((c) => c.id === "a")!.x, 48);
  assert.equal(store.board(id).cards.find((c) => c.id === "b")!.x, 0);
});

test("undoing a delete brings the card back to the store, to be pushed", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  model.perform("Delete", (b) => (b.cards = []));
  binding.flush();
  assert.equal(store.board(id).cards.length, 0);
  // the delete went to the server
  settle(store, 2);
  model.undo();
  binding.flush();
  assert.deepEqual(store.board(id).cards.map((c) => c.text), ["x"]);
  assert.deepEqual(store.pending().map((p) => p.id), ["a"]);
});

test("an edit to a card deleted elsewhere does not bring it back", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  store.merge([{ id: "a", version: 2, record: { format: 1, kind: "card", deleted: true } }]);
  model.perform("Colour", (b) => (b.cards[0].color = 3));
  binding.flush();
  assert.equal(store.board(id).cards.length, 0);
});

test("undoing a delete on a board deleted since brings nothing back", () => {
  const { store, id, model, binding } = opened([card("a", 0)]);
  model.perform("Delete", (b) => (b.cards = []));
  binding.flush();
  store.deleteBoard(id);
  model.undo();
  binding.flush();
  assert.equal(store.state.records.a.current.deleted, true);
});

test("typing is written every 300 ms however fast the keys come, as a page may leave mid-word", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, id, model, binding } = opened([card("a", 0)]);
  binding.typing = () => true;
  model.begin();
  for (let i = 1; i <= 10; i++) {
    model.update((b) => (b.cards[0].text = "x".repeat(i)));
    t.mock.timers.tick(100);
  }
  // after 1 s of a key every 100 ms, what was typed by 900 ms is in the store
  assert.equal(store.board(id).cards[0].text, "x".repeat(9));
});

test("a drag is written 300 ms after it pauses, not while it moves", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { store, id, model } = opened([card("a", 0)]);
  model.begin();
  for (let i = 1; i <= 10; i++) {
    model.update((b) => (b.cards[0].x = i));
    t.mock.timers.tick(100);
  }
  assert.equal(store.board(id).cards[0].x, 0);
  t.mock.timers.tick(200);
  assert.equal(store.board(id).cards[0].x, 10);
});
