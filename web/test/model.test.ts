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

test("perform during a gesture records nothing of its own; the gesture's step covers it", () => {
  const m = fresh();
  m.begin();
  m.update((b) => (b.cards[0].x = 24));
  let n = 0;
  m.onChange = () => n++;
  m.perform("Colour", (b) => (b.cards[0].color = 2));
  assert.equal(n, 1);
  assert.equal(m.undos.length, 0);
  m.end("Move");
  assert.equal(m.undos.length, 1);
  m.undo();
  assert.equal(x(m), 0);
  assert.equal(m.board.cards[0].color, 1);
});

test("a cancelled gesture puts the board back and records nothing", () => {
  const m = fresh();
  m.begin();
  m.update((b) => (b.cards[0].x = 24));
  m.cancel();
  assert.equal(x(m), 0);
  assert.equal(m.inGesture, false);
  assert.equal(m.canUndo, false);
});

test("undo leaves changes from another device alone", () => {
  const m = fresh();
  m.perform("Colour", (b) => (b.cards[0].color = 3));
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], x: 48 }] });
  m.undo();
  assert.equal(m.board.cards[0].color, 1);
  assert.equal(x(m), 48);
});

test("undo keeps a field the other device changed since", () => {
  const m = fresh();
  m.perform("Colour", (b) => (b.cards[0].color = 3));
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], color: 4 }] });
  m.undo();
  assert.equal(m.board.cards[0].color, 4);
});

test("redo puts back only what the step changed", () => {
  const m = fresh();
  m.perform("Colour", (b) => (b.cards[0].color = 3));
  m.undo();
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], text: "y" }] });
  m.redo();
  assert.equal(m.board.cards[0].color, 3);
  assert.equal(m.board.cards[0].text, "y");
});

test("changes from another device add no step and wait for a gesture", () => {
  const m = fresh();
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], color: 2 }] });
  assert.equal(m.canUndo, false);
  m.begin();
  m.applyRemote({ ...structuredClone(m.board), cards: [{ ...m.board.cards[0], color: 5 }] });
  assert.equal(m.board.cards[0].color, 2);
});

test("replace shows another board with no history", () => {
  const m = fresh();
  m.perform("Move", (b) => (b.cards[0].x = 24));
  m.replace({ cards: [], lanes: [] });
  assert.deepEqual(m.board, { cards: [], lanes: [] });
  assert.equal(m.canUndo, false);
});
