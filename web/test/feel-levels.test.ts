// Calibration (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md, Task 4): a cheaper level is trusted only while
// it moves the board as real input did, for the same stroke in the same mode. Level 2, the web core in Node, holds to
// level 4's camera-mode captures, which it replays; level 3's Firefox holds to the native captures in
// scenarios/strokes.e2e.ts. A stroke that drifts is the fake taught when it was wrong (AGENTS.md): capture it again
// with node scripts/web-fixture.ts --build <name> --pan camera --list <strokes>, then see what moved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { replayCapture } from "./helpers/stroke-replay.ts";
import { track } from "../../scripts/frames/check.ts";
import { curve } from "../../scripts/frames/rules.ts";

const fixtures = new URL("../../scripts/test/fixtures/web-pinch/", import.meta.url).pathname;
/** The captures level 2 calibrates against: camera mode, with each stroke's own repeat spread beside them. */
const BUILD = "main-ae48c1b-camera";
/** Never under AppKit's replays' own error, as Firefox's spread is far under it for some strokes. */
const FLOOR = 0.12;
setTimeout(() => { console.error("feel-levels ran past 60 s"); process.exit(1); }, 60_000).unref();

/** How far, at worst, `a`'s zoom parted from `b`'s, both aligned at their first input. */
export const zoomGap = (a: ReturnType<typeof track>, b: ReturnType<typeof track>) =>
  Math.max(0, ...curve(a, b, "zoom", 0).map((f) => Number(/up to ([0-9.]+)/.exec(f.say)?.[1] ?? 0)));

test("each level calibrates against its own mode's capture: level 2's zoom stays within each stroke's repeat spread of camera mode's", () => {
  const spread: Record<string, number> = JSON.parse(readFileSync(`${fixtures}${BUILD}-spread.json`, "utf8"));
  const drifted: string[] = [];
  for (const f of readdirSync(`${fixtures}${BUILD}`).sort()) {
    const s = f.replace(".json", ""), capture = track(`${fixtures}${BUILD}/${f}`);
    const gap = zoomGap(replayCapture(capture), capture), tol = Math.max(FLOOR, spread[s] ?? 0);
    if (gap > tol) drifted.push(`${s} ${gap.toFixed(3)} past ${tol}`);
  }
  assert.deepEqual(drifted, [], "level 2 moved otherwise than the real input it replays: the fake is wrong, or the capture is stale");
});

test("a level that drifts fails calibration", () => {
  // the same capture, the replay's zoom moved 0.3 off: as a WheelPan changed under level 2 would
  const capture = track(`${fixtures}${BUILD}/pinch-out-slow-1.json`), out = replayCapture(capture), z = out.fields.indexOf("zoom");
  const shifted = { fields: out.fields, rows: out.rows.map((r) => r.map((v, i) => (i === z && v != null ? v + 0.3 : v))) };
  assert.ok(zoomGap(shifted, capture) > FLOOR);
});
