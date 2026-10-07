import { test } from "node:test";
import assert from "node:assert/strict";
import { decay, coastOffset, projection, rubber, edgeSpeed, EDGE_ZONE } from "../physics.js";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≉ ${b}`);

test("velocity decays by 0.998 per millisecond, as UIScrollView's normal rate", () => {
  near(decay(1, 1), 0.998);
  near(decay(2, 1000), 2 * 0.998 ** 1000);
});

test("a coast travels the integral of its velocity and approaches its projection", () => {
  near(coastOffset(1, 0), 0);
  near(coastOffset(1, 100000), projection(1), 1e-3);
  near(projection(1), -1 / Math.log(0.998), 1e-9);
  near(coastOffset(-1, 50), -coastOffset(1, 50));
});

test("the rubber band follows UIKit's formula: small stretches nearly 1:1, large ones never past d", () => {
  near(rubber(0, 100), 0);
  near(rubber(10, 100), (1 - 1 / ((10 * 0.55) / 100 + 1)) * 100);
  assert.ok(rubber(1e6, 100) < 100);
  near(rubber(-10, 100), -rubber(10, 100));
});

test("edge scrolling starts only inside the zone, slowly, and speeds up while the finger stays", () => {
  assert.equal(edgeSpeed(EDGE_ZONE + 1, 0), 0);
  near(edgeSpeed(EDGE_ZONE, 0), 0.04);
  assert.ok(edgeSpeed(5, 500) > edgeSpeed(5, 0));
  near(edgeSpeed(1, 5000), 0.6);
});
