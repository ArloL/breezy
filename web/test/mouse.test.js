import { test } from "node:test";
import assert from "node:assert/strict";
import { Mouse, DOUBLE_MS } from "../mouse.js";

const card = (id, x, y) => ({ id, x, y, w: 240, text: "t", color: 1 });

/** An app whose input and actions record what the mouse asks of them. */
function fakeApp(hits = {}) {
  const calls = [];
  const app = {
    calls,
    state: { selection: new Set(), turned: null },
    model: { board: { cards: [card("a", 0, 0), card("b", 0, 72)], lanes: [] } },
    heightOf: () => 48,
    select: (ids) => { app.state.selection = new Set(ids); calls.push(["select", [...ids]]); },
    toggle: (id) => calls.push(["toggle", id]),
    turn: (id) => { app.state.turned = id; calls.push(["turn", id]); },
    endEditing: () => {},
    ui: { closeMenu: () => {} },
    input: {
      drag: null,
      stopCoast: () => {},
      hit: (p) => hits[`${p.x},${p.y}`] ?? { kind: "empty" },
      beginDrag: (action, h) => { app.input.drag = { action }; calls.push(["drag", action, h.id]); },
      dragMove: () => calls.push(["move"]),
      dragEnd: () => { app.input.drag = null; calls.push(["end"]); },
      dragCancel: () => { app.input.drag = null; calls.push(["cancel"]); },
      doubleClick: (p, h) => calls.push(["double", h.kind]),
    },
  };
  return app;
}
const at = (x, y, mods = {}) => ({ x, y, shiftKey: false, altKey: false, ...mods });
const names = (app) => app.calls.map((c) => c[0]);

test("a press that does not move selects without dragging, and collapses a selection to the card", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  app.state.selection = new Set(["a", "b"]);
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 12, y: 11 });
  m.up({ x: 12, y: 11 });
  assert.deepEqual(app.calls, [["select", ["a"]]]);
});

test("a drag past 3 pt moves the selection", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 14, y: 10 });
  m.move({ x: 20, y: 10 });
  m.up({ x: 20, y: 10 });
  assert.deepEqual(names(app), ["select", "drag", "move", "end"]);
});

test("a box starts with the first move, without a threshold", () => {
  const app = fakeApp();
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 11, y: 10 });
  assert.deepEqual(app.calls, [["select", []], ["drag", "marquee", undefined]]);
});

test("⌥ on a card selects its pile", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  new Mouse(app).down(at(10, 10, { altKey: true }), 0);
  assert.deepEqual(app.calls, [["select", ["a"]]]);
});

test("a second press soon and near is a double-click, which replaces the press", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" }, "12,12": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.up({ x: 10, y: 10 });
  m.down(at(12, 12), DOUBLE_MS - 1);
  assert.deepEqual(names(app), ["select", "select", "double"]);
});

test("presses slow or far apart are two clicks", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" }, "40,10": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.up({ x: 10, y: 10 });
  m.down(at(10, 10), DOUBLE_MS + 1);
  m.up({ x: 10, y: 10 });
  m.down(at(40, 10), DOUBLE_MS + 50);
  assert.ok(!names(app).includes("double"));
});

test("a third quick press is a click again", () => {
  const app = fakeApp();
  const m = new Mouse(app);
  for (const t of [0, 100, 200]) {
    m.down(at(10, 10), t);
    m.up({ x: 10, y: 10 });
  }
  assert.deepEqual(names(app).filter((n) => n === "double").length, 1);
});

test("a press anywhere but the turned card turns it back; on its fold it turns", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "b" }, "50,50": { kind: "fold", id: "b" } });
  app.state.turned = "a";
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  assert.deepEqual(app.calls.slice(0, 1), [["turn", null]]);
  m.up({ x: 10, y: 10 });
  m.down(at(50, 50), 1000);
  assert.deepEqual(app.calls.at(-1), ["turn", "b"]);
});

test("the system taking the pointer cancels the drag", () => {
  const app = fakeApp({ "10,10": { kind: "card", id: "a" } });
  const m = new Mouse(app);
  m.down(at(10, 10), 0);
  m.move({ x: 30, y: 10 });
  m.cancel();
  assert.equal(names(app).at(-1), "cancel");
});

test("the hovered card is under the last pointer position", () => {
  const app = fakeApp({ "10,10": { kind: "fold", id: "a" } });
  const m = new Mouse(app);
  m.move({ x: 10, y: 10 });
  assert.equal(m.hoveredCard(), "a");
  m.leave();
  assert.equal(m.hoveredCard(), null);
});
