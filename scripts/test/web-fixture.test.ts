// Where the Firefox replays put a reference stroke: the board under the fingers as AppKit's and the Mac app's replays
// put it (Breezy/Support/Replay.swift), and the events moved from the reference's view onto the page's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { offsetOf, startCam, strokeOf } from "../web-fixture.ts";

test("startCam places a stroke as Replay.swift does", () => {
  // 100, 50 pt from where a view centred on the reference's 40,032 pt board would begin, at 100 %: as far from the
  // empty board's centre, at 0, 0, with the page's view the reference's 1495 × 932
  const centred = startCam({ start: [1, 20016 - 1495 / 2 + 100, 20016 - 932 / 2 + 50] });
  assert.deepEqual(centred, { x: 1495 / 2 - 100, y: 932 / 2 - 50, zoom: 1 });
  // a pinch at the corner: from the board's top left, 1,194 pt out from its content, at 50 %
  const corner = startCam({ start: [0.5, 30, 40], context: { name: "pinch-corner" } });
  assert.deepEqual(corner, { x: (1194 - 30) * 0.5, y: (1194 - 40) * 0.5, zoom: 0.5 });
});

test("the offset maps the reference's view onto the page's", () => {
  // the reference's window at 0, 33, 1512 × 981, its view the bottom 949 pt; the page's content at 0, 118 on screen
  assert.deepEqual(offsetOf([0, 33, 1512, 981], { x: 0, y: 118 }), { dx: 0, dy: 53 });
  assert.deepEqual(offsetOf([200, 100, 1512, 981], { x: 10, y: 140 }), { dx: -190, dy: 8 });
});

test("a capture keeps the stroke, from the frame before it began, not the page's setup", () => {
  const fields = ["t", "zoom"], rows = [[0, 0.5], [40, 0.5], [90, 0.5], [120, 0.6], [200, 0.7]];
  assert.deepEqual(strokeOf({ fields, rows }, 100).rows, [[90, 0.5], [120, 0.6], [200, 0.7]]);
  // nothing before: all of it
  assert.deepEqual(strokeOf({ fields, rows }, -5).rows, rows);
});
