#!/usr/bin/env node
// Convergence fuzzing: web and Swift devices edit one board against sync.php, the relay and direct channels over
// simulated networks, then must end the same. See docs/superpowers/specs/2026-10-10-breezy-convergence-fuzzing-design.md.
//   node scripts/fuzz.mjs [--seeds 1-50] [--steps 300] [--web 2] [--swift 2] [--profile mixed] [--no-restore] [--no-faults]
//                         [--plant NAME] [--replay build/fuzz/SEED.json] [--verbose]
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Hub } from "./fuzz/hub.mjs";

const { values: a } = parseArgs({
  options: {
    seeds: { type: "string", default: "1-10" }, steps: { type: "string", default: "300" }, web: { type: "string", default: "2" },
    swift: { type: "string", default: "2" }, profile: { type: "string", default: "mixed" }, "no-restore": { type: "boolean" },
    "no-faults": { type: "boolean" }, plant: { type: "string" }, verbose: { type: "boolean" },
  },
});

const seeds = a.seeds.split(",").flatMap((r) => {
  const [lo, hi = lo] = r.split("-").map(Number);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
});
const opts = {
  steps: Number(a.steps), web: Number(a.web), swift: Number(a.swift), profile: a.profile, restore: !a["no-restore"], faults: !a["no-faults"],
  plant: a.plant ?? null, log: a.verbose ? (...x) => console.error(...x) : () => {},
};

let failed = 0;
for (const seed of seeds) {
  const started = performance.now();
  const r = await new Hub({ ...opts, seed }).run();
  const s = ((performance.now() - started) / 1000).toFixed(1);
  if (r.ok) {
    console.log(`seed ${seed}: ok in ${s} s, ${r.cards} cards, ${r.stats.requests} requests, ${r.stats.frames} frames, hash ${r.hash}`);
    continue;
  }
  failed++;
  mkdirSync("build/fuzz", { recursive: true });
  const file = `build/fuzz/${seed}.json`;
  writeFileSync(file, JSON.stringify({ seed, opts: { ...opts, log: undefined }, problems: r.problems, trace: r.trace }, null, 1));
  console.log(`seed ${seed}: FAILED in ${s} s, see ${file}`);
  for (const p of r.problems.slice(0, 8)) console.log(`  ${JSON.stringify(p)}`);
}
console.log(`${seeds.length - failed} of ${seeds.length} seeds converged`);
process.exitCode = failed ? 1 : 0;
