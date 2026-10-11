import { test } from "node:test";
import assert from "node:assert/strict";
import { decay, coastOffset, projection, rubber, edgeSpeed, EDGE_ZONE } from "../physics.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);

test("velocity decays by 0.985 per millisecond, as Freeform's canvas coasts", () => {
  near(decay(1, 1), 0.985);
  near(decay(2, 100), 2 * 0.985 ** 100);
});

test("a coast travels the integral of its velocity and approaches its projection", () => {
  near(coastOffset(1, 0), 0);
  near(coastOffset(1, 100000), projection(1), 1e-3);
  near(projection(1), -1 / Math.log(0.985), 1e-9);
  assert.ok(projection(1) > 60 && projection(1) < 70, "a 1 pt/ms flick coasts about 65 pt, as in Freeform");
  near(coastOffset(-1, 50), -coastOffset(1, 50));
});

test("the rubber band follows UIKit's formula: small stretches nearly 1:1, large ones never past d", () => {
  near(rubber(0, 100), 0);
  near(rubber(10, 100), (1 - 1 / ((10 * 0.55) / 100 + 1)) * 100);
  assert.ok(rubber(1e6, 100) < 100);
  near(rubber(-10, 100), -rubber(10, 100));
});

test("edge scrolling starts only inside the zone, crawls, then speeds up sharply, as Freeform's does", () => {
  assert.equal(edgeSpeed(EDGE_ZONE + 1, 0), 0);
  near(edgeSpeed(EDGE_ZONE, 0), 0.045);
  // Freeform scrolled 33 pt in the first half second and 96 pt by 0.8 s
  const scrolled = (ms) => {
    let s = 0;
    for (let t = 0; t < ms; t++) s += edgeSpeed(10, t);
    return s;
  };
  near(scrolled(500), 33, 8);
  near(scrolled(800), 96, 15);
  near(edgeSpeed(1, 5000), 1.5);
});
