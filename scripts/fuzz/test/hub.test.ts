import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Hub } from "../hub.mjs";
import { BINARY } from "../swift-devices.mjs";

test("web devices converge, and a seed replays to the same trace", async () => {
  const run = () => new Hub({ seed: 3, web: 3, swift: 0, steps: 150 }).run();
  const [a, b] = [await run(), await run()];
  assert.deepEqual(a.problems, []);
  assert.equal(a.hash, b.hash);
});

test("web and Swift devices converge, and a seed replays to the same trace", { skip: !existsSync(BINARY) && "breezy-sim is not built" }, async () => {
  const run = () => new Hub({ seed: 4, web: 1, swift: 1, steps: 150 }).run();
  const [a, b] = [await run(), await run()];
  assert.deepEqual(a.problems, []);
  assert.equal(a.hash, b.hash);
});
