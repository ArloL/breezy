import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { App } from "../app.ts";
import { fakePorts, PHONE, type FakeView } from "./fakes.ts";
import type { Board } from "../types.ts";

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 16) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const board = (): Board => ({ cards: [{ id: "a", x: 0, y: 0, w: 240, text: "a", color: 1 }], lanes: [] });

function phone() {
  const app = new App(board(), fakePorts);
  const view = app.view as FakeView;
  view.screen = PHONE;
  app.touching = true;
  return { app, view };
}

/** Until the fake stands still, on the real clock: springs take about a second. */
async function still(view: FakeView) {
  for (let t = 0; !view.still(); t += 20) {
    assert.ok(t < 3000, "never stood still");
    await sleep(20);
  }
}

test("a phone's keyboard rises after an editor takes focus, and the area above it shrinks", async () => {
  const { app, view } = phone();
  assert.deepEqual(app.ui.area(), { top: 120, bottom: 774, left: 0, right: 402 });
  app.beginEdit("a");
  assert.equal(app.ui.area().bottom, 774, "not before the keyboard has come");
  await sleep(PHONE.keyboardMs + 50);
  assert.deepEqual(app.ui.area(), { top: PHONE.keyboardTop, bottom: PHONE.h - PHONE.keyboard - 44, left: 0, right: 402 });
  app.endEditing();
  await sleep(PHONE.keyboardMs + 50);
  assert.equal(app.ui.area().bottom, 774);
  await still(view);
});

test("an animated camera move springs, and still says when it has stopped", async () => {
  const { view } = phone();
  view.setCamera({ x: 100, y: 0, zoom: 1 }, true);
  assert.equal(view.still(), false);
  assert.notEqual(view.cam.x, 100);
  await still(view);
  assert.ok(Math.abs(view.cam.x - 100) < 0.05);
});

test("reveal pans the fake's camera to show a rect, as View does", async () => {
  const { view } = phone();
  view.setCamera({ x: 0, y: 0, zoom: 1 });
  view.reveal({ x: 1000, y: 300, w: 240, h: 48 });
  await still(view);
  const s = view.toScreen({ x: 1000, y: 300 });
  assert.ok(s.x >= 0 && s.x + 240 <= 402, `x ${s.x}`);
});
