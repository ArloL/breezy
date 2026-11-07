// A measure the gate finds worse is measured again, its group alone, for as many turns once more; what stays worse
// over every turn fails, what was the turns' luck passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge, samples } from "../gate.ts";

const feelGate = new URL("../feel-gate.ts", import.meta.url).pathname;

/** feel.ts's output for one turn: its samples, and each measure's group. */
const turn = (results: Record<string, number>, groups: Record<string, string>) =>
  `${JSON.stringify({ opt: { runs: "1" }, results: Object.fromEntries(Object.entries(results).map(([k, x]) => [k, [x]])), groups })}\n`;
const GROUPS = { "recolour shows on b": "colour", "drag lag, median": "drag" };

/** A feel.ts that prints one turn: `slow` ms for recolour when given --app, as the reference, or not; and its args. */
function fakeFeel(dir: string, { run, ref }: { run: number; ref: number }) {
  const path = join(dir, "feel.mjs");
  writeFileSync(path, `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2), app = args.includes("--app");
appendFileSync(${JSON.stringify(join(dir, "calls.txt"))}, args.join(" ") + "\\n");
console.log(JSON.stringify({ opt: {}, results: { "recolour shows on b": [app ? ${ref} : ${run}] }, groups: { "recolour shows on b": "colour" } }));
`);
  chmodSync(path, 0o755);
  return path;
}

function night(runRecolour: number[], refRecolour: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "breezy-feel-gate-"));
  const lines = (xs: number[]) => xs.map((x, i) => turn({ "recolour shows on b": x, "drag lag, median": 100 + (i % 3) }, GROUPS)).join("");
  writeFileSync(join(dir, "run.txt"), lines(runRecolour));
  writeFileSync(join(dir, "ref.txt"), lines(refRecolour));
  return dir;
}
const gate = (dir: string, feel: string) => spawnSync("node", [feelGate, join(dir, "run.txt"), join(dir, "ref.txt"), "--app", "REF", "--feel", feel, "--turns", "10"], { encoding: "utf8", timeout: 60_000 });

test("judge names the measures it finds worse", () => {
  const dir = night([12, 13, 14, 12, 13], [5, 6, 4, 5, 6]);
  const { worse } = judge(samples(join(dir, "run.txt")), [samples(join(dir, "ref.txt"))]);
  assert.deepEqual(worse, ["recolour shows on b"]);
});

test("feel.ts says which group each measure is in", () => {
  const src = readFileSync(new URL("../feel.ts", import.meta.url), "utf8");
  assert.match(src, /console\.log\(JSON\.stringify\(\{ opt, results, groups \}\)\)/);
});

test("a measure worse by the turns' luck is measured again, its group alone, and passes", () => {
  // the night's ten turns drew high for this commit; ten more of each, alike, bring both to the same mean
  const dir = night([12, 13, 14, 12, 13, 12, 14, 13, 12, 13], [5, 6, 4, 5, 6, 5, 4, 6, 5, 5]);
  const r = gate(dir, fakeFeel(dir, { run: 5, ref: 12 }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n");
  assert.equal(calls.length, 20);
  assert.ok(calls.every((c) => c.includes("--only colour") && c.includes("--runs 1")), calls[0]);
  assert.equal(calls.filter((c) => c.includes("--app REF")).length, 10);
  assert.match(r.stdout, /recolour shows on b .* ok/);
});

test("a measure worse again in the turns measured once more fails", () => {
  const dir = night([12, 13, 14, 12, 13, 12, 14, 13, 12, 13], [5, 6, 4, 5, 6, 5, 4, 6, 5, 5]);
  const r = gate(dir, fakeFeel(dir, { run: 13, ref: 5 }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /recolour shows on b .* WORSE/);
});

test("a night with nothing worse measures nothing again", () => {
  const dir = night([5, 6, 5, 6, 5], [5, 6, 5, 6, 5]);
  const r = gate(dir, fakeFeel(dir, { run: 5, ref: 5 }));
  assert.equal(r.status, 0);
  assert.throws(() => readFileSync(join(dir, "calls.txt")));
});
