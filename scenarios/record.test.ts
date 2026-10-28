// A device's recording, read into a case's timeline on the wall clock beside the harness's own lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flightLines, logcatLines } from "./record.ts";

test("a recording's entries become timeline lines on the wall clock", () => {
  const r = { schema: 1 as const, origin: 1000, dropped: 0, context: null, entries: [[5, "decision", "reveal", { path: "card" }], [7, "life", "hidden"]] as never };
  assert.deepEqual(flightLines(r, "d0 webkit"), [
    [1005, "d0 webkit app", "decision reveal {\"path\":\"card\"}"],
    [1007, "d0 webkit app", "life hidden"],
  ]);
});

test("entries after a device slept are placed by the wall clock it noted on waking, as its own clock stood still", () => {
  const r = { schema: 1 as const, origin: 1000, dropped: 0, context: null, entries: [[5, "life", "hidden"], [6, "life", "visible", { wall: 60_000 }], [9, "input", "tap"]] as never };
  assert.deepEqual(flightLines(r, "d0").map(([at]) => at), [1005, 60_000, 60_003]);
});

test("no recording gives no lines", () => {
  assert.deepEqual(flightLines(null, "d0 webkit"), []);
});

test("the emulator's log keeps when a process starts, dies or is killed: a panic came as a browser's processes changed", () => {
  const log = [
    "1761628730.120  617  640 I am_proc_start: [0,15347,10166,com.android.chrome:sandboxed_process0,service,{com.android.chrome/x}]",
    "1761628731.500  617  700 I am_proc_died: [0,15205,com.android.chrome:sandboxed_process0,920,17]",
    "1761628731.600  617  700 I am_kill : [0,15063,com.android.chrome,920,empty #17]",
    "1761628731.700  455  455 D some_tag: chatter",
  ].join("\n");
  assert.deepEqual(logcatLines(log, "emulator logcat").map(([at, , what]) => [at, what.split(":")[0]]), [
    [1761628730120, "I am_proc_start"], [1761628731500, "I am_proc_died"], [1761628731600, "I am_kill"],
  ]);
});
