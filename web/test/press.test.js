import { test } from "node:test";
import assert from "node:assert/strict";
import { PressTracker, SLOP } from "../press.js";

const rect = { left: 100, top: 100, right: 144, bottom: 144 };

test("a press highlights at once and stays highlighted within 70 pt of the button", () => {
  const t = new PressTracker(rect);
  assert.equal(t.inside, true);
  assert.equal(t.move({ x: 144 + SLOP - 1, y: 120 }), null);
  assert.equal(t.inside, true);
});

test("sliding further away un-highlights, and coming back highlights again", () => {
  const t = new PressTracker(rect);
  assert.equal(t.move({ x: 144 + SLOP + 1, y: 120 }), "out");
  assert.equal(t.move({ x: 144 + SLOP + 20, y: 120 }), null);
  assert.equal(t.move({ x: 120, y: 100 - SLOP }), "in");
});

test("only a lift within reach acts", () => {
  assert.equal(new PressTracker(rect).up({ x: 120, y: 144 + SLOP }), true);
  assert.equal(new PressTracker(rect).up({ x: 120, y: 144 + SLOP + 1 }), false);
});
