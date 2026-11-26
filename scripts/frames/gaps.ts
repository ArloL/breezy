// How far one track of a stroke parted from another, for calibrating a level against the one above it
// (web/test/feel-levels.test.ts, scenarios/strokes.e2e.ts).
import { curve } from "./rules.ts";
import type { FrameTrack } from "../../web/flight.ts";

/** How far, at worst, `a`'s zoom parted from `b`'s, both aligned at their first input, within `slackMs` either way. */
export const zoomGap = (a: FrameTrack, b: FrameTrack, slackMs = 0) =>
  Math.max(0, ...curve(a, b, "zoom", 0, slackMs).map((f) => Number(/up to ([0-9.]+)/.exec(f.say)?.[1] ?? 0)));

/** How far apart, in view pt, `a` and `b` came to rest. */
export const restGap = (a: FrameTrack, b: FrameTrack) => {
  const last = (t: FrameTrack, k: string) => t.rows.at(-1)![t.fields.indexOf(k)] ?? 0;
  return Math.hypot(last(a, "camX") - last(b, "camX"), last(a, "camY") - last(b, "camY")) * last(b, "zoom");
};
