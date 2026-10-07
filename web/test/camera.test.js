import { test } from "node:test";
import assert from "node:assert/strict";
import { Camera, MIN_ZOOM, MAX_ZOOM } from "../camera.js";
import { projection } from "../physics.js";

/** A camera on a fake clock: `tick(ms)` advances time and runs one animation frame. */
function setup(cam = { x: 0, y: 0, zoom: 1 }) {
  let t = 0;
  let queue = [];
  const applied = [];
  const c = new Camera((v) => applied.push({ ...v }), {
    now: () => t,
    raf: (fn) => queue.push(fn),
    caf: () => (queue = []),
  });
  c.set(cam);
  const tick = (ms = 16, n = 1) => {
    for (let i = 0; i < n; i++) {
      t += ms;
      const q = queue;
      queue = [];
      for (const fn of q) fn(t);
    }
  };
  return { c, tick, applied };
}

const near = (a, b, e) => assert.ok(Math.abs(a - b) <= e, `${a} ≉ ${b} (±${e})`);

test("a coast moves by UIKit's deceleration and stops by itself", () => {
  const { c, tick } = setup();
  c.coast({ x: 1, y: -0.5 });
  assert.ok(c.moving);
  tick(16, 400);
  assert.ok(!c.moving);
  // it stops once slower than 0.02 pt/ms, a few points short of the full projection
  near(c.cam.x, projection(1), 12);
  near(c.cam.y, projection(-0.5), 12);
});

test("stop leaves the camera where it is", () => {
  const { c, tick } = setup();
  c.coast({ x: 2, y: 0 });
  tick(16, 6);
  const x = c.cam.x;
  c.stop();
  tick(16, 6);
  assert.equal(c.cam.x, x);
  assert.ok(!c.moving);
});

test("a spring reaches its target without overshooting and stops", () => {
  const { c, tick, applied } = setup();
  c.springTo({ x: 100, y: -40, zoom: 2 });
  tick(16, 120);
  assert.ok(!c.moving);
  near(c.cam.x, 100, 0.05);
  near(c.cam.y, -40, 0.05);
  near(c.cam.zoom, 2, 1e-4);
  assert.ok(Math.max(...applied.map((a) => a.x)) <= 100.05);
});

test("a spring carries the velocity it starts with", () => {
  const { c, tick, applied } = setup();
  c.springTo({ x: 0, y: 0, zoom: 1 }, { x: 2, y: 0, zoom: 0 });
  tick(16, 2);
  assert.ok(applied.at(-1).x > 0, "it first keeps moving the way it was going");
  tick(16, 200);
  near(c.cam.x, 0, 0.05);
});

test("zoom past a limit stretches less than asked, never collapses, and settles back to the limit", () => {
  const { c, tick } = setup();
  const z = c.stretchZoom(4);
  assert.ok(z > MAX_ZOOM && z < 4);
  assert.ok(c.stretchZoom(1000) < MAX_ZOOM * 1.5);
  assert.equal(c.stretchZoom(1.5), 1.5);
  const low = c.stretchZoom(0.05);
  assert.ok(low < MIN_ZOOM && low > MIN_ZOOM / 1.5);
  c.set({ x: 0, y: 0, zoom: z });
  c.settle({ x: 100, y: 100 });
  tick(16, 200);
  near(c.cam.zoom, MAX_ZOOM, 1e-4);
});

test("settling keeps the focus point still while the zoom returns", () => {
  const { c, tick } = setup();
  const f = { x: 100, y: 200 };
  c.set({ x: 0, y: 0, zoom: 3 });
  const world = { x: (f.x - 0) / 3, y: (f.y - 0) / 3 };
  c.settle(f);
  tick(16, 200);
  near(world.x * c.cam.zoom + c.cam.x, f.x, 0.1);
  near(world.y * c.cam.zoom + c.cam.y, f.y, 0.1);
});

test("settling inside the limits just coasts the pan", () => {
  const { c, tick } = setup();
  c.settle({ x: 0, y: 0 }, { x: 1, y: 0 });
  tick(16, 400);
  near(c.cam.x, projection(1), 12);
  assert.equal(c.cam.zoom, 1);
});
