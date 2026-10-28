#!/usr/bin/env node
// Each failed run of a night beside its control, a run of the same case that passed on another pair, device by device:
// where their recordings part, and what only the failure has, which is where to look; what both have is noise. As
// Markdown, for the nightly summary: node scripts/controls.ts DIR... >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Entry, Recording } from "../web/flight.ts";

interface Run {
  dir: string;
  case: string;
  pair: string[];
  verdict: string;
  error?: string;
}

/** An entry as what it says happened, not when or where: a kind, what, and the branch a decision took. */
const sign = ([, kind, what, data]: Entry) =>
  `${kind} ${what}${data?.path ? ` ${data.path}/${data.why}` : ""}${data?.action ? ` ${data.action}` : ""}`;

export function compare(failed: Recording, control: Recording) {
  const f = failed.entries.map(sign), c = control.entries.map(sign);
  const at = f.findIndex((s, i) => s !== c[i]);
  const end = at < 0 && f.length !== c.length ? Math.min(f.length, c.length) : at;
  const parts = end < 0 ? null : { at: end, failed: f[end] ?? "(its end)", control: c[end] ?? "(its end)" };
  const seen = new Set(c);
  return { parts, only: [...new Set(f.filter((s) => !seen.has(s)))] };
}

function* runs(dir: string): Generator<Run> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* runs(path);
    else if (name === "case.json") yield { dir: dirname(path), ...JSON.parse(readFileSync(path, "utf8")) };
  }
}

const recording = (r: Run, i: number): Recording | null => {
  const path = join(r.dir, `d${i} ${r.pair[i]} flight.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Recording : null;
};

export function report(...dirs: string[]): string {
  const all = dirs.flatMap((d) => existsSync(d) ? [...runs(d)] : []);
  const failed = all.filter((r) => r.verdict !== "passed");
  if (!failed.length) return "";
  const out = ["## Failures against their controls", "",
    "Where each failed run's recordings part from those of a run of its case that passed, and what only the failure has.", ""];
  for (const f of failed) {
    const passed = all.filter((r) => r.case === f.case && r.verdict === "passed");
    // the same device acting, where a run of it passed
    const control = passed.find((r) => r.pair[0] === f.pair[0]) ?? passed[0];
    out.push(`### ${f.case}`, "");
    const why = f.error ? `: ${f.error.split("\n")[0]!.slice(0, 200)}` : "";
    if (!control) {
      out.push(`\`${f.pair.join(" → ")}\` ${f.verdict}${why}; no run of it passed to compare with.`, "");
      continue;
    }
    out.push(`\`${f.pair.join(" → ")}\` ${f.verdict}${why}, against \`${control.pair.join(" → ")}\`, which passed.`, "");
    f.pair.forEach((kind, i) => {
      const a = recording(f, i), b = recording(control, i);
      // an app that recorded nothing where the control's did never ran, or never answered: that is the signal
      if (!a && b) return out.push(`- d${i} ${kind}: the failure's app recorded nothing, the control's ${b.entries.length} entries`);
      if (!a || !b) return out.push(`- d${i} ${kind}: no recording to compare`);
      const c = compare(a, b);
      if (!c.parts) return out.push(`- d${i} ${kind}: alike`);
      out.push(`- d${i} ${kind}: parts at entry ${c.parts.at}, \`${c.parts.failed}\` where the control has \`${c.parts.control}\``
        + (c.only.length ? `; only the failure has ${c.only.slice(0, 12).map((s) => `\`${s}\``).join(", ")}` : ""));
    });
    out.push("");
  }
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(report(...process.argv.slice(2)));
