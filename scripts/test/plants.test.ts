// What scripts/plants.ts prints of a run that failed other than as planted, as its log stays on the runner: a clean
// run of the strokes failed once on CI on 2026-11-26 with only "FAILS WITHOUT IT" to show for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failedLines } from "../plants.ts";

setTimeout(() => { console.error("plants.test ran past 30 s"); process.exit(1); }, 30_000).unref();

test("a run's failing tests and their assertions are what is printed of it, at most 40 lines", () => {
  const out = ["✔ firefox: a (1ms)", "✖ firefox: b (2ms)", "  AssertionError [ERR_ASSERTION]: drifted", "    at x", "ℹ fail 1"].join("\n");
  assert.deepEqual(failedLines(out), ["✖ firefox: b (2ms)", "  AssertionError [ERR_ASSERTION]: drifted", "ℹ fail 1"]);
  assert.equal(failedLines(Array.from({ length: 100 }, (_, i) => `✖ t${i}`).join("\n")).length, 40);
});
