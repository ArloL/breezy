// A night's sum of its scenario runs, as its summary shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stats = new URL("../scenario-stats.ts", import.meta.url).pathname;

test("a simctl call that failed in a case that passed is listed, as the retry hid it", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-"));
  const run = (name: string, simctlFailed?: string[]) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "case.json"), JSON.stringify({ case: "a card typed", pair: ["chromium", "ios-safari"], verdict: "passed", ms: 60_000, steps: [], simctlFailed }));
  };
  run("1", ["simctl openurl U http://x: failed after 33000 ms, exit 60: Operation timed out"]);
  run("2");
  const md = execFileSync("node", [stats, dir], { encoding: "utf8", timeout: 30_000 });
  assert.match(md, /### simctl calls that failed\n/);
  assert.match(md, /\| a card typed \(chromium → ios-safari\) \| passed \| `simctl openurl U http:\/\/x: failed after 33000 ms, exit 60: Operation timed out` \|/);
});

test("a night with no simctl call that failed says nothing of them", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-"));
  mkdirSync(join(dir, "1"));
  writeFileSync(join(dir, "1", "case.json"), JSON.stringify({ case: "a card typed", pair: ["chromium", "webkit"], verdict: "passed", ms: 1000, steps: [] }));
  assert.doesNotMatch(execFileSync("node", [stats, dir], { encoding: "utf8", timeout: 30_000 }), /simctl/);
});
