import { test } from "node:test";
import assert from "node:assert/strict";
import { Gestures, HOLD_MS } from "../gestures.js";

function setup() {
  const log = [];
  const h = new Proxy({}, { get: (_, name) => (...args) => log.push([name, ...args]) });
  return { g: new Gestures(h), log, names: () => log.map((e) => e[0]) };
}

const P = (x, y) => ({ x, y });

test("a quick touch is a tap", () => {
  const { g, log } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 80);
  assert.deepEqual(log, [["tap", P(10, 10)]]);
});

test("a second tap nearby within 300 ms is a double tap; the first still counts as a tap", () => {
  const { g, log } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 20, 15, 250);
  g.up(2, 20, 15, 300);
  assert.deepEqual(log, [["tap", P(10, 10)], ["doubleTap", P(20, 15)]]);
});

test("taps too far apart in time or space are separate taps", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 10, 10, 400);
  g.up(2, 10, 10, 450);
  g.down(3, 100, 10, 500);
  g.up(3, 100, 10, 550);
  assert.deepEqual(names(), ["tap", "tap", "tap"]);
});

test("a third quick tap after a double tap starts over", () => {
  const { g, names } = setup();
  for (const [id, t] of [[1, 0], [2, 100], [3, 200]]) {
    g.down(id, 10, 10, t);
    g.up(id, 10, 10, t + 30);
  }
  assert.deepEqual(names(), ["tap", "doubleTap", "tap"]);
});

test("moving less than 8 pt is still a tap", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 5, 0, 20);
  g.up(1, 5, 0, 40);
  assert.deepEqual(names(), ["tap"]);
});

test("moving 8 pt or more is a drag, reported with where it started", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 3, 0, 10);
  g.move(1, 10, 0, 20);
  g.move(1, 20, 0, 30);
  g.up(1, 20, 0, 40);
  assert.deepEqual(log.slice(0, 2), [["dragStart", P(0, 0), P(10, 0), false], ["dragMove", P(20, 0)]]);
  assert.equal(log[2][0], "dragEnd");
  assert.deepEqual(log[2][1], P(20, 0));
});

test("holding still for 300 ms is a hold; lifting then is not a tap", () => {
  const { g, log } = setup();
  g.down(1, 5, 5, 0);
  g.tick(HOLD_MS - 1);
  assert.deepEqual(log, []);
  g.tick(HOLD_MS);
  g.up(1, 5, 5, 500);
  assert.deepEqual(log, [["hold", P(5, 5)], ["holdEnd", P(5, 5)]]);
});

test("a hold is reported when the finger lifts late, even if no timer fired", () => {
  const { g, names } = setup();
  g.down(1, 5, 5, 0);
  g.up(1, 5, 5, 400);
  assert.deepEqual(names(), ["hold", "holdEnd"]);
});

test("a drag after a hold says so", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.tick(HOLD_MS);
  g.move(1, 20, 0, 400);
  assert.deepEqual(log, [["hold", P(0, 0)], ["dragStart", P(0, 0), P(20, 0), true]]);
});

test("a drag starting after 300 ms counts as held even if no timer fired", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 350);
  assert.deepEqual(log, [["hold", P(0, 0)], ["dragStart", P(0, 0), P(20, 0), true]]);
});

test("a second finger starts a pinch; the finger left after it is ignored", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.down(2, 100, 0, 10);
  g.move(2, 200, 0, 20);
  g.up(2, 200, 0, 30);
  g.move(1, 50, 50, 40);
  g.up(1, 50, 50, 50);
  assert.deepEqual(log.slice(0, 2), [["pinchStart", P(50, 0)], ["pinch", P(100, 0), 2]]);
  assert.deepEqual(log.slice(2).map((e) => e[0]), ["pinchEnd"]);
});

test("a second finger ends a one-finger drag first", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 10);
  g.down(2, 100, 0, 20);
  assert.deepEqual(log.slice(1), [["dragEnd", P(20, 0), P(0, 0)], ["pinchStart", P(60, 0)]]);
});

test("a second finger cancels a hold", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.tick(HOLD_MS);
  g.down(2, 100, 0, 400);
  assert.deepEqual(names(), ["hold", "holdCancel", "pinchStart"]);
});

test("velocity is measured over the last 80 ms and is zero after a pause", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  for (let t = 10; t <= 100; t += 10) g.move(1, t, 0, t);
  g.up(1, 100, 0, 100);
  assert.ok(Math.abs(log.at(-1)[2].x - 1) < 1e-9);
  const s = setup();
  s.g.down(1, 0, 0, 0);
  for (let t = 10; t <= 100; t += 10) s.g.move(1, t, 0, t);
  s.g.up(1, 100, 0, 300);
  assert.deepEqual(s.log.at(-1)[2], P(0, 0));
});

test("a cancelled drag is undone, and the touch's lift is ignored", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 10);
  g.cancel(1);
  g.up(1, 20, 0, 20);
  assert.deepEqual(names(), ["dragStart", "dragCancel"]);
});

test("a cancelled pinch is undone", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.down(2, 100, 0, 10);
  g.move(2, 150, 0, 20);
  g.cancel(1);
  assert.deepEqual(names(), ["pinchStart", "pinch", "pinchCancel"]);
});

test("cancelling all touches undoes what they were doing", () => {
  const { g, names } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 10);
  g.cancelAll();
  assert.deepEqual(names(), ["dragStart", "dragCancel"]);
  assert.equal(g.points.size, 0);
});

test("a tap, a quick drag, then a tap nearby within 300 ms are two taps, not a double tap", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  // beyond double-tap reach of the first tap, so a drag rather than a one-finger zoom
  g.down(2, 60, 10, 100);
  g.move(2, 110, 10, 130);
  g.up(2, 110, 10, 160);
  g.down(3, 14, 10, 200);
  g.up(3, 14, 10, 250);
  assert.deepEqual(names(), ["tap", "dragStart", "dragEnd", "tap"]);
});

test("a tap then a second touch that moves zooms, by how far it moved down, instead of dragging", () => {
  const { g, log } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 12, 10, 200);
  g.move(2, 12, 20, 220);
  g.move(2, 12, -30, 240);
  g.up(2, 12, -30, 260);
  assert.deepEqual(log, [["tap", P(10, 10)], ["zoomDragStart", P(12, 10)], ["zoomDrag", 10], ["zoomDrag", -40], ["zoomDragEnd"]]);
});

test("a second touch held still is not a hold, and zooms when it then moves", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 10, 10, 200);
  g.tick(600);
  g.move(2, 10, 30, 650);
  g.up(2, 10, 30, 700);
  assert.deepEqual(names(), ["tap", "zoomDragStart", "zoomDrag", "zoomDragEnd"]);
});

test("a second touch held still and lifted is neither a hold nor a double tap", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 10, 10, 200);
  g.up(2, 10, 10, 200 + HOLD_MS);
  assert.deepEqual(names(), ["tap"]);
});

test("a second finger ends a one-finger zoom and starts a pinch", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 10, 10, 200);
  g.move(2, 10, 30, 220);
  g.down(3, 100, 100, 240);
  assert.deepEqual(names(), ["tap", "zoomDragStart", "zoomDrag", "zoomDragEnd", "pinchStart"]);
});

test("a cancelled one-finger zoom is undone", () => {
  const { g, names } = setup();
  g.down(1, 10, 10, 0);
  g.up(1, 10, 10, 50);
  g.down(2, 10, 10, 200);
  g.move(2, 10, 30, 220);
  g.cancel(2);
  assert.deepEqual(names(), ["tap", "zoomDragStart", "zoomDrag", "zoomDragCancel"]);
});
