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

test("a cancelled drag ends where it was", () => {
  const { g, log } = setup();
  g.down(1, 0, 0, 0);
  g.move(1, 20, 0, 10);
  g.cancel(1);
  assert.deepEqual(log.at(-1), ["dragEnd", P(20, 0), P(0, 0)]);
});
