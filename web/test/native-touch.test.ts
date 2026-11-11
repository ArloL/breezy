import { test } from "node:test";
import assert from "node:assert/strict";
import { coastFromLift, followVelocity, pinchKind, stopsBrowserPan } from "../native/touch.ts";

const none = { lifted: false, held: false, dragAction: null, doubleTapSecond: false, editing: false, inEditor: false };

test("stopsBrowserPan", () => {
  assert.equal(stopsBrowserPan({ ...none, lifted: true }), true);
  assert.equal(stopsBrowserPan({ ...none, held: true }), true, "a hold on the board, a lane or its corner, before it moves far enough to drag");
  assert.equal(stopsBrowserPan({ ...none, dragAction: "move" }), true);
  assert.equal(stopsBrowserPan({ ...none, dragAction: "pan" }), false);
  assert.equal(stopsBrowserPan({ ...none, doubleTapSecond: true }), true);
  assert.equal(stopsBrowserPan({ ...none, editing: true, inEditor: true }), true);
  assert.equal(stopsBrowserPan({ ...none, editing: true, inEditor: false }), false);
  assert.equal(stopsBrowserPan(none), false);
});

test("pinchKind", () => {
  assert.equal(pinchKind({ cancelable: true, pannedThisTouch: false }), "own");
  assert.equal(pinchKind({ cancelable: false, pannedThisTouch: false }), "taken");
  assert.equal(pinchKind({ cancelable: true, pannedThisTouch: true }), "taken");
  assert.equal(pinchKind({ cancelable: true, pannedThisTouch: false }), "own", "a coast that ended before this touch");
});

test("followVelocity smooths 0.7 new and 0.3 old, dt at least 1", () => {
  assert.deepEqual(followVelocity({ x: 0, y: 0 }, 10, 0, 10), { x: 0.7, y: 0 });
  const v = followVelocity({ x: 1, y: 1 }, 10, 10, 0);
  assert.ok(Math.abs(v.x - 7.3) < 1e-9 && Math.abs(v.y - 7.3) < 1e-9);
});

test("coastFromLift keeps v within 50 ms of the last move", () => {
  const v = { x: 1, y: 2 };
  assert.deepEqual(coastFromLift(v, 49), v);
  assert.deepEqual(coastFromLift(v, 51), { x: 0, y: 0 });
});
