// The boards a page opens on from its address, when not the kept ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceBoard, referenceStart } from "../sample.ts";
import { boardOf, extent } from "../camera.ts";

test("?reference=x,y opens the reference's empty board at zoom 1 there", () => {
  assert.deepEqual(referenceStart("?reference=1194,381&who=a"), { x: 1194, y: 381, zoom: 1 });
});

test("?reference=x,y,zoom opens it at that zoom, as a reference stroke began at 50 %", () => {
  assert.deepEqual(referenceStart("?reference=-200.5,90,0.5"), { x: -200.5, y: 90, zoom: 0.5 });
});

test("an address without a reference camera opens none", () => {
  assert.equal(referenceStart("?demo"), null);
  assert.equal(referenceStart("?reference=x"), null);
  assert.equal(referenceStart(""), null);
});

test("a reference board with ?wide is as wide as AppKit's reference board, centred where the empty one is, for pans that travel thousands of points", () => {
  const b = referenceBoard("?reference=0,0&wide"), r = boardOf(extent(b.lanes), null);
  assert.deepEqual(b.cards, []);
  assert.deepEqual(r, { x: -20016, y: -20016, w: 40032, h: 40032 });
  assert.deepEqual(referenceBoard("?reference=0,0"), { cards: [], lanes: [] });
});
