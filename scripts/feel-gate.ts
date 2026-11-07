#!/usr/bin/env node
// The nightly's gate on feel: gate.ts on this commit's turns against the reference's, and for a measure it finds worse,
// its group measured again for as many turns, in turns, before every turn of both is judged. One night's ten turns of a
// 23-measure feel drew one worse by luck now and then: back from the background, recolour on b read 12.1 ms against
// 2.3 to 8.2 on a commit whose app was the reference's, as a frame's wait of 0 to 16.7 ms is most of what it measures.
//   node scripts/feel-gate.ts RUN REF --app REF_DIR [--turns 10] [--feel scripts/feel.ts]
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { judge, samples } from "./gate.ts";

const { values: opt, positionals: [run, ref] } = parseArgs({
  allowPositionals: true,
  options: { app: { type: "string" }, turns: { type: "string", default: "10" }, feel: { type: "string", default: fileURLToPath(new URL("feel.ts", import.meta.url)) } },
});
if (!run || !ref || !opt.app) throw new Error("usage: feel-gate.ts RUN REF --app REF_DIR [--turns 10]");

const verdict = () => judge(samples(run), [samples(ref)]);
let { lines, worse, missing } = verdict();
for (const l of lines) console.log(l);
if (missing.length) process.exit(1);
if (!worse.length) process.exit(0);

/** Each measure's group, as feel.ts's output names it. */
const groups: Record<string, string> = {};
for (const l of readFileSync(run, "utf8").split("\n").filter((l) => l.startsWith('{"opt"'))) Object.assign(groups, JSON.parse(l).groups ?? {});
const again = [...new Set(worse.map((k) => groups[k]))];
if (again.some((g) => !g)) {
  console.log(`no group to measure again for ${worse.filter((k) => !groups[k]).join(", ")}`);
  process.exit(1);
}
console.log(`\nworse: ${worse.join(", ")}; measuring ${again.join(", ")} again for ${opt.turns} turns`);
const feel = (args: string[], to: string) => {
  const r = spawnSync("node", [opt.feel, "--runs", "1", "--only", again.join(","), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(r.stdout);
  appendFileSync(to, r.stdout);
  if (r.status !== 0) throw new Error(`feel.ts ${args.join(" ")} exited ${r.status}`);
};
for (let t = 0; t < Number(opt.turns); t++) {
  feel(["--app", opt.app], ref);
  feel([], run);
}
({ lines, worse, missing } = verdict());
console.log("");
for (const l of lines) console.log(l);
process.exit(worse.length + missing.length ? 1 : 0);
