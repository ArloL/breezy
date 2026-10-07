import { test } from "node:test";
import assert from "node:assert/strict";
import { Model, UNDO_LIMIT } from "../model.js";

const fresh = () => new Model({ cards: [{ id: "a", x: 0, y: 0, w: 240, text: "t", color: 1 }], lanes: [] });
const x = (m) => m.board.cards[0].x;

test("perform records one step that undo and redo replay", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.undo();
  assert.equal(x(m), 0);
  m.redo();
  assert.equal(x(m), 24);
});

test("a change that changes nothing records nothing", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 0));
  assert.equal(m.canUndo, false);
});

test("a gesture is one step however many updates it has", () => {
  const m = fresh();
  m.begin();
  for (const v of [24, 48, 72]) m.update((b) => (b.cards[0].x = v));
  m.end("Move");
  m.undo();
  assert.equal(x(m), 0);
  assert.equal(m.canUndo, false);
});

test("a gesture that ends where it began records nothing", () => {
  const m = fresh();
  m.begin();
  m.update((b) => (b.cards[0].x = 24));
  m.update((b) => (b.cards[0].x = 0));
  m.end("Move");
  assert.equal(m.canUndo, false);
});

test("undo waits while a gesture is in progress", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.begin();
  m.update((b) => (b.cards[0].x = 48));
  m.undo();
  assert.equal(x(m), 48);
  m.end("Move");
  m.undo();
  assert.equal(x(m), 24);
});

test("history keeps the last 100 steps", () => {
  const m = fresh();
  for (let i = 1; i <= UNDO_LIMIT + 1; i++) m.perform("Move", (b) => (b.cards[0].x = i * 24));
  for (let i = 0; i <= UNDO_LIMIT; i++) m.undo();
  assert.equal(x(m), 24);
});

test("a new change clears redo", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.undo();
  m.perform("Move", (b) => (b.cards[0].x = 48));
  assert.equal(m.canRedo, false);
});

test("onChange fires for changes, gesture steps, undo and redo", () => {
  const m = fresh();
  let n = 0;
  m.onChange = () => n++;
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.begin();
  m.update((b) => (b.cards[0].x = 48));
  m.end("Move");
  m.undo();
  m.redo();
  assert.equal(n, 5);
});
