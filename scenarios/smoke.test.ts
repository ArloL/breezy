// The smoke set: the few cases Main runs on real devices (TESTING.md, "The gate"), one per class the devices own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cases } from "./cases.ts";
import { smoke } from "./smoke.ts";

test("the smoke set is a few cases, one per class the devices own", () => {
  const set = smoke(cases, "1");
  assert.ok(set.length >= 5 && set.length <= 8, `${set.length} smoke cases`);
  assert.ok(set.some((c) => c.input === "mouse"), "a mouse case");
  assert.ok(set.some((c) => c.input === "touch"), "a touch case");
  assert.ok(set.some((c) => c.offline), "an offline case");
  assert.ok(set.some((c) => c.edits), "an editing case");
  assert.ok(set.some((c) => c.acts?.includes("android")), "a case Android acts in");
  assert.ok(set.every((c) => (c.ms ?? 0) <= 90_000), "no long case");
});

test("without SCENARIO_SMOKE every case runs", () => {
  assert.equal(smoke(cases, undefined), cases);
});

test("SCENARIO_SMOKE=1 with no case marked is an error, not an empty run", () => {
  assert.throws(() => smoke([{ name: "x", input: "mouse", run: async () => {} }], "1"), /no case is marked smoke/);
});
