#!/usr/bin/env node
// Whether the real devices (TESTING.md, L6) keep to their flake budget: under 1 failure in 1,000 case runs, over the soak
// records under DIRS (each run's case.json, as the soaks upload them; .github/workflows/flake-budget.yaml downloads the
// last 30 days'). node scripts/flake-budget.ts DIR... fails when over it, and says so when too few runs to tell.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUDGET = 0.001;

interface Run {
  case: string;
  pair: string[];
  verdict: string;
}

/** Whether `runs` keep to `budget`, as a share of runs that fail; a rate that small needs 1 / budget runs to tell. */
export function judge(runs: Run[], budget = BUDGET) {
  const failed = runs.filter((r) => r.verdict !== "passed").length;
  const verdict = runs.length < 1 / budget ? "too few" : failed / runs.length > budget ? "over" : "within";
  return { runs: runs.length, failed, verdict };
}

function* records(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* records(path);
    else if (name === "case.json") yield path;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runs: Run[] = process.argv.slice(2).filter(existsSync).flatMap((d) => [...records(d)]).map((f) => JSON.parse(readFileSync(f, "utf8")));
  const j = judge(runs);
  const worst = Object.entries(Object.groupBy(runs.filter((r) => r.verdict !== "passed"), (r) => `${r.case} (${r.pair.join(" → ")})`))
    .map(([k, v]) => [k, v!.length] as const).sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`L6: ${j.failed} of ${j.runs} case runs failed, against a budget of ${BUDGET * 1000} in 1,000: ${j.verdict}`);
  for (const [k, n] of worst) console.log(`  ${n} × ${k}`);
  process.exitCode = j.verdict === "over" ? 1 : 0;
}
