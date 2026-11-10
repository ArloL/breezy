// The measures a stroke at the board's edge is compared on, against AppKit's (appkit-edge.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromClip, gap, measure, pastEdge, referenceLimits, sideOf } from "./helpers/measures.ts";
import type { Curve } from "./helpers/measures.ts";

const L = referenceLimits({ w: 1200, h: 762 });

test("referenceLimits at 1200 × 762 are x 6..1194, y −432..1194", () => {
  assert.deepEqual(L, { x0: 6, x1: 1194, y0: -432, y1: 1194 });
});

test("fromClip maps clip 0 to the left limit", () => {
  assert.deepEqual(fromClip([[0, 0, 813], [8, -20, 813]]), [[0, 1194, 381], [8, 1214, 381]]);
});

/** Up 0 → 40 pt past the left limit by 200 ms, the lift; back under 0.5 pt at 420 ms; still to 600. */
const pull: Curve = [];
for (let t = 0; t <= 600; t += 4) {
  const p = t <= 200 ? (40 * t) / 200 : t <= 422 ? 40 * (1 - (t - 200) / 222) : 0;
  pull.push([t, L.x1 + p, 381]);
}

test("measure of a hand-built curve", () => {
  assert.deepEqual(measure(pull, L, 200), { stretch: 40, overshoot: 40, settle: 420 });
});

test("pastEdge picks the axis crossed furthest", () => {
  const drift: Curve = [[0, L.x1, 381], [8, L.x1 + 30, 381 + 10], [16, L.x1 + 20, 381 + 20]];
  assert.deepEqual(pastEdge(drift, L), [[0, 0], [8, 30], [16, 20]]);
  const down: Curve = [[0, 600, L.y0], [8, L.x1 + 20, L.y0 - 50]];
  assert.deepEqual(pastEdge(down, L), [[0, 0], [8, 50]]);
});

test("pastEdge is negative inside the edge", () => {
  assert.deepEqual(pastEdge([[0, L.x1 - 100, 381], [8, L.x1 + 5, 381]], L), [[0, -100], [8, 5]]);
});

test("gap of a curve with itself is 0, and with one shifted 10 pt is 10", () => {
  assert.equal(gap(pull, pull, L), 0);
  assert.equal(gap(pull, pull.map(([t, x, y]) => [t, x + 10, y]), L), 10);
});

test("gap leaves out the travel more than 50 pt inside the edge, where a few ms is many points", () => {
  const a: Curve = [[0, L.x1 - 300, 381], [8, L.x1 - 40, 381], [16, L.x1 + 10, 381], [24, L.x1, 381]];
  const b: Curve = [[0, L.x1 - 200, 381], [8, L.x1 - 45, 381], [16, L.x1 + 10, 381], [24, L.x1, 381]];
  assert.equal(gap(a, b, L), 5);
});

test("a curve measured on another's edge: WheelPan on AppKit's, though it goes further past the other", () => {
  const appkit: Curve = [[0, L.x0 - 45, 381], [8, L.x1 + 39, 381], [16, L.x1, 381]];
  const web: Curve = [[0, L.x0 - 40, 381], [8, L.x1 + 227, 381], [16, L.x1, 381]];
  assert.equal(measure(web, L, 0, sideOf(appkit, L)).stretch, 40);
});
