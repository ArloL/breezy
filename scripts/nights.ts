#!/usr/bin/env node
// A night held to the one before by what each device did in each case that passed on both: how often it took each
// decision, went through each transition and took each gesture. A case's input is the same each night, so a count that
// changed is behaviour that moved before anything failed; geometry and timing move with the runner and are left out.
// As Markdown for the nightly summary, a report while it proves itself:
//   node scripts/nights.ts LAST_NIGHT_DIR THIS_NIGHT_DIR >> "$GITHUB_STEP_SUMMARY"
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recording, runs, sign, type Run } from "./controls.ts";

const COUNTED = new Set(["decision", "transition", "input"]);

function counts(r: Run, i: number): Map<string, number> {
  const m = new Map<string, number>();
  // a reveal is noted again as the board's area changes, which the keyboard's timing decides, not the case
  for (const e of recording(r, i)?.entries ?? []) if (COUNTED.has(e[1]) && e[2] !== "reveal") m.set(sign(e), (m.get(sign(e)) ?? 0) + 1);
  return m;
}

/** A case whose input is drawn anew each night, by a seed of its own. */
const random = (r: Run) => /at random/.test(r.case);

export function report(lastDir: string, thisDir: string): string {
  const passed = (dir: string) => existsSync(dir) ? [...runs(dir)].filter((r) => r.verdict === "passed") : [];
  const last = passed(lastDir);
  const out: string[] = [];
  for (const now of passed(thisDir).filter((r) => !random(r))) {
    const then = last.find((r) => r.case === now.case && r.pair.join() === now.pair.join());
    if (!then) continue;
    const lines = now.pair.flatMap((kind, i) => {
      const a = counts(then, i), b = counts(now, i);
      const moved = [...new Set([...a.keys(), ...b.keys()])].sort()
        .filter((s) => (a.get(s) ?? 0) !== (b.get(s) ?? 0)).map((s) => `\`${s}\` ${a.get(s) ?? 0} → ${b.get(s) ?? 0}`);
      return moved.length ? [`- d${i} ${kind}: ${moved.slice(0, 12).join(", ")}`] : [];
    });
    if (lines.length) out.push(`### ${now.case} (${now.pair.join(" → ")})`, "", ...lines, "");
  }
  if (!out.length) return "";
  return ["## Against the last night", "",
    "What a device did a different number of times than on the night before, in a case that passed on both.", "", ...out].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(report(process.argv[2]!, process.argv[3]!));
