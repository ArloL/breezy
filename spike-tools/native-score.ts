// Scores Firefox's own scrolling, captured by native.ts, against AppKit as appkit-score.ts scores WheelPan.
import { existsSync, readFileSync } from "node:fs";
import { compare, KEYS } from "/Users/arlookeeffe/Developer/breezy/web/test/helpers/appkit.ts";
import { MARGIN } from "/Users/arlookeeffe/Developer/breezy/web/camera.ts";
import type { Curve } from "/Users/arlookeeffe/Developer/breezy/web/test/helpers/measures.ts";
const f = JSON.parse(readFileSync("web/test/appkit-edge.json", "utf8"));
/** The board's clip origin over time on AppKit's clock: inside, the page's scroll position; past the left edge, the bar. */
export function nativeCurve(name: string): Curve | null {
  const p = `build/reference/native/${name}.json`;
  if (!existsSync(p)) return null;
  const { page, bar } = JSON.parse(readFileSync(p, "utf8"));
  const s = JSON.parse(readFileSync(`build/reference/${name}.json`, "utf8"));
  const offset = s.events.find((e: number[]) => e[1] || e[2])?.[0] ?? 0;
  const frames: number[][] = page.frames.map(([t, x, y]: number[]) => [t + offset, x, y]);
  // the bar first leaves the edge when the page first stands at it with the board moving out
  const atEdge = frames.find(([, x]) => x <= 0.5)?.[0];
  const seen = (bar as (number | null)[][]).filter(([, x]) => x !== null) as number[][];
  const moves = seen.find(([, x]) => x > 0.5)?.[0];
  if (atEdge === undefined || moves === undefined) return frames.map(([t, x, y]) => [t, MARGIN - x, MARGIN - y]);
  // a recording gets a frame only when the screen changes: between them the bar stands where it was last seen
  const shift = atEdge - moves, barAt = (t: number) => Math.max(0, seen.findLast(([u]) => u + shift <= t)?.[1] ?? 0);
  const merged = frames.map(([t, x, y]) => [t, x > 0.5 ? x : -barAt(t), y]);
  merged.sort((a, b) => a[0] - b[0]);
  return merged.map(([t, x, y]) => [t, MARGIN - x, MARGIN - y]);
}
let n = 0; const ok: Record<string, number> = {}, offs: Record<string, number[]> = {};
for (const c of f.cases) {
  const curve = nativeCurve(c.name);
  if (!curve) continue;
  n++;
  for (const m of compare(c, curve)) { (offs[m.k] ??= []).push(m.off); if (m.off <= m.within) ok[m.k] = (ok[m.k] ?? 0) + 1; }
}
const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
console.log(`native, ${n} cases: within noise ${KEYS.map((k) => `${k} ${ok[k] ?? 0}`).join(", ")}; median off ${KEYS.map((k) => `${k} ${median(offs[k] ?? [0]).toFixed(0)}`).join(", ")}`);
