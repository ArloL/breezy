// A card turned while it is edited on a phone: its back shows from its top edge, the caret in sight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { App } from "../app.ts";
import { fakePorts, PHONE, type FakeView } from "./fakes.ts";

globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(performance.now()), 16) as unknown as number;
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

/** An iPhone 13 mini's board above its keyboard, 250 pt tall, as its Safari showed it: too short for a back. */
const MINI = { ...PHONE, w: 375, h: 812, top: 120, bottom: 712, keyboardTop: 120, keyboard: 398 };

test("a card turned while it is edited on a small phone shows its back from its top edge, the caret in sight", async () => {
  const app = new App({ cards: [{ id: "a", x: 0, y: 400, w: 240, text: "a title", color: 1 }], lanes: [] }, fakePorts);
  const view = app.view as FakeView;
  view.screen = MINI;
  app.touching = true;
  app.beginEdit("a");
  for (let t = 0; !view.still(); t += 20) {
    assert.ok(t < 3000, "never stood still");
    await sleep(20);
  }
  app.switchSide();
  for (let t = 0; !view.still(); t += 20) {
    assert.ok(t < 3000, "never stood still");
    await sleep(20);
  }
  const s = view.sight();
  assert.ok(s.focus && s.caret, "the back is edited");
  assert.ok(s.focus.h > s.visible.h, `the back, ${s.focus.h} pt, fits in ${s.visible.h}`);
  assert.ok(s.focus.y >= s.visible.y, `the back's top at ${s.focus.y}, the board from ${s.visible.y}`);
  assert.ok(s.caret.y >= s.visible.y && s.caret.y + s.caret.h <= s.visible.y + s.visible.h, `the caret at ${s.caret.y}, the board ${s.visible.y} to ${s.visible.y + s.visible.h}`);
});
