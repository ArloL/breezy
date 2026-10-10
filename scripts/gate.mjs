#!/usr/bin/env node
// Fails when a measure got worse: its mean's 95 % CI lies wholly above the CI of every baseline, runs recorded on the same
// kind of machine, whose spread from one machine to the next the envelope takes in. Every measure is lower-is-better.
// Takes feel.mjs's output, whose last line holds its samples, or bench.sh's build/bench.jsonl, as the run and baselines.
//   node scripts/gate.mjs RUN BASELINE...
import { readFileSync } from "node:fs";

// as bench-summary.py
const BENCH = ["launch_ms", "idle.mb", "hidden.mb", "peak_mb", "zoom.p95_ms", "zoom.max_ms", "pan.p95_ms", "pan.max_ms", "drag.p95_ms", "drag.max_ms", "type.p95_ms", "type.max_ms", "zoom.cpu_ms"];

/** Measure → samples. */
function samples(path) {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  if (path.endsWith(".jsonl")) {
    const out = {};
    for (const { board, r } of lines.map((l) => JSON.parse(l)))
      for (const k of BENCH) {
        const [a, b] = k.split(".");
        const x = b ? r[a]?.[b] : r[a];
        if (x !== undefined) (out[`${board}: ${k}`] ??= []).push(x);
      }
    return out;
  }
  return JSON.parse(lines.at(-1)).results;
}

const T = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09];
function ci(xs) {
  const n = xs.length, m = xs.reduce((s, x) => s + x, 0) / n;
  const h = n < 2 ? 0 : ((T[n - 2] ?? 1.96) * Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1))) / Math.sqrt(n);
  return { m, lo: m - h, hi: m + h, text: `${m.toFixed(1)} ± ${h.toFixed(1)}` };
}

const [run, ...baselines] = process.argv.slice(2).map(samples);
let worse = 0;
for (const k of new Set(baselines.flatMap(Object.keys))) {
  if (!run[k]) {
    console.log(`${k}: not measured`);
    worse++;
    continue;
  }
  const bs = baselines.filter((b) => b[k]).map((b) => ci(b[k])), r = ci(run[k]);
  const lo = Math.min(...bs.map((b) => b.lo)), hi = Math.max(...bs.map((b) => b.hi));
  const verdict = r.lo > hi ? "WORSE" : r.hi < lo ? "better: record new baselines" : "ok";
  if (verdict === "WORSE") worse++;
  console.log(`${k.padEnd(48)} ${r.text.padStart(16)} against ${`${lo.toFixed(1)} to ${hi.toFixed(1)}`.padEnd(18)} ${verdict}`);
}
process.exit(worse ? 1 : 0);
