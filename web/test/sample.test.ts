// The boards a page opens on from its address, when not the kept ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceStart } from "../sample.ts";

test("?reference=x,y opens the reference's empty board at zoom 1 there", () => {
  assert.deepEqual(referenceStart("?reference=1194,381&who=a"), { x: 1194, y: 381, zoom: 1 });
});

test("an address without a reference camera opens none", () => {
  assert.equal(referenceStart("?demo"), null);
  assert.equal(referenceStart("?reference=x"), null);
  assert.equal(referenceStart(""), null);
});
