import { test } from "node:test";
import assert from "node:assert/strict";
import { wheelAction, LINE } from "../wheel.js";

const wheel = (e) => wheelAction({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...e });

test("scrolling pans against the delta", () => {
  assert.deepEqual(wheel({ deltaX: 5, deltaY: -10 }), { pan: { x: -5, y: 10 } });
});

test("a wheel counting lines pans 16 pt a line", () => {
  assert.deepEqual(wheel({ deltaY: 3, deltaMode: 1 }), { pan: { x: -0, y: -3 * LINE } });
});

test("a pinch, or ⌘-scroll, zooms: up zooms in", () => {
  assert.ok(Math.abs(wheel({ deltaY: -10, ctrlKey: true }).zoom - Math.exp(0.1)) < 1e-9);
  assert.ok(wheel({ deltaY: 10, metaKey: true }).zoom < 1);
});

test("a mouse wheel's large notch zooms one step, not to a limit", () => {
  assert.ok(Math.abs(wheel({ deltaY: -100, ctrlKey: true }).zoom - Math.exp(0.25)) < 1e-9);
  assert.ok(Math.abs(wheel({ deltaY: 3, deltaMode: 1, ctrlKey: true }).zoom - Math.exp(-0.25)) < 1e-9);
});
