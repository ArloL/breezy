// Calibration (docs/superpowers/plans/2026-11-26-breezy-feel-levels.md, Task 4): a cheaper level is trusted only while
// it moves the board as real input did, for the same stroke in the same mode. Level 2, the web core in Node, replays
// level 4's camera-mode captures, taken of main-ae48c1b's build, and holds to their zoom and to where each came to
// rest; level 3's Firefox holds to the native captures in scenarios/strokes.e2e.ts. Level 2 so finds a change to the
// replay or to the web's zoom and pan paths since that build, not a browser's own change, which only a new capture
// shows: node scripts/web-fixture.ts --build <name> --pan camera --repeats 3 [--list <strokes>].
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { replayCapture } from "./helpers/stroke-replay.ts";
import { track } from "../../scripts/frames/check.ts";
import { restGap, zoomGap } from "../../scripts/frames/gaps.ts";

const fixtures = new URL("../../scripts/test/fixtures/web-pinch/", import.meta.url).pathname;
/** The captures level 2 calibrates against: camera mode, with each stroke's own repeat spread beside them. */
const BUILD = "main-ae48c1b-camera";
/** Never under AppKit's replays' own error, as Firefox's spread is far under it for most strokes: 38 of the 41. */
const FLOOR = 0.12;
/** How far, in view pt, a replay may come to rest from where its capture did: the worst of the 41 is 0.5. */
const REST = 1;
setTimeout(() => { console.error("feel-levels ran past 60 s"); process.exit(1); }, 60_000).unref();


test("each level calibrates against its own mode's capture: level 2's zoom stays within 0.12, or a stroke's repeat spread, of camera mode's, and comes to rest where it did", () => {
  const spread: Record<string, number> = JSON.parse(readFileSync(`${fixtures}${BUILD}-spread.json`, "utf8"));
  const drifted: string[] = [];
  for (const f of readdirSync(`${fixtures}${BUILD}`).sort()) {
    const s = f.replace(".json", ""), capture = track(`${fixtures}${BUILD}/${f}`);
    const gap = zoomGap(replayCapture(capture), capture), tol = Math.max(FLOOR, spread[s] ?? 0);
    if (gap > tol) drifted.push(`${s} zoom ${gap.toFixed(3)} past ${tol}`);
    const rest = restGap(replayCapture(capture), capture);
    if (rest > REST) drifted.push(`${s} rest ${rest.toFixed(1)} pt past ${REST}`);
  }
  assert.deepEqual(drifted, [], "level 2 moved otherwise than the real input it replays: a change to the zoom or pan path, or to the replay, since the captures' build, or a stale capture");
});

test("a level that drifts fails calibration", () => {
  // the same capture, the replay's zoom moved 0.3 off: as a WheelPan changed under level 2 would
  const capture = track(`${fixtures}${BUILD}/pinch-out-slow-1.json`), out = replayCapture(capture), z = out.fields.indexOf("zoom");
  const shifted = { fields: out.fields, rows: out.rows.map((r) => r.map((v, i) => (i === z && v != null ? v + 0.3 : v))) };
  assert.ok(zoomGap(shifted, capture) > FLOOR);
});

test("a replay that comes to rest elsewhere fails calibration, though its zoom matches", () => {
  // pinch-pan-13 never zooms: the replay's camera moved 500 pt, as a wheel's sign or scale broken under level 2 would
  const capture = track(`${fixtures}${BUILD}/pinch-pan-13.json`), out = replayCapture(capture), x = out.fields.indexOf("camX");
  const shifted = { fields: out.fields, rows: out.rows.map((r) => r.map((v, i) => (i === x && v != null ? v + 500 : v))) };
  assert.equal(zoomGap(shifted, capture), 0);
  assert.ok(restGap(shifted, capture) > REST);
  assert.ok(restGap(out, capture) <= REST);
});
