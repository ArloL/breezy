import { test } from "node:test";
import assert from "node:assert/strict";
import { broadcastArgs } from "./harness.ts";

test("a broadcast quotes each extra for the device's shell", () => {
  assert.deepEqual(broadcastArgs("commit", { text: "hello world" }),
    ["shell", "am", "broadcast", "-a", "de.k5d.breezy.ime.OP", "--es", "op", "'commit'", "--es", "text", "'hello world'"]);
  assert.deepEqual(broadcastArgs("commit", { text: "it's" }).at(-1), "'it'\\''s'");
  assert.deepEqual(broadcastArgs("region", { start: 3, end: 9 }).slice(-6), ["--ei", "start", "3", "--ei", "end", "9"]);
});
