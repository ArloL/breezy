import { test } from "node:test";
import assert from "node:assert/strict";
import { camOf, isEcho, layoutOf, pinchCamera, pinchTransform, scrollOf } from "../native/geometry.ts";

const empty = { x: -1194, y: -1194, w: 2388, h: 2388 };

test("layoutOf the empty board at 0.25", () => {
  const l = layoutOf(empty, 0.25, { w: 1158, h: 864 });
  assert.equal(l.width, 1159);
  assert.equal(l.height, 865);
  assert.equal(l.gridSize, 6.25);
  assert.equal(l.world, "translate(298.5px, 298.5px) scale(0.25)");
});

test("layoutOf is at least the client plus one", () => {
  const l = layoutOf(empty, 1, { w: 3000, h: 3000 });
  assert.equal(l.width, 3001);
  assert.equal(l.height, 3001);
});

test("gridOffset is a true modulo, for a negative board.x too", () => {
  const l = layoutOf({ x: -10, y: 7, w: 5000, h: 5000 }, 1, { w: 10, h: 10 });
  // 10 mod 25 = 10; -7 mod 25 = 18
  assert.deepEqual(l.gridOffset, [10 - 12.5, 18 - 12.5]);
});

test("camOf inverts scrollOf", () => {
  const cam = { x: 600, y: -200, zoom: 0.75 };
  const c = camOf(scrollOf(cam, empty), empty, cam.zoom);
  assert.ok(Math.abs(c.x - cam.x) < 1e-6 && Math.abs(c.y - cam.y) < 1e-6 && c.zoom === cam.zoom);
});

test("isEcho", () => {
  assert.equal(isEcho({ x: 10.5, y: 3 }, { x: 10, y: 3 }), true);
  assert.equal(isEcho({ x: 11.2, y: 3 }, { x: 10, y: 3 }), false);
});

test("pinchTransform and pinchCamera put the anchor under mid", () => {
  const anchor = { x: 100, y: -50 }, mid = { x: 400, y: 300 }, scroll = { x: 37, y: 12 };
  const z0 = 0.75, z = 1.5, s = z / z0;
  const m = pinchTransform(anchor, empty, z0, z, mid, scroll).match(/translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/)!;
  assert.equal(Number(m[3]), s);
  const q = { x: (anchor.x - empty.x) * z0, y: (anchor.y - empty.y) * z0 };
  const on = { x: Number(m[1]) + q.x * s - scroll.x, y: Number(m[2]) + q.y * s - scroll.y };
  assert.ok(Math.abs(on.x - mid.x) < 0.01 && Math.abs(on.y - mid.y) < 0.01);
  const cam = pinchCamera(anchor, z, mid);
  assert.ok(Math.abs(anchor.x * cam.zoom + cam.x - mid.x) < 0.01 && Math.abs(anchor.y * cam.zoom + cam.y - mid.y) < 0.01);
});

test("the transforms CSS reads never print a number in exponent form", () => {
  const tiny = { x: 1e-9, y: -3e-8, w: 2388, h: 2388 };
  assert.equal(layoutOf(tiny, 1, { w: 10, h: 10 }).world, "translate(0px, 0px) scale(1)");
  assert.doesNotMatch(pinchTransform({ x: 1e-9, y: 0 }, tiny, 1, 1, { x: 0, y: 3e-8 }, { x: 0, y: 0 }), /\de[-+]/);
});
