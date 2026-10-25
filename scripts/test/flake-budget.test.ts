import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../flake-budget.ts";

const runs = (n: number, failed: number) => Array.from({ length: n }, (_, i) => ({ case: "c", pair: ["chromium", "webkit"], verdict: i < failed ? "failed" : "passed" }));

test("a level under its budget over enough runs is within it", () => {
  assert.deepEqual(judge(runs(2000, 1), 0.001), { runs: 2000, failed: 1, verdict: "within" });
});

test("a level over its budget is over it", () => {
  assert.equal(judge(runs(2000, 3), 0.001).verdict, "over");
});

test("too few runs to tell a rate of one in a thousand say so", () => {
  assert.equal(judge(runs(500, 0), 0.001).verdict, "too few");
});

test("a run that timed out counts as a failure", () => {
  assert.equal(judge([...runs(1000, 0), { case: "c", pair: ["a", "b"], verdict: "timed out" }], 0.0005).failed, 1);
});
