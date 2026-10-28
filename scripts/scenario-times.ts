#!/usr/bin/env node
// A night's runs under DIR as samples for gate.ts, which holds them against another night's: how long each case that
// passed took on its pair, and per run how far each device's page fell short of 60 frames a second, for what something
// new on the runner costs, as video does:
//   node scripts/scenario-times.ts DIR > with.json && node scripts/gate.ts with.json without.json
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runs } from "./controls.ts";

export function times(dir: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const add = (k: string, v: number) => (out[k] ??= []).push(v);
  for (const r of runs(dir)) {
    if (r.verdict !== "passed") continue;
    add(`${r.case} (${r.pair.join(" → ")})`, (r as { ms?: number }).ms ?? 0);
    const timeline = join(r.dir, "timeline.txt");
    if (!existsSync(timeline)) continue;
    const short: Record<string, number[]> = {};
    for (const [, kind, n] of readFileSync(timeline, "utf8").matchAll(/ d\d (\S+)\s+page frames (\d+)/g)) (short[kind!] ??= []).push(Math.max(0, 60 - Number(n)));
    for (const [kind, xs] of Object.entries(short)) add(`frames short of 60 a second: ${kind}`, xs.reduce((s, x) => s + x, 0) / xs.length);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify({ results: times(process.argv[2]!) }));
