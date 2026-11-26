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
