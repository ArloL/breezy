import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Hub } from "../hub.mjs";
import { BINARY } from "../swift-devices.mjs";
import { shrink } from "../shrink.mjs";

// the fuzzer must find a planted bug within a small budget, and shrink it
test("a planted bug fails the run, and shrinks", { skip: !existsSync(BINARY) && "breezy-sim is not built", timeout: 600_000 }, async () => {
  const opts = { seed: 1, web: 2, swift: 2, plant: "pushed-skip" };
  const r = await new Hub(opts).run();
  assert.ok(!r.ok);
  const small = await shrink(opts, r.trace, { runs: 40 });
  assert.ok(small && small.entries <= 30, `${small?.entries} entries`);
});

// converging is not enough: a merge that drops one side's change converges too
test("a merge that drops one side's change fails the merge probes", { timeout: 300_000 }, async () => {
  const r = await new Hub({ seed: 1, web: 3, swift: 0, plant: "merge-local" }).run();
  assert.ok(r.problems.some((p) => /lost in the merge/.test(p.problem)), JSON.stringify(r.problems));
});
