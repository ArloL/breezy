// The app checking on its own that the card being edited is in sight, once the board stands still, as the scenarios
// check it after every step: what it finds wrong is reported, as the owner would have to otherwise.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { SightWatch, type Sight } from "../sight.ts";
import { App } from "../app.ts";
import { fakePorts, FakeView, PHONE } from "./fakes.ts";

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 16) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const board = { x: 0, y: 120, w: 402, h: 300 };
const hidden: Sight = { focus: { x: 20, y: 520, w: 240, h: 48 }, caret: { x: 32, y: 532, w: 0, h: 24 }, visible: board };
const shown: Sight = { focus: { x: 20, y: 200, w: 240, h: 48 }, caret: { x: 32, y: 212, w: 0, h: 24 }, visible: board };

test("checks once the board has been quiet, not on every change", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const w = new SightWatch({ read: () => (reads++, shown), moving: () => false, broken: () => {} });
  w.poke();
  t.mock.timers.tick(300);
  w.poke();
  t.mock.timers.tick(600);
  assert.equal(reads, 0);
  t.mock.timers.tick(100);
  assert.equal(reads, 1);
});

test("waits while the camera moves", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let moving = true, reads = 0;
  const w = new SightWatch({ read: () => (reads++, shown), moving: () => moving, broken: () => {} });
  w.poke();
  t.mock.timers.tick(2000);
  assert.equal(reads, 0);
  moving = false;
  t.mock.timers.tick(700);
  assert.equal(reads, 1);
});

test("reports a card out of sight once, and again only after it was in sight", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let s = hidden;
  const found: string[] = [];
  const w = new SightWatch({ read: () => s, moving: () => false, broken: (problem) => found.push(problem) });
  for (const next of [hidden, hidden, shown, hidden]) {
    s = next;
    w.poke();
    t.mock.timers.tick(700);
  }
  assert.equal(found.length, 2);
  assert.match(found[0]!, /edited card/);
});

test("a board its user moved away from the card is no fault, until they edit again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const found: string[] = [];
  const w = new SightWatch({ read: () => hidden, moving: () => false, broken: (p) => found.push(p) });
  w.moved();
  w.poke();
  t.mock.timers.tick(700);
  assert.equal(found.length, 0);
  w.edited();
  t.mock.timers.tick(700);
  assert.equal(found.length, 1);
});

test("a turned card whose caret the view cannot place, as #129's, is found out of sight on a small phone", async () => {
  mock.timers.reset();
  const app = new App({ cards: [{ id: "a", x: 0, y: 400, w: 240, text: "a title", color: 1 }], lanes: [] },
    { ...fakePorts, view: (app) => Object.assign(new FakeView(app), { caretRect: () => null }) });
  const view = app.view as FakeView;
  view.screen = { ...PHONE, w: 375, h: 812, top: 120, bottom: 712, keyboardTop: 120, keyboard: 398 };
  app.touching = true;
  const found: string[] = [];
  const w = new SightWatch({ read: () => view.sight(), moving: () => !view.still(), broken: (p) => found.push(p), quietMs: 50 });
  app.beginEdit("a");
  app.switchSide();
  w.poke();
  for (let t = 0; !found.length && t < 3000; t += 50) await sleep(50);
  assert.equal(found.length, 1);
});
