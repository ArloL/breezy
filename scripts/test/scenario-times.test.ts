// A night's runs as samples gate.ts can hold against another night's: how long each case took on each pair, and how far
// each device's page fell short of 60 frames a second, for what something new on the runner, as video, costs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { times } from "../scenario-times.ts";

test("each passing case's time and each device's frames short of 60 a second are samples", () => {
  const dir = mkdtempSync(join(tmpdir(), "times-"));
  const run = (name: string, verdict: string, ms: number, frames: number[]) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "case.json"), JSON.stringify({ case: "a card", pair: ["chromium", "webkit"], verdict, ms }));
    writeFileSync(join(dir, name, "timeline.txt"), frames.map((f) => `08:32:21.420   +2995  d1 webkit      page frames ${f}`).join("\n"));
  };
  run("1", "passed", 4000, [60, 54]);
  run("2", "passed", 5000, [61, 60]);
  run("3", "failed", 9000, [10]);
  assert.deepEqual(times(dir), {
    "a card (chromium → webkit)": [4000, 5000],
    "frames short of 60 a second: webkit": [3, 0],
  });
});
