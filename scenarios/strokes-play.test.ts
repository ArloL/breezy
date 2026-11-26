// How level 3 turns a capture's rows into the browser input it can send in time (scenarios/strokes-play.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputSpan, merge } from "./strokes-play.ts";

const fields = ["t", "px", "py", "wheelDX", "wheelDY", "magnify"];

test("rows due at once go as one step: their pans summed, the browser's way round", () => {
  const s = merge(fields, [[0, 10, 20, 3, -4, 0], [8, 12, 22, 1, -2, 0]]);
  assert.deepEqual(s.pan, { dx: -4, dy: 6 });
  assert.deepEqual(s.at, { x: 12, y: 22 });
  assert.deepEqual(s.zoom, []);
});

test("a pinch's rows due at once go as ⌃-wheel steps of at most 25, as the app takes each step only so far", () => {
  // three frames of zoom × 0.8 each: ln(0.8³)/0.01 is −66.9 of deltaY, the other way round, in three steps of 22.3
  const s = merge(fields, [[0, 0, 0, 0, 0, -0.2], [8, 0, 0, 0, 0, -0.2], [16, 0, 0, 0, 0, -0.2]]);
  assert.equal(s.zoom.length, 3);
  assert.ok(s.zoom.every((d) => Math.abs(d - 22.314) < 0.01), `${s.zoom}`);
  assert.equal(s.pan, null);
});

test("a track's input span runs from its first frame with input to its last", () => {
  assert.equal(inputSpan({ fields, rows: [[0, 0, 0, 0, 0, 0], [40, 0, 0, 1, 0, 0], [90, 0, 0, 0, 0, 0.1], [300, 0, 0, 0, 0, 0]] }), 50);
  assert.equal(inputSpan({ fields, rows: [[0, 0, 0, 0, 0, 0]] }), 0);
});
