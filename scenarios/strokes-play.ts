// Level 3's input: a capture's rows as the browser input Playwright can send in time. Each wheel call is a round trip
// to the browser, 11 to 33 ms, where a capture's rows are 8 to 17 ms apart, so the rows due at once go as one step.
import { ZOOM_PER_PT } from "../web/wheel.ts";
import type { FrameTrack } from "../web/flight.ts";

/** The most of a ⌃-wheel's deltaY the app takes in one step (web/wheel.ts's wheelAction). */
const STEP = 25;
const INPUT = ["wheelDX", "wheelDY", "magnify"];

export interface Step {
  /** The pan's deltas, the browser's way round, or null when none. */
  pan: { dx: number; dy: number } | null;
  /** The pinch as ⌃-wheel deltaY, a step each of at most `STEP`. */
  zoom: number[];
  /** Where the last of the rows was, or null. */
  at: { x: number; y: number } | null;
}

/** `rows` of `fields` as one step: their pans summed, AppKit's deltas the browser's way round; their magnifications,
 * each a ⌃-wheel step's zoom less one, as the deltaY that zooms by all of them, cut into steps of at most 25. */
export function merge(fields: string[], rows: (number | null)[][]): Step {
  const v = (r: (number | null)[], k: string) => { const i = fields.indexOf(k); return i >= 0 ? r[i] ?? 0 : 0; };
  let dx = 0, dy = 0, d = 0;
  for (const r of rows) {
    dx -= v(r, "wheelDX");
    dy -= v(r, "wheelDY");
    const m = v(r, "magnify");
    if (m) d += -Math.log(1 + m) / ZOOM_PER_PT;
  }
  const n = Math.ceil(Math.abs(d) / STEP), last = rows.at(-1), px = fields.indexOf("px"), py = fields.indexOf("py");
  return {
    pan: dx || dy ? { dx, dy } : null,
    zoom: Array.from({ length: n }, () => d / n),
    at: last && px >= 0 && last[px] != null ? { x: last[px]!, y: last[py] ?? 0 } : null,
  };
}

/** How long `t`'s input went on, from its first frame with any to its last, in ms. */
export function inputSpan(t: FrameTrack): number {
  const is = INPUT.map((k) => t.fields.indexOf(k)).filter((i) => i >= 0);
  const ts = t.rows.filter((r) => is.some((i) => (r[i] ?? 0) !== 0)).map((r) => r[0] ?? 0);
  return ts.length ? ts.at(-1)! - ts[0]! : 0;
}

/** `m`'s findings as compared with `known`'s, the other side of a ratchet: only of `strokes`, without `slow` itself or
 * any stroke either side took too slowly to judge, as a slower runner takes more so, and without a `borderline`
 * stroke's curve, which synthetic timing moves across its line from run to run. */
export function judged(m: Record<string, string[]>, o: { strokes: string[]; known: Record<string, string[]>; borderline: string[] }) {
  const unjudged = new Set([...(m.slow ?? []), ...(o.known.slow ?? [])]);
  return Object.fromEntries(
    Object.entries(m)
      .filter(([r]) => r !== "slow")
      .map(([r, s]) => [r, s.filter((x) => o.strokes.includes(x) && !unjudged.has(x) && !(r === "curve" && o.borderline.includes(x)))])
      .filter(([, s]) => s.length),
  );
}

/** How often `t`'s browser drew, in ms: the median time between its rows (the owner's Mac 8, CI's runner 17 and more). */
export function frameMs(t: FrameTrack): number {
  const d = t.rows.slice(1).map((r, i) => (r[0] ?? 0) - (t.rows[i]![0] ?? 0)).sort((a, b) => a - b);
  return d.length ? d[(d.length - 1) >> 1]! : 0;
}
