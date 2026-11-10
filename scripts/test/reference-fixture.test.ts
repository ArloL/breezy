// The fixture appkit-edge.test.ts compares on: each stroke's AppKit curves and what Firefox made of the same events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixture, median } from "../reference-fixture.ts";
import type { Stroke } from "../replay.ts";

/** A push `p` pt past the left edge, lifted at 200 ms. */
const push = (name: string, p: number): Stroke => ({
  name, stage: [1200, 762], start: [0, 813],
  events: [[0, -2, 0, 1, 0], [200, -1, 0, 8, 0], [300, -1, 0, 0, 4]],
  frames: [[0, 0, 813], [100, -p / 2, 813], [200, -p, 813], [400, 0, 813]],
});
const capture = { stage: [1200, 762], from: [1194, 381, 1], events: [[0, -2, 0], [200, -1, 0]] as [number, number, number][] };

test("the median repeat, by overshoot, is the one replayed", () => {
  assert.equal(median([push("a", 30), push("a", 50), push("a", 40)]).frames[2][1], -40);
});

test("a fixture keeps each stroke's median curve, all its repeats and Firefox's events, without replays", () => {
  const f = buildFixture([push("push-hold", 30), push("push-hold", 50), push("push-hold", 40), push("push-hold-replay", 40)], { "push-hold": capture });
  assert.equal(f.strokes.length, 1);
  const s = f.strokes[0];
  assert.deepEqual([s.name, s.stage, s.from, s.lift], ["push-hold", { w: 1200, h: 762 }, { x: 1194, y: 381, zoom: 1 }, 200]);
  assert.deepEqual(s.appkit[2], [200, 1234, 381]);
  assert.equal(s.repeats.length, 3);
  assert.deepEqual(s.firefox, capture.events);
});

test("a stroke with no Firefox capture is named", () => {
  assert.throws(() => buildFixture([push("flick-fast", 30)], {}), /flick-fast/);
});

import { isStray } from "../reference-fixture.ts";

test("a touch or a momentum tail that moved nothing is a stray, not a stroke", () => {
  assert.equal(isStray(push("p", 30)), true, "3 events");
  const many = (dx: number, moved: number): Stroke => ({ ...push("p", 0), events: Array.from({ length: 12 }, (_, i) => [i * 8, dx, 0, 0, 4]), frames: [[0, 615, 762], [100, 615 - moved, 762]] });
  assert.equal(isStray(many(1, 0)), true, "nothing moved");
  assert.equal(isStray(many(3, 20)), false);
});
