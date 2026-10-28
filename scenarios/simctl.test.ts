// Each simctl call noted for a case's timeline: how long it took, and how it failed, as an iPhone's harness failure is
// read from the call that timed out and the slow ones before it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { iosLogLines, simctl, simctlLog } from "./ios.ts";

test("the simulator's errors and faults join the timeline on the wall clock, the rest stays in its file", () => {
  const log = [
    "Timestamp               Ty Process[PID:TID]",
    "2026-10-28 11:53:20.123 Df SpringBoard[101:202] [com.apple.SpringBoard:Launch] launching com.apple.mobilesafari",
    "2026-10-28 11:53:21.456 E  SpringBoard[101:202] (FrontBoard) openURL timed out for com.apple.mobilesafari",
    "2026-10-28 11:53:22.789 F  MobileSafari[303:404] crashed",
  ].join("\n");
  const lines = iosLogLines(log, "iPhone");
  assert.equal(lines.length, 2);
  assert.equal(lines[0]![0], new Date(2026, 9, 28, 11, 53, 21, 456).getTime());
  assert.equal(lines[0]![1], "iPhone log");
  assert.equal(lines[0]![2], "E SpringBoard: (FrontBoard) openURL timed out for com.apple.mobilesafari");
  assert.match(lines[1]![2], /^F MobileSafari: crashed$/);
});

test("a call is noted with how long it took", () => {
  simctlLog.length = 0;
  const out = simctl(["list", "devices"], { timeout: 1000 }, () => "{}");
  assert.equal(out, "{}");
  assert.equal(simctlLog.length, 1);
  assert.match(simctlLog[0]![2], /^simctl list devices: \d+ ms$/);
  assert.equal(simctlLog[0]![1], "simctl");
});

test("a call that fails is noted with its exit and what it said, and still throws", () => {
  simctlLog.length = 0;
  const fail = () => {
    throw Object.assign(new Error("Command failed"), { status: 60, stderr: "Simulator device failed to open http://x.\nOperation timed out\n" });
  };
  assert.throws(() => simctl(["openurl", "U", "http://x"], { timeout: 1000 }, fail), /Command failed/);
  assert.match(simctlLog[0]![2], /^simctl openurl U http:\/\/x: failed after \d+ ms, exit 60: Simulator device failed to open http:\/\/x\. Operation timed out$/);
});
