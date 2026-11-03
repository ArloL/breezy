// What ran under a night's cases, read from what each case recorded: the facts to tell a runner's trouble from the app's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentChanges, jobDirs, jobFacts, parseTimeline, ratio, report, spread } from "../runner-facts.ts";

setTimeout(() => process.exit(1), 30_000).unref();

const TIMELINE = (late: number, load = 12.5) => [
  "passed",
  "",
  "12:04:11.889   +8036  simctl              simctl launch 1EF76930-01F7-4EDF-8047-B7B160C8017F com.apple.mobilesafari: 821 ms",
  "12:04:12.717   +8864  simctl              simctl openurl 1EF76930-01F7-4EDF-8047-B7B160C8017F http://localhost:1/x: 9300 ms",
  "12:04:12.800   +8900  simctl              simctl terminate 1EF76930-01F7-4EDF-8047-B7B160C8017F com.apple.webapp: failed after 311 ms, exit 3: not running",
  "12:04:13.132   +9280  d0 chromium         page frames 14",
  "12:04:20.378  +10073  runner              busiest: Web 96 %, provjobd1625404190 23 %",
  `12:04:22.148  +18295  runner              load ${load} of 3 CPUs, 258 MB free, node's timers up to ${late} ms late`,
].join("\n");

function job(t: { after: (f: () => void) => void }, name = "scenarios-ios") {
  const root = mkdtempSync(join(tmpdir(), "breezy-facts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "environment.json"), JSON.stringify({ runner: "GitHub Actions 1, macos27 2026", cpus: "3 × M1", memory: "7 GB" }));
  const add = (when: string, verdict: string, late: number, load?: number) => {
    const d = join(dir, `${when} case`);
    mkdirSync(d);
    writeFileSync(join(d, "case.json"), JSON.stringify({ test: `case ${when}`, case: `case ${when}`, pair: ["a", "b"], verdict, started: when, ms: 1000 }));
    writeFileSync(join(d, "timeline.txt"), TIMELINE(late, load));
  };
  return { root, dir, add };
}

test("a timeline's lines keep who said them, a name of two words among them", () => {
  assert.deepEqual(parseTimeline("12:04:13.132   +9280  d0 chromium         page frames 14\nd0 says \"x\""),
    [{ at: 9280, who: "d0 chromium", text: "page frames 14" }]);
});

test("a stall names what began while the process stood still, without the iPhone's id, and not the page's own lines", (t) => {
  const j = job(t);
  j.add("2", "passed", 12558);
  const f = jobFacts(j.dir);
  assert.equal(f.stalledCases, 1);
  assert.equal(f.stalls[0]!.lateMs, 12558);
  assert.equal(f.stalls[0]!.around[1], "simctl: simctl openurl U http://localhost:1/x: 9300 ms");
  assert.ok(!f.stalls[0]!.around.some((l) => l.includes("page frames")));
});

test("lateness under the limit is no stall", (t) => {
  const j = job(t);
  j.add("1", "passed", 4999);
  assert.equal(jobFacts(j.dir).stalledCases, 0);
});

test("the job's first case is told apart by when it started, as the iPhone is still settling then", (t) => {
  const j = job(t);
  j.add("2", "passed", 6000, 10);
  j.add("1", "failed", 6000, 170);
  const f = jobFacts(j.dir);
  assert.equal(f.firstCaseLoad!.median, 170);
  assert.equal(f.load!.max, 170);
  assert.equal(f.failed, 1);
  assert.deepEqual(f.stalls.map((s) => s.firstCase).sort(), [false, true]);
  assert.deepEqual(Object.keys(f.ms), ["case 2"]);
  assert.deepEqual(f.failures, [{ test: "case 1", position: 0, load: 170, error: "failed" }]);
  assert.match(report([f]), /\| scenarios-ios \| 0 \| 170 \| failed \| case 1 \|/);
});

test("simctl's calls are told by verb, with those that failed, and a job's busiest with launchd's number off its name", (t) => {
  const j = job(t);
  j.add("1", "passed", 0);
  const f = jobFacts(j.dir);
  assert.equal(f.simctl.openurl!.median, 9300);
  assert.equal(f.simctl.terminate!.failed, 1);
  assert.equal(f.simctl.openurl!.failed, 0);
  assert.deepEqual(f.busiest, [{ name: "Web", percent: 96 }, { name: "provjobd", percent: 23 }]);
});

test("a job is the folder with an environment.json, however deep a download put it", (t) => {
  const j = job(t);
  assert.deepEqual(jobDirs([j.root]), [j.dir]);
  assert.deepEqual(jobDirs([join(j.root, "none")]), []);
});

test("a job a folder down in its artifact, as Android's, goes by its artifact's name", (t) => {
  const j = job(t, "scenarios-android");
  const down = join(j.dir, "scenarios");
  mkdirSync(down);
  writeFileSync(join(down, "environment.json"), "{}");
  rmSync(join(j.dir, "environment.json"));
  assert.deepEqual(jobDirs([j.root]), [down]);
  assert.equal(jobFacts(down).job, "scenarios-android");
});

test("a spread needs values", () => {
  assert.equal(spread([]), null);
  assert.deepEqual(spread([3, 1, 2]), { n: 3, median: 2, p95: 3, max: 3 });
});

test("a ratio holds its interval around it, and a pair alone says nothing", () => {
  assert.equal(ratio([[2, 1]]), null);
  const r = ratio(Array.from({ length: 40 }, (_, i): [number, number] => [2 + (i % 5) / 10, 1]))!;
  assert.ok(r.low < r.ratio && r.ratio < r.high);
  assert.ok(r.low > 2 && r.high < 2.4);
  assert.deepEqual(ratio([[2, 1], [3, 1], [4, 1]]), ratio([[2, 1], [3, 1], [4, 1]]));
});

test("what differs each run is no change of environment, a runner's new image is", () => {
  const a = { runner: "GitHub Actions 1, macos27 20261026", run: "x", commit: "a", node: "24" };
  assert.deepEqual(environmentChanges(a, { ...a, runner: "GitHub Actions 2, macos27 20261026", run: "y", commit: "b" }), []);
  assert.deepEqual(environmentChanges(a, { ...a, runner: "GitHub Actions 2, macos27 20261101" }), ['runner: "macos27 20261026" → "macos27 20261101"']);
});

test("the report holds a job to the other run's by the cases that passed on both", (t) => {
  const a = job(t), b = job(t);
  a.add("1", "passed", 0);
  b.add("1", "passed", 0);
  a.add("2", "passed", 0);
  b.add("2", "passed", 0);
  const text = report([jobFacts(a.dir)], [jobFacts(b.dir)]);
  assert.match(text, /\| scenarios-ios \| none \| 2 \| 1\.00 \(1\.00–1\.00\) \|/);
  assert.equal(report([]), "");
});

test("a job downloaded alone, without its artifact's name, is held to the job that ran its cases", (t) => {
  const alone = job(t, "nightly"), other = job(t, "scenarios-other"), desktop = job(t, "scenarios-desktop");
  for (const j of [alone, desktop]) j.add("1", "passed", 0);
  for (const j of [alone, desktop]) j.add("2", "passed", 0);
  other.add("3", "passed", 0);
  assert.match(report([jobFacts(alone.dir)], [jobFacts(other.dir), jobFacts(desktop.dir)]), /\| nightly \| none \| 2 \| 1\.00/);
  assert.match(report([jobFacts(other.dir)], [jobFacts(desktop.dir)]), /\| scenarios-other \| not in the other run/);
});
