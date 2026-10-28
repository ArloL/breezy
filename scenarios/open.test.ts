// Safari on the iPhone opened at a URL until its page asks, as a busy simulator drops some.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openUntilAsked } from "./ios.ts";

test("an open the simulator gave up on is tried again, as one that went nowhere is", async () => {
  let opens = 0;
  await openUntilAsked(async () => {
    if (++opens === 1) throw new Error("Simulator device failed to open http://localhost/: Operation timed out");
  }, async () => {}, 4);
  assert.equal(opens, 2);
});

test("a page that never asks ends it after the last try, with why", async () => {
  let opens = 0;
  await assert.rejects(openUntilAsked(async () => void ++opens, async () => { throw new Error("no page asked"); }, 4), /no page asked/);
  assert.equal(opens, 4);
});
