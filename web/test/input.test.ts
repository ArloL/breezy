import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../app.ts";
import { Mouse } from "../mouse.ts";
import { fakePorts, type FakeView } from "./fakes.ts";
import type { Board } from "../types.ts";

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 16) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const board = (): Board => ({
  cards: [{ id: "a", x: 600, y: 72, w: 240, text: "a", color: 1 }],
  lanes: [{ id: "l", x: 0, y: 0, w: 288, h: 720, title: "Lane" }],
});

function app() {
  const a = new App(board(), fakePorts);
  return { app: a, mouse: new Mouse(a), scene: () => (a.view as FakeView).scene() };
}

test("a mouse drag into a lane lands the card in its column, as one step", () => {
  const { app: a, mouse, scene } = app();
  mouse.down({ x: 700, y: 100, shiftKey: false, altKey: false }, 0);
  mouse.move({ x: 400, y: 150 });
  mouse.move({ x: 100, y: 200 });
  assert.equal(scene().cards[0]!.held, true);
  mouse.up({ x: 100, y: 200 });
  assert.deepEqual(scene().cards[0], { id: "a", x: 24, y: 72, w: 240, h: 48, selected: true, held: false, raised: false, color: 1, text: "a" });
  a.undo();
  assert.equal(a.model.board.cards[0]!.x, 600);
});

test("a card deleted elsewhere between the press and the drag is not dragged", () => {
  const { app: a, mouse } = app();
  mouse.down({ x: 700, y: 100, shiftKey: false, altKey: false }, 0);
  a.model.applyRemote({ cards: [], lanes: board().lanes });
  mouse.move({ x: 400, y: 150 });
  mouse.up({ x: 400, y: 150 });
  assert.equal(a.model.inGesture, false);
  assert.deepEqual(a.model.board.cards, []);
});

test("a lane deleted elsewhere between the press and the drag is not dragged", () => {
  const { app: a, mouse } = app();
  mouse.down({ x: 100, y: 10, shiftKey: false, altKey: false }, 0);
  a.model.applyRemote({ cards: board().cards, lanes: [] });
  mouse.move({ x: 200, y: 50 });
  mouse.up({ x: 200, y: 50 });
  assert.equal(a.model.inGesture, false);
});

test("a hold lifts the card the finger went down on, though the board moved under it since", () => {
  const { app: a } = app();
  a.input.touchStart({ x: 700, y: 100 });
  // as the keyboard going away moves the board
  a.view.setCamera({ ...a.view.cam, y: a.view.cam.y + 60 });
  a.input.hold({ x: 700, y: 100 });
  assert.deepEqual([...a.state.lifted], ["a"]);
});

test("a selected card the finger went down on is dragged, though the board moved under it since", () => {
  const { app: a, scene } = app();
  a.select(["a"]);
  a.input.touchStart({ x: 700, y: 100 });
  a.view.setCamera({ ...a.view.cam, y: a.view.cam.y + 60 });
  a.input.dragStart({ x: 700, y: 100 }, { x: 650, y: 150 }, false);
  assert.equal(scene().cards[0]!.held, true);
});

test("a held card deleted elsewhere before the drag is not left lifted", () => {
  const { app: a } = app();
  a.input.hold({ x: 700, y: 100 });
  assert.deepEqual([...a.state.lifted], ["a"]);
  a.model.applyRemote({ cards: [], lanes: board().lanes });
  a.input.dragStart({ x: 700, y: 100 }, { x: 650, y: 150 }, true);
  assert.deepEqual([...a.state.lifted], []);
});

test("a held card someone else holds is not left lifted when the drag cannot start", () => {
  const { app: a } = app();
  a.input.hold({ x: 700, y: 100 });
  a.state.taken = new Map([["a", { device: "d", name: "Bo", colour: "red" }]]);
  a.input.dragStart({ x: 700, y: 100 }, { x: 650, y: 150 }, true);
  assert.deepEqual([...a.state.lifted], []);
});

test("a click on the corner selects the card, a double-click turns it", () => {
  const { app: a, mouse } = app();
  mouse.down({ x: 830, y: 110, shiftKey: false, altKey: false }, 0);
  mouse.up({ x: 830, y: 110 });
  assert.equal(a.state.turned, null);
  assert.deepEqual([...a.state.selection], ["a"]);
  mouse.down({ x: 830, y: 110, shiftKey: false, altKey: false }, 100);
  mouse.up({ x: 830, y: 110 });
  assert.equal(a.state.turned, "a");
  assert.equal(a.state.editing, null);
});

test("a tap on the corner selects the card, a double tap turns it; below 69 % it edits", () => {
  const { app: a } = app();
  a.input.tap({ x: 830, y: 110 });
  assert.equal(a.state.turned, null);
  assert.deepEqual([...a.state.selection], ["a"]);
  a.input.doubleTap({ x: 830, y: 110 });
  assert.equal(a.state.turned, "a");
  // the back is bigger: its corner is elsewhere
  const r = a.view.rectOf(a.model.board.cards[0]!);
  a.input.doubleTap({ x: r.x + r.w - 10, y: r.y + r.h - 10 });
  assert.equal(a.state.turned, null);
  a.view.setCamera({ x: 0, y: 0, zoom: 0.5 });
  a.input.doubleTap({ x: 415, y: 55 });
  assert.equal(a.state.turned, null);
  assert.equal(a.state.editing?.id, "a");
});

test("a double tap on the corner of the card being edited ends the edit and turns it", () => {
  const { app: a } = app();
  a.beginEdit("a");
  a.input.doubleTap({ x: 830, y: 110 });
  assert.equal(a.state.editing, null);
  assert.equal(a.state.turned, "a");
});
