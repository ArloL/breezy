// The board's camera without a page: the camera, a wheel's pan, and the board's reach and limits, as View shows them
// (web/board-camera.ts), on a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardCamera } from "../board-camera.ts";
import type { Cam } from "../types.ts";

/** A camera over an empty board in a 1000 × 800 view, its frames and timers run by `tick`. */
function setup(from: Cam = { x: 0, y: 0, zoom: 1 }) {
  let now = 0;
  let frames: ((t: number) => void)[] = [];
  const timers: { at: number; f: () => void; id: number }[] = [];
  let id = 0;
  const shown: Cam[] = [];
  const c = new BoardCamera({
    board: () => ({ cards: [], lanes: [] }), rectOf: () => ({ x: 0, y: 0, w: 0, h: 0 }),
    stage: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }), apply: (cam) => shown.push({ ...cam }), rested: () => {},
    clock: {
      now: () => now, raf: (f) => (frames.push(f), ++id), caf: () => (frames = []),
      setTimer: (f, ms) => (timers.push({ at: now + ms, f, id: ++id }), id), clearTimer: (i) => { const k = timers.findIndex((t) => t.id === i); if (k >= 0) timers.splice(k, 1); },
    },
  });
  c.setCamera(from);
  const tick = (ms = 8, n = 1) => {
    for (let k = 0; k < n; k++) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) (timers.splice(timers.indexOf(t), 1), t.f());
      const due = frames;
      frames = [];
      for (const f of due) f(now);
    }
  };
  return { c, tick, shown };
}

test("a zoom grows the board to what it shows, and a rest keeps only what shows then", () => {
  const { c } = setup({ x: 500, y: 400, zoom: 1 });
  c.zoomAround({ x: 500, y: 400 }, 0.25);
  assert.ok(c.board().w >= 4000, `board ${JSON.stringify(c.board())} at 25 %`);
  c.setCamera({ x: 500, y: 400, zoom: 1 });
  c.rest();
  assert.deepEqual(c.board(), { x: -1194, y: -1194, w: 2388, h: 2388 });
});

test("a wheel pan past the board's edge stretches, and springs back once the stream rests", () => {
  // the view's left edge on the board's, at world -1194: x is the screen point of the world's origin
  const { c, tick } = setup({ x: 1194, y: 0, zoom: 1 });
  for (let i = 0; i < 10; i++) {
    c.wheelPan({ x: 40, y: 0 });
    tick(16);
  }
  const stretched = c.cam.x;
  assert.ok(stretched > 1194, `stretched to ${stretched}`);
  tick(8, 400);
  assert.ok(Math.abs(c.cam.x - 1194) < 1, `rests at ${c.cam.x}, the view's left on the board's edge at 1194`);
});
