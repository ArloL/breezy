// What a screen capture shows of a gesture, read into a frame track (scripts/frames/pixels.ts), and the owner's own
// recording of the Mac's pinch past 25 % on mac-bounded-board at 7e0248e, read so once into
// fixtures/owner-pinch-pixels.json: docs/superpowers/specs/2026-11-11-breezy-native-reference-2-design.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFrame, type Look } from "../frames/pixels.ts";
import { column } from "../frames/track.ts";
import { coverage, pops } from "../frames/rules.ts";
import type { FrameTrack } from "../../web/flight.ts";

const look: Look = { board: [25, 26, 24], edge: [35, 37, 34], tol: 3, view: { x: 0, y: 0, w: 200, h: 100 }, scale: 1 };

/** A 200 × 100 frame of the board, grey `top` rows down and `left` columns in, and a yellow card at 120,40 of 30 × 8. */
function frame(top: number, left: number): Uint8Array {
  const f = new Uint8Array(200 * 100 * 3);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 200; x++) {
    const c = y >= 40 && y < 48 && x >= 120 && x < 150 ? [90, 75, 30] : y < top || x < left ? look.edge : look.board;
    f.set(c, (y * 200 + x) * 3);
  }
  return f;
}

test("readFrame reads how far grey reaches in from the view's edges, and where the card is", () => {
  const r = readFrame(frame(10, 20), 200, look);
  assert.equal(r.grey, 20);
  assert.deepEqual(r.card, [120, 40, 30, 8]);
  assert.equal(readFrame(frame(0, 0), 200, look).grey, 0);
});

const owner: FrameTrack = JSON.parse(readFileSync(new URL("./fixtures/owner-pinch-pixels.json", import.meta.url), "utf8"));

test("the owner's recording shows the grey band from 13.97 s, growing to 167 pt, which coverage finds", () => {
  const grey = column(owner, "grey"), ts = column(owner, "t");
  assert.equal(ts[grey.findIndex((g) => (g ?? 0) > 0.5)], 13_966.7);
  assert.equal(Math.max(...grey.slice(0, 200).map((g) => g ?? 0)), 167);
  const found = coverage(owner);
  assert.equal(found[0].from, 13_966.7);
  assert.equal(found[0].to, 14_400);
});

test("the owner's recording shows the band shoot in and go in one frame in each of the first two pinches, which pops finds", () => {
  const found = pops(owner, ["grey"], 20).map((f) => [f.from, f.to]);
  // gone in a frame as each pinch ends
  assert.ok(found.some(([a, b]) => a === 14_400 && b === 14_416.7), JSON.stringify(found));
  assert.ok(found.some(([a, b]) => a === 15_500 && b === 15_516.7), JSON.stringify(found));
  // and in by 30 to 52 pt a frame as each begins, nowhere else
  assert.ok(found.every(([a, b]) => (a >= 13_950 && b <= 14_416.7) || (a >= 15_090 && b <= 15_516.7)), JSON.stringify(found));
  assert.equal(found.length, 10);
});
