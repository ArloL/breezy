// What the replay helper posts: NSEvent's phases, as the reference app recorded them, in CGEvent's numbering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCGPhases } from "../replay.ts";

test("toCGPhases maps every NSEvent phase", () => {
  for (const [ns, cg] of [[0, 0], [1, 1], [4, 2], [8, 4], [16, 8], [32, 128]]) assert.equal(toCGPhases(ns, 0).scroll, cg, `phase ${ns}`);
  for (const [ns, cg] of [[0, 0], [1, 1], [4, 2], [8, 3]]) assert.equal(toCGPhases(0, ns).momentum, cg, `momentum ${ns}`);
});

test("toCGPhases refuses a phase it does not know", () => {
  assert.throws(() => toCGPhases(2, 0), /phase 2/);
  assert.throws(() => toCGPhases(0, 16), /momentum 16/);
});
