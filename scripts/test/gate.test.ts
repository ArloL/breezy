// The gate on feel measured in turns: each turn's feel.ts output appended to one file, every one of its runs counting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = new URL("../gate.ts", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "breezy-gate-"));

/** feel.ts's output for one run per turn, appended: what it printed along the way, then its samples. */
function turns(file: string, lags: number[]) {
  const path = join(dir, file);
  writeFileSync(path, lags.map((x) => `drag lag, median ${x} ms   (n=1)\n${JSON.stringify({ opt: { runs: "1" }, results: { "drag lag, median": [x] } })}\n`).join(""));
  return path;
}

const run = (a: string, b: string) => spawnSync("node", [gate, a, b], { encoding: "utf8", timeout: 30_000 });

test("every turn's runs count, not the last turn's alone", () => {
  const r = run(turns("run.txt", [200, 220, 210, 214]), turns("ref.txt", [100, 104, 98, 102]));
  assert.match(r.stdout, /drag lag, median +211\.0 ± [\d.]+ against [\d.]+ to [\d.]+ +WORSE/);
  assert.equal(r.status, 1);
});

test("this build alike with the reference passes", () => {
  const r = run(turns("same.txt", [101, 103, 99]), turns("ref2.txt", [100, 104, 98]));
  assert.match(r.stdout, /ok$/m);
  assert.equal(r.status, 0);
});
