// A device's recording, read into a case's timeline on the wall clock beside the harness's own lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flightLines } from "./record.ts";

test("a recording's entries become timeline lines on the wall clock", () => {
  const r = { schema: 1 as const, origin: 1000, dropped: 0, context: null, entries: [[5, "decision", "reveal", { path: "card" }], [7, "life", "hidden"]] as never };
  assert.deepEqual(flightLines(r, "d0 webkit"), [
    [1005, "d0 webkit app", "decision reveal {\"path\":\"card\"}"],
    [1007, "d0 webkit app", "life hidden"],
  ]);
});

test("no recording gives no lines", () => {
  assert.deepEqual(flightLines(null, "d0 webkit"), []);
});
