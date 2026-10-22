#!/usr/bin/env node
// Failure rates and timings of the scenario runs recorded under DIRS (each run's build/scenarios/*/case.json, as soaks
// and Main upload them), as Markdown: node scripts/scenario-stats.ts DIR... >> "$GITHUB_STEP_SUMMARY"
// What fails, on which pair and at which step, and which cases and steps run close to their time limits.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface Step { who: string; action: string; ms?: number; error?: string }
interface Run {
  case: string;
  pair: string[];
  verdict: "passed" | "failed" | "timed out";
  error?: string;
  ms: number;
  step?: { who: string; action: string; error: string };
  steps: Step[];
}

function* records(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* records(path);
    else if (name === "case.json") yield path;
  }
}

const runs: Run[] = process.argv.slice(2).filter(existsSync).flatMap((d) => [...records(d)]).map((f) => JSON.parse(readFileSync(f, "utf8")));
const pct = (n: number, of: number) => `${(100 * n / of).toFixed(of >= 1000 ? 2 : 1)} %`;
const quantile = (xs: number[], q: number) => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
const group = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...m.get(key(x)) ?? [], x]);
  return m;
};
const kind = (who: string) => who.replace(/^d\d+ /, "");
const firstLine = (s = "") => s.split("\n")[0]!.replace(/[0-9a-zA-Z_-]{22}/g, "<id>").replace(/\d+(\.\d+)?/g, "N").slice(0, 140);
const out: string[] = [];
const table = (head: string[], rows: (string | number)[][]) => {
  out.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), "");
};

const failed = runs.filter((r) => r.verdict !== "passed");
out.push("## Scenarios", "", `${runs.length} case runs, ${failed.length} failed (${pct(failed.length, runs.length || 1)}).`, "");
if (failed.length) {
  out.push("### Failures by case and pair", "");
  const byCase = group(runs, (r) => `${r.case} (${r.pair.join(" → ")})`);
  table(["case", "failed", "of", "rate"], [...byCase].map(([k, rs]) => [k, rs.filter((r) => r.verdict !== "passed").length, rs.length] as const)
    .filter(([, f]) => f).sort((a, b) => b[1] - a[1]).map(([k, f, n]) => [k, f, n, pct(f, n)]));
  out.push("### Failures by step", "");
  table(["step", "failed"], [...group(failed, (r) => r.step ? `${kind(r.step.who)} ${r.step.action}` : r.verdict)].map(([k, rs]) => [k, rs.length] as [string, number]).sort((a, b) => b[1] - a[1]));
  out.push("### Failures by error", "");
  table(["error", "failed"], [...group(failed, (r) => firstLine(r.step?.error ?? r.error))].map(([k, rs]) => [`\`${k.replace(/[|`]/g, " ")}\``, rs.length] as [string, number]).sort((a, b) => b[1] - a[1]));
}
// a case that takes most of its 90 s, or a step most of its own limit, fails on a slower runner
out.push("### Slowest cases", "");
table(["case", "p50 s", "p95 s", "max s", "runs"], [...group(runs, (r) => `${r.case} (${r.pair.join(" → ")})`)]
  .map(([k, rs]) => [k, rs.map((r) => r.ms)] as const).sort((a, b) => quantile(b[1], 0.95) - quantile(a[1], 0.95)).slice(0, 10)
  .map(([k, ms]) => [k, (quantile(ms, 0.5) / 1000).toFixed(1), (quantile(ms, 0.95) / 1000).toFixed(1), (Math.max(...ms) / 1000).toFixed(1), ms.length]));
out.push("### Slowest steps", "");
const steps = runs.flatMap((r) => r.steps.filter((s) => s.ms !== undefined && s.action !== "wait"));
table(["step", "p50 ms", "p95 ms", "max ms", "count"], [...group(steps, (s) => `${kind(s.who)} ${s.action}`)]
  .map(([k, ss]) => [k, ss.map((s) => s.ms!)] as const).sort((a, b) => quantile(b[1], 0.95) - quantile(a[1], 0.95)).slice(0, 15)
  .map(([k, ms]) => [k, quantile(ms, 0.5), quantile(ms, 0.95), Math.max(...ms), ms.length]));
console.log(out.join("\n"));
