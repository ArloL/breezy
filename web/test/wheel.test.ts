import { test } from "node:test";
import assert from "node:assert/strict";
import { wheelAction, LINE } from "../wheel.ts";
import type { WheelPan } from "../wheel.ts";
import { replay, trace } from "./helpers/replay.ts";

const wheel = (e: Partial<Parameters<typeof wheelAction>[0]>) => wheelAction({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, ...e });

test("scrolling pans against the delta", () => {
  assert.deepEqual(wheel({ deltaX: 5, deltaY: -10 }), { pan: { x: -5, y: 10 } });
});

test("a wheel counting lines pans 16 pt a line", () => {
  assert.deepEqual(wheel({ deltaY: 3, deltaMode: 1 }), { pan: { x: -0, y: -3 * LINE } });
});

test("a pinch, or ⌘-scroll, zooms: up zooms in", () => {
  assert.ok(Math.abs(wheel({ deltaY: -10, ctrlKey: true }).zoom! - Math.exp(0.1)) < 1e-9);
  assert.ok(wheel({ deltaY: 10, metaKey: true }).zoom! < 1);
});

test("a mouse wheel's large notch zooms one step, not to a limit", () => {
  assert.ok(Math.abs(wheel({ deltaY: -100, ctrlKey: true }).zoom! - Math.exp(0.25)) < 1e-9);
  assert.ok(Math.abs(wheel({ deltaY: 3, deltaMode: 1, ctrlKey: true }).zoom! - Math.exp(-0.25)) < 1e-9);
});

// A real trackpad's stream past the board's edge, in Chrome on a Mac, replayed. Before WheelPan, the stretch sat
// frozen at its cap while the momentum ran out, 1 to 1.25 s, and sprang back only 140 ms after its last event.
const EDGES = { x0: -631.5, x1: 895.5, y0: -1e5, y1: 1e5 };
const [slow, held, flick, slowing, lifted, firefox, pushOn] = trace.gestures;
const past = (x: number) => x > EDGES.x1 + 1 || x < EDGES.x0 - 1;
const lastPast = (xs: [number, number][]) => xs.findLast(([, x]) => past(x))?.[0] ?? 0;

test("past the edge a trackpad's stretch never sits still while its deltas keep coming", () => {
  for (const g of trace.gestures) {
    const xs = replay(g, EDGES);
    for (let k = 3; k < xs.length; k++) {
      const still = xs.slice(k - 3, k + 1).every(([, x]) => x === xs[k][1]);
      const fed = g.events.some(([t, dx]) => dx && t > xs[k - 3][0] && t <= xs[k][0]);
      assert.ok(!(still && fed && past(xs[k][1])), `${g.name}: still at ${xs[k][1]} past the edge at ${xs[k][0]} ms`);
    }
  }
});

test("momentum carrying the board past the edge bounces straight back, as a coast does", () => {
  const xs = replay(flick, EDGES);
  const crossed = xs.find(([, x]) => past(x))![0];
  assert.ok(lastPast(xs) - crossed <= 700, `back ${lastPast(xs) - crossed} ms after crossing`);
  assert.ok(lastPast(replay(slow, EDGES)) <= 1800, "a push then its momentum, back 0.6 s after the momentum began");
  assert.equal(xs.at(-1)![1], EDGES.x0);
});

test("a slow drag past the edge stays stretched under the finger, however it slows, and rebounds once the finger stops", () => {
  for (const g of [held, slowing, lifted, firefox]) {
    const xs = replay(g, EDGES);
    const pushing = g.events.findLast(([, dx, dy]) => Math.hypot(dx, dy) >= 3)![0];
    assert.ok(xs.springs.every((t) => t > pushing), `${g.name}: sprang back at ${xs.springs} while the finger pushed, to ${pushing} ms`);
    const over = xs.map(([, x]) => x - EDGES.x1);
    for (let k = 1; k < over.length; k++) assert.ok(over[k] >= over[k - 1] - 0.5 || xs[k][0] > pushing, `${g.name}: gave way at ${xs[k][0]} ms`);
    assert.ok(lastPast(xs) - pushing <= 700, `${g.name}: back ${lastPast(xs) - pushing} ms after the finger's last push`);
    assert.equal(xs.at(-1)![1], EDGES.x1);
  }
  assert.ok(replay(held, EDGES).find(([t]) => t >= 1900)![1] - EDGES.x1 > 150, "stretched while the finger pushes");
});

test("a wheel stream is kept as one flight entry: each delta, the camera it gave, and where momentum went to the spring", () => {
  const streams: Parameters<WheelPan["onStream"]>[0][] = [];
  replay(flick, EDGES, 120, (s) => streams.push(s));
  assert.equal(streams.length, 1);
  const s = streams[0];
  assert.equal(s.events.length, flick.events.length);
  const [t, dx, dy, x] = s.events[0] as number[];
  assert.deepEqual([t, dx, dy], [0, -flick.events[0][1], -flick.events[0][2]]);
  assert.ok(Math.abs(x - (flick.from.x - flick.events[0][1])) < 0.1);
  assert.deepEqual(s.bounced, [replay(flick, EDGES).springs[0]]);
  assert.deepEqual(s.limits, [EDGES.x0, EDGES.x1, EDGES.y0, EDGES.y1]);
});

test("a wheel stream keeps when it began, so that a stroke split into streams joins up again", () => {
  const streams: Parameters<WheelPan["onStream"]>[0][] = [];
  replay(flick, EDGES, 120, (s) => streams.push(s));
  assert.equal(streams[0].at, flick.events[0][0]);
});

test("a drag begun as momentum dies away is a drag, even slower than the momentum was", () => {
  // the push bounced at 703 ms; its momentum died by 1,500, and from 1,600 a slow drag went on the same way
  const xs = replay(pushOn, EDGES);
  assert.equal(xs.springs.length >= 1, true);
  const stretched = xs.filter(([t]) => t >= 1800 && t <= 3300).map(([, x]) => x - EDGES.x1);
  assert.ok(Math.max(...stretched) > 100, `the slow drag stretched only ${Math.max(...stretched).toFixed(0)} pt`);
});
