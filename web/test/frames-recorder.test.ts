// The recorder of frames: a row each animation frame while what shows or the input changes, in the Mac's fields, on a
// fake clock (docs/superpowers/plans/2026-11-26-breezy-native-reference-2-web.md, Task 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Flight } from "../flight.ts";
import { FrameRecorder, WheelFrames, type FrameSource } from "../frames.ts";
import type { Cam } from "../types.ts";

function setup() {
  let now = 0, hidden = false;
  const queue = new Map<number, (t: number) => void>();
  let id = 0;
  const flight = new Flight({ now: () => now });
  const state = { cam: { x: 0, y: 0, zoom: 1 } as Cam, coverTop: false, grid: 0 };
  const source: FrameSource = {
    cam: () => state.cam, stage: () => ({ w: 1200, h: 800 }), board: () => ({ x: -1194, y: -1194, w: 3000, h: 3000 }),
    coverTop: () => state.coverTop, gridShort: () => state.grid,
  };
  const r = new FrameRecorder(flight, source, {
    raf: (f) => (queue.set(++id, f), id), caf: (i) => queue.delete(i), hidden: () => hidden,
  });
  const tick = (n = 1) => {
    for (let k = 0; k < n; k++) {
      now += 16;
      const due = [...queue.values()];
      queue.clear();
      for (const f of due) f(now);
    }
  };
  const rows = () => flight.recording().frames?.rows ?? [];
  const col = (name: string) => rows().map((row) => row[Flight.frameFields.indexOf(name)]);
  return { r, state, tick, rows, col, queue, setHidden: (h: boolean) => (hidden = h) };
}

test("a row each frame while the camera moves, one once still, then none", () => {
  const { r, state, tick, rows, queue } = setup();
  r.wake();
  for (let i = 1; i <= 5; i++) {
    state.cam = { x: -10 * i, y: 0, zoom: 1 };
    tick();
  }
  assert.equal(rows().length, 5);
  tick(40);
  assert.equal(rows().length, 6, "one row once still, and no more");
  assert.equal(queue.size, 0, "the loop stops once still");
});

test("camX is the board point at the view's top left", () => {
  const { r, state, tick, col } = setup();
  state.cam = { x: -200, y: -100, zoom: 2 };
  r.wake();
  tick();
  assert.deepEqual([col("camX")[0], col("camY")[0], col("zoom")[0]], [100, 50, 2]);
});

test("a native pinch's frames follow its transform", () => {
  const { r, state, tick, col } = setup();
  r.magnify(0, "began");
  for (let i = 1; i <= 4; i++) {
    state.cam = { x: 0, y: 0, zoom: 1 - i * 0.1 };
    r.magnify(-0.1, "changed");
    tick();
  }
  assert.deepEqual(col("zoom").map((z) => Math.round(z! * 10) / 10), [0.9, 0.8, 0.7, 0.6]);
});

test("a begin and an end in one frame both reach the frames", () => {
  const { r, tick, col } = setup();
  r.magnify(0, "began");
  r.magnify(0, "ended");
  tick(3);
  assert.deepEqual(col("gesture").slice(0, 2), [1, 3]);
});

test("wheel deltas are AppKit's way round", () => {
  const { r, tick, col } = setup();
  r.wheel(10, 0, 4, 0);
  tick();
  assert.deepEqual([col("wheelDX")[0], col("wheelPhase")[0]], [-10, 4]);
});

test("the first two touches are the fingers, the pinch's centre between them", () => {
  const { r, tick, col } = setup();
  r.pointer(7, 100, 200, true);
  r.pointer(3, 300, 400, true);
  tick();
  assert.deepEqual([col("f1x")[0], col("f1y")[0], col("f2x")[0], col("px")[0], col("py")[0]], [300, 400, 100, 200, 300]);
  r.pointer(3, null, null, true);
  r.pointer(7, null, null, true);
  tick();
  assert.equal(col("f1x")[1], null);
});

test("a hidden page keeps no loop, and wakes on input", () => {
  const { r, tick, queue, setHidden, rows } = setup();
  setHidden(true);
  r.wake();
  assert.equal(queue.size, 0);
  setHidden(false);
  r.pointer(1, 10, 10, true);
  assert.equal(queue.size, 1);
  tick();
  assert.equal(rows().length, 1);
});

test("no loop while recording is off", () => {
  const g = globalThis as { __breezyNoFlight?: boolean };
  g.__breezyNoFlight = true;
  try {
    const { r, queue } = setup();
    r.wake();
    r.wheel(1, 1, 1, 0);
    assert.equal(queue.size, 0);
  } finally {
    delete g.__breezyNoFlight;
  }
});

test("the top bar covered and the grid short reach the frames", () => {
  const { r, state, tick, col } = setup();
  state.coverTop = true;
  state.grid = 40;
  r.wake();
  tick();
  assert.deepEqual([col("coverTop")[0], col("grid")[0]], [1, 40]);
});

test("a pinch begun as the last ended, in one frame, keeps its own begin", () => {
  const { r, state, tick, col } = setup();
  r.magnify(0, "began");
  r.magnify(0, "ended");
  r.magnify(0, "began");
  for (let i = 1; i <= 3; i++) {
    state.cam = { x: 0, y: 0, zoom: 1 + i * 0.1 };
    tick();
  }
  // the second pinch goes on: no end, and no gesture-less frame, while it does
  assert.deepEqual(col("gesture"), [1, 2, 2]);
});

test("a cancelled coast is not held", () => {
  const { r, state, tick, col } = setup();
  r.wheel(0, 0, 0, 16);
  tick();
  state.cam = { x: -5, y: 0, zoom: 1 };
  tick();
  assert.deepEqual(col("momentumPhase"), [16, 0]);
});

test("a mouse moving over the board starts no loop", () => {
  const { r, queue } = setup();
  r.pointer(1, 10, 10, false);
  assert.equal(queue.size, 0);
});

/** WheelFrames on the recorder, its timers by hand. */
function wheels(pinching = () => false) {
  const s = setup();
  let fire: (() => void) | null = null;
  const w = new WheelFrames(s.r, { rest: 120, setTimer: (f) => ((fire = f), 1), clearTimer: () => (fire = null), pinching });
  const ev = (deltaY: number, mods: { ctrlKey?: boolean; deltaMode?: number } = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0, ...mods });
  return { ...s, w, ev, rest: () => fire?.() };
}

test("a wheel pan turning into a ⌃-wheel pinch ends the pan's stream first", () => {
  const { w, ev, tick, col } = wheels();
  w.take(ev(10));
  tick();
  w.take(ev(5, { ctrlKey: true }));
  tick(2);
  assert.ok(col("wheelPhase").includes(8), `phases ${col("wheelPhase")}`);
  assert.deepEqual(col("gesture").slice(1, 3), [1, 2]);
});

test("a wheel's lines are points, as the app pans by them", () => {
  const { w, ev, tick, col } = wheels();
  w.take(ev(3, { deltaMode: 1 }));
  tick();
  assert.ok(Math.abs(col("wheelDY")[0]!) > 3 * 10, `wheelDY ${col("wheelDY")[0]} for 3 lines`);
});

test("a ⌃-wheel while Safari's own pinch is on is not a second pinch", () => {
  const { w, ev, tick, col } = wheels(() => true);
  w.take(ev(5, { ctrlKey: true }));
  tick();
  assert.deepEqual(col("gesture"), []);
});

test("a wheel stream ends after it rests", () => {
  const { w, ev, tick, col, rest } = wheels();
  w.take(ev(10));
  tick();
  rest();
  tick();
  assert.deepEqual(col("wheelPhase").slice(0, 2), [1, 8]);
});

test("a ⌃-wheel pinch's frames hold where it zooms", () => {
  const { w, tick, col } = wheels();
  w.take({ deltaX: 0, deltaY: 5, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 300, clientY: 200 });
  tick();
  assert.deepEqual([col("px")[0], col("py")[0]], [300, 200]);
});
