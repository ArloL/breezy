// What the replay helper posts: NSEvent's phases, as the reference app recorded them, in CGEvent's numbering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCGPhases } from "../replay.ts";

test("toCGPhases maps every NSEvent phase", () => {
  for (const [ns, cg] of [[0, 0], [1, 1], [4, 2], [8, 4], [16, 8], [32, 128]]) assert.equal(toCGPhases(ns, 0).scroll, cg, `phase ${ns}`);
  for (const [ns, cg] of [[0, 0], [1, 1], [4, 2], [8, 3]]) assert.equal(toCGPhases(0, ns).momentum, cg, `momentum ${ns}`);
});

test("toCGPhases refuses a phase it does not know", () => {
  assert.throws(() => toCGPhases(2, 0), /phase 2/);
  assert.throws(() => toCGPhases(0, 16), /momentum 16/);
});

import { captureOf } from "../replay.ts";
import type { Stroke } from "../replay.ts";
import type { Recording } from "../../web/flight.ts";

// AppKit's scrollingDeltaX is a browser's deltaX turned round; the stream keeps the pan, the browser's turned round
const posted: Stroke = { name: "push", stage: [1200, 762], start: [0, 813], frames: [], events: [[0, 2, 0, 1, 0], [8, 3, 0, 4, 0], [300, 1, 0, 4, 0], [308, 0, 0, 8, 0]] };
const stream = (at: number, events: number[][]) => ({ at, from: [1194, 381, 1], limits: [6, 1194, -432, 1194], stage: [1200, 762], events, bounced: [] });
const page = (...streams: ReturnType<typeof stream>[]): Recording =>
  ({ schema: 1, origin: 0, dropped: 0, context: null, entries: [[5, "input", "wheel arrives", {}], ...streams.map((s) => [s.at + 500, "input", "wheel", s] as Recording["entries"][number])] });

test("a capture joins a stroke's streams, from its first event, in the browser's deltas", () => {
  const c = captureOf(page(stream(1000, [[0, 2, 0, 1196, 381], [8, 3, 0, 1199, 381]]), stream(1300, [[0, 1, 0, 1200, 381]])), posted);
  assert.deepEqual(c, { stage: [1200, 762], from: [1194, 381, 1], events: [[0, -2, 0], [8, -3, 0], [300, -1, 0]] });
});

test("a capture whose deltas fall short of the posted ones refuses", () => {
  assert.throws(() => captureOf(page(stream(1000, [[0, 2, 0, 1196, 381]])), posted), /got -2.0 of -6.0 pt on x/);
  assert.throws(() => captureOf(page(), posted), /no wheel stream/);
});

test("a capture whose deltas went the other way refuses", () => {
  assert.throws(() => captureOf(page(stream(1000, [[0, -2, 0, 1196, 381], [8, -3, 0, 1199, 381], [300, -1, 0, 1200, 381]])), posted), /got 6.0 of -6.0 pt on x/);
});

test("a capture Firefox merged into fewer events, adding up to the same, is kept", () => {
  const long: Stroke = { ...posted, events: Array.from({ length: 191 }, (_, i) => [i * 8, 1, 0, 4, 0]) };
  const got = stream(1000, [...Array.from({ length: 175 }, (_, i) => [i * 8, 1, 0, 1194, 381]), [1400, 16, 0, 1194, 381]]);
  assert.equal(captureOf(page(got), long).events.length, 176);
});

test("a capture on a board of another size than the reference's refuses", () => {
  const small = { ...stream(1000, [[0, 2, 0, 1196, 381], [8, 3, 0, 1199, 381], [300, 1, 0, 1200, 381]]), stage: [994, 534] };
  assert.throws(() => captureOf(page(small), posted), /994 × 534.*1200 × 762/);
});
