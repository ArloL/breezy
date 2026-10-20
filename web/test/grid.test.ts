import { test } from "node:test";
import assert from "node:assert/strict";
import { dotLines } from "../grid.ts";
import { GRID } from "../rules.ts";

test("dots sit on whole device pixels, within half of one of the grid's cell centres", () => {
  const cam = { x: 13.37, y: -41.2, zoom: 1.2345 };
  const dpr = 3;
  const { xs, ys } = dotLines(cam, dpr, 900, 600);
  for (const [vs, o] of [[xs, cam.x], [ys, cam.y]] as const) {
    for (const v of vs) {
      assert.equal(v, Math.round(v));
      const world = (v / dpr - o) / cam.zoom;
      const off = ((world - GRID / 2) / GRID - Math.round((world - GRID / 2) / GRID)) * GRID * cam.zoom * dpr;
      assert.ok(Math.abs(off) <= 0.5, `${v} is ${off} device px off a cell centre`);
    }
  }
});

test("dots cover the screen, one cell apart", () => {
  const cam = { x: -1000.5, y: 777.7, zoom: 0.61 };
  const dpr = 2;
  const { xs, ys } = dotLines(cam, dpr, 1024, 768);
  const t = GRID * cam.zoom * dpr;
  for (const [vs, size] of [[xs, 1024 * dpr], [ys, 768 * dpr]] as const) {
    assert.ok(vs[0] < t && vs.at(-1)! > size - t, `${vs[0]}…${vs.at(-1)} leaves an edge of ${size} bare`);
    for (let i = 1; i < vs.length; i++) assert.ok(Math.abs(vs[i] - vs[i - 1] - t) <= 1);
  }
});

test("zoomed out past 0.4, as on the Mac, there are no dots", () => {
  assert.deepEqual(dotLines({ x: 0, y: 0, zoom: 0.39 }, 2, 800, 600), { xs: [], ys: [] });
  assert.ok(dotLines({ x: 0, y: 0, zoom: 0.4 }, 2, 800, 600).xs.length > 0);
});
