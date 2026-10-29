// What the app notes in its recorder as it is used: its edits, turns and reveals, and the gestures it took, and never a
// card's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { App } from "../app.ts";
import { Mouse } from "../mouse.ts";
import type { Entry } from "../flight.ts";
import { fakePorts, FakeView, PHONE, type FakeField } from "./fakes.ts";

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 16) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

/** An iPhone 13 mini's board above its keyboard, 250 pt tall, too short for a back. */
const MINI = { ...PHONE, w: 375, h: 812, top: 120, bottom: 712, keyboardTop: 120, keyboard: 398 };

const phone = (view: (app: App) => FakeView = (app) => new FakeView(app)) => {
  const app = new App({ cards: [{ id: "a", x: 0, y: 400, w: 240, text: "a title", color: 1 }], lanes: [{ id: "l", x: 0, y: 0, w: 480, h: 200, title: "lane" }] }, { ...fakePorts, view });
  (app.view as FakeView).screen = MINI;
  app.touching = true;
  return app;
};

const still = async (app: App) => {
  for (let t = 0; !(app.view as FakeView).still(); t += 20) {
    assert.ok(t < 3000, "never stood still");
    await sleep(20);
  }
};

const of = (app: App, kind: Entry[1]) => app.flight.recording().entries.filter((e) => e[1] === kind);

test("notes why a turned card's reveal kept its caret's line", async () => {
  const app = phone();
  app.beginEdit("a");
  await still(app);
  app.switchSide();
  await still(app);
  const reveal = of(app, "decision").filter((e) => e[2] === "reveal").at(-1)!;
  assert.equal(reveal[3]!.path, "caret");
  assert.equal(reveal[3]!.why, "too tall");
  assert.equal((reveal[3]!.editing as { back: boolean }).back, true);
  assert.ok(Array.isArray((reveal[3]!.editing as { caret: unknown }).caret));
});

test("notes that a reveal kept the card's bottom when the caret had no rect, as #129 did", async () => {
  const app = phone((app) => Object.assign(new FakeView(app), { caretRect: () => null }));
  app.beginEdit("a");
  await still(app);
  app.switchSide();
  await still(app);
  const reveal = of(app, "decision").filter((e) => e[2] === "reveal").at(-1)!;
  assert.deepEqual([reveal[3]!.path, reveal[3]!.why], ["card", "no caret"]);
});

test("a card turned by the right edge pans its back 48 pt in, and notes it", () => {
  const app = new App({ cards: [{ id: "a", x: 900, y: 100, w: 240, text: "a title", color: 1 }], lanes: [] }, fakePorts);
  app.turn("a");
  assert.deepEqual(app.view.camera.goal(), { x: 1200 - 48 - (900 + 480), y: 0, zoom: 1 });
  assert.deepEqual(of(app, "decision").map((e) => [e[2], e[3]]), [["reveal", { path: "back", why: "fits", pan: [-228, 0] }]]);
  app.turn(null);
  app.turn("a");
  assert.equal(of(app, "decision").length, 1, "a back in sight pans nothing more");
});

test("notes a turned card deleted as turned back, as the Mac does", () => {
  const app = phone();
  app.turn("a");
  app.select(["a"]);
  app.removeSelection();
  assert.equal(app.state.turned, null);
  assert.deepEqual(of(app, "transition").map((e) => [e[2], e[3]]), [["turn", { from: null, to: "a" }], ["turn", { from: "a", to: null }]]);
});

test("notes edits and turns as transitions", () => {
  const app = phone();
  app.beginEdit("a");
  app.switchSide();
  app.endEditing();
  assert.deepEqual(of(app, "transition").map((e) => e[2]), ["edit", "turn", "edit", "edit end"]);
});

test("keeps no words", async () => {
  const app = phone();
  app.beginEdit("a");
  const front = app.view.editorOf("a", false) as FakeField;
  front.type("WORDS-q7 title");
  app.switchSide();
  (app.view.editorOf("a", true) as FakeField).type("WORDS-q7 back");
  app.endEditing();
  app.beginRename("l");
  (app.view.titleOf("l") as FakeField).type("WORDS-q7 lane");
  app.endEditing();
  await still(app);
  const json = JSON.stringify(app.flight.recording());
  assert.ok(json.includes("rename"), "the rename is noted");
  assert.ok(!json.includes("WORDS-q7"), json);
});

test("geometry survives the edited card's removal", () => {
  const app = phone();
  app.beginEdit("a");
  app.model.replace({ cards: [], lanes: [] });
  assert.equal(app.geometry().editing, null);
});

test("notes gestures, not their frames", () => {
  const app = phone();
  app.input.tap({ x: 300, y: 300 });
  app.input.doubleTap({ x: 300, y: 300 });
  app.input.dragStart({ x: 200, y: 700 }, { x: 200, y: 690 }, false);
  for (let i = 0; i < 20; i++) app.input.dragMove({ x: 200, y: 690 - i * 5 });
  app.input.dragEnd({ x: 200, y: 590 }, { x: 0, y: 0 });
  const entries = app.flight.recording().entries;
  assert.deepEqual(entries.filter((e) => e[1] === "input").map((e) => e[2]), ["tap", "double tap", "drag start", "drag end"]);
  const start = entries.findIndex((e) => e[2] === "drag start");
  assert.deepEqual(entries.slice(start + 1).filter((e) => e[2] === "drag").map((e) => e[1]), ["transition"]);
});

test("notes a mouse press where it fell and its release, a double-click's second press without one, as the Mac does", () => {
  const app = phone();
  const m = new Mouse(app);
  m.down({ x: 100.4, y: 48, shiftKey: false, altKey: false }, 0);
  m.up({ x: 100.4, y: 48 });
  m.down({ x: 100.4, y: 48, shiftKey: false, altKey: false }, 100);
  m.up({ x: 100.4, y: 48 });
  assert.deepEqual(of(app, "input").map((e) => [e[2], e[3]]), [["press", { x: 100, y: 48, clicks: 1 }], ["release", undefined], ["press", { x: 100, y: 48, clicks: 2 }]]);
});

test("a view that throws while the app notes a reveal breaks neither the note nor the reveal", async () => {
  const app = phone((app) => Object.assign(new FakeView(app), { topOf: () => { throw new Error("gone"); } }));
  app.beginEdit("a");
  await still(app);
  const reveal = of(app, "decision").filter((e) => e[2] === "reveal").at(-1)!;
  assert.equal(reveal[3]!.unreadable, true);
});

test("notes a reveal again only when what it decided changed, not on every key", async () => {
  const app = phone();
  app.beginEdit("a");
  await still(app);
  const before = of(app, "decision").length;
  const field = app.view.editorOf("a", false) as FakeField;
  for (const k of "abcdefgh") field.type(k);
  await still(app);
  assert.equal(of(app, "decision").length, before);
});
