// Whether a stroke replayed into the reference app (scripts/replay.ts) did what AppKit did with the owner's: the same
// deltas, and each measure within the spread of the owner's own repeats. Until it does, nothing is compared with it.
//
//   node scripts/reference-check.ts <recorded.json> <replayed.json> [--repeats <glob>]
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromClip, gap, measure, referenceLimits } from "../web/test/helpers/measures.ts";
import type { Measures } from "../web/test/helpers/measures.ts";
import type { Stroke } from "./replay.ts";

const FLOOR: Measures = { stretch: 2, overshoot: 2, settle: 16 };

/** When the finger lifted: the last event with a finger's phase, in ms. */
export const liftOf = (s: Stroke) => s.events.findLast((e) => e[3] !== 0)?.[0] ?? 0;

export const measuresOf = (s: Stroke) => {
  const l = referenceLimits({ w: s.stage[0], h: s.stage[1] });
  return measure(fromClip(s.frames), l, liftOf(s));
};

// AppKit merges events that come close together: a push's 539 events arrived as 495, its running totals within 4 pt of
// the recording's; a merge moves them by up to a whole event, which in a flick is 100 to 350 pt
const DRIFT = 8;

/** Whether `b`'s deltas add up as `a`'s did, over time and in all. */
function deltas(a: Stroke, b: Stroke): string[] {
  const sum = (s: Stroke, i: 1 | 2, t = Infinity) => s.events.reduce((n, e) => (e[0] <= t ? n + e[i] : n), 0);
  for (const i of [1, 2] as const) {
    const ta = sum(a, i), tb = sum(b, i), axis = i === 1 ? "x" : "y";
    if (ta * tb < 0 && Math.abs(ta) > 1) return [`the sign differs on ${axis}: ${ta.toFixed(1)} recorded, ${tb.toFixed(1)} replayed`];
    if (Math.abs(ta - tb) > 1) return [`the deltas on ${axis} add up to ${ta.toFixed(1)} recorded, ${tb.toFixed(1)} replayed`];
    const end = Math.max(a.events.at(-1)?.[0] ?? 0, b.events.at(-1)?.[0] ?? 0);
    const most = Math.max(DRIFT, ...a.events.map((e) => Math.abs(e[i])), ...b.events.map((e) => Math.abs(e[i])));
    for (let t = 0; t <= end; t += 8) {
      const d = Math.abs(sum(a, i, t) - sum(b, i, t));
      if (d > most) return [`the deltas on ${axis} drift ${d.toFixed(1)} pt apart by ${t} ms`];
    }
  }
  return [];
}

export function check(recorded: Stroke, replayed: Stroke, repeats: Stroke[]) {
  const errors = deltas(recorded, replayed);
  const a = measuresOf(recorded), b = measuresOf(replayed), all = repeats.map(measuresOf);
  const lines: string[] = [];
  const tol = {} as Measures;
  for (const k of Object.keys(FLOOR) as (keyof Measures)[]) {
    const vs = all.map((m) => m[k]);
    tol[k] = Math.max(FLOOR[k], vs.length ? Math.max(...vs) - Math.min(...vs) : 0);
    const bad = Math.abs(a[k] - b[k]) > tol[k];
    lines.push(`${k.padEnd(9)} recorded ${a[k].toFixed(1)}, replayed ${b[k].toFixed(1)}, within ${tol[k].toFixed(1)}${bad ? "  ✗" : ""}`);
    if (bad) errors.push(`${k} differs by ${Math.abs(a[k] - b[k]).toFixed(1)}`);
  }
  const g = gap(fromClip(recorded.frames), fromClip(replayed.frames), referenceLimits({ w: recorded.stage[0], h: recorded.stage[1] }));
  lines.push(`gap       ${g.toFixed(1)} pt, within ${tol.overshoot.toFixed(1)}${g > tol.overshoot ? "  ✗" : ""}`);
  if (g > tol.overshoot) errors.push(`the curves are ${g.toFixed(1)} pt apart`);
  return { ok: errors.length === 0, lines: [...lines, ...errors] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf("--repeats");
  const [recorded, replayed] = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (!recorded || !replayed) {
    console.error("usage: node scripts/reference-check.ts <recorded.json> <replayed.json> [--repeats <glob>]");
    process.exit(2);
  }
  const read = (f: string): Stroke => JSON.parse(readFileSync(f, "utf8"));
  const r = check(read(recorded), read(replayed), at < 0 ? [] : globSync(args[at + 1]).map(read));
  console.log(r.lines.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
