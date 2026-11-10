// The fixture appkit-edge.test.ts compares on: each stroke's AppKit curve, how far AppKit's own replay of it landed,
// and what Firefox made of the same events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixture, isStray } from "../reference-fixture.ts";
import type { Capture, Stroke } from "../replay.ts";

/** A push `p` pt past the left edge, lifted at 200 ms. */
const push = (name: string, p: number): Stroke => ({
  name, stage: [1158, 864], start: [0, 762],
  events: [[0, -2, 0, 1, 0], [200, -1, 0, 8, 0], [300, -1, 0, 0, 4]],
  frames: [[0, 0, 762], [100, -p / 2, 762], [200, -p, 762], [400, 0, 762]],
});
const capture: Capture = { stage: [1158, 864], from: [1194, 432, 1], events: [[0, -2, 0], [200, -1, 0]] };

test("a case keeps its AppKit curve, how far AppKit's replay of it landed, and Firefox's events", () => {
  const f = buildFixture([{ file: "push-hold-3.json", recorded: push("push-hold", 40), replayed: push("push-hold-replay", 43), firefox: capture }]);
  assert.equal(f.cases.length, 1);
  const c = f.cases[0];
  assert.deepEqual([c.name, c.stage, c.from, c.lift], ["push-hold-3", { w: 1158, h: 864 }, { x: 1194, y: 432, zoom: 1 }, 200]);
  assert.deepEqual(c.appkit[2], [200, 1234, 432]);
  assert.deepEqual(c.noise, { stretch: 3, overshoot: 3, settle: 0, gap: 3 });
  assert.deepEqual(c.firefox, capture.events);
});

test("Firefox's events start at AppKit's first event with a delta, as one without makes no wheel event", () => {
  const r = push("push-hold", 40);
  r.events = [[0, 0, 0, 32, 0], [30, 0, 0, 1, 0], ...r.events.map(([t, ...e]) => [t + 40, ...e])];
  const c = buildFixture([{ file: "p.json", recorded: r, replayed: r, firefox: capture }]).cases[0];
  assert.deepEqual(c.firefox.map(([t]) => t), [40, 240]);
});

test("a touch or a momentum tail that moved nothing is a stray, not a stroke", () => {
  assert.equal(isStray(push("p", 30)), true, "3 events");
  const many = (dx: number, moved: number): Stroke => ({ ...push("p", 0), events: Array.from({ length: 12 }, (_, i) => [i * 8, dx, 0, 0, 4]), frames: [[0, 615, 762], [100, 615 - moved, 762]] });
  assert.equal(isStray(many(1, 0)), true, "nothing moved");
  assert.equal(isStray(many(3, 20)), false);
});
