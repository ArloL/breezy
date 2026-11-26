// The owner's recorded strokes come in sets, each with AppKit's own recording and replay of every stroke: the 41 pinches
// of 2026-11-24 (fixtures/mac-pinch) and the 16 pans of 2026-11-26 (fixtures/mac-pans), whose captures in a browser are
// the builds named pans-<commit>.
import { REPLAYED, track } from "./check.ts";
import { pathGap } from "./gaps.ts";

/** The set a capture build's strokes belong to: its fixtures' folder, with reference/ and reference-replay/ in it. */
export const setOf = (fixtures: string, build: string) => `${fixtures}${build.startsWith("pans-") ? "mac-pans" : "mac-pinch"}/`;

/** A stroke's own path tolerance: twice how far AppKit's replay of it travelled otherwise than the owner's recording, as a
 * flick's coast replays up to 12 % short, and never under REPLAYED.path. */
export function pathTolerance(set: string, stroke: string): number {
  return Math.max(REPLAYED.path, 2 * pathGap(track(`${set}reference-replay/${stroke}.json`), track(`${set}reference/${stroke}.json`)));
}
