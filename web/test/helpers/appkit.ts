import { gap, measure, referenceLimits, sideOf } from "./measures.ts";
import type { Curve } from "./measures.ts";
import { replay } from "./replay.ts";
import type { Case } from "../../../scripts/reference-fixture.ts";

export const FLOOR = { stretch: 2, overshoot: 2, settle: 16, gap: 2 };
export const KEYS = ["stretch", "overshoot", "settle", "gap"] as const;

/** What `curve` did with a case against AppKit, on each measure: by default WheelPan's, given Firefox's events. */
export function compare(c: Case, curve?: Curve) {
  const l = referenceLimits(c.stage);
  const other = curve ?? replay({ name: c.name, stage: c.stage, from: c.from, restsAt: { x: 0, y: 0 }, events: c.firefox }, l).track;
  // both on the edge AppKit went furthest past, as a curve crossing both edges may go further past the other
  const side = sideOf(c.appkit, l);
  const a = { ...measure(c.appkit, l, c.lift, side), gap: 0 }, w = { ...measure(other, l, c.lift, side), gap: gap(c.appkit, other, l) };
  return KEYS.map((k) => ({ k, appkit: a[k], wheelpan: w[k], within: Math.max(FLOOR[k], c.noise[k]), off: Math.abs(a[k] - w[k]) }));
}
