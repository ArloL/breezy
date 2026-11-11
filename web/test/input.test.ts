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

test("in native mode a pan drag on the empty board moves nothing and coasts nothing: the browser pans", () => {
  const { app: a } = app();
  a.input.native = true;
  const cam = { ...a.view.cam };
  a.input.touchStart({ x: 400, y: 600 });
  a.input.dragStart({ x: 400, y: 600 }, { x: 350, y: 550 }, false);
  assert.equal(a.input.drag?.action, "pan");
  a.input.dragMove({ x: 300, y: 500 });
  assert.deepEqual(a.view.cam, cam);
  a.input.dragEnd({ x: 300, y: 500 }, { x: -2, y: -2 });
  assert.deepEqual(a.view.cam, cam);
  assert.equal(a.view.camera.moving, false);
});

test("in native mode a one-finger zoom zooms around the point first touched, doubling for every 150 pt down", () => {
  const { app: a } = app();
  a.input.native = true;
  const p = { x: 400, y: 300 }, w0 = a.view.toWorld(p), z0 = a.view.cam.zoom;
  a.input.zoomDragStart(p);
  a.input.zoomDrag(75);
  a.input.zoomDrag(150);
  assert.ok(Math.abs(a.view.cam.zoom - z0 * 2) < 1e-9, `zoom ${a.view.cam.zoom}`);
  const w1 = a.view.toWorld(p);
  assert.ok(Math.abs(w1.x - w0.x) < 1e-9 && Math.abs(w1.y - w0.y) < 1e-9, `the point first touched moved to ${JSON.stringify(w1)}`);
  // held at the limit, with no stretch past it to spring back from
  a.input.zoomDrag(900);
  assert.equal(a.view.cam.zoom, 2);
  a.input.zoomDragEnd();
  assert.equal(a.input.pinchBase, null);
});

test("in native mode a one-finger zoom cancelled puts the camera back", () => {
  const { app: a } = app();
  a.input.native = true;
  const cam = { ...a.view.cam };
  a.input.zoomDragStart({ x: 400, y: 300 });
  a.input.zoomDrag(150);
  a.input.zoomDragCancel();
  assert.deepEqual(a.view.cam, cam);
  assert.equal(a.input.pinchBase, null);
});

test("in native mode the pointers' pinch moves nothing: the touches' own pinch has the board", () => {
  const { app: a } = app();
  a.input.native = true;
  const cam = { ...a.view.cam };
  a.input.pinchStart({ x: 400, y: 300 });
  a.input.pinch({ x: 420, y: 320 }, 2);
  assert.deepEqual(a.view.cam, cam);
  a.input.pinchEnd({ x: 1, y: 1 });
  a.input.pinchStart({ x: 400, y: 300 });
  a.input.pinchCancel();
  assert.deepEqual(a.view.cam, cam);
  assert.equal(a.view.camera.moving, false);
});

test("in native mode a pan cancelled leaves the camera where the browser took it", () => {
  const { app: a } = app();
  a.input.native = true;
  a.input.touchStart({ x: 400, y: 600 });
  a.input.dragStart({ x: 400, y: 600 }, { x: 350, y: 550 }, false);
  // the browser's pan, as the scroll position's camera
  a.view.setCamera({ ...a.view.cam, y: a.view.cam.y - 80 });
  const cam = { ...a.view.cam };
  a.input.dragCancel();
  assert.deepEqual(a.view.cam, cam);
});
